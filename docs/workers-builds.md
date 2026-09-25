# Cloudflare Workers Builds

Worker **build + deploy** runs on Cloudflare. GitHub Actions runs **CI only**,
then triggers the exact tested commit through the **Builds API**.

## Quick setup

```bash
# launch:setup deploys both Worker environments, then offers to configure Builds
npm run launch:setup
```

At the end of the launch flow:

1. Accept **Set up Cloudflare Workers Builds**.
2. The setup opens `jobs-cron` **Settings → Builds** in the Cloudflare
   dashboard.
3. Select **Connect**, authorize the Cloudflare GitHub App for the repository,
   and select or create a Worker build API token.
4. Return to the terminal and paste a user API token when prompted. It needs
   **Workers Builds Configuration: Edit** and **Workers Scripts: Read**.
5. Let setup save the trigger IDs and Cloudflare credentials to GitHub Actions.

Everything else is applied through the API. No Worker-by-Worker variable copying
is required.

The two tokens serve different purposes: the **Worker build API token** selected
inside Settings → Builds lets Cloudflare deploy the Worker, while
`CLOUDFLARE_BUILDS_API_TOKEN` lets launch setup and GitHub Actions configure and
start builds.

To retry or configure Builds independently:

```bash
export CLOUDFLARE_BUILDS_API_TOKEN=... # user token with Builds Configuration: Edit
export CLOUDFLARE_ACCOUNT_ID=...
npm run launch:workers-builds

# Optional: one app or one environment
npm run launch:workers-builds -- --app jobs-cron
npm run launch:workers-builds -- --tier staging

# Preview the plan without API calls
npm run launch:workers-builds -- --dry-run
```

The script:

- Creates the exact GitHub repository connection (it never selects an arbitrary
  connection from the account)
- Creates/updates a **manual-only** trigger for every production and staging
  Worker, so Cloudflare git pushes cannot race or duplicate the GHA-gated build
- Syncs **all binding/URL variables** from `launch.config.json` into Cloudflare
- Selects Cloudflare's preinstalled Node `22.23.2` runtime (React Router
  requires Node newer than `22.22`)
- Disables redundant Cloudflare dependency caching (`cf-workers-ci.mjs` runs
  isolated `npm ci`; avoiding oversized cache archives prevents tool-bootstrap
  crashes) and applies monorepo watch paths
- Sets **`CF_BUILD_TRIGGER_*_PRODUCTION`** and **`CF_BUILD_TRIGGER_*_STAGING`**
  GitHub Variables (via `gh` if logged in)
- Writes `launch.workers-builds.json` (gitignored state)

Production and staging are configured on their own Worker records, as required
for Wrangler environments. Deploy both environments at least once before setup.

## Flow

```
push to main/dev → GHA CI → POST tested commit SHA → Cloudflare build+deploy
```

GHA uses `scripts/trigger-cf-builds.mjs` with:

- `CLOUDFLARE_BUILDS_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` (secrets)
- `CF_BUILD_TRIGGER_APP_PRODUCTION`, `CF_BUILD_TRIGGER_APP_STAGING`, …
  (variables)

`CLOUDFLARE_BUILDS_API_TOKEN` is intentionally separate from the broader
`CLOUDFLARE_API_TOKEN` used by the Lighthouse preview deploy. The trigger script
falls back to the latter for existing installations.

## Manifest

Per-app settings live in `scripts/workers-builds-manifest.mjs` (watch paths and
`cf-workers-ci.mjs` app id). The setup applies them to both environment Workers.
You can review the result at **Worker → Settings → Builds**; `launch:setup`
opens that page for you.

## Local parity

```bash
WORKERS_CI_BRANCH=dev node scripts/cf-workers-ci.mjs build --app jobs-cron
WORKERS_CI_BRANCH=dev node scripts/cf-workers-ci.mjs deploy --app jobs-cron
```

## What stays on GitHub Actions

- Lint, typecheck, vitest, Playwright
- OCI tenant-api (Docker + SSH)
- Lighthouse PR preview (`menuza-preview` Worker)

## Troubleshooting

### "Failed: error occurred while installing tools or dependencies"

If a build fails right after `Installing nodejs ...` during tool/dependency
setup, it is typically caused by a corrupted or oversized dependency cache
archive. Because `cf-workers-ci.mjs` manages dependencies with `npm ci`, build
caching is disabled by default on all triggers.

To purge any stale cache archives:

```bash
# Purge build cache for all Workers Builds triggers
npm run launch:workers-builds -- --purge-cache
```

Alternatively, in the Cloudflare Dashboard: **Worker → Settings → Build → Build
cache → Clear Cache**.

## Cloudflare references

- [Builds API](https://developers.cloudflare.com/workers/ci-cd/builds/api-reference/)
- [Wrangler environments](https://developers.cloudflare.com/workers/ci-cd/builds/advanced-setups/#wrangler-environments)
- [Limits and pricing](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/)

## Revert to GHA deploys

If CF Builds ops cost more than ~700 GHA min/month saved, restore the removed
`deploy-*` jobs in `.github/workflows/deploy.yml` from git history.
