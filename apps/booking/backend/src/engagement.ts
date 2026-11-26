/** Platform-native evidence for one confirmed artist profile. No booking location is required. */
export interface EngagementMetricInput {
  key: string;
  label: string;
  value: number | null;
  unit: string;
  note: string;
}

export interface EngagementContentInput {
  id: string;
  title: string;
  url: string;
  kind: string;
  publishedAt: string | null;
  metrics: readonly EngagementMetricInput[];
}

/** Structurally compatible with research adapters without depending on a dashboard or provider SDK. */
export interface EngagementProfileInput {
  artist: { source: string; id: string; name: string };
  metrics: readonly EngagementMetricInput[];
  content?: { status: string; items: readonly EngagementContentInput[] };
  fetchedAt: string;
  sourceUrl: string;
}

export type EngagementResponseKey = 'views' | 'likes' | 'comments' | 'reposts' | 'total_likes' | 'total_comments';

export interface EngagementResponseSummary {
  key: EngagementResponseKey;
  label: string;
  /** Median of observed counters only; a missing counter never contributes a zero. */
  median: number | null;
  observedCount: number;
  missingCount: number;
}

export interface PlatformEngagement {
  source: string;
  artistId: string;
  artistName: string;
  sourceUrl: string;
  fetchedAt: string;
  status: 'current' | 'stale' | 'invalid';
  /** Current followers/listeners/subscribers/viewers only, each retaining its original definition. */
  audience: EngagementMetricInput[];
  content: {
    status: 'ready' | 'unavailable' | 'not_returned';
    /** All items the adapter supplied, including duplicates, undated and older content. */
    returnedCount: number;
    /** Distinct posts/videos eligible for the recent sample. */
    sampledCount: number;
    excludedCount: number;
    firstPublishedAt: string | null;
    lastPublishedAt: string | null;
    metrics: EngagementResponseSummary[];
    note: string;
  };
}

export interface ArtistEngagement {
  generatedAt: string;
  recentDays: 90;
  freshnessDays: 7;
  scope: 'global';
  platforms: PlatformEngagement[];
  note: string;
}

const dayMs = 24 * 60 * 60 * 1000;
const recentDays = 90;
const freshnessDays = 7;
const audienceKeys = new Set(['followers', 'listeners', 'subscribers', 'viewers']);
const responses: readonly { key: EngagementResponseKey; label: string }[] = [
  { key: 'views', label: 'Median views' },
  { key: 'likes', label: 'Median likes' },
  { key: 'comments', label: 'Median comments' },
  { key: 'reposts', label: 'Median reposts' },
  { key: 'total_likes', label: 'Median likes including promoted activity' },
  { key: 'total_comments', label: 'Median comments including promoted activity' },
];

/** Strict UTC calendar validation avoids accepting dates that JavaScript silently rolls forward. */
function instant(value: string | null, allowDay = false): number | null {
  if (value === null) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z)?$/u.exec(value);
  if (!match || (!allowDay && match[4] === undefined)) return null;
  const normalized = match[4] === undefined ? `${value}T00:00:00.000Z` : value;
  const milliseconds = Date.parse(normalized);
  if (!Number.isFinite(milliseconds)) return null;
  const date = new Date(milliseconds);
  if (date.getUTCFullYear() !== Number(match[1]) || date.getUTCMonth() + 1 !== Number(match[2]) || date.getUTCDate() !== Number(match[3]) || date.getUTCHours() !== Number(match[4] ?? 0) || date.getUTCMinutes() !== Number(match[5] ?? 0) || date.getUTCSeconds() !== Number(match[6] ?? 0)) return null;
  return milliseconds;
}

function counter(value: number | null): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function observed(metrics: readonly EngagementMetricInput[], key: string): number | null {
  const values = new Set(metrics.filter(metric => metric.key === key).flatMap(metric => {
    const value = counter(metric.value);
    return value === null ? [] : [value];
  }));
  // Conflicting duplicate counters are ambiguous evidence, not an opportunity to choose a higher value.
  // Missing counters add no observation and do not invalidate otherwise agreeing values.
  return values.size === 1 ? [...values][0] ?? null : null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  values.sort((left, right) => left - right);
  const middle = Math.floor(values.length / 2), upper = values[middle];
  if (upper === undefined) return null;
  const lower = values[middle - 1];
  return values.length % 2 === 1 || lower === undefined ? upper : lower + (upper - lower) / 2;
}

