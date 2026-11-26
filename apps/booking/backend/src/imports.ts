import { createHash } from 'node:crypto';
import { IngestionError } from './domain.ts';
import type { Store } from './store.ts';

export type EvidenceKind = 'artist_audience' | 'show_outcomes';
export interface Geography { city: string; region: string | null; countryCode: string }
export interface Period { start: string; end: string }
export interface Provenance {
  provider: string;
  sourceAccountId: string;
  documentReference: string;
  sourceGeneratedAt: string | null;
  authorization: {
    declared: true;
    basis: 'artist_authorized_export' | 'organizer_owned_export' | 'licensed_export';
    reference: string;
    declaredBy: string;
    retainUntil: string;
  };
}
export interface AudienceRecord {
  recordId: string;
  artistId: string;
  platform: string;
  metric: 'listeners' | 'followers' | 'streams';
  value: number | null;
  availability: 'reported' | 'not_reported' | 'suppressed';
  precision: 'reported' | 'estimated';
  observedPeriod: Period;
  geography: Geography;
}
export interface ShowOutcome {
  recordId: string;
  eventId: string;
  eventDate: string;
  venue: { name: string; geography: Geography };
  lineupArtistIds: string[];
  paidAttendance: number | null;
  refundedTickets: number | null;
  complimentaryAttendance: number | null;
  sellableCapacity: number | null;
  netTicketRevenueMinor: number | null;
  currency: string;
}
export type EvidenceImport = {
  schemaVersion: 1;
  importId: string;
  synthetic: boolean;
  provenance: Provenance;
} & ({kind:'artist_audience';records:AudienceRecord[]} | {kind:'show_outcomes';records:ShowOutcome[]});
export interface ImportOptions { store: Store; now?: () => Date; allowSynthetic?: boolean }
export interface EvidenceFilters { artistId?: string; includeSynthetic?: boolean; now?: Date }

