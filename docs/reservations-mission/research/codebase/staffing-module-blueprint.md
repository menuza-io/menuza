# Staffing module blueprint (for a new regional, feature-flagged Reservations module)

Repository: `/home/factory-user/repos/menuza` (commit `5f61fd1c`). All paths
below are relative to the repo root unless absolute. Investigation was
read-only.

---

## (a) Summary

The Staff module is a **split-plane** module:

- **Control plane (US App/Admin, `@repo/database`)** holds only: org-level
  feature flags (`ConfigFlag` rows), permission rows and role grants, a few org
  settings (`Organization.staffingTimeZone`), public content (`JobPosting`), and
  an ids-only outbox (`StaffingOutbox`). The App decides _who may ask_ and mints
  a short-lived HS256 JWT.
- **Regional data plane (`apps/tenant-api` + `packages/tenant-db`)** holds every
  byte of person data. The browser calls tenant-api **directly** with the
  App-minted token. tenant-api never reads flags or roles; it trusts only
  App-minted tokens (audience `tenant-api-staff-operator`, `typ: staff+jwt`, one
  `scope`, `grants`, `scopeIds`, max 15 min / 5 min for sensitive grants).
- **Shared domain package (`packages/staffing`, `@repo/staffing`)** holds flag
  keys, permission strings, Zod API schemas, token claim schema, pure time math.
  No I/O, no UI strings, and a vocabulary test that forbids business-type words.
  A thin vertical package (`packages/staffing-restaurant`, 142 LOC) plus small
  adapters (`apps/tenant-api/src/restaurant/*`,
  `apps/app/app/utils/staffing/restaurant/*`) map restaurant locations onto
  opaque **scopes**.
- **Two CI security gates** read source and route tables:
  `apps/tenant-api/src/routes/staffing-security.test.ts` (every operator route
  refuses missing/forged/grantless tokens; mounts in `app.ts` are pinned; each
  router has cross-org and cross-scope tests) and
  `apps/app/app/utils/staffing/staffing-guards.test.ts` (every `staff+/`
  loader/action awaits `requireStaffingAccess` first; resource routes
  authenticate first; public routes are an explicit list).
- **Public regional surfaces** (`/careers/apply`, `/kiosk/*`,
  `/schedule-link/*`) never accept a client-chosen org id. The org comes from
  the browser `Origin` (careers) or from an org-prefixed opaque credential
  (kiosk, schedule link). Public routes check the flag indirectly by asking the
  App over an `INTERNAL_COMMAND_TOKEN` resource route.
- **Background work** is one idempotent per-org "tick" with three drivers:
  hourly jobs-cron fan-out (no new cron slot), a Durable Object alarm on the US
  Worker, and an in-process interval on Node (OCI). It has a task-registration
  extension point.

Size: roughly 11.2k LOC of domain code (+9.9k tests) in `@repo/staffing`; about
25k LOC of tenant-api source (routes, services, lib) and about 28k LOC of
tenant-api tests; about 1.8k lines of tenant schema plus a 998-line migration;
and about 47k LOC of App source (routes, components, utils) plus about 20k LOC
of App tests. See section 16.

---

## (b) Answers by question

### 1. Feature flags

**Keys**: `packages/staffing/src/flags.ts`

```ts
export const STAFFING_FLAG_KEYS = {
	enabled: 'staffing.enabled',
	timeclock: 'staffing.timeclock',
	scheduling: 'staffing.scheduling',
	labor: 'staffing.labor',
	hiring: 'staffing.hiring',
} as const
export function isFlagOn(value: unknown): boolean {
	return value === true
} // only literal true
```

`packages/staffing/src/permissions.test.ts` pins the keys and the `isFlagOn`
truth table (`'true'`, `1`, `{}` are off).

**Storage**: control-plane table `ConfigFlag`
(`packages/database/src/schema.ts:1317`): `key`, `value` (JSON text), `level`
(`system|organization|user`), `organizationId`, `userId`, unique on
`(key, level, organizationId, userId)`. No registration of keys is needed.

**Lookup**: `packages/common/src/feature-flags.server.ts`
`getFeatureFlag(key, { organizationId, userId })` resolves user -> organization
-> system. That means an explicit org-level `false` overrides a system-level
`true`, and a system-level `true` turns a feature on for every org.

**Default**: absent = off. Child flags count only while the master is on
(`getStaffingFeatureState` folds `master && raw.child`).

**Enforcement**: `apps/app/app/utils/staffing/access.server.ts`:

- `getStaffingFeatureState(orgId)`, `isStaffingFeatureEnabled(orgId, feature)`,
  and `requireStaffingFeature` (throws a **404**, so a module that is off looks
  like it does not exist).
- `requireStaffingAccess(request, orgSlug, { feature, anyOf })`. Order: active
  member (`requireUserOrganization`), flag (404), permission (403, a stronger
  grant satisfies a read), and scope (403 if limited to zero scopes). It returns
  ids only: `{ organizationId, userId, dataRegion, grants, scopeIds }`.
- `getStaffingNavAccess(userId, orgId)` drives the sidebar. It costs a single
  flag read when the master is off.
- **Token mint** (`apps/app/app/routes/_app+/$orgSlug_+/staff+/token.ts`) calls
  `requireStaffingAccess` with the section's requirement before signing.
  tenant-api does no flag lookup.
- **Machine paths** with no token (the tick, careers apply) ask the App:
  `apps/app/app/routes/resources+/staffing.scope-context.ts` returns `features`
  for the tick (`apps/tenant-api/src/lib/scope-context.ts` caches it), and
  `resources+/staffing.job-posting.ts` returns 404 when `staffing.hiring` is
  off.
- Public App/Sites content routes check the flag too:
  `apps/app/app/routes/resources+/sites.careers.ts` returns 404 unless the site
  is published and `staffing.hiring` is on.

**Toggling**:

- Admin UI: `apps/admin/app/routes/_admin+/feature-flags.tsx` +
  `apps/admin/app/components/admin/feature-flags.tsx` (type boolean, level
  organization, organizationId required).
- Seeds: `apps/tenant-api/scripts/seed-staff.ts` (and the other steps) accept
  `--enable`, which upserts the org-level `ConfigFlag` row.
  `npm run seed:staffing -w tenant-api -- <slug>` passes `--enable` to every
  step. `packages/database/seed-restaurant.ts` turns on all five flags when
  `SEED_STAFFING=1`. This is a standalone script and is not wired into any
  package.json script.
- E2E: tests insert or delete `ConfigFlag` rows directly
  (`apps/app/tests/e2e/staff-roster.test.ts`).
- No self-serve toggle exists yet (docs call it rollout stage S2).

**Local enablement for a developer**: either use the Admin Feature flags page
(key `reservations.enabled`, boolean `true`, level organization, the org id), or
copy the `--enable` upsert from `seed-staff.ts` into a `seed:reservations`
script.

### 2. Permissions / RBAC

- **Shared strings**: `packages/staffing/src/permissions.ts`
  `STAFFING_PERMISSIONS` holds 18 `action:entity:access` strings. It also
  defines `STAFFING_SENSITIVE_GRANTS` (pay and private grants, which get the
  shorter TTL), `staffingTokenTtlSeconds`, `restrictGrantsForImpersonation`
  (drops `update:`/`create:`/`approve:` and sensitive grants), and
  `grantsSatisfying` (update implies read at runtime, via the `STRONGER_GRANTS`
  table).
- **Control-plane mirror**:
  `packages/auth/src/organization-permissions.server.ts:213-233`
  (`ORG_PERMISSIONS.READ_STAFF_ANY`, ...).
- **Permission rows and built-in role grants**: control-plane migration
  `packages/database/drizzle/0022_staffing_foundation.sql`
  (`INSERT OR IGNORE INTO "Permission"` with ids
  `org_perm_<action>_<entity>_<access>`, context `organization`; then
  `_OrganizationPermissionToRole` gives `org_role_admin` everything and
  `org_role_member` only the two inert `own` grants). The same rows are in
  `packages/database/setup-roles.ts:283+` for fresh setups.
- **Custom roles**: existing custom roles deliberately get **no** staffing
  grants. Tenant-assignable ids are allow-listed in
  `apps/app/app/utils/organization/tenant-role-permissions.ts`, together with
  `STAFFING_IMPLIED_PERMISSION_IDS` (server-side "update implies read").
- **Role editor**:
  `apps/app/app/components/roles/tenant-role-access-manager.tsx` has groups with
  `staffing: true` (hidden unless `staffing.enabled`) and presets. Presets live
  in `apps/app/app/utils/staffing/role-presets.ts` and `role-presets.server.ts`.
- **Drift tests**: `packages/staffing/src/permissions.test.ts` (count = 18,
  format), `apps/app/app/utils/organization/tenant-role-permissions.test.ts`,
  `apps/app/app/routes/_app+/$orgSlug_+/settings+/roles.staffing.test.ts`, and
  `roles.presets.test.ts`.
- **App check**: `getUserOrganizationPermissions(userId, orgId)` from
  `@repo/auth`, wrapped by `requireStaffingAccess` and
  `userHasStaffingPermission`. Section requirement tables live in
  `apps/app/app/utils/staffing/sections.ts` (`STAFF_SECTION_REQUIREMENTS`,
  `*_WRITE_REQUIREMENT`), shared by the sidebar, loaders and tests.
