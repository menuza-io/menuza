# Reservations API Contract

This document defines the HTTP and token contract between `apps/app`,
`apps/sites`, `apps/ios`, `apps/android`, `apps/voice-agent`, `apps/jobs-cron`,
and the regional `apps/tenant-api` for the Reservations module.

Shared Zod schemas and TypeScript types live in `@repo/reservations`.

## 1. Operator token (`rsv+jwt`)

Minted by `GET /<orgSlug>/reservations/token?scope=<scope>` in `apps/app`.

- **Header:** `{ "alg": "HS256", "typ": "rsv+jwt" }`
- **Secret:** `TENANT_OPERATOR_TOKEN`
- **Audience (`aud`):** `'tenant-api-reservations'`
- **Scopes (`scp`):** `'book' | 'guests' | 'setup' | 'reports' | 'payments'`
- **Claims:**
  - `sub`: operator `User.id`
  - `org`: `Organization.id`
  - `reg`: `'us' | 'ksa'` (must match the receiving `tenant-api` node's
    `DATA_REGION`)
  - `scp`: requested scope
  - `grants`: non-empty array of `ReservationsPermission` strings relevant to
    `scp`
  - `locationIds`: `null` (unrestricted across all organization locations) or a
    non-empty array of `OrganizationLocation.id` strings
  - `imp`: `true` when minted during support impersonation (omitted otherwise)
  - `iat`, `exp`: epoch seconds (`exp - iat <= 900` normally; `<= 300` when
    `imp: true` or when `grants` includes `read:guestbook:any`,
    `update:guestbook:any`, or `refund:reservations_payments:any`)

## 2. Internal & control-plane routes

| Method & Path                                      | Host              | Auth Header                                 | Purpose                                                                                                   |
| -------------------------------------------------- | ----------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `GET /resources/reservations/context?orgId=<id>`   | `apps/app`        | `X-Internal-Token`                          | Returns `ReservationsContext` (locations, flags, branding, payment accounts, `platformFeeBp`).            |
| `POST /internal/reservations/context-changed`      | `apps/tenant-api` | `X-Internal-Token`                          | Evicts the cached `ReservationsContext` for `orgId` and syncs location time zones if needed.              |
| `POST /internal/reservations/erase-customer`       | `apps/tenant-api` | `X-Internal-Token`                          | Scrubs guest PII, cancels active reservations/holds/waitlist, and nulls `rsv_reservation_events.payload`. |
| `POST /api/reservations/tick`                      | `apps/tenant-api` | `X-Internal-Token`                          | Runs the regional per-organization tick (expired holds/waitlist/requests, reminders, auto-no-show).       |
| `POST /api/voice/actions/reservation-availability` | `apps/tenant-api` | `Authorization: Bearer <VOICE_AGENT_TOKEN>` | Voice agent availability check and slot search.                                                           |

## 3. Operator routes (`/operator/reservations/*` on `apps/tenant-api`)

All operator routes require `Authorization: Bearer <rsv+jwt>` verified by
`rsvGuard({ scope, anyOf, locationFrom })`. Cross-organization and out-of-scope
`locationId` requests fail closed with `403`.

| Scope      | Base Path                             | Required Grants                                                       |
| ---------- | ------------------------------------- | --------------------------------------------------------------------- |
| `setup`    | `/operator/reservations/setup/*`      | `read:reservations_settings:any` / `update:reservations_settings:any` |
| `setup`    | `/operator/reservations/experiences*` | `read:reservations_settings:any` / `update:reservations_settings:any` |
| `book`     | `/operator/reservations/book/*`       | `read:reservations:any` / `update:reservations:any`                   |
| `book`     | `/operator/reservations/waitlist*`    | `read:reservations:any` / `update:reservations:any`                   |
| `guests`   | `/operator/reservations/guests*`      | `read:guestbook:any` / `update:guestbook:any`                         |
| `reports`  | `/operator/reservations/reports/*`    | `read:reservations_reports:any`                                       |
| `payments` | `/operator/reservations/payments/*`   | `refund:reservations_payments:any`                                    |

## 4. Public guest routes (`/reservations/*` on `apps/tenant-api`)

Called browser-direct from `apps/sites` or native customer apps. Checked against
the `RESERVATIONS_PUBLIC_ENABLED` kill switch (`503` when disabled) and the
organization's `reservations.enabled` / `reservations.online` flags (`404` when
disabled).

The organization is resolved from a verified customer Bearer JWT or from the
request `Origin` header + site slug/host — never from a client-supplied `orgId`.

| Method & Path              | Purpose                                                               |
| -------------------------- | --------------------------------------------------------------------- |
| `GET /reservations/config` | Public location list, time zones, party size bounds, and experiences. |
| `POST /reservations/holds` | Creates an exclusive temporary table hold (`rsv_reservation_holds`).  |
