import test from 'node:test';
import assert from 'node:assert/strict';
import { researchLocalMarket } from '../src/market-research.ts';
import { canonicalLocalMarket } from '../src/local-market.ts';
import type { MarketResearchOptions } from '../src/market-research.ts';
import type { LocalMarket } from '../src/local-interest.ts';
import { LiveNationError } from '../src/livenation.ts';

const now = () => Date.parse('2026-11-26T18:00:00Z');
const artist = { source: 'spotify', id: 'stable-artist-id', name: 'Fixture Artist' };
const market = { city: 'Philadelphia', region: 'PA', countryCode: 'US' };
const providerArtist = { id: 'K8_fixture', name: artist.name, url: 'https://www.livenation.com/artist/K8_fixture/fixture-artist-events' };
const unrelatedArtist = { id: 'K8_other', name: 'Unrelated Artist', url: 'https://www.livenation.com/artist/K8_other/unrelated-artist-events' };
const videoId = 'aBcD1234_56', channelId = `UC${'a'.repeat(22)}`;
const title = `${artist.name} live in Philadelphia`;
const directory = (entries = [providerArtist]) => `<title>Browse Artists - Live Nation</title>${entries.map(entry => `<a href="${entry.url}">${entry.name}</a>`).join('')}`;
const location = (city = 'Philadelphia', region = 'PA', countryCode = 'US') => ({ name: 'Fixture Venue', address: { addressLocality: city, addressRegion: region, addressCountry: countryCode } });
function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    '@context': 'https://schema.org', '@type': 'MusicEvent', name: 'Fixture Artist Show',
    url: 'https://www.livenation.com/event/fixture_event/fixture-artist-show',
    performers: [{ name: providerArtist.name, sameAs: providerArtist.url }],
    startDate: '2026-11-27T20:00:00-05:00', eventStatus: 'https://schema.org/EventScheduled',
    location: location(), ...overrides,
  };
}
const page = (events: unknown[], heading = providerArtist.name) => `<h1>${heading}</h1><script type="application/ld+json">${JSON.stringify(events)}</script>`;
const html = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const search = { items: [{ id: { kind: 'youtube#video', videoId }, snippet: { title, channelId } }] };
const details = (statistics: Record<string, string> = { viewCount: '100', likeCount: '10', commentCount: '2' }) => ({ items: [{ id: videoId,
  snippet: { title, channelId, channelTitle: 'Fixture uploader', categoryId: '10', publishedAt: '2026-11-20T12:00:00Z' }, statistics }] });
interface Fixture {
  artistName?: string;
  events?: unknown[];
  artists?: typeof providerArtist[];
  youtubeStatus?: number;
  youtubeStatistics?: Record<string, string>;
  emptyYouTube?: boolean;
  livenationStatus?: number;
}
function fixture(options: Fixture = {}): { fetcher: typeof fetch; calls: { url: URL; init?: RequestInit }[] } {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const fixtureArtist = { ...providerArtist, name: options.artistName ?? providerArtist.name };
  const fixtureTitle = `${fixtureArtist.name} live in Philadelphia`;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); calls.push({ url, init });
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal instanceof AbortSignal);
    if (url.origin === 'https://www.livenation.com') {
      assert.equal(new Headers(init?.headers).has('X-Goog-Api-Key'), false);
      if (options.livenationStatus) return new Response('Fixture failure', { status: options.livenationStatus });
      if (url.pathname === '/artist-sitemap') return html(directory(options.artists ?? [fixtureArtist]));
      assert.equal(url.href, providerArtist.url);
      return html(page(options.events ?? [event({ performers: [{ name: fixtureArtist.name, sameAs: fixtureArtist.url }] })], fixtureArtist.name));
    }
    assert.equal(url.origin, 'https://www.googleapis.com');
    assert.equal(new Headers(init?.headers).get('X-Goog-Api-Key'), 'fixture-api-key');
    assert.equal(url.searchParams.has('key'), false);
    if (options.youtubeStatus) return Response.json({ error: { message: 'Fixture failure' } }, { status: options.youtubeStatus });
    if (url.pathname === '/youtube/v3/search') return Response.json(options.emptyYouTube ? { items: [] } : { items: search.items.map(item => ({ ...item, snippet: { ...item.snippet, title: fixtureTitle } })) });
    assert.equal(url.pathname, '/youtube/v3/videos');
    const detail = details(options.youtubeStatistics);
    detail.items[0]!.snippet.title = fixtureTitle;
    return Response.json(detail);
  };
  return { fetcher, calls };
}
async function research(options: Fixture = {}, confirmed = false, requestedMarket: LocalMarket = market, extra: Partial<MarketResearchOptions> = {}) {
  const stub = fixture(options);
  const result = await researchLocalMarket(artist, requestedMarket, { now, fetcher: stub.fetcher, youtubeApiKey: 'fixture-api-key',
    ...(confirmed ? { confirmedSources: { livenation: providerArtist.id } } : {}), ...extra });
  return { result, calls: stub.calls };
}