- **Docs**: `docs/permissions.md` section "Staffing permissions" and "Feature
  flags".

### 3. Operator token flow

**Mint (App)**: `apps/app/app/utils/staffing/token.server.ts`
`mintStaffingToken()`.

```ts
const claims = { aud: STAFFING_TOKEN_AUDIENCE /* 'tenant-api-staff-operator' */, role: 'operator',
  region /* 'us'|'ksa' */, orgId, sub: userId, scope /* staff|schedule|timeclock|labor|hiring */,
  grants, scopeIds /* null = all */, impersonated }
staffingTokenClaimsSchema.parse(claims)   // shared schema in packages/staffing/src/schemas.ts:182
new SignJWT(payload).setProtectedHeader({ alg: 'HS256', typ: 'staff+jwt' })
  .setAudience(...).setIssuer(brand.shortName).setSubject(userId)
  .setIssuedAt(iat).setExpirationTime(iat + ttl).sign(TENANT_OPERATOR_TOKEN)
```

- `SCOPE_POLICIES` lists which grants may ride in each token scope (for example
  `timeclock` adds `laborGrants` only while `staffing.labor` is on).
  `selectGrantsForScope` intersects that list with the grants the user holds.
- The regional URL comes from `resolveRegionalTenantApiUrls(region)`
  (`apps/app/app/utils/tenant-api.server.ts`; anything but `ksa` is `us`).
- **Route**: `GET /:orgSlug/staff/token?scope=<scope>`
  (`apps/app/app/routes/_app+/$orgSlug_+/staff+/token.ts`). It validates the
  scope, calls `requireStaffingAccess` with the section requirement, mints, and
  returns `{ jwt, tenantApiUrl, scope, grants, scopeIds, expiresAt }` with
  `Cache-Control: private, no-store`. Tests: `token.test.ts`,
  `token.location-scope.test.ts`,
  `apps/app/app/utils/staffing/token.server.test.ts`.

**Verify (tenant-api)**: `apps/tenant-api/src/lib/staff-auth.ts`
`authenticateStaffOperator(c, scope)`. Order:

1. Bearer token present, and the secret is at least 16 characters (503
   otherwise).
2. `jwtVerify` with audience, issuer, `HS256`, `typ`, required claims, and
   `maxTokenAge`.
3. Claim schema and `TENANT_ORG_ID_PATTERN`.
4. Explicit lifetime cap on `exp - iat` (900 s, or 300 s if sensitive).
5. `claims.scope === scope`, else 403 `Missing staff scope`.
6. `claims.region === node region`, else 409 `region_mismatch`.
7. `findActiveOrganizationById` (404), `orgMatchesNodeRegion` (409), and
   `hasProvisionedDb` (404).
8. Re-strip grants if impersonated.

It also exports `requireGrant`, `requireWriteGrant`, `hasGrant`, and
`scopeToScopes(auth)`, which returns `allows`, `filter` and `where(column)` (a
Drizzle predicate; an empty list becomes `0 = 1`).

- `apps/tenant-api/src/lib/staff-guard.ts`
  `staffGuard(tokenScope, label, { all: [grants], write? }, handler)` is the
  single wrapper every operator route uses. It runs auth, then the grant checks,
  then the impersonation write refusal, then `getTenantDb(orgId)`, then the
  handler. Errors become log-safe 500s (Drizzle messages quote bound values, so
  they are never logged or returned). Handler context:
  `{ db, auth, scope, ipHash }`.
- `apps/tenant-api/src/lib/staff-http.ts`: `NO_STORE`, `json()`,
  `validationResponse()` (never echoes rejected values for enum or literal
  codes), `readJsonBody(c, schema)`, and `OPAQUE_ID_PATTERN`.

**Durable Object routing** (`apps/tenant-api/workers/org-router.ts`
`orgIdFromOperatorJwt`) accepts both audiences (`tenant-api-operator` and
`STAFFING_TOKEN_AUDIENCE`) to pick the DO. A new module audience must be added
there.

**CORS** (`apps/tenant-api/src/app.ts` global middleware):
`isAllowedAnalyticsOrigin` (`src/lib/origin.ts`) allows the App and Admin
origins (`app.<brand>`, `admin.<brand>`, local equivalents, `APP_URL`) and
tenant site origins (subdomain or custom domain) whose org is in this node's
region. Preflight allows `GET, POST, PATCH, PUT, DELETE, OPTIONS`. The App CSP
`connect-src` already includes tenant-api origins
(`apps/app/app/utils/csp-frame-src.server.ts`).

**Client-side pattern (App)**:

- `apps/app/app/utils/staffing/staff-client.ts`
  `createStaffClient({ orgSlug, scope })`. Tokens are kept **in memory only**
  and cached per scope. They refresh 60 s before expiry, and concurrent callers
  share one in-flight mint. The client calls
  `${tenantApiUrl}/operator/${scope}${path}` with `cache: 'no-store'` and
  retries once after a 401 with a fresh mint. Errors are typed as
  `StaffApiError`. `createStaffClientPool(orgSlug)` holds one client per scope.
- `apps/app/app/components/staff/staff-client-provider.tsx` is mounted by
  `staff+/_layout.tsx`. It calls `pool.forgetAll()` on unmount, so a token never
  outlives a sign-out or org switch.
- `apps/app/app/hooks/use-staff-client.ts` provides `useStaffClient(scope)`
  (returns `{ client, can(permission), ready, unavailable }`) and
  `useStaffQuery(client, path | null, zodSchema)`. Writes go through
  `apps/app/app/hooks/use-staff-action.ts`.
- **Loaders return ids and flags only** (for example `team.tsx` returns
  `orgSlug`, scope lists, and booleans). All person data is fetched in the
  browser.
- Important: **a token scope maps one-to-one to a route group**
  `/operator/<scope>`. A new module adds new scopes, or better, its own audience
  and scope enum.

### 4. Tenant DB

- **Schema**: a single file, `packages/tenant-db/src/schema.ts` (2,891 lines).
  Staffing sections run from about line 1050 (`// 11b. STAFF`) to the end:
  staff, time clock (11c), scheduling (11d), labor, hiring, onboarding.
- **Conventions** (comment at `schema.ts:1051`):
  - `id: text().primaryKey().$defaultFn(() => randomUUID())`.
  - `*_at` columns are integers holding **epoch milliseconds UTC**, with
    `nowMs = sql\`(cast(strftime('%s','now') as integer) * 1000)\``. Older
    tables (customers, orders) use epoch **seconds**, so be careful.
  - `*_date` is `YYYY-MM-DD` in the scope time zone. Minutes are integers. Money
    is **integer minor units plus an explicit currency**. Multipliers are basis
    points.
  - Enums are `text('x', { enum: [...X_VALUES] })` with exported `*_VALUES`
    const arrays.
  - `scope_id` is plain text with **no foreign key** (lets a vertical introduce
    ids without a migration).
  - Control-plane ids (`user_id`, `created_by`) are opaque text without a
    foreign key.
  - Sensitive data goes in separate tables (`staff_private`) so roster queries
    cannot select it.
  - Colors are theme-token keys, never hex.
  - Partial unique indexes use `.where(sql\`... is not null\`)`.
- **Migrations**: `packages/tenant-db/drizzle/NNNN_name.sql` plus
  `drizzle/meta/_journal.json` and snapshots. Generate with
  `cd packages/tenant-db && npm run db:generate -- --name <name>` (drizzle-kit,
  `drizzle.config.ts`: schema `./src/schema.ts`, out `./drizzle`). Staffing
  landed as one large `0014_staffing_foundation.sql` (38 tables, 998 lines) and
  a small additive `0015_hiring_interested_scopes.sql`.
- **Triggers are hand-appended** to the generated SQL (drizzle-kit does not
  model triggers). Comment at `0014_staffing_foundation.sql:743`: "Append-only
  and integrity triggers ... by hand; the schema tests assert each one."
  Examples:
  - `staff_audit_log_no_delete` and `_no_update`. The latter allows only the
    redaction `changes = '{"redacted":true}'`.
  - `time_punches_no_update` and `_no_delete`.
  - `time_entry_edits_reason_required`.
  - `time_entries_no_overlap_insert`.
  - `kiosk_pairing_codes_single_use`.
  - `shifts_range_insert`.
  - `schedule_publications_no_update`.
  - Pattern:
    `CREATE TRIGGER x BEFORE UPDATE ON t WHEN NOT (... NEW.col IS OLD.col ...) BEGIN SELECT RAISE(ABORT, 't is append-only'); END;`
    separated by `--> statement-breakpoint`.
- **Runtime application**:
  - Node/OCI: `packages/tenant-db/src/db.server.ts` `getTenantDb(orgId)` opens
    `TENANT_DB_DIR/tenant_{orgId}.db` and **applies pending migrations on every
    first open** (`applyTenantMigrations` in `src/migrations.ts`: libsql
    migrator, `SQLITE_BUSY` retry, and a legacy baseline fix-up).
    `provisionTenantDb` (`src/migrate.server.ts`) adds create-if-missing with a
    per-org lock.
  - Durable Object: `apps/tenant-api/workers/tenant-org.ts` `ensureDb()` runs
    `migrate(drizzle(ctx.storage), durableSqliteMigrations)` using
    `apps/tenant-api/workers/migrations.generated.ts`. That file is generated by
    `apps/tenant-api/scripts/generate-do-migrations.mjs` from the journal and
    SQL, and it is **git-ignored** (`apps/tenant-api/.gitignore`). It is
    regenerated by `npm run build`, `typecheck` and `deploy:cf` (and
    `wrangler.jsonc` `build.command`). The local copy is currently stale (m0000
    to m0013 only); this is harmless because it is rebuilt on build.
  - Because migrations apply lazily to **every** org on first connection
    regardless of flags, they must be additive and must ship before the UI that
    needs them (`docs/staffing.md` Deploying).
