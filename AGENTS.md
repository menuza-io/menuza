# AGENTS.md

This file provides AI coding agents with essential context for working on the
Menuza monorepo.

## Project Overview

**Menuza** is a production-ready, full-stack SaaS template built as a
Turborepo-based monorepo with npm workspaces. It includes multiple apps (main
app, marketing site, admin dashboard, tenant sites, regional tenant-api, mobile
app, CMS, jobs-cron, email templates, notifications) and shared packages (UI,
auth, tenant-db, AI, payments, storage, security, i18n, etc.).

**Tech Stack**: React 19 + React Router 8, Node.js 22, SQLite + Drizzle,
Tailwind CSS 4, TypeScript, Expo (mobile), Astro (marketing + tenant sites).
App/Admin deploy on Cloudflare Workers with D1. CMS deploys on Vercel (Turso +
R2 via S3). Regional tenant-api: the US node is a Cloudflare Worker with one
SQLite Durable Object per org by default (OCI Ashburn is optional); the KSA node
runs on OCI Ampere in Riyadh with per-org SQLite on a block volume.

**Monorepo Structure**:

- `/apps/*` - Applications (app, web, admin, sites, tenant-api, cms, etc.)
- `/packages/*` - Shared packages (ui, auth, database, tenant-db, sms, etc.)
- `/docs/*` - Comprehensive documentation

**Tenant Sites vs App auth (read this before touching login, cookies, or PII):**

- **App / Admin** authenticate operators. Sessions live in US control-plane
  SQLite.
- **Sites** (`apps/sites`) authenticate **customers** with phone OTP. Customer
  PII lives in **regional** per-org SQLite (`packages/tenant-db`) behind
  `apps/tenant-api`, not in the US control-plane database.
- The **browser** calls tenant-api directly. Sites SSR (often US) must not proxy
  phone/name/email — a Sites BFF would transit KSA PII through the US. Tokens
  stay in `localStorage`, not Sites cookies.
- Changing **Customer data region** wipes the old tenant DB. Do not add
  cross-region PII migration.
- Canonical doc: `docs/tenant-data-residency.md`. ADR:
  `docs/decisions/045-tenant-data-residency.md`.

## Agent quickstart

Run commands from the repo root. Before you work in `apps/app`, read
`apps/app/AGENTS.md` (code map, local data, browser testing, single fetch, UI
kit, i18n, tests).

**Developer machine or sandbox? Decide first.**

- A _developer machine_ is a person's own computer, usually macOS, where they
  run root `npm run dev` and use App at `https://app.menuza.test:2999` through
  the HTTPS proxy. Treat the machine as one if you are on macOS, if
  `curl -sk -o /dev/null -w '%{http_code}\n' https://app.menuza.test:2999/login`
  prints anything but `000`, or if root `npm run dev` is running. A _headless
  Linux sandbox_ is a disposable VM or container made for an agent, with no
  proxy. A proxy or root dev that you, or an earlier agent session, started
  inside a disposable sandbox does not make it a developer machine. If you
  cannot tell who started it and no user is available, treat it as a developer
  machine and change nothing. If unsure, ask the user.
- On a developer machine:
  - If root dev is running, use it, and do not stop or restart it. If it is not
    running, ask the user before you start any dev server, and start only what
    they agree to, normally root `npm run dev` (it first kills whatever listens
    on the dev ports). Builds, Vitest, lint and typecheck need no permission.
  - Do not edit `apps/app/.env`, `apps/admin/.env` or `apps/app/.dev.vars`, and
    never add a `BASE_URL` override. App dev rewrites `.dev.vars` from `.env`
    and restarts when either changes, and a localhost `BASE_URL` makes the
    session cookie host-only (not shared with Admin) and moves SSO callbacks,
    email links and the JWT issuer to localhost.
  - Never run `npm run dev -w app` or `npm run dev:tenant-api` beside root dev;
    root dev holds 3001 and 3007. App fails on 3001 only after it has rewritten
    `.dev.vars` (restarting the running App) and migrated the shared local D1.
  - Never run `.agents/setup`, the `npm_config_os=linux` install or
    `write-ci-app-env.mjs`. They replace macOS native binaries and overwrite
    both `.env` files, losing the real keys.
  - Ask before `db:reset` (deletes the LibSQL database that Admin dev and local
    tenant-api read), deleting `apps/app/.wrangler/state` (erases all local App
    data), importing seed SQL into local D1 (adds demo users), or Playwright
    E2E, including `npm run test:e2e:run` and `npm run validate` (they write
    test data to LibSQL and start their own servers).
  - Stop only processes you started. Never kill by port or with broad `pkill`
    patterns.
  - Note `git status` before you start, and at the end revert only generated
    changes you caused.

**Which database a command uses.**

| Used by                                                     | Database                                                                                              |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| App dev (root `npm run dev` or `npm run dev -w app`)        | local D1 in `apps/app/.wrangler/state` (binding `DB`)                                                 |
| `db:seed`, `db:migrate:deploy`, `db:studio`, Playwright E2E | LibSQL `packages/database/db/data.db`                                                                 |
| App Vitest                                                  | `apps/app/tests/database/base.db`, copied per worker and rebuilt when the schema or migrations change |
| tenant-api (local)                                          | `packages/database/db/tenant_<orgId>.db`                                                              |

`npm run db:seed` does not seed local D1. `apps/app/AGENTS.md` has a recipe that
copies seed data into local D1.

**Check your work.**

- Types and lint:
  `cd apps/app && NODE_OPTIONS=--max-old-space-size=6144 npm run typecheck`,
  ESLint on the files you changed, and `npx oxlint <paths>`. Run ESLint from
  inside a workspace; from the repo root it ignores every file. See "Running
  commands as an agent" below for heap sizes, the App ESLint baseline and
  workspaces without a `lint` script.
- Unit tests: `cd apps/app && npx vitest run <paths>`.
- E2E: `npm run build -w app`, then
  `cd apps/app && PORT=3101 CI=true npx playwright test <spec> --workers=1`. On
  a developer machine, ask first: it writes to LibSQL.
- Pre-commit runs `node scripts/check-lingui.mjs`. Run it before you commit.
- Tests, builds and dev servers can rewrite tracked files (Varlock `env.ts`
  files, icon sprites). Compare `git status` with what you noted at the start
  and revert only generated changes you caused.

### Running commands as an agent

These apply on both kinds of machine. Per-workspace commands are in the
`project-agent-commands` skill (`docs/skills/project-agent-commands/SKILL.md`).

