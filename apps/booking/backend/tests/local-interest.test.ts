import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLocalInterest, LocalInterestInputError, LOCAL_INTEREST_RULES, sameLocalMarket } from '../src/local-interest.ts';
import type { LocalInterestInput, LocalObservation, LocalSourceCoverage } from '../src/local-interest.ts';

const now = new Date('2026-11-26T16:00:00.000Z');
const artist = { source: 'spotify', id: 'stable-artist-id', name: 'Fixture artist' };
const market = { city: 'Philadelphia', region: 'PA', countryCode: 'US' };
const ready = (source = 'youtube'): LocalSourceCoverage => ({ source, status: 'ready', fetchedAt: now.toISOString(), note: 'A bounded public sample.' });
function observation(overrides: Partial<LocalObservation> = {}): LocalObservation {
  return {
    id: 'video-a', source: 'youtube', sourceUrl: 'https://www.youtube.com/watch?v=video-a', title: 'Fixture artist in Philadelphia',
    artist: { ...artist }, market: { ...market }, kind: 'city_content', match: 'confirmed', fetchedAt: now.toISOString(),
    observedAt: '2026-11-20T12:00:00Z', metrics: [{ key: 'views', label: 'Video views', value: 100_000, unit: 'views', scope: 'content_global' }],
    ...overrides,
  };
}
function input(observations: LocalObservation[] = [], coverage: LocalSourceCoverage[] = [ready()]): LocalInterestInput {
  return { artist: { ...artist }, market: { ...market }, observations, coverage };
}

test('city-related content retains global counters without manufacturing resident audience or turnout', () => {
  const result = buildLocalInterest(input([observation()]), now);
  assert.equal(result.version, LOCAL_INTEREST_RULES.version);
  assert.equal(result.verdict, 'local_activity');
  assert.equal(result.evidenceQuality, 'limited');
  assert.equal(result.evidence[0]!.metrics[0]!.value, 100_000);
  assert.equal(result.evidence[0]!.metrics[0]!.scope, 'content_global');
  assert.match(result.summary, /audience residence remains unknown/u);
  assert.equal(Object.hasOwn(result, 'score'), false);
  assert.equal(Object.hasOwn(result, 'attendance'), false);
});

test('candidate matches require review and cannot strengthen the local assessment', () => {
  const result = buildLocalInterest(input([observation({ match: 'candidate' })]), now);
  assert.equal(result.verdict, 'no_local_evidence');
  assert.equal(result.evidence.length, 0);
  assert.equal(result.candidates.length, 1);
  assert.match(result.recommendation, /Review/u);
});

test('matching uses source-scoped artist ID and full market identity instead of names', () => {
  const mismatches = [
    observation({ id: 'wrong-id', sourceUrl: 'https://www.youtube.com/watch?v=wrong-id', artist: { ...artist, id: 'different' } }),
    observation({ id: 'wrong-source', sourceUrl: 'https://www.youtube.com/watch?v=wrong-source', artist: { ...artist, source: 'deezer' } }),
    observation({ id: 'wrong-city', sourceUrl: 'https://www.youtube.com/watch?v=wrong-city', market: { ...market, city: 'Pittsburgh' } }),
    observation({ id: 'wrong-country', sourceUrl: 'https://www.youtube.com/watch?v=wrong-country', market: { ...market, countryCode: 'CA' } }),
    observation({ id: 'missing-region', sourceUrl: 'https://www.youtube.com/watch?v=missing-region', market: { city: market.city, countryCode: market.countryCode } }),
  ];
  const result = buildLocalInterest(input(mismatches), now);
  assert.equal(result.verdict, 'no_local_evidence');
  assert.equal(result.evidence.length, 0);
  assert.equal(result.excluded.filter(item => item.reason === 'artist_mismatch').length, 2);
  assert.equal(result.excluded.filter(item => item.reason === 'market_mismatch').length, 3);
  assert.equal(sameLocalMarket(market, { city: '  PHILADELPHIA ', region: 'pa', countryCode: 'us' }), true);
  assert.equal(sameLocalMarket(market, { ...market, region: 'Pennsylvania' }), false);
  const renamed = buildLocalInterest(input([observation({ artist: { ...artist, name: 'A new display name' } })]), now);
  assert.equal(renamed.verdict, 'local_activity');
});

