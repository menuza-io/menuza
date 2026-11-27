# AGENTS.md

This file provides AI coding agents with essential context for working on the
Epic Startup monorepo.

## Project Overview

**Epic Startup** is a production-ready, full-stack SaaS template built as a
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
  run root `npm run dev` and use App at `https://app.epic-startup.test:2999`
  through the HTTPS proxy. Treat the machine as one if you are on macOS, if
  `curl -sk -o /dev/null -w '%{http_code}\n' https://app.epic-startup.test:2999/login`
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

- Types and lint: `npm run typecheck -w app`, `npm run lint -w app`, and
  `npx oxlint <paths>`. Run ESLint from inside a workspace; from the repo root
  it ignores every file.
- Unit tests: `cd apps/app && npx vitest run <paths>`.
- E2E: `npm run build -w app`, then
  `cd apps/app && PORT=3101 CI=true npx playwright test <spec> --workers=1`. On
  a developer machine, ask first: it writes to LibSQL.
- Pre-commit runs `node scripts/check-lingui.mjs`. Run it before you commit.
- Tests, builds and dev servers can rewrite tracked files (Varlock `env.ts`
  files, icon sprites). Compare `git status` with what you noted at the start
  and revert only generated changes you caused.

**Agent gotchas (from reviewing past sessions).**

- Find a file with `rg --files -g '<name>'` before you read it. Do not guess
  paths: past sessions lost many calls to `node_modules/...` and wrong-checkout
  paths.
- This template is often checked out more than once. Confirm
  (`git rev-parse --show-toplevel`) you are in the repo the user means before
  editing, and say so if the change belongs in another checkout.
- Keep parallel workers few, scoped and resumable. A usage-limit message ends or
  downgrades a worker silently: stop and report it.
- PR review feedback: `.claude/skills/pr-review-loop`. Reviewing how agents
  perform: `.claude/skills/session-doctor`.

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
  `BASE_URL` is the HTTPS proxy (`https://app.epic-startup.test:2999`), which
  gives the session cookie `Domain=.epic-startup.test`, so sign-in on localhost
  fails without an error.
- Start: `VITE_DIRECT_DEV=1 VITE_HMR_PORT=3001 npm run dev -w app`. Without
  `VITE_DIRECT_DEV=1` the HMR client connects to the proxy on 2999 and logs
  WebSocket errors. `npm run dev:app` goes through Turbo, which drops these
  variables.
- The script writes `apps/app/.dev.vars`, migrates local D1, and serves
  `http://localhost:3001` (health check: `/resources/healthcheck`). Reports and
  staffing also need `npm run dev:tenant-api` (port 3007).
- Root `npm run dev` first kills whatever listens on the dev ports (2999,
  3001-3005, 3007-3010, 8787, 24678, 24679). Stop the server you started by its
  listening port: `lsof -nP -tiTCP:3001 -sTCP:LISTEN | xargs -r kill`. Without
  `-sTCP:LISTEN`, `lsof` also matches client connections such as the dev
  proxy's. Without `lsof`, use
  `ss -Htlnp 'sport = :3001' | grep -o 'pid=[0-9]*' | cut -d= -f2 | xargs -r kill`
  (`-l` lists listeners only).

## Setup Commands

A person runs these on a developer machine; agents ask first. Sandboxes: see
"Headless Linux sandbox setup".

```bash
# Initial setup (one-time)
git clone <your-fork>
cd epic-startup
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
npm run dev:station         # Station tablet app (port 3010)
npm run dev:tenant-api      # US tenant-api (port 3007, DATA_REGION=us)
npm run dev:tenant-api:ksa  # KSA tenant-api (port 3009, DATA_REGION=ksa)
npm run dev:mobile          # Expo mobile app

# `npm run dev` already starts both tenant-api nodes (3007 + 3009).
# It also starts Station (3010), retaining https://pos.<brand-slug>.test:2999.

# Database management
npm run db:studio      # Drizzle Studio UI (port 5555)
npm run db:migrate:deploy # Apply control-plane SQL migrations (LibSQL / tests)
npm run db:migrate:d1:local -w app # Same migrations on Workers local D1 (app dev)
npm run db:seed        # Seed LibSQL (packages/database/db/data.db), not local D1
npm run db:reset -w @repo/database # Delete, migrate and re-seed LibSQL (destructive; agents ask first)
```

The dev domain comes from `getLocalDomain()` in `packages/config/brand.ts`. For
Menuza, App is `https://app.menuza.test:2999` and POS is
`https://pos.menuza.test:2999`. When `POS_URL` is empty in development, the
Terminals page uses this POS origin for pairing links and QR codes. Production
still requires `POS_URL`. Existing hosts-file setups need a person to re-run
`npm run setup:hosts` once to add the `pos.` hostname (unless using wildcard
local DNS). See `docs/pos.md` for the pairing flow.

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
- Use Zod for all validation schemas. The repo is on Zod 4: import
  `parseWithZod` / `getZodConstraint` from `@conform-to/zod/v4` (the bare
  `@conform-to/zod` entry is the Zod 3 adapter), set messages with `error`
  (`required_error`, `invalid_type_error` and `errorMap` are gone), give
  `z.record` two arguments, and read `ZodError.issues` (there is no `.errors`).
  A `z.any()` / `z.unknown()` object key is required unless you add
  `.optional()`. Issues carry no rejected value unless you parse with
  `{ reportInput: true }`. App and Admin call `installRequiredMessage()` (from
  `@repo/common/zod-defaults`) in `root.tsx` so a missing value still reads
  "Required"; every other default message is Zod 4's
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

Epic Startup enforces specific import ordering:

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
  provision + browser calls from App/Sites; not a server PII proxy) On a
  tenant-api node itself, `TENANT_API_URL` is its own public origin and is
  **required in production**: it is the origin of the signed confirmation and
  unsubscribe links in emails. The Node entry refuses to start without it. The
  Worker keeps serving (health, login, provisioning) and skips consent emails
  instead (a broadcast ends `Failed`), logging ids only. Only an explicit
  `NODE_ENV=development|test` is local: an unset `NODE_ENV` counts as
  production. The request origin or `Host` header is never used outside local
  development hosts (`localhost`, `127.0.0.1`, `::1`, `*.test`, `*.localhost`).
  Rollout order: set `TENANT_API_URL` on the node first, then deploy.
- `EMAIL_PROVIDER` - App/Admin: `resend` (default) or `oci`. When `oci`, set
  `OCI_*` vars; `sendEmail()` routes to OCI Email Delivery. See
  `docs/platform-marketing-email.md`.
- `INTERNAL_COMMAND_TOKEN` - Shared by App, Admin, every tenant-api, and
  `apps/jobs-cron` (≥16 chars). Authenticates cron POSTs to `/resources/jobs/*`
  and tenant provision/deprovision. It does not sign report JWTs.
- `OPERATOR_ANALYTICS_TOKEN` - App and every tenant-api (≥16 chars). Signs
  operator analytics JWTs. Must differ from `INTERNAL_COMMAND_TOKEN`. The schema
  default is refused outside development and test. Set it on each tenant-api
  first, then the App. An unset, placeholder, or command-token-equal App value
  makes the report token route answer 503, so no query runs. The same problem on
  a tenant-api, or a value that differs from the App, makes queries answer 401.
- `TENANT_OPERATOR_TOKEN` - Shared secret between App and tenant-api (≥16
  chars). Signs and validates operator JWT tokens for tenant-api `/operator/*`
  routes.
- `ORDER_ALERT_HASH_SECRET` - App and the US tenant-api only (32+ chars,
  distinct from `INTERNAL_COMMAND_TOKEN`). Keys the hash of a text alert
  recipient's number (STOP matching) and the one-time-code hash. The schema
  default is refused outside development and test. Changing it unlinks every
  stored recipient's STOP matching, so rotate by adding a hash version.
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
- `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` / `TURNSTILE_HOSTNAMES` - App
  (optional, separate values from Sites and tenant-api): Turnstile on operator
  login, signup and forgot-password. On only when both keys are set; empty
  disables it (local dev, Vitest, E2E). The mobile `/api/auth/*` JSON routes
  stay on rate limits. See `docs/security.md`.
- `VOICE_AGENT_TOKEN` - Shared by App, tenant-api, and `apps/voice-agent` (≥32
  chars, distinct from `INTERNAL_COMMAND_TOKEN`). Authenticates
  `/resources/phone-agent-config` and tenant-api `/api/voice/*`.
- `SITES_RESERVATION_PAYMENT_TOKEN` - Sites and App only (≥32 chars, distinct
  from `INTERNAL_COMMAND_TOKEN` and every other token). Authenticates only
  `/resources/sites/reservation/checkout` and `/status`; never give Sites
  `INTERNAL_COMMAND_TOKEN`.
- `LIVEKIT_*` / `CARTESIA_API_KEY` - App and `apps/voice-agent` (US only). Empty
  in App hides browser test calls and the voice picker.
- `STAFFING_KIOSK_ENABLED` - Tenant-api only, optional (unset or `true` is on).
  Kill switch for the shared-tablet time clock: `false` (also `0`, `off`, `no`,
  `disabled`) answers 503 on every `/kiosk` route and refuses new pairing codes
  on that node; revoking a device always still works. A paired tablet keeps its
  device secret locally, so no organization flag can stop it. Runbook: revoke
  devices first, then use the switch. See `docs/staffing.md`.
- `POS_DEVICE_HEALTH_ENABLED` - Tenant-api only, optional (unset or `true` is
  on). Kill switch for Station connection history (#356): `false` (also `0`,
  `off`, `no`, `disabled`) drops terminal heartbeats and answers the Health
  panel as off; stored history is kept. Collection also needs the organization
  flag `pos.device_health` (default off). See `docs/pos.md`.
