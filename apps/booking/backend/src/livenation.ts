/** Public upcoming-show listings. This source does not measure audiences or attendance. */
export interface LiveNationArtist { id: string; name: string; url: string }
export interface LiveNationEvent {
  id: string; artistId: string; name: string; url: string; startDate: string;
  city: string; region: string; countryCode: string; venue: string;
  status: 'scheduled' | 'rescheduled' | 'postponed' | 'cancelled' | 'moved_online' | 'unknown';
}
export interface LiveNationLookup {
  source: 'livenation'; matches: LiveNationArtist[]; events: LiveNationEvent[];
  selectedArtistId: string | null; identityConfirmed: boolean; fetchedAt: string;
  coverage: { source: 'livenation'; status: 'ready' | 'no_match' | 'unavailable' | 'rate_limited'; fetchedAt: string; note: string };
}
export interface LiveNationInput {
  artistName: string;
  /** Only a previously displayed candidate ID explicitly confirmed by a user. */
  confirmedArtistId?: string;
}
export interface LiveNationOptions {
  fetcher?: typeof fetch;
  now?: () => number;
}
export class LiveNationError extends Error {
  readonly code: 'invalid_query' | 'invalid_confirmation' | 'unavailable' | 'rate_limited' | 'invalid_payload' | 'timeout' | 'payload_too_large' | 'identity_mismatch';
  constructor(code: LiveNationError['code']) {
    super(code); this.name = 'LiveNationError'; this.code = code;
  }
}
const origin = 'https://www.livenation.com';
const artistPattern = /^\/artist\/([A-Za-z0-9_-]{1,80})\/([a-zA-Z0-9_%.-]{1,180})$/;
const eventPattern = /^\/event\/([A-Za-z0-9_-]{1,100})\/([a-zA-Z0-9_%.-]{1,200})$/;
const maxBytes = 2_000_000;
const note = 'Public upcoming-show listings only; scheduled appearances are not ticket sales, attendance or local audience counts. The browse directory covers a subset of artists.';

function normalize(value: string): string { return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase(); }
function decode(value: string): string {
  return value.replace(/&(?:amp|quot|apos|lt|gt|nbsp);|&#(?:x[0-9a-f]+|\d+);/giu, entity => {
    const named: Record<string, string> = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&nbsp;': ' ' };
    const known = named[entity.toLowerCase()];
    if (known !== undefined) return known;
    const n = entity.toLowerCase().startsWith('&#x') ? parseInt(entity.slice(3, -1), 16) : parseInt(entity.slice(2, -1), 10);
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
  });
}
function plain(value: string): string { return decode(value.replace(/<[^>]*>/gu, '')).trim().replace(/\s+/gu, ' '); }
function object(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function string(value: unknown, max = 500): string { return typeof value === 'string' && value.trim() && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value) ? value.trim() : ''; }
function urlPath(value: unknown, kind: 'artist' | 'event'): { id: string; url: string } | null {
  if (typeof value !== 'string' || value.length > 500) return null;
  try {
    const url = new URL(decode(value), origin);
    if (url.origin !== origin || url.username || url.password || url.search || url.hash || /%2f|%5c|%2e/iu.test(url.pathname)) return null;
    const match = (kind === 'artist' ? artistPattern : eventPattern).exec(url.pathname);
    return match?.[1] ? { id: match[1], url: url.href } : null;
  } catch { return null; }
}