test('source-native measured zero remains a measurement and absent values stay unknown', () => {
  const zero = observation({ kind: 'audience_measurement', metrics: [{ key: 'monthly_listeners', label: 'Monthly listeners', value: 0, unit: 'listeners', scope: 'local_audience' }] });
  const result = buildLocalInterest(input([zero]), now);
  assert.equal(result.verdict, 'measured_audience');
  assert.equal(result.evidenceQuality, 'direct');
  assert.equal(result.evidence[0]!.metrics[0]!.value, 0);
  assert.match(result.recommendation, /including zero/u);
  const missing = buildLocalInterest(input([{ ...zero, metrics: [{ ...zero.metrics[0]!, value: null }] }]), now);
  assert.equal(missing.verdict, 'no_local_evidence');
  assert.equal(missing.evidence[0]!.metrics[0]!.value, null);
});

test('an omitted region accepts one matching region but multiple regions require review', () => {
  const cityOnly = { city: market.city, countryCode: market.countryCode };
  const oneRegion = { ...input([observation()]), market: cityOnly };
  assert.equal(buildLocalInterest(oneRegion, now).verdict, 'local_activity');
  const elsewhere = observation({ id: 'elsewhere', sourceUrl: 'https://www.youtube.com/watch?v=elsewhere', market: { ...market, region: 'MS' } });
  const result = buildLocalInterest({ ...input([observation(), elsewhere]), market: cityOnly }, now);
  assert.equal(result.verdict, 'no_local_evidence');
  assert.equal(result.evidence.length, 0);
  assert.equal(result.candidates.length, 2);
  assert.ok(result.candidates.every(item => item.match === 'candidate'));
  assert.ok(result.excluded.every(item => item.reason === 'ambiguous_market'));
  const staleElsewhere = { ...elsewhere, fetchedAt: '2026-11-18T00:00:00Z', observedAt: '2026-11-01' };
  assert.equal(buildLocalInterest({ ...input([observation(), staleElsewhere]), market: cityOnly }, now).verdict, 'local_activity');
});

test('event dates and native status remain distinct from the observation date and no attendance is inferred', () => {
  const scheduled = observation({ kind: 'event_listing', metrics: [], event: { startsAt: '2027-01-15', venue: 'Fixture venue', status: 'scheduled' } });
  const result = buildLocalInterest(input([scheduled]), now);
  assert.equal(result.verdict, 'local_activity');
  assert.deepEqual(result.evidence[0]!.event, scheduled.event);
  assert.equal(result.evidence[0]!.observedAt, '2026-11-20T12:00:00Z');
  const cancelled = { ...scheduled, event: { ...scheduled.event!, status: 'cancelled' } };
  const cancelledResult = buildLocalInterest(input([cancelled]), now);
  assert.equal(cancelledResult.verdict, 'no_local_evidence');
  assert.equal(cancelledResult.evidence[0]!.event!.status, 'cancelled');
  const badDate = { ...scheduled, event: { ...scheduled.event!, startsAt: '2027-02-30' } };
  assert.equal(buildLocalInterest(input([badDate]), now).excluded[0]!.reason, 'invalid');
  result.evidence[0]!.event!.venue = 'Changed';
  assert.equal(scheduled.event!.venue, 'Fixture venue');
});

test('only scheduled and rescheduled listings qualify as local activity', () => {
  for (const status of ['postponed', 'moved_online', 'unknown', 'cancelled', 'canceled', 'onsale', null]) {
    const item = observation({ kind: 'event_listing', metrics: [], event: { startsAt: '2027-01-15', venue: 'Fixture venue', status } });
    const result = buildLocalInterest(input([item]), now);
    assert.equal(result.verdict, 'no_local_evidence', String(status));
    assert.equal(result.evidenceQuality, 'limited', String(status));
    assert.equal(result.evidence[0]!.event!.status, status);
  }
  const noEventMetadata = observation({ kind: 'event_listing', metrics: [] });
  assert.equal(buildLocalInterest(input([noEventMetadata]), now).verdict, 'no_local_evidence');
  for (const status of ['scheduled', 'rescheduled']) {
    const item = observation({ kind: 'event_listing', metrics: [], event: { startsAt: '2027-01-15', venue: 'Fixture venue', status } });
    assert.equal(buildLocalInterest(input([item]), now).verdict, 'local_activity');
  }
});

