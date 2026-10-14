# Staff module: plan

Status: built behind organization feature flags; nothing is user-visible until
its flag is on. Decisions on placement and identity are in
[ADR 047](./decisions/047-staffing-data-residency.md). Research current as of
October 2026. This plan makes no legal claims; every rule or default needs
counsel before the product asserts it. The operator guide is
[Staff module](./staffing.md).

## Goal

A "Staff" module with four parts:

- **Staff management:** roster, positions, multi-role staff, effective-dated pay
  rates, PINs.
- **Time clock and timesheets:** kiosk punches, breaks, issues, edit log,
  approve and lock, CSV export.
- **Scheduling:** week grid, copy week, publish, availability, time off.
- **Hiring and onboarding:** careers page, applicants, hire handoff, checklist.

It builds on the existing member and invitation system, but staff are not
members: an hourly worker with no email must exist without costing a billing
seat.

Not in v1: running payroll, tax forms and e-sign, job-board syndication,
background checks, AI voice screening, tip payouts, auto-scheduling, push
notifications, a staff mobile app, geofencing and photo punches.

## Design decisions everything follows from

1. **Staff are a regional entity with an optional link to a login.**
   `UserOrganization` stays the login and seat record; staff never become rows
   there.
2. **All staff, pay, schedule, punch and applicant data lives in the regional
   tenant database** behind tenant-api, for both `us` and `ksa` organizations.
   The control plane keeps only permissions, feature flags, scope grants, an
   opaque link id, an outbox and public job postings.
3. **The UI is client-rendered against tenant-api** using short-lived operator
   tokens minted by the App. No US loader joins staff names or pay.
4. **Hourly staff use a kiosk PIN on a paired tablet in v1.** Managers use their
   existing operator login.