- **Typecheck.** App and Admin run `react-router typegen && tsc`, which runs out
  of memory at Node's default heap. Use
  `cd apps/app && NODE_OPTIONS=--max-old-space-size=6144 npm run typecheck`
  (about 70 s and 3.4 GB). Never run it at the same time as App ESLint, a build
  or Playwright. Sites and web typecheck with `astro check`. The tenant-api
  typecheck first runs `codegen` and `generate:do-migrations`, which rewrite
  `env.d.ts` and the gitignored `workers/migrations.generated.ts`.
- **Lint.** Only app, admin, sites, web, mobile, chrome-extension, docs and the
  packages audit, flow-editor, marketing-workflow, notifications, payments,
  types, ui and validation have a `lint` script. For tenant-api, jobs-cron,
  voice-agent and the other packages, use `npx oxlint <paths>` and
  `npx prettier --check <files>`. In App, lint only the files you changed:
  `cd apps/app && NODE_OPTIONS=--max-old-space-size=4096 npx eslint <paths>`.
  The whole-workspace `npm run lint -w app` reports pre-existing errors (59 at
  the time of writing, all `shadcn/*` design-system rules in
  `app/components/menu/` and the `menu+` routes), so compare against that
  baseline instead of expecting exit 0. ESLint aborts the whole run if any path
  you pass does not exist.
- **ESLint `--fix` hazard.** The `jest-dom/prefer-enabled-disabled` autofix on
  `expect((el as HTMLButtonElement).disabled).toBe(true)` leaves unbalanced
  parentheses. Write `expect(el).toBeDisabled()` by hand, and lint again after
  any `--fix`.
- **Tests.** Run Vitest from inside a workspace, never from the repo root (there
  is no root Vitest config). Set `CI=true` (App then uses 2 workers). App's test
  config is in `apps/app/vite.config.ts`. tenant-api, auth, cache, common,
  database, email, observability, reports, security, sso, tenant-db and
  validation wrap Vitest in `varlock run`, so run one file there with
  `CI=true npm run test -w <workspace> -- <path>` to load the env. Add
  `--reporter=verbose` to see test names. mobile uses Jest
  (`npm run testing -w mobile`), so `npm run test` skips it. The whole App suite
  takes about 7.5 min and 2.6 GB; run it alone.
- **Timeouts.** App typecheck, whole-suite tests, `npm run build -w app` (about
  110 s) and Playwright take longer than a 60 s default; allow 300-600 s. Start
  dev servers with your tool's background mode or `setsid`; a plain
  `nohup ... &` in a one-shot shell dies with that shell. Poll health with
  `curl --max-time 5`.
- **Exit codes.** Do not pipe test, typecheck or lint output into `tail` or
  `grep` and then read `$?`. Redirect instead:
  `<cmd> > /tmp/x.log 2>&1; echo EXIT=$?`, then search the log.
- **Varlock trailer.** A failing command under Varlock ends with "try running
  the same command without varlock...". Ignore it and read the error above it.
- **One-off TypeScript.** `tsx -e` compiles to CommonJS, so top-level `await`
  fails. Write a `.mts` file and run it with `node_modules/.bin/tsx`, or wrap
  the code in `;(async () => { ... })()`. A script that imports a repo
  dependency (for example `jose`) must live inside the repo tree, not `/tmp`.
  Pass multi-line programs through a heredoc.
- **SQLite.** Use the `sqlite3` CLI (`better-sqlite3` is not installed). Run
  `.schema <table>` first, or read `packages/database/src/schema.ts` and
  `packages/tenant-db/src/schema.ts`, instead of guessing column names. Use
  absolute paths. Recent writes may still be in the `-wal` file, so copy with
  `sqlite3 <src> ".backup /tmp/x.db"`, not `cp`, and open a live file read-only
  as `"file:<path>?mode=ro"`. Local App D1 is
  `apps/app/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite`; query it
  with
  `cd apps/app && npx wrangler d1 execute DB --local --json --command "<sql>"`
  (5-15 s per call, and it masks secret-looking columns as asterisks).
- **Generated files.** Varlock rewrites tracked `src/env.ts` files without
  formatting. Restore them with
  `npx prettier --write $(git ls-files -m | grep -E '(^|/)src/env\.ts$')`, which
  keeps genuine schema changes, instead of `git checkout`. Check
  `git diff --quiet -- package-lock.json` for stray lockfile changes.
- **Secret scanners.** A fixture named like `secret*` with a long random-looking
  literal can be blocked when you push. Use obviously fake values such as
  `test-only-not-a-secret`.

### Headless Linux sandbox setup

Use this only in a headless Linux sandbox. Never use it on a developer machine.

**1. Bootstrap once.** Run `.agents/setup` (Linux-only, needs sudo). It installs
Node and dependencies, overwrites both `.env` files with placeholder secrets
when either is missing, runs `npm run setup`, seeds a new LibSQL database,
installs Playwright Chromium, and builds. Without sudo, run by hand:

```bash
# Linux only, never on macOS: installs the Linux native bindings
npm_config_os=linux npm_config_cpu=x64 npm_config_libc=glibc PUPPETEER_SKIP_DOWNLOAD=true npm install
node scripts/write-ci-app-env.mjs --for-cloudflare-build # only when neither .env file exists; it overwrites both
npm run db:migrate:deploy && npm run db:seed
npm run build
```

`npm run build` is required: App imports gitignored `dist` builds
(`@repo/observability`, `@repo/security`) and the icon sprite, and neither an
install hook nor `npm run dev -w app` creates them.

**2. Run App on localhost.**

- Add `BASE_URL=http://localhost:3001` to `apps/app/.env`. The default
  `BASE_URL` is the HTTPS proxy (`https://app.menuza.test:2999`), which gives
  the session cookie `Domain=.menuza.test`, so sign-in on localhost fails
  without an error.
- Start: `VITE_DIRECT_DEV=1 VITE_HMR_PORT=3001 npm run dev -w app`. Without
  `VITE_DIRECT_DEV=1` the HMR client connects to the proxy on 2999 and logs
  WebSocket errors. `npm run dev:app` goes through Turbo, which drops these
  variables.
- The script writes `apps/app/.dev.vars`, migrates local D1, and serves
  `http://localhost:3001` (health check: `/resources/healthcheck`). Reports and
  staffing also need `npm run dev:tenant-api` (port 3007).
- Root `npm run dev` first kills whatever listens on the dev ports (2999,
  3001-3005, 3007-3009, 8787, 24678, 24679). Stop a server you started by its
  process group, as described under "Local services (headless)" below.

**3. Local services (headless).**

These recipes are for a headless sandbox only. On a developer machine, use the
running root `npm run dev` and follow the rules above. Check `ss -Htlnp` first
and reuse a service that is already running.

