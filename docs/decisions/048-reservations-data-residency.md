# ADR 048: Reservations data residency and plane split

- **Status:** Accepted
- **Date:** 2026-04-16
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
database (`packages/tenant-db`, migration `0016_reservations_foundation.sql`):

- Configuration & floor plan (12): `rsv_location_settings`, `rsv_areas`,
  `rsv_tables`, `rsv_table_combos`, `rsv_table_combo_members`,
  `rsv_floor_elements`, `rsv_services`, `rsv_turn_times`, `rsv_pacing_rules`,
  `rsv_service_availability`, `rsv_special_days`, `rsv_blocks`
- Experiences, policies & templates (6): `rsv_experiences`,
  `rsv_experience_schedules`, `rsv_experience_exceptions`,
  `rsv_experience_addons`, `rsv_policy_rules`, `rsv_message_templates`
- Guest CRM (5): `rsv_guests`, `rsv_guest_tags`, `rsv_guest_tag_links`,
  `rsv_guest_notes`, `rsv_guest_merges`
- Bookings, holds, occupancies, waitlist, payments, comms, audit, outbox & stats
  (18): `rsv_holds`, `rsv_reservations`, `rsv_reservation_tables`,
  `rsv_reservation_addons`, `rsv_table_occupancies`, `rsv_waitlist_entries`,
  `rsv_reservation_events`, `rsv_payments`, `rsv_payment_events`,
  `rsv_messages`, `rsv_idempotency_keys`, `rsv_rate_limits`, `rsv_audit_log`,
  `rsv_outbox`, `rsv_day_versions`, `rsv_daily_location_stats`,
  `rsv_daily_service_stats`, `rsv_daily_experience_stats`

The US control plane (`@repo/database`, migration
`0025_reservations_foundation.sql`) stores **only**:

- Organization feature flags (`reservations.enabled`, `reservations.online`,
  `reservations.waitlist`, `reservations.payments`, `reservations.experiences`,
  `reservations.voice`) and `reservations.platform_fee_bp`
- Operator RBAC permissions (`read:reservation:any`, `update:reservation:any`,
  `read:reservation_guest:any`, `update:reservation_guest:any`,
  `read:reservation_settings:any`, `update:reservation_settings:any`,
  `read:reservation_report:any`, `update:reservation_payment:any`) and
  `UserOrganization.locationScope`
- Organization Locations (`OrganizationLocation`: id, name, slug, timezone,
  formatted address, coordinates, phone)
- Payment provider credentials (`OrganizationPaymentAccount`: connected account
  IDs and encrypted secrets, never guest card numbers or guest names)
- Published website reservation block configuration (which contains only
  structural layout options, never guest data)

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
4. Token TTL is **15 minutes** (`900` seconds) for standard tokens and **5
   minutes** (`300` seconds) when the token carries sensitive grants
   (`read:reservation_guest:any`, `update:reservation_guest:any`,
   `update:reservation_payment:any`) or `impersonated: true`.
5. Under support impersonation (`impersonated: true`), all write (`update:*`)
   and sensitive grants are stripped at mint time AND re-stripped by `rsvGuard`
   in `apps/tenant-api`.
6. The browser calls the regional `tenant-api` (`TENANT_API_URL` or
   `TENANT_API_URL_KSA`) directly with `Authorization: Bearer <token>`.

### 3. Customer and public routes (`Origin` + slug/host resolution) and guest identity without login

Public guest endpoints (`/reservations/*` on `apps/tenant-api`) are called
directly from the guest's browser on `apps/sites` or from the native iOS/Android
apps:

- Sites SSR never proxies reservation holds, bookings, waitlist joins, or guest
  lookups.
- On the Cloudflare Worker Durable Object router (`workers/org-router.ts`) and
  the Hono routes, `/reservations/*` resolves the target organization from a
  verified customer Bearer JWT or from the browser `Origin` header + site
  slug/custom domain, **ignoring** any `orgId` query parameter or JSON body
  field.
