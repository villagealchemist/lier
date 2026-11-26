# LIER product scope

## Product

LIER provides software for artist research, booking decisions, event operations and financial outcomes. Its current implementation is a local booking workspace. Workspace membership, hosted authorization and tenant isolation are not yet implemented.

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

- Keep every deployed dashboard and data endpoint password protected. Hosting changes must preserve authenticated access.
- Start with an explicit single-workspace boundary. A shared password does not establish user roles or multi-tenant isolation.
- Never substitute fabricated statistics for absent source data, or a configuration flag for a verified live connection.
- Store monetary values as integer minor units with their currency. Cross-currency totals require a recorded conversion policy and rate; the current booking calculator is USD-only.
- Keep attendee identities, marketing consent, aggregate audience analytics and anonymous feedback separate.
- Do not purchase provider access, activate financial accounts or execute payouts as a consequence of this scope document.

## Current deployment boundary

The current dashboard is a local Node application. No production deployment, hosted team access or live provider feed has been verified. Credentials, runtime databases and private event records must remain outside application source.

A hosted release requires a compatible runtime, persistent storage, managed secrets, HTTPS, authenticated access and deployment validation. The current loopback-only server must not be exposed directly. See [deployment requirements](../apps/booking/dashboard/DEPLOYMENT.md).
