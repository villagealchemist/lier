import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSpotify, parseSoundCloud, providerCollector } from '../src/providers.ts';
import { createJsonGet } from '../src/http.ts';
import { validateRequest, sources } from '../src/domain.ts';
import type { IngestRequest } from '../src/domain.ts';
const spotify:IngestRequest={requestId:'spotify-fixture',artistId:'fixture-artist',source:'spotify',externalId:'abcdefghijklmnopqrstuv'};
const soundcloud:IngestRequest={requestId:'soundcloud-fixture',artistId:'fixture-artist',source:'soundcloud',externalId:'soundcloud:users:12345678'};
const spotifyBody=()=>({id:spotify.externalId,type:'artist',name:'Synthetic Fixture Artist',external_urls:{spotify:`https://open.spotify.com/artist/${spotify.externalId}`},followers:{total:12500},popularity:42});
const soundcloudBody=()=>({urn:soundcloud.externalId,kind:'user',username:'Synthetic Fixture Artist',permalink_url:'https://soundcloud.com/synthetic-fixture',followers_count:2345,track_count:0,playlist_count:8,city:'Philadelphia',country:'US'});

test('Spotify records exposed native follower and platform score fields with identity',()=>{
  const result=parseSpotify(spotifyBody(),spotify);
  assert.equal(result.profile?.displayName,'Synthetic Fixture Artist');
  assert.equal(result.profile?.url,`https://open.spotify.com/artist/${spotify.externalId}`);
  assert.equal(result.metrics[0].value,12500);
  assert.equal(result.metrics[0].unit,'count');
  assert.equal(result.metrics[1].value,42);
  assert.equal(result.metrics[1].unit,'score_0_100');
  assert.equal(result.coverage,'complete_for_requested_endpoint');
  assert.ok(result.metrics.every(m=>m.geography===null&&m.window==='current'));
  assert.deepEqual(result.metrics.map(m=>m.key),['followers','popularity']);
});

test('Spotify entitlement-limited fields stay missing rather than becoming zero',()=>{
  const result=parseSpotify({id:spotify.externalId,type:'artist',name:'Fixture'},spotify);
  assert.equal(result.coverage,'partial');
  assert.ok(result.metrics.every(m=>m.value===null&&m.availability==='not_returned'));
  assert.deepEqual(result.profile,{displayName:'Fixture'});
  const zero=spotifyBody();zero.followers.total=0;zero.popularity=0;
  assert.ok(parseSpotify(zero,spotify).metrics.every(m=>m.value===0&&m.availability==='available'));
});

test('Spotify rejects unrelated objects, malformed counters, and invalid popularity range',()=>{
  assert.throws(()=>parseSpotify({...spotifyBody(),type:'user'},spotify),/identity_mismatch/);
  assert.throws(()=>parseSpotify({...spotifyBody(),id:'different'},spotify),/identity_mismatch/);
  for(const popularity of [-1,101,1.5,'20',true])assert.throws(()=>parseSpotify({...spotifyBody(),popularity},spotify),/invalid_provider_metric/);
  assert.throws(()=>parseSpotify({...spotifyBody(),followers:{total:'12500'}},spotify),/invalid_provider_metric/);
  assert.throws(()=>parseSpotify({error:{message:'TOKEN-SECRET'}},spotify),error=>error instanceof Error&&error.message==='provider_application_error');
});

test('Spotify profile links cannot point to another artist or carry credentials',()=>{
  for(const url of ['https://evil.example/artist/a','https://open.spotify.com/artist/other','https://open.spotify.com/artist/abcdefghijklmnopqrstuv?access_token=secret','http://open.spotify.com/artist/abcdefghijklmnopqrstuv','https://name:password@open.spotify.com/artist/abcdefghijklmnopqrstuv']){
    assert.throws(()=>parseSpotify({...spotifyBody(),external_urls:{spotify:url}},spotify),/invalid_provider_profile|identity_mismatch/);
  }
});

test('SoundCloud retains current account counters without promoting hometown into geography',()=>{
  const result=parseSoundCloud(soundcloudBody(),soundcloud);
  assert.deepEqual(result.metrics.map(m=>[m.key,m.value]),[['followers',2345],['public_track_count',0],['public_playlist_count',8]]);
  assert.ok(result.metrics.every(m=>m.geography===null&&m.window==='current'&&m.unit==='count'));
  assert.equal(result.sourceUpdatedAt,null);
  assert.equal(result.profile?.displayName,'Synthetic Fixture Artist');
  assert.equal(result.profile?.url,'https://soundcloud.com/synthetic-fixture');
  assert.equal(result.coverage,'complete_for_requested_endpoint');
});

test('SoundCloud missing counters are explicit and legacy mismatched IDs do not join',()=>{
  const result=parseSoundCloud({urn:soundcloud.externalId,kind:'user',username:'Fixture'},soundcloud);
  assert.equal(result.coverage,'partial');
  assert.ok(result.metrics.every(m=>m.value===null&&m.availability==='not_returned'));
  assert.throws(()=>parseSoundCloud({...soundcloudBody(),urn:'soundcloud:users:999'},soundcloud),/identity_mismatch/);
  assert.throws(()=>parseSoundCloud({id:12345678,kind:'user',username:'Fixture'},soundcloud),/identity_mismatch/);
  assert.throws(()=>parseSoundCloud({...soundcloudBody(),kind:'track'},soundcloud),/identity_mismatch/);
  assert.throws(()=>parseSoundCloud({...soundcloudBody(),followers_count:'2345'},soundcloud),/invalid_provider_metric/);
});

