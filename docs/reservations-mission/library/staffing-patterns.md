# Staffing patterns to copy for Reservations

What belongs here: the Staff module files, mechanisms and CI gates that
Reservations copies, with the reservations equivalent for each, plus the gotchas
those gates enforce.

What does NOT belong here: reservations domain logic (see `engine-notes.md`),
App UI conventions (see `app-ui-patterns.md`), Sites conventions (see
`sites-patterns.md`).

All paths are relative to `/home/factory-user/repos/menuza` and were verified to
exist. Copy the pattern, not the vocabulary: reservations is restaurant-specific
and may use restaurant words; staffing core must not.

## Superseded research

- The blueprint recommends a generic `bookings` core (`booking_*` tables,
  `bookings.*` flags, `@repo/bookings`). Superseded by mission decision 1: a
  restaurant-specific `reservations` module (`rsv_*` tables, `reservations.*`
  flags, `@repo/reservations`, audience `tenant-api-reservations-operator`,
  `typ: rsv+jwt`). See `architecture.md`.
- Name collisions to avoid regardless: tenant table
  `restaurant_order_reservations` (order inventory holds, migration
  `0011_restaurant_orders.sql`), `restaurant_orders.hold_expires_at`, the
  phone-agent `reservation` request type, and a `reservation` variable in
  `apps/tenant-api/src/routes/voice.ts`.
- The blueprint suggests report subjects `bookings` and `booking_guests_daily`;
  the mission fixes `bookings` and `waitlist_entries`.

## Flags

| Staffing                                                                                                                                                                                       | Reservations                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `packages/staffing/src/flags.ts` (`STAFFING_FLAG_KEYS`, `isFlagOn` = literal `true` only)                                                                                                      | `packages/reservations/src/flags.ts`: `reservations.enabled`, `.online`, `.waitlist`, `.payments`, `.experiences`, `.voice` |
| Child counts only while master on (`getStaffingFeatureState`)                                                                                                                                  | same fold                                                                                                                   |
| `ConfigFlag` table (`packages/database/src/schema.ts`), resolved by `getFeatureFlag(key, { organizationId, userId })` in `packages/common/src/feature-flags.server.ts` (user -> org -> system) | same; migration `0025` inserts system-level `false` rows for each key                                                       |
| Admin toggle `apps/admin/app/routes/_admin+/feature-flags.tsx`                                                                                                                                 | same page works (boolean, level organization)                                                                               |

A system-level `true` turns a feature on for every org; an org-level `false`
overrides it. Absent = off.

## Permissions and roles

- Strings and helpers: `packages/staffing/src/permissions.ts`
  (`STAFFING_PERMISSIONS`, `STAFFING_SENSITIVE_GRANTS`,
  `staffingTokenTtlSeconds`, `restrictGrantsForImpersonation`,
  `grantsSatisfying`). Reservations: `packages/reservations/src/permissions.ts`
  with 8 permissions: `read`/`update` on `reservation`, `reservation_guest`
  (sensitive), `reservation_settings`, `reservation_report`, plus
  `update:reservation_payment` (sensitive). Update implies read.
- Control-plane rows: `packages/database/drizzle/0022_staffing_foundation.sql`
  (`INSERT OR IGNORE INTO "Permission"`, ids
  `org_perm_<action>_<entity>_<access>`, context `organization`,
  `_OrganizationPermissionToRole` for `org_role_admin`). Reservations:
  `packages/database/drizzle/0025_reservations_foundation.sql` (latest existing
  is `0024_dashboards.sql`). Mirror rows in `packages/database/setup-roles.ts`.
- Mirror constants: `packages/auth/src/organization-permissions.server.ts`
  (`ORG_PERMISSIONS`).
- Tenant-assignable allow-list and implied reads:
  `apps/app/app/utils/organization/tenant-role-permissions.ts`.
- Role editor group hidden while the flag is off:
  `apps/app/app/components/roles/tenant-role-access-manager.tsx`. Presets:
  `apps/app/app/utils/staffing/role-presets.ts` (+ `.server.ts`). Reservations
  presets: Host, Reservations manager, Guest relations, Owner.
