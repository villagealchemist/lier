import test from 'node:test';
import assert from 'node:assert/strict';
import { lookupYouTubeMarketVideos } from '../src/youtube-market.ts';

const input = { artistName: 'John Summit', city: 'Philadelphia', region: 'PA', countryCode: 'US' };
const now = () => Date.parse('2026-11-26T16:00:00Z');
const key = 'SECRET-test-api-key';
const channelId = `UC${'a'.repeat(22)}`;
const otherChannel = `UC${'b'.repeat(22)}`;
const id = 'a1234567890';
function snippet(title = 'John Summit live in Philadelphia') { return { title, channelId, channelTitle: 'Synthetic music channel', categoryId: '10', publishedAt: '2026-10-12T17:00:00Z' }; }
function searchItem(videoId = id, title?: string) { return { id: { kind: 'youtube#video', videoId }, snippet: snippet(title) }; }
function detail(videoId = id, title?: string) { return { id: videoId, snippet: snippet(title), statistics: { viewCount: '123', likeCount: '0', commentCount: '4' } }; }
function fixture(search: unknown = { items: [searchItem()] }, details: unknown = { items: [detail()] }): typeof fetch { let calls = 0; return async () => Response.json(++calls === 1 ? search : details); }

test('one bounded search and details call preserve source-native counts with candidate context', async () => {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const result = await lookupYouTubeMarketVideos(input, key, { now, fetcher: async (url, init) => { calls.push({ url: new URL(String(url)), init }); return Response.json(calls.length === 1 ? { items: [searchItem()], nextPageToken: 'DO-NOT-FOLLOW' } : { items: [detail()] }); } });
  assert.equal(result.status, 'ready');
  assert.equal(result.fetchedAt, '2026-11-26T16:00:00.000Z');
  assert.deepEqual(result.videos[0], { id, title: snippet().title, url: `https://www.youtube.com/watch?v=${id}`, publishedAt: '2026-10-12T17:00:00.000Z', channelId, channelName: snippet().channelTitle, views: 123, likes: 0, comments: 4 });
  assert.match(result.note, /not local viewers/);
  assert.match(result.note, /Country and region are not verified/);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.searchParams.get('q'), '"John Summit" "Philadelphia"');
  assert.equal(calls[0].url.searchParams.get('publishedAfter'), '2025-11-26T16:00:00.000Z');
  assert.equal(calls[0].url.searchParams.get('type'), 'video');
  assert.equal(calls[0].url.searchParams.get('videoCategoryId'), '10');
  assert.equal(calls[0].url.searchParams.has('regionCode'), false);
  for (const call of calls) { assert.equal(call.url.origin, 'https://www.googleapis.com'); assert.equal(call.url.searchParams.get('maxResults'), '10'); assert.equal(call.url.href.includes(key), false); assert.equal(new Headers(call.init?.headers).get('X-Goog-Api-Key'), key); assert.equal(call.init?.redirect, 'error'); }
});

test('no matching titles avoids a details request and does not use descriptions as identity evidence', async () => {
  let calls = 0;
  const result = await lookupYouTubeMarketVideos(input, key, { now, fetcher: async () => { calls++; return Response.json({ items: ['John Summit in London', 'John Summitry Philadelphia', 'John Summit New Philadelphia', 'John in Philadelphia'].slice(0, 2).map(title => ({ ...searchItem(id, title), snippet: { ...snippet(title), description: 'John Summit Philadelphia' } })) }); } });
  assert.equal(calls, 1); assert.equal(result.status, 'no_match'); assert.deepEqual(result.videos, []);
});

test('Unicode normalization and whole token sequences match without stripping accents', async () => {
  const artist = { ...input, artistName: 'Beyoncé', city: 'São Paulo' };
  const title = 'BEYONCE\u0301 — live / São Paulo';
  const result = await lookupYouTubeMarketVideos(artist, key, { now, fetcher: fixture({ items: [searchItem(id, title)] }, { items: [detail(id, title)] }) });
  assert.equal(result.status, 'ready');
  const wrong = await lookupYouTubeMarketVideos(artist, key, { now, fetcher: fixture({ items: [searchItem(id, 'Beyonce São Paulo')] }) });
  assert.equal(wrong.status, 'no_match');
});

test('missing, malformed and unsafe counters remain null, reported zero survives', async () => {
  for (const value of [undefined, null, -1, '1.2', '-1', true, '999999999999999999999', 'NaN', 123]) {
    const video = { ...detail(), statistics: { viewCount: value, likeCount: '0' } };
    const result = await lookupYouTubeMarketVideos(input, key, { now, fetcher: fixture(undefined, { items: [video] }) });
    assert.equal(result.videos[0].views, null); assert.equal(result.videos[0].comments, null); assert.equal(result.videos[0].likes, 0);
  }
});

