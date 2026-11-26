# LIER architecture boundaries

The current implementation is one module at `apps/booking`, containing the existing `backend` and `dashboard` directories. Keeping their layout preserves their tested imports and execution commands. Folder boundaries are not a requirement to deploy separate services.

## Planned module relationships

| Module | Owns | Does not infer |
| --- | --- | --- |
| Research | Artist/provider identities, time-stamped measurements, source rights and retention | Ticket sales or unique people from summed platform audiences |
| Booking | Shortlists, preferences, offer/fee assumptions, decision versions and selected evidence | A confirmed contract or guaranteed demand from a preference score |
| Events and ticketing | Event and venue identities, lineup roles, inventory, orders, tickets and admission | Settled cash from an order or QR scan |
| Revenue and settlement | Provider transactions, refunds, fees, expenses, obligations, agreements and payment records | Spendable balance from gross ticket revenue or an analytics estimate |
| Outcomes | Aggregate attendance and event financial results linked to the original event and plan | Individual artist draw from an entire lineup's result |

Artist, event, performance, venue, organization, party and provider-account IDs need explicit identity mappings. A performance joins an artist's booking agreement to an event; one artist can appear at many events and an event can have many performers. Public stage identity and private legal/payee identity are separate. Events need an explicit timezone as well as a venue identity. The existing provider request IDs and import IDs are provenance keys, not substitutes for an event ID.

## Data contracts to establish before adding modules

- A collective/organization owns private plans and commercial records. Every hosted read and write needs authorization for that organization. The current local store has no tenant IDs or role model and must not be exposed as a shared service.
- A booking decision records its assumptions, currency, selected evidence references and decision time. Later corrections are versioned; the original forecast remains inspectable within permitted retention.
- A ticket order, reservation, payment attempt, payment confirmation, refund and ticket entitlement have separate state. Use stable provider-event IDs and idempotent processing when webhook-driven payments are implemented.
- Financial records record integer minor units and currency. A settlement agreement specifies its calculation basis, costs, splits, effective version and rounding rules. Ledger and reconciliation design must precede automated settlement or payouts.
- Corrections append attributable adjustments. Source-retention deletion and financial-record retention have different purposes and need separate policies. Do not duplicate expired provider observations into permanent booking notes to evade retention.
- Reports on events retain the full lineup and source/account namespace. Cross-source reconciliation must avoid counting the same event or transaction twice.

## Existing implementation

Node 26 runs TypeScript with type stripping. The ingestion backend uses `node:sqlite`; the local dashboard uses Node HTTP and adds roster records to the same store. There are no package dependencies. Source adapters and imports preserve metric meaning, dates, availability, provenance and expiry. The dashboard keeps personal fit separate from those measurements and calculates a USD break-even scenario in the browser.

Password enforcement is local, with HttpOnly SameSite=Strict session cookies, logout, absolute expiry, a bounded login rate and origin checks. It is not an account, membership or hosted authorization system. The listener explicitly refuses non-loopback binding.

The original README proposed Kysely and Stripe Connect. Neither is installed or integrated. Select the production persistence and payment implementation after recovering the hosting source and defining the first event/ticketing workflow. The existing SQLite implementation cannot be deployed unchanged to Cloudflare Workers/D1.

## Validation limits

105 automated tests cover the imported implementation. They use controlled provider responses, SQLite and the actual HTTP handler in process. Real provider calls, real-socket browser use, production hosting and payment execution have not been verified. A separate TypeScript compiler type check has not been run.
