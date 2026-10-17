# Reservations module: architecture draft

Status: draft for the mission's authoritative architecture document. Repository:
`/home/factory-user/repos/menuza` at `5f61fd1c`. Paths are relative to the repo
root unless absolute. Inputs: `AGENTS.md`, the research notes in
`/home/factory-user/reservations-planning/research/` and the codebase notes in
`/home/factory-user/reservations-planning/codebase/`. Payments provider details
and native app UI are owned by parallel deep-dives and appear here only as
responsibilities, flows and API contracts (marked `TODO(payments)` and
`TODO(native)`).

Repo facts verified for this draft (so workers do not re-check them):

- Tenant table names in use include `restaurant_orders`,
  `restaurant_order_reservations`, `shifts`, `shift_templates`,
  `notification_outbox`, `customers`, `marketing_journeys`. No `rsv_*` table, no
  `waitlist*` table, and no `reservations.*` flag key exist yet.
- Latest migrations: control plane
  `packages/database/drizzle/0024_dashboards.sql`; tenant
  `packages/tenant-db/drizzle/0015_hiring_interested_scopes.sql`. Last ADR is
  `docs/decisions/047-staffing-data-residency.md` (048 is free).
- Location ids are cuid2 strings (`OrganizationLocation.id` uses `createId()`).
  Member location scoping already exists generically in the control plane:
  `UserOrganization.locationScope` (`all|selected`) + `UserOrganizationLocation`
  (migration `0023`), turned into a token claim by
  `packages/staffing-restaurant/src/location-scope.ts` `locationIdsClaim`.
- `runExclusive` lives in `apps/tenant-api/src/lib/concurrency.ts`
  (`order-service.ts` has its own copy at line 80; use the `lib` one).
  `retryOnSqliteBusy` is `apps/tenant-api/src/lib/sqlite-retry.ts`.
- The Durable Object alarm is owned by staffing: `workers/tenant-org.ts`
  `maybeArmStaffAlarm` + `alarm()` -> `handleStaffAlarm` ->
  `runStaffTickForOrg`, with arming rules in `src/lib/staff-alarm.ts`
  (`isStaffActivityPath`, `armStaffAlarm` never moves an existing alarm, 5 min
  interval, 6 failures).
- The staffing demand seam is single-slot and order-shaped:
  `apps/tenant-api/src/services/order-source.ts` `registerOrderSource`, used by
  `forecast-service.ts`, `labor-data.ts`, and
  `restaurant/staffing-report-catalog.ts`.
- `workers/org-router.ts` `orgIdFromOperatorJwt` accepts audiences
  `tenant-api-operator` and `STAFFING_TOKEN_AUDIENCE`; public prefixes such as
  `/careers/` are routed from `Origin` before the generic `?orgId=` fallback.
- Native apps send the tenant site origin as the `Origin` header
  (`apps/ios/Sources/TenantKit/Networking/TenantAPIClient.swift:146-158`), so
  origin-bound public routes work for them.
- `VerticalServices` in `packages/phone-agent/src/vertical.ts` exposes only
  `sendLink`.
- Journey trigger types are a TypeScript enum on
  `marketing_journeys.trigger_type`
  (`phone_verified | profile_completed | custom_event | manual`), no SQL CHECK.
- Dashboard built-in blocks: `apps/app/app/utils/dashboards/config.ts`
  `BUILT_IN_BLOCK_TYPES`. Website blocks:
  `apps/app/app/utils/website/block-types.ts`.
- `fast-check` is installed (declared in `apps/app/package.json`).
  `libphonenumber-js` is not; `apps/tenant-api/src/routes/auth.ts:95` has a
  local `normalizePhone`.
- `@repo/staffing` depends only on `zod`; `@repo/common` depends on
  `@repo/database` and others (subpath imports keep bundles small).

---

## 1. Overview and design principles

The module gives a restaurant organization an OpenTable-class reservation
system: per-location floor plans and availability rules, an availability engine,
guest booking on the published website (and native apps), an operator
reservation book and live host stand, guest messaging, waitlist, Guestbook CRM,
server sections, large-party requests, reports, deposits and card guarantees,
Experiences, and integrations (phone agent, staffing forecast, journeys).

It is built "like staffing": org-level flags default off, role permissions,
every byte of guest data in the regional per-org SQLite behind
`apps/tenant-api`, browser-direct calls with short-lived App-minted operator
tokens, public guest routes called from the visitor's browser with the
organization resolved from `Origin`, and CI gates that sweep every route.

### 1.1 Principles

1. **Residency first.** Guest names, phones, emails, notes, allergies, tags,
   visit history, waitlist entries and anything tied to a person live only in
   the regional tenant DB. The App, Sites SSR, D1, KV, chat, dashboards' server
   loaders and cross-plane payloads carry ids, counts, money amounts and
   non-personal configuration only.
2. **Regional is authoritative for bookings and their rules.** Availability
   settings, floor plans, policies and reservations are in one database so a
   booking and the rules it was checked against commit in one transaction.
3. **Restaurant vocabulary is allowed in this module** (tables, covers, floor
   plan, turn time, server section). It stays out of `@repo/staffing`,
   `@repo/phone-agent` and their vocabulary tests. Dining periods are called
   **services** (never "shifts").
4. **Pure domain core.** All rules, availability, assignment, state machine,
   policy math and time math live in `@repo/reservations` with an injected clock
   and no I/O, so they are property-tested and shared by tenant-api, App, Sites
   and (by contract) native.
5. **Search is a hint; the write path decides.** Every capacity change
   re-validates inside one serialized transaction.
6. **Fail closed.** Unknown org, wrong region, unprovisioned DB, missing or
   stale flags (for public writes), unreachable App context for public writes:
   refuse with uniform responses that do not reveal existence.
7. **Explicit over implicit.** Combinations are explicit table sets; overbooks
   are explicit and audited; editors (floor plan) are drafts with an explicit
   Save; rule edits never silently rewrite existing bookings.

### 1.2 Invariants (tested; see section 14)

- **I1 (seating).** Every reservation in a capacity-consuming status has either
  (a) active occupancy rows on concrete tables (a single table or every member
  of one combination) covering `[start_at, end_at)`, or (b) `overbooked = 1` (an
  explicit, audited staff overbook, possibly unassigned), or (c) it belongs to a
  table-less Experience seating whose cover cap is enforced.
- **I2 (no double booking).** No two active, non-overbook occupancies on the
  same table overlap (half-open intervals). Enforced by the engine and by a
  database trigger as a safety net.
- **I3 (online never borrows).** Guest-channel availability is never computed
  from capacity created by a staff override: overbook rows count as occupying
  their tables, and an unplaceable overbook closes online availability for the
  windows and units it could use.
- **I4 (holds count).** A live hold consumes capacity exactly like a booking; an
  expired hold consumes nothing, whether or not it has been swept.
- **I5 (locked never moves).** No automatic process (repair, reflow,
  re-optimization) moves a `locked` assignment or any reservation that has
  arrived, is seated, or is inside the freeze window.
- **I6 (atomic modify).** A failed modification leaves the reservation and its
  occupancies unchanged.
- **I7 (search/book agreement).** Any slot returned by a search can be held
  immediately against the same state and clock.
- **I8 (monotonic release).** Cancelling, finishing or shrinking a reservation
  never removes availability.
- **I9 (append-only history).** Reservation events and the module audit log are
  append-only (redaction on erasure is the only permitted update).
- **I10 (idempotent effects).** Replayed creates return the original result;
  each message, payment and outbound event is sent at most once per dedupe key.
- **I11 (time intent).** `business_date + local_start_min + time_zone` is the
  source of truth; `start_at`/`end_at` are derived and re-derivable.

---

## 2. Components and responsibilities

```
packages/
  zoned-time/                     NEW @repo/zoned-time (no deps). tz.ts moved out of
                                  @repo/staffing; staffing re-exports it unchanged
  reservations/                   NEW @repo/reservations (deps: zod, @repo/zoned-time)
    src/flags.ts                  RESERVATIONS_FLAG_KEYS, isFlagOn re-export semantics
    src/permissions.ts            RESERVATIONS_PERMISSIONS, sensitive grants, TTLs,
                                  restrictGrantsForImpersonation, grantsSatisfying
    src/token.ts                  audience/typ, RESERVATIONS_SCOPES, SCOPE_GRANTS,
                                  reservationsTokenClaimsSchema
    src/time.ts                   localToInstant (gap/overlap modes), instantToLocal,
                                  currentBusinessDate, businessDateOf, localMinOf
    src/phone.ts                  normalizeGuestPhone (shared with tenant-api auth)
    src/config/                   Zod schemas for settings, areas, tables, combos,
                                  floor elements, services, turn times, pacing,
                                  special days, blocks, policies, sections,
                                  messages, experiences + validateConfig()
    src/rules/resolve-services.ts special-day precedence -> ResolvedService[]
    src/engine/occupancy.ts       per-table interval index / 5-min bitset
    src/engine/day-state.ts       buildDayState(rows) (pure, from loaded rows)
    src/engine/availability.ts    searchAvailability, calendarSummary, alternatives
    src/engine/pacing.ts          pacing + online caps + concurrent covers
    src/engine/assign.ts          score, bestFit, tryRepair (bounded), reflow
    src/engine/experiences.ts     experience seatings and cover caps
    src/waitlist/quote.ts         quoteWait (queue simulation)
    src/state-machine.ts          statuses, transitions, actors, consumesCapacity,
                                  quickActionsFor
    src/policy.ts                 policy selection, snapshot, cancellation terms, fees
    src/messages.ts               message kinds, schedule (reminders, quiet hours),
                                  dedupe keys, region/channel rules
    src/schemas/                  API request/response schemas: operator, public,
                                  internal, voice, payments, reports, native
    src/errors.ts                 stable error codes (no UI strings)
    src/testing/                  fast-check arbitraries, brute-force oracle (test-only)

packages/tenant-db/
  src/schema.ts                   new section "12. RESERVATIONS" (rsv_* tables)
  drizzle/0016_reservations_foundation.sql   generated + hand-appended triggers
  src/reservations-schema.test.ts schema/trigger tests

apps/tenant-api/src/
  lib/reservations-auth.ts        verify rsv+jwt (audience, typ, lifetime cap, scope,
                                  region, active+provisioned org, locationIds)
  lib/reservations-guard.ts       rsvGuard(scope, label, {all, write}, handler)
  lib/http.ts                     shared NO_STORE/json/validationResponse/readJsonBody
                                  (moved from staff-http.ts; staff-http re-exports)
  lib/reservations-context.ts     cached App context (facts + flags) for the node
  lib/reservations-write.ts       withReservationWrite gate (lock + tx + sweep)
  lib/reservations-tokens.ts      hold / manage / waitlist-status / payment tokens
  lib/reservations-email.ts       EN/AR plain-HTML templates in org branding
  lib/reservations-sms.ts         region-aware SMS sender (US only) + kill switch
  lib/reservations-switches.ts    RESERVATIONS_* kill switches read live
  lib/org-alarm.ts                NEW generic per-org alarm scheduler (modules)
  lib/phone.ts                    re-export normalizeGuestPhone for auth.ts
  routes/reservations-book.ts     /operator/reservations/book/*
  routes/reservations-waitlist.ts /operator/reservations/book/waitlist/* (sub-router)
  routes/reservations-guests.ts   /operator/reservations/guests/*
  routes/reservations-setup.ts    /operator/reservations/setup/*
  routes/reservations-reports.ts  /operator/reservations/reports/*
  routes/reservations-payments.ts /operator/reservations/payments/*
  routes/reservations-public.ts   /reservations/* (guest booking, manage, mine,
                                  waitlist join/status, notify-me, experiences)
  routes/reservations-internal.ts /internal/reservations/*
  routes/reservations-system.ts   /api/reservations/tick, /api/reservations/payments/*
  routes/voice-actions.ts         /api/voice/actions/:name (generic registry)
  services/rsv-*-service.ts       one per area (settings, floor, services-rules,
                                  availability, booking, status, assignment,
                                  walk-in, waitlist, notify-me, guests, messages,
                                  payments, experiences, reports, export-erase,
                                  audit, tick)
  restaurant/reservations-demand-source.ts  booked covers -> staffing forecast
  restaurant/reservations-voice.ts          registers voice actions
  restaurant/reservations-journeys.ts       journey trigger emission
apps/tenant-api/workers/          org-router branches, alarm generalization
apps/tenant-api/scripts/seed-reservations.ts  local demo data (--enable)

apps/app/app/
  routes/_app+/$orgSlug_+/reservations+/    operator screens (section 10)
  routes/resources+/reservations.*.ts       context, notify, region-summary,
                                            location-summary, payments execution
  routes/resources+/sites.reservations.ts   Sites gate payload
  routes/resources+/sites.reservation.checkout.ts / .status.ts   payments
  components/reservations/**                host stand, book, timeline, floor,
                                            floor editor, waitlist, guests,
                                            experiences, reports, settings, shared
  utils/reservations/**                     access, sections, nav, token, client,
                                            *-api, *-types, *-view, errors, presets,
                                            region guard, guards test
  hooks/use-reservations-*.ts               client, query, action, day feed
  utils/website/block-types.ts              + 'reservation' block
  utils/dashboards/*                        + 'reservations-today' block

apps/sites/src/
  pages/reserve/index.astro, manage.astro, waitlist.astro
  pages/experiences/index.astro, [slug].astro
  components/blocks/ReservationBlock.astro
  components/reservations/*                  picker, slots, details, hold timer,
                                             confirmation, manage, waitlist, labels
  lib/reservations/*                         browser client, view math, errors

packages/phone-agent/src/vertical.ts       + generic services.callAction (no
                                             reservation words)
packages/phone-agent-restaurant/src/       + reservation tools and prompt text
packages/staffing + apps/tenant-api/src/services/  + generic demand-signal seam
packages/reports/src/catalog-reservations.ts      report subjects
packages/marketing-workflow/src/workflow-labels.ts trigger labels
apps/jobs-cron/src/index.ts                + hourly /api/reservations/tick call

docs/reservations.md, docs/reservations-contract.md, docs/reservations-plan.md,
docs/decisions/048-reservations-data-residency.md (+ edits, section 15)
```

