# foldtheory.fyi transition

## Authorized outcome

Archive the Friendsgiving experience and use foldtheory.fyi for the Fold Theory booking dashboard. The dashboard and its data must remain password protected. The user authorized the site replacement and publication; a second publishing approval is not required.

## Verified existing site

- Sites project: `appgprj_6afa8f5569a881919fc82229746cdcc6`.
- Custom domain: `foldtheory.fyi`, active with active TLS.
- Existing access: public Site with an application-level event-password gate, observed in the browser.
- Last successful deployment returned in version history: version 9, commit `8638c463562aad387e5ee21e0bfb96db4a6882f3`.
- Newer saved source: version 12, commit `084c0448d3cdba5afc01696d572fc1b0fc43ab14`. Versions 10–12 did not return deployment IDs.
- Live database: binding `DB`, table `rsvps`. A complete snapshot was saved privately outside application source. Do not expose it through dashboard APIs or a public archive route.

## Current blockers

The official Sites source workflow could not resolve `git.chatgpt-team.site` from this execution environment. No local source checkout was found. The hosted source/build versions are retained, but a complete offline source/assets archive has not been obtained. Opening a local server was also denied with `listen EPERM`, preventing browser QA. No source push, publication, access-policy change, password change, or DNS change has been performed.

The runnable dashboard in this folder uses the existing Node 26 backend and SQLite. That local service is not a Cloudflare Worker and must not be packaged as if it were one. The existing hosted site's source must be opened before adapting its deployment and password gate. An earlier unrelated unpublished Sites project exists but is not the foldtheory.fyi project; its hosting manifest is intentionally excluded from LIER. Use the exact existing domain project ID above when recovering the deployed source.

## Completion sequence

1. Restore authorized execution-runtime connectivity and open the existing Site with its source helper into the prepared empty checkout.
2. Preserve source/assets for both the published rollback target and latest saved version. Keep the original password gate, database binding, and RSVP data intact during the transition.
3. Inspect the recovered hosting format and append any new database migrations without altering historical migrations or the RSVP table. Adapt the dashboard API to the supported Cloudflare runtime or establish an authenticated backend on a persistent Node host. Do not expose the loopback-only development service.
4. Retain password protection for every dashboard page and API. Verify direct unauthenticated requests, session expiry, logout and cross-origin mutations. Preserve the existing password unless the user requests a change. Keep credentials and RSVP records out of client code and source archives intended for publication.
5. Build and test from the recovered repository; save its exact pushed commit and deploy through the existing Site. Verify deployment success and custom-domain behavior. Preserve rollback identifiers and any separate archive route without enabling old event submissions.

This document records incomplete work. A local passing test or runnable preview does not establish a domain deployment.