| Service        | Start                                                                                                            | Port | Health check                                                     | Notes                                                                                                                                                                                                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| App            | `cd apps/app && VITE_DIRECT_DEV=1 VITE_HMR_PORT=3001 npm run dev`                                                | 3001 | `/resources/healthcheck`                                         | Needs the localhost `BASE_URL` (step 2). A warm start takes about 70 s; the first start after `npm install` can take about 15 min. Early checks can return 500 "Call bindCloudflareD1()" while it warms up. Reload a page that shows "Invalid hook call" or no controls. |
| Admin          | `cd apps/admin && PORT=3005 npm run dev`                                                                         | 3005 | `/resources/healthcheck`                                         | Needs `apps/admin/.env`. Moves to the next free port (up to +100) without failing if 3005 is busy, so check the port first. Shares App's local D1 when it exists (`apps/admin/scripts/dev.mjs`), so start App once first.                                                |
| Sites          | `cd apps/sites && PUBLIC_APP_URL=http://localhost:3001 npm run dev`                                              | 3008 | `curl -H 'Host: <slug>.menuza.test:3008' http://localhost:3008/` | Resolves the org from the Host header; `localhost` never resolves to an org. See the Sites notes below.                                                                                                                                                                  |
| tenant-api US  | `npm run dev -w tenant-api`                                                                                      | 3007 | `/health` (region `us`)                                          | Tenant DBs default to `packages/database/db/tenant_<orgId>.db`.                                                                                                                                                                                                          |
| tenant-api KSA | `mkdir -p packages/database/db/ksa && TENANT_DB_DIR=$PWD/packages/database/db/ksa npm run dev:ksa -w tenant-api` | 3009 | `/health` (region `ksa`)                                         | `dev:ksa` sets no `TENANT_DB_DIR`, so without it both nodes share the same tenant DB files.                                                                                                                                                                              |
| jobs-cron      | `cd apps/jobs-cron && npm run dev`                                                                               | 8787 | `/health`                                                        | `wrangler dev`.                                                                                                                                                                                                                                                          |

Dev ports (`scripts/kill-dev-ports.mjs`): 2999 proxy, 3001 app, 3002 web, 3003
studio, 3004 docs, 3005 admin, 3007 tenant-api US, 3008 sites, 3009 tenant-api
KSA, 8787 jobs-cron, 24678 Admin Vite HMR, 24679 App Vite HMR.

- **Stopping.** Kill the process group, not only the listener:
  `kill -- -$(ps -o pgid= -p "$(lsof -nP -tiTCP:<port> -sTCP:LISTEN | head -1)" | tr -d ' ')`.
  Killing only the listener leaves `tsx watch` or `workerd` children behind, and
  the next start fails with `EADDRINUSE`. Without `lsof`, find the listener PID
  with `ss -Htlnp 'sport = :<port>'` (`-l` lists listeners only; without
  `-sTCP:LISTEN`, `lsof` also matches client connections).
- **Sites hosts.** Sites accepts `<slug>.<suffix>` where the suffix is the brand
  domain, `ROOT_APP` (default `menuza.test`, `apps/sites/.env.schema`) or a
  `PUBLIC_SITE_HOST_SUFFIXES` entry (`apps/sites/src/lib/resolve-host.ts`).
  Observed: the dev server listens on IPv6 `[::1]`, so in a browser use Chromium
  `--host-resolver-rules="MAP *.menuza.test [::1]"`, not `127.0.0.1`.

**4. Local auth, OTP and email in dev.**

- Customer OTP SMS without Twilio prints `[SMS MOCK] To: <phone> | Message: ...`
  to tenant-api stdout (`packages/sms`). Search the log for the 6-digit code.
- tenant-api email without OCI logs `[OCI EMAIL MOCK] To: ... | Subject: ...`,
  with no body.
- App email under Workers dev calls the real Resend API and fails with
  placeholder keys. The Node/MSW server writes each email to
  `packages/test-utils/fixtures/email/<recipient>.json`.
- The App `Verification` table stores a TOTP secret, not a code. Compute the
  code with `generateTOTP` from `@epic-web/totp` and the stored secret,
  algorithm, digits, period and charSet.
- Usernames allow only letters, digits and `_`
  (`packages/validation/src/user-validation.ts`); hyphens are rejected.
- Local tenant-api rate limits see every local client as one identity:
  `resolveClientIp` (`apps/tenant-api/src/lib/rate-limit.ts`) falls back to
  `unknown` without `cf-connecting-ip` or `x-forwarded-for`. Give each curl
  caller its own `-H 'X-Forwarded-For: 10.0.0.<n>'`. Browsers share one bucket,
  and it persists in the org DB across restarts.
- Public tenant-api routes resolve the org from the `Origin` header. Hono routes
  are strict about trailing slashes: `/x/` returns a generic 404 that looks like
  a missing route.
- Org feature flags are `ConfigFlag` rows. `value` is JSON text. The unique
  index includes the nullable `userId`, so delete then insert instead of
  upserting. `getFeatureFlag` (`packages/common/src/feature-flags.server.ts`)
  falls back from user to organization to system rows, so deleting an org row
  exposes the system row, which can differ between local D1 and `data.db`.

## Setup Commands

A person runs these on a developer machine; agents ask first. Sandboxes: see
"Headless Linux sandbox setup".

```bash
# Initial setup (one-time)
git clone <your-fork>
cd menuza
PUPPETEER_SKIP_DOWNLOAD=true npm install && npm run setup -s

# Install Playwright Chromium for App E2E tests. `--with-deps` uses sudo;
# without sudo run `cd apps/app && npx playwright install chromium`.
npm run test:e2e:install -w app
```

**Requirements**:

- Node.js 22.18.0, npm 10.9.0 (pinned with Volta). React Router 8.3 declares
  Node >=22.22.0, so its CLI prints "Oops, Node v22.18.0 detected". The commands
  still succeed.

## Development

```bash
# Start all apps in parallel through the HTTPS proxy on 2999.
# Frees the dev ports first (see Agent quickstart).
npm run dev

# Start specific apps
npm run dev:app             # Main React Router app (port 3001, Cloudflare Workers dev)
npm run dev -w app          # Same, without Turbo (sandbox only, never beside root dev)
npm run dev -w admin        # Admin (port 3005)
npm run dev:web             # Astro marketing site (port 3002)
npm run dev:sites           # Tenant public sites (port 3008)
npm run dev:tenant-api      # US tenant-api (port 3007, DATA_REGION=us)
npm run dev:tenant-api:ksa  # KSA tenant-api (port 3009, DATA_REGION=ksa)
npm run dev:mobile          # Expo mobile app

# `npm run dev` already starts both tenant-api nodes (3007 + 3009).

# Database management
npm run db:studio      # Drizzle Studio UI (port 5555)
npm run db:migrate:deploy # Apply control-plane SQL migrations (LibSQL / tests)
npm run db:migrate:d1:local -w app # Same migrations on Workers local D1 (app dev)
npm run db:seed        # Seed LibSQL (packages/database/db/data.db), not local D1
npm run db:reset -w @repo/database # Delete, migrate and re-seed LibSQL (destructive; agents ask first)
```

