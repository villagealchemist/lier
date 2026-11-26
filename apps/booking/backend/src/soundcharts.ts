/** Optional licensed data source. No signup, purchase, cache, or automatic ingestion side effects. */
export interface SoundchartsCredentials {
  SOUNDCHARTS_APP_ID?: string;
  SOUNDCHARTS_API_KEY?: string;
}

export interface AudienceMarket {
  city: string;
  countryCode: string;
  /** Match the provider's region name exactly when cities in one country share a name. */
  region?: string;
}

export interface SoundchartsCityAudience {
  city: string;
  countryCode: string;
  region: string;
  monthlyListeners: number | null;
  observedAt: string;
}

export interface SoundchartsAudienceSnapshot {
  observedAt: string;
  globalMonthlyListeners: number | null;
  cities: SoundchartsCityAudience[];
}

export interface SoundchartsMarketAudience {
  requested: AudienceMarket;
  status: 'observed' | 'not_returned' | 'ambiguous';
  monthlyListeners: number | null;
  observedAt: string | null;
  city: SoundchartsCityAudience | null;
}

export interface SpotifyLocalAudience {
  source: 'soundcharts';
  platform: 'spotify';
  dataset: 'sandbox' | 'production';
  identity: { spotifyId: string; soundchartsId: string; artistName: string; matchedBy: 'spotify_platform_id' };
  fetchedAt: string;
  providerLastCrawlAt: string | null;
  requestedRange: { startDate: string; endDate: string };
  metric: 'monthly_listeners';
  window: { kind: 'rolling'; days: 28 };
  cityCoverage: 'top_50_only';
  cityRefresh: 'weekly';
  historyTruncated: boolean;
  snapshots: SoundchartsAudienceSnapshot[];
  market: SoundchartsMarketAudience | null;
  note: string;
}

export type SoundchartsErrorCode =
  | 'credentials_missing' | 'invalid_credentials' | 'invalid_spotify_id' | 'invalid_market'
  | 'credentials_rejected' | 'access_denied' | 'not_found' | 'rate_limited'
  | 'provider_unavailable' | 'provider_request_rejected' | 'provider_unreachable'
  | 'provider_timeout' | 'redirect_rejected' | 'payload_too_large' | 'invalid_payload'
  | 'provider_application_error' | 'identity_mismatch';

export class SoundchartsError extends Error {
  readonly code: SoundchartsErrorCode;
  readonly retryAfterSeconds: number | null;
  constructor(code: SoundchartsErrorCode, retryAfterSeconds: number | null = null) {
    super(code);
    this.name = 'SoundchartsError';
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

interface Options {
  fetcher?: typeof fetch;
  now?: () => number;
}

const origin = 'https://customer.api.soundcharts.com';
const maxBytes = 1_000_000;
const maxSnapshots = 31;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const dayMs = 86_400_000;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SoundchartsError('invalid_payload');
  return value as Record<string, unknown>;
}

function text(value: unknown, max = 300): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new SoundchartsError('invalid_payload');
  return value;
}

function counter(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new SoundchartsError('invalid_payload');
  return value;
}

function date(value: unknown, now: number): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw new SoundchartsError('invalid_payload');
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const instant = Date.parse(value);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() || !Number.isFinite(instant) || instant > now) throw new SoundchartsError('invalid_payload');
  return new Date(instant).toISOString();
}

