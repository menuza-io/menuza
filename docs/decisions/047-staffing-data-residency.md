# Staffing data residency and identity

Date: 2026-10-11

Status: proposed (accepted once the owner confirms decisions 1, 2 and 6 listed
under [Open points](#open-points))

## Context

The Staff module covers hiring and onboarding, scheduling, staff management and
a time clock. It stores records that are more sensitive than customer contact
data: legal names, phone numbers, pay rates, hours worked, schedules and job
applications. [ADR 045](./045-tenant-data-residency.md) already decided that
customer PII for KSA organizations must stay in the kingdom, including in
transit, and that moving data between regions is not supported. Staff data must
follow the same rule, and it has to be settled before any schema is written,
because moving it later would be exactly the cross-region migration ADR 045
rejects.

The platform also already has a member model: a control-plane `User` joined to
an organization through `UserOrganization`, with invitations, roles and a
billing seat count that is derived from active `UserOrganization` rows. Staff
(people who work for the organization) and members (people who log in to the
App) overlap but are not the same set. An hourly worker with no email must be
able to exist without taking a seat.

This ADR covers placement, identity, the rules for what may cross planes, and
the stance on legal rules. It does not choose pricing, trials or packaging;
those are out of scope for the implementation.

## Decision

### 1. Placement: option C

- **Control plane (US App/Admin database)** keeps identity, membership, roles
  and permission grants, `staffing.*` feature flags, the organization's staff
  time zone (`Organization.staffingTimeZone`), an opaque staff link id, an
  outbox of link/unlink/erase events (ids only), and `JobPosting` rows. The
  generic module has no member scope grants (decision 13).
- **Regional tenant database** (`packages/tenant-db`, reached through
  `apps/tenant-api`) keeps everything that describes a person or their work:
  staff profiles and contact data, positions, effective-dated pay rates, PIN
  lookups, availability, time off, shifts and publications, punches and time
  entries, labor policy, applicants and their answers, onboarding tasks, the
  staff notification outbox and the staff audit log.
- Rejected: everything in the US database (breaks ADR 045 for KSA); everything
  regional including membership (RBAC is evaluated in the US App); a US cache of
  schedules (a second code path that cannot work for KSA).

### 2. Browser-direct access

The UI is client-rendered against tenant-api with short-lived operator tokens
minted by the App, the same pattern as orders and the mailbox. No US loader
joins staff names or pay. Tokens carry a scope, permission grants and optional
scope ids. Tokens that carry pay or private-field grants get a shorter lifetime
than the default. Impersonated admin sessions get read-only tokens with no pay
or private grants. tenant-api does not look up feature flags; it honors only
tokens the App minted, so the flags are enforced at token mint and again in
every App child loader and action.

### 3. Staff is not a member; removing a member only unlinks the login

- A staff member is a regional record with an optional, opaque link to a login
  (`user_id`). The control plane holds the reverse link only as an opaque id on
  the invitation (`staffMemberId`).
- `UserOrganization` stays the login and seat record. Staff rows are never
  `UserOrganization` rows, so the seat count is unchanged by staffing. A person
  who is both a manager and staff is one seat and one staff row.
- Removing a member (`remove-member`) sets `active=false`, updates seats and
  enqueues an `unlink_user` outbox event. The person keeps clocking in with a
  PIN. Termination is a separate, explicit staff action (reason, date, rehire
  eligibility) that may also remove app access.
- This differs from an earlier suggestion that removal should terminate the
  staff record. Removing app access is an account decision; ending employment is
  an HR decision, and conflating them would silently destroy time records.

### 4. HR-event metadata crossing to the US

tenant-api may send generic events to the App (manager alerts, an audit mirror).
Payloads carry only: organization id, actor operator user id (operators are
US-held already), action, resource type, scope id and counts. They never carry a
staff id, a name, a time or a pay figure. The regional audit log is
authoritative. Delivery is server to server from an outbox.

For KSA organizations this is the default but counsel may veto it. If vetoed,
KSA organizations run with the audit mirror and alert events disabled and use
in-product alerts fetched browser-direct from the regional node.

### 5. Login email

A staff member with an App login has an email in the US database like every
member. The default is login-less staff: contact data (email, phone) lives only
regionally. Whether a KSA organization's staff may hold a US login email is left
to counsel; the product must work without it.

### 6. Region switch

Changing `dataRegion` already wipes the old tenant database (ADR 045). With HR
data present, the existing confirmation also reads counts from the regional node
(`/internal/staff/summary`), requires typed confirmation and offers a
browser-side export from the old region before the wipe. The export goes from
the region to the browser only. The default is allow-with-guard; blocking the
switch is the stricter alternative. No cross-region migration is added.

As built: the guard fails closed (an unknown summary requires the typed
confirmation too), the App action re-checks the typed slug server-side, and the
backup is offered rather than required. See
[tenant data residency](../tenant-data-residency.md#change-customer-data-region).

Erasure of a login (`erase_user`) anonymizes the linked staff row regionally:
names become a pseudonym, contact and private data and notes are deleted, and
the before/after values in that person's audit rows are redacted. Pay history
stays under the pseudonym for its retention period. The audit log remains
append-only apart from that single redaction (a trigger in regional migration
`0012_staffing_foundation`). Access requests for a Saudi-region record are
fulfilled in-region by the organization, never through the US control plane.

### 7. Principals

All verification lives in one tenant-api module. Distinct `aud` and `typ` per
principal; org-prefixed device secrets so the Durable Object router can route
them.

| Principal                     | Phase | Notes                                                                                                                                                                                          |
| ----------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manager (operator)            | 1     | App-minted HS256 token with scope, grants and optional scope ids                                                                                                                               |
| Kiosk device                  | 2     | One-time pairing code, device secret stored only as a hash, bound to one scope, revocable, punch-only                                                                                          |
| PIN                           | 2     | HMAC lookup with a server secret, unique per scope, system-generated and shown once; failure counters persisted in the org database because the tenant-api rate limiter is an in-process cache |
| Linked-user employee          | later | App-minted token for staff who have a login                                                                                                                                                    |
| Staff self-service (no login) | later | Needs a new secret and abuse controls (always-202, send caps, single-use tokens) specified first                                                                                               |
| Schedule capability link      | 3     | Read-only, per staff member, revocable, own published shifts only                                                                                                                              |
| Candidate (public)            | 5     | No account; origin-bound org resolution, Turnstile, honeypot, limits                                                                                                                           |

### 8. `JobPosting` lives in the control plane

Public job postings (title, description, pay range, status) are public content
with no PII, and Sites needs them for server rendering and structured data. A
KSA organization's posting text therefore sits in the US database. This is
acceptable because the text is published anyway. Applications, answers and notes
are regional; the posting is referenced from an application by opaque id plus a
title snapshot. A posting belongs to the organization, not to a scope: the
generic module has no per-place postings.

### 9. Rule-pack stance

Overtime, break, rounding, tip and scheduling rules are configurable data, not
legal claims. The product ships no jurisdiction-specific defaults it asserts to
be correct, labels every overtime or cost figure as an estimate, and never runs
payroll. Region rule packs (US states, KSA labor law) are added only after
counsel review. Overtime aggregation across several scopes is a required setting
with no default when a person works in more than one scope.

### 10. Controller and processor

The organization is the controller of its employees' and applicants' data; the
platform operator is the processor. This implies a data processing agreement,
privacy notice templates for employees and applicants, and a documented lawful
basis. Employee consent is a weak basis; features such as GPS or photo punches
are framed as necessary and noticed, not consent-based. Counsel owns this.

### 11. Retention (placeholders)

Placeholders until counsel decides: GPS coordinates nulled after 90 days;
declined applicants purged after 365 days; punches and time entries retained for
the legally required period (to be set per market); the staff audit log is never
purged by these jobs. Retention jobs run in the regional tick, not in the
control plane.

### 12. Feature flags

Everything user-visible is behind organization-level `ConfigFlag` rows read with
`getFeatureFlag`, default off when the row is absent:

| Flag                  | Gates                                                         |
| --------------------- | ------------------------------------------------------------- |
| `staffing.enabled`    | Master: sidebar group, routes, token minting                  |
| `staffing.timeclock`  | Kiosk pairing UI, timesheets                                  |
| `staffing.scheduling` | Schedule routes and publish                                   |
| `staffing.labor`      | Pay visibility in reports, labor summary, labor grant minting |
| `staffing.hiring`     | Postings, applicants, onboarding                              |

A flag cannot stop an already paired kiosk because its device secret lives on
the tablet. Mitigations are per-device revocation and tenant-api environment
kill switches (`STAFFING_KIOSK_ENABLED`, `STAFFING_EMAIL_ENABLED`). Those
variables are decided here. `STAFFING_KIOSK_ENABLED` is implemented in
tenant-api (default on; `false` answers 503 on every `/kiosk` route and refuses
new pairing codes, while revoking a device always still works) and documented in
AGENTS.md. `STAFFING_EMAIL_ENABLED` stops staff email on a tenant-api node and
manager alert email in the App (decision 14). Runbook: revoke devices before
turning a flag off.

No plan gating, trial or paywall is part of this work.

### 13. Scope ids and token lag

The generic module has exactly one implicit scope per organization, `main`
(`DEFAULT_SCOPE_ID` in `@repo/staffing`), named after the organization and
carrying its time zone, so a member's staffing access is organization-wide:
there are no member scope grants and no scope-grant table in the control plane.
The limiting mechanism stays in the token so a vertical can use it:

- **Claim.** Every minted staffing token carries `scopeIds`: `null` for every
  scope, otherwise the chosen ids. A vertical that stores its own grants mints
  the narrower list; a stored value the code does not recognize fails closed: no
  token is minted.
- **Enforcement.** tenant-api applies one helper, `scopeToScopes(auth)`, on
  every `/operator/staff` route. Lists only return people assigned to a
  permitted scope; reads and writes of a person outside scope answer 404 (not
  403, so out-of-scope ids are not confirmed to exist); a person shared across
  scopes shows only the in-scope assignments, and audit rows are redacted to
  in-scope ids. Org-wide actions (import, bulk add, org settings that affect
  everyone, linking a login) need an unrestricted token.
- **Scope of the scope.** A scope limit applies to staffing data only. Every
  other permission stays org-wide.
- **Presets.** An admin action creates the editable custom roles _Shift
  manager_, _General manager_ and _Hiring manager_. They are ordinary tenant
  roles, not a new built-in level.
- **Time zone.** The one scope's time zone is `Organization.staffingTimeZone`
  (default `UTC`), edited at Staff, Time clock, Rules. It fixes the business
  date of a punch and the local hours of a shift. The App serves it to
  tenant-api in the scope-facts route.

**Token lag, accepted.** Operator tokens are stateless and verified by the
regional node without calling the App. Anything that narrows access after a
token is minted (narrowing a token's scope ids, removing a grant from a role,
deactivating the member, turning a feature flag off) takes effect only when that
token expires: **at most 15 minutes**, or **at most 5 minutes** for tokens that
carry `staff_pay` or `staff_private` grants. Widening access is immediate on the
next mint. The browser refreshes tokens about 60 seconds before expiry, so a
narrowed member's next refresh is refused and the staff screens stop working.

The alternative, a small regional denylist keyed by user that the outbox
populates when a member is removed or narrowed, is rejected for v1: it adds a
second authorization source that tenant-api would have to keep consistent with
the control plane, and the lag is bounded and short. Revisit if a pilot needs
instant revocation; the mechanism would be a deny entry the verifier checks
after signature validation. Until then the runbook for an urgent removal is:
remove the member (no new tokens), and for a departing manager with pay access
accept up to 5 minutes; for a stolen browser session, revoke the member's
sessions as today. Kiosk devices are unaffected by operator token lag; they are
revoked individually.

### 14. Clock operations: the regional tick, alerts and timers

Reminders, alerts and automatic clock-outs are one idempotent function,
`runStaffTickForOrg`, run by whichever driver is available.

- **Drivers.** The existing hourly cron fan-out posts `POST /api/staff/tick` to
  each node (no new cron slot, copying the engagement sync). Sub-hourly timing
  is runtime-native: a Durable Object alarm per organization on the US Worker
  runtime, an in-process interval on the OCI (KSA) runtime. The cron is the
  safety net for both. With nothing else running the granularity is hourly, and
  the policy screen says so.
- **Flags.** tenant-api cannot read flags, and the tick has no operator token to
  carry them, so it asks the App for the organization's effective `staffing.*`
  flags (the scope-context route) and does nothing when it cannot confirm them.
  A flag turned off takes effect within five minutes; a flag older than 30
  minutes is not trusted when the App is unreachable.
- **Staff messages** are emailed by tenant-api (operational mail, no marketing
  headers, plain hex-color HTML) from a regional outbox with a unique
  `dedupe_key`, retry with backoff, and a relevance window (a reminder for a
  shift that began is dropped). Content level `full` names the place and times;
  `minimal` (the KSA default) says only that there is an update. The kill switch
  drops messages rather than holding them.
- **Manager alerts** are the one thing that crosses to the US: an organization
  id, an alert kind, a scope id, a count and an event id, under a strict schema
  that rejects any other field. The App resolves recipients by permission and
  scope, applies each member's notification preference (defaults: in-app and
  email on), and writes an in-app notification with only the kind, scope id and
  count. The event id is derived from the outbox rows it covers, so a retried
  delivery repeats nothing.
- **Unscheduled entries.** Scheduling does not exist yet, so an entry with no
  shift has no end to measure a reminder or an automatic clock-out from.
  Measuring from clock-in, as the earlier wording of the policy fields implied,
  would remind everyone minutes after they start. The tick measures an
  unscheduled entry from the long-shift threshold, the point at which the card
  is already flagged for review. The no-clock-in alert and the pre-shift
  reminder need a schedule and report "schedule unavailable" until scheduling
  registers one through the seam in `schedule-seam.ts`.

### 15. Onboarding checklists and certificates (v1 scope)

Checklist templates, a new hire's tasks and certificates live in the regional
database (part of `0012_staffing_foundation`), behind `staffing.hiring` and
reached with the `hiring` token scope (`read:hiring:any`, `update:hiring:any`).

- **What a task is.** A checklist item a manager ticks off: review the profile,
  acknowledge a policy (the policy text is stored on the task and the manager
  records the acknowledgement), complete a form the organization hosts elsewhere
  (an `https` link, no embedded credentials), or a custom task. Each has a due
  date, an assignee (a manager, the new hire, or one member by opaque id) and a
  status (`todo`, `done`, `skipped`). A template is an organization-wide recipe;
  a hire or "add a checklist" copies it, so editing or archiving a template
  never changes checklists already in flight. One live default template is
  attached on hire; without one the built-in starter list is used.
- **No document upload in v1.** Storing a person's document needs in-region
  object storage. The Durable Object runtime has none (open decision 19), and a
  US-held bucket would move KSA data to the US. So there is no upload task type
  and no `file` column anywhere; a paper copy is a custom task ("hand in the
  signed rota"). The limitation is recorded here and the type can be added
  behind the same checks once a regional store exists.
- **No tax, identity or bank data.** No tax form, national or passport number,
  or bank detail can be stored: the schemas are `.strict()`, and a test asserts
  that none of these tables has such a column. A form-by-link task keeps those
  forms with whoever hosts them. A certificate records the kind, an optional
  name, issue and expiry dates and a short note; no certificate number and no
  scan.
- **Reminders and alerts** come from the regional tick, which already runs for
  the clock. For each task due today or overdue for three days, and each
  certificate within 30 days of expiry or expired, the tick queues one manager
  outbox row per item and stage; the App receives the usual strict event
  (`onboarding_due` or `certificate_expiring`, a scope id and a count, never a
  person, a title or a date) and tells members who can read hiring, honoring the
  Hiring notification preference. The day is the organization's own day, in its
  staff time zone. A stage is stored on the row, so a task reminds at most twice
  and a renewed certificate starts over. Staff-facing reminder email is not part
  of v1.
- **Residency of the rest.** The audit log holds ids, codes and counts (never a
  title, policy text, link or note). Erasure of a linked login deletes the
  person's tasks and certificates; a person's own export lists them. Changing a
  template needs a token that covers every scope, because it changes what every
  scope's new hires get.

## Consequences

- Narrowing a manager's staffing access (scope ids, grants, membership, flags)
  lags by up to the token lifetime: 15 minutes, 5 for pay or private grants. See
  decision 13.
- Staff features cannot be rendered by US loaders; the roster, schedule grid and
  timesheets are client-rendered against the regional node. This costs some
  load-time performance and makes mid-edit token refresh a design concern.
- tenant-api must deploy before the App flags are flipped on, and both nodes
  must report the new version; a new App against an old node returns 404s.
- Tenant migrations apply lazily to every org database, whatever the flags.
  Staffing migrations must be additive.
- Admin has no regional read path in v1. Customer-facing exports are the support
  path; a break-glass policy would need its own ADR.
- Organizations with staff in two countries, and staff who work across several
  organizations, are unsupported.
- Disaster recovery for HR data (Durable Object storage on the US node, the
  Riyadh volume) is not designed yet and is a pre-GA requirement.

## Runtime facts

Marked **verified** (read from the repo for this ADR) or **unverified**
(assumption to confirm in the verification spike before it is relied on).

- **Verified.** The US tenant-api node is a Cloudflare Worker with one SQLite
  Durable Object per org by default (`TENANT_API_RUNTIME=workers`); OCI Ashburn
  is optional. KSA is OCI Riyadh with a block volume. `AGENTS.md` previously
  said both nodes were OCI; it has been corrected. Both nodes deploy on every
  tenant-api change, so version skew is possible. Design for both runtimes.
- **Verified.** The tenant-api rate limiter is an in-process LRU, and
  `runExclusive` is a process-local lock, so security counters and serialization
  cannot rely on them on the Worker runtime.
- **Verified.** `getFeatureFlag` has no consumer outside its own file, so
  staffing is its first real caller and ships with a default-off test.
- **Verified.** Cron capacity: `apps/jobs-cron/wrangler.jsonc` lists four
  triggers (`0 2`, `0 3`, `0 4`, `0 *`), so assume no free slot. Sub-hourly work
  uses runtime timers, not a cron slot.
- **Not changed here.** The `0 5` form-submission retention is mapped in
  `JOB_ROUTES` but not scheduled (`docs/scheduled-jobs.md` says so). Enabling it
  in production means adding `"0 5 * * *"` to `apps/jobs-cron/wrangler.jsonc`.
  Until then applicant-adjacent form data is not expired by schedule.
- **Verified by reading the code and types, not yet on a deployed Worker.**
  `TenantOrg` extends `DurableObject`, is declared in `new_sqlite_classes`, and
  the Workers types declare `alarm()` and `setAlarm`/`getAlarm`/`deleteAlarm`
  for SQLite-backed objects, so it supports alarms. The staff tick uses them
  (decision 14): the arming and re-arming logic lives in
  `src/lib/staff-alarm.ts` behind a narrow storage interface and is unit-tested
  with a fake; the Durable Object class is thin glue, and the first run on a
  deployed object is a pre-pilot check. `deprovision` deletes the alarm
  explicitly because `deleteAll` does not.
- **Unverified.** Whether OCI email is configured and deliverable from the US
  Worker and from the Riyadh node (sender domain, deliverability). Pre-pilot
  gate.
- **Verified (CORS), unverified (CSP).** The App origin is already allowed to
  call tenant-api cross-origin (`isOperatorControlPlaneOrigin` in `origin.ts`),
  and a test covers the `/kiosk` preflight from it and its refusal from other
  origins. The CSP of the App page that hosts the kiosk shell is App work and
  still needs a check.
- **Verified.** The org router parses staffing operator tokens (their own
  audience) and kiosk credentials. A kiosk device secret
  (`kdv1.<orgId>.<deviceId>.<random>`) and pairing code
  (`kpc1.<orgId>.<random>`) carry the organization id as a prefix; no query or
  body org id can pick the Durable Object for a `/kiosk` route, and an
  organization the control plane does not know is refused before a Durable
  Object is woken. Router tests cover all of it.
- **Unverified.** The `migrations.generated.ts` round trip on a deployed Durable
  Object (the generator runs and the chain applies on the Node file path);
  whether the Admin feature-flags page needs a key registry for `staffing.*`.

## Prerequisites verified in the repo

- **Audit trail.** `ORG_MEMBER_ADDED`, `ORG_MEMBER_REMOVED`,
  `ORG_INVITATION_SENT|ACCEPTED|REVOKED` and `ORG_INVITE_LINK_CREATED|DISABLED`
  were defined but never emitted. They are now written at the real call sites
  through `apps/app/app/utils/organization/membership-audit.server.ts`: sending,
  accepting and revoking invitations, creating, regenerating and disabling the
  invite link, removing a member, and members added by invitation, invite link
  or verified-domain auto-join. Not yet covered: members provisioned by SSO
  (they have their own SSO audit stream) and the admin app's SSO user activation
  toggle.
- **Time zone.** There is no place model, so the organization's staff time zone
  is one control-plane column, `Organization.staffingTimeZone` (default `UTC`),
  chosen from a curated list of IANA zones at Staff, Time clock, Rules.
- **Overnight shifts.** Shifts store their own start and end instants, so a
  shift that crosses midnight needs no opening-hours model.
- **Cron.** Not changed here. See the cron entries under Runtime facts.

## Open points

1. Residency: confirm option C and the HR-event metadata rule, and whether KSA
   staff may hold a US login email.
2. Launch markets and who provides legal review.
3. Upstream policy: whether staffing slices go to the template repository or
   stay in this repository. File contents stay brand-neutral either way.
4. Retention periods (the placeholders above) and the backup and recovery
   objectives per node.
5. Environment variables and packages for later slices (`@repo/staffing`, the
   kiosk and email kill switches, a staff-principal secret) are decided in
   principle but not added to AGENTS.md until the slice that creates them.

How this is built: [Staff plan](../staffing-plan.md). Related:
[tenant data residency](../tenant-data-residency.md).
