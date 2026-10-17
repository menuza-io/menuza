# Menuza: operations and testing discovery (for the Reservations mission)

Repo: `/Users/zama/menuza`. Everything below was observed read-only on
2026-10-15 (no tracked files changed; `git status` clean afterwards).
Confidence: H = verified by reading code/config or running a command, M =
inferred from code, L = plausible but unverified.

## 1. Local topology

| Service                                                      | Port                | Start command (from repo root)                                         | Notes                                                                                                                                                                                     |
| ------------------------------------------------------------ | ------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| dev proxy                                                    | 2999                | `node dev-proxy.js` (HTTPS) or `PROXY_PROTOCOL=http node dev-proxy.js` | Host-based routing, see below                                                                                                                                                             |
| App (operator, React Router on Cloudflare Vite dev)          | 3001 (`strictPort`) | `npm run dev -w app`                                                   | Runs `scripts/sync-dev-vars.mjs` (rewrites `apps/app/.dev.vars` from varlock), then `wrangler d1 migrations apply DB --local`, then `vite dev` with `DEPLOY_TARGET=cloudflare MOCKS=true` |
| App HMR                                                      | 24679               | (part of app dev)                                                      | only when `VITE_DIRECT_DEV=1`; otherwise HMR goes wss to `app.menuza.test:2999`                                                                                                           |
| Sites (Astro)                                                | 3008                | `npm run dev -w sites`                                                 | `astro dev --port 3008`, `allowedHosts: ['.menuza.test','menuza.test','localhost']`                                                                                                       |
| tenant-api US                                                | 3007                | `npm run dev -w tenant-api`                                            | `tsx watch src/index.ts`, `varlock/auto-load` from `apps/tenant-api/.env.schema` (DATA_REGION=us, PORT=3007)                                                                              |
| tenant-api KSA                                               | 3009                | `npm run dev:ksa -w tenant-api`                                        | `DATA_REGION=ksa PORT=3009`                                                                                                                                                               |
| web 3002, studio 3003, docs 3004, admin 3005, jobs-cron 8787 |                     |                                                                        | Not needed for Reservations                                                                                                                                                               |

Proxy routing (`dev-proxy.js`, local domain derived from
`packages/config/brand.ts` slug = `menuza` -> `menuza.test`):
`app.menuza.test:2999 -> :3001`, `admin -> :3005`, `api -> :3007`,
`api-ksa -> :3009`, `menuza.test -> :3002`, any other single-label
`*.menuza.test` (and any non-localhost custom host) -> Sites `:3008`.

Root scripts:

- `npm run dev` = kill dev ports, build `@repo/observability`, then proxy
  (HTTPS) + turbo dev of app/web/admin/studio/docs/sites/tenant-api/jobs-cron +
  KSA tenant-api. **HTTPS proxy will crash at start**: it reads
  `other/ssl/_wildcard.domain.me+2*.pem`, and `other/ssl/` does not exist (H).
  mkcert is installed and a mkcert root CA exists in `~/.local/share/mkcert`, so
  `npm run setup:ssl` would fix it (writes files under `other/ssl`, gitignored?
  not verified).
- `npm run dev:http` = kill ports + HTTP proxy + `dev:all` (does **not** start
  KSA tenant-api).
- Per-workspace starts (table above) work over plain `http://localhost` (H for
  App/tenant-api env defaults; M for Sites, see below).

`/etc/hosts` (H): `menuza.test`,
`app/admin/studio/docs/api/api-ksa.menuza.test`, and `acme.menuza.test` ->
127.0.0.1 (plus `::1` for `acme` and `app`). Also legacy `epic-startup.test`
entries. No other org subdomains; adding one requires root
(`npm run setup:hosts`).

How Sites resolves the organization (H, `apps/sites/src/lib/resolve-host.ts`,
`src/middleware.ts`): purely by `Host` header. `{slug}.menuza.io`,
`{slug}.menuza.test` (ROOT_APP) or `PUBLIC_SITE_HOST_SUFFIXES` -> slug; anything
else -> custom-domain lookup. **No `?slug=` query support.**
`http://localhost:3008` resolves to custom host `localhost` and finds no org.
Use `http://acme.menuza.test:3008` (hosts entry exists, allowed host) or
`curl -H 'Host: acme.menuza.test' http://localhost:3008/`. Sites SSR fetches
org/page data from App `/resources/sites*` at `PUBLIC_APP_URL`, whose schema
default is `https://app.menuza.test:2999` (the HTTPS proxy). For plain-http work
start Sites with `PUBLIC_APP_URL=http://localhost:3001` (M: varlock should let
process env override the schema default). Browser calls go to `TENANT_API_URL`
(`http://localhost:3007`) / `TENANT_API_URL_KSA` (`http://localhost:3009`)
injected into the page.