- **Schema tests** (`packages/tenant-db/src/*-schema.test.ts`: staff,
  time-clock, time-card-review, schedule, labor-summary, hiring, onboarding,
  clock-ops, plus `adversarial.test.ts`, `schema.test.ts`). Pattern: a temp dir,
  `createClient({ url: 'file:...' })`, `drizzle(client, { schema })`, then
  `migrate(db, { migrationsFolder })` in `beforeEach`. Tests assert defaults,
  check constraints, and that triggers reject
  (`expectRejectsWith(db.delete(timePunches), /append-only/)`).

### 5. tenant-api structure

- `apps/tenant-api/src/app.ts` `createTenantApiApp()` is the single Hono app for
  both runtimes. Middleware, in order:
  1. Request logging.
  2. Body limit (1 MB, 8 MB for `/api/*`).
  3. Security headers (`nosniff`, `no-referrer`, CORP cross-origin, and default
     `Cache-Control: no-store`).
  4. CORS.
  5. Per-prefix in-memory rate limits (`/operator/*` 120/min; `/kiosk/pair`
     20/min; `/kiosk/*` 600/min; `/careers/*` 30/hour; `/schedule-link/*`
     240/min).
  6. Then the `app.route(...)` mounts. Staffing mounts are `/operator/staff`,
     `/operator/timeclock`, `/operator/schedule`, `/operator/labor`,
     `/operator/hiring` (with sub-routers `/onboarding` and `/certificates`
     inside `hiring.ts`), `/careers`, `/internal/staff`, `/kiosk`,
     `/schedule-link`, and `/api/staff` (tick).
- **Organization**: `routes/<area>.ts` holds thin Hono handlers built from
  `staffGuard(...)` + Zod (from `@repo/staffing`) + `respond(result)`.
  `services/<area>-service.ts` holds DB logic that returns a `Result` union
  (`{ ok: true, value } | { ok: false, status, error, message? }`). Example:
  `routes/hiring.ts` with `READ = { all: [P.READ_HIRING] }`,
  `WRITE = { all: [P.UPDATE_HIRING], write: true }`, and `idParam()` that maps a
  malformed id to the same 404 as an unknown one.
- **Region check**: `src/lib/region.ts` provides `getNodeRegion()` and
  `orgMatchesNodeRegion()`. Startup runs `assertDataRegion()` and
  `assertTenantApiSecrets()` (`src/lib/secrets.ts`).
- **"Active provisioned organization"**: `findActiveOrganizationById` in
  `src/lib/origin.ts` (control-plane DB on Node; on Workers the lookup goes
  through `APP_URL`). Checked in `assertStaffOrg` (404, 409, 404).
- **Rate limiting**: `src/lib/rate-limit.ts`
  `rateLimit(name, { windowMs, maxRequests })` uses an in-process LRU, which
  **resets per isolate or Durable Object**. Anything that must hold (PIN
  attempts, applications per org or address) is stored in the org's SQLite
  (`kiosk_attempts`, counts in `careers-apply-service.ts`).
- **Responses**: `{ error: '<short_code>', ...extra }` with
  `Cache-Control: private, no-store` (`staffError`, `kioskError`, `refuse`).
  Validation errors are
  `{ error: 'Invalid request', issues: [{ path, code, message? }] }`.
- **Audit**: `src/services/staff-audit.ts` provides
  `writeStaffAudit(db, event)`, `writeSystemAudit`, `writeKioskAudit`,
  `diffFields`, `readableSensitivities` (pay or private rows are readable only
  with the matching grant), `hashClientIp`, and `describeStaffError`. The table
  `staff_audit_log` is append-only, with `sensitivity` set to
  `standard|pay|private`.
- **Runtime split**:
  - Node: `src/index.ts` does `serve()`, `registerRestaurantOrderSource()` and
    `startStaffTickInterval()`.
  - Workers: `workers/index.ts` is the edge fetch. It handles provision and
    deprovision, fans out the tick, uses `resolveOrgId` to pick the DO, and
    forwards with the header `X-Epic-Tenant-Org-Id`.
  - `workers/tenant-org.ts` is the `TenantOrg` Durable Object, one SQLite store
    per org. It handles `fetch`, `maybeArmStaffAlarm`, and `alarm()`.
  - `workers/tenant-registry.ts` lists org ids. `workers/org-router.ts` maps
    path to org id. `workers/bindings.ts` defines the env bindings.
    `wrangler.jsonc` defines the DO classes.
  - **Vertical registration must happen in both entry points** (`src/index.ts`
    and `workers/index.ts` each call `registerRestaurantOrderSource()`).

### 6. tenant-api tests

- Vitest (`apps/tenant-api/vitest.config.ts`: globals, node, setup
  `tests/setup-env.ts`, 15 s timeout). Run with `npm test -w tenant-api`
  (`varlock run -- vitest run`).
- **Harnesses**: `apps/tenant-api/tests/staff-harness.ts` (plus `timeclock-`,
  `schedule-`, `labor-`, `hiring-`, `timesheet-harness.ts`, and
  `order-source.ts`):
  - Constants `OPERATOR_SECRET`, `ORG_A`, `ORG_B`.
  - `makeOrg(id)`.
  - `mintStaffToken({ orgId, scope, grants, scopeIds, impersonated, region, lifetimeSeconds, audience, typ, secret, issuer, extraClaims })`,
    which can forge every claim.
  - `stubStaffEnv(dir, region)` stubs `TENANT_DB_DIR`, `DATA_REGION`, the
    tokens, and `APP_URL`.
  - `createStaffHarness(orgIds)` creates a temp dir and calls
    `provisionTenantDb` for each org. It mounts the router on a bare `Hono` and
    returns `request(method, path, { token, body })` and `cleanup()`.
  - Every suite declares `vi.mock('../lib/origin.ts', ...)` so
    `findActiveOrganizationById` returns `orgs.get(id)`, because Vitest hoists
    mocks per file.
- **Adversarial files**: `staff.adversarial.test.ts`,
  `kiosk.adversarial.test.ts`, `schedule.adversarial.test.ts`,
  `timesheets.adversarial.test.ts`, `staff.scope-limit.test.ts` (cross-scope).
- **Security sweep** (`apps/tenant-api/src/routes/staffing-security.test.ts`)
  **enumerates routes automatically** from the routers
  (`new Hono().route(prefix, router)` then `app.routes`), with path params
  filled by `fill()`.
  1. Every route returns 401 with no token, and 401 for a wrong secret or
     audience. Every route returns 403 for a grantless token in **every**
     `STAFFING_SCOPES` value (an explicit `GRANTLESS_ALLOWED` list, currently
     empty). Nothing returns 5xx. The matrix must hold more than 100 routes.
  2. `app.ts` source contains each `OPERATOR_MOUNTS` and `OTHER_MOUNTS` prefix,
     and **no other**
     `/operator/(staff|timeclock|schedule|labor|hiring|onboarding|timesheets|payroll|tips)`
     mount exists.
  3. `ROUTERS` lists every staffing route file. A file named with a staffing
     prefix but missing from the list fails. Each router's test files (matched
     by name prefix) must match the regexes `CROSS_ORG` (`ORG_B|cross org|...`)
     and `CROSS_SCOPE` (`scopeIds|another scope|...`). Each operator route's
     last two fixed path segments must appear on one line in its router's tests.
  4. Credential-less surfaces never return 2xx with no credential (except
     `PUBLIC_ON_PURPOSE = [/^\/careers/]`) and never 5xx other than 503.
- **What a new module must add**: its own `<module>-security.test.ts` modeled on
  this one (its own `OPERATOR_MOUNTS`, `OTHER_MOUNTS`, `ROUTERS`, name-prefix
  regex and scope enum). Alternatively, generalize the sweep. The current
  regexes will **not** catch `/operator/reservations` or a `reservations.ts`
  file, so adding routes there silently escapes the staffing gate. Also add a
  `<module>-mount.test.ts` like `routes/hiring-mount.test.ts` (shared app:
  public route 404 without Origin, operator route 401) and a DO routing test
  like `src/lib/careers-routing.test.ts` / `staff-tick-routing.test.ts` (calls
  `resolveOrgId` from `workers/org-router.ts`).

### 7. Public / unauthenticated regional routes

**`POST /careers/apply`** (`apps/tenant-api/src/routes/careers.ts` +
`src/services/careers-apply-service.ts`). Check order:

1. Route-level `bodyLimit` (`CAREERS_APPLY_MAX_BODY_BYTES`).
2. JSON parse.
3. **Honeypot** (`body.website` non-empty) answers `201 { received: true }`, the
   same as a success.
4. **Org from Origin**: `resolveOriginBinding(origin)` must be `slug`, `custom`
   or `local-unbound`, then
   `resolveOrganizationForBrowserAuth(origin, { slug, host })`. Body slug or
   host is honored only for local dev and must not contradict a real Origin. App
   and Admin origins are refused. Must have `hasProvisionedDb` and match the
   node region; otherwise 404 `not_found`.