- `PRINTING_ENABLED` - Tenant-api only, optional (unset or `true` is on). Kill
  switch for cloud printers (#117): `false` (also `0`, `off`, `no`, `disabled`)
  queues nothing and answers every printer's poll with "no job"; removing a
  printer always works. Needs the organization flag `kitchen.printers` (default
  off). See `docs/pos.md` ("Cloud printers").
- `POS_ENABLED` / `POS_ORIGINS` - Tenant-api only. Kill switch for the walk-in
  POS (`false` answers 503 on `/pos/*`; revoking a terminal always works) and
  the comma-separated POS web origins allowed to call `/pos/*` from a browser.
  `POS_URL` is App's: the POS origin used in pairing links. See `docs/pos.md`.
- `ZATCA_SEAL_KEY` / `ZATCA_SEAL_KEY_PREVIOUS` - Tenant-api only. The first (64
  hex chars) seals ZATCA EGS keys and CSID secrets and is required in
  production: the Node entry refuses to start without it. To rotate, move the
  old value to `ZATCA_SEAL_KEY_PREVIOUS` (comma separated); the hourly tick
  re-seals with the new key. See `docs/pos.md`.
- `VITE_POS_ALLOWED_ORIGINS` - Station build only. App and tenant-api origins
  the till may talk to; required in production builds (empty refuses every
  server).
- `STAFFING_EMAIL_ENABLED` - Tenant-api and App, optional (unset or `true` is
  on). Kill switch for staffing email: on tenant-api it drops staff reminders
  and notices (dropped, not held, so re-enabling sends no backlog); in the App
  it stops manager alert emails (in-app notifications are unaffected). `false`
  (also `0`, `off`, `no`, `disabled`).
- `REPORT_EMAIL_ENABLED` - Tenant-api only, optional (unset or `true` is on).
  Kill switch for scheduled report emails (#121): `false` (also `0`, `off`,
  `no`, `disabled`) drops sends on that node instead of holding them. See
  `docs/owner-reports.md`.
- `REPORT_UNSUBSCRIBE_SECRET` - App only, optional (16+ chars). Keys the
  one-click unsubscribe links in report emails (#121, #221). Unset, the session
  secret is used, and rotating it then breaks every link already sent. Set it
  before the first email goes out and rotate it only on purpose. See
  `docs/owner-reports.md`.
- `RESERVATIONS_EMAIL_ENABLED` - Tenant-api and App, optional (unset or `true`
  is on). Kill switch for reservations email: on tenant-api it drops guest
  emails (dropped, not held); in the App it stops manager-alert emails (in-app
  notifications are unaffected). `false` (also `0`, `off`, `no`, `disabled`).
  See `docs/scheduled-jobs.md#reservations-tick`.
- `RESERVATIONS_PUBLIC_ENABLED` - Tenant-api only, optional (unset or `true` is
  on). Kill switch for the public booking API: `false` (also `0`, `off`, `no`,
  `disabled`) answers 503 on every `/reservations/*` route of that node, manage
  links included. Operator routes are unaffected.
- `RESERVATIONS_SMS_ENABLED` - Tenant-api only, optional (unset or `true` is
  on). Kill switch for guest reservation SMS (US node only; the KSA node never
  sends it): `false` drops texts instead of holding them.
- `ORDERS_EMAIL_ENABLED` / `ORDERS_SMS_ENABLED` - Tenant-api only, optional
  (unset or `true` is on). Kill switches for guest order messages (receipt,
  ready, cancelled and changed-time emails; the "order is ready" text, US node
  only): `false` (also `0`, `off`, `no`, `disabled`) records the message as
  `dropped` instead of holding it, so switching back on sends no backlog. The
  order itself is never affected. See `docs/scheduled-jobs.md`.
- `ORDER_MESSAGES_TICK_INTERVAL_SECONDS` - Tenant-api Node (OCI) runtime only,
  optional. Seconds between in-process retries of guest order messages (default
  120, minimum 60, `0` off). `0` stops only these retries, never the acceptance
  timeout. The hourly cron fan-out always runs; the Workers runtime uses Durable
  Object alarms.
- `ORDER_ACCEPTANCE_TICK_INTERVAL_SECONDS` - Tenant-api Node (OCI) runtime only,
  optional. Seconds between in-process passes that turn down orders still
  waiting for manual acceptance past the deadline the guest was shown (#107),
  then book cancel refunds still owed (default 60, minimum 30). It cannot be
  switched off: `0`, a negative or an unreadable value means the default. The
  Workers runtime uses the `orders` Durable Object alarm module.
- `QR_DINE_IN_ENABLED` - Tenant-api only, optional (unset or `true` is on). Kill
  switch for QR table ordering: `false` (also `0`, `off`, `no`, `disabled`)
  answers 503 on dine-in placement, the table and tab context, starting a tab
  payment and the bridge's quote and bind for `tab:` ids. Pickup, delivery and
  operator routes are unaffected; payment events still apply. See
  `docs/qr-ordering.md`.
- `LOYALTY_ENABLED` - Tenant-api only, optional (unset or `true` is on). Kill
  switch for new loyalty work on a node: `false` (also `0`, `off`, `no`,
  `disabled`) answers 503 `loyalty_unavailable` on customer and till loyalty
  routes and on operator writes that start something new, and new orders neither
  earn nor take a reward. The tick, reconciliation, review decisions and refunds
  keep going, and operators can still read. See `docs/loyalty.md`.
- `GIFT_CARDS_ENABLED` - Tenant-api only, optional (unset or `true` is on). Kill
  switch for gift cards on a node: `false` (also `0`, `off`, `no`, `disabled`)
  answers 503 `gift_cards_unavailable` on new sales, top-ups, activations and
  redemptions. Balance reads, refunds back to a card, paid events and the tick
  keep working. See `docs/gift-cards.md`.
- `GIFT_CARD_HMAC_SECRET` - Tenant-api only, optional (32+ chars). Keys every
  gift card hash and the sealing of a purchased card's code. Unset,
  `AUTH_HMAC_SECRET` is used. Choose it before the first card is sold and never
  change it: there is no re-keying step, and a changed key makes existing cards
  unfindable.
- `GIFT_CARDS_TICK_INTERVAL_SECONDS` - Tenant-api Node (OCI) runtime only,
  optional. Seconds between in-process gift card ticks (default 120, minimum 60,
  `0` off). The hourly cron fan-out always runs; the Workers runtime uses
  Durable Object alarms.
- `DISCOUNTS_ENABLED` - Tenant-api only, optional (unset or `true` is on). Kill
  switch for discounts and coupons on a node: `false` (also `0`, `off`, `no`,
  `disabled`) makes it ignore every discount at quote, placement, tab payment
  and the till (`GET /pos/discount-rules` answers an empty list, uploaded sales
  keep their adjustments but get no discount-rule flag and record no use) and
  answer a request that carries a coupon code with 503 `discounts_disabled`.
  Orders already placed keep their discounts and their redemptions still settle.
  See `docs/discounts-plan.md`.
- `INVOICE_READER_BASE_URL` / `INVOICE_READER_API_KEY` / `INVOICE_READER_MODEL`
  / `INVOICE_READER_DATA_REGION` - Tenant-api only, optional. OpenAI-compatible
  vision endpoint that reads an inventory invoice photo into lines to check.
  Used only when the data region equals `DATA_REGION`. See `docs/inventory.md`.
- `INVENTORY_ENABLED` - Tenant-api only, optional (unset or `true` is on). Kill
  switch for inventory on a node: `false` (also `0`, `off`, `no`, `disabled`)
  answers 503 `inventory_unavailable` on operator and Station inventory routes.
  See `docs/inventory.md`.
- `INVENTORY_TICK_INTERVAL_SECONDS` - Tenant-api Node (OCI) runtime only,
  optional. Seconds between in-process inventory ticks (default 300, minimum 60,
  `0` off). The hourly cron fan-out always runs; the Workers runtime uses
  Durable Object alarms. See `docs/inventory.md`.
- `PRINT_BROWSER_ACCOUNT_ID` / `PRINT_BROWSER_API_TOKEN` - App only. Cloudflare
  Browser Rendering (REST `/pdf`) for Print shop PDFs. Empty in dev: downloads
  open a print-ready page instead. `PRINT_RENDER_LIMIT_PER_HOUR` caps new
  renders per organization (default 30).
- `PRINT_SHIPPING_ENABLED` / `PRINT_MOCK` / `GELATO_API_KEY` / `PRODIGI_API_KEY`
  / `PRODIGI_SANDBOX` / `PRINT_WEBHOOK_TOKEN` - App only. Shipped prints: kill
  switch for new paid orders, the local vendor emulator (ignored unless
  `BASE_URL` is local), vendor keys, and the secret in vendor webhook URLs (32+
  characters). Admin needs `APP_URL` for refunds and retries. See
  `docs/print-shop.md`.
- `MEDIA_RESTYLE_ENABLED` - App only, optional (unset or `true` is on). Kill
  switch for the menu photo restyle (#146): `false` (also `0`, `off`, `no`,
  `disabled`) stops new runs and draft generation; drafts already made stay
  reviewable. `PHOTO_QUALITY_MOCK`, `MEDIA_RESTYLE_MOCK` and
  `DISH_PHOTO_MATCH_MOCK` are local emulators for the photo adapters (also
  `MOCKS=true`), ignored unless `BASE_URL` is local. See `docs/dish-photos.md`.
- `DISH_PHOTO_TESTS_ENABLED` - Tenant-api only, optional (unset or `true` is
  on). Kill switch for the dish photo A/B counter beacon (#192): `false` (also
  `0`, `off`, `no`, `disabled`) answers 204 on `POST /forms/dish-photo-events`
  and writes nothing. Orders still record which photo a guest saw and results
  still read. See `docs/dish-photos.md`.
- `RESERVATIONS_TICK_INTERVAL_SECONDS` - Tenant-api Node (OCI) runtime only,
  optional. Seconds between in-process reservation ticks (default 120, minimum
  60, `0` off). The hourly cron fan-out always runs; the Workers runtime uses
  Durable Object alarms. See `docs/scheduled-jobs.md#reservations-tick`.
- `LOYALTY_TICK_INTERVAL_SECONDS` - Tenant-api Node (OCI) runtime only,
  optional. Seconds between in-process loyalty ticks (default 120, minimum 60,
  `0` off). The hourly cron fan-out always runs; the Workers runtime uses
  Durable Object alarms. See `docs/scheduled-jobs.md#loyalty-tick`.
- `SEO_RANK_API_LOGIN` / `SEO_RANK_API_PASSWORD` - App only, optional.
  DataForSEO Google Maps SERP credentials for the weekly local rank checks
  (`seo.rank_tracking`). Empty: checks are skipped as not set up (a local
  `BASE_URL` uses a mock). Search Console reuses `GBP_CLIENT_ID` /
  `GBP_CLIENT_SECRET`. See `docs/website-seo.md`.
- `CANVA_CLIENT_ID` / `CANVA_CLIENT_SECRET` / `CANVA_MOCK` - App only. Canva
  Connect integration for Print shop Import from Canva and Send to Canva
  (redirect URL `<BASE_URL>/resources/print/canva/callback`); empty hides the
  buttons. `CANVA_MOCK` is a local emulator, ignored unless `BASE_URL` is local.
  Tokens are encrypted with `INTEGRATION_ENCRYPTION_KEY`. See
  `docs/print-shop-canva.md`.
- `META_APP_ID` / `META_APP_SECRET` / `SOCIAL_MOCK` - App only. Meta app for
  Marketing, Social media (Facebook Pages and Instagram professional accounts;
  redirect URL `<BASE_URL>/resources/social/meta/callback`); empty means
  accounts cannot be connected. `SOCIAL_MOCK` is a local emulator, ignored
  unless `BASE_URL` is local. Page tokens are encrypted with
  `INTEGRATION_ENCRYPTION_KEY`. Scheduled posts are woken by jobs-cron's
  `SocialPostWorkflow`. See `docs/social-media.md`.
- `HERO_VIDEO_RENDERER_URL` / `HERO_VIDEO_RENDERER_TOKEN` / `HERO_VIDEO_MOCK` -
  App only, optional. The renderer behind hero "Make a video from my photos"
  (#301; JSON over HTTP, bearer token, only the plan and short-lived read links
  to the restaurant's own photos). Empty: the feature reports it is not
  available. `HERO_VIDEO_MOCK` is a local emulator, ignored unless `BASE_URL` is
  local. See `docs/hero-video.md`.
- `STAFFING_TICK_INTERVAL_SECONDS` - Tenant-api Node (OCI) runtime only,
  optional. Seconds between in-process staff ticks (default 300, minimum 60, `0`
  off). The hourly cron fan-out always runs; the Workers runtime uses Durable
  Object alarms instead. See `docs/scheduled-jobs.md#staff-tick`.
- `DEV_EMAIL_CAPTURE_DIR` - Tenant-api, development only: folder (relative to
  `apps/tenant-api`) that receives one JSON file per email the node would only
  log. Ignored in production or when OCI email is configured.
- `STRIPE_CONNECT_WEBHOOK_SECRET` - App only, optional: second Stripe webhook
  secret for Connect events (the Stripe webhook route accepts either secret).
- `PAYMENTS_MOCK` / `PAYMENTS_MOCK_ORIGIN` / `PAYMENTS_MOCK_WEBHOOKS` /
  `PAYMENTS_MOCK_WEBHOOKS_HTTP` / `PAYMENTS_MOCK_CKO_SESSION_ID` - App only:
  local Stripe and Checkout.com emulators (`MOCKS=true` also turns them on).
  Startup refuses live keys; mock routes are stripped from Worker builds. See
  `docs/payments-mock.md`.

**Private client code (App)**: logged-out visitors can download only public
route code. A route a logged-out visitor opens, or that a public page sends a
fetcher or form to, must be listed in `PUBLIC_ROUTE_PATTERNS`
(`apps/app/app/utils/route-visibility.ts`); everything else is built into
`/assets/app/`, which the Worker serves only with a valid session. Public code
must not import from private route files (move shared constants into
`app/utils/`); the client build fails with the import chain if it does. See
`docs/security.md#private-client-code`.

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

**Broadcast designer blocks, templates, actions and checks (#153, #154, #101,
#232, #236):**

- The generic block core (`packages/common/src/email-blocks.ts`) names no menu
  words. The restaurant vertical (`email-blocks-restaurant.ts`, renderer in
  `packages/email/src/marketing/components/restaurant-blocks.tsx`) adds the
  `menu_item` (one to three dishes, one location's price, Order link to
  `/menu?item=<id>`) and `coupon` blocks, registered in one place. Dishes are
  re-read from the live menu **when the email is saved** and frozen into the
  stored HTML (`item_not_available` refuses a dish that left the menu); the
  inspector flags a changed price. The coupon block's words come from the print
  shop's `couponCopy`, its button is `/menu?coupon={{couponCode}}`. A render
  takes a context (`EmailRenderContext`: language, direction, site origin,
  image-transform host, coupon words), never stored in the blocks.
- Saved templates: control-plane `MarketingEmailTemplate` (blocks only, 100 per
  organization, unique names). Starting from one copies it and refreshes dish
  snapshots; deleting a media asset a template uses keeps the stored file.
- Broadcast actions live in tenant-api (`services/campaign-actions.ts`): every
  status change is one compare-and-set UPDATE on the expected status, so it
  cannot race the tick; a `Processing` campaign cannot be edited, cancelled or
  deleted (`campaign_already_sending`), and there is no mid-send stop. Statuses
  add `Cancelled` and `SkippedLate`. Test send: the operator's own address is
  signed into a server-only token (`testEmail` / `testPhone` claims, minted by
  the App from the control-plane user; the request body names no recipient and a
  browser area token carries none, so it cannot test) and never stored in the
  region; 10 per operator and 30 per organization per hour
  (`marketing_test_sends`, ids and times only); email only in the App (the
  control plane keeps no operator phone). Re-send to non-openers: email only,
  once (unique `retarget_of_campaign_id`), 48 hours after finishing; the
  dispatcher picks the audience when it sends. Mutations are audited in the
  control plane with ids only (`utils/marketing/campaign-audit.server.ts`).
- Pre-send checks are one pure function (`@repo/common/broadcast-checks`) run in
  the App on Send or Schedule and again by the dispatcher when the send starts
  (blocking problems fail it; warnings such as starter text are the operator's
  choice). The coupon's paused or ended state is only known to the App. A
  scheduled send that cannot **start** within `late_after_minutes` (default 240)
  becomes `SkippedLate` and the operator is notified through
  `POST /resources/marketing/notify` (ids only, plain-English email); a send
  already in progress is never cut off. The boilerplate phrase check is shared
  with automations (`@repo/common/email-boilerplate`).
- A discount's "Used in" is read from the region by ids and names only
  (`GET /operator/discounts/used-in`, discounts token; the App's server uses the
  same lookup behind the server-side operator token). Pausing, archiving,
  shortening the end date or changing the code or amount shows what would break
  and offers to pause those automations and cancel those scheduled broadcasts in
  the same action; the server asks the region again and checks the member's
  permission per kind. What was paused is recorded in the discount's status
  audit entry (ids only) so a resume can offer it back. Note the audit writer's
  sanitizer stores an array as an index-keyed object: read both shapes.

**Marketing audiences, order triggers and ready-made programs (#98, #99, #100,
#150, #151):**

- Saved audiences (`@repo/common/marketing-audiences`, compiled to SQL in
  tenant-api, `/operator/marketing/audiences`) only ever narrow consent. Order
  triggers, the "stop when the guest orders" goal and the frequency cap live in
  `services/order-journeys.ts`, `journey-guards.ts`; birthdays in
  `birthday-journeys.ts` (`customers.birth_month_day`); cart reminders in
  `cart-reminders.ts` (`customer_carts`, ids and quantities only, the restore
  token rides in the URL fragment). Programs are templates in
  `packages/marketing-workflow/src/programs.ts`; "Turn on" is
  `apps/app/app/utils/marketing/programs.server.ts`. Flags (default off):
  `marketing.audiences`, `.order_automations`, `.birthdays`, `.cart_reminders`,
  `ai.marketing_drafts`. Guest data never reaches the App Worker or a model.
  Details: `docs/marketing-programs.md`.

**Marketing compliance and measurement (#75, #159, #247, #393, #152, #115):**

- One SMS consent writer (`setCustomerSubscription`, sources `sms_reply`), one
  short-link table (`short_links`, own-site paths only, counts per day with no
  IP, user agent or person id), one attribution record on the order
  (`restaurant_orders.attribution` / `attribution_source`, no visitor ids), one
  frequency cap, one marketing calendar (code occasions, flag
  `marketing.calendar`; short links are `marketing.short_links`). Docs:
  `docs/marketing-compliance.md`.
- Inbound texts: `POST /webhooks/sms/:provider` verifies the signature before
  anything else and stores only the matched keyword. Every marketing SMS ends
  with the opt-out phrase and waits for 09:00-20:00 local time.
  `MARKETING_SMS_ENABLED=false` is the node kill switch; #75 has no flag.
- The text allowance lives in the control plane as numbers only
  (`MarketingSmsUsage`, `MarketingSmsSend`); spending is one conditional UPDATE.
- Migrations: tenant-db `0059_marketing_compliance`, control plane
  `0071_marketing_compliance`. Deploy tenant-api, then App, then Sites and the
  customer app, then jobs-cron, then Admin.

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
- `@repo/zatca` - ZATCA (Saudi e-invoicing) Phase 2 for the POS: EGS keys and
  CSR, UBL simplified invoices and notes, XAdES signature, Phase 2 QR, Fatoora
  API client. Pure TypeScript, used by `apps/station` and tenant-api
- `@repo/phone-agent` - AI phone agent core: flow model, vertical contract,
  prompts, and call reports (see `docs/phone-agent-verticals.md`)
- `@repo/reservations` - Reservations domain code shared by App, tenant-api and
  Sites: flags, permissions and role presets, token claims, availability engine,
  table assignment, policy and message math, request and response Zod schemas
  (including `schemas/public-contract.ts`), error codes. No UI strings, no I/O.
  `@repo/zoned-time` holds the DST-safe time math.
- `@repo/loyalty` - Loyalty Rewards domain code shared by App, tenant-api and
  Sites: Zod schemas for every loyalty route, earning and discount math, the
  operator token contract, permissions and `loyalty.*` flag keys, error codes,
  and the frozen acceptance examples. No UI strings, no I/O.
- `@repo/inventory` - Inventory domain code shared by App, tenant-api and
  (later) Station: flags, permissions, the `inv+jwt` token contract, units and
  quantities, cost math, stock vocabulary, error codes and wire schemas. No UI
  strings, no I/O.
- `@repo/discounts` - Discounts and coupons domain code shared by App,
  tenant-api, Sites and Station: the definition schema
  (`discountDefinitionSchema`, `discountRecordSchema`), the pure
  `evaluateDiscounts` engine (rules, deals, ladders, stacking by kind), the wire
  contracts (order context, quote, error codes, `parseOrderContextDiscounts`),
  the `dsc+jwt` operator token contract, and calendar-period keys. Shares
  `money.ts` with loyalty. No UI strings, no I/O.
- `@repo/staffing` - Staff module domain code shared by App and tenant-api: Zod
  schemas, permission and `staffing.*` flag keys, PIN rules, formula-safe CSV
  export, time math (`computeTimecard` / `computeWeek`), clock state machine,
  and rule packs as data. No UI strings, no I/O in the main entry; the
  browser-only subpaths `clock-client`, `clock-queue` and `clock-sync` (fetch
  and IndexedDB for the kiosk and the Station time clock) are the exception.
  Neutral vocabulary: workplaces are opaque **scopes** (`DEFAULT_SCOPE_ID`),
  never "locations" (see `docs/staffing-plan.md`)

**Delivery routing, zone priority, fees and own drivers (#161, #266, #244, #421,
#287, #324):**

- Extends the one quote pipeline (`POST /delivery/quote`, `resolveZoneForPoint`,
  `resolveDeliveryCoverage` in `@repo/geo`) and the one fee function
  (`deliveryFeeCentsFor` in `@repo/common/delivery-fees`); never build a second
  quote, zone model or fee calculation. Zone order is
  `deliveryConfig.zonePriority` (`cheapest` default, or `order`); fee tables
  (`feeSteps`, `distanceFees`) are per zone; the fee base is the items subtotal
  before discounts. Driving distance goes through the Router adapter
  (`@repo/geo` `router.ts`, Google Routes API, dev router in development and
  test); a routing failure falls back to the straight-line distance and nothing
  about an address, coordinate or distance is ever logged.
  `POST /delivery/locations` picks the store for an address;
  `expectedDeliveryFeeMinor` guards the fee (409 `delivery_fee_changed`). Docs:
  `docs/delivery-coverage.md`.
- Own drivers live in the region (tenant-db `0070`; no control-plane migration)
  behind the flag `delivery.in_house` (default off). A driver is a staff member
  whose job position has `delivers_orders`; Station's device secret plus staff
  PIN session authenticate (no second driver login). Runs write
  `out_for_delivery` / `delivered` through `applyOrderStatusPatchInTx`. A run's
  live position and the driver's addresses are removed when the run ends; the
  driver never receives the guest's number (masked call, US only). Reports
  (`deliveries`, `driver_deliveries`) carry zones only; driver names need the
  staff grant. `POS_CONTRACT_VERSION` stays 11. Deploy App, then tenant-api,
  then Station, then Sites. Docs: `docs/delivery-drivers.md`.

**Cloud printers, test print, receipt codes, kitchen highlights and alcohol
rules (#117, #426, #263, #294, #167):**

- One print path: `@repo/common/print-ticket` (ticket document and builders),
  `print-protocols` (Star CloudPRNT and Epson Server Direct Print encoders),
  `print-devices` (setup, routing, status), `receipt-extras` (logo and codes).
  Tenant-api: `services/print-service.ts` (queue, offer, acknowledge),
  `print-hooks.ts` (accepted orders, till sales, scheduled orders),
  `routes/print.ts` (printer-facing, `/print/<orgId>.<printerId>/...`) and
  `routes/operator-print.ts` (`/operator/pos/printers`). Tables `print_devices`
  and `print_jobs` (tenant `0069`). Printers are not terminals: they poll with a
  short password, never a staff session. Never build a second Kitchen feed,
  receipt layout or device table.
- Highlights (#294) already existed (PR #549); only the guest-stated allergy
  header was added. Alcohol (#167) lives in `priceRestaurantOrder`
  (`@repo/common/alcohol-rules`); do not add a second flag.

**Multi-location control (copy settings, bulk pause, Status, tags, compare and
edit, chain defaults and locks):**

- Control-plane only. One registry of location settings
  (`packages/common/src/location-settings-registry.ts`) drives copy, compare and
  edit, chain defaults and locks: add a setting there, nowhere else. Location
  scope for a member is resolved only by `resolveMemberLocationIds` (explicit
  grants plus tags); the module resolvers delegate to it and a guard test keeps
  it that way. Bulk writes are one `db.batch` (D1 `db.transaction` is not
  atomic). Locks are enforced on the server for every write path to a registry
  setting. Docs: `docs/multi-location.md`.

**Location managers and idle sign-out (#126, #364):** team changes go through
`assertCanManageMember`
(`apps/app/app/utils/organization/member-management.server.ts`); an invitation
can carry locations (control-plane `0075_staff_controls`), and the permission
`update:member:own_locations` limits a manager to their own locations. Station
idle sign-out is `idleDecision` in `apps/station/src/lib/activity.ts`, set per
location in `stationSettings.idleSignOutMinutes`; a payment in progress is never
interrupted. See `docs/multi-location.md` and `docs/pos.md`.

**Key Apps:**

- `apps/app` - Operators; publishes sites; routes provision by `dataRegion`;
  hosts `/resources/jobs/*` and `/resources/videos/source`
- `apps/jobs-cron` - Cloudflare Worker cron → authenticated App job routes
- `apps/sites` - Public CMS HTML; injects tenant-api URL; no PII proxy
- `apps/tenant-api` - Regional customer auth + SQLite (local US :3007, KSA
  :3009; production: US Cloudflare Worker + Durable Objects by default, KSA OCI
  Riyadh)
- `apps/station` - Station tablet app, currently an offline-first register (Vite
  PWA, IndexedDB). Uploads each order revision browser-direct to the regional
  tenant-api; money and history tables are append-only, refunds and removed
  items need a reason (and a manager when sign-in is on), and closed sales carry
  a hash-chained fiscal document. A terminal can also be the time clock
  (`/pos/timeclock/*`, PIN every punch) and the host stand for its location (a
  `book`-scope reservations token minted at `/pos/reservations/token` from the
  terminal and the signed-in staff session); both are per-terminal settings plus
  the organization's flag. It can also run the location's online orders
  (`/pos/online-orders`, not `/pos/orders`, which is the till's upload; a
  per-terminal switch, sign-in and a location, no organization flag; see
  "Station apps: Online orders" in `docs/pos.md`). A terminal bound to a
  location uses that location's staffing scope (an organization with locations
  has no `main`). Deploy App before tenant-api when the `stationApps` claim
  gains a field: a missing one fails closed and refuses switching an app on.
  Read `docs/pos.md` before changing the order contract
  (`@repo/common/pos-orders`, `POS_CONTRACT_VERSION`)
- `apps/voice-agent` - LiveKit worker that answers phone-agent calls (US only);
  loads config from App and logs calls through tenant-api
- `apps/customer` - Tenant customer app (Expo, iOS and Android): branded shell
  from the published org theme, connect-to-site or white-label binding, phone
  OTP sign-in, profile and language, table booking, the Loyalty Rewards wallet
  and the Gift cards wallet (saved cards, add by code, a one-use till QR), all
  browser-direct to the regional tenant-api (no PII proxy). Session in
  `expo-secure-store`, excluded from backups. Jest tests run in normal CI;
  white-label builds come from `tenants/<slug>.json`
  (`npm run tenant -w customer -- --tenant <slug>`). `apps/mobile` is the
  separate operator app

**Branded customer app (management, links, orders, invites, push):**

- One app registry (`CustomerApp*`, control plane `0068`), managed in Admin
  (`update:customer_app:any`); credentials are write-only and encrypted with
  `INTEGRATION_ENCRYPTION_KEY`. Builds, store health, accounts and push go
  through mockable adapters. One link registry, `@repo/common/links`: no sender
  builds a guest URL by hand, capability tokens live in the URL fragment only.
  Guests' restaurant orders are `/customer/orders*` (own orders only, reorder
  returns ids). Push (tenant-db `0057`): regional devices and send log, strict
  PII-free payloads, `PUSH_ENABLED` kill switch, KSA off until
  `PUSH_KSA_APPROVED`. Flags `customer_app.enabled` / `.push`, `marketing.push`
  (default off). Docs: `docs/customer-app.md`.

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
- Hour caps, apply-on-approval swaps, My week and pay, correction requests and
  announcements (#527, #528, #514, #486; tenant `0066_staff_controls`, no new
  flag): hour caps are data on the labor policy and the KSA pack
  (`@repo/staffing` `hour-caps.ts`), warnings only, with a `capReason` to
  publish or approve over a cap; a person's Ramadan flag is private to the
  private-details grants; approving a swap publishes just that change and emails
  both people; staff pay estimates are off until `show_staff_pay_estimate` is on
  and never appear on a lock screen; announcements are regional and plain-text.
  See `docs/staffing.md` ("Staff controls").
- Security gates in CI: `apps/tenant-api/src/routes/staffing-security.test.ts`
  (every staffing route refuses a missing, forged or grantless token and has
  cross-organization and cross-scope tests) and
  `apps/app/app/utils/staffing/staffing-guards.test.ts` (every staff loader and
  action awaits `requireStaffingAccess` first). A new staffing route must pass
  both.
- Canonical docs: `docs/staffing.md` (operator guide and runbook),
  `docs/decisions/047-staffing-data-residency.md` and `docs/staffing-plan.md`.

**Reservations module (tables, bookings, waitlist, guestbook, experiences):**

- Regional data in `packages/tenant-db` (41 `rsv_*` tables, one migration,
  `0019_reservations`); control plane keeps flags, permissions, locations and
  payment connection state (one migration, `0025_reservations`). Pure domain
  code in `@repo/reservations` and `@repo/zoned-time` (never hand-roll time-zone
  math). Guest PII (names, phones, emails, notes, allergies, tags) lives only in
  the regional DB: never in the control plane, logs, cross-plane payloads, Sites
  SSR or App loaders. Validation errors never echo rejected values.
- Everything user-visible is behind org flags read with `getFeatureFlag`
  (`reservations.enabled` master, plus `.online`, `.waitlist`, `.payments`,
  `.experiences`, `.voice`; `reservations.platform_fee_bp` is a number, default
  250 from migration `0025`). Only a literal `true` counts and child flags need
  the master. Enforce at token mint and in every loader and action.
- Operators: App mints a short-lived `rsv+jwt`
  (`GET /<orgSlug>/reservations/token?scope=`; 15 minutes, 5 for guest or
  payment grants and impersonation); the browser calls tenant-api
  `/operator/reservations/*` directly. Eight permissions
  (`read|update:reservation[_guest|_settings|_payment]:any`,
  `read:reservation_report:any`); `UserOrganization.locationScope` becomes the
  `locationIds` claim.
- Guests: tenant-api `/reservations/*` resolves the organization from the
  browser `Origin` only (never a client `orgId`, never a customer token) and
  answers a uniform 404 otherwise. Capability tokens (`X-Reservation-Token`) are
  derived by HMAC from `AUTH_HMAC_SECRET`, not stored. Mutations are POST with
  an `Idempotency-Key`. A verified customer token replaces Turnstile; the
  customer app sends `X-Client: ios | android` (channel `native`). Sites never
  proxies guest data; the only Sites-to-App call is the payment hand-off,
  authenticated with `SITES_RESERVATION_PAYMENT_TOKEN`.
- Writes: every reservation write and setup mutation goes through
  `withReservationWrite` (`apps/tenant-api/src/lib/reservations-write.ts`),
  which runs a real transaction through `runTenantTransaction` (the Durable
  Object runtime needs the async storage transaction). Data-sized `IN (...)`
  lists must use `queryInChunks` / `forEachInChunks`
  (`apps/tenant-api/src/lib/chunked-in.ts`): Durable Object SQLite allows 100
  bound parameters per statement. Versioned operator mutations send and check
  `expectedVersion` (409 `stale_version`).
- Payments: the region decides amounts and state; the App is the only caller of
  Stripe and Checkout.com and forwards only ids and amounts back. Provider
  webhooks terminate at the US App, not at the region (ADR 048 section 8).
- Security gates in CI:
  `apps/tenant-api/src/routes/reservations-security.test.ts` (every operator and
  public route: forged, wrong-audience, over-long, grantless, wrong-scope,
  impersonated, cross-organization and excluded-location cases) and
  `apps/app/app/utils/reservations/reservations-guards.test.ts` (every App
  loader and action awaits `requireReservationsAccess` first). A new route must
  pass both.
- Public API fixtures: `npm run fixtures:reservations -w tenant-api` re-records
  `packages/reservations/contract-fixtures`, which the customer app's tests read
  in place; `reservations-contract.test.ts` (tenant-api and
  `@repo/reservations`) fails on drift.
- Local dev: App at `https://app.menuza.test:2999` through the root dev proxy
  (this file still mentions the older `epic-startup.test` host in places). Mock
  payments need no keys (`docs/payments-mock.md`). Demo data:
  `npm run seed:reservations -w tenant-api -- acme` (local only, idempotent).
- Canonical docs: `docs/reservations.md` (operator guide, runbook, known
  issues), `docs/reservations-contract.md`, `docs/reservations-plan.md` and
  `docs/decisions/048-reservations-data-residency.md`.

**QR ordering (table tabs and order-ahead posters):**

- A tab's rounds are `restaurant_orders` rows (`fulfillment: 'dine_in'`,
  `paymentMethod: 'handoff'`, `tabId` / `tableId` / `tableLabel` / `source`)
  grouped by the regional `qr_tabs` aggregate; tables are `qr_tables`, the org's
  policy `qr_settings` (tenant-db migration `0023_qr_ordering`); online money
  that did not settle a tab is one append-only `qr_tab_payments` row each
  (`0024_qr_tab_payments`). No control-plane tables.
- Table and tab codes are HMACs of `AUTH_HMAC_SECRET` over the org, the row id
  and its version: never stored, burned by bumping the version. They ride in the
  URL fragment and the `X-Table-Token` / `X-Tab-Token` headers only.
- Flags `qr_ordering.enabled` / `.dine_in` / `.online` (default off) reach the
  region in the order context (`qrOrdering`, fail closed). App gates nav,
  `qr-token` and every `qr+/` loader with `requireQrOrderingAccess`
  (`apps/app/app/utils/qr/qr-guards.test.ts`); menu permissions, no new ones.
- Tab payment reuses the restaurant-order payment bridge under
  `orderId = 'tab:<id>'` (`parseTabOrderRef`). Writes go through `runExclusive`
  - `runTenantTransaction`. Person erasure covers `qr_tabs.guest_name` /
    `guest_phone`.
- Tests: `apps/tenant-api/src/routes/qr-ordering.test.ts` (guest flow, codes,
  flags, kill switch, tabs, payment bridge and the `/operator/qr` sweep). Demo
  data: `npm run seed:qr -w tenant-api -- acme`. Docs: `docs/qr-ordering.md`.

**Guest order messages, order link and promised time:**

- Transactional only, never marketing consent. Flag `ordering.guest_messages`
  (default off) plus three operator switches (receipt, ready, cancelled; one
  `ConfigFlag` row `ordering.guest_messages.settings`, edited at Settings,
  Notifications with `update:settings:any`) reach the region as `guestMessages`
  in the order context. The policy is stored on the order at placement
  (`restaurant_orders.guest_messages`), so a later change affects new orders
  only; the node kill switches stop sends at once.
- Outbox: `order_messages` (tenant-db `0043_order_messages`), unique per
  `(order_id, kind, channel, dedupe_key)` (the key is the promised version for
  `eta_changed` and empty otherwise, so every other kind goes out once and each
  push-back of 10 minutes or more sends its own message; an older one still
  queued is `superseded`), no contact data and no body (contact is read from the
  order at send time; erasure leaves the rows). Rows are queued in the order's
  own transaction (`services/order-messages.ts`) from `placeOrder` (pay at
  handoff), `applyPaymentEvent` (paid), `updateOperatorOrder` and the kitchen
  command, and sent after commit (`services/order-message-send.ts`); the
  order-messages tick retries. Texts: only "ready" and a changed time, only with
  `smsUpdates` on that order, only on the US node, with a cap of 200 per
  organization per rolling day, reserved atomically before the send
  (`lib/order-messages-sms-cap.ts`, `sms_daily_cap`). No messages for table
  rounds or Station sales. Do not use the Station ready-text path for this.
- Order link: `lib/order-link.ts`, an HMAC with the purpose `order-link:v1`,
  valid 90 days from placement, carried in the URL fragment
  (`/menu/success?order=<id>#link=<token>`) and the `X-Order-Link` header of
  `GET /orders/:id`, `POST /orders/:id/resend-link` (3 per order per hour) and
  guest cancel (`GET`/`POST /orders/:id/cancel`). It never signs the guest in
  and never edits the order beyond that cancel. Every refusal is the uniform
  404, and a value that is not 64 hex characters is refused before any database
  work. A read by link returns a reduced body (`linkReceiptOrder`: no `contact`,
  no delivery address, no line notes); only the receipt token of the placing
  browser gets the full receipt. Sites moves the token from the fragment to
  `sessionStorage` and strips the URL before analytics loads.
- Promised time: `promised_at` / `promised_until` / `promised_version` /
  `promised_delay_minutes`, computed at placement by `@repo/common`
  `promised-time.ts` (prep, busy minutes, large-order extra from `largeOrder` in
  the order context). ASAP delivery is prep plus the delivery range
  (`deliveryArrivalWindowMinutes`); checkout uses the same helpers and
  `largeOrderExtraMinutes`, so the shown window equals the stored promise. The
  location's zone is stored on the order (`location_timezone`) and returned to
  operators as `timeZone`. A push-back (5, 10 or 15 minutes, 90 in total,
  `expectedPromisedVersion`, 409 `stale_version`) is
  `PATCH /operator/orders/:id` or the kitchen command `delay`; both use
  `applyPromisedDelay`. 10 minutes or more queues `eta_changed`.
- Provider refunds (#80): an online-paid order is refunded through its payment
  provider. The region books a `pending` `provider` row in
  `restaurant_order_refunds` (`POST /api/orders/refund-intent`,
  `services/order-refund-book.ts`, `order-provider-refund-service.ts`); the App
  calls Stripe or Checkout.com (`utils/restaurant-orders/refunds.server.ts`) and
  reports `refund-status`; webhooks, the region's ids-only kick
  (`/resources/orders/refund-execute`) and the hourly reconcile job finish it.
  `refunded_cents` counts succeeded refunds only and never shrinks; a pending
  row reserves the amount, a failed one releases it; a succeeded refund the
  provider fails later is marked reversed and counted in
  `refund_reversed_cents`, so readers use the net figure (never `refunded_cents`
  alone). One pending refund per order (409 `refund_pending`), none while
  disputed (409 `payment_disputed`); a cancel with a full refund that hits
  either is marked `cancel_refund_due_at` and the rest is booked when the other
  refund settles or the dispute is won (orders tick as backstop). A closed
  dispute never reopens. QR tab payments refund per `qr_tab_refunds` row.
  Handoff orders keep the record-only `recordOrderRefund`. Permission
  `update:order_refund:any` (owner, admin), never while impersonating; an order
  loyalty tracks also needs the loyalty refund grant (403
  `loyalty_refund_forbidden`). The region never calls a provider.
- Guest cancel (#111, flag `ordering.guest_cancel`, per-location window) and
  order acceptance (#107, flag `ordering.manual_acceptance`, per-location Manual
  mode) reach the region as `guestCancel` / `acceptance` in the order context;
  the shared rules are `@repo/common` `order-lifecycle.ts`. A
  `pending_acceptance` order holds capacity, has no kitchen ticket and settles
  inventory, loyalty and discounts only on accept; the orders tick
  (`processOrderAcceptance`, with the order-messages tick) rejects it as
  `not_accepted_in_time` and refunds a paid online order in full. `accepted` is
  queued only on a manual accept. Cancels and rejects share
  `applyOrderStatusPatchInTx` in `order-service.ts`. Docs:
  `docs/restaurant-ordering-contract.md`.

**Checkout tips, service fee and cart upsells (#118, #123, #114):**

- Tip choices: `OrganizationLocation.tipSettings` (control plane, JSON,
  `TipSettingsSchema` in `@repo/common/location-types`, no flag), shown from
  `GET /orders/options` (`tipChoices`) and the table tab view. An order or tab
  payment sends `tip: { percent } | { amountMinor }` (`tipPercent` stays for old
  clients). A percentage is a share of the subtotal before discounts and tax
  (`docs/discounts-plan.md`); an exact amount is capped at the larger of half
  the subtotal or the currency cap (422 `tip_too_large`) and stored with a null
  `tip_percent` (tenant migration `0045` swaps the column instead of rebuilding
  `restaurant_orders`). Station keeps its own tip settings.
- Service fee: flag `ordering.service_fee`, `OrganizationLocation.serviceFee`
  (JSON), priced by `computeServiceFee` (`@repo/common/service-fee`, re-exported
  from `restaurant-orders`) on the subtotal after discounts and rewards, never
  on the tip. The App sends `context.serviceFee = { version, locations }` (only
  locations that have it on); the browser sends `expectedServiceFeeMinor` (409
  `service_fee_changed`); a fee on that this node cannot read is 503
  `service_fee_unavailable`, never dropped. The fee's tax is part of
  `tax_cents`. Stored on the order (`service_fee_cents`,
  `service_fee_tax_cents`, `service_fee_label`) and, for a tab paid from the
  phone, on `qr_tabs`. A table round and Station sales carry none. A full refund
  includes it; a partial one only with `includeServiceFee`
  (`restaurant_order_refunds.service_fee_cents`). Contract:
  `docs/restaurant-ordering-contract.md#tips-and-the-service-fee-118-123`.
- Cart upsells: flag `ordering.upsell` reaches Sites in the public menu payload
  (`features.upsell`). One ranking, `pickUpsells` in `@repo/common/upsell`, used
  by Sites (`lib/ordering/upsell.ts`) and the phone agent (`suggestUpsells`):
  upsell categories of what is in the cart, then flagged dishes, in menu order.
  Sites shows "Goes well with" in the cart drawer and at checkout (checkout only
  offers dishes that go straight in). Counts of shown and added dishes (dish id
  only) stay in the browser and fire a `menuza:upsell` event; nothing is sent.

**Checkout rules (pickup instructions, utensils, large orders, size cap,
packaging fee, daily dish limits; #251, #257, #355, #422, #408, #409):**

- Contract:
  `docs/restaurant-ordering-contract.md#checkout-rules-251-257-355-408-409-422`.
  Control-plane columns (`0053` and `0054`):
  `OrganizationLocation.pickupInstructions` / `orderCaps` / `packagingFee`,
  `OrganizationMenuItem` and `OrganizationMenuOption` `.dailySaleLimit`,
  `Discount.waivesPackagingFee`; utensils and the large-order rule live in
  `onlineOrderingSettings` JSON (`utensils`, `largeOrder`). Regional (`0050`):
  order columns (`pickup_instructions`, `utensils_requested`,
  `large_order_extra_minutes`, `packaging_fee_*`), `order_dish_daily_claims` and
  `order_dish_daily_topups`.
- Shared domain code in `@repo/common`: `pickup-instructions`,
  `checkout-utensils`, `order-caps`, `packaging-fee`, `daily-dish-limits` /
  `daily-dish-catalog`, and the large-order rule in `promised-time`
  (`largeOrderRuleFrom`, both thresholds). One dish-count function
  (`buildOrderLimitCatalogFromMenus` + `orderDishUnits`) is the count for the
  large-order rule, per-item packaging and slot limits on every channel.
- Flags (default off): `ordering.packaging_fee`, `ordering.daily_dish_limits`.
  The rest have no flag (a location setting that is empty does nothing).
- Everything is checked again at placement. The order body is strict, so deploy
  App, then tenant-api, then Sites (Station follows). A new strict-schema key
  must be sent only when set (`waivesPackagingFee`), or an older region drops
  the whole record.
- Daily dish limits: the cap rides in the order context
  (`dailyDishLimits.entries`), never in the public menu. A claim's state (`held`
  / `sold` / `released`) follows its order through the
  `order_dish_daily_claims_sync` trigger (hand-written in `0050`: regenerating
  that migration with drizzle-kit loses it), and `dailyDishClaimState` is the
  same rule in TypeScript (a test keeps them equal). The day is the location's
  business day. Guests learn only sold out, or a low number the operator allowed
  (`dailyAvailability` in `GET /orders/options`). Manager top-up: App Orders
  page and Station Controls; tests in `routes/orders-daily-dish-limits.test.ts`
  and `routes/orders-checkout-rules.test.ts`.
- The packaging fee is a fee line like the service fee: inside `tax_cents` and
  the total, waivable by a discount, and every "prices include tax" test that
  reads the totals must count it (`restaurantOrderNetMinor`,
  `orderTaxInclusive`, `orderServiceFeeChargeCents`).
- Plain text only for pickup instructions: escape them and keep line breaks,
  never `innerHTML`, never links. A drop order shows its own pickup location
  instead.

**Menu prices, dietary tags, translations and spreadsheet (#410, #335, #412,
#388, #411):**

- One price resolver, `resolveMenuItemPrice` / `resolveMenuOptionPrice` in
  `@repo/common/menu-pricing`: a fixed location price wins, else the order-type
  price (`orderTypePrices`, dine-in / pickup / delivery) or the base, then the
  first pricing rule that covers the dish (`OrganizationMenuPricingRule`,
  published as `pricingRules` in the menu payload with menus expanded to
  categories). The region engine, the till review (`priceAs`), Station, Sites
  (`price-book.ts`), the customer app and the phone agent all call it; never
  price a dish another way. POS contract unchanged.
- Dietary tags: `dietaryTags` on dishes and options; `isVegetarian` /
  `isGlutenFree` mirror them on every write (`dietaryColumns`). Read with
  `dietaryTagsOf`.
- Menu > Translations (`@repo/common/translation-status`) and the language guard
  on website settings; Menu > Pricing rules; Menu > Spreadsheet (bulk edit
  flag). Docs: `docs/menu-pricing.md`. One control-plane migration,
  `0059_menu_rules`.

**Loyalty Rewards (points, rewards, member codes):**

- One program and one balance per organization, integer points. A customer is
  the member: one points account per customer (the `loyalty_members` row), no
  member space, list or search. Regional data only: `loyalty_*` tables
  (tenant-db `0025_loyalty`, the one tenant migration) with an append-only
  ledger, purchases, redemptions and refunds; operator-recorded order refunds
  are `restaurant_order_refunds` (same migration). The control plane keeps the
  flags `loyalty.enabled` / `.redemption` (default off) and five permissions
  (`0030_loyalty`), never an account or a balance.
- Operators: the App mints a short-lived `lty+jwt`
  (`GET /<orgSlug>/loyalty/token?scope=`) and the browser calls
  `/operator/loyalty/*` directly. Every App loyalty loader and action awaits
  `requireLoyaltyAccess` first (`apps/app/app/utils/loyalty/access.server.ts`;
  404 while the flag is off).
- Customers call `/loyalty/*` with their regional customer token (organization
  from `Origin`); tills call `/pos/loyalty/*` with the device secret. A member
  code only identifies: spending needs the member's wallet approval or a
  one-time code.
- Enrollment is automatic, with no enroll route and no terms gate: tenant-api
  opens the points account after a phone-OTP verify (fire-and-forget, only while
  the loyalty features are on) and lazily on the first wallet read, quote, claim
  or member code. Only verified-phone customers are linked (never a POS-only
  contact), and a suspended or erased account is never recreated. Terms are
  display text (config `terms`). Operators use the Loyalty panel on the Customer
  profile (`read:loyalty:any`), not a Members page. Opening an account never
  sets marketing consent.
- Writes go through `withLoyaltyWrite`
  (`apps/tenant-api/src/lib/loyalty-write.ts`). Order, QR tab and till changes
  queue the source in their own transaction and settle after commit; a paid sale
  is never refused because loyalty is unresolved, it goes to the review queue.
  Recording a refund is an Orders action (`POST /operator/orders/:id/refunds`,
  `orders:write`) and takes points back whatever the flags say; on an order
  loyalty tracks it also needs the token's `refundLoyalty` claim (minted only
  for `update:loyalty_redemption:any`, never when impersonating). The orders
  token carries `locationIds` and the region enforces them.
- Tests: `apps/tenant-api/src/routes/loyalty-security.test.ts` (every operator,
  customer and till route), the `loyalty-*.test.ts` service suites, and
  `apps/app/app/utils/loyalty/loyalty-guards.test.ts`. Docs: `docs/loyalty.md`.
- Customer API fixtures: `npm run fixtures:loyalty -w tenant-api` re-records
  `packages/loyalty/contract-fixtures`; `loyalty-contract.test.ts` (tenant-api
  and `@repo/loyalty`) fails on drift.

**Discounts and coupons (automatic, code and manual till discounts):**

- Definitions live in the control plane (`Discount`, `DiscountCode`,
  `OrganizationMenuItem.excludeFromDiscounts`; migration `0031_discounts`) and
  hold no PII. Redemptions live in the regional tenant DB
  (`discount_redemptions` and `discount_code_attempts`, tenant-db
  `0026_discounts`) with append-only triggers; erasing a person clears
  `customer_id` and keeps the amounts. Two permissions, `read:discount:any` and
  `update:discount:any`.
- Flags `discounts.enabled` (master) / `.automatic` / `.coupons` (default off,
  only a literal `true`; sub-flags need the master). There is no `discounts.pos`
  flag. App folds them into `discounts.features: {automatic, coupons}` of the
  order context. Every App discounts loader and action awaits
  `requireDiscountsAccess` first (404 while the flag is off).
- How rules reach each channel: web and QR orders get `discounts` (definitions
  plus codes) in `GET /resources/order-context`, and tenant-api evaluates in
  `POST /orders/quote` and again in `placeOrder` (`expectedDiscountMinor` is
  compared, never trusted; a difference is 409 `discount_changed`). A QR tab
  never carries a discount on its rounds: the tab view, counter close and phone
  payment (`POST /orders/tab/pay`) price it (`discount-tab.ts`). The till loads
  automatic and manual rules from `GET /pos/discount-rules` (App
  `/resources/discount-rules`, internal token) into its catalog and applies them
  offline; it ignores rules older than 24 hours and never applies a use-limited
  one by itself. The upload (contract 6, `discountApplications`) is checked
  against the rules as they are now, and a mismatch only flags the sale. Loyalty
  applies after discounts, on what is left. A total of 0 skips payment on orders
  (`not_required`); a tab refuses it (`reward_covers_total`). The public menu
  carries promotions from `buildPublicMenuDiscounts`.
- Operators: the App mints a short-lived `dsc+jwt`
  (`GET /<orgSlug>/discounts-token`, `discounts-token.ts`) and the browser reads
  counts from `/operator/discounts/usage`. The editor is `discounts+/`.
- Codes: `quoteIp` 60/min, `codeIp` 20 and `codeOrg` 10,000 wrong guesses per 10
  minutes, counted before the check and given back when the code applies. Caps:
  500 discounts and 2000 codes per organization, 90 codes per discount, 12
  automatic discounts compete per cart. The region reads the context per record
  (a bad row is dropped and logged by id). `DISCOUNTS_ENABLED` is the node kill
  switch.
- Tests and gates: `apps/tenant-api/src/routes/discounts-security.test.ts`
  (forged tokens, cross-organization codes, limit races, replayed keys), the
  `discounts-lifecycle`, `-free-order` and `-modifiers` suites,
  `packages/discounts` engine and property tests, and
  `apps/app/app/utils/discounts/discounts-guards.test.ts` (every App loader and
  action awaits `requireDiscountsAccess` first). A new discounts route must pass
  both. Deploy App, then tenant-api, then Station and Sites. Docs:
  `docs/discounts-plan.md` (spec, limits, version skew).
- Rules added later (#273, #395, #392, #415, #390; all optional on the
  definition, control-plane migration `0057`): `itemChoice` (`cheapest`; missing
  is the dearest item first, as always), `weeklyBudgetMinor` (a weekly spend
  limit counted from `discount_redemptions.local_week`, refused as
  `limit_reached`, the crossing order keeps its discount, the owner is told
  through `POST /resources/discounts/notify`, the till never applies it) and
  `audienceId` (a saved audience, needs a signed-in eligibility, membership read
  in the region with `customerInAudience`, a discount in use blocks deleting the
  audience). A cap and an item limit reach the guest through the menu promotion
  and the quote (`maxDiscountMinor`, `maxUnits`). Performance per discount is
  `GET /operator/discounts/performance` (consumed uses, the reports' gross or
  net rule, "not enough data" under 10 orders). Docs: `docs/discounts-plan.md`
  ("Caps, budgets, audiences and performance").
- Cash-payment discount (#375, POS contract 11): a per-location rate in
  `stationSettings.cashDiscountBp`, US only (`PAYMENT_PRICING_RULES` in
  `@repo/common/cash-discount`, shared with a later card surcharge), taken at
  the till for a bill paid entirely in cash as its own `cash_discount`
  adjustment and reported as its own figure (`cashDiscounts`,
  `cashDiscountCents`). See `docs/pos.md`.
- Marketing coupons: broadcasts and automation email or text steps can carry a
  coupon (`discountOffer`, `marketingOfferSchema` in `@repo/discounts`) that
  fills `{{couponCode}}`: one shared code, or a single-use code the region mints
  per recipient at send time (`discount_issued_codes`, tenant-db `0027`) and
  resolves at checkout (`codesWithIssuedCode`). Attaching one needs the coupon
  flags and `read:discount:any`; the App checks it in
  `utils/discounts/marketing-offers.server.ts`.

**Inventory setup tools (used in, unit change, groups, merge, setup checks, days
left, sold-out alerts; tenant `0062_inventory_setup`):**

- Details: `docs/inventory.md` ("Setup tools"). Rules that bite: the stock
  ledger and the other history stay append-only, so a unit change records a
  conversion (`inv_unit_changes`) and every reader that shows or sums old
  quantities calls `quantityInCurrentUnit`; a merge does not move history, it
  links the archived duplicate (`merged_into_id`) and readers follow the link.
- An ingredient group is an item (`inv_item_groups`); it has no stock or cost of
  its own, is left out of counts, orders, prep and levels (`loadLocationStock`
  hides it unless asked) and a sale takes stock from its first member
  (`allocateToMembers`). Never mix groups with merges.
- "Check your setup" findings are rules (no model); a dismissal keeps the
  evidence `fingerprint` and the finding returns when it changes. Fixes call the
  write function of the screen they mirror.
- Days left reuses prep's `weekdayDemand`; do not add a second usage series.
- Sold-out alerts reuse `/resources/inventory/notify` and the alert policy
  (`applyAlertPolicy`); the payload is dish ids and the ingredient name only.

**Inventory (stock, counts, waste, deliveries; phase 0 built):**

- Plan and status: `docs/inventory-plan.md`; placement: ADR 049. All inventory
  data is regional (`inv_*` tables, tenant-db `0033_inventory`); the control
  plane keeps only the `inventory.*` flags (`enabled` master, `purchasing`,
  `recipes`, `prep`, `transfers`; default off, only a literal `true`) and five
  permissions (`read|update:inventory:any`, `read:inventory_cost:any`,
  `update:inventory_purchasing:any`, `update:inventory_recipe:any`; migration
  `0040_inventory`). Money is left out of responses without the cost grant.
- Domain code in `@repo/inventory` (no I/O): flags, permissions, the `inv+jwt`
  token contract, units (quantities are integer thousandths of the item's base
  unit g / ml / piece), cost math (micro-minor units per base unit), vocabulary
  and wire schemas.
- App mints the token at `GET /<orgSlug>/inventory-token?scope=read|write`; the
  browser calls tenant-api `/operator/inventory/*` directly
  (`hooks/use-inventory-client.ts`). Every App inventory loader and action
  awaits `requireInventoryAccess` first (`utils/inventory/access.server.ts`; 404
  while the flag is off), checked by `utils/inventory/inventory-guards.test.ts`.
  The region reads flags from `/resources/inventory/context`.
- tenant-api: `lib/inventory-{auth,guard,write,context,switches,http}.ts`,
  `routes/operator-inventory.ts`; writes go through `withInventoryWrite`. The
  Workers org router must list `INVENTORY_TOKEN_AUDIENCE` (it routes
  `/operator/*` by audience). `services/item-sales.ts` is the one items-sold
  reader across web/QR orders and Station sales (QR rounds rung up on Station
  are not counted twice).
- Recipes API (phase 3b-1, behind `inventory.recipes`, tenant-db `0035`):
  `GET /recipes?ownerKind=&ownerId=`, `PUT /recipes`, `POST /recipes/clear`,
  `POST /recipes/costs` (a read: up to 200 dishes by `key`),
  `GET /recipes/missing?locationId=&days=&limit=` and `POST /items/:id/batch`
  (`routes/operator-inventory-recipes.ts`,
  `services/inventory-recipes-service.ts`, `-batch-service.ts`,
  `-recipe-store.ts`). Reads need `read:inventory:any`; writing a recipe needs
  `update:inventory_recipe:any` (`update:inventory:any` alone cannot), recording
  a batch only `update:inventory:any`; plate cost, typed cost, food cost and
  dish sales need `read:inventory_cost:any` and are omitted without it. A recipe
  is never edited: each `PUT` writes the next version (`expectedVersion` 0 for
  the first, 409 `stale_version` otherwise; the old row is stamped
  `superseded_at` first, then the successor and its lines, in one transaction;
  `effective_from` is now and never earlier than the version before it), a clear
  writes an empty version, and history is kept. Made-item recipes are checked
  with `checkMadeRecipeGraph` (409 `recipe_cycle` / `recipe_too_deep`, nothing
  written). `PATCH /items/:id` also sets `batchCounted` (made items only) and
  `autoSoldOut` (needs the recipe grant).
- Used by sales (phase 3b-2, behind `inventory.recipes`; no new migration, the
  `inv_outbox` and `inv_sale_usage` tables are in `0035`):
  `services/inventory-sales-service.ts`. The sale's own transaction queues
  `(restaurant_order | pos_order, id)` with `inventorySaleQueue().queue` (only
  while some recipe exists or the source already used stock; it never throws)
  and `settle` runs after commit at the same call sites loyalty uses
  (`placeOrder` when the order counts at once, `applyPaymentEvent` on paid,
  `updateOperatorOrder`, the QR tab void, counter close rung up on Station and
  clearing that mark, and `upsertPosOrder`'s `onStored` in `routes/pos.ts`).
  Settling takes `withInventoryWrite`, re-reads the source, works out
  `desiredUsage` from its current lines and the recipe versions in force at the
  sale's time, diffs it against `inv_sale_usage` and posts only the difference
  as `sale` movements valued at the average cost (event key
  `sale:<outbox id>:<location>:<item>`). Rules: counted web/QR orders use stock
  (rounds of a tab rung up on Station are left to that till sale); cancelled and
  unpaid ones none; Station sales use stock when paid or refunded (a refund
  never returns it); a `quality` void is the dish wasted once (`pos_void`
  source, an `inv_waste` row `cancelled_after_cooking` against the sale's
  terminal and a `waste` movement); `out_of_stock` voids are signals only (later
  slice). Flags off: the row is closed without effect unless the source already
  used stock; flags unreadable or the node kill switch on: left queued. A
  failure backs off from 30 s to an hour with a short machine reason in
  `last_error`; the inventory tick (`processInventoryOutbox`, hourly cron, the
  Node interval, the DO alarm when it asks for a follow-up) retries and counts
  `salesSettled`, and prunes settled rows after 14 days. Never call
  `withInventoryWrite` from inside a sale transaction. Tests:
  `services/inventory-sales-service.test.ts` and "inventory on an upload" in
  `routes/pos.test.ts`.
- Auto sold out (phase 3, tenant `0036_inventory_sold_out`, `inv_sold_out`): an
  item with `autoSoldOut` that is at zero **and** was in an approved count in
  the last 7 days takes every dish (menu item) and option whose current recipe
  uses it, directly or through a made item not counted in batches, off the menu
  at that location. `services/inventory-auto-sold-out.ts` (`syncAutoSoldOut`)
  decides; it runs after every inventory write that commits
  (`withInventoryWrite`, outside the lock, never throws; items without
  `autoSoldOut` cost two reads) and in the tick. It posts ids only to the App
  (`lib/inventory-availability.ts` to `POST /resources/inventory/availability`,
  `routes/resources+/inventory.availability.ts`, internal token). The App only
  turns an available dish unavailable and only gives back one that is
  unavailable and not changed by hand since (60 s grace); with locations it
  writes the location override, without locations the dish itself; giving back
  works even when the flags are off. Only what the App confirms is recorded
  (`out`); a dish the App did not change is recorded `undone` (not ours) until
  stock is back. A manager's undo (`POST /sold-out/:id/undo`, list
  `GET /sold-out`, both behind `inventory.recipes`) leaves an `undone` row so
  the dish is not taken off again until the ingredient was in stock. Today shows
  `sold_out_by_stock` and `ran_out_at_till` (Station `out_of_stock` voids this
  week) and the App panel `SoldOutPanel` lists what is off with the undo. No
  `inventory_sold_out` notification kind yet (`inv_alert_log` has a kind check).
- Count review lines carry `movements` (delivered, used by sales, wasted,
  adjusted since the last approved count) so "expected" explains itself.
- Kitchen "Log it as waste?" (Station): a cancelled ticket with dishes already
  started (anything past New) offers one tap that posts
  `POST /pos/inventory/waste/dishes` (`stationDishWasteSchema`, online only, the
  same `clientId` per ticket so a second tap is a duplicate, needs
  `inventory.recipes` and a signed-in person).
  `services/inventory-dish-waste-service.ts` expands each dish with the recipe
  in force now and writes an `inv_waste` row per ingredient ("Cancelled after
  cooking", this terminal) plus the `waste` movement; a dish with no recipe adds
  nothing. Phase 3 is complete.
- Prep (phase 4, behind `inventory.prep`, tenant `0037_inventory_prep`):
  `inv_prep_levels` (fill up to per weekday, base thousandths), `inv_prep_items`
  (the kitchen station that makes a made item, an opaque id from Kitchen setup)
  and `inv_prep_tasks` (one per made item and business day, with the numbers the
  plan came from). `@repo/inventory` `prep.ts` is the pure math:
  `suggestPrepAmount` = fill up to x weekday factor - on hand, rounded UP to
  whole batches of the recipe; `weekdayDemand` = same weekday of the last 4
  weeks over the mean of the 28 days (clamped 0.5x to 2x, neutral with under 7
  days or 2 same weekdays of history, days with no sales ignored); in Ramadan
  (`isRamadan`, Hijri month 9 through Intl) only Ramadan days are compared,
  otherwise Ramadan days are left out. `services/inventory-prep-service.ts`:
  `generatePrep` refreshes tasks not yet started (started, done and skipped are
  never touched; a level taken away or enough on hand removes an untouched task;
  the day is "planned" once `prep.generate` is audited, so an empty plan is a
  plan), `donePrepTask` records the batch (`recordBatch` joined into the same
  transaction, idempotent by `clientId`) and closes the task, start and skip
  answer a repeat. Dates are limited to yesterday, today and tomorrow. Operator
  routes `/prep`, `/prep/generate`, `/prep/levels` (GET, PUT) and
  `/prep/tasks/:id/start|done|skip` (`routes/operator-inventory-prep.ts`); the
  same plan and task actions under `/pos/inventory/prep` for Station (device
  plus staff session, online only). The hourly tick plans each location once
  from 07:00 local. No money anywhere in prep. App: the Prep tab (list and
  board, `components/inventory/prep-screen.tsx`, levels in
  `prep-levels-panel.tsx`, done reuses `RecordBatchDialog` with a `target`);
  with prep on, Waste leaves the tab bar and sidebar (`visibleInventoryTabs`)
  and Today links "See all". Station: Kitchen gets a Tickets | Prep switch when
  the region answers (`kitchen/usePrep.ts`, `PrepView.tsx`), filtered by the
  screen's station, Start, Done ("How much did you make?" pre-filled) and Skip;
  a write is never queued and the plan is read again after every answer. Not
  built: booked covers from reservations in the demand nudge, the tick's `prep`
  alerts.
- Transfers and branch requests (phase 5, behind `inventory.transfers`, tenant
  `0038_inventory_transfers`): `inv_transfers` / `inv_transfer_lines`, a request
  is made by the place that needs stock and a transfer by the place that has it;
  send confirms what left (`transfer_out`), receive what arrived
  (`transfer_in`), the difference is missing in transit. Triggers keep closed
  records final and sent lines frozen; only the creating place cancels, before
  sending. Routes `/transfers*` and `GET /compare?locationIds=` in
  `routes/operator-inventory-transfers.ts` (service
  `inventory-transfers-service.ts`, `inventory-compare-service.ts`); open
  requests to a central kitchen feed `prep.ts` (`committed`). App: "Moving
  stock" on Purchasing and "All your places" on Today (`transfers-panel.tsx`,
  `transfer-dialogs.tsx`, `compare-panel.tsx`); the layout exposes
  `transfersEnabled` and `transferPlaces` (every place, names only). Not built:
  a Station transfers screen, editing a planned transfer.
- Reading an invoice photo (phase 5): `POST /deliveries/:id/invoice-photo/read`
  (`update:inventory_purchasing:any`) asks the node's own OpenAI-compatible
  vision model (`INVOICE_READER_BASE_URL` / `_API_KEY` / `_MODEL` /
  `_DATA_REGION`; works only when the data region equals the node's
  `DATA_REGION`, so KSA needs an in-region model) for suggested lines to check.
  `lib/invoice-reader.ts`, `services/inventory-invoice-read-service.ts`. The
  answer is untrusted: parsed strictly, cleaned, matched to items by name, never
  recorded or priced automatically. 503 `reader_not_configured`, 409 `no_photo`,
  502 `reader_failed`. App: `invoice-read-panel.tsx` on the delivery sheet
  (hidden when the region has no reader).
- Product rules: owner words (no par, AvT, COGS, 86), at most five tabs, one
  plain name per item (inventory inputs are never translated; App strings are
  Lingui). Security gate: `routes/inventory-security.test.ts`.

**Transfers, dish waste, corrections and use against recipes (#477, #515, #526,
#517, #522, #509):**

- Extends the one transfer record, the one waste log (append-only) and the one
  ledger; tenant `0067_waste_transfers`, no control-plane migration. Details:
  `docs/inventory.md` ("Transfers, waste and use against recipes").
- Station Transfers go through the existing Stock outbox (own lane), quantities
  only; the transfer price is fixed on a line when it is sent
  (`inv_transfer_lines.price_micro`) and is what the receiver's `transfer_in`
  movement is valued at. A waste correction never changes stock when an approved
  count after the entry already covers its item
  (`stockEffect: covered_by_count`). The variance report ties out to
  `computeFoodCost` exactly. Station never shows a price or a money gap.

**Count controls (key items, quick counts, schedules, second person, devices,
late entries, bottles, phone; #490, #491, #525, #474, #470, #516):**

- Extends the one count model (`inv_counts`, `inv_count_entries`); there is no
  second count, schedule, queue or alert engine. Details: `docs/inventory.md`
  ("Count controls" and "Multi-Tablet Counting & Approval"). Tenant migration
  `0065_count_controls` (control plane: none).
- A key item is `inv_items.is_key`; a quick count is a count of `kind: 'quick'`
  and never sets a food-cost period (`computeFoodCost` reads full counts only).
  Schedules and their per-day runs live in `inv_count_schedules` and
  `inv_count_schedule_runs` (shared logic in
  `inventory-count-schedules-service.ts`, the count rules in
  `inventory-count-core.ts`); a change applies from tomorrow.
- The overdue alert is the `inventory_count_overdue` kind of the existing notify
  route. The second-person check keeps `second_state` on the count and the
  second figures in `pass = 2` entries that are never summed. An entry after
  approval is a late entry, never refused.
- The phone app reads a token from `GET /api/inventory/token` (bearer login) and
  calls the region directly; its Alerts tab is `GET /api/alerts`. Keep the phone
  thin: no new back-office screens.

**Manager alerts (operator push, quiet hours, stuck orders, Orders chime, chosen
people, large orders, offline tablets; #106, #366, #131, #265, #241, #300,
#190):**

- Extends the `Notification` table and the notify-route pattern; one engine
  (`apps/app/app/utils/alerts/`), one quiet-hours/snooze/threshold/log system
  (`policy.server.ts`, `@repo/common/operator-alerts`), one Needs attention
  feed. Operator devices (`OperatorPushDevice`) are never the guest customer-app
  tokens. Docs: `docs/manager-alerts.md`.
- Flags (default off): `notifications.operator_push`, `orders.manager_alerts`.
  Kill switches drop and never queue a backlog: `OPERATOR_PUSH_ENABLED`,
  `ORDERS_ALERTS_ENABLED` (App and tenant-api), `ORDERS_EMAIL_ENABLED` (App),
  `ORDER_ALERT_SMS_ENABLED` (App and the US tenant-api).
- No alert, push, banner, email or text may carry a guest name, phone, email,
  address, notes or items: events are strict (`ordersNotifyEventSchema`), copy
  is built from a kind, a place, a number, a time and a total.
- Control-plane migration `0073_operator_alerts`, tenant `0061_manager_alerts`.
  Deploy App, then jobs-cron, then tenant-api, then Station, then the phone app.

**Support toolkit (error reference ids, Help, support requests, contacts,
timeline, sign-in help, caller verification; #385, #233, #406, #272, #279, #246,
#291):**

- Control-plane only (`0074_support_toolkit`). One page-load trace id
  (`@repo/common/trace-id`) rides on every same-origin request, the server log
  line and the error page. A support request is a `Feedback` record with a
  `kind`, a status and a `FeedbackMessage` thread; its context is an allowlist
  (`@repo/common/support-requests`). Replies notify through the existing
  `Notification` + email pattern (`resources/support/notify`, ids only).
- `OrganizationAssignment` names Menuza contacts and gives no access.
  `OrganizationEvent` is written only through `recordOrganizationEvent`, whose
  per-kind strict schemas (`@repo/common/organization-events`) refuse any key
  that could carry guest data; audit rows are read into the Timeline, not
  copied.
- `SignInCodeDelivery` logs that a code was sent, never the code (no column for
  it). `SupportVerification` stores only a keyed hash; the code is shown to the
  signed-in operator only, never while an admin impersonates them. Change email,
  reset 2FA and start an ownership transfer in Admin call
  `requireSensitiveSupportAction` first. Docs: `docs/support-toolkit.md`.

**Sales and service insight (category sales and product mix, slow sellers, dish
profitability, order steps, missed sales while paused, online uptime; #227,
#261, #519, #243, #176, #405):**

- Extends what exists: the report engine (`packages/reports`, new `share`
  measure, `ReportSubject.listOrder` and `loaderFilterFields`), the ONE
  items-sold walk (`item-sales.ts`: `readItemSales` and `readSaleLines` are
  visitors of the same walker), plate cost (`recipeCostRows`), the order status
  changes and the ordering pause controls. Never add a second reader, status
  writer, food cost engine or pause store.
- Menu and category are stamped on every sale line at placement (web and QR in
  `restaurant_orders.lines`, Station in `pos_orders.line_catalog`, written by
  the region from the live menu, so `POS_CONTRACT_VERSION` stays 11). A line
  without a stamp is "Earlier sales". Names are copies: renaming a category
  changes no past sale.
- Order steps (`restaurant_order_steps`, tenant `0068`) are append-only and
  written inside the existing status changes; a step undone and done again keeps
  both rows. They hold ids and screens, never a name or guest data.
- The pause history is `LocationOrderingPause` (control plane `0077`), written
  only by `applyOrderingControl` (busy mode never writes). The missed sales
  estimate is always labelled an estimate and never enters a sales total; only
  windows go to the region and only totals come back.
- Cost and margin need the cost grant (`inventory_cost` report permission, the
  `read:inventory_cost:any` grant on the inventory token). Docs:
  `docs/sales-insights.md`.

**Owner reporting and exports (customer list export, export progress, scheduled
report emails, monthly results, accounting journal; #231, #386, #121, #221,
#189):**

- Extends the report engine, `POST /analytics/query` and the existing job,
  email, payout and audit code; never add a second CSV writer, scheduler or
  email sender. One chunked exporter (`runChunkedCsvExport`), one set of summary
  figures (`packages/reports/src/summary-figures.ts`), one journal builder
  (`accounting-journal.ts`). Flags `reports.schedules` and `reports.accounting`
  default off; one control-plane migration (`0084`). Docs:
  `docs/owner-reports.md`.

**Gift cards (sell, redeem, fraud holds, guest wallet):**

- One regional ledger per organization (`gift_cards`, append-only
  `gift_card_ledger`; tenant-db `0047_gift_cards`). The balance is the sum of
  the ledger. Control plane keeps the flags `gift_cards.enabled` / `.online` /
  `.pos` (default off, only a literal `true`), three permissions and the
  settings (`0050_gift_cards`), never a code or a balance. Codes are HMACs; a
  purchased card's code is sealed in the region until its email has gone out.
- Operators: the App mints a short-lived `gft+jwt`
  (`GET /<orgSlug>/gift-cards-token`) and the browser calls
  `/operator/gift-cards/*` directly. Every App gift card loader and action
  awaits `requireGiftCardAccess` first (404 while the flag is off). Guests call
  `/gift-cards/*` (organization from `Origin`), tills call `/pos/gift-cards/*`
  with the device secret, online only.
- Writes go through `withGiftCardWrite`; a ledger trigger refuses a negative
  balance. A card sale gets no discounts, no points and no VAT line; a redeemed
  card is a tender (KSA VAT is on redemption). Refunds reuse the order refund
  path and return the card's part to the card first.
- Tests and gates: `apps/tenant-api/src/routes/gift-cards-security.test.ts`
  (operator routes), `gift-cards-public.test.ts` (body cap, query bounds),
  `lib/gift-card-secret.test.ts`, the `gift-card-*` service suites and
  `apps/app/app/utils/gift-cards/gift-cards-guards.test.ts`. Deploy App, then
  tenant-api, then Sites, then Station, then the customer app. A write that
  returns a card code names it in `sealFields`, so no plaintext code is stored
  (`lib/gift-card-write.ts`). Person erasure: `gift-card-erasure.ts`. Docs:
  `docs/gift-cards.md`.

**Website SEO (cuisine, keywords, generated pages, redirects, events, Search
Console; #182, #137, #88, #184, #138):**

- Extend the existing Sites SEO stack (`seo-files.ts`, `seo-data.ts`,
  `restaurant-jsonld.ts`); never add a second sitemap, robots, `llms.txt` or
  JSON-LD system. Generated pages read `GET /resources/sites/landing`; events
  read `GET /resources/sites/events`.
- Automatic redirects go through `apps/app/app/utils/website/redirect-plan.ts`
  and `redirects.server.ts` (one hop, operator rule wins, no loops).
- Flags (default off unless noted): `seo.rank_tracking`, `seo.rank_budget`
  (number), `seo.search_console`, `website.location_pages` (on),
  `website.dish_pages`, `website.area_pages`, `website.events`. Control-plane
  migration `0062_website_seo`. Docs: `docs/website-seo.md`.

**Website integrations (media library, font licence, embeds, outside-provider
links, calendar import, hero video; #147, #286, #259, #318, #319, #301):**

- One control-plane migration, `0070_website_integrations`. Media: tags, archive
  and versions on `OrganizationMediaAsset`
  (`utils/media/library-organize.server.ts`, rules in
  `@repo/common/media-library`; a dish photo or a photo the website uses cannot
  be archived). Fonts: `FontLicenceAcceptance`, upload refused until the
  agreement is ticked (`@repo/common/font-licence`); Admin lists and removes
  (`/font-licences`), clearing the live and the draft theme. Embeds: one parser
  and frame builder, `@repo/common/site-embeds`; pasted code is never rendered,
  Sites adds only the page's providers to `frame-src` and waits for marketing
  consent in Required mode. Outside providers: one resolver,
  `@repo/common/action-targets`, used by every Sites button, structured data,
  the sitemap and Google links; outbound clicks are funnel counts (`outbound_*`,
  no visitor). Calendar: `SiteEventCalendarSource`, imported events are
  `SiteEvent` rows with a `sourceId` (`utils/events/`); what the operator adds
  survives a sync, a failed read removes nothing, the address is stored
  encrypted. A feed with more upcoming events than the limit, a truncated one or
  one that reads empty once never deletes anything (an emptied calendar needs
  two empty reads in a row); what the occurrence cap cuts is not "removed"; one
  read per source at a time (compare and set on `nextSyncAt`). The address is
  fetched through the menu importer's SSRF guard, whose DNS rebinding window
  cannot be fully closed on Workers. A removed font is dropped where the site is
  served (`findPublishedSiteOrganization`, and `/resources/fonts` answers 410),
  so a restored version or a scheduled publish cannot bring it back. Hero video:
  `HeroVideoGeneration`, a renderer adapter and a draft asset until accepted
  (`docs/hero-video.md`); a passing renderer failure re-queues and answers 503
  so the workflow retries. jobs-cron gained `CalendarSyncWorkflow` and
  `HeroVideoWorkflow` (no new cron slot; hourly sweeps). Flags
  `website.hero_video` (new, default off) and `website.events` (calendar
  import).

**Website publishing (versions, schedules, announcement windows, redirects,
legal pages, Menuza agreements; #85, #180, #238, #248, #89, #194, #260):**

- Every publish goes through `publishWebsitePage` / `publishPageWithSiteDesign`
  (`apps/app/app/utils/website/publish-page.server.ts`): one `db.batch` writes
  the page, an immutable `WebsiteVersion` and the pruning (50 per page, chrome
  and theme). Header, footer and theme edits are **drafts**
  (`Organization.draft*`, null means "same as live"); Sites reads only the live
  columns. Never write the live chrome or theme from an editor action.
- Scheduled publishes freeze the draft in `WebsiteScheduledPublish` and run
  through `/resources/jobs/website-publish` (jobs-cron `WebsitePublishWorkflow`
  plus the hourly sweep); a schedule is claimed by one caller. Announcement
  windows are decided by Sites per request (`@repo/common/announcement-window`).
- One redirect validator (`checkRedirectDestination`), one legal-page generator
  (`@repo/common/legal` and `apps/app/app/utils/legal/pages.server.ts`, also the
  accessibility statement) and one agreement system (`LegalAgreement`,
  append-only `LegalAcceptance`). The consent choice stays in the guest's
  browser (`@repo/common/site-consent`); no vendor script is rendered or loaded
  before consent in Required mode.
- Docs: `docs/website-publishing.md`.

**Website conversion (forms, alerts, popups, funnel, A/B tests; #239, #357,
#142, #132, #179, #338):**

- Form logic is shared in `@repo/common` (`public-form`,
  `public-form-submission`, `form-alerts`, `site-popup`, `site-funnel`; not
  `site-events`, which is the website events feature). Restricted-form access is
  the signed `restrictedForms` operator claim, minted only for
  `read:form_restricted:any`; every tenant-api route that reads or deletes
  responses checks it. Alerts carry ids and counts only. Counts hold no visitor
  id, address or user agent. Flags (default off): `website.popups`,
  `website.funnel`. Migrations `0067` (control plane) and `0056` (regional).
  Docs: `docs/website-conversion.md`.

**Custom domains (apex and www, provider setup, nameservers, buying, email
forwarding, custom sending; #139, #313, #283, #183, #276, #103):**

- ONE host model (`SiteDomain`, `Organization.customDomain` is its denormalized
  primary for one release), ONE zone model (`ManagedDomain` + `DomainRecord`,
  also used by buying and forwarding) and ONE screen (Website, Domain,
  `website+/domain.tsx`). Do not add a second table, screen or lookup. Every
  public site endpoint finds an organization by host with `siteHostCondition`
  (`utils/sites/site-host.server.ts`), never
  `eq(Organization.customDomain, host)`. Sites 301s a secondary host to the
  primary (`apps/sites/src/lib/secondary-host.ts`).
- Code: pure rules in `@repo/common` (`domains`, `domain-dns`, `domain-zone`,
  `domain-providers`, `domain-steps`, `email-sender`); the App in
  `utils/domains/` and `utils/email-sender/`; every action of the screen goes
  through `handleDomainAction` behind `update:settings:any`
  (`website+/domain.test.ts` refuses every intent without it). Partners sit
  behind adapters (`adapters.server.ts`: DNS zones, registrar, email routing,
  Domain Connect); `DOMAINS_MOCK=true` / `MOCKS=true` (local `BASE_URL` only)
  runs emulators, tests inject them. Registrant contact is encrypted with
  `INTEGRATION_ENCRYPTION_KEY`. Forwarded mail is never stored.
- Sweep: `POST /resources/jobs/domain-status` every 15 minutes (jobs-cron's
  fifth and last cron slot). Flags `domains.registrar` and
  `messaging.custom_sender` default off. Migration `0065_custom_domains` copies
  existing domains.
- Guest email identity: tenant-api `sendTenantEmail` reads the organization's
  sender name, verified reply-to and (only while verified) sending address from
  `/resources/tenant-organization` and falls back to the platform sender on any
  failure. Env for the partners is in `apps/app/.env.schema`. Docs:
  `docs/custom-domains.md`.

**Dish photos (focal point, quality, bulk upload, phone capture, A/B tests,
restyle; #394, #145, #316, #222, #192, #146):**

- One media library, one studio pipeline, one `parentAssetId` version link, one
  score and one photo-test type; a dish's main photo changes outside the dish
  form only through `replaceDishMainPhoto` / `replaceDishMainPhotosBatch`
  (`apps/app/app/utils/menu/dish-photo.server.ts`: compare-and-set in one
  `db.batch`, `photo_changed`, old photo kept as the original, cache purge).
- Control plane `0072_dish_photos`: `OrganizationMediaAsset.focalX/focalY` and
  `qualityScore/qualityIssues/qualityAttempts/analyzedAt`, `MediaRestyleRun`,
  `MediaRestyleRunItem`, `MenuItemPhotoTest`. Tenant `0060_dish_photo_tests`:
  `dish_photo_daily` (numbers only) and `dish_photo_order_lines` (ids only).
  Flags (default off): `media.photo_quality`, `media.restyle`,
  `menu.photo_tests`.
- A focal point is no value at the centre, so existing photos keep centre crops;
  every channel reads it from the public menu payload (`imageFocal`). Guest
  photos (`source = 'guest-photo'`) are never scored.
- The public menu carries photo B of a running test only on the `web` and `qr`
  channels (`photoTest`); `imageUrl` is always photo A. The browser picks the
  variant from a hash of a local-only anonymous id. The order body key
  `photoTests` is sent only when set (the body is strict: deploy App, then
  tenant-api, then Sites).
- Jobs (internal token): `POST /resources/jobs/photo-quality`,
  `POST /resources/jobs/media-restyle` (jobs-cron `PhotoQualityWorkflow` and
  `MediaRestyleWorkflow`, hourly sweep, no new cron slot). Mobile routes:
  `GET/POST /api/menu/photos` (bearer token, `update:menu:any`).
- Docs: `docs/dish-photos.md`.

**Print shop (Marketing, Print shop):**

- Operator B2B data in the control plane (`PrintDesign`, `PrintRender`,
  `PrintOrder`, `PrintVendorOrder`, `PrintOrderItem`, `PrintVendorProduct`,
  `PrintSettings`, `PrintVendorEvent`; migration `0027_print_shop`, upstream's
  `0020_print_shop`). Catalog, flags and schemas in `@repo/common/print-shop`;
  templates in `apps/app/app/components/print/`, rendering and orders in
  `apps/app/app/utils/print/`.
- Generic core plus a vertical, like the phone agent: the restaurant vertical
  (table cards and tents, table, order-ahead and booking codes, dishes,
  locations as scopes) lives in `@repo/common/print-shop-restaurant` and the
  `restaurant/` folders, registered in `print-shop-catalog.ts`,
  `utils/print/vertical.server.ts`, `components/print/vertical-ui.tsx` and
  Admin's `components/print/vertical-labels.ts`. Keep restaurant words out of
  the core (`utils/print/vocabulary.test.ts`). Docs:
  `docs/print-shop-verticals.md`, `docs/print-shop-restaurant.md`.
- Flags `print_shop.enabled` (designs, free PDFs), `print_shop.shipping` (paid
  orders) and `print_shop.canva` (import from and send to Canva). Campaign
  permissions design; paying also needs `update:settings:any`. Every print route
  awaits `requirePrintShopAccess` first (`print-guards.test.ts`).
- Table cards fetch table codes server-side with a short-lived `qr:write` token
  that never reaches the browser; the vertical's `canView` (menu edit) guards
  proofs, downloads and orders of prints with table codes.
- Shipped prints: Menuza is the merchant (Stripe Checkout on the platform
  account, metadata `type: 'print_order'`); vendor orders are placed only after
  payment; vendor webhooks only trigger a status fetch. Docs:
  `docs/print-shop.md`.
- Canva: each member connects their own Canva account (`PrintCanvaConnection`,
  migration `0028_print_canva`, upstream's `0021_print_canva`; tokens
  encrypted). An imported design is an artwork print
  (`PrintDesign.source = 'artwork'`): its stored PDF prints as it is, so its
  page 1 must be the product's size (bleed allowed). Prints with a vertical's
  capability codes are never sent to Canva. Code in `utils/print/canva/` and
  `utils/print/artwork.server.ts`. Docs: `docs/print-shop-canva.md`.

## Known issues

- **The pre-commit ESLint step checks nothing.** lint-staged runs from the repo
  root, and the root `eslint.config.js` ignores every file. Run
  `npm run lint -w <workspace>` before committing. Remove when fixed.
- **The lockfile lacks the Linux `unrs` binding.** `package-lock.json` lists
  only `@unrs/resolver-binding-darwin-arm64` (used by ESLint's `import-x`
  plugin). On Linux, install with the `npm_config_*` flags from Agent
  quickstart. Remove when fixed.

## Additional Resources

- **Agent guide for `apps/app`**: `apps/app/AGENTS.md` (code map, local data,
  browser testing, single fetch, UI kit, i18n, tests)
- **Sandbox bootstrap**: `.agents/setup` (headless Linux sandbox only)
- **Dashboards architecture**: `apps/app/README.md`
- **Local databases (D1 versus LibSQL)**: `docs/database.md` and
  `docs/getting-started.md`
- **Design-system lint policy**: the header of
  `packages/config/eslint-preset.js`
- **Project skills**: `docs/skills/` (`project-*` guides by area)
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
