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
R2 via S3). Regional tenant-api deploys on OCI Ampere (Riyadh + Ashburn) with
per-org SQLite on a block volume.

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

## Setup Commands

```bash
# Initial setup (one-time)
git clone <your-fork>
cd epic-startup
PUPPETEER_SKIP_DOWNLOAD=true npm install && npm run setup -s

# Install Playwright browsers for E2E tests
npm run test:e2e:install
```

**Requirements**:

- Node.js 22.18.0, npm 10.9.0 (pinned with Volta)

## Development

```bash
# Start all apps in parallel
npm run dev

# Start specific apps
npm run dev:app             # Main React Router app (port 3001)
npm run dev:web             # Astro marketing site (port 3002)
npm run dev:sites           # Tenant public sites (port 3008)
npm run dev:tenant-api      # US tenant-api (port 3007, DATA_REGION=us)
npm run dev:tenant-api:ksa  # KSA tenant-api (port 3009, DATA_REGION=ksa)
npm run dev:mobile          # Expo mobile app

# `npm run dev` already starts both tenant-api nodes (3007 + 3009).

# Database management
npm run db:studio      # Drizzle Studio UI (port 5555)
npm run db:migrate:deploy # Apply control-plane SQL migrations
npm run db:seed        # Seed database with test data
npm run db:reset       # Reset database (destructive)
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
npm run test           # Watch mode
npm run test -- --coverage

# E2E tests (Playwright)
npm run test:e2e       # UI mode (interactive)
npm run test:e2e:run   # Headless CI mode

# Full validation (run before commits)
npm run validate       # lint + typecheck + test + e2e
```

## Code Style & Conventions

**TypeScript**:

- Strict mode enabled
- Path aliases: `#app/*` (app code), `#tests/*` (tests), `@repo/*` (packages)
- Use Zod for all validation schemas
- React Router v8 conventions (loaders/actions)

**Imports**:

- ESM modules throughout (`"type": "module"`)
- Consistent import ordering (enforced by ESLint)
- Prefer named exports over default exports

**Components**:

- PascalCase for component files and names
- Use Radix UI primitives from `@repo/ui` package
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

**Fixing ESLint Warnings in Bulk**:

When encountering many ESLint warnings, follow this systematic approach:

1. **Run ESLint with auto-fix first**:

   ```bash
   cd apps/<app-name>
   npx eslint . --ext .js,.jsx,.ts,.tsx --fix
   ```

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

The project convention requires unused variables to have an `ignored` prefix:

```typescript
// ✅ Correct - prefix with 'ignored'
const { data, ignoredMetadata } = response
const [ignoredSearchParams] = useSearchParams()
const ignoredActionData = useActionData()

// ❌ Wrong - underscore prefix not allowed
const { data, _metadata } = response
const [_searchParams] = useSearchParams()

// ❌ Wrong - generic underscore not allowed
const { data, _ } = response
```

**ESLint config**: Variables must match `/^ignored/u` pattern to be allowed as
unused.

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

- Pre-commit hooks run Prettier, Oxlint, and ESLint via Husky + lint-staged on
  staged files
- Typecheck and tests are not part of pre-commit; run `npm run validate` before
  pushing
- Large changesets may timeout during pre-commit checks
- If pre-commit fails due to timeout (not errors):
  1. Verify changes pass individually: `npm run lint`, `npm run typecheck`
  2. Use `git commit --no-verify` only if you've verified the changes are
     correct
  3. Note this in commit message for transparency

**Workflow for Clean Commits**:

```bash
# 1. Auto-fix what you can
npx eslint . --ext .js,.jsx,.ts,.tsx --fix

# 2. Run full linting suite
npm run lint:all

# 3. Type check
npm run typecheck

# 4. If all pass, commit
git add -A
git commit -m "fix: resolve ESLint warnings"

# 5. If pre-commit times out but checks passed above
git commit --no-verify -m "fix: resolve ESLint warnings (verified manually)"
```

## Testing Guidelines

**Unit Tests**:

- Place tests alongside source files (`*.test.ts`, `*.test.tsx`)
- Use Vitest + Testing Library
- Mock external services with MSW (Mock Service Worker)
- Fixtures in `/tests/fixtures` with auto-cleanup

**E2E Tests**:

- Located in `/tests/e2e`
- Use authenticated fixtures for logged-in scenarios
- Clean up test data automatically
- 60-second timeout per test
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
  siteverify secret and comma-separated allowed hostnames for form submissions.

**CMS Storage**:

- Local: `apps/cms/public/media/`
- Vercel: R2 via S3 API (`R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`)

## PR & Commit Guidelines

