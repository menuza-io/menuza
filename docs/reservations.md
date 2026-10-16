# Reservations module

The Reservations module is a complete restaurant reservations, floor-plan and
table management, waitlist, guestbook CRM, prepaid experiences, and booking
protection system. It is **off for every organization until a feature flag turns
it on**.

This page is the operator guide and runbook. Architectural decisions and the
data-residency split live in
[ADR 048](./decisions/048-reservations-data-residency.md); endpoint schemas and
wire formats live in [the API contract](./reservations-contract.md); the
milestone design lives in [the implementation plan](./reservations-plan.md);
roles and grants live in [permissions](./permissions.md).

## What is in it

| Section     | Route                                 | What operators can do                                                                                               | Flag                       |
| ----------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| Today       | `/<orgSlug>/reservations/today`       | Live host stand: floor canvas, timeline grid, party drawer, seat/unseat/move tables, walk-ins, table blocks         | `reservations.enabled`     |
| Book        | `/<orgSlug>/reservations/book`        | Day sheet across dates, create/edit bookings, approve/decline large-party requests, overbook with reason            | `reservations.enabled`     |
| Waitlist    | `/<orgSlug>/reservations/waitlist`    | Live walk-in and online waitlist queue, quoted wait estimates, notify/summon via SMS, seat directly to a table      | `reservations.waitlist`    |
| Guests      | `/<orgSlug>/reservations/guests`      | Guestbook CRM, tags (VIP, allergy, regular), visit/no-show/spend counters, dietary notes, duplicate merge           | `reservations.enabled`     |
| Experiences | `/<orgSlug>/reservations/experiences` | Ticketed tastings, chef counters, and special events with custom schedules, occurrences, and per-cover/flat pricing | `reservations.experiences` |
| Reports     | `/<orgSlug>/reservations/reports`     | Covers, party count, no-show/cancellation rates, utilization by service/area/channel, CSV exports                   | `reservations.enabled`     |
| Settings    | `/<orgSlug>/reservations/settings`    | Areas, floor plan editor, tables, combos, services, turn times, pacing rules, blackouts, deposit/no-show policies   | `reservations.enabled`     |

## Feature flags

Every Reservations screen and API token mint is gated by organization-level
feature flags read with `getFeatureFlag` (`@repo/common/feature-flags`). A
missing flag defaults to `false`; child flags count only while
`reservations.enabled` is `true`.

| Flag                           | Type      | Gates                                                                                         |
| ------------------------------ | --------- | --------------------------------------------------------------------------------------------- |
| `reservations.enabled`         | `boolean` | Master switch: sidebar group, all `/<orgSlug>/reservations/*` routes, operator token mint     |
| `reservations.online`          | `boolean` | Public `/reserve` widget on Sites, iOS/Android customer booking flows, public hold creation   |
| `reservations.waitlist`        | `boolean` | Operator Waitlist section and public online waitlist join                                     |
| `reservations.payments`        | `boolean` | Deposit, no-show card hold, and prepaid policies (`rsv_policies`) plus refund endpoints       |
| `reservations.experiences`     | `boolean` | Operator Experiences section and public ticketed experiences                                  |
| `reservations.voice`           | `boolean` | AI phone agent reservation availability, hold + SMS link, and direct voice booking            |
| `reservations.platform_fee_bp` | `number`  | Platform application fee in basis points (`0..2000`, default `0`) on deposits and prepayments |

When a flag is off, App routes return **404** and the sidebar hides the gated
links. When a user lacks the required permission, App routes return **403**.

## Kill switches and environment variables

| Variable                      | Service                      | Effect                                                                                                                                           |
| ----------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `RESERVATIONS_PUBLIC_ENABLED` | `apps/tenant-api`            | Public booking kill switch. Setting `false` (`0`, `off`, `no`, `disabled`) returns `503` on every `/reservations/*` public endpoint immediately. |
| `RESERVATIONS_SMS_ENABLED`    | `apps/tenant-api`            | Guest SMS kill switch. Setting `false` drops outbound confirmation/reminder/waitlist SMS without queuing a backlog.                              |
| `RESERVATIONS_EMAIL_ENABLED`  | `apps/tenant-api` & `app`    | Guest email kill switch. Setting `false` drops outbound reservation emails without failing the booking write.                                    |
| `TENANT_OPERATOR_TOKEN`       | `apps/app` & `tenant-api`    | Shared secret signing short-lived `rsv+jwt` operator tokens (`aud: 'tenant-api-reservations'`).                                                  |
| `INTERNAL_COMMAND_TOKEN`      | `apps/app` & `tenant-api`    | Shared secret authenticating `/resources/reservations/context`, `/internal/reservations/*`, and `/api/reservations/tick`.                        |
| `VOICE_AGENT_TOKEN`           | `voice-agent` & `tenant-api` | Shared secret authenticating `/api/voice/actions/reservation-*`.                                                                                 |

## Local demo data (`seed:reservations`)

To seed realistic multi-area floor plans, tables, combinations, services,
turn-time brackets, pacing rules, experiences, guests, reservations, and
waitlist entries for local development:

```bash
# US organization (America/New_York, USD)
npm run seed:reservations -w tenant-api -- acme

# KSA organization (Asia/Riyadh, SAR)
npm run seed:reservations -w tenant-api -- riyadh-grill
```

The seed script is idempotent and refuses to run when `NODE_ENV=production`.
