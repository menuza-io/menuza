# Jobs Cron Worker

Cloudflare Worker with Cron Triggers and Workflows that call authenticated
routes on the App primary instance.

See the full guide: [docs/scheduled-jobs.md](../../docs/scheduled-jobs.md).

## Cron schedules (UTC)

| Cron        | Route                                                                                                                                                                                                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0 2 * * *` | `/resources/jobs/audit-log-archival`                                                                                                                                                                                                                                   |
| `0 3 * * *` | `/resources/jobs/mcp-token-cleanup`                                                                                                                                                                                                                                    |
| `0 3 * * *` | `/resources/jobs/job-postings-expiry`                                                                                                                                                                                                                                  |
| `0 3 * * *` | `/resources/jobs/setup-reminders`                                                                                                                                                                                                                                      |
| `0 3 * * *` | `/resources/jobs/seat-reconcile`                                                                                                                                                                                                                                       |
| `0 4 * * *` | `/resources/jobs/gdpr-erasure`                                                                                                                                                                                                                                         |
| `0 4 * * *` | `/resources/jobs/voice-retention`                                                                                                                                                                                                                                      |
| `0 4 * * *` | `/resources/jobs/staffing-outbox`                                                                                                                                                                                                                                      |
| `0 * * * *` | Tenant engagement sync, staff tick, reservations tick, loyalty tick and inventory tick (each tenant-api), and `/resources/jobs/reservation-payments-reconcile`, `restaurant-order-refunds-reconcile`, `print-sync`, `social-publish` and `impersonation-cleanup` (App) |

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

## Operator alerts workflow (#366)

| HTTP                                    | Body              | Job route the App serves               |
| --------------------------------------- | ----------------- | -------------------------------------- |
| `POST /workflows/operator-alerts/start` | `{ runAt }` (ISO) | `POST /resources/jobs/operator-alerts` |

Needs the internal token and also answers under `/api/workflows/...`. The
instance id is `operator-alerts-<minute of runAt>`, so every alert held for the
same quiet-hours end shares one instance (starting an existing one counts as
success); `runAt` more than three days ahead is refused.
`OperatorAlertsWorkflow` sleeps until `runAt` (`step.sleepUntil`) and then asks
the App to release what quiet hours and snoozes held, so no alert waits for the
next hourly sweep. The hourly sweep also calls the same job route (no sixth cron
slot), which is where long pauses, busy mode and push receipts are checked. The
payload is a time only: no alert, member or guest data.

## Photo quality and menu restyle workflows (#145, #146)

| HTTP                                  | Body                 | Job route the App serves             |
| ------------------------------------- | -------------------- | ------------------------------------ |
| `POST /workflows/photo-quality/start` | `{ organizationId }` | `POST /resources/jobs/photo-quality` |
| `POST /workflows/media-restyle/start` | `{ runId }`          | `POST /resources/jobs/media-restyle` |

Both need the internal token and also answer under `/api/workflows/...`. The id
must match `[A-Za-z0-9_-]{8,64}`. The instance id is
`<name>-<id>-<10-minute bucket>`; starting one that already exists counts as
success. The payload is an id only: no photo, dish or guest data.

- `PhotoQualityWorkflow` (`photo-quality`) scores one organization's photos in
  at most 24 batches with a 20 second pause between them. It stops when nothing
  remains, when the daily limit is reached (`limited`) or when a batch processes
  nothing.
- `MediaRestyleWorkflow` (`media-restyle`) restyles one run in batches (at most
  600). When the App pauses the run for its daily budget the workflow sleeps
  until `resumeAt` (one hour when the App gives no usable time). It stops when
  the run is done, or after three batches in a row that make no progress.
- Each batch is a retried step (2 retries, exponential from 60 seconds); a
  non-2xx answer fails the step.

Neither workflow adds a cron slot: the hourly `0 * * * *` trigger also posts an
empty body to both job routes (`Photo quality sweep`, `Media restyle sweep`) to
resume what a workflow could not, so the five-cron limit above still holds.

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
