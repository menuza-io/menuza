# Staffing: MVP-first plan

Status: phased implementation. Shipped so far: the job-application form preset
(browser-direct responses) and foundations (admin-only staffing permissions,
default-off `staffing.*` flags, `requireStaffingFeature`, the `@repo/staffing`
domain package, and the expanded location timezone list), and the regional
roster (team, positions, bulk paste, terminate/rehire, settings, audit, and
region-switch warning). Later slices are tracked in the PR sequence below;
[staffing guide](./staffing.md) describes what operators can use today.

Baseline: `main` at `ed54ca1a`, refreshed 2026-10-11. This plan consolidates the
supplied MVP, architecture, competitive-parity, live walkthrough, mock, and
repository research. Live empty-state observations establish screen structure,
not untested behavior. Mock defaults are not product or legal requirements.

## Goal

Give an organization a separate workforce roster, a publishable weekly schedule,
a shared-tablet time clock, auditable timesheets, and estimated labor costs.
Start with a single-location US pilot while preserving one regional code path
for US and KSA. Keep clock-only workers out of operator seat billing.

## Recommendation in one paragraph

Start hiring with a Website Forms preset and review applications in Mailbox.
Then deliver foundations and roster, weekly scheduling, kiosk and timesheets,
and a labor-versus-online-sales view. Structured job postings, applicant stages,
and manager-completed onboarding checklists follow only when pilot usage
justifies them. Use the architecture proposal for irreversible boundaries and
the parity matrix as a later backlog, not as the MVP commitment.

## Confirmed decisions

- All workforce records and rules are regional for both regions, as recorded in
  [ADR 047](./decisions/047-staffing-data-placement.md).
- The first pilot is single-location US. KSA readiness means placement,
  browser-direct access, Arabic/RTL, and regional isolation, not legal approval
  or a KSA release.
- A staff record is not a `UserOrganization`. Existing seat-count behavior
  remains unchanged. Commercial module pricing is still undecided.
- Default to kiosk and web operator surfaces before Expo. Native customer apps
  remain customer-only.
- Do not run payroll, file taxes, move PII across regions, collect bank/tax IDs,
  implement biometrics, or claim jurisdictional compliance in the MVP.

## Current first slice: careers form preset

`/{orgSlug}/website/forms/new` offers **Job application** alongside existing
templates. It collects full name, required email, optional phone, role,
availability, and optional experience. Email is required so managers can use
Mailbox's existing email-app handoff; the builder can change that requirement.
Creation is a draft with application-specific button and confirmation copy.

No new tables, permissions, secrets, cron trigger, billing behavior, or staffing
flag are needed. Public intake uses the existing Form block, origin resolution,
honeypot, configured Turnstile, validation, and regional storage. Applications
do not create operator accounts or staff records.

Form definitions may pass through App and public cache. Submission values must
not. The form builder now loads definitions from `GET /operator/forms/:formId`;
its Responses view obtains existing mailbox-scoped credentials and reads
`GET /operator/mailbox/form-responses/:formId` in the browser. This keeps the
builder and Mailbox on the same read-only authorization and residency path.

The Responses view shows up to 500 recent responses, as before. Mailbox is the
paged review surface for older applications. No automatic applicant email,
pipeline, consent acceptance record, upload, or hire action is implied.

Operating recipe: [careers form](./staffing.md).

## Architecture for subsequent slices

```text
US control plane                         Organization's regional tenant-api
operator identity / RBAC / flags          staff / jobs / rules / shifts
locations / billing / public postings     punches / timecards / applications
                 |
App issues scoped credentials
                 |
manager or kiosk browser ----------------------> regional API + per-org DB
                                              |
                                     in-region email / storage / audit
```

### Auth and permissions

Add organization read/update permissions for staff, schedule, and timesheets.
Pay is a separate grant before rates ship; private fields and lock/unlock have
separate grants before those capabilities ship. Keep member/viewer defaults
unchanged and grant new administrative permissions only to built-in admin. Do
not automatically copy sensitive grants to existing custom roles.

Each permission addition needs the production data migration, role seed, auth
constants, custom-role allow-list, role editor, sidebar, docs, and tests. Every
child loader and token route authorizes independently. Role presets, if added
later, create editable custom roles without changing built-in levels.

