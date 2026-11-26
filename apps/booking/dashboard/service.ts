import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Store } from '../backend/src/store.ts';
import { sources, IngestionError, validateRequest } from '../backend/src/domain.ts';
import type { IngestRequest, Policies, Snapshot, Source } from '../backend/src/domain.ts';
import { createJsonGet } from '../backend/src/http.ts';
import { providerCollector } from '../backend/src/providers.ts';
import { ingest } from '../backend/src/ingest.ts';
import { importEvidence, queryAudienceEvidence, queryShowOutcomes, purgeExpiredEvidence, validateEvidenceImport } from '../backend/src/imports.ts';

export class DashboardError extends Error {
  code: string;
  status: number;
  constructor(code: string, status = 400) { super(code); this.code = code; this.status = status; }
}
export interface Artist {
  id: string; name: string; genre: string; market: string; shortlisted: boolean;
  taste: number | null; notes: string; feeMinor: number | null; currency: string;
  sourceIds: Partial<Record<Source, string>>; createdAt: string; updatedAt: string;
}
export interface ServiceOptions {
  dbPath: string;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  collect?: (request: IngestRequest) => Promise<Snapshot>;
}
const fields = new Set(['name', 'genre', 'market', 'shortlisted', 'taste', 'notes', 'feeMinor', 'currency', 'sourceIds']);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new DashboardError('invalid_object');
  return value as Record<string, unknown>;
}
function string(value: unknown, field: string, limit: number, required = false): string {
  if (typeof value !== 'string' || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) || (required && !value.trim())) throw new DashboardError(`invalid_${field}`);
  return value.trim();
}
function patch(input: unknown): Partial<Artist> {
  const value = object(input), result: Partial<Artist> = {};
  if (!Object.keys(value).length || Object.keys(value).some(k => !fields.has(k))) throw new DashboardError('invalid_artist_fields');
  for (const key of ['name', 'genre', 'market', 'notes'] as const) if (Object.hasOwn(value, key)) result[key] = string(value[key], key, key === 'notes' ? 4000 : 120, key === 'name');
  if (Object.hasOwn(value, 'shortlisted')) {
    if (typeof value.shortlisted !== 'boolean') throw new DashboardError('invalid_shortlisted');
    result.shortlisted = value.shortlisted;
  }
  if (Object.hasOwn(value, 'taste')) {
    if (value.taste !== null && (!Number.isInteger(value.taste) || (value.taste as number) < 1 || (value.taste as number) > 5)) throw new DashboardError('invalid_taste');
    result.taste = value.taste as number | null;
  }
  if (Object.hasOwn(value, 'feeMinor')) {
    if (value.feeMinor !== null && (!Number.isSafeInteger(value.feeMinor) || (value.feeMinor as number) < 0 || (value.feeMinor as number) > 10_000_000_000)) throw new DashboardError('invalid_feeMinor');
    result.feeMinor = value.feeMinor as number | null;
  }
  if (Object.hasOwn(value, 'currency')) {
    if (value.currency !== 'USD') throw new DashboardError('invalid_currency');
    result.currency = value.currency;
  }
  if (Object.hasOwn(value, 'sourceIds')) {
    const ids = object(value.sourceIds), normalized: Partial<Record<Source, string>> = {};
    for (const [source, externalId] of Object.entries(ids)) {
      const request = validateRequest({ requestId: 'identity-review', artistId: 'identity-review', source, externalId });
      normalized[request.source] = request.externalId;
    }
    result.sourceIds = normalized;
  }
  return result;
}
function policiesFrom(env: Record<string, string | undefined>): Policies {
  const result = Object.fromEntries(sources.map(s => [s.source, { enabled: false, retentionDays: s.source === 'youtube' ? 30 : 7 }])) as Policies;
  if (!env.LIER_POLICY_FILE) return result;
  const bytes = readFileSync(env.LIER_POLICY_FILE);
  if (bytes.byteLength > 16_000) throw new DashboardError('source_policy_too_large');
  const value = object(JSON.parse(bytes.toString('utf8')));
  for (const [source, raw] of Object.entries(value)) {
    if (!sources.some(s => s.source === source)) throw new DashboardError('unknown_policy_source');
    const policy = object(raw);
    if (Object.keys(policy).sort().join(',') !== 'enabled,retentionDays' || typeof policy.enabled !== 'boolean' || !Number.isInteger(policy.retentionDays) || (policy.retentionDays as number) < 1 || (policy.retentionDays as number) > 30) throw new DashboardError('invalid_source_policy');
    result[source as Source] = { enabled: policy.enabled, retentionDays: policy.retentionDays as number };
  }
  return result;
}