5. **Workplaces are opaque scopes.** Staff work in a **scope**: an opaque id for
   the part of the business they work at. The generic module has exactly one per
   organization (`main`, `DEFAULT_SCOPE_ID` in `@repo/staffing`), named after
   the organization, with its time zone in `Organization.staffingTimeZone`
   (default `UTC`, edited at Staff, Time clock, Rules). Every scope picker and
   filter is hidden while there is one. A vertical with several places maps its
   own ids onto scopes (see [Verticals](#verticals)), the same way the phone
   agent core does ([phone agent verticals](./phone-agent-verticals.md)).
6. **Sales are entered by hand unless a vertical registers an order source.**
   The module keeps no orders. Labor percentage uses the daily sales a manager
   types or imports; a vertical that takes orders registers an order source
   (`apps/tenant-api/src/services/order-source.ts`) and the demand guide,
   forecast and online-order sales options light up. Every figure names its
   source.

## Architecture

### Placement

| Data                                                                        | Plane                                   |
| --------------------------------------------------------------------------- | --------------------------------------- |
| Login identity, membership, roles, permission grants, invitations, sessions | Control plane (existing)                |
| Staff permissions, `staffing.*` flags, staff time zone                      | Control plane, no PII                   |
| `JobPosting` (public content)                                               | Control plane                           |
| Staff outbox (link, unlink, erase; ids only)                                | Control plane                           |
| Staff profile, contact, positions, rates, assignments, PIN lookups          | Regional                                |
| Private fields (date of birth, address, emergency contact)                  | Regional, separate table and permission |
| Availability, time off, shifts, publications, templates                     | Regional                                |
| Punches, time entries, breaks, edit log, timesheet periods, kiosk devices   | Regional, punches append-only           |
| Labor policy (per scope)                                                    | Regional                                |
| Applicants, answers, notes, interviews, onboarding                          | Regional                                |
| Staff notification outbox, staff audit log                                  | Regional                                |
| Scope facts (id, name, time zone; one scope per organization)               | Control plane, pulled by tenant-api     |

HR-event metadata sent to the App carries only organization id, actor operator
id, action, resource type, scope id and counts, never staff ids, names, times or
pay.

### Principals

Manager (operator token) and kiosk device in v1; the schedule capability link
with scheduling; the public candidate path with hiring; linked-user and
login-less staff self-service later. PINs are looked up by HMAC with a server
secret, are unique per scope, system-generated and shown once, and failure
counters are stored in the org database. There is no hard device lockout, only
escalating backoff, so one person cannot lock out a whole team.

### Data model conventions

Tenant tables are snake_case. `*_at` columns are epoch milliseconds UTC;
`*_date` columns are `YYYY-MM-DD` in the scope timezone; durations are integer
minutes; money is integer minor units with an explicit currency; multipliers are
integer basis points. Migrations are additive only. The scope time zone and
local business date are stored on every shift, entry and punch.

Regional tables, all in the single tenant migration `0012_staffing_foundation`
(grouped here by slice):

| Migration             | Tables                                                                                                                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Staff core            | `staff_members`, `staff_private`, `staff_positions`, `staff_scope_assignments`, `staff_jobs` (effective-dated, never updated in place), `staff_notes`, `staffing_settings`, `staff_audit_log`   |
| Time clock            | `labor_policies` (one row per scope), `time_punches`, `time_entries`, `time_breaks`, `time_entry_edits`, `timesheet_periods`, `kiosk_devices`, `kiosk_pairing_codes`, `kiosk_attempts`          |
| Schedule              | `schedule_weeks`, `schedule_settings`, `shifts` (with `draft_patch`), `schedule_publications`, `schedule_links`, `shift_templates`, `staff_availability`, `time_off_requests`, `shift_requests` |
| Hiring and onboarding | `hiring_applications`, `hiring_notes`, `hiring_interviews`, `hiring_events`, `onboarding_templates`, `onboarding_template_tasks`, `onboarding_tasks`, `staff_certificates`                      |
| Operations            | `notification_outbox` (the regional outbox for staff mail and manager events)                                                                                                                   |
| Labor summary         | `labor_scope_settings`, `sales_manual_entries`, `tip_pool_settings` (`labor_daily` is derived on read)                                                                                          |

Control-plane additions: permission rows,
`OrganizationInvitation.staffMemberId`, `StaffingOutbox`, `JobPosting` and
`Organization.staffingTimeZone`. All of it is in `0018_staffing_foundation`.

Draft versus published shifts do not duplicate rows: editing a published shift
writes the proposed change to `draft_patch`, staff keep seeing the published
fields until publish, and publish applies all patches in one transaction.

Time math lives in one package (`@repo/staffing`): `computeTimecard` and
`computeWeek` are the single implementation for schedule footers, timesheets,
reports and export. Required fixtures: spring-forward and fall-back days, a
shift across midnight, a shift across the week boundary, a shift spanning two
business dates, Asia/Riyadh, America/Chicago, America/Toronto, Sunday and Monday
week starts. Overtime is always labeled an estimate.

### Permissions

Format `action:entity:access`. Wage and money fields are omitted from responses
(not hidden in the UI) without the matching grant. `update` implies `read`.
Existing custom roles receive no staffing grants.

| Permission                                           | Covers                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------ |
| `read:staff:any`, `update:staff:any`                 | Roster, profiles, assignments, PIN reset, terminate and rehire     |
| `read:staff_pay:any`, `update:staff_pay:any`         | Individual rates, wage history                                     |
| `read:staff_private:any`, `update:staff_private:any` | Date of birth, address, emergency contact                          |
| `read:schedule:any`, `update:schedule:any`           | View and edit shifts, publish, availability and time-off decisions |
| `read:schedule:own`, `create:timeclock:own`          | Own published shifts and own clock (linked users)                  |
| `read:timesheet:any`, `update:timesheet:any`         | View and edit time cards, hours export                             |
| `approve:timesheet:any`                              | Approve, lock, unlock                                              |
| `read:labor:any`                                     | Aggregate labor cost and labor percentage                          |
| `read:labor_policy:any`, `update:labor_policy:any`   | Labor policy, kiosk devices, pay periods                           |
| `read:hiring:any`, `update:hiring:any`               | Job posts, applicants, stages, interviews, hire                    |

Manager role presets (Shift manager, General manager, Hiring manager) are
editable tenant-owned custom roles, not new built-in levels. Scope limiting is
carried in tokens as `scopeIds` and applied by one helper on every list and
write route; token lifetime means a removed grant lags by up to the token TTL
(15 minutes, 5 for pay or private grants; accepted, see ADR 047 decision 13).

### Clock surfaces

The v1 kiosk is a public App route that tolerates being offline: client
generated punch ids, a local queue, retry with backoff. Server time is
authoritative; queued punches are accepted only if not in the future and within
12 hours of server time, and clock skew over 5 minutes is flagged. A personal
phone clock, the Expo staff tabs and push come later and need a staff principal
first.

### Time clock engine (built: regional data, punch engine, API)

Regional migration `0012_staffing_foundation` includes `labor_policies`,
`time_punches`, `time_entries`, `time_breaks`, `time_entry_edits`,
`timesheet_periods`, `kiosk_devices`, `kiosk_pairing_codes` and
`kiosk_attempts`. Triggers keep punches and the edit log append-only (the edit
log also refuses a blank reason), entries and breaks are voided and never
deleted, a locked entry is immutable until it is unlocked, a device never
changes scope or secret, and a pairing code is single use.

**Labor policy** is one row per scope plus an organization default row; a scope
row overrides the default, and with neither the built-in neutral values apply
(no overtime, no rounding, no break rules, approval off). Saves are optimistic
(`expectedVersion`), audited, and refused when an overtime rule makes no sense
(double time before overtime, a geofence without a radius, a break deduction
longer than the shift). `aggregate_overtime_across_scopes` has no default: it
stays null until chosen, is reported as a pending decision, and a save is
refused while people work at several scopes and it is still null. Time math
treats an unchosen value as per-scope.

**Kiosk.** A manager creates a one-time pairing code (10 minutes, stored only as
a keyed hash, at most 10 pending per scope). The tablet exchanges it at
`POST /kiosk/pair` for an opaque device secret
(`kdv1.<orgId>.<deviceId>.<random>`, stored only as a keyed hash, bound to one
scope for life, revocable at once). The org id is a plain prefix so the Durable
Object router can route it; nothing else can choose the organization. The kiosk
routes are `GET /kiosk/config`, `POST /kiosk/identify`, `POST /kiosk/punch`, and
(pick-name devices only) `GET /kiosk/people`. Responses carry a first name and a
clock state, never a surname, contact detail, pay figure or PIN.

**PIN protection.** A PIN is found by `HMAC(AUTH_HMAC_SECRET, org, scope, pin)`,
so two scopes may reuse a PIN. Failure counters are persisted per device
(`kiosk_attempts`): four typos are free, then a delay of 30, 60, 120, 240
seconds and a 5 minute ceiling. Attempts during a delay are refused without
looking at the PIN and do not extend it, so the device is never locked out as a
whole. Failures decay one per quiet five minutes rather than resetting, and a
correct PIN forgives only one, so neither waiting nor a known PIN gives an
attacker fresh guesses. Refused attempts count toward an hourly ceiling that
writes an audit alert. In optional pick-name mode a person is locked for 15
minutes after five wrong PINs, affecting only that person.

**Punch engine.** One transaction per punch: return the stored result when the
client id was seen (an id reused by another person, device or action is a
conflict), derive state from the open entry, reject impossible transitions,
apply policy, append the punch, update the entry and breaks, and recompute
cached minutes through `computeCachedMinutes` / `computeEntryIssues` in
`@repo/staffing` (which call `computeTimecard` and `computeWeek`). Server time
is authoritative; only a punch the tablet marks as queued offline may use device
time, inside the 12 hour and one minute bounds, flagged `offline_punch` and
`clock_skew`. A rejection is recorded and audited. A role pick for
multi-position staff is a prompt (`position_required`), not an event, so the
same punch id is reused. Cached minutes of neighbouring cards are refreshed when
a card closes, except approved and locked cards, which only an explicit edit or
unlock recomputes. Timesheets compute live from the same functions.

**Schedule seam.** Late grace, prevent-early and unscheduled-punch rules need
the schedule. `ShiftMatcher` in `punch-service.ts` is the seam: until scheduling
registers a real matcher it answers "schedule unavailable" and none of those
rules are judged. The schedule registers one when `/operator/schedule` loads
(see [Schedule](#schedule-built-regional-api-under-operatorschedule)); a scope
that has never published a schedule still answers "unavailable", so switching
the time clock on before scheduling does not make every punch "unscheduled". The
`missed_break`, `long_shift`, `offline_punch`, `clock_skew` and break issues do
not depend on it.

**Scope facts.** tenant-api pulls a scope's time zone and name from the App
(`/resources/staffing/scope-context`, `INTERNAL_COMMAND_TOKEN`, cached five
minutes, stale preferred to none) and falls back to the policy snapshot, then to
what the device was paired with, so a punch is never refused because the App is
slow. Kiosk authentication touches only the organization's own database, so a
tablet keeps working through an App outage on a node that serves it directly.

**Kill switch.** `STAFFING_KIOSK_ENABLED` (tenant-api env, default on).

**Durable Object caveat.** drizzle's Durable Object driver wraps only the
synchronous start of an async `transaction` callback in `transactionSync`, so
rollback of async work is not assumed on that runtime. The engine is written for
it: scope facts (the only network call) are fetched before the transaction,
every rejection is a returned value rather than an exception, and the first
write of each path is the one a conflict can reject (the open-entry and
open-break unique indexes, the punch id). Pairing claims the code before it
creates the device for the same reason.

**Not yet covered.** The region-switch summary and the staff backup export do
not yet count or include time clock tables (punches, entries, devices); the
summary extension is still open. Cached minutes on a card are refreshed when a
neighbouring card closes, not when a policy changes; timesheet views compute
live.

### Timesheets (built: regional API under `/operator/timeclock/timesheets`)

The same migration also adds `reviewed_by`, `reviewed_at` and `manager_note` to
`time_entries`, `hours_delta_minutes` to `time_entry_edits`,
`staffing_settings.pay_period_anchor`, the `notification_outbox` table, and two
more guards: the locked-card trigger now also freezes the review mark and the
note, and one person's cards can never overlap in time (an open card runs to
now). Two open cards stay the unique open-entry index's job, so the punch engine
still detects a lost race.

**Routes** (token scope `timeclock`; views need `read:timesheet:any` and
`read:staff:any` for names, edits `update:timesheet:any`, approval
`approve:timesheet:any`, pay period changes `update:labor_policy:any` with an
unrestricted scope claim):

| Route                                                        | Purpose                                                                                    |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `GET /day?date=`, `GET /period?date=\|periodStart=`          | Cards grouped by person, with totals; filters `scopeId`, `positionId`, `staffId`, `status` |
| `GET /review`                                                | Needs-review queue (live issues; cards open past the long-shift limit)                     |
| `GET /entries/:id`                                           | One card with its edit log (newest first) and accepted punches                             |
| `POST /entries`, `PATCH /entries/:id`, `DELETE /entries/:id` | Add, edit, void; the reason is required and the version is checked                         |
| `POST /entries/:id/review`                                   | "A manager looked at it": no time changes, no employee notification                        |
| `POST /approve`, `/lock`, `/unlock`, `/reopen`               | Batches of `{ id, version }`; per-card result codes; unlock and reopen need a reason       |
| `GET /summary`, `GET /export?kind=cards\|summary`            | Payroll summary; CSV text plus the data rows                                               |
| `GET /settings`, `PUT /settings`                             | Pay period type and anchor                                                                 |

**Figures are live and shared.** Every view recomputes issues, status, regular,
overtime, double time, holiday and paid minutes through `computeEntryFigures`
(the same `computeWeek` the cached columns and reports use), per person over the
cards around the viewed dates (overtime is per workweek and, by policy, across
scopes). A card belongs to the business date of its clock-in; a shift that
crosses a day, week or period boundary is split by the shared math, so a night
shift over spring-forward is one hour short and an overnight card is never
counted twice. An approved or locked card keeps its frozen columns; when the
live figures differ (a neighbouring card moved overtime) it is flagged
`figuresChanged` instead of being rewritten.

**Pay periods** are `weekly`, `biweekly`, `semimonthly` or `monthly` with an
optional anchor date (`packages/staffing/src/pay-period.ts`, pure and
tile-tested). Unanchored weekly follows the scope's workweek; unanchored
biweekly counts from a fixed Monday epoch. A semimonthly anchor day must be 1-14
and a monthly one 1-28; a stored anchor that no longer fits falls back to the
default rather than failing a view.

**Manager edits.** Required reason (not blank, not only invisible characters),
`expectedVersion`, future times refused against the server clock, a hard block
on overlap with the same person's other cards, at most 48 hours a card, breaks
inside the card and not overlapping. Times may be given as instants or as a date
with `HH:MM` start and end in the SCOPE's zone (an end not after the start rolls
to the next day; daylight-saving gaps and repeats follow `tz.ts`). Two roles in
one day are two cards: the role must be given when the person holds several at
the scope, and the rate snapshot is the role's. Breaks are paid or unpaid by the
scope's break rules for their kind (a rest break is paid and a meal unpaid
unless a rule says otherwise), never by the caller. Tips and the rate snapshot
are money: setting tips needs `read:staff_pay:any`. Every write is one
transaction that appends to `time_entry_edits` (before and after, the reason,
the change in paid minutes), queues a `time_card_edited` row in
`notification_outbox` for the employee (ids and facts, never pay; deduped on the
edit id; an edit that cuts hours is marked `reducedHours`), and writes a
regional audit row. The employee message is queued here and delivered by the
clock operations tick (see Notifications and jobs).

**Approval.** Off until the scope's `timesheetApprovalMode` is `approve` or
`approve_lock`. Approving needs a closed card without a blocking issue (open
break, missing clock-out, negative duration), freezes today's figures and counts
as a review. An approved card must be reopened before it can be edited; a locked
card is immutable (the trigger is the backstop) until it is unlocked, which
returns it to approved. Unlock and reopen need a reason and are logged and
audited per card. Stale versions are skipped with `stale_version`, never
overwritten.

**Money.** Per-person rates, pay and tips appear only for `read:staff_pay:any`
(the keys are absent otherwise, including in edit-log snapshots); the aggregate
`labor` object appears for `read:labor:any` or the pay grant. Impersonated
sessions get neither. Every figure is labeled `estimate: true`, is priced from
the card's own rate snapshot (a later raise never reprices history), and is
rounded once per person from exact units. A card without a rate is "unpriced",
not zero. A response that carries money writes one `timesheet.pay.read` audit
row; an export writes `timesheet.exported`.

**Token change.** The App token for scope `timeclock` now carries
`read:staff_pay:any` together with `read:labor:any`, only while `staffing.labor`
is on and only if the user holds the permission (5 minute lifetime, as for every
pay grant). The older rule that no non-staff scope carries a pay grant still
holds for `schedule` and `hiring`; `update:staff_pay:any` and private grants
never ride in `timeclock`.

**Export.** `buildExport` returns headers, rows and CSV text from one builder in
`@repo/staffing` (`timeCardsTable`, `payrollSummaryTable`). Cells are
neutralized against spreadsheet formulas (leading `=`, `+`, `-`, `@`, tab, CR,
and the invisible characters spreadsheets skip) in both the rows and the CSV;
the step is idempotent so the browser may rebuild the file with scope names the
regional node does not hold.

**Not yet covered.** Period-level close records (`timesheet_periods` is not
written yet); the manager alert "N time cards need review" (the clock operations
alerts cover forgotten clock-outs and automatic clock-outs, not this queue);
employee-visible history through a capability link; the region-switch summary
and staff backup still do not count time clock tables; the cross-plane audit
mirror for `timesheet.*` events (no outbox exists yet). An old `needs_review`
card is judged live at read time, so a policy change moves cards in and out of
the queue without a migration.

### Time clock screens (built: App UI, flag `staffing.timeclock`)

**Manager screens** live under Staff, Time clock (`staff+/timeclock*.tsx`), each
loader repeating the flag and permission check, all data fetched browser-direct
with a `timeclock` scope token (the staff client now sends each scope to its own
route group, `/operator/<scope>`):

- **Today** (`read:timesheet:any` and `read:staff:any`):
  `GET /operator/timeclock/today` returns names, positions and times only (no
  wage, rate or private field), limited to the token's scopes, with issues
  recomputed from the shared time math. A calm list, attention first (missing
  clock-out, late), filter chips instead of metric cards, refreshed every 30
  seconds while the tab is visible. "Late" is only judged once scheduling
  registers a shift matcher.
- **Tablets** (`read|update:labor_policy:any`): pair with a one-time code shown
  as a QR code and a link whose code is in the URL fragment, a pending-code
  list, devices with last seen and PIN-pause warnings, rename and sign-in mode,
  and a remove (revoke) behind a confirmation that says what happens. The dialog
  watches the pending list and says when the tablet connected.
- **Labor rules**: one form per scope plus an organization default (offered only
  with several scopes and full access), in plain-language groups: clocking in
  and out, schedule enforcement, breaks, overtime and pay week, rounding.
  Starter settings are offered, never applied silently (reminders, a
  non-required meal break, no overtime, no multi-scope choice). Saves send only
  the changed fields plus `expectedVersion`; the cross-field rules are mirrored
  in the browser; the multi-scope overtime question has no default and blocks a
  save until answered. The page says these are settings and estimates, not legal
  advice. Geofence, photo, schedule visibility, publish lead time, time-off cap
  and labor target stay untouched here (they belong to their own slices).

**Kiosk** is a public, client-only shell at `/kiosk` (`routes/kiosk*.tsx`),
outside the session guard. Its loader only names the two regional nodes; nothing
on the server reads a person. It talks to `/kiosk/*` on the regional node with
the paired device's secret (kept in `localStorage`, bound to one scope,
revocable at once). The pairing code travels in the fragment of
`/kiosk/pair#r=<region>&c=<code>`, is removed from the address bar before use,
and is redeemed once.

