import { canonicalLocalMarket } from './local-market.ts';
import { buildLocalInterest } from './local-interest.ts';
import type { LocalArtist, LocalInterestReport, LocalMarket, LocalObservation, LocalSourceCoverage } from './local-interest.ts';
import { lookupLiveNation } from './livenation.ts';
import type { LiveNationArtist } from './livenation.ts';
import { lookupYouTubeMarketVideos } from './youtube-market.ts';

export interface MarketResearchReport extends LocalInterestReport {
  sourceMatches: (LiveNationArtist & { source: 'livenation'; confirmed: boolean })[];
}
export interface MarketResearchOptions {
  confirmedSources?: { livenation?: string };
  youtubeApiKey?: string;
  youtubeUnavailable?: { status: 'rate_limited' | 'unavailable'; note: string };
  fetcher?: typeof fetch;
  now?: () => number;
}

function normalized(value: string): string { return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase(); }
function matchesMarket(requested: LocalMarket, observed: LocalMarket): boolean {
  return normalized(requested.city) === normalized(observed.city) && requested.countryCode === observed.countryCode
    && (!requested.region || normalized(requested.region) === normalized(observed.region ?? ''));
}

/** Collect our own bounded public evidence. No aggregator subscription or inferred listener totals. */
export async function researchLocalMarket(artist: LocalArtist, requestedMarket: LocalMarket, options: MarketResearchOptions = {}): Promise<MarketResearchReport> {
  const clock = options.now ?? Date.now, started = clock(), fetchedAt = new Date(started).toISOString();
  const market = canonicalLocalMarket(requestedMarket);
  // Validate the core contract before any network call.
  buildLocalInterest({ artist, market, observations: [], coverage: [] }, new Date(started));
  const [live, youtube] = await Promise.all([
    lookupLiveNation({ artistName: artist.name, ...(options.confirmedSources?.livenation ? { confirmedArtistId: options.confirmedSources.livenation } : {}) }, { ...(options.fetcher ? { fetcher: options.fetcher } : {}), now: clock }),
    options.youtubeUnavailable
      ? Promise.resolve({ fetchedAt, ...options.youtubeUnavailable, videos: [] })
      : lookupYouTubeMarketVideos({ artistName: artist.name, ...market }, options.youtubeApiKey ?? '', { ...(options.fetcher ? { fetcher: options.fetcher } : {}), now: clock }),
  ]);
  const observations: LocalObservation[] = [];
  let inactiveEvents = 0;
  for (const event of live.events) {
    if (!event.city || !event.countryCode) continue;
    const eventMarket = canonicalLocalMarket({ city: event.city, countryCode: event.countryCode, ...(event.region ? { region: event.region } : {}) });
    if (!matchesMarket(market, eventMarket)) continue;
    if (!['scheduled', 'rescheduled'].includes(event.status)) { inactiveEvents++; continue; }
    const begins = event.startDate ? Date.parse(event.startDate) : NaN;
    if (!Number.isFinite(begins) || begins < started - 365 * 86_400_000 || begins > started + 365 * 86_400_000) continue;
    observations.push({
      id: event.id, source: 'livenation', sourceUrl: event.url,
      title: `${event.name} · ${event.startDate!.slice(0, 10)}${event.venue ? ` · ${event.venue}` : ''}`.slice(0, 500),
      artist: { ...artist }, market: eventMarket, kind: 'event_listing',
      match: live.identityConfirmed ? 'confirmed' : 'candidate', fetchedAt: live.fetchedAt, observedAt: live.fetchedAt,
      metrics: [], event: { startsAt: new Date(begins).toISOString(), venue: event.venue, status: event.status },
    });
  }
  for (const video of youtube.videos) {
    observations.push({
      id: video.id, source: 'youtube', sourceUrl: video.url, title: video.title,
      artist: { ...artist }, market: { ...market }, kind: 'city_content', match: 'candidate',
      fetchedAt: youtube.fetchedAt, observedAt: video.publishedAt,
      metrics: [
        { key: 'views', label: 'YouTube video views', value: video.views, unit: 'views', scope: 'content_global' },
        { key: 'likes', label: 'YouTube video likes', value: video.likes, unit: 'likes', scope: 'content_global' },
        { key: 'comments', label: 'YouTube video comments', value: video.comments, unit: 'comments', scope: 'content_global' },
      ],
    });
  }
  const localEvents = observations.filter(item => item.source === 'livenation');
  const liveCoverage: LocalSourceCoverage = { ...live.coverage, note: `${live.coverage.note} Listings are partial public event coverage; they do not report attendance or resident listeners.${inactiveEvents ? ` ${inactiveEvents} inactive or unconfirmed-status listings were excluded.` : ''}` };
  if (liveCoverage.status === 'ready' && live.selectedArtistId !== null && localEvents.length === 0) {
    liveCoverage.status = 'no_match';
    liveCoverage.note += ' No eligible listing matched this city and country in the returned page.';
  }
  const coverage: LocalSourceCoverage[] = [liveCoverage, { source: 'youtube', status: youtube.status, fetchedAt: youtube.fetchedAt,
    note: `${youtube.note} A city mentioned in a video title does not establish where its viewers live. These search matches remain candidates.` }];
  return { ...buildLocalInterest({ artist, market, observations, coverage }, new Date(clock())),
    sourceMatches: live.matches.map(match => ({ ...match, source: 'livenation' as const, confirmed: live.identityConfirmed && live.selectedArtistId === match.id })) };
}