App tokens must carry an explicit scope, grants, subject, organization, and a
location scope (`null` for all; an empty array means no access). API enforcement
is server-side, not a location-picker cookie. Reserved claims alone are not
location authorization: finish location scoping before multi-location pilots.
Refuse workforce writes and kiosk pairing under support impersonation.

Use a default-off `staffing.enabled` flag for the actual staffing vertical.
Enforce at token mint and child routes. Disabling token minting does not revoke
an already-paired device: plan regional device revocation and kill switches.

### Domain and schema

New pure `@repo/staffing` package: Zod contracts, timezone/business-day math,
overlap checks, clock state machine, PIN rules, and CSV neutralization. Keep
database, network, and UI concerns out of it.

Regional tables arrive per vertical slice:

| Slice    | Tables                                                                                                                      |
| -------- | --------------------------------------------------------------------------------------------------------------------------- |
| Roster   | `staff_members`, `staff_positions`, `staff_location_assignments`, `staff_jobs`, `staffing_settings`, regional audit         |
| Schedule | `shifts`, `schedule_weeks`, `schedule_publications`                                                                         |
| Clock    | kiosk devices/pairing codes, per-assignment credentials, append-only `time_punches`, `time_entries`, edit log, period locks |
| Labor    | effective-dated rates, entry rate snapshots                                                                                 |
| Hiring   | applications, notes, onboarding templates/tasks                                                                             |

Use integer minor-unit money with an explicit currency. Rates become
effective-dated when introduced; do not overwrite history with a mutable
assignment rate. Existing unrated timecards stay unrated rather than being
silently costed at a newly added wage.

Store UTC instants, timezone snapshots, and local business dates. Explicitly
test DST gaps/folds, overnight shifts, Sunday/Monday weeks, and Riyadh. Do not
trust the existing wall-clock conversion or overnight store-hours behavior
without boundary tests.

Keep published shifts unchanged while draft edits are pending. Use a draft patch
or versioned snapshot, not just `updated_at > published_at`, which would expose
unpublished edits to kiosk users and notifications. Publish and audit are
transactional; notification delivery uses an idempotent regional outbox.

Punch idempotency is per action, not per timecard. An append-only punch log
captures rejected and accepted actions from day one; corrections change the
working timecard with a reason and edit evidence. Locks are enforced by the API.
Manager-entered unpaid break minutes must be explicit, not automatic deductions
from recorded time.

Kiosk pairing uses a one-time code in a URL fragment, a revocable device
credential, and PIN lookup with domain-separated keyed HMAC and weak-PIN
rejection. Never reveal a stored PIN; reset and show once. Rate limits and
device trust are required. Security review must approve key choice, uniqueness
scope, replay resistance, lockout, and revocation before pilot.

### Integration boundaries

- Location timezone, coordinates, and hours remain control-plane configuration.
  Tenant-api pulls non-PII location context, following ordering's existing
  context-fetch pattern, with bounded cache lifetime.
- Removing App membership removes App access, not employment. Termination is an
  explicit regional action. Optional invite linkage uses opaque staff IDs and an
  idempotent outbox; no automatic cross-plane email matching.
- Regional audit is authoritative. A US mirror receives generic actions and
  opaque references only. Wire missing membership audit events before roster
  invitation linkage.
- Staff emails originate regionally. Operator notifications may originate in App
  with generic content. Verify provider processing, recipient-address transit,
  consent, and region, not just message content, before KSA launch.
- Exports go regional API to browser and neutralize CSV formula prefixes. Staff
  DSAR and erasure must preserve applicable employment retention; do not erase
  statutory history solely because a login user is deleted.
- Before storing workforce history, implement region-switch warnings/guard,
  direct browser export, and in-region backup/RPO/RTO policy. Export alone is
  not evidence that a destructive switch satisfies record-retention law.

## PR sequence and exit criteria

