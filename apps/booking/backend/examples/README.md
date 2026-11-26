# Evidence import examples

Both JSON files in this directory are synthetic schema examples. They describe no real artist, platform report, venue, ticket sales, authorization or settlement. They are never loaded automatically. Ordinary imports reject `synthetic: true`; a deliberate `--allow-synthetic` option is required to exercise them. Queries exclude synthetic rows unless `--include-synthetic` is selected.

For actual evidence, construct a separate file using verified records and declare its real provenance and authorization. Changing a synthetic flag does not make an example real data. The importer records declared authorization; it does not verify a license, artist consent, or permission to retain, analyze or redistribute data. Current imported rows have `scoringAllowed: false`.

## Audience reports

`artist-audience.synthetic.json` illustrates a city-level artist report:

- `platform` identifies the original measured platform. `provenance.provider` identifies who supplied the report; keep both.
- `sourceAccountId` namespaces the supplier account so identifiers from unrelated accounts do not collide.
- `artistId` is an explicitly verified LIER artist ID. No name matching occurs.
- `observedPeriod.start` and `.end` are inclusive calendar dates reported by the source. Preserve the original range; do not relabel lifetime or daily data as monthly listeners. This schema supports a bounded date range, not open-ended lifetime observations.
- City, region and ISO country code are required geographic context. `region: null` means unknown. These values must describe audience geography, not the artist's hometown.
- `value: 0` with `availability: reported` is a measured zero. A missing metric uses `value: null` and `not_reported`; a source-suppressed metric uses `suppressed`. No missing value becomes zero.
- `precision: estimated` marks a source estimate; it does not manufacture one. A count alone never establishes ticket demand or audience overlap.

## Show outcomes

`show-outcomes.synthetic.json` carries aggregate organizer records only. There is no attendee row, name, email, transaction card data or other attendee-level field. Unknown fields are rejected. Keep credentials and personal information out of document references and provenance strings as well.

`paidAttendance`, `refundedTickets`, and `complimentaryAttendance` are separate reported quantities. Paid attendance is not automatically the number of tickets sold; the importer neither subtracts refunds from it nor calculates sell-through. `netTicketRevenueMinor` uses integer minor currency units, so `1023425` USD means $10,234.25. Preserve the report's definition of net revenue, including its treatment of fees and refunds. It is not assumed to be total event profit. Negative settlements are allowed and retained.

Each record retains the entire `lineupArtistIds` array. Querying by any artist returns the whole event with `attribution: whole_event_not_individual_artist`; no artist receives inferred individual attendance or revenue credit. Lineup array order is not billing order. Billing-position data requires a later explicit schema field.

## Provenance, revisions and retention

`sourceGeneratedAt` is the supplier's report timestamp, or null if unknown. `importedAt` is assigned by LIER and never substituted for that timestamp. The declared retention deadline, `authorization.retainUntil`, is mandatory and enforced on queries. It must be set from the actual applicable authorization, not an arbitrary default. Source restrictions continue to apply to exported data, including any limits on derived metrics; importing a report does not bypass those limits.

An import ID is immutable: re-importing the same normalized content returns the original receipt, while changing content under that ID fails. A correction uses a new import ID. Current query views deduplicate by source account and factual key and prefer a newer source-generated timestamp, then import time when source timestamps are identical. A first observation may have an unknown source timestamp, but a later import for the same factual key is rejected as `ambiguous_source_time_revision` if either revision has unknown source time. Import time is not compared against source time. Re-importing the same import ID and content remains idempotent. An explicit supersedes workflow is not yet implemented.

Report generation follows an explicit UTC calendar-date policy: when `sourceGeneratedAt` is provided, its UTC date must be on or after each event date or audience observation-period end. A report cannot claim to have been generated before the period or event it describes. Source timestamps and observation dates must be reconciled to this policy before import if the exporting system uses different date conventions.

Old revisions remain as evidence until expiry or deletion, but are not returned as current observations. Expiring or deleting the latest revision does not make an older revision current again. Opaque revision-head tombstones retain hashes, internal record references and ordering timestamps; they contain no reported counter or financial values. Queries from different source accounts remain separate evidence, not a deduplicated unique population.

Run the explicit evidence purge operation in continuous deployments; a query's expiry filter alone is not a physical deletion schedule. Scoped import deletion supports removing an export after consent is withdrawn. Source copies, backups and external exports need the same retention/revocation handling outside this module.

## Module interface

```ts
importEvidence(input, { store, now?: () => Date, allowSynthetic?: boolean })
queryAudienceEvidence(store, { artistId?: string, includeSynthetic?: boolean, now?: Date })
queryShowOutcomes(store, { artistId?: string, includeSynthetic?: boolean, now?: Date })
purgeExpiredEvidence(store, now?: Date)
deleteEvidenceImport(store, importId)
```

The importer owns `evidence_*` tables and never writes the provider `observations` or `events` tables. Validation is strict: no unknown fields, coercion from numeric strings, fractional counts, invalid calendar dates, future observations, duplicated rows, expired authorization or undeclared authorization. Every batch writes atomically.
