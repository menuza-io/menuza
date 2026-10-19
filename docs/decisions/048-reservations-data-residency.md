# ADR 048: Reservations data residency and plane split

- **Status:** Accepted
- **Date:** 2026-04-16 (amended 2026-10-18 to match the shipped module)
- **Related:**
  [ADR 045 — Tenant Customer Data Residency](./045-tenant-data-residency.md),
  [ADR 046 — OCI Regional Tenant API](./046-oci-regional-tenant-api.md),
  [ADR 047 — Staffing Data Residency](./047-staffing-data-residency.md),
  [Tenant Data Residency](../tenant-data-residency.md),
  [Reservations guide](../reservations.md),
  [Reservations contract](../reservations-contract.md),
  [Reservations plan](../reservations-plan.md)

## Context

Menuza is adding a restaurant reservations, table-management, waitlist, guest
CRM, experiences, and booking-protection module covering:

1. **Operator surfaces** (`apps/app` `/<orgSlug>/reservations/*`): Setup (floor
   plans, areas, tables, combinations, services, turn times, pacing, blackouts,
   policies, experiences, messaging), Today (live host stand, floor canvas,
   timeline, seating, walk-ins), Book (day sheet, requests, overrides),
   Waitlist, Guests (CRM, tags, visit history, notes, merge), Experiences, and
   Reports.
2. **Public guest surfaces**: Restaurant websites (`apps/sites` `/reserve`),
   native iOS (`apps/ios` + `TenantKit`) and Android (`apps/android`) booking
   flows, and AI phone agent reservation actions (`apps/voice-agent`).

These records contain regulated guest personal data: guest names, phone numbers,
email addresses, dietary/allergy notes, special occasion notes, visit and
no-show history, private staff notes, payment intent references, and raw voice
caller phone numbers.

For Saudi organizations (`Organization.dataRegion = 'ksa'`), guest personal data
is governed by the Saudi Personal Data Protection Law (PDPL) and must remain in
the KSA data plane (`apps/tenant-api` in OCI Riyadh, `packages/tenant-db`). The
operator App (`apps/app`), Admin (`apps/admin`), and Sites SSR (`apps/sites`)
run in the US control plane and must never store, proxy, or log KSA guest PII.

## Decision

### 1. Plane split: guest PII and operational state in regional `tenant-db`, control metadata in US `@repo/database`

All 41 `rsv_*` tables live exclusively in the regional per-organization SQLite
database (`packages/tenant-db`). Migration `0016_reservations_foundation.sql`
creates all 41; `0017` to `0020` only add columns and an index to them (`0017`:
`rsv_day_versions.availability_increased_at`, `rsv_outbox.status`; `0018`:
`rsv_notify_requests.last_notified_slot_min`; `0019`: index
`idx_rsv_table_occupancies_location_active_end`; `0020`: the `rsv_payments`
contract columns). `0021` adds the non-reservation table `voice_call_actions`
and `labor_scope_settings.demand_per_labor_hour`. The list below is generated
from `packages/tenant-db/src/schema.ts`.

- Configuration and floor plan (12): `rsv_location_settings`, `rsv_areas`,
  `rsv_tables`, `rsv_table_combos`, `rsv_table_combo_members`,
  `rsv_floor_elements`, `rsv_services`, `rsv_service_availability`,
  `rsv_turn_times`, `rsv_pacing_rules`, `rsv_special_days`, `rsv_blocks`
- Policies, sections and message texts (6): `rsv_policies`,
  `rsv_section_layouts`, `rsv_sections`, `rsv_section_tables`,
  `rsv_section_assignments`, `rsv_message_texts`
- Experiences (2): `rsv_experiences`, `rsv_experience_schedules`
- Guest CRM (5): `rsv_guests`, `rsv_tags`, `rsv_guest_tags`, `rsv_guest_notes`,
  `rsv_guest_merges`
- Bookings, holds and history (6): `rsv_reservations`, `rsv_reservation_tags`,
  `rsv_holds`, `rsv_table_occupancies`, `rsv_reservation_events`,
  `rsv_service_notes`
