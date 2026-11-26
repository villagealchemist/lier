import test from 'node:test';
import assert from 'node:assert/strict';
import { lookupLiveNation as lookup, LiveNationError, type LiveNationInput, type LiveNationOptions } from '../src/livenation.ts';

const lookupLiveNation = ({now, fetcher, ...input}: LiveNationInput & LiveNationOptions) => lookup(input, {now, fetcher});

const now = () => Date.parse('2026-11-26T18:00:00Z');
const artist = { id: 'K8vZ_fixture', name: 'Example Artist', url: 'https://www.livenation.com/artist/K8vZ_fixture/example-artist-events' };
const directory = (entries = [artist]) => `<title>Browse Artists - Live Nation</title>${entries.map(a => `<a href="${a.url}"><div>${a.name}</div></a>`).join('')}`;
function event(extra: Record<string, unknown> = {}) { return {
  '@context': 'https://schema.org', '@type': 'MusicEvent', name: 'Example Artist Tour',
  url: 'https://www.livenation.com/event/fixture_event/example-artist-tour',
  performers: [{ '@type': 'MusicGroup', name: artist.name, sameAs: artist.url }],
  startDate: '2026-11-27T19:00:00-05:00', eventStatus: 'https://schema.org/EventScheduled',
  location: { '@type': 'Place', name: 'Example Venue', address: { addressLocality: 'Philadelphia', addressRegion: 'PA', addressCountry: { '@type': 'Country', name: 'US' } } }, ...extra,
}; }
const page = (events: unknown = [event()], heading = artist.name) => `<h1>${heading}</h1><script type="application/ld+json">${JSON.stringify(events)}</script>`;
const html = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
function fetcherFor(body = page(), list = directory()): typeof fetch { let calls = 0; return async () => html(++calls === 1 ? list : body); }

test('unique exact name yields candidate listings with original date and geography; never confirms implicitly', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const result = await lookupLiveNation({ artistName: ' example ARTIST ', now, fetcher: async (input, init) => { calls.push({ url: String(input), init }); return html(calls.length === 1 ? directory() : page()); } });
  assert.equal(result.identityConfirmed, false);
  assert.equal(result.selectedArtistId, artist.id);
  assert.deepEqual(result.matches, [artist]);
  assert.equal(result.events[0].startDate, '2026-11-27T19:00:00-05:00');
  assert.equal(result.events[0].city, 'Philadelphia');
  assert.equal(result.events[0].region, 'PA');
  assert.equal(result.events[0].countryCode, 'US');
  assert.equal(result.events[0].status, 'scheduled');
  assert.equal(result.fetchedAt, '2026-11-26T18:00:00.000Z');
  assert.equal(result.coverage.status, 'ready');
  assert.equal(calls.length, 2);
  for (const call of calls) { assert.equal(new URL(call.url).origin, 'https://www.livenation.com'); assert.equal(call.init?.redirect, 'error'); assert.ok(call.init?.signal instanceof AbortSignal); }
});

test('unknown artist returns incomplete coverage rather than no local audience', async () => {
  const result = await lookupLiveNation({ artistName: 'Unknown Artist', now, fetcher: fetcherFor() });
  assert.equal(result.coverage.status, 'no_match'); assert.deepEqual(result.events, []); assert.deepEqual(result.matches, []);
  assert.match(result.coverage.note, /subset/);
});

test('same-name identities require stable ID selection and confirmation is bound to current discovery', async () => {
  const other = { ...artist, id: 'K8vZ_other', url: 'https://www.livenation.com/artist/K8vZ_other/example-artist-events' };
  const ambiguous = await lookupLiveNation({ artistName: artist.name, now, fetcher: fetcherFor(page(), directory([artist, other])) });
  assert.equal(ambiguous.matches.length, 2); assert.equal(ambiguous.selectedArtistId, null); assert.deepEqual(ambiguous.events, []);
  const confirmed = await lookupLiveNation({ artistName: artist.name, confirmedArtistId: artist.id, now, fetcher: fetcherFor(page(), directory([artist, other])) });
  assert.equal(confirmed.identityConfirmed, true); assert.equal(confirmed.events.length, 1);
  await assert.rejects(lookupLiveNation({ artistName: artist.name, confirmedArtistId: 'K8vZ_absent', now, fetcher: fetcherFor() }), e => e instanceof LiveNationError && e.code === 'invalid_confirmation');
});