- **Screens**: a large touch PIN pad (4 to 6 digits, Western numerals in both
  languages, physical keyboard works), optional pick-name mode (paged, first
  letter filter, first name and last initial only), actions by state (Clock in,
  Start break, End break, Clock out), a role picker when clocking in with
  several positions, a cash-tip declaration at clock-out only for roles marked
  as receiving tips (`promptTips` on identify), and a first-name confirmation
  that closes after five seconds. Idle screens return to the pad (a half-typed
  PIN is forgotten after 30 seconds). Wrong PINs and backoff come back as plain,
  translated lines; the pad pauses with a visible countdown.
- **Layout**: `h-dvh`, no scrolling on a tablet or a phone; two columns in
  landscape, stacked in portrait; 44px minimum keys; high-contrast tokens only;
  reduced motion respected; English and Arabic with one tap, remembered on the
  tablet (both catalogs are fetched up front so it also works offline).
- **Offline**: the clock still opens (service worker `public/kiosk-sw.js`, scope
  `/kiosk`, caches the signed-out page shell fetched without credentials and the
  hashed build assets; it never touches the API, the app, or anything outside
  `/kiosk` and `/assets`). A punch made with no connection is saved in IndexedDB
  with its client-made id; the PIN waits with it encrypted by a non-extractable
  AES-GCM key and is deleted the moment the punch is confirmed or refused. The
  queue drains oldest first, backs off, treats a refusal as final (kept with its
  reason for a manager, PIN dropped) and a revoked device as the end of the
  line. The header always shows Online, Offline with a count, Sending, or All
  saved. Limits: offline, only the four actions are offered (state is unknown),
  and a clock-in that needs a role pick is refused at sync and listed for a
  manager.
- **Heartbeat**: every minute the tablet fetches its config, which is what makes
  "last seen" accurate, picks up a rename or a sign-in mode change, learns the
  server's clock offset (the tablet's own clock is never trusted for display or
  for a queued punch's time), and learns it was removed.

**Components**: everything is `@repo/ui` (Button, Dialog, AlertDialog, Switch,
Select, Field, Badge, ToggleGroup, Empty, Skeleton, AnnotatedSection) plus small
wrappers in `components/staff` and `components/kiosk`. No new UI library was
needed. The QR code uses `qrcode`, already a dependency of this app. IndexedDB
is a 150-line wrapper (`utils/kiosk/kiosk-queue.ts`) rather than a package: one
store and one key. `fake-indexeddb` (MIT) is a dev dependency for its tests.

**Seed**: `npm run seed:timeclock -w tenant-api -- <org-slug> [--enable]` (after
`seed:staff`) writes the default policy, PINs for six demo people (printed once,
local development only), a paired demo tablet and today's punches (clocked in,
on a break, one never clocked out, one gone home), and prints a fresh pairing
link. It refuses unless `staffing.enabled` and `staffing.timeclock` are on.

**Not covered yet**: offline names in pick-name mode beyond the last list
loaded; a cash-tip currency symbol on the kiosk (the amount is entered in the
scope's two-decimal currency without a symbol). The kiosk Playwright specs
(`tests/e2e/staff-timeclock.test.ts`) run against any dev server; the manager
specs in the same file need the sign-in fixture, whose database must be the one
the running app reads (the Workers dev server uses local D1, the fixture writes
the LibSQL file), so run them against the `CI=true` mocked build.

### Timesheet screens (built: App UI, flag `staffing.timeclock`)

`Staff, Time clock, Timesheets` (`staff+/timeclock.timesheets*.tsx`). Needs
`read:timesheet:any` and `read:staff:any` (names come from the roster); every
loader repeats the flag and both grants (`requireTimesheetsAccess`), and the
parent loader never reruns on a filter change because nothing on the screen is
read by the App. All figures come browser-direct from
`/operator/timeclock/timesheets` with a `timeclock` token. The loader only names
the scopes (id, name, time zone) and says whether the pay period may be changed
(organization-wide, so never for a scope-limited manager).

- **Views** (one segmented control, all in the address bar so a view can be sent
  to a colleague; the search box is the exception, because a typed name must not
  ride in a URL the US app server sees, so it lives in the screen's state):
  **Day**, **Pay period**, **Needs review** (with a count) and **Summary**.
  Scope, position and status filters are asked of the node (so totals and
  overtime stay right); the search box filters the people already on screen.
  Group by person, date or position.
- **List**: a dense table with a sticky header, tabular decimal hours, a total
  row, overtime as words ("OT 1.50", tinted, never color alone), status badges
  and issue chips (review issues first, the rest folded into "+N"), and "Figures
  changed" on an approved card whose live figures moved. Below 720px of
  available width (the room beside the sidebar, not the window) it becomes
  stacked cards with the same facts. Estimated pay shows only when the token
  carries `read:staff_pay:any`; a card with no rate says "No rate" instead of
  zero. Everything that sums overtime or pay says it is an estimate.
- **Needs review**: oldest first, filterable by issue, each row says what is
  wrong in one line. A missing clock-out is fixed in the row (type the time, see
  the resolved date, Enter), saved with the reason "Forgot to clock out". A soft
  issue (missed break, long shift) is cleared with one press of "Looks right" (a
  review mark, no time changes); "Mark N as reviewed" does them all. Anything
  that needs real editing opens the card. Nothing that would change hours is
  ever one click without a visible time.
- **Card sheet** (`/timesheets/:id` and `/timesheets/new`, a sheet over the
  list, linkable on its own): date, clock in and out typed as times of day in
  the scope's zone (the form says which zone, shows the shift length and "Ends
  the next day"), breaks (meal unpaid, rest paid, decided by the scope's rules),
  tips (pay grant only), note, and a required reason with one-tap starters. Only
  changed fields are sent, with `expectedVersion`; the form mirrors the server's
  checks (future times against the server clock, overlap of breaks, break inside
  the shift) and the server still judges overlap with other cards. A stale
  version says so in plain words and keeps the form. History is a timeline of
  who (a manager or the time clock), when, why, what changed and the effect on
  paid hours, with the punches as recorded underneath. Approved cards are
  read-only with "Reopen"; locked ones with "Unlock"; both ask for a reason.
  Delete asks for a reason too.
- **Approve and lock**: only offered where the scope's rules turn them on (read
  from `GET /policies` when the viewer may read labor rules; otherwise the
  buttons show and the server answers per card). "Approve N ready cards" takes
  closed cards with no problem, after a confirmation that says hours are frozen;
  ticking cards gives a bar that offers exactly what the ticked cards can take
  ("Approve (4)", "Lock (1)", "Reopen (2)") in batches of 200 with a per-card
  outcome, so a stale or broken card is skipped and named, never overwritten.
- **Pay period**: previous and next come from the node (it knows the cadence and
  the workweek); a calendar picks any date and shows the period around it; the
  gear (organization-wide managers only) sets weekly, every two weeks, twice a
  month or monthly and the start date, with the same anchor rules as the server.
- **Summary and export**: per-person hours with a column picker (remembered in
  this browser only; names cannot be hidden; money columns exist only with the
  pay grant), a "ready for payroll" line and a link to the queue. Export calls
  `GET /export` (which writes the audit row) and the browser rebuilds the file
  from the table: scope names instead of ids, only the picked summary columns,
  every cell through the shared formula-safe `toCsv`. Headers stay in English so
  a payroll tool can map them.

**Components.** `@repo/ui` first: Sheet, Dialog, AlertDialog, Popover, Command,
Calendar, Checkbox, Select, ToggleGroup, Badge, Empty, Skeleton, Table parts.
The package already contained a `Calendar` (react-day-picker, already a
dependency) but did not export it; `@repo/ui/calendar` is now exported, with no
change to the component. The table keeps the design system's `TableRow`,
`TableHead` and `TableCell`, inside a plain `thead` that is sticky (the lint
contract forbids restyling those parts, and `Table` wraps its table in an
overflow container that breaks a sticky header). TanStack Table was already a
dependency of this app and was **not** needed: the list is grouped, not sorted
or paged, and a view is capped at 2,000 cards by the node, so virtualization was
not warranted. Times and dates use the native `time` and `date` inputs (value
format equals the API's `HH:MM` and `YYYY-MM-DD`, segment typing and pickers
come with the platform, they follow the page direction); the person search is
`Command` in a `Popover`, searched on the server. No new dependency.

**Not covered yet**: the employee is told about an edit by email through the
clock operations tick (below) only when they have an address on file, and the
screens do not promise it; the capability link for an employee's own history;
period-close records (`timesheet_periods`); a day-range CSV export (the node
exports by pay period); keyboard shortcuts for moving between days. The
Playwright spec `tests/e2e/staff-timesheets.test.ts` stubs the regional node in
the browser like the other manager specs and needs the `CI=true` mocked build.

### Notifications and jobs

The App owns notifications to operators; tenant-api owns notifications to staff.
No staff content crosses planes. Staff email goes through `sendTenantEmail`
without a marketing context. There is no SMS for KSA and none in v1.

### Clock operations (built: regional tick, alerts, outbox delivery)

One idempotent function, `runStaffTickForOrg`
(`apps/tenant-api/src/services/staff-tick-service.ts`), is driven by the hourly
cron fan-out (`POST /api/staff/tick`, copied from the engagement sync, **no new
cron slot**) and, between hours, by runtime-native timers: a Durable Object
alarm per organization on the US Worker runtime and an in-process interval on
the OCI node. With nothing else running the granularity is **hourly**, so
reminders, an automatic clock-out and alerts can lag up to an hour, and the
policy screen says so. See [scheduled jobs](scheduled-jobs.md#staff-tick) for
the timers and ADR 047 decision 14 for the reasoning.

**What a tick does**, behind the organization's `staffing.*` flags (read from
the App, fail closed): close forgotten entries when the policy sets an automatic
clock-out (off by default; guarded update, flagged `auto_clock_out`, needs
review, edit-log and audit rows, break closed at the same instant); remind the
person and tell managers about a missed clock-out; tell managers when someone is
close to or past an overtime threshold (measured with the shared time math);
alert managers when a scheduled person has not clocked in; email people before a
shift; deliver the outbox; purge finished rows after 30 days. A task that throws
is isolated from the others. `registerStaffTickTask` is the hook later slices
use (onboarding reminders); a hook runs behind its own flag, after the built-in
tasks.

**Policy settings** (in the same migration, per scope with the organization
default as fallback, each off with `null`): no clock-in alert (15 minutes after
the shift starts), pre-shift reminder (4 hours ahead), overtime warning (60
minutes short of a threshold). The existing missed clock-out reminder and
automatic clock-out settings are used as they are.

**Deviation from the wording of the earlier policy fields.** The reminder and
the automatic clock-out were described as measured "after clock-in when no shift
matched". With no schedule yet that is every entry, so a 30 minute reminder
would fire 30 minutes after everyone starts. An unscheduled entry is measured
from the long-shift threshold instead (`expectedEntryEnd` in `@repo/staffing`);
a scheduled one from its shift end. The automatic clock-out records the expected
end (the shift end, else the long-shift mark), never earlier than an open break
began.

**Schedule seam.** The no clock-in alert and the pre-shift reminder are written
against `schedule-seam.ts` and report `schedule_unavailable` until a lister is
registered (`registerShiftLister`). The schedule registers `listPublishedShifts`
(published shifts of people still on the roster, and "unavailable" until some
scope has published) next to the shift matcher; both are in
`schedule-registry.ts`. The tick tests still use a fake schedule; the registry
has its own tests, including one through the kiosk. The missed clock-out
reminder uses the shift matcher the punch engine already has.

**Staff email** is rendered as plain hex-color HTML (no React, no CSS
variables), in English or Arabic by the person's locale, at content level `full`
(names the place and times) or `minimal` (the KSA default: a generic line).
Messages queue in the regional `notification_outbox` under a unique `dedupe_key`
(`shift_reminder:{shiftId}:{staffId}`, `missed_clock_out_reminder:{entryId}`,
...), retry with backoff (5 minutes doubling to 6 hours, 8 attempts), and are
dropped when stale (a shift reminder after the shift began, anything older than
a day). It also delivers the time-card-edited notice queued by the timesheets.
`STAFFING_EMAIL_ENABLED=false` drops them instead of holding them.

**Manager alerts** cross as one generic event (organization id, kind, scope id,
count, event id; strict schema) to `POST /resources/staffing/notify`, which
resolves recipients by `read:timesheet:any` (a stronger grant counts) and scope,
applies the member's notification preference (two new workflows,
`staffing-attendance-workflow` and `staffing-overtime-workflow`, default in-app
and email on), writes an in-app notification holding only the kind, scope id and
count, and sends the email (`StaffingAlertEmail` in `@repo/email`). The event id
comes from the outbox rows it covers, so a retry repeats nothing. The
notification settings show the two toggles only to members who can receive them,
and the bell links the notification to the Time clock screen that can act on it.