tenant-api org/CORS rules (H, `apps/tenant-api/src/lib/origin.ts`):

- Allowed browser origins in dev: `localhost` (any port), `app.menuza.test`,
  `admin.menuza.test`, the `APP_URL` origin, and `{slug}.menuza.test` when the
  org resolves and its `dataRegion` matches the node.
- Slug/host lookup: first `@repo/database` (`packages/database/db/data.db`,
  requires `active` and `sitePublished`), then fallback
  `GET {APP_URL}/resources/sites?slug=`.
- `findActiveOrganizationById` (used for operator/org-id paths) **always calls
  the App** (`{APP_URL}/resources/tenant-organization`, Bearer
  `INTERNAL_COMMAND_TOKEN`, 5s timeout, fails closed). So tenant-api operator
  flows need App running on 3001.
- Browser auth on `localhost` origin falls back to body `slug`/`host` outside
  production.

Minimal process sets:

- (a) Operator in App managing tenant-api data: App :3001 + tenant-api US :3007
  (+ KSA :3009 only for KSA orgs). Login at `http://localhost:3001` as `kody` /
  `KodyLovesYou!2026` (seed). App mints short-lived operator JWTs (shared
  `TENANT_OPERATOR_TOKEN`) and the browser calls tenant-api directly.
- (b) Customer on a published Site: Sites :3008 (with
  `PUBLIC_APP_URL=http://localhost:3001`) + App :3001 (Sites SSR content
  source) + tenant-api :3007. Browse `http://acme.menuza.test:3008`. Origin
  `http://acme.menuza.test:3008` binds to slug `acme` in tenant-api.

## 2. Env setup (presence only)

Files present: `apps/app/.env`, `apps/app/.dev.vars` (generated each
`npm run dev -w app` from `apps/app/.env.schema` via varlock),
`apps/app/.env.development`, `apps/app/.env.test`, `apps/app/.env.schema`;
`apps/admin/.env.development` (no relevant keys), `apps/admin/.env.test`,
`apps/admin/.env.schema`; `apps/sites/.env.schema` only;
`apps/tenant-api/.env.schema`, `.env.example`, `.dev.vars.example` (no
`.env`/`.dev.vars`); root `.env.test`; `packages/database/.env.schema`,
`packages/tenant-db/.env.schema`, `packages/cache/.env.schema`,
`packages/sms/.env.schema`. All apps use varlock `.env.schema` files with dev
defaults.

App `.dev.vars` (set): SESSION_SECRET, INTEGRATION_ENCRYPTION_KEY,
BASE_URL=`http://localhost:3001`, MOCKS=true, TENANT_OPERATOR_TOKEN,
INTERNAL_COMMAND_TOKEN, VOICE_AGENT_TOKEN, JWT_SECRET,
TENANT_CUSTOMER_JWT_SECRET, TENANT_API_URL=`http://localhost:3007`,
TENANT_API_URL_KSA=`http://localhost:3009`,
STRIPE_SECRET_KEY/PUBLISHABLE/WEBHOOK_SECRET/PORTAL_URL (schema defaults,
presumably test/mock values), CHECKOUT_ENVIRONMENT=sandbox,
EMAIL_PROVIDER=resend, RESEND_WEBHOOK_SECRET, DATABASE_URL, CACHE_DATABASE_PATH.
App absent/empty: RESEND_API_KEY, CHECKOUT_SECRET_KEY/PUBLIC_KEY/WEBHOOK_SECRET,
GOOGLE_MAPS_API_KEY, Twilio (correct, App must not have them).

