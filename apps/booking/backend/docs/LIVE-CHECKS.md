# Verification boundary, November 26, 2026

## What has actually run

- Native Node test runner against provider-response fixtures and SQLite.
- Real local CLI processes covering source status, blocked ingestion, retries, batch processing, status queries, evidence import, synthetic isolation, unified evidence reads and deletion.
- On-disk SQLite tests for abandoned-worker recovery, independent connections, stale-worker fencing and schema upgrades.
- Official source documentation and schemas reviewed through web retrieval.

## What has not run

| Source or path | Current access | Live collection verified? |
| --- | --- | --- |
| YouTube channel counters | API key absent; disabled | No |
| Last.fm artist counters | API key absent; commercial agreement not established; disabled | No |
| Ticketmaster events | API key absent; disabled | No |
| Spotify artist metadata/counters | Access token absent; disabled | No |
| SoundCloud user metadata/counters | Access token absent; disabled | No |
| Wikidata identity candidates | Public endpoint; no key required | No: direct runtime request failed DNS resolution (`ENOTFOUND`) |
| Artist audience report import | Schema and synthetic example tested; real export not supplied | No real report imported |
| Organizer outcome import | Schema and synthetic example tested; real export not supplied | No real organizer data imported |

Successful documentation browsing is not evidence that the executable backend can reach a provider from this environment. No secret values were read from unrelated files or printed. No account, paid API subscription, or provider application was created.

## Reproducible local checks

From the backend directory:

```sh
npm test
npm run sources
node src/cli.ts help
```

The tests use no network requests or production credentials. Synthetic imports are explicitly tagged, opt-in, and hidden from ordinary queries. They must never be relabeled as real artist evidence.

## First live acceptance

Once the execution environment has outbound connectivity and an approved source credential:

1. Verify one real artist's stable source ID, ideally against its official profile.
2. Configure that source only; inspect `sources` for the intended configuration.
3. Ingest a request with a new stable request ID and review its coverage, warnings, and source-specific field availability.
4. Query the resulting evidence and compare it with the original provider response/profile. Check timestamps and units, not just a success code.
5. Repeat the same request ID to verify replay without another network call. Use a new request ID for a later observation.
6. Verify denied and rate-limited responses, expiry, and credential handling in the actual environment.

Only then should a source be described as live connected. A successful metadata call does not verify missing analytics such as Spotify listening cities.

## Remaining runtime scope

The backend is a local library and CLI. It has no public HTTP service, unattended scheduler, lease heartbeat, OAuth onboarding, token refresh, distributed quota coordinator or production deployment. TypeScript is executed through Node type stripping; a separate compiler type-check has not been run. The current storage and source policy must be reviewed before multi-user deployment or long-term collection.
