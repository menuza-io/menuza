# Environment

Machine, toolchains, env files, local databases, seeded data and environment
gotchas for the Reservations mission.

**What belongs here:** verified environment facts, env var names (never values),
local data locations, setup quirks and their fixes. **What does NOT belong
here:** service start/stop commands and ports (use `services.yaml`), validation
procedures (use `user-testing.md`), design (use `architecture.md`).

---

## Machine

- Headless Linux sandbox (x64), 4 CPUs, 7.9 GB RAM, 6 GB swap, about 25 GB free
  disk. `HOME=/home/factory-user`.
- Repo: `/Users/zama/menuza`, branch `pr/reservations`, created from `main` at
  `05741ca5`. Workers commit there. Nothing is pushed.
- Node 22.18.0 and npm 10.9.0. React Router's CLI prints "Oops, Node v22.18.0
  detected"; ignore it, commands still succeed.
- Turbo 2.10.8. Turbo fails outright when a `--filter` names a package that does
  not exist yet.

## Toolchains (nothing is in `~/.bash_profile`; export in the same command)

```bash
# Android (JDK 17, SDK platform 36, build-tools 36.0.0)
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
export ANDROID_SDK_ROOT=$HOME/android-sdk ANDROID_HOME=$HOME/android-sdk
export PATH=$JAVA_HOME/bin:$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$ANDROID_SDK_ROOT/platform-tools:$PATH
# Swift 6.4.1 (Linux; TenantKit builds and tests, SwiftUI does not exist on Linux)
export PATH=$HOME/swift/usr/bin:$PATH
# App typecheck and App ESLint (run out of heap at the V8 default)
export NODE_OPTIONS=--max-old-space-size=4096
```

- The Gradle daemon holds about 2 GB. Stop it after native work
  (`commands.android_stop_gradle`).
- fast-check 4.9.0 is hoisted at the root. A new package adds
  `"fast-check": "^4.3.0"` to its own devDependencies.

## Installing dependencies

- Run `commands.install` only when a feature adds a dependency or a workspace
  package. It runs `PUPPETEER_SKIP_DOWNLOAD=true npm install` and then
  `scripts/add-linux-bindings.sh`.
- The macOS-generated lockfile has no Linux entries for
  `@unrs/resolver-binding-linux-x64-gnu` and
  `@oxc-resolver/binding-linux-x64-gnu`. Every `npm install` prunes them, and
  ESLint then crashes with "Cannot find native binding". The script re-adds them
  into `node_modules` without touching tracked files; `init.sh` also re-adds
  them when missing.
- After any install, the first App dev start is a cold start of up to about 15
  minutes (vite re-optimizes dependencies one by one and workerd can restart
  after running out of heap). Warm restarts take about 69 seconds. Avoid
  needless reinstalls.
- Review `package-lock.json` after an install. During planning an unexplained
  tooling run added an extraneous `@posthog/cli/node_modules/prettier` entry;
  such drift must not be committed.
- Packages are consumed from source (`exports` point at `.ts` files), except
  `@repo/security` and `@repo/observability`, which App imports from `dist`.
  After changing either of those, rebuild it (`commands.build_dist_package`).

## Env files (names only; never print or commit values)

| File                 | Notes                                                                                                                                                                                                                                                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/app/.env`      | 8 keys, including `NODE_ENV=development`, `BASE_URL=http://localhost:3001`, `MOCKS=true`. App dev rewrites `apps/app/.dev.vars` from it on start.                                                                                                                                                                          |
| `apps/app/.dev.vars` | 45 keys, generated. `TENANT_API_URL=http://localhost:3007`, `TENANT_API_URL_KSA=http://localhost:3009`, `EMAIL_PROVIDER=resend`, placeholder `STRIPE_*` test values and `CHECKOUT_ENVIRONMENT=sandbox`. The placeholder keys make online payment "unconfigured" until the payment mocks (milestone `payment-mocks`) exist. |
| `apps/admin/.env`    | 3 keys copied from `apps/app/.env` during readiness. Without it Admin typecheck and dev fail in Varlock (`SESSION_SECRET`).                                                                                                                                                                                                |
| tenant-api           | No `.env`; Varlock defaults apply. Local dev is Node (`tsx watch src/index.ts`), so it can write files. `npm run dev:ksa` sets `DATA_REGION=ksa PORT=3009`.                                                                                                                                                                |

