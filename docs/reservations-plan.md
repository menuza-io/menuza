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
   - 41 `rsv_*` tables in `packages/tenant-db` (migration
     `0016_reservations_foundation.sql`) with SQLite triggers preventing
     overlapping active non-overbooked table occupancies
     (`rsv_occupancy_no_overlap_insert` / `rsv_occupancy_no_overlap_update`
     raising `'rsv_table_occupancies overlap'` when
     `o.active = 1 AND o.overbook = 0`), mutating converted holds
     (`rsv_holds_single_conversion` raising `'hold_already_converted'` when
     `OLD.status = 'converted'`), and mutations/deletions on
     `rsv_reservation_events`, `rsv_audit_log`, and `rsv_guest_merges`
     (`rsv_reservation_events_no_delete`, `rsv_reservation_events_no_update`,
     `rsv_audit_log_no_delete`, `rsv_audit_log_no_update`,
     `rsv_guest_merges_no_delete`, `rsv_guest_merges_no_update` raising
     `'append_only'`).
   - Serialized per-organization write helper `withReservationWrite` combining
     in-process `runExclusive(orgId)` locking, `BEGIN IMMEDIATE` transactions,
     `retryOnSqliteBusy`, inline expiration sweeps, idempotency key storage,
     `mapSqliteConstraintError` (mapping `'rsv_table_occupancies overlap'` and
     `'hold_already_converted'` to `409`), and `rsv_day_versions` bumping.
   - **Guest identity without login:** guests can book, join the waitlist, and
     manage/cancel bookings without an account using opaque capability tokens
     (`rsv_m_` for reservation manage tokens, `rsv_w_` for waitlist tokens).
     Only HMAC-SHA256 digests (`manage_token_hash`, `token_hash`, keyed with
     `AUTH_HMAC_SECRET`) are stored in `tenant-db`, and public manage links pass
     the token in the URL fragment (`#t=rsv_m_...`) so it never transits HTTP
     `Referer` headers or Sites SSR; customer phone-OTP / `Bearer` JWT sign-in
     is optional.
   - **Shared org alarm (`apps/tenant-api/src/lib/org-alarm.ts`):** multiplexes
     `staffing` and `reservations` regional ticks across the single per-org
     Cloudflare Durable Object `alarm()` slot and the Node/OCI periodic interval
     loop.
3. **Control plane (`packages/database`, `packages/auth`, `apps/app`):**
   - Control-plane migration `0025_reservations_foundation.sql` seeding the 8
     organization permissions (`read:reservation:any`, `update:reservation:any`,
     `read:reservation_guest:any`, `update:reservation_guest:any`,
     `read:reservation_settings:any`, `update:reservation_settings:any`,
     `read:reservation_report:any`, `update:reservation_payment:any`), 4 role
     presets (`Host`, `Shift manager` extension, `Reservations manager`,
     `Guest relations`), implied read-from-write normalization
     (`update:reservation:any` → `read:reservation:any`,
     `update:reservation_guest:any` → `read:reservation_guest:any`,
     `update:reservation_settings:any` → `read:reservation_settings:any`), and
     `UserOrganization.locationScope` enforcement.
   - 6 boolean feature flags (`reservations.enabled`, `reservations.online`,
     `reservations.waitlist`, `reservations.payments`,
     `reservations.experiences`, `reservations.voice`) plus numeric
     `reservations.platform_fee_bp`.
   - Short-lived `rsv+jwt` operator tokens (`GET /<orgSlug>/reservations/token`,
     `aud: 'tenant-api-reservations-operator'`, claims `orgId`, `region`,
     `scope`, `grants`, `locationIds`, `features`, `impersonated`) and non-PII
     context endpoint (`GET /resources/reservations/context` authenticated with
     `Authorization: Bearer <INTERNAL_COMMAND_TOKEN>`).

## Milestones

| Milestone                           | Scope                                                                                                                                                                   |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. `foundation`                     | `@repo/zoned-time`, `@repo/reservations`, tenant (`0016`) & control-plane (`0025`) migrations, `rsv+jwt` auth & guards, `withReservationWrite`, seed, docs              |
| 2. `setup-and-availability-backend` | Operator setup APIs (locations, areas, floor plan, tables, combos, services, turn times, pacing, overrides, policies, experiences) and public availability/booking APIs |
| 3. `operator-setup-and-host-ui`     | App Setup screens, interactive floor-plan editor, Today host stand (canvas + timeline + seat/walk-in), Book day sheet, Waitlist, Guests CRM                             |
| 4. `payments-experiences-and-sites` | Stripe & Checkout.com payment holds/deposits/prepayments, Admin platform fee, Experiences UI, Sites `/reserve` block & guest manage/waitlist                            |
| 5. `ticks-comms-voice-and-native`   | Regional tick (reminders, auto-no-show, waitlist expiry), SMS/email comms, Reports & CSV export, Voice agent tools, iOS & Android native flows                          |
