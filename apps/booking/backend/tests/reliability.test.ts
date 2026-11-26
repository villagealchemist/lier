import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { Store } from '../src/store.ts';
import { ingest } from '../src/ingest.ts';
import { IngestionError } from '../src/domain.ts';
import type { IngestRequest, Policies, Snapshot } from '../src/domain.ts';
import { parseYouTube, parseSpotify } from '../src/providers.ts';

const request:IngestRequest={requestId:'lease-run',artistId:'artist-lease',source:'youtube',externalId:'UCabcdefghijklmnopqrstuv'};
const start=Date.parse('2026-11-26T06:00:00.000Z');
const at=(offset=0)=>new Date(start+offset).toISOString();
const policies:Policies={youtube:{enabled:true,retentionDays:30},lastfm:{enabled:false,retentionDays:7},ticketmaster:{enabled:false,retentionDays:7},spotify:{enabled:true,retentionDays:7},soundcloud:{enabled:false,retentionDays:7}};
const snapshot=(views='500'):Snapshot=>parseYouTube({items:[{id:request.externalId,statistics:{hiddenSubscriberCount:false,subscriberCount:'100',viewCount:views,videoCount:'10'}}]},request);

test('an active lease prevents duplicate work; expiry grants a strictly newer fencing token',()=>{
  const store=new Store(':memory:');
  try{
    const first=store.begin(request,at(),at(86400000),{leaseDurationMs:1000});
    assert.deepEqual(first,{claimed:true,leaseToken:1});
    assert.throws(()=>store.begin(request,at(999),at(86400000),{leaseDurationMs:1000}),/run_in_progress/);
    const second=store.begin(request,at(1000),at(86401000),{leaseDurationMs:1000});
    assert.equal(second.leaseToken,2);assert.equal(store.run(request.requestId)?.attempt_count,2);
    assert.throws(()=>store.finish(request,snapshot('111'),at(1100),first.leaseToken),/lease_lost/);
    assert.equal(store.fail(request.requestId,'provider_unavailable',at(1100),null,first.leaseToken),false);
    store.finish(request,snapshot('222'),at(1100),second.leaseToken);
    assert.equal(store.run(request.requestId)?.status,'succeeded');
    assert.equal(store.observations(request.artistId,at(1100)).find(m=>m.key==='channel_views')?.value,222);
    assert.equal(store.fail(request.requestId,'provider_unavailable',at(1200),null,second.leaseToken),false);
  }finally{store.close();}
});

test('an expired lease cannot commit even if no replacement worker has claimed it',()=>{
  const store=new Store(':memory:');
  try{
    const lease=store.begin(request,at(),at(86400000),{leaseDurationMs:1000});
    assert.throws(()=>store.finish(request,snapshot(),at(1000),lease.leaseToken),/lease_lost/);
    assert.equal(store.fail(request.requestId,'provider_unavailable',at(1000),null,lease.leaseToken),false);
    assert.equal(store.observations(request.artistId,at(1000)).length,0);
  }finally{store.close();}
});

test('a crashed worker is recoverable after reopening the on-disk store',()=>{
  const folder=mkdtempSync(join(tmpdir(),'fold-lease-')),path=join(folder,'test.sqlite');
  const first=new Store(path);first.begin(request,at(),at(86400000),{leaseDurationMs:1000});first.close();
  const recovered=new Store(path);
  try{
    const lease=recovered.begin(request,at(1001),at(86401001),{leaseDurationMs:1000});
    assert.equal(lease.leaseToken,2);recovered.finish(request,snapshot(),at(1200),lease.leaseToken);
    assert.equal(recovered.observations(request.artistId,at(1200)).length,3);
    assert.equal(recovered.listRuns(request.artistId)[0].attempt_count,2);
  }finally{recovered.close();rmSync(folder,{recursive:true,force:true});}
});

test('independent SQLite connections cannot finish with an obsolete lease token',()=>{
  const folder=mkdtempSync(join(tmpdir(),'fold-fence-')),path=join(folder,'test.sqlite');
  const a=new Store(path),b=new Store(path);
  try{
    const old=a.begin(request,at(),at(86400000),{leaseDurationMs:1000});
    const next=b.begin(request,at(1000),at(86401000),{leaseDurationMs:1000});
    b.finish(request,snapshot('321'),at(1100),next.leaseToken);
    assert.throws(()=>a.finish(request,snapshot('123'),at(1200),old.leaseToken),/lease_lost/);
    assert.equal(a.observations(request.artistId,at(1200)).find(m=>m.key==='channel_views')?.value,321);
  }finally{a.close();b.close();rmSync(folder,{recursive:true,force:true});}
});

test('ingest reports lease loss without changing the replacement worker result',async()=>{
  const store=new Store(':memory:');let ms=0;
  try{
    const result=await ingest(request,{store,policies,leaseDurationMs:1000,now:()=>new Date(start+ms),collect:async()=>{
      ms=1000;
      const replacement=store.begin(request,at(ms),at(86400000),{leaseDurationMs:1000});
      store.finish(request,snapshot('900'),at(ms),replacement.leaseToken);
      return snapshot('100');
    }});
    assert.equal(result.leaseLost,true);assert.equal(result.run?.status,'succeeded');
    assert.equal(store.observations(request.artistId,at(ms)).find(m=>m.key==='channel_views')?.value,900);
  }finally{store.close();}
});