- `/operator/reservations/*` resolves the target organization strictly from the
  verified `rsv+jwt` `orgId` claim, returning `401` before touching any Durable
  Object when missing or invalid.
- Both public and operator routes verify that the organization is active and has
  a provisioned regional database (`Boolean(organization.hasProvisionedDb)`),
  returning uniform `404 { error: 'not_found' }` otherwise.
- **Guest identity without login**:
  - Guests can book a table, join the waitlist, and view, modify, or cancel
    their booking without creating or signing into a customer account.
  - Creating a reservation or waitlist entry mints a high-entropy capability
    token with an explicit prefix (`rsv_m_<base64url>` for reservation manage
    tokens, `rsv_w_<base64url>` for waitlist tokens).
  - Only the HMAC-SHA256 digest (`manage_token_hash` on `rsv_reservations`,
    `token_hash` on `rsv_waitlist_entries`, keyed by `AUTH_HMAC_SECRET`) is
    stored in the regional `tenant-db`; raw capability tokens are never
    persisted.
  - SMS and email manage links place the capability token in the URL fragment
    (`/reserve#t=rsv_m_...` or `/reserve#t=rsv_w_...`) rather than the query
    string so the token is never transmitted in HTTP `Referer` headers, server
    access logs, or US Sites SSR requests; the browser reads `location.hash`
    client-side and sends the token directly to the regional `tenant-api` over
    HTTPS.
  - Customer phone-OTP / `Bearer` JWT sign-in is optional: when a signed-in
    customer books or accesses `/reservations/my`, `customer_id` is linked on
    `rsv_guests` / `rsv_reservations` inside the regional `tenant-db`.

### 4. Location model and non-PII organization context pull (`GET /resources/reservations/context`)

Physical restaurant locations (`OrganizationLocation`) are managed in the US
control plane and mirrored into `rsv_location_settings` per tenant database:

- When `apps/tenant-api` needs control-plane metadata for an organization
  (active locations and time zones, feature flags, website branding theme,
  payment connection metadata, and `platformFeeBp`), it calls
  `GET /resources/reservations/context?orgId=<id>` on `apps/app` authenticated
  with `Authorization: Bearer <INTERNAL_COMMAND_TOKEN>`.
- The response is validated against `reservationsContextSchema` and contains
  **zero guest PII**.
- `apps/tenant-api/src/lib/reservations-context.ts` caches the response per
  `orgId` for **5 minutes** (`300_000` ms) fresh, serves up to **24 hours**
  (`86_400_000` ms) stale if a refresh fails, enforces a **30-second** (`30_000`
  ms) failure cooldown before retrying upstream, and uses a **3-second** timeout
  with `redirect: 'error'`.
- When an operator updates locations, flags, branding, or payment accounts in
  `apps/app`, App posts `POST /internal/reservations/context-changed` with
  `Authorization: Bearer <INTERNAL_COMMAND_TOKEN>` to evict the regional cache
  immediately and sync location time zones.

### 5. Concurrency, single-writer discipline (`withReservationWrite`), and SQLite invariants

Reservation holds, bookings, seating assignments, and waitlist promotions must
never double-book a table even under concurrent requests:

1. Every capacity-affecting mutation runs inside `withReservationWrite`
   (`apps/tenant-api/src/lib/reservations-write.ts`), which acquires the
   per-organization in-process mutex (`runExclusive(orgId, ...)`) and wraps a
   `BEGIN IMMEDIATE` SQLite transaction with `retryOnSqliteBusy`.
2. Inside the transaction, `withReservationWrite` sweeps expired holds, expired
   `pending_payment` / `pending_request` reservations, and expired `notified`
   waitlist entries before reading `loadDayStateInTx`, and bumps
   `rsv_day_versions` (`bumpDayVersionsInTx`) on commit.