- Waitlist and notify-me (2): `rsv_waitlist_entries`, `rsv_notify_requests`
- Messages, payments and outbox (4): `rsv_messages`, `rsv_payments`,
  `rsv_outbox`, `rsv_journey_emissions`
- Infrastructure (4): `rsv_idempotency_keys`, `rsv_day_versions`,
  `rsv_rate_counters`, `rsv_audit_log`

Payment events are columns and rows of `rsv_payments` (there is no separate
payment-events table), rate limits are `rsv_rate_counters`, policy rules are
`rsv_policies`, and message templates are the guest-visible overrides in
`rsv_message_texts` (the defaults live in code). There are no daily statistics
tables: reports are computed from the booking rows. They run through the generic
report token and tenant-api `POST /analytics/query` (subjects `bookings`,
`waitlist_entries`, `pacing_slots`), browser-direct, with the same location
limit and no guest fields.

Settings that belong to a location (booking interval, horizon, party range, hold
minutes, cancellation cutoff, large-party mode, messaging, waitlist) are
regional (`rsv_location_settings`), as are experiences and their schedules: they
contain no guest data but are versioned with the bookings they govern, and the
control plane only learns about them through the non-PII context pull (section
4).

The US control plane (`@repo/database`, migrations
`0025_reservations_foundation.sql` and `0026_reservations_platform_fee.sql`)
stores **only**:

- Organization feature flags (`reservations.enabled`, `reservations.online`,
  `reservations.waitlist`, `reservations.payments`, `reservations.experiences`,
  `reservations.voice`) and `reservations.platform_fee_bp`
- Operator RBAC permissions (`read:reservation:any`, `update:reservation:any`,
  `read:reservation_guest:any`, `update:reservation_guest:any`,
  `read:reservation_settings:any`, `update:reservation_settings:any`,
  `read:reservation_report:any`, `update:reservation_payment:any`) and
  `UserOrganization.locationScope` with its selected locations
- Organization Locations (`OrganizationLocation`: id, name, slug, time zone,
  formatted address, coordinates, phone)
- Payment provider connection state on `Organization` (`stripeConnectAccountId`,
  `checkoutSubEntityId`, charge and payout flags), never guest card numbers or
  guest names
- Published website reservation block configuration (structural layout options
  only)

### 2. Operator token (`rsv+jwt`) and browser-direct operator access

App loaders and actions in `apps/app` never proxy reservation or guest payloads
through the US server. Instead:

1. Every `/<orgSlug>/reservations/*` loader and action calls
   `requireReservationsAccess(request, orgSlug, { feature, anyOf })` first
   (`404` when the master or section feature flag is off; `403` when the user
   lacks the required permission or has an empty intersected `locationScope`).
2. The browser fetches a short-lived HS256 operator JWT from
   `GET /<orgSlug>/reservations/token?scope=<book|guests|setup|reports|payments>`
   signed with `TENANT_OPERATOR_TOKEN` (`typ: 'rsv+jwt'`,
   `aud: 'tenant-api-reservations-operator'`).
3. Claims include `sub` (userId), `role: 'operator'`, `orgId`, `region`
   (`'us' | 'ksa'`), `scope`, `grants`, `locationIds` (`null` for unrestricted
   or a non-empty array of allowed `OrganizationLocation.id` values), `features`
   (`{ enabled, online, waitlist, payments, experiences, voice }`), and
   `impersonated` (`boolean`).
4. Token lifetime is **15 minutes** (`900` seconds) for standard tokens and **5
   minutes** (`300` seconds) when the token carries a sensitive grant or
   `impersonated: true`. `SENSITIVE_GRANTS`
   (`packages/reservations/src/permissions.ts`) are exactly
   `read:reservation_guest:any`, `update:reservation_guest:any` and
   `update:reservation_payment:any`. Settings grants are **not** sensitive, so a
   `setup` token lives 15 minutes (see Known issues in the guide).
5. Under support impersonation (`impersonated: true`), all write (`update:*`)
   and sensitive grants are stripped at mint time AND re-stripped by `rsvGuard`
   in `apps/tenant-api`.
