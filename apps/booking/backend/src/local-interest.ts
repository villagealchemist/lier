/** Source-native local evidence. These rules do not estimate ticket sales or audience size. */
export const LOCAL_INTEREST_RULES = Object.freeze({
  version: 'local-interest-v1',
  snapshotMaxAgeDays: 7,
  audienceMaxAgeDays: 90,
  activityMaxAgeDays: 365,
  maxObservations: 200,
  maxSources: 32,
});

export interface LocalArtist { source: string; id: string; name: string }
export interface LocalMarket { city: string; region?: string; countryCode: string }
export interface LocalMetric {
  key: string;
  label: string;
  value: number | null;
  unit: string;
  scope: 'local_audience' | 'content_global';
}
export interface LocalObservation {
  id: string;
  source: string;
  sourceUrl: string;
  title: string;
  artist: LocalArtist;
  market: LocalMarket;
  kind: 'audience_measurement' | 'audience_estimate' | 'event_listing' | 'city_content';
  match: 'confirmed' | 'candidate';
  fetchedAt: string;
  /** Date of the source observation, not a future performance or retrieval date. */
  observedAt: string;
  metrics: readonly LocalMetric[];
  estimateMethod?: string;
  event?: { startsAt: string | null; venue: string | null; status: string | null };
}
export interface LocalSourceCoverage {
  source: string;
  status: 'ready' | 'no_match' | 'not_configured' | 'unavailable' | 'rate_limited';
  fetchedAt: string;
  note: string;
}
export interface LocalInterestInput {
  artist: LocalArtist;
  market: LocalMarket;
  observations: readonly LocalObservation[];
  coverage: readonly LocalSourceCoverage[];
}
export type LocalExclusionReason = 'invalid' | 'artist_mismatch' | 'market_mismatch' | 'ambiguous_market' | 'future' | 'stale_snapshot' | 'old_observation' | 'source_not_ready' | 'conflict' | 'duplicate';
export interface LocalExcludedObservation { id: string; source: string; reason: LocalExclusionReason }
export interface LocalInterest {
  version: string;
  generatedAt: string;
  artist: LocalArtist;
  market: LocalMarket;
  verdict: 'measured_audience' | 'estimated_audience' | 'local_activity' | 'no_local_evidence' | 'unavailable';
  /** Describes evidence provenance and coverage, never a calibrated confidence probability. */
  evidenceQuality: 'limited' | 'corroborated' | 'direct';
  headline: string;
  summary: string;
  recommendation: string;
  evidence: LocalObservation[];
  candidates: LocalObservation[];
  excluded: LocalExcludedObservation[];
  coverage: LocalSourceCoverage[];
  limitations: string[];
}
export type LocalInterestReport = LocalInterest;

export class LocalInterestInputError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'LocalInterestInputError'; this.code = code; }
}

const dayMs = 86_400_000;
const observationKeys = ['id', 'source', 'sourceUrl', 'title', 'artist', 'market', 'kind', 'match', 'fetchedAt', 'observedAt', 'metrics', 'estimateMethod', 'event'];
const kinds: readonly LocalObservation['kind'][] = ['audience_measurement', 'audience_estimate', 'event_listing', 'city_content'];
const statuses: readonly LocalSourceCoverage['status'][] = ['ready', 'no_match', 'not_configured', 'unavailable', 'rate_limited'];