3. Database triggers in `0016_reservations_foundation.sql` enforce hard
   invariants as a second line of defense:
   - `rsv_occupancy_no_overlap_insert` and `rsv_occupancy_no_overlap_update`
     abort with `RAISE(ABORT, 'rsv_table_occupancies overlap')` on any
     overlapping active non-overbooked occupancy
     (`o.active = 1 AND o.overbook = 0`) for the same table
     (`o.start_at < NEW.end_at AND o.end_at > NEW.start_at`), which
     `mapSqliteConstraintError` translates into `409 Conflict`.
   - `rsv_holds_single_conversion` aborts with
     `RAISE(ABORT, 'hold_already_converted')` on any update when
     `OLD.status = 'converted'`.
   - `rsv_reservation_events_no_delete` and `rsv_reservation_events_no_update`
     make `rsv_reservation_events` strictly append-only
     (`RAISE(ABORT, 'append_only')`), allowing only erasure redaction
     (`NEW.data = '{"redacted":true}'`).
   - `rsv_audit_log_no_delete` and `rsv_audit_log_no_update` make
     `rsv_audit_log` strictly append-only (`RAISE(ABORT, 'append_only')`),
     allowing only erasure redaction (`NEW.changes = '{"redacted":true}'`).
   - `rsv_guest_merges_no_delete` and `rsv_guest_merges_no_update` make
     `rsv_guest_merges` strictly append-only (`RAISE(ABORT, 'append_only')`).

### 6. Feature flags

Every Reservations screen, operator token mint, and public endpoint is gated by
organization-level feature flags read with `getFeatureFlag`
(`@repo/common/feature-flags`), defaulting to `false`:

- `reservations.enabled` — master switch for the sidebar group, all
  `/<orgSlug>/reservations/*` routes, and operator token minting.
- `reservations.online` — public `/reserve` widget on Sites, native customer
  booking flows, and public hold/booking endpoints.
- `reservations.waitlist` — operator Waitlist section and public online waitlist
  endpoints.
- `reservations.payments` — deposit, card-hold, and prepay policies plus payment
  capture/refund/release endpoints.
- `reservations.experiences` — operator Experiences section and public ticketed
  experiences.
- `reservations.voice` — AI phone agent reservation availability, hold + SMS
  link, and direct voice booking.
- `reservations.platform_fee_bp` — integer basis points (`0..2000`, default `0`)
  applied to reservation deposits and prepayments.

### 7. Permissions and location scoping (`UserOrganization.locationScope`)

Access to operator surfaces and `rsv+jwt` scopes is governed by 8 organization
permissions seeded in control-plane migration
`0025_reservations_foundation.sql`:

- `read:reservation:any`, `update:reservation:any`
- `read:reservation_guest:any`, `update:reservation_guest:any`
- `read:reservation_settings:any`, `update:reservation_settings:any`
- `read:reservation_report:any`
- `update:reservation_payment:any`

Write permissions imply their matching read permission (`update:reservation:any`
→ `read:reservation:any`; `update:reservation_guest:any` →
`read:reservation_guest:any`; `update:reservation_settings:any` →
`read:reservation_settings:any`; `update:reservation_payment:any` has no
dedicated read permission). Four organization role presets are seeded in
`0025_reservations_foundation.sql`:

- `Host`: `read:reservation:any`, `update:reservation:any`
- `Shift manager` extension: `read:reservation:any`, `update:reservation:any`,
  `read:reservation_guest:any`, `read:reservation_report:any`
- `Reservations manager`: `read:reservation:any`, `update:reservation:any`,
  `read:reservation_settings:any`, `update:reservation_settings:any`,
  `read:reservation_guest:any`, `update:reservation_guest:any`,
  `read:reservation_report:any`
- `Guest relations`: `read:reservation:any`, `read:reservation_guest:any`,
  `update:reservation_guest:any`

`UserOrganization.locationScope` (`null` for all locations, or a JSON array of
`OrganizationLocation.id` strings) restricts operator access to an explicit
subset of locations and is embedded in the `rsv+jwt` `locationIds` claim. In the
App UI, the location picker is rendered only when `locations.length > 1`.

### 8. Payments and regional webhook termination

