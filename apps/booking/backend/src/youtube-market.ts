/** Public videos mentioning an artist and city. These are candidates, never local audience counts. */
export interface YouTubeMarketInput {
  artistName: string;
  city: string;
  region?: string;
  countryCode: string;
}

export interface YouTubeMarketVideo {
  id: string;
  title: string;
  url: string;
  publishedAt: string;
  channelId: string;
  channelName: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
}

export interface YouTubeMarketResult {
  fetchedAt: string;
  status: 'ready' | 'no_match' | 'not_configured' | 'unavailable' | 'rate_limited';
  note: string;
  videos: YouTubeMarketVideo[];
}

export interface YouTubeMarketOptions {
  fetcher?: typeof fetch;
  now?: () => number;
}

const maxBytes = 1_000_000;
const limit = 10;
const windowMs = 365 * 86_400_000;
const videoIdPattern = /^[A-Za-z0-9_-]{11}$/u;
const channelIdPattern = /^UC[A-Za-z0-9_-]{22}$/u;
const candidateNote = 'Public music videos whose titles mention this artist and city, published within the last year. Artist and place matches need review. Video counters are global cumulative counts, not local viewers, audience residence, attendance or ticket demand. Country and region are not verified by a title match.';

class RequestFailure extends Error {
  readonly status: 'unavailable' | 'rate_limited';
  constructor(status: 'unavailable' | 'rate_limited') { super(status); this.status = status; }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function label(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value);
}

function tokens(value: string): string[] {
  return value.normalize('NFKC').toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
}

function containsName(title: string, name: string): boolean {
  const words = tokens(title), phrase = tokens(name);
  return phrase.length > 0 && words.some((_word, start) => phrase.every((word, index) => words[start + index] === word));
}

function matchingTitle(value: unknown, input: YouTubeMarketInput): value is string {
  return label(value, 500) && containsName(value, input.artistName) && containsName(value, input.city);
}

function counter(value: unknown): number | null {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(value)) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : null;
}

function published(value: unknown, now: number): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value)) return null;
  const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7)), day = Number(value.slice(8, 10));
  const instant = Date.parse(value);
  if (!Number.isFinite(instant) || month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() || instant > now || instant < now - windowMs) return null;
  return new Date(instant).toISOString();
}

function items(body: Record<string, unknown>): unknown[] {
  if (!Array.isArray(body.items) || body.items.length > limit) throw new RequestFailure('unavailable');
  return body.items;
}

function rejected(status: number, body: Record<string, unknown>): never {
  const error = object(body.error);
  const reasons = [...(Array.isArray(error?.errors) ? error.errors : []), ...(Array.isArray(error?.details) ? error.details : [])]
    .map(value => object(value)?.reason);
  if (status === 429 || reasons.some(reason => typeof reason === 'string' && ['quotaExceeded', 'dailyLimitExceeded', 'rateLimitExceeded', 'userRateLimitExceeded', 'QUOTA_EXCEEDED', 'RATE_LIMIT_EXCEEDED'].includes(reason))) throw new RequestFailure('rate_limited');
  throw new RequestFailure('unavailable');
}

