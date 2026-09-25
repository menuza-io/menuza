# Launch Checklist

Complete guide for deploying Menuza: infrastructure bindings, GitHub
configuration, Wrangler secrets, and product launch phases.

For day-to-day infrastructure steps, see also
[Deployment Checklist](./deployment-checklist.md).

---

## How configuration works

| Layer                            | What it controls                      | Where you set it                                                                           | Survives `wrangler deploy`?   |
| -------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------- |
| **Bindings**                     | D1, KV, R2, Worker name               | Cloudflare **Build variables** (Workers Builds) or GitHub Variables for Lighthouse preview | Yes (re-applied each build)   |
| **Runtime URLs / feature flags** | `BASE_URL`, `LAUNCH_STATUS`, API URLs | Wrangler **secrets** or GitHub Variables                                                   | Secrets yes; vars from CI yes |
| **Credentials**                  | `SESSION_SECRET`, Stripe, OAuth       | Wrangler **secrets** only                                                                  | Yes                           |
| **Local dev**                    | Everything                            | `apps/*/.env` + `.dev.vars`                                                                | N/A                           |

**Do not edit Cloudflare dashboard Variables for keys that CI manages** — the
next deploy will overwrite them. Change GitHub Variables or Wrangler secrets
instead.

### Quick start

```bash
# 1. Interactive setup (auto-detects Cloudflare + .env, writes launch.config.json)
npm run launch:setup

# 2. Set GitHub Secrets (repo → Settings → Secrets and variables → Actions)
#    CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID

# 3. Set Wrangler secrets on each Worker (see tables below)

# 4. launch:setup offers to configure Workers Builds after the first deployments.
#    Push to main (production) or dev (staging) — GHA runs CI, then triggers the
#    tested commit through the Cloudflare Builds API (see docs/workers-builds.md)
```

When logged in via `npx wrangler login`, setup auto-detects D1/KV/R2 IDs (by
`menuza-*` resource names), Worker names from wrangler configs, `ROOT_APP` from
`.env`, and your GitHub repo from `git remote get-url origin` (falls back to
`gh repo view` when origin is not GitHub).

Cloudflare **resource names** (D1, KV, R2) and **Worker names** use the
`menuza-*` prefix in the template. `npm run setup` replaces `menuza` with your
**short name** slug everywhere (Workers, databases, buckets, docs).

Local deploy test:

```bash
# Uses launch.config.json when env vars are unset
DEPLOY_TARGET=cloudflare npm run build:cf --workspace=app
node scripts/patch-wrangler.mjs --app app --env production
cd apps/app && npx wrangler deploy --config build/server/wrangler.deploy.json
```

Copy `launch.config.example.json` → `launch.config.json` (gitignored) if you
skip the interactive script. Generated secrets land in `launch.secrets.json`
(also gitignored) with values shared across App, Admin, and tenant-api.

---

## GitHub Actions — Secrets (required)

Set under **Settings → Secrets and variables → Actions → Secrets**.

| Secret                        | Used by                                 | Purpose                                            |
| ----------------------------- | --------------------------------------- | -------------------------------------------------- |
| `CLOUDFLARE_BUILDS_API_TOKEN` | `trigger-cf-builds`                     | User token with Workers Builds Configuration: Edit |
| `CLOUDFLARE_API_TOKEN`        | Lighthouse preview deploy               | API token with Workers deployment permissions      |
| `CLOUDFLARE_ACCOUNT_ID`       | Lighthouse, deploys, and Turbo R2 cache | Cloudflare account ID                              |
| `AWS_ACCESS_KEY_ID`           | Turbo cache in GitHub Actions           | Existing Cloudflare R2 token ID                    |
| `AWS_SECRET_ACCESS_KEY`       | Turbo cache in GitHub Actions           | Existing Cloudflare R2 token secret                |
| `OCI_TENANT_SSH_KEY`          | `deploy-tenant-api-oci`                 | SSH private key for OCI VMs (KSA / optional US)    |
| `GHCR_PULL_TOKEN`             | OCI deploy (optional)                   | PAT with `packages:read` if GHCR image is private  |

