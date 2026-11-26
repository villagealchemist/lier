import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSnapshot } from '../src/validation.ts';
import type { IngestRequest } from '../src/domain.ts';

const request:IngestRequest={requestId:'validation-1',artistId:'artist-1',source:'youtube',externalId:'UCabcdefghijklmnopqrstuv'};
const payload=()=>({
  source:'youtube',externalId:request.externalId,sourceUpdatedAt:null,coverage:'complete_for_requested_endpoint',warnings:[],events:[],
  metrics:[
    {key:'subscribers',value:12300,availability:'available',unit:'count',scope:'channel',window:'current',geography:null,precision:'rounded_down_3_significant_figures'},
    {key:'channel_views',value:0,availability:'available',unit:'count',scope:'channel',window:'lifetime',geography:null,precision:'reported'},
    {key:'public_video_count',value:20,availability:'available',unit:'count',scope:'channel',window:'current',geography:null,precision:'reported'}
  ]
});
test('snapshot validation reconstructs nested values without retaining mutable input references',()=>{
  const original=payload();const normalized=validateSnapshot(original,request);original.metrics[0].value=999;original.warnings.push('changed' as never);
  assert.equal(normalized.metrics[0].value,12300);assert.deepEqual(normalized.warnings,[]);assert.equal(normalized.metrics[1].value,0);
});
test('snapshot validation rejects unrecognized properties at every persisted boundary',()=>{
  for(const mutate of [
    (p:any)=>{p.accessToken='secret';}, (p:any)=>{p.metrics[0].source='spotify';},
    (p:any)=>{p.metrics[0].scoringAllowed=true;}, (p:any)=>{p.metrics[0].geography='Philadelphia';}
  ]){const p=payload();mutate(p);assert.throws(()=>validateSnapshot(p,request));}
  const accessor=payload();Object.defineProperty(accessor,'warnings',{get(){throw new Error('getter executed');},enumerable:true});assert.throws(()=>validateSnapshot(accessor,request),/invalid_snapshot/);
});
test('snapshot value, source, precision and availability cannot contradict their definitions',()=>{
  for(const value of [NaN,Infinity,-1,1.1,Number.MAX_SAFE_INTEGER+1,'123']){const p:any=payload();p.metrics[0].value=value;assert.throws(()=>validateSnapshot(p,request),/invalid_snapshot_metric/);}
  const wrongPrecision=payload();wrongPrecision.metrics[0].precision='reported';assert.throws(()=>validateSnapshot(wrongPrecision,request),/invalid_snapshot_metric/);
  const wrongIdentity=payload();wrongIdentity.externalId='different';assert.throws(()=>validateSnapshot(wrongIdentity,request),/identity_mismatch/);
  const unknown:any=payload();unknown.metrics[0].availability='not_returned';assert.throws(()=>validateSnapshot(unknown,request),/invalid_snapshot_metric/);
  unknown.metrics[0].value=null;assert.throws(()=>validateSnapshot(unknown,request),/invalid_snapshot_coverage/);unknown.coverage='partial';assert.equal(validateSnapshot(unknown,request).metrics[0].value,null);
});
test('snapshot coverage requires explicit availability for every metric',()=>{
  const duplicate=payload();duplicate.metrics.push(duplicate.metrics[0]);assert.throws(()=>validateSnapshot(duplicate,request),/duplicate_snapshot_metric/);
  const missing=payload();missing.metrics.pop();assert.throws(()=>validateSnapshot(missing,request),/incomplete_snapshot_metrics/);
  const future:any=payload();future.sourceUpdatedAt='2026-11-26T00:00:00Z';assert.throws(()=>validateSnapshot(future,request),/invalid_snapshot_source_time/);
});
test('event normalization rejects impossible dates, invented attendance and extra metadata',()=>{
  const ticketRequest:IngestRequest={...request,source:'ticketmaster',externalId:'K123'};
  const event=()=>({externalId:'event-1',name:'Show',localDate:'2028-02-29',venue:'Room',city:'Philadelphia',country:'US',status:'onsale',attendance:null});
  const snapshot=()=>({source:'ticketmaster',externalId:'K123',sourceUpdatedAt:null,coverage:'complete_for_requested_endpoint',warnings:[],events:[event()],metrics:[]});
  assert.equal(validateSnapshot(snapshot(),ticketRequest).events[0].localDate,'2028-02-29');
  for(const change of [
    (e:any)=>{e.localDate='2026-02-29';}, (e:any)=>{e.attendance=200;}, (e:any)=>{e.ticketRevenue=4000;}
  ]){const p=snapshot();change(p.events[0]);assert.throws(()=>validateSnapshot(p,ticketRequest));}
  const duplicate=snapshot();duplicate.events.push(event());assert.throws(()=>validateSnapshot(duplicate,ticketRequest),/duplicate_snapshot_event/);
});
test('snapshot arrays and text are bounded',()=>{
  const p:any=payload();p.warnings=Array(31).fill('warning');assert.throws(()=>validateSnapshot(p,request));p.warnings=['x'.repeat(1001)];assert.throws(()=>validateSnapshot(p,request));
  const ticketRequest:IngestRequest={...request,source:'ticketmaster',externalId:'K123'};
  assert.throws(()=>validateSnapshot({source:'ticketmaster',externalId:'K123',sourceUpdatedAt:null,coverage:'complete_for_requested_endpoint',warnings:[],metrics:[],events:Array(1001).fill({})},ticketRequest));
});
test('Spotify score ranges and profile URLs are validated at the storage boundary',()=>{
  const spotify:IngestRequest={...request,source:'spotify',externalId:'0OdUWJ0sBjDrqHygGUXeCF'};
  const snapshot=()=>({source:'spotify',externalId:spotify.externalId,sourceUpdatedAt:null,coverage:'complete_for_requested_endpoint',warnings:[],events:[],profile:{displayName:'Fixture artist',url:`https://open.spotify.com/artist/${spotify.externalId}`},metrics:[
    {key:'followers',value:100,availability:'available',unit:'count',scope:'artist',window:'current',geography:null,precision:'reported'},
    {key:'popularity',value:100,availability:'available',unit:'score_0_100',scope:'artist',window:'current',geography:null,precision:'reported'}
  ]});
  assert.equal(validateSnapshot(snapshot(),spotify).metrics[1].value,100);
  const outOfRange=snapshot();outOfRange.metrics[1].value=101;assert.throws(()=>validateSnapshot(outOfRange,spotify),/invalid_snapshot_metric/);
  for(const url of ['https://evil.example/artist/x',`https://open.spotify.com/artist/${spotify.externalId}?token=secret`,`https://user:secret@open.spotify.com/artist/${spotify.externalId}`,'http://open.spotify.com/artist/x','https://open.spotify.com/artist/wrong']){
    const p=snapshot();p.profile.url=url;assert.throws(()=>validateSnapshot(p,spotify),/invalid_snapshot_profile_url/);
  }
  const extra:any=snapshot();extra.profile.secret='token';assert.throws(()=>validateSnapshot(extra,spotify),/unknown_snapshot_field/);
});
test('SoundCloud profile and canonical counter schema survives a validated reconstruction',()=>{
  const soundcloud:IngestRequest={...request,source:'soundcloud',externalId:'soundcloud:users:123'};
  const snapshot={source:'soundcloud',externalId:soundcloud.externalId,sourceUpdatedAt:null,coverage:'complete_for_requested_endpoint',warnings:[],events:[],profile:{displayName:'Fixture artist',url:'https://soundcloud.com/fixture-artist'},metrics:['followers','public_track_count','public_playlist_count'].map(key=>({key,value:0,availability:'available',unit:'count',scope:'artist',window:'current',geography:null,precision:'reported'}))};
  const result=validateSnapshot(snapshot,soundcloud);assert.equal(result.profile?.url,'https://soundcloud.com/fixture-artist');assert.equal(result.metrics.length,3);
  snapshot.metrics[0].key='subscribers';assert.throws(()=>validateSnapshot(snapshot,soundcloud),/unsupported_snapshot_metric/);
});