export class DashboardService {
  readonly store: Store;
  private readonly env: Record<string, string | undefined>;
  private readonly policies: Policies;
  private readonly clock: () => Date;
  private readonly collector: (request: IngestRequest) => Promise<Snapshot>;
  private activeArtist: string | null = null;
  constructor(options: ServiceOptions) {
    this.env = { ...(options.env ?? process.env) };
    this.policies = policiesFrom(this.env);
    this.clock = options.now ?? (() => new Date());
    this.collector = options.collect ?? providerCollector(createJsonGet(), this.env);
    const path = options.dbPath === ':memory:' ? options.dbPath : resolve(options.dbPath);
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.store = new Store(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS dashboard_artists (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dashboard_artist_sources (artist_id TEXT NOT NULL REFERENCES dashboard_artists(id) ON DELETE CASCADE, source TEXT NOT NULL, external_id TEXT NOT NULL, PRIMARY KEY(artist_id,source), UNIQUE(source,external_id));`);
  }
  close() { this.store.close(); }
  status() {
    return { mode: 'local', version: '0.3.0', serverTime: this.clock().toISOString(),
      sources: sources.map(s => ({ ...s, enabled: this.policies[s.source].enabled, credentialConfigured: Boolean(this.env[s.credentialEnv]),
        commercialAccessApproved: s.source === 'lastfm' ? this.env.LASTFM_COMMERCIAL_APPROVED === 'true' : null,
        accessConfigured: this.policies[s.source].enabled && Boolean(this.env[s.credentialEnv]) && (s.source !== 'lastfm' || this.env.LASTFM_COMMERCIAL_APPROVED === 'true'),
        lastRun: this.store.db.prepare('SELECT request_id,status,collected_at,completed_at,error_code,coverage FROM runs WHERE source=? ORDER BY collected_at DESC,request_id DESC LIMIT 1').get(s.source) ?? null })),
      notice: 'Local single-user workspace. Configured access is not proof of live coverage. No provider data contributes to a booking score.' };
  }
  artists(): Artist[] { return this.store.db.prepare('SELECT payload FROM dashboard_artists ORDER BY id').all().map(row => JSON.parse(String(row.payload)) as Artist).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)); }
  artist(id: string): Artist {
    const row = this.store.db.prepare('SELECT payload FROM dashboard_artists WHERE id=?').get(id);
    if (!row) throw new DashboardError('artist_not_found', 404);
    return JSON.parse(String(row.payload));
  }
  private save(artist: Artist) {
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [source, externalId] of Object.entries(artist.sourceIds)) {
        const roster = this.store.db.prepare('SELECT artist_id FROM dashboard_artist_sources WHERE source=? AND external_id=? AND artist_id<>?').get(source, externalId!, artist.id);
        const existing = this.store.db.prepare('SELECT artist_id FROM identities WHERE source=? AND external_id=?').get(source, externalId!);
        if (roster || existing && existing.artist_id !== artist.id) throw new DashboardError('source_identity_already_linked', 409);
      }
      this.store.db.prepare('INSERT INTO dashboard_artists(id,payload) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(artist.id, JSON.stringify(artist));
      this.store.db.prepare('DELETE FROM dashboard_artist_sources WHERE artist_id=?').run(artist.id);
      const statement = this.store.db.prepare('INSERT INTO dashboard_artist_sources(artist_id,source,external_id) VALUES (?,?,?)');
      for (const [source, externalId] of Object.entries(artist.sourceIds)) statement.run(artist.id, source, externalId!);
      this.store.db.exec('COMMIT');
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
    return artist;
  }
  create(input: unknown): Artist {
    const values = patch(input);
    if (!values.name) throw new DashboardError('name_required');
    if (Number(this.store.db.prepare('SELECT count(*) AS total FROM dashboard_artists').get()!.total) >= 1000) throw new DashboardError('roster_limit_reached', 409);
    const now = this.clock().toISOString();
    return this.save({ id: randomUUID(), name: values.name, genre: '', market: '', shortlisted: false, taste: null, notes: '', feeMinor: null, currency: 'USD', sourceIds: {}, ...values, createdAt: now, updatedAt: now });
  }
  update(id: string, input: unknown): Artist {
    const old = this.artist(id);
    if (this.activeArtist === id) throw new DashboardError('artist_collection_in_progress', 409);
    return this.save({ ...old, ...patch(input), updatedAt: this.clock().toISOString() });
  }
  remove(id: string) {
    this.artist(id);
    if (this.activeArtist === id) throw new DashboardError('artist_collection_in_progress', 409);
    const now = this.clock(), instant = now.toISOString();
    this.store.purge(instant); purgeExpiredEvidence(this.store, now);
    const retainedIdentity = this.store.db.prepare('SELECT 1 FROM identities WHERE artist_id=? LIMIT 1').get(id);
    if (retainedIdentity || this.store.observations(id, instant).length || this.store.events(id, instant).length || this.store.profiles(id, instant).length || queryAudienceEvidence(this.store, { artistId: id, now }).length || queryShowOutcomes(this.store, { artistId: id, now }).length) throw new DashboardError('artist_has_retained_evidence', 409);
    this.store.db.prepare('DELETE FROM dashboard_artists WHERE id=?').run(id);
    return { deleted: true, artistId: id, notice: 'Removed from roster.' };
  }
  evidence(id: string) {
    const artist = this.artist(id), now = this.clock(), instant = now.toISOString();
    this.store.purge(instant); purgeExpiredEvidence(this.store, now);
    return { artist, observations: this.store.observations(id, instant), events: this.store.events(id, instant), profiles: this.store.profiles(id, instant),
      audience: queryAudienceEvidence(this.store, { artistId: id, now }), shows: queryShowOutcomes(this.store, { artistId: id, now }),
      notice: 'Source measurements, report evidence and whole-event outcomes remain separate. Missing evidence is unknown. Personal taste is not a measured statistic.' };
  }
  import(input: unknown) {
    const document = validateEvidenceImport(input), tracked = new Set(this.artists().map(artist => artist.id));
    if (document.kind === 'artist_audience' && document.records.some(record => !tracked.has(record.artistId))) throw new DashboardError('unknown_artist_id');
    if (document.kind === 'show_outcomes' && document.records.some(record => !record.lineupArtistIds.some(id => tracked.has(id)))) throw new DashboardError('show_requires_tracked_artist');
    const unregisteredLineupArtistIds = document.kind === 'show_outcomes' ? [...new Set(document.records.flatMap(record => record.lineupArtistIds.filter(id => !tracked.has(id))))].sort() : [];
    return { import: importEvidence(document, { store: this.store, now: this.clock, allowSynthetic: false }), warnings: { unregisteredLineupArtistIds } };
  }
  async collect(id: string, input: unknown) {
    const artist = this.artist(id), value = object(input);
    if (Object.keys(value).some(k => k !== 'sources')) throw new DashboardError('invalid_collection_fields');
    const requested = value.sources ?? Object.keys(artist.sourceIds);
    if (!Array.isArray(requested) || !requested.length || requested.length > sources.length || new Set(requested).size !== requested.length || requested.some(s => typeof s !== 'string' || !sources.some(item => item.source === s))) throw new DashboardError('invalid_collection_sources');
    if (requested.some(s => !artist.sourceIds[s as Source])) throw new DashboardError('source_identity_required');
    if (this.activeArtist) throw new DashboardError('collection_in_progress', 409);
    this.activeArtist = id;
    try {
      const results = [];
      for (const source of requested as Source[]) {
        const result = await ingest({ requestId: randomUUID(), artistId: id, source, externalId: artist.sourceIds[source] }, {
          store: this.store, policies: this.policies, now: this.clock, collect: this.collector, lastFmCommercialApproved: this.env.LASTFM_COMMERCIAL_APPROVED === 'true'
        });
        results.push({ source, ...result });
      }
      return { artistId: id, results };
    } finally { this.activeArtist = null; }
  }
}