async function html(url: string, fetcher: typeof fetch): Promise<string> {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); void reader?.cancel().catch(() => {}); reject(new LiveNationError('timeout')); }, 8_000);
  });
  const request = async (): Promise<string> => {
    let response: Response;
    // Workers supports manual/follow only. Never follow a provider redirect.
    try { response = await fetcher(url, { redirect: 'manual', signal: controller.signal, headers: { Accept: 'text/html' } }); }
    catch { throw new LiveNationError(controller.signal.aborted ? 'timeout' : 'unavailable'); }
    if (response.redirected || response.status >= 300 && response.status < 400) {
      void response.body?.cancel().catch(() => {});
      throw new LiveNationError('unavailable');
    }
    if (response.status === 429) throw new LiveNationError('rate_limited');
    if (!response.ok) throw new LiveNationError('unavailable');
    if (!response.headers.get('content-type')?.toLowerCase().includes('text/html')) throw new LiveNationError('invalid_payload');
    const announced = Number(response.headers.get('content-length'));
    if (Number.isFinite(announced) && announced > maxBytes) throw new LiveNationError('payload_too_large');
    if (!response.body) throw new LiveNationError('invalid_payload');
    reader = response.body.getReader();
    let bytes = 0, text = ''; const decoder = new TextDecoder();
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) { void reader.cancel().catch(() => {}); throw new LiveNationError('payload_too_large'); }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  };
  try { return await Promise.race([request(), timeout]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

/** Discover only exact, normalized display names. Never interpret a URL slug as proof of identity. */
function artistsFromHtml(body: string, artistName: string): LiveNationArtist[] {
  if (!/<title>\s*Browse Artists\s*-\s*Live Nation\s*<\/title>/iu.test(body)) throw new LiveNationError('invalid_payload');
  const byId = new Map<string, LiveNationArtist>();
  let validAnchors = 0;
  for (const match of body.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu)) {
    const path = urlPath(match[1], 'artist'), name = plain(match[2] ?? '');
    if (!path || !string(name, 200)) continue;
    validAnchors++;
    if (normalize(name) !== normalize(artistName)) continue;
    const old = byId.get(path.id);
    if (old && old.url !== path.url) throw new LiveNationError('invalid_payload');
    byId.set(path.id, { ...path, name });
  }
  if (!validAnchors || byId.size > 10) throw new LiveNationError('invalid_payload');
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

const countries: Record<string, string> = {
  'united states': 'US', 'united states of america': 'US', 'usa': 'US', 'canada': 'CA',
  'united kingdom': 'GB', 'uk': 'GB', 'france': 'FR', 'germany': 'DE', 'belgium': 'BE',
  'netherlands': 'NL', 'switzerland': 'CH', 'australia': 'AU', 'new zealand': 'NZ',
  'ireland': 'IE', 'spain': 'ES', 'italy': 'IT', 'portugal': 'PT', 'austria': 'AT',
  'sweden': 'SE', 'norway': 'NO', 'denmark': 'DK', 'finland': 'FI', 'poland': 'PL',
  'czechia': 'CZ', 'czech republic': 'CZ', 'hungary': 'HU', 'greece': 'GR',
  'mexico': 'MX', 'brazil': 'BR', 'argentina': 'AR', 'chile': 'CL', 'colombia': 'CO',
  'japan': 'JP', 'south korea': 'KR', 'singapore': 'SG', 'india': 'IN', 'south africa': 'ZA',
};
function country(value: unknown): string {
  const name = string(object(value)?.name ?? value, 100);
  return /^[a-z]{2}$/iu.test(name) ? name.toUpperCase() : countries[normalize(name)] ?? '';
}
function startDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/u.test(value)) return '';
  const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7)), day = Number(value.slice(8, 10));
  return month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate() && Number.isFinite(Date.parse(value)) ? value : '';
}
function status(value: unknown): LiveNationEvent['status'] {
  if (typeof value !== 'string') return 'unknown';
  const statuses: Record<string, LiveNationEvent['status']> = { EventScheduled: 'scheduled', EventRescheduled: 'rescheduled', EventPostponed: 'postponed', EventCancelled: 'cancelled', EventMovedOnline: 'moved_online' };
  const match = /^https?:\/\/schema\.org\/([A-Za-z]+)$/u.exec(value);
  return match?.[1] ? statuses[match[1]] ?? 'unknown' : 'unknown';
}
function eventNodes(value: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 5) return [];
  if (Array.isArray(value)) return value.slice(0, 500).flatMap(item => eventNodes(item, depth + 1));
  const record = object(value); if (!record) return [];
  const type = record['@type'];
  if (type === 'MusicEvent' || Array.isArray(type) && type.includes('MusicEvent')) return [record];
  return Array.isArray(record['@graph']) ? eventNodes(record['@graph'], depth + 1) : [];
}
function explicitEmptyEvents(value: unknown, depth = 0): boolean {
  if (depth > 5) return false;
  if (Array.isArray(value)) return value.slice(0, 500).some(item => explicitEmptyEvents(item, depth + 1));
  const record = object(value); if (!record) return false;
  if (record['@type'] === 'ItemList' && /\b(?:events|shows|concerts)\b/iu.test(string(record.name))
    && record.numberOfItems === 0 && Array.isArray(record.itemListElement) && record.itemListElement.length === 0) return true;
  return Array.isArray(record['@graph']) && explicitEmptyEvents(record['@graph'], depth + 1);
}
function eventsFromHtml(body: string, artist: LiveNationArtist): LiveNationEvent[] {
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/iu.exec(body);
  if (!h1?.[1] || normalize(plain(h1[1])) !== normalize(artist.name)) throw new LiveNationError('identity_mismatch');
  const byId = new Map<string, LiveNationEvent>(); const conflicts = new Set<string>();
  // The site's translation bundle contains this sentence on every page. Only visible HTML counts.
  const visible = plain(body.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/giu, ' ').replace(/<[^>]*>/gu, ' '));
  let explicitEmpty = /(?:^|\s)There are no upcoming shows\.(?:\s|$)/iu.test(visible);
  let nodes = 0;
  for (const script of body.matchAll(/<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/giu)) {
    let decoded: unknown; try { decoded = JSON.parse(script[1] ?? ''); } catch { throw new LiveNationError('invalid_payload'); }
    explicitEmpty ||= explicitEmptyEvents(decoded);
    for (const record of eventNodes(decoded)) {
      nodes++;
      const performers = record.performers ?? record.performer;
      if (!(Array.isArray(performers) ? performers : [performers]).some(performer => {
        const p = object(performer), identity = urlPath(p?.sameAs, 'artist');
        return identity?.id === artist.id && normalize(string(p?.name)) === normalize(artist.name);
      })) continue;
      const path = urlPath(record.url, 'event'), location = object(record.location), address = object(location?.address);
      const name = string(record.name), date = startDate(record.startDate), city = string(address?.addressLocality, 200), region = string(address?.addressRegion, 200);
      const countryCode = country(address?.addressCountry), venue = string(location?.name, 300);
      if (!path || !name || !date || !city || !countryCode || !venue) continue;
      const event: LiveNationEvent = { ...path, artistId: artist.id, name, startDate: date, city, region, countryCode, venue, status: status(record.eventStatus) };
      const old = byId.get(event.id);
      if (old && JSON.stringify(old) !== JSON.stringify(event)) { conflicts.add(event.id); continue; }
      byId.set(event.id, event);
    }
  }
  if (byId.size > 100) throw new LiveNationError('invalid_payload');
  const events = [...byId.values()].filter(event => !conflicts.has(event.id)).sort((a, b) => a.startDate.localeCompare(b.startDate) || a.id.localeCompare(b.id));
  // Missing/changed structured data is not evidence that the artist has no announced shows.
  if (!events.length && (nodes > 0 || !explicitEmpty)) throw new LiveNationError('invalid_payload');
  return events;
}