## Build & Test

```bash
# Build all packages and apps
npm run build

# Type checking
npm run typecheck

# Linting
npm run lint           # ESLint via Turbo
npm run lint:oxc       # Fast Oxlint (Rust-based)
npm run lint:all       # Both linters

# Formatting
npm run format         # Prettier with Tailwind plugin

# Unit tests (Vitest)
npm run test           # Every workspace once, after building dependencies
cd apps/app && npx vitest # Watch mode for one workspace
npm run coverage -w app # Coverage (Turbo rejects `npm run test -- --coverage`)

# E2E tests (Playwright)
npm run test:e2e -w app # Playwright UI mode (interactive, not for agents)
npm run test:e2e:run   # Headless CI mode: builds, then runs the App and Admin suites

# Full validation (run before commits)
npm run validate       # lint + typecheck + test + e2e
```

On a developer machine, ask first: `npm run test:e2e:run` and the E2E step of
`npm run validate` set `CI=true`, build App, start their own App and Admin
servers on 3001 and 3005 (or fail when root dev holds those ports), and write
test data to LibSQL.

## Code Style & Conventions

**TypeScript**:

- Strict mode enabled
- Path aliases: `#app/*` (app code), `#tests/*` (tests), `@repo/*` (packages)
- Use Zod for all validation schemas
- React Router 8 loaders and actions with single fetch: client data requests go
  to `<path>.data` (see `apps/app/AGENTS.md`)

**Imports**:

- ESM modules throughout (`"type": "module"`)
- Consistent import ordering (enforced by ESLint)
- Prefer named exports over default exports

**Components**:

- PascalCase for component files and names
- Use the Base UI based components from `@repo/ui` (`render` prop, not
  `asChild`)
- Tailwind CSS with class-variance-authority for variants
- Use `cn()` utility for className merging

**Forms & Validation**:

- conform-to for form management
- Zod schemas for validation (client + server)
- Type-safe with TypeScript inference

**Naming**:

- Components: `PascalCase`
- Files: `kebab-case.tsx` (except components)
- Functions/variables: `camelCase`
- Constants: `SCREAMING_SNAKE_CASE`
- Types/Interfaces: `PascalCase`

## ESLint Best Practices

**Design system rules (`@shadcn/lint`)**:

`shadcn/*` ESLint rules check how design-system components are styled. The
shared policy lives in `packages/config/eslint-preset.js`; component internals
are exempt in `packages/ui/eslint.config.js` and
`apps/mobile/eslint.config.mjs`.

- Use theme tokens, existing variants, and sizes instead of raw palette colors,
  arbitrary values, or inline styles.
- A component's `no-restyle` contract lists what callers may change. Extend a
  contract only when the design system intentionally allows the change;
  otherwise fix the call site.
- `cn` comes from the `cn` package (`@repo/ui` re-exports it). Do not add `clsx`
  or `tailwind-merge`.

**Fixing ESLint Warnings in Bulk**:

When encountering many ESLint warnings, follow this systematic approach:

1. **Run ESLint with auto-fix first**:

   ```bash
   cd <workspace>   # for example apps/app or apps/admin
   npx eslint . --fix
   ```

   `npm run lint:fix -w <workspace>` does the same, but only `app`, `sites`,
   `web` and `@repo/ui` define `lint:fix`.

   This typically fixes 80-90% of warnings automatically (import order,
   formatting, etc.)

2. **Identify remaining warnings by category**:
   - Import order issues
   - Unused variables
   - React hooks dependencies
   - Type imports

3. **Fix manually in priority order**:
   - Security-related warnings (first priority)
   - Unused variables (quick wins)
   - Import order (remaining after auto-fix)
   - React hooks exhaustive-deps (requires code understanding)

**Common ESLint Warning Patterns**:

**1. Import Order (`import/order`)**:

Menuza enforces specific import ordering:

```typescript
// ✅ Correct order
import { useState } from 'react' // 1. External dependencies
import { useNavigate } from 'react-router' // 2. External dependencies
import { Button } from '@repo/ui/button' // 3. Monorepo packages (@repo/*)
import { db } from '@repo/database' // 4. Monorepo packages
import { requireUserId } from '@repo/auth' // 5. App imports (#app/*)
import { EmptyState } from '#app/components/empty-state.tsx' // 6. App imports
import { type Route } from './+types/route-name' // 7. Relative imports
import { NoteEditor } from './note-editor' // 8. Relative imports

// ❌ Wrong order - causes warnings
import { requireUserId } from '@repo/auth'
import { Button } from '@repo/ui/button'
import { useState } from 'react' // External should come first
```

**Key rules**:

- External packages first (react, react-router, third-party libs)
- Monorepo packages second (`@repo/*`)
- App-specific imports third (`#app/*`, `#tests/*`)
- Relative imports last (`./`, `../`)
- Within each group, alphabetical order by module path

**2. Unused Variables (`@typescript-eslint/no-unused-vars`)**:

The shared config (`@epic-web/config`) warns on an unused variable or argument
unless its name starts with `_` or `ignored`: `varsIgnorePattern` and
`argsIgnorePattern` are both `^(_|ignored)`, and `ignoreRestSiblings` is on.
Both prefixes pass; `ignored` is the preferred style because it reads as intent:

```typescript
// ✅ Preferred
const [ignoredSearchParams, setSearchParams] = useSearchParams()
const ignoredActionData = useActionData()

// ✅ Also accepted
const [_searchParams, setSearchParams] = useSearchParams()

// ✅ Rest siblings: `id` may stay unused
const { id, ...rest } = record
```

**3. React Hooks Exhaustive Dependencies (`react-hooks/exhaustive-deps`)**:

When useEffect/useCallback/useMemo have missing dependencies:

```typescript
// ❌ Wrong - missing dependencies
const handleChange = (key: string, value: string) => {
	const newParams = new URLSearchParams(searchParams)
	newParams.set(key, value)
	setSearchParams(newParams)
}

useEffect(() => {
	if (searchValue !== data.filters.search) {
		handleChange('search', searchValue)
	}
}, [searchValue]) // ⚠️ Missing: data.filters.search, handleChange

// ✅ Correct - wrap in useCallback and add all dependencies
const handleChange = useCallback(
	(key: string, value: string) => {
		const newParams = new URLSearchParams(searchParams)
		newParams.set(key, value)
		setSearchParams(newParams)
	},
	[searchParams, setSearchParams],
)

useEffect(() => {
	if (searchValue !== data.filters.search) {
		handleChange('search', searchValue)
	}
}, [searchValue, data.filters.search, handleChange]) // ✅ All deps included
```