Deposit, no-show card hold, and prepaid experience charges use the
organization's connected Stripe (US) or Checkout.com (KSA) account:

- Payment intents, setup intents, captures, releases, and refunds are initiated
  from the regional `apps/tenant-api` using non-PII credentials from
  `ReservationsContext`, and payment state is stored in `rsv_payments` and
  `rsv_payment_events` in the regional `tenant-db`.
- Provider webhooks terminate directly at the regional `apps/tenant-api` node so
  guest metadata and payment records never transit the US control plane.

### 9. Customer messaging, regional tick, and shared org alarm (`lib/org-alarm.ts`)

- Confirmation, reminder, cancellation, waitlist summon, and payment-link
  messages are rendered and dispatched directly from the regional
  `apps/tenant-api` node using templates in `rsv_message_templates` and
  deduplicated in `rsv_messages` via `dedupe_key`.
- The regional tick (`POST /api/reservations/tick` authenticated with
  `Authorization: Bearer <INTERNAL_COMMAND_TOKEN>`, plus in-process Node timers
  and Durable Object alarms) expires holds, pending payment/request bookings,
  and notified waitlist entries, dispatches due reminders, and applies
  configured auto-no-show rules inside the regional data plane.
- **Shared org alarm (`apps/tenant-api/src/lib/org-alarm.ts`)**: Cloudflare
  Durable Objects support only a single scheduled `storage.setAlarm(...)`
  timestamp per organization DO instance. `lib/org-alarm.ts` multiplexes both
  `staffing` and `reservations` regional ticks across the DO `alarm()` handler
  and the Node/OCI periodic interval loop so scheduling or firing a reservation
  tick never clobbers a pending staffing alarm (and vice versa).

### 10. AI voice agent boundary

- `apps/voice-agent` interacts with regional reservation state solely through
  `/api/voice/actions/reservation-*` on `apps/tenant-api`, authenticated with
  `Authorization: Bearer <VOICE_AGENT_TOKEN>` and gated by `reservations.voice`.
- Caller phone numbers and guest names are written directly to the regional
  `tenant-db` and are never stored in US control-plane tables.

### 11. Region switch and customer erasure

- When a customer exercises right-to-erasure
  (`POST /internal/reservations/erase-customer` with
  `Authorization: Bearer <INTERNAL_COMMAND_TOKEN>`), `rsv_guests` PII is
  scrubbed, active reservations/holds/waitlist rows are cancelled and scrubbed,
  and `rsv_reservation_events` and `rsv_audit_log` rows have their payload
  columns redacted to `'{"redacted":true}'` while preserving the append-only
  audit trail.
- Switching `Organization.dataRegion` follows ADR 045: the old regional tenant
  database is destroyed and a fresh database is provisioned in the new region.

### 12. Kill switches

- `RESERVATIONS_PUBLIC_ENABLED` (`apps/tenant-api`): when `false` (`0`, `off`,
  `no`, `disabled`), every public `/reservations/*` endpoint immediately returns
  `503`.
- `RESERVATIONS_SMS_ENABLED` (`apps/tenant-api`): when `false`, outbound
  reservation and waitlist SMS messages are dropped without queuing a backlog.
- `RESERVATIONS_EMAIL_ENABLED` (`apps/tenant-api` and `apps/app`): when `false`,
  outbound reservation emails are dropped without failing booking mutations.
- `RESERVATIONS_TICK_INTERVAL_SECONDS` (`apps/tenant-api` Node runtime):
  controls the interval between in-process regional reservation ticks (`0`
  disables the in-process timer while preserving the cron/DO alarm path).

## Consequences

- KSA guest PII never enters US logs, US D1, or Sites SSR memory.
- Every operator and public reservation route is mechanically verified by
  `apps/tenant-api/src/routes/reservations-security.test.ts` and
  `apps/app/app/utils/reservations/reservations-guards.test.ts`.
- Capacity and table-overlap guarantees hold both in application logic and at
  the SQLite trigger layer.