- Shared dev secrets such as `INTERNAL_COMMAND_TOKEN`, `TENANT_OPERATOR_TOKEN`,
  `JWT_SECRET` and `AUTH_HMAC_SECRET` already exist in the local env. Reuse them
  through the existing env plumbing; never echo them in logs, tests or handoffs.
- New env vars the mission introduces (kill switches, mock and capture switches)
  are listed in `architecture.md`. Add each to the right Varlock schema and
  docs. A regenerated `src/env.ts` is a real change then: commit it after
  `commands.clean_generated` formats it.
- Never run `.agents/setup` or `node scripts/write-ci-app-env.mjs`: they
  overwrite both `.env` files.

## External services (no real providers in this mission)

| Service                          | Local behavior                                                                                                                                                                                                                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SMS (Twilio, tenant-api US only) | No credentials, so tenant-api prints `[SMS MOCK] To: <phone> \| Message: <text>` to its stdout (`/tmp/menuza-logs/tenant-api-us.log`, `tenant-api-ksa.log`).                                                                                                                       |
| Email from tenant-api (OCI)      | No OCI config: today it prints one line, `[OCI EMAIL MOCK] To: … \| Subject: …`, and returns `{status: 'skipped'}`. No body or links are kept. The dev email capture added in milestone `guest-messages` fixes this (see `architecture.md`).                                       |
| Email from App (Resend)          | Under Workers dev it calls the real Resend API with no key and fails ("API key is invalid"). Node/MSW mode (Playwright `start:mocks`) writes `packages/test-utils/fixtures/email/<recipient>.json` (overwritten per recipient). The dev email capture also covers App Workers dev. |
| Stripe, Checkout.com             | Placeholder keys only. Milestone `payment-mocks` adds in-process emulators behind the real SDKs. Never add real keys.                                                                                                                                                              |
| Turnstile                        | Keys empty locally, so the widget is disabled. Enforcement is covered by tests.                                                                                                                                                                                                    |
| Google Maps                      | Key empty; dev fixtures are used outside production.                                                                                                                                                                                                                               |
| GitHub login                     | Mocked (`MOCKS=true`). This is the pattern the payment mocks follow.                                                                                                                                                                                                               |

## Local databases

| Used by                                           | Location                                                                                                                                           |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| App dev (:3001)                                   | Local D1 in `apps/app/.wrangler/state` (binding `DB`). Query it with `cd apps/app && npx wrangler d1 execute DB --local --json --command "<sql>"`. |
| Admin dev (:3005), `db:*` scripts, Playwright e2e | LibSQL `packages/database/db/data.db` (`sqlite3` CLI works).                                                                                       |
| App Vitest                                        | `apps/app/tests/database/base.db`, copied per worker and rebuilt when the schema or migrations change.                                             |
| tenant-api US (:3007)                             | `packages/database/db/tenant_<orgId>.db`                                                                                                           |
| tenant-api KSA (:3009)                            | `packages/database/db/ksa/tenant_<orgId>.db` (its own `TENANT_DB_DIR`; see gotchas)                                                                |

- Control-plane migrations were applied through `0024_dashboards` in both
  `data.db` and local D1. After adding a control-plane migration, apply it with
  `commands.migrate_control_plane`.
- Tenant DB migrations are applied by tenant-api lazily when an org's database
  is opened.
- All of `packages/database/db/` and `.wrangler/` are gitignored.
- Never delete `apps/app/.wrangler/state`, never run `db:reset`, and never
  delete tenant DB files by hand: they hold the seeded operator, organizations
  and customers.

## Seeded data

| What                   | Value                                                                                                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operator login         | username `kody`, password `KodyLovesYou!2026` (admin role in both orgs)                                                                                                            |
| US organization        | slug `acme`, id `t58bgatqh3rv0s3movrecyj1`, `dataRegion=us`, site published. In D1 and `data.db`. Staffing flags are on (org-level rows in D1).                                    |
| KSA organization       | slug `riyadh-grill`, name "Riyadh Readiness Grill", id `ru0dm42cud9scs4g2duep21c`, `dataRegion=ksa`, site published. **In D1 only** (not in `data.db`, so Admin does not list it). |
| Customers              | acme: `+15555550123`. riyadh-grill: `+966500000123`.                                                                                                                               |
| Staffing demo data     | Removed when acme's stale staffing tables were repaired. Recreate with `commands.seed_staffing_acme` if a feature needs it.                                                        |
| Reservations demo data | `commands.seed_reservations_acme` / `seed_reservations_ksa` (built and extended by the mission; local only; idempotent).                                                           |

## ConfigFlag rows