| PR                               | Scope                                                                                                                      | Exit criteria                                                                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Careers preset (this slice)      | Preset, browser-direct builder responses, operating recipe, plan, ADR                                                      | Draft can be customized/published; form validates; responses remain regional; access-denial and residency regression tests pass |
| Foundations                      | `@repo/staffing`, admin-only permissions, default-off flag, scoped operator auth, non-PII location context, audit plumbing | Flag off denies routes/token; cross-org, cross-region, scope/principal confusion tests pass                                     |
| Roster                           | Regional people/positions/assignments, add/edit/import, notes, terminate/rehire, PIN management, region-switch guard       | Login-less workers exist without seat changes; roster writes and sensitive exclusions are audited                               |
| Schedule grid                    | Week/open shifts, editor, overlap warnings, hours/headcount, copy week, print                                              | Overnight/DST math passes; draft edits do not change published shifts                                                           |
| Schedule publish                 | Publication history, regional email outbox, affected-person summary                                                        | Publish is atomic and retry-safe; missing contact is explicit; only published own shifts are delivered                          |
| Kiosk                            | Pair/revoke, PIN, position pick, clock-in/out, append-only punches                                                         | Security-reviewed; duplicate action cannot double-punch; impossible transitions and revoked devices fail closed                 |
| Timesheets                       | Day/week review, manual corrections, edit trail, approve/lock, browser CSV                                                 | Locked entries cannot change; missing clock-outs surface; raw punches survive corrections                                       |
| Labor                            | Effective rates, pay grant, snapshots, local-day hours/cost versus online orders                                           | Hand calculation matches; mixed currencies are not summed; missing wages and excluded overtime are explicit                     |
| Structured hiring (demand-gated) | Public non-PII postings, Sites pages, regional stages/notes, transactional hire                                            | Applications stay regional; hire is idempotent and creates staff without membership                                             |
| Onboarding (demand-gated)        | Org checklist templates, manager completion, roster progress                                                               | New hires get a checklist; completion is audited; no e-sign or tax-form claims                                                  |

Schedule and clock can progress independently after roster. Do not parallelize
shared schema edits without assigning migration ownership. Migration numbers are
allocated at generation/merge time, not reserved by this plan. Current heads are
control-plane `0021` and tenant `0013`; every tenant migration also regenerates
`workers/migrations.generated.ts` and tests Node and DO runtimes.

## Explicit cut lines

MVP excludes staff mobile/self-service auth, swaps/open-shift claims,
availability/time-off workflows, automatic clock-out, offline queues, photos,
geofencing, automatic break deductions, rounding, statutory overtime pay,
forecast scheduling, tip pooling, resume uploads, e-sign, and tax/bank fields.
Add each only after a separate pilot-backed slice.

Weekly over-threshold hours are warnings, not payroll calculations. Estimated
labor costs must state when overtime and other premiums are excluded. Never
describe unverified regional rule packs as compliant payroll.

Labor percentage is cost divided by **online sales only** initially. It is not
total restaurant labor percentage. The current order model lacks dine-in/POS
sales ingestion. Add manual sales entry before claiming a full sales
denominator. Full reports integration needs duration, ratio-of-sums, and
location-aware timeframe bucketing.

## Deployment and rollout

1. Merge tested schema/API slices before exposing App UI. Tenant migrations
   affect all org databases on open, even with flags off.
2. Verify regional API versions before enabling org flags. Keep English and
   Arabic catalogs current and test keyboard, narrow-screen, and RTL flows.
3. Dogfood, then single-location US partners. Track time to first publish,
   notification reach, punches, manual corrections, and missing clock-outs.
4. Do not start multi-location pilots until row-level manager scoping ships.
5. Do not start KSA pilots until retention, regional email/storage/backups,
   identity policy, notices, and Arabic/RTL QA are approved.

Current checked-in cron config has four triggers. `wrangler.deploy.jsonc` is
generated locally and is absent from this checkout; the patcher does not add
form-retention triggers. Do not assume a fifth trigger exists or retention is
active based on the research machine's generated file. Future regional sweeps
can share the hourly fan-out; their timing must not promise ten-minute reminders
on an hourly schedule. Any new cadence needs an explicit deploy change.

## Release-gating decisions still open

- Module pricing (separate from operator seats) and pilot partners.
- Retention periods, employment-history erasure, backup recovery, and whether
  region switches must be blocked once workforce history exists.
- Kiosk PIN uniqueness/key management and security-review sign-off.
- Email availability among staff, regional email delivery, and US SMS consent.
  KSA SMS has no approved provider in this plan.
- Whether online-only sales and straight-time estimates suffice for pilots.
- Employee login email/name in the US identity system for KSA organizations.
- Approval policy before export and legal review before any labor-rule pack.

The larger feature/settings matrix remains a follow-up backlog. It does not
authorize payroll, third-party integrations, provider sign-ups, or collecting
sensitive documents.