6. The browser calls the regional `tenant-api` (`TENANT_API_URL` or
   `TENANT_API_URL_KSA`) directly with `Authorization: Bearer <token>`.

### 3. Public routes (`Origin` binding) and guest identity without login

Public guest endpoints (`/reservations/*` on `apps/tenant-api`) are called
directly from the guest's browser on `apps/sites` or from the native iOS and
Android apps:

- Sites SSR never proxies reservation holds, bookings, waitlist joins or guest
  lookups. The one exception is the payment hand-off (section 8), which carries
  opaque ids and a single-use token and no guest data.
- `/reservations*` resolves the organization from the browser **`Origin` header
  only** (plus `slug` or `host` query hints outside production, which the native
  apps use for non-https origins), on the Hono routes and in the Worker router
  (`workers/org-router.ts`) before any Durable Object is touched. It **ignores**
  any `orgId` query or body field and does not use a customer token to pick the
  organization: a presented customer token must belong to the organization the
  Origin names (403 otherwise; an invalid token is refused, not ignored).
- `/operator/reservations/*` resolves the organization strictly from the
  verified `rsv+jwt` `orgId` claim, returning `401` before touching any Durable
  Object when missing or invalid.
- Public and operator routes verify that the organization is active, in this
  node's region and has a provisioned regional database (`hasProvisionedDb`),
  and answer a uniform `404 { error: 'not_found' }` otherwise, so a caller
  learns nothing about which organizations exist.
- **Guest identity without login:**
  - Guests book, join the waitlist and view, modify, confirm or cancel their
    booking without an account, using opaque capability tokens with explicit
    prefixes: `rsv_m_` (manage), `rsv_w_` (waitlist), `rsv_n_` (notify-me),
    `rsv_p_` (payment).
  - These tokens are **derived, not stored**: HMAC-SHA256 over the organization
    id, the record id and a version counter (`manage_token_version`,
    `status_token_version`), keyed from `AUTH_HMAC_SECRET`. Bumping the version
    revokes a link. Hold tokens are random and only their SHA-256 hash is stored
    (`rsv_holds`).
  - Manage links in messages carry the token in the URL fragment
    (`/reserve/manage#t=...`, `/reserve/waitlist#t=...`) so it never reaches
    `Referer` headers, server logs or Sites SSR; the browser reads
    `location.hash` and sends it in the `X-Reservation-Token` header. The query
    form `?t=` exists only for the `.ics` download.
  - Public bookings never rewrite an existing guest profile; the profile is
    linked to a signed-in customer only when the customer's verified phone is
    the guest's phone.
  - Customer phone-OTP sign-in is optional for the web and required for native
    booking; a verified customer token substitutes for Turnstile.
- **Native clients** use the same routes with `X-Client: ios | android` (channel
  `native`); see the contract.

### 4. Location model and non-PII organization context pull (`GET /resources/reservations/context`)

Physical restaurant locations (`OrganizationLocation`) are managed in the US
control plane and mirrored into `rsv_location_settings` per tenant database:

- When `apps/tenant-api` needs control-plane metadata for an organization
  (active locations and time zones, feature flags, website branding theme,
  payment capability and `platformFeeBp`), it calls
  `GET /resources/reservations/context?orgId=<id>` on `apps/app` authenticated
  with `Authorization: Bearer <INTERNAL_COMMAND_TOKEN>`.
- The response is validated against `reservationsContextSchema` and contains
  **zero guest PII**.
- `apps/tenant-api/src/lib/reservations-context.ts` caches the response per
  `orgId` for **5 minutes** fresh, serves up to **24 hours** stale if a refresh
  fails, enforces a **30-second** failure cooldown and uses a **3-second**
  timeout with `redirect: 'error'`.
- When an operator updates locations, flags, branding or payment accounts in
  `apps/app`, App posts `POST /internal/reservations/context-changed` to evict
  the regional cache immediately and sync location time zones.
- **Location hours ride in this context and drive availability.** Each context
  location carries `timeZone`, `isActive`, `storeHours` (weekly) and
  `specialHours` (dated), typed and tolerantly parsed (a malformed value for one
  location parses to `null`, which fails open for that location only; App and
  tenant-api log a count). These are business opening hours, not PII, so no new
  data crosses regions. `onlineHours` (ordering) is not sent.
