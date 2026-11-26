import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DashboardService } from '../service.ts';
import { startDashboardServer, createDashboardHandler } from '../server.ts';
import { parseYouTube } from '../../backend/src/providers.ts';

const fixedNow = () => new Date('2026-11-26T12:00:00.000Z');
const channel = 'UCabcdefghijklmnopqrstuv';
const testPassword = 'fixture-password-not-for-production';
async function fixture(t: any, options: Record<string, unknown> = {}, serverOptions: { login?: boolean; now?: () => number; port?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'fold-dashboard-'));
  writeFileSync(join(directory, 'index.html'), '<!doctype html><title>Fold Theory</title>');
  writeFileSync(join(directory, 'app.mjs'), 'export {};');
  writeFileSync(join(directory, 'styles.css'), 'body { color: black; }');
  const dbPath = join(directory, 'workspace.sqlite');
  const service = new DashboardService({ dbPath, env: {}, now: fixedNow, ...options });
  const port = serverOptions.port ?? 4317;
  const app = createDashboardHandler({ service, password: testPassword, port, publicDirectory: directory, now: serverOptions.now });
  const origin = new URL(`http://127.0.0.1:${port}`).origin;
  t.after(() => { service.close(); rmSync(directory, { recursive: true, force: true }); });
  // Exercise the production handler and real request-body stream without binding a socket.
  // This sandbox refuses loopback listeners; the opt-in test below covers actual sockets elsewhere.
  const send = async (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const req = Readable.from(init.body === undefined ? [] : [Buffer.from(init.body)]) as unknown as IncomingMessage;
    req.method = init.method ?? 'GET'; req.url = path; req.headers = { host: new URL(origin).host, ...init.headers };
    const headers = new Headers();
    let status = 200, data: Buffer | string | undefined;
    const res = {
      writableEnded: false, destroyed: false,
      setHeader(name: string, value: unknown) { headers.set(name, String(value)); },
      writeHead(code: number, values: Record<string, unknown>) { status = code; for (const [name, value] of Object.entries(values)) headers.set(name, String(value)); },
      end(value?: Buffer | string) { data = value; this.writableEnded = true; }
    };
    await app.handle(req, res as unknown as ServerResponse);
    assert.equal(res.writableEnded, true);
    return new Response(data, { status, headers });
  };
  let cookie = '';
  const api = async (path: string, method = 'GET', value?: unknown, headers: Record<string, string> = {}) => {
    const response = await send(path, { method, headers: { ...(cookie ? { cookie } : {}), ...(method === 'GET' ? {} : { origin, 'x-fold-theory-request': '1', 'content-type': 'application/json' }), ...headers }, body: value === undefined ? undefined : JSON.stringify(value) });
    const nextCookie = response.headers.get('set-cookie');
    if (nextCookie) cookie = nextCookie.split(';')[0];
    return { status: response.status, headers: response.headers, json: await response.json() as any };
  };
  if (serverOptions.login !== false) assert.equal((await api('/api/session/login', 'POST', { password: testPassword })).status, 200);
  return { directory, dbPath, service, api, send, cookie: () => cookie };
}
test('password is mandatory and every data route requires authentication', async t => {
  const { api, service } = await fixture(t, {}, { login: false });
  await assert.rejects(startDashboardServer({ service, password: '', port: 0 }), { code: 'dashboard_password_required_minimum_12_characters' });
  await assert.rejects(startDashboardServer({ service, password: 'short', port: 0 }), { code: 'dashboard_password_required_minimum_12_characters' });
  assert.deepEqual((await api('/api/session')).json, { authenticated: false, passwordRequired: true, mode: 'local' });
  for (const path of ['/api/status', '/api/artists', '/api/artists/unknown/evidence']) assert.equal((await api(path)).status, 401);
  assert.equal((await api('/api/artists', 'POST', { name: 'Anonymous write' })).status, 401);
  assert.equal((await api('/api/import', 'POST', {})).status, 401);
  assert.equal((await api('/api/session/login', 'POST', { password: 'incorrect-password' })).status, 401);
  const accepted = await api('/api/session/login', 'POST', { password: testPassword });
  assert.equal(accepted.status, 200);
  assert.match(accepted.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/);
  assert.equal(accepted.json.authenticated, true);
  assert.equal((await api('/api/artists')).status, 200);
});
test('login rate limiting, logout, absolute expiry and login CSRF are enforced', async t => {
  let time = Date.parse('2026-11-26T12:00:00.000Z');
  const { api, cookie } = await fixture(t, {}, { login: false, now: () => time });
  assert.equal((await api('/api/session/login', 'POST', { password: testPassword }, { origin: 'https://attacker.example' })).status, 403);
  for (let attempt = 0; attempt < 5; attempt++) assert.equal((await api('/api/session/login', 'POST', { password: 'wrong' })).status, 401);
  const limited = await api('/api/session/login', 'POST', { password: testPassword });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  time += 60_001;
  assert.equal((await api('/api/session/login', 'POST', { password: testPassword })).status, 200);
  const oldCookie = cookie();
  assert.equal((await api('/api/session/logout', 'POST', {}, { origin: 'https://attacker.example' })).status, 403);
  assert.equal((await api('/api/session')).json.authenticated, true);
  assert.equal((await api('/api/session/logout', 'POST', {})).json.authenticated, false);
  assert.equal((await api('/api/artists', 'GET', undefined, { cookie: oldCookie })).status, 401);
  assert.equal((await api('/api/session/login', 'POST', { password: testPassword })).status, 200);
  time += 8 * 60 * 60 * 1000 + 1;
  assert.equal((await api('/api/session')).json.authenticated, false);
  assert.equal((await api('/api/artists')).status, 401);
});
test('roster begins empty, validates edits, and persists actual preferences across connections', async t => {
  const { api, dbPath } = await fixture(t);
  assert.deepEqual((await api('/api/artists')).json, { artists: [] });
  const created = await api('/api/artists', 'POST', { name: 'An actual research candidate', genre: 'House', market: 'Philadelphia', notes: 'Ask agent about routing', taste: 5, feeMinor: 125000, shortlisted: true });
  assert.equal(created.status, 201);
  const artist = created.json.artist;
  assert.match(artist.id, /^[0-9a-f-]{36}$/);
  assert.equal(artist.currency, 'USD');
  assert.deepEqual(artist.sourceIds, {});
  assert.equal((await api(`/api/artists/${artist.id}`, 'PATCH', { taste: 6 })).status, 400);
  assert.equal((await api(`/api/artists/${artist.id}`, 'PATCH', { feeMinor: 1.5 })).status, 400);
  assert.equal((await api(`/api/artists/${artist.id}`, 'PATCH', { currency: 'EUR' })).status, 400);
  assert.equal((await api(`/api/artists/${artist.id}`, 'PATCH', { privateToken: 'forbidden' })).status, 400);
  const changed = await api(`/api/artists/${artist.id}`, 'PATCH', { taste: 3, notes: 'Hold for next season' });
  assert.equal(changed.json.artist.taste, 3);
  const second = new DashboardService({ dbPath, env: {}, now: fixedNow });
  try { assert.equal(second.artist(artist.id).notes, 'Hold for next season'); } finally { second.close(); }
  assert.equal((await api(`/api/artists/${artist.id}`, 'DELETE')).json.deleted, true);
  assert.equal((await api(`/api/artists/${artist.id}/evidence`)).status, 404);
});
test('default HTTP port uses browser-normalized authority and origin', async t => {
  const { api } = await fixture(t, {}, { port: 80 });
  assert.equal((await api('/api/session')).json.authenticated, true);
  assert.equal((await api('/api/status')).status, 200);
});
test('same-origin mutation guard and host validation reject cross-site and rebinding requests', async t => {
  const { send, api } = await fixture(t);
  const headers = { 'content-type': 'application/json' };
  const missing = await send('/api/artists', { method: 'POST', headers, body: JSON.stringify({ name: 'Not created' }) });
  assert.equal(missing.status, 403); await missing.arrayBuffer();
  assert.equal((await api('/api/artists', 'POST', { name: 'Not created' }, { origin: 'https://other.example' })).status, 403);
  assert.equal((await api('/api/artists', 'POST', { name: 'Not created' }, { 'x-fold-theory-request': '0' })).status, 403);
  const crossSite = await api('/api/artists', 'GET', undefined, { 'sec-fetch-site': 'cross-site' });
  assert.equal(crossSite.status, 403);
  const rebinding = await send('/api/status', { headers: { host: 'attacker.example' } });
  assert.equal(rebinding.status, 403);
  assert.deepEqual((await api('/api/artists')).json.artists, []);
});
test('server refuses public binding, limits request bodies and serves only declared assets', async t => {
  const { service, send, api } = await fixture(t);
  await assert.rejects(startDashboardServer({ service, password: testPassword, host: '0.0.0.0', port: 0 }), { code: 'loopback_binding_required' });
  await assert.rejects(startDashboardServer({ service, password: testPassword, host: '192.168.1.10', port: 0 }), { code: 'loopback_binding_required' });
  assert.equal((await api('/api/artists', 'POST', { name: 'No' }, { 'content-type': 'text/plain' })).status, 415);
  const large = await api('/api/artists', 'POST', { name: 'No', notes: 'x'.repeat(4_000_000) });
  assert.equal(large.status, 413);
  for (const path of ['/.env', '/service.ts', '/assets/../../backend/src/cli.ts', '/assets/%2e%2e%2fservice.ts']) assert.equal((await send(path)).status, 404);
  const html = await send('/');
  assert.equal(html.status, 200); await html.arrayBuffer();
  assert.match(html.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  assert.equal(html.headers.get('cache-control'), 'no-store');
  assert.equal((await send('/assets/app.mjs')).status, 200);
});
test('status exposes configuration state but never credential values and empty evidence stays empty', async t => {
  const { api } = await fixture(t, { env: { YOUTUBE_API_KEY: 'secret-that-must-not-appear', SPOTIFY_ACCESS_TOKEN: 'private-bearer-value' } });
  const status = (await api('/api/status')).json;
  assert.equal(status.mode, 'local');
  assert.equal(status.sources.length, 5);
  assert.equal(status.sources.find((s: any) => s.source === 'youtube').credentialConfigured, true);
  assert.equal(status.sources.find((s: any) => s.source === 'youtube').enabled, false);
  assert.equal(status.sources.find((s: any) => s.source === 'youtube').accessConfigured, false);
  assert.equal(status.sources.find((s: any) => s.source === 'lastfm').commercialAccessApproved, false);
  assert.ok(!JSON.stringify(status).includes('secret-that-must-not-appear'));
  assert.ok(!JSON.stringify(status).includes('private-bearer-value'));
  const artist = (await api('/api/artists', 'POST', { name: 'No evidence yet' })).json.artist;
  const evidence = (await api(`/api/artists/${artist.id}/evidence`)).json;
  for (const key of ['observations', 'events', 'profiles', 'audience', 'shows']) assert.deepEqual(evidence[key], []);
});
test('source identities are validated, canonicalized and unique across roster artists', async t => {
  const { api } = await fixture(t);
  const mbid = '10E8F0DF-90F9-4957-AEDD-C4E0D187E3A8';
  const one = await api('/api/artists', 'POST', { name: 'One', sourceIds: { lastfm: mbid } });
  assert.equal(one.status, 201);
  assert.equal(one.json.artist.sourceIds.lastfm, mbid.toLowerCase());
  const duplicate = await api('/api/artists', 'POST', { name: 'Two', sourceIds: { lastfm: mbid.toLowerCase() } });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.json.error, 'source_identity_already_linked');
  assert.equal((await api('/api/artists', 'POST', { name: 'Bad source', sourceIds: { spotify: 'name-not-id' } })).status, 400);
  assert.equal((await api('/api/artists')).json.artists.length, 1);
});
test('collection uses fixed policies and existing ingestion storage without accepting client credentials', async t => {
  let calls = 0;
  const { api } = await fixture(t, { collect: async () => { calls++; throw new Error('network must not be called'); } });
  const artist = (await api('/api/artists', 'POST', { name: 'Tracked', sourceIds: { youtube: channel } })).json.artist;
  const denied = await api(`/api/artists/${artist.id}/collect`, 'POST', { sources: ['youtube'], credentials: 'untrusted' });
  assert.equal(denied.status, 400);
  const result = await api(`/api/artists/${artist.id}/collect`, 'POST', {});
  assert.equal(result.status, 200);
  assert.equal(result.json.results[0].run.status, 'blocked');
  assert.equal(result.json.results[0].run.error_code, 'source_disabled');
  assert.equal(calls, 0);
  assert.equal((await api('/api/status')).json.sources.find((s: any) => s.source === 'youtube').lastRun.status, 'blocked');
});
test('configured collection stores validated observations and preserves their provenance', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'fold-policy-'));
  const policyFile = join(directory, 'policy.json');
  writeFileSync(policyFile, JSON.stringify({ youtube: { enabled: true, retentionDays: 7 } }));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { api } = await fixture(t, {
    env: { FOLD_POLICY_FILE: policyFile, YOUTUBE_API_KEY: 'fixture-only' },
    collect: async (request: any) => parseYouTube({ items: [{ id: request.externalId, statistics: { hiddenSubscriberCount: false, subscriberCount: '1230', viewCount: '8900', videoCount: '7' } }] }, request)
  });
  const artist = (await api('/api/artists', 'POST', { name: 'Validated collection', sourceIds: { youtube: channel } })).json.artist;
  const collected = await api(`/api/artists/${artist.id}/collect`, 'POST', { sources: ['youtube'] });
  assert.equal(collected.json.results[0].run.status, 'succeeded');
  const evidence = (await api(`/api/artists/${artist.id}/evidence`)).json;
  assert.equal(evidence.observations.length, 3);
  const subscribers = evidence.observations.find((item: any) => item.key === 'subscribers');
  assert.equal(subscribers.value, 1230);
  assert.equal(subscribers.precision, 'rounded_down_3_significant_figures');
  assert.equal(subscribers.source, 'youtube');
  assert.equal(subscribers.scoringAllowed, false);
  const removal = await api(`/api/artists/${artist.id}`, 'DELETE');
  assert.equal(removal.status, 409);
  assert.equal(removal.json.error, 'artist_has_retained_evidence');
  assert.equal((await api('/api/artists')).json.artists.length, 1);
});
test('import reuses strict evidence validation, rejects synthetic input and preserves current evidence', async t => {
  const { api } = await fixture(t);
  const artist = (await api('/api/artists', 'POST', { name: 'Audience report artist' })).json.artist;
  const report = JSON.parse(readFileSync(new URL('../../backend/examples/artist-audience.synthetic.json', import.meta.url), 'utf8'));
  report.records.forEach((record: any) => { record.artistId = artist.id; });
  const synthetic = await api('/api/import', 'POST', report);
  assert.equal(synthetic.status, 400);
  report.synthetic = false;
  const imported = await api('/api/import', 'POST', report);
  assert.equal(imported.status, 201);
  const evidence = (await api(`/api/artists/${artist.id}/evidence`)).json;
  assert.ok(evidence.audience.length > 0);
  assert.equal(evidence.audience[0].scoringAllowed, false);
  assert.deepEqual(evidence.observations, []);
  assert.deepEqual(evidence.shows, []);
  const invalid = structuredClone(report); invalid.importId = 'invalid-report'; invalid.records[0].email = 'must-not-be-stored@example.test';
  assert.equal((await api('/api/import', 'POST', invalid)).status, 400);
  assert.deepEqual((await api(`/api/artists/${artist.id}/evidence`)).json.audience, evidence.audience);
  const unknown = structuredClone(report); unknown.importId = 'unknown-artist-report'; unknown.records[0].artistId = 'untracked-artist';
  const unknownResult = await api('/api/import', 'POST', unknown);
  assert.equal(unknownResult.status, 400);
  assert.equal(unknownResult.json.error, 'unknown_artist_id');
  assert.deepEqual((await api(`/api/artists/${artist.id}/evidence`)).json.audience, evidence.audience);
  assert.equal((await api(`/api/artists/${artist.id}`, 'DELETE')).json.error, 'artist_has_retained_evidence');
});
test('show imports require a tracked performer, warn about unmatched lineup IDs and preserve whole-event attribution', async t => {
  const { api } = await fixture(t);
  const artist = (await api('/api/artists', 'POST', { name: 'One lineup performer' })).json.artist;
  const report = JSON.parse(readFileSync(new URL('../../backend/examples/show-outcomes.synthetic.json', import.meta.url), 'utf8'));
  report.synthetic = false;
  const unknown = await api('/api/import', 'POST', report);
  assert.equal(unknown.status, 400);
  assert.equal(unknown.json.error, 'show_requires_tracked_artist');
  report.records[0].lineupArtistIds = [artist.id, 'untracked-other-performer'];
  report.records[0].currency = 'EUR';
  const accepted = await api('/api/import', 'POST', report);
  assert.equal(accepted.status, 201);
  assert.deepEqual(accepted.json.warnings.unregisteredLineupArtistIds, ['untracked-other-performer']);
  const evidence = (await api(`/api/artists/${artist.id}/evidence`)).json;
  assert.deepEqual(evidence.shows[0].record.lineupArtistIds, [artist.id, 'untracked-other-performer'].sort());
  assert.equal(evidence.shows[0].record.currency, 'EUR');
  assert.equal(evidence.shows[0].attribution, 'whole_event_not_individual_artist');
  assert.equal(evidence.shows[0].scoringAllowed, false);
  assert.equal((await api(`/api/artists/${artist.id}`, 'DELETE')).json.error, 'artist_has_retained_evidence');
});
