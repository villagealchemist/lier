import test from 'node:test';
import assert from 'node:assert/strict';
import { getSpotifyLocalAudience, SoundchartsError } from '../src/soundcharts.ts';

// Shapes follow Soundcharts' published OpenAPI ArtistResponse, StreamingPlotCollectionResponse,
// SocialAccount, StreamingPlot and CityPlot schemas. Counts below are synthetic fixtures.
const spotifyId = '7Eu1txygG6nJttLHbZdQOh';
const uuid = '11e81bd3-4a1f-de5c-8a88-a0369fe50396';
const now = () => Date.parse('2026-11-26T16:00:00Z');
const credentials = { SOUNDCHARTS_APP_ID: 'test-app', SOUNDCHARTS_API_KEY: 'SECRET-not-for-urls' };
const market = { city: 'Philadelphia', countryCode: 'US', region: 'Pennsylvania' };
const identity = () => ({ type: 'artist', object: { uuid, name: 'Synthetic artist', slug: 'synthetic', appUrl: 'https://app.soundcharts.com/app/artist/synthetic/overview', imageUrl: '' }, errors: [] });
const city = (cityName = 'Philadelphia', countryCode = 'US', region = 'Pennsylvania') => ({ date: '2026-11-23T00:00:00+00:00', value: 420, cityName, countryCode, countryName: 'United States', region });
const audience = () => ({
  related: { artist: { uuid, name: 'Synthetic artist' }, platform: 'spotify', lastCrawlDate: '2026-11-26T00:00:00+00:00' },
  items: [
    { date: '2026-11-25T00:00:00+00:00', value: 10_000, cityPlots: [], countryPlots: [] },
    { date: '2026-11-23T00:00:00+00:00', value: 9_500, cityPlots: [city()], countryPlots: [] },
  ],
  page: { offset: 0, limit: 31, next: null, previous: null, total: 2 }, errors: [],
});
function fixtureFetcher(body: unknown = audience(), identities: unknown = identity()): typeof fetch {
  let calls = 0;
  return async () => Response.json(++calls === 1 ? identities : body);
}
const errorIs = (code: string) => (error: unknown) => error instanceof SoundchartsError && error.code === code && error.message === code;

test('resolves exact Spotify identity and preserves city, global, crawl, and fetch dates separately', async () => {
  const calls: { url: URL; init: RequestInit | undefined }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: new URL(String(input)), init });
    return Response.json(calls.length === 1 ? identity() : audience());
  };
  const result = await getSpotifyLocalAudience(spotifyId, credentials, market, { fetcher, now });
  assert.equal(result.identity.spotifyId, spotifyId);
  assert.equal(result.identity.soundchartsId, uuid);
  assert.equal(result.identity.matchedBy, 'spotify_platform_id');
  assert.equal(result.snapshots[0].globalMonthlyListeners, 10_000);
  assert.equal(result.market?.monthlyListeners, 420);
  assert.equal(result.market?.observedAt, '2026-11-23T00:00:00.000Z');
  assert.equal(result.providerLastCrawlAt, '2026-11-26T00:00:00.000Z');
  assert.equal(result.fetchedAt, '2026-11-26T16:00:00.000Z');
  assert.deepEqual(result.window, { kind: 'rolling', days: 28 });
  assert.equal(result.cityCoverage, 'top_50_only');
  assert.equal(result.cityRefresh, 'weekly');
  assert.equal(result.dataset, 'production');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.pathname, `/api/v2/artist/by-platform/spotify/${spotifyId}`);
  assert.equal(calls[1].url.pathname, `/api/v2/artist/${uuid}/streaming/spotify`);
  assert.equal(calls[1].url.searchParams.get('limit'), '31');
  assert.equal(calls[1].url.searchParams.get('startDate'), '2026-10-27');
  for (const call of calls) {
    assert.equal(call.url.origin, 'https://customer.api.soundcharts.com');
    assert.equal(call.init?.redirect, 'error');
    assert.equal(new Headers(call.init?.headers).get('x-api-key'), credentials.SOUNDCHARTS_API_KEY);
    assert.equal(new Headers(call.init?.headers).get('x-app-id'), credentials.SOUNDCHARTS_APP_ID);
    assert.ok(!call.url.href.includes('SECRET'));
    assert.ok(call.init?.signal instanceof AbortSignal);
  }
});