test('audience estimates require method provenance and never become direct measurements', () => {
  const estimated = observation({ kind: 'audience_estimate', estimateMethod: 'Provider model v2; a monthly city estimate.', metrics: [{ key: 'listeners', label: 'Estimated monthly listeners', value: 1234, unit: 'listeners', scope: 'local_audience' }] });
  const result = buildLocalInterest(input([estimated]), now);
  assert.equal(result.verdict, 'estimated_audience');
  assert.equal(result.evidenceQuality, 'limited');
  assert.equal(result.evidence[0]!.estimateMethod, estimated.estimateMethod);
  const withoutMethod = { ...estimated }; delete withoutMethod.estimateMethod;
  const invalid = buildLocalInterest(input([withoutMethod]), now);
  assert.equal(invalid.verdict, 'no_local_evidence');
  assert.equal(invalid.excluded[0]!.reason, 'invalid');
});

test('completed no-match and unavailable provider checks produce different outcomes', () => {
  const noMatch = buildLocalInterest(input([], [{ ...ready(), status: 'no_match' }]), now);
  assert.equal(noMatch.verdict, 'no_local_evidence');
  for (const status of ['unavailable', 'not_configured', 'rate_limited'] as const) {
    const result = buildLocalInterest(input([], [{ ...ready(), status }]), now);
    assert.equal(result.verdict, 'unavailable');
    assert.equal(result.coverage[0]!.status, status);
  }
  assert.equal(buildLocalInterest(input([], []), now).verdict, 'unavailable');
  const contradictory = buildLocalInterest(input([observation()], [{ ...ready(), status: 'no_match' }]), now);
  assert.equal(contradictory.evidence.length, 0);
  assert.equal(contradictory.excluded[0]!.reason, 'source_not_ready');
});

test('stale and future source checks cannot be presented as a completed current search', () => {
  for (const fetchedAt of ['2026-11-19T15:59:59.999Z', '2026-11-26T16:00:00.001Z']) {
    const result = buildLocalInterest(input([observation()], [{ ...ready(), fetchedAt }]), now);
    assert.equal(result.verdict, 'unavailable');
    assert.equal(result.coverage[0]!.status, 'unavailable');
    assert.equal(result.evidence.length, 0);
  }
});

test('invalid calendar dates, future observation times and stale snapshots are excluded', () => {
  for (const [field, value, expected] of [
    ['fetchedAt', '2026-11-31T16:00:00Z', 'invalid'],
    ['observedAt', '2026-09-31', 'invalid'],
    ['fetchedAt', '2026-11-26T16:00:00.001Z', 'future'],
    ['observedAt', '2026-11-26T16:00:00.001Z', 'future'],
    ['fetchedAt', '2026-11-19T15:59:59.999Z', 'stale_snapshot'],
    ['observedAt', '2025-11-26T15:59:59.999Z', 'old_observation'],
  ]) {
    const item = observation({ observedAt: '2026-11-01', [field!]: value });
    const result = buildLocalInterest(input([item]), now);
    assert.equal(result.evidence.length, 0, `${field}: ${value}`);
    assert.equal(result.excluded[0]!.reason, expected, `${field}: ${value}`);
  }
});

test('freshness and observation windows have explicit inclusive boundaries', () => {
  const snapshotBoundary = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const audienceBoundary = new Date(now.getTime() - 90 * 86_400_000).toISOString();
  const activityBoundary = new Date(now.getTime() - 365 * 86_400_000).toISOString();
  const measured = observation({ kind: 'audience_measurement', fetchedAt: snapshotBoundary, observedAt: audienceBoundary, metrics: [{ key: 'followers', label: 'Followers', value: 2, unit: 'followers', scope: 'local_audience' }] });
  assert.equal(buildLocalInterest(input([measured], [{ ...ready(), fetchedAt: snapshotBoundary }]), now).verdict, 'measured_audience');
  assert.equal(buildLocalInterest(input([observation({ observedAt: activityBoundary })]), now).verdict, 'local_activity');
  assert.equal(buildLocalInterest(input([{ ...measured, observedAt: new Date(Date.parse(audienceBoundary) - 1).toISOString() }]), now).excluded[0]!.reason, 'old_observation');
});

test('duplicate IDs and URLs are not counted twice and output is order independent', () => {
  const item = observation();
  const alias = { ...item, id: 'alias' };
  const result = buildLocalInterest(input([item, { ...item }, alias]), now);
  const reversed = buildLocalInterest(input([alias, { ...item }, item]), now);
  assert.deepEqual(result, reversed);
  assert.equal(result.evidence.length, 1);
  assert.equal(result.excluded.length, 2);
  assert.ok(result.excluded.every(value => value.reason === 'duplicate'));
});

