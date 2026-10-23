# Staff module

The Staff module is a set of tools for the people who work for an organization:
a roster, a shared-tablet time clock, timesheets, the weekly schedule, labor
cost, and hiring with onboarding. It is **off for every organization until a
feature flag turns it on**.

This page is the operator guide and the runbook. The design, data model and
decisions are in [the plan](./staffing-plan.md) and
[ADR 047](./decisions/047-staffing-data-residency.md). Where data lives is in
[tenant data residency](./tenant-data-residency.md); roles and grants are in
[permissions](./permissions.md); the timers are in
[scheduled jobs](./scheduled-jobs.md#staff-tick).

## What is in it

| Area       | What a manager can do                                                                                                                                                                      | Flag                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- |
| Team       | Roster, positions, several roles per person, pay rates with start dates, PINs, notes, link a staff record to a login, terminate and rehire                                                 | `staffing.enabled`    |
| Time clock | Labor rules, the organization time zone, pair shared tablets, see who is on the clock, forgotten clock-outs and alerts                                                                     | `staffing.timeclock`  |
| Timesheets | Review and fix time cards, mark overtime and breaks in words, approve and lock, hours export for payroll                                                                                   | `staffing.timeclock`  |
| Schedule   | Week, day and month views, shifts and open shifts, copy a week, templates, publish with an audience, availability, time off, shift requests, "my schedule" for staff                       | `staffing.scheduling` |
| Labor      | Labor cost and labor percentage against sales, manual sales entry or CSV import (or orders from a vertical's order source), tip pool report, forecast gap on the schedule, report subjects | `staffing.labor`      |
| Hiring     | Job posts and a careers page, applicants in a pipeline, interviews, decline with a message, hire in one step, onboarding checklists and certificates                                       | `staffing.hiring`     |

Staff are **not** members. An hourly worker with no email exists without a login
and without costing a seat. Linking a staff record to a login is optional and
changes only what that person can see about themselves.

Not included: running payroll, tax forms, job-board syndication, background
checks, auto-scheduling, push notifications, a staff mobile app, geofencing and
photo punches.

## Turning it on

Every Staff screen is behind organization-level feature flags. A missing flag is
off; only the stored value `true` turns one on. A child flag counts only while
the master flag is on.

| Flag                  | Gates                                                                 |
| --------------------- | --------------------------------------------------------------------- |
| `staffing.enabled`    | Master: sidebar group, every Staff route, Team, minting Staff tokens  |
| `staffing.timeclock`  | Time clock and Timesheets                                             |
| `staffing.scheduling` | Schedule, publishing, "my schedule", kiosk next shifts                |
| `staffing.labor`      | Labor page, pay figures in reports, minting the `labor` grant         |
| `staffing.hiring`     | Job posts, careers pages, applicants, onboarding, applicant retention |

Set them from the admin app's **Feature flags** page (type boolean, level
organization). Keys do not need to be registered. A flag that is off answers
**404** (the module looks like it does not exist); a missing permission answers
**403**. No trial, plan or paywall check exists anywhere in the module.

Then give people access. Staff permissions are separate from every other
permission and **existing custom roles receive none**. In Settings, Roles, the
"Staff role presets" panel creates editable _Shift manager_, _General manager_
and _Hiring manager_ roles in one click; or tick the Staff groups on any custom
role. Pay, private details and labor cost never imply each other. The generic
module has one implicit scope per organization, so permissions are
organization-wide. Changes lag by up to one token lifetime: 15 minutes, 5 for
pay or private grants.

## First day, step by step

1. **Positions.** Team, Positions: the jobs your people do, each with a colour,
   an area, an Arabic name and a default rate.
2. **People.** Team, Add (or Import a CSV, or Bulk). Give each person one or
   more positions and a rate. Names, contact details and pay are stored in your
   customers' region, never in the US.
3. **Labor rules and time zone** (Time clock, Rules). Pick the organization's
   time zone first (it is stored in `Organization.staffingTimeZone`, default
   `UTC`, and fixes every business date and shift time), then set the week
   start, overtime, rounding, breaks, late grace and the reminder for a
   forgotten clock-out. `aggregate_overtime_across_scopes` has no default; it
   only matters once a vertical adds more than one scope.
4. **Pair a tablet.** Time clock, Tablets, "Pair a tablet": open the one-time
   link on the tablet within 10 minutes. The tablet is bound to one scope (the
   organization's only one, unless a vertical adds more). Each person needs a
   PIN (Team, person, Access; a PIN is printed once).
5. **Timesheets.** Cards fill from punches. Needs-review cards say why (missing
   clock-out, long shift, missed break). Fix in the row, approve, then lock a
   pay period. Locked cards cannot change until unlocked; every edit needs a
   reason and is kept in the edit log.
6. **Schedule.** Add shifts (keyboard, pointer and touch all work), copy last
   week, then Publish and choose who is told: everyone, only changes, or nobody.
   Each person gets an email with a private "my schedule" link that shows only
   their own published shifts and lets them ask for time off or a swap. People
   without email appear in "not notified".
7. **Labor.** Enter sales by hand (or import a CSV) so the labor percentage has
   a denominator. Without a vertical's order source there is nothing else to
   count, and the page says so.
8. **Hiring.** Hiring, Post a job. Publishing puts a careers page on your site
   (needs a published site). Applicants apply from their own browser; managers
   move them along, book interviews, decline with a message, or hire. Hire
   creates the staff record, assignment, position and onboarding checklist in
   one step.

## Kill switches and settings

| Setting                          | Where                  | Effect                                                                                                                                  |
| -------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `STAFFING_KIOSK_ENABLED=false`   | tenant-api (per node)  | Every `/kiosk` route answers 503 and no new pairing codes are made on that node. Revoking a device still works. Default on.             |
| `STAFFING_EMAIL_ENABLED=false`   | tenant-api and App     | Drops staff reminders and notices (dropped, not held: re-enabling sends no backlog) and manager alert email. In-app alerts are kept.    |
| `STAFFING_TICK_INTERVAL_SECONDS` | tenant-api Node (OCI)  | Seconds between in-process ticks (default 300, minimum 60, `0` off). The hourly fan-out always runs; Workers use Durable Object alarms. |
| `INTERNAL_COMMAND_TOKEN`         | App, Admin, tenant-api | Authenticates cron calls, the tick and provisioning.                                                                                    |
| `TENANT_OPERATOR_TOKEN`          | App and tenant-api     | Signs and validates the short-lived Staff tokens. Rotate on both together.                                                              |
| `AUTH_HMAC_SECRET`               | tenant-api only        | Keys PIN lookup and OTP hashes. Never set on Sites.                                                                                     |
| `TURNSTILE_SECRET_KEY`           | tenant-api only        | Challenge for the careers apply form (action `careers-apply`).                                                                          |

A flag cannot stop a tablet that is already paired: its device secret lives on
the tablet. The kill switch and device revocation are the controls for that.

A paired Station till can also be a time clock (`/pos/timeclock/*`, the same
punch engine and PIN rules, punches recorded with `source: 'pos'`). It is a
terminal setting in Settings, Terminals; `POS_ENABLED=false` and revoking the
terminal stop it, and `staffing.timeclock` off stops it while App can be
reached. See [Station apps](./pos.md#station-apps-time-clock-and-host-stand).

## Runbook

**Turning a flag off (any of timeclock, scheduling, hiring, or the master).**

1. **Revoke the kiosks first** (Time clock, Tablets, remove each tablet, or
   `STAFFING_KIOSK_ENABLED=false` on the node for a whole region). Turning
   `staffing.timeclock` off alone leaves paired tablets punching.
2. Turn the flag off. The module disappears (404) on the next page load; tokens
   already minted keep working until they expire (at most 15 minutes).
3. Nothing is deleted. Turning it back on restores everything. Declined
   applicants are still purged on their retention schedule while the master flag
   is on, even if hiring was turned off.

**Deploying.**

1. Deploy **tenant-api first** and confirm **both** nodes (US Worker and Riyadh
   OCI) report the new version. A new App against an old node answers 404s.
2. Then deploy the App, then flip flags. Tenant database migrations apply lazily
   to every organization on first connection, whatever its flags, so they are
   additive and schema-only changes ship before the UI that needs them.
3. Rollback: flip flags off, revoke kiosks, set the kill switches. Data is kept.

**Symptoms.**

| Symptom                                        | Look at                                                                                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| A tablet says it is offline or refuses a PIN   | The node's `/health`; `STAFFING_KIOSK_ENABLED`; the device was revoked; a PIN backoff (30 seconds up to 5 minutes, per device, not a lock) |
| Reminders or alerts are late                   | The hourly fan-out ran; on the US node the Durable Object alarm; on Riyadh `STAFFING_TICK_INTERVAL_SECONDS`                                |
| Managers get no alert email                    | `STAFFING_EMAIL_ENABLED`; the member's notification preferences; staff email comes from tenant-api, manager email from the App             |
| A removed manager still sees Staff for minutes | Token lag (15 minutes, 5 for pay or private grants), by design                                                                             |
| Staff link, unlink or erase did not arrive     | `/resources/jobs/staffing-outbox` (retries with backoff, once a day at worst); rows hold ids only                                          |
| A region switch shows staff, time card counts  | Expected: a switch deletes the old region's staff data. Download the backup first; time cards and applicants are not in it                 |

## Rollout stages

| Stage | Who                                                            | Gate to move on                                                                                    |
| ----- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| S0    | Dogfood on the seeded demo workplace (`npm run seed:staffing`) | Two weeks of kiosk punches, security review of PIN and kiosk signed off                            |
| S1    | 3 to 5 US design partners, flags set per organization in Admin | Time to first published schedule, share of weeks published, share of cards needing manual edit     |
| S2    | Opt-in beta                                                    | A self-serve toggle that writes the organization flag (not built yet), support runbook (this page) |
| S3    | KSA pilot                                                      | The KSA checklist below                                                                            |
| S4    | Default on for new organizations                               | S1 to S3 learnings, packaging decided                                                              |

## KSA checklist

Do not enable Staff for an organization whose customer data region is `ksa`
until all of these are true:

- [ ] Counsel has reviewed retention periods and the PDPL wording (consent text
      for applicants, staff notices, the audit log).
- [ ] Email from the Riyadh node is verified end to end (OCI Email Delivery,
      sender domain, SPF and DKIM; `EMAIL_PROVIDER=oci` with the `OCI_*`
      values).
- [ ] Arabic and right-to-left QA of the kiosk, the schedule grid, timesheets
      and the careers page on real tablets and phones.
- [ ] Sunday week start confirmed (the labor rules default to Monday).
- [ ] Retention periods set (declined applicants default to 365 days).
- [ ] Backup and recovery objectives for the regional volume are documented.
- [ ] `TENANT_OPERATOR_TOKEN`, `INTERNAL_COMMAND_TOKEN`, `AUTH_HMAC_SECRET` and
      `JWT_SECRET` are set on the node and differ from the US node's.
- [ ] `STAFFING_TICK_INTERVAL_SECONDS` is set as intended on the Node runtime.
- [ ] Twilio is **not** configured on the KSA node (SMS is blocked there).
- [ ] Staff data export to the US is refused (`/internal/staff/export-user`
      answers 409 on the Riyadh node) and `Organization.dataRegion` matches.

## Demo data (local development)

`npm run seed:staffing -w tenant-api -- <org-slug>` turns on all five flags for
the organization and builds a demo workplace in its regional database: twelve
people in six positions, a published week with open shifts and a drafted next
week, a paired tablet with people on the clock, closed time cards for two weeks
(the older week approved, one 57-hour overtime week), two applicants, and
onboarding checklists for three people. It is idempotent, refuses to run in
production, and goes through the same services as the API. The steps can also be
run alone: `seed:staff`, `seed:timeclock`, `seed:schedule`,
`seed:staffing-history`. Demo PINs print once and are for local use only.

## Security checks that run in CI

- `apps/tenant-api/src/routes/staffing-security.test.ts` builds the route table
  from the routers and checks that **every** staffing route refuses a missing,
  forged or grantless token (in every scope), that every staffing mount in
  `app.ts` is covered, and that every router has cross-organization and
  cross-scope tests.
- `apps/app/app/utils/staffing/staffing-guards.test.ts` checks that every loader
  and action under `staff+/` awaits `requireStaffingAccess` (directly or through
  a verified wrapper) before anything else, and that the public pages are an
  explicit list.
- Tenant migrations and the generated Durable Object migrations are checked by
  the schema tests; `apps/tenant-api/workers/migrations.generated.ts` is
  regenerated by `npm run generate:do-migrations -w tenant-api`.

## Known gaps

- The region-switch backup file has staff, positions, pay, notes and the audit
  trail only. Time cards, shifts and applicants are counted in the warning but
  not in the file.
- Period-level close records for timesheets are not written; approval and
  locking are per card.
- Document upload for onboarding (needs a regional object store), staff
  self-service acknowledgement, and applicant messaging beyond the invitation
  and decline emails.
- Swaps that change who works a shift are not applied automatically; a manager
  decides.
- No self-serve toggle for the flags yet (S2); they are set in Admin.
- One scope per organization: the generic module has no workplace picker. See
  [Verticals](#verticals).
- Mixed-region organizations and staff who work for two organizations are
  unsupported.

## Verticals

The module never says "location", "store" or any product word. Staff work in a
**scope**: an opaque id for the part of the business they work at. Out of the
box there is exactly one, `main` (`DEFAULT_SCOPE_ID` in `@repo/staffing`), named
after the organization, with the time zone from `Organization.staffingTimeZone`.
Every picker and filter for scopes is hidden while there is one.

A vertical that has its own places (sites, branches, stores) can map scope ids
to them: return several scopes from the scope-facts route
(`/resources/staffing/scope-context`), mint Staff tokens with a `scopeIds` claim
(null means every scope) to limit a manager, and register an order source
(`apps/tenant-api/src/services/order-source.ts`) so labor percentage and the
demand guide read real orders. The rule is the same as for the phone agent, see
[phone agent verticals](./phone-agent-verticals.md): the generic core keeps
neutral vocabulary and the vertical owns the mapping and the words.

## Demand sources and standards per unit

The forecast reads a registry of demand sources
(`apps/tenant-api/src/services/demand-sources.ts`): `orders` (from the order
source) and `visits` (people booked or seated, from Reservations). Each source
has its own standard per position in
`labor_scope_settings.demand_per_labor_hour` (`{ [unit]: { [positionId]: n } }`;
`orders` is mirrored in `orders_per_labor_hour`). `computeForecastGap` works out
the need per source and sums it per position; a position with no standard for a
unit ignores that unit. The forecast response carries `sources` and per-hour
`bookedBySource`: counts only, never a guest. Registering `visits` does not
change `hasOrderSource()`, labor sales or the report catalog wording.

## Shared alarm with Reservations

The staff tick no longer owns the organization's Durable Object alarm: it is the
`staff` module of the shared scheduler `apps/tenant-api/src/lib/org-alarm.ts`,
next to the `reservations` module, so one never clobbers the other's pending
alarm (see
[scheduled jobs](./scheduled-jobs.md#shared-organization-alarm-staffing-and-reservations)).
The `visits` demand source reads Reservations bookings (counts per hour only),
and the forecast units and standards are described above. Workplaces stay opaque
**scopes** (`main` by default); reservation locations are not staffing scopes
unless a vertical maps them.