**4. Type Import Specifiers (`import/consistent-type-specifier-style`)**:

Prefer inline type specifiers over top-level type-only imports:

```typescript
// ✅ Correct - inline type specifier
import { type LoaderFunctionArgs } from 'react-router'
import { type User, db } from '@repo/database'

// ❌ Wrong - top-level type-only import
import type { LoaderFunctionArgs } from 'react-router'
import type { User } from '@repo/database'
import { db } from '@repo/database'
```

**5. Duplicate Imports (`import/no-duplicates`)**:

Combine multiple imports from the same module:

```typescript
// ✅ Correct - single import
import { useLoaderData, Form, useActionData } from 'react-router'

// ❌ Wrong - duplicate imports
import { useLoaderData } from 'react-router'
import { Form } from 'react-router'
import { useActionData } from 'react-router'
```

**Pre-commit Hook Considerations**:

- The Husky pre-commit hook runs lint-staged (Prettier on staged
  js/jsx/ts/tsx/json/css/md files, then Oxlint and an ESLint step on
  js/jsx/ts/tsx files), then `node scripts/check-lingui.mjs`
- The lint-staged ESLint step checks nothing today (see Known issues). Run
  `npm run lint -w <workspace>` yourself
- Typecheck and tests are not part of pre-commit; run `npm run validate` before
  pushing (on a developer machine, ask first; see "Build & Test")
- If the hook fails, read its output. A Lingui failure means an unextracted
  string, an empty `msgstr` in a non-source catalog, or an unstaged `.po` file:
  extract, translate, stage, and commit again
- Use `git commit --no-verify` only when the hook cannot pass for a reason
  outside your change (for example a timeout on a large changeset), after you
  ran lint, typecheck and `node scripts/check-lingui.mjs` yourself. Say why in
  the commit message

**Workflow for Clean Commits**:

```bash
# 1. Auto-fix what you can, in each workspace you changed
(cd <workspace> && npx eslint . --fix)

# 2. Run full linting suite
npm run lint:all

# 3. Type check
npm run typecheck

# 4. If all pass, commit
git add -A
git commit -m "fix: resolve ESLint warnings"

# 5. Only if the hook cannot pass for a reason outside your change, and steps
#    2-3 and `node scripts/check-lingui.mjs` passed
git commit --no-verify -m "fix: resolve ESLint warnings (verified manually)"
```

## Testing Guidelines

**Unit Tests**:

- Place tests alongside source files (`*.test.ts`, `*.test.tsx`)
- Use Vitest + Testing Library
- Mock external services with MSW (Mock Service Worker)
- App helpers: Vitest database helpers in `apps/app/tests/test-utils.ts` and
  `apps/app/tests/dashboard-utils.ts`; static mock data in
  `apps/app/tests/fixtures/`

**E2E Tests**:

- Located in `apps/app/tests/e2e` and `apps/admin/tests/e2e`
- Use authenticated fixtures for logged-in scenarios
  (`apps/app/tests/playwright-utils.ts`)
- Clean up test data automatically
- 60-second timeout per test and 15 seconds per `expect`. With `CI=true`,
  Playwright adds 2 retries and uses 1 worker, so check new tests with
  `--retries=0 --repeat-each=3`
- Must pass before merging

**Coverage**: Aim for >80% coverage on critical paths (auth, payments, security)

## Security Considerations

**Critical Requirements**:

- ALWAYS sanitize user-generated HTML with DOMPurify before rendering
- ALWAYS validate environment variables on app startup (`SESSION_SECRET`,
  encryption keys)
- NEVER reduce bcrypt cost factor below 12
- ALWAYS escape user input in activity logs and system messages
- ALWAYS use Zod validation for all user inputs

**Security Features in Place**:

- AES-256-GCM encryption for sensitive data (SSO, integrations)
- PBKDF2-SHA512 key derivation (100k iterations)
- Bcrypt cost factor 12 for passwords
- 3-tier rate limiting (10/100/1000 req/min), plus DB-backed sliding-window
  limiters for endpoints needing a tighter/different window (forgot-password,
  translate API, MCP OAuth, SSO)
- Helmet.js security headers
- CSRF protection with honeypots
- HttpOnly, Secure, SameSite cookies (App/Admin operator sessions)
- Comprehensive audit logging
- Tenant customer tokens are **not** HttpOnly cookies: they live in
  `localStorage` so US Sites never receives KSA PII. Do not "fix" this by adding
  a Sites auth BFF or Sites-hosted session cookies. See
  `docs/tenant-data-residency.md`.

**Environment Variables**:

- `SESSION_SECRET` - Required, validated on startup (App/Admin)
- `AUDIT_LOG_SECRET_KEY` - Required in production for HMAC audit log integrity
  verification (App/Admin)
- `BASE_URL` - App/Admin public origin for emails, OAuth callbacks, and JWT
  issuer/audience. Canonical name in App code.
- `APP_URL` - Tenant-api only: US App origin for org-flag lookup when this node
  has no control-plane SQLite
- `APP_BASE_URL` - jobs-cron Worker only: App origin the worker POSTs to
- `SSO_ENCRYPTION_KEY` - 64 hex chars (32 bytes) for SSO IdP secrets and org S3
  credentials
- `INTEGRATION_ENCRYPTION_KEY` - 64 hex chars for integration OAuth tokens (App
  only)
- `TENANT_API_URL` / `TENANT_API_URL_KSA` - Regional tenant-api origins (App
  provision + browser calls from App/Sites; not a server PII proxy)
- `EMAIL_PROVIDER` - App/Admin: `resend` (default) or `oci`. When `oci`, set
  `OCI_*` vars; `sendEmail()` routes to OCI Email Delivery. See
  `docs/platform-marketing-email.md`.
- `INTERNAL_COMMAND_TOKEN` - Shared by App, Admin, every tenant-api, and
  `apps/jobs-cron` (≥16 chars). Authenticates cron POSTs to `/resources/jobs/*`
  and tenant provision/deprovision.
- `TENANT_OPERATOR_TOKEN` - Shared secret between App and tenant-api (≥16
  chars). Signs and validates operator JWT tokens for tenant-api `/operator/*`
  routes.
- `JOBS_CRON_WORKER_URL` - App only. Public URL of `apps/jobs-cron` Worker used
  to start storage migration workflows (production: `https://jobs.<apex>` custom
  domain).
