# Tenant data residency

This is the canonical guide for **customer** data on organization public sites
(Astro `apps/sites`). Read it before adding auth, cookies, APIs, or database
fields that touch phone, name, or email collected on a tenant site.

Related: [ADR 045](./decisions/045-tenant-data-residency.md),
[Authentication](./authentication.md#tenant-sites-phone-authentication),
[Deployment](./deployment.md#regional-tenant-data-plane),
[Database](./database.md), [Secrets](./secrets.md).

## Two different auth systems

Do not mix these up.

| Who                           | Where they sign in         | Storage                      | Tokens                              |
| ----------------------------- | -------------------------- | ---------------------------- | ----------------------------------- |
| **Operators** (org staff)     | App (`apps/app`)           | US SQLite (`User`, sessions) | HttpOnly cookies via `@repo/auth`   |
| **Customers** (site visitors) | Tenant site (`apps/sites`) | Regional per-org SQLite      | JWT + refresh in **`localStorage`** |

Customer PII must never land in the US control-plane database, App session
cookies, Admin, or a Sites server-side auth proxy.

## Why this shape exists

App and Admin run in the US. KSA organizations require that customer PII is
neither **stored** nor **transited** through servers outside Saudi Arabia.

Sites SSR often stays in the US (it only renders CMS HTML). A Sites BFF that
proxies login/profile would pull KSA phone/name/email through US machines. The
browser therefore calls **that org’s regional tenant-api directly**.

## Topology

```
US (control plane)                         Regional data plane (US and/or KSA)
─────────────────                          ──────────────────────────────────
App, Admin                                 Tenant API  (US: CF Containers or OCI;
                                           KSA: OCI VM + block volume)
Control-plane SQLite                       Per-org SQLite  tenant_{orgId}.db
  org flags, CMS, billing                  customers (name, email, phone, hashes)
Sites SSR (CMS HTML only)  ─browser JS──►  In-region tenant-api (auth + PII)
                                           In-region SMS (Twilio is US-only)
```

| App         | Where it runs      | What it may see                                                                          |
| ----------- | ------------------ | ---------------------------------------------------------------------------------------- |
| App / Admin | US only            | Org metadata, site CMS, billing. **Not** customer phone/name/email.                      |
| Sites       | Often US (CMS SSR) | Public org JSON and HTML. Injects the regional API URL. **Must not** proxy customer PII. |
| Tenant API  | **Per region**     | Customer PII and auth. Rejects orgs whose `dataRegion` does not match `DATA_REGION`.     |

Never share one SQLite volume across US and KSA. Each region is an isolated
deployment (Cloudflare Container singleton for US, or OCI VM + block volume).

## What lives where

**US control-plane SQLite (`Organization`)** — flags only, not PII:

- `dataRegion` — `"us"` or `"ksa"` (default `"us"`)
- `hasProvisionedDb` — tenant SQLite exists in the current region
- `sitePublished`, slug, custom domain, CMS content

**Regional tenant SQLite** (`packages/tenant-db`, table `customers`):

- `name`, `email`, `phone`
- OTP hash + expiry (`phoneVerificationCode`, `phoneVerificationExpiresAt`)
- Refresh-token hash + expiry

App never reads or writes that table. Provision/deprovision send only routing
metadata: `{ orgId, slug, customDomain, dataRegion }`.

**Regional tenant SQLite, staff tables** (Staff module, see
[ADR 047](./decisions/047-staffing-data-residency.md)): `staff_members`,
`staff_private`, `staff_positions`, `staff_scope_assignments`, `staff_jobs`
(effective-dated pay), `staff_notes`, `staffing_settings`, `staff_audit_log`.
Staff names, contact details, pay, PINs and history exist **only** here. The US
control plane keeps just the permissions, the `staffing.*` flags, an opaque
staff id on `OrganizationInvitation.staffMemberId`, the `StaffingOutbox` (ids
only), the organization's staff time zone (`Organization.staffingTimeZone`) and
`JobPosting`. There are no member scope grants; the staffing token still carries
`scopeIds` (`null` = every scope) so a vertical can limit a member, and changes
lag by up to the 15-minute token lifetime, 5 for pay or private grants. Staff
rows are never `UserOrganization` rows and never change the seat count. All
staffing tables ship in one tenant migration, `0014_staffing_foundation`.

**Regional tenant SQLite, time clock tables**: `labor_policies`, `time_punches`,
`time_entries`, `time_breaks`, `time_entry_edits`, `timesheet_periods`,
`kiosk_devices`, `kiosk_pairing_codes`, `kiosk_attempts`. Punches, times and pay
snapshots exist only here. A paired kiosk tablet calls its region's tenant-api
directly (`/kiosk/*`, device secret in `localStorage`, no cookie, nothing
proxied through the US). The only thing tenant-api pulls from the US for it is
scope facts (time zone, name) from `/resources/staffing/scope-context`; no staff
data goes the other way. `STAFFING_KIOSK_ENABLED` switches the kiosk routes off
per node.

**Clock operations** (the regional staff tick): reminders and notices to staff
are emailed by tenant-api, which holds their contact data; they never pass
through the US. Manager alerts cross as one generic event
(`POST /resources/staffing/notify`: organization id, alert kind, scope id,
count, event id, validated by a strict schema that rejects any other field). The
App resolves recipients by permission and scope, applies each member's
notification preferences, and writes an in-app notification holding only the
kind, scope id and count; names, times and pay are read in the browser from the
regional node after the manager opens it. `STAFFING_EMAIL_ENABLED` stops the
email. See [Staff tick](scheduled-jobs.md#staff-tick).

**Regional tenant SQLite, schedule tables**: `shifts`, `schedule_weeks`,
`schedule_publications`, `shift_templates`, `staff_availability`,
`time_off_requests`, `shift_requests`, `schedule_settings`, `schedule_links`.
Who works when, and what a person asked for, exists only here. Publishing emails
each person from tenant-api, which holds their contact data. "My schedule"
(`/my-schedule` on the App host) is a static client page: the person's link
token sits in the URL fragment (never sent to a server), and the page calls its
own region's tenant-api directly (`/schedule-link/*`). The App only ever sees
counts (a manager alert with the organization id, kind, scope id and count).

**Regional tenant SQLite, labor tables**: `sales_manual_entries`,
`labor_scope_settings`, `tip_pool_settings`. Labor cost, the sales behind a
labor percentage and tip pools are computed in tenant-api from the regional time
card and shift data (and orders, when a vertical registers an order source) and
returned to the browser; the control plane never holds a wage, an hour or a
sales figure for a person. Reports that include staffing subjects
(`packages/reports`) run their staffing queries in tenant-api too; pay figures
need `read:staff_pay:any`.

**Regional tenant SQLite, hiring tables**: `hiring_applications`,
`hiring_events`, `hiring_interviews`, `hiring_notes`, `onboarding_tasks`,
`onboarding_templates`, `onboarding_template_tasks`, `staff_certificates`.
Applicant names, contact details, answers and notes exist only here. The US
control plane keeps the **public** job posting (`JobPosting`: title,
description, questions, closing date, no person data) because the careers page
needs it. The apply form posts **straight from the visitor's browser to the
regional node** (`POST /careers/apply`); the Sites server never sees an
applicant, and the organization comes from the browser `Origin`, never from a
client-sent id. A new applicant reaches managers only as the generic alert event
above. Declined applicants are purged by the regional tick after the
organization's retention period (365 days by default); the audit log is never
purged.

**Regional tenant SQLite, reservations tables** (Reservations module, see
[ADR 048](./decisions/048-reservations-data-residency.md) and the
[guide](./reservations.md)): 41 `rsv_*` tables (migration
`0016_reservations_foundation`, extended by `0017` to `0020`): guests
(`rsv_guests`, tags, notes, merges), reservations and their events, holds, table
occupancies, waitlist entries, notify-me requests, messages, payments, outbox,
location settings, floor plan, services, policies, experiences and the audit
log. **Guest data is guest PII:** names, phones, emails, dietary and allergy
notes, occasions, private staff notes, visit and no-show history and payment
references exist **only** in the regional database, and the rules are:

- Never in the control plane, logs, cross-plane payloads, Sites SSR or App
  loaders. The US control plane keeps the `reservations.*` flags, the eight
  permissions, `OrganizationLocation` rows, `UserOrganization.locationScope` and
  payment connection state. It receives only ids, counts, amounts, currencies
  and kinds (manager alerts, payment status, region summaries).
- Operators reach it browser-direct with a short-lived `rsv+jwt` (15 minutes; 5
  for guest or payment grants and impersonation); guests reach it browser-direct
  on `/reservations/*` with the organization taken from the `Origin` header
  only. Sites SSR never proxies it.
- Guests need no account: capability tokens (`rsv_m_`, `rsv_w_`, `rsv_n_`,
  `rsv_p_`) are derived by HMAC from `AUTH_HMAC_SECRET` and are not stored;
  links put the token in the URL fragment.
- Guest SMS is US node only (never KSA); email works in both regions. Validation
  errors never echo values.
- Payments: the region decides amounts and state, the US App is the only
  provider caller, and provider webhooks terminate at the App and forward ids
  and amounts only (ADR 048 section 8).
- Changing the region wipes the old reservations data (no migration), is blocked
  while payments are unsettled, and needs the organization slug typed when data
  exists or the count is unknown.
- Erasure is one flow (ADR 048, section 11): erasing a guest or a customer, from
  the operator routes or `/internal/reservations/erase-customer`, removes the
  person completely in one regional transaction (guests including merged ones,
  the linked customer row, subscriptions, tokens, order contact fields, waitlist
  and notify contact data, voice data, pending messages) and redacts event and
  audit payloads. `customer_subscriptions` is the only marketing consent store,
  and a guest links to a customer only through a verified phone.

## Code map

| Concern                                    | Path                                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Regional API (Hono)                        | `apps/tenant-api/src/index.ts`                                                                                |
| Customer auth routes                       | `apps/tenant-api/src/routes/auth.ts`                                                                          |
| Provision / wipe                           | `apps/tenant-api/src/routes/provision.ts`                                                                     |
| CORS + Origin → org                        | `apps/tenant-api/src/lib/origin.ts`                                                                           |
| `DATA_REGION` checks                       | `apps/tenant-api/src/lib/region.ts`                                                                           |
| JWT / HMAC / command token                 | `apps/tenant-api/src/lib/secrets.ts`                                                                          |
| Per-org SQLite + Drizzle                   | `packages/tenant-db/`                                                                                         |
| OTP SMS (Twilio blocked for KSA prod)      | `packages/sms/`                                                                                               |
| App → regional provision                   | `apps/app/app/utils/sites/tenant-api.server.ts`                                                               |
| Organization creation + provision          | `apps/app/app/utils/organization/organizations.server.ts`                                                     |
| Internal active-org metadata               | `apps/app/app/routes/resources+/tenant-organization.ts`                                                       |
| Publish + region switch UI                 | `apps/app/app/routes/_app+/$orgSlug_+/website+/_index.tsx`                                                    |
| Region dropdown + wipe dialog              | `apps/app/app/components/settings/cards/organization/site-card.tsx`                                           |
| Region switch: staff guard (dialog)        | `apps/app/app/components/staff/region-staff-guard.tsx`                                                        |
| Region switch: staff counts (App)          | `apps/app/app/routes/resources+/staffing.region-summary.ts`, `utils/staffing/region-guard.server.ts`          |
| Staffing outbox (link / unlink / erase)    | `apps/app/app/utils/staffing/outbox.server.ts`, `routes/resources+/jobs.staffing-outbox.ts`                   |
| Account erasure + access request (staff)   | `apps/app/app/utils/staffing/dsar.server.ts`                                                                  |
| Regional `/internal/staff` commands        | `apps/tenant-api/src/routes/staff-internal.ts`, `services/staff-internal-service.ts`                          |
| Time clock: kiosk + labor policy API       | `apps/tenant-api/src/routes/kiosk.ts`, `routes/timeclock.ts`, `services/punch-service.ts`                     |
| Timesheets: views, edits, approval, export | `apps/tenant-api/src/routes/timesheets.ts`, `services/timesheet-*.ts`, `packages/staffing/src/timesheet-*.ts` |
| Time clock: scope facts (App)              | `apps/app/app/routes/resources+/staffing.scope-context.ts`                                                    |
| Schedule API, publishing, my-schedule link | `apps/tenant-api/src/routes/schedule.ts`, `routes/schedule-link.ts`, `services/schedule-*.ts`                 |
| My schedule page (static, fragment token)  | `apps/app/app/routes/my-schedule.tsx`, `apps/app/app/components/my-schedule/`                                 |
| Labor summary, sales, tip pool             | `apps/tenant-api/src/routes/labor.ts`, `services/labor-*.ts`, `services/tip-pool-service.ts`                  |
| Staffing report subjects (regional)        | `apps/tenant-api/src/services/staffing-report-records.ts`, `packages/reports/src/catalog-staffing.ts`         |
| Careers apply, applicants, hire            | `apps/tenant-api/src/routes/careers.ts`, `routes/hiring.ts`, `services/hiring-service.ts`                     |
| Onboarding checklists and certificates     | `apps/tenant-api/src/routes/onboarding.ts`, `services/onboarding-service.ts`                                  |
| Public job postings (control plane)        | `apps/app/app/routes/resources+/sites.careers.ts`, `utils/hiring/job-postings.server.ts`                      |
| Careers pages (Sites)                      | `apps/sites/src/pages/careers/`, `apps/sites/src/lib/careers/`                                                |
| Staff tick (reminders, alerts, retention)  | `apps/tenant-api/src/routes/staff-tick.ts`, `services/staff-tick-service.ts`                                  |
| Public org JSON (`dataRegion` for Sites)   | `apps/app/app/utils/sites/public-org.server.ts`                                                               |
| Sites: pick public API URL                 | `apps/sites/src/lib/tenant-api.ts`                                                                            |
| Sites: browser session (`localStorage`)    | `apps/sites/src/lib/client-auth.ts`                                                                           |
| Sites: inject `data-tenant-api-url`        | `apps/sites/src/layouts/SiteLayout.astro`                                                                     |
| Login / verify / profile / complete-name   | `apps/sites/src/pages/login.astro`, `verify.astro`, `profile.astro`, `complete-name.astro`                    |

There is **no** `apps/sites/src/pages/api/auth/` BFF. Do not add one.

## Request flows

### Create an organization

1. App creates the organization, operator membership, and default home page. New
   organizations default to `dataRegion=us`; the organization creation API can
   explicitly select `us` or `ksa`.
2. App POSTs routing metadata to the regional tenant-api (`TENANT_API_URL` or
   `TENANT_API_URL_KSA`) with `Authorization: Bearer INTERNAL_COMMAND_TOKEN`.
3. That node checks `org.dataRegion === DATA_REGION`, then creates
   `tenant_{orgId}.db` and runs Drizzle migrations.
4. App sets `hasProvisionedDb = true` before reporting creation complete. The
   website remains unpublished. If provisioning fails, App attempts to remove
   any partially provisioned database and removes the newly created
   organization, allowing creation to be retried.

### Publish a site

Publishing changes the website's visibility, not the tenant database lifecycle.
For compatibility, publishing an older organization with
`hasProvisionedDb=false` provisions its database once before making the website
public. Already-provisioned organizations do not call tenant-api on publish.

### Resolve operator organization metadata

When `APP_URL` is configured, tenant-api reads active organization metadata from
App's authenticated `/resources/tenant-organization?orgId=...` endpoint using
`INTERNAL_COMMAND_TOKEN`. The endpoint works for unpublished organizations and
returns only routing flags, never customer data. App is authoritative even if a
node-local control-plane SQLite copy is missing or stale. Failed lookups do not
fall back to stale rows. A shared local control-plane database is used only when
no App origin is configured.

### Customer login

1. Sites SSR serves HTML. The layout sets `data-tenant-api-url`,
   `data-org-slug`, and `data-custom-host` from the org’s `dataRegion`.
2. Page JS (`client-auth.ts`) POSTs phone to `{tenantApiUrl}/auth/send-code`,
   then `/auth/verify`. New customers are asked for a name after the OTP;
   returning customers skip that. Org is bound from the request `Origin`, not a
   client-chosen `orgId`.
3. Tenant-api writes the customer row in that region’s SQLite and returns
   access + refresh JWTs.
4. The browser stores tokens in `localStorage` (`tenant_access_token`,
   `tenant_refresh_token`). They are **not** sent to Sites on navigation.

### Change customer data region

Operators can switch `dataRegion` after customers exist. PII is **not**
migrated.

1. If `hasProvisionedDb`, the UI requires an explicit confirm
   (`confirmWipe=true`). **Staff guard.** The dialog also asks the old region
   what staff data it holds (`GET /resources/staffing/region-summary`, which
   calls the node's `POST /internal/staff/summary`; counts only). When there is
   anything to lose, or the answer is unknown (node down, older node without the
   route, malformed reply: the guard fails closed), the admin must **type the
   organization slug**, and the dialog offers **Download staff backup**. The
   backup is a staff-scope token minted by the App, then
   `GET /operator/staff/export` on the **old region's node straight to the
   admin's browser**, saved as a local JSON file (`staff-export/v1`). Pay and
   private groups appear only if the admin's token carries those grants. The App
   action re-checks all of this server-side (`confirmText`), so a crafted
   request cannot skip the guard. The backup is offered, not required: if Staff
   is off or the admin cannot view staff the button explains why and the typed
   confirmation is still the gate.
2. App sets `hasProvisionedDb = false` before deprovisioning the **old** region.
   The control-plane database keeps the old `dataRegion` until the wipe
   succeeds, so retries still target the correct node.
3. App updates the control-plane database: new `dataRegion`,
   `hasProvisionedDb = false`.
4. App immediately provisions an empty DB in the new region and sets
   `hasProvisionedDb = true`, whether or not the site is published.
5. Existing visitors must sign in again. Old tokens are useless against the new
   empty database.
6. Staffing outbox events still pending for the organization are marked `failed`
   (`region_changed`): they addressed a database that no longer exists. Staff
   records are not moved; the new region starts with none.
7. **Reservations guard.** The dialog also asks the old region for reservations
   counts (`POST /internal/reservations/summary`; counts only). Unsettled
   reservation payments block the switch. When any reservations data exists, or
   the answer is unknown (fails closed), the admin must type the organization
   slug. Reservations, guests and waitlist entries are not moved.

### Staff login links, removal and erasure

Staff records are regional, logins are control-plane. Three events connect them,
carried by the **`StaffingOutbox`** (ids only, never a name, contact detail, pay
figure or time) to the regional node's `/internal/staff/*` routes
(`INTERNAL_COMMAND_TOKEN`; an operator token never works there):

| Trigger                                                                                      | Outbox kind   | Regional effect                                                                                           |
| -------------------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------- |
| An invitation sent from a staff profile (`OrganizationInvitation.staffMemberId`) is accepted | `link_user`   | `staff_members.user_id` set. Refuses to take over a row linked to another login or link a terminated row. |
| A member is removed (`remove-member`)                                                        | `unlink_user` | `user_id` cleared. **Not termination:** status, PIN, schedule and pay history are untouched.              |
| An account is erased (GDPR job, before the `User` row is deleted)                            | `erase_user`  | The linked row is anonymized (below).                                                                     |

Delivery is at-least-once and every endpoint is idempotent. The App tries once
right after enqueueing; the `jobs.staffing-outbox` route (the existing
`0 4 * * *` cron trigger, no extra slot) retries with exponential backoff (1
minute up to 24 hours, 20 attempts) and delivers a login's events in order. See
[scheduled jobs](./scheduled-jobs.md#staffing-outbox). Invite-link and
verified-domain joins create members with no staff link; linking is then manual.

**Erasure** (`erase_user`) replaces the names with a pseudonym, clears email,
phone, Arabic names, employee number and PIN lookups, deletes the private record
(birth date, address, emergency contact) and notes, deactivates assignments,
ends the employment (`terminated`, reason `erased`, not eligible for rehire, and
a rehire is refused) and redacts the before/after values in the person's
`staff_audit_log` rows. The log stays append-only: a trigger in
`0014_staffing_foundation` lets exactly one edit through, replacing a row's
`changes` with `{"redacted":true}`; every other column stays fixed and deletes
remain impossible. What is **kept** under the pseudonym: the effective-dated pay
history (wage records have a retention period that outlives an account) and,
later, time entries. Rows whose login was already unlinked are an employment
record of the organization, not of the account, and are not touched by an
account erasure.

**Access requests (DSAR).** `download-user-data` adds a `staffRecords` section.
A US-region record is generated in-region (`POST /internal/staff/export-user`)
and attached. A Saudi-region record is **not** fetched through the US servers:
the node refuses (`409 export_requires_regional_delivery`) and the file only
points the person to the organization, whose admins export it in-region with
`GET /operator/staff/export?staffId=...` (browser-direct). Admin's own DSAR
export has no regional read path and does not include staff records.

**Seats.** Staff rows never touch `UserOrganization` or the seat quantity. A
person with a login is a normal member and one seat (counted when they accept);
linking adds none; clock-only staff cost none. Regression tests:
`invitation.staff-link.test.ts`.

## Tenant-api surface

Browser CORS is allowlisted only for origins that resolve to an org in **this**
node’s `DATA_REGION` (slug subdomain or published custom domain).

| Method | Path                                                                                                            | Who                       | Notes                                                                                                                                                                                                      |
| ------ | --------------------------------------------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/health`                                                                                                       | Anyone                    | Returns `{ region }` for the node.                                                                                                                                                                         |
| POST   | `/auth/send-code`                                                                                               | Browser                   | Body: `phone`, optional `slug`/`host`. Same success for new and existing numbers (no enumeration).                                                                                                         |
| POST   | `/auth/verify`                                                                                                  | Browser                   | Issues JWTs. `needsName: true` when the customer has no name yet.                                                                                                                                          |
| POST   | `/auth/refresh`                                                                                                 | Browser                   | Rotates refresh token.                                                                                                                                                                                     |
| POST   | `/auth/logout`                                                                                                  | Browser                   | Clears refresh hash.                                                                                                                                                                                       |
| GET    | `/auth/me`                                                                                                      | Browser                   | Bearer access token.                                                                                                                                                                                       |
| POST   | `/auth/profile`                                                                                                 | Browser                   | Update name/email.                                                                                                                                                                                         |
| POST   | `/api/provision`                                                                                                | App only                  | `{ orgId, slug, dataRegion }`. Bearer `INTERNAL_COMMAND_TOKEN`.                                                                                                                                            |
| POST   | `/api/deprovision`                                                                                              | App only                  | Same payload. Deletes that org’s SQLite on this node.                                                                                                                                                      |
| POST   | `/internal/staff/summary`                                                                                       | App only                  | `{ orgId }` → counts only (region-switch guard).                                                                                                                                                           |
| POST   | `/internal/staff/link-user`                                                                                     | App only                  | `{ orgId, staffMemberId, userId }`. Idempotent.                                                                                                                                                            |
| POST   | `/internal/staff/unlink-user`                                                                                   | App only                  | `{ orgId, userId }`. Not termination.                                                                                                                                                                      |
| POST   | `/internal/staff/erase-user`                                                                                    | App only                  | `{ orgId, userId }`. Anonymizes the linked row.                                                                                                                                                            |
| POST   | `/internal/staff/export-user`                                                                                   | App only                  | `{ orgId, userId }`. US node only; the Saudi node answers 409.                                                                                                                                             |
| GET    | `/operator/staff/export`                                                                                        | Operator (staff token)    | Full regional export, browser-direct; pay/private by grant; needs an unrestricted token.                                                                                                                   |
| ANY    | `/operator/staff/*`, `/operator/timeclock/*`, `/operator/schedule/*`, `/operator/labor/*`, `/operator/hiring/*` | Operator (staff token)    | Browser-direct, short-lived scoped token minted by the App after the flag and permission checks. Every route refuses a missing, wrong-scope or grantless token (locked by `staffing-security.test.ts`).    |
| ANY    | `/kiosk/*`                                                                                                      | Paired tablet             | Device secret + PIN. Off per node with `STAFFING_KIOSK_ENABLED=false`.                                                                                                                                     |
| ANY    | `/schedule-link/*`                                                                                              | Staff (link token)        | Own schedule, own time cards, own requests. The token is in the page's URL fragment.                                                                                                                       |
| POST   | `/careers/apply`                                                                                                | Browser (public)          | Applicant form. Origin-resolved organization, Turnstile, honeypot, durable rate limits, consent.                                                                                                           |
| POST   | `/api/staff/tick`                                                                                               | App cron fan-out          | Bearer `INTERNAL_COMMAND_TOKEN`. Counts only. See [Staff tick](scheduled-jobs.md#staff-tick).                                                                                                              |
| ANY    | `/reservations/*`                                                                                               | Browser, native (public)  | Booking, manage, waitlist. Organization from `Origin` only; capability tokens in `X-Reservation-Token`. See the [contract](reservations-contract.md#4-public-guest-routes-reservations-on-appstenant-api). |
| ANY    | `/operator/reservations/*`                                                                                      | Operator (rsv token)      | Browser-direct, `rsv+jwt` minted by the App. Locked by `reservations-security.test.ts`.                                                                                                                    |
| ANY    | `/operator/people/*`                                                                                            | Operator (`people` token) | Customers screen, browser-direct: customers and reservation guests as one list, profile, edit, merge, erase. One token carries both facets as claims; locked by `operator-people.test.ts`.                 |
| POST   | `/internal/reservations/*`, `/api/reservations/*`                                                               | App, cron                 | `INTERNAL_COMMAND_TOKEN`: context-changed, erase-customer (complete erase), link-customers, summary, tick, payments bridge. Counts and ids only.                                                           |
| POST   | `/api/voice/actions/:name`                                                                                      | Voice agent               | `VOICE_AGENT_TOKEN`; US organizations only.                                                                                                                                                                |

Access tokens last 15 minutes. Refresh tokens last 30 days (stored hashed with
`AUTH_HMAC_SECRET`).

## Auth model (do not “fix” this)

Login, verify, profile, and logout run in **page JavaScript** against the
regional tenant-api. Tokens stay in `localStorage` so they are not sent to US
Sites on every page load.

Send-code and verify bind to the request `Origin`, not a client-supplied
`orgId`.

Tokens in `localStorage` are readable by XSS on the tenant origin. That is the
accepted tradeoff for keeping KSA PII off US Sites servers. Do **not**:

- Put customer tokens in cookies on the Sites host
- Add `apps/sites/src/pages/api/auth/*` (or any Sites server proxy of PII)
- Give Sites a `JWT_SECRET` so it can mint or verify customer sessions
- Store customer phone/name/email on control-plane `User` / `Organization`

## Local development

`npm run dev` starts **both** tenant-api nodes:

| Process          | Port | `DATA_REGION`                              | Script                           |
| ---------------- | ---- | ------------------------------------------ | -------------------------------- |
| tenant-api (US)  | 3007 | `us`                                       | `dev:tenant-api` (via `dev:all`) |
| tenant-api (KSA) | 3009 | `ksa`                                      | `dev:tenant-api:ksa`             |
| Sites            | 3008 | injects 3007 or 3009 from org `dataRegion` | `dev:sites`                      |

App defaults:

```
TENANT_API_URL=http://localhost:3007
TENANT_API_URL_KSA=http://localhost:3009
```

New orgs default to `dataRegion=us`. To validate KSA:

1. Restart `npm run dev` so both APIs and env values load.
2. Confirm the KSA node: `curl http://localhost:3009/health` should show
   `"region":"ksa"`.
3. On Website settings, set **Customer data region** to **Saudi Arabia (KSA)**
   (switching after customers exist **deletes** them; they are not migrated).
4. The region change provisions an empty database against port 3009. Publish
   when the site should become public.
5. On the tenant site, login/profile traffic should hit port 3009 (not 3007, and
   not any Sites `/api/*` path).

If `npm run dev` is already running without the KSA process:

```sh
npm run dev:tenant-api:ksa
```

Then restart App (or the whole `npm run dev`) so `TENANT_API_URL_KSA` is picked
up. SMS is mocked to the console on both nodes in development.

Shared local secrets (not for production) live in `.env.schema`:

- App + tenant-api `INTERNAL_COMMAND_TOKEN`
- Tenant-api `JWT_SECRET` (per node; Sites does not verify customer JWTs)
- Tenant-api `AUTH_HMAC_SECRET` (OTP / refresh hashing; **not** the provision
  token)

Local schema values contain `do-not-use-in-prod` and are rejected at tenant-api
startup in production.

## Production deployment

App and Admin stay on Cloudflare Workers in the US. **Tenant-api** is regional:

| Logical `dataRegion` | Where to run tenant-api                                                                 |
| -------------------- | --------------------------------------------------------------------------------------- |
| `us`                 | **Cloudflare Worker + Durable Objects** (default) or optional OCI Ashburn               |
| `ksa`                | OCI Saudi Arabia Central (Riyadh) `me-riyadh-1` (Always Free A1 in the **home** region) |

KSA customer PII must stay on the Riyadh OCI VM with a block volume — never on
Cloudflare Workers or US infrastructure. US tenant-api runs as a native Worker
with one SQLite-backed Durable Object per org, or on OCI if you set
`OCI_TENANT_US_HOST`.

Set home region to Riyadh when you create the tenancy. Always Free resources
cannot be created in Ashburn if Riyadh is home. AWS still has no generally
available Kingdom region; do not use Bahrain or UAE as a KSA stand-in.

OCI uses `linux/arm64`; Cloudflare Containers use `linux/amd64`. SQLite files
live at `TENANT_DB_DIR=/data/tenants` (OCI block volume or container disk). Run
a **single writer** per region. Leave LiteFS unset.

App stays in the US and only sends `{ orgId, slug, customDomain, dataRegion }`
to the matching regional URL. Set `APP_URL` on each tenant-api so it can resolve
org flags without the control-plane SQLite volume.

GitHub Actions builds both architectures and pushes to GHCR. CI always deploys
US to Cloudflare (`deploy-tenant-api-us-cf`) and KSA to OCI when
`OCI_TENANT_KSA_HOST` is set (`deploy-tenant-api-oci`). Sites still deploy to
Cloudflare Pages.

See [Deployment](./deployment.md#regional-tenant-data-plane) and the
[deployment checklist](./deployment-checklist.md).

### Required secrets (per regional tenant-api)

| Secret                   | Notes                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------ |
| `DATA_REGION`            | `us` or `ksa`. Startup fails otherwise.                                              |
| `JWT_SECRET`             | Signs customer access tokens. No default in production. Unique per region.           |
| `AUTH_HMAC_SECRET`       | OTP and refresh hashes. Different from `INTERNAL_COMMAND_TOKEN`.                     |
| `INTERNAL_COMMAND_TOKEN` | Same value as US App. ≥16 chars. Empty token is rejected.                            |
| `APP_URL`                | US App origin. Authoritative active-org metadata lookup, including unpublished orgs. |
| `DATABASE_URL`           | Control-plane SQLite for **org flags only** when available. Not customer PII.        |
| `TENANT_DB_DIR`          | Volume mount for `tenant_{orgId}.db` (production: `/data/tenants`).                  |
| `ROOT_APP`               | Brand domain used to map `{slug}.{ROOT_APP}` origins for CORS.                       |

Delivery address search and coverage quotes (`/delivery/places`,
`/delivery/quote`) also run on the regional tenant-api, with an optional
`GOOGLE_MAPS_API_KEY`: see [delivery-coverage.md](./delivery-coverage.md).

### App (US)

| Variable                 | Notes                                                                      |
| ------------------------ | -------------------------------------------------------------------------- |
| `TENANT_API_URL`         | US tenant-api origin.                                                      |
| `TENANT_API_URL_KSA`     | KSA tenant-api origin. Required before creating or switching to a KSA org. |
| `INTERNAL_COMMAND_TOKEN` | Must match every regional tenant-api.                                      |

### Sites

| Variable             | Notes                                                                           |
| -------------------- | ------------------------------------------------------------------------------- |
| `TENANT_API_URL`     | US tenant-api URL (injected into pages for browser calls).                      |
| `TENANT_API_URL_KSA` | KSA tenant-api URL. Safe on a US Sites instance — it is a URL, not a PII proxy. |
| `PUBLIC_APP_URL`     | US App, for CMS JSON (not PII).                                                 |

Sites must **not** call tenant-api with customer PII on the server. These URLs
are published into HTML on purpose so the browser can reach the right region.

### SMS

- **US:** Twilio (`TWILIO_*`) on the US tenant-api.
- **KSA:** Twilio is **blocked in production** (`DATA_REGION=ksa`). Plug in an
  in-kingdom provider before going live. Local KSA still mocks SMS.

### DNS

KSA org hostnames may still point at a US Sites app for CMS HTML. Customer auth
always goes to the KSA tenant-api from the browser. A mismatched API host is
safe: tenant-api returns 404/409 when `dataRegion !== DATA_REGION`.

## Troubleshooting

| Symptom                                | Likely cause                                                                                        |
| -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Login hits port 3007 for a KSA org     | Sites missing `TENANT_API_URL_KSA`, or org `dataRegion` still `us`.                                 |
| CORS 403 on login                      | Origin not a published slug/custom domain for an org in that node’s region.                         |
| `region_mismatch` on provision         | App called the wrong regional URL, or control-plane `dataRegion` does not match the node.           |
| Empty customers after a region change  | Expected. Wipe is the product behavior; there is no PII migration.                                  |
| Mailbox says organization not found    | Verify tenant-api `APP_URL` reaches App and both apps share `INTERNAL_COMMAND_TOKEN`.               |
| Production tenant-api refuses to start | Placeholder `do-not-use-in-prod` secrets, missing `DATA_REGION`, or short `INTERNAL_COMMAND_TOKEN`. |
| KSA OTP fails in production            | Twilio is blocked; configure in-kingdom SMS.                                                        |

### Website form submission retention and deletion

The regional tenant database remains the source of truth for website forms.
Published form definitions (name, description, field labels/types, and button
copy) are projected into the shared `SITES_DATA_KV` namespace so Sites can
render forms in the initial HTML without a regional request on every page view.
Page blocks store only the form ID. KV is updated when a form is published or
deleted and populated from tenant-api on a cache miss. It never contains form
responses or submitted customer values.

Website form submissions remain in the organization's regional tenant database.
The daily `form-submission-retention` job asks the matching regional tenant-api
to delete submissions older than 365 days; submission values never pass through
the US control plane. For a data-subject deletion request, an authorized
operator can delete one response with
`DELETE /operator/forms/:formId/submissions/:submissionId`. Deleting a form
still cascades to all of its submissions.