/** One search and one details request, sharing one eight-second deadline. No retries or persistence. */
export async function lookupYouTubeMarketVideos(input: YouTubeMarketInput, apiKey: string, options: YouTubeMarketOptions = {}): Promise<YouTubeMarketResult> {
  const now = (options.now ?? Date.now)();
  if (!Number.isFinite(now) || Math.abs(now) > 8_640_000_000_000_000) throw new TypeError('Invalid clock');
  const fetchedAt = new Date(now).toISOString();
  const result = (status: YouTubeMarketResult['status'], note: string, videos: YouTubeMarketVideo[] = []): YouTubeMarketResult => ({ fetchedAt, status, note, videos });
  if (!input || !label(input.artistName, 200) || !label(input.city, 120) || !tokens(input.artistName).length || !tokens(input.city).length || typeof input.countryCode !== 'string' || !/^[A-Z]{2}$/u.test(input.countryCode) || input.region !== undefined && (!label(input.region, 120))) return result('unavailable', 'Artist and market details are invalid.');
  if (typeof apiKey !== 'string' || !apiKey.trim()) return result('not_configured', 'YouTube public video research is not connected.');
  if (apiKey.length > 500 || /[\u0000-\u001f\u007f]/u.test(apiKey)) return result('unavailable', 'YouTube public video research is unavailable.');
  const fetcher = options.fetcher ?? fetch;
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      void reader?.cancel().catch(() => undefined);
      reject(new RequestFailure('unavailable'));
    }, 8000);
  });
  async function request(resource: 'search' | 'videos', params: Record<string, string>): Promise<Record<string, unknown>> {
    if (controller.signal.aborted) throw new RequestFailure('unavailable');
    const url = new URL(`https://www.googleapis.com/youtube/v3/${resource}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    // Workers supports manual/follow only. Reject redirects before consuming a body.
    const response = await fetcher(url, { headers: { Accept: 'application/json', 'X-Goog-Api-Key': apiKey }, redirect: 'manual', signal: controller.signal });
    if (controller.signal.aborted || response.redirected || response.status >= 300 && response.status < 400) { void response.body?.cancel().catch(() => undefined); throw new RequestFailure('unavailable'); }
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maxBytes)) { void response.body?.cancel().catch(() => undefined); throw new RequestFailure('unavailable'); }
    if (!response.body) throw new RequestFailure(response.status === 429 ? 'rate_limited' : 'unavailable');
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (controller.signal.aborted) throw new RequestFailure('unavailable');
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > maxBytes) { void reader.cancel().catch(() => undefined); throw new RequestFailure('unavailable'); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); reader = undefined; }
    const data = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    let body: Record<string, unknown> | null;
    try { body = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data))); } catch { throw new RequestFailure(response.status === 429 ? 'rate_limited' : 'unavailable'); }
    if (!body) throw new RequestFailure(response.status === 429 ? 'rate_limited' : 'unavailable');
    if (!response.ok || body.error !== undefined) rejected(response.status, body);
    return body;
  }
  try {
    return await Promise.race([
      (async () => {
        // countryCode is planning context only. YouTube regionCode would filter availability, not viewer geography.
        const phrase = (name: string) => `"${name.replace(/["|]/gu, ' ').trim()}"`;
        const search = await request('search', { part: 'snippet', type: 'video', maxResults: String(limit), q: `${phrase(input.artistName)} ${phrase(input.city)}`, publishedAfter: new Date(now - windowMs).toISOString(), videoCategoryId: '10', order: 'relevance', safeSearch: 'moderate' });
        const ids = new Map<string, string>(), conflicts = new Set<string>();
        for (const value of items(search)) {
          const entry = object(value), id = object(entry?.id), snippet = object(entry?.snippet);
          if (id?.kind !== 'youtube#video' || typeof id.videoId !== 'string' || !videoIdPattern.test(id.videoId) || !matchingTitle(snippet?.title, input) || typeof snippet?.channelId !== 'string' || !channelIdPattern.test(snippet.channelId)) continue;
          if (ids.has(id.videoId) && ids.get(id.videoId) !== snippet.channelId) conflicts.add(id.videoId);
          else ids.set(id.videoId, snippet.channelId);
        }
        for (const id of conflicts) ids.delete(id);
        if (!ids.size) return result('no_match', candidateNote);
        const details = await request('videos', { part: 'snippet,statistics', id: [...ids.keys()].join(','), maxResults: String(limit) });
        const found = new Map<string, YouTubeMarketVideo>(), invalid = new Set<string>();
        for (const value of items(details)) {
          const entry = object(value), snippet = object(entry?.snippet), statistics = object(entry?.statistics);
          if (typeof entry?.id !== 'string' || !ids.has(entry.id)) continue;
          const date = published(snippet?.publishedAt, now);
          if (!matchingTitle(snippet?.title, input) || typeof snippet?.channelId !== 'string' || snippet.channelId !== ids.get(entry.id) || !label(snippet.channelTitle, 200) || !date || snippet.categoryId !== '10') { invalid.add(entry.id); continue; }
          const video: YouTubeMarketVideo = { id: entry.id, title: snippet.title.trim(), url: `https://www.youtube.com/watch?v=${entry.id}`, publishedAt: date, channelId: snippet.channelId, channelName: snippet.channelTitle.trim(), views: counter(statistics?.viewCount), likes: counter(statistics?.likeCount), comments: counter(statistics?.commentCount) };
          const prior = found.get(entry.id);
          if (prior && JSON.stringify(prior) !== JSON.stringify(video)) invalid.add(entry.id);
          else found.set(entry.id, video);
        }
        const videos: YouTubeMarketVideo[] = [];
        for (const id of ids.keys()) { const video = found.get(id); if (video && !invalid.has(id)) videos.push(video); }
        return result(videos.length ? 'ready' : 'no_match', candidateNote, videos);
      })(),
      deadline,
    ]);
  } catch (error) {
    return result(error instanceof RequestFailure ? error.status : 'unavailable', error instanceof RequestFailure && error.status === 'rate_limited' ? 'YouTube public video research has reached its request limit. Try again later.' : 'YouTube public video research is temporarily unavailable.');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}
