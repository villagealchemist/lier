# Optional Spotify local audience through Soundcharts

This backend adapter is ready for injected Soundcharts trial or production credentials. It is **not connected to production**, enabled in ingestion, or used by the temporary team dashboard. No subscription is purchased by this code.

`getSpotifyLocalAudience` resolves an exact Spotify artist ID to a Soundcharts artist UUID and requests Spotify audience history. A city is optional. It returns worldwide monthly listeners and the city observations supplied by Soundcharts, preserving each report date separately from the retrieval and provider crawl dates.

## Run from the repository root

Requires Node 26. Set `SOUNDCHARTS_APP_ID` and `SOUNDCHARTS_API_KEY` securely in your environment; do not put their values in source or shell history. Soundcharts provides a production trial through its developer account. This example makes at most two API requests and prints the result only, never credentials:

```sh
node --input-type=module <<'NODE'
import { getSpotifyLocalAudience, SoundchartsError } from './apps/booking/backend/src/soundcharts.ts';

try {
  const result = await getSpotifyLocalAudience(
    '7Eu1txygG6nJttLHbZdQOh',
    {
      SOUNDCHARTS_APP_ID: process.env.SOUNDCHARTS_APP_ID,
      SOUNDCHARTS_API_KEY: process.env.SOUNDCHARTS_API_KEY,
    },
    { city: 'Philadelphia', countryCode: 'US', region: 'Pennsylvania' },
  );
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  if (!(error instanceof SoundchartsError)) throw error;
  console.error(JSON.stringify({ code: error.code, retryAfterSeconds: error.retryAfterSeconds }));
  process.exitCode = 1;
}
NODE
```

Omit the third argument for broad artist research. Match uses the city and country, with an optional exact region name to distinguish same-name cities. Case, surrounding whitespace and Unicode normalization are tolerated; nearby towns, metro areas and countries are never conflated.

## What the result means

- `snapshots[].globalMonthlyListeners` is a Spotify rolling 28-day listener count supplied by Soundcharts. It is not an active-listener segment or a follower count.
- Each `cities[]` record preserves the provider's city, region, country, count and observation timestamp. City data refreshes weekly and covers at most the returned top 50 cities.
- The optional `market` reads the newest returned city report. An absent city is `not_returned` with a null count. An ambiguous same-name match is `ambiguous`; a reported zero remains zero. It never substitutes an older matching report when the newest city report omits that city.
- `providerLastCrawlAt` is not the metric observation date. `fetchedAt` only records when this call began. Returned timestamps are normalized to equivalent UTC instants.
- `historyTruncated` indicates that additional history exists; pagination is not followed. The request asks for one bounded page, at most 31 snapshots within the last 30 calendar days.
- No platform audiences are added together. Listener counts do not predict ticket purchases, turnout or revenue.
- The public sandbox credential pair is marked `dataset: "sandbox"`. It exposes a restricted artist dataset and must never be presented as production coverage.

## Access and failure behavior

The fixed API origin is `https://customer.api.soundcharts.com`, as specified by Soundcharts' official OpenAPI document. Credentials are sent only in `x-app-id` and `x-api-key` headers. Each response has a 10-second timeout and a 1 MB body cap. Redirects, arbitrary provider URLs, retries, and following pagination URLs are disabled. Provider errors never include upstream response text or secrets.

`SoundchartsError.code` distinguishes missing/rejected credentials, access denied (including plan restrictions), artist not found, rate limiting, unavailable/unreachable provider, timeout, invalid or oversized responses, and identity mismatch. A 429 may include `retryAfterSeconds`. Errors do not become zero audience counts.

## Verification

On November 26, 2026, one read-only request using Soundcharts' publicly documented sandbox credentials and documented default artist UUID returned HTTP 200 for Mariah Carey. The response contained a November 23 Spotify city report including Philadelphia, with a separate November 26 crawl timestamp. A subsequent full `getSpotifyLocalAudience` call using the documented Spotify ID `4iHNK0tOyZPYnBU7nGAgpQ` returned `access_denied` (HTTP 403). Therefore the direct streaming endpoint and response schema were verified against the restricted sandbox, but the complete Spotify-ID-to-audience workflow is not verified with live credentials. Production access for arbitrary artists remains unconnected. No signup or purchase was made.

Fixtures cover identity resolution, city/country/region matching, older reports, absent versus zero counts, missing fields, provider failures, credential handling, payload limits, timeout, and sandbox labeling.

```sh
node --test apps/booking/backend/tests/soundcharts.test.ts
```

Official references checked November 26, 2026:

- [OpenAPI schema](https://developers.soundcharts.com/openapi.json): `ArtistResponse`, `SocialAccount`, `StreamingPlotCollectionResponse`, `StreamingPlot`, `CityPlot`, `OffsetPage`.
- [Exact artist platform ID lookup](https://developers.soundcharts.com/api/reference/artist/get-artist-by-platform-id): the current reference page shows v2.9. The official OpenAPI document also publishes `GET /api/v2/artist/by-platform/spotify/{identifier}` with `ArtistResponse`; this adapter deliberately uses that supported v2 route and schema, rather than the v2.9 `ArtistResponse2` shape.
- [Local streaming audience](https://developers.soundcharts.com/api/reference/artist/get-local-streaming-audience): `GET /api/v2/artist/{uuid}/streaming/spotify`.
- [Sandbox and production trial access](https://help.soundcharts.com/en/articles/10091349-how-can-i-get-access-to-soundcharts-api).
- [Current API plans](https://developers.soundcharts.com/pricing). Confirm endpoint entitlement during the trial before selecting a paid plan.