**Pre-commit Checks**:

- Husky runs `lint-staged` on commit (Prettier, Oxlint, and ESLint on staged
  `*.{js,jsx,ts,tsx}` files)
- Typecheck and full test suites are **not** run in pre-commit; use
  `npm run validate` before pushing

**Before Submitting PR**:

```bash
npm run validate  # Must pass: lint + typecheck + test + e2e
```

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
npx tsx src/migrate.ts

# View data
npm run db:studio    # Opens Drizzle Studio on localhost:5555
```

Call sites use `import { db } from '@repo/database'` with Drizzle tables and
queries. Native SQL/query helpers also live on `db` from the same package.

**Database Notes**:

- Control-plane SQLite with D1 on Cloudflare Workers
- Database at `/tmp/sqlite.db` in production (Cloudflare Workers ephemeral
  filesystem)
- Local: `./packages/database/data.db`
- Use "widen then narrow" migration strategy for zero-downtime
- App/Admin D1 is the **US control plane**. Customer PII uses a **separate** OCI
  VM + block volume per `dataRegion` (`us` | `ksa`). Never put KSA SQLite on the
  US App D1 cluster.

**Tenant SQLite (regional customer data plane):**

- Schema: `packages/tenant-db/src/schema.ts`
- Migrations: `packages/tenant-db/drizzle/`
- Production path: `TENANT_DB_DIR` on an OCI block volume (`/data/tenants`)
- Provisioned lazily on site publish; destroyed on region switch
- `Organization.dataRegion` and `hasProvisionedDb` are flags only

## Deployment

**Platform**: Cloudflare Workers (App/Admin) + Vercel (CMS) + Cloudflare Workers
(jobs-cron) + OCI Ampere (tenant-api) + Cloudflare Pages (Sites / marketing web)

**Deployment Trigger**: Push to `main` (production) or `dev` (staging)

**CI/CD Pipeline** (GitHub Actions):

1. Lint with Oxlint
2. Build + TypeCheck
3. Unit tests (Vitest)
4. E2E tests (Playwright, 60min timeout)
5. Deploy App/Admin to Cloudflare Workers; CMS to Vercel; jobs-cron to
   Cloudflare Workers; Sites and marketing web to Cloudflare Pages
6. Tenant-api: build `linux/arm64`, push GHCR, SSH to OCI Ashburn + Riyadh VMs

**Zero-Downtime Deployments**:

- Cloudflare Workers handles deployment with instant routing
- Health checks: `/resources/healthcheck` (App/Admin); tenant-api `/health`

## Internationalization

**LinguiJS** for translations:

```bash
npm run lingui:extract  # Extract translatable strings
```

- RTL support enabled (Arabic, Hebrew, etc.)
- Translation files in locale directories

## Monorepo Navigation

**Package Structure**:

```bash
pnpm dlx turbo run <command> --filter=<package_name>  # Run command in package
npm install --prefix packages/<name>                   # Install deps in package
```

**Key Packages**:

- `@repo/ui` - Shared components (Radix UI + Tailwind)
- `@repo/auth` - Operator authentication & RBAC (App/Admin, not Sites customers)
- `@repo/database` - Control-plane SQLite schema & Drizzle client (no customer
  PII)
- `@repo/tenant-db` - Per-org customer SQLite (Drizzle)
- `@repo/sms` - OTP SMS (`packages/sms`; Twilio blocked for KSA production)
- `@repo/config` - Shared configs (ESLint, TypeScript, Prettier)
- `@repo/ai` - AI/ML integrations (Vercel AI SDK, Google AI)
- `@repo/security` - Security utilities (encryption, rate limiting)

**Key Apps:**

- `apps/app` - Operators; publishes sites; routes provision by `dataRegion`;
  hosts `/resources/jobs/*` and `/resources/videos/source`
- `apps/jobs-cron` - Cloudflare Worker cron → authenticated App job routes
- `apps/sites` - Public CMS HTML; injects tenant-api URL; no PII proxy
- `apps/tenant-api` - Regional customer auth + SQLite (local US :3007, KSA
  :3009; production OCI Ashburn + Riyadh)

## Additional Resources

- **Docs**: `/docs` directory (84 files covering all aspects)
- **Contributing**: See `CONTRIBUTING.md`
- **Security**: See `SECURITY_AUDIT_REPORT.md`
- **Getting Started**: See `docs/getting-started.md`
- **Tenant data residency**: See `docs/tenant-data-residency.md`
- **Scheduled jobs & video transforms**: See `docs/scheduled-jobs.md`
- **Testing Guide**: See `docs/testing.md`
