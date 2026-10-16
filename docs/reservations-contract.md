# Reservations API Contract

This document defines the HTTP and token contract between `apps/app`,
`apps/sites`, `apps/ios`, `apps/android`, `apps/voice-agent`, `apps/jobs-cron`,
and the regional `apps/tenant-api` for the Reservations module.

Shared Zod schemas and TypeScript types live in `@repo/reservations`.

## 1. Operator token (`rsv+jwt`)

Minted by `GET /<orgSlug>/reservations/token?scope=<scope>` in `apps/app`.

- **Header:** `{ "alg": "HS256", "typ": "rsv+jwt" }`
- **Secret:** `TENANT_OPERATOR_TOKEN`
- **Audience (`aud`):** `'tenant-api-reservations-operator'`
- **Scopes (`scope`):** `'book' | 'guests' | 'setup' | 'reports' | 'payments'`
- **Claims:**
  - `sub`: operator `User.id`
  - `role`: `'operator'`
  - `orgId`: `Organization.id`
  - `region`: `'us' | 'ksa'` (must match the receiving `tenant-api` node's
    `DATA_REGION`)
  - `scope`: requested scope
    (`'book' | 'guests' | 'setup' | 'reports' | 'payments'`)
  - `grants`: non-empty array of `ReservationsPermission` strings valid for
    `scope` (`SCOPE_GRANTS[scope]`)
  - `locationIds`: `null` (unrestricted across all organization locations) or a
    non-empty array of `OrganizationLocation.id` strings
  - `features`: `{ enabled, online, waitlist, payments, experiences, voice }`
    (`ReservationsFeatureState`)
  - `impersonated`: `boolean` (`true` when minted during support impersonation,
    `false` otherwise)
  - `iat`, `exp`: epoch seconds (`exp - iat <= 900` normally; `<= 300` when
    `impersonated: true` or when `grants` includes
    `update:reservation_payment:any`, `update:reservation_settings:any`, or
    `update:reservation_guest:any`)

## 2. Internal & control-plane routes

| Method & Path                                      | Host              | Auth Header                                      | Purpose                                                                                                   |
| -------------------------------------------------- | ----------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `GET /resources/reservations/context?orgId=<id>`   | `apps/app`        | `Authorization: Bearer <INTERNAL_COMMAND_TOKEN>` | Returns `ReservationsContext` (locations, flags, branding, payment accounts, `platformFeeBp`).            |
| `POST /internal/reservations/context-changed`      | `apps/tenant-api` | `Authorization: Bearer <INTERNAL_COMMAND_TOKEN>` | Evicts the cached `ReservationsContext` for `orgId` and syncs location time zones if needed.              |
| `POST /internal/reservations/erase-customer`       | `apps/tenant-api` | `Authorization: Bearer <INTERNAL_COMMAND_TOKEN>` | Scrubs guest PII, cancels active reservations/holds/waitlist, and nulls `rsv_reservation_events.payload`. |
| `POST /api/reservations/tick`                      | `apps/tenant-api` | `Authorization: Bearer <INTERNAL_COMMAND_TOKEN>` | Runs the regional per-organization tick (expired holds/waitlist/requests, reminders, auto-no-show).       |
| `POST /api/voice/actions/reservation-availability` | `apps/tenant-api` | `Authorization: Bearer <VOICE_AGENT_TOKEN>`      | Voice agent availability check and slot search.                                                           |

## 3. Operator routes (`/operator/reservations/*` on `apps/tenant-api`)

All operator routes require `Authorization: Bearer <rsv+jwt>` verified by
`rsvGuard({ scope, grant, anyOf, feature, write })`. Cross-organization and
out-of-scope `locationId` requests fail closed with `403`, and active
organizations without a provisioned regional database
(`hasProvisionedDb = false`) return uniform `404 { error: 'not_found' }`.

| Scope      | Base Path                             | Required Grants                                                     |
| ---------- | ------------------------------------- | ------------------------------------------------------------------- |
| `setup`    | `/operator/reservations/setup/*`      | `read:reservation_settings:any` / `update:reservation_settings:any` |
| `setup`    | `/operator/reservations/experiences*` | `read:reservation_settings:any` / `update:reservation_settings:any` |
| `book`     | `/operator/reservations/book/*`       | `read:reservation:any` / `update:reservation:any`                   |
| `book`     | `/operator/reservations/waitlist*`    | `read:reservation:any` / `update:reservation:any`                   |
| `guests`   | `/operator/reservations/guests*`      | `read:reservation_guest:any` / `update:reservation_guest:any`       |
| `reports`  | `/operator/reservations/reports/*`    | `read:reservation_report:any`                                       |
| `payments` | `/operator/reservations/payments/*`   | `read:reservation:any` / `update:reservation_payment:any`           |

## 4. Public guest routes (`/reservations/*` on `apps/tenant-api`)

Called browser-direct from `apps/sites` or native customer apps. Checked against
the `RESERVATIONS_PUBLIC_ENABLED` kill switch (`503` when disabled), the
organization's `hasProvisionedDb` flag (`404` when false), and the
organization's `reservations.enabled` / `reservations.online` flags (`404` when
disabled).

The organization is resolved from a verified customer Bearer JWT or from the
request `Origin` header + site slug/host — never from a client-supplied `orgId`.

| Method & Path              | Purpose                                                               |
| -------------------------- | --------------------------------------------------------------------- |
| `GET /reservations/config` | Public location list, time zones, party size bounds, and experiences. |
| `POST /reservations/holds` | Creates an exclusive temporary table hold (`rsv_reservation_holds`).  |
