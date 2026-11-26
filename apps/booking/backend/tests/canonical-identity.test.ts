import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { ingest } from '../src/ingest.ts';
import { validateRequest } from '../src/domain.ts';
import { parseLastFm } from '../src/providers.ts';
import type { IngestRequest, Policies, Snapshot } from '../src/domain.ts';
const lower='bfcc6d75-a6a5-4bc6-8282-47aec8531818',upper=lower.toUpperCase();
const request:IngestRequest={requestId:'lastfm-run',artistId:'artist-1',source:'lastfm',externalId:lower};
const now=()=>new Date('2026-11-26T07:00:00.000Z');
const policies:Policies={youtube:{enabled:false,retentionDays:30},lastfm:{enabled:true,retentionDays:7},ticketmaster:{enabled:true,retentionDays:7},spotify:{enabled:false,retentionDays:7},soundcloud:{enabled:false,retentionDays:7}};
const snapshot=(r:IngestRequest)=>parseLastFm({artist:{mbid:r.externalId,stats:{listeners:'1234',playcount:'5678'}}},r);
const hash=(r:IngestRequest)=>createHash('sha256').update(JSON.stringify([r.artistId,r.source,r.externalId])).digest('hex');

function legacyDatabase(path:string,identities:{externalId:string;artistId:string}[],runs:IngestRequest[]=[],badFingerprint=false){
  const db=new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE identities (source TEXT NOT NULL,external_id TEXT NOT NULL,artist_id TEXT NOT NULL,PRIMARY KEY(source,external_id));
      CREATE TABLE runs (request_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,artist_id TEXT NOT NULL,source TEXT NOT NULL,external_id TEXT NOT NULL,status TEXT NOT NULL,collected_at TEXT NOT NULL,completed_at TEXT,expires_at TEXT NOT NULL,coverage TEXT,warnings TEXT,error_code TEXT,retry_after_ms INTEGER);
      CREATE TABLE observations (request_id TEXT NOT NULL REFERENCES runs(request_id),metric_key TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(request_id,metric_key));`);
    for(const row of identities)db.prepare('INSERT INTO identities VALUES (?,?,?)').run('lastfm',row.externalId,row.artistId);
    for(const r of runs){
      db.prepare('INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(r.requestId,badFingerprint?'unrecognized-hash':hash(r),r.artistId,r.source,r.externalId,'succeeded',now().toISOString(),now().toISOString(),'2026-12-03T07:00:00.000Z','complete_for_requested_endpoint','[]',null,null);
      for(const m of snapshot(r).metrics)db.prepare('INSERT INTO observations VALUES (?,?,?)').run(r.requestId,m.key,JSON.stringify(m));
    }
  }finally{db.close();}
}

test('request validation clones and canonicalizes MBIDs without modifying caller objects',()=>{
  const original={...request,externalId:upper};const normalized=validateRequest(original);
  assert.notEqual(normalized,original);assert.equal(normalized.externalId,lower);assert.equal(original.externalId,upper);
});

test('Last.fm case variants replay the same request and cannot attach to another artist',async()=>{
  const store=new Store(':memory:');let calls=0;
  const collect=async(r:IngestRequest)=>{calls++;assert.equal(r.externalId,lower);return snapshot(r);};
  try{
    const first=await ingest({...request,externalId:upper},{store,policies,collect,now,lastFmCommercialApproved:true});
    assert.equal(first.run?.status,'succeeded');
    assert.equal((await ingest(request,{store,policies,collect,now,lastFmCommercialApproved:true})).replayed,true);
    await assert.rejects(ingest({...request,requestId:'another-run',artistId:'artist-2',externalId:upper},{store,policies,collect,now,lastFmCommercialApproved:true}),/identity_already_linked/);
    assert.equal(calls,1);assert.equal(store.db.prepare('SELECT count(*) AS n FROM identities').get()?.n,1);
  }finally{store.close();}
});

test('v0.1 uppercase identities and historical hashes migrate without dropping observations',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'fold-theory-legacy-'));const path=join(directory,'legacy.sqlite');
  legacyDatabase(path,[{externalId:upper,artistId:'artist-1'},{externalId:lower,artistId:'artist-1'}],[{...request,externalId:upper}]);
  const store=new Store(path);
  try{
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM identities').get()?.n,1);
    assert.equal(store.run(request.requestId)?.external_id,lower);assert.equal(store.run(request.requestId)?.fingerprint,hash(request));
    assert.equal(store.observations('artist-1',now().toISOString()).length,2);
    let calls=0;const result=await ingest(request,{store,policies,collect:async r=>{calls++;return snapshot(r);},now,lastFmCommercialApproved:true});
    assert.equal(result.replayed,true);assert.equal(calls,0);
    assert.throws(()=>store.begin({...request,requestId:'new-run',artistId:'artist-2'},now().toISOString(),'2026-12-03T07:00:00.000Z'),/identity_already_linked/);
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test('legacy cross-artist case collisions fail closed without rewriting the conflicting data',()=>{
  const directory=mkdtempSync(join(tmpdir(),'fold-theory-collision-'));const path=join(directory,'legacy.sqlite');
  try{
    legacyDatabase(path,[{externalId:upper,artistId:'artist-1'},{externalId:lower,artistId:'artist-2'}]);
    assert.throws(()=>new Store(path),/legacy_identity_case_conflict/);
    const db=new DatabaseSync(path);try{assert.equal(db.prepare('SELECT count(*) AS n FROM identities').get()?.n,2);assert.equal(db.prepare('SELECT artist_id FROM identities WHERE external_id=?').get(upper)?.artist_id,'artist-1');}finally{db.close();}
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('unrecognized historical request fingerprints fail closed and remain unchanged',()=>{
  const directory=mkdtempSync(join(tmpdir(),'fold-theory-hash-'));const path=join(directory,'legacy.sqlite');
  try{
    legacyDatabase(path,[{externalId:upper,artistId:'artist-1'}],[{...request,externalId:upper}],true);
    assert.throws(()=>new Store(path),/legacy_run_fingerprint_conflict/);
    const db=new DatabaseSync(path);try{assert.equal(db.prepare('SELECT fingerprint FROM runs').get()?.fingerprint,'unrecognized-hash');assert.equal(db.prepare('SELECT external_id FROM identities').get()?.external_id,upper);}finally{db.close();}
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('legacy uppercase writes after startup are still matched case-insensitively',()=>{
  const store=new Store(':memory:');
  try{
    store.db.prepare('INSERT INTO identities VALUES (?,?,?)').run('lastfm',upper,'artist-1');
    assert.throws(()=>store.begin({...request,artistId:'artist-2'},now().toISOString(),'2026-12-03T07:00:00.000Z'),/identity_already_linked/);
    store.db.prepare('INSERT INTO identities VALUES (?,?,?)').run('lastfm',lower,'artist-2');
    assert.throws(()=>store.begin(request,now().toISOString(),'2026-12-03T07:00:00.000Z'),/legacy_identity_case_conflict/);
  }finally{store.close();}
});

test('the default lease covers a legitimate 450-second paginated collection',async()=>{
  const store=new Store(':memory:');let current=now().getTime();
  const ticketmaster:IngestRequest={requestId:'long-event-run',artistId:'artist-1',source:'ticketmaster',externalId:'K123'};
  try{
    const result=await ingest(ticketmaster,{store,policies,now:()=>new Date(current),collect:async r=>{
      current+=450_000;
      return {source:r.source,externalId:r.externalId,metrics:[],events:[],coverage:'complete_for_requested_endpoint',sourceUpdatedAt:null,warnings:[]} satisfies Snapshot;
    }});
    assert.equal(result.leaseLost,false);assert.equal(result.run?.status,'succeeded');
    assert.equal(result.run?.completed_at,'2026-11-26T07:07:30.000Z');
  }finally{store.close();}
});
