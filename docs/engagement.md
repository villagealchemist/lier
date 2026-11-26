# Artist engagement evidence

`apps/booking/backend/src/engagement.ts` is the reusable source of truth for the artist engagement summary. It has no dependencies on a dashboard, provider SDK, hosting runtime, or booking city. The temporary team dashboard may vendor the same module to present its existing provider results; dashboard source does not belong in this backend module.

`buildArtistEngagement(profiles, now)` accepts confirmed artist profiles. Its input is structurally compatible with the research adapters: source and artist identity, profile counters, fetched time, and optionally dated posts/videos with counters. Confirming that accounts belong to the intended artist remains the caller's responsibility. The function does not fetch new data or resolve identities.

The result keeps each platform separate. Current profile followers, listeners, subscribers and live viewers retain their provider label, units and definition. The summary never combines platform audiences, converts followers to listeners, or infers unique people.

For each platform, a recent response sample reports median views, likes, comments and reposts independently. Optional `total_likes` and `total_comments` retain their separate promoted-inclusive meaning. Every median includes the number of posts with an observed counter and the number missing it. A reported zero contributes zero; absent, invalid or conflicting counters remain unknown. Base counters and provider-specific promoted-inclusive totals are never added together or substituted for each other.

Samples use only distinct posts/videos published within 90 days of the supplied clock and no later than the provider observation. Snapshots older than seven days, future observations, undated content and malformed dates contribute no current response. Dates must be valid UTC ISO timestamps; post publication may also be an exact calendar date. The output gives all returned items, eligible items, exclusions, and the eligible publication date span. A returned recent-content sample is not the complete activity in a time window.

Repeated snapshots of the same platform account are deduplicated to their newest valid observation. Content is deduplicated by both its source ID and URL. Different platform accounts remain separate, even when display names match. Content URLs and names are data, not trusted markup; consumers must escape text and validate any links they render.

This evidence describes global platform activity. Choosing Philadelphia or any other booking market cannot convert these counters into local listening or ticket demand. A later market assessment must use evidence whose source explicitly supplies audience geography, period, identity and coverage. No population estimate, popularity score, benchmark threshold or attendance forecast is produced here.

Run the deterministic checks with:

```sh
node --test apps/booking/backend/tests/engagement.test.ts
```