test('HTML entities decode but names and provider performer IDs must both agree', async () => {
  const missingPerformer = event({ performers: [{ name: artist.name, sameAs: 'https://www.livenation.com/artist/K8vZ_other/example-artist-events' }] });
  const wrongName = event({ performers: [{ name: 'Other Artist', sameAs: artist.url }] });
  const result = await lookupLiveNation({ artistName: artist.name, now, fetcher: fetcherFor(page([missingPerformer, wrongName])) });
  assert.equal(result.events.length, 0);
  assert.equal(result.coverage.status, 'unavailable');
  const escaped = { ...artist, name: 'Example & Artist' };
  const escapedPage = page(event({ performers: [{ name: escaped.name, sameAs: artist.url }] }), 'Example &amp; Artist');
  const escapedResult = await lookupLiveNation({ artistName: escaped.name, now, fetcher: fetcherFor(escapedPage, directory([{ ...escaped, name: 'Example &amp; Artist' }])) });
  assert.equal(escapedResult.events.length, 1);
});

test('cancellation, postponement and rescheduling remain explicit and dates are never attendance', async () => {
  const values = ['EventCancelled', 'EventPostponed', 'EventRescheduled', 'EventMovedOnline', 'Unknown'];
  const events = values.map((value, index) => event({ url: `https://www.livenation.com/event/e${index}/event`, eventStatus: `https://schema.org/${value}` }));
  const result = await lookupLiveNation({ artistName: artist.name, now, fetcher: fetcherFor(page(events)) });
  assert.deepEqual(result.events.map(e => e.status), ['cancelled', 'postponed', 'rescheduled', 'moved_online', 'unknown']);
  assert.ok(result.events.every(e => !('attendance' in e)));
});

test('preserves distinct cities, regions and countries and excludes unknown country/date', async () => {
  const location = (city: string, region: string, addressCountry: unknown) => ({ name: 'Example Venue', address: { addressLocality: city, addressRegion: region, addressCountry } });
  const events = [event(), event({ url: 'https://www.livenation.com/event/ms/show', location: location('Philadelphia', 'MS', 'United States') }), event({ url: 'https://www.livenation.com/event/london/show', location: location('London', '', 'United Kingdom') }), event({ url: 'https://www.livenation.com/event/unknown/show', location: location('Unknown', '', 'Unknown Country') }), event({ url: 'https://www.livenation.com/event/baddate/show', startDate: '2026-02-30' })];
  const result = await lookupLiveNation({ artistName: artist.name, now, fetcher: fetcherFor(page(events)) });
  assert.equal(result.events.length, 3); assert.deepEqual(result.events.map(e => e.countryCode).sort(), ['GB', 'US', 'US']);
  assert.deepEqual(result.events.filter(e => e.city === 'Philadelphia').map(e => e.region).sort(), ['MS', 'PA']);
});

test('deduplicates exact event records and drops conflicting records instead of double counting', async () => {
  const repeated = await lookupLiveNation({ artistName: artist.name, now, fetcher: fetcherFor(page([event(), event()])) });
  assert.equal(repeated.events.length, 1);
  const conflict = await lookupLiveNation({ artistName: artist.name, now, fetcher: fetcherFor(page([event(), event({ eventStatus: 'https://schema.org/EventCancelled' })])) });
  assert.equal(conflict.events.length, 0);
  assert.equal(conflict.coverage.status, 'unavailable');
});