**Not covered yet**: manager alert email is English only (like the other App
notification emails); certificate expiry and retention tasks from the plan;
fan-out to only the organizations that use staffing (every Durable Object is
woken hourly and answers with one local query when it has no staff, which is
fine at today's organization counts); the Durable Object alarm has been
exercised only against a storage fake, not on a deployed object.

### Schedule (built: regional API under `/operator/schedule`)

The schedule API is the manager side of scheduling: the week grid, shifts, copy
week, templates, "recommend a schedule", publishing, the demand guide, time off,
availability and swap, cover and drop approvals. It is reached browser-direct
with an App-minted token of scope `schedule`, which the App mints only while
`staffing.scheduling` is on; tenant-api trusts the token (grants, `scopeIds`)
and does no flag lookup. Views need `read:schedule:any` and `read:staff:any`
(the grid names people); writes need `update:schedule:any` (decisions on time
off, availability and requests included). The schema is part of
`0012_staffing_foundation`; the pure domain (wall-clock placement, conflicts,
copy and recommend planning, demand and estimate math, the stable error codes)
lives in `@repo/staffing` (`schedule-*.ts`), the services and routes in
tenant-api (`services/schedule-*.ts`, `routes/schedule.ts`).

**Routes.** `GET /week` (people, shifts, overlays, footers, totals, labor
target), `GET /demand`, `GET|PUT /settings`; `POST /shifts` (several dates at
once, several shifts a day, overnight), `PATCH|DELETE /shifts/:id`,
`POST /shifts/:id/assign|unassign|revert`; `POST /copy`, `GET|POST /templates`,
`POST /templates/:id/apply`, `DELETE /templates/:id`; `POST /recommend`;
`POST /publish`, `GET /publications`; `GET|POST /time-off`,
`POST /time-off/:id/decision|cancel`; `GET|POST /availability`,
`POST /availability/decision`, `POST /availability/:id/cancel`;
`GET|POST /requests`, `POST /requests/:id/decision|cancel`.

**Times.** A shift is entered, copied and templated as wall-clock times in the
scope time zone and stored as UTC instants with the zone and local date. An end
at or before the start is the next day; copying keeps 09:00 at 09:00 across a
clock change, and a night shift over a change is one hour shorter or longer by
real time. The week starts on the scope's labor-policy week start (Sunday and
Monday are both tested) and any date snaps to it. A shift belongs to the week it
starts in; minutes after midnight count on the next day in the footers,
including in the following week's footer. The time zone comes from the control
plane scope facts, else the policy, else an earlier shift; with none the scope
answers `time_zone_unknown` (409) instead of guessing.

**Draft versus published.** A new shift is a draft. Editing a published shift
writes the change to `draft_patch` and leaves the published fields alone, so
staff keep seeing what was published; removing one marks it `cancel_pending`.
The unpublished count is drafts plus patched shifts. Publishing is one
transaction: drafts go live, patches are applied, removals cancel, the week's
counter goes up, and one append-only `schedule_publications` row records the
counts and the ids of the shifts that changed (never names, times or pay). A
draft assigned to someone who has since left is published as an open shift.
Publishing nothing is refused (`nothing_to_publish`) unless the notify mode is
`everyone` on a week that has published shifts. Every shift write is guarded by
the shift's `version` (`stale_shift` with the current version) and publishing by
the week version (`stale_week`). Telling people happens in the same transaction
(see "Publishing and my schedule" below).

**Conflicts are warnings.** Each shift comes back with `overlap`, `time_off`,
`unavailable`, `overtime`, `min_rest`, `position_mismatch`, `not_at_scope` and
`staff_on_leave` entries (stable codes, numbers only). Only approved time off
and availability count; a pending request does not. A one-off availability row
replaces the weekday's weekly rows for its date; a person with "available"
windows that day can work only inside them. Overtime comes from the same
`computeWeek` as the timesheets, under the scope's labor policy (no rounding,
the shift's own unpaid break). Minimum rest (an organization setting, 8 hours by
default, 0 turns it off) compares shifts on different local dates, so a split
shift is not a short night. Shifts at scopes the token cannot see do not take
part in a scoped manager's warnings.

**Copy, templates, recommend.** Copy and templates take a scope (all, positions,
people; open shifts only with `all` and `positions`); results are drafts, exact
duplicates are skipped so repeating does nothing, and shifts of people who have
left become open shifts. "Recommend a schedule" is deterministic: the base week
moves to the target week, each person keeps a shift unless approved time off,
approved availability, an overlap, their roster status or a missing pay row says
otherwise, and those shifts go out open with a reason code. Overtime and rest
stay warnings. `apply: false` only proposes. A week holds at most 2500 shifts
(`week_full`).