- `MEDIA_TRANSFORM_BASE_URL` - App only. Cloudflare-proxied hostname with Media
  Transformations enabled; powers on-demand video posters/clips via
  `/cdn-cgi/media/`. Empty in dev (falls back to `/resources/videos/source`).
- `DATA_REGION` - Tenant-api only: `us` or `ksa`
- `TENANT_DB_DIR` - Tenant-api only: directory for `tenant_{orgId}.db` (OCI:
  `/data/tenants`)
- `JWT_SECRET` - App: mobile/API operator tokens. Tenant-api: customer tokens.
  Same name, **must not share values**.
- `AUTH_HMAC_SECRET` - Tenant-api only (OTP / refresh hashes). Sites must not
  have this.
- `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` - Tenant-api
  US node only (`@repo/sms`). Do not set on App or KSA.
- `PUBLIC_TURNSTILE_SITE_KEY` - Sites only: Cloudflare Turnstile site key for
  public form blocks. Empty disables the widget (local dev).
- `TURNSTILE_SECRET_KEY` / `TURNSTILE_HOSTNAMES` - Tenant-api only: Turnstile
  siteverify secret and comma-separated allowed hostnames for form submissions
  and careers applications (action `careers-apply`).
- `GOOGLE_MAPS_API_KEY` - Tenant-api (customer delivery address search +
  coverage quotes, `/delivery/*`) and App (store address search/geocoding).
  Optional; empty uses dev fixtures outside production. See
  `docs/delivery-coverage.md`.
- `VOICE_AGENT_TOKEN` - Shared by App, tenant-api, and `apps/voice-agent` (≥32
  chars, distinct from `INTERNAL_COMMAND_TOKEN`). Authenticates
  `/resources/phone-agent-config` and tenant-api `/api/voice/*`.
- `LIVEKIT_*` / `CARTESIA_API_KEY` - App and `apps/voice-agent` (US only). Empty
  in App hides browser test calls and the voice picker.
- `STAFFING_KIOSK_ENABLED` - Tenant-api only, optional (unset or `true` is on).
  Kill switch for the shared-tablet time clock: `false` (also `0`, `off`, `no`,
  `disabled`) answers 503 on every `/kiosk` route and refuses new pairing codes
  on that node; revoking a device always still works. A paired tablet keeps its
  device secret locally, so no organization flag can stop it. Runbook: revoke
  devices first, then use the switch. See `docs/staffing.md`.
- `STAFFING_EMAIL_ENABLED` - Tenant-api and App, optional (unset or `true` is
  on). Kill switch for staffing email: on tenant-api it drops staff reminders
  and notices (dropped, not held, so re-enabling sends no backlog); in the App
  it stops manager alert emails (in-app notifications are unaffected). `false`
  (also `0`, `off`, `no`, `disabled`).
- `STAFFING_TICK_INTERVAL_SECONDS` - Tenant-api Node (OCI) runtime only,
  optional. Seconds between in-process staff ticks (default 300, minimum 60, `0`
  off). The hourly cron fan-out always runs; the Workers runtime uses Durable
  Object alarms instead. See `docs/scheduled-jobs.md#staff-tick`.

**CMS Storage**:

- Local: `apps/cms/public/media/`
- Vercel: R2 via S3 API (`R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`)

## Marketing Emails (HTML blocks)

Broadcasts and automation email steps in App/Admin can be designed from blocks
(heading, body text, paragraph, image, button) and are rendered with React Email
in the org's website branding.

- Blocks + schema: `packages/common/src/email-blocks.ts`
- Merge tags (chips + fallbacks): `packages/common/src/merge-tags.ts` +
  `MergeTagField` in `@repo/marketing`. Stored as `{{tag}}` / `{{tag|fallback}}`
- Branding → email-safe colors/fonts: `packages/common/src/email-theme.ts`
  (converts `oklch()` to hex; email clients support neither CSS vars nor oklch)
- Renderer: `@repo/email/marketing` + `renderMarketingEmail()` in
  `@repo/marketing/server/email-render`
- Rendering happens **at design time** (App/Admin action) and the HTML is stored
  (`content_html` / automation node `bodyHtml`); tenant-api and jobs-cron only
  interpolate merge tags into it, with values HTML-escaped.
- In automations the designer is a **full-screen overlay with an explicit Save**
  (`EmailDesignOverlay`): it edits a local draft and discards it if you leave
  without saving, so nothing hits the journey implicitly.
- Details: `docs/platform-marketing-email.md`

## PR & Commit Guidelines

**Pre-commit Checks**:

- Husky runs `lint-staged` on commit (Prettier, Oxlint, and an ESLint step that
  checks nothing today; see Known issues), then `node scripts/check-lingui.mjs`
- Typecheck and full test suites are **not** run in pre-commit; use
  `npm run validate` before pushing (on a developer machine, ask first; see
  below)

**Before Submitting PR**:

```bash
npm run validate  # Must pass: lint + typecheck + test + e2e
```

On a developer machine, ask first: its E2E step sets `CI=true`, builds App,
starts its own App and Admin servers on 3001 and 3005 (or fails when root dev
holds those ports), and writes test data to LibSQL.

**Branch Naming**: Use `pr/your-feature-name` format

**Commit Messages**:

- Clear, descriptive messages
- Reference issue numbers where applicable
- Format: `feat(scope): description` or `fix(scope): description`

**PR Requirements**:

- All CI checks must pass (lint, typecheck, unit tests, E2E tests)
- No merge to `main` or `dev` without passing tests
- Code review required

## Database Operations

**Control-plane Drizzle workflow** (`@repo/database`):

```bash
# After schema changes in packages/database/src/schema.ts
cd packages/database
npx drizzle-kit generate --name your_migration_name
# Review the SQL, then from the repo root apply it to both local databases.
# (Vitest rebuilds its own database.) On a developer machine, tell the user
# before applying it: this migrates the local databases their running App and
# Admin use, and it cannot be undone.
npm run db:migrate:deploy          # LibSQL, runs src/migrate.ts through Varlock
npm run db:migrate:d1:local -w app # Workers local D1

# View data
npm run db:studio    # Opens Drizzle Studio on localhost:5555
```

Call sites use `import { db } from '@repo/database'` with Drizzle tables and
queries. Native SQL/query helpers also live on `db` from the same package.

**Database Notes**:

- Control-plane SQLite with D1 on Cloudflare Workers
- Production and staging use the D1 binding `DB` (`apps/app/wrangler.jsonc`)
- Local: see the database table in Agent quickstart
- Use "widen then narrow" migration strategy for zero-downtime
- App/Admin D1 is the **US control plane**. Customer PII lives in a **separate**
  regional tenant data plane per `dataRegion` (`us` | `ksa`): by default a
  Cloudflare Worker with Durable Objects in the US, and OCI Riyadh for KSA.
  Never put KSA SQLite on the US App D1 cluster.