- Drift tests: `packages/staffing/src/permissions.test.ts`,
  `apps/app/app/utils/organization/tenant-role-permissions.test.ts`,
  `settings+/roles.staffing.test.ts`, `roles.presets.test.ts`. Existing custom
  roles get no new grants.

## Operator token (App mint -> tenant-api verify)

| Staffing                                                                                                                                                                                                                                                                                  | Reservations                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/app/app/utils/staffing/token.server.ts` `mintStaffingToken`, `SCOPE_POLICIES`, `selectGrantsForScope`                                                                                                                                                                               | `apps/app/app/utils/reservations/token.server.ts` `mintReservationsToken`, features folded into `SCOPE_POLICIES`                      |
| Route `staff+/token.ts` (`GET ?scope=`, `private, no-store`)                                                                                                                                                                                                                              | `reservations+/token.ts`                                                                                                              |
| Claims: `aud tenant-api-staff-operator`, `typ staff+jwt`, `role operator`, `region`, `orgId`, `sub`, `scope`, `grants`, `scopeIds`, `impersonated`; HS256 with `TENANT_OPERATOR_TOKEN`                                                                                                    | `aud tenant-api-reservations-operator`, `typ rsv+jwt`, scopes `book`/`guests`/`setup`/`reports`/`payments`, `locationIds`, `features` |
| TTL 15 min, 5 min with sensitive grants; capped on `exp - iat` in tenant-api                                                                                                                                                                                                              | same                                                                                                                                  |
| Verify: `apps/tenant-api/src/lib/staff-auth.ts` `authenticateStaffOperator` (bearer, secret >= 16 chars else 503, `jwtVerify` audience/issuer/typ/maxTokenAge, claim schema, lifetime cap, scope equality 403, region 409, active org 404, provisioned 404, re-strip impersonated grants) | `lib/reservations-auth.ts`                                                                                                            |
| Guard: `apps/tenant-api/src/lib/staff-guard.ts` `staffGuard(scope, label, { all, write }, handler)`; log-safe 500s                                                                                                                                                                        | `rsvGuard(scope, label, { all, write }, handler)` plus `locationIds` filtering (`allowsLocation(id)`; empty list = nothing)           |
| HTTP helpers: `apps/tenant-api/src/lib/staff-http.ts` (`NO_STORE`, `json`, `validationResponse`, `readJsonBody`, `OPAQUE_ID_PATTERN`)                                                                                                                                                     | reuse                                                                                                                                 |
| DO routing: `apps/tenant-api/workers/org-router.ts` `orgIdFromOperatorJwt` accepts listed audiences                                                                                                                                                                                       | add the reservations audience, or Workers answers 400 "Could not resolve tenant organization"                                         |

Canonical reservations strings live in code: the 8 permissions
(`read|update:reservation:any`, `read|update:reservation_settings:any`,
`read|update:reservation_guest:any`, `read:reservation_report:any`,
`update:reservation_payment:any`), the 6 flags
(`reservations.enabled|online|waitlist|payments|experiences|voice`), the claims
in the table above, and `Authorization: Bearer <INTERNAL_COMMAND_TOKEN>` for
App<->node calls are defined by `packages/reservations/src/permissions.ts` +
`token.ts`, `packages/database/drizzle/0025_reservations_foundation.sql` and
`packages/auth/src/organization-permissions.server.ts`. The repo docs
(`docs/permissions.md`, `docs/reservations-contract.md`,
`docs/reservations-plan.md`, ADR 048) were reconciled to this vocabulary by the
foundation fix commit `d835bc9e` (VAL-FND-024); an older vocabulary
(`read:reservations:any`, `read:guestbook:any`, `aud tenant-api-reservations`,
`imp: true`, `X-Internal-Token`, migration `0023`) exists nowhere in code. The
ADR's trigger prose is still ahead of the schema (it names non-existent
`rsv_holds_no_overlap_*`/`rsv_events_*` triggers and strings); 0016 is
authoritative.

Region URL: `resolveRegionalTenantApiUrls(region)` in
`apps/app/app/utils/tenant-api.server.ts`. CORS for App/Admin and tenant site
origins is global in `apps/tenant-api/src/app.ts` (`isAllowedAnalyticsOrigin` in
`src/lib/origin.ts`); App CSP `connect-src` already includes tenant-api
(`apps/app/app/utils/csp-frame-src.server.ts`).

## App client pattern

- `apps/app/app/utils/staffing/staff-client.ts` `createStaffClient` /
  `createStaffClientPool`: tokens in memory only, per scope, refresh 60 s early,
  shared in-flight mint, `cache: 'no-store'`, one retry after 401, typed errors.
- `apps/app/app/components/staff/staff-client-provider.tsx` mounted by
  `staff+/_layout.tsx`; `pool.forgetAll()` on unmount.
- Hooks: `apps/app/app/hooks/use-staff-client.ts` (`useStaffClient(scope)` ->
  `{ client, can, ready, unavailable }`, `useStaffQuery`),
  `use-staff-action.ts`.
- Per-area files in `apps/app/app/utils/staffing/`: `*-api.ts`, `*-types.ts`
  (Zod response schemas), `*-view.ts` (pure, tested), `*-errors.ts` (code ->
  copy), `*-access.server.ts`.
- Reservations equivalents: `utils/reservations/reservations-client.ts`,
  `hooks/use-reservations-client.ts`, `use-reservations-action.ts` (expected
  version, toast, reload on stale), `use-day-feed.ts` (ETag polling).
- Loaders return ids and flags only; all person data is fetched in the browser.

## App access layer and guard test

- `apps/app/app/utils/staffing/access.server.ts`:
  `requireStaffingAccess(request, orgSlug, { feature, anyOf })` order = active
  member, flag (404), permission (403), scope (403); returns ids only.
  Reservations:
  `requireReservationsAccess(request, orgSlug, { feature, anyOf, locationId? })`,
  location -> 403.
- Section requirement tables: `apps/app/app/utils/staffing/sections.ts`, shared
  by sidebar, loaders, tests.
- Nav: `apps/app/app/root.tsx` computes `staffingNav` with `cachified` (30 s,
  fail to hidden); `apps/app/app/components/app-sidebar.tsx` item definitions,
  group visibility, per-link filter; type in
  `apps/app/app/utils/staffing/nav.ts`.
- Guard test `apps/app/app/utils/staffing/staffing-guards.test.ts` is static
  source analysis: in every `staff+/` loader and action the first `await` must
  be followed within 120 chars by a `WRAPPERS` call; no
  `request.formData|json|text(` before it; no `clientLoader`/`clientAction`;
  resource routes with module prefixes call `requireInternalCommandAuth(` or
  `requireUserWithOrganizationPermission(` before any `db`/`fetch`; explicit
  `PUBLIC_ROUTES` map. Reservations needs its own `reservations-guards.test.ts`
  (the staffing one only scans `staff+/` and `staffing.*`).

## tenant-api structure

- One Hono app `apps/tenant-api/src/app.ts` for both runtimes. Middleware order:
  logging, body limit (1 MB, 8 MB `/api/*`), security headers (default
  `Cache-Control: no-store`), CORS, per-prefix in-memory rate limits
  (`/operator/*` 120/min), then mounts.
- Thin routes `routes/<area>.ts` (guard + Zod + `respond(result)`); services
  `services/<area>-service.ts` return
  `{ ok: true, value } | { ok: false, status, error }`. Example:
  `routes/hiring.ts`.
- Region: `src/lib/region.ts` (`getNodeRegion`, `orgMatchesNodeRegion`). Active
  org: `findActiveOrganizationById` in `src/lib/origin.ts`.
- Concurrency helpers: `src/lib/concurrency.ts` (`runExclusive`),
  `src/lib/sqlite-retry.ts` (`retryOnSqliteBusy`).
- Rate limits: `src/lib/rate-limit.ts` is an in-process LRU that resets per
  isolate or DO; limits that must hold are stored in the org DB.
- Audit: `src/services/staff-audit.ts` (`writeStaffAudit`, `diffFields`,
  `hashClientIp`, `describeStaffError`); reservations use `rsv_audit_log`.
- Runtimes: Node `src/index.ts` (`serve()`, `registerRestaurantOrderSource()`,
  `startStaffTickInterval()`); Workers `workers/index.ts` (edge fetch,
  provision, tick fan-out, `resolveOrgId`, header `X-Epic-Tenant-Org-Id`),
  `workers/tenant-org.ts` (`TenantOrg` DO), `workers/org-router.ts`,
  `workers/tenant-registry.ts`, `workers/bindings.ts`. Vertical registrations
  must run in both `src/index.ts` and `workers/index.ts`.

## Tenant DB conventions

- Schema `packages/tenant-db/src/schema.ts`; migrations
  `packages/tenant-db/drizzle/` (latest `0015_hiring_interested_scopes.sql`;
  reservations add `0016_reservations_foundation.sql`). Generate:
  `cd packages/tenant-db && npm run db:generate -- --name <name>`.
- Ids `text` UUID; `*_at` epoch milliseconds (older tables such as `customers`
  and `restaurant_orders` use seconds); `*_date` `YYYY-MM-DD`; money integer
  minor units + currency; multipliers basis points; enums with exported
  `*_VALUES`; control-plane ids opaque text without FK; sensitive data in
  separate columns or tables; colors are theme-token keys.
- Triggers are hand-appended to the generated SQL (drizzle-kit does not model
  them), separated by `--> statement-breakpoint`, and every trigger is asserted
  in a schema test. Example: `0014_staffing_foundation.sql` from line 743.
- Migrations apply lazily on first open to every org regardless of flags
  (`getTenantDb` in `packages/tenant-db/src/db.server.ts`; DO `ensureDb()` uses
  `workers/migrations.generated.ts`, git-ignored, regenerated by build,
  typecheck and `deploy:cf` via
  `apps/tenant-api/scripts/generate-do-migrations.mjs`). Keep migrations
  additive; deploy tenant-api first.
- Schema tests: `packages/tenant-db/src/*-schema.test.ts` (temp dir, libsql
  client, `migrate` in `beforeEach`, `expectRejectsWith(..., /append-only/)`).
- Reservation status columns still lag the canonical state machine:
  `packages/tenant-db/src/schema.ts` (`RSV_RESERVATION_STATUS_VALUES`) lists
  `pending_approval`/`disputed` and lacks `requested`/`partially_arrived`, and
  `apps/tenant-api/src/lib/reservations-write.ts:274-279,318` expires on
  `pending_approval`. No CHECK constraint enforces it, so nothing fails today,
  but a typed write of the canonical statuses through `@repo/tenant-db` will not
  compile until a later migration reconciles it. Canonical source:
  `packages/reservations/src/state-machine.ts`.
- `apps/tenant-api/workers/migrations.generated.ts` is git-ignored and generated
  only by tenant-api's build/typecheck, so a `@repo/tenant-db` test that reads
  it must generate it first (as
  `packages/tenant-db/src/reservations-schema.test.ts` does by running
  `apps/tenant-api/scripts/generate-do-migrations.mjs` when the file is absent)
  or live in a tenant-api-owned test whose task depends on the build.

## Public routes (careers pattern)

`POST /careers/apply` (`apps/tenant-api/src/routes/careers.ts`,
`src/services/careers-apply-service.ts`), check order: body limit, JSON parse,
honeypot (`website` non-empty -> same success answer), org from Origin
(`resolveOriginBinding`, `resolveOrganizationForBrowserAuth`; body slug/host
only in local dev), strict Zod, Turnstile (`verifyTurnstileToken` with
`expectedAction`, off without a secret), flag/context from the App via an
internal resource route with an LRU cache (`src/lib/job-posting-context.ts`: 60
s hits, 15 s misses, 503 when unreachable), durable limits in the org DB, HMAC
contact dedupe, consent recorded, generic outbox event.

Reservations: `/reservations/*` with an `org-router.ts` branch placed before the
generic `?orgId=` fallback, Turnstile actions `reservation-hold`,
`reservation-request`, `reservation-notify`, `waitlist-join`, honeypot
`website`, uniform 404, `RESERVATIONS_PUBLIC_ENABLED` -> 503. Capability links
follow `src/lib/schedule-link-auth.ts` but use HMAC-derived tokens stored as
hashes. Routing tests: copy `src/lib/careers-routing.test.ts`; mount test: copy
`src/routes/hiring-mount.test.ts`.

## Security sweep (tenant-api)

`apps/tenant-api/src/routes/staffing-security.test.ts` builds
`new Hono().route(prefix, router)` for each `OPERATOR_MOUNTS` entry, reads
`app.routes`, fills params, and asserts: 401 without token and with wrong secret
or audience; 403 for a grantless token in every scope value (`GRANTLESS_ALLOWED`
empty); no 5xx; `app.ts` contains every mount and no other staffing
`/operator/...` mount; every router file is listed in `ROUTERS`; each router's
tests match `CROSS_ORG` and `CROSS_SCOPE`; each route's last two fixed segments
appear in its tests; credential-less surfaces never 2xx (except
`PUBLIC_ON_PURPOSE = [/^\/careers(\/|$)/]`) and never 5xx other than 503.

Its regexes do not cover `/operator/reservations` or reservations files.
Reservations ships `src/routes/reservations-security.test.ts` with its own
mounts, router list, wrong-audience cases (staffing token, `tenant-api-operator`
token), wrong-scope, cross-org (`ORG_B`), cross-location (`locationIds`) and
capability-token cases.

Harness to copy: `apps/tenant-api/tests/staff-harness.ts` (`OPERATOR_SECRET`,
`ORG_A`, `ORG_B`, `makeOrg`, `mintStaffToken` that can forge every claim,
`stubStaffEnv`, `createStaffHarness`). Every suite mocks `../lib/origin.ts`
(`vi.mock` is hoisted per file).

## Cross-plane events

- Regional -> App: staff `notification_outbox` + `src/lib/manager-alerts.ts` ->
  App `POST /resources/staffing/notify`
  (`apps/app/app/routes/resources+/staffing.notify.ts`),
  `INTERNAL_COMMAND_TOKEN`, 8 s timeout, `redirect: 'error'`, strict
  `managerAlertEventSchema`
  `{ orgId, eventId, kind, scopeId, count, actorUserId? }`, retry on
  401/408/425/429/5xx, App answers 200 `skipped` for permanent failures.
  Reservations: `rsv_outbox` -> `/resources/reservations/notify` (ids, kind,
  counts only).
- App -> regional: control-plane `StaffingOutbox` +
  `apps/app/app/utils/staffing/outbox.server.ts`.
- Facts pulled by the node: `/resources/staffing/scope-context` (cached in
  `apps/tenant-api/src/lib/scope-context.ts`). Reservations: a reservations
  context route and a context cache
  (`apps/tenant-api/src/lib/reservations-context.ts`). Contract cache parameters
  are scope-context's: per-org LRU, fresh 5 min, stale 24 h, 30 s failure
  cooldown, 3 s timeout, `redirect: 'error'` (`architecture.md` §7.3,
  `VAL-FND-018`).
- Region switch: `/internal/staff/summary` counts ->
  `resources+/staffing.region-summary.ts` ->
  `components/staff/region-staff-guard.tsx`,
  `utils/staffing/region-guard.server.ts`. Reservations add
  `/internal/reservations/summary` and extend the guard (typed confirmation,
  refuse while payments are unsettled).

## Tick and alarm

- `apps/tenant-api/src/services/staff-tick-service.ts` `runStaffTickForOrg`
  (per-org lock -> `busy`, skips `flags_unknown`, `staffing_disabled`,
  `no_staff`, `region_mismatch`; `registerStaffTickTask`; caps 100 emails, 50
  manager groups).
- Drivers: jobs-cron hourly `TENANT_HOURLY_CRON = '0 * * * *'` in
  `apps/jobs-cron/src/index.ts` calls `invokeTenantStaffTick` (crons
  `["0 2 * * *","0 3 * * *","0 4 * * *","0 * * * *"]`, 4 of 5 free slots used:
  add to the hourly list, no new cron); Node `src/routes/staff-tick.ts` +
  `src/lib/staff-tick-interval.ts` (`STAFFING_TICK_INTERVAL_SECONDS`, default
  300, min 60, `0` off); Workers `handleStaffTickFanOut` in `workers/index.ts`
  and `maybeArmStaffAlarm` / `alarm()` in `workers/tenant-org.ts` with
  `isStaffActivityPath()` from `src/lib/staff-alarm.ts`.
- A DO has a single alarm. A second `setAlarm` would overwrite the staff alarm.
  Reservations generalize to `src/lib/org-alarm.ts` (modules `staff` and
  `reservations`, `armOrgAlarm` only moves earlier, clamp `now+30s..now+60min`,
  per-module failure counters, legacy key `staffTickOrgId` read as fallback for
  `orgAlarmOrgId`). Staffing alarm tests must stay green. Node interval
  `RESERVATIONS_TICK_INTERVAL_SECONDS` (default 120, min 60, `0` off).

## Email, SMS, kill switches

- `src/lib/tenant-email.ts` `sendTenantEmail` (OCI; pass `context` only for
  marketing). `src/lib/staff-email.ts`: plain HTML strings (no React in the DO),
  hex colors only, escape every value, EN and AR.
- `src/lib/email-switch.ts` reads `STAFFING_EMAIL_ENABLED` live from
  `process.env` (dropped, not held). App copy
  `apps/app/app/utils/staffing/email-switch.server.ts`. Env schemas:
  `apps/tenant-api/.env.schema`, `apps/app/.env.schema`, plus the AGENTS.md env
  list.
- `@repo/sms` logs `[SMS MOCK]` without credentials outside production and
  throws in production when `DATA_REGION=ksa`. Reservations SMS only when node
  region is `us`.
- Reservations switches: `RESERVATIONS_PUBLIC_ENABLED`,
  `RESERVATIONS_EMAIL_ENABLED`, `RESERVATIONS_SMS_ENABLED`,
  `RESERVATIONS_TICK_INTERVAL_SECONDS`.

## Seeds, reports, E2E, docs

- Seeds: `apps/tenant-api/scripts/seed-staffing.mjs` refuses
  `NODE_ENV=production` and runs each step via
  `varlock run -- tsx scripts/<step>.ts <slug> --enable`;
  `scripts/seed-staff.ts` resolves the org by slug, upserts the flag with
  `--enable`, provisions, and goes through real service functions (idempotent).
  Reservations: `npm run seed:reservations -w tenant-api -- <slug>`.
- Reports: `packages/reports/src/catalog-staffing.ts`,
  `packages/reports/src/operator-token.ts` (audience `tenant-api-operator`),
  `apps/app/app/utils/staffing/report-access.server.ts`,
  `apps/app/app/routes/_app+/$orgSlug_+/reports+/token.ts`,
  `apps/tenant-api/src/routes/analytics.ts`,
  `apps/tenant-api/src/services/staffing-report-records.ts` (audit per run). The
  reports token route checks `read:analytics:any`, which no role is granted
  (known issue in AGENTS.md).
- E2E: `apps/app/tests/e2e/staff-roster.test.ts` inserts `ConfigFlag` rows and
  stubs tenant-api with `page.route` and permissive CORS.
- Docs shape: `docs/staffing.md` (operator guide, runbook, kill switches,
  rollout, KSA checklist, demo data, CI security checks),
  `docs/decisions/047-staffing-data-residency.md` (last ADR number; reservations
  is 048), `docs/staffing-plan.md`.

## Gotchas enforced by tests and CI

1. Flag off -> 404; missing permission -> 403; every child loader and action
   calls the guard itself (parent loaders can be skipped on data requests).
2. Only literal `true` turns a flag on; children need the master.
3. tenant-api never checks flags or roles on token routes; the App must never
   mint for a disabled module; the token's `features` claim lets tenant-api
   refuse child-flag routes.
4. Audiences are distinct per principal; add any new audience to
   `workers/org-router.ts`.
5. Impersonation: read-only, no sensitive grants, enforced at mint and in
   tenant-api.
6. New prefixes escape the staffing sweep: ship a dedicated sweep.
7. Location (scope) filtering on every list and write; empty list means nothing.
8. Errors never echo values; Drizzle errors are never logged or returned;
   `Cache-Control: private, no-store`.
9. In-memory limits reset per isolate; persist limits that matter.
10. Public routes never trust a client org id.
11. Tenant migrations are lazy and additive; triggers asserted in schema tests.
12. Mixed timestamp units (ms vs seconds) when joining to `customers` or orders.
13. Cross-plane payloads are ids and counts through `.strict()` schemas.
14. Single DO alarm per org: generalize, do not add a second `setAlarm`.
15. Cron slots: piggyback on the hourly fan-out.
16. Kill switches read live from `process.env`; dropped, not queued.
17. SMS US only.
18. `packages/staffing/src/vocabulary.test.ts` forbids restaurant words in
    staffing core (`restaurant`, `location(s)`, `store`, `menu`, `food`,
    `kitchen`, ...). The demand-source registry change must keep it green:
    staffing says "visits"/"people", never "covers".
19. Register vertical adapters in both runtimes; tests that need them register
    explicitly (`apps/tenant-api/tests/order-source.ts`).
20. Region switch wipes regional data; show counts and require typed
    confirmation.
21. App E2E never runs tenant-api; regional behavior is covered by tenant-api
    Vitest.
22. No PII in App loaders, MCP tools or dashboards' server loaders.

## Reservations Book, Host Stand & Guest Backend Notes (`foh-book-and-host-backend`)

- **Routes & Services**:
  - `apps/tenant-api/src/routes/operator-reservations-book.ts` (mounted at
    `/operator/reservations/book`):
    - `GET /day?locationId=&date=` -> returns composite
      `ETag: "<locationId>:<date>:<dayVersion>:<settingsVersion>"`,
      `304 Not Modified` on `If-None-Match` match, and payload
      `{ etag, dayVersion, settingsVersion, locationId, businessDate, settings, areas, tables, combos, elements, services, specialDays, sectionLayouts, sectionAssignments, serviceNotes, reservations, blocks, holds, waitlist, tags, pacing, stats }`.
    - `GET /changes?locationId=&date=&sinceVersion=` ->
      `{ dayVersion, changed }`.
    - `GET /availability?locationId=&date=&partySize=&serviceId=&areaId=` ->
      `{ slots }` with `onlineBookable`, `staffBookable`, `pacingWarning`,
      `tableIds`, `combinationId`.
    - `GET /calendar?locationId=&month=YYYY-MM` ->
      `{ month, days, daysByDate }`.
    - `GET /overview?locationId=&date=&serviceId=` ->
      `{ stats, vips, allergies, allergyList, occasions, largeParties, specialRequests, paymentFlags, serviceNotes }`
      (allergy text redacted to `null` when operator lacks
      `read:reservation_guest:any`, while `hasAllergy: true` remains visible).
    - `GET/PUT/POST /service-notes` -> pre-service shift notes with
      `expectedVersion` (409 `stale_version`).
    - `GET/PUT/POST /section-assignments` (and `/sections/assignments`) ->
      per-service server section assignments (`staffId` and/or `serverLabel`).
    - `GET /guests?q=` and `GET /guests/:id/summary` -> convenience `book`-scope
      guest lookup and summary for the New Reservation modal and Reservation
      Detail Drawer.
    - `POST /reservations` and `POST /walk-ins` -> require `Idempotency-Key`,
      auto-assign best-fit tables (including `staff_only` and `walk_in_only`),
      support `overbook: true` + `overbookReason`, and serialize writes via
      `withReservationWrite`.
    - `GET /reservations/:id`, `PATCH /reservations/:id`,
      `POST /reservations/:id/assign` (`lock`, `unlock`, `swap`, soft reflow
      outside `freeze_min` returning `moves[]`, `overbook`),
      `POST /reservations/:id/status`, `POST /reservations/:id/undo` (30-min
      `finished -> seated` window + table occupancy re-check), `/contact`,
      `/running-late`, `/course`, `/notes`.
  - `apps/tenant-api/src/routes/operator-reservations-guests.ts` (mounted at
    `/operator/reservations/guests`, scope `guests`):
    - `GET /`, `POST /`, `GET /:id`, `GET /:id/summary`,
      `GET /:id/export?includeSensitive=1`, `POST /:id/erase`.
  - `apps/tenant-api/src/routes/operator-reservations-setup.ts`:
    - Added `GET/POST /locations/:id/sections` and
      `PATCH/DELETE /locations/:id/sections/:layoutId` (enforcing
      `table_in_multiple_sections`).
  - `apps/tenant-api/src/routes/reservations-internal.ts` &
    `apps/app/app/routes/resources+/reservations.region-summary.ts`:
    - `POST /internal/reservations/summary`,
      `POST /internal/reservations/location-summary`, and
      `GET /resources/reservations/region-summary?organizationId=`.
- **Token Claims Gotcha**:
  - `mintReservationsToken` in `apps/app/app/utils/reservations/token.server.ts`
    includes `read:reservation_guest:any` in `grants` (and `canReadGuest: true`)
    on `scope=book` tokens when the user has `read:reservation_guest:any`, so
    `GET /book/day` and `GET /book/overview` know whether to include or redact
    guest allergy text (`VAL-BOOK-020`). `reservations-auth.ts` strips extra
    helper claims before `.strict()` schema parsing.

## Scrutiny findings — foh-core (round 1 at 403e6c0c; re-verified in round 2 at a255e6e8 / 275d4b30)

Round 2 confirmed every round-1 finding below is resolved. The facts that are
still true, plus new round-2 facts:

- Setup writes now run through `withSetupWrite` (AsyncLocalStorage transaction
  context) → `withReservationWrite`: one serialized SQLite transaction per
  mutation, rollback on error, version checks inside the lock
  (`operator-reservations-setup.ts`, `rsv-setup-service.ts`,
  `rsv-setup-crud.ts`). Nuance: most setup CRUD passes the constant `'setup'` as
  the lock key (`reservations-write.ts:56`), not the org id, so setup writes
  serialize globally and not against org-keyed booking writes.
- `apps/tenant-api/scripts/seed-reservations.ts` is not typechecked
  (`apps/tenant-api/tsconfig.json` includes only `src/**` and `workers/**`) and
  Drizzle silently ignores object keys that are not table columns (it iterates
  the table's columns). Column names are correct at a255e6e8 (`sort`,
  `body`/`updatedBy`, `arrivedCovers`/`guestRequests`/`staffNotes`); still
  verify seeded field values with `sqlite3`, not row counts.
- Validation errors must never echo rejected values: use
  `readJsonBody`/`readQuery` from `apps/tenant-api/src/lib/http.ts` (or its
  `ECHOING_CODES`), not a local `parseBody`/`parseQuery` that always returns Zod
  messages.
- The day-feed ETag is `"<locationId>:<date>:<dayVersion>:<settingsVersion>"`.
  Only location-settings and floor-plan saves bump
  `rsv_location_settings.version`; other setup config writes do not, so an
  ETag-cached client can keep stale data after a config save.
- The contract paths exist at a255e6e8: `GET /book/conflicts`
  (`operator-reservations-book.ts:293`), `GET /book/reservations/:id/events`
  (:1065), and `POST .../contact-status` (:1372) / `.../course-status` (:1478)
  as aliases of `/contact` and `/course`.
- `POST /internal/reservations/location-summary` returns the location-scoped
  shape (`rsv-day-feed-service.ts:1893-1917`: `locationId`,
  `futureReservations`, `activeWaitlist`, `activeHolds`, `tables`, `canDelete`)
  matching the App's `locationReservationsSummarySchema`.
- `unlock`, `reflowLaterParties`, `skipPayment` and `paymentPolicyMode` are
  accepted by tenant-api at a255e6e8; the App does not yet call `/events` or
  send `skipPayment`/`paymentPolicyMode` (later milestones own those fields).
- `upsertServiceNotes` enforces `expectedVersion` (409 `stale_version`);
  `putSectionAssignments` runs inside `withReservationWrite` with audit and a
  day-version bump but still takes no version parameter.
- `covers_actual` is in `rsv_reservations` (0016 edited in place).
  `refreshReservationsTriggers` (`packages/tenant-db/src/migrations.ts:212`)
  adds it to an existing DB and is called by the Node/LibSQL path
  (`migrateTenantDb`) and `seed:reservations` — not by the Durable Object worker
  (`apps/tenant-api/workers/tenant-org.ts:43` runs only `migrate`), so a
  pre-existing DO would need a new numbered migration or a call to the helper
  before deploy.
- Status transitions read covers as
  `coversActual ?? covers ?? seatedPartySize ?? seatedCovers`
  (`rsv-booking-service.ts:2486-2510`); guest `visits`/`covers` counters bump on
  `finished`.
