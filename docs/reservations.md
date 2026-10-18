# Reservations module

The Reservations module is a restaurant reservations, floor-plan and table
management, waitlist, guestbook CRM, prepaid experiences and booking-protection
system. It is **off for every organization until a feature flag turns it on**.

This page is the operator guide and runbook. Architectural decisions and the
data-residency split live in
[ADR 048](./decisions/048-reservations-data-residency.md); endpoint schemas and
wire formats live in [the API contract](./reservations-contract.md); the design
and build log live in [the implementation plan](./reservations-plan.md); roles
and grants live in [permissions](./permissions.md).

## Features

| Section     | Route                                 | What operators can do                                                                                                | Flag                       |
| ----------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| Overview    | `/<orgSlug>/reservations/overview`    | Location summary, today's covers, pending requests                                                                   | `reservations.enabled`     |
| Today       | `/<orgSlug>/reservations/today`       | Live host stand: floor canvas, party drawer, seat/unseat/move tables, walk-ins, table blocks                         | `reservations.enabled`     |
| Floor       | `/<orgSlug>/reservations/floor`       | Floor canvas on its own                                                                                              | `reservations.enabled`     |
| Timeline    | `/<orgSlug>/reservations/timeline`    | Table-by-time grid for the business date                                                                             | `reservations.enabled`     |
| Book        | `/<orgSlug>/reservations/book`        | Day sheet, create/edit bookings, approve or decline large-party requests, overbook with a reason                     | `reservations.enabled`     |
| Calendar    | `/<orgSlug>/reservations/calendar`    | Month view with availability per day                                                                                 | `reservations.enabled`     |
| Waitlist    | `/<orgSlug>/reservations/waitlist`    | Walk-in and online waitlist queue, quoted waits, notify/summon, seat directly to a table                             | `reservations.waitlist`    |
| Guests      | `/<orgSlug>/reservations/guests`      | Guestbook CRM, tags, visit/no-show/spend counters, dietary notes, merge, export, erase                               | `reservations.enabled`     |
| Experiences | `/<orgSlug>/reservations/experiences` | Ticketed tastings and events with schedules, occurrences, and per-cover or flat pricing                              | `reservations.experiences` |
| Reports     | `/<orgSlug>/reservations/reports`     | Summary, no-shows, cancellations, turn times, waitlist and pacing reports with CSV export                            | `reservations.enabled`     |
| Settings    | `/<orgSlug>/reservations/settings`    | Floor plan, tables, sections, services, special days, pacing, waitlist, policies (deposit, card guarantee), messages | `reservations.enabled`     |

Guest-facing surfaces: the Sites `/reserve` pages (book, `/reserve/manage`,
`/reserve/waitlist`, `/reserve/pay`), the native iOS and Android booking flows
(`apps/ios`, `apps/android`, see the contract) and the AI phone agent actions
(`reservations.availability`, `reservations.hold`, `reservations.book`).