test('public matches stay candidates until the user confirms the discovered Live Nation identity', async () => {
  const unconfirmed = await research();
  assert.equal(unconfirmed.result.verdict, 'no_local_evidence');
  assert.equal(unconfirmed.result.evidence.length, 0);
  assert.equal(unconfirmed.result.candidates.length, 2);
  assert.equal(unconfirmed.result.sourceMatches[0]!.confirmed, false);
  const { result, calls } = await research({}, true);
  assert.equal(result.verdict, 'local_activity');
  assert.equal(result.evidenceQuality, 'limited');
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0]!.source, 'livenation');
  assert.equal(result.evidence[0]!.match, 'confirmed');
  assert.equal(result.sourceMatches[0]!.confirmed, true);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]!.source, 'youtube');
  assert.equal(result.candidates[0]!.match, 'candidate');
  assert.equal(calls.length, 4);
  assert.deepEqual(result.artist, artist);
});

test('unknown confirmed provider IDs cannot attach another artist’s listings', async () => {
  const stub = fixture();
  await assert.rejects(researchLocalMarket(artist, market, { fetcher: stub.fetcher, now, youtubeApiKey: '', confirmedSources: { livenation: 'K8_unknown' } }),
    error => error instanceof LiveNationError && error.code === 'invalid_confirmation');
  assert.equal(stub.calls.filter(call => call.url.origin === 'https://www.livenation.com').length, 1);
  const absent = await research({ artists: [unrelatedArtist], emptyYouTube: true }, false);
  assert.equal(absent.result.verdict, 'no_local_evidence');
  assert.deepEqual(absent.result.sourceMatches, []);
  assert.deepEqual(absent.result.evidence, []);
});

test('US state aliases and country casing join exact geography without expanding to other cities', async () => {
  assert.deepEqual(canonicalLocalMarket({ city: ' Philadelphia ', region: 'pennsylvania', countryCode: 'us' }), market);
  const aliases = [event({ location: location('Philadelphia', 'Pennsylvania', 'United States') })];
  const { result } = await research({ events: aliases, emptyYouTube: true }, true, { city: 'philadelphia', region: 'pa', countryCode: 'us' });
  assert.equal(result.verdict, 'local_activity');
  assert.equal(result.evidence.length, 1);
  assert.deepEqual(result.evidence[0]!.market, market);
  assert.equal(result.market.region, 'PA');
  assert.equal(result.market.countryCode, 'US');
  const unrelated = [
    event({ url: 'https://www.livenation.com/event/pittsburgh/show', location: location('Pittsburgh') }),
    event({ url: 'https://www.livenation.com/event/canada/show', location: location('Philadelphia', 'PA', 'CA') }),
    event({ url: 'https://www.livenation.com/event/mississippi/show', location: location('Philadelphia', 'MS') }),
  ];
  const excluded = await research({ events: unrelated, emptyYouTube: true }, true);
  assert.equal(excluded.result.verdict, 'no_local_evidence');
  assert.equal(excluded.result.evidence.length, 0);
  assert.equal(excluded.result.coverage.find(item => item.source === 'livenation')!.status, 'no_match');
});

test('omitting region accepts a unique region but keeps same-city cross-region ambiguity for review', async () => {
  const cityOnly = { city: 'Philadelphia', countryCode: 'US' };
  const one = await research({ emptyYouTube: true }, true, cityOnly);
  assert.equal(one.result.verdict, 'local_activity');
  const two = await research({ emptyYouTube: true, events: [event(), event({ url: 'https://www.livenation.com/event/ms/show', location: location('Philadelphia', 'MS') })] }, true, cityOnly);
  assert.equal(two.result.verdict, 'no_local_evidence');
  assert.equal(two.result.evidence.length, 0);
  assert.equal(two.result.candidates.length, 2);
  assert.ok(two.result.excluded.every(item => item.reason === 'ambiguous_market'));
});

test('cancelled, postponed, online and unknown-status events do not support the market verdict', async () => {
  const statuses = ['EventCancelled', 'EventPostponed', 'EventMovedOnline', 'SomethingUnknown'];
  const inactive = statuses.map((status, index) => event({ url: `https://www.livenation.com/event/e${index}/show`, eventStatus: `https://schema.org/${status}` }));
  const result = (await research({ events: inactive, emptyYouTube: true }, true)).result;
  assert.equal(result.verdict, 'no_local_evidence');
  assert.equal(result.evidence.length, 0);
  assert.match(result.coverage.find(item => item.source === 'livenation')!.note, /4 inactive/u);
  const rescheduled = (await research({ events: [event({ eventStatus: 'https://schema.org/EventRescheduled' })], emptyYouTube: true }, true)).result;
  assert.equal(rescheduled.verdict, 'local_activity');
  assert.equal(rescheduled.evidence[0]!.event!.status, 'rescheduled');
});