test('general research needs no city and sandbox credentials are explicitly marked', async () => {
  const result = await getSpotifyLocalAudience(spotifyId, { SOUNDCHARTS_APP_ID: 'soundcharts', SOUNDCHARTS_API_KEY: 'soundcharts' }, undefined, { fetcher: fixtureFetcher(), now });
  assert.equal(result.market, null);
  assert.equal(result.dataset, 'sandbox');
  assert.equal(result.snapshots.length, 2);
});

test('country and optional region distinguish same-name cities without fuzzy merging', async () => {
  const body = audience();
  body.items[1].cityPlots = [city('Philadelphia', 'US', 'Pennsylvania'), city('Philadelphia', 'US', 'Mississippi'), city('Philadelphia', 'ZA', 'Western Cape')];
  const ambiguous = await getSpotifyLocalAudience(spotifyId, credentials, { city: 'Philadelphia', countryCode: 'US' }, { fetcher: fixtureFetcher(body), now });
  assert.equal(ambiguous.market?.status, 'ambiguous');
  assert.equal(ambiguous.market?.monthlyListeners, null);
  const exact = await getSpotifyLocalAudience(spotifyId, credentials, { city: ' philadelphia ', countryCode: 'us', region: ' pennsylvania ' }, { fetcher: fixtureFetcher(body), now });
  assert.equal(exact.market?.status, 'observed');
  assert.equal(exact.market?.city?.region, 'Pennsylvania');
  const nearby = await getSpotifyLocalAudience(spotifyId, credentials, { city: 'Camden', countryCode: 'US' }, { fetcher: fixtureFetcher(body), now });
  assert.equal(nearby.market?.status, 'not_returned');
  assert.equal(nearby.market?.monthlyListeners, null);
});

test('newest city report controls selection; older presence never becomes current evidence', async () => {
  const body = audience();
  body.items[0].cityPlots = [{ ...city('London', 'GB', 'England'), date: body.items[0].date }];
  const result = await getSpotifyLocalAudience(spotifyId, credentials, market, { fetcher: fixtureFetcher(body), now });
  assert.equal(result.market?.status, 'not_returned');
  assert.equal(result.market?.monthlyListeners, null);
  assert.equal(result.snapshots[1].cities[0].monthlyListeners, 420);
});

test('missing counters stay null; a reported zero is still observed', async () => {
  const body = audience();
  const withoutCounts = { ...body, items: [{ date: body.items[1].date, cityPlots: [{ ...city(), value: undefined }] }] };
  const missing = await getSpotifyLocalAudience(spotifyId, credentials, market, { fetcher: fixtureFetcher(withoutCounts), now });
  assert.equal(missing.snapshots[0].globalMonthlyListeners, null);
  assert.equal(missing.market?.monthlyListeners, null);
  assert.equal(missing.market?.status, 'not_returned');
  body.items[1].cityPlots[0].value = 0;
  const zero = await getSpotifyLocalAudience(spotifyId, credentials, market, { fetcher: fixtureFetcher(body), now });
  assert.equal(zero.market?.monthlyListeners, 0);
  assert.equal(zero.market?.status, 'observed');
});

test('empty history is explicit and returned next links never trigger another request', async () => {
  const body = { ...audience(), items: [], page: { ...audience().page, next: 'https://evil.example/steal' } };
  let calls = 0;
  const result = await getSpotifyLocalAudience(spotifyId, credentials, market, { now, fetcher: async () => Response.json(++calls === 1 ? identity() : body) });
  assert.equal(calls, 2);
  assert.equal(result.historyTruncated, true);
  assert.deepEqual(result.snapshots, []);
  assert.equal(result.market?.status, 'not_returned');
});

test('wrong artist or platform fails before audience evidence is accepted', async () => {
  for (const related of [{ ...audience().related, platform: 'youtube' }, { ...audience().related, artist: { uuid: '11e81bd3-4a1f-de5c-8a88-a0369fe50397' } }]) {
    await assert.rejects(getSpotifyLocalAudience(spotifyId, credentials, market, { fetcher: fixtureFetcher({ ...audience(), related }), now }), errorIs('identity_mismatch'));
  }
});