5. Strict Zod (`careersApplySchema`).
6. **Turnstile** via `@repo/common/turnstile`
   `verifyTurnstileToken({ secret, token, remoteIp: cf-connecting-ip, expectedAction: 'careers-apply', expectedHostnames: TURNSTILE_HOSTNAMES })`.
   It is off when no secret is configured (dev).
7. **Live posting and flag** from the control plane via
   `src/lib/job-posting-context.ts` `getLivePosting` -> App
   `GET /resources/staffing/job-posting` with `INTERNAL_COMMAND_TOKEN`. The App
   returns 404 if the flag is off; results are LRU-cached 60 s (15 s for
   misses); an unreachable App gives 503 `unavailable`.
8. **Durable limits** in the org DB: per-org per hour, and per keyed IP hash
   (`hashClientIp`) per hour and per day, giving 429.
9. Dedupe by HMAC of contact (`applicantContactHash` uses `hmacHash` with
   `AUTH_HMAC_SECRET`). A duplicate answers the same `received`.
10. **Consent recorded** (`consentAt`, `consentVersion` columns on
    `hiring_applications`).
11. A new applicant notifies managers only through a generic outbox event (id
    and count).

Worker routing: `org-router.ts` resolves `/careers/*` from Origin plus query
slug/host only, never from a body or query `orgId`. Unique-violation detection
uses `isUniqueViolation`. SQLite busy retries use `src/lib/sqlite-retry.ts`.

The **Sites** side (`apps/sites/src/pages/careers/*.astro`,
`src/components/careers/ApplyPanel.astro`, `src/lib/careers/apply-form.ts`): the
page fetches **public content** from the App (`fetchPublishedCareers` ->
`/resources/sites/careers`, which returns 404 unless published and the flag is
on). The form posts from the browser to `data-tenant-api-url`. The CSP
`connect-src` is in `apps/sites/src/lib/site-headers.ts`. Strings are in
`apps/sites/src/locales/*.po`.

**`/kiosk/*`** (`routes/kiosk.ts`, `lib/kiosk-auth.ts`,
`services/kiosk-*-service.ts`):

- The device secret is org-prefixed and opaque
  (`kdv1.<orgId>.<deviceId>.<random>`) and stored only as a keyed hash. The
  pairing code is single use, lasts 10 minutes, and is protected by a trigger.
- The org is parsed from the credential by `org-router.ts`
  (`parseKioskDeviceSecret`, `parseKioskPairingCode`). `assertKioskOrgOnUsNode`
  refuses unknown orgs **before** creating a DO.
- PIN attempt backoff is persisted per device (`kiosk_attempts`). Responses
  include first names only.
- The env kill switch `STAFFING_KIOSK_ENABLED` is read live from `process.env`;
  when off, every route returns 503.
- An operator token is never accepted here.

**Pattern for public booking**: copy careers.

- Org from Origin only, with an `org-router.ts` branch.
- Honeypot, then Turnstile with its own action (for example `reservation-book`).
- A flag and config check via an App internal resource route with a short LRU
  cache, or a regional mirror of public availability settings.
- Durable per-org, per-address and per-contact limits in the org DB.
- HMAC-keyed contact dedupe, and uniform answers that do not reveal existence.
- Consent and version columns.
- Generic outbox event to managers.
- A management link for the guest modeled on `/schedule-link/*` (256-bit secret,
  org-prefixed, revocable, rate-limited); see `lib/schedule-link-auth.ts` and
  `services/schedule-link-service.ts`.
- Signed-in customers could alternatively use the existing customer JWT
  (`orgIdFromCustomerJwt`, audience `tenant-api`, issuer `brand.slug`,
  `routes/auth.ts`).

### 8. App side

**Routes**: `apps/app/app/routes/_app+/$orgSlug_+/staff+/` (31 non-test files):

- `_layout.tsx` (guard with `feature: 'enabled'` and
  `STAFF_SECTION_PERMISSIONS`, `ScopeWordingProvider`, `StaffClientProvider`)
  and `_index.tsx`.
- `team.tsx`, `team.new.tsx`, `team.import.tsx`, `team.bulk.tsx`,
  `team_.$staffId.tsx` (+ `.terminate`, `.rehire`), `positions.tsx`,
  `invite.ts`.
- `timeclock.tsx`, `timeclock._index.tsx`, `timeclock.rules.tsx`,
  `timeclock.tablets.tsx`, `timeclock.timesheets(.new|.$entryId).tsx`.
- `schedule.tsx`, `schedule._index.tsx`, `schedule.availability.tsx`,
  `schedule.time-off.tsx`.
- `labor.tsx`.
- `hiring.tsx`, `hiring._index.tsx`, `hiring.new.tsx`, `hiring.$postingId.tsx`,
  `hiring.applicants(.$applicationId).tsx`, `hiring.onboarding.tsx`.
- `token.ts`.
- Plus per-area `*-routes.test.ts`.

**Resource routes**:
`apps/app/app/routes/resources+/staffing.{notify,job-posting,scope-context,region-summary}.ts`,
`jobs.staffing-outbox.ts`, `sites.careers.ts`.

**Public shells**: `routes/kiosk.tsx`, `kiosk._index.tsx`, `kiosk.pair.tsx`,
`my-schedule.tsx`.

**Guard test** (`apps/app/app/utils/staffing/staffing-guards.test.ts`) is
**static source analysis**:

- `exportedFunctionBody(source, 'loader'|'action')` does brace matching.
- The first `await ` must be followed within 120 characters by a call matching
  `WRAPPERS`: `requireStaffingAccess`, `requireLaborAccess`,
  `requireScheduleAccess`, `requireTimesheetsAccess`, `requirePostingWriter`, or
  `runPostingAction`. Each wrapper is itself verified to call
  `requireStaffingAccess`.
- There must be no `request.formData|json|text(` before the guard, and no
  `clientLoader` or `clientAction`.
- Resource routes matching `/^(staffing\.|jobs\.(staffing|job-posting))/` must
  call `requireInternalCommandAuth(` or `requireUserWithOrganizationPermission(`
  before any `db`, `fetch` or `tenantFetch`.
- `PUBLIC_ROUTES` is an explicit map from path to reason. Any top-level `kiosk*`
  or `my-schedule*` route not in the map fails.
- A new module needs its own equivalent (for example
  `reservations-guards.test.ts`) with its own directory and prefixes. The
  staffing test only scans `staff+/` and `staffing.*`.

**Navigation**:

- `apps/app/app/root.tsx:411-433` computes `staffingNav` with `cachified` (30 s
  TTL, key `staffing-nav:<org>:<user>`). On failure it returns
  `HIDDEN_STAFFING_NAV`; it can only hide links, never grant access.
- `apps/app/app/components/app-sidebar.tsx:473-500` (item definitions), `:652`
  (group visibility), and `:684-697` (per-link filter; the group URL lands on
  the first visible link).
- The type lives in `apps/app/app/utils/staffing/nav.ts`.

**Module configuration**: lives inside the module (Time clock, Rules; Positions;
Tablets), not under `settings+/`. Cross-cutting settings touchpoints:

- `settings+/roles` (presets, staffing groups hidden while off).
- `settings+/notifications` (staffing alert preferences:
  `utils/staffing/notification-visibility.server.ts`,
  `components/settings/cards/notification-preferences-card.tsx`).
- `settings+/members` (location scope: `members.locations.test.ts`).
- `website+/_index` region switch (`components/staff/region-staff-guard.tsx`,
  `utils/staffing/region-guard.server.ts`, `region-backup.ts`,
  `region-confirmation.ts`).
- The notification bell (`components/ui/notification-bell.tsx`).

**i18n**: Lingui macros
`t\`...\``and`<Trans>`with`useLingui()`throughout routes and components. Catalogs are`apps/app/app/locales/{en,ar}.po` (`apps/app/lingui.config.ts`, `npm
run lingui:extract -w
app`). The domain package has **no UI strings**. tenant-api emails are hand-written en and ar HTML strings (`src/lib/staff-email.ts`).

**Shared UI**:

- `apps/app/app/components/staff/**` (roster, profile tabs, `schedule/*`,
  `timesheets/*`, `labor/*`, `onboarding/*`) and
  `apps/app/app/components/hiring/*`.
- Utilities in `apps/app/app/utils/staffing/*` (per-area `*-api.ts`,
  `*-types.ts` Zod response schemas, `*-view.ts` pure view models, `*-errors.ts`
  error-to-copy mapping, `*-access.server.ts` wrappers, `*-context.server.ts`).
- Hooks: `apps/app/app/hooks/use-staff-*.ts`.

### 9. Scope vocabulary and vertical split

- `DEFAULT_SCOPE_ID = 'main'` (`packages/staffing/src/scope.ts`). The generic
  module has exactly one scope per org, named after the org, with time zone
  `Organization.staffingTimeZone`. Pickers hide while there is one scope.
