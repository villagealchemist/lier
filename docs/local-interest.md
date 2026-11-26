# LIER local evidence research

This is LIER's own public-source collection and local evidence assessment. It does not call Chartmetric or Soundcharts. The temporary team dashboard is a separate client of the reusable modules in `apps/booking/backend/src`.

## Implemented workflow

1. The client starts with a selected artist identity and adds a city and country for a market check. The hosted server resolves the selected provider ID again; client-supplied audience totals are not accepted.
2. `livenation.ts` reads the public artist directory and one matching artist page. It validates the structured MusicEvent performer IDs and preserves event dates, venue, country, region and status. An exact name match is a candidate until the user confirms that provider's artist identity. Directory coverage is partial.
3. `youtube-market.ts` uses the existing YouTube Data API key for one bounded video search and at most one details request. It retains recent music-video titles containing both artist and city. Native views, likes and comments describe each video globally. These title matches remain review candidates and do not establish viewer geography or verified artist ownership.
4. `market-research.ts` collects both sources independently, filters events by city/country and optional region, excludes inactive events and calls `buildLocalInterest`. US state names and abbreviations have an explicit equivalence map; other regions use exact normalized names. There is no Philadelphia default or artist-specific fixture in production code.
5. `local-interest.ts` validates identity, geography, freshness, conflicts and duplicate evidence, then returns a dated assessment with source coverage. It separates direct geographic audience measurements, supplied audience estimates, local activity, no matching evidence and unavailable sources. The current collectors supply local activity and candidate content, not geographic audience counts.

## Meaning and limits

`local-interest-v1` is an evidence assessment, not a calibrated listener or ticket-sales model. Evidence quality describes source coverage, not a probability of a successful show. An event announcement is not paid attendance; a video mentioning a city does not locate its viewers. Sources are never summed into unique people. Candidate matches do not strengthen a verdict. Missing or blocked sources do not become zero demand.

The model accepts future geographic measurements/estimates through explicit typed observations. Estimated observations must identify their method. Producing our own audience-size or turnout estimates will require observed geographic inputs and held-out validation against actual local outcomes; global follower counts alone are insufficient. Optional supplied local reports and comparable shows remain available in the separate calculator.

## Runtime and retention

Public collectors use fixed hosts, bounded response sizes/deadlines and no arbitrary redirects. They need no aggregator credentials. YouTube uses a server-only key. The hosted route is behind the existing shared-password gate, accepts bounded same-origin JSON, applies a per-session rate limit, and shares the existing daily YouTube search budget.

Successful hosted reports and canonical identities are cached only in bounded isolate memory for 15 minutes. No provider payload, key, or new historical series is persisted in D1. Only rate-limit counters are stored. Artist confirmations currently travel with the forecast's active client state; they are not an organization-wide identity registry.

## Modules and verification

- `local-interest.ts`: pure assessment and validation.
- `local-market.ts`: exact market normalization.
- `livenation.ts`: public event collection.
- `youtube-market.ts`: public city-related video candidates.
- `market-research.ts`: collection orchestration.

All five files are vendored unchanged into the separate hosted demonstration's `shared/` directory. Provider modules enter only the server bundle; the browser imports the pure core and market normalization.

Tests cover partial provider failures, bad identities, conflicting geography, future/stale evidence, missing versus zero counters, cancellation, candidate confirmation and native-count semantics. A normal live read on November 26, 2026 found John Summit's November 27 Philadelphia listing at The Liacouras Center. That validates this public event path, not city-listener coverage or turnout prediction.
