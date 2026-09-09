# Scheduled Jobs

Epic Stack runs control-plane maintenance on a schedule without a separate job
runner like Trigger.dev. A lightweight **Cloudflare Worker** (`apps/jobs-cron`)
fires cron triggers that POST to authenticated routes on the **App primary
instance**. The App holds the control-plane SQLite database, so the actual work
always runs where the database lives.

## Architecture

```
Cloudflare Cron (apps/jobs-cron)
        │  POST + Bearer INTERNAL_COMMAND_TOKEN
        ▼
App instance (Cloudflare Workers)
        ▼
/resources/jobs/* route handlers
        │
        ▼
Control-plane SQLite (audit logs, MCP tokens, GDPR requests, …)
```

Job routes live under `apps/app/app/routes/resources+/jobs.*.ts` and share the
auth guard in `apps/app/app/utils/internal-command-auth.server.ts` (same pattern
as the Admin cache route).

## Cron schedules (UTC)

| Cron        | Route                                       | Purpose                                                      |
| ----------- | ------------------------------------------- | ------------------------------------------------------------ |
| `0 2 * * *` | `/resources/jobs/audit-log-archival`        | Archive old audit logs                                       |
| `0 3 * * *` | `/resources/jobs/mcp-token-cleanup`         | Remove expired MCP tokens                                    |
| `0 4 * * *` | `/resources/jobs/gdpr-erasure`              | Process pending GDPR erasures                                |
| `0 5 * * *` | `/resources/jobs/form-submission-retention` | Delete regional website-form submissions older than 365 days |

## Secrets and configuration

| Variable                 | Where                           | Purpose                                           |
| ------------------------ | ------------------------------- | ------------------------------------------------- |
| `INTERNAL_COMMAND_TOKEN` | App, tenant-api, jobs-cron      | Bearer token for internal POST routes (≥16 chars) |
| `APP_BASE_URL`           | `apps/jobs-cron/wrangler.jsonc` | Base URL the worker POSTs to (staging/production) |

Set the worker secret (must match App):

```bash
cd apps/jobs-cron
npx wrangler secret put INTERNAL_COMMAND_TOKEN
```

Update `APP_BASE_URL` in `wrangler.jsonc` for each environment before deploy.

## Deployment

The `deploy-jobs-cron` GitHub Actions job deploys when `apps/jobs-cron/**`
changes. Locally:

```bash
cd apps/jobs-cron
npm run dev      # wrangler dev with cron simulation
npm run deploy   # production deploy
```

See also [deployment checklist](./deployment-checklist.md) and
[secrets](./secrets.md).

## One-off ops scripts

Some maintenance tasks are **not** on the cron schedule and are run manually
from the repo root:

| Script / npm command               | Purpose                                                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run audit:integrity-backfill` | Backfill HMAC integrity hashes on existing audit logs (dry-run by default; pass `--apply` to `npx tsx scripts/audit-integrity-backfill.ts`) |
| `scripts/transfer-s3-files.ts`     | Copy objects between S3 buckets when onboarding BYO storage (see [organization S3 storage](./organization-s3-storage.md))                   |

GDPR erasure processing previously lived in `scripts/process-gdpr-requests.mjs`;
that flow is now the `/resources/jobs/gdpr-erasure` cron route.

## Storage migration (Cloudflare Workflow)

When an org admin enables BYO S3 or changes buckets, existing note/comment media
can be copied in the background:

1. Admin saves S3 settings (optionally checks **Migrate existing org media**) or
   clicks **Migrate existing media** on the settings page.
2. App creates a `StorageMigration` row and POSTs to
   `JOBS_CRON_WORKER_URL/workflows/storage-migration/start`.
3. `StorageMigrationWorkflow` on `apps/jobs-cron` loops:
   - `POST /resources/storage/migration/:id/batch` — App copies the next batch
     server-side (then deletes each object from the source bucket), and
     **finalizes** the migration (`completed` / `failed`) when no objects remain
   - On unrecoverable workflow errors, `POST .../complete` marks the migration
     `failed`

Secrets stay on the App (Cloudflare D1/Workers); the Worker never stores org
credentials.

**App env:** `JOBS_CRON_WORKER_URL` (Worker public URL — `http://localhost:8787`
in dev; production: `https://jobs.<your-apex-domain>` on a custom domain).

## Video note media (no background jobs)

Note video **posters** and **hover preview clips** are generated **on demand**
via
[Cloudflare Media Transformations](https://developers.cloudflare.com/images/transform-images/transform-videos/)
(`/cdn-cgi/media/`), not ffmpeg or async workers.

1. The App exposes `/resources/videos/source?objectKey=…`, which proxies the
   org's object from Cloudflare R2 or custom S3 (HEAD + Range support).
2. URL helpers in `@repo/common` build transform URLs when
   `MEDIA_TRANSFORM_BASE_URL` is set on the App.
3. The `VideoPoster` component shows a frame poster and plays a short silent
   clip on hover.

**Production requirements:**

- App hostname must be **Cloudflare-proxied** (orange cloud).
- Enable **Media Transformations** on that zone.
- Set `MEDIA_TRANSFORM_BASE_URL=https://app.yourdomain.com` on the App
  (Cloudflare secret).

Leave `MEDIA_TRANSFORM_BASE_URL` empty in local dev; the UI falls back to direct
source URLs.

## Related docs

- [Organization S3 storage](./organization-s3-storage.md) — per-org buckets and
  BYO migration
- [Image storage](./image-storage.md) — Tigris / proxy pattern for images
- [Tenant data residency](./tenant-data-residency.md) — `INTERNAL_COMMAND_TOKEN`
  for tenant-api provision