test('conflicting duplicate observations and alias bridges are excluded, not maximized', () => {
  const item = observation();
  const conflict = { ...item, metrics: [{ ...item.metrics[0]!, value: 999_999 }] };
  const result = buildLocalInterest(input([item, conflict]), now);
  assert.equal(result.evidence.length, 0);
  assert.ok(result.excluded.every(value => value.reason === 'conflict'));
  const b = observation({ id: 'b', sourceUrl: 'https://www.youtube.com/watch?v=b' });
  const bridge = { ...b, id: item.id };
  const bridged = buildLocalInterest(input([item, b, bridge]), now);
  assert.equal(bridged.evidence.length, 0);
  assert.equal(bridged.excluded.length, 3);
  assert.deepEqual(bridged, buildLocalInterest(input([bridge, b, item]), now));
});

test('a newer snapshot supersedes an older counter without adding the two snapshots', () => {
  const current = observation();
  const previous = { ...current, fetchedAt: '2026-11-25T16:00:00Z', metrics: [{ ...current.metrics[0]!, value: 5 }] };
  const result = buildLocalInterest(input([previous, current]), now);
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0]!.metrics[0]!.value, 100_000);
  assert.equal(result.excluded[0]!.reason, 'duplicate');
});

test('corroboration requires separate source namespaces and origins, not repeated videos', () => {
  const item = observation();
  const other = observation({ id: 'event-a', source: 'livenation', sourceUrl: 'https://www.livenation.com/event/event-a', kind: 'event_listing', metrics: [], event: { startsAt: '2027-01-15', venue: 'Fixture venue', status: 'scheduled' } });
  const result = buildLocalInterest(input([item, other], [ready(), ready('livenation')]), now);
  assert.equal(result.verdict, 'local_activity');
  assert.equal(result.evidenceQuality, 'corroborated');
  const sameOrigin = { ...other, sourceUrl: 'https://www.youtube.com/watch?v=other' };
  assert.equal(buildLocalInterest(input([item, sameOrigin], [ready(), ready('livenation')]), now).evidenceQuality, 'limited');
  assert.equal(buildLocalInterest(input([item, observation({ id: 'b', sourceUrl: 'https://www.youtube.com/watch?v=b' })]), now).evidenceQuality, 'limited');
});

test('malformed counters, metric scopes, URLs and unexpected fields fail closed', () => {
  const invalids: unknown[] = [
    { ...observation(), extra: true },
    observation({ sourceUrl: 'javascript:alert(1)' }),
    observation({ sourceUrl: 'https://name:password@www.youtube.com/watch?v=a' }),
    observation({ kind: 'audience_measurement' }),
    observation({ estimateMethod: 'Not an estimate.' }),
    ...[-1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '100', undefined].map(value => ({ ...observation(), metrics: [{ ...observation().metrics[0]!, value }] })),
    observation({ metrics: [observation().metrics[0]!, observation().metrics[0]!] }),
  ];
  const result = buildLocalInterest(input(invalids as LocalObservation[]), now);
  assert.equal(result.evidence.length, 0);
  assert.equal(result.excluded.length, invalids.length);
  assert.ok(result.excluded.every(value => value.reason === 'invalid'));
});

test('invalid envelopes and source records throw a stable error instead of coercing inputs', () => {
  for (const raw of [null, { ...input(), extra: true }, { ...input(), market: { ...market, countryCode: 1 } }, { ...input(), coverage: [ready(), ready()] },
    { ...input(), observations: 'none' }, { ...input(), coverage: [{ ...ready(), fetchedAt: 'bad' }] }, { ...input(), observations: Array(201).fill(observation()) }]) {
    assert.throws(() => buildLocalInterest(raw as LocalInterestInput, now), error => error instanceof LocalInterestInputError && error.code === 'invalid_local_interest_input');
  }
  assert.throws(() => buildLocalInterest(input(), new Date('invalid')), error => error instanceof LocalInterestInputError && error.code === 'invalid_evaluation_date');
});

test('result edits cannot mutate caller observations or source records', () => {
  const original = input([observation()]);
  const before = structuredClone(original);
  const result = buildLocalInterest(original, now);
  result.artist.name = 'Changed'; result.market.city = 'Changed'; result.evidence[0]!.artist.name = 'Changed'; result.evidence[0]!.market.city = 'Changed';
  result.evidence[0]!.metrics[0]!.value = 0; result.coverage[0]!.note = 'Changed';
  assert.deepEqual(original, before);
});
