# Validation Contract — Menuza Reservations Module

This validation contract defines the behavioral acceptance assertions for the
Menuza Reservations module across all 12 milestones, organized by surface/area
and cross-area end-to-end flows.

---

## Area: Foundation

### VAL-FND-001: `@repo/zoned-time` package extraction and `@repo/staffing` re-export parity

`packages/zoned-time` exists as a standalone workspace package with zero runtime
dependencies, exporting the time-zone helpers moved verbatim from
`packages/staffing/src/tz.ts` (`localParts`, `tzOffsetMs`, `zonedLocalToUtc`,
`addDays`, `dayOfWeek`, `businessDateOf`, `businessDayStartMs`).
`packages/staffing/src/tz.ts` re-exports `* from '@repo/zoned-time'` and
`packages/staffing/package.json` depends on `@repo/zoned-time`. Running Vitest
for `@repo/zoned-time` and `@repo/staffing` passes 100% of unit tests with no
regressions. Tool: `terminal`
(`CI=true npm run test -w @repo/zoned-time && CI=true npm run test -w @repo/staffing`)
Evidence: Vitest exit code 0 for both workspaces and inspection of
`packages/staffing/src/tz.ts`. Milestone: foundation

### VAL-FND-002: `@repo/reservations` pure domain boundaries, flags, permissions, and token claims

`packages/reservations` depends only on `zod` and `@repo/zoned-time` and
contains no I/O, network calls, UI strings, or `Date.now()` calls (clock is
always injected). `src/flags.ts` exports `RESERVATIONS_FLAG_KEYS`
(`reservations.enabled`, `reservations.online`, `reservations.waitlist`,
`reservations.payments`, `reservations.experiences`, `reservations.voice`),
`PLATFORM_FEE_FLAG_KEY`, `parsePlatformFeeBp`, and
`foldReservationsFeatures(raw)` where only literal boolean `true` activates a
flag and every child flag evaluates to `false` whenever `reservations.enabled`
is not `true`. `src/permissions.ts` and `src/token.ts` export the 8
`RESERVATIONS_PERMISSIONS`, `SENSITIVE_GRANTS` (`read:reservation_guest:any`,
`update:reservation_guest:any`, `update:reservation_payment:any`),
`grantsSatisfying` (where each `update:*` grant implies its matching `read:*`
grant), `restrictGrantsForImpersonation` (stripping all write and sensitive
grants), `RESERVATIONS_SCOPES` (`book`, `guests`, `setup`, `reports`,
`payments`), `SCOPE_GRANTS`, `reservationsTokenClaimsSchema`, and token TTL
constants (15 minutes standard, 5 minutes with any sensitive grant or
impersonation). Tool: `terminal` (`CI=true npm run test -w @repo/reservations`)
Evidence: Vitest output for `flags`, `permissions`, and `token` unit tests in
`@repo/reservations`, plus grep confirming zero `Date.now(` or `fetch(` in
`packages/reservations/src/`. Milestone: foundation

### VAL-FND-003: DST-safe time helpers across US, UK, and KSA time zones

`packages/reservations/src/time.ts` exports
`localToInstant(date, localMin, tz, opts)`,
`instantToLocal(ms, tz, dayStartMin)`, and
`currentBusinessDate(now, tz, dayStartMin)` and passes deterministic DST and
boundary tests across `America/New_York`, `America/Los_Angeles`,
`Europe/London`, and `Asia/Riyadh`. On spring-forward dates (`2027-03-14` in New
York/Los Angeles, `2027-03-28` in London), nonexistent gap minutes
(`02:00`–`02:59`) return `null` with `gap: 'skip'` (used for booking slots) and
resolve after the transition with `gap: 'after'` (used for service ends). On
fall-back dates (`2026-11-01` in New York/Los Angeles, `2026-10-25` in London),
repeated minutes (`01:00`–`01:59`) resolve once to the first occurrence with
`overlap: 'earlier'`, and a 90-minute booking starting at `01:15` ends at the
second `01:45`; `day_start_min` boundary transitions (`+/- 1` minute around
`240`) and `Asia/Riyadh` services crossing midnight (`localMin > 1440`)
round-trip accurately. Tool: `terminal`
(`cd /home/factory-user/repos/menuza/packages/reservations && CI=true npx vitest run src/time.test.ts`)
Evidence: Vitest test report showing all New York, Los Angeles, London, Riyadh,
and `day_start_min` boundary test cases passing. Milestone: foundation

### VAL-FND-004: Configuration Zod schemas and `validateConfig` checks

`packages/reservations/src/config/` defines strict Zod schemas for location
settings, areas, tables, combinations, services, turn times, pacing rules,
special days, blocks, and policies, and exports
`validateConfig(config: LocationConfig): ConfigIssue[]`. `validateConfig`
detects and reports configuration issues including: turn-time buckets that fail
to cover `1..party_max` contiguously or that overlap, table combinations with
fewer than 2 members or with archived/non-combinable members or duplicate member
sets within a location, services where
`first_seating_min <= last_seating_min <= end_min` or
`end_min - first_seating_min <= 1440` is violated, and invalid policy
references. Tool: `terminal`
(`cd /home/factory-user/repos/menuza/packages/reservations && CI=true npx vitest run src/config`)
Evidence: Vitest output confirming `validateConfig` returns empty issues for
valid configs and specific `ConfigIssue` codes for each invalid configuration
case. Milestone: foundation

### VAL-FND-005: Service resolution with special-day precedence

`packages/reservations/src/rules/resolve-services.ts` exports
`resolveServices(config, businessDate): ResolvedService[]` enforcing the exact
precedence `closed > replace > modified > online_closed > weekly template` (with
weekly templates ordered by latest `effective_from` date, then `priority`). A
`closed` special day resolves to no bookable services with the closed
reason/note; `replace` substitutes only the special day's linked services
(`special_day_id`); `modified` applies the validated `servicePatchSchema` patch
to the target `service_id`; and `online_closed` disables online booking for the
date while preserving staff services. Tool: `terminal`
(`cd /home/factory-user/repos/menuza/packages/reservations && CI=true npx vitest run src/rules`)
Evidence: Vitest output verifying all five precedence tiers, date-range
filtering (`effective_from`/`effective_to`), `days_mask` bitmask matching (bit 0
= Monday), and overnight services (`end_min > 1440`). Milestone: foundation

### VAL-FND-006: Availability engine, pacing, alternatives, and calendar summary

`packages/reservations/src/engine/` exports `buildDayState`,
`searchAvailability`, `alternatives`, and `calendarSummary`, computing slot
availability from loaded tables, combinations, service availability rules,
active occupancies (including previous-date spill-over and table
`reset_buffer_min`), live holds, blocks, and experience caps. Guest channels
(`online`, `native`, `voice_agent`) enforce `min_notice_min`,
`same_day_cutoff_min`, `horizon_days`, `release_local_min`,
`online_party_min`..`online_party_max`, per-interval online caps, pacing bucket
`max_covers`/`max_parties`, rolling window cover caps, concurrent-cover caps,
`walk_in_only`/`staff_only`/`unavailable` exclusions, and invariant I3 (never
borrowing capacity from staff overbooks). Staff channels (`phone`, `host`,
`walk_in`, `waitlist`) surface pacing breaches as warnings rather than hiding
slots, and allow `walk_in_only` tables only for `walk_in` and `waitlist`. Tool:
`terminal`
(`cd /home/factory-user/repos/menuza/packages/reservations && CI=true npx vitest run src/engine`)
Evidence: Vitest output covering slot generation, pacing rules, `alternatives`
(same-day nearby slots and other dates), `calendarSummary`, expired-hold
ignoring (I4), and overbook isolation (I3). Milestone: foh-core

### VAL-FND-007: Best-fit table assignment, bounded repair, reflow, and conflict detection

`packages/reservations/src/engine/assign.ts` and `conflicts.ts` export
`planBooking`, `reflow`, and `detectConflicts`. `planBooking` scores candidate
single tables and explicit combinations by wasted covers, table priority,
combination penalty, and gap packing, and when no direct table is free, runs
bounded repair (`tryRepair`) that moves only `soft` future reservations outside
`freeze_min` of start. Neither `tryRepair` nor `reflow` ever moves a `locked`
assignment, a reservation in
`partially_arrived`/`arrived`/`partially_seated`/`seated`/`finished`, or a
reservation within `freeze_min` of `start_at` (invariant I5). `detectConflicts`
identifies unassigned capacity-consuming bookings, table overlaps, bookings
outside resolved service hours, and bookings on archived/shrunk/blocked tables.
Tool: `terminal`
(`cd /home/factory-user/repos/menuza/packages/reservations && CI=true npx vitest run src/engine`)
Evidence: Vitest output for `assign.test.ts` and `conflicts.test.ts` confirming
best-fit scoring, bounded repair moves, reflow after table/duration changes, and
strict preservation of locked/arrived/frozen bookings. Milestone: foundation

### VAL-FND-008: Booking state machine, quick actions, policy math, message schedules, schemas, and error codes

`packages/reservations` exports `state-machine.ts` (all 13 statuses, allowed
actor transitions for G/O/S/V, `consumesCapacity`, `quickActionsFor`, and undo
rules including the 30-minute window for `finished -> seated`), `policy.ts`
(`selectPolicy`, `snapshotPolicy`, `cancellationTerms`, `noShowFee`,
`refundAmount`, `platformFeeMinor`, `proportionalFeeRefund`, `currencyMinimum`),
`messages.ts` (`MESSAGE_KINDS`, `scheduleFor` with quiet-hours
shifting/skipping, `dedupeKey`, `channelsFor` restricting SMS to region `us`
with opt-in), `phone.ts` (`normalizeGuestPhone` shared with
`apps/tenant-api/src/routes/auth.ts`), `schemas/` (strict Zod DTOs where every
deadline response includes ISO `expiresAt` and server `now`), and `errors.ts`
(all 24 stable error codes). Tool: `terminal`
(`CI=true npm run test -w @repo/reservations && cd /home/factory-user/repos/menuza/apps/tenant-api && CI=true npx vitest run src/routes/auth.test.ts`)
Evidence: Vitest output for `state-machine`, `policy`, `messages`, `phone`, and
`schemas` in `@repo/reservations`, plus `auth.test.ts` passing in `tenant-api`.
Milestone: foundation

### VAL-FND-009: Fast-check property tests against brute-force oracle and scale expansion budgets

`packages/reservations/src/testing/` (exported via `@repo/reservations/testing`)
provides fast-check arbitraries and a brute-force oracle for small floors (up to
8 tables and 12 bookings). Property test suites execute random operation
sequences (search, hold, book, modify, cancel, seat, finish, no-show, block,
settings edit, clock advance) and verify invariants I1 through I8 after every
step with zero soundness failures against the oracle. Scale tests at 120 tables,
80 combinations, and 900 bookings per day enforce the node-expansion budgets
(`200` per slot for search, `2,000` for book, `5,000` for reflow) and return
`"no fit"` rather than partial plans when a budget is exhausted. Tool:
`terminal` (`CI=true npm run test -w @repo/reservations`) Evidence: Vitest
property and scale test execution results in `@repo/reservations` showing zero
counterexamples for I1–I8 and adherence to the 200/2,000/5,000 expansion caps.
Milestone: foh-core

### VAL-FND-010: Tenant DB migration `0016_reservations_foundation.sql` tables, indexes, and constraints

`packages/tenant-db/drizzle/0016_reservations_foundation.sql` creates all 41
`rsv_*` tables defined in architecture sections 4.1–4.6
(`rsv_location_settings`, `rsv_areas`, `rsv_tables`, `rsv_table_combos`,
`rsv_table_combo_members`, `rsv_floor_elements`, `rsv_services`,
`rsv_service_availability`, `rsv_turn_times`, `rsv_pacing_rules`,
`rsv_special_days`, `rsv_blocks`, `rsv_policies`, `rsv_section_layouts`,
`rsv_sections`, `rsv_section_tables`, `rsv_section_assignments`,
`rsv_message_texts`, `rsv_experiences`, `rsv_experience_schedules`,
`rsv_guests`, `rsv_tags`, `rsv_guest_tags`, `rsv_guest_notes`,
`rsv_guest_merges`, `rsv_reservations`, `rsv_reservation_tags`,
`rsv_table_occupancies`, `rsv_holds`, `rsv_reservation_events`,
`rsv_service_notes`, `rsv_waitlist_entries`, `rsv_notify_requests`,
`rsv_messages`, `rsv_payments`, `rsv_outbox`, `rsv_journey_emissions`,
`rsv_idempotency_keys`, `rsv_day_versions`, `rsv_rate_counters`,
`rsv_audit_log`), exports their Drizzle table definitions from
`@repo/tenant-db`, and regenerates
`apps/tenant-api/workers/migrations.generated.ts`. CHECK constraints enforce
`1 <= min_covers <= max_covers <= 99`, `reset_buffer_min between 0 and 120`,
`first_seating_min <= last_seating_min <= end_min`,
`end_min - first_seating_min <= 1440`, `end_at > start_at`,
`party_size between 1 and 99`, and single-owner checks on
`rsv_service_availability`, `rsv_blocks`, and `rsv_table_occupancies`. Tool:
`terminal`
(`cd /home/factory-user/repos/menuza/packages/tenant-db && CI=true npx vitest run src/reservations-schema.test.ts`)
Evidence: Vitest `reservations-schema.test.ts` passing all table creation, CHECK
constraint, unique index, and Durable Object migration bundle checks. Milestone:
foundation

### VAL-FND-011: Tenant DB table-occupancy overlap triggers

The hand-appended SQLite triggers `rsv_occupancy_no_overlap_insert` and
`rsv_occupancy_no_overlap_update` in `0016_reservations_foundation.sql` abort
any `INSERT` or `UPDATE` on `rsv_table_occupancies` with
`'rsv_table_occupancies overlap'` when `NEW.active = 1 AND NEW.overbook = 0` and
another row on the same `table_id` with `active = 1 AND overbook = 0` has an
overlapping half-open interval
(`o.start_at < NEW.end_at AND NEW.start_at < o.end_at`). Adjacent intervals
(`o.end_at = NEW.start_at`), inactive rows (`active = 0`), and explicit staff
overbook rows (`overbook = 1`) succeed without triggering an abort. Tool:
`terminal`
(`cd /home/factory-user/repos/menuza/packages/tenant-db && CI=true npx vitest run src/reservations-schema.test.ts`)
Evidence: Schema trigger test cases verifying overlap abort on insert/update,
boundary-touching pass, `active = 0` pass, and `overbook = 1` bypass. Milestone:
foundation

### VAL-FND-012: Tenant DB hold single-conversion and append-only history triggers

In `0016_reservations_foundation.sql`, `rsv_holds_single_conversion` aborts any
`UPDATE` on a `rsv_holds` row whose `OLD.status = 'converted'`, and
`rsv_reservations.hold_id` is `UNIQUE`, guaranteeing a hold converts to a
booking at most once. Append-only triggers
`rsv_reservation_events_no_delete`/`_no_update` and
`rsv_audit_log_no_delete`/`_no_update` abort all deletes and updates except
redaction updates setting `data = '{"redacted":true}'` (or
`changes = '{"redacted":true}'`), while
`rsv_guest_merges_no_delete`/`_no_update` abort all updates and deletes
unconditionally. Tool: `terminal`
(`cd /home/factory-user/repos/menuza/packages/tenant-db && CI=true npx vitest run src/reservations-schema.test.ts`)
Evidence: Schema trigger test cases asserting SQLite `ABORT` on second hold
conversion, event/audit/merge delete or mutation, and success on redaction
update. Milestone: foundation

### VAL-FND-013: Control-plane migration `0025_reservations_foundation.sql` permissions and role grants

Control-plane migration
`packages/database/drizzle/0025_reservations_foundation.sql` seeds the 8
organization-context permissions (`read:reservation:any`,
`update:reservation:any`, `read:reservation_guest:any`,
`update:reservation_guest:any`, `read:reservation_settings:any`,
`update:reservation_settings:any`, `read:reservation_report:any`,
`update:reservation_payment:any`), grants all 8 to `org_role_admin`, and grants
0 of them to `org_role_member`. The same 8 permissions are mirrored in
`packages/database/setup-roles.ts` and
`packages/auth/src/organization-permissions.server.ts` (`ORG_PERMISSIONS`), with
a unit test verifying zero drift against `RESERVATIONS_PERMISSIONS`. Tool:
`terminal`
(`sqlite3 /home/factory-user/repos/menuza/packages/database/db/data.db "SELECT id, action, entity, access FROM Permission WHERE entity LIKE 'reservation%' ORDER BY id;" && sqlite3 /home/factory-user/repos/menuza/packages/database/db/data.db "SELECT A, COUNT(*) FROM _OrganizationPermissionToRole WHERE B LIKE 'org_perm_%_reservation%' GROUP BY A;"`)
Evidence: `sqlite3` query output on `data.db` (and local D1 via
`wrangler d1 execute DB --local`) showing 8 permission rows and
`org_role_admin|8` with no `org_role_member` rows, plus passing auth drift
tests. Milestone: foundation

### VAL-FND-014: Control-plane migration `0025` system-level feature flags

Migration `0025_reservations_foundation.sql` inserts system-level `ConfigFlag`
rows (`level = 'system'`, `organizationId = NULL`, `userId = NULL`,
`value = 'false'`) for all 6 keys (`reservations.enabled`,
`reservations.online`, `reservations.waitlist`, `reservations.payments`,
`reservations.experiences`, `reservations.voice`) using `WHERE NOT EXISTS` so
re-running or seeding never creates duplicate system rows. Tool: `terminal`
(`sqlite3 /home/factory-user/repos/menuza/packages/database/db/data.db "SELECT key, level, value, COUNT(*) FROM ConfigFlag WHERE key LIKE 'reservations.%' AND level='system' GROUP BY key, level, value ORDER BY key;"`)
Evidence: `sqlite3` output on `data.db` and local D1 showing exactly 1 system
row with `value = 'false'` for each of the 6 `reservations.*` flag keys.
Milestone: foundation

### VAL-FND-015: Role presets, implied permissions, and role-editor Reservations group gating

`apps/app/app/utils/reservations/role-presets.ts` defines presets including the
4 required presets: **Host** (`read:reservation:any`, `update:reservation:any`),
**Reservations manager** (all 7 grants except `update:reservation_payment:any`),
**Guest relations** (`read:reservation:any`, `read:reservation_guest:any`,
`update:reservation_guest:any`), and **Owner** (all 8 grants).
`apps/app/app/utils/organization/tenant-role-permissions.ts` includes
`RESERVATIONS_IMPLIED_PERMISSION_IDS` so selecting an `update:*` permission
implies its `read:*` permission, and
`apps/app/app/components/roles/tenant-role-access-manager.tsx` hides the
Reservations permission group when `reservations.enabled` is off for the
organization and displays it when `reservations.enabled` is `true`. Tool:
`agent-browser` (App `http://localhost:3001/acme/settings/members` or roles
editor with `reservations.enabled` toggled off vs on) and `terminal`
(`cd /home/factory-user/repos/menuza/apps/app && CI=true npx vitest run app/utils/reservations`)
Evidence: Vitest unit test output for `role-presets` and implied permissions,
plus `agent-browser` snapshot showing the Reservations permission group hidden
when `reservations.enabled` is `false` and visible when `true`. Milestone:
foundation Isolation: serial (toggles `reservations.enabled` org flag on `acme`)

### VAL-FND-016: App operator token mint route and claim rules

`GET /:orgSlug/reservations/token?scope=<book|guests|setup|reports|payments>` in
`apps/app/app/routes/_app+/$orgSlug_+/reservations+/token.ts` responds with
`Cache-Control: private, no-store` and returns
`{ jwt, tenantApiUrl, scope, grants, locationIds, features, expiresAt }`. The
signed HS256 JWT has header `typ: 'rsv+jwt'`,
`aud: 'tenant-api-reservations-operator'`, `role: 'operator'`, `region` matching
the org's `dataRegion` (`us` -> `http://localhost:3007` for `acme`, `ksa` ->
`http://localhost:3009` for `riyadh-grill`), `locationIds` from
`UserOrganization.locationScope` (`null` when `all`), folded `features`, and a
TTL of 15 minutes (900 s) for non-sensitive scopes (`book`, `setup`, `reports`)
or 5 minutes (300 s) when any sensitive grant is included (`guests`, `payments`)
or `impersonated` is true. Minting returns 404 when `reservations.enabled` is
off, 404/403 for `scope=payments` when `reservations.payments` is off, and 403
when the member lacks any grant in `SCOPE_GRANTS[scope]`. Tool: `terminal`
(`cd /home/factory-user/repos/menuza/apps/app && CI=true npx vitest run app/utils/reservations/token.test.ts`)
and `agent-browser` (logged in as `kody` on
`http://localhost:3001/acme/reservations/token?scope=setup`) Evidence: Vitest
token minting test suite output and decoded JWT header/payload from
`/acme/reservations/token?scope=setup` and
`/riyadh-grill/reservations/token?scope=setup`. Milestone: foundation

### VAL-FND-017: Tenant-api operator token verification, `rsvGuard`, and `org-router` routing

`apps/tenant-api/src/lib/reservations-auth.ts` and `reservations-guard.ts`
verify `rsv+jwt` tokens and enforce: valid signature with
`TENANT_OPERATOR_TOKEN`, `aud === 'tenant-api-reservations-operator'`,
`typ === 'rsv+jwt'`, `exp - iat` capped at 900 s (300 s if sensitive grants or
`impersonated`), token `region` matching the node's `DATA_REGION`, active and
provisioned organization, required scope and grants, 403 on write routes when
`impersonated` is true, 404 when a required child feature flag in `features` is
false, and `allowsLocation(locationId)` against `locationIds` (where `[]` allows
nothing). `apps/tenant-api/workers/org-router.ts` routes
`/operator/reservations/*` via `orgIdFromOperatorJwt`, `/reservations/*` via
`Origin` binding before the `?orgId=` fallback, and `/internal/reservations/*`,
`/api/reservations/*`, and `/api/voice/actions/*` via `orgIdFromJsonBody`. Tool:
`terminal`
(`cd /home/factory-user/repos/menuza/apps/tenant-api && CI=true npx vitest run src/lib/reservations-routing.test.ts src/lib/reservations-auth.test.ts`)
Evidence: Passing Vitest runs for `reservations-routing.test.ts` and
`reservations-auth.test.ts`. Milestone: foundation

### VAL-FND-018: App context endpoint and tenant-api `reservations-context` cache

App route `GET /resources/reservations/context?orgId=<id>` enforces
`requireInternalCommandAuth` first (rewriting unauthenticated 302s to 403), sets
`Cache-Control: private, no-store`, and returns a payload matching
`reservationsContextSchema` (folded `features`, `organization` with hex-only
`emailTheme`, active `locations` with `timeZone` and `currency`, `payments`,
`staffing`, and `voice`), with zero PII.
`apps/tenant-api/src/lib/reservations-context.ts` caches the context per org (5
min fresh, 24 h stale, 30 s failure cooldown, 3 s timeout, `redirect: 'error'`),
and `POST /internal/reservations/context-changed` with `INTERNAL_COMMAND_TOKEN`
immediately invalidates the cached entry for `orgId`. Tool: `curl` (against
`http://localhost:3001/resources/reservations/context?orgId=t58bgatqh3rv0s3movrecyj1`
without token -> 401/403, with `INTERNAL_COMMAND_TOKEN` -> 200 JSON) and
`terminal`
(`cd /home/factory-user/repos/menuza/apps/tenant-api && CI=true npx vitest run src/lib/reservations-context.test.ts`)
Evidence: HTTP status codes and response JSON from `curl` plus passing Vitest
tests for `reservations-context` and `context-changed`. Milestone: foundation

### VAL-FND-019: Serialized write gate `withReservationWrite` and day-version bumping

`apps/tenant-api/src/lib/reservations-write.ts` implements
`withReservationWrite`, which acquires `runExclusive(orgId)` and
`retryOnSqliteBusy`, opens a single SQLite transaction that sweeps expired
holds/payments/requests/waitlist offers, checks `rsv_idempotency_keys` by
`(scope, key)` and `request_hash` (returning the stored result on a matching
hash or `409 idempotency_conflict` on a mismatched hash), loads fresh day state,
runs the caller's mutation callback, increments `rsv_day_versions.version` for
affected business dates, and commits before running post-commit cache
invalidation and outbound hooks. Tool: `terminal`
(`cd /home/factory-user/repos/menuza/apps/tenant-api && CI=true npx vitest run src/lib/reservations-write.test.ts`)
Evidence: Passing Vitest tests for `withReservationWrite` verifying per-org
serialization, idempotency replay vs `409 idempotency_conflict`, expired-hold
sweep inside the transaction, and `rsv_day_versions` increments. Milestone:
foundation

### VAL-FND-020: Tenant-api security sweep (`reservations-security.test.ts`) and App guards test (`reservations-guards.test.ts`)

`apps/tenant-api/src/routes/reservations-security.test.ts` enumerates every
mounted route under `/operator/reservations/*` and `/reservations/*`, asserting
that every operator route returns 401 for missing, bad-secret, wrong-audience
(including staffing and `tenant-api-operator` tokens), wrong-`typ`, or over-long
TTL tokens; 403 for grantless, wrong-scope, or impersonated-write tokens; and
403/404 for cross-organization (`ORG_B`) or excluded-`locationIds` tokens, and
never 5xx. `apps/app/app/utils/reservations/reservations-guards.test.ts`
statically verifies that every loader and action under
`routes/_app+/$orgSlug_+/reservations+/` awaits `requireReservationsAccess`
first before reading any request body, defines no `clientLoader`/`clientAction`,
and that every `resources+/reservations.*` route calls
`requireInternalCommandAuth` (or `requireUserWithOrganizationPermission` on
`reservations.region-summary.ts`) before any `db` or `fetch` call. Tool:
`terminal`
(`cd /home/factory-user/repos/menuza/apps/tenant-api && CI=true npx vitest run src/routes/reservations-security.test.ts && cd /home/factory-user/repos/menuza/apps/app && CI=true npx vitest run app/utils/reservations/reservations-guards.test.ts`)
Evidence: Both Vitest guard and security sweep suites pass with 0 failures.
Milestone: foundation

### VAL-FND-021: App Reservations sidebar group and routes return 404 when `reservations.enabled` is off

When `reservations.enabled` is `false` (the default) for `acme`, logging into
the App at `http://localhost:3001/acme` as `kody` does not render a
"Reservations" group in the sidebar navigation. Direct navigation to
`/acme/reservations`, `/acme/reservations/settings`, and
`/acme/reservations/token?scope=setup` each returns HTTP 404. Tool:
`agent-browser` (logged in as `kody` on `http://localhost:3001/acme` with
`reservations.enabled` set to `false`) Evidence: Sidebar accessibility snapshot
showing no "Reservations" group and 404 responses on `/acme/reservations` and
`/acme/reservations/settings`. Milestone: foundation Isolation: serial (requires
`reservations.enabled = false` on `acme`)

### VAL-FND-022: App Reservations sidebar group and `_layout.tsx` shell when `reservations.enabled` is on

When `reservations.enabled` is set to `true` for `acme` and `riyadh-grill`,
logging into `http://localhost:3001/acme` and
`http://localhost:3001/riyadh-grill` as `kody` displays the "Reservations" group
in the sidebar navigation. Opening `/<orgSlug>/reservations` runs the
`_layout.tsx` guard (`requireReservationsAccess`), mounts
`ReservationsClientProvider` (hiding the location picker when the organization
has only one location), and redirects `_index.tsx` to the first allowed section
for the operator. Tool: `agent-browser` (logged in as `kody` on
`http://localhost:3001/acme/reservations` and
`http://localhost:3001/riyadh-grill/reservations` with
`reservations.enabled = true`) Evidence: Browser URL redirect to the first
allowed section and accessibility snapshot of the Reservations sidebar group and
layout shell on both `acme` and `riyadh-grill`. Milestone: foundation Isolation:
serial (sets `reservations.enabled = true` on `acme` and `riyadh-grill`)

### VAL-FND-023: Idempotent `seed:reservations` script for US (`acme`) and KSA (`riyadh-grill`)

`npm run seed:reservations -w tenant-api -- acme` and
`TENANT_DB_DIR=/home/factory-user/repos/menuza/packages/database/db/ksa npm run seed:reservations -w tenant-api -- riyadh-grill`
execute without error against the local US and KSA tenant SQLite databases,
applying migrations if needed and seeding foundational location settings, areas,
tables, combinations, services, and turn times idempotently when run twice in
succession. Tool: `terminal`
(`cd /home/factory-user/repos/menuza && npm run seed:reservations -w tenant-api -- acme && npm run seed:reservations -w tenant-api -- acme && TENANT_DB_DIR=/home/factory-user/repos/menuza/packages/database/db/ksa npm run seed:reservations -w tenant-api -- riyadh-grill`)
Evidence: Command exit code 0 on first and second invocation and stable row
counts in `rsv_location_settings`, `rsv_areas`, and `rsv_tables` in both tenant
DB files. Milestone: foundation Isolation: serial (writes demo seed data to
`acme` and `riyadh-grill` tenant DBs)

### VAL-FND-024: ADR 048 draft and reservations documentation skeletons

The repository contains the draft ADR
`docs/decisions/048-reservations-data-residency.md` (covering regional guest PII
and settings placement, browser-direct operator tokens, `Origin`-bound public
routes, guest identity without login, payments split, shared org alarm,
messaging regions, retention/erasure, flags, location scope reuse, and platform
fee), skeleton docs `docs/reservations.md`, `docs/reservations-contract.md`, and
`docs/reservations-plan.md`, and updated `docs/permissions.md` listing the 8
reservations permissions and 6 feature flags. Tool: `terminal` (verify file
existence and non-empty headings in
`docs/decisions/048-reservations-data-residency.md`, `docs/reservations.md`,
`docs/reservations-contract.md`, `docs/reservations-plan.md`, and
`docs/permissions.md`) Evidence: Presence of all five documentation files with
required sections verified via file inspection. Milestone: foh-core

---

## Area: Setup

### VAL-SETUP-001: Reservations card on the location settings page

With `reservations.enabled = true` on `acme`, opening the location settings page
`http://localhost:3001/acme/settings/locations/<locationId>` displays a
"Reservations" card that links directly to
`/acme/reservations/settings?location=<locationId>`, without storing any
reservation settings columns on the control-plane `OrganizationLocation` table.
When `reservations.enabled` is `false`, the Reservations card is not rendered on
the location settings page. Tool: `agent-browser`
(`http://localhost:3001/acme/settings/locations/<locationId>`) Evidence:
Accessibility snapshot showing the Reservations card and its link target when
`reservations.enabled` is `true`, and absence when `false`. Milestone: foh-core
Isolation: serial (toggles `reservations.enabled` when checking hidden state)

### VAL-SETUP-002: Location booking grid, horizon, and daily release time settings

On `/acme/reservations/settings` (`settings._index.tsx`), an operator with
`update:reservation_settings:any` can toggle location `enabled` and
`online_enabled`, set `day_start_min`, choose `interval_min` from
`{5, 10, 15, 20, 30, 60}`, set `horizon_days` (`1..365`), and configure
`release_local_min`. Saving sends
`PUT /operator/reservations/setup/locations/:id/settings` to
`http://localhost:3007`, increments `rsv_location_settings.version`, writes an
`rsv_audit_log` row with `action = 'settings.update'`, and persists the values
across a page reload; invalid grid values (such as `interval_min: 12` or
`horizon_days: 400`) are rejected with HTTP 400. Tool: `agent-browser`
(`http://localhost:3001/acme/reservations/settings`) and `curl`
(`PUT http://localhost:3007/operator/reservations/setup/locations/<id>/settings`)
Evidence: Browser network capture showing 200 response with incremented
`version`, persisted form values after reload, `rsv_audit_log` row in SQLite,
and 400 response on invalid `interval_min`. Milestone: foh-core Isolation:
serial (updates `rsv_location_settings` on `acme`)

### VAL-SETUP-003: Minimum notice and same-day cutoff settings

In `settings._index.tsx` and via
`PUT /operator/reservations/setup/locations/:id/settings`, the operator can
configure `min_notice_min` (online lead time in minutes) and
`same_day_cutoff_min` (optional wall-clock minute cutoff for same-day online
bookings, or cleared to `null`). Saved values persist in `rsv_location_settings`
and immediately govern `searchAvailability` for the `online` channel on that
location. Tool: `agent-browser`
(`http://localhost:3001/acme/reservations/settings`) and `terminal`
(`cd /home/factory-user/repos/menuza/apps/tenant-api && CI=true npx vitest run src/routes/reservations-setup.test.ts`)
Evidence: Persisted `min_notice_min` and `same_day_cutoff_min` in
`GET /operator/reservations/setup/locations/:id/settings` and passing route
tests. Milestone: foh-core Isolation: serial (updates `rsv_location_settings` on
`acme`)

### VAL-SETUP-004: Party limits, large-party mode, and seating preference mode

In `settings._index.tsx` and via
`PUT /operator/reservations/setup/locations/:id/settings`, the operator can
configure `online_party_min`, `online_party_max`, staff `party_max`,
`large_party_mode` (`contact` or `request`), localized `large_party_note_i18n`,
`request_holds_capacity`, `request_deadline_hours`, `contact_phone`,
`public_note_i18n`, and `seating_pref_mode` (`off`, `preferred`, or `strict`).
The API rejects configurations where `online_party_min > online_party_max` or
`online_party_max > party_max` with HTTP 400. Tool: `agent-browser`
(`http://localhost:3001/acme/reservations/settings`) and `curl`
(`PUT http://localhost:3007/operator/reservations/setup/locations/<id>/settings`)
Evidence: Updated fields returned by
`GET /operator/reservations/setup/locations/:id/settings` after save and 400
validation response when `online_party_min > online_party_max`. Milestone:
foh-core Isolation: serial (updates `rsv_location_settings` on `acme`)

### VAL-SETUP-005: Hold durations, freeze window, late grace, and opt-in auto no-show

In `settings._index.tsx` and via
`PUT /operator/reservations/setup/locations/:id/settings`, the operator can
configure `hold_minutes` (`3..20`, default 7), `payment_hold_minutes` (`10..60`,
default 20), `voice_hold_minutes` (`5..30`, default 15), `freeze_min` (default
30), `late_grace_min` (default 15), and opt-in `auto_no_show_after_min` (`null`
when off, or positive integer minutes when enabled). Out-of-range hold durations
(e.g., `hold_minutes: 1` or `25`) are rejected with HTTP 400. Tool:
`agent-browser` (`http://localhost:3001/acme/reservations/settings`) and `curl`
(`PUT http://localhost:3007/operator/reservations/setup/locations/<id>/settings`)
Evidence: Persisted values in `rsv_location_settings` when toggled between
`auto_no_show_after_min = null` and `45`, and 400 error on out-of-range
`hold_minutes`. Milestone: foh-core Isolation: serial (updates
`rsv_location_settings` on `acme`)

### VAL-SETUP-006: Per-phone booking limits, guest modify cutoff, and contact/course status toggles

In `settings._index.tsx` and via
`PUT /operator/reservations/setup/locations/:id/settings`, the operator can
configure `max_active_per_phone` (default 3), `block_same_phone_overlap`
(boolean), `guest_modify_cutoff_min` (default 120), `contact_statuses_enabled`
(boolean), and `course_statuses_enabled` (boolean). Saving updates
`rsv_location_settings` and reflects the updated toggles immediately in the
settings UI and `GET /operator/reservations/setup/locations/:id/settings`. Tool:
`agent-browser` (`http://localhost:3001/acme/reservations/settings`) Evidence:
Accessibility snapshot and network response confirming saved values for
`max_active_per_phone`, `block_same_phone_overlap`, `guest_modify_cutoff_min`,
`contact_statuses_enabled`, and `course_statuses_enabled`. Milestone: foh-core
Isolation: serial (updates `rsv_location_settings` on `acme`)

### VAL-SETUP-007: Optimistic concurrency (`expectedVersion`) on location settings updates

Submitting `PUT /operator/reservations/setup/locations/:id/settings` with an
`expectedVersion` that does not match the current
`rsv_location_settings.version` fails with HTTP `409` and
`{ error: 'stale_version' }` (including the current row), leaving the database
row unchanged. In the App UI, a `stale_version` response surfaces a conflict
notification and reloads the latest settings. Tool: `curl`
(`PUT http://localhost:3007/operator/reservations/setup/locations/<id>/settings`
with stale `expectedVersion: 1`) Evidence: HTTP 409 response with
`error: "stale_version"` and unchanged row version in `rsv_location_settings`.
Milestone: foh-core Isolation: serial (tests version conflict on `acme` location
settings)

### VAL-SETUP-008: Dining areas CRUD and localized labels

On `/acme/reservations/settings/tables` (`settings.tables.tsx`) and via
`/operator/reservations/setup/...`, the operator can create, edit, reorder
(`sort`), and archive dining areas (`rsv_areas`) with `name`, localized
`name_i18n`, `online_bookable`, `guest_selectable`, `canvas_w` (default 1200),
and `canvas_h` (default 800). Archived areas have `archived_at` set and are
excluded from active booking configuration while preserving historical foreign
keys. Tool: `agent-browser`
(`http://localhost:3001/acme/reservations/settings/tables`) Evidence: UI list
and tenant-api response showing a newly created dining area, updated sort/flags,
and `archived_at` populated upon archiving. Milestone: foh-core Isolation:
serial (modifies `rsv_areas` on `acme`)

### VAL-SETUP-009: Tables CRUD, capacity bounds, and unique active label constraint

On `/acme/reservations/settings/tables`, the operator can create, edit, and
archive tables (`rsv_tables`) within a dining area with `label`, `min_covers`,
`max_covers`, `online_bookable`, `combinable`, `priority`, `reset_buffer_min`
(`0..120`), and `shape` (`round`, `square`, `rect`, `booth`, `bar`). Creating or
updating a table with `min_covers > max_covers`, `max_covers > 99`,
`reset_buffer_min > 120`, or a `label` that duplicates another non-archived
table in the same location is rejected with HTTP 400/409, whereas reusing the
label of an archived table succeeds. Tool: `agent-browser`
(`http://localhost:3001/acme/reservations/settings/tables`) and `curl` (against
`http://localhost:3007/operator/reservations/setup/...`) Evidence: Created table
row in `rsv_tables`, 400/409 rejection on duplicate active label or invalid
cover range, and 200 success when reusing an archived table's label. Milestone:
foh-core Isolation: serial (modifies `rsv_tables` on `acme`)

### VAL-SETUP-010: Table combinations CRUD and member set validation

On `/acme/reservations/settings/tables`, the operator can create, edit, and
archive explicit table combinations (`rsv_table_combos` and
`rsv_table_combo_members`) specifying `label`, `min_covers`, `max_covers`,
`online_bookable`, `priority`, and member `tableIds`. The service rejects any
combination that has fewer than 2 members, references an archived or
non-`combinable` table, or has the exact same member table set as another active
combination in the same location. Tool: `agent-browser`
(`http://localhost:3001/acme/reservations/settings/tables`) and `curl` (against
`http://localhost:3007/operator/reservations/setup/...`) Evidence: Persisted
combination in `rsv_table_combos` and `rsv_table_combo_members`, plus 400/409
responses when submitting a 1-table combo, a non-combinable member, or a
duplicate member set. Milestone: foh-core Isolation: serial (modifies
`rsv_table_combos` on `acme`)

### VAL-SETUP-011: Full-screen floor plan editor local draft and explicit atomic Save

Opening `/acme/reservations/settings/floor-plan` (`settings.floor-plan.tsx`)
renders the full-screen floor plan editor loaded from
`GET /operator/reservations/setup/locations/:id/floor-plan`. Moving tables or
adding elements edits a local draft only: navigating away or reloading without
clicking **Save** leaves `rsv_tables`, `rsv_floor_elements`, and
`floor_plan_version` unchanged in SQLite. Clicking **Save** sends
`PUT /operator/reservations/setup/locations/:id/floor-plan` with
`{ floorPlanVersion, areas, tables, combos, elements }`, atomically persists the
floor plan, increments `rsv_location_settings.floor_plan_version`, and writes
`rsv_audit_log` with `action = 'floor_plan.save'`. Tool: `agent-browser`
(`http://localhost:3001/acme/reservations/settings/floor-plan`) Evidence:
Verification that unsaved edits disappear on reload, followed by an explicit
Save that returns 200 with incremented `floorPlanVersion` and records
`floor_plan.save` in `rsv_audit_log`. Milestone: foh-core Isolation: serial
(saves floor plan on `acme`)

### VAL-SETUP-012: Floor plan editor stale `floorPlanVersion` 409 conflict

When `PUT /operator/reservations/setup/locations/:id/floor-plan` is sent with a
`floorPlanVersion` older than the current
`rsv_location_settings.floor_plan_version` (simulating a concurrent save by
another operator), tenant-api refuses the write with HTTP `409` and
`error: 'stale_version'` without modifying any table or element rows, and the
floor plan editor displays a conflict banner/dialog. Tool: `curl`
(`PUT http://localhost:3007/operator/reservations/setup/locations/<id>/floor-plan`
with stale `floorPlanVersion`) and `agent-browser`
(`http://localhost:3001/acme/reservations/settings/floor-plan`) Evidence: HTTP
409 `{ error: "stale_version" }` response and conflict alert rendered in the
floor plan editor UI. Milestone: foh-core Isolation: serial (tests floor plan
version conflict on `acme`)

### VAL-SETUP-013: Floor plan table drag with grid snap, resize, and rotation

In `/acme/reservations/settings/floor-plan`, dragging a table on the canvas
snaps its `x` and `y` coordinates to the editor grid, dragging its resize
handles updates `w` and `h`, and adjusting its rotation control updates
`rotation` (`0..359`). Saving the floor plan and reloading
`/acme/reservations/settings/floor-plan` renders the table at the exact saved
`x`, `y`, `w`, `h`, and `rotation` values. Tool: `agent-browser`
(`http://localhost:3001/acme/reservations/settings/floor-plan`) Evidence:
`GET /operator/reservations/setup/locations/:id/floor-plan` response and DOM
style inspection (`left`, `top`, `width`, `height`, `transform`) before and
after reload. Milestone: foh-core Isolation: serial (modifies table geometry on
`acme`)

### VAL-SETUP-014: Floor plan keyboard arrow-key nudge and Shift-arrow 10-unit nudge

In `/acme/reservations/settings/floor-plan`, focusing a selected table on the
canvas and pressing an arrow key (`ArrowRight`, `ArrowDown`, `ArrowLeft`,
`ArrowUp`) nudges the table's draft coordinate by 1 step, while holding `Shift`
with an arrow key nudges it by 10 canvas units. Saving persists the nudged
`x`/`y` coordinates to `rsv_tables`. Tool: `agent-browser`
(`http://localhost:3001/acme/reservations/settings/floor-plan`) Evidence: Table
`(x, y)` coordinates before keypress, after single arrow key, after
`Shift+Arrow`, and in the persisted `PUT /floor-plan` payload. Milestone:
foh-core Isolation: serial (modifies table geometry on `acme`)

### VAL-SETUP-015: Floor plan decor elements (`wall`, `bar`, `door`, `window`, `label`, `plant`, `zone`)

In `/acme/reservations/settings/floor-plan`, the operator can add, position,
resize, rotate, label, and delete non-bookable decor elements
(`rsv_floor_elements`) of every supported kind (`wall`, `bar`, `door`, `window`,
`label`, `plant`, `zone`). Saving persists all elements in `rsv_floor_elements`
for the area without creating bookable tables in `rsv_tables`. Tool:
`agent-browser` (`http://localhost:3001/acme/reservations/settings/floor-plan`)
and `terminal`
(`cd /home/factory-user/repos/menuza/apps/tenant-api && CI=true npx vitest run src/routes/reservations-setup.test.ts`)
Evidence: `GET /operator/reservations/setup/locations/:id/floor-plan` response
showing persisted `elements` across the 7 kinds and `rsv_floor_elements` rows in
SQLite. Milestone: foh-core Isolation: serial (modifies `rsv_floor_elements` on
`acme`)

### VAL-SETUP-016: Floor plan editor in Arabic RTL mirrors chrome without mirroring room geometry

Opening the floor plan editor in Arabic
(`http://localhost:3001/riyadh-grill/reservations/settings/floor-plan?lng=ar` or
`/acme/reservations/settings/floor-plan?lng=ar`) sets `dir="rtl"` on the
document so the App sidebar, toolbar, and inspector panels mirror for
right-to-left reading, while the floor plan room canvas keeps canonical
left-to-right geometry (`dir="ltr"` on the canvas container and identical
`left`/`top` pixel positioning for tables at `(x, y)` as in `lng=en`). Tool:
`agent-browser`
(`http://localhost:3001/acme/reservations/settings/floor-plan?lng=en` vs
`?lng=ar`) Evidence: Computed `dir` and bounding/style coordinates of the floor
canvas and a reference table in `lng=en` vs `lng=ar` confirming identical
canonical `(x, y)` geometry alongside RTL chrome. Milestone: foh-core

### VAL-SETUP-017: Floor plan Save unassigns and reflows future bookings on archived or shrunk tables

When `PUT /operator/reservations/setup/locations/:id/floor-plan` archives a
table or reduces its `max_covers` below the `party_size` of a future reservation
assigned to that table, the save transaction deactivates the invalid occupancy,
runs `reflow` to move soft future bookings to alternative fitting tables where
available, leaves any unplaceable or locked booking unassigned as a conflict,
bumps `rsv_day_versions`, and returns the resulting `conflicts` array in the
response. Tool: `terminal`
(`cd /home/factory-user/repos/menuza/apps/tenant-api && CI=true npx vitest run src/routes/reservations-setup.test.ts`)
Evidence: Vitest test in `reservations-setup.test.ts` verifying that
shrinking/archiving an occupied table via `PUT /floor-plan` reflows a soft
booking to a free table and reports an unplaceable booking in `conflicts`.
Milestone: foh-core

### VAL-SETUP-018: Services (dining periods) and weekly templates CRUD

On `/acme/reservations/settings/services` (`settings.services.tsx`) and via
`/operator/reservations/setup/services`, the operator can create, edit, and
archive dining services (`rsv_services`) with `name`, `name_i18n`, `days_mask`
(bit 0 = Monday), `first_seating_min`, `last_seating_min`, `end_min` (supporting
overnight values `> 1440` where `end_min - first_seating_min <= 1440`), optional
`interval_min`, `effective_from`/`effective_to`, `priority`, `online_enabled`,
`online_from_min`/`online_to_min`, `max_party`, `online_party_max`,
`online_cap_per_interval`, `concurrent_covers_cap`, `allow_overrun_past_end`,
and theme `color_token`. Invalid time ordering
(`first_seating_min > last_seating_min` or `last_seating_min > end_min`) is
rejected with HTTP 400. Tool: `agent-browser`
(`http://localhost:3001/acme/reservations/settings/services`) and `curl`
(against `http://localhost:3007/operator/reservations/setup/services`) Evidence:
Created and updated service rows in `GET /operator/reservations/setup/services`,
UI rendering on `settings.services.tsx`, and 400 response on invalid time
bounds. Milestone: foh-core Isolation: serial (modifies `rsv_services` on
`acme`)

### VAL-SETUP-019: Turn times by party size CRUD and contiguous bucket validation

On `/acme/reservations/settings/services` and via
`/operator/reservations/setup/turn-times`, the operator can configure
location-default (`service_id = null`) and per-service turn-time buckets
(`rsv_turn_times`) with `party_min`, `party_max`, `minutes` (`15..480`), and
optional `days_mask`. The API and `validateConfig` reject overlapping buckets or
`minutes` outside `15..480`, and flag any gap in `1..party_max` coverage. Tool:
`agent-browser` (`http://localhost:3001/acme/reservations/settings/services`)
and `curl` (against
`http://localhost:3007/operator/reservations/setup/turn-times`) Evidence: Saved
turn-time buckets in `rsv_turn_times` for `acme`, plus 400 rejection when
submitting `minutes: 10` or `minutes: 600` or overlapping ranges. Milestone:
foh-core Isolation: serial (modifies `rsv_turn_times` on `acme`)

### VAL-SETUP-020: Pacing rules CRUD (`max_covers`, `max_parties`, rolling window, and channel scope)

On `/acme/reservations/settings/services` and via
`/operator/reservations/setup/pacing`, the operator can create, edit, and delete
per-service pacing rules (`rsv_pacing_rules`) with optional sub-service window
`from_min`/`to_min`, `bucket_min` (default 15), `max_covers`, `max_parties`,
`rolling_min`, `rolling_max_covers`, and `channel` (`all` or `online`). Saved
pacing rules persist in `rsv_pacing_rules` and cap slot availability in
`searchAvailability` accordingly. Tool: `agent-browser`
(`http://localhost:3001/acme/reservations/settings/services`) and `curl`
(against `http://localhost:3007/operator/reservations/setup/pacing`) Evidence:
Created, updated, and deleted `rsv_pacing_rules` rows via UI and API. Milestone:
foh-core Isolation: serial (modifies `rsv_pacing_rules` on `acme`)

### VAL-SETUP-021: Per-service table availability modes (`online`, `staff_only`, `walk_in_only`, `unavailable`)

On `/acme/reservations/settings/services` and via
`/operator/reservations/setup/service-availability`, the operator can create,
update, and delete `rsv_service_availability` rules targeting an area
(`area_id`), a single table (`table_id`), or a combination (`combo_id`) for a
given `service_id` and optional `from_min`/`to_min` window, setting `mode` to
`online`, `staff_only`, `walk_in_only`, or `unavailable`. Submitting a rule with
zero or more than one target among `area_id`, `table_id`, and `combo_id` is
rejected with HTTP 400. Tool: `agent-browser`
(`http://localhost:3001/acme/reservations/settings/services`) and `curl`
(against
`http://localhost:3007/operator/reservations/setup/service-availability`)
Evidence: Persisted `rsv_service_availability` rows for each of the 4 modes and
400 error when both `area_id` and `table_id` are supplied. Milestone: foh-core
Isolation: serial (modifies `rsv_service_availability` on `acme`)

### VAL-SETUP-022: Special days CRUD (`closed`, `online_closed`, `modified`, `replace`)

On `/acme/reservations/settings/special-days` (`settings.special-days.tsx`) and
via `/operator/reservations/setup/special-days`, the operator can create, edit,
and delete special-day rules (`rsv_special_days`) for a date range
`from_date..to_date` with `name`, `public_note_i18n`, and `kind` set to
`closed`, `online_closed`, `modified` (targeting a `service_id` with a validated
`patch`), or `replace` (with replacement services linked via `special_day_id`).
Creating or deleting a special day bumps `rsv_day_versions` for the affected
dates. Tool: `agent-browser`
(`http://localhost:3001/acme/reservations/settings/special-days`) and `curl`
(against `http://localhost:3007/operator/reservations/setup/special-days`)
Evidence: Persisted `rsv_special_days` rows for all 4 kinds and incremented
`rsv_day_versions` on affected dates. Milestone: foh-core Isolation: serial
(modifies `rsv_special_days` on `acme`)

### VAL-SETUP-023: Table and area blocks CRUD, occupancy expansion, and soft-booking reflow

On `/acme/reservations/settings/special-days` and via
`GET/POST/DELETE /operator/reservations/setup/blocks`, the operator can create
and delete blocks (`rsv_blocks`) on either a specific `table_id` or an entire
`area_id` for a `business_date`, `[start_at, end_at)` window, `reason`, and
`note`. Creating a block writes `rsv_table_occupancies` rows of `kind = 'block'`
(expanding an `area_id` block to every active table in that area), increments
`rsv_day_versions`, and reflows any soft future bookings off the blocked tables;
deleting the block removes/deactivates its occupancy rows and increments
`rsv_day_versions`. Tool: `agent-browser`
(`http://localhost:3001/acme/reservations/settings/special-days`) and `terminal`
(`cd /home/factory-user/repos/menuza/apps/tenant-api && CI=true npx vitest run src/routes/reservations-setup.test.ts`)
Evidence: `rsv_blocks` and `rsv_table_occupancies` (`kind = 'block'`) rows
created for single-table and area blocks, reflow verification in
`reservations-setup.test.ts`, and cleanup on `DELETE /blocks/:id`. Milestone:
foh-core Isolation: serial (creates and deletes `rsv_blocks` on `acme`)

### VAL-SETUP-024: Setup validation view surfaces `validateConfig` issues

`GET /operator/reservations/setup/locations/:id/validate` runs `validateConfig`
against the location's current settings, areas, tables, combinations, services,
and turn times, and the validation panel on `/acme/reservations/settings`
displays any detected configuration warnings or errors (such as a missing
turn-time party-size bucket or a service with no bookable tables). When the
configuration is complete and valid, the panel reports zero issues. Tool:
`agent-browser` (`http://localhost:3001/acme/reservations/settings`) and `curl`
(`GET http://localhost:3007/operator/reservations/setup/locations/<id>/validate`)
Evidence: JSON response from `/validate` and UI validation status when a
turn-time gap exists vs when resolved. Milestone: foh-core Isolation: serial
(temporarily introduces and resolves a config gap on `acme`)

### VAL-SETUP-025: Setup conflicts view surfaces `detectConflicts` items

`GET /operator/reservations/setup/locations/:id/conflicts` inspects upcoming
business dates using `detectConflicts` and returns any reservations that are
unassigned, overlapping, outside resolved service hours (e.g., after a service
window is narrowed or a `closed` special day is added), or seated on
archived/blocked tables, and the conflicts panel on
`/acme/reservations/settings` lists each conflict with its date and reason code.
Tool: `terminal`
(`cd /home/factory-user/repos/menuza/apps/tenant-api && CI=true npx vitest run src/routes/reservations-setup.test.ts`)
and `agent-browser` (`http://localhost:3001/acme/reservations/settings`)
Evidence: Vitest test and UI conflicts view showing conflicts returned by
`GET /operator/reservations/setup/locations/:id/conflicts`. Milestone: foh-core

### VAL-SETUP-026: Time-zone mismatch banner and explicit `rederive-times` action

When the control-plane location time zone (`OrganizationLocation.timeZone` in
the cached context) differs from `rsv_location_settings.time_zone`,
`/acme/reservations/settings` displays a time-zone mismatch warning banner
(`tz_mismatch`). Clicking the **Re-derive times** action calls
`POST /operator/reservations/setup/locations/:id/rederive-times`, which updates
`rsv_location_settings.time_zone` and `tz_synced_at`, recomputes `start_at` and
`end_at` for future reservations from their stored
`business_date + local_start_min` intent (invariant I11), updates their
`rsv_table_occupancies` intervals, bumps `rsv_day_versions`, and clears the
mismatch banner. Tool: `terminal`
(`cd /home/factory-user/repos/menuza/apps/tenant-api && CI=true npx vitest run src/routes/reservations-setup.test.ts`)
and `agent-browser` (`http://localhost:3001/acme/reservations/settings`)
Evidence: Mismatch banner visible when `rsv_location_settings.time_zone` is set
to a different zone than the location context, followed by
`POST /rederive-times` updating `time_zone`, re-deriving future
`start_at`/`end_at` instants, and dismissing the banner. Milestone: foh-core
Isolation: serial (temporarily alters `rsv_location_settings.time_zone` on
`acme` and re-derives)

### VAL-SETUP-027: Read-only setup access with `read:reservation_settings:any` only

An operator whose token carries `read:reservation_settings:any` without
`update:reservation_settings:any` (or an impersonated operator token) can load
`/acme/reservations/settings*` and call every
`GET /operator/reservations/setup/*` route (receiving 200), while
save/create/delete controls in the UI are disabled or hidden and any direct
`POST`, `PUT`, `PATCH`, or `DELETE` call to `/operator/reservations/setup/*` is
refused by `rsvGuard` with HTTP `403 forbidden`. Tool: `curl` (against
`http://localhost:3007/operator/reservations/setup/locations/<id>/settings` with
a read-only `setup` token) and `terminal`
(`cd /home/factory-user/repos/menuza/apps/tenant-api && CI=true npx vitest run src/routes/reservations-security.test.ts`)
Evidence: `GET` returns 200 while `PUT /locations/:id/settings`,
`PUT /locations/:id/floor-plan`, and `POST /services` return 403 `forbidden`.
Milestone: foh-core

### VAL-SETUP-028: Cross-organization and cross-location isolation across all setup routes

Sending a valid `setup` operator token for `riyadh-grill` (or another org
`ORG_B`) to `acme`'s setup routes on port 3007, or sending an `acme` `setup`
token whose `locationIds` array excludes the target `:locationId`, is refused
with HTTP 403 or 404 on every route in `routes/reservations-setup.ts`.
`apps/tenant-api/src/routes/reservations-security.test.ts` and
`reservations-setup.test.ts` include cross-organization (`ORG_B`) and
cross-location cases for every setup route tail segment. Tool: `curl` (sending a
`riyadh-grill` token to
`http://localhost:3007/operator/reservations/setup/locations/<acmeLocationId>/settings`)
and `terminal`
(`cd /home/factory-user/repos/menuza/apps/tenant-api && CI=true npx vitest run src/routes/reservations-security.test.ts src/routes/reservations-setup.test.ts`)
Evidence: HTTP 401/403/404 response from `curl` and 100% pass rate on
`reservations-security.test.ts` and `reservations-setup.test.ts`. Milestone:
foh-core

### VAL-SETUP-029: US (`acme` on 3007) and KSA (`riyadh-grill` on 3009) regional setup parity

With `reservations.enabled = true` on `riyadh-grill` and `seed:reservations` run
for `riyadh-grill`, opening
`http://localhost:3001/riyadh-grill/reservations/settings`, `/settings/tables`,
`/settings/floor-plan`, `/settings/services`, and `/settings/special-days` in
`agent-browser` mints a KSA `rsv+jwt` token
(`tenantApiUrl: http://localhost:3009`, `region: 'ksa'`) and reads and saves
settings (`time_zone: 'Asia/Riyadh'`, `currency: 'SAR'`), floor plans, services,
turn times, pacing, and special days directly against port 3009
(`packages/database/db/ksa/tenant_<orgId>.db`), with zero requests or rows
written to the US node on port 3007. Tool: `agent-browser`
(`http://localhost:3001/riyadh-grill/reservations/settings`) and `terminal`
(`sqlite3 /home/factory-user/repos/menuza/packages/database/db/ksa/tenant_ru0dm42cud9scs4g2duep21c.db "SELECT location_id, time_zone, currency, enabled, online_enabled FROM rsv_location_settings;"`)
Evidence: Captured browser requests targeting
`http://localhost:3009/operator/reservations/setup/...` and `sqlite3` output
from KSA tenant DB showing `Asia/Riyadh` and `SAR`. Milestone: foh-core
Isolation: serial (updates setup tables on `riyadh-grill`)

### VAL-SETUP-030: Setup validation errors never echo rejected input values

When any `/operator/reservations/setup/*` mutation receives invalid input (for
example `interval_min: "ECHO_SECRET_SENTINEL_999"` on
`PUT /locations/:id/settings`, `shape: "ECHO_SECRET_SENTINEL_999"` on table
creation, or `from_date: "ECHO_SECRET_SENTINEL_999"` on `POST /special-days`),
tenant-api responds with HTTP 400 containing `{ error: 'invalid', ... }` with
field paths only, and the response body never contains the substring
`"ECHO_SECRET_SENTINEL_999"`. Tool: `curl`
(`PUT http://localhost:3007/operator/reservations/setup/locations/<id>/settings`
with `"interval_min":"ECHO_SECRET_SENTINEL_999"`) and `terminal`
(`cd /home/factory-user/repos/menuza/apps/tenant-api && CI=true npx vitest run src/routes/reservations-setup.test.ts`)
Evidence: HTTP 400 response body confirmed not to contain
`"ECHO_SECRET_SENTINEL_999"` alongside field-path error structure. Milestone:
foh-core

### VAL-SETUP-031: Arabic localization and Lingui catalog completeness for Setup UI

Loading `/riyadh-grill/reservations/settings?lng=ar`, `/settings/tables?lng=ar`,
`/settings/floor-plan?lng=ar`, `/settings/services?lng=ar`, and
`/settings/special-days?lng=ar` renders Arabic translations (`dir="rtl"`) for
all navigation tabs, headings, form labels, and buttons, and running
`npm run lingui:check` from the repo root exits 0 with zero unextracted strings
or empty `msgstr` entries in `apps/app/app/locales/ar/messages.po`. Tool:
`agent-browser`
(`http://localhost:3001/riyadh-grill/reservations/settings?lng=ar`) and
`terminal` (`cd /home/factory-user/repos/menuza && npm run lingui:check`)
Evidence: Accessibility snapshot in Arabic showing localized labels with
`dir="rtl"` and exit code 0 from `npm run lingui:check`. Milestone: foh-core

### VAL-SETUP-032: Setup Playwright E2E spec passes against the production App build

The milestone 2 Playwright E2E spec
(`apps/app/tests/e2e/reservations-setup.test.ts`) builds and runs against the
App server on port 3101 with tenant-api stubbed (`**/operator/reservations/**`),
exercising location settings, tables/combinations, floor plan editor Save and
version conflict, services/turn times/pacing, and special days/blocks, and
passes with `--retries=0`. Tool: `terminal`
(`cd /home/factory-user/repos/menuza && npm run build -w app && cd apps/app && PORT=3101 CI=true npx playwright test tests/e2e/reservations-setup.test.ts --workers=1 --reporter=line --retries=0`)
Evidence: Playwright exit code 0 with all tests in `reservations-setup.test.ts`
passing. Milestone: foh-core Isolation: serial (runs App build and Playwright
server on port 3101)

---

---

Shared preconditions for every assertion unless stated otherwise: all five web
services are up per `services.yaml` (`tenant-api-us` on 3007, `tenant-api-ksa`
on 3009, `app` on 3001, `sites` on 3008); `reservations.enabled` is on for the
organization via `commands.set_org_flag`; `commands.seed_reservations_acme` and
`commands.seed_reservations_ksa` have run; the default operator is `kody`
(built-in admin role with all eight reservations permissions). Each validator
uses its own isolated future business dates (`2026-06-<dd>` or later) and its
own guest phones (`+1555555<validator-number><nn>` on US,
`+96655<validator-number><nnnn>` on KSA) and emails
(`rsv-<validator>-<n>@example.com`) so parallel or consecutive checks never
collide on table occupancy, pacing counters, or guest profiles. Short-lived
operator tokens (`typ: rsv+jwt`, audience `tenant-api-reservations-operator`)
are minted in the browser via
`fetch('/<orgSlug>/reservations/token?scope=<scope>').then(r => r.json())` and
are never written into evidence files. Read-only SQLite verification queries run
against `packages/database/db/tenant_t58bgatqh3rv0s3movrecyj1.db` (`acme`) and
`packages/database/db/ksa/tenant_ru0dm42cud9scs4g2duep21c.db` (`riyadh-grill`).

---

## Area: Reservation book (`VAL-BOOK`)

### VAL-BOOK-001: Phone booking sheet searches existing guests and creates a new guest inline

Open `/acme/reservations/book` as `kody` and open the New reservation (phone /
host booking) sheet. Typing at least 2 characters of an existing guest's name,
phone, or email queries `GET /operator/reservations/book/guests/lookup?q=` and
displays up to 10 matching guest summaries with visit/no-show counts and tags;
selecting one populates the form, while entering a fresh name and phone
(`+15555550101`) creates a new `rsv_guests` row when the booking is submitted.
Pass: existing guest lookup populates the form, new guest submission returns
`201`/`200` from `POST /operator/reservations/book/reservations`, and the new
guest row exists in `rsv_guests`. Tool: agent-browser Evidence:
screenshot(book-phone-sheet-lookup), network(GET
/operator/reservations/book/guests/lookup -> 200), network(POST
/operator/reservations/book/reservations -> 200|201) Milestone: foh-core

### VAL-BOOK-002: Phone booking checks staff availability with pacing warnings and auto-assigns best-fit table

In the phone booking sheet on `/acme/reservations/book`, select the validator's
business date, party size 4, and Dinner service. The sheet calls
`GET /operator/reservations/book/availability?locationId=...&date=...&partySize=4`
and displays candidate slots (including staff pacing warnings when a slot is
near or at its online pacing cap) and submitting a slot creates the reservation
with an automatically assigned best-fit single table or table combination and an
active row in `rsv_table_occupancies`. Pass: availability slots render with any
applicable pacing indicator, the created reservation has status `booked`, and
`rsv_reservation_tables` + `rsv_table_occupancies` hold the assigned table
spanning `[start_at, end_at)` where `end_at - start_at` equals the turn time
plus `buffer_after_min`. Tool: agent-browser Evidence:
screenshot(book-phone-availability-assigned), network(GET
/operator/reservations/book/availability -> 200), sqlite(rsv_reservations,
rsv_reservation_tables, rsv_table_occupancies for the booking) Milestone:
foh-core

### VAL-BOOK-003: Phone booking persists area preference, custom duration, occasion, dietary notes, and internal notes

Submit a phone booking from `/acme/reservations/book` specifying a preferred
dining area, a custom duration override (`durationMin: 120`), an occasion
(`anniversary`), guest dietary notes (`contract-dietary-book003`), and private
internal staff notes (`contract-internal-book003`). Open the created
reservation's detail sheet (`?r=<id>`). Pass: the detail sheet and
`GET /operator/reservations/book/reservations/:id` return the chosen
`diningAreaId`, `durationMin: 120`, `occasion: 'anniversary'`, `dietaryNotes`,
and `internalNotes`, and `rsv_table_occupancies.end_at` reflects the 120-minute
duration plus buffer. Tool: agent-browser Evidence:
screenshot(book-phone-custom-fields), network(GET
/operator/reservations/book/reservations/:id -> 200), sqlite(rsv_reservations
duration_min, occasion, dietary_notes, internal_notes) Milestone: foh-core

### VAL-BOOK-004: Operator booking enforces Idempotency-Key deduplication and conflict detection

Mint a `book`-scope token and send two identical
`POST /operator/reservations/book/reservations` requests with the same
`Idempotency-Key` UUID and identical JSON body, then send a third request with
the same `Idempotency-Key` but a different `partySize`. Pass: the first two
requests return the exact same reservation id and create only one row in
`rsv_reservations` and one `operator_create` row in `rsv_idempotency_keys`; the
third request with a mutated body is rejected with `409 idempotency_conflict`.
Tool: curl Evidence: network(POST /operator/reservations/book/reservations
replay -> 200, mutated -> 409 idempotency_conflict), sqlite(rsv_idempotency_keys
and rsv_reservations count) Milestone: foh-core

### VAL-BOOK-005: Explicit overbooking requires a reason, sets overbook occupancy, and writes an audit log without PII

On a date and time slot where all compatible tables in the chosen area are
already occupied, submit `POST /operator/reservations/book/reservations` first
without `overbook: true` (or without an overbook reason), then with
`overbook: true` and `overbookReason: "VIP manager override"`. Pass: the first
request is rejected with `409` (`no_availability` or `missing_overbook_reason`),
while the explicit overbook request succeeds, sets
`rsv_table_occupancies.overbook = 1` (bypassing the non-overbook overlap trigger
cleanly), records an event in `rsv_reservation_events`, and writes an
`rsv_audit_log` row with `action = 'reservation.overbook'` whose `changes` JSON
contains no guest PII. Tool: curl Evidence: network(POST
/operator/reservations/book/reservations without overbook -> 409, with
overbook+reason -> 200), sqlite(rsv_table_occupancies.overbook=1 and
rsv_audit_log action='reservation.overbook') Milestone: foh-core

### VAL-BOOK-006: Walk-in modal seats a party immediately and can allocate walk-in-only tables

On `/acme/reservations/today`, click the Walk-in button, select party size 2,
optionally leave guest phone/email blank (anonymous walk-in) or provide a
walk-in name, and seat at a table configured with `walk_in_only = 1` (or let
auto-assignment pick a table including `walk_in_only` tables). Pass:
`POST /operator/reservations/book/walk-ins` creates a reservation with
`source = 'walk_in'`, `status = 'seated'`, non-null `arrived_at` and
`seated_at`, `covers_actual = 2`, and an active `rsv_table_occupancies` row,
whereas online availability (`GET /reservations/availability`) never offers the
`walk_in_only` table. Tool: agent-browser Evidence:
screenshot(today-walk-in-seated), network(POST
/operator/reservations/book/walk-ins -> 200|201), sqlite(rsv_reservations
source='walk_in' status='seated') Milestone: foh-core

### VAL-BOOK-007: Walk-in creation enforces Idempotency-Key in the walk_in scope and rejects occupied tables

Using a `book`-scope token, call `POST /operator/reservations/book/walk-ins`
twice with the same `Idempotency-Key` header and body, then attempt a second
walk-in with a new key specifying a `tableIds` array whose table is currently
seated by the first walk-in (without `overbook: true`). Pass: the idempotent
replay returns the first walk-in's reservation id without duplicating rows in
`rsv_reservations` or `rsv_idempotency_keys` (`scope = 'walk_in'`), and the
conflicting walk-in onto the already-seated table is rejected with `409`. Tool:
curl Evidence: network(POST /operator/reservations/book/walk-ins replay -> 200,
conflict -> 409), sqlite(rsv_idempotency_keys scope='walk_in') Milestone:
foh-core

### VAL-BOOK-008: Book list switches business dates and service periods with accurate party and cover totals

Open `/acme/reservations/book` as `kody`, navigate to a business date containing
bookings in both Lunch and Dinner services, and switch the service selector
between All services, Lunch, and Dinner. Pass: the list updates to show only
reservations falling in the selected service window, and the header summary
counters (total parties and total covers) equal the sum of listed active
reservations for that date and service filter. Tool: agent-browser Evidence:
screenshot(book-list-service-filter), network(GET
/operator/reservations/book/day -> 200), console-errors Milestone: foh-core

### VAL-BOOK-009: Book list searches by guest name, phone, confirmation code, and table and filters by status, area, source, and tags

On `/acme/reservations/book` for a date with multiple bookings, search
sequentially by a substring of the guest's name, by middle digits of the phone
number, by the reservation's `confirmation_code`, and by assigned table label,
then filter by status (`booked` vs `cancelled`), dining area, source (`phone` vs
`walk_in`), and guest/reservation tag. Pass: each search query and filter
narrows the rendered rows to the matching reservations without page errors, and
combining filters intersects the criteria accurately. Tool: agent-browser
Evidence: screenshot(book-list-search-and-filters), console-errors Milestone:
foh-core

### VAL-BOOK-010: Book list shows an explicit empty state when no reservations match and resets cleanly

On `/acme/reservations/book`, enter a search string that matches no reservation
(`zz-no-match-book010`). Pass: the table area renders a clear empty state with
zero reservation rows and a way to clear/reset filters; clearing the search
restores the date's reservations with no console errors. Tool: agent-browser
Evidence: screenshot(book-list-empty-state), console-errors Milestone: foh-core

### VAL-BOOK-011: Today screen groups reservations into Upcoming, Seated, and Finished tabs with live counters and quick actions

Open `/acme/reservations/today` on the current business date after creating one
`booked` party, one `seated` party, and one `finished` (or
`cancelled`/`no_show`) party. Pass: the top counters and tab badges reflect the
exact counts for Upcoming (`pending_payment`, `pending_approval`, `booked`,
`confirmed`, `arrived`), Seated (`seated`), and Finished (`finished`,
`cancelled`, `no_show`), and triggering a quick status action (such as marking
the upcoming party `arrived` or `seated`) moves the row to the corresponding tab
and updates the counters immediately. Tool: agent-browser Evidence:
screenshot(today-tabs-and-quick-actions), network(POST
/operator/reservations/book/reservations/:id/status -> 200), console-errors
Milestone: foh-core

### VAL-BOOK-012: Today screen surfaces unassigned and conflicting bookings in the Unassigned and Conflict panel

Create a reservation that becomes unassigned or has an active conflict (for
example by creating a table block with `onConflict: 'unassign'` over its
assigned table, or an overbooked overlap), then open `/acme/reservations/today`
and check `GET /operator/reservations/book/conflicts?locationId=...&date=...`.
Pass: the conflicts endpoint lists the unassigned and overlapping reservations
for the day, the Today screen's Unassigned and Conflict panel displays them with
a badge count, and clicking an entry opens its detail sheet (`?r=<id>`) so the
host can resolve it. Tool: agent-browser Evidence:
screenshot(today-unassigned-conflict-panel), network(GET
/operator/reservations/book/conflicts -> 200) Milestone: foh-core

### VAL-BOOK-013: Detail sheet (?r=<id>) displays reservation details, guest summary, and append-only change history

Click a reservation row on `/acme/reservations/book` or
`/acme/reservations/today` so the URL updates with `?r=<id>` and the detail
`Sheet` opens. Pass: the sheet renders the confirmation code, status badge,
date/time/duration, party size, assigned table(s), source, notes, occasion,
guest visit/no-show summary, and the chronological change history loaded from
`GET /operator/reservations/book/reservations/:id/events` showing `created` and
subsequent events with actor kinds and timestamps. Tool: agent-browser Evidence:
screenshot(book-detail-sheet-events), network(GET
/operator/reservations/book/reservations/:id -> 200), network(GET
/operator/reservations/book/reservations/:id/events -> 200) Milestone: foh-core

### VAL-BOOK-014: Detail sheet pauses background day polling while the operator is editing fields

Open `/acme/reservations/today?r=<id>` (where background polling normally runs
every 5 seconds), focus an editable field inside the detail sheet (such as
internal notes or party size) and type unsaved text without submitting for at
least 12 seconds. Pass: while the form in the detail sheet is dirty/being
edited, either background `GET /operator/reservations/book/day` polling is
paused or incoming polls do not clobber the unsaved input value; saving the edit
persists the change and resumes normal polling. Tool: agent-browser Evidence:
screenshot(detail-sheet-editing-preserved), console-errors Milestone: foh-core

### VAL-BOOK-015: Modifying reservation time, party size, area, or duration atomically re-plans excluding own occupancy

On an existing `booked` reservation for 2 guests at 19:00 on a table of max
capacity 4, send `PATCH /operator/reservations/book/reservations/:id` (or save
in the detail sheet) changing `partySize` to 4 and shifting `startAt` by 15
minutes with the current `expectedVersion`. Pass: the planner excludes the
reservation's own existing `rsv_table_occupancies` rows so it does not conflict
with itself, keeps or reassigns a valid table, updates `rsv_table_occupancies`
to the new window, increments `rsv_reservations.version`, and appends a
`modified` event to `rsv_reservation_events`. Tool: agent-browser Evidence:
screenshot(detail-sheet-modified), network(PATCH
/operator/reservations/book/reservations/:id -> 200), sqlite(rsv_reservations
version, rsv_table_occupancies window, rsv_reservation_events modified)
Milestone: foh-core

### VAL-BOOK-016: Concurrent edit or status change with a stale expectedVersion is rejected with 409 stale_version

Fetch a reservation's current `version` (say `v`), perform one valid `PATCH`
(bumping the stored version to `v + 1`), and then send a second
`PATCH /operator/reservations/book/reservations/:id` and a
`POST /operator/reservations/book/reservations/:id/status` both carrying the
stale `expectedVersion: v`. Pass: both stale requests return HTTP `409` with
error code `stale_version`, leaving the stored reservation at version `v + 1`
without overwriting the first edit. Tool: curl Evidence: network(PATCH
/operator/reservations/book/reservations/:id stale -> 409 stale_version),
network(POST /operator/reservations/book/reservations/:id/status stale -> 409
stale_version) Milestone: foh-core

### VAL-BOOK-017: Forward status transitions update lifecycle timestamps, actual covers, table occupancy, and guest counters

Create a `booked` reservation for 3 covers and step it through
`POST /operator/reservations/book/reservations/:id/status` in sequence:
`confirmed`, `arrived`, `seated` (passing `covers: 4`), and `finished`. Pass:
each transition succeeds (`200`) and bumps `version`; `arrived` sets
`arrived_at`; `seated` sets `seated_at` and `covers_actual = 4`; `finished` sets
`finished_at`, releases or shortens active `rsv_table_occupancies` rows
(`active = 0` or `end_at <= finished_at`), increments `rsv_guests.visits` by 1
and `rsv_guests.covers` by 4, and updates `rsv_guests.last_visit_at`. Tool: curl
Evidence: network(POST /operator/reservations/book/reservations/:id/status ->
200), sqlite(rsv_reservations timestamps/covers_actual, rsv_table_occupancies
active, rsv_guests visits/covers) Milestone: foh-core

### VAL-BOOK-018: Invalid status transitions are rejected with 409 invalid_status_transition

Using a `book`-scope token, attempt illegal transitions on reservations via
`POST /operator/reservations/book/reservations/:id/status`: `booked -> finished`
(skipping `seated`), `finished -> arrived`, `no_show -> arrived`, and
`cancelled -> seated`. Pass: every illegal transition returns `409` with code
`invalid_status_transition`, `rsv_reservations.status` and `version` remain
unchanged, and no bogus event is written to `rsv_reservation_events`. Tool: curl
Evidence: network(POST /operator/reservations/book/reservations/:id/status
invalid -> 409 invalid_status_transition), sqlite(rsv_reservations status
unchanged) Milestone: foh-core

### VAL-BOOK-019: Cancelling or marking no_show deactivates table occupancy and records cancellation metadata

Create two `booked` reservations with assigned tables on the validator's date:
transition the first to `cancelled` (with `reason: "Guest called to cancel"`)
and the second to `no_show`. Pass: both transitions set
`rsv_table_occupancies.active = 0` for their tables (immediately freeing the
slot for new bookings), the cancelled reservation records `cancelled_at`,
`cancelled_by = 'restaurant'`, and `cancel_reason`, the no-show reservation sets
`no_show_at` and increments `rsv_guests.no_shows` by 1, and both append
corresponding events in `rsv_reservation_events`. Tool: curl Evidence:
network(POST /operator/reservations/book/reservations/:id/status -> 200),
sqlite(rsv_table_occupancies active=0, rsv_reservations cancelled_by/no_show_at,
rsv_guests.no_shows) Milestone: foh-core

### VAL-BOOK-020: Undo endpoint reverts no_show, seated->arrived, and cancelled->booked while re-validating occupancy

On three reservations that just transitioned to (a) `no_show` from `booked`, (b)
`seated` from `arrived`, and (c) `cancelled` from `booked`, invoke
`POST /operator/reservations/book/reservations/:id/undo` (or click Undo in the
detail sheet). Pass: (a) returns to `booked` and decrements
`rsv_guests.no_shows`, (b) returns to `arrived` and clears `seated_at`, and (c)
reinstates the cancelled booking to `booked` with active `rsv_table_occupancies`
restored (or rejected with `409` if another booking took the table in the
meantime), and each writes an `undone` event to `rsv_reservation_events`. Tool:
agent-browser Evidence: screenshot(detail-sheet-undo), network(POST
/operator/reservations/book/reservations/:id/undo -> 200),
sqlite(rsv_reservations status and rsv_reservation_events undone) Milestone:
foh-core

### VAL-BOOK-021: Undo of finished -> seated succeeds within 30 minutes and is rejected after 30 minutes or on table conflict

Transition a `seated` reservation to `finished`, then call
`POST /operator/reservations/book/reservations/:id/undo` immediately: it reverts
to `seated`, restores active table occupancy, and rolls back the guest's
`visits`/`covers` increment. Next, set `finished_at` on a finished reservation
to 31 minutes ago (or seat another party on the same table) and call `/undo`
again. Pass: the immediate undo succeeds (`200`), while the undo after the
30-minute window (or when the table is now occupied) is rejected with `409` and
leaves the reservation in `finished`. Tool: curl Evidence: network(POST
/operator/reservations/book/reservations/:id/undo within 30m -> 200, after 30m
or conflict -> 409), sqlite(rsv_reservations status and rsv_guests visits)
Milestone: foh-core

### VAL-BOOK-022: Contact status, running-late note, and notes endpoints enforce pre-arrival and settings rules

For a `booked` reservation at a location with `contact_statuses_enabled = 1`,
call `POST /operator/reservations/book/reservations/:id/contact-status` with
`left_message`, `POST .../running-late` with `"Running 15 min late"`, and
`POST .../notes` to update internal/dietary notes. Then transition the
reservation to `arrived` and attempt `POST .../contact-status` again; also test
`contact-status` when `contact_statuses_enabled = 0`. Pass: before arrival with
the setting enabled, all three endpoints succeed (`200`) and persist the fields
and events; after arrival or when `contact_statuses_enabled = 0`,
`contact-status` is rejected with `409`/`400`. Tool: curl Evidence: network(POST
/operator/reservations/book/reservations/:id/contact-status before arrival ->
200, after arrival -> 409), sqlite(rsv_reservations contact_status,
running_late_note) Milestone: foh-core

### VAL-BOOK-023: Course status updates only while seated and when course_statuses_enabled is on

With `course_statuses_enabled = 1`, attempt
`POST /operator/reservations/book/reservations/:id/course-status` (`appetizer`)
on a `booked` reservation (expect `409`), then transition the reservation to
`seated` and step through `appetizer`, `entree`, `dessert`, `check_dropped`,
`paid`, and `bussing`. Finally disable `course_statuses_enabled` in location
settings and attempt another course-status update. Pass: course status updates
succeed (`200`) and record `course_changed` events only while the reservation is
`seated` and `course_statuses_enabled = 1`, and are rejected with `409`/`400`
otherwise. Tool: curl Evidence: network(POST
/operator/reservations/book/reservations/:id/course-status booked -> 409, seated
-> 200, setting off -> 409), sqlite(rsv_reservations course_status and
rsv_reservation_events) Milestone: foh-core

### VAL-BOOK-024: Day snapshot endpoint serves composite ETag and answers 304 Not Modified until day or settings change

Call `GET /operator/reservations/book/day?locationId=...&date=...` and capture
the `ETag` response header (`"<dayVersion>.<settingsVersion>"`). Repeat the
request with `If-None-Match: "<dayVersion>.<settingsVersion>"`, then create or
modify a booking on that date and repeat with the old `If-None-Match`; finally
update a location setting (`rsv_location_settings`) and repeat again. Pass: the
unchanged poll returns `304 Not Modified` with an empty body; after a booking
write `dayVersion` increments and `GET /day` returns `200` with a new ETag;
after a location-settings write `settingsVersion` increments and `GET /day`
returns `200` with the new composite ETag. Tool: curl Evidence: network(GET
/operator/reservations/book/day -> 200 with ETag, If-None-Match -> 304, after
write -> 200 with new ETag), sqlite(rsv_day_versions and
rsv_location_settings.version) Milestone: foh-core

### VAL-BOOK-025: Lightweight changes endpoint reports dayVersion and changed flag accurately

Query
`GET /operator/reservations/book/changes?locationId=...&date=...&since=<currentDayVersion>`,
then modify a reservation on that date and call the same URL with the previous
`since` value. Pass: when no write has occurred since `<currentDayVersion>`, the
response is `200` with `{ dayVersion: <currentDayVersion>, changed: false }`;
after the write, the response is `200` with
`{ dayVersion: <newVersion>, changed: true }` where
`<newVersion> > <currentDayVersion>`. Tool: curl Evidence: network(GET
/operator/reservations/book/changes unchanged -> changed:false, after write ->
changed:true) Milestone: foh-core

### VAL-BOOK-026: Guest export endpoint enforces guest permissions, gates sensitive fields, and logs guest.export without PII

Create a guest via phone booking with dietary/allergy text
`contract-sensitive-book026`. Mint a `book`-scope token (no guest grants), a
`guests`-scope token for a Guest-viewer role (`read:reservation_guest:any`
only), and a `guests`-scope token for `kody` (`update:reservation_guest:any`).
Call `GET /operator/reservations/guests/:id/export` and
`GET /operator/reservations/guests/:id/export?includeSensitive=1` with each.
Pass: the `book` token gets `403`; the read-only guest token gets `200` on
default export (with `contract-sensitive-book026` omitted) and `403` on
`?includeSensitive=1`; `kody`'s token gets `200` on `?includeSensitive=1`
including `contract-sensitive-book026`; each successful export appends one
`rsv_audit_log` row with `action = 'guest.export'` and zero PII in `changes`.
Tool: curl Evidence: network(GET /operator/reservations/guests/:id/export
default -> 200, includeSensitive read-only -> 403, admin -> 200),
sqlite(rsv_audit_log action='guest.export') Milestone: foh-core

### VAL-BOOK-027: Guest erase endpoint anonymizes profile, cancels future bookings, redacts event payloads, and preserves row counts

Create a guest with a future `booked` reservation and one past `finished`
reservation, plus a reservation note and event containing the guest's text
`contract-erase-note-book027`. Record row counts in `rsv_reservation_events` and
`rsv_audit_log`, then call `POST /operator/reservations/guests/:id/erase` with
`kody`'s `guests`-scope token. Pass: `rsv_guests` has `first_name` / `last_name`
anonymized to `"Erased guest"` and `phone_e164`, `email`, `notes`, and
`allergy_notes` nulled/cleared; the future booking is transitioned to
`cancelled` (`cancelled_by = 'restaurant'`) with its table occupancy released
while the past booking keeps its status and aggregate counters; prior
event/audit JSON carrying guest text is updated to `{"redacted":true}` with zero
rows deleted; and a new `rsv_audit_log` row with `action = 'guest.erase'` is
written. Tool: curl Evidence: network(POST
/operator/reservations/guests/:id/erase -> 200), sqlite(rsv_guests anonymized,
future rsv_reservations cancelled, rsv_reservation_events redacted and count >=
prior, rsv_audit_log guest.erase) Milestone: foh-core

### VAL-BOOK-028: Region-summary internal and App resource routes return counts only with no PII

As `kody`, call
`GET http://localhost:3001/resources/reservations/region-summary?orgSlug=acme`
(with operator session cookie) and
`POST http://localhost:3007/internal/reservations/summary` (with
`INTERNAL_COMMAND_TOKEN`). Pass: both return JSON containing only numeric counts
(`reservationsCount`, `guestsCount`, `activeWaitlistCount` or equivalent summary
fields) matching the tenant DB row counts, and neither response body contains
any guest name, phone, email, or note text; unauthenticated calls are rejected
with `401`/`403`. Tool: curl Evidence: network(GET
/resources/reservations/region-summary?orgSlug=acme -> 200), network(POST
/internal/reservations/summary -> 200) Milestone: foh-core

### VAL-BOOK-029: Region-switch guard shows reservation counts, requires typed slug when data exists, and skips confirmation when zero

Open `/acme/website` (or organization settings card with the Customer data
region control) as `kody` while `acme` has non-zero reservations or guests: the
region-switch dialog displays the reservations/guests count warning alongside
staffing counts and requires typing the organization slug `acme`. Submitting the
region-switch action without `confirmOrgSlug` or with a wrong slug returns HTTP
`400` with `reservationsConfirmationRequired` and leaves
`Organization.dataRegion` unchanged. Conversely, on a disposable test org with
zero reservations, zero guests, and zero active waitlist entries (and zero
staff), `evaluateReservationsRegionGuard` requires no typed-slug confirmation.
Tool: agent-browser Evidence:
screenshot(region-switch-dialog-reservation-counts), network(POST region-switch
with wrong slug -> 400 reservationsConfirmationRequired) Milestone: foh-core
Isolation: serial (tests region-switch guard on org settings)

### VAL-BOOK-030: Region-switch guard fails closed when the regional tenant-api summary is unreachable

Evaluate the region-switch guard (`evaluateReservationsRegionGuard` or the
region-switch action) when the regional `/internal/reservations/summary` call
returns an error or times out (`summary.unknown === true`), first without
`confirmOrgSlug` and then with the exact `confirmOrgSlug`. Pass: when the
summary is unknown and `confirmOrgSlug` is missing or wrong, the guard fails
closed with `400 reservationsConfirmationRequired` rather than assuming zero
rows; providing the matching `confirmOrgSlug` satisfies the guard. Tool:
terminal Evidence: terminal(vitest or curl verification of
evaluateReservationsRegionGuard with unknown:true) Milestone: foh-core

### VAL-BOOK-031: Location-delete guard blocks deleting a location that has future reservations

In `/acme/settings/locations`, create a temporary secondary location, seed or
book one future reservation at that location, and attempt to delete the location
in `/acme/settings/locations/<locationId>`. Then cancel or remove the future
reservation (or leave only past/cancelled reservations as specified by
`/internal/reservations/location-summary`) and delete the location again. Pass:
while at least one active future reservation exists at the location, deletion is
refused (`400`/`409`) and the UI displays an error naming the future reservation
count while the `Location` row remains; once zero active future reservations
remain, the location deletes cleanly. Tool: agent-browser Evidence:
screenshot(location-delete-blocked-by-reservations), network(POST
/internal/reservations/location-summary -> 200), sqlite(Location row present
while blocked, deleted after) Milestone: foh-core Isolation: serial (creates and
deletes a temporary Location in control-plane DB)

### VAL-BOOK-032: Read-only reservation operator can view Today and Book but cannot create or mutate bookings

Sign in as an operator whose role grants only `read:reservation:any` (no
`update:reservation:any`). Open `/acme/reservations/today` and
`/acme/reservations/book`, open a reservation detail sheet (`?r=<id>`), and also
use the operator's minted `book`-scope token to call `POST .../reservations`,
`PATCH .../reservations/:id`, `POST .../reservations/:id/status`,
`POST .../reservations/:id/undo`, and `POST .../walk-ins`. Pass: Today, Book,
and the detail sheet load and render read-only, while all mutating UI controls
are hidden or disabled and every mutating API endpoint returns `403`. Tool:
agent-browser Evidence: screenshot(book-readonly-operator), network(POST
/operator/reservations/book/reservations -> 403), network(POST
/operator/reservations/book/walk-ins -> 403) Milestone: foh-core Isolation:
serial (uses restricted read-only operator role)

### VAL-BOOK-033: Book routes reject missing, forged, expired, cross-org, or wrong-scope tokens

Using `curl`, send requests to `/operator/reservations/book/day`,
`POST /operator/reservations/book/reservations`, and
`POST /operator/reservations/book/walk-ins` with: (1) no `Authorization` header,
(2) a JWT signed with the wrong secret, (3) an expired token (`exp < now`), (4)
a token whose `exp - iat` exceeds 900 seconds, (5) a `reports`-scope token (no
reservation read/update grant), and (6) a valid `acme` token used against
another org's data. Pass: cases (1)-(4) return `401`, case (5) returns `403`,
and case (6) never reads or mutates another org's tenant database. Tool: curl
Evidence: network(GET /operator/reservations/book/day unauth -> 401, wrong-scope
-> 403) Milestone: foh-core

### VAL-BOOK-034: Location-scoped operator can read and mutate only their assigned locationIds

For a multi-location org where a member's `UserOrganization.locationScope`
restricts them to Location A (`locationIds: [<locA>]` in the minted `book`
token), call `GET /operator/reservations/book/day?locationId=<locA>&date=...`
and `GET /operator/reservations/book/day?locationId=<locB>&date=...`, and
attempt `POST /operator/reservations/book/reservations` for Location B. Pass:
requests for Location A succeed (`200`), while requests targeting Location B (or
a reservation ID belonging to Location B) are rejected with `403`. Tool: curl
Evidence: network(GET /operator/reservations/book/day locA -> 200, locB -> 403),
network(POST /operator/reservations/book/reservations locB -> 403) Milestone:
foh-core Isolation: serial (uses location-scoped member assignment)

### VAL-BOOK-035: Impersonated operator session receives a 5-minute read-only token and cannot mutate reservations

While impersonating an organization member (or minting a token from an
impersonated session), inspect the minted `book` token from
`GET /acme/reservations/token?scope=book` and attempt
`POST /operator/reservations/book/reservations` and
`POST /operator/reservations/book/reservations/:id/status`. Also attempt to mint
`scope=guests` or `scope=payments` during impersonation. Pass: the `book` token
has `impersonated: true`, `exp - iat <= 300`, and no `update:*` or sensitive
grants; mutating book routes return `403`; sensitive scopes (`guests`,
`payments`) are refused (`403`). Tool: curl Evidence: network(GET
/acme/reservations/token?scope=book impersonated -> 200 with exp-iat<=300),
network(POST /operator/reservations/book/reservations impersonated -> 403)
Milestone: foh-core

### VAL-BOOK-036: KSA organization (riyadh-grill) runs Today and Book flows strictly against tenant-api-ksa with zero US PII leakage

Open `/riyadh-grill/reservations/today` and `/riyadh-grill/reservations/book` as
`kody`, create a phone booking with a KSA phone (`+966550010036`) and a walk-in,
and transition the phone booking to `arrived`. Inspect browser network requests
and query both US and KSA SQLite files. Pass: every
`/operator/reservations/book/*` request from the browser goes to
`http://localhost:3009` (`tenant-api-ksa`), sending the `riyadh-grill` operator
token to `http://localhost:3007` is rejected with `401`/`403`, the new rows
exist in `packages/database/db/ksa/tenant_ru0dm42cud9scs4g2duep21c.db`, and zero
rows or PII for `+966550010036` exist in `packages/database/db/data.db` or any
US tenant DB. Tool: agent-browser Evidence: screenshot(ksa-book-and-today),
network(POST http://localhost:3009/operator/reservations/book/reservations ->
200), network(GET http://localhost:3007/operator/reservations/book/day with ksa
token -> 401|403), sqlite(ksa db has row; us db has 0) Milestone: foh-core

### VAL-BOOK-037: Today and Book screens render right-to-left in Arabic (?lng=ar) without reversing numbers or codes

Open `/acme/reservations/today?lng=ar` and `/acme/reservations/book?lng=ar` as
`kody` and open a reservation detail sheet (`?r=<id>&lng=ar`). Pass: the page
sets `dir="rtl"`, Arabic translations appear for tabs, filters, status badges,
and action buttons (with zero raw untranslated Lingui message IDs), while phone
numbers (`+1...`), confirmation codes, times (`19:00`), and party numbers render
left-to-right without character reversal and with zero console errors. Tool:
agent-browser Evidence: screenshot(book-ar-rtl), screenshot(today-ar-rtl),
console-errors Milestone: foh-core

### VAL-BOOK-038: Reservation events and audit logs are strictly append-only at the SQLite trigger layer

Against `acme`'s tenant database, attempt direct SQL
`DELETE FROM rsv_reservation_events`,
`UPDATE rsv_reservation_events SET type = 'hacked'`,
`DELETE FROM rsv_audit_log`, and `UPDATE rsv_audit_log SET action = 'hacked'`,
then test the single permitted redaction update
`UPDATE rsv_reservation_events SET data = '{"redacted":true}' WHERE id = ...`.
Pass: both `DELETE` statements and both non-redaction `UPDATE` statements abort
via the `rsv_reservation_events_no_delete` / `_no_update` and
`rsv_audit_log_no_delete` / `_no_update` triggers, while setting `data` or
`changes` to `'{"redacted":true}'` succeeds. Tool: terminal Evidence:
sqlite(trigger abort messages on DELETE/UPDATE and success on
'{"redacted":true}') Milestone: foh-core

---

## Area: Host stand (`VAL-HOST`)

### VAL-HOST-001: Timeline view renders tables grouped by dining area across 15-minute slots with an Unassigned lane

Open `/acme/reservations/timeline` as `kody` on a date with seeded or newly
created reservations. Pass: the timeline renders a horizontal grid whose rows
are active tables grouped under their dining area headers, plus a dedicated
Unassigned lane at the top for bookings without a table, and whose columns are
15-minute increments across the selected service period; reservations render as
bars spanning `[start_at, end_at)` on their assigned table row(s) with guest
name, party size, and status styling. Tool: agent-browser Evidence:
screenshot(timeline-grid-areas-and-unassigned), network(GET
/operator/reservations/book/day -> 200), console-errors Milestone: foh-core

### VAL-HOST-002: Timeline pacing strip shows booked covers against configured 15-minute slot caps

On `/acme/reservations/timeline`, inspect the top pacing strip across the
service's 15-minute columns and compare the displayed numbers with the sum of
booked/seated covers starting in each slot and the service's configured
`max_covers_per_slot`. Book an additional party into a slot to bring it to or
above `max_covers_per_slot`. Pass: the pacing strip updates its cover count for
that 15-minute column and visually highlights the slot as full or over-paced.
Tool: agent-browser Evidence: screenshot(timeline-pacing-strip), console-errors
Milestone: foh-core

### VAL-HOST-003: Dragging a reservation to a different table on the timeline offers Assign vs Assign & Lock

On `/acme/reservations/timeline`, drag a reservation bar from the Unassigned
lane (or from its current soft-assigned table) onto another compatible empty
table row at the same time slot. Pass: the UI lets the host choose between soft
assignment (`lock: false`, keeping `locked_assignment = 0`) and locked
assignment (`lock: true`, setting `locked_assignment = 1`), calls
`POST /operator/reservations/book/reservations/:id/assign`, moves the bar to the
target table row, shows a lock icon when locked, and updates
`rsv_reservation_tables` and `rsv_table_occupancies`. Tool: agent-browser
Evidence: screenshot(timeline-drag-assign-lock), network(POST
/operator/reservations/book/reservations/:id/assign -> 200),
sqlite(rsv_reservations.locked_assignment and rsv_reservation_tables) Milestone:
foh-core

### VAL-HOST-004: Dragging a locked reservation on the timeline prompts "Unlock and move?" before reassigning

Lock a reservation to Table A (`locked_assignment = 1`), then on
`/acme/reservations/timeline` drag that reservation bar onto Table B. Pass: the
timeline does not silently move the locked party; it prompts
`"Unlock and move?"` (or equivalent confirmation); cancelling the prompt keeps
the reservation on Table A with `locked_assignment = 1`, while confirming
reassigns it to Table B and records a `table_assigned` event in
`rsv_reservation_events`. Tool: agent-browser Evidence:
screenshot(timeline-locked-unlock-prompt), network(POST
/operator/reservations/book/reservations/:id/assign -> 200),
sqlite(rsv_reservation_events table_assigned) Milestone: foh-core

### VAL-HOST-005: Dragging a reservation horizontally on the timeline shifts its start time and occupancy window

On `/acme/reservations/timeline`, drag an existing `booked` reservation bar
horizontally by 30 minutes to a later open slot on the same table row. Pass: the
timeline sends `PATCH /operator/reservations/book/reservations/:id` (or
assign/move request) with `expectedVersion`, updates `start_at` and `end_at` by
+30 minutes, updates `rsv_table_occupancies` without self-conflict, and renders
the bar at the new time column. Tool: agent-browser Evidence:
screenshot(timeline-drag-time-shift), network(PATCH
/operator/reservations/book/reservations/:id -> 200), sqlite(rsv_reservations
start_at/end_at and rsv_table_occupancies) Milestone: foh-core

### VAL-HOST-006: Resizing the right edge of a reservation bar on the timeline updates duration_min and checks conflicts

On `/acme/reservations/timeline`, drag the right resize handle of a reservation
bar to extend its duration by 30 minutes into an open window, then attempt to
extend it further so that it overlaps a subsequent locked booking on the same
table. Pass: extending into open time updates `duration_min` and `end_at`
(`200`) and lengthens the bar; extending into a conflicting booking is rejected
(`409`) or prompts for explicit overbook, leaving the prior valid duration
intact when cancelled. Tool: agent-browser Evidence:
screenshot(timeline-resize-duration), network(PATCH
/operator/reservations/book/reservations/:id -> 200), sqlite(rsv_reservations
duration_min) Milestone: foh-core

### VAL-HOST-007: Clicking an empty cell on the timeline opens the phone booking sheet pre-filled with table, area, and slot time

On `/acme/reservations/timeline`, click an empty cell at the intersection of a
specific table row (for example Table 4 in Main Dining) and a 15-minute time
column (for example `18:30`). Pass: the phone/host booking sheet opens with the
date, time (`18:30`), dining area, and selected table pre-filled; completing
guest details and submitting creates the reservation assigned directly to that
table and slot. Tool: agent-browser Evidence:
screenshot(timeline-empty-cell-prefilled-sheet), network(POST
/operator/reservations/book/reservations -> 200|201) Milestone: foh-core

### VAL-HOST-008: Assigning a table occupied by a soft future booking outside freeze_min reflows the soft booking and reports moves

On a future business date (well outside `freeze_min`), create a soft-assigned
reservation R1 (`locked_assignment = 0`) on Table T1 at 19:00 while another
compatible table T2 is free at 19:00. Create a second reservation R2 for 19:00
and call `POST /operator/reservations/book/reservations/<R2>/assign` (or drag R2
on the timeline) to assign and lock R2 onto Table T1. Pass: the engine
automatically reflows R1 onto Table T2 within the same SQLite transaction,
assigns R2 to Table T1, records an `auto_reassigned` event on R1, and returns
`{ reservation, moves: [{ reservationId: <R1>, fromTables, toTables }] }` which
the UI surfaces as a move notice to the host. Tool: agent-browser Evidence:
screenshot(timeline-reflow-move-notice), network(POST
/operator/reservations/book/reservations/:id/assign -> 200 with moves),
sqlite(rsv_reservation_tables for R1 and R2, rsv_reservation_events
auto_reassigned) Milestone: foh-core

### VAL-HOST-009: Reflow never moves reservations that are locked, arrived/seated, or inside freeze_min

Repeat the table assignment conflict scenario in three cases where the existing
occupant R1 on Table T1 is: (1) `locked_assignment = 1`, (2) status `arrived` or
`seated`, or (3) `booked` with `start_at` within `freeze_min` (for example
within 60 minutes of `now`). Attempt to assign R2 onto Table T1 without
`overbook: true`. Pass: in all three cases, R1 is never auto-reassigned to
another table, the non-overbook assignment of R2 onto T1 is rejected with `409`,
and R1's `rsv_reservation_tables` and `rsv_table_occupancies` rows remain
untouched. Tool: curl Evidence: network(POST
/operator/reservations/book/reservations/:id/assign -> 409 in all 3 cases),
sqlite(R1 table assignment unchanged) Milestone: foh-core

### VAL-HOST-010: Assigning onto a conflicting table when no reflow exists requires explicit overbook with reason

On a slot where every compatible table in the area is already occupied by locked
reservations, attempt `POST /operator/reservations/book/reservations/:id/assign`
onto one of those tables first with `overbook: false` (expect `409`), and then
with `overbook: true` and a reason. Pass: the non-overbook attempt fails with
`409` and changes nothing; the explicit overbook attempt succeeds (`200`),
creates an occupancy row with `overbook = 1`, and writes a
`reservation.overbook` row in `rsv_audit_log`. Tool: curl Evidence: network(POST
/operator/reservations/book/reservations/:id/assign overbook:false -> 409,
overbook:true -> 200), sqlite(rsv_table_occupancies overbook=1, rsv_audit_log
reservation.overbook) Milestone: foh-core

### VAL-HOST-011: Timeline 10-second ETag polling pauses during active drag or resize gestures

Open `/acme/reservations/timeline` and begin dragging a reservation bar (holding
pointer down over a target row) across a 12-second window where the 10-second
poll timer fires. Pass: the active drag gesture is not aborted or snapped back
by a background poll while the pointer is down, and releasing the pointer
completes the assignment cleanly. Tool: agent-browser Evidence:
screenshot(timeline-drag-poll-paused), console-errors Milestone: foh-core

### VAL-HOST-012: Live floor plan renders published tables colored by real-time status across dining areas

Open `/acme/reservations/floor` as `kody` on a business date where one table is
empty, one has an upcoming/arrived reservation, one is currently `seated` with a
course status (`entree` or `check_dropped`), and one has an active table block.
Pass: the canvas renders the published floor plan shapes (`round`, `square`,
`rect`, `booth`, `bar`, plus architectural elements) in their saved positions,
colors each table distinctly by its live state, and switches dining areas via
the area tabs. Tool: agent-browser Evidence: screenshot(floor-live-statuses),
network(GET /operator/reservations/book/day -> 200), console-errors Milestone:
foh-core

### VAL-HOST-013: Seated tables on the live floor plan display party info and a live elapsed/remaining timer via useLiveNow

Seat a party at a table on `/acme/reservations/floor` and observe the table
shape on the canvas over at least 16 seconds while inspecting the browser
network log. Pass: the table displays the guest name (or party label), cover
count, and an elapsed / remaining turn-time counter (highlighting overstay when
elapsed exceeds `duration_min`), and the timer ticks forward via the 15-second
`useLiveNow` hook without issuing extra API requests for the clock tick. Tool:
agent-browser Evidence: screenshot(floor-seated-live-timer), console-errors
Milestone: foh-core

### VAL-HOST-014: Dragging an upcoming or arrived party from the floor side list onto an empty table seats or assigns them

On `/acme/reservations/floor`, drag an `arrived` (or `booked`) party from the
side reservation list and drop it onto a compatible empty table on the canvas.
Pass: dropping the party assigns the table and transitions (or offers to seat)
the party to `seated`, updates the table's visual state and occupancy on the
floor canvas immediately, and persists the change in `rsv_reservations` and
`rsv_table_occupancies`. Tool: agent-browser Evidence:
screenshot(floor-drag-party-to-table), network(POST
/operator/reservations/book/reservations/:id/status|assign -> 200),
sqlite(rsv_reservations and rsv_table_occupancies) Milestone: foh-core

### VAL-HOST-015: Dropping a party onto an already-assigned or occupied table on the floor plan presents swap, reflow, or overbook choices

On `/acme/reservations/floor`, drag party P1 onto Table T1 when T1 is already
assigned to another party P2. Pass: instead of silently failing or overwriting,
the floor UI presents explicit conflict resolution options (swap P1 and P2's
tables when P1 has a table, move P2 to another table if P2 is soft-assigned, or
explicitly overbook with a reason); choosing swap or move updates both parties
cleanly and reflects their new table assignments on the canvas. Tool:
agent-browser Evidence: screenshot(floor-drop-conflict-resolution), network(POST
/operator/reservations/book/reservations/:id/assign -> 200) Milestone: foh-core

### VAL-HOST-016: Clicking a table on the live floor plan opens quick actions for walk-in seating, current party detail, course status, and table block

On `/acme/reservations/floor`, click an empty table and verify the quick action
to seat a walk-in directly at that table (or block the table); then click a
currently seated table and verify quick actions to open the party's detail sheet
(`?r=<id>`), advance its course/bussing status, or mark it `finished`. Pass:
both table popovers/sheets work without leaving `/acme/reservations/floor` and
persist the chosen action to the regional API. Tool: agent-browser Evidence:
screenshot(floor-table-quick-actions), network(POST
/operator/reservations/book/walk-ins -> 200|201), console-errors Milestone:
foh-core

### VAL-HOST-017: Floor plan 5-second ETag polling pauses during drag gestures

On `/acme/reservations/floor`, start dragging a party card from the side list
over the floor canvas and hold the drag across at least 7 seconds (spanning the
5-second poll interval) before dropping onto a table. Pass: the in-flight drag
is not interrupted or reset by the 5-second poll, and dropping the party
completes the assignment. Tool: agent-browser Evidence:
screenshot(floor-drag-poll-paused), console-errors Milestone: foh-core

### VAL-HOST-018: Section layout setup supports creating, editing, and deleting section layouts with color tokens and table sets

Open `/acme/reservations/settings/sections` as `kody` and create a section
layout (`"Dinner 3-server"`) containing three sections (for example
`"Section A"`, `"Section B"`, `"Patio"`) with distinct `color_token` values
(`1..8`) and assign tables to each section; then rename a section and delete a
throwaway layout. Pass: `POST`, `PATCH`, and `DELETE` on
`/operator/reservations/setup/sections/layouts` succeed (`200`/`201`), rows are
persisted in `rsv_section_layouts`, `rsv_sections`, and `rsv_section_tables`,
and `rsv_audit_log` records the setup change. Tool: agent-browser Evidence:
screenshot(settings-sections-crud), network(POST
/operator/reservations/setup/sections/layouts -> 200|201),
sqlite(rsv_section_layouts, rsv_sections, rsv_section_tables) Milestone:
foh-core

### VAL-HOST-019: A table cannot belong to two sections in the same section layout

In `/acme/reservations/settings/sections` (and via direct `PUT`/`PATCH` to
`/operator/reservations/setup/sections/layouts/:id`), attempt to assign the same
`table_id` to two different sections within the same `layout_id`. Pass: the UI
either moves the table from the first section to the second or prevents
duplicate selection, and any raw API payload placing one `table_id` in two
sections of the same layout is rejected (`400`/`409`) or deduplicated so
`rsv_section_tables` always satisfies its `(layout_id, table_id)` primary key.
Tool: curl Evidence: network(PATCH
/operator/reservations/setup/sections/layouts/:id duplicate table -> 400|409 or
deduplicated), sqlite(rsv_section_tables uniqueness per layout_id) Milestone:
foh-core

### VAL-HOST-020: Per-service section server assignment supports both staff_id and free-text server_label and overlays on the Floor screen

On `/acme/reservations/floor` for a selected date and service, enable the
Section overlay and open the section server assignment control
(`GET/PUT /operator/reservations/book/sections/assignments?locationId=...&date=...&serviceId=...`).
Assign one section to a free-text `server_label` (`"Samir"`) and—when
`staffing.enabled` is on for the org—assign another section to a scheduled
`staff_id` (and verify it still works with `server_label` when
`staffing.enabled` is off). Pass: `PUT /sections/assignments` persists rows in
`rsv_section_assignments`, and the floor canvas outlines or badges each
section's tables with its `color_token` and assigned server name. Tool:
agent-browser Evidence: screenshot(floor-section-overlay-and-servers),
network(PUT /operator/reservations/book/sections/assignments -> 200),
sqlite(rsv_section_assignments) Milestone: foh-core

### VAL-HOST-021: Month calendar view shows per-day covers, party counts, and closed/special day badges and drills into the selected date

Open `/acme/reservations/calendar` as `kody` for a month containing seeded or
validator-created bookings and at least one special/closed day
(`rsv_special_days`). Pass:
`GET /operator/reservations/book/calendar?locationId=...&month=YYYY-MM` returns
per-day cover totals, party counts, and closed/special-day flags; the calendar
grid renders those numbers and badges on each date cell; and clicking a day cell
navigates to that business date in the Book or Timeline view. Tool:
agent-browser Evidence: screenshot(calendar-month-view), network(GET
/operator/reservations/book/calendar -> 200), console-errors Milestone: foh-core

### VAL-HOST-022: Pre-service overview summarizes covers, large parties, VIP/tagged guests, occasions, dietary counts, and pacing peaks

Open `/acme/reservations/overview` on a business date and service where bookings
include a large party (`party_size >= 6`), a guest with a VIP/custom tag, a
booking with an occasion (`birthday` or `anniversary`), and a booking with
dietary/allergy notes. Pass: `GET /operator/reservations/book/overview` and the
Overview screen display accurate totals for covers and parties, list the large
parties, VIP/tagged bookings, and occasions, report dietary/allergy counts, and
highlight peak 15-minute arrival slots. Tool: agent-browser Evidence:
screenshot(overview-preservice-brief), network(GET
/operator/reservations/book/overview -> 200), console-errors Milestone: foh-core

### VAL-HOST-023: Pre-service overview redacts raw allergy text for operators without read:reservation_guest:any

With a booking on the selected date whose guest has `allergy_notes` set to
`contract-allergy-host023`, open `/acme/reservations/overview` (and call
`GET /operator/reservations/book/overview`) first as `kody` and then as a Host
operator (`read:reservation:any` + `update:reservation:any`, no guest grants).
Pass: `kody` can view the dietary/allergy detail, whereas the Host operator's
Overview UI and network response from `GET /operator/reservations/book/overview`
omit the literal string `contract-allergy-host023` (showing at most
non-sensitive counts or flags). Tool: agent-browser Evidence:
screenshot(overview-host-redacted), network(GET
/operator/reservations/book/overview as Host -> 200 without allergy text)
Milestone: foh-core Isolation: serial (uses Host operator account without guest
grants)

### VAL-HOST-024: Saving pre-service notes persists per location, date, and service period and surfaces on host views

On `/acme/reservations/overview`, enter service notes
(`"86 halibut; Chef table VIP at 20:00"`) for the selected location, business
date, and service period and save
(`PUT /operator/reservations/book/service-notes`). Reload
`/acme/reservations/overview` and switch to another service period and back.
Pass: the notes persist in `rsv_service_notes` keyed by
`(location_id, business_date, service_period_id)`, reload intact for that
service, do not bleed into a different date or service period, and are visible
to hosts on the overview/host stand. Tool: agent-browser Evidence:
screenshot(overview-service-notes-saved), network(PUT
/operator/reservations/book/service-notes -> 200), sqlite(rsv_service_notes row)
Milestone: foh-core

### VAL-HOST-025: Host-stand RBAC enforces update:reservation:any for assignments/service-notes and update:reservation_settings:any for section layouts

Using a read-only reservation token (`read:reservation:any` only), call
`POST /operator/reservations/book/reservations/:id/assign`,
`PUT /operator/reservations/book/service-notes`, and
`PUT /operator/reservations/book/sections/assignments`; using a `book`-scope
token (`update:reservation:any`, no settings grants), call
`POST /operator/reservations/setup/sections/layouts`. Also open
`/acme/reservations/timeline` and `/acme/reservations/floor` as the read-only
operator. Pass: Timeline and Floor render in read-only mode, all three
`book`-write calls with the read-only token return `403`, and the section-layout
setup write without `update:reservation_settings:any` returns `403`. Tool: curl
Evidence: network(POST .../assign readonly -> 403, PUT .../service-notes
readonly -> 403, POST .../setup/sections/layouts without settings grant -> 403),
screenshot(timeline-readonly) Milestone: foh-core

### VAL-HOST-026: Host-stand screens (Timeline, Floor, Calendar, Overview) fit iPad landscape (1024x768) without clipped controls

Resize the browser viewport to `1024x768` (iPad landscape) and open
`/acme/reservations/today`, `/acme/reservations/timeline`,
`/acme/reservations/floor`, `/acme/reservations/calendar`, and
`/acme/reservations/overview`. Pass: on every screen, the primary navigation,
date/service switchers, Walk-in and New reservation buttons, and the main canvas
or table scroll container remain reachable and visible without unintended
document-level horizontal overflow or overlapping interactive controls. Tool:
agent-browser Evidence: screenshot(ipad-1024x768-timeline),
screenshot(ipad-1024x768-floor), console-errors Milestone: foh-core

### VAL-HOST-027: KSA organization (riyadh-grill) runs Timeline, Floor, Calendar, and Overview on tenant-api-ksa and renders RTL in Arabic

Open `/riyadh-grill/reservations/timeline?lng=ar`,
`/riyadh-grill/reservations/floor?lng=ar`,
`/riyadh-grill/reservations/calendar?lng=ar`, and
`/riyadh-grill/reservations/overview?lng=ar` as `kody`, and drag-assign a
reservation on the KSA timeline. Pass: all API requests target
`http://localhost:3009` (`tenant-api-ksa`), the UI sets `dir="rtl"` with Arabic
labels and zero untranslated message IDs, table numbers and time labels remain
legible without character reversal, and the assignment writes only to the KSA
tenant database. Tool: agent-browser Evidence: screenshot(ksa-timeline-ar-rtl),
screenshot(ksa-floor-ar-rtl), network(POST
http://localhost:3009/operator/reservations/book/reservations/:id/assign ->
200), console-errors Milestone: foh-core

### VAL-HOST-028: Opening and closing the detail sheet (?r=<id>) on Timeline and Floor preserves date, service, and area state

On `/acme/reservations/timeline` and `/acme/reservations/floor`, switch to a
non-default business date, service period, and dining area tab, click a
reservation bar or seated table to open the detail sheet (`?r=<id>`), perform a
note or status update, and close the sheet. Pass: the detail sheet opens in
place over Timeline and Floor, reflects the update immediately on the underlying
timeline bar or floor table, and closing the sheet preserves the selected date,
service period, and dining area tab. Tool: agent-browser Evidence:
screenshot(timeline-detail-sheet-context-preserved),
screenshot(floor-detail-sheet-context-preserved), console-errors Milestone:
foh-core

---

---

Shared preconditions for all assertions unless one says otherwise: all five
services up per `services.yaml` (`tenant-api-us` 3007, `tenant-api-ksa` 3009,
`app` 3001, `sites` 3008); `commands.seed_reservations_acme` and
`commands.seed_reservations_ksa` have run; org flags `reservations.enabled true`
and `reservations.online true` set for `acme` and `riyadh-grill` via
`commands.set_org_flag`. Seeded acme location settings are the defaults: hold 7
min, min notice 60 min, horizon 30 days, online party 1-8,
`max_active_per_phone` 3, `guest_modify_cutoff_min` 120, large-party mode
`request`. Public curl calls send `Origin: http://acme.menuza.test:3008` (US,
port 3007) or `Origin: http://riyadh-grill.menuza.test:3008` (KSA, port 3009).
Validators use their own guest phones/emails and booking dates per the
data-isolation rules in `library/user-testing.md`. Operator tokens are obtained
with the recipe in `library/user-testing.md` section 4 (never pasted into
reports). SQLite reads are read-only: US org DB
`packages/database/db/tenant_t58bgatqh3rv0s3movrecyj1.db`, KSA org DB
`packages/database/db/ksa/tenant_ru0dm42cud9scs4g2duep21c.db`.

## Area: Online booking - public API

### VAL-ONLINE-001: Config describes the bookable restaurant

`curl -H 'Origin: http://acme.menuza.test:3008' http://localhost:3007/reservations/config`
returns 200 with `Cache-Control: private, no-store` and a body listing the
bookable locations (id, name, address, time zone), party limits (min 1, max 8),
the horizon, the large-party mode and contact, the waitlist/notify flags, public
notes, and occasion/dietary chips. The body contains no guest names, phones or
emails. Repeat against 3009 with the riyadh-grill Origin and get the
riyadh-grill locations with `Asia/Riyadh` time zone. Tool: curl Evidence:
terminal(curl commands), network(GET /reservations/config -> 200) Milestone:
guest-channels-and-crm

### VAL-ONLINE-002: Availability returns grid slots with dayVersion, now and ETag

`GET /reservations/availability?locationId=<id>&date=<open future date>&partySize=2`
returns 200 with `dayVersion`, `timeZone`, the server's `now`, and `slots` whose
start times lie on the location's booking grid (default 15-minute interval)
inside a service's seating window. The response carries
`ETag: "<dayVersion>.<settingsVersion>"`; repeating the request with
`If-None-Match` returns 304 with an empty body, and after any booking is made on
that date the same conditional request returns 200 with a new ETag. Tool: curl
Evidence: terminal(curl commands), network(GET /reservations/availability -> 200
/ 304) Milestone: guest-channels-and-crm

### VAL-ONLINE-003: Calendar summary is capped at 62 days

`GET /reservations/calendar?locationId=<id>&partySize=2&from=<today>&to=<today+30>`
returns 200 with one entry per day, each with `hasAvailability` and first/last
slot information, and days outside the horizon or closed show
`hasAvailability: false`. A request spanning more than 62 days is refused with a
4xx validation error. Days with a `closed` special day are distinguishable from
ordinary sold-out days. Tool: curl Evidence: terminal(curl commands),
network(GET /reservations/calendar -> 200) Milestone: guest-channels-and-crm

### VAL-ONLINE-004: Alternatives appear when the requested time is unavailable

Pick a date/time and party size, then book every online-bookable unit for that
slot (repeat holds+bookings with distinct phones until the slot disappears from
availability). The next availability response for that slot contains no slot at
the requested time and a non-empty `alternatives` object: `sameDay` lists other
slots on the same date and `otherDates` lists `{ date, firstLocalMin }` entries
on later dates. Tool: curl Evidence: terminal(curl script), network(GET
/reservations/availability -> 200) Milestone: guest-channels-and-crm

### VAL-ONLINE-005: Booking-window rules constrain online results

With the operator settings API (setup token), set `min_notice_min` 120,
`same_day_cutoff_min` 900 (15:00), `horizon_days` 14 and `release_local_min` 600
(10:00) on the seeded acme location. Then: (a) no slot starting less than 120
minutes from the server's `now` is offered online; (b) after 15:00 local
wall-clock no same-day slot is offered (validate by querying with the clock on
the far side of the cutoff, or temporarily move the cutoff 1 minute into the
future); (c) no date beyond today+14 is offered; (d) before 10:00 local the
newest horizon day is withheld and at 10:00 it appears (query one minute before
and after, or set the release time one minute ahead of the current wall clock
and poll). Restore the defaults afterwards. Tool: curl Evidence: terminal(curl
script), network(GET /reservations/availability -> 200) Milestone:
guest-channels-and-crm Isolation: serial (changes acme location settings)

### VAL-ONLINE-006: Party-size limits and the large-party signal

Availability with `partySize=0` or `partySize=500` returns a 4xx validation
error (`party_size_invalid`). With the seeded online max of 8, `partySize=8`
returns slots and `partySize=9` returns 200 with `slots: []` and a `largeParty`
object that carries the configured mode (`request`) instead of a 4xx. The
large-party response includes the location contact information from the config.
Tool: curl Evidence: terminal(curl commands), network(GET
/reservations/availability -> 200 / 4xx) Milestone: guest-channels-and-crm

### VAL-ONLINE-007: Closed and online-closed special days behave differently

Using the operator settings API, create a special day of kind `closed` with a
public note for date D1 and a special day of kind `online_closed` for date D2 on
the seeded acme location. Public availability for D1 returns no slots and a
`closed` object with the reason and note; D2 also returns no online slots.
Operator availability (`GET /operator/reservations/book/availability` with a
`book` token) still returns slots for D2 but not for D1. Delete the special days
afterwards. Tool: curl Evidence: terminal(curl script), network(GET
/reservations/availability -> 200, GET /operator/reservations/book/availability
-> 200) Milestone: guest-channels-and-crm Isolation: serial (changes acme
special days)

### VAL-ONLINE-008: Staff-only and walk-in-only tables are never offered online

Using the operator settings API, mark every seeded acme table `staff_only` or
`walk_in_only` for the dinner service via per-service availability rows (or
`online_bookable` off) except one table T. Book T for a slot through the public
API, then query availability again for the same slot: it returns no slot, even
though the staff-only and walk-in-only tables are physically free. Operator
availability for the same slot still shows bookable capacity. Restore the
availability rows afterwards. Tool: curl Evidence: terminal(curl script),
sqlite(SELECT mode FROM rsv_service_availability) Milestone:
guest-channels-and-crm Isolation: serial (changes acme table availability)

### VAL-ONLINE-009: Hold creation returns token, expiresAt and server now

`POST /reservations/holds` with
`{ locationId, slot: { date, localMin, partySize: 2 } }` returns 200/201 with
`holdToken`, `expiresAt` (ISO), the server's `now` (ISO) and the held `slot`.
`expiresAt - now` equals the configured hold length (default 7 minutes, within a
few seconds of transport). The hold token is high-entropy and the tenant DB
stores only `sha256(token)` in `rsv_holds.token_hash` (the plaintext token
matches no column value). Tool: curl Evidence: terminal(curl commands),
network(POST /reservations/holds -> 201), sqlite(SELECT token_hash, status,
expires_at FROM rsv_holds) Milestone: guest-channels-and-crm

### VAL-ONLINE-010: A live hold consumes capacity like a booking

Choose a slot with exactly one fitting online unit (use the last available start
time for the largest online party size, or exhaust other units first). Create a
hold for that slot, then re-query availability: the held slot is gone (or the
party size that needed that unit returns no slot).
`POST /reservations/holds/release` with the hold token makes the slot reappear
in the very next availability response. Tool: curl Evidence: terminal(curl
script), network(GET /reservations/availability -> 200, POST
/reservations/holds/release -> 200) Milestone: guest-channels-and-crm

### VAL-ONLINE-011: An expired hold consumes no capacity

With the operator settings API, set `hold_minutes` to its minimum (3) on the
seeded acme location. Create a hold for a slot, wait 3.5 minutes without
converting it, then query availability: the slot is offered again, and a fresh
booking for that slot with a different guest succeeds with 201. Restore
`hold_minutes` to 7 afterwards. (The same wait window can host VAL-ONLINE-015.)
Tool: curl Evidence: terminal(curl script with sleep), network(POST
/reservations -> 201) Milestone: guest-channels-and-crm Isolation: serial
(changes acme hold_minutes; waits on the wall clock)

### VAL-ONLINE-012: replaceHoldToken releases the previous hold

Create hold A for slot S1, then create hold B for slot S2 with
`replaceHoldToken: <A's token>`. The response is hold B; using A's token against
`GET /reservations/holds/current` or `POST /reservations` returns the same
refusal as an unknown token, and the tenant DB shows hold A with status
`released`. Capacity behind S1 is bookable again immediately. Tool: curl
Evidence: terminal(curl script), sqlite(SELECT status FROM rsv_holds) Milestone:
guest-channels-and-crm

### VAL-ONLINE-013: Booking converts a hold and returns code plus manage token

Create a hold, then `POST /reservations` with `Idempotency-Key: <uuid>`,
`X-Client: web`, the hold token and
`{ guest: { firstName, lastName, phone, email }, locale: 'en', smsOptIn: false, website: '' }`.
The response is 201 with a `reservation` (status `booked`, channel `online`, an
8-character Crockford-base32 `confirmationCode`) and a `manageToken`. The tenant
DB row has the matching `hold_id`, `channel = 'online'`, `client = 'web'`, and
the hold row is `converted`. A second conversion attempt with the same hold
token fails. Tool: curl Evidence: terminal(curl script), network(POST
/reservations -> 201), sqlite(SELECT confirmation_code, channel, client, hold_id
FROM rsv_reservations; SELECT status FROM rsv_holds) Milestone:
guest-channels-and-crm

### VAL-ONLINE-014: Idempotent replay returns the same booking

Repeat the exact booking request of a successful booking (same
`Idempotency-Key`, byte-identical body). The response is again 201 with the same
reservation id, the same confirmation code and an equivalent manage token, and
`rsv_reservations` contains exactly one row for the attempt. Then re-send the
same key with one body field changed (for example a different `firstName`): the
response is 409 with `error: 'idempotency_conflict'` and still no second row.
Tool: curl Evidence: terminal(curl script), network(POST /reservations -> 201 /
409), sqlite(SELECT COUNT(*) FROM rsv_reservations WHERE ...) Milestone:
guest-channels-and-crm

### VAL-ONLINE-015: Expired hold cannot book; a new key creates nothing when the slot is gone

With `hold_minutes` at 3 (serial setting from VAL-ONLINE-011): create hold H for
slot S, wait for expiry, book S with a different guest, then attempt
`POST /reservations` with H's token: the response is 410 with
`error: 'hold_expired'` and no reservation is created. Separately, after a
successful booking for the last unit of a slot, retry the booking with the same
body but a fresh `Idempotency-Key` and a different phone: the response is 409
`slot_unavailable` carrying alternatives, and no second reservation row exists.
Tool: curl Evidence: terminal(curl script with sleep), network(POST
/reservations -> 410 / 409), sqlite(SELECT COUNT(*) FROM rsv_reservations WHERE
...) Milestone: guest-channels-and-crm Isolation: serial (changes acme
hold_minutes; waits on the wall clock)

### VAL-ONLINE-016: A valid hold loses only to a staff overbook

Create a live hold for slot S. With an operator `book` token, create a staff
booking for the same slot with explicit `overbook: true`. Convert the guest hold
via `POST /reservations`: the response is 409 with `error: 'slot_unavailable'`
and a list of alternative slots, no reservation is created, and the hold row is
not `converted`. Without the staff overbook the same conversion succeeds
(control case, may reuse VAL-ONLINE-013's booking). Tool: curl Evidence:
terminal(curl script), network(POST /reservations -> 409), sqlite(SELECT status
FROM rsv_holds) Milestone: guest-channels-and-crm

### VAL-ONLINE-017: Per-phone active limit is enforced

With the default `max_active_per_phone` of 3, create three future bookings for
the same phone number on different dates or times. A fourth booking attempt with
that phone is refused with a 4xx (429 `rate_limited` or the documented limit
error) and no fourth active reservation exists. Cancelling one of the three
makes the same phone bookable again. Tool: curl Evidence: terminal(curl script),
network(POST /reservations -> 4xx), sqlite(SELECT COUNT(*) FROM rsv_reservations
r JOIN rsv_guests g ...) Milestone: guest-channels-and-crm

### VAL-ONLINE-018: Validation errors name fields but never echo values

`POST /reservations` with a body whose `guest.phone` is the distinctive invalid
string `zz-not-a-phone-zz` and whose `guest.email` is `not-an-email` returns 400
with `error: 'invalid'` (or the documented validation shape) listing the field
paths `guest.phone` and `guest.email`. The response body does not contain the
strings `zz-not-a-phone-zz` or `not-an-email` anywhere. Tool: curl Evidence:
terminal(curl + grep of the response body), network(POST /reservations -> 400)
Milestone: guest-channels-and-crm

### VAL-ONLINE-019: The honeypot answers like success and writes nothing

`POST /reservations` with a valid hold and body identical to a success except
`website: 'https://spam.example'` returns the same status code and response
shape as a real booking (201 with a reservation-looking payload). Afterwards,
`rsv_reservations` and `rsv_guests` contain no new rows for the submitted
name/phone, and any manage token in the response does not open a real booking
via `GET /reservations/manage`. Tool: curl Evidence: terminal(curl script),
network(POST /reservations -> 201), sqlite(row counts before/after) Milestone:
guest-channels-and-crm

### VAL-ONLINE-020: Read-route rate limits answer 429 at the documented numbers

Loop `GET /reservations/availability` (limit 60/min): the 61st request inside a
minute returns 429 with `error: 'rate_limited'`; `GET /reservations/calendar`
(limit 30/min) returns 429 on the 31st request. After the window passes the
routes answer 200 again. Tool: curl Evidence: terminal(curl loop), network(GET
/reservations/availability -> 429) Milestone: guest-channels-and-crm Isolation:
serial (in-memory per-IP buckets are shared by all loopback validators)

### VAL-ONLINE-021: Durable hold limit survives a tenant-api restart

Create 10 holds within 10 minutes (durable limit 10 per IP hash per 10 min): the
11th returns 429 `rate_limited`. Stop and start `tenant-api-us` with the
`services.yaml` commands, then immediately create another hold: it is still 429,
proving the counter in `rsv_rate_counters` persisted. The refusal lifts after
the 10-minute window. Tool: curl Evidence: terminal(curl loop + service
restart), network(POST /reservations/holds -> 429), sqlite(SELECT bucket, count
FROM rsv_rate_counters) Milestone: guest-channels-and-crm Isolation: serial
(restarts tenant-api-us; shared loopback IP bucket)

### VAL-ONLINE-022: Manage mutations are limited to 30/hour per token, durably

With a valid manage token, call any mix of `POST /reservations/manage/confirm`
and `POST /reservations/manage/late` 31 times within an hour. The 31st call
returns 429 `error: 'rate_limited'`, and the refusal survives a tenant-api-us
restart (durable counter in `rsv_rate_counters`). `GET /reservations/manage`
with the same token is on its own 60/min budget and keeps working. Tool: curl
Evidence: terminal(curl loop + service restart), network(POST
/reservations/manage/late -> 429) Milestone: guest-channels-and-crm Isolation:
serial (restarts tenant-api-us; burns one booking's mutation budget)

### VAL-ONLINE-023: Mutations are POST-only

`GET`, `PUT`, `PATCH` and `DELETE` against `POST`-only routes
(`POST /reservations`, `POST /reservations/holds`,
`POST /reservations/requests`, `POST /reservations/manage/cancel`,
`POST /reservations/manage/confirm`, `POST /reservations/manage/modify`,
`POST /reservations/manage/late`, `POST /reservations/holds/release`) never
produce 2xx and never mutate: a booking targeted by a
`GET /reservations/manage/cancel?t=<token>` attempt is still `booked` afterwards
in both `GET /reservations/manage` and the tenant DB. Tool: curl Evidence:
terminal(curl script), network(GET /reservations/manage/cancel -> 4xx),
sqlite(SELECT status FROM rsv_reservations) Milestone: guest-channels-and-crm

### VAL-ONLINE-024: Every public route answers the uniform 404 without a bound Origin

For each of these routes — `GET /reservations/config`,
`GET /reservations/availability`, `GET /reservations/calendar`,
`GET /reservations/holds/current`, `GET /reservations/manage`,
`GET /reservations/manage/availability`,
`GET /reservations/manage/calendar.ics`, `GET /reservations/mine`,
`POST /reservations/holds`, `POST /reservations/holds/release`,
`POST /reservations`, `POST /reservations/requests`,
`POST /reservations/manage/modify`, `POST /reservations/manage/cancel`,
`POST /reservations/manage/confirm`, `POST /reservations/manage/late` — a
request with no `Origin`, with an unknown `Origin` (for example
`http://no-such-org.menuza.test:3008`), or with an `orgId` query parameter
instead of an Origin returns the identical 404 `{ error: 'not_found' }` response
shape; none returns 2xx or reveals whether an organization exists. (Local
`?slug=`/`?host=` resolution outside production is allowed and may be used by
tools.) Tool: curl Evidence: terminal(curl loop over the route list),
network(GET /reservations/config -> 404) Milestone: guest-channels-and-crm

### VAL-ONLINE-025: Wrong region fails closed

Send `Origin: http://riyadh-grill.menuza.test:3008` to the US node (3007) and
`Origin: http://acme.menuza.test:3008` to the KSA node (3009) for
`GET /reservations/config` and `POST /reservations/holds`: every response is the
uniform 404 `not_found`, identical to an unknown Origin, and no data crosses
nodes. Tool: curl Evidence: terminal(curl commands), network(GET
/reservations/config -> 404) Milestone: guest-channels-and-crm

### VAL-ONLINE-026: Capability tokens fail closed and uniformly

Against `GET /reservations/manage`, `GET /reservations/manage/calendar.ics` and
`POST /reservations/manage/cancel`: a missing token, a garbage token, a valid
acme manage token sent to the KSA node (3009), and a valid manage token for a
different acme booking all return the identical 404 `not_found`. Expired and
rotated manage tokens are covered by the security sweep (VAL-ONLINE-042) because
rotation ships with `POST /operator/reservations/book/reservations/:id/resend`
in `guest-messages`. Tool: curl Evidence: terminal(curl script), network(GET
/reservations/manage -> 404) Milestone: guest-channels-and-crm

### VAL-ONLINE-027: `reservations.online` off stops booking but keeps manage links

Set `reservations.online false` for acme (master stays on) via
`commands.set_org_flag` and wait out the 5-minute public-write context freshness
(or trigger a context refresh by restarting tenant-api-us). Then
`GET /reservations/config`, `GET /reservations/availability`,
`GET /reservations/calendar`, `POST /reservations/holds`, `POST /reservations`
and `POST /reservations/requests` all return the uniform 404, while
`GET /reservations/manage`, `POST /reservations/manage/confirm`,
`POST /reservations/manage/late` and `GET /reservations/manage/calendar.ics` for
an existing booking keep working. Restore the flag to `true` afterwards. Tool:
curl Evidence: terminal(curl script), network(POST /reservations/holds -> 404,
GET /reservations/manage -> 200) Milestone: guest-channels-and-crm Isolation:
serial (changes the acme org flag)

### VAL-ONLINE-028: Master flag off hides every public route

Set `reservations.enabled false` for acme via `commands.set_org_flag`, wait out
the context cache as in VAL-ONLINE-027, and re-run the full public route list
from VAL-ONLINE-024 including the manage routes: every one returns the
uniform 404. An operator route (`GET /operator/reservations/book/day` with a
valid `book` token) also refuses. Restore the flag afterwards. Tool: curl
Evidence: terminal(curl loop), network(GET /reservations/config -> 404)
Milestone: guest-channels-and-crm Isolation: serial (changes the acme org flag)

### VAL-ONLINE-029: RESERVATIONS_PUBLIC_ENABLED=false answers 503 on public routes only

Restart `tenant-api-us` with `RESERVATIONS_PUBLIC_ENABLED=false`, then re-run
the public route list from VAL-ONLINE-024 with a valid Origin: every route
returns 503 `{ error: 'unavailable' }`, including reads and manage routes.
Operator routes are unaffected: `GET /operator/reservations/book/day` without a
token returns 401 (not 503) and with a valid `book` token returns 200. Restart
the node normally afterwards. Tool: curl Evidence: terminal(curl loop + service
restart), network(GET /reservations/config -> 503, GET
/operator/reservations/book/day -> 200) Milestone: guest-channels-and-crm
Isolation: serial (restarts tenant-api-us with an env change)

### VAL-ONLINE-030: Manage view shows the booking without leaking full contact data

`GET /reservations/manage` with `X-Reservation-Token: <manageToken>` returns 200
with the guest's first name, date/time, party size, location, status, occasion,
the guest's own requests, policy terms, payment status, a masked contact form
(no full phone or email), and the booleans `canModify`, `canCancel` plus
`cancelDeadline`. For a booking starting more than `guest_modify_cutoff_min`
(default 120 min) in the future both booleans are true. A booking in `cancelled`
status shows that status. Tool: curl Evidence: terminal(curl script),
network(GET /reservations/manage -> 200) Milestone: guest-channels-and-crm

### VAL-ONLINE-031: Guest modify moves the booking and frees the old slot

Book a slot S1 on a date with at least two available times.
`POST /reservations/manage/modify` with the manage token and a new time S2
returns 200 and the manage view shows S2. Availability for S1 immediately offers
the freed slot again (cancelling/modifying never removes availability, I8), and
S2 is consumed. Modifying to a sold-out slot returns 409 `slot_unavailable` with
alternatives and the booking is unchanged (I6). Tool: curl Evidence:
terminal(curl script), network(POST /reservations/manage/modify -> 200 / 409,
GET /reservations/availability -> 200) Milestone: guest-channels-and-crm

### VAL-ONLINE-032: Guest modify and cancel close inside the cutoff

With the operator settings API, set `guest_modify_cutoff_min` to 100000 on the
seeded acme location so every booking is inside the cutoff.
`POST /reservations/manage/modify` returns 4xx with `error: 'modify_closed'`,
`POST /reservations/manage/cancel` returns `error: 'cancel_closed'`, and the
manage view shows `canModify: false` and `canCancel: false`. The booking itself
is unchanged. Restore the default afterwards. Tool: curl Evidence: terminal(curl
script), network(POST /reservations/manage/modify -> 4xx) Milestone:
guest-channels-and-crm Isolation: serial (changes acme guest_modify_cutoff_min)

### VAL-ONLINE-033: Guest cancellation frees the capacity for rebooking

Book the last unit of a slot, then `POST /reservations/manage/cancel` with the
manage token: the response is 200, the manage view shows status `cancelled` with
`cancelled_by = guest` in the tenant DB, and the same slot is immediately
bookable again by a different guest through the public flow. A second cancel
call is a no-op or a clean 4xx, never a 5xx. Tool: curl Evidence: terminal(curl
script), network(POST /reservations/manage/cancel -> 200, GET
/reservations/availability -> 200), sqlite(SELECT status, cancelled_by FROM
rsv_reservations) Milestone: guest-channels-and-crm

### VAL-ONLINE-034: Guest confirm moves booked to confirmed

For a booking in status `booked`, `POST /reservations/manage/confirm` with the
manage token returns 200 and the manage view and tenant DB show status
`confirmed`. A repeat confirm is idempotent (still `confirmed`, no error). Tool:
curl Evidence: terminal(curl commands), network(POST
/reservations/manage/confirm -> 200), sqlite(SELECT status FROM
rsv_reservations) Milestone: guest-channels-and-crm

### VAL-ONLINE-035: Running late is recorded and visible to the operator

Book as a guest, then `POST /reservations/manage/late` with the manage token and
`{ minutes: 20 }` returns 200. In the App, signed in as kody on acme, open
`/acme/reservations/today` (or Book for that date) within one poll interval: the
booking shows a running-late indication of 20 minutes. The tenant DB row has
`running_late_min = 20`. Tool: agent-browser Evidence:
screenshot(today-running-late), network(POST /reservations/manage/late -> 200),
sqlite(SELECT running_late_min FROM rsv_reservations) Milestone:
guest-channels-and-crm

### VAL-ONLINE-036: The .ics download describes the booking

`GET /reservations/manage/calendar.ics?t=<manageToken>` (or with the
`X-Reservation-Token` header) returns 200 with content type `text/calendar`,
header `Referrer-Policy: no-referrer`, and a VEVENT whose `DTSTART`/`DTEND`
match the booking's start and end instants and whose `SUMMARY`/`LOCATION` name
the restaurant. An unknown token returns the uniform 404. Tool: curl Evidence:
terminal(curl + grep of the .ics body), network(GET
/reservations/manage/calendar.ics -> 200) Milestone: guest-channels-and-crm

### VAL-ONLINE-037: /mine lists a signed-in customer's bookings and nothing else's

Sign in on the acme site with phone OTP (`+15555550123`, code from
`commands.read_sms_code`) and capture the customer access token from
`localStorage`. Book once while sending `Authorization: Bearer <token>` and once
in a fresh flow with a different phone and no token. `GET /reservations/mine`
with the Bearer token returns 200 listing only the linked booking (upcoming
section) with a fresh derived manage token per booking. The same request without
a token, with a garbage token, or with a riyadh-grill customer token is rejected
(4xx, never 2xx). Tool: curl Evidence: terminal(curl script), network(GET
/reservations/mine -> 200 / 4xx), sqlite(SELECT customer_id FROM
rsv_reservations) Milestone: guest-channels-and-crm

### VAL-ONLINE-038: Large-party request lifecycle over the API

With the seeded `request` mode and online max 8, `POST /reservations/requests`
with `Idempotency-Key` for party 12 returns 200/201 with the request in status
`requested`. With the default `request_holds_capacity`, availability for that
window shrinks while the request is pending. An operator `book` token then:
`POST /operator/reservations/book/reservations/:id/approve` moves it to `booked`
and the guest-facing manage view shows the approved booking; `POST .../decline`
on a second request moves it to `declined` and the held capacity reappears in
public availability. Replayed requests with the same `Idempotency-Key` return
the same request. Tool: curl Evidence: terminal(curl script), network(POST
/reservations/requests -> 201, POST .../approve -> 200), sqlite(SELECT status
FROM rsv_reservations) Milestone: guest-channels-and-crm

### VAL-ONLINE-039: Contact mode shows the phone instead of a request form

With the operator settings API, switch the seeded acme location's
`large_party_mode` to `contact` and set `contact_phone`.
`GET /reservations/availability?partySize=12` returns `largeParty` carrying the
contact mode and phone number, and the config response reflects the same mode.
Restore `request` mode afterwards. Tool: curl Evidence: terminal(curl script),
network(GET /reservations/availability -> 200) Milestone: guest-channels-and-crm
Isolation: serial (changes acme large-party mode)

### VAL-ONLINE-040: X-Client sets the recorded channel

Book once with `X-Client: ios` and once with `X-Client: android`. Both bookings
land with `channel = 'native'` and the `client` column recording `ios` /
`android` in `rsv_reservations`. Booking with `X-Client: web` (or absent) keeps
`channel = 'online'`. Tool: curl Evidence: terminal(curl script), sqlite(SELECT
channel, client FROM rsv_reservations ORDER BY created_at DESC) Milestone:
guest-channels-and-crm

### VAL-ONLINE-041: KSA bookings live only in the KSA tenant DB

Complete a public booking on riyadh-grill via 3009 with
`Origin: http://riyadh-grill.menuza.test:3008`. The row exists in
`packages/database/db/ksa/tenant_ru0dm42cud9scs4g2duep21c.db`
(`rsv_reservations` and `rsv_guests`), and no row with that guest's phone or
name exists in the US tenant DB
`packages/database/db/tenant_t58bgatqh3rv0s3movrecyj1.db`. The US node's logs
and the App's local D1 contain no trace of the guest PII (grep the guest's
distinctive name across `/tmp/menuza-logs/tenant-api-us.log` and query D1 via
`npx wrangler d1 execute DB --local`). Tool: terminal Evidence: sqlite(SELECT in
both tenant DBs), terminal(grep of logs and wrangler d1 query) Milestone:
guest-channels-and-crm

### VAL-ONLINE-042: Public security sweep and abuse tests pass

`cd apps/tenant-api && CI=true npx vitest run src/routes/reservations-security.test.ts`
(plus the abuse test file(s) it references) passes. The suite covers, for every
public `/reservations/*` route: no 2xx without Origin binding; forged,
cross-org, expired and rotated capability tokens all returning 404; refusal of
writes without Turnstile or a customer token when `TURNSTILE_SECRET_KEY` is
configured; GET never mutating; and validation errors echoing no submitted
values. Tool: terminal Evidence: terminal(CI=true npx vitest run
src/routes/reservations-security.test.ts) Milestone: guest-channels-and-crm

## Area: Online booking - Sites pages

### VAL-ONLINE-043: The /reserve gate follows the flags

With both flags on, `http://acme.menuza.test:3008/reserve` renders the booking
flow. `curl -H 'Host: acme.menuza.test:3008' http://localhost:3008/reserve`
returns HTML with `Cache-Control: no-store`. Set `reservations.online false` for
acme (`commands.set_org_flag`): the App gate
`GET /resources/sites/reservations?host=acme.menuza.test:3008` returns 404 and
the Sites page falls back to a CMS page named `reserve` or to 404 — the booking
flow is gone. Restore the flag afterwards. Tool: agent-browser Evidence:
screenshot(reserve-gated), terminal(curl of Sites and App gate), network(GET
/resources/sites/reservations -> 404) Milestone: guest-channels-and-crm
Isolation: serial (changes the acme org flag)

### VAL-ONLINE-044: Full guest booking flow on Sites

On `http://acme.menuza.test:3008/reserve` as an anonymous visitor: choose the
location, party size 2, an open future date from the calendar, and a time chip;
a hold countdown appears. Fill the details form (validator-owned
name/phone/email), submit, and land on a confirmation showing the 8-character
confirmation code, the booking details, an add-to-calendar control and a manage
link whose href contains `#t=`. The browser called
`http://localhost:3007/reservations/*` directly (visible in the network capture)
and no call carried guest data to the Sites origin. No console errors. Tool:
agent-browser Evidence: screenshot(confirmation), console-errors, network(POST
/reservations -> 201) Milestone: guest-channels-and-crm

### VAL-ONLINE-045: Time chips carry seating labels and restaurant-local times

With a seeded acme configuration that has guest-selectable areas, the time chips
on `/reserve` show seating-area labels. All displayed times are the restaurant's
local time; when the browser's time zone differs from the location's (set the
browser profile to a different zone), the page names the restaurant's zone next
to the times. Tool: agent-browser Evidence: screenshot(time-chips),
console-errors Milestone: guest-channels-and-crm

### VAL-ONLINE-046: Empty-slot state offers alternatives, not waitlist features

Pick a date/time with no availability (exhaust it as in VAL-ONLINE-004 or pick a
closed date). The Sites flow shows nearby alternative times for the same day and
other available dates. With `reservations.waitlist` off, no "Notify me" or "Join
waitlist" control is rendered anywhere in the flow, matching the
`notifyMe`/`waitlist` flags in the availability response. Tool: agent-browser
Evidence: screenshot(alternatives), network(GET /reservations/availability
-> 200) Milestone: guest-channels-and-crm

### VAL-ONLINE-047: Details-form validation is inline and the honeypot is invisible

On the details step, submit with an empty first name and a malformed phone: the
flow stays on the step, shows inline field errors, and no booking request
reaches tenant-api (network capture shows no `POST /reservations`). The
`website` honeypot field is present in the DOM but not visible or focusable in
the normal tab order. Tool: agent-browser Evidence:
screenshot(details-validation), console-errors, network(no POST /reservations)
Milestone: guest-channels-and-crm

### VAL-ONLINE-048: Hold countdown expiry returns the guest to slot selection

With `hold_minutes` set to 3 (serial setting, shared with VAL-ONLINE-011):
select a slot on Sites, watch the countdown reach zero without submitting, and
the flow returns to the time-selection step with a message that the hold
expired; the slot list is refreshed from the server. Booking the same slot
afterwards (if still free) works normally. Tool: agent-browser Evidence:
screenshot(hold-expired), network(GET /reservations/availability -> 200)
Milestone: guest-channels-and-crm Isolation: serial (changes acme hold_minutes;
waits on the wall clock)

### VAL-ONLINE-049: Manage page from the confirmation link supports view, modify, cancel

Open the manage link from a confirmation (`/reserve/manage#t=<token>`): the page
loads the booking (the token travels in the fragment and in
`X-Reservation-Token`, never as a query parameter to the Sites server). Modify
the booking to another available time and see the new time; then cancel and see
the cancelled state. Each change is confirmed by a matching
`GET /reservations/manage` response, and the cancelled slot is bookable again in
a fresh `/reserve` search. Tool: agent-browser Evidence:
screenshot(manage-cancelled), console-errors, network(POST
/reservations/manage/cancel -> 200) Milestone: guest-channels-and-crm

### VAL-ONLINE-050: Sites SSR HTML contains no guest PII and no tokens

`curl -H 'Host: acme.menuza.test:3008' http://localhost:3008/reserve` and
`.../reserve/manage` return HTML that contains no guest name, phone, email,
manage token or booking data — only the page shell, label bundles and
`data-tenant-api-url="http://localhost:3007"` on `<html>`. Grep the response
bodies for the distinctive guest string used in VAL-ONLINE-044 and find nothing.
Tool: terminal Evidence: terminal(curl + grep of SSR HTML) Milestone:
guest-channels-and-crm

### VAL-ONLINE-051: A Sites booking appears in the operator's Book within one poll

Milestone acceptance check: with the App open on `/acme/reservations/book` for
the right date (10-second ETag poll), complete a booking on Sites as in
VAL-ONLINE-044. Without any manual reload, the new booking row appears in the
Book list (and under Today when the date is today) within one poll interval,
showing the guest name, party size, time and the online channel. Tool:
agent-browser Evidence: screenshot(book-poll-arrival), network(GET
/operator/reservations/book/day -> 200) Milestone: guest-channels-and-crm

### VAL-ONLINE-052: Signed-in customer gets prefill, the customer link and the profile panel

Sign in on the acme site with phone OTP (`+15555550123`). Open `/reserve`: the
details step is prefilled with the customer's name and phone. Complete the
booking, then open the profile page: an "Upcoming reservations" panel lists the
new booking (fed by `GET /reservations/mine` from the browser) and its entry
opens the manage page. The tenant DB row carries the verified `customer_id`.
Signed out again, the panel shows no reservations (or a sign-in prompt) and no
booking data. Tool: agent-browser Evidence: screenshot(profile-upcoming),
network(GET /reservations/mine -> 200), sqlite(SELECT customer_id FROM
rsv_reservations) Milestone: guest-channels-and-crm

### VAL-ONLINE-053: The Book a table block is hidden in the builder unless online is on

In the App website builder for acme (`/acme/website/pages/<pageId>`), open the
block picker with `reservations.online` on: the "Book a table" block is listed
and can be added, with inspector fields for heading, body, button label,
location, default party size and layout. Set `reservations.online false` for
acme via `commands.set_org_flag` and reopen the picker: the block is absent.
Restore the flag afterwards. Tool: agent-browser Evidence:
screenshot(block-picker), console-errors Milestone: guest-channels-and-crm
Isolation: serial (changes the acme org flag)

### VAL-ONLINE-054: The published Book a table block renders and deep-links into the flow

Add a "Book a table" block to an acme page (default party size 2, layout
`button`), publish, and open the page on Sites: the block renders with the
configured heading and button. Activating it lands on `/reserve` with the
configured location, party, date and time prefilled from the
`?location=&party=&date=&time=` query, and the flow continues to slot selection
without re-asking. With layout `inline`, the compact party/date/time bar mounts
on the page and produces the same prefilled navigation. Tool: agent-browser
Evidence: screenshot(reservation-block), console-errors, network(GET
/reservations/config -> 200) Milestone: guest-channels-and-crm

### VAL-ONLINE-055: Six locales render with non-empty translations

Enable the site locales es, fr, de and zh for acme (ar already covered on
riyadh-grill), then open `/reserve` under each locale prefix (`/es/reserve`,
`/fr/reserve`, `/de/reserve`, `/zh/reserve`): step labels, buttons, validation
and confirmation strings render in the locale with no untranslated source-string
fallbacks for reservations strings. The Sites label-completeness test passes:
`cd apps/sites && CI=true npx vitest run <label completeness test file>`. Tool:
agent-browser Evidence: screenshot(locale-es), terminal(CI=true npx vitest run
<label test>), console-errors Milestone: guest-channels-and-crm Isolation:
serial (changes acme site locales)

### VAL-ONLINE-056: riyadh-grill books end to end in Arabic, right-to-left, on the KSA node

With the resolver rule `MAP *.menuza.test [::1]`, open
`http://riyadh-grill.menuza.test:3008/ar/reserve` (or `/reserve` when Arabic is
the default locale): the layout is mirrored right-to-left while times,
party-size digits and the confirmation code stay left-to-right and unmirrored.
`data-tenant-api-url` is `http://localhost:3009` and every reservation call goes
to 3009. Complete a booking: the confirmation renders in Arabic and the row
lands in the KSA tenant DB. The details step offers no SMS opt-in (KSA is
email-only); the acme flow does offer it. Tool: agent-browser Evidence:
screenshot(ar-rtl-confirmation), console-errors, network(POST /reservations ->
201 on :3009), sqlite(SELECT in the KSA tenant DB) Milestone:
guest-channels-and-crm

## Area: Online booking - operator side

### VAL-ONLINE-057: Operator approves a large-party request from the Requests tab

Create a large-party request as a guest (VAL-ONLINE-038). In the App as kody,
open `/acme/reservations/today` and switch to the Requests tab: the request
shows the guest name, party size, requested date/time and contact. Approve it:
the row leaves the pending list, and the guest manage view (curl with the
request's manage token) shows status `booked` with the approved time. Tool:
agent-browser Evidence: screenshot(requests-approve), network(POST
/operator/reservations/book/reservations/:id/approve -> 200), terminal(curl GET
/reservations/manage) Milestone: guest-channels-and-crm

### VAL-ONLINE-058: Operator decline frees the held capacity and is visible to the guest

Create a second large-party request. In the Requests tab, decline it with a
reason: the row shows the declined state, the capacity it held is bookable again
in public availability, and the guest manage view shows `declined`. A declined
request cannot be approved afterwards (the action is absent or refused with
409). Tool: agent-browser Evidence: screenshot(requests-decline), network(POST
/operator/reservations/book/reservations/:id/decline -> 200, GET
/reservations/availability -> 200) Milestone: guest-channels-and-crm

### VAL-ONLINE-059: The operator sees the booking channel, including native X-Client

Book once on Sites (`X-Client: web` implicit) and once via curl with
`X-Client: ios` (VAL-ONLINE-040). In the App reservation detail sheet (`?r=<id>`
from Book or Today), the web booking shows the online/web channel and the ios
booking shows the native channel — the recorded `X-Client` value is visible or
unambiguously reflected in the detail view. Tool: agent-browser Evidence:
screenshot(detail-channel), network(GET
/operator/reservations/book/reservations/:id -> 200) Milestone:
guest-channels-and-crm

---

Shared preconditions for every assertion unless one says otherwise: services
`tenant-api-us` (3007), `tenant-api-ksa` (3009), `app` (3001) and `sites` (3008)
are started with the `services.yaml` commands;
`commands.set_org_flag acme reservations.enabled true` and
`reservations.online true` (and `reservations.waitlist true` for Waitlist) have
been run for `acme`, and the same for `riyadh-grill`;
`commands.seed_reservations_acme` and `commands.seed_reservations_ksa` have been
run; the operator UI is driven as kody per `library/user-testing.md` section 1;
guest pages use `http://acme.menuza.test:3008` (en) and
`http://riyadh-grill.menuza.test:3008` (ar) per section 2. Validators use their
own phone numbers, emails and future booking dates per the data-isolation rules.
"the tick" means `POST http://localhost:3007/api/reservations/tick` (or `:3009`
for KSA) with the internal command token as described in
`library/user-testing.md` section 4 and `architecture.md` section 7.4; waiting
for the Node interval tick (default 120 s) is an acceptable alternative
everywhere the tick is mentioned. No token or secret value ever appears in
evidence.

## Area: Guest messages

### VAL-MSG-001: Tick route refuses unauthenticated and wrongly authenticated calls

With the US node running, `POST /api/reservations/tick` with a JSON body `{}`
and (a) no `Authorization` header and (b) a header carrying any wrong bearer
value each return 401 with a JSON error and `Cache-Control: private, no-store`.
An operator `rsv+jwt` token (minted through the App per user-testing section 4)
is also refused: this route authenticates only the internal command token. No
organization's state changes on any refused call (a subsequent authorized tick
for the org returns the same counts as before the refused calls). Tool: curl
Evidence: network(POST /api/reservations/tick -> 401), terminal(curl output)
Milestone: guest-channels-and-crm

### VAL-MSG-002: Tick expires holds and frees their capacity

On `acme`, create a public hold (`POST /reservations/holds` with the Sites
origin) and note `expiresAt` and the slot. Let the hold expire (place the hold
close to now or wait out `hold_minutes`), then run the tick with
`{ "orgId": <acme id> }`. Afterwards `GET /reservations/availability` for the
same date and party size offers the held slot again, and a read-only sqlite
query of the acme tenant DB shows the hold row with `status = 'expired'` and its
occupancy rows `active = 0`. The tick response is a JSON summary of counts (for
example expired holds) with no names, phones or emails in it. Tool: curl
Evidence: network(POST /reservations/holds -> 200), network(POST
/api/reservations/tick -> 200), network(GET /reservations/availability -> 200),
sqlite(rsv_holds status, rsv_table_occupancies active) Milestone:
guest-channels-and-crm

### VAL-MSG-003: Tick expires large-party requests past their deadline

Seed or create (via `POST /reservations/requests` for a party above the online
maximum) a large-party request whose `request_deadline_hours` has passed — the
validator may set the location's `request_deadline_hours` to the minimum and
wait, or use seeded data. After the tick, the request's reservation shows status
`expired` in the operator API
(`GET /operator/reservations/book/reservations/:id`), and the guest receives
exactly one terminal message for the request (visible in the dev email capture)
rather than silence. A request still inside its deadline on the same date is
untouched by the same tick. Tool: curl Evidence: network(POST
/api/reservations/tick -> 200), network(GET
/operator/reservations/book/reservations/:id -> 200), email-capture(request
terminal), sqlite(rsv_reservations status) Milestone: guest-channels-and-crm
Isolation: serial (changes the location setting `request_deadline_hours` for
acme)

### VAL-MSG-004: Opt-in auto no-show marks late bookings, and only when enabled

Configure acme's seeded location with `auto_no_show_after_min` set (for
example 30) through the operator setup API, and create a booking starting in the
past by more than that (a host booking placed for earlier today). After the tick
the booking is `no_show` with `no_show_at` set and
`rsv_table_occupancies.active = 0`, and no fee payment row is created for it
(`rsv_payments` stays empty for the reservation — auto no-show never charges).
On a second location of the same org with `auto_no_show_after_min` null, an
equally late booking remains in its previous status after the same tick. Tool:
curl Evidence: network(POST /api/reservations/tick -> 200),
sqlite(rsv_reservations status/no_show_at, rsv_table_occupancies, rsv_payments
empty) Milestone: guest-channels-and-crm Isolation: serial (changes a location
setting for acme)

### VAL-MSG-005: Confirmation message (US) — content, branding, links, note

On acme (US), complete a guest booking through Sites `/reserve` (or
`POST /reservations` with `Origin: http://acme.menuza.test:3008`) with a valid
email and `smsOptIn: false`. Within one tick, a file appears in
`apps/tenant-api/.dev-mail/us/` whose record has `to` = the guest email,
`meta.messageKind = 'confirmation'`, a non-empty subject, and `html` that
contains the location name, the booking date/time and party size, the
restaurant's branding (logo and hex colors from the org's email theme), a manage
link of the form `<siteOrigin>/reserve/manage#t=...` and an add-to-calendar
link. Setting a custom note for kind `confirmation`, locale `en` (message
settings screen or `PUT /operator/reservations/setup/message-texts`) makes the
note text appear in the confirmation email of the next booking, and not in any
other kind's email. The SMS log shows no message for this booking (the guest did
not opt in). Tool: agent-browser Evidence: email-capture(confirmation),
screenshot(confirmation-email), sms-log(absence), network(POST /reservations
-> 201) Milestone: guest-channels-and-crm

### VAL-MSG-006: SMS goes only to opted-in US guests

Repeat VAL-MSG-005 with `smsOptIn: true` and a validator-owned US phone. The US
node log gains an `[SMS MOCK] To: <phone>` line whose text names the restaurant
and booking time and contains the manage link, and the email capture also has
the confirmation email. A third booking with `smsOptIn: false` produces the
email but no new `[SMS MOCK]` line for its phone. Tool: agent-browser Evidence:
sms-log, email-capture(confirmation), network(POST /reservations -> 201)
Milestone: guest-channels-and-crm

### VAL-MSG-007: KSA sends no SMS; confirmation arrives by email in Arabic RTL

On riyadh-grill (KSA node 3009), complete a guest booking through the Arabic
Sites page with an email and any phone. No `[SMS MOCK]` line for that phone
appears in `/tmp/menuza-logs/tenant-api-ksa.log` (the KSA node never sends
reservation SMS), and the guest is not shown an error for it. The confirmation
email lands in `apps/tenant-api/.dev-mail/ksa/` with an Arabic subject and an
`html` body whose root element carries `dir="rtl"`; opened in a browser the
layout is right-to-left while the date, time and party-size digits are not
mirrored. Tool: agent-browser Evidence: email-capture(confirmation-ksa),
screenshot(rtl-confirmation), sms-log(absence on ksa log), network(POST
/reservations -> 201 on 3009) Milestone: guest-channels-and-crm

### VAL-MSG-008: Arabic-preferring US guest receives the Arabic email

On acme, book with `locale: 'ar'` (or a guest whose stored locale is Arabic).
The confirmation email in `.dev-mail/us/` has an Arabic subject and `dir="rtl"`
markup, while a booking made with `locale: 'es'` on the same org receives the
English email (non-EN/AR guest locales fall back to English). Tool: curl
Evidence: email-capture(confirmation-ar),
email-capture(confirmation-en-fallback) Milestone: guest-channels-and-crm

### VAL-MSG-009: Manage and calendar links from the captured email work

From a captured confirmation email (VAL-MSG-005), open the manage link in a
fresh agent-browser session: the Sites manage page loads and shows the booking's
first name, date/time, party size and status — it does not 404 and does not
require a login. Following the add-to-calendar link (or requesting
`GET /reservations/manage/calendar.ics` with the token) returns an `.ics`
document whose summary and start time match the booking. Links embedded in the
email carry the capability token only in the URL fragment (`#t=`), never in path
or query. Tool: agent-browser Evidence: screenshot(manage-page), network(GET
/reserve/manage -> 200), network(GET /reservations/manage/calendar.ics -> 200),
email-capture(confirmation) Milestone: guest-channels-and-crm

### VAL-MSG-010: Modification message and schedule-version dedupe

Book a modifiable reservation on acme (start at least `guest_modify_cutoff_min`
plus the reminder window in the future), then modify its time through the manage
page (`POST /reservations/manage/modify`). A `modification` email for the new
time is captured; a sqlite read of `rsv_messages` shows the pending reminder row
of the old `schedule_version` cancelled and exactly one pending reminder for the
new version. After the tick, no reminder for the old time is ever sent and no
duplicate reminder exists (dedupe key
`<entity>:<id>:<kind>:<channel>:<schedule_version>`). Tool: agent-browser
Evidence: email-capture(modification), sqlite(rsv_messages statuses and
dedupe_key), network(POST /reservations/manage/modify -> 200) Milestone:
guest-channels-and-crm

### VAL-MSG-011: Guest cancellation message and suppression of pending reminders

Cancel the VAL-MSG-010 reservation (or a fresh one) through the manage page
before its reminder is due, then run the tick. The capture gains a
`cancellation_guest` email reflecting the cancelled booking; the pending
reminder row is `cancelled`/`suppressed` in `rsv_messages` and no reminder email
for that booking is ever captured afterwards. Tool: agent-browser Evidence:
email-capture(cancellation_guest), sqlite(rsv_messages reminder status),
network(POST /reservations/manage/cancel -> 200) Milestone:
guest-channels-and-crm

### VAL-MSG-012: Restaurant cancellation message

As kody, cancel a future booked reservation from the App book or detail sheet
(choose "cancelled by restaurant" where the UI distinguishes). The guest
receives a `cancellation_restaurant` email that names the restaurant, the
cancelled date/time and the restaurant's contact details, with wording distinct
from the guest-cancellation kind. The operator UI confirms the cancellation
immediately. Tool: agent-browser Evidence:
email-capture(cancellation_restaurant), screenshot(detail-sheet-cancelled),
network(POST /operator/reservations/book/reservations/:id/status -> 200)
Milestone: guest-channels-and-crm

### VAL-MSG-013: Reminder delivered at its scheduled time

With message settings at defaults (reminder hours from the seeded config), book
on acme for a date/time whose reminder `send_at` is a few minutes in the future.
Before that moment no reminder is captured; after the moment and one tick,
exactly one `reminder` email for the booking is captured, with the booking's
date/time, the manage link and the custom note when one is set for kind
`reminder`. A second tick does not produce a second reminder. Tool: curl
Evidence: email-capture(reminder), sqlite(rsv_messages send_at/status),
network(POST /api/reservations/tick -> 200) Milestone: guest-channels-and-crm

### VAL-MSG-014: Reconfirmation request message and confirm action

With reconfirmation enabled in message settings, book so that the
`reconfirm_request` `send_at` falls a few minutes ahead and run the tick. The
capture gains a `reconfirm_request` email asking the guest to confirm, with a
manage link. Opening that link and pressing the confirm action
(`POST /reservations/manage/confirm`) moves the reservation from `booked` to
`confirmed`, visible on the manage page and in the operator day feed within one
poll. Tool: agent-browser Evidence: email-capture(reconfirm_request),
network(POST /reservations/manage/confirm -> 200), sqlite(rsv_reservations
status) Milestone: guest-channels-and-crm

### VAL-MSG-015: Request received, approved and declined messages

On acme with `large_party_mode = 'request'`, submit a large-party request via
Sites (party above the online maximum). A `request_received` email is captured
promptly. As kody, approve the request from the App Today/Book requests view:
the guest receives `request_approved` with the approved date/time and a manage
link. Repeat with a second request and decline it: the guest receives
`request_declined` and the request shows `declined` to the operator. Each kind
is captured exactly once per request. Tool: agent-browser Evidence:
email-capture(request_received), email-capture(request_approved),
email-capture(request_declined), network(POST /reservations/requests -> 201),
screenshot(requests-tab) Milestone: guest-channels-and-crm

### VAL-MSG-016: Quiet hours defer scheduled kinds, never drop them, and never delay immediate kinds

Set quiet hours on acme (default 21:00-08:00 location time) and arrange a
reminder whose raw `send_at` falls inside quiet hours (choose the booking
date/time or temporarily narrow the reminder hours so this happens within the
validation window). Its computed `send_at` in `rsv_messages` is moved earlier
out of quiet hours (or the reminder is skipped when it would land too near the
start, per `scheduleFor`), and it is delivered at the adjusted time rather than
inside quiet hours. A confirmation booked during quiet hours is still sent
immediately. Tool: terminal Evidence: sqlite(rsv_messages send_at),
email-capture(reminder), email-capture(confirmation) Milestone:
guest-channels-and-crm Isolation: serial (changes acme message settings)

### VAL-MSG-017: Message settings screen controls kinds and persists

In the App at `/<org>/reservations/settings/messages`, kody sees per-kind enable
switches, reminder and reconfirmation hours, quiet hours, an SMS on/off control
and per-kind per-locale custom note fields, plus a preview rendered from
tenant-api sample data (no real guest data). Disabling kind `reminder` and
saving means a booking made afterwards schedules no reminder row in
`rsv_messages`; re-enabling restores it for later bookings. Saving an Arabic
custom note makes it appear in the Arabic email for that kind (VAL-MSG-007/008
flow). Tool: agent-browser Evidence: screenshot(message-settings),
sqlite(rsv_messages after toggle), email-capture(reminder-with-ar-note)
Milestone: guest-channels-and-crm Isolation: serial (changes acme message
settings)

### VAL-MSG-018: Kill switch drops email without backlog

Restart the US node with `RESERVATIONS_EMAIL_ENABLED=false`, then trigger a
confirmation (new booking) and a due reminder (existing booking), and run the
tick. No new files appear in `.dev-mail/us/`, and the affected `rsv_messages`
rows end in status `dropped` (not held pending). Restart the node normally:
later messages send, and the messages dropped while the switch was off are never
sent (no backlog). Repeat the same check on the KSA node for its own switch
state. Tool: terminal Evidence: terminal(node restart with env),
email-capture(absence), sqlite(rsv_messages status dropped), terminal(log lines)
Milestone: guest-channels-and-crm Isolation: serial (restarts tenant-api nodes
with an env change; affects every validator)

### VAL-MSG-019: Kill switch drops SMS without backlog

Restart the US node with `RESERVATIONS_SMS_ENABLED=false`, book with
`smsOptIn: true`, and run the tick: no `[SMS MOCK]` line for the booking's phone
appears and the SMS row is `dropped`, while the email twin is still captured.
After a normal restart, opted-in bookings send SMS again and the dropped ones
are not retried. Tool: terminal Evidence: terminal(node restart with env),
sms-log(absence then presence), sqlite(rsv_messages status dropped) Milestone:
guest-channels-and-crm Isolation: serial (restarts the US node with an env
change)

### VAL-MSG-020: Dev email capture is active in dev and production-excluded

The US and KSA node logs each contain the boot line
`DEV EMAIL CAPTURE ACTIVE -> <dir>` pointing at `apps/tenant-api/.dev-mail/us`
and `.dev-mail/ksa` respectively, and each captured file matches the record
format
(`id, capturedAt, source: 'tenant-api', region, to, from, subject, html, text, meta`
where `meta` carries only `orgId`, `messageKind`, `messageId` — no guest name or
phone inside `meta`). `apps/tenant-api/.dev-mail/` is ignored by git
(`git check-ignore` succeeds). The approved unit/integration tests for
`isDevEmailCaptureOn()` pass and prove the sink is inactive when
`NODE_ENV=production` or when OCI email is configured. Tool: terminal Evidence:
terminal(boot log line), terminal(ls .dev-mail), terminal(git check-ignore
apps/tenant-api/.dev-mail), terminal(npx vitest run
src/lib/dev-email-capture.test.ts) Milestone: guest-channels-and-crm

### VAL-MSG-021: App-side email capture serves manager emails in the mock viewer

Trigger any App-sent email relevant to reservations (for example the manager
alert email of VAL-MSG-024). Open `http://localhost:3001/mock-email` as kody:
the message is listed with subject and recipient, and
`GET /mock-email/dev/messages?to=<kody email>` returns it as JSON. The
production exclusion is covered by the approved tests: the `build:cf` route
strip and the `mock-email+` 404-without-MOCKS checks pass. Tool: agent-browser
Evidence: screenshot(mock-email-viewer), network(GET /mock-email/dev/messages ->
200), terminal(npx vitest run tests for dev-email-capture / build:cf strip)
Milestone: guest-channels-and-crm

### VAL-MSG-022: Tick retries failed deliveries with backoff and ends failed

Run the approved tenant-api tick/delivery tests (`rsv-tick-service` and
reservations message-delivery test files). They must pass and must show: a
failed send is retried after 1, 5 and 30 minutes (`attempts` and
`next_attempt_at` grow accordingly) and the row becomes `failed` afterwards;
`last_error_code` stores only a code (no destination, no body); re-sending an
already `sent` dedupe key never produces a second message. A real transport
failure cannot be produced on the dev surface, so this invariant is asserted by
tests, not by curl. Tool: terminal Evidence: terminal(cd apps/tenant-api &&
CI=true npx vitest run src/services/rsv-tick-service.test.ts
src/lib/reservations-email.test.ts src/lib/reservations-sms.test.ts) Milestone:
guest-channels-and-crm

### VAL-MSG-023: Generic org alarm runs both modules and staffing alarm tests stay green

Run the tenant-api alarm/tick test files: `staff-alarm.test.ts` (pre-existing,
must pass unchanged), the new org-alarm tests and the tick interval tests. They
must show the generic per-organization alarm running both registered modules
(`staff` and `reservations`), the legacy `staffTickOrgId` storage key still
honored as a fallback, alarms clamped to `[now+30s, now+60min]` and only moved
earlier, and the Node reservations interval honoring
`RESERVATIONS_TICK_INTERVAL_SECONDS` (default 120, minimum 60, `0` off). Tool:
terminal Evidence: terminal(cd apps/tenant-api && CI=true npx vitest run
src/lib/staff-alarm.test.ts src/lib/org-alarm.test.ts
src/lib/staff-tick-interval.test.ts <reservations interval test>) Milestone:
guest-channels-and-crm

### VAL-MSG-024: Manager alert reaches App in-app notifications with ids and counts only

Submit a large-party request on acme (VAL-MSG-015 setup) and run the tick.
Within one tick the regional `rsv_outbox` `manager_alert` row is delivered
(status sent), and in the App the notification bell for kody (admin, in scope)
shows a new notification for kind `large_party_request` containing the location
and a count — and no guest name, phone or email anywhere in the notification
text. A duplicate delivery of the same event id creates no second notification
(idempotent per event id and member). Tool: agent-browser Evidence:
screenshot(notification-bell), sqlite(rsv_outbox status), network(POST
/api/reservations/tick -> 200) Milestone: guest-channels-and-crm

### VAL-MSG-025: Manager alert email honors per-user preferences

With kody's `reservations.large_party_request` preference at defaults (in-app
on, email on) a new large-party request produces both the in-app notification
and an email visible in `/mock-email`. Turning the email channel off for that
workflow in `settings+/notifications` and triggering another request yields the
in-app notification but no new email; turning in-app off and email on yields the
reverse. With the App-side `RESERVATIONS_EMAIL_ENABLED` off the email is dropped
while the in-app notification still appears (this last step requires an App
restart with the variable set; skip it if App restarts are not available in the
session and rely on the approved App email-switch test instead). Tool:
agent-browser Evidence: screenshot(notification-preferences), network(GET
/mock-email/dev/messages -> 200), screenshot(notification-bell),
terminal(approved email-switch test when restart unavailable) Milestone:
guest-channels-and-crm Isolation: serial (changes kody's notification
preferences; optional App restart with env change)

### VAL-MSG-026: A burst of delivery failures raises one bulk alert

Covered by the approved tenant-api tests rather than fault injection on the
running surface: the message-delivery tests must show that 10 failures for one
location within 15 minutes enqueue exactly one `manager_alert` of kind
`message_failed_bulk`, and that the App notify route maps it to one in-app
notification per eligible member. On the running system, the absence of spurious
bulk alerts during the other VAL-MSG flows is confirmed by the `rsv_outbox`
table containing no `message_failed_bulk` rows. Tool: terminal Evidence:
terminal(npx vitest run <message-delivery test file>), sqlite(rsv_outbox kinds)
Milestone: guest-channels-and-crm

### VAL-MSG-027: Hourly jobs-cron hook calls the reservations tick

The approved jobs-cron test file passes and asserts the hourly cron list
contains `Tenant reservations tick` invoking `POST /api/reservations/tick` on
every configured tenant node with the internal command token, added to the
existing hourly fan-out (no new cron slot — `wrangler.jsonc` keeps its four
crons). On the running system, the reservations tick also fires by itself via
the Node interval: with no manual tick, a due reminder (VAL-MSG-013 setup) is
delivered within roughly two interval periods. Tool: terminal Evidence:
terminal(cd apps/jobs-cron && CI=true npx vitest run src/index.test.ts),
terminal(grep crons apps/jobs-cron/wrangler.jsonc), email-capture(reminder)
Milestone: guest-channels-and-crm

### VAL-MSG-028: Send-time re-check suppresses stale messages

Run the approved delivery tests and confirm on the running system via sqlite: a
pending message whose reservation left the eligible status before `send_at` (a
reminder for a booking that was seated early, or a reconfirm request for a
booking the guest already confirmed) is marked `suppressed` at the tick and
never appears in the capture. Population checked: `reminder` and
`reconfirm_request` rows that became stale during the VAL-MSG-013/014 runs.
Tool: terminal Evidence: sqlite(rsv_messages suppressed rows),
email-capture(absence), terminal(npx vitest run <delivery re-check tests>)
Milestone: guest-channels-and-crm

### VAL-MSG-029: Operator resend sends a fresh confirmation and can rotate the manage link

As kody, open a booked reservation's detail sheet and use resend
(`POST /operator/reservations/book/reservations/:id/resend`): a new
`confirmation` message is captured for the guest. Repeating with `rotate: true`
captures another confirmation whose manage link carries a new token; the old
manage link now returns the uniform `404 not_found` on
`GET /reservations/manage`. Tool: agent-browser Evidence:
email-capture(confirmation-resend), network(GET /reservations/manage with old
token -> 404), network(POST /operator/reservations/book/reservations/:id/resend
-> 200) Milestone: guest-channels-and-crm

### VAL-MSG-030: Master flag off stops messaging; online off keeps it

With future bookings and a due reminder pending on acme, set
`reservations.enabled` to `false` and run the tick: no messages for that org are
delivered (rows stay pending or are suppressed; nothing new reaches the capture
or SMS log). Re-enable the master flag but set `reservations.online` to `false`:
reminders and manage links keep working (the due reminder is delivered and the
manage page loads) while new public booking is refused. Restore both flags
afterwards. Tool: curl Evidence: email-capture(absence then presence),
sqlite(rsv_messages), network(GET /reservations/manage -> 200),
terminal(commands.set_org_flag) Milestone: guest-channels-and-crm Isolation:
serial (toggles org flags for acme)

## Area: Waitlist

### VAL-WAIT-001: Waitlist settings screen saves and gates the feature

In the App at `/<org>/reservations/settings/waitlist` (requires the settings
permission and the `reservations.waitlist` flag), kody can toggle
`waitlist_enabled`, `waitlist_online` and `notify_me_enabled`, set
`waitlist_response_min` and `waitlist_max_parties`, and save; a reload shows the
persisted values, and `GET /operator/reservations/setup/locations/:id/waitlist`
returns the same values. With `reservations.waitlist` off, the App waitlist
screens 404 and every `/operator/reservations/book/waitlist/*` route returns 404
(feature gating through the token's `features` claim). Tool: agent-browser
Evidence: screenshot(waitlist-settings), network(GET
/operator/reservations/setup/locations/:id/waitlist -> 200), network(GET
/operator/reservations/book/waitlist/ -> 404 with flag off),
terminal(commands.set_org_flag) Milestone: guest-channels-and-crm Isolation:
serial (toggles the waitlist flag and settings for acme)

### VAL-WAIT-002: Operator adds a walk-in party with a simulated quote

With waitlist enabled on acme, `POST /operator/reservations/book/waitlist/`
(name, party size, phone with `sms_opt_in`, optional area preference,
`Idempotency-Key`) returns 201 with an entry in status `waiting` carrying
`quoted_min` and `quoted_ready_at` computed by queue simulation (a positive
number of minutes, consistent with
`GET /operator/reservations/book/waitlist/quote?locationId&partySize` for the
same party size). The entry appears in the App waitlist queue and in the Today
Waitlist tab within one 5-second poll, with its quoted wait shown. Tool:
agent-browser Evidence: network(POST /operator/reservations/book/waitlist/ ->
201), network(GET /operator/reservations/book/waitlist/quote -> 200),
screenshot(waitlist-queue) Milestone: guest-channels-and-crm

### VAL-WAIT-003: Quote grows with the queue ahead

With two tables' worth of seated parties and upcoming reservations (seeded
state), add three same-size parties to the waitlist in order. The third entry's
`quoted_min` is greater than the first entry's, and each quote equals the quote
the standalone `/quote` endpoint returns when the queue contains exactly the
entries ahead of it (the quote accounts for predicted table free-times minus
colliding reservations). A party added after the queue is emptied (all seated or
left) gets a smaller quote than the last queued quote did. Tool: curl Evidence:
network(POST /operator/reservations/book/waitlist/ -> 201 x3),
sqlite(rsv_waitlist_entries quoted_min ordering) Milestone:
guest-channels-and-crm

### VAL-WAIT-004: Notify the guest — message, status and response deadline

From the App waitlist, press Notify on a `waiting` entry with an opted-in US
phone. The entry becomes `notified` with `notified_at` set and
`response_deadline_at = notified_at + waitlist_response_min`; a `waitlist_ready`
message reaches the guest — an `[SMS MOCK]` line for the opted-in phone and/or
an email in the capture — containing the restaurant name and the entry's status
link. Repeating Notify on an already `notified` entry does not send a second
message for the same schedule version. Tool: agent-browser Evidence: sms-log,
email-capture(waitlist_ready), sqlite(rsv_waitlist_entries
notified_at/response_deadline_at), screenshot(waitlist-queue) Milestone:
guest-channels-and-crm

### VAL-WAIT-005: No response by the deadline becomes no_response

Notify an entry (VAL-WAIT-004) with `waitlist_response_min` set short (for
example 1 minute via the settings screen), take no guest action, and run the
tick after the deadline. The entry is `no_response` in the operator list; the
tick's `waitlist_offers` sweep is what moved it. An entry notified but answered
("on the way") before its deadline is untouched by the same tick. Tool: curl
Evidence: sqlite(rsv_waitlist_entries status no_response), network(POST
/api/reservations/tick -> 200) Milestone: guest-channels-and-crm Isolation:
serial (changes `waitlist_response_min` for acme)

### VAL-WAIT-006: On the way from the guest is reflected for the host

Remote-join a party (VAL-WAIT-010), then from the guest status page press "on my
way" (`POST /reservations/waitlist/status/on-my-way` with the status token). The
entry becomes `on_the_way`, and the operator waitlist list shows the on-the-way
state within one 5-second poll, without a manual reload. Tool: agent-browser
Evidence: network(POST /reservations/waitlist/status/on-my-way -> 200),
screenshot(operator-waitlist-on-the-way), sqlite(rsv_waitlist_entries status)
Milestone: guest-channels-and-crm

### VAL-WAIT-007: Seat from the waitlist creates the walk-in reservation and occupancy

From the App waitlist, seat a `waiting`/`on_the_way` entry onto a concrete table
(`POST /operator/reservations/book/waitlist/:id/seat` with table ids). The entry
becomes `seated` with `reservation_id` set; the new reservation has
`channel = 'waitlist'` and status `seated`, and `rsv_table_occupancies` holds
active rows on the chosen table covering its interval. The seated party appears
on the Today Seated tab and on the floor plan as occupied within one poll. Tool:
agent-browser Evidence: network(POST
/operator/reservations/book/waitlist/:id/seat -> 200), sqlite(rsv_reservations
channel/status, rsv_table_occupancies), screenshot(today-seated-tab) Milestone:
guest-channels-and-crm

### VAL-WAIT-008: Reorder the queue and the order persists

With at least three `waiting` entries, reorder them from the App (drag or the
reorder affordance, `POST /operator/reservations/book/waitlist/reorder`). Reload
the page: the new order survives (persisted `sort_key`, not local state), and
the guest status page of the moved entry reports its new position
(`GET /reservations/waitlist/status`). Tool: agent-browser Evidence:
screenshot(waitlist-reordered), sqlite(rsv_waitlist_entries sort_key),
network(GET /reservations/waitlist/status -> 200) Milestone:
guest-channels-and-crm

### VAL-WAIT-009: Cancel, leave and edit from the operator side

From the App waitlist: cancelling an entry moves it to `cancelled` and out of
the active queue counts; `PATCH /operator/reservations/book/waitlist/:id`
updates party size or notes and bumps the entry's `version` (a stale
`expectedVersion` gets 409 `stale_version`). A guest who leaves via the status
page (`POST /reservations/waitlist/status/leave`) shows as `left` in the
operator list within one poll. Cancelled and left entries no longer receive
waitlist messages. Tool: agent-browser Evidence: network(PATCH
/operator/reservations/book/waitlist/:id -> 200/409), network(POST
/reservations/waitlist/status/leave -> 200), screenshot(operator-list-left),
sqlite(rsv_waitlist_entries) Milestone: guest-channels-and-crm

### VAL-WAIT-010: Remote join on Sites with validation and limits

With `waitlist_online` and `reservations.online` on for acme, open
`http://acme.menuza.test:3008/reserve/waitlist` in a guest browser, enter a
validator-owned name, phone and party size, and join. The page shows the guest
status view: position in queue, quoted wait and the entry state, with "leave"
and "on my way" actions. A second join with the same phone the same day is
refused (one active entry per phone per location per day); when
`waitlist_max_parties` is set and the active queue is at the cap, the join is
refused with a clear full-list message; a join with the honeypot field `website`
filled gets the same apparent success but writes nothing (sqlite shows no new
entry). Tool: agent-browser Evidence: screenshot(waitlist-join),
screenshot(waitlist-status-page), network(POST /reservations/waitlist/join ->
201/4xx), sqlite(rsv_waitlist_entries) Milestone: guest-channels-and-crm
Isolation: serial (changes `waitlist_max_parties` during the cap step)

### VAL-WAIT-011: Remote join needs both waitlist and online flags

With `reservations.waitlist` on but `reservations.online` off, the Sites
`/reserve/waitlist` page refuses the join flow (gate payload has
`waitlist: false`/404 fallback) and `POST /reservations/waitlist/join` returns
the uniform `404 not_found`. The operator waitlist (VAL-WAIT-002) keeps working
in this state. Restore the flag afterwards. Tool: curl Evidence: network(POST
/reservations/waitlist/join -> 404), network(GET /resources/sites/reservations
-> payload), terminal(commands.set_org_flag) Milestone: guest-channels-and-crm
Isolation: serial (toggles `reservations.online` for acme)

### VAL-WAIT-012: Join confirmation message

A successful remote join (US, opted-in phone and email) produces exactly one
`waitlist_joined` message: an `[SMS MOCK]` line and/or a captured email
containing the quoted wait, the restaurant name and the status-page link whose
token travels in the URL fragment (`#t=`). A walk-in entry added by the operator
without contact details produces no message and no error. Tool: curl Evidence:
sms-log, email-capture(waitlist_joined), sqlite(rsv_messages one row per entry)
Milestone: guest-channels-and-crm

### VAL-WAIT-013: Guest status page stays consistent with the operator list

Remote-join two parties, A then B. The guest status pages report positions 1 and
2; after the host notifies A, A's status page shows the notified state and B's
position is unchanged; after the host seats A, B's status page shows position 1
and an updated quoted wait, and A's page shows the seated state. Every change is
visible to the guest by reloading the status page (the contract's
`GET /reservations/waitlist/status` returns position, quoted wait, state and
server `now`). Tool: agent-browser Evidence: screenshot(guest-status-a),
screenshot(guest-status-b), network(GET /reservations/waitlist/status -> 200 x2)
Milestone: guest-channels-and-crm

### VAL-WAIT-014: Status token is the only credential and rotation/forgery fails closed

From a fresh browser session without the status token, neither
`GET /reservations/waitlist/status` nor the leave/on-my-way POSTs succeed (404
`not_found`). A token with one character changed, and a valid status token from
the other organization's node (acme token sent to 3009), get the same
uniform 404. The token appears only in the URL fragment and the
`X-Reservation-Token` header — never in path or query of any request the browser
makes. Tool: agent-browser Evidence: network(GET /reservations/waitlist/status
without token -> 404), network(POST /reservations/waitlist/status/leave with
forged token -> 404), network(POST on 3009 with acme token -> 404) Milestone:
guest-channels-and-crm

### VAL-WAIT-015: Notify-me request is created when no time is available

On acme, pick a fully booked date/time window (seed or fill it) and submit
"Notify me" from the Sites availability step (`POST /reservations/notify-me`
with party size, time range and contact). The response is 201 with a cancel
token and the request shows status `active` in sqlite. A sixth active request
for the same contact is refused (at most 5 active per contact), and a request
with the honeypot filled appears to succeed but writes nothing. Tool:
agent-browser Evidence: network(POST /reservations/notify-me -> 201/4xx),
sqlite(rsv_notify_requests status), screenshot(notify-me-form) Milestone:
guest-channels-and-crm

### VAL-WAIT-016: Notify-me match after a cancellation frees the slot

With an active notify-me request covering a full slot (VAL-WAIT-015), cancel the
booking that occupies it (restaurant cancellation by kody) and run the tick. The
date's `rsv_day_versions.availability_increased_at` is set, the matching task
notifies the request in FIFO order (at most the first 3 requests per slot), and
each notified guest receives exactly one `notify_available` message (captured
email and/or SMS) containing the available date/time and a booking link. The
request row becomes `notified` with `notified_count` incremented. Tool: curl
Evidence: email-capture(notify_available), sqlite(rsv_notify_requests notified,
rsv_day_versions.availability_increased_at), network(POST /api/reservations/tick
-> 200) Milestone: guest-channels-and-crm

### VAL-WAIT-017: Notify-me batching, repeat window and expiry

With 5 active notify-me requests matching one freed slot, one tick notifies only
the first 3 in FIFO order; the remaining 2 stay `active` until the next batch
window (15 minutes later) passes and a further tick notifies them. A request
whose time range has passed is moved to `expired` by the tick and is never
notified afterwards. Cancelling a request with its cancel token
(`POST /reservations/notify-me/cancel`) sets it `cancelled` and the same token
returns the uniform 404 on reuse. Tool: curl Evidence:
sqlite(rsv_notify_requests statuses and notified_count),
email-capture(notify_available count), network(POST
/reservations/notify-me/cancel -> 200 then 404) Milestone:
guest-channels-and-crm

### VAL-WAIT-018: A notified notify-me guest can book the freed slot

From the `notify_available` email, follow the booking link and complete the
booking for the freed slot on Sites. The booking succeeds (201), the notify-me
request becomes `booked`, and a normal confirmation email follows —
demonstrating the match led to a real, engine-validated booking rather than a
reserved-side bypass. Tool: agent-browser Evidence: network(POST /reservations
-> 201), sqlite(rsv_notify_requests status booked), email-capture(confirmation)
Milestone: guest-channels-and-crm

### VAL-WAIT-019: Drag a waitlist card onto the floor plan seats the party

On the App floor plan (`/<org>/reservations/floor`) with the waitlist panel
visible, drag a waiting entry's card onto a free table (or use the keyboard
drag-and-drop equivalent). The drop seats the party: the entry becomes `seated`,
a `channel = 'waitlist'` reservation occupies that table, and the table flips to
occupied with its timer — identical in effect to VAL-WAIT-007's seat action.
Dropping onto an occupied table offers the same swap / move / overbook choices
as any other floor-plan drop. Tool: agent-browser Evidence:
screenshot(floor-drag-seat), sqlite(rsv_waitlist_entries seated,
rsv_reservations channel), network(POST
/operator/reservations/book/waitlist/:id/seat -> 200) Milestone:
guest-channels-and-crm

### VAL-WAIT-020: KSA waitlist uses email and the status page, never SMS

On riyadh-grill (KSA node), remote-join with an email and phone from the Arabic
`/ar/reserve/waitlist` page (RTL layout, numbers unmirrored). The
`waitlist_joined` and, after the operator notifies, `waitlist_ready` messages
arrive only as captured emails in `.dev-mail/ksa/` (Arabic, `dir="rtl"`); no
`[SMS MOCK]` line for the phone appears in the KSA node log, and the guest sees
no error. The status page works identically to the US one. Tool: agent-browser
Evidence: email-capture(waitlist_joined-ksa), email-capture(waitlist_ready-ksa),
sms-log(absence on ksa log), screenshot(ar-waitlist-status) Milestone:
guest-channels-and-crm

### VAL-WAIT-021: Flag off stops waitlist messages

With pending waitlist work queued (a notified entry awaiting its deadline and a
matched notify-me request), set `reservations.waitlist` to `false` for acme and
run the tick: no `waitlist_ready` or `notify_available` messages are delivered
while the flag is off (waitlist message kinds are gated by the flag), while
non-waitlist kinds (for example a due reminder) still send. Restore the flag
afterwards. Tool: curl Evidence: email-capture(absence of waitlist kinds,
presence of reminder), sqlite(rsv_messages by kind),
terminal(commands.set_org_flag) Milestone: guest-channels-and-crm Isolation:
serial (toggles `reservations.waitlist` for acme)

### VAL-WAIT-022: Join idempotency and rate limits

`POST /reservations/waitlist/join` twice with the same `Idempotency-Key` and
identical body returns the same entry and status token and creates exactly one
row; the same key with a different body returns 409 `idempotency_conflict`. Six
rapid distinct joins from one IP trip the 5/10min in-memory limit with 429
`rate_limited`. Equivalent checks for `POST /reservations/notify-me` (5/10 min
per IP). Tool: curl Evidence: network(POST /reservations/waitlist/join ->
201/409/429), sqlite(rsv_waitlist_entries single row) Milestone:
guest-channels-and-crm

### VAL-WAIT-023: Waitlist offers are also swept inside the write path

Without running the tick, perform an unrelated reservation write (for example a
host booking) after a notified entry's response deadline has passed. The write
path's `sweepExpired` (holds, payments, requests, waitlist offers) moves the
overdue entry to `no_response` as part of that transaction — expiry is enforced
even between ticks. Confirm via the operator waitlist list or sqlite. Tool: curl
Evidence: network(POST /operator/reservations/book/reservations -> 201),
sqlite(rsv_waitlist_entries status no_response) Milestone:
guest-channels-and-crm

### VAL-WAIT-024: Security sweep and App guards cover every waitlist and message route

Run `apps/tenant-api/src/routes/reservations-security.test.ts` and the App
guards test: they pass and enumerate the waitlist sub-router routes
(`/operator/reservations/book/waitlist/*`), the setup message-texts and
waitlist-settings routes, and the public `/reservations/waitlist/*` and
`/reservations/notify-me*` routes — each refusing missing, forged,
wrong-audience, grantless, cross-organization and cross-location tokens as the
sweep defines, with public capability-token failures returning uniform 404 and
no 5xx other than 503. Tool: terminal Evidence: terminal(cd apps/tenant-api &&
CI=true npx vitest run src/routes/reservations-security.test.ts), terminal(cd
apps/app && CI=true npx vitest run
app/utils/reservations/reservations-guards.test.ts) Milestone:
guest-channels-and-crm

### VAL-WAIT-025: Operator notify requires its deadline to come from settings

Change `waitlist_response_min` on acme (settings screen), notify a fresh entry,
and read the row: `response_deadline_at - notified_at` equals the new setting in
minutes, proving the deadline is computed from live location settings rather
than a constant. Restore the default afterwards. Tool: curl Evidence:
sqlite(rsv_waitlist_entries deadline delta), network(POST
/operator/reservations/book/waitlist/:id/notify -> 200) Milestone:
guest-channels-and-crm Isolation: serial (changes `waitlist_response_min` for
acme)

---

Shared preconditions for every assertion unless stated otherwise: all five web
services are up per `services.yaml` (`tenant-api-us` on 3007, `tenant-api-ksa`
on 3009, `app` on 3001, `sites` on 3008); `reservations.enabled` (plus
`reservations.online` and `reservations.waitlist` where bookings or waitlist
entries are created through public routes) is on for the org via
`commands.set_org_flag`; `commands.seed_reservations_acme` /
`commands.seed_reservations_ksa` have run; the operator is `kody` (admin role,
all eight reservations grants). The validator uses its own guests: unique phones
`+1555555<validator-number><nn>`, unique emails
`rsv-<validator>-<n>@example.com`, and its own future booking dates so counts
are not shared. Operator API tokens are obtained in the browser with
agent-browser `eval` on an App page:
`fetch('/acme/reservations/token?scope=<scope>').then(r => r.json())`, and are
never written into evidence. Read-only SQLite queries run against
`packages/database/db/tenant_t58bgatqh3rv0s3movrecyj1.db` (acme) and
`packages/database/db/ksa/tenant_ru0dm42cud9scs4g2duep21c.db` (riyadh-grill).
"Host operator" below means a non-kody member of the org assigned the Host role
preset (read/update reservation only, no guest or report grants); "Guest viewer"
means a member whose role grants only `read:reservation_guest:any`; "Report-less
operator" means a member whose role grants `read:settings:any` but no
reservations permissions. Creating these accounts and roles is a one-time serial
setup (see the Isolation lines).

## Area: Guestbook

### VAL-GUEST-001: Guestbook search matches partial names

With the flag on and seeded history in acme, open `/acme/reservations/guests` as
kody and type a case-insensitive substring (at least 3 characters) of a seeded
guest's last name into the search field. The list narrows to guests whose first
or last name contains the substring, and clearing the search restores the full
list. Pass: the matching guest appears and a known non-matching guest does not;
the browser console shows no errors. Tool: agent-browser Evidence:
screenshot(guestbook-search), console-errors Milestone: guest-channels-and-crm

### VAL-GUEST-002: Guestbook search matches partial phone numbers

Search the Guestbook for the middle digits of the validator's own guest phone
(for example `5558801` from `+15555558801`) after creating that guest through
any booking. The guest appears in the results. Pass: partial digits match the
stored E.164 number; a digit string present in no guest's phone returns the
empty state, not an error. Tool: agent-browser Evidence:
screenshot(guestbook-search-phone), console-errors Milestone:
guest-channels-and-crm

### VAL-GUEST-003: Guestbook search matches partial email, case-insensitively

Search for a substring of the validator's guest email in upper case (for example
`EXAMPLE.COM`). The guest created with `rsv-<validator>-<n>@example.com`
appears. Pass: the match is found despite case difference and partial input.
Tool: agent-browser Evidence: screenshot(guestbook-search-email), console-errors
Milestone: guest-channels-and-crm

### VAL-GUEST-004: Search with no matches shows an empty state

Search the Guestbook for a string no guest can match (for example
`zz-no-such-guest-<validator>`). The list area shows an empty-state message and
no rows, the page does not error, and the console is clean. Pass: an explicit
empty state is rendered; a blank screen, spinner that never resolves, or a
console error fails. Tool: agent-browser Evidence: screenshot(guestbook-empty),
console-errors Milestone: guest-channels-and-crm

### VAL-GUEST-005: Custom tags can be created, assigned, and used as a list filter

On the validator's guest profile, create a new custom tag
(`contract-<validator>`) and assign it. Back on the Guestbook list, filter by
that tag. Pass: the tagged guest is listed and an untagged guest is not; the tag
chip is visible on the profile and in the filtered list. Tool: agent-browser
Evidence: screenshot(guestbook-tag-filter), console-errors Milestone:
guest-channels-and-crm

### VAL-GUEST-006: Guestbook list pages in cursor pages of at most 50

Using a `guests`-scope token, curl
`GET http://localhost:3007/operator/reservations/guests/` for acme. If the
response has no `nextCursor`, create guests (any booking flow) until the org has
more than 50, then repeat. Pass: the first page contains at most 50 guests and a
cursor; following the cursor returns the next page with no guest id repeated
from page one. Tool: curl Evidence: network(GET /operator/reservations/guests/
-> 200) Milestone: guest-channels-and-crm

### VAL-GUEST-007: Completing a booking updates profile stats

Create a guest through a phone/host booking for two covers on the validator's
own date, then move it through arrived, seated and finished from the Today list.
Open the guest's Guestbook profile. Pass: visits has increased by 1, covers by
2, and the last visit date is the booking's business date; the visit history
lists the booking with its final status. Tool: agent-browser Evidence:
screenshot(guest-stats-completed), network(GET /operator/reservations/guests/:id
-> 200) Milestone: guest-channels-and-crm

### VAL-GUEST-008: No-show and cancellation update profile stats

Book two more reservations for the same validator guest: mark one `no_show`,
cancel the other inside the free-cancellation window. Reload the profile. Pass:
`no_shows` and `late_cancels` each increased by 1 and `visits` did not change;
the visit history shows one booking as no-show and one as cancelled. Tool:
agent-browser Evidence: screenshot(guest-stats-noshow), network(GET
/operator/reservations/guests/:id -> 200) Milestone: guest-channels-and-crm

### VAL-GUEST-009: System tag "first visit" is derived and cannot be set by hand

For a freshly created validator guest with no completed visit, the profile shows
the system tag "first visit". After one booking of that guest is finished
(VAL-GUEST-007), reload the profile: the tag is gone. Separately, attempt to
assign the system tag manually with
`POST /operator/reservations/guests/:id/tags` naming the `first_visit` tag id
from `GET /operator/reservations/guests/tags`. Pass: the tag appears exactly
while the guest has zero completed visits, and the manual assignment is refused
with a 4xx and no tag added. Tool: agent-browser Evidence:
screenshot(guest-first-visit-tag), network(POST
/operator/reservations/guests/:id/tags -> 4xx) Milestone: guest-channels-and-crm

### VAL-GUEST-010: System tag "frequent no-show" is derived and cannot be removed by hand

Repeatedly book and no-show the same validator guest (up to 10 cycles). Pass: by
the tenth no-show at the latest, the profile shows the system tag "frequent
no-show", and trying to remove it from the profile UI or with
`DELETE /operator/reservations/guests/:id/tags/:tagId` is refused (4xx or no
control offered) while the tag remains. Fail if the tag never appears within 10
no-shows or if it can be removed manually. Tool: agent-browser Evidence:
screenshot(guest-frequent-noshow), network(DELETE
/operator/reservations/guests/:id/tags/:tagId -> 4xx) Milestone:
guest-channels-and-crm

### VAL-GUEST-011: Guestbook is hidden and refused without a guest grant

Sign in as the Host operator (Host role preset, no guest grants) in a fresh
browser session. The sidebar's Reservations group shows no Guestbook link, and
opening `/acme/reservations/guests` directly is refused (403 "no access", not a
crash). Pass: no entry point and no direct access; a rendered guest list fails.
Tool: agent-browser Evidence: screenshot(guestbook-no-access), console-errors
Milestone: guest-channels-and-crm Isolation: serial (creates a member/role
assignment for the Host operator)

### VAL-GUEST-012: Sensitive grants produce 5-minute tokens

On an App page as kody, mint two tokens in the browser:
`fetch('/acme/reservations/token?scope=guests')` and
`fetch('/acme/reservations/token?scope=book')`, then decode each JWT payload.
Pass: the guests token's `exp - iat` is at most 300 seconds and the book token's
is at most 900 seconds; the guests token's `grants` include the guest grants and
the book token's do not. Tool: agent-browser Evidence: network(GET
/acme/reservations/token?scope=guests -> 200), terminal(jwt payload decode)
Milestone: guest-channels-and-crm

### VAL-GUEST-013: Allergy details are hidden from operators without a guest grant

On the validator's guest profile (as kody), set an allergy note
(`contract-allergy-<validator>`) and assign a dietary tag. Create a booking for
that guest. Open the reservation detail sheet (`?r=<id>`) as the Host operator
and as kody. Pass: the Host operator's guest summary shows visit counts and
non-sensitive tags but nowhere renders the allergy text or the dietary tag,
while kody's summary shows them; the literal string
`contract-allergy-<validator>` appears in no network response body the Host
operator's browser receives. Tool: agent-browser Evidence:
screenshot(guest-summary-host-vs-admin), network(GET
/operator/reservations/guests/:id/summary -> 200) Milestone:
guest-channels-and-crm

### VAL-GUEST-014: Guest routes refuse tokens without guest grants

Mint a `book`-scope token (no guest grants) and curl acme:
`GET /operator/reservations/guests/?q=x`,
`PATCH /operator/reservations/guests/<id>`,
`POST /operator/reservations/guests/merge`,
`POST /operator/reservations/guests/<id>/erase`. Pass: every call returns 403
and no response body contains guest data; a second check with no Authorization
header returns 401 on the same routes. Tool: curl Evidence: network(GET
/operator/reservations/guests/ -> 403), network(POST
/operator/reservations/guests/:id/erase -> 403) Milestone:
guest-channels-and-crm

### VAL-GUEST-015: Pinned notes lead the profile and appear in the guest summary everywhere

As kody, add two notes to the validator's guest and pin the second one
(`contract-pinned-<validator>`). Pass: the profile lists the pinned note ahead
of the unpinned one; the reservation detail sheet in the Book and the guest
summary on the host stand (Today or Floor) both show the pinned note text;
unpinning it removes it from both summaries after reload. Tool: agent-browser
Evidence: screenshot(guest-pinned-note-profile), screenshot(guest-summary-book),
screenshot(guest-summary-host-stand) Milestone: guest-channels-and-crm

### VAL-GUEST-016: Edited and deleted notes propagate

Edit one note's body on the validator's guest and delete another. Pass: the
profile shows the edited body and no longer shows the deleted note, and the
guest summary in the book shows the same state after reload; the deleted note
does not reappear on refresh. Tool: agent-browser Evidence:
screenshot(guest-notes-edited), console-errors Milestone: guest-channels-and-crm

### VAL-GUEST-017: Merging duplicates moves bookings, tags and notes to the surviving guest

Create two validator guests A and B, each with one future booking, one tag and
one note. As kody, merge B into A from the profile UI
(`POST /operator/reservations/guests/merge` with `keepId=A`, `mergeId=B`). Pass:
A's profile now lists both bookings in visit history, the union of both guests'
tags, and both notes; searching for B's name or phone no longer finds a separate
B profile (or shows it only as merged into A); a read-only query of
`rsv_guest_merges` shows a row with `kept_guest_id=A`, `merged_guest_id=B`, and
`rsv_guests.merged_into_id` of B equals A. Tool: agent-browser Evidence:
screenshot(guest-merge), network(POST /operator/reservations/guests/merge ->
200), sqlite(rsv_guest_merges row and rsv_guests.merged_into_id) Milestone:
guest-channels-and-crm

### VAL-GUEST-018: Invalid merges are refused and change nothing

With a `guests`-scope token, curl `POST /operator/reservations/guests/merge`
three times: (1) `keepId == mergeId`; (2) a stale `expectedVersions` value for
the kept guest; (3) merging into a guest that was itself already merged (merge a
new guest C into B from VAL-GUEST-017). Pass: (1) and (3) return a 4xx
(`invalid` or `conflict`), (2) returns `409 stale_version`, and a read-only
check shows no new `rsv_guest_merges` rows and unchanged profiles after each
refusal. Tool: curl Evidence: network(POST /operator/reservations/guests/merge
-> 409), sqlite(rsv_guest_merges row count unchanged) Milestone:
guest-channels-and-crm

### VAL-GUEST-019: Merge is recorded in the moved bookings' history

After VAL-GUEST-017, fetch the change history of B's original booking:
`GET /operator/reservations/book/reservations/<id>/events`. Pass: the history
contains a `merged_guest` event with actor kind `operator`, the events
pre-dating the merge are still present in the same order, and a read-only query
shows no reservation events were deleted. Tool: curl Evidence: network(GET
/operator/reservations/book/reservations/:id/events -> 200),
sqlite(rsv_reservation_events for the booking) Milestone: guest-channels-and-crm

### VAL-GUEST-020: Guest export returns JSON without sensitive fields by default

Create a validator guest whose profile carries the allergy text
`contract-allergy-export-<validator>` (set as kody), a tag, a note, and at least
one booking. With a `guests`-scope token, curl
`GET /operator/reservations/guests/<id>/export` (no `includeSensitive`). Pass:
the response is JSON containing the profile fields, visit history, tags, notes
and message metadata, and the response body contains neither the allergy text
nor any reservation dietary-notes text (search the raw body for the marker
string). Tool: curl Evidence: network(GET
/operator/reservations/guests/:id/export -> 200) Milestone:
guest-channels-and-crm

### VAL-GUEST-021: Sensitive export requires the update guest grant

As the Guest viewer operator (read guest only, no update), export the same guest
with `?includeSensitive=1`: refused with 403. As kody (update guest), repeat the
call: the response is 200 and this time contains the allergy text
`contract-allergy-export-<validator>`. Pass: read guest alone cannot export
sensitive fields, update guest can, and the default export stays clean. Tool:
curl Evidence: network(GET
/operator/reservations/guests/:id/export?includeSensitive=1 -> 403), network(GET
/operator/reservations/guests/:id/export?includeSensitive=1 -> 200) Milestone:
guest-channels-and-crm Isolation: serial (creates the Guest viewer role/account)

### VAL-GUEST-022: Every export is audited without PII

Before and after VAL-GUEST-020/021's successful exports, run a read-only query
on `rsv_audit_log` where `action='guest.export'`. Pass: each successful export
added exactly one row naming the guest id in `entity_id`, the refused sensitive
export added none, and no audit row's `changes` payload contains the guest's
name, phone, email, notes or allergy text. Tool: terminal Evidence:
sqlite(rsv_audit_log guest.export rows) Milestone: foh-core

### VAL-GUEST-023: Erasing a guest anonymizes the profile

Create a validator guest (`Erasure <validator>`) with a phone, email, tag and
note, then erase them from the Guestbook UI as kody (confirm the dialog). Pass:
the profile afterwards shows the anonymized name ("Erased guest") with contact
fields, tags and notes cleared; searching for the old name, phone or email
returns nothing; the erased guest's id still opens without a server error. Tool:
agent-browser Evidence: screenshot(guest-erased), network(POST
/operator/reservations/guests/:id/erase -> 200) Milestone:
guest-channels-and-crm

### VAL-GUEST-024: Erasure cancels future bookings and notifies the guest first

Give the erasure guest a future booking with email
`rsv-<validator>-erase@example.com`, then erase the guest. Pass: the booking
shows as cancelled with `cancelled_by` `restaurant` in the Book or the day feed;
the dev email capture holds a `cancellation_restaurant` email for that address
whose body uses the guest's real name (sent before the contact was cleared); the
erased guest's past bookings keep their history. Tool: agent-browser Evidence:
email-capture(cancellation_restaurant), screenshot(erasure-cancelled-booking),
terminal(grep the capture file for the guest name) Milestone:
guest-channels-and-crm

### VAL-GUEST-025: Erasure redacts but never deletes history or audit rows

Using VAL-GUEST-023's guest: record read-only counts of the guest's
`rsv_reservation_events` rows and of `rsv_audit_log` rows before erase, then
erase and re-count. Pass: no event or audit row was deleted or removed, event
`data` payloads that held guest-typed text are redacted (`{"redacted":true}`),
and exactly one new audit row with `action='guest.erase'` and the guest's id
exists. Tool: terminal Evidence: sqlite(rsv_reservation_events counts and
redacted payloads; rsv_audit_log guest.erase row) Milestone: foh-core

### VAL-GUEST-026: The existing Customers screen is unchanged and holds no Guestbook guests

Open `/acme/customers` as kody after creating several Guestbook guests through
phone bookings (no Sites sign-in). Pass: the page loads and behaves as before,
lists tenant customers only, and contains none of the booking-created guests'
names or phones; the page shows no reservations UI (no tags, visit stats or
merge controls). Tool: agent-browser Evidence: screenshot(customers-unchanged),
console-errors Milestone: guest-channels-and-crm

### VAL-GUEST-027: Erasing a tenant customer unlinks their guests but keeps history

Sign in on the acme site with a fresh validator phone (OTP via
`commands.read_sms_code`), book a reservation while signed in so the guest
carries the verified `customer_id` link, and note the customer id from the
profile or a read-only query of `rsv_guests`. Then POST
`http://localhost:3007/internal/reservations/erase-customer` with the internal
command auth header and body `{ "orgId": "<acme id>", "customerId": "<id>" }`.
Pass: the call succeeds, the guest profile keeps its visit history and the
booking remains, and a read-only query shows the guest's `customer_id` (and
`marketing_customer_id` if set) cleared. Tool: curl Evidence: network(POST
/internal/reservations/erase-customer -> 200), sqlite(rsv_guests customer_id
before and after) Milestone: guest-channels-and-crm

### VAL-GUEST-028: riyadh-grill behaves the same and is served only by the KSA node

On riyadh-grill (KSA), open `/riyadh-grill/reservations/guests`, create a
validator guest (KSA phone `+9665...`), assign a tag and view the profile:
search, profile, stats and tags behave exactly as on acme. Then mint a
guests-scope token for riyadh-grill and send it to the US node
(`http://localhost:3007/operator/reservations/guests/`) and confirm refusal;
read-only queries confirm the guest rows exist in the KSA tenant DB and not the
US one. Pass: feature parity on the KSA org, cross-region token refused
(401/403), and KSA guest PII only in `db/ksa`. Tool: agent-browser Evidence:
screenshot(ksa-guestbook), network(GET /operator/reservations/guests/ on 3007 ->
4xx), sqlite(ksa tenant db rsv_guests row present; us tenant db absent)
Milestone: guest-channels-and-crm

### VAL-GUEST-029: Guestbook renders right-to-left in Arabic

Open `/acme/reservations/guests?lng=ar` as kody. Pass: the interface chrome
mirrors (navigation, list and profile layout right-to-left, `dir="rtl"` on the
page), Arabic UI labels are shown, while guest names, phone numbers, dates and
stat numbers are not reversed or mirrored; the console is clean. Tool:
agent-browser Evidence: screenshot(guestbook-ar-rtl), console-errors Milestone:
guest-channels-and-crm

## Area: Reports and dashboard block

### VAL-REPORT-001: The Reports page lists and runs all six module reports

Open `/acme/reservations/reports` as kody. The page offers exactly the module
reports from the architecture: summary (covers and parties by service, source
and party size), no-shows, cancellations, turn times (actual versus configured),
waitlist (quoted versus actual), and pacing. Run each against the seeded date
range. Pass: all six render a table or chart without an error; a missing report
family or an error state fails. Tool: agent-browser Evidence:
screenshot(reports-page), console-errors, network(GET
/operator/reservations/reports/summary -> 200) Milestone: guest-channels-and-crm

### VAL-REPORT-002: Reports UI is hidden and refused without the report grant

Sign in as the Report-less operator (`read:settings:any`, no reservations
grants) in a fresh session. The sidebar's Reservations group shows no Reports
link and `/acme/reservations/reports` returns a refusal (404/403 without
rendering data). Pass: no entry point and no rendered report. Tool:
agent-browser Evidence: screenshot(reports-no-access), console-errors Milestone:
guest-channels-and-crm Isolation: serial (creates the Report-less role/account)

### VAL-REPORT-003: Report endpoints refuse tokens without the report grant

Mint a `book`-scope token and curl
`GET http://localhost:3007/operator/reservations/reports/summary?locationId=<id>&from=<d>&to=<d>`.
Also try each of `/no-shows`, `/cancellations`, `/turn-times`, `/waitlist`,
`/pacing` with the same token. Pass: all six return 403 and no aggregate data
leaks in the error bodies. Tool: curl Evidence: network(GET
/operator/reservations/reports/summary -> 403) Milestone: guest-channels-and-crm

### VAL-REPORT-004: Summary figures match a known data set

On the validator's own future date D, create exactly: two online bookings of 2
covers at lunch and one phone booking of 4 covers at dinner (channels `online`
and `phone` respectively). Run the summary report for acme, from=D to=D. Pass:
reported parties and covers by service, by source and by party size equal these
bookings (2 lunch parties / 4 covers online, 1 dinner party / 4 covers phone,
party-size buckets 2x2 and 1x4); nothing from other dates is counted. Tool: curl
Evidence: network(GET /operator/reservations/reports/summary -> 200) Milestone:
guest-channels-and-crm

### VAL-REPORT-005: No-shows report matches known no-shows

On the validator's date D, book two reservations for validator guests and mark
exactly one `no_show`. Run the no-shows report for D. Pass: it reports exactly
one no-show with that booking's party size and service, and the total matches;
the finished/cancelled bookings do not appear as no-shows. Tool: curl Evidence:
network(GET /operator/reservations/reports/no-shows -> 200) Milestone:
guest-channels-and-crm

### VAL-REPORT-006: Cancellations report matches known cancellations

On date D, cancel two validator bookings: one inside the free-cancellation
window (late) and one outside it. Run the cancellations report for D. Pass: it
reports two cancellations, distinguishes the late cancel from the regular one,
and counts match; the validator's no-show from VAL-REPORT-005 is not counted as
a cancellation. Tool: curl Evidence: network(GET
/operator/reservations/reports/cancellations -> 200) Milestone:
guest-channels-and-crm

### VAL-REPORT-007: Turn times report compares actual and configured

On date D, seat a validator walk-in or booking of a known party size and finish
it after a measured interval (note the wall-clock minutes between Seat and
Finish). Run the turn-times report for D. Pass: the report shows the configured
turn time for that party-size bucket next to an actual average within one minute
of the measured interval, bucketed under the same party size. Tool:
agent-browser Evidence: screenshot(reports-turn-times), network(GET
/operator/reservations/reports/turn-times -> 200) Milestone:
guest-channels-and-crm

### VAL-REPORT-008: Waitlist report compares quoted and actual waits

On date D, add two validator walk-in parties to the waitlist, note the quoted
wait of each, notify and seat them, noting actual wait times. Run the waitlist
report for D. Pass: each entry's quoted minutes and actual minutes match the
noted values (within one minute for actuals), and the outcomes are `seated`;
entries from other dates are not counted. Tool: agent-browser Evidence:
screenshot(reports-waitlist), network(GET
/operator/reservations/reports/waitlist -> 200) Milestone:
guest-channels-and-crm

### VAL-REPORT-009: Pacing report matches known bookings per slot

Using the bookings created on date D in VAL-REPORT-004, run the pacing report
for D. Pass: the per-slot (or per-service) booking and cover counts it reports
equal the validator's known bookings, alongside the location's configured pacing
limits; no booking appears in a slot it was not booked into. Tool: curl
Evidence: network(GET /operator/reservations/reports/pacing -> 200) Milestone:
guest-channels-and-crm

### VAL-REPORT-010: Date-range and service filters narrow results correctly

Create one additional validator booking on date D+1 at lunch. Run the summary
report for from=D to=D, then from=D to=D+1, then for D restricted to the dinner
service. Pass: the D-only run excludes the D+1 booking, the wider range includes
exactly one more party and its covers, and the dinner-filtered run excludes the
lunch bookings while keeping the dinner one. Tool: curl Evidence: network(GET
/operator/reservations/reports/summary -> 200) Milestone: guest-channels-and-crm

### VAL-REPORT-011: An empty range renders zeros, not an error

Run each of the six module reports for a past date range with no bookings (for
example 2020-01-06 to 2020-01-07). Pass: every report returns 200 and renders an
explicit empty or all-zero result; no error toast, no HTTP 5xx, no console
error. Tool: agent-browser Evidence: screenshot(reports-empty-range),
console-errors Milestone: guest-channels-and-crm

### VAL-REPORT-012: Every report run writes an audit row without PII

Read-only query the count of `rsv_audit_log` rows with `action='report.run'`,
then run each of the six module report endpoints once with a `reports`-scope
token, then re-count. Pass: the count increased by exactly six, each new row
names the report kind (or endpoint) and location without any guest name, phone,
email or note text in `changes`. Tool: terminal Evidence: sqlite(rsv_audit_log
report.run rows before and after) Milestone: guest-channels-and-crm

### VAL-REPORT-013: Module report responses carry no guest contact data

Run all six module report endpoints for a range that includes bookings of a
validator guest with the distinctive name `Reportprobe <validator>` and a staff
note. Pass: none of the six response bodies contains that name, the guest's
phone or email, or the note text (grep the raw bodies); the aggregates
themselves are correct. Tool: curl Evidence: network(GET
/operator/reservations/reports/* -> 200), terminal(grep response bodies for PII
markers) Milestone: guest-channels-and-crm

### VAL-REPORT-014: The report builder offers the bookings and waitlist_entries subjects

As kody (with `read:reservation_report:any` and the master flag on), open the
App's report builder (`/acme/reports/new`). Pass: the subject list includes
`bookings` and `waitlist_entries`; as the Report-less operator, minting a report
token yields a `subjects` list without either subject and the builder does not
offer them. (Cross-check: `GET /acme/reports/token` JSON.) Tool: agent-browser
Evidence: screenshot(report-builder-subjects), network(GET /acme/reports/token
-> 200) Milestone: guest-channels-and-crm

### VAL-REPORT-015: Report subject rows expose no contact columns

Run a report on the `bookings` subject over a range containing the distinctively
named validator guest from VAL-REPORT-013, selecting every available field.
Pass: the result rows contain business date, time, location, service, party
size, covers, status, channel, duration and similar aggregate facts, and no row
or column contains any guest's first name, last name, phone, email, notes or
allergy text (grep the rendered table and the raw response for the markers).
Repeat for `waitlist_entries` with the waitlist parties from VAL-REPORT-008:
same result. Tool: curl Evidence: network(POST /analytics/query -> 200),
terminal(grep response body for PII markers) Milestone: guest-channels-and-crm

### VAL-REPORT-016: The bookings subject returns one correct row per reservation

Run a `bookings` subject report filtered to date D with the validator's known
bookings from VAL-REPORT-004 to VAL-REPORT-006. Pass: the row count equals the
number of the validator's bookings in D, and each row's date, service, party
size, status and channel match the booking it represents; rows are not
duplicated or aggregated away. Tool: curl Evidence: network(POST
/analytics/query -> 200) Milestone: guest-channels-and-crm

### VAL-REPORT-017: The waitlist_entries subject returns one correct row per entry

Run a `waitlist_entries` subject report filtered to date D. Pass: the rows equal
the validator's waitlist entries from VAL-REPORT-008 one-to-one, each with the
right party size, channel, quoted wait, actual wait and outcome; no contact
fields appear. Tool: curl Evidence: network(POST /analytics/query -> 200)
Milestone: guest-channels-and-crm

### VAL-REPORT-018: Restricted subjects are refused without the grant at tenant-api

Mint an analytics token as the Report-less operator (the App mint succeeds
because the operator holds `read:settings:any`, but the token's `subjects` list
omits `bookings` and `waitlist_entries`). POST `/analytics/query` on the US
tenant-api with a definition on subject `bookings`. Pass: tenant-api answers 403
(`forbidden_subject` or equivalent), and the same call with kody's token
(subjects include both) returns 200. Tool: curl Evidence: network(POST
/analytics/query -> 403), network(POST /analytics/query -> 200) Milestone:
guest-channels-and-crm

### VAL-REPORT-019: The bookings-today dashboard block renders today's counts once

With the flag on, open the acme home dashboard as kody, use "Add block" and add
"Bookings today". Pass: the block renders counts by status, covers by service,
the waitlist count, and a next-arrivals list (time, party size, first name,
status) that matches today's bookings; after adding it, "Bookings today" is no
longer offered in the Add block dialog (maxInstances 1). Tool: agent-browser
Evidence: screenshot(dashboard-bookings-today), console-errors Milestone:
guest-channels-and-crm

### VAL-REPORT-020: The dashboard block is hidden without the reservation read grant

Sign in as the Report-less operator (no `read:reservation:any`). Open the home
dashboard and the Add block dialog. Pass: "Bookings today" is not offered, and
if the block was added to a shared dashboard by kody it is not rendered for this
operator; other blocks are unaffected. Tool: agent-browser Evidence:
screenshot(dashboard-block-hidden), console-errors Milestone:
guest-channels-and-crm

### VAL-REPORT-021: The dashboard block disappears when the master flag is off

Turn `reservations.enabled` off for acme
(`commands.set_org_flag acme reservations.enabled delete`), reload the home
dashboard, then turn it back on. Pass: while the flag is off the block is not
rendered and not offered in the Add block dialog; after re-enabling it renders
again. Fail if the block keeps rendering or errors while the flag is off. Tool:
agent-browser Evidence: screenshot(dashboard-block-flag-off), console-errors
Milestone: guest-channels-and-crm Isolation: serial (toggles the org's master
flag)

### VAL-REPORT-022: The dashboard block fetches browser-direct, never through the App loader

With a validator guest named `Dashprobe <validator>` holding a booking today,
reload the acme home dashboard with network capture on. Pass: the block's data
comes from a browser request to
`GET http://localhost:3007/operator/reservations/book/today` (200, with an
`rsv+jwt` Bearer), the dashboard's App document/`.data` response contains no
guest names (grep the response body for `Dashprobe`), and the App server made no
regional data call in its loader. Repeat on riyadh-grill: the equivalent call
goes to port 3009. Tool: agent-browser Evidence: network(GET
/operator/reservations/book/today -> 200), network(GET /acme -> 200),
terminal(grep App response for guest name) Milestone: guest-channels-and-crm

### VAL-REPORT-023: The dashboard block refreshes within about 60 seconds

With the block visible on the acme home dashboard, note its counts, then create
a new booking for today (any channel). Without reloading the page, wait up to 75
seconds. Pass: the block's counts and next-arrivals list update to include the
new booking on their own (one poll cycle plus slack); the network log shows a
repeat `GET /operator/reservations/book/today` roughly 60 seconds after the
previous one. Tool: agent-browser Evidence: screenshot(dashboard-block-refresh),
network(GET /operator/reservations/book/today -> 200) Milestone:
guest-channels-and-crm

### VAL-REPORT-024: Reports page renders right-to-left in Arabic

Open `/acme/reservations/reports?lng=ar` and run the summary report. Pass: the
chrome and report layout mirror right-to-left with Arabic labels, while figures,
dates and times are not reversed; the console is clean. Tool: agent-browser
Evidence: screenshot(reports-ar-rtl), console-errors Milestone:
guest-channels-and-crm

---

Scope: milestone 9 `payment-mocks` — the Stripe and Checkout.com emulators
behind the real SDKs, the mock hosted pages, webhooks, the dev control API,
production exclusion, and validation against existing online ordering (US Stripe
order on `acme`, KSA Checkout.com order on `riyadh-grill`). Reservation payments
are milestone 10 and are not asserted here.

Environment baseline for all assertions unless stated otherwise: the App runs on
`http://localhost:3001` via `services.app` (Workers dev, `MOCKS=true`),
tenant-api US on 3007, tenant-api KSA on 3009, Sites on 3008 (`services.yaml`
commands). Operator login is `kody` on orgs `acme` (US) and `riyadh-grill`
(KSA). `PAYMENTS_MOCK_WEBHOOKS` defaults to `inline`. Curl calls to App resource
routes that require it use the `INTERNAL_COMMAND_TOKEN` from the local env
configuration; the token value never appears in assertions or evidence.
Precondition for ordering flows: `acme` and `riyadh-grill` each have a published
menu with at least one orderable item and a pickup fulfillment window (seeded
baseline; if absent the validator publishes one through the App first).

## Area: Payment mocks

### Activation, deactivation and production exclusion

### VAL-PMOCK-001: Mock mode is active and visible under MOCKS=true

With the App started through `services.app` (which sets `MOCKS=true` and
placeholder payment keys), the App log at `/tmp/menuza-logs/app.log` contains
the boot line `PAYMENTS MOCK ACTIVE` naming both providers. Signed in as kody on
`acme`, Settings -> Shop shows the "Mock payments" badge and the mock onboarding
panel. `GET http://localhost:3001/mock-payments/dashboard` returns 200 with the
mock banner. Pass: all three signals present. Fail: any one missing. Tool:
agent-browser Evidence: screenshot(settings-shop-mock-badge), terminal(grep
'PAYMENTS MOCK ACTIVE' /tmp/menuza-logs/app.log), network(GET
/mock-payments/dashboard -> 200)

### VAL-PMOCK-002: PAYMENTS_MOCK=false forces the mock off

Restart the App with `PAYMENTS_MOCK=false` added to its environment while
`MOCKS=true` remains set. Then `GET /mock-payments/dashboard` and
`POST /mock-payments/dev/events` both return 404, and Settings -> Shop for
`acme` shows neither the badge nor the mock panel. Restore the normal
`services.app` environment afterwards. Pass: 404 on both routes and no badge.
Isolation: serial (App restart with changed env) Tool: curl Evidence:
network(GET /mock-payments/dashboard -> 404), network(POST
/mock-payments/dev/events -> 404), screenshot(settings-shop-no-mock-badge)

### VAL-PMOCK-003: With no mock switches, every mock route 404s

Restart the App with neither `MOCKS` nor `PAYMENTS_MOCK` set. The population of
mock routes is: `/mock-payments/dashboard`, `/mock-payments/stripe/checkout/x`,
`/mock-payments/stripe/3ds/x`, `/mock-payments/stripe/connect/onboard/x`,
`/mock-payments/stripe/connect/dashboard/x`,
`/mock-payments/checkout-com/hpp/x`, `/mock-payments/checkout-com/dashboard`,
`/mock-payments/dev/events`, `/mock-payments/dev/onboard`,
`/mock-payments/dev/reset`. Each must return 404. Restore the normal environment
afterwards. Pass: every listed route returns 404. Fail: any returns another
status. Isolation: serial (App restart with changed env) Tool: curl Evidence:
network(GET|POST /mock-payments/* -> 404 for each listed route), terminal(curl
loop output)

### VAL-PMOCK-004: Activation rule unit tests

Run the activation-rule Vitest file in `@repo/payments` (the test file covering
`paymentsMockMode` in `packages/payments/src/mock/`). It must prove:
`PAYMENTS_MOCK=true` alone activates both emulators; `PAYMENTS_MOCK=false`
forces off even with `MOCKS=true`; `MOCKS` unset and `PAYMENTS_MOCK` unset means
off; an `sk_live_`-prefixed `STRIPE_SECRET_KEY` with mocks on throws the refusal
error; a real (non-placeholder) test key for one provider disables only that
provider's mock; and `NODE_ENV=production` with `MOCKS=true` still activates (no
`NODE_ENV` gate). Pass: the file exists and
`cd packages/payments && CI=true npx vitest run <file>` exits 0. Tool: terminal
Evidence: terminal(npx vitest run <activation test file> in packages/payments)

### VAL-PMOCK-005: Production build excludes the mock (layers 1, 2 and 4)

Run `cd /home/factory-user/repos/menuza && npm run build:cf -w app`. Then: (a)
`grep -r "__MENUZA_PAYMENTS_MOCK__" apps/app/build` finds nothing (the vite
define eliminated the mock branch and the sentinel string); (b) the build output
contains no compiled route modules for `mock-payments+` or `mock-email+` (the
`STRIP_DEV_MOCKS=1` route strip, e.g. no matching route paths in the server
build manifest); (c) the CI bundle check is wired — a CI workflow file under
`.github/workflows/` or a script it calls performs the sentinel grep and fails
the job when the sentinel is found. Pass: (a), (b) and (c) all hold. Tool:
terminal Evidence: terminal(npm run build:cf -w app), terminal(grep -r
**MENUZA_PAYMENTS_MOCK** apps/app/build -> no matches), terminal(grep of route
manifest for mock-payments+/mock-email+ -> no matches), terminal(grep -r
**MENUZA_PAYMENTS_MOCK** .github/workflows/ scripts/ -> check present)

### VAL-PMOCK-006: The Node (CI) build keeps the mock

Run `npm run build -w app` (the non-Cloudflare Node build used by Playwright
CI). `grep -r "__MENUZA_PAYMENTS_MOCK__" apps/app/build` finds the sentinel,
proving exclusion is tied to `DEPLOY_TARGET=cloudflare` plus `build`, not to
`NODE_ENV` (CI runs `NODE_ENV=production MOCKS=true` and must keep the mock).
Pass: sentinel present in the Node build output. Tool: terminal Evidence:
terminal(npm run build -w app && grep -r **MENUZA_PAYMENTS_MOCK** apps/app/build
-> match)

### Emulator state

### VAL-PMOCK-007: __mock_pay_* tables hold emulator state in local D1

With the App running in mock mode and at least one Stripe Checkout session
created (for example after VAL-PMOCK-012), read local D1 from `apps/app` with
`npx wrangler d1 execute DB --local --command "<select>"`. The tables
`__mock_pay_object`, `__mock_pay_idempotency` and `__mock_pay_event` exist
(created lazily, no Drizzle migration), and `__mock_pay_object` contains
`provider='stripe'` rows of types `checkout.session`, `payment_intent` and the
ledger objects for the completed payment. Pass: the three tables exist and the
object rows for the known session id are present. Tool: terminal Evidence:
sqlite(select name from sqlite_master where name like '__mock_pay_%'),
sqlite(select provider, type, id from __mock_pay_object where id =
'<cs_test_...>')

### VAL-PMOCK-008: Mock state survives an App restart

With a completed Stripe Checkout session id from an earlier assertion, call
`GET /mock-payments/dev/objects/stripe/<sessionId>` and note the `status` field.
Restart the App (`services.app` stop/start with unchanged env). Call the same
endpoint again. Pass: the second response returns the same object with the same
`status` (`complete`); the emulator did not lose state across the restart.
Isolation: serial (App restart) Tool: curl Evidence: network(GET
/mock-payments/dev/objects/stripe/<id> -> 200 before and after restart,
identical status)

### Stripe Connect onboarding and dashboards

### VAL-PMOCK-009: Onboarding gates online payment; requirements-due does not enable charges

Starting state: `POST /mock-payments/dev/reset` has run and `acme` has no
completed Connect onboarding (if a previous assertion onboarded it, this
assertion must run first or after wiping the org's Connect columns through the
dev reset flow). (1) Placing an online-payment order on acme fails:
`POST /resources/sites/order/checkout` for an unpaid order returns 409
`online_payment_unavailable`, and the Sites checkout page offers no pay-online
option. (2) As kody on `acme` Settings -> Shop, click "Connect payout account";
the browser lands on `/mock-payments/stripe/connect/onboard/<id>` with the mock
banner; choose "Submit with requirements due"; after the return sync, charges
remain disabled and the 409 persists. (3) Repeat via a fresh account link
choosing "Complete"; after the `?connect=return` sync, Settings -> Shop shows
charges enabled and `GET /resources/order-context?orgId=<acme>` (with the
internal command token) reports `onlinePayment.enabled: true` with processor
`connect`. Pass: all three stages behave as stated. Isolation: serial (mutates
acme onboarding state; coordinates with VAL-PMOCK-010 and VAL-PMOCK-012) Tool:
agent-browser Evidence: screenshot(mock-connect-onboarding-page),
screenshot(settings-shop-charges-enabled), network(POST
/resources/sites/order/checkout -> 409), network(GET /resources/order-context ->
onlinePayment.enabled true), console-errors

### VAL-PMOCK-010: Instant onboarding helper enables a provider in one call

With mock mode on, `POST /mock-payments/dev/onboard` with body
`{"orgSlug":"acme","provider":"stripe"}` returns 200. Immediately after,
`GET /resources/order-context?orgId=<acme>` reports
`onlinePayment.enabled: true`, and the Organization row in local D1 has
`stripeConnectAccountId` set and `stripeConnectChargesEnabled = 1`. The same
call with `{"orgSlug":"riyadh-grill","provider":"checkout"}` returns 200 and
sets `checkoutChargesEnabled = 1`. Signed in as kody, Settings -> Shop shows the
"Mock payments" panel with both "Instantly enable" buttons; when mock mode is
off (VAL-PMOCK-002/003 window), the same intents answer 404. Pass: all of the
above. Isolation: serial (mutates onboarding state of both orgs) Tool: curl
Evidence: network(POST /mock-payments/dev/onboard -> 200), network(GET
/resources/order-context -> 200), sqlite(select stripeConnectAccountId,
stripeConnectChargesEnabled, checkoutChargesEnabled from Organization),
screenshot(settings-shop-mock-panel)

### VAL-PMOCK-011: Express dashboard shows the payment ledger

Precondition: an acme Stripe order has been paid through the mock in this
session (VAL-PMOCK-012). As kody on `acme` Settings -> Shop, open the Express
dashboard (the login link resolves to
`/mock-payments/stripe/connect/dashboard/<acctId>`). The page shows the mock
banner and lists the completed payment's ledger rows: the charge (`ch_`), the
destination transfer (`tr_`) and the application fee (`fee_`), and it renders
the refunds/reversals section. The transfer amount equals the charge amount
minus the application fee. Pass: all rows for the known payment are listed with
consistent amounts. Tool: agent-browser Evidence:
screenshot(express-dashboard-ledger), network(GET
/mock-payments/stripe/connect/dashboard/<acct> -> 200)

### Stripe Checkout payment mode (US ordering regression)

### VAL-PMOCK-012: Existing US Stripe order pays end to end with 4242

On `http://acme.menuza.test:3008`, place a pickup order as a guest, choose
online payment, and submit. The browser is redirected to
`http://localhost:3001/mock-payments/stripe/checkout/cs_test_...` — Sites
accepted the loopback `http:` checkout URL instead of failing with
`payment_unavailable`. The mock page shows the mock banner, the amount in USD
and Pay/Back buttons. Pay with card `4242 4242 4242 4242`, any future expiry,
any CVC. The browser is 303-redirected to the Sites `/menu/success?order=<id>`
URL. The success page's status poll (`POST /api/orders/payment-status`) reports
`paid`, and the receipt shows "Total paid".
`GET /mock-payments/dev/objects/stripe/<sessionId>` shows the session `complete`
and `payment_status: 'paid'`, and the regional order row
(`restaurant_orders.payment_status` in the acme tenant DB) is `paid`. Pass:
redirect to the mock page, successful payment, poll reports `paid`. Tool:
agent-browser Evidence: screenshot(mock-stripe-checkout-page),
screenshot(sites-order-success-paid), network(POST /api/orders/payment ->
checkoutUrl http://localhost:3001/mock-payments/...), network(POST
/api/orders/payment-status -> paid), network(GET
/mock-payments/dev/objects/stripe/<cs_...> -> complete/paid), sqlite(select
payment_status from restaurant_orders where id='<orderId>' in the acme tenant
DB)

### VAL-PMOCK-013: Declined card shows an inline error and the session stays open

Start another acme online order to reach the mock Stripe Checkout page. Submit
card `4000 0000 0000 0002`. The page re-renders with an inline decline error (no
redirect), the order is not paid, and
`GET /mock-payments/dev/objects/stripe/<sessionId>` still shows
`status: 'open'`. Pass: inline error shown, session open, status poll does not
report `paid`. Tool: agent-browser Evidence:
screenshot(mock-checkout-decline-error), network(GET
/mock-payments/dev/objects/stripe/<cs_...> -> open), console-errors

### VAL-PMOCK-014: 3DS challenge pass completes the payment

Start another acme online order. On the mock checkout page pay with
`4000 0025 0000 3155`; the browser is taken to
`/mock-payments/stripe/3ds/<attemptId>` with "Complete authentication" and "Fail
authentication" buttons. Click "Complete authentication". The flow completes:
redirect to `/menu/success?order=<id>`, the status poll reports `paid`, and the
dev API shows the session `complete`. Pass as stated. Tool: agent-browser
Evidence: screenshot(mock-3ds-page), screenshot(sites-order-success-paid),
network(POST /api/orders/payment-status -> paid)

### VAL-PMOCK-015: 3DS challenge failure declines the payment

Start another acme online order, pay with `4000 0025 0000 3155`, and on the 3DS
page click "Fail authentication". The payment fails: the checkout page shows an
inline authentication-failure/decline error, the order is not paid, and the
session remains `open` (the guest may retry with another card). Pass as stated;
fail if the order is marked paid or the session completes. Tool: agent-browser
Evidence: screenshot(mock-3ds-fail-error), network(GET
/mock-payments/dev/objects/stripe/<cs_...> -> open), network(POST
/api/orders/payment-status -> not paid)

### VAL-PMOCK-016: Back from the hosted page cancels without paying

Start another acme online order. On the mock checkout page click "Back". The
browser lands on the order's cancel URL (the Sites `/menu` page for the order's
locale). The order is not paid, and starting checkout again produces a fresh
hosted session. Pass: landing on the cancel URL with no payment recorded. Tool:
agent-browser Evidence: screenshot(sites-menu-after-cancel), network(POST
/api/orders/payment-status -> not paid), console-errors

### VAL-PMOCK-017: Forced expiry closes the session and clears the binding

Start another acme online order and note the session id, but do not pay. Call
`POST /mock-payments/dev/sessions/<sessionId>/expire`. Reloading the hosted page
now shows "This Checkout Session is no longer active" instead of the payment
form, and the order status poll reports a non-paid terminal or retryable state
(the regional binding is cleared, so a new checkout attempt creates a new
session). Pass: expired page shown and a subsequent checkout attempt for the
same order yields a different `cs_test_` session. Tool: curl Evidence:
network(POST /mock-payments/dev/sessions/<id>/expire -> 200),
screenshot(mock-checkout-expired), network(POST /api/orders/payment-status ->
failed/expired), network(POST /api/orders/payment -> new session id)

### Webhooks

### VAL-PMOCK-018: Inline mode delivers signed webhooks synchronously

With the default `PAYMENTS_MOCK_WEBHOOKS=inline`, after the successful payment
in VAL-PMOCK-012, `GET /mock-payments/dev/events?provider=stripe` lists
`checkout.session.completed` and `payment_intent.succeeded` events for the
session with `delivered_at` set and `last_status` 200 — the dispatcher delivered
a correctly signed event to the real `/api/stripe/webhook` route before the
redirect completed (the route verifies the signature, so a 200 proves signing).
Pass: both event types present and delivered with status 200 without any flush
call. Tool: curl Evidence: network(GET /mock-payments/dev/events?provider=stripe
-> delivered events with last_status 200)

### VAL-PMOCK-019: Deferred mode delivers without a flush

Restart the App with `PAYMENTS_MOCK_WEBHOOKS=deferred`. Pay a new acme order
through the dev API (`POST /mock-payments/dev/stripe/sessions/<id>/complete`
with card `4242424242424242`) without calling `events/flush`. Within a few
seconds, `GET /mock-payments/dev/events?provider=stripe` shows the new events
with `delivered_at` set and `last_status` 200, and the order's status poll
reports `paid`. Restore `inline` (or unset) afterwards. Pass: delivery happened
with no flush and the order is paid. Isolation: serial (App restart with changed
webhook mode) Tool: curl Evidence: network(POST
/mock-payments/dev/stripe/sessions/<id>/complete -> 200), network(GET
/mock-payments/dev/events -> delivered_at set), network(POST
/api/orders/payment-status -> paid)

### VAL-PMOCK-020: Stripe webhook route rejects a bad signature

Craft a `POST http://localhost:3001/api/stripe/webhook` with a syntactically
valid event JSON body but a `Stripe-Signature` header computed with the wrong
secret (or a garbage header). The route responds 400 and does not apply the
event: `GET /mock-payments/dev/events` shows no new delivered event and no mock
object changed. Pass: 400 and no state change. Tool: curl Evidence: network(POST
/api/stripe/webhook -> 400), network(GET /mock-payments/dev/events -> unchanged)

### VAL-PMOCK-021: Checkout.com webhook route rejects a bad signature

Craft a `POST http://localhost:3001/api/shop/webhook` with a valid-shaped event
body but a `cko-signature` header computed with the wrong secret. The route
responds 400 (invalid signature) and applies nothing. Pass: 400 and no state
change visible through the dev API. Tool: curl Evidence: network(POST
/api/shop/webhook -> 400), network(GET
/mock-payments/dev/events?provider=checkout -> unchanged)

### Stripe setup mode and off-session PaymentIntents (emulator test surface)

These behaviors have no UI in existing online ordering (they exist for
reservation guarantees and fees in milestone 10); they are validated through the
Vitest suites that drive the real Stripe SDK against the in-process emulator,
per the approved test harness.

### VAL-PMOCK-022: Setup mode saves a card and off-session charges succeed

Run the emulator's setup-mode Vitest file (`packages/payments` or the app-side
mock test that calls the real `createShopCommerce` helpers). The test creates a
Checkout Session in `mode: 'setup'` through the real SDK, completes it with
`emulator.testing.completeCheckout(sessionId, { card: '4000002500003155' })`
(3DS), verifies via `sessions.retrieve` with `expand: ['setup_intent']` that the
SetupIntent `succeeded`, then creates an off-session PaymentIntent
(`off_session: true, confirm: true`) against the saved PaymentMethod and asserts
`status: 'succeeded'`. Pass: `CI=true npx vitest run <file>` exits 0. Tool:
terminal Evidence: terminal(npx vitest run <setup/off-session test file>)

### VAL-PMOCK-023: authentication_required survives withConnect

Run the Vitest test that completes setup with card `4000 0027 6000 3184` and
then creates an off-session PaymentIntent through a `withConnect`-wrapped
helper. The test asserts the thrown error is an
`instanceof Stripe.errors.StripeCardError` with
`code: 'authentication_required'`, and that `error.raw.payment_intent` (or the
equivalent preserved payload) carries the PaymentIntent with status
`requires_payment_method` — i.e. the `withConnect` fix keeps the provider error
class, `code`, `decline_code` and the raw PaymentIntent instead of flattening
them into a plain `Error`. Pass: the test file exits 0. Tool: terminal Evidence:
terminal(npx vitest run <withConnect/off-session test file>)

### VAL-PMOCK-024: Off-session and setup decline profiles

Run the Vitest test covering the remaining Stripe card profiles: setup with
`4000 0000 0000 0341` succeeds but the later off-session charge throws
`StripeCardError` with `code: 'card_declined'` and
`decline_code: 'generic_decline'`; setup with `4000 0000 0000 9995` fails at
attach time (`insufficient_funds`). Pass: the test file exits 0. Tool: terminal
Evidence: terminal(npx vitest run <card-profile decline test file>)

### Stripe refunds, disputes and protocol fidelity

### VAL-PMOCK-025: Full, partial and over-refunds with ledger reversal

Run the emulator's refund Vitest file. Against a paid destination charge it
asserts: a full refund (`reverse_transfer: true, refund_application_fee: true`)
produces `charge.refunded`, a transfer reversal (`trr_`) and an application-fee
refund (`fr_`) in the ledger; a partial refund reverses transfer and fee
proportionally; a refund exceeding the remaining amount returns a 400 Stripe
error envelope (`charge_already_refunded` or `amount_too_large`). Pass: the test
file exits 0. Tool: terminal Evidence: terminal(npx vitest run
<refund test file>)

### VAL-PMOCK-026: Asynchronous refund settlement

Run the Vitest test covering the asynchronous refund cards: a refund on a
payment made with `4000 0000 0000 7726` is `pending` and, after settling via the
helper/dev API with outcome succeeded, becomes `succeeded` with the matching
events; a refund on `4000 0000 0000 5126` settles to `failed` and emits
`refund.failed` / `charge.refund.updated`. Pass: the test file exits 0. Tool:
terminal Evidence: terminal(npx vitest run <async refund test file>)

### VAL-PMOCK-027: Dispute created through the dev API fires its webhook

Precondition: a paid acme payment exists (VAL-PMOCK-012); read its
`payment_intent` id via `GET /mock-payments/dev/objects/stripe/<sessionId>`.
Call `POST /mock-payments/dev/disputes` with that PaymentIntent id. Then
`GET /mock-payments/dev/events?provider=stripe&type=charge.dispute.created`
shows the event, delivered (inline mode) with `last_status` 200 — the real
webhook route accepted the signed dispute event. The mock event log page lists
it as well. Pass: the dispute event exists and was delivered. Tool: curl
Evidence: network(POST /mock-payments/dev/disputes -> 200), network(GET
/mock-payments/dev/events?type=charge.dispute.created -> delivered),
screenshot(mock-event-log-dispute)

### VAL-PMOCK-028: Stripe protocol fidelity (idempotency, validation, 501)

Run the emulator protocol Vitest file, which uses the real SDK over the
in-process transport and asserts: the same `Idempotency-Key` with the same
parameters replays the stored response; the same key with different parameters
returns a 400 `idempotency_error`; `expires_at` outside the 30-minute to 24-hour
window is rejected; a USD amount below 50 minor units is rejected; an
off-session PaymentIntent with a PaymentMethod not attached to the Customer is
rejected; and an unimplemented endpoint returns 501 (with a loud log) rather
than succeeding silently. Pass: the test file exits 0. Tool: terminal Evidence:
terminal(npx vitest run <protocol/idempotency test file>)

### Checkout.com

### VAL-PMOCK-029: KSA sub-entity onboarding through the real UI (guards removed)

Signed in as kody on `riyadh-grill` (KSA) Settings -> Shop: the page does not
show the "US organizations only" notice for Checkout.com, the Stripe Connect
button stays hidden (Stripe remains US only), and "Invite Checkout payout
contact" succeeds. Opening "Open Checkout dashboard" lands on
`/mock-payments/checkout-com/dashboard` with the mock banner and the new
sub-entity (`ent_...`) in a non-activated state. Click "Activate payments",
reload Settings -> Shop (status syncs on load), and the org shows Checkout
charges enabled; `GET /resources/order-context?orgId=<riyadh-grill>` reports
`onlinePayment.enabled: true` with processor `checkout`. Pass: all of the above;
fail if any US-only guard blocks the flow. Isolation: serial (mutates
riyadh-grill onboarding state) Tool: agent-browser Evidence:
screenshot(settings-shop-riyadh-checkout), screenshot(cko-dashboard-activate),
network(GET /resources/order-context -> onlinePayment.enabled true processor
checkout)

### VAL-PMOCK-030: Existing KSA Checkout.com order pays through HPP, confirmed without a webhook

Restart the App with `PAYMENTS_MOCK_WEBHOOKS=manual` so no webhook is delivered
automatically. On `http://riyadh-grill.menuza.test:3008` (resolver rule per
user-testing), place a pickup order in SAR and choose online payment. The
browser is redirected to
`http://localhost:3001/mock-payments/checkout-com/hpp/hpp_...` — order checkout
now uses the Hosted Payments Page, not Flow. Pay with Visa `4242424242424242`
(frictionless). The browser lands on `success_url?cko-session-id=sid_...`.
Before any flush, the success page's status poll reports `paid` — the App
reconciled through `GET /hosted-payments/{id}` and `GET /payments/{sid_...}`
with no webhook. Then `POST /mock-payments/dev/events/flush`; the queued
`payment_approved` event delivers with `last_status` 200 and the order remains
`paid` exactly once (late webhook is idempotent). The mock Checkout.com
dashboard lists the payment with its amount allocation and commission. Restore
the default webhook mode afterwards. Pass: paid before flush via lookup, still
paid after flush, no duplicate effect. Isolation: serial (App restart with
webhook mode manual; changes shared webhook mode) Tool: agent-browser Evidence:
screenshot(mock-cko-hpp-page), screenshot(sites-success-paid-ar), network(POST
/api/orders/payment-status -> paid before flush), network(POST
/mock-payments/dev/events/flush -> 200), network(GET
/mock-payments/dev/events?provider=checkout -> payment_approved delivered),
screenshot(cko-dashboard-payment-allocation), sqlite(select payment_status from
restaurant_orders where id='<orderId>' in the riyadh-grill tenant DB)

### VAL-PMOCK-031: HPP amount-based decline

On `riyadh-grill`, build an order whose total in halalas ends in `05` (for
example SAR 10.05 = 1005) by combining items, and open the mock HPP page. Pay
with `4242424242424242`. The payment is declined at submit: the browser is
redirected to `failure_url?cko-session-id=sid_...`, the order is not paid, and
`GET /mock-payments/dev/objects/checkout/<payId>` (id resolvable through the
`sid_`) shows `approved: false`, `status: 'Declined'`, `response_code: '20005'`.
Pass as stated. Tool: agent-browser Evidence: screenshot(sites-payment-failure),
network(GET /mock-payments/dev/objects/checkout/<id> -> Declined 20005),
network(POST /api/orders/payment-status -> not paid)

### VAL-PMOCK-032: HPP 3DS password fail then pass

On `riyadh-grill`, start an order and pay on the mock HPP with
`4543474002249996`. The mock 3DS page asks for a password. Enter a wrong
password: the payment fails (failure redirect or inline failure per the page's
design) and the order is not paid. Start a fresh checkout attempt for a new
order, use the same card, and enter `Checkout1!`: the payment succeeds and the
status poll reports `paid`. Pass: wrong password fails, `Checkout1!` succeeds.
Tool: agent-browser Evidence: screenshot(mock-cko-3ds-page),
screenshot(sites-payment-failure), screenshot(sites-success-paid), network(POST
/api/orders/payment-status -> failed then paid)

### VAL-PMOCK-033: Back from the HPP cancels without paying

On `riyadh-grill`, start an order, and on the mock HPP page click "Back". The
browser lands on the order's cancel URL, the order is not paid, and
`GET /mock-payments/dev/objects/checkout/<hppId>` shows no associated approved
payment. Pass as stated. Tool: agent-browser Evidence:
screenshot(sites-after-cancel), network(GET
/mock-payments/dev/objects/checkout/<hpp_...> -> unpaid), network(POST
/api/orders/payment-status -> not paid)

### Checkout.com stored instruments, MIT, refunds, allocations (emulator test surface)

### VAL-PMOCK-034: Stored instrument and merchant-initiated charges

Run the emulator's stored-instrument Vitest file. It completes an `Unscheduled`
customer-initiated HPP payment storing the card, asserts the payment carries
`source.id` (`src_...`), `customer.id` and `scheme_id`, then performs MIT
`POST /payments` with `source: { type: 'id', id }`, `merchant_initiated: true`,
`payment_type: 'Unscheduled'` and the CIT id as `previous_payment_id`: Visa
approves; an amount ending in `05` declines with `response_code` 20005 (201,
`approved: false`, `status: 'Declined'`); the clearly labeled mock mada card
approves the CIT but its MIT declines with 20046; a `previous_payment_id` that
is not a CIT on the same source is rejected. Pass: the test file exits 0. Tool:
terminal Evidence: terminal(npx vitest run <stored-instrument/MIT test file>)

### VAL-PMOCK-035: Amount allocations recorded and validated

Run the allocations Vitest file. It creates an HPP payment with
`amount_allocations` to a payments-enabled sub-entity and asserts the
allocations and `commission.amount` are stored on the payment object and carried
in the `payment_approved` webhook payload; and it asserts 422
`request_invalid`-style rejections for: allocation ids that are unknown or not
payments-enabled, allocation amounts that do not sum to the payment amount, and
`commission.amount` greater than the allocation amount. Pass: the test file
exits 0. Tool: terminal Evidence: terminal(npx vitest run
<allocations test file>)

### VAL-PMOCK-036: Checkout.com refunds with allocation reversal

Run the CKO refund Vitest file. Against a captured payment with allocations:
`POST /payments/{id}/refunds` returns 202 with an `action_id`; the refund
settles lazily (default approved) emitting `payment_refunded`, with reversal
allocations whose commission is proportional to the refunded amount and never
exceeds what was allocated; a refund forced to decline through the emulator
emits `payment_refund_declined`; `Cko-Idempotency-Key` replays are honored on
payments and refunds. Pass: the test file exits 0. Tool: terminal Evidence:
terminal(npx vitest run <CKO refund test file>)

### VAL-PMOCK-037: Checkout.com protocol fidelity

Run the CKO protocol Vitest file, which uses the real `checkout-sdk-node` client
pointed at host `https://checkout-com.mock.invalid` and asserts: a bad
`Authorization` key returns 401; malformed requests return 422
`{ request_id, error_type: 'request_invalid', error_codes }`;
`POST /payment-sessions` (Flow) is emulated faithfully with an id, tokens and
`_links.self` but no redirect link; and `GET /payments/{id}` resolves both
`pay_` and `sid_` ids. Pass: the test file exits 0. Tool: terminal Evidence:
terminal(npx vitest run <CKO protocol test file>)

### Sites loopback rule and test harness

### VAL-PMOCK-038: Sites accepts loopback http: checkout URLs only outside production

Run the Sites unit test covering the `order-client.ts` checkout-URL check
(`cd apps/sites && CI=true npx vitest run src/lib/ordering/order-client.test.ts`
or the file containing the relaxation test). It asserts: `http:` URLs on
`localhost`, `127.0.0.1` and `*.localhost` are accepted outside production; any
other `http:` URL is rejected with `payment_unavailable`; and in production mode
even loopback `http:` is rejected. Pass: the test file exits 0. Tool: terminal
Evidence: terminal(npx vitest run <order-client test file> in apps/sites)

### VAL-PMOCK-039: Playwright page objects drive the mock pages

Run the payment-mocks Playwright spec added by this milestone:
`commands.e2e_build` then `commands.e2e_spec` with the payment-mocks spec (for
example `tests/e2e/payment-mocks.test.ts`). The spec uses the page objects keyed
on `data-testid` for the mock checkout, 3DS and onboarding pages, uses the dev
API for setup/clock/flush, and asserts through App/Sites status endpoints rather
than the redirect alone. Pass: the spec exits 0. Tool: terminal Evidence:
terminal(PORT=3101 CI=true npx playwright test <payment-mocks spec> --workers=1)

### VAL-PMOCK-040: Event log page lists deliveries and redelivers an event

Precondition: at least one delivered event exists (any earlier payment). Open
`http://localhost:3001/mock-payments/dashboard` as any local visitor. The event
log lists each event with provider, type, delivery status and attempt count.
Click "Redeliver" on one delivered event: its attempt count increments and
`last_status` stays 200, and `GET /mock-payments/dev/events` reflects the same.
Pass: list renders with delivery status and the redelivered event shows a second
attempt. Tool: agent-browser Evidence: screenshot(mock-event-log), network(POST
/mock-payments/dev/events/<id>/redeliver or the page form action -> 200),
network(GET /mock-payments/dev/events -> attempts incremented)

---

Scope: milestone 10 `payments-experiences` — the Admin platform-fee control and
its resolution order, fee math and snapshots, payment policies (deposit, prepay,
card guarantee), the `pending_payment` booking flow through the mock hosted
pages, late payments and expiry, staff-initiated no-show and late-cancel fees
with pay-link recovery, refunds and the reconcile job, disputes, payment
messages, payment badges and panel, the region-switch payment guard, and
Experiences (setup, publishing, public pages, availability, prepaid booking).
Emulator internals (card profiles, ledger mechanics, exclusion layers) belong to
`f-payment-mocks.md`; long end-to-end journeys belong to `i-cross-area.md`.

Environment baseline for all assertions unless stated otherwise: services run
through `services.yaml` (`tenant-api-us` 3007, `tenant-api-ksa` 3009, `app` 3001
with `MOCKS=true`, `sites` 3008; `admin` 3005 only where an assertion says so).
Operator login is `kody` / `KodyLovesYou!2026`, admin on orgs `acme` (US, Stripe
Connect) and `riyadh-grill` (KSA, Checkout.com HPP). Org flags
`reservations.enabled`, `reservations.online`, `reservations.payments` and
`reservations.experiences` are set with `commands.set_org_flag`; demo data via
`commands.seed_reservations_acme` / `commands.seed_reservations_ksa`. Both orgs
are onboarded through the mock helper
(`POST http://localhost:3001/mock-payments/dev/onboard { orgSlug, provider }` or
the Settings, Shop "Mock payments" panel). `PAYMENTS_MOCK_WEBHOOKS` is `inline`
unless an assertion says `manual`. Curl calls to App internal routes and
tenant-api `/internal/*` and `/api/reservations/*` routes authenticate with
`Authorization: Bearer $INTERNAL_COMMAND_TOKEN` from the local env; the token
value never appears in assertions, evidence or reports. Regional state is read
with read-only `sqlite3` against the acme tenant DB
(`packages/database/db/tenant_<acme-orgId>.db`) or the riyadh-grill tenant DB
(under `packages/database/db/ksa/`). Validators use their own guest phones
(`+1555555<nn><mm>` / `+96650000<nn><mm>`), emails, party names, policy and
experience names, and a validator-specific future date. Assertions that change
payment policies do so with validator-owned policies attached to validator-dated
services or experiences, never by editing the seeded defaults, unless marked
serial.

## Area: Reservation payments

#### Platform fee (Admin control, resolution order, math, snapshot)

### VAL-PAY-001: Admin control shows the seeded system default and no overrides

Start Admin (`services.admin`), log in to the App as kody in the same
agent-browser session, run `commands.copy_admin_session`, then open
`http://localhost:3005/` and navigate to the Reservations platform fee control
(route file `_admin+/reservations.platform-fee.tsx`). The control shows the
system default of 0 basis points (displayed as a percentage, `0.00%`) and an
empty override list, matching migration `0026`. Read back:
`sqlite3 packages/database/db/data.db "select key, level, value from ConfigFlag where key='reservations.platform_fee_bp'"`
shows the system row with value `0`. Pass: default shown as 0 / `0.00%`, no
organization rows listed, and the data.db row present. Stop Admin afterwards.
Tool: agent-browser Evidence: screenshot(admin-fee-control-default),
sqlite(data.db ConfigFlag system row = 0) Milestone:
payments-integrations-and-native Isolation: serial (Admin running)

### VAL-PAY-002: Add an organization override, shown as a percentage with two decimals

With Admin open as in VAL-PAY-001, add an override for `acme` of `250` basis
points and save. The control then lists acme with the override displayed as
`2.50%` (percentage with two decimals), and
`sqlite3 packages/database/db/data.db "select level, organizationId, value from ConfigFlag where key='reservations.platform_fee_bp' and level='organization'"`
shows `250` for acme's organization id. Pass: the override is listed, rendered
as `2.50%`, and persisted as the integer 250 at organization level. Fail: stored
as a percentage (2.5), a string, or not listed. Tool: agent-browser Evidence:
screenshot(admin-fee-override-listed), sqlite(data.db ConfigFlag org row = 250)
Milestone: payments-integrations-and-native Isolation: serial (Admin running;
changes the platform fee config in data.db)

### VAL-PAY-003: The control rejects non-integers and values outside 0-10000

With Admin open as in VAL-PAY-001, attempt to save each of: `12.5`, `-1`,
`10001`, and a non-numeric string, as the system default and as an acme
override. Every attempt is refused with a field validation error and nothing is
written (the ConfigFlag rows in data.db are unchanged). Then save `0` and
`10000` (boundaries): both are accepted and displayed as `0.00%` and `100.00%`.
Pass: the four invalid inputs are all rejected with a validation error and no
write; both boundaries save. Fail: any invalid value persists. Tool:
agent-browser Evidence: screenshot(admin-fee-validation-errors), sqlite(data.db
ConfigFlag unchanged then 0/10000), network(POST reservations.platform-fee
action -> 4xx for invalid) Milestone: payments-integrations-and-native
Isolation: serial (Admin running; changes the platform fee config in data.db)

### VAL-PAY-004: Removing an override restores system-level resolution

Continuing from VAL-PAY-002, remove the acme override in the Admin control. The
override list no longer shows acme, the data.db organization row is gone, and
the system default row is untouched. Pass: after removal, only the system row
exists for the key and the list is empty again. Tool: agent-browser Evidence:
screenshot(admin-fee-override-removed), sqlite(data.db ConfigFlag rows for the
key) Milestone: payments-integrations-and-native Isolation: serial (Admin
running; changes the platform fee config in data.db)

### VAL-PAY-005: Resolution order (org override beats system beats 0) observed in charged amounts

Preconditions: acme has a validator-owned deposit policy of
$25.00 per cover
attached to the validator's date; acme has no org override. Set the D1 system
row to 300 bp (`npx wrangler d1 execute DB --local --command "update ConfigFlag set value='300' where key='reservations.platform_fee_bp' and level='system'"`
from `apps/app`). A guest books party 4 ($100.00
= 10000 minor) and pays on the mock Stripe page. Then
`GET /mock-payments/dev/objects/stripe/<paymentIntentId>` shows
`application_fee_amount: 300` and the acme tenant DB `rsv_payments` row has
`platform_fee_bp=300, platform_fee_minor=300`. Now add the acme org override 500
(`commands.set_org_flag acme reservations.platform_fee_bp 500`) and repeat the
booking on a new validator date: the second charge shows
`application_fee_amount: 500` and `platform_fee_bp=500`, proving the org row
wins over the system row. Reset both to 0 afterwards
(`commands.set_org_flag acme reservations.platform_fee_bp delete`; restore the
system row to `0`). Pass: 300 with only the system row, 500 with the override,
each equal to `floor(10000 * bp / 10000)`. Tool: agent-browser Evidence:
screenshot(mock-checkout-success), terminal(curl
/mock-payments/dev/objects/stripe/<pi> application_fee_amount),
sqlite(rsv_payments platform_fee_bp/minor), terminal(commands.set_org_flag)
Milestone: payments-integrations-and-native Isolation: serial (changes the
platform fee config in D1)

### VAL-PAY-006: Fee math floors (`floor(amountMinor * bp / 10000)`)

Set the acme org override to 150 bp (D1, as in VAL-PAY-005) and create a
validator-owned flat deposit policy of $33.33 (3333 minor). A party-2 booking
pays 3333 minor through the mock Stripe page. The emulator's PaymentIntent has
`application_fee_amount: 49` (floor(3333 * 150 / 10000) = floor(49.995)) and the
`rsv_payments` row snapshots `platform_fee_bp=150, platform_fee_minor=49`. Pass:
exactly 49 in both places. Fail: 50 (rounding instead of flooring) or a missing
snapshot. Reset the override afterwards. Tool: agent-browser Evidence:
terminal(curl /mock-payments/dev/objects/stripe/<pi> -> application_fee_amount
49), sqlite(rsv_payments platform_fee_minor=49) Milestone:
payments-integrations-and-native Isolation: serial (changes the platform fee
config in D1)

### VAL-PAY-007: Checkout.com commission allocation carries the fee (KSA)

Set the riyadh-grill org override directly in D1
(`commands.set_org_flag riyadh-grill reservations.platform_fee_bp 1000`;
riyadh-grill is D1-only and never appears in Admin). Create a validator-owned
flat deposit policy of SAR 100.00 (10000 halalas) on the KSA location. A guest
books on `http://riyadh-grill.menuza.test:3008` and pays through the mock
Checkout.com HPP. `GET /mock-payments/dev/objects/checkout-com/<payId>` shows
`amount_allocations` containing the sub-entity id with `amount: 10000` and
`commission: { amount: 1000 }`, and the KSA tenant DB `rsv_payments` row
snapshots `platform_fee_bp=1000, platform_fee_minor=1000`. Pass: the commission
equals floor(10000 * 1000 / 10000) = 1000 in the emulator object and the
regional snapshot. Reset the override afterwards. Tool: agent-browser Evidence:
terminal(curl /mock-payments/dev/objects/checkout-com/<pay> allocations),
sqlite(ksa rsv_payments fee snapshot), screenshot(mock-cko-hpp) Milestone:
payments-integrations-and-native Isolation: serial (changes the platform fee
config in D1)

### VAL-PAY-008: The fee snapshot on a payment never changes when the fee changes later

With the acme override at 500 bp, complete a deposit booking of 10000 minor
(snapshot: `platform_fee_bp=500, platform_fee_minor=500`). Then change the
override to 900 bp (`commands.set_org_flag ... 900`). The existing
`rsv_payments` row still reads 500/500, and an operator full refund of that
booking reverses the fee by the snapshot: the emulator refund shows the
application-fee reversal of 500, not 900-based. Pass: the stored snapshot is
unchanged by the later config change and drives the reversal. Reset the override
afterwards. Tool: agent-browser Evidence: sqlite(rsv_payments snapshot
before/after the flag change), terminal(curl
/mock-payments/dev/objects/stripe/<refund> fee reversal 500),
terminal(commands.set_org_flag) Milestone: payments-integrations-and-native
Isolation: serial (changes the platform fee config in D1)

### VAL-PAY-009: Proportional fee reversal on partial and full refunds (rounding)

Set the acme override to 1000 bp and create a flat deposit policy of 3333 minor;
the paid booking snapshots `platform_fee_minor=333`. From the detail sheet
payment panel, kody (payment grant) refunds 1667 minor: the emulator refund
reverses `round(333 * 1667 / 3333)` = 167 of fee. Then refund the remaining
1666: the second reversal is 166, and the two reversals sum to exactly 333.
Pass: reversals 167 and 166 recorded on the two emulator refunds (and
equivalently `commission` reversals on the Checkout.com side if run on
riyadh-grill); fail if the fee is not reversed, is reversed in full on the first
partial refund, or the parts do not sum to the snapshot. Tool: agent-browser
Evidence: sqlite(rsv_payments refunded_minor accumulation), terminal(curl
/mock-payments/dev/objects/stripe/<refund1|refund2>),
email-capture(refund_issued) Milestone: payments-integrations-and-native
Isolation: serial (changes the platform fee config in D1)

### VAL-PAY-010: The platform fee also applies to staff-charged fees

With the acme override at 1000 bp and a guaranteed booking (card
`4000 0025 0000 3155`, no-show fee $25.00 per cover, party 4), kody marks the
booking no-show and charges the fee from the payment panel. The off-session
charge of 10000 minor carries `application_fee_amount: 1000` on the emulator
PaymentIntent, and the `rsv_payments` fee row (`kind='no_show_fee'`,
`status='succeeded'`) snapshots `platform_fee_bp=1000, platform_fee_minor=1000`
as reported by the App's `/fee-result` call. Pass: the fee charge itself bears
the platform fee and the snapshot lands on the fee row. Reset the override
afterwards. Tool: agent-browser Evidence: terminal(curl
/mock-payments/dev/objects/stripe/<pi> application_fee_amount 1000),
sqlite(rsv_payments fee row snapshot) Milestone:
payments-integrations-and-native Isolation: serial (changes the platform fee
config in D1)

### VAL-PAY-011: The reservation fee never touches shop or order flows

With the acme override at 1000 bp, place and pay an existing online ordering
pickup order on acme through the mock Stripe page (the `payment-mocks`
regression target). The order charge keeps the shop fee behavior
(`SHOP_PLATFORM_FEE_PERCENT`, 20%) and shows no influence from
`reservations.platform_fee_bp`: no reservation-style fee snapshot is written
anywhere in the tenant DB and the order's application fee follows the shop rule
only. Pass: order amounts and fees are identical to the same order with the
override at 0. Fail: any reservation fee applied to an order. Reset the override
afterwards. Tool: agent-browser Evidence: terminal(curl
/mock-payments/dev/objects/stripe/<order pi> fee), sqlite(no rsv_payments rows
for the order) Milestone: payments-integrations-and-native Isolation: serial
(changes the platform fee config in D1; runs an ordering flow)

#### Payment policies

### VAL-PAY-012: Policy CRUD and terms versioning

As kody on acme, open Reservations, Settings, Policies
(`reservations+/settings.policies.tsx`). Create a validator-owned deposit
policy: amount
$25.00 per cover, free cancellation until 1440 minutes before,
late-cancel fee $50.00
flat, no-show fee $25.00 per cover with a $100.00 cap, refund rule
`full_before_window`, terms text in English and Arabic; the list shows it with
`terms_version` 1. Edit only the terms text and save: the list now shows
`terms_version` 2 (editing terms bumps the version), and the acme tenant DB
`rsv_policies` row matches. Pass: create/edit/versions behave as stated; fail if
a terms edit does not bump `terms_version`. Tool: agent-browser Evidence:
screenshot(policy-form-and-list), sqlite(rsv_policies terms_version 1 -> 2),
network(PUT /operator/reservations/setup/policies -> 200) Milestone:
payments-integrations-and-native

### VAL-PAY-013: `reservations.payments` off hides and refuses non-`none` policy kinds

Turn off the child flag
(`commands.set_org_flag acme reservations.payments false`; master stays on). In
the App, Reservations, Settings, Policies returns 404 (the route requires the
payments feature). Directly against tenant-api with a fresh `setup`-scope token
(minted while the feature is folded off),
`PUT /operator/reservations/setup/policies` with a `deposit` policy is refused
(404 from the feature check), while a `none` policy can still be saved through
whatever settings surface remains. Restore the flag
(`commands.set_org_flag acme reservations.payments true`). Pass: UI 404 and API
refusal while off, normal behavior after restore. Tool: agent-browser Evidence:
network(GET settings.policies -> 404), terminal(curl PUT policies -> 404
feature_off/not_found), terminal(commands.set_org_flag) Milestone:
payments-integrations-and-native Isolation: serial (toggles
`reservations.payments` for acme)

### VAL-PAY-014: Processor capability is reported per organization in the context

Call `curl http://localhost:3001/resources/reservations/context?orgId=<id>` with
the internal command token for acme and for riyadh-grill. With both onboarded,
acme reports
`payments: { processor: 'connect', deposit: true, guarantee: true }` and
riyadh-grill reports `{ processor: 'checkout', deposit: true, guarantee: true }`
(Checkout.com guarantee support is always true in mock mode). Pass: both
contexts match these values; fail on `null` processor or false capabilities for
an onboarded org. Tool: curl Evidence: terminal(curl
/resources/reservations/context for both orgs), network(GET
/resources/reservations/context -> 200) Milestone:
payments-integrations-and-native

### VAL-PAY-015: Booking fails closed with `policy_unavailable` when the processor is unavailable

Simulate a processor that became unavailable: from `apps/app`, run
`npx wrangler d1 execute DB --local --command "update Organization set stripeConnectChargesEnabled=0 where slug='acme'"`
and wait out the 5-minute tenant-api context cache (or restart the App). A guest
booking on a validator date whose service carries a deposit policy now fails
closed: `POST /reservations` answers an error with code `policy_unavailable`, no
reservation or payment row is created, and the slot is not held (a follow-up
availability search still offers it). Restore the column to 1 afterwards. Pass:
closed failure with `policy_unavailable` and no state written; fail if the
booking is created without payment. Tool: curl Evidence: terminal(curl POST
/reservations -> policy_unavailable), sqlite(no new
rsv_reservations/rsv_payments rows), terminal(wrangler d1 update + restore)
Milestone: payments-integrations-and-native Isolation: serial (flips acme
onboarding state in D1; App restart or cache wait)

### VAL-PAY-016: KSA policy form recommends prepaid deposits

As kody on `riyadh-grill`, open Reservations, Settings, Policies and start a new
policy. The form shows the regional guidance "Prepaid deposits are recommended
in this region" (the KSA/Checkout.com caveat from the architecture). The same
form on acme does not show it. Pass: the hint renders for riyadh-grill only.
Tool: agent-browser Evidence: screenshot(ksa-policy-form-hint),
screenshot(us-policy-form-no-hint) Milestone: payments-integrations-and-native

### VAL-PAY-017: The guest sees the policy terms and consent is recorded with the terms version

With a validator-owned deposit policy (terms version 2 after an edit) active for
the slot, start a booking on `http://acme.menuza.test:3008/reserve`. The details
step renders the policy terms text (the operator-authored terms for the selected
locale) and requires the consent control before continuing; the payment step
follows. After paying, the acme tenant DB reservation row has `policy_snapshot`
containing the policy id, amounts and `terms_version: 2`, and
`policy_accepted_at` / `policy_text_hash` are set. Pass: terms displayed before
payment, consent recorded, snapshot carries the version in force at booking
time. Fail: no terms shown, booking completes without consent, or the snapshot
carries the wrong version. Tool: agent-browser Evidence:
screenshot(sites-policy-terms-step), sqlite(rsv_reservations policy_snapshot +
policy_accepted_at + policy_text_hash) Milestone:
payments-integrations-and-native

### VAL-PAY-018: `applies_party_min` scopes when a policy applies

Create a validator-owned deposit policy with `applies_party_min = 6` on the
validator's date. A party-4 booking on Sites completes with no payment step
(booking goes straight to `booked`, `payment_status = none`), while a party-8
booking at the same time is created `pending_payment` with the payment block.
Pass: the small party bypasses payment and the large party requires it, same
slot and service. Tool: agent-browser Evidence: network(POST /reservations ->
201 without payment for party 4; with payment block for party 8),
sqlite(rsv_reservations statuses) Milestone: payments-integrations-and-native

#### Deposit and prepayment at booking

### VAL-PAY-019: A policy requiring payment returns the payment block and parks the booking in `pending_payment`

With the acme deposit policy ($25.00 per cover) active, complete the Sites
booking flow for party 4 up to the details step and submit. The tenant-api
response is `201` with
`payment: { paymentToken, purpose: 'deposit', amountMinor: 10000, currency: 'USD', expiresAt, payUrl }`
where `payUrl` is
`http://acme.menuza.test:3008/reserve/pay#r=<id>&t=<paymentToken>`; the
reservation is `pending_payment` (not `booked`) with `payment_status: 'pending'`
and a `payment_expires_at` about `payment_hold_minutes` (default 20) out; an
`rsv_payments` row `kind='deposit', processor='stripe', amount_minor=10000`
exists. Pass: all of the stated response fields, statuses and the payment row.
Fail: the booking confirms without payment or the payment block lacks
`paymentToken`/`payUrl`. Tool: agent-browser Evidence: network(POST
/reservations -> 201 with payment block), sqlite(rsv_reservations
pending_payment + rsv_payments deposit row), screenshot(sites-payment-step)
Milestone: payments-integrations-and-native

### VAL-PAY-020: The extended payment hold keeps capacity while unpaid

Continuing VAL-PAY-019, before paying: the hold row has
`extended_for_payment = 1` and `expires_at` matching `payment_expires_at` (the
20-minute payment hold, not the 7-minute regular hold). While the booking waits,
`GET /reservations/availability` for the same date/party no longer offers the
held slot to a second guest, and the operator day feed shows the pending
booking. Pass: capacity is consumed exactly like a booking for the extended
window. Fail: the slot is double-offered while `pending_payment`. Tool: curl
Evidence: sqlite(rsv_holds extended_for_payment + expires_at), terminal(curl GET
/reservations/availability slot absent), network(GET
/operator/reservations/book/day -> 200) Milestone:
payments-integrations-and-native

### VAL-PAY-021: Payment success arrives by webhook even when the guest closes the tab (Stripe, inline mode)

Book a deposit on acme and, on the mock Stripe Checkout page
(`/mock-payments/stripe/checkout/:sessionId`), pay with `4242 4242 4242 4242`,
then close the tab immediately at the success redirect (never returning to
Sites). Without any further guest action, the booking becomes `booked` with
`payment_status = 'paid'` (verify through the operator Book list or
`GET /reservations/manage/payment`), and a `payment_received` email for the
guest is captured in `apps/tenant-api/.dev-mail/us/` with the manage link. Pass:
webhook delivery alone moves the booking to booked/paid and enqueues the
message. Fail: the booking stays `pending_payment` until a poll. Tool:
agent-browser Evidence: network(mock checkout POST -> 303), terminal(poll GET
/reservations/manage/payment -> booked/paid), email-capture(payment_received),
sqlite(rsv_payments status succeeded) Milestone:
payments-integrations-and-native

### VAL-PAY-022: Payment success arrives by webhook on Checkout.com, with Arabic email and no SMS (KSA)

On `http://riyadh-grill.menuza.test:3008` in Arabic, book the validator-owned
KSA deposit policy (SAR 100.00 flat) and pay on the mock Checkout.com HPP with
Visa `4543474002249996`, completing the 3DS password page with `Checkout1!`,
then close the tab. The booking becomes `booked` / `paid` without a poll; a
`payment_received` email is captured in `apps/tenant-api/.dev-mail/ksa/` with
Arabic content and `dir="rtl"`; and
`grep 'SMS MOCK' /tmp/menuza-logs/tenant-api-ksa.log` shows no reservation SMS
for the guest (KSA is email-only even though the guest opted into SMS at
booking). Pass: webhook-only success, Arabic RTL email captured, zero SMS. Fail:
booking stuck pending, English-only email, or any KSA SMS line. Tool:
agent-browser Evidence: screenshot(cko-hpp-3ds), email-capture(payment_received
ar/rtl), terminal(grep SMS MOCK tenant-api-ksa.log -> none for this booking),
sqlite(ksa rsv_payments succeeded) Milestone: payments-integrations-and-native

### VAL-PAY-023: Status lookup alone marks the booking paid when no webhook is delivered (both processors)

Restart the App with `PAYMENTS_MOCK_WEBHOOKS=manual` added to its environment.
On acme, book a deposit and pay on the mock Stripe page; do not flush events.
Polling the payment status (Sites `/api/reservations/payment-status` or the
guest poll `GET /reservations/manage/payment`) retrieves the session and moves
the booking to `booked` / `paid` with the webhook still queued
(`GET /mock-payments/dev/events?provider=stripe` shows it undelivered). Repeat
on riyadh-grill through the HPP (`curl` the Sites payment-status endpoint): the
App's Checkout.com status lookup (`GET /hosted-payments/{id}` then
`GET /payments/{id}`) marks it booked with no webhook. Then
`POST /mock-payments/dev/events/flush`: each late webhook is recorded as a
duplicate — statuses do not change and no second `payment_received` email is
captured. Restore the normal App environment afterwards. Pass: poll-only success
on both processors, and flushed duplicates are inert. Tool: agent-browser
Evidence: terminal(curl Sites payment-status -> paid), terminal(curl
/mock-payments/dev/events queued then flushed), sqlite(rsv_messages single
payment_received per dedupe_key), email-capture(payment_received exactly once)
Milestone: payments-integrations-and-native Isolation: serial (App restart with
PAYMENTS_MOCK_WEBHOOKS=manual)

### VAL-PAY-024: A declined card leaves the booking unpaid and the guest can retry until expiry

Book a deposit on acme; on the mock Stripe page pay with `4000 0000 0000 0002`:
the page re-renders with an inline decline error, the session stays open, the
reservation remains `pending_payment` / unpaid, and no success email is
captured. Still within the payment window, return to the payment step from the
same payUrl and pay with `4242 4242 4242 4242`: the booking becomes `booked` /
`paid` and exactly one reservation exists (no duplicate booking from the retry).
Pass: decline leaves state unpaid and the retry succeeds on the same booking.
Fail: a decline expires the booking early or the retry creates a second
reservation. Tool: agent-browser Evidence:
screenshot(mock-checkout-decline-error), sqlite(rsv_reservations single row,
pending_payment -> booked), network(POST /reservations count),
email-capture(payment_received after retry only) Milestone:
payments-integrations-and-native

### VAL-PAY-025: 3DS success and 3DS failure on the deposit step

Book a deposit on acme with card `4000 0025 0000 3155`: the mock page redirects
to `/mock-payments/stripe/3ds/:attemptId`; choosing **Complete authentication**
pays and the booking becomes `booked`. On a second booking with the same card,
choose **Fail authentication**: the booking stays `pending_payment` and unpaid,
and a retry that completes authentication succeeds. Pass: 3DS completion books,
3DS failure leaves a retryable unpaid booking. Fail: failure cancels the booking
or blocks retry. Tool: agent-browser Evidence: screenshot(mock-3ds-page),
sqlite(rsv_reservations statuses across both bookings),
email-capture(payment_received once per booking) Milestone:
payments-integrations-and-native

### VAL-PAY-026: Expiry releases the booking, the capacity and the provider session

Book a deposit on acme with the location's `payment_hold_minutes` at its minimum
(10) and abandon the mock checkout page. After `payment_expires_at` passes, run
`curl -X POST http://localhost:3007/api/reservations/tick` (internal token). The
reservation becomes `expired`, its occupancies are deactivated, the held slot
reappears in `GET /reservations/availability` (and a new guest booking for it
succeeds), an `rsv_outbox` row of kind `checkout_expire` is recorded, and the
emulator's Stripe session is expired (completing it via
`POST /mock-payments/dev/stripe/sessions/:id/complete` now fails / the page
shows the session is no longer active). Pass: all four effects. Fail: capacity
stays held after expiry or the session stays payable indefinitely. Tool: curl
Evidence: terminal(curl POST /api/reservations/tick), sqlite(rsv_reservations
expired + rsv_outbox checkout_expire + occupancies inactive), terminal(curl
availability slot restored), terminal(curl dev complete on expired session ->
error) Milestone: payments-integrations-and-native Isolation: serial (changes
acme `payment_hold_minutes`; time-based wait)

### VAL-PAY-027: A late payment with the slot still free confirms the booking

App in `PAYMENTS_MOCK_WEBHOOKS=manual` mode; acme `payment_hold_minutes` at 10.
Book a deposit, pay it provider-side at once via
`POST /mock-payments/dev/stripe/sessions/:id/complete { card: '4242424242424242' }`
but deliver nothing (no flush, no poll). Wait past `payment_expires_at` and run
the tick: the reservation expires regionally while the provider payment is
already complete. Now push the late success (poll the status endpoint or flush
the event): regional re-runs the booking plan, the slot is still free, and the
outcome is `confirmed` — the reservation ends `booked` / `paid` and the guest
gets `payment_received`. Pass: a late success on a free slot books the
reservation; fail if it stays expired with the money captured and no refund.
Tool: curl Evidence: terminal(dev complete then tick then flush),
sqlite(rsv_reservations expired -> booked, rsv_payments succeeded),
email-capture(payment_received), network(GET /reservations/manage/payment ->
booked) Milestone: payments-integrations-and-native Isolation: serial (App
restart with manual webhooks; changes `payment_hold_minutes`; time-based wait)

### VAL-PAY-028: A late payment with the slot taken is refunded in full at once

Same setup as VAL-PAY-027, but after the regional expiry and before pushing the
late success, kody books another party into the freed slot (operator booking
succeeds because capacity was released). Now flush the late payment: regional
answers `refund_required`, the App refunds the payment in full immediately
(emulator refund for the full 10000 minor, idempotency key
`reservation_late_refund_<paymentRef>`), the guest receives the
`late_payment_refunded` email, and the reservation stays expired with
`payment_status = 'refunded'`. The operator's replacement booking is untouched.
Pass: automatic full refund plus message, no manual step. Fail: the payment
settles without a refund or the replacement booking is displaced. Tool: curl
Evidence: sqlite(rsv_reservations both bookings; rsv_payments refunded),
terminal(curl /mock-payments/dev/objects/stripe/<refund> full amount),
email-capture(late_payment_refunded) Milestone: payments-integrations-and-native
Isolation: serial (App restart with manual webhooks; changes
`payment_hold_minutes`; time-based wait)

### VAL-PAY-029: A failing late-payment refund moves the payment to `review` and alerts managers

Run the Vitest file covering the late-payment `refund_required` path with a
failing refund (fault injection; search `refund_required` / `review` under
`apps/app` and `apps/tenant-api` payment tests). It must prove: when the
immediate late-payment refund call fails, the payment moves to `review`
(payment_status `review`), a `payment_review` manager alert is enqueued, and no
partial state is committed. Pass: the test file exists and
`cd apps/app && CI=true npx vitest run <file>` (or the tenant-api equivalent)
exits 0. Tool: terminal Evidence: terminal(npx vitest run
<late-payment refund-failure test file>) Milestone:
payments-integrations-and-native

### VAL-PAY-030: The reconcile job settles bound-but-pending sessions and refunds

With the App in `PAYMENTS_MOCK_WEBHOOKS=manual` mode, pay a deposit
provider-side (dev complete) without flushing or polling, so the regional
session stays bound and pending. Call
`curl -X POST http://localhost:3001/resources/jobs/reservation-payments-reconcile`
with the internal command token: the App asks the node's
`/api/reservations/payments/pending`, retrieves the session from the emulator,
pushes the terminal state, and the booking becomes `booked` / `paid`. Pass: the
reconcile call alone settles the booking. Fail: it stays pending until a poll or
flush. Tool: curl Evidence: terminal(curl reconcile route -> 200),
sqlite(rsv_payments pending -> succeeded, rsv_reservations booked),
email-capture(payment_received) Milestone: payments-integrations-and-native
Isolation: serial (App restart with manual webhooks)

### VAL-PAY-031: `/status` accepts only the matching terminal event and duplicates are idempotent

After a deposit is bound,
`curl -X POST http://localhost:3007/api/reservations/payments/status` (internal
token) with a tampered `amountMinor` (or a wrong `sessionId`): the call is
rejected and regional state is unchanged. Then complete the payment legitimately
and deliver the same terminal event twice (the second time via
`POST /mock-payments/dev/events/:id/redeliver` or a repeated `/status` call):
the second delivery reports the duplicate outcome, the reservation version and
statuses do not change, and exactly one `payment_received` message row exists
for the dedupe key. Pass: mismatched events rejected, duplicates inert (I10).
Tool: curl Evidence: terminal(curl /api/reservations/payments/status tampered ->
rejected), terminal(curl redeliver -> duplicate), sqlite(rsv_messages one row
per dedupe_key; reservation version stable) Milestone:
payments-integrations-and-native

#### Card guarantee

### VAL-PAY-032: Stripe setup-mode guarantee stores the card and records consent (including failure retry)

Create a validator-owned `card_guarantee` policy on acme (no-show fee $25.00 per
cover). Book on Sites: the payment step leads to the mock Stripe page in setup
mode ("Save card for later") showing the consent text (amount cap, trigger,
window, time zone; at most 1200 characters). First attempt with
`4000 0000 0000 9995`: the card cannot be attached, setup fails, and the booking
stays `pending_payment`. Retry with `4000 0025 0000 3155` and complete 3DS: the
booking becomes `booked` with `payment_status = 'guaranteed'`. The
`rsv_payments` row has `kind='setup'`, `provider_customer_ref` (`cus_`),
`provider_payment_method_ref` (`pm_`), and card display facts
(`card_brand='visa'`, `card_last4='3155'`, expiry) — and no full card number
anywhere in the tenant DB. `policy_accepted_at` and `policy_text_hash` are set
on the reservation. Pass: failure is retryable, success guarantees, and only
display facts are stored. Tool: agent-browser Evidence:
screenshot(mock-setup-page-consent-text), sqlite(rsv_payments setup row card
facts; no PAN), sqlite(rsv_reservations guaranteed + consent fields) Milestone:
payments-integrations-and-native

### VAL-PAY-033: Checkout.com guarantee stores an instrument for later MIT charges (KSA)

With a validator-owned `card_guarantee` policy on riyadh-grill, book on the
Arabic Sites flow and complete the mock HPP (an `Unscheduled` CIT storing the
card) with Visa `4242424242424242`. The booking becomes `booked` / `guaranteed`;
the KSA tenant DB `rsv_payments` setup row records `provider_payment_method_ref`
(`src_...`), `previous_payment_ref` (the CIT `pay_...` id) and
`provider_customer_ref`, and consent fields are set on the reservation. Pass:
stored-instrument references present and the booking guaranteed. Fail: guarantee
completes without a stored `src_` reference. Tool: agent-browser Evidence:
sqlite(ksa rsv_payments setup row refs), screenshot(cko-hpp), sqlite(ksa
rsv_reservations guaranteed) Milestone: payments-integrations-and-native

#### No-show and late-cancel fees

### VAL-PAY-034: Staff charge a no-show fee off-session: exact amount, audit and message

Preconditions: acme guaranteed booking, party 4, policy no-show fee $25.00 per
cover (cap none), guarantee card `4000 0025 0000 3155`. As kody, mark the
booking no-show from the host stand, then open the detail sheet payment panel
and choose Charge fee: the offered amount is exactly 10000 minor (2500 x 4),
computed from the booking-time snapshot. Confirm: the App action
`reservations+/payments.fee.ts` runs, the off-session PaymentIntent succeeds,
the reservation shows `payment_status = 'fee_charged'`, the `rsv_payments` fee
row is `succeeded` for 10000, an `rsv_audit_log` row `payment.fee_requested`
exists, and a `fee_charged` email is captured. Pass: exact amount, success
state, audit row and message. Fail: wrong amount, no audit, or any charge
without the staff action. Tool: agent-browser Evidence:
screenshot(payment-panel-charge-fee), sqlite(rsv_payments fee row +
rsv_audit_log payment.fee_requested), email-capture(fee_charged), terminal(curl
/mock-payments/dev/objects/stripe/<pi> amount 10000) Milestone:
payments-integrations-and-native

### VAL-PAY-035: Fees are never charged automatically (I12)

Set the acme location's `auto_no_show_after_min` (opt-in) to its minimum and let
a guaranteed validator booking pass its start time without arrival; run the
tick. The reservation is auto-marked `no_show`, but no `rsv_payments` row of any
fee kind exists and the emulator shows no charge. Then kody charges the fee
manually: it succeeds. Pass: the automatic no-show charges nothing, and the
staff action afterwards works. Fail: any fee row or provider charge created by
the tick. Restore the setting to null afterwards. Tool: curl Evidence:
terminal(curl POST /api/reservations/tick), sqlite(rsv_reservations no_show;
zero fee rows in rsv_payments), terminal(curl /mock-payments/dev/objects list:
no PI for the fee) Milestone: payments-integrations-and-native Isolation: serial
(changes acme `auto_no_show_after_min`)

### VAL-PAY-036: Staff charge a late-cancel fee after a guest cancels inside the window

With a deposit policy whose free-cancel window is 1440 minutes, book and
guarantee a table for later today (inside the window). The guest cancels through
the manage link: the reservation is `cancelled` with `late_cancel = 1` and
`cancelled_by = 'guest'`. Kody opens the payment panel and charges the
`late_cancel_fee` (flat $50.00): the off-session charge succeeds for exactly
5000 minor and the status becomes `fee_charged`. Pass: the late-cancel state
enables the fee and the charged amount matches the snapshot. Fail: fee refused
on a late-cancelled booking or amount differs. Tool: agent-browser Evidence:
sqlite(rsv_reservations cancelled + late_cancel=1; rsv_payments late_cancel_fee
5000 succeeded), email-capture(fee_charged), screenshot(payment-panel)
Milestone: payments-integrations-and-native

### VAL-PAY-037: A declined fee charge surfaces the decline and allows exactly one retry

Use a guaranteed booking whose guarantee card is `4000 0000 0000 0341`
(off-session declines). Mark no-show and charge the fee: the off-session
PaymentIntent declines, the fee row becomes `failed` with
`decline_code = 'generic_decline'`, the reservation shows `fee_failed`, and the
payment panel reports the decline. The operator retries once: the second attempt
uses `attempt = 2` (a new idempotency key `rsv:<reservationId>:no_show_fee:2`)
and declines again; a third attempt is refused (only one retry). Pass: decline
recorded with code, one retry allowed and tracked, further retries refused.
Fail: silent failure, or unlimited retries. Tool: agent-browser Evidence:
sqlite(rsv_payments fee rows attempt 1/2 failed with decline_code),
screenshot(payment-panel-decline), terminal(curl
/mock-payments/dev/objects/stripe/<pi> declined) Milestone:
payments-integrations-and-native

### VAL-PAY-038: `authentication_required` recovers through a pay link the guest completes

Guarantee with card `4000 0027 6000 3184` (off-session
`authentication_required`). Charge the no-show fee: the fee row becomes
`requires_action`, the dangling PaymentIntent is cancelled in the emulator, and
a `fee_action_required` email is captured containing the pay link
`http://acme.menuza.test:3008/reserve/pay#f=<feeId>&t=<token>`. Open that link
as the guest and complete the hosted payment (3DS): the fee ends `succeeded`,
the reservation shows `fee_charged`, and a `fee_charged` message follows. Pass:
the full recovery loop works from the emailed link. Fail: no pay link, or the
paid fee is not reconciled to the reservation. Tool: agent-browser Evidence:
email-capture(fee_action_required with pay link),
screenshot(sites-pay-fee-page), sqlite(rsv_payments fee succeeded after
requires_action), terminal(curl /mock-payments/dev/objects/stripe/<pi>
cancelled) Milestone: payments-integrations-and-native

### VAL-PAY-039: Only holders of `update:reservation_payment:any` can charge fees or request refunds

Create or reuse a second operator with the Reservations manager preset (every
grant except payment). In the App as that user: the payment panel on a no-show
booking shows no Charge fee / Refund controls; minting
`/acme/reservations/token?scope=payments` is refused; posting the App actions
`payments.fee.ts` / `payments.refund.ts` is refused (403). Directly with any
non-payments operator token,
`curl -X POST http://localhost:3007/operator/reservations/payments/reservations/:id/fee`
returns 403. The same actions as kody (admin, all grants) succeed. Pass: refusal
at all three layers for the grantless operator, success for the grant holder.
Fail: any layer lets the grantless user through. Tool: agent-browser Evidence:
screenshot(panel-no-payment-controls), network(token?scope=payments -> 403),
terminal(curl fee route with book-scope token -> 403), network(POST payments.fee
-> 403) Milestone: payments-integrations-and-native

### VAL-PAY-040: Fee charge validation: guarantee required, operator may only lower, currency minimum, no double charge

With a payments-scope token, curl the regional fee route on acme bookings: (a) a
no-show booking with no guarantee on file -> refused (no fee created); (b)
`amountMinor` above the snapshot-computed fee -> refused (the operator may only
lower the amount); (c) an amount below the currency minimum (49 minor, USD
minimum 50) -> refused; (d) a second fee after a successful one -> refused. Each
refusal returns a 4xx with a stable error code (`fee_not_allowed` / `invalid`)
and writes nothing. A lowered amount within the rules (for example 8000 instead
of 10000) succeeds and charges exactly the lowered amount. Pass: all four
refusals plus the lowered-amount success. Tool: curl Evidence: terminal(curl
POST .../fee cases a-d -> 4xx with codes), sqlite(rsv_payments only the valid
fee row), terminal(curl lowered amount -> success) Milestone:
payments-integrations-and-native

#### Refunds

### VAL-PAY-041: Guest cancellation inside the free window refunds in full per the terms

With a `full_before_window` deposit policy (free cancellation until 1440 minutes
before), book and pay a deposit on acme for a validator date beyond the window.
The guest cancels through the manage link: the reservation is `cancelled`
(`cancelled_by='guest'`, `late_cancel=0`), a `refund` row and a `refund_request`
outbox row are written, and after the tick delivers it the App executes a full
Stripe refund of 10000 minor with `reverse_transfer: true` and
`refund_application_fee: true` (visible in the emulator object). A
`refund_issued` email is captured and the manage view shows the refunded status.
Pass: full automatic refund per terms with the reversal flags. Fail: no refund,
partial refund, or missing fee reversal. Tool: agent-browser Evidence:
sqlite(rsv_payments refund row + rsv_outbox refund_request), terminal(curl
/mock-payments/dev/objects/stripe/<refund> reverse_transfer +
refund_application_fee), email-capture(refund_issued),
screenshot(manage-refunded) Milestone: payments-integrations-and-native

### VAL-PAY-042: Guest cancellation follows the refund rule: none inside the window, partial when configured

Two paid deposit bookings on acme, both cancelled by the guest through the
manage link inside the free-cancel window (`late_cancel=1`): booking A under a
`refund_rule: none` policy completes the cancellation with no refund row at all;
booking B under a `refund_rule: partial` policy with `partial_refund_bp = 5000`
refunds exactly half (5000 of 10000 minor) and the reservation ends
`partially_refunded`. Pass: rule none refunds nothing, rule partial refunds
exactly 50%, both recorded regionally and in the emulator. Fail: a refund under
rule none, or a full refund under the partial rule. Tool: agent-browser
Evidence: sqlite(rsv_payments: no refund row for A; refund 5000 for B),
terminal(curl /mock-payments/dev/objects/stripe/<refund B> amount 5000),
email-capture(refund_issued for B only) Milestone:
payments-integrations-and-native

### VAL-PAY-043: Restaurant cancellation always refunds in full

Book and pay a deposit under a `refund_rule: none` policy. As kody, cancel the
booking as the restaurant (operator cancel with reason). Despite rule none, a
full refund of 10000 minor executes through the outbox, the guest receives
`cancellation_restaurant` and `refund_issued` emails, and the payment row ends
`refunded` with `refunded_minor = 10000`. Pass: full refund on restaurant cancel
regardless of the configured rule. Tool: agent-browser Evidence:
sqlite(rsv_reservations cancelled_by=restaurant; rsv_payments refunded in full),
email-capture(cancellation_restaurant + refund_issued), terminal(curl
/mock-payments/dev/objects/stripe/<refund> full) Milestone:
payments-integrations-and-native

### VAL-PAY-044: Operator partial refund: exact amount, accumulation and over-refund refusal

On a paid 10000-minor deposit booking, kody requests a refund of 4000 minor from
the payment panel (`payments.refund.ts` action -> regional
`POST /operator/reservations/payments/reservations/:id/refund` -> outbox -> App
execution): the emulator refund is exactly 4000 and the payment row shows
`refunded_minor = 4000`, status `partially_refunded`. Requesting a further 6001
minor is refused regionally with `refund_exceeds_paid` (above
`amount_minor - refunded_minor`) and nothing is enqueued; requesting 6000
succeeds and the row becomes `refunded` with `refunded_minor = 10000`. Pass:
exact amounts, accumulation, and the boundary refusal. Tool: agent-browser
Evidence: sqlite(rsv_payments refunded_minor 4000 -> refused -> 10000),
terminal(curl /mock-payments/dev/objects/stripe refunds 4000 and 6000),
network(POST refund -> 4xx refund_exceeds_paid for 6001) Milestone:
payments-integrations-and-native

### VAL-PAY-045: An asynchronous refund shows `refund pending` and settles to `succeeded`

Pay a deposit with card `4000 0000 0000 7726` (refunds go `pending` first) and
have kody refund it in full. Immediately afterwards the payment panel and badges
show refund pending (`refund_pending`) and the emulator refund is `pending`.
Settle it with
`POST /mock-payments/dev/refunds/:id/settle { outcome: 'succeeded' }` and
deliver the resulting event (inline webhook or
`POST /mock-payments/dev/events/flush`): the payment row becomes `refunded` and
the badge clears to refunded. Pass: the intermediate pending state is visible
and settles to a terminal refunded state. Tool: agent-browser Evidence:
screenshot(refund-pending-badge), terminal(curl dev refunds/:id/settle +
events/flush), sqlite(rsv_payments refund_pending -> refunded) Milestone:
payments-integrations-and-native

#### Disputes

### VAL-PAY-046: A dispute is reported to operators (reported only)

Pay a deposit on acme with card `4000 0000 0000 0259`, then open a dispute with
`POST /mock-payments/dev/disputes { paymentIntent: '<pi>' }`. The
`charge.dispute.created` webhook maps by metadata to the reservation: the
regional `/dispute` call sets the reservation `payment_status = 'disputed'` and
the payment row's `dispute_status`, and a `dispute_opened` manager alert
produces an in-app notification in the App (bell icon; ids and counts only). The
host-stand row and detail sheet show the disputed badge. Pass: status, alert and
badge all appear; fail if the dispute is dropped silently or any
evidence-submission flow is implied. Tool: agent-browser Evidence: terminal(curl
dev disputes), sqlite(rsv_reservations disputed + rsv_payments dispute_status),
screenshot(disputed-badge + manager notification) Milestone:
payments-integrations-and-native

#### Messages, badges and panel consistency

### VAL-PAY-047: KSA payment messages are email-only and Arabic RTL

During the riyadh-grill flows (VAL-PAY-022/033), for a guest who opted into
every channel at booking: every payment message (`payment_received`,
`refund_issued`, `fee_charged` where triggered) is captured as a file in
`apps/tenant-api/.dev-mail/ksa/` with Arabic content and `dir="rtl"`, and
`grep -c 'SMS MOCK' /tmp/menuza-logs/tenant-api-ksa.log` shows no reservation
SMS lines for the guest's phone. Pass: email capture present with RTL markup,
zero KSA SMS. Fail: any reservation SMS on the KSA node or a missing email.
Tool: terminal Evidence: email-capture(payment_received), terminal(ls + grep
.dev-mail/ksa files for dir="rtl"), terminal(grep SMS MOCK tenant-api-ksa.log)
Milestone: payments-integrations-and-native

### VAL-PAY-048: Payment badges on the host stand and detail sheet match the payment state

On acme's Today list for a validator date with: a paid deposit booking, a
guaranteed booking, a booking with a successful no-show fee, and a disputed
booking (VAL-PAY-046): each row shows the matching payment badge (deposit paid /
card on file / fee due or charged / disputed), and opening each detail sheet
shows the same badge there. Pass: badge set and per-state mapping agree between
the list rows and the sheets. Fail: a missing, wrong or inconsistent badge on
either surface. Tool: agent-browser Evidence: screenshot(today-row-badges),
screenshot(detail-sheet-badges), network(GET /operator/reservations/book/day
-> 200) Milestone: payments-integrations-and-native

### VAL-PAY-049: The payment panel lists every payment row and offers actions only with the grant

On a booking with a guarantee, a fee and a refund (from the flows above), open
the detail sheet payment panel as kody: it lists all rows (setup, fee, refund)
with amounts and statuses identical to
`GET /operator/reservations/payments/reservations/:id` (curl with a payments
token) and to the `rsv_payments` table, including card display facts (brand,
last4) and no card numbers. Charge fee and Refund controls are present for kody;
repeated as the Reservations-manager-preset user (VAL-PAY-039) the same panel
data may render but the action controls do not. Pass: panel contents match
regional state exactly and the controls follow the grant. Tool: agent-browser
Evidence: screenshot(payment-panel-rows), terminal(curl GET
/operator/reservations/payments/reservations/:id), sqlite(rsv_payments rows
match), screenshot(panel-actions-hidden-for-manager) Milestone:
payments-integrations-and-native

#### Region-switch guard

### VAL-PAY-050: A guaranteed booking counts as unsettled and blocks the region switch

Preconditions: acme has a `booked` reservation with
`payment_status = 'guaranteed'` (card on file, nothing charged) and no other
unsettled payments.
`curl -X POST http://localhost:3007/internal/reservations/summary` (internal
token) reports an unsettled-payments count >= 1 (a `guaranteed` payment state
blocks, per the guard's status list). In the App, start the customer-data-region
switch for acme and submit with the correctly typed slug: the action answers 409
with `payments_unsettled` and no wipe occurs (the reservation and guest rows are
intact). After cancelling that booking (releasing the guarantee), the summary
count drops to 0 and the guard no longer blocks on payments (do not complete the
switch). Pass: 409 while guaranteed, clean release afterwards; typed
confirmation cannot override. Tool: agent-browser Evidence: terminal(curl
/internal/reservations/summary before/after), network(region action -> 409
payments_unsettled), sqlite(rsv_reservations intact) Milestone:
payments-integrations-and-native Isolation: serial (exercises the shared
region-change action; creates and cancels a booking)

#### Domain and job test gates (fault-injection paths)

### VAL-PAY-051: Policy and fee math unit tests

Run the policy-math tests in `@repo/reservations` (`packages/reservations`, the
file covering `src/policy.ts`). They must prove: `platformFeeMinor` floors;
`proportionalFeeRefund` rounds and parts sum to the snapshot;
`cancellationTerms` computes free / late-cancel / fee / refund per the snapshot
and window; `noShowFee` is per cover or flat, clamped to `fee_cap_minor`, and an
operator amount may only lower it; and `currencyMinimum` is 50 for USD/CAD and
200 for SAR. Pass:
`cd packages/reservations && CI=true npx vitest run <policy test file>` exits 0.
Tool: terminal Evidence: terminal(npx vitest run <policy test file> in
packages/reservations) Milestone: payments-integrations-and-native

### VAL-PAY-052: Reconcile and refund retry behavior tests

Run the Vitest file covering the App payment reconcile job and refund outcome
handling (search `reservation-payments-reconcile` / `refund-result` under
`apps/app`). It must prove: bound sessions still pending are retrieved and
terminal states pushed; `pending` refunds stay pending; `succeeded` / `failed`
refund results update regional rows; and transient provider failures are retried
rather than treated as terminal. Pass: the file exists and
`cd apps/app && CI=true npx vitest run <file>` exits 0. Tool: terminal Evidence:
terminal(npx vitest run <reconcile/refund test file> in apps/app) Milestone:
payments-integrations-and-native

## Area: Experiences

### VAL-EXP-001: A draft experience is visible to operators and invisible to guests

As kody on acme, open Reservations, Experiences
(`reservations+/experiences.tsx`), New: create a validator-owned ticketed
experience "Chef's Counter <validator>", $75.00 per cover, party 2-6,
`uses_tables` on, a schedule with an explicit 19:00 seating on the validator's
Saturday, `covers_cap_per_seating` 8, in the main area. It appears in the
operator list as `draft`. Meanwhile
`curl http://localhost:3007/reservations/experiences -H 'Origin: http://acme.menuza.test:3008'`
does not list it and `http://acme.menuza.test:3008/experiences` does not render
it. Pass: operator-visible draft, publicly absent. Fail: a draft leaks to any
public surface. Tool: agent-browser Evidence:
screenshot(experiences-list-draft), terminal(curl GET /reservations/experiences
-> absent), screenshot(sites-experiences-no-draft) Milestone:
payments-integrations-and-native

### VAL-EXP-002: Experience setup validation rejects invalid definitions

In the experience editor, attempt to save: party range with `party_min` 6 and
`party_max` 2; a schedule with `end_min` before `start_min`; a negative price;
and a slug containing characters outside the slug alphabet. Each is refused with
a field-level validation error that does not echo the rejected value, and
nothing is persisted (`rsv_experiences` unchanged). A corrected definition
saves. Pass: all four rejections plus the clean save. Fail: any invalid row
persists. Tool: agent-browser Evidence:
screenshot(experience-validation-errors), network(POST/PUT experiences -> 4xx
field errors), sqlite(rsv_experiences unchanged) Milestone:
payments-integrations-and-native

### VAL-EXP-003: Experience slugs are unique per location

With "Chef's Counter <validator>" saved (slug `chefs-counter-<validator>`),
create a second experience with the same slug at the same location: refused with
a conflict error. The same slug is accepted only if the first experience is
archived. Pass: duplicate slug refused while the original is active. Tool:
agent-browser Evidence: network(POST /operator/reservations/setup/experiences ->
409), sqlite(rsv_experiences single active slug) Milestone:
payments-integrations-and-native

### VAL-EXP-004: Publishing puts the experience on the Sites public pages (SSR, non-PII)

Publish the experience from the operator screen.
`curl -H 'Host: acme.menuza.test:3008' http://localhost:3008/experiences` now
lists "Chef's Counter <validator>" with its description and $75.00 price, served
from the public `GET /reservations/experiences` data (SSR may fetch it; the
response carries `Cache-Control: max-age=60`), and
`/experiences/chefs-counter-<validator>` renders the detail: name, description,
image, price, seating times and the policy terms. The HTML contains no guest
data (view-source check). Pass: list + detail render published public data only.
Fail: unpublished content leaks, or any PII appears in the SSR HTML. Tool:
agent-browser Evidence: screenshot(sites-experiences-list),
screenshot(sites-experience-detail), network(GET /experiences -> 200,
max-age=60), console-errors Milestone: payments-integrations-and-native

### VAL-EXP-005: Unpublishing (archive) removes the public pages but keeps existing bookings

With a published experience that has one confirmed booking, archive it from the
operator screen. `/experiences` no longer lists it and the detail URL answers
404; the public API omits it. The existing booking remains in the operator Book
with its experience label and is otherwise unaffected. Pass: public gone,
booking intact. Fail: archiving cancels or hides the existing booking. Tool:
agent-browser Evidence: network(GET /experiences/<slug> -> 404), terminal(curl
/reservations/experiences -> absent), sqlite(rsv_reservations booking intact
with experience_id) Milestone: payments-integrations-and-native

### VAL-EXP-006: Experience availability serves the scheduled seatings and enforces the per-seating cover cap

For the published experience (cap 8 covers per seating),
`curl 'http://localhost:3007/reservations/availability?locationId=<id>&date=<sat>&partySize=2&experienceId=<exp>' -H 'Origin: ...'`
offers the 19:00 seating. Book party 6, then party 2: both succeed. The next
party-2 request for 19:00 finds the seating sold out (no slot / marked
unavailable) while the experience's other seatings remain bookable. Pass: cap
arithmetic exactly at 8 covers; fail if a 9th cover books into the seating.
Tool: curl Evidence: terminal(curl availability before/after bookings),
sqlite(rsv_reservations experience rows), terminal(curl sold-out seating
refused) Milestone: payments-integrations-and-native

### VAL-EXP-007: The per-day cover cap is enforced across seatings

Set the validator experience's `covers_cap_per_day` to 10 with two seatings
(19:00 and 21:00, per-seating cap 8). Book 6 covers at 19:00 and 4 at 21:00; any
further experience booking that day — at either seating — is refused as sold
out, while regular table availability for the same evening is unaffected. Pass:
the day cap binds across seatings; fail if an 11th cover books. Tool: curl
Evidence: terminal(curl experience bookings up to cap then refused),
sqlite(rsv_experience_schedules caps; rsv_reservations count), terminal(curl
regular availability still offered) Milestone: payments-integrations-and-native

### VAL-EXP-008: Exclusive windows disappear from regular availability; non-exclusive ones do not

Create two validator experiences on the same validator Saturday in the main
area: experience E1 `exclusive` on with a 19:00 seating, experience E2
`exclusive` off with a 20:00 seating, both published. Regular
`/reservations/availability` (no `experienceId`) for party 2 offers 20:00 (E2's
window stays in regular availability) but never offers 19:00 in the main area —
that window is bookable only through E1's page, where it books normally. Pass:
exclusive windows hidden from the regular channel and still bookable via the
experience; fail if 19:00 appears in regular search or E1 cannot book it. Tool:
curl Evidence: terminal(curl regular availability: 19:00 absent, 20:00 present),
terminal(curl experience availability: 19:00 bookable) Milestone:
payments-integrations-and-native

### VAL-EXP-009: A table-less experience is a cover-capped pool (I1 case c)

Create a validator experience with `uses_tables` off and
`covers_cap_per_seating` 20 at a time when fewer than 20 table seats are free.
Experience bookings succeed past the free table count up to 20 covers total,
write no `rsv_table_occupancies` rows (sqlite), and the 21st cover is refused.
Regular availability for the same window is unaffected by these bookings. Pass:
pool semantics with cap enforcement and zero occupancy rows. Tool: curl
Evidence: sqlite(rsv_table_occupancies: no rows for the experience bookings),
terminal(curl bookings succeed to 20, refused at 21), terminal(curl regular
availability unchanged) Milestone: payments-integrations-and-native

### VAL-EXP-010: Experience booking with prepayment goes through the same checkout

Give the validator experience (ticketed, $75.00 per cover) a prepay policy. From
`/experiences/chefs-counter-<validator>`, book party 2 on the validator
Saturday: the flow creates the booking `pending_payment` with
`payment.purpose = 'experience'` and `amountMinor = 15000` (7500 x 2; the Stripe
line item quantity is the cover count), then pays through the same Sites payment
hand-off and mock Stripe page. Success marks it `booked` / `paid`; the
confirmation page and `payment_received` email match a regular deposit booking's
shape; the operator Book shows the booking with its experience label, and the
calendar/overview for that day counts the experience covers. Pass: identical
checkout mechanics with per-cover pricing and operator visibility. Fail: a
different/duplicated checkout path or wrong amount. Tool: agent-browser
Evidence: network(POST /reservations -> 201 purpose experience amountMinor
15000), screenshot(mock-checkout-experience), sqlite(rsv_reservations
experience_id + paid), email-capture(payment_received),
screenshot(book-experience-label) Milestone: payments-integrations-and-native

### VAL-EXP-011: An experience without a payment policy books without a payment step

Create a validator prix-fixe experience with no policy (and no price or a price
display only). Booking party 2 from its Sites page completes directly to
`booked` with `payment_status = 'none'` — no payment step, no `rsv_payments` row
— and a confirmation email is captured. Pass: payment-free experiences book in
one step. Fail: the flow demands payment anyway. Tool: agent-browser Evidence:
network(POST /reservations -> 201 booked, no payment block), sqlite(no
rsv_payments row), email-capture(confirmation) Milestone:
payments-integrations-and-native

### VAL-EXP-012: An experience booking is manageable under its policy terms

The guest opens the manage link from the confirmation email for a prepaid
experience booking (VAL-EXP-010): the manage view shows the experience name,
date, party size, payment status and the policy terms with the cancel deadline.
Cancelling inside the free window refunds the prepayment in full through the
standard refund path (`refund_issued` email captured). Pass: manage, terms
display and per-terms refund all work for experience bookings. Tool:
agent-browser Evidence: screenshot(manage-experience-booking),
email-capture(refund_issued), sqlite(rsv_payments refunded) Milestone:
payments-integrations-and-native

### VAL-EXP-013: Flag gating: `experiences` off hides everything; public pages also need `online`

With experiences set up and published, turn off
`commands.set_org_flag acme reservations.experiences false`: the operator
Experiences screens 404, `curl` CRUD on
`/operator/reservations/setup/experiences` with a fresh setup token is refused
(feature check), `GET /reservations/experiences` returns the uniform 404, and
`http://acme.menuza.test:3008/experiences` falls back like any gated route
(404/CMS fallback). Turn experiences back on and `reservations.online` off:
operator setup works again, but the public `/reservations/experiences` API and
Sites pages stay 404 (the public part needs both flags). Restore both flags.
Pass: the full matrix behaves as stated. Fail: any public surface reachable with
a required flag off. Tool: agent-browser Evidence: network(operator experiences
-> 404; GET /reservations/experiences -> 404),
screenshot(sites-experiences-404), terminal(commands.set_org_flag toggles),
network(operator setup -> 200 with online off) Milestone:
payments-integrations-and-native Isolation: serial (toggles
`reservations.experiences` and `reservations.online` for acme)

### VAL-EXP-014: KSA experience in Arabic: pages, prepaid booking and SAR amounts

On riyadh-grill, create and publish a validator experience with an Arabic name
and description, SAR 250.00 per cover, prepay policy, 20:00 seating. Open
`http://riyadh-grill.menuza.test:3008/ar/experiences` (resolver rule): the list
and detail render in Arabic, right-to-left, with SAR pricing; book party 2
(50000 halalas) and pay through the mock Checkout.com HPP; the booking confirms,
the Arabic confirmation/payment emails are captured in `.dev-mail/ksa/`, and no
SMS is sent. Pass: Arabic RTL pages end to end with the HPP prepayment. Fail:
LTR layout, wrong currency, or English-only messages. Tool: agent-browser
Evidence: screenshot(ar-experiences-list-rtl), screenshot(ar-experience-detail),
screenshot(cko-hpp-payment), email-capture(confirmation ar), sqlite(ksa
rsv_reservations experience booking paid, currency SAR) Milestone:
payments-integrations-and-native

### VAL-EXP-015: A sold-out exclusive seating does not affect neighbouring regular capacity

With E1 (exclusive, cap 8, 19:00, validator Saturday) fully booked
(VAL-EXP-006), regular `/reservations/availability` for the same evening still
offers the adjacent non-exclusive times at normal capacity, and a regular
party-2 booking at 20:00 succeeds. The experience's covers never consume regular
pacing buckets beyond the exclusive window, and regular bookings never consume
the experience cap. Pass: the two pools are independent apart from the exclusive
window itself. Tool: curl Evidence: terminal(curl regular availability after cap
reached), terminal(curl regular POST /reservations 20:00 -> 201),
sqlite(rsv_reservations both channels coexist) Milestone:
payments-integrations-and-native

### VAL-EXP-016: Experience schedules restricted to areas or a service are honored by the engine

Create a validator experience with `uses_tables` on and `area_ids` limited to
the bar area, plus a `service_id` restriction to dinner. Experience availability
draws only from bar tables during dinner (a booking consumes bar occupancy,
visible in `rsv_table_occupancies`), while regular bookings in the main dining
area at the same time are unaffected and the experience never consumes main-area
tables. Pass: area/service restriction holds in both directions. Fail: an
experience booking occupies a main-area table. Tool: curl Evidence:
sqlite(rsv_table_occupancies only bar table_ids for the experience),
terminal(curl experience availability vs regular availability) Milestone:
payments-integrations-and-native

---

Shared preconditions for live checks: services `tenant-api-us` (3007),
`tenant-api-ksa` (3009), `app` (3001) and `sites` (3008) are up per
`services.yaml`; org `acme` (id `t58bgatqh3rv0s3movrecyj1`, US, node 3007, site
`http://acme.menuza.test:3008`) and org `riyadh-grill` (id
`ru0dm42cud9scs4g2duep21c`, KSA, node 3009); demo data via
`commands.seed_reservations_acme` / `commands.seed_reservations_ksa`; flags via
`commands.set_org_flag`. Voice curl calls need a started call:
`POST http://localhost:3007/api/voice/calls` with the voice agent token
(`Authorization: Bearer`, value from the local env, never written down) and body
`{ orgId, channel, roomName, scopeId, callerPhone }`; the response `callId` is
used in `/api/voice/actions/:name` bodies
`{ orgId, callId, scopeId?, channel, input }`. `callerPhone` must be a US/Canada
number (other numbers are blocked as `not_allowed_number` and produce no SMS).

## Area: Phone agent

### VAL-VOICE-001: Voice action route refuses missing or wrong voice agent token

With tenant-api US on 3007 and a started call for acme,
`POST /api/voice/actions/reservations.availability` with a valid body is sent
three ways: no `Authorization` header, `Authorization: Bearer` with one
character of the real token changed, and a garbage token. Every attempt returns
401 and no `voice_call_actions` row is written. Pass: all three return 401 (not
2xx/5xx other than the token-config 503 case) and `sqlite3` shows zero new
`voice_call_actions` rows for the call. Tool: curl Evidence: network(POST
/api/voice/actions/reservations.availability -> 401), terminal(sqlite3 count of
voice_call_actions), sqlite(voice_call_actions rows for the call) Milestone:
payments-integrations-and-native

### VAL-VOICE-002: Unknown action name returns 404

With a valid voice agent token and a live acme call,
`POST /api/voice/actions/reservations.nonexistent` (and a second made-up name)
returns 404 and writes no `voice_call_actions` row, while the same call then
runs `reservations.availability` successfully, proving the call itself was
valid. Pass: unknown names 404, the known action on the same call succeeds.
Tool: curl Evidence: network(POST /api/voice/actions/reservations.nonexistent ->
404), network(POST /api/voice/actions/reservations.availability -> 200),
sqlite(voice_call_actions) Milestone: payments-integrations-and-native

### VAL-VOICE-003: Actions on a finished call return 409

Start a call, finish it with `POST /api/voice/calls/:callId/finish`, then POST
`reservations.availability` with the same `callId`. Pass: the action returns 409
(call finished) and no `voice_call_actions` row is recorded for it. Tool: curl
Evidence: network(POST /api/voice/actions/reservations.availability -> 409),
sqlite(voice_call_actions) Milestone: payments-integrations-and-native

### VAL-VOICE-004: Per-call caps are enforced (10 / 2 / 1)

On one live acme call, call `reservations.availability` 11 times with valid
input: the first 10 succeed, the 11th returns 429 `rate_limited`. On a fresh
call, `reservations.hold` succeeds twice and the third returns 429;
`reservations.book` (with `voice_mode = 'confirm_on_call'`, see VAL-VOICE-009)
succeeds once and the second returns 429. Pass: caps at exactly 10/2/1 per call,
caps counted from `voice_call_actions` rows for that `call_id` + `action`, and a
different call id is unaffected. Tool: curl Evidence: network(POST
/api/voice/actions/* -> 429), sqlite(voice_call_actions counts by call_id and
action) Milestone: payments-integrations-and-native Isolation: serial (changes
acme `voice_mode` for the `reservations.book` cap check; restore `hold_link`
afterwards)

### VAL-VOICE-005: `web_test` calls run dry and create nothing

Start a call with `channel: 'web_test'`. Run `reservations.availability`
(returns real slots) and `reservations.hold` with valid input. Pass: the hold
response has `simulated: true`; `sqlite3` shows no new row in `rsv_holds` and no
new `rsv_reservations` row for the slot; no `[SMS MOCK]` line appears in
`/tmp/menuza-logs/tenant-api-us.log` for the caller number; the action is still
logged in `voice_call_actions` with `dry_run = 1` and counts toward the per-call
cap. Tool: curl Evidence: network(POST /api/voice/actions/reservations.hold ->
200 with simulated:true), sqlite(rsv_holds and rsv_reservations unchanged),
sms-log, sqlite(voice_call_actions dry_run) Milestone:
payments-integrations-and-native

### VAL-VOICE-006: Voice availability matches the public engine and carries no guest data

With `reservations.enabled`, `reservations.online` and `reservations.voice` on
for acme, request public availability with
`curl -H 'Origin: http://acme.menuza.test:3008' 'http://localhost:3007/reservations/availability?locationId=<id>&date=<D>&partySize=4'`
and `reservations.availability` with input `{ date: <D>, partySize: 4 }` for the
same location. Pass: every `localTime` returned by the voice action (up to 3
nearest) is a slot the public response also offers for the same request, and the
voice response JSON contains only slot fields (`localTime`, `partySizeFits`,
`requiresPayment`) with no guest names, phones, emails or booking details. The
action never returns guest data. Tool: curl Evidence: network(GET
/reservations/availability -> 200), network(POST
/api/voice/actions/reservations.availability -> 200) Milestone:
payments-integrations-and-native

### VAL-VOICE-007: Default hold-and-link texts a `/reserve` confirm link

With acme in the default `voice_mode = 'hold_link'`, start a `phone` channel
call with a US `callerPhone` and POST `reservations.hold` with
`{ slot, partySize, firstName }` for an available slot. Pass: the action
succeeds; a new `rsv_holds` row exists with `source = 'voice_agent'`, the call
id in `voice_call_id`, and expiry `voice_hold_minutes` (default 15) ahead; a
`[SMS MOCK] To: <callerPhone>` line in `/tmp/menuza-logs/tenant-api-us.log`
contains a link on the acme site origin whose path is `/reserve` (a locale
prefix is allowed) and whose URL fragment carries the hold token (e.g.
`#h=...`). The action response itself exposes no guest data beyond the submitted
first name. Tool: curl Evidence: network(POST
/api/voice/actions/reservations.hold -> 200), sms-log, sqlite(rsv_holds row)
Milestone: payments-integrations-and-native

### VAL-VOICE-008: The voice confirm link completes the booking on Sites

Continue from VAL-VOICE-007: extract the `/reserve#...` link from the
`[SMS MOCK]` line and open it in agent-browser on
`http://acme.menuza.test:3008`. Pass: the booking flow resumes the held slot
(date, time and party size prefilled from the hold, hold countdown running) at
the details step; after entering name, phone and email and confirming, the
confirmation screen shows a confirmation code; `sqlite3` shows the hold
converted (`status = 'converted'`) and a new `rsv_reservations` row with
`hold_id` set and `channel = 'voice_agent'`. Tool: agent-browser Evidence:
screenshot(reserve-resumed-hold), screenshot(reserve-confirmation), network(GET
/reservations/holds/current -> 200), network(POST /reservations -> 201),
sqlite(rsv_holds status, rsv_reservations channel/hold_id) Milestone:
payments-integrations-and-native

### VAL-VOICE-009: Confirm-on-call books directly only when enabled and no payment policy exists

Three checks on acme. (a) With the default `voice_mode = 'hold_link'`,
`POST /api/voice/actions/reservations.book` fails with `ok: false`, reason
`not_enabled`, and writes no reservation. (b) With `reservations.payments` on
and a deposit or prepay policy active for the location, setting
`voice_mode = 'confirm_on_call'` through the operator location-settings write is
refused (validation error). (c) With no payment-requiring policy and
`voice_mode = 'confirm_on_call'` (set through the operator setup API with an
`rsv+jwt` token captured per user-testing.md), `reservations.book` with
`{ slot, partySize, firstName }` returns success; `sqlite3` shows an
`rsv_reservations` row with `channel = 'voice_agent'`, `voice_call_id` set and
the caller's number as an unverified contact; and a confirmation message with a
manage link (token in the URL fragment) is captured (`[SMS MOCK]` line for the
US caller, or the dev email capture). Tool: curl Evidence: network(POST
/api/voice/actions/reservations.book -> not_enabled), network(operator
location-settings write -> 4xx), network(POST
/api/voice/actions/reservations.book -> 200), sqlite(rsv_reservations row),
sms-log, email-capture(confirmation) Milestone: payments-integrations-and-native
Isolation: serial (changes acme `reservations.payments` flag, a payment policy,
and `voice_mode`; restore defaults afterwards)

### VAL-VOICE-010: Actions are refused when `reservations.voice` is off

With acme's `reservations.voice` flag off (master on),
`POST /api/voice/actions/reservations.availability` with a valid token and live
call fails with `ok: false`, reason `not_enabled`, and writes no hold or
booking. Turn the flag back on and the same request succeeds. Pass: flag off
refuses, flag on succeeds, nothing written while off. Tool: curl Evidence:
network(POST /api/voice/actions/reservations.availability -> not_enabled then
200), sqlite(rsv_holds unchanged while off) Milestone:
payments-integrations-and-native Isolation: serial (toggles `reservations.voice`
for acme)

### VAL-VOICE-011: App phone-agent settings show the reservation tools toggle only with the flag (US)

Log in to the App as kody, open acme's phone-agent settings
(`/acme/phone-agent`). With `reservations.voice` on for acme, the restaurant
vertical settings show the reservation booking tools toggle; after setting
`reservations.voice` to false the toggle is not rendered. Pass: toggle present
exactly when the flag is on; no console errors either way. Tool: agent-browser
Evidence: screenshot(phone-agent-settings-toggle-on),
screenshot(phone-agent-settings-toggle-off), console-errors Milestone:
payments-integrations-and-native Isolation: serial (toggles `reservations.voice`
for acme)

### VAL-VOICE-012: The toggle never appears for a KSA organization

With `reservations.enabled` and `reservations.voice` both on for `riyadh-grill`,
open `/riyadh-grill/phone-agent` settings as kody. Pass: no reservation tools
toggle is rendered (phone agent is US only), and the page loads without console
errors. Tool: agent-browser Evidence:
screenshot(ksa-phone-agent-settings-no-toggle), console-errors Milestone:
payments-integrations-and-native Isolation: serial (sets flags for riyadh-grill)

### VAL-VOICE-013: Voice actions refuse a KSA organization on both nodes

With a valid voice agent token,
`POST http://localhost:3009/api/voice/actions/reservations.availability` with
`{ orgId: 'ru0dm42cud9scs4g2duep21c', ... }` returns 404, and the same body to
the US node 3007 also returns 404 (the org is not in this node's region). Pass:
both nodes 404 with the uniform response and write nothing. Tool: curl Evidence:
network(POST /api/voice/actions/reservations.availability -> 404 on 3009 and
3007), sqlite(no voice_call_actions rows for the KSA org) Milestone:
payments-integrations-and-native

### VAL-VOICE-014: Core phone-agent package stays free of restaurant words

`packages/phone-agent` gains the generic `services.action(name, input)`
returning `VerticalActionResult`
(`{ ok: true; data } | { ok: false; reason: 'unavailable' | 'rate_limited' | 'not_enabled' | 'invalid' | 'conflict'; explanation }`)
and nothing restaurant-specific. Run
`cd packages/phone-agent && npx vitest run src/vocabulary.test.ts`. Pass: the
vocabulary test is green and `vertical.ts` contains no restaurant vocabulary
(the test enforces the ban list). Tool: terminal Evidence: terminal(cd
packages/phone-agent && npx vitest run src/vocabulary.test.ts) Milestone:
payments-integrations-and-native

### VAL-VOICE-015: Restaurant tools map to the voice actions with `record_request` as fallback

Run the restaurant vertical and worker tool tests:
`cd packages/phone-agent-restaurant && npx vitest run` and
`cd apps/voice-agent && npx vitest run src/tools.test.ts src/restaurant.test.ts`.
Pass: all green, covering `check_table_availability` ->
`reservations.availability`; `book_table` -> `reservations.hold` + `sendLink` of
`/reserve` by default and `reservations.book` in confirm-on-call mode; tools
hidden and the prompt back to request capture when the booking setting is off;
`record_request` (type `reservation`) still registered as the fallback;
`classifyPurpose` returns `reservation` when a booking tool ran; `summarizeCall`
reports the held table without the caller's name; the worker fakes include
`services.action`. Tool: terminal Evidence: terminal(cd
packages/phone-agent-restaurant && npx vitest run), terminal(cd apps/voice-agent
&& npx vitest run src/tools.test.ts src/restaurant.test.ts) Milestone:
payments-integrations-and-native

### VAL-VOICE-016: tenant-api voice action test suite is green, including the last-slot race

Run `cd apps/tenant-api && CI=true npx vitest run src/routes/voice.test.ts`
(plus the voice-actions and `src/lib/reservations-routing.test.ts` routing files
if split out). Pass: the suite is green and covers 401/503 token cases,
cross-region 404, unknown action 404, finished call 409, per-call cap 429
(including concurrent holds), flag-off refusal, the `web_test` dry run, response
shapes without guest fields, two voice holds racing for the last slot producing
exactly one success, and `/api/voice/actions/*` routing on `orgId` from the JSON
body. Tool: terminal Evidence: terminal(cd apps/tenant-api && CI=true npx vitest
run src/routes/voice.test.ts src/lib/reservations-routing.test.ts) Milestone:
payments-integrations-and-native

## Area: Staffing forecast

### VAL-FCST-001: Demand-source registry registers `visits` without disturbing `orders`

Run the tenant-api demand-source and order-source tests
(`cd apps/tenant-api && CI=true npx vitest run src/services/demand-sources.test.ts src/restaurant/staffing-order-source.test.ts src/restaurant/reservations-demand-source.test.ts`,
adjusting to the landed file names). Pass: green; `registerOrderSource` still
registers the `orders` source and `hasOrderSource()` keeps `labor-data.ts` sales
sourcing and `activeReportCatalog()` wording unchanged when `visits` is also
registered; the `visits` source sums seated/finished covers by seated hour and
future capacity-consuming `party_size` by local start hour per scope, selecting
no guest columns. Tool: terminal Evidence: terminal(cd apps/tenant-api &&
CI=true npx vitest run src/services/demand-sources.test.ts
src/restaurant/staffing-order-source.test.ts
src/restaurant/reservations-demand-source.test.ts) Milestone:
payments-integrations-and-native

### VAL-FCST-002: Forecast strip shows booked covers for a day with bookings, counts only

Seed acme (`commands.seed_reservations_acme`) so a near-future day has several
bookings, and enable the staffing labor/scheduling flags. In the App as kody,
open acme's Staff schedule for that week. Pass: the forecast strip for that day
shows the booked-covers count ("N covers booked", restaurant wording through the
scope-wording provider); N equals `sqlite3`-verified sum of `party_size` over
capacity-consuming future reservations that day; the strip and the underlying
day panel show no guest names or contact data. Tool: agent-browser Evidence:
screenshot(forecast-strip-booked-covers), network(GET
/operator/schedule/forecast -> 200), sqlite(sum of party_size for the day),
console-errors Milestone: payments-integrations-and-native

### VAL-FCST-003: Labor settings accept a per-unit standard

In the App labor settings for acme, the standards editor offers an input per
demand unit (`orders` and `visits`), and saving a `visits` standard persists it
(visible after reload). Pass: both units are editable; the saved value is stored
in `labor_scope_settings.demand_per_labor_hour` under the `visits` key for the
position (verify with `sqlite3`). Tool: agent-browser Evidence:
screenshot(labor-standards-per-unit),
sqlite(labor_scope_settings.demand_per_labor_hour JSON) Milestone:
payments-integrations-and-native Isolation: serial (changes acme labor
standards; restore afterwards)

### VAL-FCST-004: Per-unit standards drive the computed labor need

Run `cd packages/staffing && npx vitest run src/forecast-gap.test.ts`. Pass:
green, covering `computeForecastGap` computing need per source and summing per
position; orders-only input producing output identical to the pre-registry
behavior; visits-only input; booked-above-median winning per unit; a position
without a standard for a unit ignoring that unit; output carrying `sources` and
per-slot `bookedBySource`. Tool: terminal Evidence: terminal(cd
packages/staffing && npx vitest run src/forecast-gap.test.ts) Milestone:
payments-integrations-and-native

### VAL-FCST-005: Staffing regression suites and the vocabulary test stay green

Run the existing staffing suites that touch the shared seams:
`cd packages/staffing && npx vitest run` (includes `forecast-gap.test.ts`,
`schedule-demand.test.ts`, `vocabulary.test.ts`) and
`cd apps/tenant-api && CI=true npx vitest run src/routes/schedule.forecast.test.ts src/routes/schedule.demand.test.ts src/routes/labor.test.ts src/routes/labor.tips.test.ts src/routes/analytics.staffing.test.ts`,
plus
`cd apps/app && CI=true npx vitest run app/utils/staffing/labor-types.test.ts`.
Pass: all green, and `packages/staffing` still contains no restaurant words (the
vocabulary test bans "covers" and "table"). Tool: terminal Evidence: terminal(cd
packages/staffing && npx vitest run), terminal(tenant-api staffing route tests),
terminal(cd apps/app && CI=true npx vitest run
app/utils/staffing/labor-types.test.ts) Milestone:
payments-integrations-and-native

### VAL-FCST-006: Forecast API exposes per-source booked counts without guest identifiers

With seeded acme bookings, call
`GET http://localhost:3007/operator/schedule/forecast` for the seeded week with
a staffing operator Bearer token (captured per user-testing.md). Pass: the
response carries per-slot booked demand broken out by source (`bookedBySource`
with a `visits` count matching the sqlite-verified sum) and a `sources` list
including `visits` with unit `visits`; no field anywhere in the payload contains
a guest name, phone or email. Tool: curl Evidence: network(GET
/operator/schedule/forecast -> 200), sqlite(party_size sums per day) Milestone:
payments-integrations-and-native

### VAL-FCST-007: Migration `0017` adds the action log and per-unit standards column

After the `integrations` migrations are applied to acme's tenant DB, inspect it
read-only:
`sqlite3 packages/database/db/tenant_t58bgatqh3rv0s3movrecyj1.db ".schema voice_call_actions"`
and `"SELECT demand_per_labor_hour FROM labor_scope_settings"`. Pass:
`voice_call_actions` exists with columns
`id, call_id, action, outcome, dry_run, created_at` and an index on
`(call_id, action)`; `labor_scope_settings.demand_per_labor_hour` exists as JSON
and existing rows are backfilled from `orders_per_labor_hour` under the `orders`
key (no data lost). Tool: terminal Evidence: sqlite(schema of voice_call_actions
and labor_scope_settings.demand_per_labor_hour), terminal(sqlite3 read-only
queries) Milestone: payments-integrations-and-native

## Area: Journeys

Preconditions for the live journey assertions: a journey with the relevant
`reservation_*` trigger created and activated in the App editor
(`/acme/marketing/automations.new`) while `reservations.enabled` is on for acme;
journey runs are read from acme's tenant DB `journey_runs` (join `customers` by
id to match the guest's phone). Journey-creating assertions are serial because
an active journey fires on every validator's bookings in acme.

### VAL-JRNY-001: The four reservation trigger types are accepted, others still rejected

Run `cd apps/tenant-api && CI=true npx vitest run src/routes/journeys.test.ts`.
Pass: green; journeys can be created and updated with each of
`reservation_booked`, `reservation_completed`, `reservation_no_show` and
`reservation_cancelled`; an unknown trigger type is rejected; the new values are
in `JOURNEY_TRIGGER_TYPES` and the `marketing_journeys.trigger_type` enum with
no SQL migration required. Tool: terminal Evidence: terminal(cd apps/tenant-api
&& CI=true npx vitest run src/routes/journeys.test.ts) Milestone:
payments-integrations-and-native

### VAL-JRNY-002: The editor offers reservation triggers only when the flag is on

In the App as kody, open `/acme/marketing/automations.new` with
`reservations.enabled` on: the trigger select lists all four reservation
triggers with non-empty labels. Set `reservations.enabled` to false and reload:
the four reservation triggers are absent from both `automations.new` and the
existing-journey editor. Pass: triggers offered exactly when the flag is on, in
both editors; no console errors. Tool: agent-browser Evidence:
screenshot(journey-triggers-flag-on), screenshot(journey-triggers-flag-off),
console-errors Milestone: payments-integrations-and-native Isolation: serial
(toggles `reservations.enabled` for acme)

### VAL-JRNY-003: `reservation_booked` fires once after commit for a verified guest

With an active `reservation_booked` journey in acme, sign in on
`http://acme.menuza.test:3008` as a seeded customer (phone OTP, code from the
tenant-api log) and complete a booking on `/reserve`. Pass: within the run of
the booking response, `journey_runs` gains exactly one row for that journey and
the verified customer id; a second booking by the same customer creates a second
run (dedupe is per booking, not per customer); the emission is recorded in
`rsv_journey_emissions` with the reservation id and trigger. Tool: agent-browser
Evidence: screenshot(reserve-confirmation), network(POST /reservations -> 201),
sqlite(journey_runs and rsv_journey_emissions rows) Milestone:
payments-integrations-and-native Isolation: serial (creates/activates a journey
in acme)

### VAL-JRNY-004: An explicitly consenting unverified guest fires the trigger

With the same journey active, book on `/reserve` as a guest (not signed in) with
a fresh test phone number and the marketing opt-in checked. Pass: one
`journey_runs` row appears for the journey; `rsv_guests.marketing_customer_id`
points at a new unverified `customers` row keyed by the normalized phone;
`customer_subscriptions` has rows with topic `reservations`, source
`reservation_booking` and the consented channels; the row is never usable as a
login (unverified). Tool: agent-browser Evidence: network(POST /reservations ->
201), sqlite(journey_runs, rsv_guests.marketing_customer_id, customers,
customer_subscriptions) Milestone: payments-integrations-and-native Isolation:
serial (creates/activates a journey in acme)

### VAL-JRNY-005: A guest who is neither verified nor consenting gets no run

With the same journey active, book on `/reserve` as a guest with a fresh test
phone and the marketing opt-in left unchecked. Pass: the booking succeeds (201,
confirmation shown) but no `journey_runs` row, no `rsv_journey_emissions` row
and no new `customers` row appear for that phone; the booking still counts in
`rsv_reservations` normally. Tool: agent-browser Evidence: network(POST
/reservations -> 201), sqlite(absence in journey_runs, rsv_journey_emissions,
customers) Milestone: payments-integrations-and-native Isolation: serial
(creates/activates a journey in acme)

### VAL-JRNY-006: Emission is deduplicated per booking and trigger with ids-only context

Run the journey emission tests (modeled on `src/routes/auth-trigger.test.ts`),
e.g.
`cd apps/tenant-api && CI=true npx vitest run src/restaurant/reservations-journeys.test.ts`
(adjust to the landed file). Pass: green, covering one run per active journey
per status transition; a repeated transition of the same booking to the same
trigger emits nothing (the `rsv_journey_emissions` primary key is inserted first
and a conflict is a no-op); emission happens after the committing transaction
for host actions and the tick; `contextData` passed to
`evaluateAndSpawnTriggers` has exactly the keys
`reservationId, locationId, partySize, businessDate, serviceId, channel, experienceId, visitNumber`
and never names, phones, emails, notes or allergies. Tool: terminal Evidence:
terminal(cd apps/tenant-api && CI=true npx vitest run
src/restaurant/reservations-journeys.test.ts) Milestone:
payments-integrations-and-native

### VAL-JRNY-007: Step execution checks consent for reservation journeys

Run the `executeJourneyStep` consent tests in `apps/tenant-api` (journey-service
tests). Pass: green; for a journey whose trigger is a `reservation_*` type, a
step on a channel without an active `customer_subscriptions` row (topic
`reservations`) is recorded as `skipped` and sends nothing; withdrawing consent
mid-run stops later steps; journeys with non-reservation triggers keep today's
behavior (no consent check). Tool: terminal Evidence: terminal(cd
apps/tenant-api && CI=true npx vitest run src/services/journey-service.test.ts)
Milestone: payments-integrations-and-native

### VAL-JRNY-008: `reservation_cancelled` fires once from a guest cancel

With an active `reservation_cancelled` journey in acme, book on `/reserve` as a
signed-in customer, then cancel through the manage link
(`/reserve/manage#t=...`). Pass: exactly one `journey_runs` row and one
`rsv_journey_emissions` row with trigger `reservation_cancelled` for that
reservation; no run was created at booking time for this journey (different
trigger). Tool: agent-browser Evidence: screenshot(manage-cancel-confirmation),
network(POST /reservations/manage/cancel -> 200), sqlite(journey_runs,
rsv_journey_emissions) Milestone: payments-integrations-and-native Isolation:
serial (creates/activates a journey in acme)

### VAL-JRNY-009: Trigger labels are complete in both maps and catalogs compile

Run `cd packages/marketing-workflow && npx vitest run` and
`npm run lingui:check`. Pass: green;
`TENANT_TRIGGER_MSGS`/`TENANT_TRIGGER_OPTION_MSGS` (workflow-labels.ts) and
`TENANT_TRIGGER_LABELS`/`TENANT_TRIGGER_OPTIONS` (workflow-config.tsx) each
contain all four `reservation_*` keys (a test asserts this, since the
`Record<string, ...>` types do not); the App `automations.test.ts` covers the
flag-gated allowed list. Tool: terminal Evidence: terminal(cd
packages/marketing-workflow && npx vitest run), terminal(npm run lingui:check),
terminal(cd apps/app && CI=true npx vitest run
app/routes/_app+/$orgSlug_+/marketing+/automations.test.ts) Milestone:
payments-integrations-and-native

## Area: Native apps

### VAL-NATIVE-001: A customer token replaces Turnstile for native clients (tests)

Run the tenant-api public-route protection tests
(`cd apps/tenant-api && CI=true npx vitest run src/routes/reservations-security.test.ts`
and the public routes/abuse test files). Pass: green, covering
`POST /reservations/holds`, `/requests`, `/waitlist/join` and `/notify-me`
succeeding with a valid customer access token and no Turnstile token while
`TURNSTILE_SECRET_KEY` is set; refused without either; an invalid or
cross-organization customer token rejected (not ignored); booking from native
requiring sign-in with no phone field in the payload. Tool: terminal Evidence:
terminal(cd apps/tenant-api && CI=true npx vitest run
src/routes/reservations-security.test.ts) Milestone:
payments-integrations-and-native

### VAL-NATIVE-002: `X-Client` is recorded and sets the channel to `native`

Against acme on 3007 (flags `reservations.enabled` + `reservations.online` on,
Turnstile keys empty locally), create a hold with `X-Client: ios`, then book it
with `X-Client: android` and an idempotency key. Pass: the resulting
`rsv_reservations` row has `client = 'android'` and `channel = 'native'`; the
hold row recorded `source`/client consistently; an absent header defaults to web
behavior; an unknown `X-Client` value does not error the request. Tool: curl
Evidence: network(POST /reservations/holds -> 200), network(POST /reservations
-> 201), sqlite(rsv_reservations.client and channel) Milestone:
payments-integrations-and-native

### VAL-NATIVE-003: The payment-status poll returns status and server time

With an acme booking in `pending_payment` (from the `payments-experiences` seed
or a deposit booking made on Sites with a mock card), call
`GET http://localhost:3007/reservations/manage/payment` with the booking's
payment/manage token in `X-Reservation-Token` (Origin header set). Pass: 200
with exactly `{ paymentStatus, reservationStatus, now }`; after the mock payment
succeeds the same poll reports the updated statuses; a forged or missing token
returns the uniform 404; the route answers GET only. Tool: curl Evidence:
network(GET /reservations/manage/payment -> 200 then updated), network(GET
/reservations/manage/payment -> 404 for bad token) Milestone:
payments-integrations-and-native

### VAL-NATIVE-004: Contract fixtures are recorded from the local tenant-api and parse against the public schemas

Run the recorder (`npm run fixtures:reservations -w tenant-api` with tenant-api
US running and seeded acme) and then the contract test
`cd apps/tenant-api && CI=true npx vitest run src/routes/reservations-contract.test.ts`.
Pass: the recorder writes `packages/reservations/contract-fixtures/*.json` from
live local responses; the contract test parses every canonical fixture with the
public Zod schemas from `@repo/reservations`; re-running the recorder on the
same seed leaves `git status` clean (deterministic ids/data). Tool: terminal
Evidence: terminal(npm run fixtures:reservations -w tenant-api), terminal(cd
apps/tenant-api && CI=true npx vitest run
src/routes/reservations-contract.test.ts), terminal(git status --short after
re-record) Milestone: payments-integrations-and-native

### VAL-NATIVE-005: The iOS and Android fixture copies are byte-identical to the canonical fixtures

Compare the trees:
`diff -r packages/reservations/contract-fixtures apps/ios/Tests/TenantKitTests/Fixtures/Reservations`
and
`diff -r packages/reservations/contract-fixtures apps/android/app/src/test/resources/reservations`,
and confirm the contract test also asserts this. Pass: both diffs are empty
(byte-identical copies, same file names). Tool: terminal Evidence: terminal(diff
-r canonical vs ios and android fixture dirs) Milestone:
payments-integrations-and-native

### VAL-NATIVE-006: iOS TenantKit builds

Run `commands.ios_build` (`swift build` in `apps/ios`). Pass: exit 0 on Linux;
the Reservations code lives in `Sources/TenantKit/Reservations/` (Foundation
only, with `#if canImport(FoundationNetworking)` guards where networking is
touched). Tool: terminal Evidence: terminal(commands.ios_build) Milestone:
payments-integrations-and-native

### VAL-NATIVE-007: iOS TenantKit tests pass, including fixture decoding

Run `commands.ios_test` (`swift test`). Pass: all tests green, including the
Reservations fixture tests that decode every canonical fixture (config,
availability, hold, book, manage, payment status, waitlist) through the
`Decodable` models in `ReservationModels.swift`; fixtures resolve through
`Bundle.module` (test target `resources:` entry present in `Package.swift`).
Tool: terminal Evidence: terminal(commands.ios_test) Milestone:
payments-integrations-and-native

### VAL-NATIVE-008: iOS ReservationsClient sends Origin, X-Client and the customer token on every call

The TenantKit tests assert the request shape through a fake `HTTPTransport`:
every `ReservationsClient` call goes through `CustomerSession.authorized`,
carries the site `Origin`, `X-Client: ios`, and `Authorization: Bearer` for
authenticated calls; mutations are POST. Pass: the request-shape tests in
`Tests/TenantKitTests` are green (run via `commands.ios_test` or the named test
class). Tool: terminal Evidence: terminal(swift test --filter ReservationsClient
tests within commands.ios_test) Milestone: payments-integrations-and-native

### VAL-NATIVE-009: iOS BookingFlow state machine behaves to spec

The `BookingFlow` tests cover: search -> slot -> hold -> details -> payment ->
confirmed transitions; hold countdown computed from `expiresAt` and the server
`now` offset (never the device clock alone) and expiry handling; alternatives
surfaced when the requested time is unavailable; modify/cancel eligibility from
the manage payload; error mapping for `slot_unavailable` (409), `hold_expired`
(410), `policy_required` (422) and `rate_limited` (429); waitlist join and
status. Pass: the BookingFlow test suite is green via `commands.ios_test`. Tool:
terminal Evidence: terminal(commands.ios_test BookingFlow tests) Milestone:
payments-integrations-and-native

### VAL-NATIVE-010: iOS SwiftUI screens exist for the whole flow and hang off the signed-in branch

Inspect `apps/ios/Sources/TenantApp/Reservations/` and
`Sources/TenantApp/Views/RootView.swift`. Pass: files exist for reservations
home (Book a table, My reservations), location picker, search (party stepper,
date strip, time chips, alternatives), details, review with the hold countdown,
deposit via the system browser with a poll on return (`scenePhase`),
confirmation, reservation detail with modify, cancel and running late, and the
waitlist; a `NavigationStack` is added inside the signed-in branch of
`RootView`; manage tokens use the Keychain-backed `TokenStorage` pattern (grep
finds no `UserDefaults` manage-token storage). SwiftUI is not compiled on Linux;
this is a structure check only. Tool: terminal Evidence: terminal(ls/grep of
apps/ios/Sources/TenantApp/Reservations and RootView.swift) Milestone:
payments-integrations-and-native

### VAL-NATIVE-011: Android unit tests pass

Run `commands.android_test` (`testDebugUnitTest`). Pass: all JVM tests green,
including the new `core/reservations/` fixture tests; `core/` still imports no
`android.*` (a test or lint check enforces it). Tool: terminal Evidence:
terminal(commands.android_test) Milestone: payments-integrations-and-native

### VAL-NATIVE-012: Android debug build passes

Run `commands.android_build` (`assembleDebug`). Pass: exit 0, compiling the
framework-views UI in `ui/reservations/` with no AndroidX, coroutines or new
runtime dependencies (check `app/build.gradle.kts` dependencies are unchanged
except test deps). Tool: terminal Evidence: terminal(commands.android_build)
Milestone: payments-integrations-and-native

### VAL-NATIVE-013: Android request shape is POST-only with Origin, X-Client and Bearer

The Android client tests assert every reservation call: mutations use POST only
(no PATCH anywhere in `core/net` or `core/reservations`, which
`HttpURLConnection` cannot send), `Origin` is attached to reservation calls (not
only auth), `X-Client: android` is set, and the customer Bearer token is sent
through `CustomerSession.authorized`. Pass: the request-shape tests are green
via `commands.android_test`, and `grep -rn 'PATCH' apps/android/app/src/main`
finds no reservation call. Tool: terminal Evidence:
terminal(commands.android_test request-shape tests), terminal(grep -rn PATCH
apps/android/app/src/main) Milestone: payments-integrations-and-native

### VAL-NATIVE-014: Android BookingFlow matches the iOS state machine

The Kotlin `BookingFlow` tests cover the same behaviors as VAL-NATIVE-009: the
transition sequence, hold countdown from `expiresAt` and the server offset,
expiry, alternatives, modify/cancel/running-late eligibility, the four error
mappings, and waitlist join/status, all against the shared fixtures. Pass: green
via `commands.android_test`. Tool: terminal Evidence:
terminal(commands.android_test BookingFlow tests) Milestone:
payments-integrations-and-native

### VAL-NATIVE-015: All six Android locales carry the complete reservations strings

Compare `apps/android/app/src/main/res/values/strings.xml` with `values-ar`,
`values-es`, `values-fr`, `values-de` and `values-zh`. Pass: every reservations
string key present in the base file exists in the other five with a non-empty,
non-placeholder translation (a script or test compares key sets); `lintDebug`
(`commands.android_lint`) reports no missing-translation or hardcoded-text
errors for the new screens. Tool: terminal Evidence: terminal(key-set comparison
across values*/strings.xml), terminal(commands.android_lint) Milestone:
payments-integrations-and-native

### VAL-NATIVE-016: The Android byte budget holds, or a raise records its reason

Run `commands.android_size` (release APK + AAB and `scripts/size-report.mjs`).
Pass: the size report passes against `apps/android/size-budget.json`; if
`size-budget.json` was raised above the planning baseline (APK 160,000 B, AAB
220,000 B), the same commit's `$comment` in that file records the reason, and
the measured sizes still fit the new budget. Tool: terminal Evidence:
terminal(commands.android_size), terminal(cat apps/android/size-budget.json)
Milestone: payments-integrations-and-native

### VAL-NATIVE-017: Android screens, navigation and token storage follow the platform patterns

Inspect `apps/android/app/src/main/kotlin/com/epicstartup/tenant/`:
`ui/reservations/` implements the screens behind the keys `res:home`,
`res:location`, `res:search`, `res:details`, `res:review`, `res:confirmed`,
`res:detail:<id>` and `res:waitlist` in `AppState`/`MainActivity.screenKey()`
with a small back stack; time chips are `TextView`s in a wrapping
`LinearLayout`; payment opens through `MainActivity.openUrl` with a poll in
`onResume`; manage tokens live in the Keystore-backed storage (grep finds no
plain-preferences manage-token storage). Pass: all keys and patterns present.
Tool: terminal Evidence: terminal(grep/ls of ui/reservations, AppState.kt,
MainActivity.kt) Milestone: payments-integrations-and-native

### VAL-NATIVE-018: The tenant-api contract test keeps server, iOS and Android aligned

Run
`cd apps/tenant-api && CI=true npx vitest run src/routes/reservations-contract.test.ts`.
Pass: green; it parses every canonical fixture with the public Zod schemas and
fails when any native copy drifts from the canonical fixture (verify by checking
the test asserts byte-identity of both copies, per VAL-NATIVE-005). Tool:
terminal Evidence: terminal(cd apps/tenant-api && CI=true npx vitest run
src/routes/reservations-contract.test.ts) Milestone:
payments-integrations-and-native

## Area: Docs

### VAL-DOCS-001: `docs/reservations.md` exists with the full operator guide and runbook sections

The file exists at the repo root docs and contains sections covering: features,
the flags table (all six `reservations.*` keys), permissions and role presets,
first-day setup, kill switches (`RESERVATIONS_PUBLIC_ENABLED`,
`RESERVATIONS_EMAIL_ENABLED`, `RESERVATIONS_SMS_ENABLED`,
`RESERVATIONS_TICK_INTERVAL_SECONDS`), deploy order (tenant-api before App), a
symptoms table, the region switch, a KSA checklist, demo data
(`seed:reservations`), the CI security checks, and known gaps. Pass: every
listed topic has a heading or table in the file. Tool: terminal Evidence:
terminal(grep for the required headings in docs/reservations.md) Milestone:
payments-integrations-and-native

### VAL-DOCS-002: `docs/reservations-contract.md` and `docs/reservations-plan.md` are complete

`docs/reservations-contract.md` documents the public (`/reservations/*`),
operator (`/operator/reservations/*`), internal (`/internal/reservations/*`),
voice (`/api/voice/actions/:name`) and native API contracts with schemas, the
stable error codes, and the fixture locations. `docs/reservations-plan.md` holds
the design summary and a per-milestone build log including any migration beyond
`0016`/`0017`/`0025`/`0026`. Pass: both files exist and contain the listed
sections; the contract names the voice action registry and the
`X-Client`/customer-token native rules. Tool: terminal Evidence: terminal(grep
for sections in docs/reservations-contract.md and docs/reservations-plan.md)
Milestone: payments-integrations-and-native

### VAL-DOCS-003: ADR 048 records the residency decisions

`docs/decisions/048-reservations-data-residency.md` exists and covers: data
placement, regional settings and experiences, browser-direct operator access,
public origin binding, guest identity without login, the payments split
(regional decisions, App provider calls), the tick/alarm generalization,
messaging regions (US SMS, email), retention and erasure, flags, location-scope
reuse, and the platform fee. Pass: the file exists, follows the ADR format of
047, and names each listed decision. Tool: terminal Evidence: terminal(grep for
the decision topics in docs/decisions/048-reservations-data-residency.md)
Milestone: payments-integrations-and-native

### VAL-DOCS-004: AGENTS.md documents the module and the new environment variables

The repo `AGENTS.md` contains a "Reservations module" section (flags, residency
rule, security gates, seed command) and lists the new variables from
architecture section 17 (`RESERVATIONS_PUBLIC_ENABLED`,
`RESERVATIONS_EMAIL_ENABLED`, `RESERVATIONS_SMS_ENABLED`,
`RESERVATIONS_TICK_INTERVAL_SECONDS`, `DEV_EMAIL_CAPTURE_DIR`, `PAYMENTS_MOCK*`,
`STRIPE_CONNECT_WEBHOOK_SECRET`) alongside the existing entries. Pass: the
section exists and each variable name appears in AGENTS.md and in the relevant
`.env.schema` (`apps/tenant-api/.env.schema` or `apps/app/.env.schema`). Tool:
terminal Evidence: terminal(grep AGENTS.md and the .env.schema files for the
variable names) Milestone: payments-integrations-and-native

### VAL-DOCS-005: The existing docs are updated where the module touches them

Pass when all of these edits exist: `docs/permissions.md` lists the eight
reservations permissions and the six flags; `docs/scheduled-jobs.md` documents
the generic org alarm modules, the reservations tick and the payment reconcile
job; `docs/tenant-data-residency.md` states the guest-data residency rules;
`docs/phone-agent-verticals.md` documents `services.action` and the tenant-api
voice action registry; `apps/tenant-api/README.md` documents the new routes,
kill switches and the dev email capture; `docs/staffing.md` documents the shared
alarm, demand sources and units (`orders`/`visits`, `demand_per_labor_hour`) and
the scope wording. Tool: terminal Evidence: terminal(grep each listed file for
the listed topics) Milestone: payments-integrations-and-native

---

Scope: journeys that span two or more areas, surfaces or milestones; entry
points and navigation; first-visit flows; residency and privacy across planes;
region behavior end to end. Single-area behaviors are owned by the per-area
authors and are deliberately not repeated here (the one handed-off exception: "a
Sites booking appears in the operator's Today/Book within one poll" belongs to
the online-booking author; flows below that pass through it verify other
checkpoints).

Shared conventions used below:

- Services: App `http://localhost:3001`, Sites `http://localhost:3008` (Host
  `acme.menuza.test:3008`, or `riyadh-grill.menuza.test:3008` via the resolver
  rule `MAP *.menuza.test [::1]`), tenant-api US `http://localhost:3007`,
  tenant-api KSA `http://localhost:3009`, Admin `http://localhost:3005` (started
  only when a flow says so). Start/stop/health per `services.yaml`; logs in
  `/tmp/menuza-logs/<service>.log`.
- Operator login: agent-browser, `http://localhost:3001/login`, user `kody`,
  password `KodyLovesYou!2026`. kody is admin in `acme` (US) and `riyadh-grill`
  (KSA). Use one `--session` per validator and close it at the end.
- Flags: `commands.set_org_flag <slug> <key> <json|delete>` (writes local D1,
  and `data.db` when the org exists there). "All flags on" for acme means
  `reservations.enabled`, `.online`, `.waitlist`, `.payments`, `.experiences`,
  `.voice` set to `true`.
- Demo data: `commands.seed_reservations_acme` /
  `commands.seed_reservations_ksa`.
- Operator token for curl: log in as the target user in agent-browser, open a
  reservations screen, and read the `Authorization: Bearer` header of a captured
  request to `http://localhost:3007|3009/operator/reservations/...` (or call
  `/<org>/reservations/token?scope=<scope>` from the page with agent-browser
  eval). Never paste tokens into reports.
- Internal routes: `Authorization: Bearer $INTERNAL_COMMAND_TOKEN` (from the
  environment; never printed). Voice routes:
  `Authorization: Bearer $VOICE_AGENT_TOKEN`.
- Guest emails: JSON files in `apps/tenant-api/.dev-mail/us/` and
  `.../.dev-mail/ksa/` (newest first via `commands.list_dev_emails_us` /
  `list_dev_emails_ksa`). Guest SMS: `[SMS MOCK] To: ... | Message: ...` lines
  in `/tmp/menuza-logs/tenant-api-us.log`. App-sent emails:
  `http://localhost:3001/mock-email/dev/messages?to=<email>`.
- Databases (read-only queries): local D1 via
  `cd apps/app && npx wrangler d1 execute DB --local --json --command "<sql>"`;
  LibSQL `packages/database/db/data.db` via `sqlite3`; tenant DBs
  `packages/database/db/tenant_t58bgatqh3rv0s3movrecyj1.db` (acme) and
  `packages/database/db/ksa/tenant_ru0dm42cud9scs4g2duep21c.db` (riyadh-grill).
- Validators use unique guest phones/emails per validator (for example
  `+1555555<validator><nn>`, `rsv-<validator>-<n>@example.com`) and, where the
  flow allows, a distinct future booking date.

## Cross-Area Flows

### VAL-CROSS-001: First visit: module invisible until enabled, then reachable through the sidebar and set up end to end

Preconditions: all services up; acme has no organization-level `reservations.*`
rows (`commands.set_org_flag acme reservations.enabled delete` and same for the
five child keys, so the seeded system `false` rows apply). Journey:

1. As kody on `http://localhost:3001/acme`: the sidebar shows no "Reservations"
   group. `GET /acme/reservations` (typed URL) returns 404. Open Settings,
   Roles, edit any role: no Reservations permission group is offered. Open
   Settings, Locations, the Downtown Flagship location: no Reservations card.
2. `commands.set_org_flag acme reservations.enabled true`. Reload: the
   "Reservations" sidebar group appears and its first link is reachable by
   clicking (not by typing a URL); `/acme/reservations` redirects to the first
   allowed section. The role editor now shows the Reservations group with the
   eight permissions; the location page shows the Reservations card linking to
   `reservations/settings?location=<id>`.
3. Through the sidebar, open Reservations, Settings and complete a minimal setup
   for the location: save general settings (defaults are acceptable), create one
   area, add two tables (2-top and 4-top), save the floor plan (explicit Save,
   no conflict), create one dinner service covering the next 7 days. The
   validation view (`settings` tab) reports no blocking issues.
4. With an operator `setup` token,
   `curl http://localhost:3007/operator/reservations/setup/locations/<id>/settings`
   returns 200 with the saved values, proving the App screen wrote to the
   regional node, not the control plane. Pass: every checkpoint in 1-4 holds.
   Fail: any reservations UI, route, role group, or card visible while the flag
   is off; any 404 while it is on; setup not persisted regionally. Tool:
   agent-browser (App), curl (tenant-api) Evidence: screenshot(sidebar-off),
   screenshot(sidebar-on), network(GET /acme/reservations -> 404 then 200),
   terminal(commands.set_org_flag), sqlite(D1 ConfigFlag rows for acme)
   Milestone: foh-core Isolation: serial (creates/deletes acme
   organization-level flag rows; leaves `reservations.enabled` on)

### VAL-CROSS-002: Host preset can run the book but is refused setup, guestbook, reports and payments everywhere

Preconditions: all flags on for acme; `commands.seed_reservations_acme` run. As
kody (admin), create a role from the "Host" preset (Settings, Roles; the preset
grants `read:reservation:any` + `update:reservation:any` only). Create an
organization invite link (Settings, Members) for that role; in a fresh
agent-browser session open the invite link, register a new user
`host-cross-<validator>` (read the verification code from the local D1
`Verification` table if asked), and log in. Journey:

1. As the host user: the sidebar Reservations group shows only Today and Book
   (no Settings, Guestbook, Reports, Experiences, Waitlist entries requiring
   other grants). Open Today: seeded bookings render. Create a phone booking
   from Today for tomorrow, party of 2: it succeeds and appears in the Upcoming
   tab. Mark it arrived, then seated: both quick actions succeed.
2. Attempts that must fail: typed URL `/acme/reservations/settings` -> 403 or
   404 (not a rendered page); same for `/acme/reservations/guests` and
   `/acme/reservations/reports`. From the page, eval
   `fetch('/acme/reservations/token?scope=setup')`, `?scope=guests`,
   `?scope=reports`, `?scope=payments`: each returns 403 (mint refuses a scope
   the member has no grant for).
3. With the host's `book` token,
   `curl http://localhost:3007/operator/reservations/setup/locations/<id>/settings`
   -> 403, and `GET /operator/reservations/guests?q=a` -> 403 (tenant-api
   enforces grants independently of the App). Pass: the host completes booking
   and status changes, and every setup, guest, report and payment surface or
   token is refused in both the App and tenant-api. Fail: any forbidden screen
   renders, any refused mint returns a token, or any refused tenant-api call
   returns 2xx. Tool: agent-browser (App), curl (tenant-api) Evidence:
   screenshot(host-sidebar), screenshot(host-today-booking), network(GET
   /acme/reservations/token?scope=setup -> 403), network(GET
   /operator/reservations/setup/... -> 403), sqlite(D1 Verification row read)
   Milestone: foh-core Isolation: serial (creates a role, an invite link and a
   user in acme)

### VAL-CROSS-003: Location scope limits a member across the book, the API and navigation

Preconditions: all flags on for acme; seeded data; acme has two locations
(Downtown Flagship `v17plv08r5v357bie335lyq8`, Waterfront Kitchen
`vw6s16lrjjvyafd3dc4cqexu`). As kody, set the host user from VAL-CROSS-002 (or a
new invited member with the Host preset) to location scope "selected" with only
Downtown Flagship (Settings, Members). Journey:

1. As the scoped member, open Reservations: the location picker lists only
   Downtown Flagship. Today and Book show only that location's bookings.
2. The member's token (`/acme/reservations/token?scope=book`) carries
   `locationIds` = exactly the Downtown id (decode the JWT payload locally; do
   not log the token).
3. With that token:
   `curl 'http://localhost:3007/operator/reservations/book/day?locationId=vw6s16lrjjvyafd3dc4cqexu&date=<tomorrow>'`
   -> 403 or 404, and the same request with the Downtown id -> 200. A POST
   `/operator/reservations/book/reservations` for the Waterfront location ->
   403/404.
4. Typed URL `/acme/reservations/book?location=vw6s16lrjjvyafd3dc4cqexu` renders
   no Waterfront data (403 or empty-state with picker forced back to Downtown).
   Pass: every surface and API call is limited to the scoped location; the
   excluded location is invisible and immutable for this member. Fail: any
   Waterfront booking row, name or slot reaches the member's browser or curl.
   Tool: agent-browser (App), curl (tenant-api) Evidence:
   screenshot(scoped-picker), network(GET /operator/reservations/book/day
   waterfront -> 403), network(day downtown -> 200), terminal(curl POST refused)
   Milestone: foh-core Isolation: serial (changes a member's location scope)

### VAL-CROSS-004: Region-switch guard shows reservation counts and requires the typed slug

Preconditions: all flags on for acme; seeded data including at least one future
reservation and one guest. Journey:

1. As kody, open Settings, Website/organization site card (the region control).
   Open the change-region dialog. Checkpoint: the dialog lists reservation
   counts (future reservations, guests, waitlist entries) fetched from
   `GET /resources/reservations/region-summary?orgSlug=acme` (200 in the network
   log, counts > 0), alongside the existing staffing counts.
2. Attempt the switch without typing the slug (or with a wrong slug): the action
   returns 400 `reservationsConfirmationRequired`; nothing changes. Checkpoint:
   `curl -X POST http://localhost:3007/internal/reservations/summary` with the
   internal token and `{ "orgId": "t58bgatqh3rv0s3movrecyj1" }` returns the same
   counts, confirming the dialog numbers come from the regional node.
3. Verify no switch happened: `sqlite3` on acme's tenant DB still returns the
   seeded `rsv_reservations` rows, and Today still lists them. Do NOT complete
   the switch (see Scope notes). Pass: counts shown and consistent with the
   regional summary route; untyped or mis-typed confirmation refused with 400;
   data untouched. Fail: switch proceeds without confirmation, counts missing,
   or any data lost. Tool: agent-browser (App), curl (tenant-api), terminal
   (sqlite3) Evidence: screenshot(region-dialog-counts), network(GET
   /resources/reservations/region-summary -> 200), network(region action ->
   400), terminal(curl internal summary), sqlite(acme tenant rsv_reservations
   count unchanged) Milestone: foh-core Isolation: serial (exercises the shared
   region-change action; no switch completed)

### VAL-CROSS-005: Floor-plan editor Save drives the live floor plan and seating

Preconditions: all flags on for acme; setup from VAL-CROSS-001 or seed. Journey:

1. As kody, open Reservations, Settings, Floor plan (full-screen editor). Move a
   table, resize another, add one new table "P-9" in the area, and Save.
   Checkpoint: save returns the new `floorPlanVersion`; a second tab opened
   before the Save that tries to Save afterwards gets a 409 conflict (stale
   version) and keeps its draft.
2. Open Reservations, Floor (live floor plan): the layout matches the saved
   draft exactly (P-9 present, moved table at its new position).
3. From Today, seat a walk-in party of 2 onto P-9: the floor shows P-9 occupied
   with a running timer; Today shows the party under Seated; the timeline shows
   the occupancy on P-9's row.
4. Archive P-9 in Settings, Tables: the floor no longer offers it; the conflicts
   view lists any affected future booking as unassigned. Pass: geometry edited
   in setup is exactly what the host stand renders and acts on; stale-version
   conflict is reported, not silently overwritten. Fail: any drift between
   editor and live floor, or a lost/conflicting save. Tool: agent-browser (App)
   Evidence: screenshot(floor-editor), screenshot(live-floor-p9), network(PUT
   /operator/reservations/setup/locations/<id>/floor-plan -> 200 then 409),
   console-errors Milestone: foh-core

### VAL-CROSS-006: Automatic reflow moves are shown to hosts but never to guests

Preconditions: all flags on for acme; seeded future bookings with soft
assignments; the module messages exist (or skip step 4 when run before
guest-messages and rely on step 3 only). Journey:

1. As kody, open the Timeline for tomorrow. Note a soft-assigned booking's
   table. Create a table block (Settings, Special days / blocks) covering that
   table for the booking's window.
2. Timeline reload: the soft booking has been auto-reassigned to another table;
   an auto-move notice is shown on the timeline; the reservation detail sheet
   (`?r=<id>`) history contains an `auto_reassigned` event with the old and new
   table ids.
3. Open the same booking's guest manage view
   (`http://acme.menuza.test:3008/reserve/manage#t=<manageToken>` from the
   booking's confirmation link or a freshly minted token via curl with the
   internal services): the guest sees their time and party, no table assignment
   and no trace of the reassignment. The manage view JSON
   (`GET /reservations/manage`) contains no `auto_reassigned` events and no
   table ids.
4. A locked booking (drag with "Lock" chosen on the timeline) under the same
   block is NOT moved: it appears in the unassigned/conflict panel instead.
   Pass: hosts see the move and its audit event; guests never see assignment
   churn; locked bookings are never auto-moved. Fail: guest manage view leaks
   table ids or auto-reassign events; a locked booking moved automatically.
   Tool: agent-browser (App + Sites), curl (tenant-api) Evidence:
   screenshot(timeline-auto-move-notice), network(GET /reservations/manage ->
   200 body check), screenshot(conflict-panel-locked), console-errors Milestone:
   foh-core

### VAL-CROSS-007: Setup changes reshape what Sites offers and what staff booking warns about, consistently

Preconditions: all flags on for acme; a bookable dinner service tomorrow.
Journey:

1. Baseline: on `http://acme.menuza.test:3008/reserve`, party 2 tomorrow shows
   time chips.
   `curl 'http://localhost:3007/reservations/availability?locationId=<id>&date=<tomorrow>&partySize=2'`
   with `Origin: http://acme.menuza.test:3008` returns slots.
2. As kody in Settings, Special days: add an `online_closed` special day for
   tomorrow. Reload `/reserve`: tomorrow shows no online slots (closed note or
   unavailable day), and the availability API returns `closed` (or empty slots
   with the reason). Meanwhile in the App Book, kody can still create a phone
   booking for tomorrow (staff channel unaffected); the booking succeeds.
3. Change the special day to `closed`: now staff booking for tomorrow also fails
   or blocks with the closed reason.
4. Mark the only 4-top table `staff_only` for the dinner service (service
   availability): Sites no longer offers slots for party 4 (party 2 still fits
   smaller tables); the staff availability endpoint
   (`GET /operator/reservations/book/availability`) still offers party 4.
5. Add a pacing rule `max_parties=1` per 15-minute bucket for dinner with
   `channel=all`: after one existing booking in a bucket, staff availability
   shows the next same-bucket slot with a pacing warning (staff may proceed with
   explicit overbook), while Sites does not offer that bucket at all. Pass: each
   rule change takes effect on both channels with the documented channel
   semantics (guest channel filtered, staff channel warned), with no App or
   Sites restart. Fail: any channel sees stale availability, or a guest slot
   appears that the rules forbid. Tool: agent-browser (App + Sites), curl
   (tenant-api) Evidence: network(GET /reservations/availability -> 200 bodies
   before/after), screenshot(sites-closed-day),
   screenshot(staff-pacing-warning), terminal(curl staff availability)
   Milestone: guest-channels-and-crm Isolation: serial (changes acme special
   days, service availability and pacing rules; restore the original settings at
   the end)

### VAL-CROSS-008: Every reservations screen is reachable by navigation, on App and Sites

Preconditions: all flags on for acme (`enabled`, `online`, `waitlist`,
`payments`, `experiences`, `voice`); seeded data; kody has the admin role.
Journey (no typed URLs except where stated):

1. App: from the sidebar Reservations group, reach Today, Book, Waitlist,
   Guestbook, Experiences, Reports, Settings. From Settings tabs reach floor
   plan, tables, services, special days, sections, waitlist, messages, policies.
   From Today open the reservation detail sheet via a row click (URL gains
   `?r=<id>`); from Book reach the same sheet; from the floor plan reach it too.
   Timeline, calendar and overview are reachable from the book/host-stand
   navigation. Each screen renders without a console error.
2. Website builder: open a published page in Website, Pages; add the "Book a
   table" block (it is offered in the block picker while `reservations.online`
   is on), publish.
3. Sites: on `http://acme.menuza.test:3008/`, the published page shows the Book
   a table block; clicking it opens `/reserve` (prefilled
   `?location=&party=&date=&time=` when configured). Complete a booking; the
   confirmation step links to the manage page (`/reserve/manage#t=...`) and the
   manage page loads. The profile page (after guest OTP sign-in with
   `+15555550123`, code from `commands.read_sms_code`) shows an "Upcoming
   reservations" panel listing that booking. Pass: every screen in the
   architecture 10.2 route map and every Sites entry point (block, confirmation
   manage link, profile panel) is reachable by clicking, and renders. Fail: any
   screen reachable only by typed URL, any 404 with flags on, or console errors.
   Tool: agent-browser (App + Sites) Evidence: screenshot(sidebar-group),
   screenshot(builder-block), screenshot(sites-block),
   screenshot(profile-panel), network(GET /reservations/mine -> 200),
   console-errors Milestone: guest-channels-and-crm Isolation: serial (publishes
   a website page change on acme)

### VAL-CROSS-009: An abandoned hold returns its slot to both the guest and staff channels

Preconditions: all flags on; `hold_minutes` at its minimum (3) for the test
location (set through Settings; restore afterwards). Journey:

1. On Sites `/reserve`, party 2 tomorrow: pick the last slot of a single-table
   area (or a table with no alternative), reach the hold step with the countdown
   visible; do NOT confirm. Note the slot time.
2. Immediately with an operator `book` token:
   `curl 'http://localhost:3007/operator/reservations/book/availability?locationId=<id>&date=<d>&partySize=2'`
   no longer offers that slot (the live hold consumes capacity).
3. Abandon: close the guest tab (or POST `/reservations/holds/release` with the
   hold token). Wait past `expiresAt` (3 minutes) or force the sweep with
   `curl -X POST http://localhost:3007/api/reservations/tick` (internal token,
   `{ "orgId": "t58bgatqh3rv0s3movrecyj1" }`).
4. Re-check both channels: the Sites time chips show the slot again and the
   staff availability endpoint offers it again. Checkpoint:
   `sqlite3 packages/database/db/tenant_t58bgatqh3rv0s3movrecyj1.db "select status from rsv_holds order by created_at desc limit 1"`
   shows `expired` (or `released`), and `rsv_table_occupancies` has no active
   row for it. Pass: the slot is withheld while the hold is live and offered
   again on both channels after expiry. Fail: slot lost after expiry, or
   bookable by a second guest while the hold was live. Tool: agent-browser
   (Sites), curl (tenant-api), terminal (sqlite3) Evidence: network(POST
   /reservations/holds -> 201), network(availability before/after -> 200),
   terminal(curl tick), sqlite(rsv_holds status, occupancy inactive) Milestone:
   guest-channels-and-crm Isolation: serial (changes acme `hold_minutes`;
   restores it at the end)

### VAL-CROSS-010: RESERVATIONS_PUBLIC_ENABLED=false gives 503 on guest routes while operator tools keep working

Preconditions: all flags on; seeded data. This flow restarts the US tenant-api
node: run it alone. Journey:

1. Baseline:
   `curl -H 'Origin: http://acme.menuza.test:3008' http://localhost:3007/reservations/config?locationId=<id>`
   -> 200.
2. Stop `tenant-api-us` (services.yaml stop) and start it again with
   `RESERVATIONS_PUBLIC_ENABLED=false` prepended to the start command.
3. Every public route answers 503 `unavailable`: `/reservations/config`,
   `/reservations/availability`, `POST /reservations/holds`,
   `GET /reservations/manage`, `POST /reservations/waitlist/join`,
   `GET /reservations/experiences`. Sites `/reserve` shows its
   unavailable/closed state (no crash, no 500).
4. Operator side unaffected: kody's Today screen loads live data (browser calls
   to `/operator/reservations/book/day` return 200), and a host can create a
   phone booking.
5. Restart the node normally (services.yaml start) and confirm
   `/reservations/config` -> 200 again. Pass: uniform 503 on every public route
   and full operator functionality throughout. Fail: any public route 2xx while
   the switch is off; any operator failure; 500s. Tool: curl (tenant-api),
   agent-browser (App + Sites), terminal (restart) Evidence: network(GET
   /reservations/config -> 503), network(GET /operator/reservations/book/day ->
   200), screenshot(sites-unavailable), terminal(stop/start tenant-api-us)
   Milestone: guest-channels-and-crm Isolation: serial (restarts the US
   tenant-api node with an env override; affects every validator)

### VAL-CROSS-011: Guest books online, modifies through the email link, operator cancels, slot returns

Preconditions: all flags on for acme; dev email capture active (boot log
`DEV EMAIL CAPTURE ACTIVE` in `tenant-api-us.log`); a bookable slot tomorrow.
Journey:

1. On `http://acme.menuza.test:3008/reserve`, book party 2 tomorrow 19:00 as
   guest `rsv-x1@example.com` / validator-unique phone, SMS opt-in on.
   Confirmation page shows the confirmation code and manage link.
2. Email: the newest capture in `apps/tenant-api/.dev-mail/us/` for
   `rsv-x1@example.com` has `meta.messageKind = "confirmation"` and an HTML body
   containing a manage link (`/reserve/manage#t=`) and an add-to-calendar link.
   SMS: one `[SMS MOCK]` line to the guest phone with the manage link (US node).
3. Follow the manage link in agent-browser: the manage view renders first name,
   time, party, policy terms. Use "add to calendar": the `.ics` downloads
   (tenant-api `GET /reservations/manage/calendar.ics`, 200).
4. Modify through the manage page: move the booking to 20:00. A `modification`
   email is captured. Checkpoint: in the App, kody opens the reservation
   (Today/Book, `?r=<id>`): time is 20:00 and the history shows the guest
   `modified` event; 19:00 is free again (Sites offers it).
5. As kody, cancel the reservation (restaurant cancel, with a reason).
   Checkpoints: a `cancellation_restaurant` email is captured; the manage link
   now shows the cancelled state (no modify/cancel actions); 20:00 is bookable
   again on Sites (book it with a second guest to prove it, then leave or cancel
   that booking). Pass: all five checkpoints. Fail: any missing or wrong-kind
   message, a manage link that 404s or leaks another booking, operator history
   missing the guest modification, or the cancelled slot staying closed. Tool:
   agent-browser (Sites + App), terminal (email capture, SMS log), curl
   Evidence: email-capture(confirmation), email-capture(modification),
   email-capture(cancellation_restaurant), sms-log,
   screenshot(manage-cancelled), network(GET /reservations/manage/calendar.ics
   -> 200), screenshot(operator-history) Milestone: guest-channels-and-crm

### VAL-CROSS-012: Large-party request flows from Sites to the operator and back to the guest

Preconditions: all flags on; the location's `large_party_mode` = `request`,
`online_party_max` = 8; email capture active; kody's in-app notifications
enabled (default). Journey:

1. On Sites `/reserve`, choose party 12 tomorrow: the flow shows the request
   form (not slots). Submit with guest details. Response 201/200; a
   `request_received` email is captured for the guest.
2. Manager alert: within one tick (or after
   `curl -X POST http://localhost:3007/api/reservations/tick`), kody's App
   notification menu shows a `large_party_request` alert carrying the location
   and a count (network: `POST /resources/reservations/notify` was called by
   tenant-api; the Notification row in local D1 has no guest name or phone).
3. In Today, Requests tab (or Book request filter), kody sees the request, opens
   it, approves it for 19:30. Checkpoints: a `request_approved` email with a
   manage link is captured; the booking appears in Book at 19:30 with the
   request's party size; capacity is consumed (a parallel availability check
   shows the unit taken).
4. Second request: repeat step 1 with another validator-unique guest, then
   decline it in the App with a reason. Checkpoints: a `request_declined` email
   is captured; no booking appears; the declined request shows in the operator
   list as declined. Pass: both branches (approve, decline) produce the matching
   message and book state, and the manager alert carried ids and counts only.
   Fail: request lost between surfaces, wrong message kind, or guest PII in the
   App notification. Tool: agent-browser (Sites + App), terminal (email
   capture), curl (tick), sqlite (D1 Notification row) Evidence:
   email-capture(request_received), email-capture(request_approved),
   email-capture(request_declined), screenshot(today-requests-tab), network(POST
   /resources/reservations/notify -> 2xx), sqlite(D1 Notification
   kind/location/count, no PII) Milestone: guest-channels-and-crm

### VAL-CROSS-013: Runbook flag order: online off keeps manage, reminders and operator tools; master off hides all and restores cleanly

Preconditions: all flags on for acme; at least one future booking with an email
guest (from seed or VAL-CROSS-011); email capture active. Journey:

1. `commands.set_org_flag acme reservations.online false`. Checkpoints: the Book
   a table block disappears from the Sites page (block hidden in the builder
   picker too); `/reserve` falls back to the CMS-page-or-404 gate
   (`GET /resources/sites/reservations?slug=acme` reflects `online: false`);
   `POST /reservations/holds` -> 404 `not_found`/`feature_off`. Meanwhile: the
   existing manage link still opens (`GET /reservations/manage` 200); kody's
   Today/Book work; and `curl -X POST .../api/reservations/tick` still
   enqueues/sends the due reminder for the future booking (a `reminder` email is
   captured).
2. `commands.set_org_flag acme reservations.enabled false`. Checkpoints: sidebar
   group gone; every `/acme/reservations*` route 404; public routes 404; manage
   link 404. Record the count of `rsv_reservations` in acme's tenant DB.
3. Re-enable both flags (`true`). Checkpoints: sidebar back, Today lists the
   same bookings (count unchanged in sqlite), the manage link works again,
   `/reserve` bookable. Pass: partial shutdown keeps guest self-service and
   operator tools alive; full shutdown hides everything without touching data;
   re-enable restores the exact prior state. Fail: any data loss, any operator
   tool breaking when only `online` is off, or manage links dying before the
   master flag does. Tool: terminal (flag script, sqlite), agent-browser (App +
   Sites), curl (tenant-api) Evidence: terminal(commands.set_org_flag sequence),
   network(POST /reservations/holds -> 404), email-capture(reminder),
   screenshot(sidebar-gone), sqlite(rsv_reservations count before/after
   identical) Milestone: guest-channels-and-crm Isolation: serial (flips acme
   master and online flags; must restore both to true)

### VAL-CROSS-014: RESERVATIONS_EMAIL_ENABLED=false drops guest emails with no backlog after re-enabling

Preconditions: all flags on; email capture active; run alone (restarts the US
node). Journey:

1. Restart `tenant-api-us` with `RESERVATIONS_EMAIL_ENABLED=false` (as in
   VAL-CROSS-010).
2. Book a reservation on Sites for `rsv-x2@example.com`. Checkpoints: booking
   succeeds (201, confirmation code shown); no new file for that recipient in
   `.dev-mail/us/`; the tenant DB `rsv_messages` row for the confirmation is
   `dropped` (or absent per implementation), not `pending`.
3. Restart the node normally. Wait two tick intervals (or POST the tick).
   Checkpoints: still no confirmation email for `rsv-x2@example.com` (nothing
   held over); then book a second reservation for the same address: its
   confirmation email IS captured.
4. SMS unaffected check (US, opt-in on): the `[SMS MOCK]` confirmation line for
   the second booking appears in `tenant-api-us.log` in both phases (SMS switch
   is independent). Pass: messages are dropped while off, none are replayed
   after re-enabling, and normal delivery resumes for new events. Fail: any
   backlog delivery, or bookings failing while email is off. Tool: terminal
   (restart, ls .dev-mail, grep sms log), agent-browser (Sites), sqlite
   (rsv_messages status) Evidence: terminal(node restart with env),
   email-capture(absence then presence), sms-log, sqlite(rsv_messages
   dropped/not pending) Milestone: guest-channels-and-crm Isolation: serial
   (restarts the US tenant-api node with an env override)

### VAL-CROSS-015: Arabic across operator, guest site and email, with mirrored chrome but unmirrored geometry and numbers

Preconditions: all flags on for `riyadh-grill` (org id
`ru0dm42cud9scs4g2duep21c`, KSA node 3009); `commands.seed_reservations_ksa`
run; email capture active on the KSA node (`.dev-mail/ksa/`). Journey:

1. Operator: as kody open
   `http://localhost:3001/riyadh-grill/reservations?lng=ar`: the interface is
   right-to-left (sidebar, tabs, buttons mirrored). Open the floor plan editor
   and the live floor: table geometry (positions, sizes) is identical to the
   `?lng=en` rendering; times and numbers are not mirrored.
2. Guest: with the resolver-rule session open
   `http://riyadh-grill.menuza.test:3008/ar/reserve`: the booking flow is RTL
   and in Arabic. Complete a booking for party 2 (email
   `rsv-ar-<validator>@example.com`, phone `+966500000<nn>`). Times on the chips
   are in the restaurant's local time, numerals not direction-reversed.
3. Email: the newest `.dev-mail/ksa/` capture for that address has an Arabic
   subject and `dir="rtl"` in the HTML, org branding colors, and a manage link
   containing `/ar/reserve/manage#t=`.
4. No SMS: `grep` of `tenant-api-ksa.log` for the guest phone finds no
   `[SMS MOCK]` reservation line (KSA is email-only).
5. Cross-check in the operator UI: kody (Arabic session) sees the booking in
   Today with the guest's Arabic-or-Latin name rendered correctly. Pass: all
   surfaces mirror layout but never geometry, times or numbers; the Arabic email
   renders RTL with working links; no SMS attempted on the KSA node. Fail:
   unmirrored Arabic UI, mirrored floor geometry, English-only email, or any KSA
   reservation SMS. Tool: agent-browser (App + Sites with resolver rule),
   terminal (email capture, log grep) Evidence: screenshot(app-ar-rtl),
   screenshot(floor-ar-geometry), screenshot(sites-ar-reserve), email-capture(ar
   confirmation with dir=rtl), terminal(grep SMS absence) Milestone:
   guest-channels-and-crm

### VAL-CROSS-016: Remote waitlist join triggers manager alert, ready notification, status page and seating from the floor

Preconditions: acme flags `enabled`, `online`, `waitlist` on; location
`waitlist_enabled` and `waitlist_online` on (Settings, Waitlist); email capture
active. Journey:

1. Guest: on `http://acme.menuza.test:3008/reserve` for tonight (or the waitlist
   entry point), choose "Join waitlist" for party 3 with email
   `rsv-wl-<validator>@example.com`. Response returns a status token; the status
   page `/reserve/waitlist#t=<token>` shows position 1 and a quoted wait. A
   `waitlist_joined` message (email, and SMS if opted in) is captured/logged.
2. Manager alert: kody's notifications gain a `waitlist_remote_join` entry
   (count/location only). In the App Waitlist screen the entry appears.
3. Operator: kody clicks "Notify" on the entry. Checkpoints: a `waitlist_ready`
   email is captured with the response deadline; the guest status page now shows
   "Your table is ready" with an "On my way" action; the guest clicks it (status
   -> `on_the_way`).
4. Seating across surfaces: kody drags the waitlist card from the waitlist panel
   onto a free table on the Floor screen. Checkpoints: a walk-in reservation is
   created and seated; Today shows it under Seated; the waitlist entry shows
   `seated`; the guest status page shows the seated state.
5. Deadline branch (second entry): add another remote entry, notify it, then
   POST the tick after `waitlist_response_min` (or set the location's response
   minutes low first): the entry becomes `no_response` and loses its place.
   Pass: the full remote-join to seated loop works across Sites, notifications,
   App waitlist and floor plan; the deadline branch flips to `no_response`.
   Fail: any step where a surface disagrees with another (status page vs
   operator queue), missing messages, or a seated party missing from Today.
   Tool: agent-browser (Sites + App), terminal (email capture, tick curl)
   Evidence: email-capture(waitlist_joined), email-capture(waitlist_ready),
   screenshot(status-page-ready), screenshot(floor-drag-seat), network(POST
   /reservations/waitlist/join -> 2xx), sqlite(rsv_waitlist_entries statuses)
   Milestone: guest-channels-and-crm

### VAL-CROSS-017: Notify-me fires when another booking is cancelled, and the guest books the freed slot

Preconditions: acme flags `enabled`, `online`, `waitlist` on;
`notify_me_enabled` on for the location; a fully booked window tomorrow (create
phone bookings as kody until the target slot has no availability); email capture
active. Journey:

1. Guest on Sites `/reserve`: party 2 tomorrow shows no slots for the target
   time; the "Notify me" option appears. Submit with
   `rsv-nm-<validator>@example.com` for the 19:00-21:00 window. Response returns
   a cancel token. (`POST /reservations/notify-me` 2xx.)
2. Operator: kody cancels the existing booking covering 19:30 (restaurant
   cancel). Checkpoint: the day version bump marks availability increased.
3. Trigger matching: `curl -X POST http://localhost:3007/api/reservations/tick`
   (internal token). Checkpoints: a `notify_available` email is captured for the
   guest; the notify request row is `notified`; a second immediate tick does NOT
   resend it (dedupe/FIFO batch rules).
4. Guest follows the email's booking link and books 19:30 for party 2: success.
   The notify request ends `booked`; the new booking appears in the operator
   Book within one poll.
5. Cancel-by-token branch: a second notify-me request created in step 1 style
   can be cancelled through `POST /reservations/notify-me/cancel` with its token
   (200), after which the tick no longer notifies it. Pass: the freed slot
   reaches exactly the waiting guest by email and becomes bookable; no duplicate
   notifications; cancel token works. Fail: guest never notified, double
   notification, or the freed slot unbookable. Tool: agent-browser (Sites +
   App), curl (tenant-api), terminal (email capture) Evidence:
   email-capture(notify_available), network(POST /reservations/notify-me ->
   2xx), terminal(tick twice, second sends nothing), sqlite(rsv_notify_requests
   status transitions) Milestone: guest-channels-and-crm Isolation: serial
   (fills and changes tomorrow's availability for acme)

### VAL-CROSS-018: A waitlisted walk-in flows through seating into the waitlist report and the Guestbook

Preconditions: acme flags on incl. `waitlist`; kody admin; a staff member or
label for section assignment optional. Journey:

1. As kody on the Waitlist screen: add a walk-in party of 4, name "Crosswalk
   <validator>", phone validator-unique. The quote shown comes from the queue
   simulation (note the quoted minutes).
2. Notify the guest (SMS opt-in on): a `[SMS MOCK]` line appears in
   `tenant-api-us.log` with the ready text. Mark "on the way" from the operator
   side (or guest link).
3. Seat the party by dragging the waitlist card onto a table on the Floor
   screen; course through statuses to `finished` (seat, then finish from Today
   or the floor quick action). Note actual wait (join to seated).
4. Reports: open Reservations, Reports, run the waitlist report for today.
   Checkpoint: the entry appears with quoted vs actual wait; the run is audited
   (`sqlite3 ... "select action from rsv_audit_log where action='report.run' order by at desc limit 1"`).
5. Guestbook: open Guests, search the phone: the guest profile shows 1 visit and
   the party's covers counted; the reservation history lists the waitlist-seated
   visit with channel `waitlist`.
6. Cross-check aggregates: the summary report's source breakdown for today
   counts the party under walk-in/waitlist, and covers match the party size.
   Pass: one walk-in journey is visible consistently in the floor, reports
   (quoted vs actual) and the Guestbook counters. Fail: report missing the
   entry, counters off, or any surface showing contact data it should not
   (reports carry aggregates only). Tool: agent-browser (App), terminal (SMS
   log, sqlite) Evidence: sms-log, screenshot(waitlist-report-row),
   screenshot(guestbook-profile), sqlite(rsv_audit_log report.run),
   screenshot(summary-report) Milestone: guest-channels-and-crm

### VAL-CROSS-019: Signed-in Sites customer: prefilled booking, profile panel, and operator Guestbook link

Preconditions: acme flags on; customer `+15555550123` exists (seeded); guest OTP
sign-in works (code via `commands.read_sms_code` adjusted to the number).
Journey:

1. Guest signs in on `http://acme.menuza.test:3008/` (phone OTP; token in
   localStorage). Opens `/reserve`: the details step is prefilled with the
   customer's name/phone (network: `GET /reservations/mine` or config call with
   the customer JWT, 200).
2. Book for tomorrow party 2. Checkpoints: the booking's
   `rsv_reservations.customer_id` is set (sqlite on the acme tenant DB); no
   `customers` row was modified with guest data.
3. Profile page: the "Upcoming reservations" panel lists the new booking with
   time and party; clicking it opens the manage view.
4. Operator: kody opens Book, finds the booking (search by phone), opens the
   detail sheet: the guest summary shows the linked-customer indicator. Open the
   Guestbook profile from the sheet: visit history and stats render; the profile
   shows the same upcoming visit.
5. Privacy: the Sites SSR HTML of `/reserve` and the profile page (view source /
   curl with Host header) contains no guest name, phone or booking data;
   `/reservations/mine` is fetched by the browser only. Pass: prefill, panel,
   manage link and operator Guestbook all agree; the customer link is the opaque
   id only; no guest data in SSR HTML. Fail: any guest data in Sites HTML,
   booking not linked, or panel missing the booking. Tool: agent-browser
   (Sites + App), terminal (curl Sites HTML, sqlite) Evidence:
   screenshot(prefilled-details), screenshot(profile-panel), network(GET
   /reservations/mine -> 200), sqlite(rsv_reservations.customer_id set),
   terminal(grep SSR HTML for phone -> no match) Milestone:
   guest-channels-and-crm

### VAL-CROSS-020: Erasing a guest cancels future bookings, notifies, anonymizes, and leaves no cross-plane trace

Preconditions: acme flags on; a guest with one future and one past booking
(create both on Sites as `rsv-erase-<validator>@example.com`); kody admin; email
capture active. Journey:

1. Record the future booking's slot; confirm it occupies capacity (availability
   check).
2. Operator: Guests, open the profile, Erase (with the update-guest grant),
   confirm. Checkpoints:
   - A `cancellation_restaurant` email is captured for the guest (sent before
     contact details are cleared).
   - The future booking is `cancelled` (`cancelled_by = 'restaurant'` or
     `system` per implementation) and its slot is bookable again on Sites.
   - The Guestbook profile now shows the anonymized name ("Erased guest" or
     equivalent), no phone/email/notes/tags; visit history counts remain.
   - `rsv_reservation_events` rows for the guest's bookings are redacted (no
     contact values), not deleted.
   - `rsv_audit_log` has a `guest.erase` row (sqlite).
3. Privacy sweep for this guest: `grep -r` the guest's email/phone/name across
   local D1 (export via wrangler query of Notification/audit tables), `data.db`,
   `/tmp/menuza-logs/app.log` and `sites.log`: no matches outside the regional
   tenant DB and the dev email capture folder.
4. The erased manage link returns the uniform 404. Pass: all checkpoints;
   erasure is region-local, audited and total. Fail: any live future booking,
   any PII left in the Guestbook UI or control plane, or the manage link still
   working. Tool: agent-browser (App + Sites), terminal (email capture, grep,
   sqlite) Evidence: email-capture(cancellation_restaurant),
   screenshot(erased-profile), sqlite(rsv_audit_log guest.erase, events
   redacted), terminal(grep PII across control plane and logs -> none),
   network(GET /reservations/manage -> 404) Milestone: guest-channels-and-crm

### VAL-CROSS-021: bookings-today dashboard block reflects regional counts and respects flag and permission

Preconditions: acme flags on; seeded bookings today (create a same-day booking
as kody if the seed has none); a dashboard on the App home. Journey:

1. As kody, open the Home dashboard: add the "Bookings today" block (offered in
   the add-block dialog). The block shows counts by status, covers by service,
   the next arrivals (time, party size, first name) and the waitlist count.
   Network: the browser minted a `book` token and called
   `GET http://localhost:3007/operator/reservations/book/today` (200); the App
   server loader for the dashboard page made no tenant-api call (check the
   document response contains only `tokenUrl`, `tenantApiUrl`, `locations`).
2. Live update: seat one booking from Today; within the 60-second refresh (or on
   reload) the block's seated count increments.
3. As the Host-preset user from VAL-CROSS-002 (has `read:reservation:any`): the
   block renders for them too. As a member with no reservations grants (invite
   or reuse one): the block is absent from their dashboard and not offered in
   the add-block dialog.
4. `commands.set_org_flag acme reservations.enabled false`: the block
   disappears/hides without errors; re-enable restores it. Pass: counts come
   from the regional node browser-direct and match the Book; visibility follows
   flag + permission exactly. Fail: block data in the App loader, wrong counts,
   or visibility without the grant. Tool: agent-browser (App), curl (tenant-api)
   Evidence: network(GET /operator/reservations/book/today -> 200),
   screenshot(dashboard-block), screenshot(add-block-dialog-hidden),
   terminal(commands.set_org_flag) Milestone: guest-channels-and-crm Isolation:
   serial (flips acme master flag in step 4; restores it)

### VAL-CROSS-022: Mock Connect onboarding flips the payments capability that tenant-api reports

Preconditions: App running with payment mocks active (`MOCKS=true`);
`reservations.payments` on for acme; Admin not needed. Journey:

1. Baseline:
   `curl http://localhost:3001/resources/reservations/context?orgId=t58bgatqh3rv0s3movrecyj1`
   with the internal token: `payments.processor` is `null` or `deposit: false`
   (not onboarded).
2. In agent-browser as kody, open the mock onboarding entry (Settings, Shop
   instant-onboarding panel in mock mode, or the Connect onboarding page under
   `/mock-payments/*`): complete onboarding via the helper.
3. Re-fetch the context route (drop the tenant-api context cache first with
   `curl -X POST http://localhost:3007/internal/reservations/context-changed`,
   internal token): `payments.processor = 'connect'`, `deposit: true`,
   `guarantee: true`.
4. Downstream effect: in Reservations Settings, Policies, the deposit policy
   kind is now selectable (before onboarding it was refused/hidden); create a
   deposit policy and save (200).
5. Emulator state is control-plane and synthetic: `sqlite3` (or wrangler) query
   of the `__mock_pay_*` tables shows the account row with synthetic ids only
   (no real keys, no PII). Pass: onboarding through the mock pages changes the
   capability the App advertises to the regional node, unlocking deposit
   policies. Fail: context still reports no processor after onboarding, or
   policy save refused. Tool: agent-browser (App + mock pages), curl (App
   resource + tenant-api internal), terminal (sqlite) Evidence: network(GET
   /resources/reservations/context -> 200 before/after),
   screenshot(mock-onboarding), screenshot(policy-form-deposit-enabled),
   sqlite(__mock_pay_* synthetic rows) Milestone:
   payments-integrations-and-native

### VAL-CROSS-023: US deposit booking end to end: Sites, mock Stripe 3DS, badges and messages

Preconditions: acme flags on incl. `payments`; org onboarded (VAL-CROSS-022); a
deposit policy (e.g. $25/party) attached to the dinner service; email capture
active. Journey:

1. Guest books on `http://acme.menuza.test:3008/reserve` for tomorrow 19:00
   party 2. After details, the payment step appears (create response had
   `payment: { paymentToken, purpose, amountMinor: 2500, currency: 'USD', payUrl }`).
   The reservation is `pending_payment` (network:
   `GET /reservations/manage/payment`).
2. Continue to the hosted page: browser lands on
   `http://localhost:3001/mock-payments/...` Stripe Checkout. Pay with
   `4242 4242 4242 4242`; complete 3DS with the mock challenge. Return / status
   poll flips the reservation to `booked` (payment_status `paid`).
3. Messages: a `payment_received` email (and confirmation, if separate) is
   captured for the guest.
4. Operator: kody opens Today/Book: the reservation shows the deposit-paid
   badge; the detail sheet payment panel lists the succeeded `deposit` row
   ($25.00) with card brand/last4 display facts only.
5. Regional record: `sqlite3` on acme's tenant DB: `rsv_payments` row
   `kind='deposit'`, `status='succeeded'`, `platform_fee_minor` snapshot
   present, no card number anywhere (grep the row).
6. Expiry branch: book a second deposit reservation and abandon the hosted page;
   after `payment_hold_minutes` (or tick with clock advanced via the dev API),
   the reservation is `expired`, capacity freed (slot bookable again), and a
   `checkout_expire` outbox row was delivered to the App (mock session expired:
   check the event log page or dev API). Pass: money, state, badges and messages
   agree across guest, provider (emulator), operator and regional DB, in both
   the success and expiry branches. Fail: booking stuck in `pending_payment`
   after payment, missing badge/message, or capacity leaked after expiry. Tool:
   agent-browser (Sites + mock page + App), terminal (email capture, sqlite),
   curl (tick / dev API) Evidence: screenshot(mock-stripe-checkout), network(GET
   /reservations/manage/payment -> 200 transitions),
   email-capture(payment_received), screenshot(payment-badge),
   sqlite(rsv_payments row, no PAN), terminal(dev API session expire) Milestone:
   payments-integrations-and-native

### VAL-CROSS-024: KSA region end to end: Arabic guest, Checkout.com HPP deposit, email-only, zero US trace

Preconditions: `riyadh-grill` flags on incl. `payments`; seeded
(`commands.seed_reservations_ksa`); Checkout.com sub-entity onboarded via the
mock (KSA guards removed); a SAR deposit policy on the service; KSA email
capture active (`.dev-mail/ksa/`). Journey:

1. Guest (resolver-rule session) opens
   `http://riyadh-grill.menuza.test:3008/ar/reserve` and books party 2 tomorrow.
   Page HTML has `data-tenant-api-url="http://localhost:3009"`; every tenant-api
   call in the network log targets 3009.
2. Payment step redirects to the mock Checkout.com Hosted Payments Page; pay
   with the mock card and pass 3DS with password `Checkout1!`. Status poll (or
   status lookup) flips the reservation to `booked`, amount in SAR.
3. Messages: the confirmation/payment email is captured in `.dev-mail/ksa/` with
   Arabic RTL HTML. `grep` the KSA log: no `[SMS MOCK]` reservation lines.
4. Operator: kody (Arabic session) sees the booking in
   `/riyadh-grill/reservations` Today with the paid badge.
5. Residency: the US tenant DB directory (`packages/database/db/`, excluding
   `ksa/`) contains no file or table row for riyadh-grill reservations
   (`ls packages/database/db/tenant_ru0dm42cud9scs4g2duep21c.db` absent;
   riyadh-grill's DB lives under `db/ksa/`); `grep` the guest's phone/email/name
   in `/tmp/menuza-logs/tenant-api-us.log`, `app.log` and `sites.log`: no
   matches; the same grep in `tenant-api-ksa.log` shows only ids/codes in
   structured logs, not full PII. Pass: the whole flow runs on the KSA node in
   Arabic with Checkout.com, and no riyadh-grill guest data touches the US node,
   the US tenant DB directory, or any log. Fail: any 3007 call from the guest
   flow, any US-side trace, any KSA SMS. Tool: agent-browser (Sites + mock HPP +
   App), terminal (email capture, greps, ls), curl (3009 health/region)
   Evidence: screenshot(ar-hpp-3ds), network(all tenant-api calls -> :3009),
   email-capture(ar confirmation), terminal(grep US logs -> no PII; ls US tenant
   dir), sqlite(ksa tenant rsv_payments SAR row) Milestone:
   payments-integrations-and-native

### VAL-CROSS-025: Platform fee: Admin override reaches the charge and is reversed proportionally on a restaurant-cancel refund

Preconditions: acme onboarded, deposit policy ($100 party deposit to keep math
trivial), flags on. Start Admin; log in to the App as kody in the same session,
run `commands.copy_admin_session`, open `http://localhost:3005/`. Journey:

1. In Admin, open the Reservations platform fee control: set an organization
   override for acme of 1000 bp (10.00%). Save. Read back:
   `sqlite3 packages/database/db/data.db "select value from ConfigFlag where key='reservations.platform_fee_bp' and level='organization'"`.
2. Mirror into the App's D1 (local artifact):
   `commands.set_org_flag acme reservations.platform_fee_bp 1000`.
3. Guest books the deposit on Sites and pays through the mock Stripe page.
   Checkpoints: the emulator's Express dashboard ledger (or dev API objects)
   shows the $100 charge with a $10 application fee; the regional `rsv_payments`
   row has `platform_fee_bp=1000`, `platform_fee_minor=1000`.
4. Operator cancels the booking as restaurant-cancel. Checkpoints: a full refund
   executes through the outbox (tick or wait): `rsv_payments` refund row
   `amount_minor=10000` succeeded; the emulator ledger shows the refund with
   `reverse_transfer` and a $10 fee reversal (proportional, here total); a
   `refund_issued` email is captured; the guest manage view shows refunded.
5. Partial branch: on a second paid booking, kody requests a
   $40 partial
   refund from the payment panel: the emulator shows a $4 fee
   reversal (`round(1000 * 4000/10000)`), and the refund row matches.
6. Reset the override afterwards:
   `commands.set_org_flag acme reservations.platform_fee_bp delete` and remove
   the Admin override (or set it back to none) so other validators see the 0
   default. Pass: fee applied at charge time from the Admin-configured value and
   reversed proportionally on both full and partial refunds, with matching
   snapshots regionally. Fail: wrong fee math, refund without fee reversal, or
   the App charging before the D1 mirror (proves it read the wrong store). Tool:
   agent-browser (Admin + Sites + App + mock pages), terminal (sqlite data.db,
   flag script, email capture) Evidence: screenshot(admin-fee-control),
   sqlite(data.db ConfigFlag 1000), terminal(commands.set_org_flag 1000),
   screenshot(mock-ledger-fee), sqlite(rsv_payments fee snapshot + refund rows),
   email-capture(refund_issued) Milestone: payments-integrations-and-native
   Isolation: serial (Admin running; changes acme platform-fee flag in D1 and
   data.db; must reset to default afterwards)

### VAL-CROSS-026: Region switch is refused while any reservation payment is unsettled

Preconditions: acme flags on, onboarded, deposit policy; run alone after
VAL-CROSS-025 reset. Journey:

1. Guest starts a deposit booking on Sites and abandons the hosted page, so the
   reservation sits `pending_payment` (unsettled).
2. As kody, open the region-switch dialog: the reservation counts now include 1
   unsettled payment. Type the correct slug and confirm. Checkpoint: the action
   returns 409 `payments_unsettled` and NO wipe occurs (sqlite:
   `rsv_reservations` still present; the pending booking still in the operator
   Book).
3. Let the payment expire (tick / dev clock advance): the reservation becomes
   `expired`. Re-open the dialog: the unsettled count is 0, the
   typed-confirmation path is offered again (do not complete the switch).
4. Cross-check the server path directly:
   `curl -X POST http://localhost:3007/internal/reservations/summary` reports
   `unsettledPayments: 0` after expiry. Pass: the guard hard-blocks with 409
   while anything is unsettled and releases after expiry; typed confirmation
   cannot override. Fail: switch proceeding with an unsettled payment, or the
   guard staying stuck after expiry. Tool: agent-browser (Sites + App), curl
   (tenant-api internal), terminal (sqlite, tick) Evidence:
   screenshot(region-dialog-unsettled), network(region action -> 409
   payments_unsettled), sqlite(rsv_reservations intact), terminal(curl summary
   before/after) Milestone: payments-integrations-and-native Isolation: serial
   (exercises the shared region-change action; no switch completed)

### VAL-CROSS-027: Experience published in App is bookable on Sites with prepayment and reshapes regular availability

Preconditions: acme flags on incl. `experiences` and `payments`; onboarded; a
prepay policy. Journey:

1. As kody: Reservations, Experiences, New: "Chef's Counter <validator>",
   ticketed, $75 per cover, party 2-4, schedule Saturday 19:00 seating,
   `exclusive` on, area = the main area, covers cap 8. Publish.
2. Sites: `http://acme.menuza.test:3008/experiences` lists it (SSR, public data
   only); the detail page shows name, description, price. Booking from the
   experience page for next Saturday 19:00 party 2 goes through the same payment
   hand-off (mock Stripe) and confirms. A confirmation email is captured.
3. Operator: the booking appears in Book with the experience label; the detail
   sheet shows the prepayment badge; capacity counts against the experience
   seating (the calendar/overview shows the experience).
4. Exclusivity: regular `/reserve` availability for that Saturday 19:00 in the
   main area no longer offers the exclusive window (party 2 regular booking gets
   alternatives outside the window), while a non-exclusive adjacent time still
   books.
5. Caps: book the experience repeatedly (or set cap 2) until the seating cap is
   hit: the experience page then shows the seating as sold out while regular
   availability is unaffected. Pass: publish -> discovery -> prepaid booking ->
   operator labeling -> exclusive window and caps all consistent. Fail:
   unpublished experience visible, exclusive window bookable as a regular slot,
   or cap not enforced. Tool: agent-browser (App + Sites + mock page), terminal
   (email capture) Evidence: screenshot(experience-setup),
   screenshot(sites-experiences-list), network(POST /reservations -> 201 with
   experience), screenshot(book-experience-label), email-capture(confirmation),
   screenshot(exclusive-window-unavailable) Milestone:
   payments-integrations-and-native

### VAL-CROSS-028: Impersonation is read-only and carries no sensitive grants into tenant-api

Preconditions: acme flags on; seeded data; the Host-preset user from
VAL-CROSS-002 exists. Start Admin; `commands.copy_admin_session`. Journey:

1. In Admin, impersonate the host user; open the App in the same session. The
   App shows the impersonation banner.
2. Open Reservations Today: bookings render (read works). Attempt a write:
   create a phone booking / change a status: the action is refused (403 or
   disabled with the read-only notice).
3. Token checks from the page: `/acme/reservations/token?scope=book` returns a
   token with `impersonated: true`; `?scope=guests` and `?scope=payments` are
   refused (no sensitive grants under impersonation, even for roles that would
   otherwise hold them — also impersonate kody/admin and confirm the
   guests/payments mint is still refused).
4. With the impersonated `book` token:
   `curl -X POST http://localhost:3007/operator/reservations/book/walk-ins ...`
   -> 403 (tenant-api enforces impersonation write refusal independently);
   `GET .../book/day` -> 200.
5. Stop impersonation in Admin; confirm a booking write succeeds again as kody.
   Pass: impersonated sessions read everything their grants allow and write
   nothing, on both planes, and never receive sensitive-grant tokens. Fail: any
   successful write or sensitive token under impersonation. Tool: agent-browser
   (Admin + App), curl (tenant-api) Evidence: screenshot(impersonation-banner),
   network(POST write -> 403), network(token?scope=guests -> 403), terminal(curl
   walk-ins -> 403), console-errors Milestone: payments-integrations-and-native
   Isolation: serial (Admin session and impersonation state)

### VAL-CROSS-029: Residency sweep after a full day of activity

Preconditions: the other payment/messages/guestbook flows for acme have run
(bookings, a deposit payment, messages sent, a waitlist entry, a manager alert,
a journey emission if integrations has landed). Read-only: safe to run in
parallel with other read-only checks. Journey (each step is a checkpoint):

1. Control-plane D1: dump and grep for known guest identifiers used in this run
   (emails `rsv-*@example.com`, phones `+1555555*`): query `Notification`,
   `ConfigFlag`, `__mock_pay_object`, `__mock_pay_event`, `__dev_email_capture`
   (App-side records carry `meta` ids only) — expect no guest
   names/phones/emails. Command:
   `npx wrangler d1 execute DB --local --json --command "select ..."` per table,
   grep output.
2. LibSQL `data.db`: same greps (it holds Admin data only).
3. Logs:
   `grep -E 'rsv-|\+1555555' /tmp/menuza-logs/app.log /tmp/menuza-logs/sites.log`
   -> no matches; tenant-api logs may contain `[SMS MOCK]` destinations by
   design but structured reservation logs carry ids and codes only (spot-check
   20 reservation log lines).
4. Sites SSR:
   `curl -H 'Host: acme.menuza.test:3008' http://localhost:3008/reserve` and
   `/reserve/manage`: HTML contains no guest data (no names/phones; the manage
   page is an empty shell until the browser supplies the fragment token — the
   fragment is never sent to the server).
5. App loader data: fetch `/acme/reservations/book.data` (browser session): the
   JSON contains ids, flags, location facts and `can` booleans only — no guest
   fields.
6. Cross-plane payloads: replay `GET /resources/reservations/context?orgId=...`
   and inspect the recorded `POST /resources/reservations/notify` body (App log
   or re-run): keys are `{ orgId, eventId, kind, locationId, count }` — ids and
   counts only. Pass: no guest PII in any control-plane table, log, SSR HTML,
   loader payload, or cross-plane body. Fail: any occurrence. Tool: terminal
   (wrangler/sqlite/grep/curl), agent-browser (loader fetch) Evidence:
   terminal(grep results empty), sqlite(D1/data.db table scans), network(GET
   /acme/reservations/book.data -> key-set check), terminal(curl Sites HTML, no
   PII) Milestone: payments-integrations-and-native

### VAL-CROSS-030: Phone-agent hold texts a link the guest completes on Sites; operator sees the voice source

Preconditions: acme flags on incl. `voice`; US node; `voice_mode = 'hold_link'`
(default); email capture and SMS log available. The voice action route is
`POST http://localhost:3007/api/voice/actions/<name>` with
`Authorization: Bearer $VOICE_AGENT_TOKEN`. Journey:

1. Dry run: `POST /api/voice/actions/reservations.availability` with
   `{ orgId, callId: 'call-x-<v>', channel: 'web_test', input: { date: <tomorrow>, partySize: 2 } }`
   -> 200 with up to 3 slots and `simulated: true`; no hold written (sqlite: no
   new `rsv_holds`).
2. Real action: same route, `channel: 'phone'` (or the non-dry channel per
   implementation) -> slots. Then `POST /api/voice/actions/reservations.hold`
   with the chosen slot and `{ partySize: 2, firstName: 'Voice<validator>' }` ->
   hold created with `source='voice_agent'`, `voice_call_id` set, expiry
   `voice_hold_minutes`.
3. The tool layer texts the link: a `[SMS MOCK]` line in `tenant-api-us.log`
   contains `/reserve#h=<holdToken>` (via `sendLink`).
4. Guest: open `http://acme.menuza.test:3008/reserve#h=<holdToken>`: the flow
   resumes at the details step with the held slot and countdown
   (`GET /reservations/holds/current` 200). Complete the booking (guest contact
   details). Success.
5. Operator: kody finds the booking in Book/Today: channel shown as phone agent;
   `sqlite3`: `rsv_reservations.channel='voice_agent'` (or
   `created_by_kind='voice_agent'`), `voice_call_id` matches, and the hold row
   is `converted` (single conversion).
6. Replay protection: reusing the same hold token to book again -> 409/404.
   Pass: the voice hold crosses into the guest web flow exactly once and lands
   in the operator book with its source. Fail: dry run writes state, link
   resumes nothing, hold converts twice, or source missing. Tool: curl
   (tenant-api voice + public), agent-browser (Sites + App), terminal (SMS log,
   sqlite) Evidence: terminal(curl availability dry-run simulated), sms-log(link
   with #h=), network(GET /reservations/holds/current -> 200),
   screenshot(book-voice-channel), sqlite(hold converted once, reservation
   channel) Milestone: payments-integrations-and-native

### VAL-CROSS-031: Bookings feed the staffing forecast strip as booked covers, counts only

Preconditions: acme flags on; staffing enabled for acme
(`commands.seed_staffing_acme` if staffing data is absent); reservations for
tomorrow exist (seed or create two bookings, parties 2 and 4). Journey:

1. As kody, open Staff, Schedule for tomorrow: the forecast strip shows booked
   covers for the reservation hours (e.g. "6 covers booked" across the
   19:00-20:00 slots), in addition to any order demand.
2. Add one more operator booking of party 2 at 19:30 (Today, phone booking).
   Reload the schedule: booked covers for that hour increase by 2.
3. Cancel that booking: after reload the count drops back.
4. Counts-only contract:
   `curl 'http://localhost:3007/operator/schedule/demand?...'` (staffing token
   or the documented call) and inspect the response: per-slot `bookedBySource`
   entries for the `visits` source carry unit counts only — grep the payload for
   guest names/phones: none.
5. Regression:
   `cd apps/tenant-api && CI=true npx vitest run src/services/forecast-gap.test.ts`
   (and the staffing vocabulary test `packages/staffing` vocabulary test) pass.
   Pass: the strip tracks booking changes as bare counts and the staffing
   suite/vocabulary stay green. Fail: stale counts after a booking change, any
   guest field in the demand payload, or red staffing tests. Tool: agent-browser
   (App), curl (tenant-api), terminal (vitest) Evidence:
   screenshot(forecast-strip-covers), network(demand -> bookedBySource counts
   only), terminal(vitest forecast-gap + vocabulary green) Milestone:
   payments-integrations-and-native

### VAL-CROSS-032: Journey triggers fire once for consenting guests and never for non-consenting guests

Preconditions: acme flags on; an active journey in the App automation editor
using the `reservation_booked` trigger (create it as kody: Marketing,
Automations, New — the reservation triggers are offered because the flag is on;
with the flag off they must be absent from the trigger list). Journey:

1. Guest A (`rsv-j1-<v>@example.com`) books on Sites WITH the marketing email
   opt-in checked. Checkpoints: `rsv_journey_emissions` gains a
   `(reservation_id, 'reservation_booked')` row; a `journey_runs` row exists for
   the journey and the (unverified) marketing customer; context data is
   ids/counts only (`reservationId`, `locationId`, `partySize`, ... — grep the
   row for the guest name: absent).
2. Modify guest A's booking (time change). Checkpoint: no second emission for
   `reservation_booked` (the PK dedupes); at most one journey run.
3. Guest B books WITHOUT consent and without sign-in. Checkpoints: no
   `rsv_journey_emissions` row, no journey run; the Guestbook still counts the
   visit after it completes.
4. Step consent: a journey with an SMS step for a guest whose subscription
   covers email only records that step as `skipped` (journey_runs step record),
   not sent.
5. Operator cancel on guest A's booking fires `reservation_cancelled` once
   (emission row), again deduped on any repeat transition. Pass: consenting
   guests trigger each journey exactly once per booking and trigger with
   ids-only context; non-consenting guests trigger nothing. Fail: duplicate
   runs, any run without consent/verification, or PII in the trigger context.
   Tool: agent-browser (Sites + App), terminal (sqlite on acme tenant DB)
   Evidence: sqlite(rsv_journey_emissions rows, dedupe), sqlite(journey_runs
   counts + skipped step), screenshot(automation-trigger-list), terminal(grep
   context for name -> absent) Milestone: payments-integrations-and-native
   Isolation: serial (creates an automation journey in acme)

### VAL-CROSS-033: Native-shaped calls: customer token replaces Turnstile, X-Client is recorded, fixtures match the live API

Preconditions: acme flags on; customer `+15555550123` sign-in; contract fixtures
recorded (`packages/reservations/contract-fixtures/*.json` and the native
copies). Journey:

1. Obtain a customer access token (OTP sign-in on Sites; read
   `tenant_access_token` from localStorage via agent-browser eval).
2. With curl, replay the native flow against 3007 with
   `Origin: http://acme.menuza.test:3008`, `X-Client: ios` and the Bearer
   customer token — and NO Turnstile token: `POST /reservations/holds` -> 201
   (verified customer substitutes for Turnstile); `POST /reservations` with an
   `Idempotency-Key` -> 201, response carries `manageToken`, `expiresAt` and
   server `now`. Every mutation used POST (no PATCH). sqlite: the reservation's
   `channel = 'native'`, `client = 'ios'`.
3. The same `POST /reservations` replayed with the same idempotency key and body
   returns the original reservation and a re-derived manage token (no duplicate
   row); with a different body -> 409 `idempotency_conflict`.
4. Operator: the booking appears in Book with the native channel attribution.
5. Contract check:
   `cd apps/tenant-api && CI=true npx vitest run src/routes/reservations-contract.test.ts`
   passes: the canonical fixtures parse against the public schemas and the
   iOS/Android copies are byte-identical. Spot-check one fixture against the
   live API: `GET /reservations/config` response keys match the fixture's key
   set.
6. Unauthenticated branch: the same hold request without the customer token and
   without Turnstile (Turnstile unconfigured locally) still works only per the
   documented local policy; with an invalid/cross-org customer token the request
   is rejected (401/404), never silently downgraded. Pass: the exact request
   shape the native apps will send works against the live public API, is
   attributed as native, is idempotent, and matches the recorded contract. Fail:
   any PATCH requirement, missing `expiresAt`/`now`, duplicate booking on
   replay, or fixture drift. Tool: curl (tenant-api), agent-browser (Sites for
   OTP + eval), terminal (vitest, sqlite) Evidence: network(POST
   /reservations/holds -> 201 with X-Client ios), terminal(replay same key ->
   same id; different body -> 409), sqlite(channel native, client ios),
   terminal(vitest contract test green) Milestone:
   payments-integrations-and-native

---
