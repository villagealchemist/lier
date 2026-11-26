import { IngestionError, object, list, text, metric } from './domain.ts';
import type { Snapshot, IngestRequest, Event } from './domain.ts';
import type { JsonGet } from './http.ts';
export type Credentials = Partial<Record<'YOUTUBE_API_KEY'|'LASTFM_API_KEY'|'TICKETMASTER_API_KEY'|'SPOTIFY_ACCESS_TOKEN'|'SOUNDCLOUD_ACCESS_TOKEN',string>>;
const base=(r:IngestRequest):Snapshot=>({source:r.source,externalId:r.externalId,metrics:[],events:[],sourceUpdatedAt:null,coverage:'complete_for_requested_endpoint',warnings:[]});
function publicProfileUrl(value:unknown,host:string):string|undefined {
  if(value===undefined||value===null)return undefined;
  let url:URL;
  try{url=new URL(text(value));}catch{throw new IngestionError('invalid_provider_profile');}
  if(url.protocol!=='https:'||url.hostname!==host||url.port||url.username||url.password||url.search||url.hash||url.pathname==='/')throw new IngestionError('invalid_provider_profile');
  return url.href;
}
function nativeInteger(value:unknown):number|null {
  if(value===undefined||value===null)return null;
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw new IngestionError('invalid_provider_metric');
  return value;
}
export function parseSpotify(payload:unknown,r:IngestRequest):Snapshot {
  const artist=object(payload);
  if(artist.error)throw new IngestionError('provider_application_error');
  if(artist.id!==r.externalId||artist.type!=='artist')throw new IngestionError('identity_mismatch');
  const result=base(r),followers=artist.followers===undefined||artist.followers===null?null:object(artist.followers);
  const popularity=nativeInteger(artist.popularity);
  if(popularity!==null&&popularity>100)throw new IngestionError('invalid_provider_metric');
  const urls=artist.external_urls===undefined||artist.external_urls===null?null:object(artist.external_urls);
  const url=publicProfileUrl(urls?.spotify,'open.spotify.com');
  if(url&&new URL(url).pathname!==`/artist/${r.externalId}`)throw new IngestionError('identity_mismatch');
  result.profile={displayName:text(artist.name),...(url?{url}:{})};
  result.metrics=[metric('followers',nativeInteger(followers?.total),'artist','current'),{...metric('popularity',popularity,'artist','current'),unit:'score_0_100'}];
  if(result.metrics.some(m=>m.value===null))result.coverage='partial';
  result.warnings=['Follower and popularity fields depend on app entitlement and may be absent. This endpoint supplies neither monthly listeners nor listening-city breakdowns. Popularity is Spotify’s platform score, not a LIER booking score.'];
  return result;
}
export function parseSoundCloud(payload:unknown,r:IngestRequest):Snapshot {
  const user=object(payload);
  if(user.error||user.errors)throw new IngestionError('provider_application_error');
  if(user.urn!==r.externalId||user.kind!=='user')throw new IngestionError('identity_mismatch');
  const result=base(r),url=publicProfileUrl(user.permalink_url,'soundcloud.com');
  result.profile={displayName:text(user.username),...(url?{url}:{})};
  result.metrics=[metric('followers',nativeInteger(user.followers_count),'artist','current'),metric('public_track_count',nativeInteger(user.track_count),'artist','current'),metric('public_playlist_count',nativeInteger(user.playlist_count),'artist','current')];
  if(result.metrics.some(m=>m.value===null))result.coverage='partial';
  result.warnings=['SoundCloud user counts describe the linked account. Profile city and country are not audience geography. Track-level playback counts are not returned by this user adapter.'];
  return result;
}
export function parseYouTube(payload:unknown,r:IngestRequest):Snapshot{
  const body=object(payload);if(body.error)throw new IngestionError('provider_application_error');
  const items=list(body.items);if(items.length===0)throw new IngestionError('provider_not_found');
  const item=object(items[0]);if(items.length!==1||item.id!==r.externalId)throw new IngestionError('identity_mismatch');
  const stats=object(item.statistics),result=base(r);
  if(typeof stats.hiddenSubscriberCount!=='boolean')throw new IngestionError('invalid_provider_payload');
  const subs=metric('subscribers',stats.hiddenSubscriberCount?null:stats.subscriberCount,'channel','current','rounded_down_3_significant_figures');
  if(stats.hiddenSubscriberCount)subs.availability='hidden';
  result.metrics=[subs,metric('channel_views',stats.viewCount,'channel','lifetime'),metric('public_video_count',stats.videoCount,'channel','current')];
  if(result.metrics.some(m=>m.value===null))result.coverage='partial';
  result.warnings=['Channel subscribers may be rounded. No city, demographic, or monthly-listener claims. YouTube data is excluded from scoring.'];
  return result;
}
export function parseLastFm(payload:unknown,r:IngestRequest):Snapshot{
  const body=object(payload);if(body.error)throw new IngestionError('provider_application_error');
  const artist=object(body.artist);if(typeof artist.mbid!=='string'||artist.mbid.toLowerCase()!==r.externalId.toLowerCase())throw new IngestionError('identity_mismatch');
  const stats=object(artist.stats),result=base(r);
  result.metrics=[metric('listeners',stats.listeners,'artist','lifetime'),metric('scrobbles',stats.playcount,'artist','lifetime')];
  if(result.metrics.some(m=>m.value===null))result.coverage='partial';
  result.warnings=['Last.fm counters are not Spotify monthly listeners. No cross-platform audience deduplication.'];
  return result;
}
export function parseEvent(payload:unknown,attractionId:string):Event{
  const e=object(payload),embedded=object(e._embedded),attractions=list(embedded.attractions);
  if(!attractions.some(a=>object(a).id===attractionId))throw new IngestionError('identity_mismatch');
  const venues=embedded.venues===undefined?[]:list(embedded.venues);const venue=venues.length?object(venues[0]):null;
  const dates=e.dates===undefined?null:object(e.dates);
  const optional=(x:unknown)=>x===null||x===undefined?null:text(x);
  return {externalId:text(e.id),name:text(e.name),localDate:optional(dates?.start?.localDate),venue:optional(venue?.name),city:optional(venue?.city?.name),country:optional(venue?.country?.countryCode),status:optional(dates?.status?.code),attendance:null};
}
export function providerCollector(get:JsonGet,credentials:Credentials){
  return async(r:IngestRequest):Promise<Snapshot>=>{
    if(r.source==='spotify'){
      if(!credentials.SPOTIFY_ACCESS_TOKEN)throw new IngestionError('credentials_missing');
      const url=new URL(`https://api.spotify.com/v1/artists/${encodeURIComponent(r.externalId)}`);
      return parseSpotify(await get(url,{authorization:`Bearer ${credentials.SPOTIFY_ACCESS_TOKEN}`}),r);
    }
    if(r.source==='soundcloud'){
      if(!credentials.SOUNDCLOUD_ACCESS_TOKEN)throw new IngestionError('credentials_missing');
      const url=new URL(`https://api.soundcloud.com/users/${encodeURIComponent(r.externalId)}`);
      return parseSoundCloud(await get(url,{authorization:`OAuth ${credentials.SOUNDCLOUD_ACCESS_TOKEN}`}),r);
    }
    if(r.source==='youtube'){
      if(!credentials.YOUTUBE_API_KEY)throw new IngestionError('credentials_missing');
      const url=new URL('https://www.googleapis.com/youtube/v3/channels');url.search=new URLSearchParams({id:r.externalId,part:'statistics',key:credentials.YOUTUBE_API_KEY}).toString();
      return parseYouTube(await get(url),r);
    }
    if(r.source==='lastfm'){
      if(!credentials.LASTFM_API_KEY)throw new IngestionError('credentials_missing');
      const url=new URL('https://ws.audioscrobbler.com/2.0/');url.search=new URLSearchParams({method:'artist.getinfo',mbid:r.externalId,autocorrect:'0',api_key:credentials.LASTFM_API_KEY,format:'json'}).toString();
      return parseLastFm(await get(url),r);
    }
    if(r.source!=='ticketmaster')throw new IngestionError('source_not_implemented');
    if(!credentials.TICKETMASTER_API_KEY)throw new IngestionError('credentials_missing');
    const result=base(r),seen=new Set<string>();
    for(let page=0;page<5;page++){
      const url=new URL('https://app.ticketmaster.com/discovery/v2/events.json');url.search=new URLSearchParams({attractionId:r.externalId,size:'200',page:String(page),apikey:credentials.TICKETMASTER_API_KEY}).toString();
      const body=object(await get(url));if(body.errors||body.fault)throw new IngestionError('provider_application_error');
      const paging=object(body.page);if(!Number.isSafeInteger(paging.totalPages)||paging.totalPages<0||paging.number!==page)throw new IngestionError('invalid_provider_pagination');
      const items=body._embedded===undefined?[]:list(object(body._embedded).events);
      for(const item of items){const event=parseEvent(item,r.externalId);if(!seen.has(event.externalId)){result.events.push(event);seen.add(event.externalId);}}
      if(page+1>=paging.totalPages)break;
      if(page===4){result.coverage='partial';result.warnings.push('Provider deep-paging limit reached. Coverage is incomplete.');}
    }
    result.warnings.push('Event listings do not include paid attendance or prove sell-through. This is provider coverage, not a complete touring history.');
    return result;
  };
}