**Tenant SQLite (regional customer data plane):**

- Schema: `packages/tenant-db/src/schema.ts`
- Migrations: `packages/tenant-db/drizzle/`
- Production path: `TENANT_DB_DIR` on an OCI block volume (`/data/tenants`)
- Provisioned when the organization is created; region switches destroy the old
  database and immediately provision an empty one in the new region
- `Organization.dataRegion` and `hasProvisionedDb` are flags only

## Deployment

**Platform**: Cloudflare Workers (App/Admin) + Vercel (CMS) + Cloudflare Workers
(jobs-cron) + tenant-api (US: Cloudflare Worker + Durable Objects by default,
optional OCI Ashburn; KSA: OCI Riyadh) + Cloudflare Pages (Sites / marketing
web)

**Deployment Trigger**: Push to `main` (production) or `dev` (staging)

**CI/CD Pipeline** (GitHub Actions):

1. Lint with Oxlint
2. Build + TypeCheck
3. Unit tests (Vitest)
4. E2E tests (Playwright, 60min timeout)
5. Deploy App/Admin to Cloudflare Workers; CMS to Vercel; jobs-cron to
   Cloudflare Workers; Sites and marketing web to Cloudflare Pages
6. Tenant-api: US node deploys as a Cloudflare Worker; KSA builds `linux/arm64`,
   pushes GHCR, and SSHes to the OCI Riyadh VM (an optional OCI Ashburn VM
   follows the same path)

**Zero-Downtime Deployments**:

- Cloudflare Workers handles deployment with instant routing
- Health checks: `/resources/healthcheck` (App/Admin); tenant-api `/health`

## Internationalization

**LinguiJS** for translations:

```bash
npm run lingui:extract -w <app>  # Extract strings (the root alias covers App only)
node scripts/check-lingui.mjs    # Check every Lingui app (pre-commit runs it)
```

- After extracting, fill every new `msgstr` in each non-source catalog
- Locales: `en` (source) and `ar` (RTL) in App, Admin and mobile; Sites also has
  `es`, `fr`, `de` and `zh`. Preview App in Arabic with `?lng=ar`
- Catalogs: `apps/app/app/locales/`, `apps/admin/app/locales/`,
  `apps/mobile/locales/`, `apps/sites/src/locales/`

## Monorepo Navigation

**Package Structure**:

```bash
npm run <script> -w <workspace>              # Run a script in one workspace
npx turbo run <task> --filter=<workspace>    # Same through Turbo (with task deps)
npm install <pkg> -w <workspace>             # Add a dependency, then review package-lock.json
```

**Key Packages**:

- `@repo/ui` - Shared components (Base UI + Tailwind)
- `@repo/auth` - Operator authentication & RBAC (App/Admin, not Sites customers)
- `@repo/database` - Control-plane SQLite schema & Drizzle client (no customer
  PII)
- `@repo/tenant-db` - Per-org customer SQLite (Drizzle)
- `@repo/sms` - OTP SMS (`packages/sms`; Twilio blocked for KSA production)
- `@repo/config` - Shared configs (ESLint, TypeScript, Prettier)
- `@repo/ai` - AI/ML integrations (Vercel AI SDK, Google AI)
- `@repo/security` - Security utilities (encryption, rate limiting)
- `@repo/phone-agent` - AI phone agent core: flow model, vertical contract,
  prompts, and call reports (see `docs/phone-agent-verticals.md`)
- `@repo/staffing` - Staff module domain code shared by App and tenant-api: Zod
  schemas, permission and `staffing.*` flag keys, PIN rules, formula-safe CSV
  export, time math (`computeTimecard` / `computeWeek`), clock state machine,
  and rule packs as data. No UI strings, no I/O. Neutral vocabulary: workplaces
  are opaque **scopes** (`DEFAULT_SCOPE_ID`), never "locations" (see
  `docs/staffing-plan.md`)

**Key Apps:**

- `apps/app` - Operators; publishes sites; routes provision by `dataRegion`;
  hosts `/resources/jobs/*` and `/resources/videos/source`
- `apps/jobs-cron` - Cloudflare Worker cron → authenticated App job routes
- `apps/sites` - Public CMS HTML; injects tenant-api URL; no PII proxy
- `apps/tenant-api` - Regional customer auth + SQLite (local US :3007, KSA
  :3009; production: US Cloudflare Worker + Durable Objects by default, KSA OCI
  Riyadh)
- `apps/voice-agent` - LiveKit worker that answers phone-agent calls (US only);
  loads config from App and logs calls through tenant-api
- `apps/ios` - Tenant customer iOS app (SwiftUI + `TenantKit` Swift package):
  branded shell, phone-OTP sign-in, and profile, reusing the published org
  branding and the regional tenant-api. Keychain session; no PII proxy. Swift
  tasks are opt-in (`npm run ios:test -w ios`) so Linux CI stays green
- `apps/android` - Tenant customer Android app (Kotlin, framework views only: no
  AndroidX/Compose/OkHttp — see its README for the size budget): same branded
  shell, phone-OTP sign-in, and profile as iOS, with the session in the Android
  Keystore. Opt-in via `npm run android:* -w android`; the Android toolchain is
  installed by `.agents/setup`

**Staff module (hiring, scheduling, staff management, time clock):**

- Staff, pay, punch, schedule, and applicant data lives in the **regional**
  tenant DB and is reached browser-direct with short-lived operator tokens. The
  US control plane keeps only permissions, flags, the organization's staff time
  zone (`Organization.staffingTimeZone`), opaque link ids, outbox rows, and
  public job postings. No staff PII in cross-plane events.
- Staff are not members: never write staff as `UserOrganization` rows, and
  removing a member only unlinks the login.
- Workplaces are opaque **scopes**. The generic module has one implicit scope
  per organization (`DEFAULT_SCOPE_ID = 'main'` in `@repo/staffing`); its time
  zone is edited at Staff, Time clock, Rules. Scope pickers hide while there is
  one. A vertical with several places maps its own ids onto scopes (scope-facts
  route, the token's `scopeIds` claim, `registerOrderSource` in
  `apps/tenant-api/src/services/order-source.ts`), like
  `docs/phone-agent-verticals.md`. Keep place, food and retail words out of
  generic staffing code (`packages/staffing/src/vocabulary.test.ts`).
- Everything user-visible is behind org-level feature flags read with
  `getFeatureFlag` (`staffing.enabled` master, plus `staffing.timeclock`,
  `staffing.scheduling`, `staffing.labor`, `staffing.hiring`), default off.
  Enforce at token mint and in every child loader and action.
