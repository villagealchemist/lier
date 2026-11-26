import test from 'node:test';
import assert from 'node:assert/strict';
import { buildArtistEngagement } from '../src/engagement.ts';
import type { EngagementContentInput, EngagementMetricInput, EngagementProfileInput } from '../src/engagement.ts';

const now = new Date('2026-11-26T16:00:00.000Z');
const metric = (key: string, value: number | null): EngagementMetricInput => ({ key, value, label: key, unit: key, note: 'Original provider definition.' });
function post(id: string, values: Record<string, number | null>, publishedAt = '2026-11-20T12:00:00.000Z'): EngagementContentInput {
  return { id, url: `https://www.instagram.com/p/${id}/`, title: id, kind: 'post', publishedAt, metrics: Object.entries(values).map(([key, value]) => metric(key, value)) };
}
function profile(items: EngagementContentInput[] = []): EngagementProfileInput {
  return { artist: { source: 'instagram', id: '123', name: 'Fixture artist' }, sourceUrl: 'https://www.instagram.com/fixture/', fetchedAt: '2026-11-26T15:00:00.000Z', metrics: [metric('followers', 5000), metric('media', 200)], content: { status: 'ready', items } };
}

test('summarizes active response by platform while preserving zero and unknown counts', () => {
  const result = buildArtistEngagement([profile([post('a', { views: 100, likes: 10, comments: 0 }), post('b', { views: 300, likes: null, comments: 2 }), post('c', { views: null, likes: 20 })])], now);
  const platform = result.platforms[0]!;
  assert.equal(result.scope, 'global');
  assert.equal(platform.status, 'current');
  assert.deepEqual(platform.audience, [metric('followers', 5000)]);
  assert.equal(platform.content.sampledCount, 3);
  assert.deepEqual(platform.content.metrics, [
    { key: 'views', label: 'Median views', median: 200, observedCount: 2, missingCount: 1 },
    { key: 'likes', label: 'Median likes', median: 15, observedCount: 2, missingCount: 1 },
    { key: 'comments', label: 'Median comments', median: 1, observedCount: 2, missingCount: 1 },
    { key: 'reposts', label: 'Median reposts', median: null, observedCount: 0, missingCount: 3 },
    { key: 'total_likes', label: 'Median likes including promoted activity', median: null, observedCount: 0, missingCount: 3 },
    { key: 'total_comments', label: 'Median comments including promoted activity', median: null, observedCount: 0, missingCount: 3 },
  ]);
});

test('excludes stale, future, undated, impossible-date, older and catalog content', () => {
  const items = [post('current', { views: 10 }), post('old', { views: 999 }, '2026-08-01T00:00:00Z'), post('future', { views: 999 }, '2026-11-26T15:30:00Z'), { ...post('undated', { views: 999 }), publishedAt: null }, post('invalid-calendar', { views: 999 }, '2026-09-31T00:00:00Z'), { ...post('album', { views: 999 }), kind: 'album' }];
  const fresh = buildArtistEngagement([profile(items)], now).platforms[0]!;
  assert.equal(fresh.content.returnedCount, 6);
  assert.equal(fresh.content.sampledCount, 1);
  assert.equal(fresh.content.excludedCount, 5);
  assert.equal(fresh.content.metrics[0]!.median, 10);
  for (const fetchedAt of ['2026-11-19T15:59:59.999Z', '2026-11-26T16:00:00.001Z', '2026-11-31T00:00:00Z', 'bad']) {
    const result = buildArtistEngagement([{ ...profile(items), fetchedAt }], now).platforms[0]!;
    assert.notEqual(result.status, 'current');
    assert.deepEqual(result.audience, []);
    assert.equal(result.content.sampledCount, 0);
    assert.ok(result.content.metrics.every(metric => metric.median === null));
  }
});