function record(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
}
function text(value: unknown, maximum = 200): value is string {
  return typeof value === 'string' && value.length <= maximum && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value);
}
function source(value: unknown): value is string { return typeof value === 'string' && /^[a-z][a-z0-9_-]{0,49}$/u.test(value); }
function artist(value: unknown): value is LocalArtist {
  return record(value, ['source', 'id', 'name']) && source(value.source) && text(value.id, 200) && text(value.name, 200);
}
function market(value: unknown): value is LocalMarket {
  return record(value, ['city', 'region', 'countryCode']) && text(value.city, 120)
    && (value.region === undefined || typeof value.region === 'string' && value.region.length <= 120 && !/[\u0000-\u001f\u007f]/u.test(value.region))
    && typeof value.countryCode === 'string' && /^[A-Za-z]{2}$/u.test(value.countryCode);
}
function canonical(value: string): string { return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US'); }
export function sameLocalMarket(left: LocalMarket, right: LocalMarket): boolean {
  if (!market(left) || !market(right)) return false;
  return canonical(left.city) === canonical(right.city) && canonical(left.region ?? '') === canonical(right.region ?? '') && left.countryCode.toUpperCase() === right.countryCode.toUpperCase();
}
function matchesRequestedMarket(requested: LocalMarket, observed: LocalMarket): boolean {
  return canonical(requested.city) === canonical(observed.city) && requested.countryCode.toUpperCase() === observed.countryCode.toUpperCase()
    && (!canonical(requested.region ?? '') || canonical(requested.region ?? '') === canonical(observed.region ?? ''));
}
function instant(value: unknown, allowDay = false): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z)?$/u.exec(value);
  if (!match || !allowDay && match[4] === undefined) return null;
  const milliseconds = Date.parse(match[4] === undefined ? `${value}T00:00:00Z` : value);
  if (!Number.isFinite(milliseconds)) return null;
  const date = new Date(milliseconds);
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() + 1 === Number(match[2]) && date.getUTCDate() === Number(match[3])
    && date.getUTCHours() === Number(match[4] ?? 0) && date.getUTCMinutes() === Number(match[5] ?? 0) && date.getUTCSeconds() === Number(match[6] ?? 0) ? milliseconds : null;
}
function url(value: unknown): string | null {
  if (!text(value, 2048)) return null;
  try {
    const result = new URL(value);
    if (result.protocol !== 'https:' || result.username || result.password || result.port || !result.hostname) return null;
    result.hash = ''; result.searchParams.sort();
    return result.href;
  } catch { return null; }
}
function metric(value: unknown): value is LocalMetric {
  return record(value, ['key', 'label', 'value', 'unit', 'scope']) && text(value.key, 100) && text(value.label, 200) && text(value.unit, 80)
    && (value.value === null || typeof value.value === 'number' && Number.isFinite(value.value) && value.value >= 0 && value.value <= Number.MAX_SAFE_INTEGER)
    && (value.scope === 'local_audience' || value.scope === 'content_global');
}
function observation(value: unknown): value is LocalObservation {
  if (!record(value, observationKeys) || !text(value.id, 200) || !source(value.source) || !url(value.sourceUrl) || !text(value.title, 500)
    || !artist(value.artist) || !market(value.market) || !kinds.includes(value.kind as LocalObservation['kind']) || value.match !== 'confirmed' && value.match !== 'candidate'
    || instant(value.fetchedAt) === null || instant(value.observedAt, true) === null || !Array.isArray(value.metrics) || value.metrics.length > 16 || !value.metrics.every(metric)
    || value.estimateMethod !== undefined && !text(value.estimateMethod, 1000)) return false;
  if (value.kind === 'audience_estimate' && !text(value.estimateMethod, 1000)) return false;
  if (value.kind !== 'audience_estimate' && value.estimateMethod !== undefined) return false;
  if (value.event !== undefined) {
    if (value.kind !== 'event_listing' || !record(value.event, ['startsAt', 'venue', 'status'])
      || value.event.startsAt !== null && instant(value.event.startsAt, true) === null
      || value.event.venue !== null && !text(value.event.venue, 300)
      || value.event.status !== null && !text(value.event.status, 100)) return false;
  }
  const metrics = value.metrics as LocalMetric[];
  if (new Set(metrics.map(item => item.key)).size !== metrics.length) return false;
  const audience = value.kind === 'audience_measurement' || value.kind === 'audience_estimate';
  // City-related content views are never accepted as a measurement of resident audience.
  return metrics.every(item => item.scope === (audience ? 'local_audience' : 'content_global'));
}
function coverage(value: unknown): value is LocalSourceCoverage {
  return record(value, ['source', 'status', 'fetchedAt', 'note']) && source(value.source) && statuses.includes(value.status as LocalSourceCoverage['status'])
    && instant(value.fetchedAt) !== null && typeof value.note === 'string' && value.note.length <= 2000 && !/[\u0000-\u001f\u007f]/u.test(value.note);
}
function clone(item: LocalObservation): LocalObservation {
  return { ...item, artist: { ...item.artist }, market: { ...item.market }, metrics: item.metrics.map(value => ({ ...value })), ...(item.event ? { event: { ...item.event } } : {}) };
}
function signature(item: LocalObservation): string {
  return JSON.stringify({ source: item.source, sourceUrl: url(item.sourceUrl), title: item.title, artist: [item.artist.source, item.artist.id],
    market: [canonical(item.market.city), canonical(item.market.region ?? ''), item.market.countryCode.toUpperCase()], kind: item.kind, match: item.match,
    observedAt: instant(item.observedAt, true), metrics: [...item.metrics].sort((a, b) => a.key.localeCompare(b.key)).map(value => [value.key, value.label, value.value, value.unit, value.scope]),
    estimateMethod: item.estimateMethod ?? null, event: item.event ? [item.event.startsAt === null ? null : instant(item.event.startsAt, true), item.event.venue, item.event.status] : null });
}
function label(value: unknown): { id: string; source: string } {
  const raw = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  return { id: text(raw.id, 200) ? raw.id : 'unknown', source: source(raw.source) ? raw.source : 'unknown' };
}