const fail=(code:string):never=>{throw new IngestionError(code);};
function obj(value:unknown):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)fail('invalid_import_object');
  return value as Record<string,unknown>;
}
function keys(value:Record<string,unknown>,expected:string[]){
  if(Object.keys(value).length!==expected.length||expected.some(k=>!Object.hasOwn(value,k)))fail('invalid_import_fields');
}
function string(value:unknown,max=200):string{
  if(typeof value!=='string'||!value.trim()||value!==value.trim()||value.length>max||/[\u0000-\u001f]/.test(value))fail('invalid_import_string');
  return value as string;
}
function id(value:unknown):string{const v=string(value,100);if(!/^[A-Za-z0-9_-]+$/.test(v))fail('invalid_import_identifier');return v;}
function slug(value:unknown):string{const v=string(value,80);if(!/^[a-z][a-z0-9_-]*$/.test(v))fail('invalid_import_source');return v;}
function date(value:unknown):string{
  const v=string(value,10);if(!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString().slice(0,10)!==v)fail('invalid_import_date');return v;
}
function instant(value:unknown):string{
  const v=string(value,24);if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString()!==v)fail('invalid_import_timestamp');return v;
}
function integer(value:unknown,allowNegative=false):number|null{
  if(value===null)return null;
  if(typeof value!=='number'||!Number.isSafeInteger(value)||(!allowNegative&&value<0))fail('invalid_import_number');return value as number;
}
const countries=new Set(('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW').split(' '));
const currencies=new Set(Intl.supportedValuesOf('currency'));
function geography(value:unknown):Geography{
  const g=obj(value);keys(g,['city','region','countryCode']);const countryCode=string(g.countryCode,2);if(!countries.has(countryCode))fail('invalid_country_code');
  return {city:string(g.city),region:g.region===null?null:string(g.region),countryCode};
}
function provenance(value:unknown,kind:EvidenceKind):Provenance{
  const p=obj(value);keys(p,['provider','sourceAccountId','documentReference','sourceGeneratedAt','authorization']);const a=obj(p.authorization);keys(a,['declared','basis','reference','declaredBy','retainUntil']);
  if(a.declared!==true)fail('authorization_not_declared');
  const allowed=kind==='artist_audience'?['artist_authorized_export','licensed_export']:['organizer_owned_export','licensed_export'];
  if(typeof a.basis!=='string'||!allowed.includes(a.basis))fail('incompatible_authorization_basis');
  return {provider:slug(p.provider),sourceAccountId:id(p.sourceAccountId),documentReference:string(p.documentReference,500),sourceGeneratedAt:p.sourceGeneratedAt===null?null:instant(p.sourceGeneratedAt),authorization:{declared:true,basis:a.basis as Provenance['authorization']['basis'],reference:string(a.reference,500),declaredBy:id(a.declaredBy),retainUntil:instant(a.retainUntil)}};
}
function audience(value:unknown):AudienceRecord{
  const r=obj(value);keys(r,['recordId','artistId','platform','metric','value','availability','precision','observedPeriod','geography']);
  if(typeof r.metric!=='string'||!['listeners','followers','streams'].includes(r.metric))fail('invalid_audience_metric');
  if(typeof r.availability!=='string'||!['reported','not_reported','suppressed'].includes(r.availability))fail('invalid_audience_availability');
  if(typeof r.precision!=='string'||!['reported','estimated'].includes(r.precision))fail('invalid_audience_precision');
  const measured=integer(r.value);if((r.availability==='reported')!==(measured!==null))fail('contradictory_audience_availability');
  const period=obj(r.observedPeriod);keys(period,['start','end']);const start=date(period.start),end=date(period.end);if(start>end)fail('invalid_observed_period');
  return {recordId:id(r.recordId),artistId:id(r.artistId),platform:slug(r.platform),metric:r.metric as AudienceRecord['metric'],value:measured,availability:r.availability as AudienceRecord['availability'],precision:r.precision as AudienceRecord['precision'],observedPeriod:{start,end},geography:geography(r.geography)};
}
function show(value:unknown):ShowOutcome{
  const r=obj(value);keys(r,['recordId','eventId','eventDate','venue','lineupArtistIds','paidAttendance','refundedTickets','complimentaryAttendance','sellableCapacity','netTicketRevenueMinor','currency']);
  const venue=obj(r.venue);keys(venue,['name','geography']);
  if(!Array.isArray(r.lineupArtistIds)||r.lineupArtistIds.length<1||r.lineupArtistIds.length>100)fail('invalid_lineup');
  const lineup=r.lineupArtistIds.map(id).sort();if(new Set(lineup).size!==lineup.length)fail('duplicate_lineup_artist');
  const currency=string(r.currency,3);if(!currencies.has(currency))fail('invalid_currency');
  const capacity=integer(r.sellableCapacity);if(capacity===0)fail('invalid_sellable_capacity');
  // Paid attendance and refunds are independent reported measures; don't subtract refunds a second time.
  return {recordId:id(r.recordId),eventId:string(r.eventId),eventDate:date(r.eventDate),venue:{name:string(venue.name),geography:geography(venue.geography)},lineupArtistIds:lineup,paidAttendance:integer(r.paidAttendance),refundedTickets:integer(r.refundedTickets),complimentaryAttendance:integer(r.complimentaryAttendance),sellableCapacity:capacity,netTicketRevenueMinor:integer(r.netTicketRevenueMinor,true),currency};
}
function logicalKey(kind:EvidenceKind,record:AudienceRecord|ShowOutcome):string{
  if(kind==='show_outcomes')return JSON.stringify([(record as ShowOutcome).eventId]);
  const r=record as AudienceRecord;
  return JSON.stringify([r.artistId,r.platform,r.metric,r.observedPeriod.start,r.observedPeriod.end,r.geography.countryCode,r.geography.region,r.geography.city]);
}
function observedThrough(kind:EvidenceKind,record:AudienceRecord|ShowOutcome):string{
  return kind==='artist_audience'?(record as AudienceRecord).observedPeriod.end:(record as ShowOutcome).eventDate;
}
export function validateEvidenceImport(input:unknown):EvidenceImport{
  const e=obj(input);keys(e,['schemaVersion','importId','kind','synthetic','provenance','records']);
  if(e.schemaVersion!==1)fail('unsupported_import_version');if(e.kind!=='artist_audience'&&e.kind!=='show_outcomes')fail('invalid_import_kind');if(typeof e.synthetic!=='boolean')fail('missing_synthetic_declaration');
  if(!Array.isArray(e.records)||e.records.length<1||e.records.length>1000)fail('invalid_import_record_count');
  const kind=e.kind as EvidenceKind,records=e.records.map(value=>kind==='artist_audience'?audience(value):show(value)).sort((a,b)=>a.recordId.localeCompare(b.recordId));
  const ids=new Set<string>(),logical=new Set<string>();
  for(const r of records){const k=logicalKey(kind,r);if(ids.has(r.recordId)||logical.has(k))fail('duplicate_import_record');ids.add(r.recordId);logical.add(k);}
  const p=provenance(e.provenance,kind);
  // Calendar-date policy: a report's UTC generation date must not precede the event/period end date.
  if(p.sourceGeneratedAt!==null&&records.some(r=>observedThrough(kind,r)>p.sourceGeneratedAt!.slice(0,10)))fail('source_generation_precedes_observation');
  return {schemaVersion:1,importId:id(e.importId),kind,synthetic:e.synthetic,provenance:p,records} as EvidenceImport;
}
function initialize(store:Store){
  store.db.exec(`CREATE TABLE IF NOT EXISTS evidence_imports (
    import_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, kind TEXT NOT NULL,
    synthetic INTEGER NOT NULL CHECK(synthetic IN(0,1)), provider TEXT NOT NULL,
    source_account_id TEXT NOT NULL, imported_at TEXT NOT NULL, expires_at TEXT NOT NULL,
    provenance TEXT NOT NULL, record_count INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS evidence_records (
      import_id TEXT NOT NULL REFERENCES evidence_imports(import_id) ON DELETE CASCADE,
      record_id TEXT NOT NULL, logical_key TEXT NOT NULL, artist_id TEXT,
      payload TEXT NOT NULL, PRIMARY KEY(import_id,record_id), UNIQUE(import_id,logical_key));
    CREATE TABLE IF NOT EXISTS evidence_lineup (
      import_id TEXT NOT NULL, record_id TEXT NOT NULL, artist_id TEXT NOT NULL,
      PRIMARY KEY(import_id,record_id,artist_id), FOREIGN KEY(import_id,record_id)
      REFERENCES evidence_records(import_id,record_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS evidence_heads (
      head_key TEXT PRIMARY KEY, import_id TEXT NOT NULL, record_id TEXT NOT NULL,
      effective_at TEXT NOT NULL, imported_at TEXT NOT NULL, source_clock TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS evidence_artist ON evidence_records(artist_id);
    CREATE INDEX IF NOT EXISTS evidence_lineup_artist ON evidence_lineup(artist_id);
    CREATE INDEX IF NOT EXISTS evidence_expiry ON evidence_imports(expires_at);`);
  const headColumns=store.db.prepare('PRAGMA table_info(evidence_heads)').all();
  if(!headColumns.some(c=>c.name==='source_clock')){
    store.db.exec("ALTER TABLE evidence_heads ADD COLUMN source_clock TEXT NOT NULL DEFAULT 'legacy'");
    // Surviving provenance can identify the clock; historical tombstones stay explicitly ambiguous.
    store.db.exec(`UPDATE evidence_heads SET source_clock=CASE
      WHEN json_extract((SELECT provenance FROM evidence_imports i WHERE i.import_id=evidence_heads.import_id),'$.sourceGeneratedAt') IS NULL THEN 'unknown' ELSE 'known' END
      WHERE EXISTS(SELECT 1 FROM evidence_imports i WHERE i.import_id=evidence_heads.import_id)`);
  }
}
export function importEvidence(input:unknown,options:ImportOptions){
  const e=validateEvidenceImport(input);if(e.synthetic&&!options.allowSynthetic)fail('synthetic_import_requires_explicit_opt_in');
  const importedAt=(options.now??(()=>new Date()))().toISOString();
  if(e.provenance.authorization.retainUntil<=importedAt)fail('import_authorization_expired');
  if(e.provenance.sourceGeneratedAt!==null&&e.provenance.sourceGeneratedAt>importedAt)fail('source_generation_in_future');
  const today=importedAt.slice(0,10);if(e.records.some(r=>observedThrough(e.kind,r)>today))fail('future_observation');
  const fingerprint=createHash('sha256').update(JSON.stringify(e)).digest('hex');initialize(options.store);
  const db=options.store.db;db.exec('BEGIN IMMEDIATE');
  try{
    const old=db.prepare('SELECT fingerprint,imported_at,record_count FROM evidence_imports WHERE import_id=?').get(e.importId);
    if(old){if(old.fingerprint!==fingerprint)fail('import_idempotency_conflict');db.exec('COMMIT');return {importId:e.importId,replayed:true,importedAt:String(old.imported_at),recordCount:Number(old.record_count),synthetic:e.synthetic};}
    db.prepare('INSERT INTO evidence_imports VALUES (?,?,?,?,?,?,?,?,?,?)').run(e.importId,fingerprint,e.kind,e.synthetic?1:0,e.provenance.provider,e.provenance.sourceAccountId,importedAt,e.provenance.authorization.retainUntil,JSON.stringify(e.provenance),e.records.length);
    const write=db.prepare('INSERT INTO evidence_records VALUES (?,?,?,?,?)'),lineup=db.prepare('INSERT INTO evidence_lineup VALUES (?,?,?)');
    // Heads deliberately have no foreign key. After deletion, their opaque tombstones prevent older revisions reappearing.
    const head=db.prepare(`INSERT INTO evidence_heads(head_key,import_id,record_id,effective_at,imported_at,source_clock) VALUES (?,?,?,?,?,?) ON CONFLICT(head_key) DO UPDATE SET
      import_id=excluded.import_id,record_id=excluded.record_id,effective_at=excluded.effective_at,imported_at=excluded.imported_at,source_clock=excluded.source_clock
      WHERE excluded.effective_at>evidence_heads.effective_at OR
        (excluded.effective_at=evidence_heads.effective_at AND excluded.imported_at>=evidence_heads.imported_at)`);
    for(const r of e.records){
      write.run(e.importId,r.recordId,logicalKey(e.kind,r),e.kind==='artist_audience'?(r as AudienceRecord).artistId:null,JSON.stringify(r));
      const headKey=createHash('sha256').update(JSON.stringify([e.provenance.provider,e.provenance.sourceAccountId,e.kind,e.synthetic,logicalKey(e.kind,r)])).digest('hex');
      const previousHead=db.prepare('SELECT source_clock FROM evidence_heads WHERE head_key=?').get(headKey);
      if(previousHead&&(previousHead.source_clock!=='known'||e.provenance.sourceGeneratedAt===null))fail('ambiguous_source_time_revision');
      head.run(headKey,e.importId,r.recordId,e.provenance.sourceGeneratedAt??importedAt,importedAt,e.provenance.sourceGeneratedAt===null?'unknown':'known');
      if(e.kind==='show_outcomes')for(const artistId of (r as ShowOutcome).lineupArtistIds)lineup.run(e.importId,r.recordId,artistId);
    }
    db.exec('COMMIT');return {importId:e.importId,replayed:false,importedAt,recordCount:e.records.length,synthetic:e.synthetic};
  }catch(error){db.exec('ROLLBACK');throw error;}
}
function query(store:Store,kind:EvidenceKind,filters:EvidenceFilters){
  if(filters.artistId!==undefined)id(filters.artistId);if(filters.includeSynthetic!==undefined&&typeof filters.includeSynthetic!=='boolean')fail('invalid_synthetic_filter');
  initialize(store);const now=(filters.now??new Date()).toISOString();
  // A source-dated correction replaces the query view, not the original evidence. Expiry cannot revive an old revision.
  const rows=store.db.prepare(`SELECT i.import_id,i.synthetic,i.provider,i.source_account_id,i.imported_at,i.expires_at,i.provenance,
      r.record_id,r.artist_id,r.payload
    FROM evidence_records r JOIN evidence_imports i USING(import_id)
    JOIN evidence_heads h ON h.import_id=r.import_id AND h.record_id=r.record_id
    WHERE i.kind=? AND i.expires_at>? AND (?=1 OR i.synthetic=0)
    AND (? IS NULL OR r.artist_id=? OR EXISTS (SELECT 1 FROM evidence_lineup l WHERE l.import_id=r.import_id AND l.record_id=r.record_id AND l.artist_id=?))
    ORDER BY i.imported_at DESC,i.import_id,r.record_id`).all(kind,now,filters.includeSynthetic?1:0,filters.artistId??null,filters.artistId??null,filters.artistId??null);
  return rows.map(row=>({importId:String(row.import_id),synthetic:row.synthetic===1,importedAt:String(row.imported_at),expiresAt:String(row.expires_at),provenance:JSON.parse(String(row.provenance)) as Provenance,verification:'self_declared_not_independently_verified' as const,scoringAllowed:false as const,record:JSON.parse(String(row.payload))}));
}
export function queryAudienceEvidence(store:Store,filters:EvidenceFilters={}){return query(store,'artist_audience',filters) as Array<{importId:string;synthetic:boolean;importedAt:string;expiresAt:string;provenance:Provenance;verification:'self_declared_not_independently_verified';scoringAllowed:false;record:AudienceRecord}>;}
export function queryShowOutcomes(store:Store,filters:EvidenceFilters={}){return query(store,'show_outcomes',filters).map(r=>({...r,record:r.record as ShowOutcome,attribution:'whole_event_not_individual_artist' as const}));}
export function purgeExpiredEvidence(store:Store,now:Date=new Date()){
  initialize(store);const result=store.db.prepare('DELETE FROM evidence_imports WHERE expires_at<=?').run(now.toISOString());return {importsDeleted:Number(result.changes)};
}
export function deleteEvidenceImport(store:Store,importId:string){
  id(importId);initialize(store);const result=store.db.prepare('DELETE FROM evidence_imports WHERE import_id=?').run(importId);return {importsDeleted:Number(result.changes)};
}
