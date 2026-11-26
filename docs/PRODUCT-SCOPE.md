# LIER product scope

## Product and first collective

LIER is the product. Fold Theory is a collective MJ already works with and the first use case for this module. The Fold Theory branding in the current dashboard represents that workspace, not the platform's product name. A general branding/tenant system is not yet implemented.

The product ambition is moneymaking behind the music: understanding opportunity, choosing a financially workable booking, selling and operating an event, and knowing the actual result. Ticketing belongs inside that loop.

## Decisions the product should support

1. Which artists deserve investigation for this market and room?
2. How do our preferences compare with the available evidence?
3. Under what fee, ticket price and cost assumptions can this booking work?
4. What is selling, through which channel, and how does it compare with the plan?
5. What was collected, refunded, spent, owed and paid?
6. What did we learn for the next booking?

## First connected product milestone

Use a real, reviewed artist identity and authorized source access to collect evidence into a private workspace. Record a booking scenario for a real event with an explicit currency and cost assumptions. When authorized organizer results become available, link the event's outcome to the original scenario and display the difference. Preserve the whole lineup; a show's total attendance is not every performer's individual draw.

This milestone is not complete. Current code has separately testable evidence, roster and scenario features, but no persisted event/booking decision relationship or verified live source connection.

## Delivery sequence

| Step | Acceptance evidence |
| --- | --- |
| Live research slice | A real artist is matched explicitly, retrieved through authorized sources, persisted with field meaning and freshness, and inspected in the password-protected dashboard. |
| Booking and event records | A saved event links market, venue, lineup, booking assumptions, user preferences and evidence references. Comparable measurements are compared without silently merging different scopes. |
| Ticketing slice | Inventory reservations, checkout attempts, issued tickets, cancellations and admission are consistent under retry and concurrency. Payment state is reconciled with the payment provider. |
| Event economics | Gross receipts, taxes where applicable, refunds, processor/platform fees, costs, receivables and liabilities are recorded distinctly. Reports explain their date, currency and accounting scope. |
| Settlement | Versioned agreements determine amounts owed. Adjustments and payment records are auditable; money is never moved solely because an analytics view says it is available. |
| Learning | Actual event outcomes can be compared with frozen booking assumptions without training or evaluating on future information. |

## Working rules

- Keep every deployed dashboard and data endpoint password protected. Existing event protection must survive the domain transition.
- Start with an explicit single-collective boundary. A shared password does not establish user roles or multi-tenant isolation.
- Never substitute fabricated statistics for absent source data, or a configuration flag for a verified live connection.
- Store monetary values as integer minor units with their currency. Cross-currency totals require a recorded conversion policy and rate; the current booking calculator is USD-only.
- Keep attendee identities, marketing consent, aggregate audience analytics and anonymous feedback separate.
- Do not purchase provider access, activate financial accounts or execute payouts as a consequence of this scope document.

## Current deployment boundary

foldtheory.fyi remains the Friendsgiving experience. Its RSVP snapshot and preserved-version references are maintained privately outside this repository. No RSVP records, credentials, production databases, or old fictional UI were imported into LIER.

The current dashboard is a local Node application. The existing domain uses a Sites/Cloudflare deployment. Recovering its source, completing the archive, adapting the runtime/storage, preserving password protection and verifying the domain remain separate unfinished deployment tasks.
