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

All 24 `rsv_*` tables live exclusively in the regional per-organization SQLite
database (`packages/tenant-db`):

- Configuration & floor plan: `rsv_location_settings`, `rsv_areas`,
  `rsv_tables`, `rsv_table_combos`, `rsv_table_combo_members`,
  `rsv_floor_elements`, `rsv_services`, `rsv_turn_times`, `rsv_pacing_rules`,
  `rsv_slot_overrides`, `rsv_date_overrides`, `rsv_policies`, `rsv_experiences`,
  `rsv_experience_occurrences`
- Guest CRM & bookings: `rsv_guests`, `rsv_guest_tags`, `rsv_guest_tag_links`,
  `rsv_reservations`, `rsv_table_occupancies`, `rsv_reservation_holds`,
  `rsv_table_blocks`, `rsv_waitlist_entries`, `rsv_reservation_events`,
  `rsv_day_versions`

The US control plane (`@repo/database`) stores **only**:

- Organization feature flags (`reservations.enabled`, `reservations.online`,
  `reservations.waitlist`, `reservations.payments`, `reservations.experiences`,
  `reservations.voice`) and `reservations.platform_fee_bp`
- Operator RBAC permissions (`read/update:reservations:any`,
  `read/update:guestbook:any`, `read/update:reservations_settings:any`,
  `read:reservations_reports:any`, `refund:reservations_payments:any`) and
  `UserOrganization.locationScope`
- Organization Locations (`OrganizationLocation`: id, name, slug, timezone,
  formatted address, coordinates, phone)
- Payment provider credentials (`OrganizationPaymentAccount`: connected account
  IDs and encrypted secrets, never guest card numbers or guest names)
- Published website reservation block configuration (which contains only
  structural layout options, never guest data)

### 2. Browser-direct operator access with scoped `rsv+jwt` tokens

App loaders and actions in `apps/app` never proxy reservation or guest payloads
through the US server. Instead:

1. Every `/<orgSlug>/reservations/*` loader and action calls
   `requireReservationsAccess(request, orgSlug, { section })` first (`404` when
   the master or section feature flag is off; `403` when the user lacks the
   required permission or has an empty intersected `locationScope`).
2. The browser fetches a short-lived HS256 operator JWT from
   `GET /<orgSlug>/reservations/token?scope=<book|guests|setup|reports|payments>`
   signed with `TENANT_OPERATOR_TOKEN` (`typ: 'rsv+jwt'`,
   `aud: 'tenant-api-reservations'`).
3. Claims include `sub` (userId), `org` (orgId), `reg` (`us` | `ksa`), `scp`,
   `grants`, `locationIds` (`null` for unrestricted or a non-empty array of
   allowed `OrganizationLocation.id` values), and `imp` (`true` during support
   impersonation).
4. Token TTL is **15 minutes** for standard tokens and **5 minutes** when the
   token carries sensitive grants (`read/update:guestbook:any`,
   `refund:reservations_payments:any`) or `imp: true`.
5. Under support impersonation (`imp: true`), all write grants (`update:*`,
   `refund:*`) and guestbook/refund grants are stripped at mint time AND
   re-stripped by `rsvGuard` in `apps/tenant-api`.
6. The browser calls the regional `tenant-api` (`TENANT_API_URL` or
   `TENANT_API_URL_KSA`) directly with `Authorization: Bearer <token>`.

### 3. Public guest requests resolve organization from `Origin` + slug/host, never client `orgId`

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
  verified `rsv+jwt` `org` claim, returning `401` before touching any Durable
  Object when missing or invalid.

### 4. Non-PII organization context pull (`GET /resources/reservations/context`)

When `apps/tenant-api` needs control-plane metadata for an organization (active
locations and time zones, feature flags, website branding theme, payment
connection metadata, and `platformFeeBp`), it calls
`GET /resources/reservations/context?orgId=<id>` on `apps/app` authenticated
with `X-Internal-Token: <INTERNAL_COMMAND_TOKEN>`.

- The response is validated against `reservationsContextSchema` and contains
  **zero guest PII**.
- `apps/tenant-api/src/lib/reservations-context.ts` caches the response per
  `orgId` for **60 seconds** fresh and serves up to **5 minutes** stale if a
  refresh fails.
- When an operator updates locations, flags, branding, or payment accounts in
  `apps/app`, App posts `POST /internal/reservations/context-changed` to evict
  the regional cache immediately and sync location time zones.

### 5. Serialized per-organization write gate (`withReservationWrite`) and SQLite invariants

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
3. Database triggers in `0010_reservations_foundation.sql` enforce hard
   invariants as a second line of defense:
   - `trg_rsv_table_occupancies_no_overlap_insert` / `_update` abort with
     `RAISE(ABORT, 'table_overlap')` on any overlapping active occupancy for the
     same table (`start_at < existing.end_at AND end_at > existing.start_at`).
   - `trg_rsv_reservation_holds_no_overlap_insert` / `_update` abort with
     `RAISE(ABORT, 'hold_overlap')` when an active hold conflicts with another
     active hold or active table occupancy.
   - `trg_rsv_reservation_events_no_update` / `_delete` make
     `rsv_reservation_events` strictly append-only
     (`RAISE(ABORT, 'append_only')`).

### 6. Customer erasure and region switching

- When a customer exercises right-to-erasure
  (`POST /internal/reservations/erase-customer`), `rsv_guests` PII is scrubbed,
  active reservations/holds/waitlist rows are cancelled and scrubbed, and
  `rsv_reservation_events` rows have their `payload` scrubbed to `NULL` while
  preserving the append-only audit trail
  (`trigger trg_rsv_reservation_events_no_update` allows only `payload -> NULL`
  updates).
- Switching `Organization.dataRegion` follows ADR 045: the old regional tenant
  database is destroyed and a fresh database is provisioned in the new region.

## Consequences

- KSA guest PII never enters US logs, US D1, or Sites SSR memory.
- Every operator and public reservation route is mechanically verified by
  `apps/tenant-api/src/routes/reservations-security.test.ts` and
  `apps/app/app/utils/reservations/reservations-guards.test.ts`.
- Capacity and table-overlap guarantees hold both in application logic and at
  the SQLite trigger layer.