function normalize(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function validateMarket(market: AudienceMarket | undefined): AudienceMarket | undefined {
  if (market === undefined) return undefined;
  if (!market || typeof market.city !== 'string' || !market.city.trim() || market.city.length > 200 || typeof market.countryCode !== 'string' || !/^[a-z]{2}$/i.test(market.countryCode) || (market.region !== undefined && (typeof market.region !== 'string' || !market.region.trim() || market.region.length > 200))) throw new SoundchartsError('invalid_market');
  return { city: market.city.trim(), countryCode: market.countryCode.toUpperCase(), ...(market.region === undefined ? {} : { region: market.region.trim() }) };
}

function applicationBody(body: unknown): Record<string, unknown> {
  const value = object(body);
  if (!Array.isArray(value.errors)) throw new SoundchartsError('invalid_payload');
  if (value.errors.length) throw new SoundchartsError('provider_application_error');
  return value;
}

function retryAfter(value: string | null, now: number): number | null {
  if (value === null) return null;
  const seconds = /^\d+$/.test(value) ? Number(value) : Math.max(0, Math.ceil((Date.parse(value) - now) / 1000));
  return Number.isSafeInteger(seconds) ? seconds : null;
}

async function getJson(url: URL, credentials: Required<SoundchartsCredentials>, fetcher: typeof fetch, now: number): Promise<unknown> {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      void reader?.cancel().catch(() => {});
      reject(new SoundchartsError('provider_timeout'));
    }, 10_000);
  });
  const request = async (): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetcher(url, {
        method: 'GET', redirect: 'error', signal: controller.signal,
        headers: { Accept: 'application/json', 'x-app-id': credentials.SOUNDCHARTS_APP_ID, 'x-api-key': credentials.SOUNDCHARTS_API_KEY },
      });
    } catch {
      throw new SoundchartsError(controller.signal.aborted ? 'provider_timeout' : 'provider_unreachable');
    }
    if (!response.ok || response.redirected) {
      void response.body?.cancel().catch(() => {});
      if (response.redirected || (response.status >= 300 && response.status < 400)) throw new SoundchartsError('redirect_rejected');
      if (response.status === 401) throw new SoundchartsError('credentials_rejected');
      if (response.status === 403) throw new SoundchartsError('access_denied');
      if (response.status === 404) throw new SoundchartsError('not_found');
      if (response.status === 429) throw new SoundchartsError('rate_limited', retryAfter(response.headers.get('retry-after'), now));
      throw new SoundchartsError(response.status >= 500 ? 'provider_unavailable' : 'provider_request_rejected');
    }
    if (Number(response.headers.get('content-length')) > maxBytes) {
      void response.body?.cancel().catch(() => {});
      throw new SoundchartsError('payload_too_large');
    }
    if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json') || !response.body) {
      void response.body?.cancel().catch(() => {});
      throw new SoundchartsError('invalid_payload');
    }
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          void reader.cancel().catch(() => {});
          throw new SoundchartsError('payload_too_large');
        }
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      if (error instanceof SoundchartsError) throw error;
      throw new SoundchartsError(controller.signal.aborted ? 'provider_timeout' : 'invalid_payload');
    }
  };
  try { return await Promise.race([request(), timeout]); }
  finally { clearTimeout(timer); }
}

function parseSnapshot(value: unknown, now: number): SoundchartsAudienceSnapshot {
  const plot = object(value);
  const observedAt = date(plot.date, now);
  const rawCities = plot.cityPlots ?? [];
  if (!Array.isArray(rawCities) || rawCities.length > 50) throw new SoundchartsError('invalid_payload');
  const seen = new Set<string>();
  const cities = rawCities.map((raw): SoundchartsCityAudience => {
    const city = object(raw);
    const cityName = text(city.cityName, 200);
    const countryCode = text(city.countryCode, 2).toUpperCase();
    const region = city.region === undefined ? '' : city.region;
    if (!/^[A-Z]{2}$/.test(countryCode) || typeof region !== 'string' || region.length > 200) throw new SoundchartsError('invalid_payload');
    const key = JSON.stringify([normalize(cityName), countryCode, normalize(region)]);
    if (seen.has(key)) throw new SoundchartsError('invalid_payload');
    seen.add(key);
    return { city: cityName, countryCode, region, monthlyListeners: counter(city.value), observedAt: date(city.date, now) };
  });
  return { observedAt, globalMonthlyListeners: counter(plot.value), cities };
}

function selectMarket(snapshots: SoundchartsAudienceSnapshot[], market: AudienceMarket): SoundchartsMarketAudience {
  // Use the latest returned city report, never an older matching city to hide absence in a newer report.
  const snapshot = snapshots.find(item => item.cities.length > 0);
  const matches = snapshot?.cities.filter(city => normalize(city.city) === normalize(market.city) && city.countryCode === market.countryCode && (market.region === undefined || normalize(city.region) === normalize(market.region))) ?? [];
  if (matches.length !== 1) return { requested: market, status: matches.length > 1 ? 'ambiguous' : 'not_returned', monthlyListeners: null, observedAt: null, city: null };
  const city = matches[0];
  return { requested: market, status: city.monthlyListeners === null ? 'not_returned' : 'observed', monthlyListeners: city.monthlyListeners, observedAt: city.observedAt, city };
}

