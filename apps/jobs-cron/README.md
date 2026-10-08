# Jobs Cron Worker

Cloudflare Worker with Cron Triggers and Workflows that call authenticated
routes on the App primary instance.

See the full guide: [docs/scheduled-jobs.md](../../docs/scheduled-jobs.md).

## Cron schedules (UTC)

| Cron        | Route                                    |
| ----------- | ---------------------------------------- |
| `0 2 * * *` | `/resources/jobs/audit-log-archival`     |
| `0 3 * * *` | `/resources/jobs/mcp-token-cleanup`      |
| `0 4 * * *` | `/resources/jobs/gdpr-erasure`           |
| `0 4 * * *` | `/resources/jobs/voice-retention`        |
| `0 * * * *` | Tenant engagement sync (each tenant-api) |

`/resources/jobs/form-submission-retention` is mapped to `0 5 * * *` in
`JOB_ROUTES` but that trigger is not in `wrangler.jsonc`, so it does not run.
Add the trigger only when form retention should start deleting submissions.

The Workers free plan allows five cron triggers per Worker. Daily jobs share a
trigger (see `JOB_ROUTES` in `src/index.ts`) rather than adding a sixth; each
job is still a separate request with its own error logging.

## Storage migration workflow

| HTTP                                      | Purpose                                                              |
| ----------------------------------------- | -------------------------------------------------------------------- |
| `POST /workflows/storage-migration/start` | Start a `StorageMigrationWorkflow` instance (`{ migrationId }` body) |

The workflow fetches presigned URLs from the App and stream-copies org media in
batches. Triggered by the App when an org admin starts migration from settings.

## Secrets

Set via Wrangler (must match `INTERNAL_COMMAND_TOKEN` on the App):

```bash
cd apps/jobs-cron
npx wrangler secret put INTERNAL_COMMAND_TOKEN
```

## Configuration

- `APP_BASE_URL` in `wrangler.jsonc` — App URL the worker calls
- App sets `JOBS_CRON_WORKER_URL` to this Worker's public URL (production:
  `https://jobs.<your-apex-domain>` via a custom domain on the jobs-cron Worker)

## Development

```bash
cd apps/jobs-cron
cp .dev.vars.example .dev.vars   # if missing; token must match App
npm run dev
```

Wrangler loads secrets from `.dev.vars` (not `.env`). `INTERNAL_COMMAND_TOKEN`
must match the App value (default:
`dev-internal-command-token-do-not-use-in-prod` in `apps/app/.env.schema`). Set
`APP_BASE_URL=http://localhost:3001` in `.dev.vars` so workflow callbacks hit
your local App, not production.

In another terminal, run the App with
`JOBS_CRON_WORKER_URL=http://localhost:8787`.

## Video media (App, not this worker)

Note video posters use Cloudflare Media Transformations on the App hostname. Set
`MEDIA_TRANSFORM_BASE_URL` on the App — see
[scheduled jobs — video media](../../docs/scheduled-jobs.md#video-note-media-no-background-jobs).