function platform(profile: EngagementProfileInput, now: number): PlatformEngagement {
  const fetched = instant(profile.fetchedAt);
  const status = fetched === null || fetched > now ? 'invalid' : now - fetched > freshnessDays * dayMs ? 'stale' : 'current';
  const audience = status === 'current' ? [...new Map(profile.metrics.filter(metric => audienceKeys.has(metric.key)).map(metric => [metric.key, { ...metric, value: observed(profile.metrics, metric.key) }])).values()] : [];
  const contentStatus = profile.content === undefined ? 'not_returned' : profile.content.status === 'ready' ? 'ready' : 'unavailable';
  const returnedCount = profile.content?.items.length ?? 0;
  const candidates: { item: EngagementContentInput; published: number | null }[] = [];
  if (status === 'current' && fetched !== null && contentStatus === 'ready') {
    for (const item of profile.content?.items ?? []) {
      if (item.kind !== 'post' && item.kind !== 'video' || !item.id.trim() || !item.url.trim()) continue;
      const published = instant(item.publishedAt, true);
      candidates.push({ item, published });
    }
  }
  // Join aliases even when a later item reveals that two earlier IDs share one content URL.
  const parents = candidates.map((_entry, index) => index);
  const root = (index: number): number => {
    let parent = parents[index] ?? index;
    while (parent !== (parents[parent] ?? parent)) parent = parents[parent] ?? parent;
    return parent;
  };
  const seen = new Map<string, number>();
  for (let index = 0; index < candidates.length; index++) {
    const item = candidates[index]!.item;
    for (const key of [`id:${item.id}`, `url:${item.url}`]) {
      const previous = seen.get(key);
      if (previous !== undefined) {
        const left = root(previous), right = root(index);
        parents[Math.max(left, right)] = Math.min(left, right);
      }
      seen.set(key, index);
    }
  }
  const groups = new Map<number, typeof candidates>();
  for (let index = 0; index < candidates.length; index++) {
    const key = root(index), group = groups.get(key) ?? [];
    group.push(candidates[index]!); groups.set(key, group);
  }
  const sample = [...groups.values()].flatMap(group => {
    const published = group[0]?.published;
    // Conflicting or missing publication times cannot establish one recent dated item.
    if (published === null || published === undefined || fetched === null || group.some(entry => entry.published !== published) || published > fetched || now - published > recentDays * dayMs) return [];
    return [{ published, metrics: group.flatMap(entry => entry.item.metrics) }];
  });
  const dates = sample.map(entry => entry.published).sort((left, right) => left - right);
  const first = dates[0], last = dates.at(-1);
  return {
    source: profile.artist.source, artistId: profile.artist.id, artistName: profile.artist.name,
    sourceUrl: profile.sourceUrl, fetchedAt: profile.fetchedAt, status, audience,
    content: {
      status: contentStatus, returnedCount, sampledCount: sample.length, excludedCount: returnedCount - sample.length,
      firstPublishedAt: first === undefined ? null : new Date(first).toISOString(),
      lastPublishedAt: last === undefined ? null : new Date(last).toISOString(),
      metrics: responses.map(definition => {
        const values = sample.flatMap(({ metrics }) => { const value = observed(metrics, definition.key); return value === null ? [] : [value]; });
        return { ...definition, median: median(values), observedCount: values.length, missingCount: sample.length - values.length };
      }),
      note: 'A sample of returned posts and videos published in the last 90 days, not every post in that period. Medians use only supplied counters; views and interactions may include repeat or paid activity. These are global platform counts, not unique people or local ticket buyers.',
    },
  };
}

/** Summarize confirmed profiles without combining audiences or inferring a booking market. */
export function buildArtistEngagement(profiles: readonly EngagementProfileInput[], now: Date = new Date()): ArtistEngagement {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new RangeError('Engagement summary requires a valid observation time.');
  // Repeated snapshots of the same profile represent one account. Keep its newest valid observation.
  const unique = new Map<string, EngagementProfileInput>();
  for (const profile of profiles) {
    const key = JSON.stringify([profile.artist.source, profile.artist.id]), previous = unique.get(key);
    const fetched = instant(profile.fetchedAt), previousFetched = previous ? instant(previous.fetchedAt) : null;
    const usableTime = fetched !== null && fetched <= nowMs ? fetched : -Infinity;
    const previousTime = previousFetched !== null && previousFetched <= nowMs ? previousFetched : -Infinity;
    if (!previous || usableTime > previousTime) unique.set(key, profile);
  }
  return {
    generatedAt: now.toISOString(), recentDays, freshnessDays, scope: 'global',
    platforms: [...unique.values()].map(profile => platform(profile, nowMs)),
    note: 'Each platform describes its own audience and activity. Counts overlap across platforms and are not added together. City-level engagement requires evidence that explicitly identifies the audience location.',
  };
}