Generate API token:
[Cloudflare Dashboard → API Tokens](https://dash.cloudflare.com/profile/api-tokens)
(Custom token: Account → Workers Scripts, D1, KV, R2 → Edit).

For the Turbo cache, create `menuza-turbo-cache` in R2 and reuse an existing R2
token with Object Read & Write permission. `npm run launch:setup` creates the
bucket when Cloudflare resource creation is selected, then securely opens
`https://dash.cloudflare.com/<ACCOUNT_ID>/r2/api-tokens/create?type=account`
when GitHub setup is selected. After the user creates the bucket-scoped token,
the launcher securely prompts for and saves its `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY` values.

---

## GitHub Actions — Variables (bindings + URLs)

Set under **Settings → Secrets and variables → Actions → Variables**.

CI reads these on every deploy. Use the `_STAGING` suffix for the `dev` branch;
unsuffixed names are used for `main` (production).

### Shared URLs (all environments)

| Variable                    | Example                             | Used by                                 |
| --------------------------- | ----------------------------------- | --------------------------------------- |
| `APP_BASE_URL`              | `https://app.yourdomain.com`        | App, jobs-cron, tenant-api              |
| `ADMIN_BASE_URL`            | `https://admin.yourdomain.com`      | Admin                                   |
| `PUBLIC_APP_URL`            | `https://app.yourdomain.com`        | Sites build + Sites Worker              |
| `ROOT_APP`                  | `yourdomain.com`                    | App, Admin, Sites, tenant-api, Web      |
| `PUBLIC_SITE_HOST_SUFFIXES` | `yourdomain.com,workers.dev`        | App                                     |
| `TENANT_API_URL`            | `https://tenant-us.yourdomain.com`  | App, Admin, Sites, jobs-cron, CI health |
| `TENANT_API_URL_KSA`        | `https://tenant-ksa.yourdomain.com` | App, Admin, Sites, jobs-cron, CI health |
| `JOBS_CRON_WORKER_URL`      | `https://jobs.yourdomain.com`       | App (custom domain on jobs-cron Worker) |
| `DOCS_URL`                  | `https://docs.yourdomain.com`       | App sidebar (optional)                  |
| `WEB_BASE_URL`              | `https://yourdomain.com`            | Web marketing Worker (apex + `www`)     |

`DOCS_URL` is optional. Set it to the absolute URL of your documentation site to
show **Get help** in the App sidebar; leave it unset or empty to omit that item.
Use `DOCS_URL_STAGING` when staging should link to different docs.

### Staging URLs (`dev` branch)

Flat single-label subdomains on the production apex (free Universal SSL — no
`*.stage.yourdomain.com`). See
[ADR 046](./decisions/046-staging-hostnames-and-cookies.md).

| Variable                            | Example                                    |
| ----------------------------------- | ------------------------------------------ |
| `ROOT_APP_STAGING`                  | `yourdomain.com` (same apex as production) |
| `APP_BASE_URL_STAGING`              | `https://app-staging.yourdomain.com`       |
| `ADMIN_BASE_URL_STAGING`            | `https://admin-staging.yourdomain.com`     |
| `WEB_BASE_URL_STAGING`              | `https://staging.yourdomain.com`           |
| `PUBLIC_APP_URL_STAGING`            | `https://app-staging.yourdomain.com`       |
| `PUBLIC_SITE_HOST_SUFFIXES_STAGING` | `yourdomain.com,workers.dev`               |
| `TENANT_API_URL_STAGING`            | `https://tenant-us-staging.yourdomain.com` |
| `JOBS_CRON_WORKER_URL_STAGING`      | `https://jobs-staging.yourdomain.com`      |
| `DOCS_URL_STAGING`                  | `https://docs-staging.yourdomain.com`      |

`patch-wrangler.mjs` injects **zone routes** from the URLs above. Production
Sites uses `*.yourdomain.com/*`. Staging Sites defaults to
`demo-staging.yourdomain.com/*` (explicit route — prod already owns the apex
wildcard). Add **Custom Domains** on the staging Sites Worker for additional
`{slug}-staging.yourdomain.com` tenant hosts.

Staging App/Admin share `Domain=.yourdomain.com` cookies but use suffixed names
(`en_session_staging`, etc.) so prod sessions are not overwritten in the same
browser.

### App (`apps/app`)

| Variable (production) | Variable (staging / `dev` branch) |
| --------------------- | --------------------------------- |
| `APP_D1_DATABASE_ID`  | `APP_D1_DATABASE_ID_STAGING`      |
| `APP_KV_NAMESPACE_ID` | `APP_KV_NAMESPACE_ID_STAGING`     |
| `APP_WORKER_NAME`     | `APP_WORKER_NAME_STAGING`         |

Create resources:

```bash
cd apps/app
npx wrangler d1 create menuza-db
npx wrangler kv namespace create menuza-cache
# Staging:
npx wrangler d1 create menuza-db-staging
npx wrangler kv namespace create menuza-cache-staging
```

### Admin (`apps/admin`)

| Variable (production)   | Variable (staging)              |
| ----------------------- | ------------------------------- |
| `ADMIN_D1_DATABASE_ID`  | `ADMIN_D1_DATABASE_ID_STAGING`  |
| `ADMIN_KV_NAMESPACE_ID` | `ADMIN_KV_NAMESPACE_ID_STAGING` |
| `ADMIN_WORKER_NAME`     | `ADMIN_WORKER_NAME_STAGING`     |

Admin shares the **same D1 database** as App in most installs — use the same
`database_id` for both.

### Web / marketing (`apps/web`)

| Variable (production) | Variable (staging)           |
| --------------------- | ---------------------------- |
| `WEB_D1_DATABASE_ID`  | `WEB_D1_DATABASE_ID_STAGING` |
| `WEB_R2_BUCKET_NAME`  | `WEB_R2_BUCKET_NAME_STAGING` |
| `WEB_WORKER_NAME`     | `WEB_WORKER_NAME_STAGING`    |

`PUBLIC_APP_URL` / `PUBLIC_APP_URL_STAGING` are patched into the Web Worker for
login links and theme cookie name sync with App/Admin (see ADR 046).

```bash
cd apps/web
npx wrangler d1 create menuza-web-db
npx wrangler r2 bucket create menuza-media
```

### Sites (`apps/sites`)

| Variable (production) | Variable (staging)          |
| --------------------- | --------------------------- |
| `SITES_WORKER_NAME`   | `SITES_WORKER_NAME_STAGING` |

Sites URLs come from the shared variables (`PUBLIC_APP_URL`, `TENANT_API_URL`,
`ROOT_APP`). Staging tenant sites use `{slug}-staging.yourdomain.com`. The
default staging route is `demo-staging.yourdomain.com/*`; add Custom Domains for
other staging org hosts (see ADR 046).

### Jobs cron (`apps/jobs-cron`)

| Variable (production)   | Variable (staging)              |
| ----------------------- | ------------------------------- |
| `JOBS_CRON_WORKER_NAME` | `JOBS_CRON_WORKER_NAME_STAGING` |

URLs patched from `APP_BASE_URL`, `TENANT_API_URL`, `TENANT_API_URL_KSA`.

### Tenant API US (`apps/tenant-api` on Cloudflare)

| Variable (production)       | Variable (staging)                  |
| --------------------------- | ----------------------------------- |
| `TENANT_API_US_WORKER_NAME` | `TENANT_API_US_WORKER_NAME_STAGING` |

### OCI tenant-api (optional / KSA)

| Variable              | Purpose                                        |
| --------------------- | ---------------------------------------------- |
| `OCI_TENANT_US_HOST`  | Ashburn VM hostname (optional US OCI fallback) |
| `OCI_TENANT_KSA_HOST` | Riyadh VM hostname                             |
| `OCI_TENANT_SSH_USER` | SSH user (default `ubuntu`)                    |

---

## Per-application Wrangler secrets

Run from each app directory. Use `--env staging` for the staging Worker when
deploying the `dev` branch.

Generate values: `openssl rand -hex 32`

### App (`apps/app`) — required for production

| Secret                       | Notes                                            |
| ---------------------------- | ------------------------------------------------ |
| `SESSION_SECRET`             | Session cookie signing — **must match Admin**    |
| `HONEYPOT_SECRET`            | CSRF honeypot                                    |
| `INTERNAL_COMMAND_TOKEN`     | Shared with Admin, tenant-api, jobs-cron         |
| `TENANT_OPERATOR_TOKEN`      | Operator JWT for browser → tenant-api            |
| `JWT_SECRET`                 | App/mobile operator API tokens                   |
| `TENANT_CUSTOMER_JWT_SECRET` | **Must match US tenant-api `JWT_SECRET`**        |
| `LAUNCH_STATUS`              | `CLOSED_BETA` \| `PUBLIC_BETA` \| `LAUNCHED`     |
| `BASE_URL`                   | Public App origin (can also use GitHub Variable) |
| `AUDIT_LOG_SECRET_KEY`       | Required in production                           |

### App — when billing is live (`LAUNCH_STATUS=LAUNCHED`)

| Secret                   | Notes                   |
| ------------------------ | ----------------------- |
| `STRIPE_SECRET_KEY`      |                         |
| `STRIPE_WEBHOOK_SECRET`  |                         |
| `STRIPE_PUBLISHABLE_KEY` | Can be var if preferred |

### App — email

| Secret           | When                                                          |
| ---------------- | ------------------------------------------------------------- |
| `RESEND_API_KEY` | `EMAIL_PROVIDER=resend` (default)                             |
| `OCI_*`          | `EMAIL_PROVIDER=oci` — see `docs/platform-marketing-email.md` |

### App — storage (R2 / S3-compatible)

| Secret                  | Notes               |
| ----------------------- | ------------------- |
| `AWS_ACCESS_KEY_ID`     | R2 API token ID     |
| `AWS_SECRET_ACCESS_KEY` | R2 API token secret |

Set non-secret storage config via secrets or GitHub Variables:
`AWS_ENDPOINT_URL_S3`, `BUCKET_NAME`, `AWS_REGION`.

### App — optional integrations

`INTEGRATION_ENCRYPTION_KEY`, `SSO_ENCRYPTION_KEY`, `GITHUB_CLIENT_SECRET`,
`GOOGLE_CLIENT_SECRET`, `DISCORD_*`, `JIRA_CLIENT_SECRET`,
`SLACK_CLIENT_SECRET`, `POSTHOG_PROJECT_TOKEN`, `POSTHOG_HOST`,
`POSTHOG_PERSONAL_API_KEY`, `POSTHOG_PROJECT_ID`, `POSTHOG_LOGS_DESTINATION`,
`CLOUDFLARE_API_TOKEN` (custom domains), `MEDIA_TRANSFORM_BASE_URL`,
`GOOGLE_GENERATIVE_AI_API_KEY`, etc. — see `apps/app/.env.schema`.

```bash
cd apps/app
npx wrangler secret put SESSION_SECRET
npx wrangler secret put LAUNCH_STATUS
# … repeat for each secret
npx wrangler secret put SESSION_SECRET --env staging
```

### Admin (`apps/admin`) — required

| Secret                      | Notes                      |
| --------------------------- | -------------------------- |
| `SESSION_SECRET`            | **Same value as App**      |
| `HONEYPOT_SECRET`           |                            |
| `INTERNAL_COMMAND_TOKEN`    | **Same as App**            |
| `LAUNCH_STATUS`             | **Same as App**            |
| `BASE_URL`                  | Public Admin origin        |
| `SSO_ENCRYPTION_KEY`        | **Same as App**            |
| `AUDIT_LOG_SECRET_KEY`      | **Same as App**            |
| `AWS_SECRET_ACCESS_KEY`     | If using R2 for org assets |
| `RESEND_API_KEY` or `OCI_*` | Platform marketing email   |

### Tenant API US (`apps/tenant-api`)

| Secret                   | Notes                                                          |
| ------------------------ | -------------------------------------------------------------- |
| `JWT_SECRET`             | Customer tokens — **matches App `TENANT_CUSTOMER_JWT_SECRET`** |
| `AUTH_HMAC_SECRET`       | OTP / refresh hashes — unique per region                       |
| `INTERNAL_COMMAND_TOKEN` | **Same as App**                                                |
| `TENANT_OPERATOR_TOKEN`  | **Same as App**                                                |
| `TWILIO_AUTH_TOKEN`      | US SMS only (not KSA production)                               |

### Jobs cron (`apps/jobs-cron`)

| Secret                   | Notes           |
| ------------------------ | --------------- |
| `INTERNAL_COMMAND_TOKEN` | **Same as App** |

### Tenant API KSA (OCI VM `.env`, not Wrangler)

On the Riyadh VM at `/opt/tenant-api/.env`:

```
DATA_REGION=ksa
TENANT_DB_DIR=/data/tenants
JWT_SECRET=...          # unique to KSA
AUTH_HMAC_SECRET=...
INTERNAL_COMMAND_TOKEN=...   # same as App
TENANT_OPERATOR_TOKEN=...    # same as App
APP_URL=https://app.yourdomain.com
ROOT_APP=yourdomain.com
```

See [Deployment](./deployment.md#regional-tenant-data-plane).

---

## Per-application local `.env`

After `npm run setup`, edit:

| App        | File                   | Schema                        |
| ---------- | ---------------------- | ----------------------------- |
| App        | `apps/app/.env`        | `apps/app/.env.schema`        |
| Admin      | `apps/admin/.env`      | `apps/admin/.env.schema`      |
| Sites      | `apps/sites/.env`      | `apps/sites/.env.schema`      |
| Web        | `apps/web/.env`        | `apps/web/.env.schema`        |
| Tenant API | `apps/tenant-api/.env` | `apps/tenant-api/.env.schema` |

Wrangler dev secrets: `apps/app/.dev.vars`, `apps/tenant-api/.dev.vars`
(gitignored).

---

## Deploy checklist by application

### 1. App + Admin (Cloudflare Workers + D1)

- [ ] Create D1 + KV (production + staging)
- [ ] Set GitHub Variables (`APP_*`, `ADMIN_*`, shared URLs)
- [ ] Set Wrangler secrets on both Workers (staging + production)
- [ ] Run D1 migrations: `npm run db:migrate:deploy` (or CI on first deploy)
- [ ] Accept the Workers Builds setup at the end of `npm run launch:setup`
- [ ] Push to `main` / `dev` — GHA CI, then Cloudflare Workers Builds
      ([workers-builds.md](./workers-builds.md))

### 2. Web (marketing Worker)

- [ ] Create D1 + R2 bucket
- [ ] Set `WEB_*` GitHub Variables + `ROOT_APP`
- [ ] Deploy via CI or
      `node scripts/patch-wrangler.mjs --app web && cd apps/web && npx wrangler deploy --config wrangler.deploy.toml`

### 3. Sites (tenant public sites Worker)

- [ ] Set `PUBLIC_APP_URL`, `TENANT_API_URL*`, `ROOT_APP`, `SITES_WORKER_NAME*`
- [ ] Sites build receives `PUBLIC_APP_URL` / tenant URLs from GitHub Variables
      in CI

### 4. Jobs cron

- [ ] Set `JOBS_CRON_WORKER_NAME*`, `JOBS_CRON_WORKER_URL`
      (`https://jobs.<apex>`)
- [ ] Attach `jobs.<apex>` as a custom domain on the jobs-cron Worker
- [ ] `wrangler secret put INTERNAL_COMMAND_TOKEN` (same token as App)

### 5. Tenant API US (Cloudflare Worker + Durable Objects)

- [ ] Enable Durable Objects on Cloudflare account
- [ ] Set `TENANT_API_US_WORKER_NAME*`, `APP_BASE_URL`, `ROOT_APP`
- [ ] Set tenant-api Wrangler secrets
- [ ] Verify: `curl $TENANT_API_URL/api/health` → `"region":"us"`

### 6. Tenant API KSA (OCI)

- [ ] Provision OCI VM + block volume at `/data/tenants`
- [ ] Set `OCI_TENANT_KSA_HOST`, `OCI_TENANT_SSH_KEY`, `TENANT_API_URL_KSA`
- [ ] Copy `docker-compose.yml` + `.env` to `/opt/tenant-api`
- [ ] Verify: `curl $TENANT_API_URL_KSA/api/health` → `"region":"ksa"`

### 7. CMS (Vercel — optional)

- [ ] Turso + R2 credentials on Vercel — see CMS docs
- [ ] Not managed by `patch-wrangler.mjs`

---

## Product launch phases

`LAUNCH_STATUS` is an enum on **both** `apps/app` and `apps/admin`. The two apps
must use the **same value** in every environment.

| Phase       | Value         | What users see                                                                          | Billing |
| ----------- | ------------- | --------------------------------------------------------------------------------------- | ------- |
| Closed beta | `CLOSED_BETA` | Sign up → `/waitlist`; earn points via referrals and Discord; admins grant early access | Hidden  |
| Public beta | `PUBLIC_BETA` | Sign up → create an organization; full app without Stripe checkout                      | Hidden  |
| Launched    | `LAUNCHED`    | Full product including subscriptions and billing                                        | Enabled |

Defined in `apps/app/.env.schema` and `apps/admin/.env.schema`.

### What each phase gates in code

- **Closed beta:** onboarding redirects to `/waitlist`; logged-in users without
  early access stay on the waitlist; organization creation is blocked until an
  admin grants access (`Admin → Waitlist → Grant access`).
- **Public beta:** new users go to organization creation; billing pages and
  upgrade UI are hidden.
- **Launched:** billing, Stripe plans, and the upgrade sidebar card are
  available.

---

## Shared steps (every phase change)

- [ ] Set `LAUNCH_STATUS` via Wrangler secret on **App and Admin** (not
      dashboard Variables)
- [ ] Redeploy **both** App and Admin (or push a commit)
- [ ] Confirm Admin **Waitlist** shows the expected banner for the current phase
- [ ] Run a quick signup smoke test in the target environment

```bash
cd apps/app && npx wrangler secret put LAUNCH_STATUS
cd ../admin && npx wrangler secret put LAUNCH_STATUS
# Enter: CLOSED_BETA | PUBLIC_BETA | LAUNCHED
# Repeat with --env staging for dev branch Workers
```

---

## Phase 1 — Closed beta (waitlist)

### Required configuration

**App** (Wrangler secrets or `apps/app/.env` locally):

- [ ] `LAUNCH_STATUS=CLOSED_BETA`
- [ ] `BASE_URL` matches the public App origin

**Admin:**

- [ ] `LAUNCH_STATUS=CLOSED_BETA`

### Waitlist verification

- [ ] New signup completes onboarding and lands on `/waitlist`
- [ ] Existing users without early access are redirected to `/waitlist` from `/`
- [ ] Referral link (`/r/{code}`) awards +5 points to the referrer on signup
- [ ] Admin **Waitlist** lists entries, sort/filter works, and **Grant access**
      lets a user create an organization
- [ ] After grant, the user leaves the waitlist and can use the app normally

### Discord integration (recommended)

See [Discord Integration](../apps/app/docs/DISCORD_INTEGRATION.md).

**App** secrets:

- [ ] `DISCORD_INVITE_URL`
- [ ] `DISCORD_CLIENT_ID`
- [ ] `DISCORD_CLIENT_SECRET`
- [ ] `DISCORD_GUILD_ID`
- [ ] `DISCORD_REDIRECT_URI` — must match Discord Developer Portal exactly

```bash
cd apps/app
npx wrangler secret put DISCORD_CLIENT_SECRET
npx wrangler secret put DISCORD_CLIENT_ID
npx wrangler secret put DISCORD_GUILD_ID
npx wrangler secret put DISCORD_REDIRECT_URI
npx wrangler secret put DISCORD_INVITE_URL
```

---

## Phase 2 — Public beta

- [ ] `LAUNCH_STATUS=PUBLIC_BETA` on App **and** Admin (Wrangler secrets)
- [ ] Redeploy both apps
- [ ] New signup goes to `/organizations/create` (not waitlist)
- [ ] Billing routes and upgrade prompts remain hidden

`TRIAL_DAYS` and `CREDIT_CARD_REQUIRED_FOR_TRIAL` are **ignored** during this
phase.

---

## Phase 3 — Launched

- [ ] `LAUNCH_STATUS=LAUNCHED` on App **and** Admin
- [ ] Stripe secrets configured on App Worker
- [ ] Redeploy both apps
- [ ] Billing and subscriptions work end-to-end

### Trial configuration (App only)

Set via Wrangler secrets when billing is live:

| Variable                         | Default  | Purpose                  |
| -------------------------------- | -------- | ------------------------ |
| `TRIAL_DAYS`                     | `14`     | Free trial length (days) |
| `CREDIT_CARD_REQUIRED_FOR_TRIAL` | `manual` | `manual` or `stripe`     |

---

## Troubleshooting

| Symptom                                 | Likely cause                                                                                              |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Dashboard Variable reverts after deploy | Key is in `wrangler.jsonc` `vars` or patched by CI — use secrets or GitHub Variables                      |
| D1 binding error on deploy              | Missing `APP_D1_DATABASE_ID` (or `_STAGING`) GitHub Variable                                              |
| App and Admin session mismatch          | Different `SESSION_SECRET` or `BASE_URL` / cookie domain; staging uses `en_session_staging` (see ADR 046) |
| Tenant provision fails                  | `INTERNAL_COMMAND_TOKEN` mismatch between App and tenant-api                                              |
| Customer auth fails on Sites            | `TENANT_CUSTOMER_JWT_SECRET` (App) ≠ `JWT_SECRET` (US tenant-api)                                         |
| Manual Discord note on waitlist         | Missing Discord secrets on App                                                                            |
| Waitlist inactive in Admin              | `LAUNCH_STATUS` ≠ `CLOSED_BETA` on Admin                                                                  |

---

## Related docs

- [Deployment Checklist](./deployment-checklist.md) — condensed infra steps
- [Deployment](./deployment.md) — architecture and tenant-api OCI
- [Secrets](./secrets.md) — local `.env` vs `wrangler secret put`
- [Discord Integration](../apps/app/docs/DISCORD_INTEGRATION.md)
- [Payments package](../packages/payments/README.md)
- `launch.config.example.json` — local / CI variable reference
- `launch.secrets.json` — generated shared secrets (gitignored; created by
  `launch:setup`)
- `scripts/patch-wrangler.mjs` — binding injection implementation
- `scripts/launch-setup.mjs` — interactive first-time setup
  (`npm run launch:setup`)