- Restaurant mapping:
  - `packages/staffing-restaurant/src/location-scope.ts` defines the member
    location scope `all|selected`, `memberLocationScopeInputSchema`, and
    `locationIdsClaim()`, which fails closed to `[]`.
  - The control-plane table `UserOrganizationLocation` and the
    `UserOrganization.locationScope` column come from migration
    `packages/database/drizzle/0023_staffing_restaurant_locations.sql`.
  - `apps/app/app/utils/staffing/restaurant/location-scopes.server.ts`
    `loadLocationScopes()` maps one scope per `OrganizationLocation` (scope id =
    location id, plus its tz and currency); it returns `null` if there are no
    locations, which falls back to generic `main`.
  - `apps/app/app/utils/staffing/scope-claim.server.ts`
    `resolveStaffingScopeIds()` produces the token's `scopeIds` claim.
  - `apps/app/app/utils/staffing/scope-wording.ts` and
    `components/staff/scope-wording-provider.tsx` say "location" versus
    "workplace".
- tenant-api vertical:
  - `apps/tenant-api/src/restaurant/staffing-order-source.ts` registers an
    `OrderSource` (counts and money per scope and 15-minute bucket from
    `restaurant_orders.location_id`, never a customer).
  - `apps/tenant-api/src/restaurant/staffing-report-catalog.ts` re-words report
    subjects.
  - `registerOrderSource(source)` in
    `apps/tenant-api/src/services/order-source.ts` is a **single-slot**
    registry.
- **Enforcement**: `packages/staffing/src/vocabulary.test.ts` uses
  `import.meta.glob(['./*.ts','!./*.test.ts'], { query: '?raw' })` and forbids
  `restaurant`, `location(s)`, `store(s)`, `menu(s)`, `dish`, `food`, `kitchen`,
  `dine-in`, `catering`, `chef`, and camelCase or snake_case `location` names.
  It also asserts `DEFAULT_SCOPE_ID === 'main'`. The phone agent has the same
  test (`packages/phone-agent/src/vocabulary.test.ts`, which also bans "order").
  It only covers the domain package. App and tenant-api generic code is policed
  by convention, with restaurant code confined to `restaurant/` folders.
- **Why**: `PRODUCT.md` "Brand Commitments" says committed files stay unbranded
  with "no vertical-specific branding ... Files must stay generic enough to sync
  to the upstream template repository". The git history shows this repo syncs
  from an upstream template (`chore: sync upstream main`).
- **Phone agent precedent** (`docs/phone-agent-verticals.md`):
  - `@repo/phone-agent` is the engine plus a `PhoneAgentVertical` contract
    (definitions, settings schema, data parser, tools, link handoff,
    placeholders).
  - `@repo/phone-agent-restaurant` adds menus, cart, hours, and the definitions
    `reservation` (call purpose and request type) and `reservations` (FAQ
    category).
  - The core's ids are string slugs, and the vertical merges its own lists
    first.
- **Assessment**: see section (c), item 0, and the return summary. In short, a
  **generic "bookings" core with a restaurant vertical** is feasible and is the
  only option that keeps the files syncable upstream. The concepts generalize
  well: capacity-based time-slot booking of resources, availability rules,
  holds, waitlist, guest profiles, no-shows, reminders, and the public widget.
  Floor-plan geometry, table combinations, turn times by party size, covers and
  pacing are restaurant-flavoured but can be expressed as neutral "resources",
  "capacity", "duration rules" and "per-slot limits", with the vertical
  supplying the words and defaults. Name collisions to avoid:
  - The existing tenant table `restaurant_order_reservations` (inventory holds
    for orders, migration `0011_restaurant_orders.sql`).
  - `restaurant_orders.hold_expires_at`.
  - The phone agent `reservation` request type, and a `reservation` variable
    inside `routes/voice.ts` (the SMS send precheck).
  - Prefer `booking_*` tables, the `bookings.*` flag namespace and the `booking`
    permission entities in the core.

### 10. Cross-plane events

- **Regional to App (manager alerts)**:
  - In-region queue: tenant table `notification_outbox` (`schema.ts:1804`;
    `dedupe_key` unique; `status`, `attempts`, `next_attempt_at`). This table is
    staff-specific (`staff_id NOT NULL`).
  - The tick groups due items and calls `src/lib/manager-alerts.ts`
    `sendManagerAlert(event)` -> App `POST /resources/staffing/notify`
    (`STAFFING_NOTIFY_PATH`) with `INTERNAL_COMMAND_TOKEN`, an 8 s timeout, and
    `redirect: 'error'`.
  - The contract is `managerAlertEventSchema`
    (`packages/staffing/src/clock-ops.ts:63`), `.strict()`:
    `{ orgId, eventId (hex), kind (enum), scopeId|null, count 1..10000, actorUserId? }`.
    **No staff id, name, time or pay.**
  - The App route (`apps/app/app/routes/resources+/staffing.notify.ts`)
    re-checks flags, resolves recipients by permission and scope, applies
    notification preferences, writes an in-app `Notification` (kind, scope,
    count), and sends `StaffingAlertEmail` (honoring the App's
    `STAFFING_EMAIL_ENABLED`). It is idempotent per event id and member, and
    returns 200 `skipped` for things that cannot succeed.
  - `RETRYABLE` statuses: 401, 408, 425, 429, 5xx.
  - Copy lives in `utils/staffing/manager-alert-copy.ts` and `alert-copy.ts`.
    Visibility filtering is in `notification-visibility.server.ts`.
- **App to regional (ids-only outbox)**:
  - Control-plane `StaffingOutbox` (migration `0022`):
    `apps/app/app/utils/staffing/outbox.server.ts` with kinds `link_user`,
    `unlink_user`, `erase_user`. Rows hold ids only. Delivery is best-effort
    immediately, then drained by `resources+/jobs.staffing-outbox.ts` on the
    shared daily `0 4 * * *` cron, with exponential backoff (1 min to 24 h, 20
    attempts), per-login ordering, and a lease.
  - Delivery target: tenant-api `/internal/staff/*` (`routes/staff-internal.ts`,
    body `orgId` + `INTERNAL_COMMAND_TOKEN`) via
    `apps/app/app/utils/staffing/regional-internal.server.ts`.
  - Payload schemas: `STAFFING_OUTBOX_PAYLOAD_SCHEMAS` and
    `STAFFING_OUTBOX_PATHS` in `packages/staffing/src/internal-api.ts`.
- **Facts pulled by the regional node** (no PII):
  `/resources/staffing/scope-context` (scopes, tz, features, dataRegion) and
  `/resources/staffing/job-posting`, both `INTERNAL_COMMAND_TOKEN`, cached.
- **Region switch**: `/internal/staff/summary` returns counts only and feeds the
  confirmation (`resources+/staffing.region-summary.ts`).
  `/internal/staff/export-user` serves DSAR and refuses on KSA with 409.
- ADR 047 decision 4 is the rule.

### 11. Ticks and scheduled work

- `apps/tenant-api/src/services/staff-tick-service.ts`
  `runStaffTickForOrg(orgId)`:
  - Idempotent. A per-org lock answers `busy`.
  - It reads features via `getFeatures` from scope-context and skips with
    `flags_unknown`, `staffing_disabled`, `no_staff`, or `region_mismatch`.
  - Built-in tasks (`TICK_TASK_NAMES`): `auto_clock_out`, `missed_clock_out`,
    `no_clock_in`, `pre_shift`, `overtime`, `hiring_retention`. Then it delivers
    the outbox (staff email directly; manager alerts through the App).
  - Caps: `MAX_STAFF_EMAILS_PER_TICK = 100`, `MAX_MANAGER_GROUPS_PER_TICK = 50`.
  - It returns `TickResult` with counts and `needsFollowUp`.
  - **Extension point**:
    `registerStaffTickTask({ name, requires: 'enabled'|'timeclock'|'scheduling'|'hiring', run(ctx) })`,
    where `ctx` provides `{ orgId, db, now, features, enqueue }`. `requires` is
    typed to staffing features only.
- **Drivers**:
  1. Hourly jobs-cron: `apps/jobs-cron/src/index.ts`
     `TENANT_HOURLY_CRON = '0 * * * *'` runs `invokeTenantStaffTick` (POSTs
     `/api/staff/tick` with no body to every node). `wrangler.jsonc` crons are
     `["0 2 * * *","0 3 * * *","0 4 * * *","0 * * * *"]`. The comment says the
     free plan allows 5 cron triggers per Worker, so **4 are used and 1 is
     left**. Daily jobs share triggers (`JOB_ROUTES`).
  2. Node: `src/routes/staff-tick.ts` (`INTERNAL_COMMAND_TOKEN`, strict body
     `{ orgId? }`, 60/min) runs one org or all (`fanOutStaffTick`).
     `src/lib/staff-tick-interval.ts` `startStaffTickInterval()` uses
     `STAFFING_TICK_INTERVAL_SECONDS` (default 300, minimum 60, `0` off).
  3. Workers: the edge `handleStaffTickFanOut` lists the registry and forwards
     to each DO with `orgId`. In `workers/tenant-org.ts`, `maybeArmStaffAlarm`
     arms a DO alarm after successful requests whose path passes
     `isStaffActivityPath()` (`src/lib/staff-alarm.ts`, a hard-coded list of
     staffing prefixes) or after a tick reporting `needsFollowUp`. `alarm()`
     calls `handleStaffAlarm` -> `runStaffTickForOrg`. The interval is 5 min,
     and re-arming stops after 6 consecutive failures.
