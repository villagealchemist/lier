import test from 'node:test';
import assert from 'node:assert/strict';
import { DashboardService } from '../service.ts';
import { startDashboardServer } from '../server.ts';

// Explicit opt-in because managed runtimes may forbid even loopback listeners.
// FOLD_DASHBOARD_SOCKET_TESTS=1 node --test dashboard/tests/server.socket.ts
test('real loopback HTTP session and roster smoke', { skip: process.env.FOLD_DASHBOARD_SOCKET_TESTS !== '1' }, async t => {
  const service = new DashboardService({ dbPath: ':memory:', env: {} });
  const password = 'socket-test-fixture-password';
  let running: Awaited<ReturnType<typeof startDashboardServer>> | undefined;
  t.after(async () => { if (running) await running.close(); service.close(); });
  running = await startDashboardServer({ service, password, port: 0 });
  const denied = await fetch(running.url + '/api/artists');
  assert.equal(denied.status, 401); await denied.arrayBuffer();
  const headers = { origin: running.url, 'content-type': 'application/json', 'x-fold-theory-request': '1' };
  const loggedIn = await fetch(running.url + '/api/session/login', { method: 'POST', headers, body: JSON.stringify({ password }) });
  assert.equal(loggedIn.status, 200); await loggedIn.arrayBuffer();
  const cookie = loggedIn.headers.get('set-cookie')!.split(';')[0];
  const created = await fetch(running.url + '/api/artists', { method: 'POST', headers: { ...headers, cookie }, body: JSON.stringify({ name: 'HTTP smoke candidate' }) });
  assert.equal(created.status, 201);
  const { artist } = await created.json() as any;
  const evidence = await fetch(running.url + `/api/artists/${artist.id}/evidence`, { headers: { cookie } });
  assert.equal(evidence.status, 200);
  assert.deepEqual((await evidence.json() as any).observations, []);
});
