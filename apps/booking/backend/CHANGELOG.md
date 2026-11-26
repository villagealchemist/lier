# Changes

## 0.2.0

- Added direct Spotify artist and SoundCloud user adapters with explicit unavailable metrics and stable identity checks.
- Added Wikidata search and identity candidates, retaining source revision, competing IDs and review requirements without auto-linking.
- Added serialized batch ingestion, run/status inspection and explicit retry commands.
- Added expiring ten-minute worker leases and fencing tokens, safe recovery from interrupted jobs, and retry deadlines.
- Added strict normalized-snapshot validation before database writes, profile persistence and compatible SQLite schema upgrades.
- Added authorized artist-audience report and organizer outcome imports with provenance, geographic/period scope, whole-event attribution, currency minor units and source-controlled retention.
- Added import correction handling, ambiguous-date rejection, deletion/expiry tombstones, and strict synthetic-example isolation.
- Added unified evidence queries that preserve sources and units without inventing rankings or audience totals.
- Added regression checks for identity case normalization, stale workers, corrupted inputs, atomic rollback, imports and actual CLI processes.

No provider credentials are connected and no live adapter has been verified. Local runtime DNS prevented the public Wikidata probe. No UI work or publication is part of this version.

## 0.1.0

Initial YouTube, Last.fm and Ticketmaster adapters, source mapping, SQLite observations, request idempotency, retry handling and deterministic tests.