- Time clock: tenant-api `/kiosk/*` (public, paired-device secret, PIN lookup by
  HMAC, persisted per-device backoff, first-name-only responses) and
  `/operator/timeclock/*` (labor policy, kiosk devices, pairing codes). The
  single time-math implementation is `computeTimecard` / `computeWeek` in
  `@repo/staffing`; punches and edit logs are append-only (triggers).
- Hiring: the public apply route is tenant-api `POST /careers/apply`, called
  from the careers page in the visitor's browser (never proxied by Sites). The
  organization comes from the browser `Origin`, never from a client-sent id; it
  needs Turnstile, a honeypot, durable per-address and per-organization limits,
  and recorded consent. Managers use `/operator/hiring/*`; the hire is one
  regional transaction (staff, assignment, position, checklist, application).
  Declined applicants are purged by the regional tick; the audit log is never
  purged. A new applicant reaches managers only as a generic event (id and
  count).
- Scheduling, labor and onboarding follow the same split: shifts, availability,
  labor figures and checklists live in the regional tenant DB; the control plane
  keeps the flags and a public job posting. The "my schedule" page uses a
  private link token, never a login. Sales are entered by hand unless a vertical
  registers an order source.
- Demo data: `npm run seed:staffing -w tenant-api -- <org-slug>` (local only;
  idempotent; goes through the same services as the API).
- Security gates in CI: `apps/tenant-api/src/routes/staffing-security.test.ts`
  (every staffing route refuses a missing, forged or grantless token and has
  cross-organization and cross-scope tests) and
  `apps/app/app/utils/staffing/staffing-guards.test.ts` (every staff loader and
  action awaits `requireStaffingAccess` first). A new staffing route must pass
  both.
- Canonical docs: `docs/staffing.md` (operator guide and runbook),
  `docs/decisions/047-staffing-data-residency.md` and `docs/staffing-plan.md`.

## Known issues

- **Logging out and back in lands on `/_.data` (404 "Organization not found").**
  Logout redirects to `/`, the client loads `/_.data`, and `requireUserId` in
  `packages/auth/src/auth.server.ts` builds `redirectTo` from that raw
  single-fetch URL. To switch users, use a new browser context and open `/login`
  directly. Remove when fixed.
- **No role grants `read:analytics:any`.** The report token route checks it, but
  no migration or `packages/database/setup-roles.ts` seeds it. Only roles with
  `read:settings:any` or `read:website:any` (the built-in admin role) can run
  reports. Remove when fixed.
- **The pre-commit ESLint step checks nothing.** lint-staged runs from the repo
  root, and the root `eslint.config.js` ignores every file. Run
  `npm run lint -w <workspace>` before committing. Remove when fixed.
- **The lockfile lacks the Linux resolver bindings.** `package-lock.json`
  installs only `@unrs/resolver-binding-darwin-arm64` (used by ESLint's
  `import-x` plugin) and `@oxc-resolver/binding-darwin-arm64`, so `npm ci` on
  Linux misses `@unrs/resolver-binding-linux-x64-gnu` and
  `@oxc-resolver/binding-linux-x64-gnu`. On Linux, install with the
  `npm_config_*` flags from Agent quickstart. Remove when fixed.

## Additional Resources

- **Agent guide for `apps/app`**: `apps/app/AGENTS.md` (code map, local data,
  browser testing, single fetch, UI kit, i18n, tests)
- **Sandbox bootstrap**: `.agents/setup` (headless Linux sandbox only)
- **Dashboards architecture**: `apps/app/README.md`
- **Local databases (D1 versus LibSQL)**: `docs/database.md` and
  `docs/getting-started.md`
- **Design-system lint policy**: the header of
  `packages/config/eslint-preset.js`
- **Project skills** in `docs/skills/`, also exposed to Droid at
  `.factory/skills/` (a symlink):
  - `project-agent-commands`: per-workspace verify commands, memory and
    timeouts, exit codes, SQLite, Lingui, Playwright and native builds
  - `project-browser-testing`: manual browser testing of App, Admin and Sites in
    a headless sandbox
  - `project-auth`: authentication, sessions, OAuth, passkeys, 2FA and regional
    customer auth
  - `project-caching`: cache selection, cachified, invalidation and safety
  - `project-database`: Drizzle schema, SQLite/D1 migrations, tenant databases
    and data residency
  - `project-deployment`: builds, CI/CD, Cloudflare, Pages, OCI and health
    checks
  - `project-email-marketing`: transactional email, campaigns, block email
    design and merge tags
  - `project-forms`: Zod and Conform forms, validation, uploads, honeypots and
    public tenant forms
  - `project-integrations`: OAuth integrations, encrypted tokens, adapters and
    callbacks
  - `project-jobs-observability`: cron triggers, Workflows, internal jobs,
    logging and telemetry
  - `project-mcp`: MCP OAuth, PKCE, client registration and scoped tools
  - `project-mobile`: Expo operator app and white-label iOS/Android tenant apps
  - `project-monorepo`: workspaces, Turbo tasks, shared packages and generated
    artifacts
  - `project-payments-commerce`: billing, checkout, shop processors, webhooks
    and orders
  - `project-permissions`: system and organization RBAC and permission-aware UI
  - `project-public-sites`: Astro tenant sites, host and locale resolution,
    caching, CSP and forms
  - `project-react-patterns`: React 19 and React Router 8 data APIs and
    TypeScript patterns
  - `project-routing`: flat routes, layouts, resource routes, loaders and
    actions
  - `project-security`: validation, XSS, CSP, rate limits, secrets and audit
    logging
  - `project-sso`: organization OIDC/SSO configuration and provisioning
  - `project-storage-media`: S3 storage, media, signed URLs and storage
    migrations
  - `project-tenant-data`: regional tenant-api, PII boundaries, provisioning and
    browser auth
  - `project-testing`: Vitest, Testing Library, Playwright, MSW and fixtures
  - `project-ui-guidelines`: accessible UI, shared components, Tailwind 4, i18n
    and design lint
- **Docs**: `/docs` directory
- **Contributing**: See `CONTRIBUTING.md`
- **Security**: See `docs/security.md`
- **Getting Started**: See `docs/getting-started.md`
- **Tenant data residency**: See `docs/tenant-data-residency.md`
- **Staff module (operator guide, flags, runbook)**: See `docs/staffing.md`
  (design in `docs/staffing-plan.md`)
- **Scheduled jobs & video transforms**: See `docs/scheduled-jobs.md`
- **Testing Guide**: See `docs/testing.md` (including E2E against the production
  build)
