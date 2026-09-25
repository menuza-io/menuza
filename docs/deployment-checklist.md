# Deployment Checklist

Infrastructure steps for deploying Menuza. For the full per-app variable tables,
Wrangler secrets, and product launch phases, see
[Launch Checklist](./launch-checklist.md).

## Overview

- **Main App & Admin App**: Cloudflare Workers with Cloudflare D1
- **Marketing Site & Tenant Sites**: Cloudflare Workers (static assets)
- **CMS**: Vercel (Turso + R2 S3)
- **Tenant-API**: US on Cloudflare Workers + Durable Objects; KSA on OCI
- **Jobs Cron**: Cloudflare Workers

## Prerequisites

- [ ] Node.js 22.18.0+ and npm 10.9.0+ installed
- [ ] Cloudflare account with Workers, D1, KV, and R2 enabled
- [ ] Wrangler CLI authenticated (`npx wrangler login`)
- [ ] GitHub repo with Actions enabled

## Step 1 — Run launch setup

```bash
npm run launch:setup
```

This writes `launch.config.json` (gitignored), optionally creates Cloudflare
resources, and prints `gh variable set` / `wrangler secret put` commands.

Or copy `launch.config.example.json` → `launch.config.json` and fill in IDs
manually.

## Step 2 — GitHub Actions configuration

**Secrets** (required):

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `AWS_ACCESS_KEY_ID` (existing Cloudflare R2 token ID)
- `AWS_SECRET_ACCESS_KEY` (existing Cloudflare R2 token secret)

**Variables** — binding IDs and public URLs. See
[Launch Checklist → GitHub Variables](./launch-checklist.md#github-actions--variables-bindings--urls).

Minimum to deploy App:

```
APP_D1_DATABASE_ID
APP_KV_NAMESPACE_ID
APP_BASE_URL
ADMIN_BASE_URL
ADMIN_D1_DATABASE_ID
ADMIN_KV_NAMESPACE_ID
```

Repeat with `_STAGING` suffixes for the `dev` branch.

Apply with the `gh` CLI or the GitHub UI:

```bash
gh variable set APP_D1_DATABASE_ID --body "<uuid-from-wrangler-d1-create>"
```

## Step 3 — Create Cloudflare resources

If you skipped resource creation in `launch:setup`:

```bash
cd apps/app
npx wrangler d1 create menuza-db
npx wrangler kv namespace create menuza-cache

cd ../web
npx wrangler d1 create menuza-web-db
npx wrangler r2 bucket create menuza-media
```

Copy the generated IDs into GitHub Variables (not into committed wrangler
files).

Create the dedicated Turborepo remote-cache bucket once. The launch setup does
this automatically when Cloudflare resource creation is selected and securely
opens the account-specific R2 token creation page when GitHub setup is selected.
It then securely prompts for the resulting credentials and saves them to GitHub.
The token must have R2 Object Read & Write permission.

```bash
npx wrangler r2 bucket create menuza-turbo-cache
```

## Step 4 — Wrangler secrets

Set secrets on each Worker once. Never commit values.

```bash
cd apps/app
npx wrangler secret put SESSION_SECRET
npx wrangler secret put INTERNAL_COMMAND_TOKEN
npx wrangler secret put LAUNCH_STATUS
# See docs/launch-checklist.md for the full list per app
```

## Step 5 — Deploy

Push to `main` (production) or `dev` (staging). CI:

1. Runs `scripts/patch-wrangler.mjs` — injects GitHub Variables into
   `wrangler.deploy.jsonc` / `wrangler.deploy.toml`
2. Runs `wrangler deploy --config wrangler.deploy.*`

Manual deploy:

```bash
node scripts/patch-wrangler.mjs --app app --env production
cd apps/app && npx wrangler deploy --config wrangler.deploy.jsonc
```

## Step 6 — Tenant API

### US (Cloudflare)

- [ ] Enable Durable Objects
- [ ] Set `TENANT_API_US_WORKER_NAME` GitHub Variable
- [ ] Set tenant-api Wrangler secrets (`JWT_SECRET`, `AUTH_HMAC_SECRET`, etc.)
- [ ] Set `TENANT_API_URL` for CI health checks

### KSA (OCI)

- [ ] OCI VM + `/data/tenants` volume
- [ ] `OCI_TENANT_KSA_HOST`, `OCI_TENANT_SSH_KEY`, `TENANT_API_URL_KSA`

## Step 7 — Verify

Health endpoints (liveness — expect HTTP 200 and `"status":"ok"`):

| App        | Endpoint                           |
| ---------- | ---------------------------------- |
| App        | `GET /api/health`                  |
| Admin      | `GET /api/health`                  |
| Web        | `GET /api/health`                  |
| Sites      | `GET /api/health`                  |
| Jobs cron  | `GET /api/health`                  |
| Tenant API | `GET /api/health` or `GET /health` |

Deep checks (App/Admin only — D1 + self-reachability):
`GET /resources/healthcheck`

- [ ] `curl -fsS $APP_BASE_URL/api/health`
- [ ] `curl -fsS $ADMIN_BASE_URL/api/health`
- [ ] `curl -fsS https://<marketing-host>/api/health`
- [ ] `curl -fsS https://<tenant-site-host>/api/health`
- [ ] `curl -fsS https://jobs.<apex>/api/health`
- [ ] `curl -fsS $TENANT_API_URL/api/health` → `"region":"us"`
- [ ] `curl -fsS $TENANT_API_URL_KSA/api/health` → `"region":"ksa"` (if KSA
      deployed)
- [ ] Staging (flat hostnames): `curl -fsS $APP_BASE_URL_STAGING/api/health`,
      etc. — see [ADR 046](./decisions/046-staging-hostnames-and-cookies.md)
- [ ] App signup smoke test
- [ ] D1 migrations applied (`npm run db:migrate:deploy`)

## Troubleshooting

- **Binding errors**: Check GitHub Variables match `wrangler d1 list` /
  `wrangler kv namespace list`
- **Dashboard values revert**: Expected — CI is source of truth for patched keys
- **Database errors**: `APP_D1_DATABASE_ID` must match the D1 database in your
  account

## Related

- [Launch Checklist](./launch-checklist.md) — complete reference
- [ADR 046 — Staging hostnames and cookies](./decisions/046-staging-hostnames-and-cookies.md)
- [Deployment](./deployment.md) — architecture details
- [Secrets](./secrets.md)
