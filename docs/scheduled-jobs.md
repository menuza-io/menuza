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

| Cron        | Route                                       | Purpose                                         |
| ----------- | ------------------------------------------- | ----------------------------------------------- |
| `0 2 * * *` | `/resources/jobs/audit-log-archival`        | Archive old audit logs                          |
| `0 3 * * *` | `/resources/jobs/mcp-token-cleanup`         | Remove expired MCP tokens                       |
| `0 3 * * *` | `/resources/jobs/job-postings-expiry`       | Mark job postings past their closing date       |
| `0 4 * * *` | `/resources/jobs/gdpr-erasure`              | Process pending GDPR erasures                   |
| `0 4 * * *` | `/resources/jobs/voice-retention`           | Delete expired call recordings and caller data  |
| `0 4 * * *` | `/resources/jobs/staffing-outbox`           | Deliver staffing link, unlink, and erase events |
| `0 5 * * *` | `/resources/jobs/form-submission-retention` | Not scheduled (see below)                       |

The hourly `0 * * * *` trigger fans out to every regional tenant-api node: the
tenant engagement sync, the staff tick and the reservations tick (below). They
are independent requests, so one failing never blocks the others. The Workers
free plan allows five cron triggers per Worker, so new daily jobs share an
existing trigger (each job is still its own request with its own error logging).

### Staff tick

`POST /api/staff/tick` on each tenant-api node (token: `INTERNAL_COMMAND_TOKEN`)
runs the time clock's reminders and alerts for every organization on that node:
the missed clock-out reminder, the optional automatic clock-out (off by
default), the "has not clocked in" and overtime alerts for managers, the
pre-shift reminder, the "new applicant" manager alert, the retention of declined
applicants (below), and delivery of the regional notification outbox. It adds
**no cron slot**: it copies the engagement sync fan-out on the hourly trigger.
The response is counts only.

Granularity is therefore **hourly** when nothing else drives it: a reminder, an
automatic clock-out or an alert can lag up to an hour behind its due time, and
the policy screen says so. Two runtime-native timers make it sub-hourly where
people are actually clocked in, with this hourly call as the safety net for
both:

- **US node (Cloudflare Worker, Durable Object per organization):** each
  organization's object arms a storage alarm (5 minutes) when a kiosk call or a
  staff operator call shows staffing is in use, and re-arms it only while the
  tick reports something to watch (an open entry, a queued message, a shift
  coming up). An idle organization goes quiet and costs nothing.
- **KSA node (OCI, Node process):** an in-process interval runs the same tick
  for every organization on the node. `STAFFING_TICK_INTERVAL_SECONDS` sets it
  (default 300, minimum 60, `0` turns it off).

Every task is idempotent (a message is queued once per `dedupe_key`, an
automatic clock-out is a guarded update, and a second tick for an organization
already being ticked returns "busy"), so the drivers may overlap. The tick does
nothing for an organization whose `staffing.*` flags it cannot confirm are on:
it reads them from the App (`/resources/staffing/scope-context`), fails closed,
and a flag turned off takes effect within five minutes.
`STAFFING_EMAIL_ENABLED=false` stops staff email on a node (messages are
dropped, not held) and manager alert email in the App; in-app notifications are
unaffected.

Hiring retention runs inside the same pass: declined applicants whose retention
period has passed (the organization's setting, 365 days by default) are deleted,
200 at a time, with one audit row carrying only a count. It runs while the
master `staffing.enabled` flag is on even if `staffing.hiring` was turned off,
and it only ever selects declined rows. An organization with applicants but no
staff yet is still ticked, so its first managers are told about new applicants.

### Reservations tick

`POST /api/reservations/tick` on each tenant-api node (token:
`INTERNAL_COMMAND_TOKEN`, empty body `{}`) runs the Reservations module's
scheduled work for every organization on that node: expiring holds and
large-party requests, automatic no-shows, due guest messages and reminders with
their retries, and delivery of manager alerts to the App. It adds **no cron
slot**: it is the third request in the hourly fan-out
(`Tenant reservations tick`), after the staff tick, and a failing node or task
never blocks the others. The response is counts only.

Hourly is the safety net. The US Workers node arms a per-organization Durable
Object alarm and the Node (OCI) node runs an in-process interval
(`RESERVATIONS_TICK_INTERVAL_SECONDS`, default 120, minimum 60, `0` turns it
off), so reminders and retries are not an hour late where Reservations is in
use. Every task is idempotent, so the drivers may overlap.

Manager alerts reach the App at `POST /resources/reservations/notify` (the
regional node posts `{ orgId, eventId, kind, locationId, count }` with the
internal token). The App turns each into one in-app notification per eligible
member, plus an email unless `RESERVATIONS_EMAIL_ENABLED=false` (the switch also
stops guest email on a tenant-api node; in-app notifications are unaffected).

### Staffing outbox

`/resources/jobs/staffing-outbox` drains the control-plane `StaffingOutbox`
table: events that must reach the regional staff database but cannot be applied
in the US (link a login to a staff record when an invitation carrying a staff id
is accepted, unlink it when a member is removed, anonymize the record when an
account is erased). Rows hold opaque ids only, never names, contact details, pay
or times, and the route answers with counts only.

It runs on the **existing `0 4 * * *` trigger**. It deliberately has no cron
slot of its own: `apps/jobs-cron/wrangler.jsonc` is near the five-trigger limit,
so the free-slot count is treated as zero. That trigger is the only scheduled
drain, which means a failed delivery is retried at most once a day. Two things
keep that acceptable:

- the App makes a best-effort delivery attempt right after enqueueing (accepting
  a staff-linked invitation, removing a member, the GDPR erasure job), so the
  normal case does not wait for the cron at all;
- each row backs off exponentially (1 minute doubling to a 24-hour cap) and is
  tried at most 20 times before it is marked `failed` and logged.

Events for the same login in the same organization are delivered in order, so an
erase never overtakes the unlink queued before it. Finished rows are purged
after 7 days and failed rows after 30. If the trigger is ever moved or the
hourly trigger gains room, point the same route at it; the route is idempotent
and safe to call as often as you like.

### Job postings expiry

`/resources/jobs/job-postings-expiry` flips every published job posting whose
closing date has passed to `expired` (control-plane `JobPosting`, public content
with no person data). It rides the **existing `0 3 * * *` trigger** next to the
MCP token cleanup, so it needs no cron slot, and it is idempotent: a retry or an
overlapping run changes nothing. The route answers with a count only.

The job only keeps the stored status honest for the editor. The careers pages do
not wait for it: the public route refuses an ended posting the moment its date
passes, so a failed or late run never leaves an expired role open to applicants.

Form-submission retention (delete regional website-form submissions older than
365 days) is mapped in `JOB_ROUTES`, but `0 5 * * *` is not in
`apps/jobs-cron/wrangler.jsonc`, so it does not run. Add that trigger only when
you want old form submissions deleted.

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