Responsibilities by runtime:

| Component             | Owns                                                                                                                                             | Never does                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `@repo/reservations`  | rules, engine, state machine, policy, message schedule math, schemas, flag and permission strings                                                | I/O, UI strings, provider calls                                                 |
| tenant-api (regional) | all reservation data, writes, availability, holds, messages to guests, regional tick, voice actions, report records                              | read flags/roles for operator routes (trusts the token), call payment providers |
| App (US)              | flags, permissions, token mint, location facts, Sites gate payload, payment provider calls, manager notifications, region switch guard, UI shell | read or store guest data, proxy guest calls                                     |
| Sites                 | public pages and blocks, labels in six locales, injects regional URL                                                                             | fetch or render guest data server-side, proxy bookings                          |
| jobs-cron             | hourly trigger of `/api/reservations/tick` on every node                                                                                         | anything else                                                                   |
| Native apps           | call the public and customer routes (contract only)                                                                                              | anything not in the contract                                                    |

---

## 3. Data placement

| Entity                                                                                                                                                          | Plane                                                                  | PII rule                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Flags `reservations.*` (`ConfigFlag`)                                                                                                                           | Control                                                                | none                                                                                                          |
| Permission rows, role grants, presets                                                                                                                           | Control                                                                | none                                                                                                          |
| Location facts (name, slug, time zone, address, phone, hours)                                                                                                   | Control (`OrganizationLocation`)                                       | business data, not personal                                                                                   |
| Member location scope                                                                                                                                           | Control (`UserOrganization.locationScope`, `UserOrganizationLocation`) | operator ids only                                                                                             |
| Website block config ("Book a table")                                                                                                                           | Control (`WebsitePageSection.config`)                                  | none                                                                                                          |
| Manager notifications                                                                                                                                           | Control (`Notification`)                                               | ids, kind, location id, count only                                                                            |
| Payment provider sessions, webhooks                                                                                                                             | Provider + App transit                                                 | App sees reservation id, amount, currency, opaque provider refs; guest enters card/email on the provider page |
| Reservation settings, areas, tables, combos, floor elements, services, turn times, pacing, special days, blocks, policies, sections, message texts, experiences | Regional                                                               | no PII (sections may reference staff ids, regional)                                                           |
| Guests, tags, notes, merges                                                                                                                                     | Regional                                                               | PII; allergy/dietary is sensitive (staff-only, excluded from exports and reports by default)                  |
| Reservations, occupancies, holds, events, service notes                                                                                                         | Regional                                                               | PII (names, requests, notes)                                                                                  |
| Waitlist entries, notify-me requests                                                                                                                            | Regional                                                               | PII                                                                                                           |
| Messages outbox/log, payments records                                                                                                                           | Regional                                                               | PII (destination) / provider refs only, never card data                                                       |
| Idempotency keys, day versions, rate counters, audit, outbox                                                                                                    | Regional                                                               | hashes and ids only                                                                                           |

**Why settings are regional.** The engine reads settings, floor plan, blocks and
bookings together inside the write transaction; a booking must commit against
exactly the rules it was validated with, and a settings edit that changes
availability bumps the same `rsv_day_versions` that invalidate caches and polls.
Cross-plane settings would need a second consistency protocol, add App latency
to every search, and make the regional node depend on the App for correctness.
Settings hold no PII, so placing them regionally costs nothing in residency.
Consequence: a region switch wipes them (the region-switch guard counts and
warns; section 5.5).

**How control-plane facts reach tenant-api.** New internal route
`GET /resources/reservations/context?orgId=` on the App
(`requireInternalCommandAuth`, 302 rewritten to 403, `private, no-store`).
Response (validated by `reservationsContextSchema` in `@repo/reservations`):

```ts
{
  orgId, dataRegion: 'us' | 'ksa',
  features: { enabled, online, waitlist, payments, experiences, voice }, // folded: child = master && child
  organization: { name, slug, currency, defaultLocale, locales, siteOrigin, sitePublished,
                  emailTheme /* hex only, from packages/common/src/email-theme.ts */, logoUrl },
  locations: [{ id, name, slug, timeZone, phone, address: { formattedAddress, city, lat, lng },
                storeHours, specialHours, isActive }],
  payments: { processor: 'connect' | 'checkout' | null, deposit: boolean, guarantee: boolean },
  staffing: { enabled: boolean }   // whether section assignments may pick staff ids
}
```

Cache in `apps/tenant-api/src/lib/reservations-context.ts`, copying
`lib/scope-context.ts`: LRU per org, fresh 5 min, stale 24 h, 30 s failure
cooldown, 3 s timeout, `redirect: 'error'`, base URL only from
`APP_URL`/`BASE_URL`. Use rules:

- Public **reads** (config, availability, calendar, experiences) accept stale
  facts; features may be at most 30 min stale, else 503.
- Public **writes** (hold, book, request, waitlist join, notify-me) require
  features no older than 5 min; one synchronous refresh on staleness; App
  unreachable -> 503 `unavailable`.
- **Operator** routes never need flags (the token proves them at mint, at most
  15 min ago). They need only the location time zone, which is snapshotted in
  `rsv_location_settings.time_zone` so the write path never blocks on the App.
- The **tick** skips sending when features are unknown (`flags_unknown`) but
  still expires holds and payments (no messages).
- A time zone in the context that differs from the snapshot raises a
  `tz_mismatch` banner in Settings; re-deriving future instants is an explicit
  operator action (`POST /setup/locations/:id/rederive-times`).
- The App nudges invalidation via `POST /internal/reservations/context-changed`
  after location edits, flag changes made in Admin are picked up within 5 min.

---

## 4. Regional data model

New section `// 12. RESERVATIONS` in `packages/tenant-db/src/schema.ts`; one
additive migration `0016_reservations_foundation.sql` (later slices may add
`0017+`, always additive). Conventions (same as staffing, comment at
`schema.ts:1051`):

- `id text PK` default `randomUUID()`; enums as `text({ enum: X_VALUES })` with
  exported `*_VALUES`; booleans `integer({ mode: 'boolean' })`.
- `*_at` epoch **milliseconds** UTC (default `nowMs`). Note: `customers` and
  `restaurant_orders` use epoch seconds; convert when joining.
- `*_date` `YYYY-MM-DD` business date in the location time zone; `*_min` integer
  minutes from 00:00 of the business date (may exceed 1440).
- Money `*_minor` integer minor units + `currency` (ISO 4217 upper case).
- `location_id` = control-plane location id, plain text, no FK. Control-plane
  user ids (`created_by`, `actor_id`) opaque text, no FK.
- Colors are theme-token keys (`color_token`), never hex.
- `version integer not null default 1` on mutable aggregates, bumped on every
  update (optimistic concurrency).
- Localized operator-authored public text: `*_i18n` JSON `{ [locale]: string }`
  validated by Zod against the six site locales.

Drizzle names: `rsvLocationSettings`, `rsvAreas`, ... exported from
`@repo/tenant-db`.

### 4.1 Configuration

**rsv_location_settings** (one row per location; created on first setup)

| Column                                                 | Type                                  | Notes                                                                                                     |
| ------------------------------------------------------ | ------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| location_id                                            | text PK                               |                                                                                                           |
| enabled                                                | bool, default 0                       | location-level switch (operators + guests)                                                                |
| online_enabled                                         | bool, default 0                       | shown on website/native when org flag `online` is on                                                      |
| time_zone                                              | text                                  | snapshot of App location tz; IANA, validated                                                              |
| tz_synced_at                                           | int                                   |                                                                                                           |
| day_start_min                                          | int default 240                       | business-day boundary (04:00)                                                                             |
| interval_min                                           | int default 15                        | booking grid; check in (5,10,15,20,30,60)                                                                 |
| horizon_days                                           | int default 30                        | check 1..365                                                                                              |
| release_local_min                                      | int null                              | daily release time of the newest day                                                                      |
| min_notice_min                                         | int default 60                        | online lead time                                                                                          |
| same_day_cutoff_min                                    | int null                              | wall-clock cutoff for same-day online                                                                     |
| online_party_min / online_party_max                    | int 1 / 8                             |                                                                                                           |
| party_max                                              | int default 30                        | staff max                                                                                                 |
| large_party_mode                                       | text `contact` \| `request`           | above online max                                                                                          |
| large_party_note_i18n                                  | json                                  |                                                                                                           |
| request_holds_capacity                                 | bool default 1                        |                                                                                                           |
| request_deadline_hours                                 | int default 24                        |                                                                                                           |
| seating_pref_mode                                      | text `off` \| `preferred` \| `strict` | guest area choice                                                                                         |
| hold_minutes                                           | int default 7                         | check 3..20                                                                                               |
| payment_hold_minutes                                   | int default 20                        | check 10..60                                                                                              |
| freeze_min                                             | int default 30                        | no automatic moves inside                                                                                 |
| late_grace_min                                         | int default 15                        | "late" derived                                                                                            |
| auto_no_show_after_min                                 | int null                              | null = off (opt-in)                                                                                       |
| max_active_per_phone                                   | int default 3                         | future bookings per phone per location                                                                    |
| block_same_phone_overlap                               | bool default 1                        |                                                                                                           |
| guest_modify_cutoff_min                                | int default 120                       | guest self-service modify until N min before                                                              |
| contact_statuses_enabled                               | bool default 1                        | left message / no answer / wrong number                                                                   |
| course_statuses_enabled                                | bool default 0                        |                                                                                                           |
| default_policy_id                                      | text null FK rsv_policies             |                                                                                                           |
| waitlist_enabled / waitlist_online / notify_me_enabled | bool 0/0/0                            |                                                                                                           |
| waitlist_response_min                                  | int default 10                        |                                                                                                           |
| messaging                                              | json                                  | Zod `messagingSettingsSchema`: per kind enabled, reminder hours, reconfirm hours, quiet hours, sms on/off |
| public_note_i18n                                       | json                                  | shown on /reserve                                                                                         |
| contact_phone                                          | text null                             | override of location phone for large-party contact                                                        |
| floor_plan_version                                     | int default 1                         | bumped on floor-plan Save                                                                                 |
| version                                                | int default 1                         |                                                                                                           |
| updated_at, updated_by                                 | int, text                             |                                                                                                           |

**rsv_areas**: `id`, `location_id`, `name`, `name_i18n` (public label for
seating preference), `sort`, `online_bookable` bool, `guest_selectable` bool,
`canvas_w` int default 1200, `canvas_h` int default 800, `archived_at`,
`created_at`, `updated_at`, `version`. Index `(location_id, sort)`.

**rsv_tables**: `id`, `location_id`, `area_id` FK, `label`, `min_covers`,
`max_covers`, `online_bookable` bool, `combinable` bool, `priority` int (higher
= preferred), `reset_buffer_min` int default 0, `shape` (`round` | `square` |
`rect` | `booth` | `bar`), `x`, `y`, `w`, `h` int (canvas units, canonical LTR),
`rotation` int (0..359), `archived_at`, `created_at`, `updated_at`. Checks
`1 <= min_covers <= max_covers <= 99`, `reset_buffer_min between 0 and 120`.
Unique `(location_id, label)` where `archived_at is null`. Index
`(location_id, area_id)`.

**rsv_table_combos**: `id`, `location_id`, `label`, `min_covers`, `max_covers`,
`online_bookable`, `priority`, `archived_at`, `created_at`, `updated_at`.
**rsv_table_combo_members**: `combo_id` FK cascade, `table_id` FK; PK
`(combo_id, table_id)`. Service validation: ≥ 2 members, members active and
combinable, no duplicate member sets in a location.

**rsv_floor_elements** (non-table decor): `id`, `area_id` FK cascade, `kind`
(`wall` | `bar` | `door` | `window` | `label` | `plant` | `zone`), `label`, `x`,
`y`, `w`, `h`, `rotation`.

**rsv_services** (weekly templates and special-day replacements): `id`,
`location_id`, `name`, `name_i18n`, `days_mask` int (bit 0 = Monday),
`first_seating_min`, `last_seating_min`, `end_min` (may exceed 1440),
`interval_min` null (inherit), `effective_from` date null, `effective_to` date
null, `priority` int, `special_day_id` FK null (set = only that day),
`online_enabled` bool, `online_from_min` / `online_to_min` null, `max_party`
null, `online_party_max` null, `online_cap_per_interval` null,
`concurrent_covers_cap` null, `policy_id` null, `section_layout_id` null,
`allow_overrun_past_end` bool default 1, `color_token`, `sort`, `archived_at`,
`version`. Checks `first <= last <= end`, `end - first <= 1440`. Index
`(location_id, archived_at)`.

**rsv_service_availability** (per-service table availability): `id`,
`service_id` FK cascade, one of `area_id` / `table_id` / `combo_id` (check
exactly one), `mode` (`online` | `staff_only` | `walk_in_only` | `unavailable`),
optional `from_min` / `to_min` (time period inside the service). Default without
a row: table `online_bookable` decides `online` vs `staff_only`. `walk_in_only`
tables are excluded from auto assignment of reservations but usable for walk-ins
and waitlist seating.

