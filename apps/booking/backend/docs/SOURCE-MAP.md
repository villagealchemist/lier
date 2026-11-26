# LIER source feasibility

Reviewed against official documentation on November 26, 2026.

## The actual objective

Collect data from the platforms and records that underpin music-market analysis, then make it useful for booking decisions. Chartmetric is a coverage benchmark and an optional supplier, not a required dependency. Matching an aggregator's source names is not the same as matching its fields, historical depth, geographic reach, refresh cadence, licensing, identity graph or proprietary estimates.

Chartmetric publishes a broad [platform catalog](https://chartmetric.com/data/platforms) and [coverage overview](https://chartmetric.com/data). These establish what it says it covers. They do not establish how it obtains each field or whether LIER can access that field under the same conditions. Proprietary Chartmetric scores and modeled audiences are not platform-native facts we can reconstruct from a list of API endpoints.

## Priority source map

| Source | Useful direct data | Access route / material limits | Implementation here |
| --- | --- | --- | --- |
| Spotify | Artist identity and catalog; other fields depend on app access | Standard artist response does not document monthly listeners or listening cities. New development-mode rules remove artist followers and popularity. Do not promise an audience-geography connector from this API. Investigate artist-authorized reports or a separately licensed feed. | Artist adapter implemented and fixture-tested; exposes available fields and explicit missing values. No live connection; local-demand gap remains. |
| SoundCloud | User profile, followers, public track count and public playlist count | Registered API app and OAuth token. Current user schema does not provide listening geography or a total-play counter. Hometown is never treated as audience geography. | User adapter implemented and fixture-tested using canonical user URNs; no live connection |
| YouTube | Public channel subscribers, views and video counts | API key for public counters. Subscribers may be hidden or rounded. Private channel analytics and geography need owner authorization. Standard API policies restrict derived metrics and storage; additional analytics permissions are separately described for audited developers. | Adapter implemented and fixture-tested; no live connection; excluded from scoring |
| Instagram | Business Discovery can retrieve basic metrics on other eligible professional accounts, including followers and media counts | Requires appropriate Instagram app-user setup and permissions. Business Discovery is not unrestricted private insights or demographics. Confirm exact target-account coverage and insights grants. | Researched, not implemented |
| TikTok | Authorized user's follower, like and video counters; authorized video metadata | Display API stats require user consent and scopes. The Research API is not a commercial discovery shortcut; its FAQ excludes commercial users. Broad arbitrary-artist coverage needs a separate approved route. | Researched, not implemented |
| Last.fm | Artist listeners and scrobbles | API key and commercial agreement for commercial use. Counters describe Last.fm activity, not total DSP audience. | MBID-based adapter implemented and fixture-tested; disabled pending access |
| Ticketmaster | Attraction identities, event listings, dates, venue and geography | Discovery API key. Provider-specific coverage, quotas and paging limits. Does not establish paid attendance, sell-through or settlement. | Adapter implemented and fixture-tested; no live connection |
| Bandsintown | Artist event listings | Artist API keys are tied to a single artist unless otherwise authorized. Broad-market collection needs expanded permission. | Researched, not implemented |
| Songkick | Event discovery and touring history | Partnership agreement and license fee; current access must be confirmed. | Researched, not implemented |
| Apple Music / iTunes | Catalog, playlist relationships and storefront charts | Developer token for Apple Music API. Catalog/chart access should not be represented as individual artist listening-city analytics. Apple Music Feed has a distinct, restricted purpose; do not assume it is an internal analytics warehouse feed. | Researched, not implemented |
| Wikidata | Cross-platform identity candidates and source revision | Public structured data; candidates still require verification. Handles are distinct from stable provider IDs. Historical qualifier counts are not imported as fresh audience metrics. | Search and entity resolver implemented and fixture-tested; direct runtime probe failed DNS resolution |
| MusicBrainz | Stable artist identifiers and metadata | Public API has rate and identification requirements; commercial use has a separate service route. Useful for identity, not demand. | MBID input supported; automated lookup not implemented |
| Beatport, Resident Advisor, Bandcamp | Potential electronic-music charts, release and event context | No general production-ready acquisition path has been verified in this investigation. Establish official partner/feed/export access and exact fields before committing coverage. | Open research |
| Radio and remaining regional DSPs | Airplay and regional listening/chart signals | Source-specific access investigation needed. No claim of parity with Chartmetric's coverage. | Open research |
| Organizer ticketing and settlement reports | Paid attendance, refunds, net sales, capacity, venue, promotion spend and lineup | Authorized organizer exports or API access. This is the necessary ground truth for validating booking decisions. | Provider-independent JSON importer implemented and tested; actual organizer provider and data not yet supplied |

The five current adapters cover provider-native counters, profiles, and paginated event listings. A separate import path accepts authorized artist audience reports and organizer outcomes with source dates, geographic scope, explicit retention, and correction handling. These interfaces do not establish live data access or sufficient booking coverage by themselves. Source priority should follow the artists and markets being researched.

## Access is not the same as usefulness

For each desired metric, establish all of the following before marking it supported:

1. The endpoint or export actually contains the field for our artists and app access tier.
2. Artist identity is matched explicitly; name-only matching cannot silently join two performers.
3. Meaning is recorded: lifetime/current/rolling period, platform population, geographic level, precision, sample or estimate, and source date.
4. Retrieval, retention, derived analysis and intended display are permitted for the specific access route.
5. Live requests have passed schema, coverage, pagination, failure and freshness checks.
6. Historical access and refresh frequency are separately verified. Polling today cannot recreate several years of history.

The most consequential unresolved metric is **artist audience by booking market**. Global follower counts cannot fill that gap. If local audience is not available directly, the honest choices are authorized artist reports, an appropriate licensed provider, or an explicitly different model using actual local show results. None should be silently substituted for the others.

## Official references

- Chartmetric: [coverage](https://chartmetric.com/data), [platforms](https://chartmetric.com/data/platforms), [artist API](https://apidocs.chartmetric.com/reference/tag/artist).
- Spotify: [artist response](https://developer.spotify.com/documentation/web-api/reference/get-an-artist), [February 2026 migration](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide), [access announcement and March update](https://developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security), [quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes). The announcement distinguishes existing integrations from newly created development-mode apps; verify the actual app entitlement rather than extrapolating a single migration date.
- SoundCloud: [API guide](https://developers.soundcloud.com/docs), [current public OpenAPI schema](https://developers.soundcloud.com/docs/api/explorer/api.json).
- YouTube: [channel counters](https://developers.google.com/youtube/data/reference/rest/v3/channels), [channel endpoint](https://developers.google.com/youtube/data/reference/rest/v3/channels/list), [owner analytics reports](https://developers.google.com/youtube/analytics/channel_reports), [developer policies, especially III.E.4 and III.L](https://developers.google.com/youtube/terms/developer-policies). Current code uses conservative 30-day maximum expiry and no derived score. A future analytics permission must be reviewed and recorded explicitly.
- Instagram: [Business Discovery](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login/business-discovery), [insights reference](https://developers.facebook.com/docs/graph-api/reference/shadow-ig-user/insights/).
- TikTok: [user info and scopes](https://developers.tiktok.com/docs/en/tiktok-api-v2-get-user-info), [Research API eligibility](https://developers.tiktok.com/docs/en/research-api-faq/).
- Last.fm: [artist.getInfo](https://www.last.fm/api/show/artist.getInfo), [API use terms](https://www.last.fm/api/tos).
- Ticketmaster: [Discovery API](https://developer.ticketmaster.com/products-and-docs/apis/discovery-api/v2/).
- Bandsintown: [API access scope](https://help.artists.bandsintown.com/en/articles/7053475-what-is-the-bandsintown-api).
- Songkick: [developer access](https://songkick.com/developer).
- Apple: [Music API](https://developer.apple.com/documentation/applemusicapi), [charts](https://developer.apple.com/documentation/applemusicapi/charts), [Music Feed purpose](https://developer.apple.com/documentation/AppleMusicFeed).
- Wikidata: [data access](https://www.wikidata.org/wiki/Wikidata:Data_access), [MusicBrainz property](https://www.wikidata.org/wiki/Property:P434), [Spotify property](https://www.wikidata.org/wiki/Property:P1902), [YouTube property](https://www.wikidata.org/wiki/Property:P2397), [SoundCloud handle property](https://www.wikidata.org/wiki/Property:P3040).
- MusicBrainz: [API access](https://musicbrainz.org/doc/MusicBrainz_API), [rate limits](https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting).

These references document available interfaces and restrictions, not confirmed credentials or commercial agreements for LIER. No provider applications, purchases, subscriptions or outreach were performed. All five adapter credentials remain absent. A direct execution-runtime request to Wikidata returned ENOTFOUND; documentation browsing succeeded separately. No live adapter is verified. See LIVE-CHECKS.md for the release verification boundary.