test('bad identity, market, or credentials never call the provider', async () => {
  let calls = 0;
  const options = { now, fetcher: async () => { calls++; return Response.json({}); } };
  await assert.rejects(getSpotifyLocalAudience('Four Tet', credentials, undefined, options), errorIs('invalid_spotify_id'));
  await assert.rejects(getSpotifyLocalAudience(spotifyId, {}, undefined, options), errorIs('credentials_missing'));
  await assert.rejects(getSpotifyLocalAudience(spotifyId, { ...credentials, SOUNDCHARTS_API_KEY: 'key\nheader' }, undefined, options), errorIs('invalid_credentials'));
  await assert.rejects(getSpotifyLocalAudience(spotifyId, credentials, { city: 'Philadelphia', countryCode: '' }, options), errorIs('invalid_market'));
  assert.equal(calls, 0);
});

test('HTTP failures are distinct, bounded to one attempt, and never expose upstream secrets', async () => {
  const errors = new Map([[401, 'credentials_rejected'], [403, 'access_denied'], [404, 'not_found'], [429, 'rate_limited'], [500, 'provider_unavailable'], [400, 'provider_request_rejected'], [302, 'redirect_rejected']]);
  for (const [status, code] of errors) {
    let calls = 0;
    await assert.rejects(getSpotifyLocalAudience(spotifyId, credentials, undefined, { now, fetcher: async () => {
      calls++;
      return new Response('SECRET-not-for-logs', { status, headers: { 'retry-after': '60', Location: 'https://evil.example' } });
    } }), errorIs(code));
    assert.equal(calls, 1);
  }
});

test('429 retains a safe Retry-After delay without sleeping or retrying paid calls', async () => {
  await assert.rejects(getSpotifyLocalAudience(spotifyId, credentials, undefined, { now, fetcher: async () => new Response('', { status: 429, headers: { 'retry-after': '60' } }) }), error => error instanceof SoundchartsError && error.retryAfterSeconds === 60);
});

test('provider application errors, broken JSON and non-JSON responses are sanitized', async () => {
  await assert.rejects(getSpotifyLocalAudience(spotifyId, credentials, undefined, { now, fetcher: fixtureFetcher(audience(), { errors: [{ message: 'SECRET' }] }) }), errorIs('provider_application_error'));
  for (const response of [new Response('not json', { headers: { 'content-type': 'application/json' } }), new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } })]) {
    await assert.rejects(getSpotifyLocalAudience(spotifyId, credentials, undefined, { now, fetcher: async () => response }), errorIs('invalid_payload'));
  }
});

test('streamed and declared response sizes are bounded before parsing', async () => {
  for (const response of [new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '1000001' } }), new Response(' '.repeat(1_000_001), { headers: { 'content-type': 'application/json' } })]) {
    await assert.rejects(getSpotifyLocalAudience(spotifyId, credentials, undefined, { now, fetcher: async () => response }), errorIs('payload_too_large'));
  }
});

test('negative, fractional, coerced counters and impossible dates cannot become audience evidence', async () => {
  for (const value of [-1, 1.5, '420', true, Number.MAX_SAFE_INTEGER + 1]) {
    const body = { ...audience(), items: [{ ...audience().items[1], cityPlots: [{ ...city(), value }] }] };
    await assert.rejects(getSpotifyLocalAudience(spotifyId, credentials, market, { now, fetcher: fixtureFetcher(body) }), errorIs('invalid_payload'));
  }
  for (const date of ['2026-02-30T00:00:00Z', 'tomorrow', '2026-12-01T00:00:00Z']) {
    const body = { ...audience(), items: [{ ...audience().items[1], date }] };
    await assert.rejects(getSpotifyLocalAudience(spotifyId, credentials, market, { now, fetcher: fixtureFetcher(body) }), errorIs('invalid_payload'));
  }
});

test('duplicate cities, excessive city reports and excessive history fail closed', async () => {
  for (const body of [
    { ...audience(), items: [{ ...audience().items[1], cityPlots: [city(), city()] }] },
    { ...audience(), items: [{ ...audience().items[1], cityPlots: Array.from({ length: 51 }, (_, i) => city(`City ${i}`)) }] },
    { ...audience(), items: Array.from({ length: 32 }, () => audience().items[1]) },
  ]) await assert.rejects(getSpotifyLocalAudience(spotifyId, credentials, market, { now, fetcher: fixtureFetcher(body) }), errorIs('invalid_payload'));
});

test('transport timeout is bounded even if an injected fetcher ignores cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const request = getSpotifyLocalAudience(spotifyId, credentials, undefined, { now, fetcher: () => new Promise<Response>(() => {}) });
  const assertion = assert.rejects(request, errorIs('provider_timeout'));
  t.mock.timers.tick(10_000);
  await assertion;
});