test('includes exact freshness and content age boundaries and normalizes sample dates', () => {
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 86_400_000).toISOString();
  const result = buildArtistEngagement([{ ...profile([post('boundary', { likes: 0 }, ninetyDaysAgo), post('fresh', { likes: 1 }, '2026-11-19')]), fetchedAt: '2026-11-19T16:00:00Z' }], now).platforms[0]!;
  assert.equal(result.status, 'current');
  assert.equal(result.content.sampledCount, 2);
  assert.equal(result.content.firstPublishedAt, ninetyDaysAgo);
  assert.equal(result.content.lastPublishedAt, '2026-11-19T00:00:00.000Z');
  assert.equal(result.content.metrics[1]!.median, 0.5);
});

test('deduplicates same content IDs and URLs, including alias chains', () => {
  const a = post('a', { likes: 10 });
  const alias = { ...post('b', { likes: 999 }), url: a.url };
  const aliasChain = post('b', { likes: 999 });
  const result = buildArtistEngagement([profile([a, { ...a }, alias, aliasChain, post('c', { likes: 20 })])], now).platforms[0]!;
  assert.equal(result.content.returnedCount, 5);
  assert.equal(result.content.sampledCount, 2);
  assert.equal(result.content.excludedCount, 3);
  assert.equal(result.content.metrics[1]!.median, 20);
  assert.equal(result.content.metrics[1]!.observedCount, 1);
  assert.equal(result.content.metrics[1]!.missingCount, 1);
  const lateBridge = buildArtistEngagement([profile([post('a', { likes: 10 }), post('b', { likes: 999 }), { ...post('a', { likes: 999 }), url: post('b', {}).url }])], now).platforms[0]!;
  assert.equal(lateBridge.content.sampledCount, 1);
  assert.equal(lateBridge.content.metrics[1]!.median, null);
  assert.equal(lateBridge.content.metrics[1]!.missingCount, 1);
});

test('conflicting alias counters are unknown regardless of row order and missing aliases preserve agreeing observations', () => {
  const a = post('a', { likes: 10, comments: 2, views: 0 });
  const alias = { ...post('b', { likes: 1000, comments: null, views: 0 }), url: a.url };
  const agreement = { ...post('c', { likes: null, comments: 2, reposts: 3 }), url: a.url };
  const observations = [a, alias, agreement, post('d', { likes: 20, comments: 4, views: null })];
  const forward = buildArtistEngagement([profile(observations)], now).platforms[0]!.content;
  const reversed = buildArtistEngagement([profile([...observations].reverse())], now).platforms[0]!.content;
  assert.deepEqual(forward, reversed);
  assert.equal(forward.sampledCount, 2);
  assert.equal(forward.metrics.find(metric => metric.key === 'likes')!.median, 20);
  assert.equal(forward.metrics.find(metric => metric.key === 'likes')!.missingCount, 1);
  assert.equal(forward.metrics.find(metric => metric.key === 'comments')!.median, 3);
  assert.equal(forward.metrics.find(metric => metric.key === 'comments')!.observedCount, 2);
  assert.equal(forward.metrics.find(metric => metric.key === 'views')!.median, 0);
  assert.equal(forward.metrics.find(metric => metric.key === 'reposts')!.median, 3);
});

test('excludes aliases with conflicting publication evidence before applying the recency filter', () => {
  const a = post('a', { likes: 10 });
  for (const publishedAt of ['2026-11-21T12:00:00Z', '2026-01-01T00:00:00Z', '2026-11-27T00:00:00Z', '2026-09-31T00:00:00Z', null]) {
    const duplicate = { ...a, publishedAt };
    const forward = buildArtistEngagement([profile([a, duplicate])], now).platforms[0]!.content;
    const reversed = buildArtistEngagement([profile([duplicate, a])], now).platforms[0]!.content;
    assert.deepEqual(forward, reversed);
    assert.equal(forward.returnedCount, 2);
    assert.equal(forward.sampledCount, 0);
    assert.equal(forward.excludedCount, 2);
    assert.equal(forward.firstPublishedAt, null);
    assert.ok(forward.metrics.every(metric => metric.median === null));
  }
});

