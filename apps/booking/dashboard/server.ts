import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { DashboardService, DashboardError } from './service.ts';
import { IngestionError } from '../backend/src/domain.ts';

const MAX_BODY = 4_000_000;
const here = dirname(fileURLToPath(import.meta.url));
const assets: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/assets/app.mjs': { file: 'app.mjs', type: 'text/javascript; charset=utf-8' },
  '/assets/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' }
};
function body(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) throw new DashboardError('json_content_type_required', 415);
  const length = req.headers['content-length'];
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY)) throw new DashboardError('request_too_large', 413);
  return new Promise((resolveBody, reject) => {
    let total = 0, settled = false;
    const chunks: Buffer[] = [];
    req.on('data', chunk => {
      if (settled) return;
      total += chunk.length;
      if (total > MAX_BODY) { settled = true; chunks.length = 0; reject(new DashboardError('request_too_large', 413)); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try { resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new DashboardError('invalid_json')); }
    });
    req.on('error', () => { if (!settled) { settled = true; reject(new DashboardError('request_interrupted')); } });
    req.on('aborted', () => { if (!settled) { settled = true; reject(new DashboardError('request_interrupted')); } });
  });
}
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
export interface ServerOptions {
  service: DashboardService;
  password: string;
  host?: string;
  port?: number;
  publicDirectory?: string;
  now?: () => number;
}
export function createDashboardHandler(options: ServerOptions) {
  const host = options.host ?? '127.0.0.1', port = options.port ?? 4317;
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new DashboardError('loopback_binding_required');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new DashboardError('invalid_port');
  if (typeof options.password !== 'string' || options.password.length < 12 || options.password.length > 1024) throw new DashboardError('dashboard_password_required_minimum_12_characters');
  const passwordSalt = randomBytes(16), passwordHash = scryptSync(options.password, passwordSalt, 32);
  const clock = options.now ?? Date.now;
  const sessions = new Map<string, number>();
  const sessionDuration = 8 * 60 * 60 * 1000;
  let loginAttempts: number[] = [];
  const digest = (token: string) => createHash('sha256').update(token).digest('hex');
  const sessionToken = (req: IncomingMessage) => {
    const cookies = (req.headers.cookie ?? '').split(';').map(item => item.trim());
    const values = cookies.filter(item => item.startsWith('fold_session=')).map(item => item.slice('fold_session='.length));
    return values.length === 1 && /^[A-Za-z0-9_-]{43}$/.test(values[0]) ? values[0] : null;
  };
  const authenticated = (req: IncomingMessage) => {
    const now = clock();
    for (const [key, expires] of sessions) if (expires <= now) sessions.delete(key);
    const token = sessionToken(req);
    return Boolean(token && sessions.has(digest(token)));
  };
  const sessionState = (authenticated: boolean) => ({ authenticated, passwordRequired: true, mode: 'local' });
  const publicDirectory = resolve(options.publicDirectory ?? resolve(here, 'public'));
  let listeningPort = port;
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    res.setHeader('cache-control', 'no-store');
    try {
      const authority = req.headers.host;
      const allowed = new Set([`127.0.0.1:${listeningPort}`, `localhost:${listeningPort}`, `[::1]:${listeningPort}`]);
      if (listeningPort === 80) for (const hostname of ['127.0.0.1', 'localhost', '[::1]']) allowed.add(hostname);
      if (!authority || !allowed.has(authority)) throw new DashboardError('invalid_host', 403);
      const origin = new URL(`http://${authority}`).origin;
      const url = new URL(req.url ?? '/', origin);
      if (url.origin !== origin || url.search || url.hash) throw new DashboardError('invalid_request_url');
      const method = req.method ?? 'GET', api = url.pathname.startsWith('/api/');
      if (api) {
        if (req.headers['sec-fetch-site'] === 'cross-site' || req.headers.origin && req.headers.origin !== origin) throw new DashboardError('same_origin_required', 403);
        if (!['GET', 'HEAD'].includes(method) && (req.headers.origin !== origin || req.headers['x-fold-theory-request'] !== '1')) throw new DashboardError('same_origin_required', 403);
        if (method === 'GET' && url.pathname === '/api/session') return json(res, 200, sessionState(authenticated(req)));
        if (method === 'POST' && url.pathname === '/api/session/login') {
          const now = clock();
          loginAttempts = loginAttempts.filter(time => time > now - 60_000);
          if (loginAttempts.length >= 5) {
            res.setHeader('retry-after', Math.max(1, Math.ceil((loginAttempts[0] + 60_000 - now) / 1000)));
            throw new DashboardError('login_rate_limited', 429);
          }
          loginAttempts.push(now);
          const input = await body(req);
          if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).join(',') !== 'password' || typeof (input as {password?: unknown}).password !== 'string' || (input as {password: string}).password.length > 1024) throw new DashboardError('invalid_login');
          const supplied = scryptSync((input as {password: string}).password, passwordSalt, 32);
          if (!timingSafeEqual(supplied, passwordHash)) throw new DashboardError('invalid_credentials', 401);
          const old = sessionToken(req);
          if (old) sessions.delete(digest(old));
          authenticated(req);
          if (sessions.size >= 8) sessions.delete(sessions.keys().next().value!);
          const token = randomBytes(32).toString('base64url');
          sessions.set(digest(token), now + sessionDuration);
          res.setHeader('set-cookie', `fold_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionDuration / 1000}`);
          return json(res, 200, sessionState(true));
        }
        if (method === 'POST' && url.pathname === '/api/session/logout') {
          const token = sessionToken(req);
          if (token) sessions.delete(digest(token));
          res.setHeader('set-cookie', 'fold_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
          return json(res, 200, sessionState(false));
        }
        if (!authenticated(req)) throw new DashboardError('authentication_required', 401);
        if (method === 'GET' && url.pathname === '/api/status') return json(res, 200, options.service.status());
        if (method === 'GET' && url.pathname === '/api/artists') return json(res, 200, { artists: options.service.artists() });
        if (method === 'POST' && url.pathname === '/api/artists') return json(res, 201, { artist: options.service.create(await body(req)) });
        if (method === 'POST' && url.pathname === '/api/import') return json(res, 201, options.service.import(await body(req)));
        const match = /^\/api\/artists\/([A-Za-z0-9_-]{1,100})(?:\/(evidence|collect))?$/.exec(url.pathname);
        if (match) {
          const [, id, action] = match;
          if (method === 'GET' && action === 'evidence') return json(res, 200, options.service.evidence(id));
          if (method === 'POST' && action === 'collect') return json(res, 200, await options.service.collect(id, await body(req)));
          if (method === 'PATCH' && !action) return json(res, 200, { artist: options.service.update(id, await body(req)) });
          if (method === 'DELETE' && !action) return json(res, 200, options.service.remove(id));
        }
        return json(res, 404, { error: 'route_not_found' });
      }
      const asset = assets[url.pathname];
      if (!asset || !['GET', 'HEAD'].includes(method)) return json(res, 404, { error: 'route_not_found' });
      let data: Buffer;
      try { data = await readFile(resolve(publicDirectory, asset.file)); }
      catch { return json(res, 404, { error: 'asset_not_found' }); }
      res.writeHead(200, { 'content-type': asset.type, 'content-length': data.byteLength });
      res.end(method === 'HEAD' ? undefined : data);
    } catch (error) {
      if (res.writableEnded || res.destroyed) return;
      const status = error instanceof DashboardError ? error.status : error instanceof IngestionError ? 400 : 500;
      const code = error instanceof DashboardError || error instanceof IngestionError ? error.code : 'service_error';
      if (status === 413) res.setHeader('connection', 'close');
      json(res, status, { error: code });
    }
  };
  return { handle, setPort: (value: number) => { listeningPort = value; } };
}
export async function startDashboardServer(options: ServerOptions) {
  const app = createDashboardHandler(options);
  const host = options.host ?? '127.0.0.1', port = options.port ?? 4317;
  const bindHost = host === 'localhost' ? '127.0.0.1' : host;
  const server = createServer(app.handle);
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 50;
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(port, bindHost, () => { server.off('error', reject); accept(); }); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new DashboardError('server_address_unavailable', 500);
  app.setPort(address.port);
  const url = `http://${bindHost === '::1' ? '[::1]' : bindHost}:${address.port}`;
  return { server, url, close: () => new Promise<void>((accept, reject) => { server.close(error => error ? reject(error) : accept()); server.closeIdleConnections(); }) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let service: DashboardService | undefined;
  try {
    // Validate before creating a database or binding any socket.
    const host = process.env.FOLD_HOST ?? '127.0.0.1';
    if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new DashboardError('loopback_binding_required');
    const password = process.env.FOLD_DASHBOARD_PASSWORD;
    if (!password || password.length < 12 || password.length > 1024) throw new DashboardError('dashboard_password_required_minimum_12_characters');
    const port = Number(process.env.FOLD_DASHBOARD_PORT ?? 4317);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new DashboardError('invalid_port');
    service = new DashboardService({ dbPath: process.env.FOLD_DB_PATH ?? resolve('data/fold-theory.sqlite') });
    const running = await startDashboardServer({ service, password, host, port });
    process.stdout.write(JSON.stringify({ mode: 'local', url: running.url }) + '\n');
    const shutdown = async () => { await running.close(); service!.close(); process.exit(0); };
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  } catch (error) {
    service?.close();
    process.stderr.write(JSON.stringify({ error: error instanceof DashboardError || error instanceof IngestionError ? error.code : 'server_start_failed' }) + '\n');
    process.exitCode = 1;
  }
}