test('future, stale, impossible dates, changed title or channel, nonmusic details cannot become evidence', async () => {
  const bad = [
    { publishedAt: '2026-11-27T00:00:00Z' }, { publishedAt: '2025-11-26T15:59:59Z' }, { publishedAt: '2026-02-30T00:00:00Z' }, { publishedAt: 'November 12' },
    { title: 'John Summit Chicago' }, { channelId: otherChannel }, { categoryId: '20' },
  ];
  for (const change of bad) {
    const result = await lookupYouTubeMarketVideos(input, key, { now, fetcher: fixture(undefined, { items: [{ ...detail(), snippet: { ...snippet(), ...change } }] }) });
    assert.equal(result.status, 'no_match'); assert.deepEqual(result.videos, []);
  }
});

test('unrequested IDs and malformed IDs are discarded; details keep search ordering', async () => {
  const next = 'b1234567890';
  const result = await lookupYouTubeMarketVideos(input, key, { now, fetcher: fixture({ items: [searchItem(next), searchItem(id), searchItem('invalid')] }, { items: [detail(id), detail('c1234567890'), detail(next)] }) });
  assert.deepEqual(result.videos.map(video => video.id), [next, id]);
});

test('duplicates are stable; conflicting provider identities or counters are excluded independent of order', async () => {
  const result = await lookupYouTubeMarketVideos(input, key, { now, fetcher: fixture({ items: [searchItem(), searchItem()] }, { items: [detail(), detail()] }) });
  assert.equal(result.videos.length, 1);
  const conflict = { ...detail(), statistics: { ...detail().statistics, viewCount: '124' } };
  for (const videos of [[detail(), conflict], [conflict, detail()]]) {
    const result = await lookupYouTubeMarketVideos(input, key, { now, fetcher: fixture(undefined, { items: videos }) });
    assert.equal(result.videos.length, 0);
  }
  let calls = 0;
  const searchConflict = await lookupYouTubeMarketVideos(input, key, { now, fetcher: async () => { calls++; return Response.json({ items: [searchItem(), { ...searchItem(), snippet: { ...snippet(), channelId: otherChannel } }] }); } });
  assert.equal(calls, 1); assert.equal(searchConflict.status, 'no_match');
});

test('missing key and invalid inputs do not call upstream or expose credentials', async () => {
  let calls = 0;
  const options = { now, fetcher: async () => { calls++; throw Error('SECRET provider failure'); } };
  assert.equal((await lookupYouTubeMarketVideos(input, '', options)).status, 'not_configured');
  for (const bad of [{ ...input, countryCode: '' }, { ...input, city: '' }, { ...input, artistName: '\nsecret' }, { ...input, region: '' }]) assert.equal((await lookupYouTubeMarketVideos(bad, key, options)).status, 'unavailable');
  assert.equal((await lookupYouTubeMarketVideos(input, 'bad\nkey', options)).status, 'unavailable');
  assert.equal(calls, 0);
});

test('403 quota failure differs from rejected key, HTTP failures are sanitized and never retried', async () => {
  const cases: [number, string, string][] = [[403, 'quotaExceeded', 'rate_limited'], [403, 'keyInvalid', 'unavailable'], [429, '', 'rate_limited'], [500, '', 'unavailable'], [302, '', 'unavailable']];
  for (const [status, reason, expected] of cases) {
    let calls = 0;
    const result = await lookupYouTubeMarketVideos(input, key, { now, fetcher: async () => { calls++; return Response.json({ error: { message: key, errors: [{ reason }] } }, { status }); } });
    assert.equal(result.status, expected); assert.equal(calls, 1); assert.equal(JSON.stringify(result).includes(key), false);
  }
});

test('malformed payloads and declared or streamed oversized responses fail closed', async () => {
  const responses = [Response.json({}), Response.json({ items: new Array(11).fill(searchItem()) }), new Response('not-json'), new Response('{}', { headers: { 'content-length': '1000001' } }), new Response(' '.repeat(1_000_001))];
  for (const response of responses) {
    const result = await lookupYouTubeMarketVideos(input, key, { now, fetcher: async () => response });
    assert.equal(result.status, 'unavailable'); assert.deepEqual(result.videos, []);
  }
});

test('eight-second total deadline bounds ignored fetch cancellation and hanging body reads', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const fetcher of [async () => new Promise<Response>(() => undefined), async () => new Response(new ReadableStream<Uint8Array>({ pull() { return new Promise<void>(() => undefined); } }))]) {
    const promise = lookupYouTubeMarketVideos(input, key, { now, fetcher });
    await Promise.resolve(); await Promise.resolve();
    t.mock.timers.tick(8000);
    const result = await promise;
    assert.equal(result.status, 'unavailable');
  }
});