test('stable Spotify IDs and SoundCloud user URNs are required at the request boundary',()=>{
  assert.deepEqual(validateRequest(spotify),spotify);
  assert.deepEqual(validateRequest(soundcloud),soundcloud);
  for(const externalId of ['Some artist','spotify:artist:abcdefghijklmnopqrstuv','https://open.spotify.com/artist/abcdefghijklmnopqrstuv'])assert.throws(()=>validateRequest({...spotify,externalId}),/spotify_requires_artist_id/);
  for(const externalId of ['fixture-artist','12345678','urn:soundcloud:users:12345678','soundcloud:users:000123','soundcloud:tracks:12345678'])assert.throws(()=>validateRequest({...soundcloud,externalId}),/soundcloud_requires_user_urn/);
});

test('provider requests use the platform-specific Authorization scheme and no token query strings',async()=>{
  const calls:{url:string;authorization:string|undefined}[]=[];
  const collect=providerCollector(async(url,options)=>{calls.push({url:url.href,authorization:options?.authorization});return url.hostname==='api.spotify.com'?spotifyBody():soundcloudBody();},{SPOTIFY_ACCESS_TOKEN:'SPOTIFY_SECRET',SOUNDCLOUD_ACCESS_TOKEN:'SOUNDCLOUD_SECRET'});
  await collect(spotify);await collect(soundcloud);
  assert.deepEqual(calls,[
    {url:`https://api.spotify.com/v1/artists/${spotify.externalId}`,authorization:'Bearer SPOTIFY_SECRET'},
    {url:'https://api.soundcloud.com/users/soundcloud%3Ausers%3A12345678',authorization:'OAuth SOUNDCLOUD_SECRET'}
  ]);
  assert.ok(calls.every(c=>!c.url.includes('SECRET')));
});

test('missing externally provisioned access tokens fail before a provider call',async()=>{
  let calls=0;const collect=providerCollector(async()=>{calls++;return {};},{});
  await assert.rejects(collect(spotify),/credentials_missing/);
  await assert.rejects(collect(soundcloud),/credentials_missing/);
  assert.equal(calls,0);
});

test('transport permits only the expected auth scheme on each approved token endpoint host',async()=>{
  const calls:RequestInit[]=[];
  const get=createJsonGet({fetcher:async(_url,options)=>{calls.push(options??{});return Response.json({ok:true});}});
  await get(new URL('https://api.spotify.com/v1/artists/abcdefghijklmnopqrstuv'),{authorization:'Bearer secret-token'});
  await get(new URL('https://api.soundcloud.com/users/soundcloud%3Ausers%3A12345678'),{authorization:'OAuth secret-token'});
  assert.equal(new Headers(calls[0].headers).get('Authorization'),'Bearer secret-token');
  assert.equal(new Headers(calls[1].headers).get('Authorization'),'OAuth secret-token');
  assert.equal(calls[0].redirect,'error');
  await assert.rejects(get(new URL('https://api.soundcloud.com/users/x'),{authorization:'Bearer secret-token'}),/invalid_provider_authorization/);
  await assert.rejects(get(new URL('https://www.googleapis.com/'),{authorization:'Bearer secret-token'}),/invalid_provider_authorization/);
  await assert.rejects(get(new URL('https://api.spotify.com/v1/artists/x'),{authorization:'Bearer secret\r\nInjected: true'}),/invalid_provider_authorization/);
  assert.equal(calls.length,2);
});

test('public identity resolver can send a safe identified User-Agent without auth',async()=>{
  let headers:Headers|undefined;
  const get=createJsonGet({fetcher:async(_url,options)=>{headers=new Headers(options?.headers);return Response.json({search:[]});}});
  await get(new URL('https://www.wikidata.org/w/api.php'),{userAgent:'LIER/0.2.0 (test@example.com)'});
  assert.equal(headers?.get('User-Agent'),'LIER/0.2.0 (test@example.com)');
  assert.equal(headers?.get('Authorization'),null);
  await assert.rejects(get(new URL('https://www.wikidata.org/w/api.php'),{userAgent:'LIER\nX-Injected: true'}),/invalid_user_agent/);
  await assert.rejects(get(new URL('https://www.wikidata.org/w/api.php'),{userAgent:' '.repeat(300)}),/invalid_user_agent/);
});

test('new source capabilities report missing analytics and credential variable names truthfully',()=>{
  const sp=sources.find(s=>s.source==='spotify')!,sc=sources.find(s=>s.source==='soundcloud')!;
  assert.equal(sp.credentialEnv,'SPOTIFY_ACCESS_TOKEN');assert.equal(sc.credentialEnv,'SOUNDCLOUD_ACCESS_TOKEN');
  assert.deepEqual(sp.metrics,['followers','popularity']);assert.ok(sp.missing.includes('monthly listeners'));
  assert.deepEqual(sc.metrics,['followers','public_track_count','public_playlist_count']);
  assert.equal(sp.scoringAllowed,false);assert.equal(sc.scoringAllowed,false);
});