- **Precedence** (`buildEffectiveDay`, `packages/reservations`): location
  inactive, then location closed for the whole business day (special hours
  closed, closed weekday, no open instant), then the reservations special day
  (`closed`, `online_closed`, `modified`/`replace`), then the location hours
  clipping the day's slots, then the weekly service templates. Slots are checked
  per start instant in the **location's** zone, so overnight ranges, the
  reservation time zone and `dayStartMin` stay exact. Location hours are the
  single source of "when are we open": services only operate inside them, a
  special day can never open reservations on a closed location, and staff keep
  the explicit `overbook` override (`closed_day`, `outside_location_hours`
  warning). Enforcement has no flag.

### 5. Concurrency, single-writer discipline (`withReservationWrite`), and SQLite invariants

Reservation holds, bookings, seating assignments and waitlist promotions must
never double-book a table even under concurrent requests:

1. Every reservation write and every setup or configuration mutation runs inside
   `withReservationWrite` (`apps/tenant-api/src/lib/reservations-write.ts`): the
   per-organization in-process mutex (`runExclusive(orgId, ...)`),
   `retryOnSqliteBusy` (delays 0, 10, 25, 50, 100, 200 ms on `SQLITE_BUSY`) and
   a real transaction (libsql `db.transaction` opens `BEGIN IMMEDIATE`).
2. Inside the transaction it sweeps expired holds, `pending_payment` and
   `pending_approval` reservations and expired `notified` waitlist entries,
   checks the idempotency record, loads the day state, runs the callback,
   reconciles scheduled messages of the touched days, and bumps
   `rsv_day_versions`. After commit it invalidates the day cache and runs
   `afterCommit` hooks.
3. Database triggers in `0016_reservations_foundation.sql` enforce hard
   invariants as a second line of defense:
   - `rsv_occupancy_no_overlap_insert` and `rsv_occupancy_no_overlap_update`
     abort with `RAISE(ABORT, 'rsv_table_occupancies overlap')` on any
     overlapping active non-overbooked occupancy
     (`o.active = 1 AND o.overbook = 0`) for the same table, which
     `mapSqliteConstraintError` translates into `409 Conflict`.
   - `rsv_holds_single_conversion` aborts with `hold_already_converted` on any
     update when `OLD.status = 'converted'`.
   - `rsv_reservation_events_no_delete` / `_no_update`,
     `rsv_audit_log_no_delete` / `_no_update` and `rsv_guest_merges_no_delete` /
     `_no_update` make those tables append-only (`RAISE(ABORT, 'append_only')`).
     The only allowed update on events and audit rows is erasure redaction
     (`data = '{"redacted":true}'`, `changes = '{"redacted":true}'`) with `id`
     and the entity columns unchanged; the actor and time columns are not pinned
     (known issue).
4. **Transactions on the Durable Object runtime.** Drizzle's durable-sqlite
   `db.transaction` calls `storage.transactionSync` and does not await an async
   callback, so it cannot roll back writes made after the first `await`. The
   write gate therefore runs through `runTenantTransaction` (`@repo/tenant-db`,
   `resolver.ts`). libsql keeps `db.transaction`; the `TenantOrg` object
   registers `ctx.storage.transaction` (the async variant, which rolls back on a
   throw) as the runner for its handle. **Guarantee:** all writes of one gate
   call commit or roll back together on both runtimes. Retry-scoped state
   (affected dates, day-version bookkeeping, post-commit hooks) is created per
   attempt inside the retried closure, so a `SQLITE_BUSY` retry never replays
   stale bookkeeping.
