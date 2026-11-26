# LIER backend architecture

## Purpose and current boundary

The backend collects music-market evidence, preserves its definition and provenance, and gives future booking analysis a dependable input boundary. Provider observations, authorized exports and team taste have different meanings. An eventual agent or UI can use the same records without manufacturing missing values, joining performers by name or turning an event listing into a ticket receipt.

Version 0.2 is a local CLI backed by SQLite. It includes five direct provider adapters, Wikidata candidate discovery, serial batch orchestration, recoverable fenced ingestion and strict authorized-import schemas. There is no public HTTP service, deployment, UI, shared team account system or scoring model.

No provider credentials were available during development. A runtime Wikidata probe failed DNS resolution with `ENOTFOUND`. Documentation research and deterministic fixture tests are evidence of implemented contracts, not live data coverage.

## Acquisition paths

| Path | Boundary | Output |
| --- | --- | --- |
| Provider ingestion | Validated request, explicit source policy, provisioned credential, fixed approved endpoint, provider parser and strict snapshot validator | Timestamped provider observations, event listings and optional artist profile |
| Identity discovery | Wikidata name search or explicit entity ID; retain conflicting candidates and source statements | Review candidates only; no identity database writes or metric inference |
| Authorized imports | Strict JSON report/outcome schema, declared authorization, source/account namespace, observation dates and retention deadline | Attributable local-audience evidence or whole-event organizer results |

The provider registry currently covers YouTube counters, Last.fm counters, Ticketmaster events, Spotify profiles and exposed follower/popularity fields, and SoundCloud profiles and exposed account counters. An unavailable field remains unavailable; no adapter substitutes an invented value. Detailed access constraints remain in [SOURCE-MAP.md](SOURCE-MAP.md).

Node supplies HTTP requests, the test runner and SQLite implementation. TypeScript expresses contracts; Node runs the files by type stripping, and a separate compiler typecheck has not been performed. SQLite supports the current local scope. Its presence does not establish a distributed production warehouse.

## Record boundaries

| Record | Purpose | Implemented behavior |
| --- | --- | --- |
| Identity candidate | Preserve community-supplied cross-platform identifiers and conflicting claims | Wikidata entity revision, property, statement, rank and reference count; review required |
| Confirmed source identity | Link a canonical LIER artist ID to a provider entity | Operator-supplied mapping, uniqueness enforced; Last.fm UUID case normalized with legacy-safe checks |
| Ingestion run | Idempotency, ownership and operational state | Request fingerprint, status, attempt count, fencing token, lease expiry, collection times, data expiry, safe errors and retry delay |
| Provider observation | Preserve one platform's native metric | Exact metric name, unit, scope, period, availability and precision; geographic scope remains unknown where unavailable |
| Provider profile | Preserve optional display identity from Spotify/SoundCloud | Validated name and constrained provider URL; expires with its snapshot |
| Event listing | Retain touring context | Provider event ID, status, date and place; attendance is always null |
| Import provenance | Record a supplied document and operator's access declaration | Provider/account, document reference, source time, declaration, retention deadline, synthetic flag and content fingerprint |
| Imported audience record | Retain an artist report's market-level observation | Explicit platform, artist, metric, period and geography; reported/estimated and reported/missing/suppressed distinctions |
| Organizer outcome | Retain actual reported event results without overstated attribution | Event/date/venue, complete lineup, attendance, refunds, comps, capacity, integer minor-unit net ticket revenue and currency |
| Import revision head | Identify the current source-dated revision | Namespace-specific head and opaque tombstone; expiry/deletion cannot revive an older revision |
| Booking preference or derived feature | Add team taste or supported analysis later | Not implemented; distinct from the acquisition records |

`complete_for_requested_endpoint` means the requested endpoint was consumed without a known adapter coverage gap. It does not mean the artist has a complete audience profile or touring history. A succeeded run can retain explicit missing fields and partial coverage.

## Ingestion state and recovery

Every request has a stable ID and a fingerprint over artist, source and external ID. SQLite claims and writes use transactions. The run holds a ten-minute lease by default, with a monotonic fencing token and attempt count. Programmatic lease duration is configurable from one second through one hour.

| Existing state | Matching submission |
| --- | --- |
| No run | Claim a lease and collect |
| Running with an unexpired lease | Refuse duplicate work with `run_in_progress` |
| Running with an expired lease | Reclaim with a newer token and collect |
| Succeeded | Replay its recorded status without another fetch |
| Blocked, denied, rate-limited or failed | Replay unless the caller explicitly sets retry; enforce the stored retry deadline |
| Any state with a different fingerprint | Reject as an idempotency conflict |

A finish requires the current, unexpired lease and matching request. A stale worker cannot write observations or override a replacement worker's result with a failure. The caller receives `leaseLost` if ownership is lost; the CLI treats that as failure even if the current database run belongs to another worker that succeeded. Validation reconstructs bounded records before they cross the persistence boundary, and snapshot writes are atomic.