**rsv_turn_times**: `id`, `location_id`, `service_id` null (null = location
default), `party_min`, `party_max`, `minutes`, `days_mask` null. Unique
`(location_id, service_id, party_min, days_mask)`. Validation: contiguous and
non-overlapping ranges covering 1..party_max; minutes 15..480. Engine fallback
if a size is missing: largest bucket, logged as a config warning.

**rsv_pacing_rules**: `id`, `service_id` FK cascade, `from_min` / `to_min` null
(whole service), `bucket_min` default 15, `max_covers` null, `max_parties` null,
`rolling_min` null, `rolling_max_covers` null, `channel` (`all` | `online`).

**rsv_special_days**: `id`, `location_id`, `from_date`, `to_date`, `kind`
(`closed` | `online_closed` | `modified` | `replace`), `service_id` null (for
`modified`), `patch` json (Zod `servicePatchSchema`), `name`,
`public_note_i18n`, `created_by`, `created_at`, `version`. Index
`(location_id, from_date, to_date)`. Precedence per research section 5.2:
closed > replace > modified > online_closed > weekly template (latest
`effective_from`, then priority).

**rsv_blocks**: `id`, `location_id`, one of `table_id` / `area_id`,
`business_date`, `start_at`, `end_at`, `reason`, `note`, `created_by`,
`created_at`. Index `(location_id, business_date)`. Each table-level block also
writes occupancy rows of kind `block` (area blocks expand to every table of the
area at write time).

**rsv_policies**: `id`, `location_id`, `name`, `kind` (`none` | `card_guarantee`
| `deposit` | `prepay`), `amount_minor`, `per_cover` bool, `currency`,
`free_cancel_until_min` (minutes before start), `late_cancel_fee_minor`,
`no_show_fee_minor`, `fee_per_cover` bool, `refund_rule` (`full_before_window` |
`none` | `partial`), `partial_refund_bp` null, `applies_party_min` null,
`terms_i18n` json, `terms_version` int, `archived_at`, `version`. Editing terms
bumps `terms_version`; reservations snapshot the policy.

**rsv_section_layouts**: `id`, `location_id`, `name`, `archived_at`.
**rsv_sections**: `id`, `layout_id` FK cascade, `name`, `color_token`, `sort`.
**rsv_section_tables**: `section_id` FK cascade, `table_id` FK, `layout_id`
(denormalized); PK `(section_id, table_id)`, unique `(layout_id, table_id)`.
**rsv_section_assignments** (per service day): `id`, `location_id`,
`business_date`, `service_id`, `section_id`, `staff_id` text null (opaque
staffing id; regional, no FK because staffing may be off), `server_label` text
null, `version`. Unique `(business_date, service_id, section_id)`.

**rsv_message_texts**: `id`, `location_id` null (null = org default), `kind`,
`locale` (`en` | `ar`), `custom_note` (≤ 500 chars, plain text appended to the
template), `updated_by`, `updated_at`. Unique `(location_id, kind, locale)`.

**rsv_experiences**: `id`, `location_id`, `slug` (unique per location while
active), `kind` (`ticketed` | `prix_fixe`), `name_i18n`, `description_i18n`,
`image_url` null, `price_minor` null, `price_per_cover` bool, `currency`,
`policy_id` null (prepay/deposit), `party_min`, `party_max`, `uses_tables` bool
default 1, `exclusive` bool (when on, the windows below are bookable only
through the experience), `status` (`draft` | `published` | `archived`), `sort`,
`version`. **rsv_experience_schedules**: `id`, `experience_id` FK cascade,
`from_date`, `to_date`, `days_mask`, `seating_mins` json (explicit start
minutes) or `start_min` / `end_min` / `interval_min`, `turn_min`,
`covers_cap_per_seating` null, `covers_cap_per_day` null, `area_ids` json null,
`service_id` null.

### 4.2 Guests

**rsv_guests**: `id`, `customer_id` text null FK `customers.id` ON DELETE SET
NULL (unique where not null; set only from a verified customer token or a
staff-confirmed link to a verified customer), `first_name`, `last_name`,
`phone_e164` null, `email_norm` null, `locale`, `allergy_notes` null
(sensitive), `staff_notes_summary` null, `marketing_email_consent_at`,
`marketing_sms_consent_at`, `consent_source`, `consent_text_version`, `visits`,
`covers`, `no_shows`, `late_cancels`, `cancels`, `first_visit_at`,
`last_visit_at` (denormalized; updated in the same transaction as status
changes; repair job recomputes from reservations), `merged_into_id` null,
`erased_at` null, `created_at`, `updated_at`, `version`. Indexes: `phone_e164`,
`email_norm`, `last_name`, `last_visit_at`. No unique on phone.

**rsv_tags**: `id`, `scope` (`guest` | `reservation`), `category` (`vip` |
`dietary` | `occasion` | `seating` | `custom` | `system`), `name`, `name_i18n`
(guest-facing for occasion/dietary chips), `color_token`, `sensitive` bool
(dietary/allergy), `system_key` null (unique: `first_visit`, `frequent_no_show`,
`vip`), `guest_selectable` bool, `archived_at`. **rsv_guest_tags**: `guest_id`
FK cascade, `tag_id` FK; PK both. **rsv_guest_notes**: `id`, `guest_id` FK
cascade, `body` (≤ 2000), `pinned`, `author_id`, `created_at`, `deleted_at`.
**rsv_guest_merges**: `id`, `kept_guest_id`, `merged_guest_id`, `actor_id`,
`at`, `moved_counts` json. Append-only trigger.

### 4.3 Reservations

**rsv_reservations**

| Column                                                       | Type                             | Notes                                                                                                                                         |
| ------------------------------------------------------------ | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| id                                                           | text PK                          |                                                                                                                                               |
| location_id                                                  | text                             |                                                                                                                                               |
| guest_id                                                     | text FK rsv_guests               |                                                                                                                                               |
| customer_id                                                  | text null                        | copy of the binding at booking time (verified only)                                                                                           |
| confirmation_code                                            | text unique                      | 8 chars Crockford base32, display only, not a secret                                                                                          |
| business_date                                                | text                             | intent                                                                                                                                        |
| local_start_min                                              | int                              | intent                                                                                                                                        |
| time_zone                                                    | text                             | intent                                                                                                                                        |
| start_at / end_at                                            | int                              | derived; `end_at = start_at + duration_min*60000`                                                                                             |
| duration_min                                                 | int                              | turn time at booking (editable)                                                                                                               |
| service_id                                                   | text null                        | null for walk-ins outside services                                                                                                            |
| experience_id                                                | text null                        |                                                                                                                                               |
| party_size                                                   | int                              | check 1..99                                                                                                                                   |
| seated_covers                                                | int null                         | partial seating                                                                                                                               |
| status                                                       | text                             | section 6.4                                                                                                                                   |
| contact_status                                               | text null                        | `left_message` \| `no_answer` \| `wrong_number`                                                                                               |
| running_late_min                                             | int null                         | guest or host reported                                                                                                                        |
| course_status                                                | text null                        | `appetizer` \| `entree` \| `dessert` \| `check_dropped` \| `paid` \| `bussing`                                                                |
| channel                                                      | text                             | `online` \| `phone` \| `host` \| `walk_in` \| `waitlist` \| `voice_agent` \| `native`                                                         |
| assignment                                                   | text                             | `soft` \| `locked`                                                                                                                            |
| combo_id                                                     | text null                        |                                                                                                                                               |
| overbooked                                                   | bool                             | explicit staff overbook (audited)                                                                                                             |
| area_pref_id                                                 | text null, area_pref_strict bool |                                                                                                                                               |
| occasion_tag_id                                              | text null                        |                                                                                                                                               |
| guest_requests                                               | text null                        | guest-typed (≤ 500)                                                                                                                           |
| dietary_notes                                                | text null                        | guest-typed, sensitive                                                                                                                        |
| staff_notes                                                  | text null                        |                                                                                                                                               |
| policy_snapshot                                              | json null                        | policy + terms version + amounts at booking                                                                                                   |
| payment_status                                               | text                             | `none` \| `pending` \| `guaranteed` \| `paid` \| `refund_pending` \| `refunded` \| `fee_pending` \| `fee_charged` \| `fee_failed` \| `review` |
| payment_expires_at                                           | int null                         |                                                                                                                                               |
| request_deadline_at                                          | int null                         |                                                                                                                                               |
| hold_id                                                      | text unique null                 | conversion at most once                                                                                                                       |
| manage_token_hash                                            | text unique                      | sha256 of derived token                                                                                                                       |
| manage_token_version                                         | int default 1                    | rotation                                                                                                                                      |
| sms_opt_in                                                   | bool                             | transactional texts (US only)                                                                                                                 |
| guest_locale                                                 | text                             | for messages and manage page                                                                                                                  |
| schedule_version                                             | int default 1                    | bumped on time/date change (message dedupe)                                                                                                   |
| version                                                      | int default 1                    |                                                                                                                                               |
| arrived_at, seated_at, finished_at, cancelled_at, no_show_at | int null                         |                                                                                                                                               |
| cancelled_by                                                 | text null                        | `guest` \| `restaurant` \| `system`                                                                                                           |
| cancel_reason                                                | text null                        |                                                                                                                                               |
| created_by_kind                                              | text                             | `guest` \| `operator` \| `system` \| `voice_agent`                                                                                            |
| created_by_id                                                | text null                        | operator user id                                                                                                                              |
| ip_hash                                                      | text null                        | public bookings                                                                                                                               |
| created_at, updated_at                                       | int                              |                                                                                                                                               |

Indexes: `(location_id, business_date, status)`, `(location_id, start_at)`,
`(guest_id, start_at)`, `(status, start_at)`, `(customer_id, start_at)`. Checks:
`end_at > start_at`, `party_size between 1 and 99`.

**rsv_reservation_tags**: `reservation_id` FK cascade, `tag_id` FK; PK both.

**rsv_table_occupancies** (single occupancy table for reservations, holds and
blocks, so one trigger guards all of them):

| Column                              | Type               | Notes                                     |
| ----------------------------------- | ------------------ | ----------------------------------------- |
| id                                  | text PK            |                                           |
| location_id                         | text               |                                           |
| table_id                            | text FK rsv_tables |                                           |
| kind                                | text               | `reservation` \| `hold` \| `block`        |
| reservation_id / hold_id / block_id | text null          | check exactly one matches `kind`          |
| start_at / end_at                   | int                | includes reset buffer; check end > start  |
| active                              | bool               | 0 once the owner stops consuming capacity |
| overbook                            | bool               | skips the overlap trigger                 |
| created_at                          | int                |                                           |

Index `(table_id, active, start_at)`, `(reservation_id)`, `(hold_id)`.
Maintained in the same transaction as owner status changes (finish sets
`end_at = max(start_at+1, finished_at)`; cancel/no-show/expire sets
`active = 0`; hold conversion updates `kind`, `hold_id -> reservation_id` in
place so the interval does not change).

Overlap trigger (hand-appended; schema test asserts it):

```sql
CREATE TRIGGER rsv_occupancy_no_overlap_insert
BEFORE INSERT ON rsv_table_occupancies
WHEN NEW.active = 1 AND NEW.overbook = 0
BEGIN
  SELECT RAISE(ABORT, 'rsv_table_occupancies overlap')
  WHERE EXISTS (
    SELECT 1 FROM rsv_table_occupancies o
    WHERE o.table_id = NEW.table_id AND o.active = 1 AND o.overbook = 0
      AND o.start_at < NEW.end_at AND NEW.start_at < o.end_at);
END;
--> statement-breakpoint
CREATE TRIGGER rsv_occupancy_no_overlap_update
BEFORE UPDATE ON rsv_table_occupancies
WHEN NEW.active = 1 AND NEW.overbook = 0 AND (
  NEW.table_id IS NOT OLD.table_id OR NEW.start_at < OLD.start_at OR
  NEW.end_at > OLD.end_at OR OLD.active = 0 OR OLD.overbook = 1)
BEGIN
  SELECT RAISE(ABORT, 'rsv_table_occupancies overlap')
  WHERE EXISTS (
    SELECT 1 FROM rsv_table_occupancies o
    WHERE o.id <> NEW.id AND o.table_id = NEW.table_id AND o.active = 1
      AND o.overbook = 0 AND o.start_at < NEW.end_at AND NEW.start_at < o.end_at);
END;
```

Repairs and moves deactivate or shorten old rows before inserting new ones.
Expired holds are swept at the start of every write transaction, so their
still-active rows never trip the trigger.

**rsv_holds**: `id`, `location_id`, `token_hash` unique, `business_date`,
`local_start_min`, `start_at`, `end_at`, `party_size`, `service_id`,
`experience_id`, `area_pref_id`, `combo_id`, `status` (`active` | `converted` |
`released` | `expired`), `expires_at`, `extended_for_payment` bool, `ip_hash`,
`reservation_id` null, `created_at`. Index
`(location_id, business_date, status, expires_at)`, `(ip_hash, created_at)`.
Table-less experience holds have no occupancy rows but count against the
experience cap.