- **Plugging in reservations reminders, no-show marking and hold expiry**:
  - A **Durable Object has a single alarm**, and `TenantOrg.alarm()` runs only
    the staff tick. Reservations must either (a) generalize the alarm into a
    module-agnostic per-org scheduler (add `isReservationsActivityPath`, and
    make `alarm()` run every registered module tick), or (b) register tasks into
    the staff tick. Option (b) is wrong because of `requires`, the `no_staff`
    and `staffing_disabled` early exits, and the staff-specific outbox.
  - Recommended: a generic `/api/<module>/tick` or a shared `/api/tick` with a
    module registry. Reuse the hourly cron fan-out by adding a call in
    `jobs-cron` `scheduled()` next to `invokeTenantStaffTick` (no new cron slot
    needed), and reuse the Node interval pattern.
  - Hold expiry needs minute-level precision. The DO alarm can be armed at the
    earliest hold expiry, but do not rely on the hourly cron. Expired holds must
    also be ignored at read time (as orders do with `hold_expires_at`).

### 12. Email and SMS from tenant-api

- `src/lib/tenant-email.ts` `sendTenantEmail(input)` wraps `sendOciEmail` from
  `@repo/email` (OCI Email Delivery; tenant-api never uses Resend). Pass
  `context` only for marketing (it adds unsubscribe headers). Operational mail
  omits it.
- **Dev**: `packages/email/src/oci/send-oci-email.ts` uses the mock transport
  when configured (`shouldUseOciEmailMockTransport`). Otherwise, with no OCI
  config outside production, it logs `[OCI EMAIL MOCK] To: ... | Subject: ...`
  and returns `status: 'skipped'`. In production without config it returns an
  error.
- `src/lib/staff-email.ts` holds plain HTML string templates. Constraints: no
  React (they run inside the DO), hex colors only (no CSS vars or `oklch`),
  escape every value, never include pay, en and ar, and a `ContactLevel` of
  `full` or `minimal` (the KSA default `minimal` omits names, places and times).
- `src/lib/email-switch.ts` `isEmailEnabled()` reads `STAFFING_EMAIL_ENABLED`
  **live from `process.env`** (so it can be flipped without a deploy). When off,
  mail is dropped, not held. The App has its own copy,
  `apps/app/app/utils/staffing/email-switch.server.ts`. Env schemas:
  `apps/tenant-api/.env.schema` (lines about 82-129: `TURNSTILE_*`,
  `STAFFING_KIOSK_ENABLED`, `STAFFING_EMAIL_ENABLED`,
  `STAFFING_TICK_INTERVAL_SECONDS`) and `apps/app/.env.schema:247`.
- `@repo/sms` (`packages/sms/src/index.ts`) `sendSms({ to, message })` uses
  Twilio. Without credentials it logs `[SMS MOCK]` outside production and throws
  in production. It **throws in production when `DATA_REGION=ksa`**, so the KSA
  node needs an in-kingdom provider. It is used by `routes/auth.ts`,
  `routes/operator.ts`, `routes/voice.ts`, and `services/journey-service.ts`.
  Staffing itself sends no SMS. Reservation SMS reminders would need a
  region-aware sender, and KSA would be email-only until a provider exists.

### 13. Seeds and demo data

- `apps/tenant-api/scripts/seed-staffing.mjs` refuses `NODE_ENV=production` and
  runs `varlock run -- tsx scripts/<step>.ts <slug> --enable` for `seed-staff`,
  `seed-timeclock`, `seed-schedule`, and `seed-staffing-history`, in that order.
  Each step can run alone (`npm run seed:staff -w tenant-api -- <slug>`).
- `seed-staff.ts` resolves the org by slug from the control-plane DB (the Node
  runtime can read it), and refuses unless `staffing.enabled` is on, or upserts
  it with `--enable`. It calls `provisionTenantDb` and `getTenantDb`, builds a
  fake `StaffAuth` (`scopeToScopes`), and **goes through the real service
  functions** (`createStaff`, `createJob`, ...) so that validation and audit
  rows apply. It is idempotent (it stops if data exists).
- Fixtures: `packages/staffing/src/demo-roster.ts` (exported as
  `@repo/staffing/demo-roster`), reused by E2E tests. Scope resolution:
  `scripts/seed-scope.ts`.

### 14. Reports, analytics, dashboards, MCP

- **Reports**:
  - `packages/reports` holds the subject catalog. `src/catalog-staffing.ts`
    defines
    `STAFFING_REPORT_SUBJECTS = ['time_entries','shifts','labor_daily','applications']`
    and `STAFF_PAY_REPORT_PERMISSION`.
  - `src/operator-token.ts` defines the reports token with audience
    `tenant-api-operator`, a subjects list, and `scopeIds`.
  - The App decides allowed subjects in
    `apps/app/app/utils/staffing/report-access.server.ts` `staffReportAccess()`
    (flags, permissions, scope, and impersonation gets none). The token route is
    `apps/app/app/routes/_app+/$orgSlug_+/reports+/token.ts`
    (`token.staffing.test.ts`).
  - tenant-api `routes/analytics.ts` dispatches staffing subjects to
    `services/staffing-report-records.ts` (`loadTimeEntryRecords`,
    `loadShiftRecords`, `loadLaborDailyRecords`, `loadApplicationRecords`, and
    `auditStaffReportRun`). It applies scope and money access, and writes an
    audit row per run. Tests: `routes/analytics.staffing.test.ts`,
    `services/staffing-report-records.test.ts`, and
    `packages/reports/src/catalog-staffing.test.ts`.
- **Dashboards** (`apps/app/app/utils/dashboards/*`,
  `routes/_app+/$orgSlug_+/dashboards+/*`) have built-in block types plus a
  generic `report` block. Staffing appears only through report subjects; there
  are **no staffing-specific dashboard blocks**.
- **MCP** (`apps/app/app/utils/mcp/tools.server.ts`): only `find_user` and
  `get_user_notes`. **Staffing exposes no MCP tools.** This is consistent with
  residency: the App server never holds staff data.
- Reservations would add subjects (for example `bookings` and
  `booking_guests_daily`) to the catalog plus regional loaders and access rules.

### 15. Docs a module is expected to have

- `docs/staffing.md` (237 lines): the operator guide and runbook. Sections:
  - What is in it (table of area, capabilities, flag).
  - Turning it on (flags table, 404 versus 403, permissions and presets, token
    lag).
  - First day, step by step.
  - Kill switches and settings (env table).
  - Runbook (turning a flag off; deploy order with tenant-api first; symptoms
    table).
  - Rollout stages S0 to S4.
  - KSA checklist.
  - Demo data.
  - Security checks that run in CI.
  - Known gaps.
  - Verticals.
- `docs/decisions/047-staffing-data-residency.md` (425 lines): the ADR. Context,
  then numbered decisions:
  1. Placement.
  2. Browser-direct.
  3. Staff is not a member.
  4. HR-event metadata.
  5. Login email.
  6. Region switch.
  7. Principals table.
  8. JobPosting in the control plane.
  9. Rule packs.
  10. Controller and processor.
  11. Retention.
  12. Feature flags.
  13. Scope ids and token lag.
  14. The tick.
  15. Onboarding.

  It closes with Consequences, Runtime facts, Prerequisites verified, and Open
  points. Status is "proposed".

- `docs/staffing-plan.md` (1,412 lines): the design and build log. Goal, design
  decisions, architecture (placement, principals, data model conventions,
  permissions), then one "(built: ...)" section per slice with API and screens,
  then audit and security, members, billing and erasure, component choices,
  roadmap, verticals, flags and rollout, open decisions, and risks.
- Also touched: `docs/permissions.md`, `docs/scheduled-jobs.md#staff-tick`,
  `docs/tenant-data-residency.md`, `AGENTS.md` (the "Staff module" section and
  env var list), and `apps/tenant-api/README.md`.

### 16. Size and shape (approximate, from `wc -l`)

| Area                                        | Source                                                                                | Tests                                                        |
| ------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `packages/staffing/src`                     | 38 files, ~11.2k LOC                                                                  | 35 files, ~9.9k LOC                                          |
| `packages/staffing-restaurant`              | 2 files, 142 LOC (incl. test)                                                         | -                                                            |
| `packages/tenant-db` schema (staffing part) | ~1.85k lines of `schema.ts` + 998-line `0014` + 1-line `0015`                         | 8 schema test files, ~2.3k LOC (+ `adversarial.test.ts` 926) |
| Control-plane DB                            | migrations `0022` (94 lines), `0023` (14) + `setup-roles.ts` rows + `ORG_PERMISSIONS` | -                                                            |
| tenant-api routes (staffing)                | 12 files, ~3.2k LOC                                                                   | 32 files, ~24.4k LOC                                         |
| tenant-api services (staffing)              | ~37 files, ~19.8k LOC                                                                 | 8 files, ~3.3k LOC                                           |
| tenant-api lib (staffing)                   | ~16 files, ~2.1k LOC                                                                  | (included above)                                             |
| tenant-api harnesses / seeds                | `tests/*.ts` ~1.4k; `scripts/seed-*` ~1.0k                                            | -                                                            |
| App routes `staff+/`                        | 31 files, ~4.1k LOC                                                                   | 14 files, ~4.0k LOC                                          |
| App components `staff/`, `hiring/`          | 117 files, ~30.3k LOC                                                                 | 27 files, ~8.0k LOC                                          |
| App utils `staffing/`, `hiring/`            | 80 files, ~12.6k LOC                                                                  | 40 files, ~8.6k LOC                                          |
| App resource routes / hooks / public shells | 6 files (~560) / 5 hooks (~430) / 4 shells                                            | various                                                      |
| App E2E                                     | 8 `staff-*.test.ts`, ~2.7k LOC (tenant-api stubbed with `page.route`)                 |                                                              |
| Sites careers                               | ~1.5k LOC (pages, components, lib, tests)                                             |                                                              |
| Docs                                        | ~2.1k lines across 3 docs + edits to 4 others                                         |                                                              |

