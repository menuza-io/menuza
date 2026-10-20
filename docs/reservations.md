# Reservations module

The Reservations module is a restaurant reservations, floor-plan and table
management, waitlist, guest profiles (shown in Customers), prepaid experiences
and booking-protection system. It is **off for every organization until a
feature flag turns it on**.

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
| Experiences | `/<orgSlug>/reservations/experiences` | Ticketed tastings and events with schedules, occurrences, and per-cover or flat pricing                              | `reservations.experiences` |
| Settings    | `/<orgSlug>/reservations/settings`    | Floor plan, tables, sections, services, special days, pacing, waitlist, policies (deposit, card guarantee), messages | `reservations.enabled`     |

Guests and reports are not screens of this module. **Guests are now part of
Customers** (see [People](#people-customers-is-the-one-people-screen) below) and
reports are the **Reservations** group on the main Reports page (see Reservation
reports). `/reservations/guests` and `/reservations/guests/<id>` redirect to
`/<orgSlug>/customers` and `/<orgSlug>/customers/g_<id>`;
`/reservations/reports` redirects to
`/<orgSlug>/reports?category=Reservations&location=<active>`. The sidebar group
and the page tab bar are Today, Calendar, Waitlist, Experiences and Settings
(each gated by its flag and permission).

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

## People: Customers is the one people screen

There is one people screen, **Customers** (`/<orgSlug>/customers`, profile at
`/<orgSlug>/customers/<key>`). Reservation guests are a facet of it, not a
second list: the Reservations Guests screen is gone. Two tables remain
underneath in the same regional database (`customers`: sign-in, orders, consent;
`rsv_guests`: dining history) and the screen joins them through
`GET /operator/people`.

- **One row per person.** `c_<customerId>` is a customer, with the guest linked
  to it (strict verified-phone link, `rsv_guests.customer_id`) as its dining
  facet. `g_<guestId>` is a guest with no linked customer, labelled **Guest, no
  sign-in** (a customer who never verified is **Not verified**). The unverified
  customer row a booking-form consent creates is a consent shadow of its guest:
  hidden, and its key resolves to the guest. A guest key resolves to its
  customer, a merged guest to the survivor.
- **Walk-ins** (a guest with no phone and no email) are hidden by default; the
  filter **Show walk-ins without contact details** reveals them.
- **List:** server paging (keyset cursor, 50 a page), server search by name,
  phone or email, server filters (VIP, Has allergy, Lapsed 90 days, Upcoming
  booking, Signed in, Guest only, Show walk-ins) and sorts (recent activity,
  name, visits, last visit). Columns: Name with status, Contact, Visits, Last
  visit, Next booking, Orders (when the organization has orders) and Flags (VIP,
  Allergy, No-show risk). Visits and orders are never summed. **New
  reservation** is a header action only when reservations are on and the member
  can book.
- **Profile** (sections, not tabs): Contact (edit), Dining (counters, tags,
  allergy, pinned notes), Notes, Orders (all of the customer's orders, 20 a
  page; see below), Reservation history, Marketing messages
  (`customer_subscriptions`, the one consent source), Duplicates and data (merge
  a duplicate, export, **erase**).
- **Orders on the profile.** The Orders section lists every restaurant order of
  the customer, newest first, with number, date, status, fulfillment, item count
  and total, plus the order count and lifetime spend (cancelled, expired and
  payment-review orders are not spend). Each number opens
  `/<orgSlug>/orders/<id>`. Rule: an order is the customer's when its
  `customer_id` is theirs, or, for a customer with a VERIFIED phone, when it has
  no `customer_id` and the same contact phone. Never by name or email. Needs the
  customers claim (`GET /operator/people/:key/orders`).
- **Customer on an order.** The Orders page links an order to its person
  (`customerKey`, `c_<id>` or `g_<id>`): by `customer_id`, else by verified
  phone to a customer, else to a guest with no customer and the same phone. A
  guest checkout with no match shows **Guest checkout**. The key is returned
  only when the Orders token carries `linkCustomers` / `linkGuests`, signed by
  App from the same access as the Customers screen.
- **Who sees what** (claims of one browser-direct `people` token, see the
  [contract](./reservations-contract.md#4-people-api-operatorpeople)): contact,
  orders and consent need `read:settings:any`; the dining facet needs
  reservations on and `read:reservation_guest:any`. Allergy flag and text,
  sensitive tags, pinned and full notes and free-text booking requests need that
  guest grant; hosts (`read:reservation` only) get no free text. A
  guest-grant-only member sees only people with a guest record and no orders.
  Editing needs `update:settings:any` (contact) and
  `update:reservation_guest:any` (dining); tokens that carry the guest grant
  live 5 minutes.
- **One erase flow.** The profile's **Erase customer** asks for the person's
  name and erases reservations contact data, order contact data, marketing
  choices, sign-in and call/message records through `erasePerson`; it needs a
  token minted with `canDelete` (`update:settings:any`, plus
  `update:reservation_guest:any` when reservations are on).
- **Merge** moves bookings, tags and notes of a duplicate into the profile on
  screen. Orders and sign-in never move. Two people signed in as different
  customers cannot be merged (`409 merge_conflicting_customers`, shown as a
  plain explanation).
- The booking sheet's returning-guest search and the detail sheet keep using
  `/operator/reservations/guests/*`; the detail sheet's **Open customer
  profile** opens `/<orgSlug>/customers/g_<guestId>`.

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
   `payments`, `experiences`, `voice` as the restaurant needs them.
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
   and blocks. The validation panel reports overlaps and conflicts, and checks
   services against the location's opening hours (see "Hours model").
6. **Policies** (needs `reservations.payments`, a connected provider account):
   deposit, card guarantee or prepay, fees and the cancellation window.
7. **Messages** (Settings, Messages): switch message kinds on or off, reminder
   and reconfirm lead times, quiet hours, SMS on or off, and the guest-visible
   texts.
8. **Publish the website** and turn on `reservations.online`. Sites asks
   `GET /resources/sites/reservations` and answers 404 until the website is
   published and both flags are on.
9. Check Book with a test booking, then Today.

## Languages

Reservations has no language list of its own. The languages are the ones in
**Website settings, Languages** (`siteLocales` plus the default language
`siteDefaultLocale`, limited to the six site content languages `en`, `ar`, `es`,
`fr`, `de`, `zh`), the same list the Menu and Drops editors use. Decision
record: ADR 048, section 13.

- **Who writes what.** Owners type guest-facing text themselves, per language:
  service names, dining area names, the booking page note and the large-party
  message (Settings, General), the special-day public note, experience name and
  description, payment policy terms and the custom note of each guest message.
  Each editor has the shared language switcher in its header; it hides itself
  for a one-language organization, and the editor starts on the organization's
  **default** language (never the operator's interface language). The default
  language is required for names; every other language is optional and falls
  back to it. The existing optional Translate button comes with the field.
- **Staff-only text stays single-language:** table labels, section names, policy
  names, special-day names, blocks, service notes, guest notes and slugs.
- **Storage.** Every guest-facing text is a `*_i18n` JSON map (language to text)
  next to its canonical column (`name`), which holds the default-language text.
  Message notes are one `rsv_message_texts` row per kind and language. A
  language removed from Website settings is neither accepted on save nor served;
  its stored text is left alone and is simply not shown.
- **What guests see.** Operator text resolves requested language, then the
  organization default, then the canonical name; it never borrows another
  language. `locale` and `Accept-Language` are checked against the enabled
  languages; anything else is the organization default.
- **Guest messages.** The language of an SMS or email is the guest's own booking
  language when the organization enables it, else the organization default. The
  shipped subject, body and SMS templates exist for all six languages
  (`apps/tenant-api/src/lib/reservations-copy/`, a
  `Record<SiteContentLocale, ...>` so a new site language fails the typecheck
  until its copy exists, and a test checks every kind and placeholder). The
  templates are first drafts written without a native speaker: **have a native
  speaker review the es, fr, de, zh and ar copy before relying on it.** The
  owner's custom note is the note for the guest's language, else for the default
  language, and is never translated at send time.
- **Sites.** The page language comes from the Sites locale resolution (path
  prefix, `<html lang>`); the page chrome is Lingui (all six catalogs) and the
  booking client sends that language as `locale`.

## Hours model: location hours are the single source of truth

The location (Settings, Locations) owns "when are we open": weekly `storeHours`,
dated `specialHours`, `isActive` and the time zone. Reservations reads them from
the non-PII control-plane context (`GET /resources/reservations/context`) and
there is no flag: enforcement is on for everyone.

- Services and seatings only operate **inside** the open hours. A slot is
  offered only when its start instant is open in the **location's** zone (the
  reservation zone and `dayStartMin` only label business dates: a 01:00 slot
  belongs to the previous business date but is checked by its real clock time).
- A closed location (special hours closed, `isActive` false, a closed weekday)
  has **no** availability for guests, the online widget, the phone agent or
  holds, and a stale hold cannot be confirmed. Hosts see a closed-day state with
  the source ("Closed: Christmas (from location hours)") and can still book with
  the explicit `overbook` override (same as a reservations `closed` day). Slots
  outside open hours on an otherwise open day carry the warning
  `outside_location_hours` for staff.
- Reservation special days only add reservation behavior **on top**: `closed`
  (reservations-only closure while the location stays open), `online_closed`
  (stop online, staff and phone can still book) and `modified` / `replace`
  (service windows and limits, only inside open hours). A special day can never
  open reservations on a closed location; for a special opening edit the
  location's special hours.
- Overnight hours are modelled as the location does it (split at midnight, for
  example Fri 18:00-23:59 and Sat 00:00-02:00; an end before the start is read
  as overnight). `onlineHours` is ordering-only and ignored here. The end of a
  range is inclusive at minute granularity. Several ranges per day are fine.
- Fail open: no context, no weekly hours, or a malformed value for one location
  never closes anything (the context schema parses it to `null` and logs a
  count). A context older than 24 hours is dropped by the cache, so it also
  fails open.
- Existing bookings are never auto-cancelled when a day closes: they appear in
  the conflicts feed (`outside_service_hours`) and the host stand.
- The setup validation panel warns about `service_on_closed_weekday`,
  `service_outside_location_hours`, `location_inactive` and `location_no_hours`
  ("Add opening hours in Location settings"), and notes (info only, in `infos`)
  a reservations `closed` special day on dates the location is already closed
  (`special_day_redundant_closed`).

Code: `packages/reservations/src/rules/location-hours.ts` (`isLocationOpenAt`,
`locationOpenIntervals`, `buildEffectiveDay`), the engine in
`packages/reservations/src/engine/availability.ts` (`config.locationHours`),
`apps/tenant-api/src/services/rsv-location-hours.ts` and `rsv-special-days.ts`
(`loadStaffDayState`). Decision record: ADR 048.

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
- Arabic (`ar`) must be enabled in Website settings for the organization to
  write and send Arabic copy (see [Languages](#languages)); right-to-left
  layouts are required in the App and Sites; check them with `?lng=ar`.

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

**Reservation reports**

Reservation reports are not a screen of their own. They are the **Reservations**
template category of the generic Reports page (`/<orgSlug>/reports`), built on
three regional subjects: `bookings`, `waitlist_entries` and `pacing_slots`. The
Reservations has no Reports tab or sidebar item: the **Reservations** group sits
on the main Reports page with the other groups, for people who have
`reservations.enabled` and `read:reservation_report:any`. The old
`/reservations/reports` route only redirects to
`/<orgSlug>/reports?category=Reservations&location=<active location>` (keeping
`lng`), and the location becomes a `location` filter on the template you open.

- Data path: the browser fetches `/<orgSlug>/reports/token` and posts the report
  straight to tenant-api `POST /analytics/query`. Nothing passes through the App
  and no field carries a name, phone, email, note or allergy text (a test locks
  the field list). Every run writes one `report.run` audit row naming the
  subject and row count.
- Access: `read:reservation_report:any` plus the `reservations.enabled` flag,
  limited to the person's locations. A role holding only this grant (host, shift
  manager, finance) can mint a report token; without an analytics, settings or
  website grant it receives only the reservation (and staff) subjects. The
  templates, the dashboard Add block picker and saved reports are filtered by
  the same grants.
- **Covers** are the guests who actually came when recorded, otherwise the
  booked party size (`coversActual ?? partySize`), in every report. A finished
  party does not use the seated count.
- Booked parties are bookings that are not cancelled, declined or expired. The
  no-show rate divides no-shows by booked parties, so upcoming bookings count in
  the denominator: use a range that has passed.
- Turn-time fields reuse `configuredTurnMinutes` (a service rule beats a general
  one); `turnVarianceMinutes` is actual minus configured.
- `pacing_slots` rows come from `computePacingSlots` in
  `apps/tenant-api/src/services/rsv-report-shared.ts`, the one definition of
  bookings and covers per date, service and start time against the pacing
  limits.
- Templates: Daily summary, Covers by service, Booking sources, No-shows &
  cancellations, Cancellations by who, Late cancellations, No-show list, Turn
  times, Turn times against target, Waitlist outcomes, Waitlist waits, Pacing,
  and four single-number KPIs (Covers today, No-show rate, Late cancellations,
  Average waitlist wait) that also appear as dashboard report blocks. A report
  reads at most 20,000 rows; none of the templates runs over all time.
- Not carried over from the old page: the narrative insight sentence and the
  comparison with the previous period (a follow-up for single-number reports),
  and the read-only turn-time rules table (it stays in Settings, Policies).

**Guests and reports**

- Erasing a person is one flow (ADR 048, section 11) and
  `customer_subscriptions` is the only marketing consent store (the
  `rsv_guests.marketing_*_consent_at`, `consent_source` and
  `consent_text_version` columns are deprecated, never read or written, and
  dropped in a later release). A guest links to a customer only through a
  verified phone; merging two guests linked to different customers is refused
  (`409 merge_conflicting_customers`). Still open: access tokens issued before
  an erasure stay valid until they expire (15 minutes), the Stripe customer
  object is not deleted at the provider, and website form submissions are
  redacted only when they contain the erased phone or email.
- The guestbook is organization-wide: `locationIds` scoping is not applied to
  guests or to `/operator/people` (needs a product decision).
- A report keeps the oldest 20,000 rows when it truncates (a notice shows), and
  the no-show rate denominator counts every booking that is not cancelled,
  declined or expired, including upcoming ones.
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
