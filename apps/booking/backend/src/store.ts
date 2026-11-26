import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { IngestionError, validateRequest } from './domain.ts';
import type { IngestRequest, Snapshot } from './domain.ts';
import { validateSnapshot } from './validation.ts';

export interface RunClaim { claimed: boolean; leaseToken: number; }
export interface ClaimOptions { leaseDurationMs?: number; retryFailed?: boolean; }
const fingerprint = (r: IngestRequest) => createHash('sha256').update(JSON.stringify([r.artistId,r.source,r.externalId])).digest('hex');
const instant = (value: string) => {
  const n=Date.parse(value);
  if (!Number.isFinite(n) || new Date(n).toISOString() !== value) throw new IngestionError('invalid_timestamp');
  return n;
};

export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    this.db=new DatabaseSync(path);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS identities (source TEXT NOT NULL, external_id TEXT NOT NULL, artist_id TEXT NOT NULL, PRIMARY KEY(source,external_id));
      CREATE TABLE IF NOT EXISTS runs (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, artist_id TEXT NOT NULL, source TEXT NOT NULL, external_id TEXT NOT NULL, status TEXT NOT NULL, collected_at TEXT NOT NULL, completed_at TEXT, expires_at TEXT NOT NULL, coverage TEXT, warnings TEXT, error_code TEXT, retry_after_ms INTEGER, lease_token INTEGER NOT NULL DEFAULT 0, lease_expires_at TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, source_updated_at TEXT);
      CREATE TABLE IF NOT EXISTS observations (request_id TEXT NOT NULL REFERENCES runs(request_id), metric_key TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(request_id,metric_key));
      CREATE TABLE IF NOT EXISTS events (request_id TEXT NOT NULL REFERENCES runs(request_id), external_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(request_id,external_id));
      CREATE TABLE IF NOT EXISTS profiles (request_id TEXT PRIMARY KEY REFERENCES runs(request_id), payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS runs_artist_time ON runs(artist_id,collected_at);
      CREATE INDEX IF NOT EXISTS runs_expiry ON runs(expires_at);`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Upgrade the original local schema without rebuilding or discarding prior data.
      const columns=new Set(this.db.prepare('PRAGMA table_info(runs)').all().map(r=>String(r.name)));
      const additions: Record<string,string>={lease_token:'INTEGER NOT NULL DEFAULT 0',lease_expires_at:'TEXT',attempt_count:'INTEGER NOT NULL DEFAULT 0',source_updated_at:'TEXT'};
      for (const [name,type] of Object.entries(additions)) if(!columns.has(name)) this.db.exec(`ALTER TABLE runs ADD COLUMN ${name} ${type}`);
      this.canonicalizeLegacyLastFm();
      this.db.exec('COMMIT');
    } catch(error) { this.db.exec('ROLLBACK');this.db.close();throw error; }
  }
  close() { this.db.close(); }
  run(requestId:string) { return this.db.prepare('SELECT * FROM runs WHERE request_id=?').get(requestId); }
  private canonicalLegacyRun(row:Record<string,unknown>) {
    const original:IngestRequest={requestId:String(row.request_id),artistId:String(row.artist_id),source:'lastfm',externalId:String(row.external_id)};
    let request:IngestRequest;
    try { request=validateRequest(original); } catch { throw new IngestionError('legacy_run_identity_invalid'); }
    const hash=fingerprint(request);
    if(row.fingerprint!==fingerprint(original)&&row.fingerprint!==hash)throw new IngestionError('legacy_run_fingerprint_conflict');
    return {request,hash};
  }
  private canonicalizeLegacyLastFm() {
    const bindings=new Map<string,string>();
    const remember=(externalId:string,artistId:string)=>{
      let request:IngestRequest;
      try { request=validateRequest({requestId:'legacy-identity',artistId,source:'lastfm',externalId}); }
      catch { throw new IngestionError('legacy_identity_invalid'); }
      const prior=bindings.get(request.externalId);
      if(prior!==undefined&&prior!==artistId)throw new IngestionError('legacy_identity_case_conflict');
      bindings.set(request.externalId,artistId);
    };
    for(const row of this.db.prepare("SELECT external_id,artist_id FROM identities WHERE source='lastfm'").all())remember(String(row.external_id),String(row.artist_id));
    const runs=this.db.prepare("SELECT * FROM runs WHERE source='lastfm'").all().map(row=>({row,...this.canonicalLegacyRun(row)}));
    for(const {row,request} of runs)if(row.status==='succeeded')remember(request.externalId,request.artistId);
    // All mappings and historical hashes are checked before changing any data.
    const write=this.db.prepare("INSERT OR IGNORE INTO identities(source,external_id,artist_id) VALUES ('lastfm',?,?)");
    for(const [externalId,artistId] of bindings)write.run(externalId,artistId);
    this.db.prepare("DELETE FROM identities WHERE source='lastfm' AND external_id<>lower(external_id)").run();
    const update=this.db.prepare('UPDATE runs SET external_id=?,fingerprint=? WHERE request_id=?');
    for(const {request,hash} of runs)update.run(request.externalId,hash,request.requestId);
  }
  private linkedArtist(source:IngestRequest['source'],externalId:string):string|null {
    if(source!=='lastfm'){
      const row=this.db.prepare('SELECT artist_id FROM identities WHERE source=? AND external_id=?').get(source,externalId);
      return row?String(row.artist_id):null;
    }
    // Case-safe even if an older process writes an uppercase ID after startup.
    const rows=this.db.prepare(`SELECT artist_id FROM identities WHERE source='lastfm' AND external_id=? COLLATE NOCASE
      UNION SELECT artist_id FROM runs WHERE source='lastfm' AND external_id=? COLLATE NOCASE AND status='succeeded'`).all(externalId,externalId);
    if(rows.length>1)throw new IngestionError('legacy_identity_case_conflict');
    return rows.length?String(rows[0].artist_id):null;
  }
  listRuns(artistId:string, limit=100) {
    if(!Number.isInteger(limit)||limit<1||limit>1000)throw new IngestionError('invalid_run_limit');
    return this.db.prepare('SELECT * FROM runs WHERE artist_id=? ORDER BY collected_at DESC,request_id LIMIT ?').all(artistId,limit);
  }
  begin(input:IngestRequest,now:string,expires:string,options:ClaimOptions={}):RunClaim {
    const request=validateRequest(input),nowMs=instant(now),expiresMs=instant(expires),hash=fingerprint(request);
    // Five Ticketmaster pages can use roughly 450 seconds of bounded retries.
    const leaseMs=options.leaseDurationMs??600_000;
    if(!Number.isInteger(leaseMs)||leaseMs<1000||leaseMs>3_600_000)throw new IngestionError('invalid_lease_duration');
    if(expiresMs<=nowMs)throw new IngestionError('invalid_expiry');
    const leaseExpires=new Date(Math.min(nowMs+leaseMs,expiresMs)).toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let old=this.run(request.requestId);
      if(old&&old.source==='lastfm'){
        const normalized=this.canonicalLegacyRun(old);
        if(old.external_id!==normalized.request.externalId||old.fingerprint!==normalized.hash){
          this.db.prepare('UPDATE runs SET external_id=?,fingerprint=? WHERE request_id=?').run(normalized.request.externalId,normalized.hash,request.requestId);
          old=this.run(request.requestId);
        }
      }
      if(old&&old.fingerprint!==hash)throw new IngestionError('idempotency_conflict');
      const linked=this.linkedArtist(request.source,request.externalId);
      if(linked!==null&&linked!==request.artistId)throw new IngestionError('identity_already_linked');
      if(old){
        const token=Number(old.lease_token);
        if(old.status==='succeeded' || old.status!=='running'&&!options.retryFailed){this.db.exec('COMMIT');return {claimed:false,leaseToken:token};}
        if(old.status==='running' && old.lease_expires_at!==null && instant(String(old.lease_expires_at))>nowMs)throw new IngestionError('run_in_progress');
        if(old.status!=='running' && old.retry_after_ms!==null && old.completed_at!==null){
          const retryAt=instant(String(old.completed_at))+Number(old.retry_after_ms);
          if(retryAt>nowMs)throw new IngestionError('retry_not_due',retryAt-nowMs);
        }
      }
      const token=Number(old?.lease_token??0)+1;
      if(!Number.isSafeInteger(token))throw new IngestionError('lease_token_exhausted');
      if(old){
        this.db.prepare("UPDATE runs SET status='running',collected_at=?,completed_at=NULL,expires_at=?,coverage=NULL,warnings=NULL,error_code=NULL,retry_after_ms=NULL,lease_token=?,lease_expires_at=?,attempt_count=attempt_count+1,source_updated_at=NULL WHERE request_id=?").run(now,expires,token,leaseExpires,request.requestId);
      } else {
        this.db.prepare('INSERT INTO runs(request_id,fingerprint,artist_id,source,external_id,status,collected_at,expires_at,lease_token,lease_expires_at,attempt_count) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(request.requestId,hash,request.artistId,request.source,request.externalId,'running',now,expires,token,leaseExpires,1);
      }
      this.db.exec('COMMIT');return {claimed:true,leaseToken:token};
    } catch(error) { this.db.exec('ROLLBACK');throw error; }
  }
  private owns(requestId:string,leaseToken:number,now:string) {
    const run=this.run(requestId);
    return run && run.status==='running' && Number(run.lease_token)===leaseToken && run.lease_expires_at!==null && instant(String(run.lease_expires_at))>instant(now) ? run : null;
  }
  finish(input:IngestRequest,payload:Snapshot,now:string,leaseToken:number) {
    const request=validateRequest(input),snapshot=validateSnapshot(payload,request);
    instant(now);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const run=this.owns(request.requestId,leaseToken,now);
      if(!run)throw new IngestionError('lease_lost');
      if(run.fingerprint!==fingerprint(request))throw new IngestionError('idempotency_conflict');
      const linked=this.linkedArtist(request.source,request.externalId);
      if(linked!==null&&linked!==request.artistId)throw new IngestionError('identity_already_linked');
      this.db.prepare('INSERT OR IGNORE INTO identities(source,external_id,artist_id) VALUES (?,?,?)').run(request.source,request.externalId,request.artistId);
      if(request.source==='lastfm')this.db.prepare("DELETE FROM identities WHERE source='lastfm' AND external_id=? COLLATE NOCASE AND external_id<>?").run(request.externalId,request.externalId);
      const metric=this.db.prepare('INSERT INTO observations VALUES (?,?,?)');
      for(const m of snapshot.metrics)metric.run(request.requestId,m.key,JSON.stringify(m));
      const event=this.db.prepare('INSERT INTO events VALUES (?,?,?)');
      for(const e of snapshot.events)event.run(request.requestId,e.externalId,JSON.stringify(e));
      if(snapshot.profile)this.db.prepare('INSERT INTO profiles VALUES (?,?)').run(request.requestId,JSON.stringify(snapshot.profile));
      this.db.prepare("UPDATE runs SET status='succeeded',completed_at=?,coverage=?,warnings=?,source_updated_at=?,lease_expires_at=NULL WHERE request_id=? AND lease_token=?").run(now,snapshot.coverage,JSON.stringify(snapshot.warnings),snapshot.sourceUpdatedAt,request.requestId,leaseToken);
      this.db.exec('COMMIT');
    } catch(error) { this.db.exec('ROLLBACK');throw error; }
  }
  fail(requestId:string,code:string,now:string,retryAfterMs:number|null,leaseToken:number):boolean {
    instant(now);
    if(!/^[a-z][a-z0-9_]{0,99}$/.test(code))throw new IngestionError('invalid_error_code');
    if(retryAfterMs!==null&&(!Number.isSafeInteger(retryAfterMs)||retryAfterMs<0))throw new IngestionError('invalid_retry_delay');
    const status=['source_disabled','credentials_missing','commercial_access_not_confirmed'].includes(code)?'blocked':code==='provider_access_denied'?'access_denied':code==='rate_limited'?'rate_limited':'failed';
    const result=this.db.prepare("UPDATE runs SET status=?,error_code=?,completed_at=?,retry_after_ms=?,lease_expires_at=NULL WHERE request_id=? AND status='running' AND lease_token=? AND lease_expires_at>?").run(status,code,now,retryAfterMs,requestId,leaseToken,now);
    return Number(result.changes)===1;
  }
  observations(artistId:string,now:string) {
    instant(now);
    return this.db.prepare(`SELECT r.request_id,r.source,r.external_id,r.collected_at,r.completed_at,r.source_updated_at,r.expires_at,o.payload FROM observations o JOIN runs r USING(request_id) WHERE r.artist_id=? AND r.status='succeeded' AND r.expires_at>? ORDER BY r.collected_at,o.metric_key`).all(artistId,now).map(r=>({...JSON.parse(String(r.payload)),requestId:r.request_id,source:r.source,externalId:r.external_id,collectedAt:r.collected_at,collectionCompletedAt:r.completed_at,sourceUpdatedAt:r.source_updated_at,expiresAt:r.expires_at,scoringAllowed:false}));
  }
  events(artistId:string,now:string) {
    instant(now);
    return this.db.prepare(`SELECT r.request_id,r.source,r.collected_at,r.completed_at,r.expires_at,e.payload FROM events e JOIN runs r USING(request_id) WHERE r.artist_id=? AND r.status='succeeded' AND r.expires_at>? ORDER BY r.collected_at,e.external_id`).all(artistId,now).map(r=>({...JSON.parse(String(r.payload)),requestId:r.request_id,source:r.source,collectedAt:r.collected_at,collectionCompletedAt:r.completed_at,expiresAt:r.expires_at}));
  }
  profiles(artistId:string,now:string) {
    instant(now);
    return this.db.prepare(`SELECT r.request_id,r.source,r.external_id,r.collected_at,r.completed_at,r.expires_at,p.payload FROM profiles p JOIN runs r USING(request_id) WHERE r.artist_id=? AND r.status='succeeded' AND r.expires_at>? ORDER BY r.collected_at,r.source`).all(artistId,now).map(r=>({...JSON.parse(String(r.payload)),requestId:r.request_id,source:r.source,externalId:r.external_id,collectedAt:r.collected_at,collectionCompletedAt:r.completed_at,expiresAt:r.expires_at}));
  }
  purge(now:string) {
    instant(now);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const metrics=this.db.prepare('DELETE FROM observations WHERE request_id IN (SELECT request_id FROM runs WHERE expires_at<=?)').run(now).changes;
      const events=this.db.prepare('DELETE FROM events WHERE request_id IN (SELECT request_id FROM runs WHERE expires_at<=?)').run(now).changes;
      this.db.prepare('DELETE FROM profiles WHERE request_id IN (SELECT request_id FROM runs WHERE expires_at<=?)').run(now);
      this.db.exec('COMMIT');return {metrics,events};
    } catch(error) { this.db.exec('ROLLBACK');throw error; }
  }
}