This is recoverable claim handling, not an unattended queue. There is no heartbeat or daemon that scans expired leases; a new matching submission performs recovery. Attempt count and latest run state are retained, but a full per-attempt event log is not implemented. A successful request is never silently refreshed; new observations use new request IDs.

Batch ingestion validates every request and duplicate ID before any collection. It then processes requests serially and reports failures independently. This limits local concurrency but is not a cross-process or distributed provider quota manager.

## Imported evidence and revisions

Imports are separate from provider snapshots so that a self-declared report cannot masquerade as a live API response. The importer rejects unknown fields, inconsistent values, future observations, invalid periods, expired authorization and duplicate logical rows before committing the document. It stores no attendee-level fields. An authorization declaration is preserved as self-reported, not certified.

The current-view key includes provider, source account, evidence kind, synthetic status and the logical measurement or event. Corrections compare source generation times. Older reports arriving later cannot overwrite newer evidence. Revisions with ambiguous unknown source time fail rather than adopting arrival order as truth. A surviving revision tombstone prevents an older correction from resurfacing when the current document expires or is deleted.

Synthetic examples require explicit import opt-in and remain excluded from ordinary queries. A combined evidence query returns provider observations, imported audience data and event outcomes with their separate provenance. It computes no unique-audience total, artist-level ticket draw, fit score or prediction. Whole-event records returned for one lineup artist remain whole-event records.

## Source meaning, time and retention

- A stream, listener, follower, subscriber, ticket order and paid attendee are different units. Platform populations cannot be summed into unique people without a defensible model and the required permissions.
- Artist hometown never becomes listener geography. Imported geography comes from explicit report fields.
- Collection start/completion, source update time and an imported observation period are separate fields. Current provider adapters do not establish source measurement timestamps, so those remain null.
- Missing, hidden, suppressed, unreturned and zero retain distinct semantics. Denied access fails visibly and never falls back to synthetic data.
- Each source has explicit enabling and retention configuration. Provider data expires after its configured 1–30-day period; imported evidence uses its declared retention deadline. Queries filter expiry even before physical purge.
- Provider snapshots, profiles and imported values are purged through applicable CLI commands. No unattended retention schedule exists. Backups and exported copies need independent expiry controls.
- Raw provider bodies, credential values and credential-bearing request URLs are not persisted. Run metadata and import revision tombstones retain safe identifiers/status or opaque revision keys after evidence deletion.
- Every current evidence record is excluded from scoring. Later feature computation needs source-specific analysis permissions, precise definitions, lineage and formula versions.

Existing local databases are upgraded without a rebuild. Lease/provenance columns and new tables are additive. Last.fm UUID compatibility checks merge case variants belonging to the same artist and preserve existing observations. Historical request hashes migrate only when they match the original or canonical request. Conflicting artist mappings (`legacy_identity_case_conflict`) or unverifiable hashes (`legacy_run_fingerprint_conflict`) prevent opening the store; the identity/hash migration rolls back without deleting existing data. These cases require investigation of the original records before migration can proceed.

## Next backend slices

1. **Prove an authorized live vertical slice.** Establish working runtime connectivity, configure an approved source, verify real artist identities, retrieve and query an observation, then verify refresh and actual field coverage. Fixture success does not satisfy this milestone.
2. **Close the local-demand access gap.** Obtain artist-authorized reports or an appropriate licensed route for local audience evidence, and identify the organizer/ticketing export formats to support. The import schema exists; real access and provider-specific conversion still need verification.
3. **Complete source onboarding.** Add OAuth consent and token refresh where appropriate, durable access-grant/revocation records, and further platform adapters against confirmed entitlements. Direct Spotify monthly listening geography remains unimplemented.
4. **Operationalize collection and retention.** Introduce scheduling, lease heartbeat, provider/tenant quota coordination, full attempt auditing, schema-release management, monitoring, managed secrets and backup policies. Select a deployed warehouse when scale and concurrency requirements are established.
5. **Extend identity and reconciliation.** Add reviewed entity linking, alias/collaboration handling, track/release identifiers and reversible corrections. A community-maintained ID candidate is evidence to review, not an automatic identity decision.
6. **Build validated booking analysis.** Separate preferences, costs, observations and uncertainty. Validate eligible features against actual show outcomes chronologically and in comparable market/venue contexts. Account for lineup and promotion confounding before attributing event demand to an artist or producing forecasts.
7. **Expose a shared application boundary.** Add team access controls and typed service/MCP interfaces over these same modules, then design the UI around proven data workflows.

## Release acceptance boundary

Complete for this slice: executable adapters and CLI workflows, candidate discovery, strict report/outcome imports, persistent provenance, idempotency, recoverable fenced claims, retention and revision handling, deterministic tests, source-access documentation and explicit gaps.

Not established: live provider connectivity or entitlements, Chartmetric-equivalent breadth/history/geography, an unattended production system, automatic consent/token lifecycle, direct ticketing-platform integrations, source-approved scoring, or a validated booking recommendation. This release does not yet provide validated booking recommendations.