/** At most two requests: resolve the exact Spotify ID, then collect one bounded audience-history page. */
export async function getSpotifyLocalAudience(spotifyId: string, credentials: SoundchartsCredentials, market?: AudienceMarket, options: Options = {}): Promise<SpotifyLocalAudience> {
  if (typeof spotifyId !== 'string' || !/^[A-Za-z0-9]{22}$/.test(spotifyId)) throw new SoundchartsError('invalid_spotify_id');
  const requestedMarket = validateMarket(market);
  const appId = credentials?.SOUNDCHARTS_APP_ID, apiKey = credentials?.SOUNDCHARTS_API_KEY;
  if (!appId || !apiKey) throw new SoundchartsError('credentials_missing');
  if (![appId, apiKey].every(value => typeof value === 'string' && /^[\x21-\x7e]{1,512}$/.test(value))) throw new SoundchartsError('invalid_credentials');
  const auth = { SOUNDCHARTS_APP_ID: appId, SOUNDCHARTS_API_KEY: apiKey };
  const now = (options.now ?? Date.now)();
  if (!Number.isFinite(now)) throw new SoundchartsError('invalid_payload');
  const fetcher = options.fetcher ?? fetch;
  const identityBody = applicationBody(await getJson(new URL(`/api/v2/artist/by-platform/spotify/${spotifyId}`, origin), auth, fetcher, now));
  const artist = object(identityBody.object);
  const soundchartsId = text(artist.uuid, 36).toLowerCase();
  if (!uuidPattern.test(soundchartsId)) throw new SoundchartsError('invalid_payload');
  const artistName = text(artist.name);
  const requestedRange = { startDate: new Date(now - 30 * dayMs).toISOString().slice(0, 10), endDate: new Date(now).toISOString().slice(0, 10) };
  const url = new URL(`/api/v2/artist/${soundchartsId}/streaming/spotify`, origin);
  url.search = new URLSearchParams({ ...requestedRange, limit: String(maxSnapshots), offset: '0', sort: 'desc' }).toString();
  const body = applicationBody(await getJson(url, auth, fetcher, now));
  const related = object(body.related), relatedArtist = object(related.artist);
  if (related.platform !== 'spotify' || relatedArtist.uuid !== soundchartsId) throw new SoundchartsError('identity_mismatch');
  if (!Array.isArray(body.items) || body.items.length > maxSnapshots) throw new SoundchartsError('invalid_payload');
  const snapshots = body.items.map(item => parseSnapshot(item, now)).sort((a, b) => b.observedAt.localeCompare(a.observedAt));
  if (new Set(snapshots.map(item => item.observedAt)).size !== snapshots.length) throw new SoundchartsError('invalid_payload');
  const page = object(body.page);
  if (page.next !== null && typeof page.next !== 'string') throw new SoundchartsError('invalid_payload');
  return {
    source: 'soundcharts', platform: 'spotify', dataset: appId === 'soundcharts' && apiKey === 'soundcharts' ? 'sandbox' : 'production',
    identity: { spotifyId, soundchartsId, artistName, matchedBy: 'spotify_platform_id' },
    fetchedAt: new Date(now).toISOString(),
    providerLastCrawlAt: related.lastCrawlDate === null || related.lastCrawlDate === undefined ? null : date(related.lastCrawlDate, now),
    requestedRange, metric: 'monthly_listeners', window: { kind: 'rolling', days: 28 },
    cityCoverage: 'top_50_only', cityRefresh: 'weekly', historyTruncated: page.next !== null,
    snapshots, market: requestedMarket ? selectMarket(snapshots, requestedMarket) : null,
    note: 'Spotify listening evidence supplied by Soundcharts. City reports cover only the returned top cities; an absent city is unknown, not zero. Snapshot dates can differ from collection time. These listeners are not expected ticket buyers.',
  };
}
