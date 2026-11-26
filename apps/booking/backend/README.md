# Fold Theory ingestion backend

Version 0.2 builds the data foundation for artist booking research: direct provider adapters, identity candidates, authorized report imports, source-aware storage, and recoverable ingestion. It does not use Chartmetric as its backend. No UI or deployment is part of this release.

**All five provider credentials are currently absent, and no live provider adapter has been validated.** A direct Wikidata probe failed with DNS resolution error `ENOTFOUND` in the execution runtime. Official documentation was accessible through web research, which does not prove runtime API connectivity. The executable paths are tested with synthetic fixtures; this is not Chartmetric-equivalent coverage or a production service.

## Implemented sources

| Adapter | Stored evidence | Required access / boundary |
| --- | --- | --- |
| YouTube | Channel subscribers, lifetime views, public video count | `YOUTUBE_API_KEY`; hidden subscribers remain null, rounding retained. No city or demographic analytics. |
| Last.fm | Artist listeners and scrobbles | `LASTFM_API_KEY` and an already obtained commercial-use agreement. MusicBrainz UUID input is canonicalized to lowercase. These are Last.fm counters. |
| Ticketmaster | Events by attraction ID, dates, venues, geography and listing status | `TICKETMASTER_API_KEY`; paginated up to the provider's deep-paging boundary, then explicitly partial. No attendance is inferred. |
| Spotify | Artist profile and follower/popularity fields when actually returned | Externally provisioned `SPOTIFY_ACCESS_TOKEN`. Entitlement-limited fields remain null. No monthly listeners or listening-city data. |
| SoundCloud | User profile, exposed follower count, public track and playlist counts | Externally provisioned `SOUNDCLOUD_ACCESS_TOKEN`; stable `soundcloud:users:…` URN required. No artist hometown is converted into audience geography. |

Wikidata discovery can search names and return cross-platform identity candidates with source revision and statement provenance. It never automatically links candidates, resolves a name collision, or imports follower-count qualifiers. Its SoundCloud handle candidates still need verification and resolution to stable user URNs before provider ingestion.

The authorized-import path accepts audience reports and whole-event organizer results in a strict JSON format. It is a way to retain evidence that the team is entitled to supply, not a bypass for unavailable APIs. See [SOURCE-MAP.md](docs/SOURCE-MAP.md) for source access and [ARCHITECTURE.md](docs/ARCHITECTURE.md) for system boundaries.

## Run

Node 26 or newer; no runtime or test package dependencies. Node executes TypeScript through type stripping. A separate TypeScript compiler check has not been run.

```sh
npm test
npm run sources
node src/cli.ts help
```

Put authorized credentials in an untracked `.env` file, and point `FOLD_POLICY_FILE` to a source-policy JSON file. Every source defaults to disabled. Each configured policy has exactly `enabled` and `retentionDays`; accepted retention is 1–30 days. Enable a source only after establishing its intended access and retention. `LASTFM_COMMERCIAL_APPROVED=true` records an existing agreement; it does not acquire one. Spotify and SoundCloud token creation and refresh are not implemented.

```sh
cp .env.example .env
node --env-file=.env src/cli.ts sources
```

`sources` exposes credential presence, enabled state, declared capabilities and the last recorded provider run, never credential values. Neither configuration nor a successful response proves complete artist coverage.

## Collect and inspect provider evidence

Each request specifies an operator-verified provider identity and a canonical Fold Theory artist ID. Replace the placeholder channel ID before using this request:

```json
{
  "requestId": "artist-001-youtube-20261126",
  "artistId": "artist-001",
  "source": "youtube",
  "externalId": "UCabcdefghijklmnopqrstuv"
}
```

```sh
node --env-file=.env src/cli.ts identity-search "artist name"
node --env-file=.env src/cli.ts ingest request.json
node --env-file=.env src/cli.ts batch requests.json
node --env-file=.env src/cli.ts status artist-001-youtube-20261126
node --env-file=.env src/cli.ts runs artist-001
node --env-file=.env src/cli.ts observations artist-001
```

`identity Q123` retrieves candidates for an explicitly selected Wikidata item; use the reviewed item's actual ID. Discovery results are not inserted into the identity store. `batch` accepts a JSON array of 1–100 requests. It validates the entire array and rejects duplicate request IDs before collecting anything, then processes requests serially and reports independent failures without stopping the remaining requests. Serial processing is not distributed quota coordination.

Provider IDs are explicit: YouTube channel ID, Last.fm MusicBrainz UUID, Ticketmaster attraction ID, Spotify artist ID, or SoundCloud user URN. An existing source identity cannot silently move to another artist. Last.fm UUID casing is normalized, including compatible older records; conflicting legacy mappings fail rather than being merged.

## Retry and crash behavior