Also in the module: marketing journeys (`reservation_booked`,
`reservation_completed`, `reservation_no_show`, `reservation_cancelled`), the
`visits` demand source for the Staff forecast (see
[Staffing](./staffing.md#demand-sources-and-standards-per-unit)), manager alerts
(large-party request, remote waitlist join, unassigned conflict, payment failed
or in review, dispute opened) and the hourly payment reconcile job.

## Feature flags

Every Reservations screen and operator token mint is gated by organization-level
feature flags read with `getFeatureFlag` (`@repo/common/feature-flags`). A flag
counts only when its value is the literal `true`; child flags count only while
`reservations.enabled` is `true`. Platform staff set them per organization in
Admin (Feature flags).

| Flag                           | Type      | Gates                                                                                                                   |
| ------------------------------ | --------- | ----------------------------------------------------------------------------------------------------------------------- |
| `reservations.enabled`         | `boolean` | Master switch: sidebar group, all `/<orgSlug>/reservations/*` routes, operator token mint                               |
| `reservations.online`          | `boolean` | Public booking on Sites, iOS/Android booking, public hold and booking routes (`GET /resources/sites/reservations` gate) |
| `reservations.waitlist`        | `boolean` | Operator Waitlist section, public online waitlist, notify-me                                                            |
| `reservations.payments`        | `boolean` | Deposit, card guarantee and prepay policies, refunds, fee charges                                                       |
| `reservations.experiences`     | `boolean` | Operator Experiences section and public ticketed experiences                                                            |
| `reservations.voice`           | `boolean` | Phone agent availability, hold with texted link, and direct voice booking                                               |
| `reservations.platform_fee_bp` | `number`  | Platform fee in basis points (`0..10000`) on deposits and prepayments. System default `250` (2.50%, migration `0026`).  |

When a flag is off, App routes answer **404** and the sidebar hides the link.
When a member lacks the permission, App routes answer **403**. The regional node
enforces child flags through the token's `features` claim (operator) and through
the cached `ReservationsContext` (public).

## Permissions and role presets

Eight organization permissions (full table in [permissions](./permissions.md)):
`read:reservation:any`, `update:reservation:any`, `read:reservation_guest:any`,
`update:reservation_guest:any`, `read:reservation_settings:any`,
`update:reservation_settings:any`, `read:reservation_report:any`,
`update:reservation_payment:any`. The built-in `admin` role has all eight; other
roles have none until an owner grants them. Write grants imply their read grant.

Role presets (Settings, Roles; `RESERVATIONS_ROLE_PRESETS` in
`@repo/reservations`):

| Preset                 | Grants                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `host`                 | read and update reservation                                                               |
| `shift_manager`        | read and update reservation, read guest, read report                                      |
| `reservations_manager` | read and update reservation, read and update settings, read and update guest, read report |
| `guest_relations`      | read reservation, read and update guest                                                   |
| `guestbook_manager`    | read reservation, read and update guest                                                   |
| `finance`              | read reservation, read report, update payment                                             |
| `owner`                | all eight                                                                                 |

`UserOrganization.locationScope` limits a member to some locations (the token's
`locationIds` claim). Operator tokens carrying a guest grant or
`update:reservation_payment:any` live 5 minutes; others 15 minutes.

## First-day setup

1. **Flags.** Turn on `reservations.enabled`; add `online`, `waitlist`,
   `payments`, `experiences`, `voice` as the restaurant needs them. Local:
   `.factory/mission/scripts/set-org-flag.sh <org> <key> <value>`.
2. **Locations.** Create or check the organization's locations (Settings,
   Locations). Each bookable location needs an address and a time zone.
3. **Permissions.** Give the host stand and managers the presets above.
4. **Settings** (`/reservations/settings`): location settings (booking interval,
   horizon in days, minimum notice, online party size range, large party mode
   `request` or `contact`, hold minutes, cancellation cutoff, auto no-show
   minutes, `dayStartMin`), then areas, floor plan and tables, optional
   combinations and sections.
5. **Services** (meal periods): days, first and last seating, end, turn times.
   Then pacing rules, special days (closed, online closed, modified, replace)
   and blocks. The validation panel reports overlaps and conflicts.
6. **Policies** (needs `reservations.payments`, a connected provider account):
   deposit, card guarantee or prepay, fees and the cancellation window.
7. **Messages** (Settings, Messages): switch message kinds on or off, reminder
   and reconfirm lead times, quiet hours, SMS on or off, and the guest-visible
   texts.
8. **Publish the website** and turn on `reservations.online`. Sites asks
   `GET /resources/sites/reservations` and answers 404 until the website is
   published and both flags are on.
9. Check Book with a test booking, then Today.

## Kill switches and environment variables

| Variable                             | Service                          | Effect                                                                                                                                                                                |
| ------------------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RESERVATIONS_PUBLIC_ENABLED`        | `apps/tenant-api`                | `false` (also `0`, `off`, `no`, `disabled`) answers `503 { error: 'unavailable' }` on every public `/reservations/*` route, including manage links. Operator routes are not affected. |
| `RESERVATIONS_SMS_ENABLED`           | `apps/tenant-api`                | `false` drops guest SMS (marked `dropped`, not held). Reservation SMS is US node only; the KSA node never sends it.                                                                   |
| `RESERVATIONS_EMAIL_ENABLED`         | `apps/tenant-api` and `app`      | `false` drops guest email on a node and manager alert email in the App. In-app notifications are unaffected. No backlog is sent when it is switched back on.                          |
| `RESERVATIONS_TICK_INTERVAL_SECONDS` | `apps/tenant-api` (Node)         | Seconds between in-process ticks. Default `120`, minimum `60`, `0` leaves only the hourly cron. The Workers runtime uses Durable Object alarms.                                       |
| `TENANT_OPERATOR_TOKEN`              | `apps/app` and `tenant-api`      | Shared secret signing the `rsv+jwt` operator tokens.                                                                                                                                  |
| `INTERNAL_COMMAND_TOKEN`             | App, Admin, `tenant-api`         | Authenticates `/resources/reservations/*` (App), `/internal/reservations/*`, `/api/reservations/*` (including payments and tick).                                                     |
| `VOICE_AGENT_TOKEN`                  | `voice-agent`, App, `tenant-api` | Authenticates `/api/voice/actions/:name`.                                                                                                                                             |
| `SITES_RESERVATION_PAYMENT_TOKEN`    | `apps/sites` and `app` only      | At least 32 characters, distinct from every other token. Authenticates only `/resources/sites/reservation/checkout` and `/status`. Sites never holds `INTERNAL_COMMAND_TOKEN`.        |
| `AUTH_HMAC_SECRET`                   | `apps/tenant-api`                | Derives the manage, waitlist, notify and payment capability tokens and hashes hold tokens. Rotating it invalidates every outstanding link.                                            |
| `STRIPE_CONNECT_WEBHOOK_SECRET`      | `apps/app`                       | Second Stripe secret for Connect events. The Stripe webhook route accepts either secret.                                                                                              |
| `PAYMENTS_MOCK*`, `MOCKS`            | `apps/app`                       | Local Stripe and Checkout.com emulators, see [payments mock](./payments-mock.md). Never in production builds.                                                                         |
| `DEV_EMAIL_CAPTURE_DIR`              | `apps/tenant-api`                | Development only: a folder receiving one JSON file per email the node would otherwise only log.                                                                                       |

## Deploy order

1. **tenant-api first** (US Worker and KSA node): it ships the migrations
   (`0016` to `0021`) and the new routes. Tenant databases migrate on first use
   (Node) or on first request to the Durable Object.
2. **App and Admin second**: control-plane migrations `0025` (permissions and
   flags) and `0026` (platform fee default) run with the App deploy.
3. **Sites and the marketing web** last, then `apps/jobs-cron` if its triggers
   changed.
4. Turn flags on per organization only after all three are live.

Rolling back: switch `RESERVATIONS_PUBLIC_ENABLED=false` on the nodes first (no
deploy needed), then flags off per organization. Migrations are additive and
need no rollback.

## Symptoms

| Symptom                                                    | Likely cause                                                       | What to do                                                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Reservations sidebar group missing, routes 404             | `reservations.enabled` off for the organization                    | Turn the flag on in Admin                                                                         |
| Route answers 403                                          | Member lacks the permission, or `locationScope` has no locations   | Grant a preset                                                                                    |
| Sites `/reserve` shows the CMS 404                         | Website not published, or `online` flag off                        | Publish, check `GET /resources/sites/reservations?slug=<slug>`                                    |
| Every `/reservations/*` call answers 503                   | `RESERVATIONS_PUBLIC_ENABLED=false` on that node                   | Unset it or set `true`                                                                            |
| Guest calls answer 404 `not_found` on a valid booking link | Origin names no organization on that node, or the link has expired | Check the site origin and region; manage links stop answering 7 days after the booking's end time |
| No guest emails or texts                                   | Kill switch, message kind off, SMS on KSA, or no opt-in            | Check the switches, Settings, Messages, and the message row's `lastErrorCode`                     |
| Messages stay pending                                      | App unreachable for flags: the tick reports `flags_unknown`        | Check `APP_URL` and the App health check; held messages retry every 10 minutes                    |
| Operator calls answer 401                                  | Token expired (5 or 15 minutes), wrong secret or region            | Reload the page; check `TENANT_OPERATOR_TOKEN` matches on App and the node                        |
| Operator calls answer 409 `stale_version`                  | Someone else saved first                                           | Reload and redo the edit                                                                          |
| Booking stuck in `pending_payment`                         | Guest abandoned payment, or the webhook did not arrive             | It expires after the payment window; the hourly reconcile job settles lingering sessions          |
| Refund pending                                             | Provider call failed or App unreachable                            | The outbox retries; run the refund from the reservation, or wait for the next reconcile           |
| Region switch refused                                      | Reservation data or unsettled payments exist in the old region     | See Region switch below                                                                           |

## Region switch

Changing an organization's customer data region deletes the old regional
database and provisions an empty one (ADR 045); there is no migration. The App
region guard asks the old node for counts only
(`POST /internal/reservations/summary`) and then:

- **Unsettled reservation payments block the switch** until they are settled or
  refunded.
- When any reservations data exists, or the counts cannot be read (fail closed),
  the administrator must type the organization slug to confirm.
- Deleting a location with future reservations is guarded the same way
  (`/internal/reservations/location-summary`).

## KSA checklist

- The KSA node (OCI Riyadh) holds all guest data for `dataRegion = 'ksa'`
  organizations; the App, Admin and Sites SSR never store it.
- **No reservation SMS**: SMS is US node only. KSA guests are reached by email
  only, so the booking and waitlist forms must collect an email (see Known
  issues).
- The phone agent is US only; `reservations.voice` does nothing for KSA.
- Payments use Checkout.com (SAR); Stripe never settles SAR.
- Webhooks still terminate at the US App, which forwards only ids and amounts to
  the KSA node (ADR 048, section 8).
- `TENANT_API_URL_KSA` is set in App and Sites; `APP_URL` and
  `INTERNAL_COMMAND_TOKEN` are set on the KSA node so it can read flags and post
  manager alerts.
- Arabic (`ar`) message texts and right-to-left layouts are required in the App
  and Sites; check them with `?lng=ar`.

## Local development

- Open the App at `https://app.menuza.test:2999` through the dev proxy (root
  `npm run dev`). The repository `AGENTS.md` still mentions the older
  `epic-startup.test` host in places; use `menuza.test`.
- Payments run against in-process Stripe and Checkout.com mocks with hosted
  pages (see [payments mock](./payments-mock.md)); no real key is needed.
- Guest email lands in `apps/tenant-api/.dev-mail/{us,ksa}` and the App's
  `/mock-email/dev/messages` capture; SMS is logged as `[SMS MOCK]` lines.
- Start the App before testing ticks, otherwise the tick reports
  `flags_unknown`.
- Operator Playwright specs stub tenant-api the way the staffing specs do.

## Local demo data (`seed:reservations`)

To seed a demo venue with areas, tables, combinations, services, turn times,
pacing rules, an experience, guests, reservations and waitlist entries:

```bash
# US organization (America/New_York, USD)
npm run seed:reservations -w tenant-api -- acme

# KSA organization (Asia/Riyadh, SAR)
npm run seed:reservations -w tenant-api -- riyadh-grill
```

The script turns on every `reservations.*` flag for the organization, is
idempotent, and refuses to run when `NODE_ENV=production`.

## Contract fixtures

`npm run fixtures:reservations -w tenant-api` re-records the public API fixtures
in `packages/reservations/contract-fixtures` and the iOS and Android copies from
the in-process routes with seeded demo data. See the
[contract](./reservations-contract.md#9-native-clients-and-contract-fixtures).

## CI security checks

- `apps/tenant-api/src/routes/reservations-security.test.ts` sweeps every
  mounted operator and public route: missing, forged and wrong-audience tokens
  (401), wrong `typ`, over-long lifetime (401), grantless and wrong-scope (403),
  impersonated writes (403), cross-organization (403 or 404), excluded
  `locationIds`, and uniform `404` when `hasProvisionedDb` is false.
- `apps/app/app/utils/reservations/reservations-guards.test.ts`: every App
  reservations loader and action awaits `requireReservationsAccess` first.
- `apps/tenant-api/src/routes/reservations-contract.test.ts` and
  `packages/reservations/src/reservations-contract.test.ts`: fixtures parse with
  the public schemas, match the live routes key for key, and the native copies
  are byte-identical.
- Property tests for the engine (`packages/reservations/src/engine/`), and the
  concurrency tests for holds, bookings and experiences.

## Known issues and known gaps

Open items from the principal-engineer review. Each was re-checked against the
code when this page was written.

**Availability engine**

- The candidate cache key (`serviceId::channel`) ignores the slot, but service
  table modes can be time-windowed (`fromMin`/`toMin`), so a mode change inside
  a service is applied from the first slot computed.
- A special day of type `modified` or `replace` drops `maxParty` and the online
  window (`onlineFromMin`, `onlineToMin`, `onlinePartyMax`) of the services it
  customizes (`normalizeCustomService`).
- Area pacing in the availability search is checked after table assignment, so a
  slot is rejected when the assigned area is paced out instead of trying a table
  in another area (booking itself filters per area).
- The booking horizon release time compares the wall-clock minute with
  `releaseLocalMin` while the business date flips at `dayStartMin`, so a release
  time before the day start misbehaves.
- Service windows are not validated against `dayStartMin` in setup.
- Two state machines exist: `state-machine.ts` in `@repo/reservations` is not
  used by tenant-api, which has its own `VALID_STATUS_TRANSITIONS`.

**Messages and automation**

- Turning `smsEnabled` off does not cancel SMS rows already scheduled: only rows
  of switched-off kinds or older schedule versions are cancelled.
- Waitlist messages are held (retried every 10 minutes) for as long as
  `reservations.waitlist` is off and are never purged while pending.
- A queued `notify_available` is not re-checked against the request's status at
  send time, and a request has no lifetime cap on notifications (only a two-hour
  repeat suppression and a batch of three).
- Operator cancels always send the `cancellation_restaurant` message ("cancelled
  by the restaurant") even when the operator cancelled on the guest's behalf.
- Auto no-show selects candidates from a snapshot and transitions each without
  an `expectedVersion`, so a guest tapping "running late" between the two is not
  honored.

**Guests and reports**

- The guestbook is organization-wide: `locationIds` scoping is not applied to
  guests (needs a product decision).
- Report CSV export keeps the oldest 20,000 rows when it truncates, and the
  no-show rate denominator counts every booking that is not cancelled, declined
  or expired, including upcoming ones.
- The append-only triggers on `rsv_reservation_events` and `rsv_audit_log` allow
  an update that sets the redaction payload while leaving actor and time columns
  unpinned, so a redaction could also rewrite them.
- Setup writes other than message settings do not reconcile scheduled reminders
  (message settings do; they are the only setting reminders read).
- Operator setup and settings tokens live 15 minutes; only guest and payment
  grants are in the 5-minute sensitive set. Whether settings writes should be
  sensitive is undecided.

**Sites**

- A KSA guest cannot get SMS, yet the waitlist form only requires a phone; the
  email is optional, so a KSA party may never be notified.
- A late-night slot (`localMin` of 1440 or more) is shown by clock time on Sites
  with no next-day label.

**Platform and tooling**

- The tick fan-out visits organizations in directory order with a 50-second
  budget, so the same tail organizations are the ones deferred under load.
- `busy_timeout` is set once on the first libsql connection of a tenant file;
  the extra connections `client.transaction()` opens do not get it. A
  per-connection timeout was tried and reverted (it blocks the event loop, see
  ADR 048 section 5).
- `mock-email` routes are guarded by `MOCKS=true` and by route stripping in
  `build:cf` only; unlike the payment mock routes they do not check for a local
  request.
- Tests that use `dateAhead(0..2)` or "today" fail between 00:00 and 04:00 UTC
  (default `dayStartMin` is 240).
- `packages/database/db/data.db` on a developer machine can carry a stale
  Drizzle journal after switching branches; re-run `npm run db:migrate:deploy`
  (do not reset a database that holds data you need).
- The root `package.json` override `esbuild ^0.28.1` does not match Admin's Vite
  6.4.3; Admin dev breaks without a local workaround.