test('terminal failures replay by default and require an explicit retry with the same fingerprint',async()=>{
  const store=new Store(':memory:');let calls=0;const collect=async()=>{calls++;return snapshot();};
  const disabled={...policies,youtube:{enabled:false,retentionDays:30}};
  try{
    const blocked=await ingest(request,{store,policies:disabled,collect,now:()=>new Date(start)});assert.equal(blocked.run?.status,'blocked');
    const replay=await ingest(request,{store,policies,collect,now:()=>new Date(start+1000)});assert.equal(replay.replayed,true);assert.equal(calls,0);
    const retry=await ingest(request,{store,policies,collect,retryFailed:true,now:()=>new Date(start+1000)});
    assert.equal(retry.run?.status,'succeeded');assert.equal(retry.run?.attempt_count,2);assert.equal(calls,1);
    await assert.rejects(ingest({...request,artistId:'different'},{store,policies,collect,retryFailed:true,now:()=>new Date(start+1000)}),/idempotency_conflict/);
  }finally{store.close();}
});

test('explicit retry respects the provider Retry-After deadline',async()=>{
  const store=new Store(':memory:');let calls=0;
  try{
    await ingest(request,{store,policies,now:()=>new Date(start),collect:async()=>{throw new IngestionError('rate_limited',2000);}});
    const collect=async()=>{calls++;return snapshot();};
    await assert.rejects(ingest(request,{store,policies,collect,retryFailed:true,now:()=>new Date(start+1999)}),error=>error instanceof IngestionError&&error.code==='retry_not_due'&&error.retryAfterMs===1);
    assert.equal(calls,0);
    const result=await ingest(request,{store,policies,collect,retryFailed:true,now:()=>new Date(start+2000)});assert.equal(result.run?.status,'succeeded');assert.equal(calls,1);
  }finally{store.close();}
});

test('a forged normalized payload cannot overwrite provenance or become persisted data',async()=>{
  const store=new Store(':memory:');const forged=snapshot();(forged.metrics[0] as any).source='licensed';
  try{
    const result=await ingest(request,{store,policies,collect:async()=>forged,now:()=>new Date(start)});
    assert.equal(result.run?.status,'failed');assert.equal(result.run?.error_code,'unknown_snapshot_field');
    assert.equal(store.observations(request.artistId,at()).length,0);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM identities').get()?.n,0);
  }finally{store.close();}
});

test('profile provenance and expiry follow the same boundary as metric values',async()=>{
  const store=new Store(':memory:');const r:IngestRequest={...request,source:'spotify',externalId:'0123456789abcdefghijkl'};
  const s=parseSpotify({id:r.externalId,type:'artist',name:'Fixture Artist',external_urls:{spotify:`https://open.spotify.com/artist/${r.externalId}`}},r);
  try{
    await ingest(r,{store,policies,collect:async()=>s,now:()=>new Date(start)});
    const profile=store.profiles(r.artistId,at())[0];assert.equal(profile.displayName,'Fixture Artist');assert.equal(profile.requestId,r.requestId);assert.equal(profile.collectionCompletedAt,at());
    const expiry=at(7*86400000);assert.equal(store.profiles(r.artistId,expiry).length,0);store.purge(expiry);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM profiles').get()?.n,0);
  }finally{store.close();}
});

test('v0.1 databases retain data and old abandoned running rows can be reclaimed',()=>{
  const folder=mkdtempSync(join(tmpdir(),'fold-migration-')),path=join(folder,'old.sqlite');
  const legacy=new DatabaseSync(path);
  legacy.exec('CREATE TABLE runs (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, artist_id TEXT NOT NULL, source TEXT NOT NULL, external_id TEXT NOT NULL, status TEXT NOT NULL, collected_at TEXT NOT NULL, completed_at TEXT, expires_at TEXT NOT NULL, coverage TEXT, warnings TEXT, error_code TEXT, retry_after_ms INTEGER)');
  const hash=createHash('sha256').update(JSON.stringify([request.artistId,request.source,request.externalId])).digest('hex');
  legacy.prepare('INSERT INTO runs(request_id,fingerprint,artist_id,source,external_id,status,collected_at,expires_at) VALUES (?,?,?,?,?,?,?,?)').run(request.requestId,hash,request.artistId,request.source,request.externalId,'running',at(),at(86400000));legacy.close();
  const store=new Store(path);
  try{
    assert.equal(store.run(request.requestId)?.artist_id,request.artistId);
    const lease=store.begin(request,at(1000),at(86401000));assert.equal(lease.leaseToken,1);
    store.finish(request,snapshot(),at(1100),lease.leaseToken);assert.equal(store.observations(request.artistId,at(1100)).length,3);
  }finally{store.close();rmSync(folder,{recursive:true,force:true});}
});