**rsv_reservation_events** (append-only): `id`, `reservation_id`, `at`,
`actor_kind` (`guest` | `operator` | `system` | `voice_agent`), `actor_id`,
`type` (`created`, `status_changed`, `modified`, `assigned`, `auto_reassigned`,
`overbooked`, `message_sent`, `message_failed`, `payment_*`, `note`,
`contact_status`, `course_status`, `approved`, `declined`, `merged_guest`),
`from_status`, `to_status`, `data` json (field diffs; no contact values,
guest-typed text referenced by field name only). Index `(reservation_id, at)`.
Triggers `rsv_reservation_events_no_delete`, `_no_update` (allows only
`data = '{"redacted":true}'`).

**rsv_service_notes**: `id`, `location_id`, `business_date`, `service_id` null,
`body` (≤ 2000), `updated_by`, `updated_at`, `version`. Unique
`(location_id, business_date, service_id)`.

### 4.4 Waitlist and notify-me

**rsv_waitlist_entries**: `id`, `location_id`, `business_date`, `guest_id` null,
`display_name`, `phone_e164` null, `email_norm` null, `party_size`,
`area_pref_id`, `channel` (`walk_in` | `remote`), `joined_at`, `quoted_min`,
`quoted_ready_at`, `status` (`waiting` | `notified` | `on_the_way` | `seated` |
`cancelled` | `left` | `no_response`), `notified_at`, `response_deadline_at`,
`reservation_id` null (walk-in reservation created at seating),
`status_token_hash` unique null, `sort_key` real, `notes`, `sms_opt_in`,
`locale`, `ip_hash`, `created_at`, `version`. Index
`(location_id, business_date, status, sort_key)`. Partial unique
`(location_id, business_date, phone_e164)` where status in active set (enforced
in service, plus index for lookup).

**rsv_notify_requests**: `id`, `location_id`, `business_date`, `party_size`,
`from_local_min`, `to_local_min`, `area_pref_id`, `experience_id`,
`contact_phone_e164` null, `contact_email_norm` null, `guest_id` null, `locale`,
`status` (`active` | `notified` | `booked` | `expired` | `cancelled`),
`notified_count`, `last_notified_at`, `expires_at`, `cancel_token_hash`,
`ip_hash`, `created_at`. Index `(location_id, business_date, status)`.

### 4.5 Messages, payments, cross-plane outbox

**rsv_messages** (outbox and delivery log): `id`, `location_id`,
`reservation_id` null, `waitlist_entry_id` null, `notify_request_id` null,
`kind` (section 9.3), `channel` (`email` | `sms`), `category` (`transactional` |
`marketing`), `locale`, `send_at`, `status` (`pending` | `sending` | `sent` |
`failed` | `cancelled` | `suppressed` | `dropped`), `attempts`,
`next_attempt_at`, `dedupe_key` unique
(`<entity>:<id>:<kind>:<channel>:<schedule_version>`), `provider_message_id`,
`last_error_code`, `sent_at`, `created_at`. Index `(status, next_attempt_at)`,
`(reservation_id)`. Destination is resolved at send time from the guest or entry
row (not copied), so erasure needs no message rewrite.

**rsv_payments**: `id`, `reservation_id`, `kind` (`setup` | `deposit` | `prepay`
| `no_show_fee` | `late_cancel_fee` | `refund`), `processor` (`stripe` |
`checkout_com`), `status` (`created` | `pending` | `succeeded` | `failed` |
`requires_action` | `cancelled` | `refunded`), `amount_minor`, `currency`,
`provider_session_id` unique null, `provider_payment_ref` null,
`provider_payment_method_ref` null (opaque), `idempotency_key` unique
(`rsv:<reservationId>:<kind>:<attempt>`), `payment_token_hash` null,
`failure_code`, `parent_payment_id` null (refund of), `requested_by`,
`created_at`, `updated_at`, `version`. Index `(reservation_id)`. No card data.

**rsv_outbox** (regional -> App, ids and counts only): `id`, `kind`
(`manager_alert` | `refund_request` | `checkout_expire`), `dedupe_key` unique,
`payload` json (strict schema per kind), `status`, `attempts`,
`next_attempt_at`, `created_at`. Index `(status, next_attempt_at)`.

### 4.6 Infrastructure

**rsv_idempotency_keys**: `scope` (`public_book` | `public_hold` |
`public_request` | `waitlist_join` | `notify_me` | `operator_create` | `walk_in`
| ...), `key` (client UUID), `request_hash` (sha256 of canonical body),
`result_kind`, `result_id`, `status_code`, `created_at`, `expires_at` (48 h); PK
`(scope, key)`. Stores ids, never response bodies: replays re-serialize the
entity and re-derive capability tokens (they are HMAC derived), so no secret is
stored in plaintext. Same key + same hash = same result; same key + different
hash = `409 idempotency_conflict`.

**rsv_day_versions**: `location_id`, `business_date`, `version`,
`availability_increased_at` null (notify-me matching flag); PK both. Bumped in
every write that touches the date (bookings, holds, blocks, settings that affect
it; settings-wide edits bump a location-wide `rsv_location_settings.version`
that is folded into the ETag).

**rsv_rate_counters**: `bucket` (e.g. `hold:ip:<hash>`, `book:phone:<hash>`,
`waitlist:ip:<hash>`), `window_start`, `count`; PK `(bucket, window_start)`.
Purged by the tick.

**rsv_audit_log** (append-only, like `staff_audit_log`): `id`, `at`,
`actor_kind`, `actor_id`, `action` (`settings.update`, `floor_plan.save`,
`guest.merge`, `guest.export`, `guest.erase`, `payment.fee_requested`,
`payment.refund_requested`, `report.run`, ...), `entity_kind`, `entity_id`,
`location_id`, `changes` json (no PII), `ip_hash`. Same no-delete/no-update
triggers with redaction exception.

Other hand-appended triggers: `rsv_holds_single_conversion` (status `converted`
cannot change), `rsv_guest_merges_append_only`.

---

## 5. Control-plane changes

### 5.1 Flags (`packages/reservations/src/flags.ts`)

| Key                        | Gates                                                                                                                             | Requires                           |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `reservations.enabled`     | the module: nav, every App route, token mint, operator API, tick messaging, manage links, all public routes                       | none (master)                      |
| `reservations.online`      | public booking (config, availability, calendar, holds, book, large-party request), `/reserve`, Book a table block, native booking | master                             |
| `reservations.waitlist`    | operator waitlist; remote join and notify-me also need `online`                                                                   | master                             |
| `reservations.payments`    | non-`none` policies, deposits, guarantees, fees, refunds UI and routes (existing paid bookings stay refundable when off)          | master                             |
| `reservations.experiences` | Experiences setup, public pages, experience availability                                                                          | master (public part also `online`) |
| `reservations.voice`       | phone-agent reservation tools                                                                                                     | master                             |

Only literal `true` is on; child flags count only while master is on (fold in
`getReservationsFeatureState`). Admin's Organization tab only lists keys that
exist at system level, so the seed and docs add system-level `false` rows for
all six keys.

### 5.2 Permissions (`packages/reservations/src/permissions.ts`, mirrored in `ORG_PERMISSIONS`)

| Constant                    | String                            | Allows                                                                                                                                 |
| --------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| READ_RESERVATION            | `read:reservation:any`            | book, timeline, floor live, calendar, overview, waitlist, guest summaries on reservations                                              |
| UPDATE_RESERVATION          | `update:reservation:any`          | create/modify/status/assign/overbook, walk-ins, waitlist actions, blocks, service notes, section assignments, approve/decline requests |
| READ_RESERVATION_GUEST      | `read:reservation_guest:any`      | Guestbook search, profiles, history, notes, export (sensitive)                                                                         |
| UPDATE_RESERVATION_GUEST    | `update:reservation_guest:any`    | edit profiles, tags, notes, merge, erase (sensitive)                                                                                   |
| READ_RESERVATION_SETTINGS   | `read:reservation_settings:any`   | view setup                                                                                                                             |
| UPDATE_RESERVATION_SETTINGS | `update:reservation_settings:any` | edit setup, floor plan, services, policies, messages, sections, experiences                                                            |
| READ_RESERVATION_REPORT     | `read:reservation_report:any`     | reports, report subjects, dashboard block                                                                                              |
| UPDATE_RESERVATION_PAYMENT  | `update:reservation_payment:any`  | charge fees, request refunds (sensitive)                                                                                               |

Update implies read at runtime (`grantsSatisfying`). Sensitive grants (5 min
tokens): both guest grants and the payment grant. Impersonation: read-only, no
sensitive grants.

Default grants (migration): `org_role_admin` gets all eight; `org_role_member`
gets none. Existing custom roles get none. Presets
(`apps/app/app/utils/reservations/role-presets.ts`): **Host** (read+update
reservation), **Reservations manager** (all except payment), **Guest relations**
(read reservation + both guest grants), **Owner** (all).

### 5.3 Migrations and mirrors

- `packages/database/drizzle/0025_reservations_foundation.sql`:
  `INSERT OR IGNORE INTO "Permission"` (ids
  `org_perm_<action>_<entity>_<access>`, context `organization`) and
  `_OrganizationPermissionToRole` for admin. No new tables. Mirror rows in
  `packages/database/setup-roles.ts`.
- `packages/auth/src/organization-permissions.server.ts` `ORG_PERMISSIONS` (+
  drift test against `RESERVATIONS_PERMISSIONS`).
- `apps/app/app/utils/organization/tenant-role-permissions.ts` allow-list and
  `RESERVATIONS_IMPLIED_PERMISSION_IDS`; role editor group `reservations: true`
  hidden unless `reservations.enabled`
  (`apps/app/app/components/roles/tenant-role-access-manager.tsx`).
- Member location scope: reuse `UserOrganization.locationScope` +
  `UserOrganizationLocation` (one "locations this member works at" setting)
  through `locationIdsClaim`; docs generalize its description.

### 5.4 Token

- Audience `tenant-api-reservations-operator`, header `typ: rsv+jwt`, HS256 with
  `TENANT_OPERATOR_TOKEN`, issuer `brand.shortName`.
- Claims (`reservationsTokenClaimsSchema`): `aud`, `role: 'operator'`, `region`,
  `orgId`, `sub`, `scope` (`book` | `guests` | `setup` | `reports` |
  `payments`), `grants`, `locationIds` (`null` = all), `features` (folded child
  flags, so tenant-api can refuse e.g. waitlist routes when off without a flag
  read), `impersonated`. TTL 15 min, 5 min with sensitive grants or
  impersonation; tenant-api caps `exp - iat`.
- `SCOPE_GRANTS`: book = reservation grants (+ `read:reservation_guest` is NOT
  included); guests = guest grants + read reservation; setup = settings grants;
  reports = report grant; payments = payment grant + read reservation.
- Add the audience to `workers/org-router.ts` `orgIdFromOperatorJwt`.

### 5.5 App resource routes (all `requireInternalCommandAuth` first)

| Route                                                                                                                      | Direction           | Purpose                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /resources/reservations/context?orgId`                                                                                | regional -> App     | facts + flags (section 3)                                                                                                                                                                |
| `POST /resources/reservations/notify`                                                                                      | regional -> App     | manager alerts `{ orgId, eventId, kind, locationId, count }` strict; kinds `large_party_request`, `waitlist_remote_join`, `unassigned_conflict`, `payment_failed`, `message_failed_bulk` |
| `POST /resources/reservations/payments`                                                                                    | regional -> App     | execute refunds / expire checkout (section 12)                                                                                                                                           |
| `GET /resources/sites/reservations?slug\|host`                                                                             | Sites -> App        | gate payload: `{ online, waitlist, experiences, notifyMe }` or 404 when master off or site unpublished                                                                                   |
| `POST /resources/sites/reservation/checkout`, `/status`                                                                    | Sites server -> App | opaque `{ reservationId, paymentToken }` only (ordering pattern)                                                                                                                         |
| `GET /resources/reservations/region-summary?orgId` (App-internal helper calling regional `/internal/reservations/summary`) | App -> regional     | counts for the region switch guard                                                                                                                                                       |

Region switch (`website+/_index` guard): show counts of future reservations,
guests, waitlist and unsettled payments; require typed confirmation; refuse
(409) while payments are `pending`, `guaranteed`, `fee_pending` or
`refund_pending`. Location deletion: App asks
`/internal/reservations/location-summary` and blocks deletion while future
reservations exist.

### 5.6 App navigation and entry points

- `apps/app/app/root.tsx`: `reservationsNav` via
  `getReservationsNavAccess(userId, orgId)` (cachified 30 s, key
  `reservations-nav:<org>:<user>`, fails to `HIDDEN_RESERVATIONS_NAV`).
- `apps/app/app/components/app-sidebar.tsx`: group "Reservations" with Today,
  Book, Waitlist, Guestbook, Experiences, Reports, Settings; per-link filter by
  `sections.ts` requirements; group URL = first visible link.
- Location settings: `settings+/locations.$locationId.tsx` gets a "Reservations"
  card (visible when the flag is on) linking to
  `reservations/settings?location=<id>`; no reservation fields are stored on
  `OrganizationLocation`.
- Website builder: `BLOCK_TYPES.reservation` ("Book a table") in
  `apps/app/app/utils/website/block-types.ts` with `defaultConfig`
  `{ heading, body, buttonLabel, locationId: null, defaultPartySize: 2, layout: 'inline' | 'button', experienceId: null }`;
  `LOCALIZED_FIELDS` heading/body/buttonLabel; inspector + preview cases in
  `website+/pages.$pageId.tsx` (inspector lists locations from the control plane
  and published experiences via the setup token); hidden from the block picker
  unless `reservations.online` is on; header CTA uses plain `/reserve` URL. Add
  `reserve` and `experiences` to `SITE_LINK_RESERVED_PATHS`.
- Dashboards: `reservations-today` built-in block (section 13.4).
- Phone agent settings: reservation tools toggle in the restaurant vertical
  config when `reservations.voice` is on.
- Notification preferences: reservations alert kinds in
  `settings+/notifications`.

---

## 6. Domain package API (`@repo/reservations`)

### 6.1 Time (`time.ts`, built on `@repo/zoned-time`)

`@repo/zoned-time` is `packages/staffing/src/tz.ts` moved verbatim
(`localParts`, `tzOffsetMs`, `zonedLocalToUtc`, `addDays`, `dayOfWeek`,
`businessDateOf`, `businessDayStartMs`, ...); `packages/staffing/src/tz.ts`
becomes `export * from '@repo/zoned-time'` so staffing's API and tests are
unchanged. Reservations adds:

```ts
localToInstant(date: string, localMin: number, tz: string,
  opts: { gap: 'skip' | 'after'; overlap: 'earlier' | 'later' }): number | null
