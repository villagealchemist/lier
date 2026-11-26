import { IngestionError, sources } from './domain.ts';
import type { Event, IngestRequest, Metric, Snapshot } from './domain.ts';

type MetricShape = {
  unit: 'count' | 'score_0_100';
  scope: 'channel' | 'artist';
  window: 'lifetime' | 'current';
  precision: 'reported' | 'rounded_down_3_significant_figures';
};
const shape = (scope: MetricShape['scope'], window: MetricShape['window'], unit: MetricShape['unit']='count', precision: MetricShape['precision']='reported'): MetricShape => ({scope, window, unit, precision});
const metricShapes: Record<string, Record<string, MetricShape>> = {
  youtube: {
    subscribers: shape('channel', 'current', 'count', 'rounded_down_3_significant_figures'),
    channel_views: shape('channel', 'lifetime'),
    public_video_count: shape('channel', 'current')
  },
  lastfm: {listeners: shape('artist', 'lifetime'), scrobbles: shape('artist', 'lifetime')},
  ticketmaster: {},
  spotify: {followers: shape('artist', 'current'), popularity: shape('artist', 'current', 'score_0_100')},
  soundcloud: {followers: shape('artist', 'current'), public_track_count: shape('artist', 'current'), public_playlist_count: shape('artist', 'current')}
};
const rootKeys = ['source','externalId','metrics','events','coverage','sourceUpdatedAt','warnings'];
const metricKeys = ['key','value','availability','unit','scope','window','geography','precision'];
const eventKeys = ['externalId','name','localDate','venue','city','country','status','attendance'];

function invalid(code='invalid_snapshot'): never { throw new IngestionError(code); }
function record(value: unknown): Record<string, unknown> {
  if (value===null || typeof value!=='object' || Array.isArray(value)) return invalid();
  const prototype=Object.getPrototypeOf(value);
  if (prototype!==Object.prototype && prototype!==null) return invalid();
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!('value' in descriptor)) return invalid();
  }
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, required: string[], optional: string[]=[]): void {
  const own=Reflect.ownKeys(value);
  if (own.some(key=>typeof key!=='string' || !required.includes(key) && !optional.includes(key))) invalid('unknown_snapshot_field');
  if (required.some(key=>!Object.hasOwn(value,key))) invalid();
}
function boundedText(value: unknown, max: number): string {
  if (typeof value!=='string' || !value.trim() || value.length>max || value.includes('\0')) return invalid();
  return value;
}
function nullableText(value: unknown, max: number): string | null { return value===null ? null : boundedText(value,max); }
function boundedArray(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length>max) return invalid();
  return value;
}
function calendarDate(value: unknown): string | null {
  if (value===null) return null;
  if (typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return invalid();
  const date=new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0,10)!==value) return invalid();
  return value;
}
function validateMetric(input: unknown, request: IngestRequest, allowed: string[]): Metric {
  const value=record(input); keys(value,metricKeys);
  const key=boundedText(value.key,100);
  if (!allowed.includes(key)) return invalid('unsupported_snapshot_metric');
  const expected=metricShapes[request.source]?.[key];
  if (!expected || value.unit!==expected.unit || value.scope!==expected.scope || value.window!==expected.window || value.precision!==expected.precision || value.geography!==null) return invalid('invalid_snapshot_metric');
  const availability=value.availability;
  if (availability!=='available' && availability!=='hidden' && availability!=='not_returned') return invalid('invalid_snapshot_metric');
  if (availability==='hidden' && !(request.source==='youtube' && key==='subscribers')) return invalid('invalid_snapshot_metric');
  const number=value.value;
  if (availability==='available') {
    if (typeof number!=='number' || !Number.isSafeInteger(number) || number<0 || expected.unit==='score_0_100' && number>100) return invalid('invalid_snapshot_metric');
  } else if (number!==null) return invalid('invalid_snapshot_metric');
  // The branches above establish the value type before reconstructing this record.
  return {key, value: typeof number==='number' ? number : null, availability, unit:expected.unit, scope:expected.scope, window:expected.window, geography:null, precision:expected.precision};
}
function validateEvent(input: unknown): Event {
  const value=record(input); keys(value,eventKeys);
  if (value.attendance!==null) return invalid('invalid_snapshot_event');
  return {
    externalId:boundedText(value.externalId,200), name:boundedText(value.name,500),
    localDate:calendarDate(value.localDate), venue:nullableText(value.venue,500),
    city:nullableText(value.city,300), country:nullableText(value.country,100),
    status:nullableText(value.status,100), attendance:null
  };
}
function validateProfile(input: unknown, request: IngestRequest): {displayName:string;url?:string} {
  if (request.source!=='spotify' && request.source!=='soundcloud') return invalid('unsupported_snapshot_profile');
  const value=record(input); keys(value,['displayName'],['url']);
  const profile:{displayName:string;url?:string}={displayName:boundedText(value.displayName,300)};
  if (Object.hasOwn(value,'url')) {
    const raw=boundedText(value.url,2000); let url:URL;
    try { url=new URL(raw); } catch { return invalid('invalid_snapshot_profile_url'); }
    const host=request.source==='spotify'?'open.spotify.com':'soundcloud.com';
    if (url.protocol!=='https:' || url.hostname!==host || url.port || url.username || url.password || url.search || url.hash || request.source==='spotify' && url.pathname!==`/artist/${request.externalId}`) return invalid('invalid_snapshot_profile_url');
    profile.url=url.toString();
  }
  return profile;
}

/** Validate normalized provider output before it crosses the persistence boundary. */
export function validateSnapshot(input: unknown, request: IngestRequest): Snapshot {
  const value=record(input); keys(value,rootKeys,['profile']);
  const definition=sources.find(source=>source.source===request.source);
  if (!definition || !metricShapes[request.source]) return invalid('unsupported_snapshot_source');
  if (value.source!==request.source || value.externalId!==request.externalId) return invalid('identity_mismatch');
  if (value.sourceUpdatedAt!==null) return invalid('invalid_snapshot_source_time');
  const coverage=value.coverage;
  if (coverage!=='complete_for_requested_endpoint' && coverage!=='partial') return invalid('invalid_snapshot_coverage');
  const metrics=boundedArray(value.metrics,20).map(item=>validateMetric(item,request,definition.metrics));
  const seenMetrics=new Set(metrics.map(item=>item.key));
  if (seenMetrics.size!==metrics.length) return invalid('duplicate_snapshot_metric');
  const expectedKeys=Object.keys(metricShapes[request.source]);
  if (metrics.length!==expectedKeys.length || expectedKeys.some(key=>!seenMetrics.has(key))) return invalid('incomplete_snapshot_metrics');
  if (coverage==='complete_for_requested_endpoint' && metrics.some(item=>item.availability!=='available')) return invalid('invalid_snapshot_coverage');
  const events=boundedArray(value.events,1000).map(validateEvent);
  if (events.length && request.source!=='ticketmaster') return invalid('unsupported_snapshot_events');
  if (new Set(events.map(event=>event.externalId)).size!==events.length) return invalid('duplicate_snapshot_event');
  const warnings=boundedArray(value.warnings,30).map(item=>boundedText(item,1000));
  const snapshot:Snapshot={source:request.source, externalId:request.externalId, metrics, events, coverage, sourceUpdatedAt:null, warnings};
  if (Object.hasOwn(value,'profile')) snapshot.profile=validateProfile(value.profile,request);
  return snapshot;
}
