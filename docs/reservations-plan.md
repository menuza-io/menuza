# Reservations Implementation Plan

This document tracks the architecture and milestone plan for the Reservations
module across `@repo/zoned-time`, `@repo/reservations`, `@repo/tenant-db`,
`@repo/database`, `@repo/auth`, `apps/tenant-api`, `apps/app`, `apps/admin`,
`apps/sites`, `apps/voice-agent`, `apps/ios`, and `apps/android`.

See [ADR 048](./decisions/048-reservations-data-residency.md) for data residency
and [the API contract](./reservations-contract.md) for wire schemas.

## Architecture summary

1. **Pure domain packages (`@repo/zoned-time`, `@repo/reservations`):**
   - Wall-clock math, business-date resolution (`dayStartMin`), and DST handling
     live in `@repo/zoned-time`.
   - Availability search, deterministic table/combo assignment
     (`scoreCandidate`, `assignTables`), reservation state machine
     (`canTransitionReservation`), cancellation/deposit policy math
     (`evaluatePolicy`), guest tag rules, formula-safe CSV export, and Zod wire
     schemas live in `@repo/reservations`.
2. **Regional data plane (`packages/tenant-db`, `apps/tenant-api`):**
   - 24 `rsv_*` tables in `packages/tenant-db` with SQLite triggers preventing
     overlapping active table occupancies (`table_overlap`), overlapping active
     holds (`hold_overlap`), and mutations/deletions on `rsv_reservation_events`
     (`append_only`).
   - Serialized per-organization write helper `withReservationWrite` combining
     in-process `runExclusive(orgId)` locking, `BEGIN IMMEDIATE` transactions,
     `retryOnSqliteBusy`, inline expiration sweeps, idempotency key storage, and
     `rsv_day_versions` bumping.
3. **Control plane (`packages/database`, `packages/auth`, `apps/app`):**
   - 8 organization permissions, 4 role presets (`Host`, `Shift manager`
     extension, `Reservations manager`, `Guest relations`), implied
     read-from-write normalization, and `UserOrganization.locationScope`
     enforcement.
   - Short-lived `rsv+jwt` operator tokens (`GET /<orgSlug>/reservations/token`)
     and non-PII context endpoint (`GET /resources/reservations/context`).

## Milestones

| Milestone                           | Scope                                                                                                                                                                   |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. `foundation`                     | `@repo/zoned-time`, `@repo/reservations`, tenant & control-plane migrations, `rsv+jwt` auth & guards, `withReservationWrite`, seed, docs                                |
| 2. `setup-and-availability-backend` | Operator setup APIs (locations, areas, floor plan, tables, combos, services, turn times, pacing, overrides, policies, experiences) and public availability/booking APIs |
| 3. `operator-setup-and-host-ui`     | App Setup screens, interactive floor-plan editor, Today host stand (canvas + timeline + seat/walk-in), Book day sheet, Waitlist, Guests CRM                             |
| 4. `payments-experiences-and-sites` | Stripe & Checkout.com payment holds/deposits/prepayments, Admin platform fee, Experiences UI, Sites `/reserve` block & guest manage/waitlist                            |
| 5. `ticks-comms-voice-and-native`   | Regional tick (reminders, auto-no-show, waitlist expiry), SMS/email comms, Reports & CSV export, Voice agent tools, iOS & Android native flows                          |