A reservations module of comparable scope (floor plan, availability, bookings,
waitlist, guests, public widget, reminders) is plausibly 40-60% of staffing.
Staffing has five sub-features and very deep timesheet and labor math.

---

## (c) New module checklist (implementation order)

0. **Decide vocabulary.** Use a generic core (`bookings`, `resources`,
   `capacity`, `party`/`guests`, `availability rules`, `waitlist`,
   `guest profiles`) with a restaurant vertical package. Pick unique names:
   tables `booking_*`, flag namespace `bookings.*`, permission entities
   `booking`, `booking_guest`, `booking_settings`. Avoid `reservation`
   collisions (`restaurant_order_reservations`, phone-agent `reservation`,
   `hold_expires_at`). Write the ADR first. Copy from:
   `docs/decisions/047-staffing-data-residency.md`.
1. **Domain package** `packages/bookings` (`@repo/bookings`): `flags.ts`,
   `permissions.ts` (strings, sensitive grants, TTLs,
   `restrictGrantsForImpersonation`, `grantsSatisfying`), `scope.ts` (reuse
   `DEFAULT_SCOPE_ID` semantics), `schemas.ts` (API Zod plus token claims schema
   with a **new audience and `typ`**, such as `tenant-api-bookings-operator` /
   `bookings+jwt`, and a scope enum), `internal-api.ts` (internal paths and
   outbox payloads), pure availability and slot math, `vocabulary.test.ts`,
   `permissions.test.ts`, and `package.json` with exports. Copy from:
   `packages/staffing/src/{flags,permissions,scope,schemas,internal-api,vocabulary.test,permissions.test}.ts`,
   `packages/staffing/package.json`.
2. **Vertical package** `packages/bookings-restaurant`: table, floor-plan and
   covers words, location-scope mapping helpers, and default turn times. Copy
   from: `packages/staffing-restaurant/src/*`,
   `packages/phone-agent-restaurant/src/vertical.ts`.
3. **Control-plane migration**: `Permission` rows
   (`org_perm_<action>_<entity>_<access>`, context `organization`),
   `_OrganizationPermissionToRole` for `org_role_admin` (and only inert own
   grants for member), any org settings columns, an ids-only outbox table if
   needed, and public content tables (for example a published booking widget
   config, if not regional). Run
   `cd packages/database && npx drizzle-kit generate --name bookings_foundation`,
   hand-append the INSERTs, then update `packages/database/src/schema.ts`. Copy
   from: `packages/database/drizzle/0022_staffing_foundation.sql`,
   `0023_staffing_restaurant_locations.sql`.
4. **Mirror permissions**:
   `packages/auth/src/organization-permissions.server.ts` (`ORG_PERMISSIONS`),
   `packages/database/setup-roles.ts`,
   `apps/app/app/utils/organization/tenant-role-permissions.ts` (allow-list plus
   implied-read map), the role editor groups with a hidden-while-off flag
   (`apps/app/app/components/roles/tenant-role-access-manager.tsx`), presets,
   drift tests, and `docs/permissions.md`. Copy from:
   `apps/app/app/utils/staffing/role-presets*.ts`,
   `tenant-role-permissions.test.ts`, `settings+/roles.staffing.test.ts`.
5. **Tenant schema and migration**: add a section to
   `packages/tenant-db/src/schema.ts` (epoch-ms `*_at`, `*_date` in scope tz,
   minor units plus currency, UUID ids, text `scope_id` without FK, enums with
   `*_VALUES`, a separate table for sensitive guest data, a module audit log).
   Run
   `cd packages/tenant-db && npm run db:generate -- --name bookings_foundation`,
   then **hand-append triggers** (append-only audit or status history,
   no-overlap or capacity guards where possible). Keep it additive, because it
   applies lazily to every org. Run
   `npm run generate:do-migrations -w tenant-api` (or `typecheck`). Copy from:
   `schema.ts:1050+`, `drizzle/0014_staffing_foundation.sql:743+`.
6. **Schema tests**: `packages/tenant-db/src/bookings-schema.test.ts` (temp
   libsql plus `migrate`, defaults, triggers reject). Copy from:
   `hiring-schema.test.ts`, `time-clock-schema.test.ts`.
7. **tenant-api auth layer**: `src/lib/bookings-auth.ts` (verify audience,
   `typ`, lifetime cap, scope, region, active and provisioned org;
   `scopeToScopes`), `src/lib/bookings-guard.ts`, and reuse `staff-http.ts` (or
   move the helpers to a shared `lib/http.ts`). Add the new audience to
   `workers/org-router.ts` `orgIdFromOperatorJwt`. Copy from:
   `src/lib/staff-auth.ts`, `staff-guard.ts`, `staff-http.ts`.
8. **tenant-api services and routes**: `src/services/booking-*-service.ts`
   (Result unions, audit writes, `retryOnSqliteBusy`) and
   `src/routes/bookings.ts` (+ sub-routers such as floor plan, availability,
   waitlist, guests) mounted in `src/app.ts` under `/operator/bookings*`.
   `/operator/*` already has a 120/min limit. Copy from: `routes/hiring.ts`,
   `services/hiring-service.ts`, `services/staff-audit.ts`.
9. **Public booking route** `src/routes/booking-public.ts` (for example
   `/book/*`): origin-bound org, honeypot, Turnstile action, a flag and config
   check via an App internal resource route (cached), durable per-org,
   per-address and per-contact limits, HMAC contact dedupe, consent and version,
   uniform answers, and a guest management link token. Add a per-IP `rateLimit`
   in `app.ts`, an `org-router.ts` branch (Origin only, never a body `orgId`),
   and a routing test. Copy from: `routes/careers.ts`,
   `services/careers-apply-service.ts`, `lib/job-posting-context.ts`,
   `lib/careers-routing.test.ts`, `lib/schedule-link-auth.ts`.
10. **Internal routes** `src/routes/bookings-internal.ts`
    (`/internal/bookings/summary` with counts for the region switch, export and
    erase for DSAR) with `INTERNAL_COMMAND_TOKEN`, plus an `org-router.ts`
    branch (`orgIdFromJsonBody`). Copy from: `routes/staff-internal.ts`.
11. **Tick**: generalize `workers/tenant-org.ts` alarm handling (one DO alarm
    for all modules) and `src/lib/staff-alarm.ts` activity paths; add
    `src/services/bookings-tick-service.ts` (reminders, no-show, hold expiry,
    waitlist offers, outbox delivery); add a `/api/bookings/tick` route or a
    shared tick registry; add a Node interval; add the jobs-cron hourly call
    (`apps/jobs-cron/src/index.ts` `scheduled()`, with tests in
    `index.test.ts`). Copy from: `services/staff-tick-service.ts`,
    `routes/staff-tick.ts`, `services/staff-tick-fanout.ts`,
    `lib/staff-tick-interval.ts`, `workers/index.ts` `handleStaffTickFanOut`.
12. **Email and SMS**: plain-HTML en and ar templates (escaped, hex colors), a
    `BOOKINGS_EMAIL_ENABLED` live kill switch, and a region-aware SMS decision
    (Twilio is US only; it throws on KSA in production). Add env vars to
    `apps/tenant-api/.env.schema`, `apps/app/.env.schema`, and the AGENTS.md env
    list. Copy from: `lib/staff-email.ts`, `lib/email-switch.ts`,
    `lib/tenant-email.ts`.
13. **Manager events**: a strict generic event schema (orgId, eventId, kind,
    scopeId, count) and an App `POST /resources/bookings/notify` route that
    writes in-app notifications and email, plus notification preference and
    visibility filtering. Copy from: `lib/manager-alerts.ts`,
    `routes/resources+/staffing.notify.ts`,
    `utils/staffing/notification-visibility.server.ts`.
14. **tenant-api tests**: a harness (`tests/bookings-harness.ts` with
    `mintBookingsToken` that can forge everything), per-router tests containing
    `ORG_B` and `scopeIds` cases, `*.adversarial.test.ts`, a mount test, and a
    `bookings-security.test.ts` sweep. Copy from: `tests/staff-harness.ts`,
    `routes/staffing-security.test.ts`, `routes/hiring-mount.test.ts`.
15. **App access layer**: `apps/app/app/utils/bookings/access.server.ts`
    (`getBookingsFeatureState`, `requireBookingsFeature` returning 404,
    `requireBookingsAccess` with flag 404 then permission 403 then scope 403,
    `getBookingsNavAccess`), `sections.ts` (requirements table), `nav.ts`,
    `scope-claim.server.ts` (reuse location grants), `token.server.ts`
    (`SCOPE_POLICIES`, `mintBookingsToken`), and tests. Copy from:
    `apps/app/app/utils/staffing/{access.server,sections,nav,scope-claim.server,token.server}.ts`.
16. **App routes**: `apps/app/app/routes/_app+/$orgSlug_+/bookings+/_layout.tsx`
    (guard plus client provider), `token.ts` (`private, no-store`), and section
    routes whose loaders return ids and flags only. Add resource routes
    `resources+/bookings.{notify,config,scope-context,region-summary}.ts`, all
    with `requireInternalCommandAuth` or `requireUserWithOrganizationPermission`
    first. Copy from: `staff+/_layout.tsx`, `staff+/token.ts`,
    `staff+/team.tsx`, `resources+/staffing.*.ts`.