- A completed successful request replays without another fetch. Use a new request ID for a new observation; successful requests are never silently refreshed.
- A blocked or failed request also replays by default. `--retry` explicitly permits another attempt with the same identity and request fingerprint, after any recorded `Retry-After` deadline.
- Reusing a request ID for a different artist, source or external ID fails.
- Active work holds a ten-minute lease by default. An expired running lease can be reclaimed on the next matching submission. The programmatic `leaseDurationMs` option accepts 1 second through 1 hour.
- Each claim gets a newer fencing token. A stale worker cannot commit data or replace the newer worker's result with a failure.
- `leaseLost: true` means the caller lost ownership even if the returned run belongs to a replacement worker that succeeded. The CLI treats this as failure.

```sh
node --env-file=.env src/cli.ts ingest request.json --retry
node --env-file=.env src/cli.ts batch requests.json --retry
```

`status` and `runs` show attempt count, lease state, safe failure codes, collection and completion times, expiry and coverage. Blocked or failed ingestion exits with status 2. There is no lease heartbeat or unattended job scheduler; an operation that outlives its lease fails safely and requires a later claim.

## Import local audience reports and organizer results

The two supported import kinds are:

| Kind | Evidence preserved |
| --- | --- |
| `artist_audience` | Artist, platform, listeners/followers/streams, reported versus missing or suppressed value, precision, observation period and explicit city/region/country. |
| `show_outcomes` | Provider/account event ID, date, venue, complete lineup, paid and complimentary attendance, refunded tickets, sellable capacity, net ticket revenue in integer minor units, and currency. |

Each document needs a source/account namespace, document reference, source-generation time or explicit unknown, declared authorization basis and responsible operator, retention deadline, unique import ID and an explicit `synthetic` flag. Authorization is self-declared and returned as such; the importer does not independently establish permission. Unrecognized fields, attendee-PII additions, impossible dates and contradictory values are rejected before any records are written.

```sh
node --env-file=.env src/cli.ts import evidence.json
node --env-file=.env src/cli.ts audience artist-001
node --env-file=.env src/cli.ts shows artist-001
node --env-file=.env src/cli.ts evidence artist-001
```

The files in [examples/](examples/README.md) are fictional schemas, not retrieved artist reports or ticketing records. They require deliberate import opt-in and are excluded from ordinary queries:

```sh
node src/cli.ts import examples/artist-audience.synthetic.json --allow-synthetic
node src/cli.ts import examples/show-outcomes.synthetic.json --allow-synthetic
node src/cli.ts evidence artist-demo-001 --include-synthetic
```

Repeated identical imports are idempotent; conflicting reuse of an import ID fails. Dated corrections update the current view within the same provider/account namespace using source generation time, not merely import arrival order. Ambiguous revisions with unknown source time fail. Revision tombstones prevent an expired or deleted correction from exposing an older version again. Whole-event outcomes remain attributed to the event and lineup, not to a single artist's supposed ticket draw.

## Provenance and retention

Provider snapshots pass strict validation again at the database boundary. Unknown fields, incompatible metric definitions, duplicate records, invalid values or profile links, and identity mismatches are rejected. Transactional writes prevent partial snapshots.

Observations preserve source, provider ID, request ID, metric unit and scope, window, precision, availability, collection start/completion and expiry. Provider measurement timestamps are unknown and remain null. Collection time is not presented as the source's measurement time. Imported evidence preserves its supplied period and source timestamp separately.

Zero is a measured zero. Hidden, missing and suppressed values stay distinct. Platform audiences are never added into a unique-person total. No booking score, individual-artist ticket attribution or attendance forecast is computed; all returned evidence is excluded from scoring in this release.

SQLite is local runtime state excluded from the source package. Queries hide expired evidence. Ingestion and query paths purge their applicable expired values; `purge` removes expired provider data and imports together. `delete-import` deletes one imported document and its records while retaining opaque revision tombstones. It does not delete the upstream source document.

```sh
node --env-file=.env src/cli.ts purge
node --env-file=.env src/cli.ts delete-import import-001
```

No raw provider response bodies or credential-bearing request URLs are stored. Historical snapshots remain subject to permitted retention; this release does not provide a historical warehouse or backfill. There is no background retention scheduler, and backup/export expiry must be handled separately before a continuously running deployment.

## Validation and remaining work

Deterministic tests cover adapters, missing/hidden/zero handling, metric precision, identity candidates and conflicts, whole-batch validation, strict persistence schemas, atomic writes, idempotency, cross-connection lease fencing, crash recovery, legacy database upgrades, retry deadlines, imports and corrections, retention, synthetic-data separation, pagination, safe request construction and sanitized errors. Tests use local fixtures and in-memory or temporary on-disk SQLite databases; they do not establish live API access.

Still required: a live authorized vertical slice, source-specific analytics entitlements, automatic token refresh or OAuth onboarding, managed collection and retention scheduling, lease heartbeat, distributed quotas, production secrets/backup operations, a deployed warehouse, direct ticketing-platform connectors, semantic artist/track/release reconciliation, calibrated booking features and service/team access controls. No public HTTP API or UI is provided.
