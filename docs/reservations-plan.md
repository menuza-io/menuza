# Reservations Implementation Plan

This document holds the design summary and the build log of the Reservations
module across `@repo/zoned-time`, `@repo/reservations`, `@repo/tenant-db`,
`@repo/database`, `@repo/auth`, `@repo/payments`, `apps/tenant-api`, `apps/app`,
`apps/admin`, `apps/sites`, `apps/voice-agent`, `apps/jobs-cron`, and the native
customer apps (`apps/ios` and `apps/android`, since replaced by the Expo
`apps/customer`).

See [ADR 048](./decisions/048-reservations-data-residency.md) for data
residency, [the API contract](./reservations-contract.md) for wire schemas and
the [operator guide](./reservations.md) for runbooks and known issues.

## Design summary

1. **Pure domain packages (`@repo/zoned-time`, `@repo/reservations`).**
   - Wall-clock math, business-date resolution (`dayStartMin`) and DST handling
     live in `@repo/zoned-time`; reservations never hand-roll time-zone math.
   - Availability search, deterministic table and combination assignment, the
     reservation state machine, cancellation and deposit policy math, guest tag
     rules, message math, formula-safe CSV export, response and request Zod
     schemas, role presets and error codes live in `@repo/reservations`. It does
     no I/O and has no UI strings.
2. **Regional data plane (`packages/tenant-db`, `apps/tenant-api`).**
   - 41 `rsv_*` tables (migration `0019_reservations`) with SQLite triggers for
     overlapping occupancies, converted holds and append-only history (ADR 048
     lists them).
   - A serialized per-organization write gate, `withReservationWrite`
     (`apps/tenant-api/src/lib/reservations-write.ts`): in-process mutex,
     `retryOnSqliteBusy`, a real transaction through `runTenantTransaction`
     (libsql `db.transaction`, or the Durable Object async storage transaction),
     inline expiry sweeps, idempotency records, day-version bumps and
     scheduled-message reconcile before commit.
   - **Guest identity without login:** opaque capability tokens derived by HMAC
     (manage, waitlist, notify, payment) and hashed random hold tokens; the
     customer phone-OTP session is optional and substitutes for Turnstile.
   - **Shared org alarm** (`apps/tenant-api/src/lib/org-alarm.ts`): staffing and
     reservations ticks share the single Durable Object alarm slot and the Node
     interval loop.
   - Messages (email everywhere, SMS on the US node), an outbox to the App for
     manager alerts and payment commands, journeys and the `visits` demand
     source.
3. **Control plane (`packages/database`, `packages/auth`, `apps/app`,
   `apps/admin`).**
   - Migration `0025_reservations.sql` seeds the 8 organization permissions
     (granted to the `admin` role), system-level `false` flags, and the platform
     fee default of 250 basis points.
   - Operator `rsv+jwt` tokens minted by `GET /<orgSlug>/reservations/token`,
     and the non-PII context endpoint `GET /resources/reservations/context`.
   - Payment orchestration: the App talks to Stripe and Checkout.com, verifies
     webhooks, and forwards ids and amounts to the region.
4. **Guest surfaces.** Sites `/reserve` pages (browser-direct), native iOS and
   Android flows, and the phone agent actions.

## Milestones and build log

| Milestone                             | Scope                                                                                                                                                      | Main commits                                                  |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 1. `foundation`                       | `@repo/zoned-time`, `@repo/reservations`, the tenant `0019` and control-plane `0025` migrations, `rsv+jwt` auth, guards, write gate, App shell, seed, docs | `b10ef622`, `bc4326f7`, `452bb463`                            |
| 2. `foh-core`                         | Setup backend and App Setup screens, floor-plan editor, Book, Today host stand, Timeline, Calendar, Overview, region and location guards                   | `bf30dd0c`, `d6dd3084`, `3c4bfa6b`, `403e6c0c` and fix rounds |
| 3. `guest-channels-and-crm`           | Public booking API, Sites pages and builder block, messages and tick, waitlist and notify-me, guestbook CRM, reports                                       | `c336ca21`, `05659c95`, `97bb99a4`, `e5c6e296`, `661d65a5`    |
| 4. `payments-integrations-and-native` | Payment mocks, payments and platform fee, experiences, Sites pay, voice actions, demand source, journeys, native apps, docs                                | `72032cc7`, `8b544867`, `8cac7e43`, this change               |

Hardening: `6c8ec334` made the write gate roll back on the Durable Object
runtime, chunked `IN` lists below the 100-parameter limit, windowed occupancy
scans (index in migration `0019`), fixed undo, stopped public bookings from
patching guest profiles and moved idempotency retries to per-attempt keys.

### Migrations

| Migration                         | Plane    | Change                                                                                                                                                                                                                                                                                          |
| --------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tenant `0019_reservations`        | regional | 41 `rsv_*` tables, indexes, triggers; `rsv_payments` contract columns; `voice_call_actions` table; `labor_scope_settings.demand_per_labor_hour`. One migration for the whole module: it began as six (`0016` to `0021`) and was folded into one, after upstream's `0016` to `0018`, when merged |
| control plane `0025_reservations` | US       | 8 permissions, `admin` grants, system flags, `reservations.platform_fee_bp` system default `250`                                                                                                                                                                                                |

### Milestone 4 detail

- **Payments:** in-process Stripe and Checkout.com emulators
  ([payments mock](./payments-mock.md)); App payment bridge and webhooks; Sites
  checkout and status routes behind `SITES_RESERVATION_PAYMENT_TOKEN`; hourly
  reconcile job on the existing `0 * * * *` trigger; Admin platform fee control.
- **Experiences:** setup and public backend with a seating engine, App
  Experiences UI, Sites experience pages.
- **Integrations:** voice actions (`reservations.availability`, `.hold`,
  `.book`), the `visits` demand source and `demand_per_labor_hour` for the Staff
  forecast, marketing journey triggers.
- **Native apps:** `X-Client: ios | android` sets `channel = 'native'`; the
  customer Bearer token replaces Turnstile; recorded contract fixtures in
  `packages/reservations/contract-fixtures` and a contract test. The separate
  SwiftUI (`apps/ios`) and Android (`apps/android`) apps, and their copies of
  the fixtures, were removed: the Expo customer app (`apps/customer`, iOS and
  Android) books tables and reads the fixtures in place.
- **Docs:** this set (operator guide, contract, plan, ADR 048, AGENTS.md,
  permissions, scheduled jobs, residency, phone-agent verticals, staffing,
  tenant-api README).

## Decisions made after the first plan

- Public routes resolve the organization from `Origin` only (not from a customer
  token).
- Capability tokens are derived, not stored.
- Webhooks terminate at the US App and forward ids and amounts (ADR 048, section
  8).
- The write gate uses `runTenantTransaction`; `IN` lists are chunked at 90.
- `busy_timeout` is set once per tenant file; a per-connection timeout was
  reverted because the synchronous libsql driver would block the event loop.
- Platform fee: `0..10000` basis points, default 250.
- `policy_required` is HTTP 400.