instantToLocal(ms, tz, dayStartMin): { businessDate, localMin }
currentBusinessDate(now, tz, dayStartMin): string
```

Slots use `{ gap: 'skip', overlap: 'earlier' }`; service ends use
`{ gap: 'after', overlap: 'later' }`; walk-ins derive the intent from `now`.

### 6.2 Rules and engine

```ts
resolveServices(config: LocationConfig, businessDate): ResolvedService[]
buildDayState(input: { config, businessDate, rows: DayRows, now }): DayState
  // rows: tables, combos, service availability, occupancies (incl. previous
  // date spill-over), holds, reservations, blocks, experience counts
searchAvailability(input: { config, day, request: SearchRequest, now,
  budget?: number }): SearchResult
  // SearchRequest: { partySize, channel, areaId?, experienceId?, excludeReservationId? }
  // SearchResult: { slots: Slot[], largeParty?, closed?: { reason, note? } }
  // Slot: { startAt, localMin, serviceId, areaIds, experienceId?, requiresPayment? }
alternatives(input): { sameDay: Slot[]; otherDates: { date; firstLocalMin }[] }
calendarSummary(input: { config, days: DayState[], partySize, channel, now })
planBooking(input: { day, booking: BookingCandidate, mode: 'search' | 'book',
  budget: number, prefer?: { tableIds?, lock? } }): Plan | null
  // Plan: { unit: { tableIds, comboId? }, moves: Move[] }   Move: { reservationId, toTableIds, toComboId? }