test('rejects malformed or conflicting counters without manufacturing zeros or summing totals', () => {
  const invalid = post('a', { views: NaN, likes: -1, comments: Infinity, reposts: Number.MAX_SAFE_INTEGER + 1 });
  const conflicting = post('b', { likes: 30, total_likes: 1000 });
  conflicting.metrics = [...conflicting.metrics, metric('likes', 40)];
  const result = buildArtistEngagement([{ ...profile([invalid, conflicting]), metrics: [metric('followers', -1), metric('listeners', null)] }], now).platforms[0]!;
  assert.ok(result.audience.every(metric => metric.value === null));
  assert.ok(result.content.metrics.filter(metric => metric.key !== 'total_likes').every(metric => metric.median === null));
  assert.ok(result.content.metrics.filter(metric => metric.key !== 'total_likes').every(metric => metric.missingCount === 2));
  assert.deepEqual(result.content.metrics.find(metric => metric.key === 'total_likes'), { key: 'total_likes', label: 'Median likes including promoted activity', median: 1000, observedCount: 1, missingCount: 1 });
});

test('base and promoted-inclusive counters remain separate measurements with separate samples', () => {
  const result = buildArtistEngagement([profile([post('a', { likes: 10, total_likes: 100, comments: 2, total_comments: 20 }), post('b', { likes: null, total_likes: 200, comments: null, total_comments: 40 })])], now).platforms[0]!;
  assert.equal(result.content.metrics.find(metric => metric.key === 'likes')!.median, 10);
  assert.equal(result.content.metrics.find(metric => metric.key === 'likes')!.observedCount, 1);
  assert.equal(result.content.metrics.find(metric => metric.key === 'total_likes')!.median, 150);
  assert.equal(result.content.metrics.find(metric => metric.key === 'comments')!.median, 2);
  assert.equal(result.content.metrics.find(metric => metric.key === 'total_comments')!.median, 30);
});

test('unavailable content and absent content do not become an observed empty audience', () => {
  const unavailable = buildArtistEngagement([{ ...profile([post('ignored', { views: 100 })]), content: { status: 'unavailable', items: [post('ignored', { views: 100 })] } }], now).platforms[0]!;
  assert.equal(unavailable.content.status, 'unavailable');
  assert.equal(unavailable.content.sampledCount, 0);
  const withoutContent = profile(); delete withoutContent.content;
  const absent = buildArtistEngagement([withoutContent], now).platforms[0]!;
  assert.equal(absent.content.status, 'not_returned');
  assert.equal(absent.content.firstPublishedAt, null);
  assert.equal(absent.audience[0]!.value, 5000);
});

test('keeps platform audiences separate and uses only the latest snapshot of the same profile', () => {
  const first = profile([post('first', { likes: 10 })]);
  const newer = { ...profile([post('newest', { likes: 20 })]), fetchedAt: '2026-11-26T16:00:00.000Z', metrics: [metric('followers', 5010)] };
  const youtube = { ...profile(), artist: { source: 'youtube', id: 'abc', name: 'Fixture artist' }, metrics: [metric('subscribers', 1000)] };
  const result = buildArtistEngagement([first, newer, { ...newer, fetchedAt: '2026-11-27T00:00:00Z' }, youtube], now);
  assert.equal(result.platforms.length, 2);
  assert.deepEqual(result.platforms.map(item => item.audience[0]!.value), [5010, 1000]);
  assert.equal(result.platforms[0]!.content.metrics[1]!.median, 20);
  assert.equal(Object.hasOwn(result, 'totalAudience'), false);
  assert.equal(Object.hasOwn(result, 'city'), false);
});

test('does not mutate adapters, supports arbitrary platform names and rejects invalid clock input', () => {
  const input = { ...profile([post('a', { reposts: 9 }), post('b', { reposts: 1 })]), artist: { source: 'future-provider', id: 'profile', name: 'Artist' } };
  const original = structuredClone(input);
  const result = buildArtistEngagement([input], now);
  assert.deepEqual(input, original);
  assert.equal(result.platforms[0]!.source, 'future-provider');
  assert.equal(result.platforms[0]!.content.metrics[3]!.median, 5);
  assert.throws(() => buildArtistEngagement([input], new Date('bad')), RangeError);
});