test('YouTube failures preserve confirmed local event evidence and remain distinct from no matches', async () => {
  for (const youtubeStatus of [503, 429]) {
    const { result } = await research({ youtubeStatus }, true);
    assert.equal(result.verdict, 'local_activity');
    assert.equal(result.evidence.length, 1);
    assert.equal(result.candidates.length, 0);
    assert.equal(result.coverage.find(item => item.source === 'youtube')!.status, youtubeStatus === 429 ? 'rate_limited' : 'unavailable');
  }
  const skipped = await research({}, true, market, { youtubeUnavailable: { status: 'rate_limited', note: 'Daily search budget is exhausted.' } });
  assert.equal(skipped.calls.length, 2);
  assert.equal(skipped.result.verdict, 'local_activity');
  assert.match(skipped.result.coverage.find(item => item.source === 'youtube')!.note, /budget/u);
});

test('all-source failures and successful searches without matches stay distinguishable', async () => {
  const unavailable = (await research({ livenationStatus: 503, youtubeStatus: 503 })).result;
  assert.equal(unavailable.verdict, 'unavailable');
  const noMatch = (await research({ artists: [unrelatedArtist], emptyYouTube: true })).result;
  assert.equal(noMatch.verdict, 'no_local_evidence');
  assert.ok(noMatch.coverage.every(item => item.status === 'no_match'));
  const onlyYouTube = (await research({ livenationStatus: 503 })).result;
  assert.equal(onlyYouTube.verdict, 'no_local_evidence');
  assert.equal(onlyYouTube.candidates.length, 1);
  assert.equal(onlyYouTube.evidence.length, 0);
});

test('an empty artist directory is unavailable rather than proof of a completed no-match search', async () => {
  const { result } = await research({ artists: [], emptyYouTube: true });
  assert.equal(result.coverage.find(item => item.source === 'livenation')!.status, 'unavailable');
  assert.equal(result.coverage.find(item => item.source === 'youtube')!.status, 'no_match');
  assert.equal(result.sourceMatches.length, 0);
});

test('both collectors accept the core’s full artist-name bound without aborting another source', async () => {
  const longArtist = { ...artist, name: 'A'.repeat(200) };
  const stub = fixture({ artistName: longArtist.name });
  const result = await researchLocalMarket(longArtist, market, { fetcher: stub.fetcher, now, youtubeApiKey: 'fixture-api-key', confirmedSources: { livenation: providerArtist.id } });
  assert.equal(result.verdict, 'local_activity');
  assert.equal(result.evidence.length, 1);
  assert.equal(result.candidates.length, 1);
  assert.ok(result.coverage.every(item => item.status === 'ready'));
  assert.equal(result.sourceMatches[0]!.name, longArtist.name);
  assert.equal(stub.calls.length, 4);
  let rejectedCalls = 0;
  await assert.rejects(researchLocalMarket({ ...artist, name: 'A'.repeat(201) }, market, { now, fetcher: async () => { rejectedCalls++; throw new Error('No network expected'); } }));
  assert.equal(rejectedCalls, 0);
});

test('native zero counters are preserved and missing counters remain unknown, never local listeners', async () => {
  const { result } = await research({ youtubeStatistics: { viewCount: '0', likeCount: '0' } }, true);
  const video = result.candidates.find(item => item.source === 'youtube')!;
  assert.deepEqual(video.metrics.map(item => [item.key, item.value, item.scope]), [
    ['views', 0, 'content_global'], ['likes', 0, 'content_global'], ['comments', null, 'content_global'],
  ]);
  assert.ok([...result.evidence, ...result.candidates].every(item => item.kind === 'city_content' || item.kind === 'event_listing'));
  assert.ok([...result.evidence, ...result.candidates].flatMap(item => item.metrics).every(item => item.scope === 'content_global'));
  assert.equal(Object.hasOwn(result, 'attendance'), false);
  assert.equal(Object.hasOwn(result, 'score'), false);
});

test('scheduled event date is separate from observation time and out-of-window events are excluded', async () => {
  const { result } = await research({ events: [event(), event({ url: 'https://www.livenation.com/event/old/show', startDate: '2025-01-01T20:00:00Z' }), event({ url: 'https://www.livenation.com/event/future/show', startDate: '2028-01-01T20:00:00Z' })], emptyYouTube: true }, true);
  assert.equal(result.evidence.length, 1);
  const listing = result.evidence[0]!;
  assert.equal(listing.observedAt, '2026-11-26T18:00:00.000Z');
  assert.equal(listing.fetchedAt, '2026-11-26T18:00:00.000Z');
  assert.equal(listing.event!.startsAt, '2026-11-28T01:00:00.000Z');
  assert.match(listing.title, /2026-11-27/u);
  assert.equal(listing.event!.venue, 'Fixture Venue');
});

test('invalid market inputs are rejected before any network request', async () => {
  let requests = 0;
  const fetcher: typeof fetch = async () => { requests++; throw new Error('Network must not be called'); };
  for (const requestedMarket of [{ city: '', countryCode: 'US' }, { city: 'Philadelphia', countryCode: 'USA' }]) {
    await assert.rejects(researchLocalMarket(artist, requestedMarket, { fetcher, now }));
  }
  assert.equal(requests, 0);
});
