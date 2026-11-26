import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.ts';
import { ingestBatch } from '../src/batch.ts';
import { IngestionError } from '../src/domain.ts';
import { parseYouTube } from '../src/providers.ts';
import type { IngestRequest, Policies, Snapshot } from '../src/domain.ts';
const request:IngestRequest={requestId:'run1',artistId:'artist1',source:'youtube',externalId:'UCabcdefghijklmnopqrstuv'};
const policy={enabled:true,retentionDays:7};
const policies:Policies={youtube:policy,lastfm:policy,ticketmaster:policy,spotify:policy,soundcloud:policy};
const now=()=>new Date('2026-11-26T06:00:00Z');
const snapshot=(r:IngestRequest):Snapshot=>parseYouTube({items:[{id:r.externalId,statistics:{hiddenSubscriberCount:false,subscriberCount:'100',viewCount:'200',videoCount:'2'}}]},r);
test('batch validates every request before making any network call',async()=>{
  const store=new Store(':memory:');let calls=0;
  try{await assert.rejects(ingestBatch([request,{...request,requestId:'run2',source:'unimplemented'}],{store,policies,now,collect:async r=>{calls++;return snapshot(r);}}),/source_not_implemented/);assert.equal(calls,0);assert.equal(store.run('run1'),undefined);}finally{store.close();}
});
test('batch rejects duplicate request IDs before touching persistence',async()=>{
  const store=new Store(':memory:');try{await assert.rejects(ingestBatch([request,request],{store,policies,now,collect:async r=>snapshot(r)}),/duplicate_batch_request_id/);assert.equal(store.run('run1'),undefined);}finally{store.close();}
});
test('a failed source does not prevent independent requests from finishing',async()=>{
  const store=new Store(':memory:');try{const r=await ingestBatch([request,{...request,requestId:'run2'}],{store,policies,now,collect:async req=>{if(req.requestId==='run1')throw new IngestionError('provider_access_denied');return snapshot(req);}});assert.equal(r.processed,2);assert.equal(store.run('run1')?.status,'access_denied');assert.equal(store.run('run2')?.status,'succeeded');}finally{store.close();}
});
test('batch remains idempotent when a completed batch is submitted again',async()=>{
  const store=new Store(':memory:');let calls=0;const options={store,policies,now,collect:async(r:IngestRequest)=>{calls++;return snapshot(r);}};
  try{await ingestBatch([request],options);const replay=await ingestBatch([request],options);assert.equal(calls,1);assert.equal(replay.results[0].replayed,true);}finally{store.close();}
});