/** At most two fixed-origin HTTP GETs. No credentials, pagination, redirects, retries or persistence. */
export async function lookupLiveNation(input: LiveNationInput, options: LiveNationOptions = {}): Promise<LiveNationLookup> {
  if (!input || typeof input.artistName !== 'string' || !input.artistName.trim() || input.artistName.length > 200 || /[\u0000-\u001f\u007f]/u.test(input.artistName)) throw new LiveNationError('invalid_query');
  if (input.confirmedArtistId !== undefined && !/^[A-Za-z0-9_-]{1,80}$/u.test(input.confirmedArtistId)) throw new LiveNationError('invalid_confirmation');
  const fetchedAt = new Date((options.now ?? Date.now)()).toISOString();
  const result: LiveNationLookup = { source: 'livenation', matches: [], events: [], selectedArtistId: null, identityConfirmed: false, fetchedAt,
    coverage: { source: 'livenation', status: 'ready', fetchedAt, note } };
  try {
    const fetcher = options.fetcher ?? fetch;
    result.matches = artistsFromHtml(await html(`${origin}/artist-sitemap`, fetcher), input.artistName);
    if (!result.matches.length) { result.coverage.status = 'no_match'; return result; }
    const selected = input.confirmedArtistId === undefined ? result.matches.length === 1 ? result.matches[0] : undefined : result.matches.find(artist => artist.id === input.confirmedArtistId);
    if (input.confirmedArtistId && !selected) throw new LiveNationError('invalid_confirmation');
    if (!selected) { result.coverage.note = `Choose the matching Live Nation artist before using these listings. ${note}`; return result; }
    result.selectedArtistId = selected.id;
    result.identityConfirmed = input.confirmedArtistId === selected.id;
    result.events = eventsFromHtml(await html(selected.url, fetcher), selected);
    return result;
  } catch (error) {
    if (error instanceof LiveNationError && error.code === 'invalid_confirmation') throw error;
    result.events = [];
    result.coverage.status = error instanceof LiveNationError && error.code === 'rate_limited' ? 'rate_limited' : 'unavailable';
    result.coverage.note = `Live Nation could not provide usable listings for this lookup. ${note}`;
    return result;
  }
}