**Time off, availability, requests.** A manager entering one is final
(`manager_entered`, approved at once); `staff_request` records a request the
person made and it waits for a decision (staff cannot sign in to submit these
themselves yet). Short notice (an organization setting) and a full day (the
labor policy's per-day limit) come back as warnings on pending time off and
never refuse. A person's submitted weekly pattern replaces the earlier approved
one when it is approved (the older rows become `superseded`); a manager can
choose `replaceWeekly` or add to the pattern. Swap, cover and drop requests are
approved by changing the shift through the same draft mechanics, so staff see
nothing until publish; a request that no longer matches the schedule is refused
as `request_stale`. One request may be open per shift.

**Demand guide.** Reads counted orders by weekday and local hour over the
trailing 8 weeks through the registered order source
(`services/order-source.ts`, `loadBuckets`), for the scope. The generic module
has no source, so the guide is empty and says so; a vertical that takes orders
registers one. It is labeled a guide: orders are not necessarily all of a
business's sales, and a future week is guided by the most recent real weeks.
Sales (and the week's labor percentage against the scope's labor target, per
currency, never added across currencies) need `read:labor:any`.

**Money.** A shift's estimated cost and a person's week cost need
`read:staff_pay:any`; the day footers' cost, the totals and the labor target
need `read:labor:any` (or the pay grant). Without them the keys are absent from
the response, including from write responses. Impersonated sessions never get
either.

**Local data.** `npm run seed:schedule -w tenant-api -- <org-slug> [--enable]`
(after `seed:staff`) publishes the current week with one pending edit and copies
the next week as drafts, with time off and availability, through the same
service functions as the API.

**Not covered yet** (later slices): the events row, and approving swaps that
change who works a shift automatically. Per-day time-off limits are warnings
only, not holds. Telling staff, the "my schedule" link and staff requests are in
the next section. The manager screens follow it.

### Publishing and my schedule (built: flag `staffing.scheduling`)

Publishing can tell people. The schema (`schedule_links`, a `notification`
column on `schedule_publications`, a per-device `show_next_shifts` flag); the
pure parts (recipients, dedupe keys, link token format, self-service schemas,
error codes) are in `@repo/staffing/schedule-publish.ts`.

**Notify modes.** `POST /publish` takes `notifyMode`: `everyone` (everyone with
a live published shift in the week), `changed` (only people whose own shifts
were added, changed, moved away or cancelled; the default) or `nobody`. The
recipients, and anyone who could not be reached (`no_email`, `inactive`,
`email_disabled`), are recorded in the publication row in the same transaction
as the publish, so a manager can always see who was not told. The queued
`notification_outbox` row carries the publication id, week, scope and the
person's own shift ids, never a name, time or pay.

**The email.** The regional tick sends it (`staff-tick-service`), honoring the
`STAFFING_EMAIL_ENABLED` kill switch. The text is built at send time from the
live schedule and selects only the recipient's own published shifts, so a late
or repeated message can never state an old time and can never mention anyone
else. It is a plain template in English or Arabic (the person's locale). On the
KSA node the content level is `minimal`: one generic line that there is an
update and a link, with no place or times. Without an email address, or when the
node does not know the App address, the message has no link and says so.

**The link.** One live link per person (`schedule_links`), read-only, valid 90
days and extended by each new email. The token is derived with an HMAC from
`AUTH_HMAC_SECRET` over the organization, link and person (so the same email can
be resent without storing the plaintext) and only a second keyed hash is stored.
It travels in the URL fragment (`/my-schedule#r=<region>&t=<token>`), so no
server, log or referrer sees it. There is no endpoint that requests a link: it
exists only inside the email. A manager sees its status on the staff member's
Access tab (live, last opened, lapses) and can turn it off; the next schedule
email then creates a new one. Rotating `AUTH_HMAC_SECRET` revokes every link. A
link stops working when the person leaves, when the link is revoked or expired,
and while scheduling is off.

**Public API (`/schedule-link`, the browser calls it directly).** Authenticated
by the bearer token alone, never by an operator token; responses are `no-store`
and tell the browser to send no referrer. `GET /me` (own published shifts around
today, bounded to 62 days; never drafts, pending edits, cancelled or open
shifts; no pay), `GET /me/time-cards` (own cards with their edit history, no
money, no manager notes or review state), `GET /me/requests`,
`POST /me/time-off` and `POST /me/availability` (recorded as requests that wait
for a manager, never final), `POST /me/shift-requests` for swap, cover and drop
(each request has a `/:id/cancel`), and `GET /me/teammates` (first name and last
initial, only where the scope lets the team see the schedule). Writes are rate
limited per link and a person can have at most 10 open requests. A person's
audit rows use the `staff_link` actor kind.

**My schedule page.** `/my-schedule` (`routes/my-schedule.tsx`,
`components/my-schedule`) is a client-rendered page outside the signed-in app,
like the time clock: no cookies, no analytics, `noindex`. It lists the person's
published shifts by day, their time cards with edit history, and lets them ask
for time off, send availability and ask for a swap, cover or drop. It is
available in English and Arabic (RTL) and runs fine at 360px.

**Manager screens.** The publish dialog shows a summary (period, shifts, hours,
estimated labor cost with `labor`, conflicts) and the notify mode with a count
of who will be told and who cannot be reached. "Publish history" lists every
publication with its counts, notify mode, the "Not notified" list (people
without an email address) and who was sent, failed or skipped, with "Resend to
people not yet reached" and "Resend to everyone" (a five-minute cooldown per
publication; a queued message that is too old to be useful is skipped as
`stale`). A change to a published shift after publishing is written to the
regional audit log with the fields touched and the shift state, and counts as
unpublished until the next publish. When a schedule is published, managers with
the `schedule_published` notification preference get one in-app alert that
carries only counts (see "Clock operations").

**Kiosk next shifts.** Opt-in per tablet on the Tablets screen. After someone
enters their PIN, the kiosk briefly shows only that person's next published
shifts at that scope.

**Print.** The schedule prints from "Print this view" (see the screens below).

### Schedule screens (built: App UI, flag `staffing.scheduling`)

Routes under `/:orgSlug/staff/schedule`: the schedule itself (`_index`),
`time-off` and `availability`. Each loader repeats the flag and the permission
check (`schedule-access.server.ts`: `read:schedule:any` plus `read:staff:any`)
and hands the screen only scope names and time zones; every shift, person,
request and figure is fetched from the regional node by the browser with a
`schedule` token, a week at a time (the month view makes one request per week it
touches). Names for time off and availability come from the staff scope's
roster, kept in the tab's memory only (`use-staff-directory.ts`).

- **Views.** Week grid (people by days, grouped by position or not grouped, an
  open-shifts row, per-day hours, headcount and open shifts, and estimated cost
  when the labor grant is held), day timeline (people by hours), month overview
  (people, hours and open shifts per day, each day opens in the day view), and
  on a phone (under about 760px of room) a one-day list with a strip of the
  week's days. The demand strip sits above the grid when an order source is
  registered (a guide from past orders, not a forecast, and not all of a
  business's sales).
- **What a shift says.** Drafts are dashed outlines, published shifts a soft
  tint of the position color (`positionBlockClass` in `@repo/ui/position-color`,
  theme tokens only), edits not yet published carry a dot, removals not yet
  published are struck through, overnight shifts show "+1". Conflicts are red
  flags with words (never blocking) and the "Show conflicts" switch hides them
  for a quiet or print-ready grid. State is never carried by color alone: every
  block has a spoken label ("Draft, 9 AM to 5 PM, Server, 7h 30m, 1 warning,
  ...").
- **Editing.** A sheet (bottom sheet on a phone) with person (open shift or
  anyone), position, times in 15-minute steps, unpaid break, notes, "repeat on"
  day chips, split shift, and for an existing shift ranked suggestions for who
  could take it (`rankBackfill`: explicitly available first, then no preference,
  fewest hours this week first, near-overtime last, blocked people flagged at
  the end). Warnings show and never stop a save. A stale shift or week reloads
  and says so in plain words.
- **Moving.** `@dnd-kit/core` (already a dependency of the app): pointer, touch
  (press and hold) and keyboard sensors. Keyboard: Enter opens the editor, Space
  lifts a shift, the arrow keys choose the cell (or, on the day timeline, slide
  in time), Space drops, Escape cancels, with spoken announcements. Resize: drag
  either end on the day timeline, or Shift plus arrow keys (Alt for the start)
  in every view. Copy and paste: Ctrl or Cmd plus C and V, a paste button on
  each cell while something is copied, and "Repeat on other days" in the editor
  for touch and screen readers.
- **Planning.** Copy week (from another week into this one or this one
  elsewhere; everything, some positions or some people; open shifts included or
  not), templates (save a week, add a template to a week, keep or drop who
  works), and an empty-week jumpstart: copy a past week, use a template or
  "recommend a schedule" (previewed first, written only on Apply, with the
  reason each opened shift lost its person).
- **Publishing.** A sticky bar "Publish (N)" when anything is unpublished; the
  dialog counts new, changed and removed shifts, mentions warnings, and lets the
  manager choose who hears about it. It sends the week version it saw, so a
  stale publish is refused and the week reloads.
- **Time off and availability.** Queues (waiting, upcoming or in force,
  declined) with approve and decline (optional note), recording on someone's
  behalf (approved at once), and swap, cover and drop requests on the time-off
  page. Availability decisions are made per person for all of their waiting
  rows.
- **Print.** "Print this view" prints the region marked `data-print-root`, on a
  landscape page, without the app shell (the rule in `styles/tailwind.css` only
  applies on pages that have such a region), with a heading of scope and period.
- **Components.** `@repo/ui` first: Sheet, Dialog, AlertDialog, Tabs,
  ToggleGroup, Calendar (react-day-picker, for the date and the date range
  pickers), Select, Switch, Checkbox, RadioGroup, Empty. No new dependency was
  needed. The grid is a real `<table>` (row and column headers, a sticky name
  column that follows the reading direction); it is not virtualized: a week is
  capped at 2,500 shifts by the API and cells are memoized, so measure before
  adding it.

### Labor summary, sales and tips (built: flag `staffing.labor`)

Regional API under `/operator/labor` (token scope `labor`, minted only while
`staffing.labor` is on; `GET /:orgSlug/staff/token?scope=labor`), the Labor
screen at `/:orgSlug/staff/labor`, and two additions to the schedule. Nothing
here crosses to the control plane: wages, sales, tips and shares stay in the
regional database and are read browser-direct.

**Data.** `labor_scope_settings` (per scope: sales source and the
orders-per-labor-hour standard of each position), `sales_manual_entries` (one
row per scope and business date: net sales in minor units, explicit currency,
`manual` or `csv`, an optional note) and `tip_pool_settings` (per scope: split
basis, cadence, card fee in basis points, which fulfillment types join the pool,
position percentages). `labor_daily` is not stored: it is derived on read from
time cards (priced by the same `computeEntryFigures` the timesheets use, so
overtime and rate snapshots cannot disagree with payroll figures) and sales, one
row per scope and business day. Pure functions live in `@repo/staffing`
(`labor-summary`, `tip-pool`, `forecast-gap`, `sales-csv`, `labor-api`) and
carry the unit tests, including a hand-calculated week.

**Sales source (decision 8, recommended default).** Each scope chooses `manual`
(daily net sales typed in or uploaded; the default, and the only meaningful
choice without an order source), `online_orders` (counted orders from the
registered order source: live and, for online payment, paid; net sales are the
order subtotal) or `online_only` (the same orders, and the scope says they are
all of its sales). With `manual`, orders are not added on top, so nothing is
counted twice. Rules that hold on every surface:

- The source is named wherever a labor percentage appears: the Labor overview,
  its CSV export (a "Sales source" column on every row) and the schedule footer.
- A share is only marked "within" or "over" a target when the sales cover
  everything the scope sells (`manual` or `online_only`). The server omits the
  status otherwise and the screens also refuse to compute one, so with orders
  alone the share is shown with a plain note that sales made any other way are
  missing and the target is "not applied".
- A share over a range is a ratio of sums over the days that have sales, never
  an average of daily shares. A day with no manual entry is "not entered", not
  zero, and is left out of the share.
- Money is never added across currencies. Cost and sales are kept per currency;
  wages in a currency with no sales in that currency have no share and are
  listed as a mismatch ("shown separately and left out of the share"), never
  converted.
- Cost is rounded once per currency from exact cost units. Hours and cost are
  attributed to the card's business date (the scope's workday rule), and orders
  are bucketed into 15-minute buckets and then into the same business dates.

**Entering sales.** `PUT /sales` saves one day, `POST /sales/bulk` imports up to
a year of days in one transaction (created, updated and unchanged days are
counted), `DELETE /sales` removes a day. A day that has not happened yet (by the
business-day rule) is refused. The browser reads a pasted or chosen CSV with the
shared parser (`parseSalesCsv`): a Date and a Net sales column (English or
Arabic header names), exact decimal text (`1,234.50` and `1.234,50` both read as
123450 minor units, never floats), ISO dates or month-first or day-first on
request, Arabic-Indic digits, a preview, and every unreadable line named with a
stable code. Only readable days are sent; tenant-api never parses free text.

**Labor percentage on the schedule.** The week view's `laborTarget` now carries
the sales source, whether the sales are complete, whether a target may be
judged, and the guide sales of each day. For `manual` the guide is the median of
the entered sales of the same weekday over the trailing eight weeks (days nobody
entered are unknown, not zero); otherwise it is the existing orders guide. The
footer shows a "Labor share of typical sales" row with the source under its
label, and a sentence that says what online-only sales leave out.

**Forecast against the schedule (decision: ours, deterministic; needs an order
source).** `GET /operator/schedule/forecast?scopeId&date` (needs
`read:schedule:any` and `read:labor:any`, so it is behind the flag) compares
expected orders with the scheduled people hour by hour. Expected orders of a
weekday and local hour are the median counted online orders over the trailing
eight weeks (the same guide as the demand strip), never fewer than the paid,
active orders already booked for that hour (`scheduledFor`, future only). The
manager sets, per position, how many orders one person handles in an hour; an
hour needs `ceil(orders / standard)` people in that position. Scheduled people
are counted by real time inside each local hour (15-minute steps, so a
daylight-saving day holds the right number of hours; unpaid breaks are spread
over the shift). Each position is compared on its own, so a surplus of cooks
never hides a shortage of cashiers. An hour is "short" at half a person or more
short, "over" at a whole person over with nothing short. Drafts count; open
shifts and shifts with no position do not. It carries no names and no money. The
schedule shows it as a coverage strip under the demand strip (colored cells plus
the day's short and over hours in words) and says so when no standard is set
yet. The method is our own design; no outside method was copied.

**Tip-pool report (decision 20, recommended default: report only).** A report
and a CSV export, never a payout. The pool of a scope and range is the tips on
counted online orders of the chosen fulfillment types (pickup only by default;
delivery tips often belong to the driver and stay out until chosen), less a card
fee percentage withheld from those online tips only, plus the cash tips people
declared on their time cards. Only closed cards worked under a tip-eligible pay
row join the split; open cards are left out and surfaced, and unapproved cards
are counted so a manager knows the hours could still change. The split is by
paid hours, or by position percentage (re-scaled over the positions that worked,
then by hours inside each position), for the whole range or each day on its own.
Shares are whole minor units by largest remainder, so they add up to the pool to
the last cent and the same inputs always give the same shares. A pool nobody
eligible can share stays "not allocated" rather than disappearing. Pools of
different currencies are separate. The report names people and amounts, so it
needs `read:staff_pay:any` and `read:staff:any` besides `read:labor:any`, and it
writes a `labor.tips.read` pay-sensitivity audit row (the export a
`labor.exported` one).

**Permissions.** `read:labor:any` for every `/operator/labor` route (a pay grant
alone does not open the section; impersonated sessions are refused by the
services because they never see wages). Daily sales writes need
`update:timesheet:any`; sales source, standards and tip rules need
`update:labor_policy:any` (tip rules also the pay grant). A scope outside the
token's scope answers 404 on reads and 403 on writes that name it. Settings and
sales writes write `staff_audit_log` rows (counts and amounts, never names).

**Screens.** Overview (a quiet row of figures per currency with the sales source
stated beside the share, then one row per day; stacked rows on a phone), Sales
(one amount box per day with the cursor where the manager types, save on Enter,
an import dialog with preview), Tips (pool lines, shares, rules dialog, export)
and Settings (sales source, orders per labor hour per position). Built from
`@repo/ui` only (ToggleGroup, Select, RadioGroup, Checkbox, Dialog, Input,
Table, Empty, Skeleton); no new dependency was needed. Everything reads and
writes through the `labor` client scope and the address bar holds only the view,
scope and range.

### Reports and labor cost (built: `packages/reports`, subjects loaded in tenant-api)

Four regional report subjects sit next to orders in the Reports screens and are
loaded by tenant-api (`services/staffing-report-records.ts`) from the same
functions the screens use, so a report and the screen it summarises agree to the
cent (`buildLiveCards` for time cards, `computeLaborSummary` for labor days; the
route test checks the hand-calculated week against the labor suite's 20.09%).

| Subject        | One row per                      | Needs (token subject, App flag, permission)                     |
| -------------- | -------------------------------- | --------------------------------------------------------------- |
| `time_entries` | time card                        | `staffing.timeclock`, `read:timesheet:any` and `read:staff:any` |
| `shifts`       | scheduled shift (open ones too)  | `staffing.scheduling`, `read:schedule:any` and `read:staff:any` |
| `labor_daily`  | scope and business day           | `staffing.labor`, `read:labor:any`                              |
| `applications` | job application                  | `staffing.hiring`, `read:hiring:any`                            |
| `staff_pay`    | not a subject, a permission mark | `staffing.labor`, `read:staff_pay:any`, with `time_entries`     |

- **Where access is decided.** The App decides (flags, permissions, scope scope)
  when it mints the reports token (`reports+/token.ts`,
  `utils/staffing/report-access.server.ts`) and lists the granted subjects in
  the token. All five names are in `RESTRICTED_REPORT_SUBJECTS`. tenant-api
  trusts the token, checks the subject and every field's `requiresSubject`, and
  applies the token's `scopeIds` on every query (`scopeToScopes`). A token that
  lists a staff subject cannot be minted without a scope claim, and a token
  without the claim means no scopes. An impersonated session gets none of them.
  A token with `staff_pay` lives 5 minutes, enforced on verify as well as at
  mint.
- **What a person sees.** The Reports loaders (`_index`, `new`, `$reportId` and
  their actions) filter the catalog, templates and saved reports with
  `catalogForGrants` / `definitionAllowed`: without the flag or permission the
  staff subjects, their templates and the `cost` field do not exist for that
  person (a saved report on one is a 404). The regional API enforces the same
  grants on every run.
- **Wages.** `time_entries.cost` names `staff_pay` in `requiresSubject`, so one
  person's wages need `read:staff_pay:any`. `labor_daily` holds scope totals and
  needs only `read:labor:any`; the template "Labor by position" therefore needs
  the pay permission and is hidden without it.
- **Engine.** `resolveTimeframeRange` and all day, week and month buckets use an
  IANA zone (UTC unless given; the runner sends the viewer's zone, the report's
  setting can pin UTC or a named zone). Subjects carry `timeZoneField`: staff
  records cut days in their scope's zone, so "today" and a labor day are the
  scope's own, across DST (tests: spring forward, fall back). Loaders read a
  window padded by 14 hours (`timeframeLoadWindow`) and the engine makes the
  exact cut. A `day` bucket was added. A `duration` field type holds minutes.
  The `ratio` measure divides the sums of two fields over the whole group, never
  an average of per-record shares; records missing either side are left out and
  counted (`valueInfo.excluded`, surfaced as a notice), a result whose records
  are in more than one currency has no value, and the share carries its caveat
  (wages are estimates; sales depend on the scope's sales source). `labor_daily`
  rows are cut per scope and day; wages in another currency from the day's sales
  set `currencyMismatch` and leave the day out of shares.
- **Templates** (Labor and Hiring categories): labor cost percent (total, by
  day, by scope), sales per labor hour, hours by employee and by day, overtime
  hours by week and by employee, scheduled vs actual hours and clock-ins,
  on-time arrival, late arrivals by employee, labor by position, tip pool
  (online-order tips by day) and the applicant funnel and applications by
  source. Titles and descriptions are translated (`ui/report-labels.ts`);
  `packages/reports/src/ui` is in the App and Admin Lingui includes (the rest of
  the Reports screens remain English-only, as before).
- **Audit.** Every run over a staff subject writes one `report.run` row to the
  regional audit log (subject and row count only, `pay` sensitivity when the
  token holds `staff_pay`); a run that cannot be recorded returns nothing.
- **Deferred.** Per-person tip-pool allocation as a report subject (the Labor
  page's tip report does the split); the applicants-by-person view (the funnel
  report reads stage, job, scope, source and days to decision only);
  point-of-sale sales ingestion beyond a vertical's order source; translating
  the rest of the Reports builder.

### Job postings and careers pages (built: flag `staffing.hiring`)

A posting is **public content with no person data**, so it lives in the control
plane (ADR 047, decision 8) as `JobPosting` (control-plane migration
`0018_staffing_foundation`): organization, `slug` unique per organization,
title, position name, employment type, pay type and minimum/maximum in minor
units with a currency, sanitized description HTML, screener questions JSON,
`isGeneral`, `status` (`draft`, `published`, `closed`, `expired`) and timestamps
(`publishedAt`, `closedAt`, `expiresAt`). Applicants stay regional and refer to
a posting by its opaque id.

- **Shared rules** live in `packages/common/src/job-posting.ts`: Zod schemas,
  the lifecycle (a draft publishes, a live posting closes or expires, a closed
  or ended one reopens), publish checks, slugs, the public projection, the
  sanitizer allow-list and the schema.org `JobPosting` builder. Pay is stored as
  integer minor units; a posting that shows no pay stores no amounts.
- **Editor** (`staff/hiring`, `hiring/new`, `hiring/:postingId`): four steps
  (role, pay, questions, review) in one in-memory draft with explicit Save
  draft, Publish and Close. It uses normal loaders and actions; no regional
  token is involved. Writes need `update:hiring:any`, reads `read:hiring:any`,
  both behind the flag. Impersonated support sessions are read-only. A posting
  belongs to the organization, not to a scope. Every change writes a
  `job_posting_*` audit row with ids and states only.
- **General application.** An evergreen posting (`isGeneral`, slug
  `general-application`, never expires) is offered on the list as one click; it
  is created as a draft so a manager publishes it consciously.
- **Screener questions.** Yes/no questions (with a topic, an optional
  dealbreaker and the right answer) and open questions, at most 10. A
  dealbreaker only flags an applicant; it never rejects anyone. The public
  projection never includes which answer is the dealbreaker.
- **AI draft.** An optional "write a draft" from a short prompt, through
  `@repo/ai`. Only the typed prompt and the business name are sent, the reply is
  parsed and sanitized, ids are assigned by us, nothing is saved until the
  manager saves, and it can be undone. Ten requests per user per hour.
- **Public route.** `GET /resources/sites/careers?slug=` (or `host=`) lists live
  postings, `&posting=` returns one. It answers 404 until the site is published
  and `staffing.hiring` is on (checked on every request), serves an ended
  posting never (even before the job runs), and carries ids and public text
  only.
- **Sites** (`apps/sites`): `/careers` and `/careers/:slug`, rendered on the
  server from that route, locale-prefixed and right-to-left aware, with a
  `JobPosting` structured-data block, a copy-link button and a server-drawn QR
  code. Careers pages are never served from the HTML edge cache. While hiring is
  off, `/careers` falls through to whatever page the organization published at
  that address. The posting page carries the real application form (see the next
  section).
- **Expiry.** `/resources/jobs/job-postings-expiry` marks postings past their
  closing date as `expired` on the existing `0 3 * * *` trigger (no new cron
  slot); see `docs/scheduled-jobs.md`.

Choices worth knowing: descriptions are sanitized with `sanitize-html` (the
repo's server-side sanitizer, which also runs on Workers) rather than DOMPurify,
which needs a DOM, once on write and again on render with the same allow-list.
The rich-text field reuses the Tiptap packages already in the App (starter kit
limited to paragraphs, one heading size, bold, italic, lists and links). The QR
code uses `qrcode`, already in App and Admin, through its browser build (SVG
only, no Node APIs) on Sites.

### Onboarding checklists and certificates (built: flag `staffing.hiring`)

Regional tables (in `0012_staffing_foundation`): `onboarding_templates` (one
live default, enforced by a partial unique index), `onboarding_template_tasks`,
the extended `onboarding_tasks` (type, instructions, form link, assignee,
template of origin, reminder stage) and `staff_certificates` (kind, optional
label, issue and expiry dates, note, alert stage). Rules and pure helpers are in
`@repo/staffing` (`onboarding-api.ts`): task types (`review_profile`,
`acknowledge_policy`, `form_link`, `custom`), strict request schemas, the
`https` form-link check, progress, due state, reminder stage and certificate
standing.

- **API**, under `/operator/hiring` so it shares the hiring token: templates
  (`GET/POST /onboarding/templates`, `PUT/DELETE /onboarding/templates/:id`),
  roster progress (`GET /onboarding/summary`: counts and the earliest open due
  date, no titles), a person's checklist (`/onboarding/staff/:id/tasks`,
  `apply`) and certificates (`/certificates/staff/:id`). A person outside the
  token's scope ids is a 404; template changes need an unrestricted token.
- **Auto-attach on hire.** The hire transaction copies the template named in the
  request, else the live default, else the built-in list. The template is
  resolved before any write, so an unknown one refuses the whole hire.
- **Reminders** run in the regional tick (see ADR 047, section 15) and alert
  managers with a count and a place only.
- **UI.** Hiring > Onboarding is the template builder (a side sheet with
  button-based reordering). A person's profile gets Onboarding and Certificates
  tabs, and the roster shows "Onboarding 3/5" (with "late" in words) only for
  people with tasks left. All of it is absent unless `staffing.hiring` is on and
  the member can read hiring. "Today" in the UI is the manager's device day.
- **Components.** Built only from `@repo/ui` (checkbox, progress, select, sheet,
  dropdown menu, alert dialog); no third-party component was needed.
- **Deferred.** Document upload (needs a regional object store; ADR 047 section
  15), staff self-service acknowledgement and staff-facing reminder email, a
  member picker for assigning a task to one member (the API and the saved
  templates support it; the UI offers manager or new hire), a template choice in
  the hire dialog (the API accepts `templateId`; the dialog uses the default).

### Applicants and hiring (built: flag `staffing.hiring`)

Applicants, their answers, notes and interviews live in the **regional** tenant
database (`packages/tenant-db`, same migration): `hiring_applications` (opaque
posting id, title snapshot, source, contact, answers JSON as asked and given,
stage, screener score and flags, `consent_at` and `consent_version`,
`retention_expires_at`, `hired_staff_id`, a keyed hash of the caller address),
`hiring_notes`, `hiring_interviews`, `hiring_events` (the candidate's timeline,
codes only) and `onboarding_tasks` (the new hire's checklist; templates and
reminders build on it). Shared rules are in `@repo/staffing` (`hiring-api.ts`:
stages, schemas, retention, the default checklist; `hiring-screener.ts`:
answers, score and flags).

- **Public intake** (`POST /careers/apply` on tenant-api, called from the
  careers page in the visitor's browser, never through Sites' server). The
  organization is resolved from the browser's `Origin` and is never chosen by
  the client: a body `orgId` is a 400, a body `slug` that disagrees with the
  Origin is a 404, the platform's own app origin and look-alike hosts resolve
  nothing, and a request with no Origin resolves nothing. A slug or host in the
  body is honored only for a local development origin outside production. The
  Workers edge routes `/careers/*` by that same resolution, never by a body or
  query `orgId`. Checks, in order: body size (32 KB), honeypot (answered like a
  success), organization, strict Zod validation (size caps, no markup in names,
  at most 20 answers, phone normalized to E.164), Turnstile (action
  `careers-apply`), the live posting from the control plane, then durable limits
  stored in the organization's own database (60 per organization per hour, 5 per
  address per hour and 12 per day, by keyed hash) and the write. Consent is
  required, its version must be one the server knows, and `consent_at` is the
  server's clock. A repeat application from the same email or phone to the same
  posting returns the same "received" answer and creates no second record (a
  declined applicant may apply again). No file upload in v1.
- **The posting** is pulled from the App (`GET /resources/staffing/job-posting`,
  `INTERNAL_COMMAND_TOKEN`) because tenant-api cannot read the control plane and
  the browser is not trusted about what a posting asks. It carries public
  content plus which answers are dealbreakers (never shown publicly) and answers
  404 for a posting that is not live, an organization with hiring off, or an
  unpublished site. A minute of caching, and an unreachable App is a 503 ("try
  again"), never an accepted application it could not validate.
- **Screener.** Deterministic: every yes/no question is required, answers are
  checked against the posting's own questions (an unknown key is refused), the
  score is the share of yes/no answers that match what the job wanted, and a
  dealbreaker that differs raises a flag. Nothing rejects anyone; the manager
  decides. The question text, the wanted answer and the dealbreaker setting are
  snapshotted with the answers so editing a posting later never changes what an
  applicant was asked.
- **Manager API** (`/operator/hiring`, token scope `hiring`; reads need
  `read:hiring:any`, changes `update:hiring:any` and are refused for
  impersonated sessions). List with filters (stage or `open`, job, scope,
  answers to check, search) and per-stage counts; the list carries no contact
  details and no answers. One candidate returns contact, answers, notes,
  interviews and timeline, and the read is audited first
  (`hiring.application.viewed`). Stage moves (any open stage to any open stage,
  and a declined candidate back in), notes, interviews (booked in the scope's
  time zone, with an emailed invitation, a cancellation notice and a resend),
  decline (private reason, optional templated message, interviews still ahead
  are cancelled, retention clock starts), hire, erase, and the position list for
  a hire. Visibility is the token's scope ids applied to the application's
  scope; an application outside it is a 404. The generic module gives every
  posting the one default scope.
- **The hire is one regional transaction**: the staff member (names, email,
  phone and language from the application), their primary scope assignment,
  their position, the default onboarding checklist, the application's move to
  Hired with the new staff id, the timeline entry and the audit rows
  (`staff.created`, `staff.job.added`, `hiring.application.hired`). Any failure
  rolls back all of it; two concurrent hires create one person. It refuses a
  candidate who is declined or already hired, an archived position, and a person
  who is already on the roster (`staff_exists`) or is a former member
  (`staff_terminated_match`, so a rehire is done from the roster). Pay is not
  set in the hire dialog (the hiring token holds no pay grant, by design); the
  profile it opens sets it. The optional app invitation is the existing
  `staff/invite` route called with the new opaque staff id after the hire,
  because a login lives in the control plane.
- **Manager notification.** A new application queues a generic
  `manager.new_applicant` outbox event (an id and a scope, never a name). The
  regional tick delivers it to the App as the same strict
  `{ orgId, eventId, kind, scopeId, count }` event the clock alerts use; the App
  tells members who can read hiring at that scope, in the app and by email,
  honoring their notification preferences (a new "Hiring" workflow). The tick no
  longer skips an organization that has applicants but no staff yet.
- **Retention and erasure.** The regional tick purges declined applicants past
  their period (the organization's `retentionDaysDeclinedApplicants`, default
  365 days, placeholder pending counsel), only ever selecting declined rows, in
  batches of 200, one audit row per pass with a count. It runs while the master
  switch is on even if `staffing.hiring` was turned off, so a module that is off
  does not keep personal data past its period. The audit log is never touched
  and holds ids and counts only. A manager can erase one applicant at any time
  (answers, notes, interviews and timeline cascade), and erasing a login also
  erases the application its staff record was hired from. A person's own export
  includes what they wrote when they applied. The region-switch summary counts
  applicants; they are not part of the staff backup file in v1.
- **Screens** (`staff/hiring/applicants`, a tab beside Jobs): the pipeline as a
  board of columns (New, Screening, Interview, Offer) or a list with a stage
  filter, the same data either way; a phone gets the list by default. Cards move
  four ways: drag with a mouse, press and hold the grip on a touch screen, Space
  and the arrow keys on the grip (with spoken updates), or the "Move to" menu on
  each card. A candidate opens in a side sheet (a child route) with the next
  steps first (stage, Hire, Interview, Decline) and details, interviews, notes
  and history in tabs. Filters live in the address bar. Everything is fetched
  browser-direct; the route loaders only name scopes (a name, a time zone, a
  currency).
- **Sites.** The posting page has the real form (names, email or phone, the
  job's questions, a consent box with the notice version, Turnstile when a site
  key is set, a honeypot) posting to the regional node named in
  `data-tenant-api-url`. `?src=qr` (the QR code) and `?src=share` (the copy-link
  button) set the applicant's source. The structured data claims `directApply`
  only when the node's address is configured.

Component choices: the board reuses `@dnd-kit` (already in the App for the
schedule) with a pointer, touch and keyboard sensor and spoken announcements,
and every other control is an `@repo/ui` component (Base UI under the hood), so
nothing new was installed. Date and time entry uses the browser's own inputs (no
date-picker library), interpreted in the interview scope's time zone.

Deferred: applicant messaging beyond the invitation and decline emails, manual
"add a walk-in" entry, a reply-to address on applicant email (the sender is the
platform's), rejecting by score automatically (deliberately never), EEO
questions and documents (decision 21), and including applicants in the
region-switch backup file.

### Audit and security

Two layers: a regional append-only `staff_audit_log` (every write, every read of
private, pay or applicant detail, punch rejections, PIN resets, kiosk pairing,
exports, timesheet unlocks, policy changes) and a generic mirror into
`@repo/audit` sent server to server from an outbox. Time-card edits require a
reason, locked cards are immutable until unlocked by an `approve` holder, and
the employee is notified of edits. CSV export neutralizes formula-leading
characters. Public apply uses Turnstile, a honeypot, per-IP and per-org limits
and size caps, with no file upload in v1.

### Members, billing and erasure

Staff-only workers cost no seat. Removing a member only unlinks the login;
termination is an explicit staff action. Enabling staffing offers an import of
current members, posted from the manager's browser to the regional node. Erasing
a `User` enqueues an anonymization of the linked staff row. The region-switch
confirmation shows counts and offers a browser export before the wipe.

## Component choices and deviations (final integration)

**Components.** The module installed no UI library. Everything visible is an
`@repo/ui` component (Base UI under the hood: Button, Dialog, AlertDialog,
Sheet, Select, Field, Switch, Badge, Tabs, ToggleGroup, Empty, Skeleton,
Calendar, AnnotatedSection) with small wrappers in `components/staff`,
`components/kiosk`, `components/hiring` and `components/my-schedule`. Two thin
additions went into `@repo/ui`: `position-color` (a token-only colour chip for
positions, using the `position-*` theme tokens) and the `calendar` export. The
only dependencies added to the repo are the first two rows (the third is
reused):

| Package          | Where            | Why                                                                                              | Licence |
| ---------------- | ---------------- | ------------------------------------------------------------------------------------------------ | ------- |
| `qrcode`         | `apps/sites`     | The careers QR code (browser build, SVG only); already used by the App and Admin                 | MIT     |
| `fake-indexeddb` | `apps/app` (dev) | Tests for the kiosk offline punch queue                                                          | MIT     |
| `@dnd-kit/core`  | none (reused)    | Schedule drag and drop and the applicant board; already an App dependency, keyboard sensor added | MIT     |

No date-picker, chart, table or rich-text library was added: dates use the
browser's own inputs, and the job-description editor reuses the Tiptap packages
already in the App.

**Deviations from the plan, and why the repo won.**

- The US tenant-api node is a Cloudflare Worker with a SQLite Durable Object per
  organization (OCI Ashburn is optional), not an OCI VM as the plan assumed.
  Tenant migrations therefore also ship as generated Durable Object migrations
  (`apps/tenant-api/workers/migrations.generated.ts`, regenerated by
  `generate:do-migrations`, which `typecheck` and `build` run). The tick uses
  Durable Object alarms on Workers and an in-process interval on Node.
- The control-plane schema is one migration, `0018_staffing_foundation`, and the
  tenant schema one migration, `0012_staffing_foundation`; both are generated
  from the final schemas and are additive only.
- Manager alerts reuse the App's existing notification system (bell, stream,
  preferences, email) rather than a new channel; the payload crossing the plane
  boundary is an id and a count.
- The region-switch backup file holds staff, positions, pay, notes and the audit
  trail only; time cards, shifts and applicants are counted in the warning and
  not exported (kept off the US plane by design, and a switch wipes them).
- Time-card approval and locking are per card; period-level close records were
  not built.
- Draft schedule edits are stored as a `draft_patch` on the published shift row
  rather than as duplicate rows; auto scheduling, swaps that reassign
  automatically, push notifications and a staff mobile app are out of scope.
- Local development has two control planes: the libsql file used by the seed
  scripts and Playwright, and the Workers local D1 used by `npm run dev -w app`.
  Flags set by `seed:staffing` land in the libsql database; turn them on in the
  D1 database (Admin, Feature flags) to see the demo in the dev server.

## Roadmap

Slices land as sequential `pr/staffing-<slice>` branches (hiring:
`pr/hiring-<slice>`), each with tests, docs and regenerated Lingui catalogs.

| Phase | Scope                                                                                                                                                    |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Decisions and prerequisites: ADR 047, this plan, time zone list, audit emission for member and invitation actions, a verification spike on both runtimes |
| 1     | Foundations (permissions, flags, access helper, `@repo/staffing` skeleton), roster, positions, rates, PINs, link-to-login                                |
| 2     | Time clock and timesheets: kiosk, breaks, issues, edit log, approve and lock, CSV export, clock tick                                                     |
| 3     | Scheduling: grid, copy week, publish, availability, time off                                                                                             |
| 4     | Labor cost and labor-percentage reporting                                                                                                                |
| 5     | Hiring and onboarding (parallel after Phase 1)                                                                                                           |
| 6     | Reach: staff principal, personal clock, swaps, tip-pool report, forecast overlay, rule packs, payroll exports, documents                                 |

Phases 2 and 3 are independent after Phase 1 and can be reordered; the data
model does not change because `time_entries.shift_id` is nullable.

## Verticals

The generic module never says "location", "store" or a product word. A vertical
that has its own places maps them onto scopes, following the phone agent
precedent ([phone agent verticals](./phone-agent-verticals.md)): the core keeps
neutral vocabulary and the vertical owns the mapping and the words. The seams:

- **Scope facts.** The App route `/resources/staffing/scope-context` returns the
  scopes (`{ id, name, timeZone, isActive }`) and the effective flags. The
  generic version returns the one `main` scope; a vertical returns one per
  place.
- **Token claim.** Staffing tokens carry `scopeIds` (null means every scope);
  `scopeToScopes` applies it on every staff route, so a vertical that stores
  member grants only has to mint the narrower list.
- **Order source.** `registerOrderSource` in
  `apps/tenant-api/src/services/order-source.ts` feeds the demand guide, the
  forecast, the order-based sales options and the tip pool.
- **Pickers.** Scope pickers and filters in the screens appear only when the
  scope list has more than one entry.
- **Vocabulary guard.** `packages/staffing/src/vocabulary.test.ts` fails when
  the core sources use place, food or retail words.

## Feature flags and rollout

Org-level `ConfigFlag` rows read with `getFeatureFlag`; absent means off.

| Flag                  | Gates                                                         |
| --------------------- | ------------------------------------------------------------- |
| `staffing.enabled`    | Master: sidebar group, routes, token minting                  |
| `staffing.timeclock`  | Kiosk pairing UI, timesheets                                  |
| `staffing.scheduling` | Schedule routes and publish                                   |
| `staffing.labor`      | Pay visibility in reports, labor summary, labor grant minting |
| `staffing.hiring`     | Postings, applicants, onboarding                              |

- Enforce at token mint and in every child loader and action; tenant-api honors
  only tokens the App minted. A unit test locks default-off, since this is the
  first consumer of `getFeatureFlag`.
- A flag cannot stop an already paired kiosk. Mitigations: revoke devices first,
  and tenant-api kill switches for kiosk and staff email.
- Deploy tenant-api first, confirm both nodes report the new version, then flip
  flags. Tenant migrations apply lazily to every org database, so they stay
  additive and schema-only changes merge before UI.
- Rollback: flip flags, revoke kiosk devices, set kill switches. Data is kept.
- KSA enablement waits for legal review of retention and PDPL wording, OCI email
  verified from Riyadh, Arabic and RTL QA, and settled residency decisions.

## Open decisions

Residency metadata rule and KSA login email; launch markets and legal review;
upstream policy; first wedge (hours or coverage) and whether pilot organizations
have a tablet; payroll scope and first export formats; sales source for labor
percentage; retention periods; region-switch policy; rule-pack posture; manager
role presets; notification channels; PIN length and UX; cron and sub-hourly
approach; time-card edit policy; hiring scope; document storage; tip pooling
rules; applicant data collected; kiosk locales and hosting; mixed-region and
cross-org staff (unsupported).

## Risks

Residency retrofit if placement is not settled; wrong labor percentage when
sales are incomplete; wage-dispute exposure from manager edits of time cards;
PIN kiosk abuse; compliance liability from overtime and break defaults; time
math errors (daylight saving, overnight, week start, server-local report
bucketing); cron capacity and an unscheduled retention job; two runtimes
diverging; migration blast radius across all org databases; no designed recovery
story for HR data; confusion between Members and Staff.