/**
 * Assess explicit market evidence for one stable artist identity. Adapters own verification
 * of that identity and the source's geography. Names, popularity and population are not
 * identity joins, geographic observations or ticket conversion assumptions.
 */
export function buildLocalInterest(input: LocalInterestInput, now: Date = new Date()): LocalInterest {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new LocalInterestInputError('invalid_evaluation_date');
  if (!record(input, ['artist', 'market', 'observations', 'coverage']) || !artist(input.artist) || !market(input.market)
    || !Array.isArray(input.observations) || input.observations.length > LOCAL_INTEREST_RULES.maxObservations
    || !Array.isArray(input.coverage) || input.coverage.length > LOCAL_INTEREST_RULES.maxSources || !input.coverage.every(coverage)
    || new Set(input.coverage.map(item => item.source)).size !== input.coverage.length) throw new LocalInterestInputError('invalid_local_interest_input');
  const sourceCoverage = input.coverage.map(item => {
    const fetched = instant(item.fetchedAt)!;
    return fetched > nowMs || nowMs - fetched > LOCAL_INTEREST_RULES.snapshotMaxAgeDays * dayMs
      ? { ...item, status: 'unavailable' as const, note: 'The source check is outdated or future-dated; run the market check again.' }
      : { ...item };
  }).sort((a, b) => a.source.localeCompare(b.source));
  const ready = new Set(sourceCoverage.filter(item => item.status === 'ready').map(item => item.source));
  const excluded: LocalExcludedObservation[] = [], valid: LocalObservation[] = [];
  for (const raw of input.observations) {
    if (!observation(raw)) { excluded.push({ ...label(raw), reason: 'invalid' }); continue; }
    valid.push(raw);
  }
  // Unite both ID and URL aliases so a bridge cannot count the same source item twice.
  const parents = valid.map((_item, index) => index);
  const root = (index: number): number => { while (parents[index] !== index) index = parents[index]!; return index; };
  const seen = new Map<string, number>();
  for (let index = 0; index < valid.length; index++) {
    const item = valid[index]!;
    for (const key of [`${item.source}:id:${item.id}`, `${item.source}:url:${url(item.sourceUrl)}`]) {
      const previous = seen.get(key);
      if (previous !== undefined) { const left = root(previous), right = root(index); parents[Math.max(left, right)] = Math.min(left, right); }
      seen.set(key, index);
    }
  }
  const groups = new Map<number, LocalObservation[]>();
  for (let index = 0; index < valid.length; index++) { const key = root(index); groups.set(key, [...groups.get(key) ?? [], valid[index]!]); }
  const evidence: LocalObservation[] = [], candidates: LocalObservation[] = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => instant(b.fetchedAt)! - instant(a.fetchedAt)! || a.id.localeCompare(b.id));
    const item = sorted[0]!;
    const fetched = instant(item.fetchedAt)!, observed = instant(item.observedAt, true)!;
    const sameTime = sorted.filter(value => instant(value.fetchedAt) === fetched);
    let reason: LocalExclusionReason | null = null;
    if (sameTime.some(value => signature(value) !== signature(item)) || group.some(value => value.artist.source !== item.artist.source || value.artist.id !== item.artist.id
      || !sameLocalMarket(value.market, item.market) || value.kind !== item.kind || value.match !== item.match)) reason = 'conflict';
    else if (item.artist.source !== input.artist.source || item.artist.id !== input.artist.id) reason = 'artist_mismatch';
    else if (!matchesRequestedMarket(input.market, item.market)) reason = 'market_mismatch';
    else if (fetched > nowMs || observed > fetched) reason = 'future';
    else if (nowMs - fetched > LOCAL_INTEREST_RULES.snapshotMaxAgeDays * dayMs) reason = 'stale_snapshot';
    else if (nowMs - observed > (item.kind === 'audience_measurement' || item.kind === 'audience_estimate' ? LOCAL_INTEREST_RULES.audienceMaxAgeDays : LOCAL_INTEREST_RULES.activityMaxAgeDays) * dayMs) reason = 'old_observation';
    else if (!ready.has(item.source)) reason = 'source_not_ready';
    if (reason) for (const value of sorted) excluded.push({ ...label(value), reason });
    else {
      (item.match === 'confirmed' ? evidence : candidates).push(clone(item));
      for (const duplicate of sorted.slice(1)) excluded.push({ ...label(duplicate), reason: 'duplicate' });
    }
  }
  if (!canonical(input.market.region ?? '')) {
    const regions = new Set(evidence.map(item => canonical(item.market.region ?? '')).filter(Boolean));
    if (regions.size > 1) {
      for (const item of evidence.splice(0)) {
        candidates.push({ ...item, match: 'candidate' });
        excluded.push({ ...label(item), reason: 'ambiguous_market' });
      }
    }
  }
  const order = (a: LocalObservation, b: LocalObservation): number => instant(b.observedAt, true)! - instant(a.observedAt, true)! || a.source.localeCompare(b.source) || a.id.localeCompare(b.id);
  evidence.sort(order); candidates.sort(order);
  excluded.sort((a, b) => a.source.localeCompare(b.source) || a.id.localeCompare(b.id) || a.reason.localeCompare(b.reason));
  const measured = evidence.filter(item => item.kind === 'audience_measurement' && item.metrics.some(value => value.value !== null));
  const estimated = evidence.filter(item => item.kind === 'audience_estimate' && item.metrics.some(value => value.value !== null));
  const activity = evidence.filter(item => item.kind === 'city_content' || item.kind === 'event_listing' && ['scheduled', 'rescheduled'].includes(canonical(item.event?.status ?? '')));
  const searched = sourceCoverage.some(item => item.status === 'ready' || item.status === 'no_match');
  const verdict: LocalInterest['verdict'] = measured.length ? 'measured_audience' : estimated.length ? 'estimated_audience' : activity.length ? 'local_activity' : searched ? 'no_local_evidence' : 'unavailable';
  const qualifying = [...measured, ...estimated, ...activity];
  const corroborated = new Set(qualifying.map(item => item.source)).size >= 2 && new Set(qualifying.map(item => new URL(item.sourceUrl).hostname)).size >= 2;
  const evidenceQuality = measured.length ? 'direct' : corroborated ? 'corroborated' : 'limited';
  const city = input.market.city.trim();
  const messages: Record<LocalInterest['verdict'], { headline: string; summary: string; recommendation: string }> = {
    measured_audience: {
      headline: `Audience measurements available for ${city}`,
      summary: 'A source explicitly reports audience activity in this market. Each count retains its source, date and original definition.',
      recommendation: 'Use the reported local audience as one booking input alongside recent activity and the show plan. A reported count, including zero, does not by itself establish ticket sales.',
    },
    estimated_audience: {
      headline: `Audience estimates available for ${city}`,
      summary: 'A source supplies a geographically specific audience estimate. Its method and observation date are retained with the evidence.',
      recommendation: 'Use these estimates to prioritize further market research. Validate them against local outcomes before using them to size a show.',
    },
    local_activity: {
      headline: `Public activity found for ${city}`,
      summary: 'Matched public content or event listings connect this artist with the selected market. This establishes a market connection; audience residence remains unknown.',
      recommendation: 'Investigate the linked local activity and compare it with the artist’s wider engagement. Ask the relevant promoter or artist team about past results before setting a sales target.',
    },
    no_local_evidence: {
      headline: `Local demand is still unmeasured in ${city}`,
      summary: candidates.length ? 'The search returned possible matches to review, but no confirmed current local evidence supports an assessment yet.' : 'The completed searches did not establish current local audience or activity. Their coverage is incomplete; this does not mean the artist has no local following.',
      recommendation: candidates.length ? 'Review the possible matches and use the wider artist overview while gathering stronger local evidence.' : 'Use the wider artist overview as context and seek a local audience report or comparable show result before choosing a sales target.',
    },
    unavailable: {
      headline: `Market research is unavailable for ${city}`,
      summary: 'No source completed a usable market check. This is an access or collection gap, not a finding about the artist’s local popularity.',
      recommendation: 'Retry the market check when its sources are available. The broader artist overview remains separate context.',
    },
  };
  return {
    version: LOCAL_INTEREST_RULES.version, generatedAt: now.toISOString(), artist: { ...input.artist }, market: { ...input.market }, verdict, evidenceQuality,
    ...messages[verdict], evidence, candidates, excluded, coverage: sourceCoverage,
    limitations: [
      'This is an evidence assessment, not a trained attendance forecast, popularity score or calibrated probability.',
      'Content views and reactions describe that content’s global response, even when the content concerns this city. They are not counts of residents or ticket buyers.',
      'Only scheduled or rescheduled event listings contribute to local activity. Other statuses remain visible as source evidence without strengthening the assessment. Listings do not establish that a show occurred, sold out or drew a particular audience.',
      'Source audiences overlap and are never added together. Missing values remain unknown; reported zero values stay zero.',
      'Only matching stable artist IDs and matching city and country are included. A supplied region must match; when omitted, conflicting regions require review. Possible name matches require review.',
      `Source checks and snapshots must be no older than ${LOCAL_INTEREST_RULES.snapshotMaxAgeDays} days. Audience observations use a ${LOCAL_INTEREST_RULES.audienceMaxAgeDays}-day window; local activity uses a ${LOCAL_INTEREST_RULES.activityMaxAgeDays}-day window.`,
      'Evidence quality describes provenance and source coverage. Corroboration across sources does not establish independent audiences or validate ticket demand.',
    ],
  };
}