5. **Bound parameters.** Durable Object SQLite allows at most **100 bound
   parameters per statement**. Any `IN (...)` list sized by data (reservation,
   guest, message or hold ids) goes through `queryInChunks` / `forEachInChunks`
   (`apps/tenant-api/src/lib/chunked-in.ts`, `MAX_IN_CHUNK = 90`, leaving room
   for the statement's other parameters). A new query with a data-sized `IN`
   list must use them.
6. **`busy_timeout` limitation.** `PRAGMA busy_timeout` is applied once, on the
   first libsql connection of a tenant file
   (`packages/tenant-db/src/db.server.ts`). `client.transaction()` opens extra
   connections that do not inherit it. A per-connection `timeout` client option
   was tried and **reverted**: libsql's driver is synchronous, so a same-process
   writer waiting for a lock held by another in-process transaction blocks the
   event loop for the whole timeout (the lock holder cannot run), which stalled
   unrelated requests for about 30 seconds. Same-process writers are serialized
   by `runExclusive`; `retryOnSqliteBusy` covers the rest.
7. **Occupancy reads are time-windowed.** Scheduling state loads only active
   occupancies overlapping the business date padded by 2 days before and 3 days
   after (`occupancyWindowFilter`), backed by
   `idx_rsv_table_occupancies_location_active_end` (migration `0019`).

### 6. Feature flags

Every Reservations screen, operator token mint and public endpoint is gated by
organization-level feature flags read with `getFeatureFlag`
(`@repo/common/feature-flags`), defaulting to `false` (only a literal `true`
counts; child flags need `reservations.enabled`):

- `reservations.enabled` — master switch for the sidebar group, all
  `/<orgSlug>/reservations/*` routes and operator token minting.
- `reservations.online` — public booking on Sites, native booking, public hold
  and booking endpoints.
- `reservations.waitlist` — operator Waitlist section, public waitlist and
  notify-me.
- `reservations.payments` — deposit, card-guarantee and prepay policies, refunds
  and fees.
- `reservations.experiences` — operator Experiences section and public ticketed
  experiences.
- `reservations.voice` — AI phone agent reservation actions.

### 7. Permissions, role presets and location-scope reuse

Access to operator surfaces and `rsv+jwt` scopes is governed by 8 organization
permissions seeded in control-plane migration `0025_reservations_foundation.sql`
and granted to the built-in `admin` role only:

- `read:reservation:any`, `update:reservation:any`
- `read:reservation_guest:any`, `update:reservation_guest:any`
- `read:reservation_settings:any`, `update:reservation_settings:any`
- `read:reservation_report:any`
- `update:reservation_payment:any`

Write permissions imply their matching read permission (`update:reservation:any`
→ `read:reservation:any`; `update:reservation_guest:any` →
`read:reservation_guest:any`; `update:reservation_settings:any` →
`read:reservation_settings:any`); `update:reservation_payment:any` has no
dedicated read permission. Role presets are not seeded in a migration: Settings,
Roles offers them (`RESERVATIONS_ROLE_PRESETS` in `@repo/reservations`: `host`,
`shift_manager`, `reservations_manager`, `guest_relations`, `guestbook_manager`,
`finance`, `owner`).

**Location scope reuse.** Reservations reuses the existing
`UserOrganization.locationScope` (`all` or `selected`, with
`UserOrganizationLocation` rows) that Staffing introduced instead of adding a
second mechanism. `resolveReservationsLocationIds` turns it into the token's
`locationIds` claim (`null` for all locations). The App location picker shows
only when more than one location is allowed, and every operator route checks the
`locationId` against the claim. The guestbook is the exception: guests are
organization-wide (known issue, a decision is pending).

### 8. Payments and webhook termination

Deposits, card guarantees and prepaid experiences use the organization's
connected Stripe account (US) or Checkout.com sub-entity (KSA, SAR):

- **Regional decisions.** The regional node decides amounts, currency, policy,
  state and refund eligibility, and stores them in `rsv_payments` (one row per
  attempt, fee or refund). It never calls a provider.
- **Provider calls in the App.** The US App is the only component that talks to
  a provider. It asks the region for a quote, creates the provider session
  itself, then reports to the region (`bind`, `status`, `fee-claim`,
  `fee-result`, `refund-claim`, `refund-result`, `dispute`, `pending`) in
  separate calls: it never calls a provider inside a regional lock or
  transaction. Provider metadata, product names, customers and idempotency keys
  carry opaque ids only.
- **Webhooks terminate at the US App (accepted deviation).** The earlier draft
  of this ADR terminated provider webhooks at the regional node so payment
  events never touched the US plane. That was not practical: the
  connected-account records, webhook signing secrets and the existing shop and
  restaurant webhook handlers live in the control plane, a provider delivers to
  one URL per account, and the App is the component that is publicly reachable
  and retried by the providers. Terminating at the regional node would also have
  meant a second copy of every provider secret on the KSA VM. The App therefore
  verifies the signature (Stripe: `/api/stripe/webhook` with
  `STRIPE_WEBHOOK_SECRET` or `STRIPE_CONNECT_WEBHOOK_SECRET`; Checkout.com:
  `/api/shop/webhook`), maps the event at once to an **ids-and-amounts DTO**
  (reservation or payment id, amount, currency, status), never stores or logs
  the raw event, and forwards only that to the region
  (`/api/reservations/payments/status`, `/dispute`, `/refund-result`). The DTO
  holds no guest name, phone, email, note or card data, and reservations
  metadata at the provider is opaque ids. A failure to reach the region answers
  5xx so the provider retries; duplicates are idempotent regionally.
- **Checkout.com card guarantee.** A guarantee on Checkout.com is a
  customer-initiated `Unscheduled` payment that stores the card, and a payment
  needs a positive amount, so the hosted page charges a verification amount of
  **100 minor units** (`RESERVATION_CHECKOUT_VERIFICATION_MINOR`), which the App
  refunds best-effort (idempotent key; a failure is logged by code and never
  blocks the guarantee).
- **Sites hand-off.** The pay link is
  `<siteOrigin>/reserve/pay#r=<id>&t=<token>`. The Sites server forwards the
  opaque reservation id and the single-use payment token to
  `POST /resources/sites/reservation/checkout`, authenticated with
  `SITES_RESERVATION_PAYMENT_TOKEN`, a secret held only by App and Sites (at
  least 32 characters, distinct from `INTERNAL_COMMAND_TOKEN`; Sites never holds
  the internal token). Amounts come from the regional quote.
- **Regional to App commands** (refunds, checkout expiry) travel through the
  regional outbox to `POST /resources/reservations/payments`
  (`INTERNAL_COMMAND_TOKEN`), with an hourly reconcile job
  (`/resources/jobs/reservation-payments-reconcile`) as the safety net.
- **Platform fee.** `reservations.platform_fee_bp` (integer basis points,
  `0..10000`, system default `250` set by control-plane migration `0026`; a
  per-organization value overrides it, edited in Admin) is applied as
  `floor(amount * bp / 10000)` to deposits and prepayments, reported at bind and
  fee result and stored in `rsv_payments.platform_fee_bp`.
- A region switch is refused while unsettled payments exist (section 11).

### 9. Customer messaging, regional tick, and shared org alarm (`lib/org-alarm.ts`)

- **Messaging regions.** Guest messages are rendered and sent from the regional
  node. Email works in both regions. **SMS is US node only**: the KSA node never
  sends reservation SMS (it is marked `suppressed`), because Twilio is blocked
  for KSA production. SMS also needs the guest's opt-in and the location's
  `smsEnabled`. Texts come from code defaults overridden by `rsv_message_texts`,
  and rows are deduplicated by `dedupe_key` in `rsv_messages`.
- The regional tick (`POST /api/reservations/tick` with
  `INTERNAL_COMMAND_TOKEN`, plus in-process Node timers and Durable Object
  alarms) expires holds, pending payment and request bookings and notified
  waitlist entries, applies auto-no-show, offers waitlist and notify-me slots,
  delivers due messages, the outbox (manager alerts, payment commands), heals
  guest counters and purges old rows.
- **Shared org alarm (`apps/tenant-api/src/lib/org-alarm.ts`)**: a Durable
  Object has a single `storage.setAlarm` timestamp per organization, so
  `lib/org-alarm.ts` multiplexes the `staffing` and `reservations` ticks across
  the DO `alarm()` handler and the Node/OCI interval loop; scheduling or firing
  one never clobbers the other.
- Manager alerts cross to the App as
  `{ orgId, eventId, kind, locationId, count }` through the outbox: no guest,
  party or time.

### 10. AI voice agent boundary

- `apps/voice-agent` interacts with regional reservation state solely through
  `POST /api/voice/actions/:name` on `apps/tenant-api`
  (`reservations.availability`, `reservations.hold`, `reservations.book`),
  authenticated with `Authorization: Bearer <VOICE_AGENT_TOKEN>`, US
  organizations only and gated by `reservations.voice`.
- Callers are never identified by phone number and no action returns guest data;
  caller numbers and names are written only to the regional `tenant-db`.

### 11. Retention, erasure and region switch

- **Retention** (the regional tick's `purge`): idempotency keys 48 hours, rate
  counters 2 days, released or expired holds 7 days, finished guest messages 180
  days, delivered outbox rows 30 days. Reservations, events and the audit log
  are kept. A manage link stops answering 7 days after the booking ends; a
  waitlist link 2 days after joining.
- **One erasure flow** (`erasePerson`,
  `apps/tenant-api/src/services/person-erasure-service.ts`). The operator guest
  erase (`POST /operator/reservations/guests/:id/erase`, needs
  `update:reservation_guest:any`), the operator customer erase
  (`POST /operator/customers/:id/erase`, needs a token minted with `canDelete`)
  and the internal route (`POST /internal/reservations/erase-customer`, body
  `{ orgId, customerId }`) all call it, so erasing a person from either side
  does the same complete job. A person is a set grown to a fixed point from the
  guest ids (with every guest merged into them, recursively, and the survivor of
  a merge), the linked customer ids (`customer_id`, `marketing_customer_id`) and
  the phones and emails they hold: a guest found by phone brings its customer, a
  customer brings the guests that carry its phone. In one regional write
  transaction (`withSetupWrite`, chunked `IN` lists of 90 or fewer) it:
  - anonymizes every guest row and deletes their notes and tags;
  - cancels future bookings (the cancellation notice goes out first, outside the
    transaction), scrubs reservation text, `client` and `ip_hash`, card metadata
    on payments, and deletes the holds that became those bookings (their token
    and address hashes go with them);
  - nulls contact data on waitlist entries and notify requests (matched by guest
    id, phone or email) and cancels the open ones;
  - stops every pending or sending `rsv_messages` row of those bookings,
    waitlist entries and notify requests (the table holds no address: it was
    read from the guest, which is gone), so nothing is sent after the erasure;
  - deletes the customer row and, explicitly, its subscriptions, refresh tokens,
    payment methods, journey runs, journey step executions and marketing
    messages (no reliance on the foreign-key pragma);
  - scrubs order contact and delivery fields (`restaurant_orders`: name, phone,
    email, address, notes, postal code, coordinates, receipt token) for orders
    by customer id, phone or email, and keeps totals; nulls
    `shop_orders.customer_id`;
  - redacts website form submissions that contain the erased phone or email
    (best effort: free text);
  - redacts earlier `rsv_reservation_events` and `rsv_audit_log` payloads and
    appends one PII-free `guest.erase` audit entry, only when something changed.

  Voice calls tied to the phone or customer (with their requests, SMS log and
  recordings) are erased first through `eraseCallerVoiceData`, because
  recordings live in object storage: a failed recording deletion answers 502 and
  stops before any row is touched. The flow is idempotent and safe to re-run (a
  second run changes nothing). `person-erasure-pii-columns.test.ts` lists every
  PII-looking column of the tenant schema and fails when a new one is neither
  covered by the erase nor allow-listed; `person-erasure.test.ts` seeds one
  person across the tables and scans a dump of the whole database. Not covered:
  access tokens already issued (15 minutes, stateless) and the Stripe customer
  object at the provider.

- **Single consent source.** `customer_subscriptions` is the only marketing
  consent store. `rsv_guests.marketing_email_consent_at`,
  `marketing_sms_consent_at`, `consent_source` and `consent_text_version` are
  deprecated: nothing reads or writes them (kept one release, then dropped). A
  booking-form consent writes only subscription rows
  (`recordReservationMarketingConsent`), and the guest profile reports consent
  from the linked customer's subscriptions (`marketing`, null when the guest has
  no customer row). A broadcast campaign's audience (`loadBroadcastAudience`) is
  customers with an active subscription (`unsubscribed_at IS NULL`) for the
  campaign's channel; texts also need a verified phone. Having a customer row, a
  verified phone or a past booking is not consent.
- **Linking rule.** `rsv_guests.customer_id` is set only when a customer's
  verified phone (E.164) equals the guest's phone and the customer owns no other
  guest. Never on an unverified phone, a name or an email; a guest never creates
  a `customers` row as a link (the unverified row a marketing consent may create
  is reachable only through `marketing_customer_id`). Link points: phone
  verification (`/auth/verify`, best effort, never fails sign-in), signed-in
  public booking, operator booking and guest create or phone edit
  (`resolveOrCreateGuestForBooking`, `createGuestProfile`, `updateGuestProfile`;
  a phone edit that no longer equals the customer's phone drops the link), and
  the idempotent pass `linkGuestsToCustomers`
  (`POST /internal/reservations/link-customers`, counts only; ties go to the
  guest with the latest visit). Merging two guests linked to different customers
  is refused with `409 merge_conflicting_customers`; merging when one is linked
  keeps the link.
- **Phone normalization is region-aware.** Input with a country code (`+` or
  `00`) is never reinterpreted. A number typed without one is read in the node's
  data region: `05XXXXXXXX`, `5XXXXXXXX` and `9665XXXXXXXX` are `+966...` on a
  KSA node, 10 digits (or 11 with a leading 1) are `+1...` on a US node. One
  shared function (`normalizeGuestPhone` in `@repo/reservations`, wrapped by
  `apps/tenant-api/src/lib/phone.ts`) serves customers, guests and the
  guestbook.
- **Region switch** follows ADR 045: the old regional database is destroyed and
  an empty one is provisioned. The App guard reads counts only
  (`/internal/reservations/summary`), refuses while unsettled payments exist and
  otherwise requires the administrator to type the organization slug when any
  data exists or the count is unknown.

### 12. Kill switches

- `RESERVATIONS_PUBLIC_ENABLED` (`apps/tenant-api`): when `false` (`0`, `off`,
  `no`, `disabled`), every public `/reservations/*` endpoint immediately returns
  `503`. Operator routes are unaffected.
- `RESERVATIONS_SMS_ENABLED` (`apps/tenant-api`): when `false`, outbound
  reservation and waitlist SMS messages are dropped without queuing a backlog.
- `RESERVATIONS_EMAIL_ENABLED` (`apps/tenant-api` and `apps/app`): when `false`,
  outbound reservation emails and manager alert emails are dropped without
  failing booking mutations.
- `RESERVATIONS_TICK_INTERVAL_SECONDS` (`apps/tenant-api` Node runtime): seconds
  between in-process ticks (default 120, minimum 60, `0` disables the timer and
  keeps the cron and alarm paths).

### 13. Languages follow Website settings

Reservations stores no language list. Guest-facing operator text is a locale map
whose languages are the organization's Website settings languages (site locales
plus the default language, limited to `SITE_CONTENT_LOCALES`); the default
language is required for names. tenant-api reads the same list from the non-PII
control-plane context (`organization.locales`, `organization.defaultLocale`),
validates every map against it and resolves requested language, organization
default, canonical name. Guest SMS and email use the guest's booking language
when enabled, else the default, from shipped templates in all six languages.
Nothing here puts text or language data in the control plane. See
`docs/reservations.md#languages`.

## Consequences

- KSA guest PII never enters US logs, US D1 or Sites SSR memory. Payment events
  do pass through the US App as ids and amounts only; the App holds no guest
  data from them.
- Every operator and public reservation route is mechanically verified by
  `apps/tenant-api/src/routes/reservations-security.test.ts` and
  `apps/app/app/utils/reservations/reservations-guards.test.ts`; the public
  contract by `reservations-contract.test.ts` (tenant-api and
  `@repo/reservations`).
- Capacity and table-overlap guarantees hold both in application logic and at
  the SQLite trigger layer.
- Known gaps are tracked in the
  [operator guide](../reservations.md#known-issues-and-known-gaps).