tenant-api (schema defaults, set): JWT_SECRET, AUTH_HMAC_SECRET,
TENANT_OPERATOR_TOKEN, VOICE_AGENT_TOKEN, INTERNAL_COMMAND_TOKEN (from
`packages/cache/.env.schema`), APP_URL=`http://localhost:3001`, DATA_REGION=us,
PORT=3007, ROOT_APP=menuza.test, TURNSTILE_HOSTNAMES=`localhost,menuza.test`,
STAFFING_* defaults. Empty: TURNSTILE_SECRET_KEY, GOOGLE_MAPS_API_KEY, TWILIO__,
MAILBOX_AI__, RECORDING_S3_*, TENANT_DB_DIR, TENANT_API_RUNTIME. Sites:
PUBLIC_APP_URL (https proxy default), TENANT_API_URL(_KSA), ROOT_APP,
PUBLIC_SHOP_PAYMENT_MODE=redirect; PUBLIC_TURNSTILE_SITE_KEY empty.

Cross-app consistency (verified by comparing SHA-256 fingerprints, values not
printed): App and tenant-api TENANT_OPERATOR_TOKEN, INTERNAL_COMMAND_TOKEN and
VOICE_AGENT_TOKEN match; App TENANT_CUSTOMER_JWT_SECRET equals tenant-api
JWT_SECRET.

Dev behavior with empty keys:

- SMS (H): `@repo/sms` without Twilio creds logs
  `[SMS MOCK] To: ... | Message: ...` to the tenant-api console. OTP codes are
  read from tenant-api stdout.
- Turnstile (H): tenant-api skips siteverify in development when
  `TURNSTILE_SECRET_KEY` is unset; Sites hides the widget when
  `PUBLIC_TURNSTILE_SITE_KEY` is empty.
- Google Maps (H, schema docs): empty -> deterministic dev fixtures outside
  production.
- Email (M): `packages/email/src/send-email.ts` returns a fake success only when
  `RESEND_API_KEY` is empty **and** `MOCKS !== 'true'`; with MOCKS=true it calls
  `api.resend.com`, which MSW intercepts only in the Node server
  (`apps/app/index.ts` imports `tests/mocks`: `dev:node`, `start:mocks`,
  Playwright CI). Under the default Cloudflare `vite dev`, App emails will
  likely fail against real Resend. Do not depend on email delivery in local
  manual checks; in unit tests `NODE_ENV=test` short-circuits.

## 3. Databases

- Control plane for **App dev (Workers)**: local D1 at
  `apps/app/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/a36f84ea...b6006.sqlite`
  (H).
- Control plane for **tenant-api, seeds, unit tests, Playwright CI**:
  `packages/database/db/data.db` (`DATABASE_URL=file:./db/data.db`). Docs saying
  `packages/database/data.db` are stale.
- These are two separate copies. Both contain the same 3 orgs; App D1 has
  staffing flags for `acme`, `data.db` has none.
- Migration state (H): repo has 25 control-plane migrations (0000-0024). Both
  local DBs are **3 behind**: D1 last applied `0022_staffing_permissions.sql`
  (an old name); pending `0022_staffing_foundation`,
  `0023_staffing_restaurant_locations`, `0024_dashboards`
  (`npx wrangler d1 migrations list DB --local`). None of their tables exist
  yet, so they should apply cleanly. `npm run dev -w app` applies them to D1
  automatically; `npm run db:migrate:deploy` is needed for `data.db`.
- Tenant DB dir (H): `TENANT_DB_DIR` empty -> `packages/database/db/`
  (`packages/tenant-db/src/db.server.ts`). Files:
  `tenant_t58bgatqh3rv0s3movrecyj1.db` (acme) and
  `tenant_clw9x0a12000008l00testfk.db` (a test leftover). Tenant migrations:
  `packages/tenant-db/drizzle/` (latest `0015_hiring_interested_scopes.sql`);
  they are applied when the connection opens (M). Workers DO migrations are
  generated into `apps/tenant-api/workers/migrations.generated.ts` (untracked,
  generated by `npm run generate:do-migrations`; also run by tenant-api
  `typecheck`/`build`).