- Table
  `ConfigFlag(id, key, value, level, organizationId, userId, createdAt, updatedAt)`.
  `value` is JSON text (`'true'`, `'250'`). `level` is `system`, `organization`
  or `user`. Timestamps are milliseconds.
- The unique index `(key, level, organizationId, userId)` includes a NULL
  `userId`, so SQLite does not stop duplicates: delete, then insert (as
  `scripts/set-org-flag.sh` does).
- App dev reads flags from local D1; Admin dev reads and writes `data.db`. In
  production both use the same D1.

## Gotchas (all verified during readiness)

1. **Varlock rewrites tracked `src/env.ts` files** (reports, security, auth,
   email and others) without Prettier formatting whenever tests, typecheck or
   dev servers run. Run `commands.clean_generated` before committing: Prettier
   restores the committed form and keeps genuine schema changes. Never commit
   formatting-only `env.ts` diffs.
2. **App typecheck (about 3.4 GB) and App ESLint (about 4.1 GB) must never run
   at the same time.**
3. **Stop services by process group** (the `stop` commands in `services.yaml`).
   `pgrep -f workerd` matches the calling shell; use
   `lsof -ti tcp:<port> -sTCP:LISTEN` or `ps -eo pid,args | grep [w]orkerd`.
4. **Sites and App listen on IPv6 loopback.** Sites resolves the organization
   from the Host header; `*.localhost` returns 404. Use
   `Host: acme.menuza.test:3008` with curl, or the browser flag
   `--host-resolver-rules=MAP *.menuza.test [::1]` (mapping to `127.0.0.1` gives
   connection refused).
5. **The KSA node needs its own `TENANT_DB_DIR`.** Sharing the US directory made
   the KSA node hold cached connections to files the US node deleted during a
   region switch.
6. **App HMR needs `VITE_DIRECT_DEV=1`**, otherwise the HMR client targets the
   HTTPS proxy and pages keep stale chunks ("Invalid hook call"). Reload any
   page that shows that error or renders without interactive elements.
7. **The first App healthcheck** can return 500 ("Call bindCloudflareD1() before
   using db") or take more than 30 s. Poll with `--max-time 60`.
8. **Admin silently moves to another port** when 3005 is busy; the start command
   fails instead. Admin has no `/login`; it reuses the App session cookie but
   checks `data.db`, so copy the session first (`commands.copy_admin_session`).
9. **The acme tenant DB had stale staffing tables** from an older branch (fixed
   during readiness; backup at
   `/home/factory-user/reservations-planning/readiness/backups/tenant_acme_before_fix.db`).
   If a tenant DB again reports "table already exists", return to the
   orchestrator rather than dropping tables.
10. **Logging out and back in lands on `/_.data` (404)**, a known repo issue.
    Use a fresh browser session and open `/login` directly to switch users.
11. **`npm run lint -w @repo/payments|@repo/ui|@repo/notifications`** crash
    without the Linux bindings; with them they pass.
12. **`wrangler d1 migrations apply DB --local` fails with
    `SQLITE_ERROR: too many terms in compound SELECT`** when a control-plane
    migration uses a multi-branch `UNION ALL` inside
    `INSERT INTO ... SELECT ... WHERE NOT EXISTS`. Write one
    `INSERT ... WHERE NOT EXISTS` statement per row (as
    `0025_reservations_foundation.sql` does for the six flags instead of a
    shared `UNION ALL`).
13. **Editing SQL in an already-applied tenant migration never reaches existing
    local tenant DBs.** Each tenant DB's `__drizzle_migrations` records the file
    as applied and both seed commands are no-ops for it, so a corrected
    hand-appended trigger lives only in freshly migrated DBs. After such an
    edit, refresh the hand-built objects (DROP/CREATE the changed triggers) in
    **both** roots: `packages/database/db/tenant_*.db` (US node) and
    `packages/database/db/ksa/tenant_*.db` (KSA node started by `services.yaml`
    `tenant-api-ksa`). Verify with
    `sqlite3 "file:<db>?mode=ro" "SELECT name, sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'rsv_%'"`;
    never delete a tenant DB file to force a rebuild.

## Known pre-existing issues (do not fix)

- App ESLint: 59 errors (design-system rules) in six menu files, plus 79
  warnings. Gate on "no new errors" (`commands.lint_app_gate`).
- No role grants `read:analytics:any` (repo AGENTS.md known issue).
- The pre-commit ESLint step checks nothing (lint-staged runs from the root,
  which ignores every file). Run workspace lint yourself.