17. **App client**: `utils/bookings/bookings-client.ts` (memory-only tokens,
    refresh margin, a single 401 retry, `/operator/<scope>` mapping),
    `hooks/use-bookings-client.ts` (`useBookingsClient`, `useBookingsQuery`), a
    provider that forgets tokens on unmount, `*-types.ts` Zod response schemas,
    `*-view.ts`, `*-errors.ts`. Copy from: `utils/staffing/staff-client.ts`,
    `hooks/use-staff-client.ts`, `components/staff/staff-client-provider.tsx`.
18. **App guard test** `utils/bookings/bookings-guards.test.ts` (static analysis
    of `bookings+/` loaders and actions, resource routes, an explicit
    public-routes list). Copy from: `utils/staffing/staffing-guards.test.ts`.
19. **Navigation**: in `apps/app/app/root.tsx`, compute `bookingsNav`
    (cachified, 30 s, fail to hidden). In `components/app-sidebar.tsx`, add the
    item, group visibility and per-link filter. Copy from: `root.tsx:411-433`,
    `app-sidebar.tsx:473-500,652,684-697`.
20. **UI components** under `apps/app/app/components/bookings/**`, using
    `@repo/ui` primitives, Lingui `t` and `<Trans>`, RTL. Then run
    `npm run lingui:extract -w app` (`apps/app/app/locales/{en,ar}.po`). Copy
    from: `components/staff/**`.
21. **Cross-cutting settings**: notification preferences, members location scope
    (reuse), the region-switch guard (add booking counts to the confirmation and
    backup), DSAR export and erasure hooks. Copy from:
    `components/staff/region-staff-guard.tsx`,
    `utils/staffing/region-guard.server.ts`, `region-backup.ts`,
    `dsar.server.ts`.
22. **Sites public booking widget**: Astro page or block, public availability
    via the App (flag-checked) or directly from tenant-api for slot availability
    (no PII), a browser-direct POST, Turnstile site key, CSP `connect-src`, and
    `.po` strings. Copy from: `apps/sites/src/pages/careers/*`,
    `components/careers/ApplyPanel.astro`, `lib/careers/apply-form.ts`,
    `lib/site-headers.ts`, `lib/org.ts` `fetchPublishedCareers`.
23. **Vertical adapters**: tenant-api `src/restaurant/bookings-*.ts` registered
    in **both** `src/index.ts` and `workers/index.ts`. Consider a multi-source
    demand registry so booked covers can feed the staffing demand guide
    (`services/order-source.ts` is single-slot today). Integrate the phone agent
    `reservation` request type and link handoff, and optionally import from
    OpenTable or Resy (`packages/integrations/src/providers/{opentable,resy}`).
    Copy from: `src/restaurant/staffing-order-source.ts`,
    `utils/staffing/restaurant/*`.
24. **Reports**: catalog subjects plus access rules plus regional loaders with
    scope and audit; dashboards come for free through the report block. Copy
    from: `packages/reports/src/catalog-staffing.ts`,
    `utils/staffing/report-access.server.ts`,
    `services/staffing-report-records.ts`.
25. **Seeds**: `apps/tenant-api/scripts/seed-bookings*.ts` (`--enable` upserts
    flags; refuses production; uses real services; idempotent) and package.json
    scripts. Copy from: `scripts/seed-staffing.mjs`, `scripts/seed-staff.ts`.
26. **E2E**: `apps/app/tests/e2e/bookings-*.test.ts` (insert `ConfigFlag` rows;
    stub tenant-api with `page.route` and permissive CORS). Copy from:
    `apps/app/tests/e2e/staff-roster.test.ts`.
27. **Docs**: `docs/bookings.md` (operator guide and runbook),
    `docs/bookings-plan.md`, an ADR
    `docs/decisions/0NN-bookings-data-residency.md`, plus edits to
    `docs/permissions.md`, `docs/scheduled-jobs.md`,
    `docs/tenant-data-residency.md`, and the `AGENTS.md` module section and env
    vars. Copy from: `docs/staffing.md`, `docs/staffing-plan.md`, ADR 047.

---

## (d) Gotchas and invariants enforced by tests and CI

1. **A flag that is off returns 404, a missing permission returns 403**, and
   there is a single helper for both. **Every child loader and action** calls
   the guard itself, because parent loaders can be skipped on data requests.
   Enforced statically by `staffingGuards` (the first `await` must be the guard;
   nothing reads the body before it; no `clientLoader` or `clientAction`).
2. **Only the literal `true` turns a flag on** (`isFlagOn`). Child flags require
   the master. A system-level `true` enables every org unless an org-level row
   overrides it.
3. **tenant-api never checks flags or roles for token routes**; the App must
   never mint a token for a disabled module. Token lifetimes are capped _on the
   claims_ (`exp - iat`), not just by age. The scope claim must equal the route
   group. The region claim must match the node. Unknown, unprovisioned and
   wrong-region orgs fail closed (404, 404, 409).
4. **Token audiences are distinct per principal**. Staffing tokens cannot hit
   the orders or mailbox routes and vice versa. The security sweep checks that a
   token for another audience or secret returns 401. Remember to add any new
   audience to `workers/org-router.ts`, or the Workers runtime returns 400
   "Could not resolve tenant organization".
5. **Impersonation**: read-only, with no sensitive grants and a 5-minute TTL.
   This is enforced both at mint and in tenant-api
   (`restrictGrantsForImpersonation`, `requireWriteGrant`).
6. **Route enumeration gate**: every operator route must return 401 with no
   token and 403 for a grantless token in every scope, and must never return
   5xx. Mounts in `app.ts` are pinned by string match. Each router needs test
   files containing cross-org (`ORG_B`) and cross-scope (`scopeIds`) evidence,
   and each route's tail segments must appear in its tests. **New prefixes are
   not covered by the staffing regexes**, so ship a dedicated sweep.
7. **Scope filtering is mandatory on every list and write** through
   `scopeToScopes(auth).where(column)`. An empty `scopeIds` array means nothing,
   not everything.
8. **Errors never echo values**: `validationBody` omits messages for enum,
   literal and union codes; Drizzle errors are never logged or returned
   (`describeStaffError`). Responses carry `Cache-Control: private, no-store`.
9. **The in-memory rate limiter resets per isolate or DO**, so abuse limits that
   matter must be persisted in the org DB.
10. **Public routes never trust a client org id**: they use Origin, or an
    org-prefixed credential parsed by the router. A request with no Origin
    resolves nothing in production. The honeypot answers like a success, and
    duplicate submissions answer like new ones.
11. **Tenant migrations apply lazily to every org on first open**, regardless of
    flags. Keep them additive, and deploy tenant-api to **both** nodes before
    the App. Triggers are hand-written in the SQL and must be asserted in schema
    tests. `workers/migrations.generated.ts` is git-ignored and regenerated on
    build, typecheck and deploy. The docs claim a schema test checks it, but no
    such test was found (no test references `migrations.generated` or the
    generator).
12. **Mixed timestamp units**: staffing uses epoch **ms**; older tenant tables
    (`customers`, `restaurant_orders`, `voice_calls`) use epoch **seconds**
    (`strftime('%s','now')`). Joining bookings to orders or customers needs
    care.
13. **Cross-plane payloads are ids and counts only**, through strict Zod
    (`.strict()`, so extra fields return 400). The App re-checks flags on
    receipt and answers 200 `skipped` for permanent failures so the node stops
    retrying.
14. **Single DO alarm per org**: today it is wired exclusively to the staff tick
    (`isStaffActivityPath`, `runStaffTickForOrg`). A second module must
    generalize it rather than call `setAlarm` independently, because a second
    `setAlarm` would overwrite the staff alarm.
15. **Cron slots**: jobs-cron uses 4 of the 5 free-plan triggers. Piggyback on
    the hourly fan-out or the shared daily triggers.
16. **Kill switches are read live from `process.env`** (not the varlock
    snapshot) so they can be flipped without a deploy. Email that comes due
    while the switch is off is dropped, not queued.
17. **SMS is US-only**: `@repo/sms` throws in production on KSA. It logs
    `[SMS MOCK]` in dev. Email in dev logs `[OCI EMAIL MOCK]` when no OCI config
    is present.
18. **Vocabulary test**: core sources must avoid restaurant words. The test only
    scans `packages/<core>/src/*.ts`, so App and tenant-api generic code relies
    on convention, with restaurant code confined to `restaurant/` folders.
    `PRODUCT.md` requires generic files so the repo can sync upstream.
19. **Vertical registrations must run in both runtimes** (`src/index.ts` and
    `workers/index.ts`), and test suites that need them must register them
    explicitly (`tests/order-source.ts`).
20. **Region switch wipes regional data**: the App must show counts from
    `/internal/<module>/summary` and require typed confirmation when anything
    would be lost. There is no cross-region migration.
21. **E2E tests do not run tenant-api**: they stub it in the browser with
    `page.route` and permissive CORS. Regional behavior is covered by tenant-api
    vitest suites only.
22. **No PII in App loaders, MCP tools or dashboards**: staffing exposes no MCP
    tools and no person data in SSR. Reports read regional data through a token
    and audit every run.
