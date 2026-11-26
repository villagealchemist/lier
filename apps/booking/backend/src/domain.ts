export type Source = 'youtube' | 'lastfm' | 'ticketmaster' | 'spotify' | 'soundcloud';
export type Availability = 'available' | 'hidden' | 'not_returned';
export interface Metric {
  key: string;
  value: number | null;
  availability: Availability;
  unit: 'count' | 'score_0_100';
  scope: 'channel' | 'artist';
  window: 'lifetime' | 'current';
  geography: null;
  precision: 'reported' | 'rounded_down_3_significant_figures';
}
export interface Event {
  externalId: string;
  name: string;
  localDate: string | null;
  venue: string | null;
  city: string | null;
  country: string | null;
  status: string | null;
  attendance: null;
}
export interface Snapshot {
  source: Source;
  externalId: string;
  metrics: Metric[];
  events: Event[];
  coverage: 'complete_for_requested_endpoint' | 'partial';
  sourceUpdatedAt: null;
  warnings: string[];
  profile?: { displayName: string; url?: string };
}
export interface IngestRequest {
  requestId: string;
  artistId: string;
  source: Source;
  externalId: string;
}
export interface AccessPolicy {
  enabled: boolean;
  retentionDays: number;
}
export type Policies = Record<Source, AccessPolicy>;
export interface SourceDefinition {
  source: Source;
  implemented: boolean;
  authentication: string;
  credentialEnv: string;
  metrics: string[];
  profile?: boolean;
  events?: boolean;
  missing: string[];
  scoringAllowed: false;
  docs: string;
}
export const sources: SourceDefinition[] = [
  { source:'youtube',implemented:true,authentication:'YOUTUBE_API_KEY',credentialEnv:'YOUTUBE_API_KEY',metrics:['subscribers','channel_views','public_video_count'],missing:['audience geography','demographics','monthly listeners'],scoringAllowed:false,docs:'https://developers.google.com/youtube/data/reference/rest/v3/channels' },
  { source:'lastfm',implemented:true,authentication:'LASTFM_API_KEY; commercial use agreement required',credentialEnv:'LASTFM_API_KEY',metrics:['listeners','scrobbles'],missing:['market-level ticket demand','Spotify listeners'],scoringAllowed:false,docs:'https://www.last.fm/api/show/artist.getInfo' },
  { source:'ticketmaster',implemented:true,authentication:'TICKETMASTER_API_KEY',credentialEnv:'TICKETMASTER_API_KEY',metrics:[],events:true,missing:['paid attendance','sell-through','settlement'],scoringAllowed:false,docs:'https://developer.ticketmaster.com/products-and-docs/apis/discovery-api/v2/' },
  { source:'spotify',implemented:true,authentication:'SPOTIFY_ACCESS_TOKEN; externally provisioned OAuth access token',credentialEnv:'SPOTIFY_ACCESS_TOKEN',metrics:['followers','popularity'],profile:true,missing:['monthly listeners','listening-city breakdown','fields removed for this app entitlement'],scoringAllowed:false,docs:'https://developer.spotify.com/documentation/web-api/reference/get-an-artist' },
  { source:'soundcloud',implemented:true,authentication:'SOUNDCLOUD_ACCESS_TOKEN; externally provisioned OAuth access token',credentialEnv:'SOUNDCLOUD_ACCESS_TOKEN',metrics:['followers','public_track_count','public_playlist_count'],profile:true,missing:['listener geography','monthly listeners','user-level total plays'],scoringAllowed:false,docs:'https://developers.soundcloud.com/docs/api/explorer/api.json' }
];
export class IngestionError extends Error {
  code: string;
  retryAfterMs: number | null;
  constructor(code: string, retryAfterMs: number | null = null) {
    super(code); this.code=code; this.retryAfterMs=retryAfterMs;
  }
}
export function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new IngestionError('invalid_provider_payload');
  return value as Record<string, any>;
}
export function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new IngestionError('invalid_provider_payload');
  return value;
}
export function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length>2000) throw new IngestionError('invalid_provider_payload');
  return value;
}
export function count(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (!(typeof value==='number' || typeof value==='string' && /^\d+$/.test(value))) throw new IngestionError('invalid_provider_metric');
  const n=Number(value);
  if (!Number.isSafeInteger(n) || n<0) throw new IngestionError('invalid_provider_metric');
  return n;
}
export function metric(key: string, value: unknown, scope: Metric['scope'], window: Metric['window'], precision: Metric['precision']='reported'): Metric {
  const parsed=count(value);
  return {key,value:parsed,availability:parsed===null?'not_returned':'available',scope,window,unit:'count',geography:null,precision};
}
export function validateRequest(input: unknown): IngestRequest {
  const r=object(input);
  if(Object.keys(r).some(k=>!['requestId','artistId','source','externalId'].includes(k)))throw new IngestionError('unknown_request_field');
  for(const key of ['requestId','artistId'])if(typeof r[key]!=='string'|| !/^[a-zA-Z0-9_-]{1,100}$/.test(r[key]))throw new IngestionError(`invalid_${key}`);
  if(!sources.some(s=>s.source===r.source))throw new IngestionError('source_not_implemented');
  if(typeof r.externalId!=='string'||r.externalId.length>200||!r.externalId.trim())throw new IngestionError('invalid_externalId');
  if(r.source==='youtube'&&!/^UC[A-Za-z0-9_-]{22}$/.test(r.externalId))throw new IngestionError('youtube_requires_channel_id');
  if(r.source==='lastfm'&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(r.externalId))throw new IngestionError('lastfm_requires_mbid');
  if(r.source==='ticketmaster'&&!/^[A-Za-z0-9_-]+$/.test(r.externalId))throw new IngestionError('invalid_attraction_id');
  if(r.source==='spotify'&&!/^[A-Za-z0-9]{22}$/.test(r.externalId))throw new IngestionError('spotify_requires_artist_id');
  if(r.source==='soundcloud'&&!/^soundcloud:users:[1-9]\d{0,19}$/.test(r.externalId))throw new IngestionError('soundcloud_requires_user_urn');
  // MBIDs are case-insensitive UUIDs. Canonicalize before hashing or linking,
  // and never mutate the caller's request object.
  return {requestId:r.requestId,artistId:r.artistId,source:r.source,externalId:r.source==='lastfm'?r.externalId.toLowerCase():r.externalId};
}