reflow(input: { day, changed: string[], budget, now }): Move[]
validateConfig(config): ConfigIssue[]          // turn coverage, combos, services
detectConflicts(day, now): Conflict[]          // unassigned, overlaps, outside hours, removed tables
quoteWait(input: { day, queue, partySize, now, history }): { minutes, tableIds? }
```

The pseudocode in
`/home/factory-user/reservations-planning/research/reservation-engineering.md`
sections 1.4 (availability, pacing, table fit, horizon, cutoffs), 2.2 (scoring
weights), 2.3 (bounded repair), 2.4 (re-optimization), 3.4 (holds) and 7.1 (wait
quotes) is normative. Budgets: search 200 node expansions per slot, book 2000,
reflow 5000 per call. Channels: `online`, `native` and `voice_agent` are guest
channels (all online rules apply); `phone`, `host`, `walk_in`, `waitlist` are
staff channels (pacing is a warning, not a filter; `walk_in_only` tables allowed
for walk-ins and waitlist only).

Assignment rules:

- **soft** (system or host suggestion): may be moved by repair at booking time
  and by reflow, but never inside `freeze_min` of start or once arrived.
- **locked** (host pins, guest-requested specific table): never moved by any
  automatic process. Dragging a locked party asks "Unlock and move?".
- Reflow runs after seat, move, extend, party-size change, block, and table
  archive; it moves only soft, future, outside-freeze reservations; moves are
  logged as `auto_reassigned` events and surfaced to hosts, never to guests.
- A host drop onto an occupied table offers: swap, move the other party (if
  soft), or overbook (explicit).
- Background re-optimization (tick, later slice) runs only for business dates
  beyond today and accepts a plan only if every booking still fits and the
  objective strictly improves.

### 6.3 Experiences

Experience seatings resolve to virtual services for their dates. If
`uses_tables`, availability is the normal table engine restricted to the
experience's areas plus `covers_cap_per_seating`/`per_day`; if not, the
experience is a pool limited only by cover caps (invariant I1 case c). When
`exclusive`, those windows/areas are hidden from regular availability.

### 6.4 State machine (`state-machine.ts`)

Statuses: `requested`, `pending_payment`, `booked`, `confirmed`,
`partially_arrived`, `arrived`, `partially_seated`, `seated`, `finished`,
`cancelled`, `no_show`, `declined`, `expired`.

Capacity: consumed in `pending_payment` (until `payment_expires_at`), `booked`,
`confirmed`, `partially_arrived`, `arrived`, `partially_seated`, `seated`; in
`requested` only when `request_holds_capacity`; released on `finished` (from
`finished_at`), `cancelled`, `no_show`, `declined`, `expired`. "Late" and
"running long" are derived, never stored.

Transitions (actor: G guest, O operator, S system):

| From                                          | To                                                   | Actor                                         | Notes                                   |
| --------------------------------------------- | ---------------------------------------------------- | --------------------------------------------- | --------------------------------------- |
| (new)                                         | requested                                            | G, O                                          | above online max / request mode         |
| (new)                                         | pending_payment                                      | G                                             | policy requires payment                 |
| (new)                                         | booked                                               | G, O, voice                                   | accepted                                |
| (new)                                         | seated                                               | O                                             | walk-in, waitlist seat                  |
| requested                                     | booked / pending_payment / declined                  | O                                             | approve re-validates                    |
| requested                                     | expired                                              | S                                             | deadline                                |
| pending_payment                               | booked                                               | S                                             | payment succeeded (re-validate if late) |
| pending_payment                               | expired                                              | S                                             | checkout expired                        |
| booked                                        | confirmed                                            | G, O                                          | reconfirmation                          |
| booked, confirmed                             | partially_arrived, arrived, partially_seated, seated | O                                             |                                         |
| partially_arrived                             | arrived, partially_seated, seated                    | O                                             |                                         |
| arrived                                       | partially_seated, seated                             | O                                             |                                         |
| partially_seated                              | seated                                               | O                                             |                                         |
| seated, partially_seated                      | finished                                             | O                                             |                                         |
| requested, pending_payment, booked, confirmed | cancelled                                            | G (before start), O, S                        |                                         |
| partially_arrived, arrived                    | cancelled                                            | O                                             |                                         |
| booked, confirmed                             | no_show                                              | O, S (opt-in, after `auto_no_show_after_min`) |                                         |
| no_show                                       | booked, seated                                       | O                                             | undo; re-validate                       |
| finished                                      | seated                                               | O                                             | undo within 30 min; re-validate         |
| seated                                        | arrived                                              | O                                             | undo seating                            |
| cancelled                                     | booked                                               | O                                             | reinstate; re-validate                  |

Side fields: `contact_status` (O, pre-arrival only), `running_late_min` (G via
manage link, O), `course_status` (O while seated; only when enabled).
`quickActionsFor(reservation, ctx)` derives list/floor/timeline buttons from
this table (e.g. booked -> Arrived, Seat, Confirm, Left message, No-show,
Cancel). Modify (time, date, party, area, duration) is not a status change: it
re-plans excluding the reservation's own occupancy and swaps atomically.

### 6.5 Policy and messages

`policy.ts`: `selectPolicy(config, service, experience, partySize)`,
`snapshotPolicy(policy, partySize, currency)`,
`cancellationTerms(snapshot, now, startAt)` ->
`{ free, feeMinor, refundMinor }`,
`noShowFee(snapshot, partySize, seatedCovers)`. `messages.ts`: `MESSAGE_KINDS`,
`scheduleFor(reservation, settings, tz)` -> `{ kind, channel, sendAt }[]` (quiet
hours move reminders earlier, skip if too near), `dedupeKey(...)`,
`channelsFor(region, settings, guest)` (SMS only when region is `us`,
`sms_opt_in`, phone present, switch on).

### 6.6 Schemas

`schemas/` exports strict Zod request and response schemas used by tenant-api
(validation), App (`*-types.ts` parse), Sites (client parse) and documented for
native: config DTOs, `DayFeed`, `ReservationOperatorView`,
`ReservationPublicView`, `HoldRequest/Response`, `BookRequest/Response`,
`ManageView`, `WaitlistJoin/Status`, `NotifyMeRequest`, `ExperiencePublic`,
`ReportResult*`, internal payloads (`managerAlertEventSchema`,
`reservationsContextSchema`, payment quote/bind/status), voice action inputs.
Error codes in `errors.ts` (`no_fit`, `slot_unavailable`, `hold_expired`,
`stale_version`, `idempotency_conflict`, `outside_horizon`, `large_party`,
`policy_required`, `rate_limited`, `not_found`, `unavailable`, ...).

---

## 7. tenant-api route surface

All responses `Cache-Control: private, no-store` unless an ETag response is
noted; errors `{ error: '<code>', ...extra }`; validation errors never echo
rejected values. Every operator route uses
`rsvGuard(scope, label, { all, write }, handler)` which runs token verification,
grant checks, impersonation write refusal, `locationIds` filtering
(`allowsLocation(id)`; empty list = nothing), `getTenantDb(orgId)`, and log-safe
500s.

### 7.1 Operator routes (`rate: /operator/* 120/min` existing)

`/operator/reservations/book/*` (scope `book`):

| Method + path                                                                                                                                                                            | Grant       | Purpose                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------- |
| GET `/day?locationId&date`                                                                                                                                                               | read        | day feed (ETag = `"<dayVersion>.<settingsVersion>"`, 304 on match)                     |
| GET `/changes?locationId&date&since=<dayVersion>`                                                                                                                                        | read        | cheap poll: `{ dayVersion, changed: bool }`                                            |
| GET `/availability?locationId&date&partySize&areaId?`                                                                                                                                    | read        | staff availability with warnings                                                       |
| GET `/calendar?locationId&month`                                                                                                                                                         | read        | per-day covers/parties/closed                                                          |
| GET `/overview?locationId&date&serviceId?`                                                                                                                                               | read        | pre-service brief                                                                      |
| GET `/guests/lookup?q`                                                                                                                                                                   | read        | ≤ 10 guest summaries for booking                                                       |
| POST `/reservations` (Idempotency-Key)                                                                                                                                                   | update      | phone/host booking; `overbook` explicit                                                |
| GET `/reservations/:id`                                                                                                                                                                  | read        | detail                                                                                 |
| PATCH `/reservations/:id`                                                                                                                                                                | update      | modify (expectedVersion)                                                               |
| POST `/reservations/:id/status`                                                                                                                                                          | update      | transition `{ to, expectedVersion, tableIds?, reason? }`                               |
| POST `/reservations/:id/assign`                                                                                                                                                          | update      | `{ tableIds, comboId?, lock, overbook?, expectedVersion }` -> `{ reservation, moves }` |
| POST `/reservations/:id/contact-status`, `/course-status`, `/notes`                                                                                                                      | update      | side fields                                                                            |
| POST `/reservations/:id/approve`, `/decline`                                                                                                                                             | update      | large-party requests                                                                   |
| POST `/reservations/:id/resend`                                                                                                                                                          | update      | resend confirmation                                                                    |
| GET `/reservations/:id/events`                                                                                                                                                           | read        | change history                                                                         |
| POST `/walk-ins` (Idempotency-Key)                                                                                                                                                       | update      | seat now                                                                               |
| POST `/blocks`, DELETE `/blocks/:id`                                                                                                                                                     | update      |                                                                                        |
| PUT `/service-notes`                                                                                                                                                                     | update      |                                                                                        |
| GET/PUT `/sections/assignments?locationId&date&serviceId`                                                                                                                                | read/update | servers per section                                                                    |
| `/waitlist/*` sub-router (requires `features.waitlist`): GET `/?locationId&date`, GET `/quote`, POST `/` (Idempotency-Key), PATCH `/:id`, POST `/:id/notify`, `/:id/seat`, `/:id/status` | read/update |                                                                                        |

`/operator/reservations/guests/*` (scope `guests`): GET `/?q&tag&sort&cursor`,
GET `/:id` (profile + history), PATCH `/:id`, POST `/:id/tags`, POST/DELETE
`/:id/notes`, POST `/merge { keepId, mergeId, expectedVersions }`, GET
`/:id/export` (JSON; allergy excluded unless `includeSensitive` + update grant),
POST `/:id/erase` (anonymize, cancel future with notification), GET/ POST/PATCH
`/tags`.

`/operator/reservations/setup/*` (scope `setup`): GET/PUT
`/locations/:id/settings`; GET `/locations/:id/floor-plan`, PUT
`/locations/:id/floor-plan { floorPlanVersion, areas, tables, combos, elements }`
(atomic Save, returns conflicts: future reservations on removed or shrunk
tables, which become unassigned + reflowed); CRUD `/services`, `/turn-times`,
`/pacing`, `/special-days`, `/service-availability`, `/policies` (money kinds
need `features.payments`), `/sections/layouts`, `/message-texts`, `/experiences`
(+ schedules; needs `features.experiences`); GET `/locations/:id/conflicts`;
POST `/locations/:id/rederive-times`; GET `/locations/:id/validate`.

`/operator/reservations/reports/*` (scope `reports`): GET
`/summary?locationId&from&to` (covers/parties by service, source, party-size),
`/no-shows`, `/cancellations`, `/turn-times` (actual vs configured by party
bucket), `/waitlist` (quoted vs actual), `/pacing`; aggregates only; each run
writes `rsv_audit_log` `report.run`.

`/operator/reservations/payments/*` (scope `payments`): GET `/reservations/:id`
(payment rows), POST `/reservations/:id/fee { kind, expectedVersion }` (creates
`fee_pending`; App executes, section 12), POST
`/reservations/:id/refund { amountMinor? }`.

### 7.2 Public guest routes (`/reservations/*`)

Org resolution: `Origin` (plus query/body `slug`/`host` only outside production,
never a body/query `orgId`), via a new `org-router.ts` branch placed before the
generic `?orgId=` fallback, like `/careers/`. Every route requires an active,
published, provisioned org in this node's region, master flag and the route's
child flags, the location `enabled` (and `online_enabled` for booking), and the
`RESERVATIONS_PUBLIC_ENABLED` switch; otherwise uniform `404 not_found` (503
when the switch is off or context is unavailable). Customer JWT
(`Authorization: Bearer`, audience `tenant-api`) is optional; an invalid or
cross-org token is rejected (not ignored). Capability tokens travel in
`X-Reservation-Token` so a customer JWT can coexist.

| Route                                                                      | Limits (in-memory per IP / durable)                                  | Notes                                                                                                                                                                                           |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET `/config`                                                              | 120/min                                                              | bookable locations (id, name, address, tz), party limits, horizon, areas when selectable, large-party mode/contact, waitlist/notify flags, public notes, occasion/dietary chips                 |
| GET `/availability?locationId&date&partySize&areaId?&experienceId?`        | 60/min                                                               | `{ dayVersion, timeZone, slots, alternatives, largeParty?, closed?, notifyMe, waitlist }`; ETag; `Cache-Control: private, max-age=0`                                                            |
| GET `/calendar?locationId&partySize&from&to`                               | 30/min                                                               | ≤ 62 days                                                                                                                                                                                       |
| POST `/holds`                                                              | 10/min; durable 10 per IP hash per 10 min, ≤ 300 active per org      | Turnstile `reservation-hold` (or verified customer JWT), honeypot, `replaceHoldToken` releases the previous hold; returns `{ holdToken, expiresAt, slot, policy?, requiresPayment? }`           |
| DELETE `/holds`                                                            | 30/min                                                               | release (token)                                                                                                                                                                                 |
| POST `/` (Idempotency-Key)                                                 | 10/min; durable per phone `max_active_per_phone`, 20/day per IP hash | `{ holdToken, guest, occasionTagId?, requests?, dietary?, areaPref?, smsOptIn, marketing?, policyAccepted: { termsVersion }, locale, website }` -> `201 { reservation, manageToken, payment? }` |
| POST `/requests` (Idempotency-Key)                                         | 5/10 min                                                             | large-party request; Turnstile `reservation-request`                                                                                                                                            |
| GET `/manage`                                                              | 60/min                                                               | view by `X-Reservation-Token`                                                                                                                                                                   |
| GET `/manage/availability`                                                 | 30/min                                                               | modify search excluding own occupancy                                                                                                                                                           |
| POST `/manage/modify`, `/manage/cancel`, `/manage/confirm`, `/manage/late` | 30/hour per token (durable)                                          | POST only; never GET mutations                                                                                                                                                                  |
| GET `/manage/calendar.ics`                                                 | 30/min                                                               | add-to-calendar                                                                                                                                                                                 |
| GET `/mine`                                                                | 60/min                                                               | customer JWT; upcoming/past with a derived manage token each                                                                                                                                    |
| GET `/experiences`, GET `/experiences/:slug`                               | 120/min                                                              | public, non-PII (Sites SSR may call it)                                                                                                                                                         |
| POST `/notify-me`                                                          | 5/10 min; ≤ 5 active per contact                                     | Turnstile `reservation-notify`; returns cancel token                                                                                                                                            |
| POST `/notify-me/cancel`                                                   | 30/hour                                                              | token                                                                                                                                                                                           |
| POST `/waitlist/join` (Idempotency-Key)                                    | 5/10 min; one active per phone per location per day                  | Turnstile `waitlist-join`; requires `waitlist_online`; returns status token                                                                                                                     |
| GET `/waitlist/status`                                                     | 120/min                                                              | position, quote, state                                                                                                                                                                          |
| POST `/waitlist/status/leave`, `/on-my-way`                                | 30/hour                                                              |                                                                                                                                                                                                 |

Capability tokens (`lib/reservations-tokens.ts`):
`token = base64url(HMAC(AUTH_HMAC_SECRET, '<purpose>:<orgId>:<id>:<version>'))`
(purposes `rsv-manage`, `rsv-hold`, `rsv-pay`, `rsv-waitlist`, `rsv-notify`),
store `sha256(token)`, compare with `timingSafeEqualString`. Holds use a random
128-bit token instead (no id exists yet). Manage tokens are valid until 7 days
after the reservation's business date and rotate on operator request. Manage
views show first name, date/time, party, location, status, occasion, the guest's
own requests, policy terms and payment status; never the phone/email in full
(masked), staff notes, tags or table.

### 7.3 Internal and system routes

| Route                                                                                       | Auth                                         | Purpose                                                                                                                        |
| ------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| POST `/internal/reservations/summary`                                                       | `INTERNAL_COMMAND_TOKEN`, body `orgId`       | counts for region switch                                                                                                       |
| POST `/internal/reservations/location-summary`                                              | same                                         | counts for location deletion                                                                                                   |
| POST `/internal/reservations/context-changed`                                               | same                                         | drop cached context                                                                                                            |
| POST `/internal/reservations/erase-customer`                                                | same                                         | when a tenant customer is erased: unlink guests, keep anonymized history                                                       |
| POST `/api/reservations/tick`                                                               | same, body `{ orgId? }` (none = fan out)     | regional tick                                                                                                                  |
| POST `/api/reservations/payments/quote`, `/bind`, `/status`, `/fee-quote`, `/refund-result` | same                                         | App payment broker (section 12)                                                                                                |
| POST `/api/voice/actions/:name`                                                             | `VOICE_AGENT_TOKEN`, body `orgId` + `callId` | generic vertical actions; reservations registers `reservations.availability`, `reservations.book`, `reservations.link-payload` |

`org-router.ts` branches: `/internal/reservations/*`, `/api/reservations/*` and
`/api/voice/actions/*` -> `orgIdFromJsonBody`; `/reservations/*` -> Origin
binding; operator audience added. Routing tests:
`src/lib/reservations-routing.test.ts` (public never routes on client orgId;
unknown origin -> null).

---

## 8. Write path and concurrency

`lib/reservations-write.ts`:

```ts
withReservationWrite(ctx, { locationId, dates }, fn) =
  // 1. outside the lock: context facts, Turnstile, request hash, token parsing
  runExclusive(orgId, () => retryOnSqliteBusy(() => db.transaction(async (tx) => {
    await sweepExpired(tx, now)            // holds, pending payments, requests, waitlist offers
    const replay = await checkIdempotency(tx, scope, key, hash); if (replay) return replay
    const day = await loadDayState(tx, locationId, dates, now)  // fresh, inside the tx
    const result = await fn(tx, day)       // re-validate with the engine + write rows
    await bumpDayVersions(tx, locationId, affectedDates)
    await appendEvents(tx, ...); await enqueueMessages(tx, ...); await storeIdempotency(tx, ...)
    return result
  })))
  // 3. after commit: drop day cache, best-effort immediate message send (bounded,
  //    outside the lock), notify-me dirty flag, journey triggers
```

- No network I/O inside the transaction (the DO yields at every await).
- `runExclusive` from `lib/concurrency.ts` serializes per org in-process; the DO
  is single-instance per org; on Node, SQLite locking + `retryOnSqliteBusy`
  covers other processes.
- Expected-version checks on every operator mutation: mismatch ->
  `409 stale_version` with the fresh row; idempotent-by-nature transitions (seat
  when already seated) succeed.
- Hold conversion: `hold_id UNIQUE` + status trigger; a valid hold wins against
  everything except a staff overbook; conversion re-validates rules
  (pacing/blocks may have changed) and on failure returns `409 slot_unavailable`
  with alternatives.
- Late payments: payment success after hold/payment expiry re-runs the plan; if
  it fits, book; otherwise `payment_status = review`, auto-refund request, guest
  message, manager alert.
- Overlap trigger is the safety net; a trigger abort maps to `409 conflict` and
  is logged as an engine bug metric.
- Day cache: in-memory `Map<orgId:locationId:date, { version, state }>`; a read
  compares the persisted `rsv_day_versions.version` (one indexed lookup), so it
  is exact on both runtimes.
- Polling: the day feed and public availability return
  `ETag: "<dayVersion>.<settingsVersion>"`; `If-None-Match` -> 304 with no body;
  `/changes` is the cheapest probe.

---

## 9. Scheduled work and notifications

### 9.1 Generalized org alarm

New `apps/tenant-api/src/lib/org-alarm.ts`:

```ts
type OrgTickModule = {
  name: 'staff' | 'reservations'
  tickPath: string                         // '/api/staff/tick', '/api/reservations/tick'
  isActivityPath(pathname: string): boolean
  run(orgId: string, now: number): Promise<{ needsFollowUp: boolean; nextDueAt?: number | null }>
}
registerOrgTickModule(module)
armOrgAlarm(storage, orgId, now, dueAt?)  // moves an alarm only earlier; clamps to [now+30s, now+60min]
handleOrgAlarm({ storage, now, modules }) // runs every module, per-module failure
                                          // counters 'tickFailures:<name>', re-arms at
                                          // min(nextDueAt) or interval while any needsFollowUp
```

- `staff-alarm.ts` keeps its exports (tests stay) and its logic becomes the
  staff module adapter; storage key `staffTickOrgId` is read as a fallback for
  the new `orgAlarmOrgId`.
- `workers/tenant-org.ts`: `maybeArmStaffAlarm` -> `maybeArmOrgAlarm` checks
  every module's activity path and parses `needsFollowUp`/`nextDueAt` from
  either tick path; `alarm()` -> `handleOrgAlarm`.
- Workers edge: `handleStaffTickFanOut` generalized to `handleTickFanOut(path)`
  for `/api/reservations/tick`.
- Node: `startReservationsTickInterval()` (`RESERVATIONS_TICK_INTERVAL_SECONDS`,
  default 120, minimum 60, `0` off) in `src/index.ts`.
- jobs-cron: add `['Tenant reservations tick', invokeTenantReservationsTick]` to
  the hourly list in `apps/jobs-cron/src/index.ts` (no new cron slot).
- Holds, payments and offers expire lazily at read time, so the tick is about
  timeliness, never correctness.

### 9.2 Reservations tick (`services/rsv-tick-service.ts`)

`runReservationsTickForOrg(orgId, now)`: per-org lock (`busy`), skip with
`region_mismatch`, `no_reservations` (no settings rows), `flags_unknown` (sweeps
only). Tasks (`registerReservationsTickTask`), each bounded:

1. `expire_holds`, `expire_payments` (+ `checkout_expire` outbox),
   `expire_requests` (+ guest message).
2. `auto_no_show` (only locations with `auto_no_show_after_min`; never charges
   fees).
3. `waitlist_offers` (notified past deadline -> `no_response`).
4. `notify_me_match` (dates with `availability_increased_at`; recompute; notify
   FIFO first 3 per slot, next batch after 15 min; expire past range).
5. `deliver_messages` (due `pending`, ≤ 100 per tick, re-check eligibility and
   `schedule_version` before sending; retry 1, 5, 30 min, then `failed`).
6. `deliver_outbox` (manager alerts ≤ 50 groups, refund requests, checkout
   expiry to App; retry statuses 401/408/425/429/5xx).
7. `purge` (idempotency > 48 h, rate counters > 2 days, released/expired holds
   > 7 days).
8. `reoptimize` (later slice; future dates only; time-budgeted).

Returns `{ counts, needsFollowUp, nextDueAt }` (min of next message `send_at`,
next payment/request/offer deadline, next auto no-show).

### 9.3 Guest messages

Kinds: `confirmation`, `modification`, `cancellation_guest`,
`cancellation_restaurant`, `reminder`, `reconfirm_request`, `request_received`,
`request_approved`, `request_declined`, `payment_required`, `payment_received`,
`refund_issued`, `fee_charged`, `waitlist_joined`, `waitlist_ready`,
`notify_available`. All `transactional`; marketing goes only through journeys
(section 13.3).

- Enqueued inside the write transaction; immediate kinds sent right after commit
  (best effort), scheduled kinds by the tick. Modify bumps `schedule_version`
  and cancels pending rows of the old version.
- Email: `lib/reservations-email.ts`, plain HTML strings (no React in the DO),
  EN and AR (`dir="rtl"`), every value escaped, hex colors and logo from the
  context `emailTheme`, location name/address/phone, manage link
  `<siteOrigin>[/ar]/reserve/manage#t=<token>`, add-to-calendar link, the
  operator's `custom_note`. Guest locales other than `ar` fall back to `en`.
  Sent with `sendTenantEmail` (no marketing context).
- SMS: `lib/reservations-sms.ts` wraps `@repo/sms` only when
  `getNodeRegion() === 'us'`, the guest opted in, and the switch is on; short
  EN/AR texts with the manage link. KSA: email + status pages only; no error to
  the guest. Quiet hours 21:00-08:00 location time for scheduled kinds.
- Kill switches (read live from `process.env`; dropped, not held):
  `RESERVATIONS_EMAIL_ENABLED`, `RESERVATIONS_SMS_ENABLED`,
  `RESERVATIONS_PUBLIC_ENABLED` (503 on every public route; operator routes
  unaffected). Add to `apps/tenant-api/.env.schema` and the AGENTS.md env list.
- Manager alerts: `rsv_outbox` -> App `/resources/reservations/notify` (in-app
  `Notification` + optional email; preferences; idempotent per event).

---

## 10. Operator App

### 10.1 Access layer

`apps/app/app/utils/reservations/`: `access.server.ts`
(`getReservationsFeatureState`, `requireReservationsFeature` -> 404,
`requireReservationsAccess(request, orgSlug, { feature, anyOf, locationId? })`
-> member, flag 404, permission 403, location 403; returns ids only),
`sections.ts` (`RESERVATIONS_SECTION_REQUIREMENTS`), `nav.ts`, `token.server.ts`
(`mintReservationsToken`, `SCOPE_POLICIES` folding features),
`reservations-client.ts` (in-memory token pool per scope, refresh 60 s early,
shared in-flight mint, one retry on 401, `cache: 'no-store'`), `*-api.ts`,
`*-types.ts` (Zod from `@repo/reservations`), `*-view.ts` (pure, tested),
`errors.ts` (code -> Lingui message), `role-presets.ts`,
`region-guard.server.ts`. Hooks: `use-reservations-client.ts`
(`useReservationsClient(scope)`, `useReservationsQuery`),
`use-reservations-action.ts` (expectedVersion, toast, reload on stale),
`use-day-feed.ts` (ETag polling with `useVisiblePolling`, pauses during drags
and open sheets, `useLiveNow` with server offset for timers).

### 10.2 Route map (`apps/app/app/routes/_app+/$orgSlug_+/reservations+/`)

| File                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Screen                                                                                                                                                                       | Requirement                   | Loader returns                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------ |
| `_layout.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                         | guard, `ReservationsClientProvider`, location picker (hidden with one location)                                                                                              | master + any section          | orgSlug, locations `{ id, name, timeZone }`, features, `can` flags       |
| `_index.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                          | redirect to first allowed section                                                                                                                                            |                               |                                                                          |
| `token.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `GET ?scope=` mint, `private, no-store`                                                                                                                                      | per scope                     | `{ jwt, tenantApiUrl, scope, grants, locationIds, features, expiresAt }` |
| `today.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                           | host stand: list (Upcoming/Seated/Finished/Waitlist tabs, counters, quick actions) + floor/timeline toggle, unassigned and conflict panel, walk-in and phone booking buttons | read reservation              | ids/flags only                                                           |
| `book.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                            | reservation list by date/service, search, filters, phone booking sheet                                                                                                       | read reservation              | same                                                                     |
| `timeline.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                        | tables × time Gantt, drag to move/reassign (Assign vs Lock prompt), resize duration, click empty cell to book, unassigned lane on top, pacing strip                          | read (write to drag)          | same                                                                     |
| `calendar.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                        | month view of covers/parties, special days                                                                                                                                   | read                          | same                                                                     |
| `floor.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                           | live floor plan: tables by status with timers, drag party or waitlist card onto a table to seat, section overlay, server assignment                                          | read                          | same                                                                     |
| `overview.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                        | service overview / pre-service brief, service notes                                                                                                                          | read                          | same                                                                     |
| `waitlist.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                        | waitlist with quotes, notify, seat                                                                                                                                           | read + `waitlist`             | same                                                                     |
| `guests.tsx`, `guests_.$guestId.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                  | Guestbook list and profile (history, tags, notes, merge, export, erase)                                                                                                      | read guest                    | ids only                                                                 |
| `experiences.tsx`, `experiences.$experienceId.tsx`, `experiences.new.tsx`                                                                                                                                                                                                                                                                                                                                                                                             | Experiences                                                                                                                                                                  | settings + `experiences`      | ids, currency                                                            |
| `reports.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                         | reports (charts via `@repo/ui/chart`)                                                                                                                                        | report                        | ids                                                                      |
| `settings.tsx` (tabs) + `settings._index.tsx` (general, online booking, policies link), `settings.floor-plan.tsx` (full-screen editor, explicit Save, `floorPlanVersion` check), `settings.tables.tsx` (areas, tables, combinations list), `settings.services.tsx` (services, turn times, pacing, service availability), `settings.special-days.tsx`, `settings.policies.tsx` (`payments`), `settings.messages.tsx`, `settings.sections.tsx`, `settings.waitlist.tsx` | setup                                                                                                                                                                        | read settings (write to save) | ids, location facts, `tzMismatch` hint not needed (client fetches)       |

Reservation detail is a `Sheet` opened by `?r=<id>` (no route-based dialogs, ADR
023). All guest data is fetched in the browser. `shouldRevalidate` returns false
within the org. Every loader/action awaits `requireReservationsAccess` first; no
`clientLoader`/`clientAction`.

Polling: host stand and floor 5 s (ETag), book and timeline 10 s, waitlist 5 s,
calendar and overview 60 s, Guestbook and settings none. Timers update every 15
s.

UI building blocks: timeline and drag/drop modeled on
`components/staff/schedule/day-timeline.tsx` and `schedule-dnd.tsx` (dnd-kit,
keyboard sensor, localized announcements, CSS-var logical positioning); floor
plan as DOM/SVG absolutely positioned tables (inline
`left/top/width/height/transform` are lint-allowed), dnd-kit with grid snap,
custom resize/rotate handles, arrow-key nudge; room geometry stored and drawn
canonical (not mirrored in RTL), surrounding chrome mirrored; section colors
from theme-token keys (`PositionDot` palette); status colors from permitted
palettes. Lingui `t`/`Trans` everywhere; `npm run lingui:extract -w app` and
Arabic `msgstr` filled.

---

## 11. Sites

- Pages: `src/pages/reserve/index.astro` (flow), `reserve/manage.astro`
  (fragment `#t=`), `reserve/waitlist.astro` (join and status `#t=`),
  `experiences/index.astro`, `experiences/[slug].astro`. Locale prefixes
  (`/ar/reserve`) work through the existing middleware rewrite.
- Gate: SSR calls App `/resources/sites/reservations` (404 -> CMS page named
  `reserve` or 404, like careers). Experience pages SSR-fetch the public,
  non-PII `GET {tenantApi}/reservations/experiences` (FormBlock precedent: 3 s
  timeout, short cache). No guest data is fetched or rendered server-side.
- Routing and caching: `isSitesReservationsRoute` in `src/lib/site-headers.ts`
  added to `isSitesAppRoute`; `no-store` for `/reserve*`; experiences pages
  `max-age=60`. `SITE_LINK_RESERVED_PATHS` gains `reserve`, `experiences`.
- Flow (client module `src/lib/reservations/*`, components in
  `src/components/reservations/*`): location -> party size -> date (calendar
  summary) -> time chips with seating-area labels -> nearby alternatives, other
  dates, "Notify me", "Join waitlist" (same day) -> hold with countdown (reuse
  `lib/ordering/hold-timer.ts`, `countdown.ts`) -> details (name, phone, email,
  occasion chips, requests, dietary chips + notes, seating preference, SMS
  opt-in, marketing opt-in, policy text + consent) -> payment step when required
  (redirect via Sites `/api/reservations/payment` -> App, opaque refs only) ->
  confirmation (code, add-to-calendar via `lib/ordering/calendar.ts`, manage
  link; manage token kept in `sessionStorage` and the URL fragment, never sent
  to Sites).
- Signed-in customers (tokens in `localStorage` via `client-auth.ts`) get
  prefilled details and `customer_id` binding; `profile.astro` gains an
  "Upcoming reservations" panel from `/reservations/mine`.
- Block: `src/components/blocks/ReservationBlock.astro` registered in
  `RenderBlocks.astro`: compact party/date/time bar that either mounts the same
  client inline or links to `/reserve?location=&party=&date=&time=`.
- i18n: six locales (`en, ar, es, fr, de, zh`) via Lingui `msg` in
  `src/locales/*.po`, non-empty translations required (ordering rule), labels
  passed to scripts via a JSON label block; RTL for `ar`; times in restaurant
  local time with the zone shown when the visitor's zone differs.
- Turnstile: `PUBLIC_TURNSTILE_SITE_KEY` widget with actions `reservation-hold`,
  `reservation-request`, `reservation-notify`, `waitlist-join`; honeypot field
  `website`.
- Regional URL: existing `data-tenant-api-url` on `<html>`
  (`getTenantApiUrl(dataRegion)`), read by `getBrowserTenantApiUrl()`; CSP
  `connect-src` already includes US and KSA tenant-api. Which locations and
  experiences are bookable comes from `GET /reservations/config` and
  `/reservations/experiences` in the browser.

---

## 12. Payments (responsibilities and flows)

Principles: the regional API is authoritative for amounts, state and capacity;
the App is the only component that talks to providers; the App never receives
guest PII (the guest enters card and email on the provider page). Pattern =
ordering's quote -> bind -> status
(`apps/app/app/utils/restaurant-orders/checkout.server.ts`,
`routes/order-system.ts`).

1. **Deposit / prepayment at booking** (policy `deposit`/`prepay`, experiences
   prepay): booking creates `pending_payment`, extends the hold to
   `payment_hold_minutes`, returns `{ reservationId, paymentToken }`. Browser ->
   Sites `/api/reservations/payment` -> App
   `/resources/sites/reservation/checkout` -> regional
   `/api/reservations/payments/quote` (amount, currency, expiry, processor) ->
   App creates hosted checkout (metadata
   `{ type: 'reservation_payment', orgId, reservationId, kind }`, deterministic
   provider idempotency key) -> regional `/bind` (once) -> redirect.
   Webhook/status -> App dispatcher (`payment-webhooks.server.ts`, new metadata
   type) -> regional `/status` (succeeded -> `booked` + confirmation; expired ->
   `expired`; late success -> section 8 rule). `TODO(payments)`: Stripe Connect
   session parameters, Checkout.com equivalent, statement descriptor, SAR
   handling.
2. **Card guarantee** (policy `card_guarantee`): same flow in setup mode; the
   regional record stores only an opaque payment-method reference and provider
   customer ref. `TODO(payments)`: SetupIntent/Checkout `mode: 'setup'` on the
   connected account, `setup_intent.succeeded` webhook, Checkout.com
   card-on-file, mada for KSA.
3. **No-show / late-cancel fee**: never automatic. Operator with
   `update:reservation_payment` -> regional `/payments/reservations/:id/fee`
   (creates `fee_pending`, audited) -> App action (`reservations+/...` payments
   action, guarded) -> regional `/fee-quote` -> App off-session charge with
   idempotency key -> regional `/status` (`fee_charged` / `fee_failed` with
   code; failure may email the guest a pay link). `TODO(payments)`: off-session
   confirmation, SCA handling.
4. **Refunds**: regional decides (cancellation terms from the snapshot,
   restaurant cancel = full) and enqueues `refund_request` in `rsv_outbox`; the
   tick calls App `/resources/reservations/payments`; App refunds with key
   `refund:<reservationId>:<n>` and reports via `/refund-result`.
   `TODO(payments)`: partial refunds, disconnected provider account.
5. **Capability gating**: context `payments.deposit|guarantee` reflects
   processor support (Stripe Connect US only, Checkout.com any region); policies
   of unsupported kinds cannot be saved; booking fails closed if the processor
   became unavailable (`policy_unavailable`).

---

## 13. Integrations (contract level)

### 13.1 Phone agent

- Core: add generic
  `callAction(name: string, input: unknown): Promise<{ ok: true; data: unknown } | { ok: false; reason: string; explanation: string }>`
  to `VerticalServices` in `packages/phone-agent/src/vertical.ts`; the voice
  worker (`apps/voice-agent/src/services.ts`) POSTs `/api/voice/actions/:name`.
  No reservation words in core (vocabulary test).
- tenant-api: `routes/voice-actions.ts` with a registry
  `registerVoiceAction(name, { schema, run })`;
  `src/restaurant/reservations-voice.ts` registers `reservations.availability`
  (date, party, time window -> slots), `reservations.book` (slot + caller name +
  phone captured unverified, `channel = voice_agent`, guest-channel limits,
  confirmation SMS/email) and `reservations.link-payload` (prefill for
  `/reserve`), registered in both `src/index.ts` and `workers/index.ts`. Each
  re-checks `reservations.voice` and the location setting through the context
  cache.
- `packages/phone-agent-restaurant`: tools `check_table_availability`,
  `book_table`, `send_booking_link` (uses `sendLink` to `/reserve` with a
  prefill payload); prompt switches from "request capture" to booking when the
  tools are enabled; the existing `record_request` path remains the fallback.
  Caller ID never identifies or authorizes a guest (no modify/cancel by phone).
  US only (voice worker is US).

### 13.2 Staffing labor forecast

Add a generic, multi-source **demand signal** seam next to
`services/order-source.ts`:
`registerDemandSignal({ key, unit: 'count' | 'people', loadBooked(db, scopeId, window) -> { date, hour, count }[] })`
and let the forecast and schedule demand strip show each registered signal, with
optional per-position standards per signal (`people per labor hour`).
`src/restaurant/reservations-demand-source.ts` registers `booked_guests` (sum of
`party_size` of capacity-consuming reservations by local hour; `scopeId` =
location id). Counts only. Staffing core keeps its vocabulary
("guests"/"people", not "covers"). This is a staffing change; schedule it late
and keep it behind both modules being on.

### 13.3 Journeys

Add trigger types `reservation_booked`, `reservation_completed`,
`reservation_no_show`, `reservation_cancelled` to the TypeScript enum on
`marketing_journeys.trigger_type` and labels in
`packages/marketing-workflow/src/workflow-labels.ts`. Emitted after commit from
`src/restaurant/reservations-journeys.ts` via
`evaluateAndSpawnTriggers(orgId, type, customerId, ...)` with
`contextData { reservationId, locationId, partySize, businessDate, serviceId }`,
only when the reservation has a verified `customer_id` (journeys require it).

### 13.4 Reports and dashboard

- Module reports: fixed aggregate endpoints (section 7.1) rendered in
  `reports.tsx`.
- Generic reports: `packages/reports/src/catalog-reservations.ts` subjects
  `reservations` (one row per reservation: date, service, party, status,
  channel, source, duration, tables count; no contact data) and
  `waitlist_entries`; access in
  `apps/app/app/utils/reservations/report-access.server.ts`; regional loaders
  `services/rsv-report-records.ts` with location scope and audit. Dashboards get
  them through the generic `report` block.
- `reservations-today` built-in dashboard block: browser-direct with a `book`
  token (read grant): today's covers/parties by service, next arrivals (first
  name + time + party), waitlist count; hidden via `hiddenBlockIds` unless
  flag + permission.

### 13.5 Native apps (`TODO(native)` for UI)

Native clients send the site origin as `Origin` and use the same public routes:
`/reservations/config`, `/availability`, `/calendar`, `/holds`,
`POST /reservations` (`channel` recorded as `native` from a header
`X-Client: ios|android`), `/manage/*`, `/mine` (customer JWT), `/experiences`,
`/waitlist/*`, `/notify-me`. Turnstile is not available natively: a valid
customer access token substitutes for Turnstile on `/holds`, `/requests`,
`/waitlist/join` and `/notify-me` (so native booking requires phone-OTP
sign-in). Manage tokens live in the Keychain / Keystore.

---

## 14. Security and testing gates

1. **`apps/tenant-api/src/routes/reservations-security.test.ts`** (modeled on
   `staffing-security.test.ts`): enumerates every route of the six operator
   routers; each returns 401 without a token, with a wrong secret/audience
   (including a staffing token and a `tenant-api-operator` token), 403 for a
   grantless token in every `RESERVATIONS_SCOPES` value, 403 for a token of the
   wrong scope, never 5xx; pins the mounts in `app.ts` and refuses any other
   `/operator/reservations` mount; requires each router's tests to contain
   cross-org (`ORG_B`) and cross-location (`locationIds`) cases and each route's
   tail segments; public surfaces never return 2xx without Origin binding
   (except an explicit `PUBLIC_ON_PURPOSE` list: `/reservations/config`,
   `/availability`, `/calendar`, `/experiences*` still require Origin), never
   5xx other than 503; forged, cross-org, expired and rotated capability tokens
   -> 404. Plus `reservations-mount.test.ts` and
   `src/lib/reservations-routing.test.ts`.
2. **`apps/app/app/utils/reservations/reservations-guards.test.ts`**: static
   check that every `reservations+/` loader/action awaits
   `requireReservationsAccess` (or a verified wrapper) first, nothing reads the
   body before it, no `clientLoader`/`clientAction`; resource routes matching
   `/^(reservations\.|sites\.reservation)/` call `requireInternalCommandAuth(`
   or a permission guard before any `db`/`fetch`.
3. **Domain property tests** (`packages/reservations`, fast-check): random floor
   plans, rules and operation sequences (search, hold, book, modify, cancel,
   seat, finish, no-show, block, settings edit, clock advance) assert invariants
   I1-I8 after every step; brute-force oracle (≤ 8 tables, ≤ 12 bookings) proves
   soundness and reports the false-negative rate; operation counts asserted for
   performance (120 tables, 80 combos, 900 bookings/day).
4. **DST and time tests**: `America/New_York` fall back **2026-11-01** (01:00-
   01:59 repeated: shown once, pacing once, 90-minute dinner at 01:15 ends at
   the second 01:45) and spring forward **2027-03-14** (02:00-02:59 skipped,
   03:00 once, service end in the gap resolves after it); also
   `America/Los_Angeles` same dates, `Europe/London` 2026-10-25 / 2027-03-28,
   `Asia/Riyadh` (no DST; services crossing midnight, Ramadan special days);
   business-date boundary at `day_start_min` ±1 minute; release time ±1 ms;
   reminders and quiet hours across DST.
5. **Database tests** (`packages/tenant-db/src/reservations-schema.test.ts`):
   overlap triggers (insert, update, overbook bypass, inactive rows ignored),
   append-only events and audit (redaction only), hold single conversion,
   checks, defaults; migrations on libsql; DO migrations regenerated.
6. **Concurrency tests** (tenant-api, real libsql files): N parallel books for
   the last table -> exactly one success; host move vs online booking; payment
   after hold expiry; tick sweep during booking; idempotent replay returns the
   same entity and token; stale version -> 409.
7. **Abuse tests**: honeypot answers like success, Turnstile required when
   configured, durable limits survive a new app instance, uniform 404s, manage
   routes reject GET mutations.
8. **E2E**: App Playwright specs insert `ConfigFlag` rows and stub
   `**/operator/reservations/**` (staffing pattern); Sites vitest for client
   modules and label completeness; a real-stack validation script (App :3001
   - tenant-api :3007 + Sites `http://acme.menuza.test:3008`) driven by
     agent-browser for the booking -> host stand loop, using
     `npm run seed:reservations -w tenant-api -- acme` (local only, idempotent,
     `--enable` writes flags to `data.db`; docs show the D1 insert for App dev).

---

## 15. Docs to write or update

- `docs/reservations.md`: operator guide and runbook (what is in it, flags
  table, permissions and presets, first day setup, kill switches, deploy order
  tenant-api first, symptoms table, region switch, KSA checklist, demo data, CI
  security checks, known gaps).
- `docs/decisions/048-reservations-data-residency.md`: ADR (placement, regional
  settings, browser-direct, public origin binding, guest identity without login,
  payments split, tick generalization, messaging regions, retention and erasure,
  flags, location scope reuse).
- `docs/reservations-contract.md`: public, operator, internal, voice and native
  API contract with schemas and error codes.
- `docs/reservations-plan.md`: design and per-slice build log.
- `AGENTS.md`: "Reservations module" section and env vars
  (`RESERVATIONS_EMAIL_ENABLED`, `RESERVATIONS_SMS_ENABLED`,
  `RESERVATIONS_PUBLIC_ENABLED`, `RESERVATIONS_TICK_INTERVAL_SECONDS`).
- `docs/permissions.md` (reservations permissions and flags),
  `docs/scheduled-jobs.md` (org alarm modules, reservations tick),
  `docs/tenant-data-residency.md` (guest data rules),
  `docs/phone-agent-verticals.md` (`callAction`), `apps/tenant-api/README.md`,
  `docs/staffing.md` (shared alarm, demand signals, location scope wording).

---

## 16. Suggested build order (vertical slices)

Each slice ends with something validated through a real surface.

| #   | Slice                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Depends on                   | Validated through                                                                               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------- |
| F0  | **Foundation**: ADR 048 draft; `@repo/zoned-time` extraction; `@repo/reservations` flags, permissions, token, time, config schemas, `validateConfig`, `resolveServices`, engine (availability, pacing, assignment, repair) and state machine with property/DST tests; control-plane migration 0025 + mirrors; tenant-db 0016 (all foundation tables + triggers) + schema tests; tenant-api auth/guard/http/context/write gate, routing branches, security sweep scaffold; App access layer, token route, client pool, guards test, nav, `_layout`; seed script skeleton | none                         | unit/property tests; App shows an empty Reservations section only when the flag is on (404 off) |
| S1  | **Setup**: settings, areas/tables/combos, floor-plan editor, services, turn times, pacing, service availability, special days, blocks, validate/conflicts                                                                                                                                                                                                                                                                                                                                                                                                               | F0                           | App Settings UI + tenant-api tests                                                              |
| S2  | **Reservation book core**: phone/host booking with auto-assign, walk-ins, list view, status lifecycle with quick actions, contact/course statuses, change history, unassigned/conflict list, staff overbook, guest records (create/lookup), region-switch and location-delete guards, guest erase/export endpoints                                                                                                                                                                                                                                                      | S1                           | App Book + Today list                                                                           |
| S3  | **Timeline and calendar**: timeline drag/move/Assign-vs-Lock/resize, reflow, calendar month view, service overview + service notes                                                                                                                                                                                                                                                                                                                                                                                                                                      | S2                           | App Timeline/Calendar/Overview                                                                  |
| S4  | **Live floor plan host stand + server sections**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | S2 (S3 for reflow)           | App Floor                                                                                       |
| S5  | **Public booking**: `/reservations/*` public routes, holds, booking, manage (view/modify/cancel/confirm/late, ics), `/mine`, large-party requests + operator approve/decline, Turnstile and durable limits, Sites `/reserve` + manage + Book a table block (App registration), six locales                                                                                                                                                                                                                                                                              | S2                           | Sites UI end to end, operator sees the booking within one poll                                  |
| S6  | **Messaging and tick**: org-alarm generalization, reservations tick, email EN/AR, SMS US, reminders, reconfirmation, request/expiry messages, kill switches, manager alerts, jobs-cron hook                                                                                                                                                                                                                                                                                                                                                                             | S5                           | dev mail/SMS mock logs + tick tests; staffing alarm tests unchanged                             |
| S7  | **Waitlist + notify-me**: operator waitlist with quotes, notify, seat; remote join + status page; notify-me matching                                                                                                                                                                                                                                                                                                                                                                                                                                                    | S6                           | App Waitlist + Sites waitlist page                                                              |
| S8  | **Guestbook CRM**: search, profiles, tags (VIP/allergy/regular), notes, visit stats, merge, export/erase UI                                                                                                                                                                                                                                                                                                                                                                                                                                                             | S2                           | App Guestbook                                                                                   |
| S9  | **Reports + dashboard block + report subjects**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | S2 (S7 for waitlist metrics) | App Reports and Home dashboard                                                                  |
| S10 | **Payments**: policies with money, deposits/prepay, card guarantee, fees, refunds (after the payments deep-dive)                                                                                                                                                                                                                                                                                                                                                                                                                                                        | S5, S6                       | Sites booking with Stripe test mode; App fee/refund actions                                     |
| S11 | **Experiences**: setup, public pages, experience availability, prepayment                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | S5 (S10 for prepay)          | App Experiences + Sites experiences pages                                                       |
| S12 | **Phone agent tools**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | S5, S6                       | voice-actions tests + browser test call                                                         |
| S13 | **Staffing forecast demand signal**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | S2                           | Staff schedule demand strip shows booked guests                                                 |
| S14 | **Journey triggers**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | S5                           | journey spawned on visit completed (tenant-api tests + App journeys UI)                         |
| S15 | **Native API readiness** (`X-Client`, customer-token substitute for Turnstile, contract doc)                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | S5, S7                       | API tests; native UI per the native deep-dive                                                   |
| S16 | **Background re-optimization + polish** (performance tests, docs completion)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | S3                           | perf counters, docs review                                                                      |

Parallelism: after F0, S1 must land first; then S3/S4/S8 can proceed in parallel
with S5; S6 unblocks S7/S10/S12; S9, S13, S14 are independent once their
dependencies land.

---

## 17. Open questions (recommendations included)

1. **Guest verification for online booking.** Booking without login is the
   decision; abuse controls are Turnstile, honeypot, durable limits and
   per-phone caps. Should a location be able to require phone OTP?
   _Recommendation:_ add `require_verified_phone` (default off; unavailable on
   KSA, which has no SMS); native booking already requires sign-in.
2. **Marketing journeys for guests without customer accounts.** Journeys need
   `customer_id`. _Recommendation:_ fire triggers only for verified customers;
   store the booking form's marketing opt-in on `rsv_guests` for staff and
   future use, and do not create `customers` rows from unverified phones.
3. **Master flag turned off with future bookings.** _Recommendation:_ master off
   hides everything (404) and stops messages, matching staffing; turning off
   only `reservations.online` stops new public bookings while manage links,
   reminders and operator tools keep working. Document "turn off online first,
   then cancel or export, then the master".
4. **Member location scope reuse.** _Recommendation:_ reuse
   `UserOrganization.locationScope`/`UserOrganizationLocation` for reservations
   (one "where this member works" setting) rather than adding a
   reservations-specific scope.
5. **Live updates.** _Recommendation:_ ETag polling (5 s host stand) now;
   WebSockets on the Durable Object plus a Node equivalent only if polling
   proves insufficient.
6. **No-show fees.** _Recommendation:_ always staff-confirmed (never automatic,
   even with auto no-show on), charged no earlier than the end of the service.
7. **Tz extraction.** _Recommendation:_ new `@repo/zoned-time` package (staffing
   re-exports) instead of importing `@repo/staffing` from reservations or adding
   a fourth tz implementation.
8. **Upstream template sync.** `PRODUCT.md` asks committed files to stay generic
   for the upstream template; this module is restaurant-specific by decision.
   _Recommendation:_ keep all of it in clearly named `reservations` paths (plus
   `restaurant/` adapters) so it can be excluded from upstream syncs as a unit.
9. **Operator-editable message templates.** _Recommendation:_ code-owned EN/AR
   templates with a per-kind custom note (as designed), not free-form template
   editing, until there is demand.
