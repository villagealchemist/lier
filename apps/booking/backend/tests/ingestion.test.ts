import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.ts';
import { ingest } from '../src/ingest.ts';
import { providerCollector, parseYouTube, parseLastFm } from '../src/providers.ts';
import { createJsonGet } from '../src/http.ts';
import { validateRequest } from '../src/domain.ts';
import type { IngestRequest, Policies } from '../src/domain.ts';
const request:IngestRequest={requestId:'run-1',artistId:'artist-1',source:'youtube',externalId:'UCabcdefghijklmnopqrstuv'};
const policies:Policies={youtube:{enabled:true,retentionDays:30},lastfm:{enabled:true,retentionDays:7},ticketmaster:{enabled:true,retentionDays:7},spotify:{enabled:false,retentionDays:7},soundcloud:{enabled:false,retentionDays:7}};
const now=()=>new Date('2026-11-26T06:00:00Z');
const payload=()=>({items:[{id:request.externalId,statistics:{hiddenSubscriberCount:false,subscriberCount:'12300',viewCount:'123456',videoCount:'20'}}]});
test('YouTube maps native counters without inventing geography or listeners',()=>{
  const result=parseYouTube(payload(),request);assert.equal(result.metrics[0].value,12300);assert.equal(result.metrics[0].precision,'rounded_down_3_significant_figures');assert.ok(result.metrics.every(m=>m.geography===null));assert.equal(result.metrics.length,3);
});
test('hidden, absent and measured zero remain distinct',()=>{
  const p=payload();p.items[0].statistics.hiddenSubscriberCount=true;p.items[0].statistics.viewCount='0';delete (p.items[0].statistics as any).videoCount;
  const r=parseYouTube(p,request);assert.equal(r.coverage,'partial');assert.equal(r.metrics[0].availability,'hidden');assert.equal(r.metrics[0].value,null);assert.equal(r.metrics[1].value,0);assert.equal(r.metrics[2].availability,'not_returned');
});
test('malformed counters, unsafe integers and identity mismatch are rejected',()=>{
  for(const value of ['-1','12K','','9007199254740992']){const p=payload();p.items[0].statistics.viewCount=value;assert.throws(()=>parseYouTube(p,request),/invalid_provider_metric/);}
  const p=payload();p.items[0].id='different';assert.throws(()=>parseYouTube(p,request),/identity_mismatch/);
});
test('re-delivery does not fetch or write twice; conflicting request IDs fail',async()=>{
  const store=new Store(':memory:');let calls=0;const collect=async()=>{calls++;return parseYouTube(payload(),request);};
  try{await ingest(request,{store,policies,collect,now});const result=await ingest(request,{store,policies,collect,now});assert.equal(result.replayed,true);assert.equal(calls,1);assert.equal(store.observations('artist-1',now().toISOString()).length,3);await assert.rejects(ingest({...request,artistId:'other'},{store,policies,collect,now}),/idempotency_conflict/);}finally{store.close();}
});
test('a source identity cannot silently attach to two artists',async()=>{
  const store=new Store(':memory:');const collect=async()=>parseYouTube(payload(),request);
  try{await ingest(request,{store,policies,collect,now});await assert.rejects(ingest({...request,requestId:'run-2',artistId:'artist-2'},{store,policies,collect,now}),/identity_already_linked/);}finally{store.close();}
});
test('disabled sources and missing commercial access never make requests',async()=>{
  const store=new Store(':memory:');let calls=0;const collect=async()=>{calls++;return parseYouTube(payload(),request);};
  try{const r=await ingest(request,{store,policies:{...policies,youtube:{enabled:false,retentionDays:30}},collect,now});assert.equal(r.run?.status,'blocked');const fm={...request,requestId:'fm',source:'lastfm' as const,externalId:'bfcc6d75-a6a5-4bc6-8282-47aec8531818'};const s=await ingest(fm,{store,policies,collect,now});assert.equal(s.run?.error_code,'commercial_access_not_confirmed');assert.equal(calls,0);}finally{store.close();}
});
test('expiry removes data from reads before a physical purge, then deletes stored values',async()=>{
  const store=new Store(':memory:');
  try{await ingest(request,{store,policies,collect:async()=>parseYouTube(payload(),request),now});const later='2026-12-26T06:00:00.000Z';assert.equal(store.observations('artist-1',later).length,0);assert.deepEqual(store.purge(later),{metrics:3,events:0});assert.equal(store.run(request.requestId)?.status,'succeeded');}finally{store.close();}
});
test('atomic writes roll back a malformed duplicate metric snapshot',async()=>{
  const store=new Store(':memory:');const p=parseYouTube(payload(),request);p.metrics.push(p.metrics[0]);
  try{const r=await ingest(request,{store,policies,collect:async()=>p,now});assert.equal(r.run?.status,'failed');assert.equal(store.observations('artist-1',now().toISOString()).length,0);}finally{store.close();}
});
test('missing credentials are reported without network calls',async()=>{
  let calls=0;const collect=providerCollector(async()=>{calls++;return {};},{});await assert.rejects(collect(request),/credentials_missing/);assert.equal(calls,0);
});
test('Last.fm requires an explicit matching MBID and preserves its own metric namespace',()=>{
  const r={...request,source:'lastfm' as const,externalId:'bfcc6d75-a6a5-4bc6-8282-47aec8531818'};
  const parsed=parseLastFm({artist:{mbid:r.externalId,stats:{listeners:'1200',playcount:'12345'}}},r);assert.equal(parsed.metrics[1].key,'scrobbles');assert.equal(parsed.source,'lastfm');assert.throws(()=>parseLastFm({artist:{mbid:'',stats:{}}},r),/identity_mismatch/);
});
test('Ticketmaster pagination deduplicates events and never invents attendance',async()=>{
  const r={...request,source:'ticketmaster' as const,externalId:'K123'},pages:number[]=[];
  const event={id:'evt1',name:'Show',dates:{start:{localDate:'2026-12-10'}},_embedded:{attractions:[{id:'K123'}],venues:[{name:'Room',city:{name:'Philadelphia'},country:{countryCode:'US'}}]}};
  const collect=providerCollector(async url=>{const page=Number(url.searchParams.get('page'));pages.push(page);return {page:{number:page,totalPages:2},_embedded:{events:[event]}};},{TICKETMASTER_API_KEY:'fixture'});
  const result=await collect(r);assert.deepEqual(pages,[0,1]);assert.equal(result.events.length,1);assert.equal(result.events[0].attendance,null);
});
test('Ticketmaster marks deep-page truncation rather than claiming full coverage',async()=>{
  const collect=providerCollector(async url=>({page:{number:Number(url.searchParams.get('page')),totalPages:9}}),{TICKETMASTER_API_KEY:'fixture'});
  const result=await collect({...request,source:'ticketmaster',externalId:'K123'});assert.equal(result.coverage,'partial');assert.match(result.warnings.join(' '),/incomplete/);
});
test('HTTP retry honors Retry-After and never includes credential URLs in errors',async()=>{
  let calls=0;const waits:number[]=[];
  const get=createJsonGet({fetcher:async()=>{calls++;return calls===1?new Response('',{status:429,headers:{'Retry-After':'2'}}):Response.json({ok:true});},sleep:async ms=>{waits.push(ms);}});
  assert.deepEqual(await get(new URL('https://www.googleapis.com/youtube/v3/channels?key=SECRET')),{ok:true});assert.deepEqual(waits,[2000]);
  const blocked=createJsonGet({fetcher:async()=>new Response('SECRET',{status:403})});await assert.rejects(blocked(new URL('https://www.googleapis.com/?key=SECRET')),error=>error instanceof Error&&error.message==='provider_access_denied');
});
test('HTTP refuses untrusted hosts, long waits, and oversized provider responses',async()=>{
  const get=createJsonGet({fetcher:async()=>new Response('',{status:429,headers:{'Retry-After':'3600'}})});
  await assert.rejects(get(new URL('https://example.com/')),/disallowed_provider_url/);
  await assert.rejects(get(new URL('https://www.googleapis.com/')),error=>(error as any).code==='rate_limited'&&(error as any).retryAfterMs===3600000);
  const large=createJsonGet({fetcher:async()=>new Response('small',{headers:{'Content-Length':'2000001'}})});await assert.rejects(large(new URL('https://www.googleapis.com/')),/provider_payload_too_large/);
});
test('invalid requests fail before persistence, no fuzzy name matching',()=>{
  assert.throws(()=>validateRequest({...request,externalId:'Some artist name'}),/youtube_requires_channel_id/);assert.throws(()=>validateRequest({...request,source:'tiktok'}),/source_not_implemented/);assert.throws(()=>validateRequest({...request,extra:true}),/unknown_request_field/);
});
