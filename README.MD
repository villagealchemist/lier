# LIER

**Moneymaking behind the music.**

*LIER so you don’t ever have to believe the liar again.*

LIER is artist-first software for the business behind a great night: finding the right artists, making a booking work financially, selling access, running the event, and understanding who earned what.

Ticketing is one part of that system. The larger goal is to connect the research and decisions made before a show with the money and outcomes recorded afterward.

## Who this is for

Artists, promoters, event organizers, and the people building their scenes. LIER connects artist research and booking decisions with the operations and financial results of an event.

Chartmetric is a functional reference for artist intelligence. LIER's research layer aims to provide verifiable evidence alongside personal taste, local market fit, booking assumptions, and actual event results. Chartmetric-equivalent data coverage is not established by this prototype.

## The business loop

| Area | Product responsibility | Current state |
| --- | --- | --- |
| Research | Artist identities, platform evidence, audience markets, trends, discovery and comparison | Five ingestion adapters, evidence imports, identity candidates and storage implemented; no verified live feed. Discovery, market coverage and history remain incomplete. |
| Book | Shortlists, personal fit, fee assumptions, event budgets and booking decisions | Local roster, notes, personal ratings and USD break-even calculator implemented. Offers, contracts and configurable evidence weighting are planned. |
| Sell | Events, ticket inventory, checkout, access lists and admission | Planned; no ticketing implementation exists yet. |
| Operate | Sales pace, capacity, promotion, staffing and event execution | Planned. |
| Settle | Revenue, refunds, fees, costs, revenue splits, artist/vendor amounts owed and payouts | Whole-event outcome reports can be imported. Transaction reconciliation, settlement and payment execution are planned. |
| Learn | Compare initial assumptions with actual turnout and financial results | Evidence and outcome storage implemented; a linked event-to-booking feedback workflow is planned. |

Additional revenue channels such as merch, tips, memberships and recurring events can use the same event and revenue model when their workflows are defined. A forecast, a ticket order, a payment, and money available for payout are distinct records.

## What runs today

`apps/booking` contains the first implemented module: a password-protected local dashboard and its ingestion backend.

- Artist roster, shortlist, personal fit, notes, source IDs and USD fee assumptions.
- Evidence views and authorized JSON imports for artist audience and whole-event outcomes.
- YouTube, Last.fm, Ticketmaster, Spotify and SoundCloud adapters with explicit missing-data semantics, retention, retries and provenance.
- Password login, protected data APIs, expiring sessions, logout and origin checks.
- Deterministic break-even calculations from user-entered costs, ticket revenue and capacity.

Requires Node 26 or newer; no package installation is needed for this module.

```sh
npm test
npm run dashboard
```

Before starting the dashboard, copy `apps/booking/backend/.env.example` to `.env` in that same directory and set `LIER_DASHBOARD_PASSWORD` to a password of at least 12 characters. Source credentials stay in that untracked file. See [the module guide](apps/booking/dashboard/README.md).

The module currently uses Node's SQLite API and a single-user, loopback-only service. Hosted team access and tenant isolation are not implemented. All 105 automated tests pass against controlled fixtures and in-process HTTP handlers. Live provider collection, real-socket browser QA and production deployment remain unverified. No payment processing or money movement is implemented.

## Product direction

The [original LIER vision](docs/ORIGINAL-VISION.md) included custom ticketing and access, anonymous community interaction, performer tools, Stripe Connect/webhooks and modular ML hooks. Those remain possible modules, with ticketing and money visibility joining the artist-intelligence work in one product. Provider choices and ML capabilities are proposals, not delivered integrations.

Keep the original principles: artist-first economics, transparency about costs and payouts, respect for anonymity, and control over private records. User taste must remain identifiable as user taste; measured evidence needs its source and date. Predictions must remain distinguishable from actual outcomes.

See [product scope](docs/PRODUCT-SCOPE.md) and [architecture boundaries](docs/ARCHITECTURE.md) for the planned connection between modules and the current implementation limits.