- Seeded orgs (H): `acme` (id `t58bgatqh3rv0s3movrecyj1`, name "Erdman -
  Brakus", region us, provisioned, sitePublished=1); `kozey-and-sons-ovPr` and
  `dickens-marvin-and-kulas-Rp5Q` (us, not provisioned, not published). No KSA
  org exists.
- Operator login (H, `packages/database/seed.ts`): `kody` / `kody@kcd.dev`,
  password `KodyLovesYou!2026`, roles admin+user, member of `acme`.
- Feature flags: `ConfigFlag` rows (`key`, `value`, `level='organization'`,
  `organizationId`), set from Admin or SQL.
  `npm run seed:staffing -w tenant-api -- acme` runs seed-staff, seed-timeclock,
  seed-schedule, seed-staffing-history with `--enable` and writes flags into
  **`data.db` only** (via `@repo/database`). Because App dev reads D1, flags
  written by the seed are not visible to App dev. To enable in App dev, insert
  into D1, e.g. `npx wrangler d1 execute DB --local --command "INSERT ..."` from
  `apps/app` (M), or use the Admin UI. A new `reservations.*` flag needs the
  same treatment.

## 4. Tests

| Workspace          | test                        | typecheck                                           | lint                                     | Runner notes                                                                                                                                                                              | Unit files              |
| ------------------ | --------------------------- | --------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| apps/tenant-api    | `varlock run -- vitest run` | `codegen && generate:do-migrations && tsc --noEmit` | none (no lint script)                    | `vitest.config.ts`: node env, `setupFiles: tests/setup-env.ts`, `testTimeout 15000`, default pool. Tests make real file-based SQLite in temp dirs (`mkdtemp`, 25 files), not `:memory:`   | 80 (49 in `src/routes`) |
| apps/app           | `vitest --run`              | `react-router typegen && tsc`                       | `eslint .`                               | config in `vite.config.ts` `test`: `pool: 'forks'`, `maxWorkers` 2 in CI, globalSetup builds `tests/database/base.db` from control-plane migrations, each worker copies to `data.{id}.db` | 255 unit, 45 e2e        |
| apps/sites         | `vitest run`                | `astro check`                                       | `eslint .`                               | `vitest.config.ts` node env, `src/**/*.test.ts`                                                                                                                                           | 24                      |
| packages/tenant-db | `varlock run -- vitest run` | `tsc --noEmit`                                      | none                                     | no vitest config (defaults)                                                                                                                                                               | 12                      |
| packages/staffing  | `vitest run`                | `tsc --noEmit`                                      | none                                     | node env                                                                                                                                                                                  | 35                      |
| packages/ui        | none                        | `tsc --noEmit`                                      | `oxlint . && eslint . (ignores stories)` |                                                                                                                                                                                           | 0                       |

Measured (4 vCPU, warm): tenant-api `src/lib/origin.test.ts` 3.8s vitest / 8.3s
wall; two DB-backed route tests (`provision`, `schedule.review`) 5.8s / 7.0s
wall; staffing full suite (35 files, 634 tests) 3.2s / 4.0s wall. Extrapolation:
full tenant-api suite likely 1-3 min; app unit suite several minutes (255 files,
forks).

Single-file pattern:
`cd apps/tenant-api && ../../node_modules/.bin/varlock run -- npx vitest run <file>`
(varlock is needed for env); staffing/sites: `npx vitest run <file>`.

Playwright (H): configs `apps/app/playwright.config.ts` and
`apps/admin/playwright.config.ts`. App config: `testDir ./tests/e2e`, 60s
timeout, `webServer` = `npm run start:mocks` when `CI` is set (needs
`npm run build -w app` first) else `npm run dev` with `reuseExistingServer`;
Chromium with `--host-rules=MAP *.menuza.test [::1]`. Recommended per
`docs/testing.md`:
`npm run build -w app && cd apps/app && PORT=3101 CI=true npx playwright test tests/e2e/<spec> --workers=1`.
Staff e2e specs stub tenant-api in the browser. Playwright 1.57.0; browsers
installed in `~/.cache/ms-playwright` (`chromium-1200`,
`chromium_headless_shell-1200`, `ffmpeg-1011`).

## 5. Turbo

49 workspaces (`apps/*` + `packages/*`). Turbo 2.10.8. `typecheck` and `lint`
are cached with no `dependsOn`; `test` depends on `^build`.

- Single workspace: `npx turbo run typecheck --filter=tenant-api`,
  `--filter=app`, `--filter=sites`, `--filter=@repo/tenant-db`,
  `--filter=@repo/staffing`, `--filter=@repo/ui`. Or
  `npm run typecheck -w <name>`.
- Root `npm run typecheck` / `npm run lint` are feasible but heavy (49
  workspaces, 4 CPUs, 8 GB RAM; app/admin typecheck run react-router typegen).
  Prefer filtered runs; use root runs once at the end. `npm run lint:oxc` (root
  oxlint) is fast.

## 6. Machine resources

`nproc` 4; RAM 7956 MB total, ~6.9 GB available, 6 GB swap; `/` 53 GB, 30 GB
free; load average 0.24. Listening ports: only 22, 111 and 49983. All dev ports
(2999, 3001-3009, 8787, 24678/9) are free. No node, wrangler, vite or docker
processes; docker not installed.

## 7. Tooling

`agent-browser` 0.37.1 at `/home/factory-user/.factory/bin/agent-browser`;
`tuistory` **not** on PATH; `sqlite3` 3.45.1; `jq`, `curl`, `lsof`, `ss`,
`mkcert` present. Node v22.18.0, npm 10.9.0.

## 8. Repo agent conventions

`docs/skills/*/SKILL.md` (one line each): project-auth (auth, sessions, OAuth,
passkeys, 2FA, regional customer auth); project-caching (cachified,
invalidation); project-database (Drizzle, SQLite/D1 migrations, tenant DBs,
residency); project-deployment (CI/CD, Cloudflare, OCI, secrets, health checks);
project-email-marketing (transactional and block email, merge tags);
project-forms (Zod + Conform, honeypots, public tenant forms);
project-integrations (OAuth integrations, provider adapters);
project-jobs-observability (cron, Workflows, internal jobs, telemetry);
project-mcp (MCP OAuth); project-mobile (Expo, iOS/Android tenant apps);
project-monorepo (workspaces, Turbo boundaries); project-payments-commerce
(billing, checkout, shop, webhooks); project-permissions (RBAC, custom roles,
permission-aware UI); project-public-sites (Astro sites, host/locale resolution,
CSP, forms, shop); project-react-patterns (React 19, RR8 data APIs);
project-routing (flat routes, resource routes); project-security (validation,
XSS, CSP, rate limits, PII); project-sso; project-storage-media;
project-tenant-data (tenant-api architecture, PII boundaries, provisioning,
browser auth); project-testing (Vitest, Playwright, MSW, DB fixtures, authz
tests); project-ui-guidelines (a11y, shared components, Tailwind 4, i18n,
design-system lint).

`.agents/setup` (Amp orb setup: Volta toolchain, mkcert, Android SDK, npm
install, dev env files, control-plane DB + SSL + hosts, Playwright Chromium,
turbo build) and `.agents/resume` (recreates/seeds `data.db` if missing, repairs
hosts entries). No `.factory/` directory. Also `.cursor/`, `.amp/`,
`.coderabbit.yml`.

Hooks: `.husky/pre-commit` runs `npx lint-staged` (prettier on
js/ts/json/css/md; `oxlint --fix` and `eslint --fix` on js/ts) and then
`node scripts/check-lingui.mjs`. Recent commits repeatedly note "pre-commit
skipped: pre-existing admin lingui catalog failure; lint+typecheck verified
manually", so expect the lingui check to fail on main.

Commits: Conventional style `feat(scope): ...`, `fix(scope): ...`, `chore: ...`,
`docs(scope): ...`, `test: ...`, `refactor(ui): ...`. Branches: `pr/<feature>`
(also `feat/...`, `demo/...` exist).

## 9. Git state

Branch `main`, tracking `origin/main`, clean. Remotes: `origin`
(menuza-io/menuza), `upstream` (mohammedzamakhan/epic-startup). Local branches
include `feat/resy-reservation-integration` (Resy integration; Resy/OpenTable
providers already exist in `packages/integrations/src/providers/`).

Naming collision to note: `packages/tenant-db/src/schema.ts:734` already defines
`restaurantOrderReservations` / table `restaurant_order_reservations` (order
slot capacity holds, not table bookings). The new module's tables and
identifiers must not clash with it.

## Draft services.yaml

```yaml
commands:
  install: 'PUPPETEER_SKIP_DOWNLOAD=true npm install' # H
  migrate_control_plane_sqlite: 'npm run db:migrate:deploy' # H (data.db; 3 pending)
  migrate_control_plane_d1: 'npm run db:migrate:d1:local -w app' # H (also runs on app dev)
  seed_staffing: 'npm run seed:staffing -w tenant-api -- acme' # H (writes flags to data.db only)
  typecheck_tenant_api: 'npx turbo run typecheck --filter=tenant-api' # H
  typecheck_app: 'npx turbo run typecheck --filter=app' # H (slow-ish: typegen + tsc)
  typecheck_sites: 'npx turbo run typecheck --filter=sites' # H (astro check)
  typecheck_tenant_db: 'npx turbo run typecheck --filter=@repo/tenant-db' # H
  typecheck_staffing: 'npx turbo run typecheck --filter=@repo/staffing' # H
  typecheck_ui: 'npx turbo run typecheck --filter=@repo/ui' # H
  lint_app: 'npm run lint -w app' # H
  lint_sites: 'npm run lint -w sites' # H
  lint_ui: 'npm run lint -w @repo/ui' # H
  lint_oxc_root: 'npm run lint:oxc' # H (covers tenant-api and packages without eslint)
  test_tenant_api: 'npm run test -w tenant-api' # H (80 files, est. 1-3 min)
  test_tenant_api_file: 'cd apps/tenant-api && ../../node_modules/.bin/varlock
    run -- npx vitest run <file>' # H
  test_app: 'npm run test -w app' # H (255 files, several min)
  test_app_file: 'cd apps/app && npx vitest run <file>' # M
  test_sites: 'npm run test -w sites' # H
  test_tenant_db: 'npm run test -w @repo/tenant-db' # H
  test_staffing: 'npm run test -w @repo/staffing' # H (~4s)
  e2e_app: 'npm run build -w app && cd apps/app && PORT=3101 CI=true npx
    playwright test tests/e2e/<spec> --workers=1' # H

services:
  tenant-api-us:
    start: 'cd apps/tenant-api && npm run dev' # H
    port: 3007
    healthcheck: 'curl -sf http://localhost:3007/health' # M (path from AGENTS.md)
    stop: 'lsof -ti tcp:3007 -sTCP:LISTEN | xargs -r kill'
  tenant-api-ksa:
    start: 'cd apps/tenant-api && npm run dev:ksa' # H
    port: 3009
    healthcheck: 'curl -sf http://localhost:3009/health' # M
    stop: 'lsof -ti tcp:3009 -sTCP:LISTEN | xargs -r kill'
  app:
    start: 'cd apps/app && npm run dev' # H (Workers vite dev, local D1, applies D1 migrations)
    port: 3001
    healthcheck: 'curl -sf http://localhost:3001/resources/healthcheck' # M
    stop: 'lsof -ti tcp:3001 -sTCP:LISTEN | xargs -r kill'
    depends_on: [tenant-api-us]
  sites:
    start: 'cd apps/sites && PUBLIC_APP_URL=http://localhost:3001 npm run dev' # M (override needed without HTTPS proxy)
    port: 3008
    healthcheck: "curl -sf -o /dev/null -H 'Host: acme.menuza.test'
      http://localhost:3008/" # M
    browse: 'http://acme.menuza.test:3008'
    stop: 'lsof -ti tcp:3008 -sTCP:LISTEN | xargs -r kill'
    depends_on: [app, tenant-api-us]
  dev-proxy-http: # optional
    start: 'PROXY_PROTOCOL=http node dev-proxy.js' # H
    port: 2999
    stop: 'lsof -ti tcp:2999 -sTCP:LISTEN | xargs -r kill'
```

## Blockers and surprises

1. The HTTPS `npm run dev` fails because the `other/ssl` certs are missing. Run
   `npm run setup:ssl`, or use the HTTP proxy or per-workspace starts.
2. There are two control-plane copies (App D1 and `data.db`). Seeds and
   tenant-api slug lookups use `data.db`, while App dev uses D1. Flags must be
   set in both, or in the copy the consumer reads.
3. Both control-plane copies are 3 migrations behind.
4. The Sites `PUBLIC_APP_URL` default points at the HTTPS proxy. Sites needs a
   Host header ending in `.menuza.test`; plain localhost and `?slug=` do not
   work.
5. tenant-api needs App up for org-by-id checks, because it fails closed.
6. Email does not work under App Workers dev with MOCKS=true and no Resend key
   (M).
7. The pre-commit lingui check is known to fail.
8. `restaurant_order_reservations` already exists in the tenant DB.
9. No KSA org is seeded.
10. tuistory is not installed.