test('provider failures and challenges remain unavailable; rate limit remains distinct', async () => {
  for (const response of [new Response('blocked', { status: 403 }), new Response('failed', { status: 503 }), html('<title>Challenge</title>'), new Response('{}', { headers: { 'Content-Type': 'application/json' } })]) {
    const result = await lookupLiveNation({ artistName: artist.name, now, fetcher: async () => response });
    assert.equal(result.coverage.status, 'unavailable'); assert.equal(result.events.length, 0);
  }
  const limited = await lookupLiveNation({ artistName: artist.name, now, fetcher: async () => new Response('', { status: 429 }) });
  assert.equal(limited.coverage.status, 'rate_limited');
});

test('mismatched artist pages and invalid JSON do not become usable listings', async () => {
  for (const body of [page([event()], 'Different Artist'), `<h1>${artist.name}</h1><script type="application/ld+json">{broken</script>`]) {
    const result = await lookupLiveNation({ artistName: artist.name, now, fetcher: fetcherFor(body) });
    assert.equal(result.coverage.status, 'unavailable'); assert.equal(result.events.length, 0);
  }
});

test('directory and event format drift stay unavailable instead of manufacturing a no-match result', async () => {
  const missingDirectory = await lookupLiveNation({ artistName: artist.name, now, fetcher: fetcherFor(page(), directory([])) });
  assert.equal(missingDirectory.coverage.status, 'unavailable');
  for (const body of [
    `<h1>${artist.name}</h1>`, page([]), page({ '@type': 'Person', name: artist.name }),
    `<h1>${artist.name}</h1><script>window.translations = { noUpcoming: 'There are no upcoming shows.' };</script>`,
    page({ '@type': 'ItemList', name: 'Navigation', numberOfItems: 0, itemListElement: [] }),
  ]) {
    const result = await lookupLiveNation({ artistName: artist.name, now, fetcher: fetcherFor(body) });
    assert.equal(result.coverage.status, 'unavailable');
    assert.deepEqual(result.events, []);
  }
});

test('only explicit visible or named structured empty event states report a completed empty listing', async () => {
  for (const body of [
    `<h1>${artist.name}</h1><p>There are no upcoming shows.</p>`,
    page({ '@type': 'ItemList', name: 'Upcoming shows', numberOfItems: 0, itemListElement: [] }),
  ]) {
    const result = await lookupLiveNation({ artistName: artist.name, now, fetcher: fetcherFor(body) });
    assert.equal(result.coverage.status, 'ready');
    assert.deepEqual(result.events, []);
  }
});

test('rejects unsafe origins, URLs and malformed input without request escalation', async () => {
  let calls = 0;
  for (const artistName of ['', 'x'.repeat(201), 'bad\nname']) await assert.rejects(lookupLiveNation({ artistName, now, fetcher: async () => { calls++; return html(''); } }));
  assert.equal(calls, 0);
  const badDirectory = directory([{ ...artist, url: 'https://evil.example/artist/K8vZ_fixture/example-artist-events' }]);
  const result = await lookupLiveNation({ artistName: artist.name, now, fetcher: fetcherFor(page(), badDirectory) });
  assert.equal(result.coverage.status, 'unavailable');
  const unsafeEvent = await lookupLiveNation({ artistName: artist.name, now, fetcher: fetcherFor(page(event({ url: 'javascript:alert(1)' }))) });
  assert.equal(unsafeEvent.events.length, 0);
});

test('response byte cap rejects both declared and streamed oversized HTML', async () => {
  for (const response of [new Response('x', { headers: { 'Content-Type': 'text/html', 'Content-Length': '2000001' } }), html('x'.repeat(2_000_001))]) {
    const result = await lookupLiveNation({ artistName: artist.name, now, fetcher: async () => response });
    assert.equal(result.coverage.status, 'unavailable');
  }
});

test('deadline covers a body that stops producing bytes and cancels its reader', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let cancelled = false;
  const resultPromise = lookupLiveNation({ artistName: artist.name, now, fetcher: async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('<title>Browse')); },
    cancel() { cancelled = true; },
  }), { headers: { 'Content-Type': 'text/html' } }) });
  await new Promise<void>(resolve => setImmediate(resolve));
  context.mock.timers.tick(8_000);
  const result = await resultPromise;
  assert.equal(result.coverage.status, 'unavailable'); assert.equal(cancelled, true);
});
