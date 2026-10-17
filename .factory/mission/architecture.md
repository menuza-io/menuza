# Reservations module: architecture

Status: authoritative architecture for the Menuza Reservations mission.
Repository: `/Users/zama/menuza`, branch `pr/reservations`. Paths are relative
to the repository root unless they are absolute. The mission directory is
`/Users/zama/menuza/.factory/mission` (written `{missionDir}` below).

## How to use this document

- **Scope and milestones:** `{missionDir}/mission.md` decides what is built and
  in which milestone. When this document and `mission.md` disagree, `mission.md`
  wins; report the conflict instead of guessing.
- **Acceptance:** `{missionDir}/validation-contract.md` decides what "done"
  means for each milestone. This document says how to build it.
- **Reference:** `{missionDir}/library/*.md` holds distilled reference notes
  (for example `library/payment-mocks.md` for the emulators). The raw research
  is in `{missionDir}/research/`.
- **This document** is the single technical design: data model, routes, flows,
  invariants, gates and touchpoints. Each area names the milestone that builds
  it (milestone ids: `foundation`, `setup`, `reservation-book`, `host-stand`,
  `online-booking`, `guest-messages`, `waitlist`, `guestbook-reports`,
  `payment-mocks`, `payments-experiences`, `integrations`, `native-apps`).
- **Where the design is silent,** follow the Staff module's equivalent code
  (`docs/staffing.md`, `docs/decisions/047-staffing-data-residency.md`), then
  ask. Do not invent cross-plane data flows.
- Decisions taken while reconciling the draft and the deep-dives are listed with
  reasons in `{missionDir}/research/architecture-reconciliation-notes.md`.

## Table of contents

1. [Principles and invariants](#1-principles-and-invariants)
2. [Components and responsibilities](#2-components-and-responsibilities)
3. [Data placement](#3-data-placement)
4. [Regional data model](#4-regional-data-model)
5. [Control-plane changes](#5-control-plane-changes)
6. [Domain package API](#6-domain-package-api-reporeservations)
7. [tenant-api routes](#7-tenant-api-routes)
8. [Write path and concurrency](#8-write-path-and-concurrency)
9. [Scheduled work, messages and dev email capture](#9-scheduled-work-messages-and-dev-email-capture)
10. [Operator App](#10-operator-app)
11. [Sites](#11-sites)
12. [Payments](#12-payments)
13. [Payment mocks (summary)](#13-payment-mocks-summary)
14. [Integrations](#14-integrations)
15. [Native apps](#15-native-apps)
16. [Security and testing gates](#16-security-and-testing-gates)
17. [Environment variables and kill switches](#17-environment-variables-and-kill-switches)
18. [Docs to write or update](#18-docs-to-write-or-update)
19. [Milestone map](#19-milestone-map)
20. [Out of scope](#20-out-of-scope)
21. [Existing code touchpoints](#21-existing-code-touchpoints)
22. [Resolved design questions](#22-resolved-design-questions)

### Repo facts verified for this document

Workers do not need to re-check these.

- No `rsv_*` table, no `waitlist*` table and no `reservations.*` flag key exist
  yet. Tenant tables already in use include `restaurant_orders`,
  `restaurant_order_reservations` (order slot capacity, unrelated to table
  bookings), `customers`, `customer_subscriptions`, `marketing_journeys`,
  `journey_runs`, `voice_sms_sends`, `labor_scope_settings`.
- Latest migrations: control plane
  `packages/database/drizzle/0024_dashboards.sql`; tenant
  `packages/tenant-db/drizzle/0015_hiring_interested_scopes.sql`. The last ADR
  is `docs/decisions/047-staffing-data-residency.md`, so 048 is free.
- `ConfigFlag` (`packages/database/src/schema.ts:1317`) has `key`, `value`
  (JSON), `level` (`system` | `organization` | `user`), `organizationId`,
  `userId`. Its unique index includes nullable columns, so SQLite treats two
  system rows with the same key as distinct: seed with
  `INSERT ... SELECT ... WHERE NOT EXISTS`, never `INSERT OR IGNORE`.
  `getFeatureFlag` (`packages/common/src/feature-flags.server.ts`) resolves
  user, then organization, then system.
- The Admin flag editor (`apps/admin/app/components/admin/feature-flags.tsx`)
  already edits `number` values at system and organization level, but its
  Organization tab lists only keys that exist at system level, and it does not
  validate ranges.
- `NotificationPreference.workflow` is free text, so new manager-alert kinds
  need no migration.
- Location ids are cuid2 strings (`OrganizationLocation.id`). Member location
  scope exists: `UserOrganization.locationScope` (`all` | `selected`) and
  `UserOrganizationLocation` (migration `0023`), turned into a claim by
  `packages/staffing-restaurant/src/location-scope.ts` `locationIdsClaim`.
- `runExclusive`: `apps/tenant-api/src/lib/concurrency.ts` (use this one, not
  the copy in `order-service.ts`). `retryOnSqliteBusy`:
  `apps/tenant-api/src/lib/sqlite-retry.ts`.
- The Durable Object alarm is owned by staffing: `workers/tenant-org.ts`
  `maybeArmStaffAlarm` and `alarm()` -> `handleStaffAlarm` ->
  `runStaffTickForOrg`; arming rules in `src/lib/staff-alarm.ts`
  (`isStaffActivityPath`; `armStaffAlarm` never moves an existing alarm;
  5-minute interval; 6 failures). A Durable Object has exactly one alarm.
- The staffing demand seam is single-slot:
  `apps/tenant-api/src/services/order-source.ts` `registerOrderSource`, read by
  `forecast-service.ts`, `labor-data.ts` and
  `restaurant/staffing-report-catalog.ts`.
- `workers/org-router.ts` `orgIdFromOperatorJwt` accepts the audiences
  `tenant-api-operator` and `STAFFING_TOKEN_AUDIENCE`; public prefixes such as
  `/careers/` are routed from `Origin` before the generic `?orgId=` fallback.
- Voice: `VerticalServices` (`packages/phone-agent/src/vertical.ts`) exposes
  only `sendLink`. The worker client is `apps/voice-agent/src/services.ts`; its
  fakes are in `apps/voice-agent/src/test-fixtures.ts`. Voice routes are
  `apps/tenant-api/src/routes/voice.ts`, mounted at `/api/voice`, using
  `requireVoiceAgent` and `regionalOrganization`.
- Journeys: `JOURNEY_TRIGGER_TYPES` in
  `packages/tenant-db/src/types/journey.ts:22` plus a duplicate TypeScript enum
  on `marketing_journeys.trigger_type`
  (`packages/tenant-db/src/schema.ts:137-142`), no SQL CHECK.
  `evaluateAndSpawnTriggers`
  (`apps/tenant-api/src/services/journey-service.ts:929`) has no dedupe;
  `executeJourneyStep` (`:114`) does not check consent.
  `CUSTOMER_SUBSCRIPTION_TOPICS = ['drops']` and channels `['sms']` are
  TypeScript enums (`schema.ts:74-75`), no SQL CHECK.
- Reports: `packages/reports/src/catalog.ts`, `catalog-staffing.ts`;
  `RESTRICTED_REPORT_SUBJECTS` in `operator-token.ts:32`; App token route
  `reports+/token.ts`; tenant-api dispatch in `routes/analytics.ts`.
- Dashboards: `apps/app/app/utils/dashboards/config.ts` `BUILT_IN_BLOCK_TYPES`,
  `visibility.ts` `hiddenBlockIds`, `block-data.server.ts` (control plane only),
  `components/dashboard/blocks/report-block-result.tsx` (the browser-direct
  pattern).
- Website: `apps/app/app/utils/website/block-types.ts`,
  `website+/pages.$pageId.tsx`; `SITE_LINK_RESERVED_PATHS` in
  `packages/common/src/site-link.ts:65`.
- Sites: `src/lib/site-headers.ts` (`isSitesAppRoute`), `data-tenant-api-url` on
  `<html>` read by `getBrowserTenantApiUrl()`, reusable
  `src/lib/ordering/{hold-timer,countdown,calendar}.ts`;
  `order-client.ts:255-257` rejects non-https checkout URLs.
- Payments (App): `utils/restaurant-orders/payment-config.server.ts`
  `resolveRestaurantOnlinePayment` (`:46-77`); `checkout.server.ts`
  (`createRestaurantOrderHostedCheckout` `:324-484`, status `:515-604`);
  `payment-webhooks.server.ts`; webhooks `api+/stripe+/webhook.tsx` (one secret)
  and `api+/shop+/webhook.tsx` (`cko-signature`). Fees:
  `packages/payments/src/connect/shop-fees.ts` `SHOP_PLATFORM_FEE_PERCENT = 20`.
  `commerce.ts` `withConnect` (`:300-308`) flattens provider errors.
  Checkout.com order checkout uses Flow `paymentSessions.request`
  (`checkout-shop.ts:126-205`) and `restaurant.ts:155-182` requires
  `processing.payment_session_id`. The three US-only Checkout.com guards are
  `shop-card.tsx:78-84`, `settings+/shop.tsx:215-222`, `shop.server.ts:333-335`.
  `isConfiguredSecret` treats any value containing `***` as unconfigured.
- Email: tenant-api `src/lib/tenant-email.ts` `sendTenantEmail` ->
  `sendOciEmail` (`packages/email/src/oci/send-oci-email.ts:35-62`), which only
  logs `[OCI EMAIL MOCK] To|Subject` when OCI is not configured. App
  `packages/email/src/send-email.ts` sends through Resend; in Node with
  `MOCKS=true` MSW captures it into `packages/test-utils/fixtures/email/`; in
  Workers dev the Resend call fails. Precedent for a workerd dev-only fetch
  wrapper: `apps/app/workers/dev-s3-mock.ts`, guarded by
  `process.env.MOCKS !== 'true' || import.meta.env.PROD`. Staff email kill
  switch precedent: `apps/tenant-api/src/lib/email-switch.ts`.
- SMS: `@repo/sms` logs `[SMS MOCK]` without Twilio and refuses KSA production.
- CI runs the App with `start:mocks` and `NODE_ENV=production`, so a `NODE_ENV`
  check never proves "not production".
- Android: `HttpURLConnection` cannot send PATCH. Budget in
  `apps/android/size-budget.json`: APK 88,676 of 160,000 bytes, AAB 145,554 of
  220,000 bytes; measured with `scripts/size-report.mjs`.
- iOS: `swift test` passes (72 tests); `TenantAPIClient.swift` sends `Origin`;
  the transport seam is `HTTPTransport`.
- Seeds: `acme` (US, id `t58bgatqh3rv0s3movrecyj1`) and `riyadh-grill` (KSA, id
  `ru0dm42cud9scs4g2duep21c`, present in D1 only). KSA tenant DB dir
  `packages/database/db/ksa`. tenant-api env schema
  `apps/tenant-api/.env.schema`.
- `fast-check` is installed. `libphonenumber-js` is not;
  `apps/tenant-api/src/routes/auth.ts:95` has a local `normalizePhone`.

---

## 1. Principles and invariants

The module gives a restaurant organization an OpenTable-class reservation
system: per-location floor plans and availability rules, an availability engine,
guest booking on the published website and native apps, an operator reservation
book and live host stand, guest messages, waitlist and notify-me, the Guestbook
CRM, server sections, large-party requests, reports and a dashboard block,
deposits, prepayment, card guarantees, fees and refunds, Experiences, and
integrations (phone agent, staffing forecast, journeys).

It is built like the Staff module: organization flags that default off, role
permissions, every byte of guest data in the regional per-organization SQLite
behind `apps/tenant-api`, browser-direct operator calls with short-lived
App-minted tokens, public guest routes called from the visitor's browser with
the organization resolved from `Origin`, and CI gates that sweep every route.

### 1.1 Principles

1. **Residency first.** Guest names, phones, emails, notes, allergies, tags,
   visit history, waitlist entries and anything tied to a person live only in
   the regional tenant DB. The App, Sites SSR, D1, KV, logs, dashboards' server
   loaders and cross-plane payloads carry only ids, counts, money amounts and
   non-personal configuration.
2. **Regional is authoritative for bookings and their rules.** Settings, floor
   plans, policies, experiences and reservations share one database, so a
   booking and the rules it was checked against commit in one transaction.
3. **Restaurant vocabulary is allowed in this module** (tables, covers, floor
   plan, turn time, server section) and in `restaurant/` adapters. It stays out
   of `@repo/staffing`, `@repo/phone-agent` and their vocabulary tests. Dining
   periods are **services**, never "shifts".
4. **Pure domain core.** Rules, availability, assignment, the state machine,
   policy math, message schedules and time math live in `@repo/reservations`
   with an injected clock and no I/O, so they are property-tested and shared by
   tenant-api, App, Sites and (by contract) the native apps.
5. **Search is a hint; the write path decides.** Every capacity change
   re-validates inside one serialized transaction.
6. **Fail closed.** Unknown organization, wrong region, unprovisioned DB,
   missing or stale flags (for public writes), unreachable App context for
   public writes: refuse with uniform responses that do not reveal existence.
7. **Explicit over implicit.** Combinations are explicit table sets; overbooks
   are explicit and audited; editors (the floor plan) are drafts with an
   explicit Save; rule edits never silently rewrite existing bookings; fees are
   charged only by staff.
8. **Upstream-separable.** All code sits in clearly named `reservations` paths
   (plus `restaurant/` adapters and a few generic seams listed in section 21),
   so the module can be excluded from upstream template syncs as a unit.

### 1.2 Invariants (tested; see section 16)

- **I1 (seating).** Every reservation in a capacity-consuming status has either
  (a) active occupancy rows on concrete tables (one table or every member of one
  combination) covering `[start_at, end_at)`, or (b) `overbooked = 1` (an
  explicit, audited staff overbook, possibly unassigned), or (c) it belongs to a
  table-less Experience seating whose cover cap is enforced.
- **I2 (no double booking).** No two active, non-overbook occupancies on the
  same table overlap (half-open intervals). Enforced by the engine and by a
  database trigger as a safety net, including when requests race.
- **I3 (online never borrows).** Guest-channel availability is never computed
  from capacity created by a staff override: overbook rows count as occupying
  their tables, and an unplaceable overbook closes online availability for the
  windows and units it could use.
- **I4 (holds count).** A live hold consumes capacity exactly like a booking; an
  expired hold consumes nothing, whether or not it has been swept.
- **I5 (locked never moves).** No automatic process (repair, reflow) moves a
  `locked` assignment or any reservation that has arrived, is seated, or is
  inside the freeze window.
- **I6 (atomic modify).** A failed modification leaves the reservation and its
  occupancies unchanged.
- **I7 (search/book agreement).** Any slot returned by a search can be held
  immediately against the same state and clock.
- **I8 (monotonic release).** Cancelling, finishing or shrinking a reservation
  never removes availability.
- **I9 (append-only history).** Reservation events and the module audit log are
  append-only; redaction on erasure is the only permitted update.
- **I10 (idempotent effects).** Replayed creates return the original result;
  each message, payment, journey trigger and outbound event happens at most once
  per dedupe key.
- **I11 (time intent).** `business_date + local_start_min + time_zone` is the
  source of truth for a booking's time; `start_at`/`end_at` are derived and
  re-derivable.
- **I12 (no automatic fees).** No process other than an operator action with
  `update:reservation_payment:any` creates a fee charge.

---

## 2. Components and responsibilities

### 2.1 Responsibilities by component

| Component                                   | Owns                                                                                                                                                                                                                                                                                                                        | Never does                                                                                                        |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `@repo/zoned-time` (new)                    | time-zone math moved verbatim from `packages/staffing/src/tz.ts`                                                                                                                                                                                                                                                            | anything else; it has no dependencies                                                                             |
| `@repo/reservations` (new)                  | flag, permission and token-claim strings; DST-safe time helpers; config schemas and `validateConfig`; service resolution; availability, pacing, alternatives, calendar summary; assignment, repair, reflow; state machine and quick actions; policy and message-schedule math; wait quotes; API schemas; stable error codes | I/O, UI strings, provider calls, `Date.now()` (clock is injected)                                                 |
| tenant-api (regional, US :3007 / KSA :3009) | every `rsv_*` row and every write; availability; holds; capability tokens; guest messages; the regional tick; voice actions; report records; refund and fee decisions                                                                                                                                                       | read flags or roles for operator routes (it trusts the token), call payment providers, send guest data to the App |
| App (US control plane)                      | flags, permissions, token mint, location facts, the Sites gate payload, every payment provider call (mocked locally), webhook verification, manager notifications, the region-switch and location-delete guards, operator UI shell                                                                                          | read, store, log or proxy guest data; decide amounts or capacity                                                  |
| Sites                                       | public pages and the "Book a table" block in six locales; injects the regional API URL; forwards opaque payment references to the App                                                                                                                                                                                       | fetch or render guest data server-side; proxy bookings; read capability tokens on the server                      |
| Admin                                       | the platform fee default and per-organization overrides                                                                                                                                                                                                                                                                     | anything else for this module                                                                                     |
| jobs-cron                                   | hourly POST of `/api/reservations/tick` to every node and the App payment reconcile job                                                                                                                                                                                                                                     | anything else                                                                                                     |
| voice-agent (US only)                       | calls the generic `services.action` and `sendLink`                                                                                                                                                                                                                                                                          | read guest data back to callers; identify callers by caller ID                                                    |
| Native apps (iOS, Android)                  | call the public and customer routes defined in `docs/reservations-contract.md`                                                                                                                                                                                                                                              | anything outside the contract                                                                                     |

### 2.2 Code layout

```
packages/
  zoned-time/                       NEW @repo/zoned-time (no deps). src/index.ts = old
                                    packages/staffing/src/tz.ts; staffing's tz.ts becomes
                                    `export * from '@repo/zoned-time'`
  reservations/                     NEW @repo/reservations (deps: zod, @repo/zoned-time)
    src/flags.ts                    RESERVATIONS_FLAG_KEYS, foldReservationsFeatures,
                                    PLATFORM_FEE_FLAG_KEY, parsePlatformFeeBp
    src/permissions.ts              RESERVATIONS_PERMISSIONS, SENSITIVE_GRANTS,
                                    grantsSatisfying, restrictGrantsForImpersonation
    src/token.ts                    audience/typ, RESERVATIONS_SCOPES, SCOPE_GRANTS,
                                    reservationsTokenClaimsSchema, token TTLs
    src/time.ts                     localToInstant, instantToLocal, currentBusinessDate
    src/phone.ts                    normalizeGuestPhone (E.164; shared with tenant-api auth)
    src/config/                     Zod schemas for every setting kind + validateConfig()
    src/rules/resolve-services.ts   special-day precedence -> ResolvedService[]
    src/engine/occupancy.ts         per-table interval index
    src/engine/day-state.ts         buildDayState(rows) (pure, from loaded rows)
    src/engine/availability.ts      searchAvailability, alternatives, calendarSummary
    src/engine/pacing.ts            pacing, online caps, concurrent-cover caps
    src/engine/assign.ts            score, bestFit, tryRepair (bounded), reflow
    src/engine/experiences.ts       experience seatings and cover caps
    src/engine/conflicts.ts         detectConflicts
    src/waitlist/quote.ts           quoteWait (queue simulation)
    src/state-machine.ts            statuses, transitions, actors, consumesCapacity,
                                    quickActionsFor, undo rules
    src/policy.ts                   selectPolicy, snapshotPolicy, cancellationTerms,
                                    feeAmount, refundAmount, platformFeeMinor
    src/messages.ts                 MESSAGE_KINDS, scheduleFor, quiet hours, dedupeKey,
                                    channelsFor
    src/schemas/                    operator, public, internal, voice, payments, reports,
                                    native DTOs
    src/errors.ts                   stable error codes (no UI strings)
    src/testing/                    fast-check arbitraries + brute-force oracle (test only;
                                    subpath export "@repo/reservations/testing")
    contract-fixtures/              recorded public API responses (native-apps milestone)

packages/tenant-db/
  src/schema.ts                     new section "12. RESERVATIONS" (rsv_* tables)
  drizzle/0016_reservations_foundation.sql   generated + hand-appended triggers
  src/reservations-schema.test.ts   schema and trigger tests

apps/tenant-api/src/
  lib/http.ts                       NO_STORE, json, validationResponse, readJsonBody
                                    (moved from staff-http.ts; staff-http re-exports)
  lib/reservations-auth.ts          verify rsv+jwt
  lib/reservations-guard.ts         rsvGuard(scope, label, opts, handler)
  lib/reservations-context.ts       cached App context (facts + flags) per org
  lib/reservations-write.ts         withReservationWrite gate
  lib/reservations-tokens.ts        hold, manage, pay, waitlist and notify tokens
  lib/reservations-public.ts        public org resolution, Turnstile/customer-token check,
                                    honeypot, rate limits, uniform 404
  lib/reservations-email.ts         EN/AR HTML templates in org branding
  lib/reservations-sms.ts           region-aware SMS (US only)
  lib/reservations-switches.ts      RESERVATIONS_* kill switches, read live
  lib/org-alarm.ts                  NEW generic per-org alarm scheduler (modules)
  lib/dev-email-capture.ts          dev-only email capture sink (section 9.6)
  routes/reservations-book.ts       /operator/reservations/book/*
  routes/reservations-waitlist.ts   /operator/reservations/book/waitlist/* (sub-router)
  routes/reservations-guests.ts     /operator/reservations/guests/*
  routes/reservations-setup.ts      /operator/reservations/setup/*
  routes/reservations-reports.ts    /operator/reservations/reports/*
  routes/reservations-payments.ts   /operator/reservations/payments/*
  routes/reservations-public.ts     /reservations/*
  routes/reservations-internal.ts   /internal/reservations/*
  routes/reservations-system.ts     /api/reservations/tick, /api/reservations/payments/*
  routes/voice-actions.ts           /api/voice/actions/:name (generic registry)
  services/voice-actions.ts         registerVoiceAction registry (generic)
  services/demand-sources.ts        registerDemandSource registry (generic)
  services/rsv-*.ts                 one service per area: settings, floor, rules,
                                    availability, booking, status, assignment, walk-in,
                                    waitlist, notify-me, guests, messages, payments,
                                    experiences, reports, report-records, export-erase,
                                    audit, outbox, tick, journeys
  restaurant/reservations-demand-source.ts  booked covers -> staffing forecast
  restaurant/reservations-voice.ts          registers the voice actions
  restaurant/reservations-journeys.ts       journey trigger emission
apps/tenant-api/workers/            org-router branches, alarm generalization
apps/tenant-api/scripts/seed-reservations.ts  local demo data
apps/tenant-api/scripts/record-reservations-fixtures.ts  native contract fixtures

apps/app/app/
  routes/_app+/$orgSlug_+/reservations+/    operator screens (section 10)
  routes/resources+/reservations.*.ts       context, notify, payments, region-summary,
                                            location-summary
  routes/resources+/sites.reservations.ts   Sites gate payload
  routes/resources+/sites.reservation.checkout.ts, .status.ts   payment broker
  routes/resources+/jobs.reservation-payments-reconcile.ts
  routes/mock-payments+/                    emulator pages + dev API (stripped in build:cf)
  routes/mock-email+/                       dev email capture viewer (stripped in build:cf)
  components/reservations/**                host stand, book, timeline, floor, floor editor,
                                            waitlist, guests, experiences, reports,
                                            settings, payments, shared
  utils/reservations/**                     access, sections, nav, token, client, *-api,
                                            *-types, *-view, errors, presets, region guard,
                                            payments, guards test
  hooks/use-reservations-*.ts               client, query, action, day feed
apps/admin/app/routes/_admin+/reservations.platform-fee.tsx   platform fee control

apps/sites/src/
  pages/reserve/index.astro, manage.astro, waitlist.astro, pay.astro
  pages/experiences/index.astro, [slug].astro
  pages/api/reservations/payment.ts, payment-status.ts
  components/blocks/ReservationBlock.astro
  components/reservations/*                 picker, slots, details, hold timer,
                                            confirmation, manage, waitlist, labels
  lib/reservations/*                        browser client, view math, errors

packages/payments/src/mock/                 emulators (payment-mocks milestone)
packages/phone-agent/src/vertical.ts        + generic services.action
packages/phone-agent-restaurant/src/        + check_table_availability, book_table
packages/reports/src/catalog-reservations.ts       report subjects bookings, waitlist_entries
packages/marketing-workflow/src/workflow-labels.ts, workflow-config.tsx   trigger labels
apps/jobs-cron/src/index.ts                 + hourly reservations tick + payment reconcile
apps/ios/Sources/TenantKit/Reservations/*, apps/ios/Sources/TenantApp/Reservations/*
apps/android/app/src/main/kotlin/.../core/reservations/*, .../ui/reservations/*
docs/reservations.md, docs/reservations-contract.md, docs/reservations-plan.md,
docs/decisions/048-reservations-data-residency.md
```

---

## 3. Data placement

| Entity                                                                                                                                                                                 | Plane                                                                  | PII rule                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Flags `reservations.*` and `reservations.platform_fee_bp` (`ConfigFlag`)                                                                                                               | Control                                                                | none                                                                                                                 |
| Permission rows, role grants                                                                                                                                                           | Control                                                                | none                                                                                                                 |
| Role presets (Host, Reservations manager, Guest relations, Owner)                                                                                                                      | Code (`role-presets.ts`)                                               | none                                                                                                                 |
| Location facts (name, slug, time zone, address, phone, hours, currency)                                                                                                                | Control (`OrganizationLocation`)                                       | business data                                                                                                        |
| Member location scope                                                                                                                                                                  | Control (`UserOrganization.locationScope`, `UserOrganizationLocation`) | operator ids only                                                                                                    |
| "Book a table" block config                                                                                                                                                            | Control (`WebsitePageSection.config`)                                  | none                                                                                                                 |
| Manager notifications                                                                                                                                                                  | Control (`Notification`, `NotificationPreference`)                     | ids, kind, location id, count only                                                                                   |
| Payment mock state (`__mock_pay_*`)                                                                                                                                                    | Control DB, mock mode only                                             | synthetic provider objects                                                                                           |
| Dev email capture (`__dev_email_capture`)                                                                                                                                              | Control DB, Workers dev only                                           | local dev copies of App emails                                                                                       |
| Payment provider sessions, webhooks                                                                                                                                                    | Provider + App transit                                                 | App sees reservation id, amount, currency, opaque provider refs; the guest types card and email on the provider page |
| Settings, areas, tables, combinations, floor elements, services, turn times, pacing, service availability, special days, blocks, policies, section layouts, message notes, experiences | Regional                                                               | no PII (section assignments may reference staff ids, which are regional)                                             |
| Guests, tags, notes, merges                                                                                                                                                            | Regional                                                               | PII; allergy/dietary notes are sensitive                                                                             |
| Reservations, occupancies, holds, events, service notes                                                                                                                                | Regional                                                               | PII (names, requests, notes)                                                                                         |
| Waitlist entries, notify-me requests                                                                                                                                                   | Regional                                                               | PII                                                                                                                  |
| Messages outbox/log, payments                                                                                                                                                          | Regional                                                               | destination resolved at send time / opaque provider refs and card display facts only, never card numbers             |
| Idempotency keys, day versions, rate counters, audit log, outbox to the App, journey emissions                                                                                         | Regional                                                               | hashes and ids only                                                                                                  |

**Never in the control plane:** guest names, phones, emails, notes, allergies or
anything else tied to a person. Cross-plane payloads carry only ids, counts,
amounts and non-personal configuration.

**Region switch.** Switching an organization's customer data region wipes its
regional data, including reservation settings, as it does today. The guard
(section 5.6) shows counts first, requires typed confirmation, and refuses while
payments are unsettled.

### 3.1 Why settings are regional

The engine reads settings, floor plan, blocks and bookings together inside the
write transaction; a booking must commit against exactly the rules it was
validated with, and a settings edit that changes availability bumps the same
`rsv_day_versions` rows that invalidate caches and polls. Control-plane settings
would need a second consistency protocol, add App latency to every search, and
make the regional node depend on the App for correctness. Settings hold no PII,
so placing them regionally costs nothing in residency. Experiences follow
settings (one home for configuration); Sites reads their public, non-PII
definitions from tenant-api, like `FormBlock.astro` does for forms.

### 3.2 How control-plane facts reach tenant-api

App route `GET /resources/reservations/context?orgId=` (`foundation`):
`requireInternalCommandAuth` first, a 302 rewritten to 403,
`Cache-Control: private, no-store`. Response, validated by
`reservationsContextSchema` in `@repo/reservations`:

```ts
{
  orgId, dataRegion: 'us' | 'ksa',
  features: { enabled, online, waitlist, payments, experiences, voice }, // folded: child = master && child
  organization: { name, slug, defaultLocale, locales, siteOrigin, sitePublished,
                  emailTheme /* hex only, from packages/common/src/email-theme.ts */, logoUrl },
  locations: [{ id, name, slug, timeZone, currency /* USD | CAD | SAR */, phone,
                address: { formattedAddress, city, lat, lng }, storeHours, specialHours, isActive }],
  payments: { processor: 'connect' | 'checkout' | null, deposit: boolean, guarantee: boolean },
  staffing: { enabled: boolean },   // whether section assignments may pick staff ids
  voice: { enabled: boolean }       // phone agent configured for this org (US only)
}
```

Cache in `apps/tenant-api/src/lib/reservations-context.ts`, copying
`lib/scope-context.ts`: LRU per org, fresh 5 min, stale 24 h, 30 s failure
cooldown, 3 s timeout, `redirect: 'error'`, base URL only from
`APP_URL`/`BASE_URL`. Use rules:

- Public **reads** (config, availability, calendar, experiences) accept stale
  facts; features may be at most 30 min stale, otherwise 503 `unavailable`.
- Public **writes** (hold, book, request, waitlist join, notify-me, manage
  mutations) require features no older than 5 min; one synchronous refresh on
  staleness; App unreachable -> 503 `unavailable`.
- **Operator** routes never read flags (the token proves them, minted at most 15
  minutes ago). They need only the location time zone, which is snapshotted in
  `rsv_location_settings.time_zone`, so the write path never blocks on the App.
- The **tick** skips sending when features are unknown (`flags_unknown`) but
  still expires holds, payments and requests.
- A context time zone that differs from the snapshot raises a `tz_mismatch`
  banner in Settings; re-deriving future instants is an explicit operator action
  (`POST /setup/locations/:id/rederive-times`).
- The App calls `POST /internal/reservations/context-changed` after location
  edits and flag changes it makes; flag changes made in Admin are picked up
  within 5 minutes.

---

## 4. Regional data model

All tables go in a new section `// 12. RESERVATIONS` of
`packages/tenant-db/src/schema.ts` and are created by **one migration,
`packages/tenant-db/drizzle/0016_reservations_foundation.sql`**, in the
`foundation` milestone, so later milestones never race on schema. Later
milestones may add additive migrations (section 4.9); they never rewrite `0016`.
After any tenant migration, regenerate the Durable Object migrations
(`apps/tenant-api/workers/migrations.generated.ts`).

Conventions (as in staffing, see the comment near `schema.ts:1051`):

- `id text PK`, default `randomUUID()`; enums as `text({ enum: X_VALUES })` with
  exported `*_VALUES`; booleans `integer({ mode: 'boolean' })`.
- `*_at`: epoch **milliseconds** UTC (default `nowMs`). `customers` and
  `restaurant_orders` use epoch seconds; convert when joining.
- `*_date`: `YYYY-MM-DD` business date in the location time zone. `*_min`:
  integer minutes from 00:00 of the business date (may exceed 1440).
- Money: `*_minor` integer minor units plus `currency` (ISO 4217, upper case).
- `location_id`: the control-plane location id, plain text, no FK. Control-plane
  user ids (`created_by`, `actor_id`) are opaque text, no FK.
- Colors are theme-token keys (`color_token`), never hex.
- `version integer not null default 1` on mutable aggregates, bumped on every
  update (optimistic concurrency).
- Localized operator-authored public text: `*_i18n` JSON `{ [locale]: string }`,
  validated against the six site locales.
- Drizzle names: `rsvLocationSettings`, `rsvAreas`, ..., exported from
  `@repo/tenant-db`.

### 4.1 Configuration

**rsv_location_settings** (one row per location, created on first setup)

| Column                                                 | Type                                                       | Notes                                                                                                     |
| ------------------------------------------------------ | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| location_id                                            | text PK                                                    |                                                                                                           |
| enabled                                                | bool, default 0                                            | location-level switch for operators and guests                                                            |
| online_enabled                                         | bool, default 0                                            | bookable on website/native while `reservations.online` is on                                              |
| time_zone                                              | text                                                       | snapshot of the App location time zone (IANA, validated)                                                  |
| tz_synced_at                                           | int                                                        |                                                                                                           |
| currency                                               | text                                                       | snapshot of the location currency                                                                         |
| day_start_min                                          | int, default 240                                           | business-day boundary (04:00)                                                                             |
| interval_min                                           | int, default 15                                            | booking grid; one of 5, 10, 15, 20, 30, 60                                                                |
| horizon_days                                           | int, default 30                                            | 1..365                                                                                                    |
| release_local_min                                      | int null                                                   | daily release time of the newest day                                                                      |
| min_notice_min                                         | int, default 60                                            | online lead time                                                                                          |
| same_day_cutoff_min                                    | int null                                                   | wall-clock cutoff for same-day online bookings                                                            |
| online_party_min / online_party_max                    | int 1 / 8                                                  |                                                                                                           |
| party_max                                              | int, default 30                                            | staff maximum                                                                                             |
| large_party_mode                                       | text `contact` \| `request`                                | above the online maximum                                                                                  |
| large_party_note_i18n                                  | json                                                       |                                                                                                           |
| request_holds_capacity                                 | bool, default 1                                            |                                                                                                           |
| request_deadline_hours                                 | int, default 24                                            |                                                                                                           |
| seating_pref_mode                                      | text `off` \| `preferred` \| `strict`                      | guest area choice                                                                                         |
| hold_minutes                                           | int, default 7                                             | 3..20                                                                                                     |
| payment_hold_minutes                                   | int, default 20                                            | 10..60                                                                                                    |
| voice_hold_minutes                                     | int, default 15                                            | 5..30; phone-agent holds                                                                                  |
| voice_mode                                             | text `hold_link` \| `confirm_on_call`, default `hold_link` | `confirm_on_call` refused when any policy requires payment                                                |
| freeze_min                                             | int, default 30                                            | no automatic moves inside                                                                                 |
| late_grace_min                                         | int, default 15                                            | "late" is derived                                                                                         |
| auto_no_show_after_min                                 | int null                                                   | null = off (opt-in); never charges fees                                                                   |
| max_active_per_phone                                   | int, default 3                                             | future bookings per phone per location                                                                    |
| block_same_phone_overlap                               | bool, default 1                                            |                                                                                                           |
| guest_modify_cutoff_min                                | int, default 120                                           | guest self-service until N min before start                                                               |
| contact_statuses_enabled                               | bool, default 1                                            | left message / no answer / wrong number                                                                   |
| course_statuses_enabled                                | bool, default 0                                            |                                                                                                           |
| default_policy_id                                      | text null, FK rsv_policies                                 |                                                                                                           |
| waitlist_enabled / waitlist_online / notify_me_enabled | bool 0 / 0 / 0                                             |                                                                                                           |
| waitlist_response_min                                  | int, default 10                                            | notified guest must answer within                                                                         |
| waitlist_max_parties                                   | int null                                                   | remote join closes above                                                                                  |
| messaging                                              | json                                                       | Zod `messagingSettingsSchema`: per-kind enabled, reminder hours, reconfirm hours, quiet hours, SMS on/off |
| public_note_i18n                                       | json                                                       | shown on `/reserve`                                                                                       |
| contact_phone                                          | text null                                                  | large-party contact override                                                                              |
| floor_plan_version                                     | int, default 1                                             | bumped on floor-plan Save                                                                                 |
| version                                                | int, default 1                                             |                                                                                                           |
| updated_at, updated_by                                 | int, text                                                  |                                                                                                           |

**rsv_areas**: `id`, `location_id`, `name`, `name_i18n` (public seating label),
`sort`, `online_bookable` bool, `guest_selectable` bool, `canvas_w` int default
1200, `canvas_h` int default 800, `archived_at`, `created_at`, `updated_at`,
`version`. Index `(location_id, sort)`.

**rsv_tables**: `id`, `location_id`, `area_id` FK, `label`, `min_covers`,
`max_covers`, `online_bookable` bool, `combinable` bool, `priority` int (higher
= preferred), `reset_buffer_min` int default 0, `shape` (`round` | `square` |
`rect` | `booth` | `bar`), `x`, `y`, `w`, `h` int (canvas units, canonical
left-to-right), `rotation` int (0..359), `archived_at`, `created_at`,
`updated_at`. Checks `1 <= min_covers <= max_covers <= 99`,
`reset_buffer_min between 0 and 120`. Unique `(location_id, label)` where
`archived_at is null`. Index `(location_id, area_id)`.

**rsv_table_combos**: `id`, `location_id`, `label`, `min_covers`, `max_covers`,
`online_bookable`, `priority`, `archived_at`, `created_at`, `updated_at`.
**rsv_table_combo_members**: `combo_id` FK cascade, `table_id` FK; PK
`(combo_id, table_id)`. Service validation: at least 2 members, all active and
combinable, no duplicate member sets in a location.

**rsv_floor_elements** (decor): `id`, `area_id` FK cascade, `kind` (`wall` |
`bar` | `door` | `window` | `label` | `plant` | `zone`), `label`, `x`, `y`, `w`,
`h`, `rotation`.

**rsv_services** (weekly templates and special-day replacements): `id`,
`location_id`, `name`, `name_i18n`, `days_mask` int (bit 0 = Monday),
`first_seating_min`, `last_seating_min`, `end_min` (may exceed 1440),
`interval_min` null (inherit), `effective_from` / `effective_to` date null,
`priority` int, `special_day_id` FK null (set = only that day), `online_enabled`
bool, `online_from_min` / `online_to_min` null, `max_party` null,
`online_party_max` null, `online_cap_per_interval` null, `concurrent_covers_cap`
null, `policy_id` null, `section_layout_id` null, `allow_overrun_past_end` bool
default 1, `color_token`, `sort`, `archived_at`, `version`. Checks
`first <= last <= end`, `end - first <= 1440`. Index
`(location_id, archived_at)`.

**rsv_service_availability** (per-service table availability): `id`,
`service_id` FK cascade, exactly one of `area_id` / `table_id` / `combo_id`
(check), `mode` (`online` | `staff_only` | `walk_in_only` | `unavailable`),
optional `from_min` / `to_min` inside the service. Without a row, the table's
`online_bookable` decides `online` vs `staff_only`. `walk_in_only` tables are
excluded from automatic assignment of reservations but usable for walk-ins and
waitlist seating.

**rsv_turn_times**: `id`, `location_id`, `service_id` null (null = location
default), `party_min`, `party_max`, `minutes`, `days_mask` null. Unique
`(location_id, service_id, party_min, days_mask)`. Validation: contiguous,
non-overlapping ranges covering 1..`party_max`; minutes 15..480. Engine fallback
for a missing size: the largest bucket, reported as a config warning.

**rsv_pacing_rules**: `id`, `service_id` FK cascade, `from_min` / `to_min` null
(whole service), `bucket_min` default 15, `max_covers` null, `max_parties` null,
`rolling_min` null, `rolling_max_covers` null, `channel` (`all` | `online`).

**rsv_special_days**: `id`, `location_id`, `from_date`, `to_date`, `kind`
(`closed` | `online_closed` | `modified` | `replace`), `service_id` null (for
`modified`), `patch` json (Zod `servicePatchSchema`), `name`,
`public_note_i18n`, `created_by`, `created_at`, `version`. Index
`(location_id, from_date, to_date)`. Precedence: closed > replace > modified >
online_closed > weekly template (latest `effective_from`, then priority).

**rsv_blocks**: `id`, `location_id`, exactly one of `table_id` / `area_id`,
`business_date`, `start_at`, `end_at`, `reason`, `note`, `created_by`,
`created_at`. Index `(location_id, business_date)`. Each block writes occupancy
rows of kind `block` (area blocks expand to every table of the area at write
time).

**rsv_policies**: `id`, `location_id`, `name`, `kind` (`none` | `card_guarantee`
| `deposit` | `prepay`), `amount_minor`, `per_cover` bool, `currency`,
`free_cancel_until_min` (minutes before start), `late_cancel_fee_minor`,
`no_show_fee_minor`, `fee_per_cover` bool, `fee_cap_minor` null, `refund_rule`
(`full_before_window` | `none` | `partial`), `partial_refund_bp` null,
`applies_party_min` null, `terms_i18n` json, `terms_version` int, `archived_at`,
`version`. Editing terms bumps `terms_version`; reservations snapshot the
policy. Non-`none` kinds need the `payments` feature and processor support
(section 12.7).

**rsv_section_layouts**: `id`, `location_id`, `name`, `archived_at`.
**rsv_sections**: `id`, `layout_id` FK cascade, `name`, `color_token`, `sort`.
**rsv_section_tables**: `section_id` FK cascade, `table_id` FK, `layout_id`
(denormalized); PK `(section_id, table_id)`, unique `(layout_id, table_id)`.
**rsv_section_assignments** (per service day): `id`, `location_id`,
`business_date`, `service_id`, `section_id`, `staff_id` text null (opaque
staffing id, no FK because staffing may be off), `server_label` text null,
`version`. Unique `(business_date, service_id, section_id)`.

**rsv_message_texts** (operator custom notes; templates are code-owned): `id`,
`location_id` null (null = organization default), `kind`, `locale` (`en` |
`ar`), `custom_note` (plain text, at most 500 characters, appended to the
template), `updated_by`, `updated_at`. Unique `(location_id, kind, locale)`.

**rsv_experiences**: `id`, `location_id`, `slug` (unique per location while not
archived), `kind` (`ticketed` | `prix_fixe`), `name_i18n`, `description_i18n`,
`image_url` null, `price_minor` null, `price_per_cover` bool, `currency`,
`policy_id` null (prepay or deposit), `party_min`, `party_max`, `uses_tables`
bool default 1, `exclusive` bool (windows below are bookable only through the
experience), `status` (`draft` | `published` | `archived`), `sort`, `version`.
**rsv_experience_schedules**: `id`, `experience_id` FK cascade, `from_date`,
`to_date`, `days_mask`, `seating_mins` json (explicit start minutes) or
`start_min` / `end_min` / `interval_min`, `turn_min`, `covers_cap_per_seating`
null, `covers_cap_per_day` null, `area_ids` json null, `service_id` null.

### 4.2 Guests

**rsv_guests**: `id`; `customer_id` text null, FK `customers.id` ON DELETE SET
NULL, unique where not null, set only from a verified customer token or a
staff-confirmed link to a verified customer (this is the only guest-to-customer
link, an opaque id; guest data is never copied into `customers`);
`marketing_customer_id` text null, FK `customers.id` ON DELETE SET NULL (an
unverified `customers` row created only when the guest gave explicit marketing
consent at booking, used only for journeys, never for `/mine`; section 14.3);
`first_name`, `last_name`, `phone_e164` null, `email_norm` null, `locale`,
`allergy_notes` null (sensitive), `marketing_email_consent_at`,
`marketing_sms_consent_at`, `consent_source`, `consent_text_version`, `visits`,
`covers`, `no_shows`, `late_cancels`, `cancels`, `first_visit_at`,
`last_visit_at` (denormalized; updated in the same transaction as status
changes; a repair job recomputes from reservations), `merged_into_id` null,
`erased_at` null, `created_at`, `updated_at`, `version`. Indexes `phone_e164`,
`email_norm`, `last_name`, `last_visit_at`. No unique index on phone (households
share phones).

**rsv_tags**: `id`, `scope` (`guest` | `reservation`), `category` (`vip` |
`dietary` | `occasion` | `seating` | `regular` | `custom` | `system`), `name`,
`name_i18n` (guest-facing for occasion and dietary chips), `color_token`,
`sensitive` bool (dietary/allergy), `system_key` null (unique: `first_visit`,
`frequent_no_show`), `guest_selectable` bool, `archived_at`. System tags are
computed from counters (`first_visit`: `visits === 0`; `frequent_no_show`:
`no_shows >= 2`) and never set or removed by hand. **rsv_guest_tags**:
`guest_id` FK cascade, `tag_id` FK; PK both. **rsv_guest_notes**: `id`,
`guest_id` FK cascade, `body` (at most 2000), `pinned`, `author_id`,
`created_at`, `deleted_at`. **rsv_guest_merges**: `id`, `kept_guest_id`,
`merged_guest_id`, `actor_id`, `at`, `moved_counts` json. Append-only trigger.

### 4.3 Reservations

**rsv_reservations**

| Column                                                       | Type                             | Notes                                                                                                                                                                               |
| ------------------------------------------------------------ | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id                                                           | text PK                          |                                                                                                                                                                                     |
| location_id                                                  | text                             |                                                                                                                                                                                     |
| guest_id                                                     | text FK rsv_guests               |                                                                                                                                                                                     |
| customer_id                                                  | text null                        | copy of the verified binding at booking time                                                                                                                                        |
| confirmation_code                                            | text unique                      | 8 characters Crockford base32; display only, not a secret                                                                                                                           |
| business_date                                                | text                             | intent                                                                                                                                                                              |
| local_start_min                                              | int                              | intent                                                                                                                                                                              |
| time_zone                                                    | text                             | intent                                                                                                                                                                              |
| start_at / end_at                                            | int                              | derived; `end_at = start_at + duration_min * 60000`                                                                                                                                 |
| duration_min                                                 | int                              | turn time at booking (editable)                                                                                                                                                     |
| service_id                                                   | text null                        | null for walk-ins outside services                                                                                                                                                  |
| experience_id                                                | text null                        |                                                                                                                                                                                     |
| party_size                                                   | int                              | 1..99                                                                                                                                                                               |
| arrived_covers / seated_covers                               | int null                         | partial arrival and seating                                                                                                                                                         |
| status                                                       | text                             | section 6.4                                                                                                                                                                         |
| contact_status                                               | text null                        | `left_message` \| `no_answer` \| `wrong_number`                                                                                                                                     |
| running_late_min                                             | int null                         | guest- or host-reported                                                                                                                                                             |
| course_status                                                | text null                        | `appetizer` \| `entree` \| `dessert` \| `check_dropped` \| `paid` \| `bussing`                                                                                                      |
| channel                                                      | text                             | `online` \| `native` \| `voice_agent` \| `phone` \| `host` \| `walk_in` \| `waitlist`                                                                                               |
| client                                                       | text null                        | recorded `X-Client` value (`web`, `ios`, `android`)                                                                                                                                 |
| assignment                                                   | text                             | `soft` \| `locked`                                                                                                                                                                  |
| combo_id                                                     | text null                        |                                                                                                                                                                                     |
| overbooked                                                   | bool                             | explicit staff overbook (audited)                                                                                                                                                   |
| area_pref_id                                                 | text null, area_pref_strict bool |                                                                                                                                                                                     |
| occasion_tag_id                                              | text null                        |                                                                                                                                                                                     |
| guest_requests                                               | text null                        | guest-typed (at most 500)                                                                                                                                                           |
| dietary_notes                                                | text null                        | guest-typed, sensitive                                                                                                                                                              |
| staff_notes                                                  | text null                        |                                                                                                                                                                                     |
| policy_snapshot                                              | json null                        | policy + terms version + amounts at booking                                                                                                                                         |
| policy_accepted_at / policy_text_hash                        | int null / text null             | card-on-file and deposit consent record                                                                                                                                             |
| payment_status                                               | text                             | `none` \| `pending` \| `guaranteed` \| `paid` \| `refund_pending` \| `refunded` \| `partially_refunded` \| `fee_pending` \| `fee_charged` \| `fee_failed` \| `review` \| `disputed` |
| payment_expires_at                                           | int null                         |                                                                                                                                                                                     |
| request_deadline_at                                          | int null                         |                                                                                                                                                                                     |
| late_cancel                                                  | bool, default 0                  | guest cancelled inside the free window                                                                                                                                              |
| hold_id                                                      | text unique null                 | conversion at most once                                                                                                                                                             |
| voice_call_id                                                | text null                        | phone-agent call that created it                                                                                                                                                    |
| manage_token_version                                         | int, default 1                   | rotation (tokens are HMAC-derived; no plaintext stored)                                                                                                                             |
| sms_opt_in                                                   | bool                             | transactional texts (US only)                                                                                                                                                       |
| guest_locale                                                 | text                             | messages and manage page                                                                                                                                                            |
| schedule_version                                             | int, default 1                   | bumped on time/date change (message dedupe)                                                                                                                                         |
| version                                                      | int, default 1                   |                                                                                                                                                                                     |
| arrived_at, seated_at, finished_at, cancelled_at, no_show_at | int null                         |                                                                                                                                                                                     |
| cancelled_by                                                 | text null                        | `guest` \| `restaurant` \| `system`                                                                                                                                                 |
| cancel_reason                                                | text null                        |                                                                                                                                                                                     |
| created_by_kind                                              | text                             | `guest` \| `operator` \| `system` \| `voice_agent`                                                                                                                                  |
| created_by_id                                                | text null                        | operator user id                                                                                                                                                                    |
| ip_hash                                                      | text null                        | public bookings                                                                                                                                                                     |
| created_at, updated_at                                       | int                              |                                                                                                                                                                                     |

Indexes `(location_id, business_date, status)`, `(location_id, start_at)`,
`(guest_id, start_at)`, `(status, start_at)`, `(customer_id, start_at)`. Checks
`end_at > start_at`, `party_size between 1 and 99`.

**rsv_reservation_tags**: `reservation_id` FK cascade, `tag_id` FK; PK both.

**rsv_table_occupancies** (one table for reservations, holds and blocks, so one
trigger guards all of them):

| Column                              | Type               | Notes                                                |
| ----------------------------------- | ------------------ | ---------------------------------------------------- |
| id                                  | text PK            |                                                      |
| location_id                         | text               |                                                      |
| table_id                            | text FK rsv_tables |                                                      |
| kind                                | text               | `reservation` \| `hold` \| `block`                   |
| reservation_id / hold_id / block_id | text null          | check: exactly one, matching `kind`                  |
| start_at / end_at                   | int                | includes the reset buffer; check `end_at > start_at` |
| active                              | bool               | 0 once the owner stops consuming capacity            |
| overbook                            | bool               | skips the overlap trigger                            |
| created_at                          | int                |                                                      |

Indexes `(table_id, active, start_at)`, `(reservation_id)`, `(hold_id)`.
Maintained in the same transaction as owner status changes: finish sets
`end_at = max(start_at + 1, finished_at)`; cancel, no-show and expiry set
`active = 0`; hold conversion updates `kind` and `hold_id -> reservation_id` in
place so the interval does not change.

**rsv_holds**: `id`, `location_id`, `token_hash` unique, `business_date`,
`local_start_min`, `start_at`, `end_at`, `party_size`, `service_id`,
`experience_id`, `area_pref_id`, `combo_id`, `source` (`web` | `native` |
`voice_agent`), `voice_call_id` null, `status` (`active` | `converted` |
`released` | `expired`), `expires_at`, `extended_for_payment` bool, `ip_hash`,
`reservation_id` null, `created_at`. Indexes
`(location_id, business_date, status, expires_at)`, `(ip_hash, created_at)`.
Table-less experience holds have no occupancy rows but count against the
experience cap.

**rsv_reservation_events** (append-only): `id`, `reservation_id`, `at`,
`actor_kind` (`guest` | `operator` | `system` | `voice_agent`), `actor_id`,
`type` (`created`, `status_changed`, `modified`, `assigned`, `auto_reassigned`,
`overbooked`, `message_sent`, `message_failed`, `payment_*`, `note`,
`contact_status`, `course_status`, `running_late`, `approved`, `declined`,
`merged_guest`, `undo`), `from_status`, `to_status`, `data` json (field diffs;
no contact values; guest-typed text referenced by field name only). Index
`(reservation_id, at)`.

**rsv_service_notes**: `id`, `location_id`, `business_date`, `service_id` null,
`body` (at most 2000), `updated_by`, `updated_at`, `version`. Unique
`(location_id, business_date, service_id)`.

### 4.4 Waitlist and notify-me

**rsv_waitlist_entries**: `id`, `location_id`, `business_date`, `guest_id` null,
`display_name`, `phone_e164` null, `email_norm` null, `party_size`,
`area_pref_id`, `channel` (`walk_in` | `remote`), `joined_at`, `quoted_min`,
`quoted_ready_at`, `status` (`waiting` | `notified` | `on_the_way` | `seated` |
`cancelled` | `left` | `no_response`), `notified_at`, `response_deadline_at`,
`reservation_id` null (walk-in reservation created at seating),
`status_token_version` int, `sort_key` real, `notes`, `sms_opt_in`, `locale`,
`ip_hash`, `created_at`, `version`. Index
`(location_id, business_date, status, sort_key)`. One active entry per phone per
location per day (enforced in the service; indexed for lookup).

**rsv_notify_requests**: `id`, `location_id`, `business_date`, `party_size`,
`from_local_min`, `to_local_min`, `area_pref_id`, `experience_id`,
`contact_phone_e164` null, `contact_email_norm` null, `guest_id` null, `locale`,
`status` (`active` | `notified` | `booked` | `expired` | `cancelled`),
`notified_count`, `last_notified_at`, `expires_at`, `token_version` int,
`ip_hash`, `created_at`. Index `(location_id, business_date, status)`.

### 4.5 Messages, payments, cross-plane outbox, journeys

**rsv_messages** (outbox and delivery log): `id`, `location_id`,
`reservation_id` null, `waitlist_entry_id` null, `notify_request_id` null,
`kind` (section 9.3), `channel` (`email` | `sms`), `category` (`transactional`),
`locale`, `send_at`, `status` (`pending` | `sending` | `sent` | `failed` |
`cancelled` | `suppressed` | `dropped`), `attempts`, `next_attempt_at`,
`dedupe_key` unique (`<entity>:<id>:<kind>:<channel>:<schedule_version>`),
`provider_message_id`, `last_error_code`, `sent_at`, `created_at`. Indexes
`(status, next_attempt_at)`, `(reservation_id)`. The destination is resolved at
send time from the guest or entry row (never copied), so erasure needs no
message rewrite.

**rsv_payments**: `id`, `reservation_id`, `kind` (`setup` | `deposit` | `prepay`
| `no_show_fee` | `late_cancel_fee` | `refund`), `processor` (`stripe` |
`checkout_com`), `status` (`created` | `pending` | `charging` | `succeeded` |
`failed` | `requires_action` | `cancelled` | `expired` | `refunded` |
`partially_refunded`), `amount_minor`, `refunded_minor` default 0, `currency`,
`platform_fee_bp`, `platform_fee_minor` (snapshot reported by the App at bind
time), `provider_session_id` unique null, `provider_payment_ref` null (`pi_`,
`pay_`), `provider_customer_ref` null (`cus_`, Checkout.com customer id),
`provider_payment_method_ref` null (`pm_`, `src_`), `previous_payment_ref` null
(Checkout.com CIT id for MIT), `card_brand`, `card_last4`, `card_exp_month`,
`card_exp_year` (display facts, setup rows only), `attempt` int default 1,
`idempotency_key` unique (`rsv:<reservationId>:<kind>:<attempt>`),
`failure_code`, `decline_code`, `dispute_status` null, `parent_payment_id` null
(refund of), `requested_by`, `created_at`, `updated_at`, `version`. Index
`(reservation_id)`. No card numbers, no billing details.

**rsv_outbox** (regional -> App, ids, amounts and counts only): `id`, `kind`
(`manager_alert` | `refund_request` | `checkout_expire`), `dedupe_key` unique,
`payload` json (strict schema per kind), `status`, `attempts`,
`next_attempt_at`, `created_at`. Index `(status, next_attempt_at)`.

**rsv_journey_emissions**: `reservation_id`, `trigger` (`reservation_booked` |
`reservation_completed` | `reservation_no_show` | `reservation_cancelled`),
`customer_id`, `emitted_at`, `runs` int; PK `(reservation_id, trigger)`. The
primary key is the journey dedupe (section 14.3).

### 4.6 Infrastructure tables

**rsv_idempotency_keys**: `scope` (`public_book` | `public_hold` |
`public_request` | `waitlist_join` | `notify_me` | `operator_create` | `walk_in`
| `waitlist_add` | `voice_hold` | `voice_book`), `key` (client UUID),
`request_hash` (sha256 of the canonical body), `result_kind`, `result_id`,
`status_code`, `created_at`, `expires_at` (48 h); PK `(scope, key)`. Stores ids,
never response bodies: replays re-serialize the entity and re-derive capability
tokens (HMAC-derived), so no secret is stored in plaintext. Same key and same
hash returns the same result; same key and a different hash returns
`409 idempotency_conflict`.

**rsv_day_versions**: `location_id`, `business_date`, `version`,
`availability_increased_at` null (notify-me matching flag); PK both. Bumped by
every write that touches the date (bookings, holds, blocks, date-specific
settings). Location-wide settings edits bump `rsv_location_settings.version`,
which is folded into the ETag.

**rsv_rate_counters**: `bucket` (for example `hold:ip:<hash>`,
`book:phone:<hash>`, `waitlist:ip:<hash>`, `manage:token:<hash>`),
`window_start`, `count`; PK `(bucket, window_start)`. Purged by the tick.

**rsv_audit_log** (append-only, like `staff_audit_log`): `id`, `at`,
`actor_kind`, `actor_id`, `action` (`settings.update`, `floor_plan.save`,
`guest.merge`, `guest.export`, `guest.erase`, `reservation.overbook`,
`payment.fee_requested`, `payment.refund_requested`, `report.run`, ...),
`entity_kind`, `entity_id`, `location_id`, `changes` json (no PII), `ip_hash`.

### 4.7 Capability token storage

Manage, pay, waitlist-status and notify-cancel tokens are derived:
`base64url(HMAC(AUTH_HMAC_SECRET, '<purpose>:<orgId>:<id>:<version>'))`. Nothing
is stored except the `*_version` counters; verification recomputes and compares
with `timingSafeEqualString`. Hold tokens are random 128-bit values (no id
exists yet), stored as `sha256(token)` in `rsv_holds.token_hash`. Rotation bumps
the version, which invalidates every outstanding link.

### 4.8 Hand-appended triggers (in `0016`; schema tests assert each)

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

- Repairs and moves deactivate or shorten old rows before inserting new ones.
  Expired holds are swept at the start of every write transaction, so their
  still-active rows never trip the trigger.
- `rsv_holds_single_conversion`:
  `BEFORE UPDATE ON rsv_holds WHEN OLD.status = 'converted'` raises (a hold
  converts to a booking only once; together with
  `rsv_reservations.hold_id UNIQUE`).
- `rsv_reservation_events_no_delete` / `_no_update`: abort, except an update
  that sets `data = '{"redacted":true}'`.
- `rsv_audit_log_no_delete` / `_no_update`: same rule.
- `rsv_guest_merges_no_delete` / `_no_update`: abort always.

### 4.9 Tenant migrations by milestone

| Migration                                 | Milestone      | Content                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0016_reservations_foundation.sql`        | `foundation`   | every `rsv_*` table in sections 4.1-4.6, indexes, checks, the triggers in 4.8                                                                                                                                                                                                                                          |
| `0017_voice_actions_and_demand_units.sql` | `integrations` | `voice_call_actions` (`id`, `call_id`, `action`, `outcome`, `dry_run`, `created_at`; index `(call_id, action)`), the generic per-call action log; `labor_scope_settings.demand_per_labor_hour` JSON column (`{ [sourceId]: { [positionId]: number } }`), backfilled from `orders_per_labor_hour` into the `orders` key |

Journey and subscription enum widening (`JOURNEY_TRIGGER_TYPES`,
`CUSTOMER_SUBSCRIPTION_TOPICS`, `CUSTOMER_SUBSCRIPTION_CHANNELS`,
`CUSTOMER_SUBSCRIPTION_SOURCES`) is TypeScript-only and needs no migration. If a
milestone finds it needs another column, it adds the next free number (additive
only, never editing a landed migration) and records it in
`docs/reservations-plan.md`.

---

## 5. Control-plane changes

### 5.1 Flags (`packages/reservations/src/flags.ts`, `foundation`)

| Key                        | Gates                                                                                                                                  | Requires                           |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `reservations.enabled`     | the module: nav, every App route, token mint, operator API, tick messaging, manage links, all public routes                            | none (master)                      |
| `reservations.online`      | public booking (config, availability, calendar, holds, book, large-party requests), `/reserve`, the Book a table block, native booking | master                             |
| `reservations.waitlist`    | operator waitlist, waitlist message kinds; remote join and notify-me also need `online`                                                | master                             |
| `reservations.payments`    | non-`none` policies, deposits, guarantees, fees, refund actions (existing paid bookings stay refundable when off)                      | master                             |
| `reservations.experiences` | Experiences setup, public pages, experience availability                                                                               | master (public part also `online`) |
| `reservations.voice`       | phone-agent reservation tools and voice actions                                                                                        | master                             |

- Only a literal JSON `true` is on. Child flags count only while the master is
  on; `foldReservationsFeatures(raw)` returns the folded record used everywhere
  (App access, token `features` claim, context route).
- Flags are read at organization level then system level
  (`getFeatureFlag(key, { organizationId })`, no user id).
- System-level `false` rows are seeded for all six keys by `0025`, because the
  Admin Organization tab lists only keys that exist at system level.

### 5.2 Platform fee (`payments-experiences`)

- Key `reservations.platform_fee_bp` in `ConfigFlag`: a JSON integer in basis
  points (0..10000). The system row is the platform default, seeded at `0` by
  `0026`; an organization row is an optional override. Resolution: organization
  row if valid, else system row if valid, else `0`; `parsePlatformFeeBp` rejects
  non-integers and out-of-range values and logs a config warning (amounts only).
- Edited only through the Admin control
  `apps/admin/app/routes/_admin+/reservations.platform-fee.tsx`: shows the
  system default, lists organizations with overrides, adds or removes an
  override, and validates with Zod (`z.number().int().min(0).max(10000)`, shown
  as a percentage with two decimals). The generic flag editor stays usable but
  is not the documented path.
- The App reads the fee when it creates a provider session or charge, and
  reports `platformFeeBp` and `platformFeeMinor` in the regional bind or result
  call so the regional `rsv_payments` row keeps the snapshot. Refunds reverse
  the fee proportionally (section 12.3).
- `platformFeeMinor = floor(amountMinor * bp / 10000)`. It applies to deposits,
  prepayments, experience tickets and fees, never to the shop or order flows
  (they keep `SHOP_PLATFORM_FEE_PERCENT`).
- Local validation note: Admin writes `packages/database/db/data.db` while the
  App reads local D1; validators copy the value into D1 with
  `wrangler d1 execute DB --local` before checking amounts.

### 5.3 Permissions (`packages/reservations/src/permissions.ts`, mirrored in `ORG_PERMISSIONS`)

| Constant                    | String                            | Allows                                                                                                                             |
| --------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| READ_RESERVATION            | `read:reservation:any`            | book, today, timeline, floor, calendar, overview, waitlist, guest summaries on reservations, dashboard block                       |
| UPDATE_RESERVATION          | `update:reservation:any`          | create, modify, status, assign, overbook, walk-ins, waitlist actions, service notes, section assignments, approve/decline requests |
| READ_RESERVATION_GUEST      | `read:reservation_guest:any`      | Guestbook search, profiles, history, notes, export (sensitive)                                                                     |
| UPDATE_RESERVATION_GUEST    | `update:reservation_guest:any`    | edit profiles, tags, notes, merge, erase (sensitive)                                                                               |
| READ_RESERVATION_SETTINGS   | `read:reservation_settings:any`   | view setup                                                                                                                         |
| UPDATE_RESERVATION_SETTINGS | `update:reservation_settings:any` | edit setup, floor plan, services, table and area blocks, policies, messages, sections, experiences                                 |
| READ_RESERVATION_REPORT     | `read:reservation_report:any`     | module reports, report subjects                                                                                                    |
| UPDATE_RESERVATION_PAYMENT  | `update:reservation_payment:any`  | charge fees, request refunds (sensitive)                                                                                           |

- Update implies read at runtime (`grantsSatisfying`).
- Sensitive grants (5-minute tokens): both guest grants and the payment grant.
- Impersonation is read-only and gets no sensitive grants.
- Default grants: `org_role_admin` gets all eight; `org_role_member` and
  existing custom roles get none.
- Presets (`apps/app/app/utils/reservations/role-presets.ts`): **Host** (read
  and update reservation), **Reservations manager** (all except payment),
  **Guest relations** (read reservation, both guest grants), **Owner** (all
  eight).
- Role editor group `reservations: true` in
  `apps/app/app/components/roles/tenant-role-access-manager.tsx`, hidden unless
  `reservations.enabled`.

### 5.4 Control-plane migrations

**`packages/database/drizzle/0025_reservations_foundation.sql` (`foundation`)**,
hand-written SQL with a matching Drizzle snapshot (no new tables):

```sql
INSERT OR IGNORE INTO "Permission" ("id", "action", "entity", "access", "description", "context", ...)
VALUES ('org_perm_read_reservation_any', 'read', 'reservation', 'any', ..., 'organization'), ...;  -- 8 rows
INSERT OR IGNORE INTO "_OrganizationPermissionToRole" ("A", "B")
SELECT p.id, 'org_role_admin' FROM "Permission" p WHERE p.id LIKE 'org_perm_%_reservation%';
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), k.key, 'false', 'system', NULL, NULL, <now_ms>, <now_ms>
FROM (SELECT 'reservations.enabled' AS key UNION ALL ... ) k
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" f WHERE f.key = k.key AND f.level = 'system');
```

Copy the exact `Permission` column list from the latest staffing permission
migration. Mirror the rows in `packages/database/setup-roles.ts`.

**`packages/database/drizzle/0026_reservations_platform_fee.sql`
(`payments-experiences`)**: the system row `reservations.platform_fee_bp = 0`
with the same `WHERE NOT EXISTS` guard.

Code mirrors (`foundation`):

- `packages/auth/src/organization-permissions.server.ts` `ORG_PERMISSIONS` plus
  a drift test against `RESERVATIONS_PERMISSIONS`.
- `apps/app/app/utils/organization/tenant-role-permissions.ts` allow-list and
  `RESERVATIONS_IMPLIED_PERMISSION_IDS`.
- Member location scope reuses `UserOrganization.locationScope` and
  `UserOrganizationLocation` through `locationIdsClaim`; the docs generalize its
  description ("locations this member works at").

### 5.5 Operator token (`foundation`)

- Audience `tenant-api-reservations-operator`, header `typ: rsv+jwt`, HS256 with
  `TENANT_OPERATOR_TOKEN`, issuer `brand.shortName`.
- Claims (`reservationsTokenClaimsSchema`): `aud`, `role: 'operator'`, `region`,
  `orgId`, `sub`, `scope` (`book` | `guests` | `setup` | `reports` |
  `payments`), `grants`, `locationIds` (`null` = all locations), `features`
  (folded flags), `impersonated`, `iat`, `exp`.
- Lifetime 15 minutes; 5 minutes with any sensitive grant or impersonation.
  tenant-api caps `exp - iat` at those values and refuses longer tokens.
- `SCOPE_GRANTS`: `book` = reservation grants (no guest grants); `guests` =
  guest grants + read reservation; `setup` = settings grants; `reports` = report
  grant; `payments` = payment grant + read reservation.
- Mint refuses unless the master flag is on and the member holds at least one
  grant of the scope; the `payments` scope also needs `features.payments`.
- tenant-api: audience added to `workers/org-router.ts` `orgIdFromOperatorJwt`;
  the token never routes a public path.

### 5.6 App resource routes (all `requireInternalCommandAuth` first unless noted)

| Route                                                                                                       | Direction                                        | Purpose                                                                                                                                  | Milestone              |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `GET /resources/reservations/context?orgId`                                                                 | regional -> App                                  | facts + flags (section 3.2)                                                                                                              | `foundation`           |
| `POST /resources/reservations/notify`                                                                       | regional -> App                                  | manager alerts `{ orgId, eventId, kind, locationId, count }` (strict)                                                                    | `guest-messages`       |
| `POST /resources/reservations/payments`                                                                     | regional -> App                                  | execute refunds and checkout expiry from `rsv_outbox` (section 12)                                                                       | `payments-experiences` |
| `GET /resources/sites/reservations?slug\|host`                                                              | Sites -> App                                     | gate payload `{ online, waitlist, experiences, notifyMe }`, 404 when the master is off or the site unpublished                           | `online-booking`       |
| `POST /resources/sites/reservation/checkout`, `/status`                                                     | Sites server -> App                              | opaque `{ slug\|host, reservationId \| feeId, paymentToken, purpose }` only (ordering pattern)                                           | `payments-experiences` |
| `POST /resources/jobs/reservation-payments-reconcile`                                                       | jobs-cron -> App                                 | re-check bound sessions that are still pending                                                                                           | `payments-experiences` |
| `GET /resources/reservations/region-summary?orgSlug=`                                                       | App browser -> App                               | counts only, for the region-switch dialog; operator session with `update:settings:any` (copy of `resources+/staffing.region-summary.ts`) | `reservation-book`     |
| `utils/reservations/region-guard.server.ts` (`fetchReservationsSummary`, `evaluateReservationsRegionGuard`) | App -> regional `/internal/reservations/summary` | counts for the dialog and the server-side guard                                                                                          | `reservation-book`     |

- **Region switch** (`reservation-book`), following the staffing guard that
  exists today:
  - UI: the region control in
    `apps/app/app/components/settings/cards/organization/site-card.tsx` already
    fetches `/resources/staffing/region-summary` and asks for the typed slug
    when `requiresStaffConfirmation(summary)` is true. It also fetches
    `/resources/reservations/region-summary` and shows the reservation counts
    (future reservations, guests, waitlist entries and, from
    `payments-experiences`, unsettled payments) in the same typed-confirmation
    dialog. One typed slug confirms both. A pure
    `utils/reservations/region-confirmation.ts`
    (`requiresReservationsConfirmation`) mirrors
    `utils/staffing/region-confirmation.ts`.
  - Server: the region-change action in
    `apps/app/app/routes/_app+/$orgSlug_+/website+/_index.tsx` already calls
    `fetchStaffSummary` and `evaluateRegionGuard` before the wipe. It also calls
    `fetchReservationsSummary` and `evaluateReservationsRegionGuard`. The action
    returns 400 with `reservationsConfirmationRequired` when there is data and
    the typed slug is missing or wrong, or when the summary is unknown. It
    returns 409 `payments_unsettled` while any payment is `pending`, `charging`,
    `guaranteed`, `fee_pending` or `refund_pending`; typed confirmation cannot
    override this.
  - All-zero counts need no extra confirmation. An unreachable regional node
    counts as "unknown" and requires the typed slug, as staffing does.
- **Location delete** (`settings+/locations.$locationId.tsx`,
  `reservation-book`): the App asks `/internal/reservations/location-summary`
  and blocks deletion while future reservations exist.

### 5.7 App navigation and entry points

- `apps/app/app/root.tsx`: `reservationsNav` from
  `getReservationsNavAccess(userId, orgId)` (cachified 30 s, key
  `reservations-nav:<org>:<user>`, fails to `HIDDEN_RESERVATIONS_NAV`).
- `apps/app/app/components/app-sidebar.tsx`: group "Reservations" with Today,
  Book, Waitlist, Guestbook, Experiences, Reports, Settings; each link filtered
  by `sections.ts` requirements; the group URL is the first visible link.
- Location settings: `settings+/locations.$locationId.tsx` gets a Reservations
  card (visible when the flag is on) linking to
  `reservations/settings?location=<id>`; no reservation fields are stored on
  `OrganizationLocation`.
- Website builder (`online-booking`): `BLOCK_TYPES.reservation` ("Book a table")
  in `apps/app/app/utils/website/block-types.ts`, `defaultConfig`
  `{ heading, body, buttonLabel, locationId: null, defaultPartySize: 2, layout: 'inline' | 'button', experienceId: null }`,
  `LOCALIZED_FIELDS` heading/body/buttonLabel; inspector and preview cases in
  `website+/pages.$pageId.tsx` (locations from the control plane; published
  experiences via a browser `setup` token); hidden from the block picker unless
  `reservations.online` is on. `SITE_LINK_RESERVED_PATHS` gains `reserve` and
  `experiences`.
- Dashboards (`guestbook-reports`): the `bookings-today` built-in block (section
  14.5).
- Phone agent settings (`integrations`): a reservation tools toggle in the
  restaurant vertical config, shown only when `reservations.voice` is on and the
  organization is US.
- Notification preferences (`guest-messages`): reservations alert kinds in
  `settings+/notifications` (free-text `NotificationPreference.workflow` values
  `reservations.<kind>`).

---

## 6. Domain package API (`@repo/reservations`)

### 6.1 Time (`time.ts`, built on `@repo/zoned-time`)

`@repo/zoned-time` is `packages/staffing/src/tz.ts` moved unchanged
(`localParts`, `tzOffsetMs`, `zonedLocalToUtc`, `addDays`, `dayOfWeek`,
`businessDateOf`, `businessDayStartMs`, ...). `packages/staffing/src/tz.ts`
becomes `export * from '@repo/zoned-time'`, so staffing's API and tests are
unchanged. Reservations adds:

```ts
localToInstant(date: string, localMin: number, tz: string,
  opts: { gap: 'skip' | 'after'; overlap: 'earlier' | 'later' }): number | null
instantToLocal(ms: number, tz: string, dayStartMin: number): { businessDate: string; localMin: number }
currentBusinessDate(now: number, tz: string, dayStartMin: number): string
```

Slots use `{ gap: 'skip', overlap: 'earlier' }`; service ends use
`{ gap: 'after', overlap: 'later' }`; walk-ins derive the intent from `now`.

### 6.2 Rules and engine

```ts
validateConfig(config: LocationConfig): ConfigIssue[]       // turn coverage, combos, services, policies
resolveServices(config: LocationConfig, businessDate: string): ResolvedService[]
buildDayState(input: { config, businessDate, rows: DayRows, now }): DayState
  // rows: tables, combos, service availability, occupancies (incl. previous-date
  // spill-over), holds, reservations, blocks, experience counts
searchAvailability(input: { config, day, request: SearchRequest, now, budget?: number }): SearchResult
  // SearchRequest: { partySize, channel, areaId?, experienceId?, excludeReservationId? }
  // SearchResult: { slots: Slot[], largeParty?, closed?: { reason, note? } }
  // Slot: { startAt, localMin, serviceId, areaIds, experienceId?, requiresPayment? }
alternatives(input): { sameDay: Slot[]; otherDates: { date: string; firstLocalMin: number }[] }
calendarSummary(input: { config, days: DayState[], partySize, channel, now }): CalendarDay[]
planBooking(input: { day, booking: BookingCandidate, mode: 'search' | 'book',
  budget: number, prefer?: { tableIds?: string[]; lock?: boolean } }): Plan | null
  // Plan: { unit: { tableIds, comboId? }, moves: Move[] }
  // Move: { reservationId, toTableIds, toComboId? }
reflow(input: { day, changed: string[], budget: number, now }): Move[]
detectConflicts(day: DayState, now: number): Conflict[]  // unassigned, overlaps, outside hours, removed tables
quoteWait(input: { day, queue, partySize, now, history }): { minutes: number; tableIds?: string[] }
```

- The pseudocode in `{missionDir}/research/reservation-engineering.md` sections
  1.4 (availability, pacing, table fit, horizon, cutoffs), 2.2 (scoring
  weights), 2.3 (bounded repair), 3.4 (holds) and 7.1 (wait quotes) is
  normative. Its section 2.4 (background re-optimization) is out of scope.
- Budgets: search 200 node expansions per slot, book 2,000, reflow 5,000 per
  call. Exhausting a budget returns "no fit" (never a partial plan).
- Channels: `online`, `native` and `voice_agent` are guest channels (all online
  rules apply). `phone`, `host`, `walk_in` and `waitlist` are staff channels:
  pacing problems are warnings, not filters; `walk_in_only` tables are allowed
  for `walk_in` and `waitlist` only.

Assignment rules:

- **soft** (system or host suggestion): may be moved by repair at booking time
  and by reflow, but never inside `freeze_min` of start or once arrived.
- **locked** (host pin, guest-requested specific table): never moved by any
  automatic process. Dragging a locked party asks "Unlock and move?".
- Reflow runs after seat, move, extend, party-size change, block and table
  archive. It moves only soft, future, outside-freeze reservations; moves are
  logged as `auto_reassigned` events and shown to hosts, never to guests.
- A host drop onto an occupied table offers: swap, move the other party (if
  soft), or overbook (explicit, audited).

### 6.3 Experiences

Experience seatings resolve to virtual services on their dates. With
`uses_tables`, availability is the normal table engine restricted to the
experience's areas plus `covers_cap_per_seating` / `covers_cap_per_day`;
without, the experience is a pool limited only by cover caps (I1 case c). When
`exclusive`, those windows and areas are hidden from regular availability.

### 6.4 State machine (`state-machine.ts`)

Statuses: `requested`, `pending_payment`, `booked`, `confirmed`,
`partially_arrived`, `arrived`, `partially_seated`, `seated`, `finished`,
`cancelled`, `no_show`, `declined`, `expired`.

Capacity is consumed in `pending_payment` (until `payment_expires_at`),
`booked`, `confirmed`, `partially_arrived`, `arrived`, `partially_seated` and
`seated`; in `requested` only when `request_holds_capacity`. It is released on
`finished` (from `finished_at`), `cancelled`, `no_show`, `declined` and
`expired`. "Late" and "running long" are derived, never stored.

Transitions (actor: G guest, O operator, S system, V voice agent):

| From                                          | To                                                   | Actor                                         | Notes                                             |
| --------------------------------------------- | ---------------------------------------------------- | --------------------------------------------- | ------------------------------------------------- |
| (new)                                         | requested                                            | G, O                                          | above the online maximum / request mode           |
| (new)                                         | pending_payment                                      | G                                             | policy requires payment                           |
| (new)                                         | booked                                               | G, O, V                                       | accepted                                          |
| (new)                                         | seated                                               | O                                             | walk-in, waitlist seat                            |
| requested                                     | booked / pending_payment / declined                  | O                                             | approve re-validates                              |
| requested                                     | expired                                              | S                                             | deadline                                          |
| pending_payment                               | booked                                               | S                                             | payment succeeded (re-plan if late, section 12.4) |
| pending_payment                               | expired                                              | S                                             | payment window passed                             |
| booked                                        | confirmed                                            | G, O                                          | reconfirmation                                    |
| booked, confirmed                             | partially_arrived, arrived, partially_seated, seated | O                                             |                                                   |
| partially_arrived                             | arrived, partially_seated, seated                    | O                                             |                                                   |
| arrived                                       | partially_seated, seated                             | O                                             |                                                   |
| partially_seated                              | seated                                               | O                                             |                                                   |
| seated, partially_seated                      | finished                                             | O                                             |                                                   |
| requested, pending_payment, booked, confirmed | cancelled                                            | G (before start), O, S                        | sets `late_cancel` inside the free window         |
| partially_arrived, arrived                    | cancelled                                            | O                                             |                                                   |
| booked, confirmed                             | no_show                                              | O, S (opt-in, after `auto_no_show_after_min`) | never charges                                     |
| no_show                                       | booked, seated                                       | O                                             | undo; re-validate                                 |
| finished                                      | seated                                               | O                                             | undo within 30 min; re-validate                   |
| seated                                        | arrived                                              | O                                             | undo seating                                      |
| cancelled                                     | booked                                               | O                                             | reinstate; re-validate                            |

- Side fields: `contact_status` (O, before arrival only), `running_late_min` (G
  through the manage link, O), `course_status` (O while seated; only when
  enabled).
- `quickActionsFor(reservation, ctx)` derives list, floor and timeline buttons
  from this table (for example booked -> Arrived, Seat, Confirm, Left message,
  No-show, Cancel).
- Modify (time, date, party, area, duration) is not a status change: it re-plans
  excluding the reservation's own occupancy and swaps atomically.

### 6.5 Policy and messages

- `policy.ts`: `selectPolicy(config, service, experience, partySize)`
  (precedence: experience `policy_id` -> service `policy_id` -> location
  `default_policy_id`, applied only when `partySize >= applies_party_min`),
  `snapshotPolicy(policy, partySize, currency)`,
  `cancellationTerms(snapshot, now, startAt)` ->
  `{ free, lateCancel, feeMinor, refundMinor }`,
  `noShowFee(snapshot, partySize, arrivedCovers)` (clamped to `fee_cap_minor`;
  an operator may only lower it), `refundAmount(payment, terms, cancelledBy)`
  (restaurant cancel = full), `platformFeeMinor(amountMinor, bp)`,
  `proportionalFeeRefund(...)`, `currencyMinimum(currency)` (USD/CAD 50, SAR
  200).
- `messages.ts`: `MESSAGE_KINDS`, `scheduleFor(reservation, settings, tz)` ->
  `{ kind, channel, sendAt }[]` (quiet hours move reminders earlier and skip
  them if too near), `dedupeKey(...)`, `channelsFor(region, settings, contact)`
  (SMS only when the region is `us`, the guest opted in, a phone is present and
  the switch is on).

### 6.6 Schemas and errors

`schemas/` exports strict Zod request and response schemas used by tenant-api
(validation), App (`*-types.ts`), Sites (client parse) and documented for
native: config DTOs, `DayFeed`, `ReservationOperatorView`,
`ReservationPublicView`, `HoldRequest/Response`, `BookRequest/Response`,
`ManageView`, `PaymentStatusView`, `WaitlistJoin/Status`, `NotifyMeRequest`,
`ExperiencePublic`, `ReportResult*`, internal payloads
(`managerAlertEventSchema`, `reservationsContextSchema`, payment
quote/bind/status/fee/refund), voice action inputs and outputs. Every public
response that carries a deadline includes `expiresAt` (ISO) and the server's
`now` (ISO).

`errors.ts` codes: `no_fit`, `slot_unavailable`, `hold_expired`,
`hold_not_found`, `stale_version`, `idempotency_conflict`, `outside_horizon`,
`too_soon`, `large_party`, `party_size_invalid`, `policy_required`,
`policy_unavailable`, `payment_required`, `modify_closed`, `cancel_closed`,
`rate_limited`, `turnstile_required`, `not_found`, `unavailable`, `forbidden`,
`feature_off`, `conflict`, `fee_not_allowed`, `refund_exceeds_paid`, `invalid`.

---

## 7. tenant-api routes

### 7.1 Conventions

- All responses `Cache-Control: private, no-store` unless an ETag response is
  noted. Errors are `{ error: '<code>', ...extra }`; validation errors list
  field paths and never echo rejected values.
- Every operator route uses
  `rsvGuard(scope, label, { all, write, feature? }, handler)`, which runs token
  verification (`lib/reservations-auth.ts`: audience, `typ`, lifetime cap,
  scope, region matches the node, organization active and provisioned), grant
  checks, impersonation write refusal, `features` checks (for example `waitlist`
  routes 404 when off), `locationIds` filtering (`allowsLocation(id)`; an empty
  list allows nothing), `getTenantDb(orgId)`, and log-safe 500s.
- Operator routes share the existing `/operator/*` limit (120/min). Operator
  mutations carry `expectedVersion`; idempotent creates carry an
  `Idempotency-Key` header.
- Operator routes are browser-only, so they may use PATCH, PUT and DELETE.
  **Public routes use only GET and POST** (native clients cannot send PATCH).

### 7.2 Operator routes

`/operator/reservations/book/*` (scope `book`):

| Method + path                                                                                                                                                                                                   | Grant       | Purpose                                                                                                                               | Milestone           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| GET `/day?locationId&date`                                                                                                                                                                                      | read        | day feed; ETag `"<dayVersion>.<settingsVersion>"`, 304 on match                                                                       | `reservation-book`  |
| GET `/changes?locationId&date&since=<dayVersion>`                                                                                                                                                               | read        | cheap poll `{ dayVersion, changed }`                                                                                                  | `reservation-book`  |
| GET `/availability?locationId&date&partySize&areaId?`                                                                                                                                                           | read        | staff availability with warnings                                                                                                      | `reservation-book`  |
| GET `/guests/lookup?q`                                                                                                                                                                                          | read        | at most 10 guest summaries for booking                                                                                                | `reservation-book`  |
| POST `/reservations` (Idempotency-Key)                                                                                                                                                                          | update      | phone/host booking; `overbook` is explicit                                                                                            | `reservation-book`  |
| GET `/reservations/:id`                                                                                                                                                                                         | read        | detail                                                                                                                                | `reservation-book`  |
| PATCH `/reservations/:id`                                                                                                                                                                                       | update      | modify (`expectedVersion`)                                                                                                            | `reservation-book`  |
| POST `/reservations/:id/status`                                                                                                                                                                                 | update      | transition `{ to, expectedVersion, tableIds?, covers?, reason? }`                                                                     | `reservation-book`  |
| POST `/reservations/:id/undo`                                                                                                                                                                                   | update      | undo the last undoable transition                                                                                                     | `reservation-book`  |
| POST `/reservations/:id/contact-status`, `/course-status`, `/running-late`, `/notes`                                                                                                                            | update      | side fields                                                                                                                           | `reservation-book`  |
| GET `/reservations/:id/events`                                                                                                                                                                                  | read        | change history                                                                                                                        | `reservation-book`  |
| POST `/reservations/:id/resend`                                                                                                                                                                                 | update      | resend confirmation                                                                                                                   | `guest-messages`    |
| POST `/walk-ins` (Idempotency-Key)                                                                                                                                                                              | update      | seat now                                                                                                                              | `reservation-book`  |
| GET `/conflicts?locationId&date`                                                                                                                                                                                | read        | unassigned and conflict panel                                                                                                         | `reservation-book`  |
| POST `/reservations/:id/assign`                                                                                                                                                                                 | update      | `{ tableIds, comboId?, lock, overbook?, expectedVersion }` -> `{ reservation, moves }`                                                | `host-stand`        |
| GET `/calendar?locationId&month`                                                                                                                                                                                | read        | per-day covers, parties, closed days                                                                                                  | `host-stand`        |
| GET `/overview?locationId&date&serviceId?`                                                                                                                                                                      | read        | pre-service brief                                                                                                                     | `host-stand`        |
| PUT `/service-notes`                                                                                                                                                                                            | update      | service notes                                                                                                                         | `host-stand`        |
| GET/PUT `/sections/assignments?locationId&date&serviceId`                                                                                                                                                       | read/update | server per section                                                                                                                    | `host-stand`        |
| POST `/reservations/:id/approve`, `/decline`                                                                                                                                                                    | update      | large-party requests                                                                                                                  | `online-booking`    |
| GET `/today?locationId?`                                                                                                                                                                                        | read        | `bookings-today` block: counts by status, covers by service, next 8 arrivals `{ time, partySize, firstName, status }`, waitlist count | `guestbook-reports` |
| `/waitlist/*` sub-router (feature `waitlist`): GET `/?locationId&date`, GET `/quote?locationId&partySize`, POST `/` (Idempotency-Key), PATCH `/:id`, POST `/:id/notify`, `/:id/seat`, `/:id/status`, `/reorder` | read/update | operator waitlist                                                                                                                     | `waitlist`          |

`/operator/reservations/guests/*` (scope `guests`; `guestbook-reports`, except
export and erase which land in `reservation-book`):

| Method + path                                                              | Grant                                           | Purpose                                                                                                            |
| -------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| GET `/?q&tag&sort&cursor`                                                  | read guest                                      | search and list (server-side filtering, cursor pages of 50)                                                        |
| GET `/:id`                                                                 | read guest                                      | profile, visit history, stats, tags, pinned notes                                                                  |
| PATCH `/:id`                                                               | update guest                                    | edit profile (`expectedVersion`)                                                                                   |
| POST `/:id/tags`, DELETE `/:id/tags/:tagId`                                | update guest                                    | tags                                                                                                               |
| POST `/:id/notes`, PATCH `/:id/notes/:noteId`, DELETE `/:id/notes/:noteId` | update guest                                    | notes, pin                                                                                                         |
| POST `/merge` `{ keepId, mergeId, expectedVersions }`                      | update guest                                    | merge duplicates                                                                                                   |
| GET `/:id/export?includeSensitive`                                         | read guest (sensitive fields need update guest) | JSON export; audited                                                                                               |
| POST `/:id/erase`                                                          | update guest                                    | anonymize, cancel future bookings with a notification; audited                                                     |
| GET/POST/PATCH `/tags`                                                     | read/update guest                               | tag catalog                                                                                                        |
| GET `/:id/summary`                                                         | read reservation                                | guest summary for book and host stand (visits, no-shows, tags, pinned note; no allergy text without a guest grant) |

`/operator/reservations/setup/*` (scope `setup`; `setup` unless noted):

| Method + path                                                                                                            | Purpose                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| GET/PUT `/locations/:id/settings`                                                                                        | location settings                                                                                                                         |
| GET `/locations/:id/floor-plan`, PUT `/locations/:id/floor-plan` `{ floorPlanVersion, areas, tables, combos, elements }` | atomic Save; stale version -> 409; returns conflicts (future reservations on removed or shrunk tables become unassigned and are reflowed) |
| CRUD `/services`, `/turn-times`, `/pacing`, `/special-days`, `/service-availability`                                     | rules                                                                                                                                     |
| GET `/blocks?locationId&from&to`, POST `/blocks`, DELETE `/blocks/:id`                                                   | table and area blocks for a date range (bumps day versions; reflows soft bookings off blocked tables)                                     |
| GET `/locations/:id/validate`, GET `/locations/:id/conflicts`                                                            | validation and conflicts view                                                                                                             |
| POST `/locations/:id/rederive-times`                                                                                     | time-zone mismatch re-derive                                                                                                              |
| CRUD `/sections/layouts` (+ sections, tables)                                                                            | `host-stand`                                                                                                                              |
| GET/PUT `/message-texts`                                                                                                 | `guest-messages`                                                                                                                          |
| GET/PUT `/locations/:id/waitlist`                                                                                        | `waitlist`                                                                                                                                |
| CRUD `/policies` (money kinds need `features.payments` and processor support)                                            | `payments-experiences`                                                                                                                    |
| CRUD `/experiences` (+ schedules, publish; feature `experiences`)                                                        | `payments-experiences`                                                                                                                    |

`/operator/reservations/reports/*` (scope `reports`, `guestbook-reports`): GET
`/summary?locationId&from&to` (covers and parties by service, source, party
size), `/no-shows`, `/cancellations`, `/turn-times` (actual vs configured by
party bucket), `/waitlist` (quoted vs actual), `/pacing`. Aggregates only; each
run writes `rsv_audit_log` `report.run`.

`/operator/reservations/payments/*` (scope `payments`, feature `payments`,
`payments-experiences`):

| Method + path                                                                                              | Purpose                                                                                                              |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| GET `/reservations/:id`                                                                                    | payment rows and card display facts                                                                                  |
| POST `/reservations/:id/fee` `{ kind: 'no_show_fee' \| 'late_cancel_fee', amountMinor?, expectedVersion }` | validates state, creates a `fee_pending` row, audited, returns `{ feeId, amountMinor }` (App executes, section 12.5) |
| POST `/reservations/:id/refund` `{ amountMinor?, reason }`                                                 | operator partial or full refund request, audited; enqueues `refund_request`                                          |

### 7.3 Public guest routes (`/reservations/*`, `online-booking` unless noted)

**Organization resolution.** `Origin` only (plus query/body `slug`/`host`
outside production for local tools), never a body or query `orgId`, through a
new `org-router.ts` branch placed before the generic `?orgId=` fallback, like
`/careers/`. Every route requires: an active, published, provisioned
organization in this node's region; the master flag and the route's child flags;
the location `enabled` (and `online_enabled` for booking); and
`RESERVATIONS_PUBLIC_ENABLED` not off. Otherwise uniform `404 not_found` (503
`unavailable` when the switch is off or the context is unavailable).

**Identity.** A customer JWT (`Authorization: Bearer`, audience `tenant-api`) is
optional; an invalid or cross-organization token is rejected, not ignored.
Capability tokens travel in `X-Reservation-Token`, so a customer JWT can
coexist.

**Bot protection on writes** (`lib/reservations-public.ts`): a valid customer
access token for this organization **or** a Turnstile token (when
`TURNSTILE_SECRET_KEY` is set) is required on `POST /holds`, `/requests`,
`/waitlist/join` and `/notify-me`; the honeypot field `website` answers like
success and writes nothing; in-memory per-IP limits plus durable limits in
`rsv_rate_counters`. `X-Client: web | ios | android` is recorded; `ios` and
`android` set channel `native`.

| Route                                                                      | Limits (in-memory per IP / durable)                                   | Notes                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET `/config`                                                              | 120/min                                                               | bookable locations (id, name, address, time zone), party limits, horizon, areas when selectable, large-party mode and contact, waitlist/notify flags, public notes, occasion and dietary chips, policy summaries                                                                                                                          |
| GET `/availability?locationId&date&partySize&areaId?&experienceId?`        | 60/min                                                                | `{ dayVersion, timeZone, now, slots, alternatives, largeParty?, closed?, notifyMe, waitlist }`; ETag; `Cache-Control: private, max-age=0`                                                                                                                                                                                                 |
| GET `/calendar?locationId&partySize&from&to`                               | 30/min                                                                | at most 62 days                                                                                                                                                                                                                                                                                                                           |
| POST `/holds`                                                              | 10/min; durable 10 per IP hash per 10 min; at most 300 active per org | `replaceHoldToken` releases the previous hold; returns `{ holdToken, expiresAt, now, slot, policy?, requiresPayment? }`                                                                                                                                                                                                                   |
| GET `/holds/current`                                                       | 60/min                                                                | hold by `X-Reservation-Token` (resume from a voice link); `{ slot, expiresAt, now }`                                                                                                                                                                                                                                                      |
| POST `/holds/release`                                                      | 30/min                                                                | release by token                                                                                                                                                                                                                                                                                                                          |
| POST `/` (Idempotency-Key)                                                 | 10/min; durable per phone `max_active_per_phone`, 20/day per IP hash  | `{ holdToken, guest: { firstName, lastName, phone, email }, occasionTagId?, requests?, dietary?, areaPref?, smsOptIn, marketing?: { email, sms, textVersion }, policyAccepted?: { termsVersion }, locale, website }` -> `201 { reservation, manageToken, payment?: { paymentToken, purpose, amountMinor, currency, expiresAt, payUrl } }` |
| POST `/requests` (Idempotency-Key)                                         | 5/10 min                                                              | large-party request                                                                                                                                                                                                                                                                                                                       |
| GET `/manage`                                                              | 60/min                                                                | view by token: first name, date/time, party, location, status, occasion, own requests, policy terms, payment status, masked contact, `canModify`, `canCancel`, `cancelDeadline`                                                                                                                                                           |
| GET `/manage/availability`                                                 | 30/min                                                                | modify search excluding own occupancy                                                                                                                                                                                                                                                                                                     |
| POST `/manage/modify`, `/manage/cancel`, `/manage/confirm`, `/manage/late` | 30/hour per token (durable)                                           | POST only, never GET mutations                                                                                                                                                                                                                                                                                                            |
| GET `/manage/calendar.ics`                                                 | 30/min                                                                | add to calendar (token in `X-Reservation-Token` or `?t=` for calendar apps; `Referrer-Policy: no-referrer`)                                                                                                                                                                                                                               |
| GET `/manage/payment`                                                      | 120/min                                                               | payment status poll `{ paymentStatus, reservationStatus, now }` (`payments-experiences`)                                                                                                                                                                                                                                                  |
| GET `/mine`                                                                | 60/min                                                                | customer JWT; upcoming and past bookings, each with a derived manage token                                                                                                                                                                                                                                                                |
| GET `/experiences`, GET `/experiences/:slug`                               | 120/min                                                               | public, non-PII; Sites SSR may call it (`payments-experiences`)                                                                                                                                                                                                                                                                           |
| POST `/notify-me`                                                          | 5/10 min; at most 5 active per contact                                | returns a cancel token (`waitlist`)                                                                                                                                                                                                                                                                                                       |
| POST `/notify-me/cancel`                                                   | 30/hour                                                               | token (`waitlist`)                                                                                                                                                                                                                                                                                                                        |
| POST `/waitlist/join` (Idempotency-Key)                                    | 5/10 min; one active per phone per location per day                   | requires `waitlist_online`; returns a status token (`waitlist`)                                                                                                                                                                                                                                                                           |
| GET `/waitlist/status`                                                     | 120/min                                                               | position, quoted wait, state, `now` (`waitlist`)                                                                                                                                                                                                                                                                                          |
| POST `/waitlist/status/leave`, `/waitlist/status/on-my-way`                | 30/hour                                                               | (`waitlist`)                                                                                                                                                                                                                                                                                                                              |

- Hold tokens are random; manage, pay, waitlist and notify tokens are derived
  (section 4.7). Manage tokens are valid until 7 days after the business date
  and rotate on operator request (`POST /book/reservations/:id/resend` with
  `rotate: true`).
- Manage links travel in the URL fragment:
  `<siteOrigin>[/<locale>]/reserve/manage#t=<token>`.
- Forged, cross-organization, expired and rotated tokens all return the same
  `404 not_found`.

### 7.4 Internal and system routes

All use `INTERNAL_COMMAND_TOKEN`, take `orgId` in the JSON body, run
`assertOrgRegion` fail-closed, and carry ids, counts and amounts only.

| Route                                                                                                                                               | Purpose                                                                                                       | Milestone              |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------- |
| POST `/internal/reservations/summary`                                                                                                               | counts for the region switch (future reservations, guests, waitlist, unsettled payments)                      | `reservation-book`     |
| POST `/internal/reservations/location-summary` `{ orgId, locationId }`                                                                              | counts for location deletion                                                                                  | `reservation-book`     |
| POST `/internal/reservations/context-changed`                                                                                                       | drop the cached context                                                                                       | `foundation`           |
| POST `/internal/reservations/erase-customer` `{ orgId, customerId }`                                                                                | a tenant customer was erased: unlink guests (`customer_id`, `marketing_customer_id`), keep anonymized history | `guestbook-reports`    |
| POST `/api/reservations/tick` `{ orgId? }` (none = fan out)                                                                                         | regional tick                                                                                                 | `guest-messages`       |
| POST `/api/reservations/payments/quote`, `/bind`, `/status`, `/fee-claim`, `/fee-result`, `/refund-claim`, `/refund-result`, `/dispute`, `/pending` | App payment broker (section 12.6)                                                                             | `payments-experiences` |

### 7.5 Voice actions (`integrations`)

POST `/api/voice/actions/:name`, mounted in `routes/voice.ts`'s router under
`/api/voice`: `requireVoiceAgent` (`VOICE_AGENT_TOKEN`) and
`regionalOrganization` first; body
`{ orgId, callId, scopeId?, channel, input }`. The route checks that the call
exists and is not finished (409), looks up the registered action (unknown ->
404), validates `input` with the action's schema, enforces the per-call cap by
counting `voice_call_actions` rows (429 `rate_limited`), runs the action, and
records the row. On `channel = 'web_test'` actions run with `dryRun: true`:
availability is real, holds and bookings are not written and nothing is texted
(`simulated: true`). Restaurant registrations (section 14.1):
`reservations.availability` (cap 10 per call), `reservations.hold` (cap 2),
`reservations.book` (cap 1).

### 7.6 Routing (`workers/org-router.ts`)

- `/internal/reservations/*`, `/api/reservations/*` and `/api/voice/actions/*`
  -> `orgIdFromJsonBody`.
- `/reservations/*` -> Origin binding (before the `?orgId=` fallback).
- `/operator/reservations/*` -> `orgIdFromOperatorJwt` with the new audience.
- Tests: `src/lib/reservations-routing.test.ts` (public never routes on a client
  `orgId`; unknown origin -> null; operator audience routes; a staffing token
  never routes a reservations path).

---

## 8. Write path and concurrency

`lib/reservations-write.ts` (`foundation`):

```ts
withReservationWrite(ctx, { locationId, dates, scope?, idempotencyKey?, requestHash? }, fn) =
  // 1. outside the lock: context facts, Turnstile, request hash, token parsing
  runExclusive(orgId, () => retryOnSqliteBusy(() => db.transaction(async (tx) => {
    await sweepExpired(tx, now)            // holds, pending payments, requests, waitlist offers
    const replay = await checkIdempotency(tx, scope, key, hash); if (replay) return replay
    const day = await loadDayState(tx, locationId, dates, now)  // fresh, inside the tx
    const result = await fn(tx, day)       // re-validate with the engine, write rows
    await bumpDayVersions(tx, locationId, affectedDates)
    await appendEvents(tx, ...); await enqueueMessages(tx, ...)
    await enqueueOutbox(tx, ...); await storeIdempotency(tx, ...)
    return result
  })))
  // 2. after commit: drop the day cache, best-effort immediate message send
  //    (bounded, outside the lock), notify-me dirty flag, journey triggers
```

- No network I/O inside the transaction (the Durable Object yields at every
  await).
- `runExclusive` serializes per organization in-process; the Durable Object is
  single-instance per organization; on Node, SQLite locking and
  `retryOnSqliteBusy` cover other processes. One writer per organization.
- Expected-version checks on every operator mutation: a mismatch returns
  `409 stale_version` with the fresh row. Idempotent-by-nature transitions (seat
  when already seated) succeed.
- Hold conversion: `hold_id UNIQUE` plus the single-conversion trigger. A valid
  hold wins against everything except a staff overbook. Conversion re-validates
  rules (pacing or blocks may have changed); on failure it returns
  `409 slot_unavailable` with alternatives.
- Late payments: see section 12.4.
- The overlap trigger is a safety net; a trigger abort maps to `409 conflict`
  and is logged as an engine-bug metric (no PII).
- Day cache: in-memory `Map<orgId:locationId:date, { version, state }>`; a read
  compares the persisted `rsv_day_versions.version` (one indexed lookup), so it
  is exact on both runtimes.
- Polling: the day feed and public availability return
  `ETag: "<dayVersion>.<settingsVersion>"`; `If-None-Match` returns 304 with no
  body; `/changes` is the cheapest probe.
- Expiry is enforced lazily at read time (a hold past `expires_at` counts as
  expired in `buildDayState`), so the tick affects timeliness, never
  correctness.

---

## 9. Scheduled work, messages and dev email capture

### 9.1 Generic per-organization alarm (`guest-messages`)

New `apps/tenant-api/src/lib/org-alarm.ts`:

```ts
type OrgTickModule = {
  name: 'staff' | 'reservations'
  tickPath: string                         // '/api/staff/tick', '/api/reservations/tick'
  isActivityPath(pathname: string): boolean
  run(orgId: string, now: number): Promise<{ needsFollowUp: boolean; nextDueAt?: number | null }>
}
registerOrgTickModule(module: OrgTickModule): void
armOrgAlarm(storage, orgId, now, dueAt?): Promise<void> // moves an alarm only earlier; clamps to [now+30s, now+60min]
handleOrgAlarm({ storage, now, modules }): Promise<void>
  // runs every module; per-module failure counters 'tickFailures:<name>';
  // re-arms at min(nextDueAt) or the interval while any module needsFollowUp
```

- `src/lib/staff-alarm.ts` keeps its exports (its tests stay green) and its
  logic becomes the staff module adapter. Storage key `staffTickOrgId` is read
  as a fallback for the new `orgAlarmOrgId`.
- `workers/tenant-org.ts`: `maybeArmStaffAlarm` -> `maybeArmOrgAlarm` checks
  every module's activity path and parses `needsFollowUp`/`nextDueAt` from
  either tick path; `alarm()` -> `handleOrgAlarm`.
- Workers edge: `handleStaffTickFanOut` generalized to `handleTickFanOut(path)`
  for `/api/reservations/tick`.
- Node: `startReservationsTickInterval()` in `src/index.ts`
  (`RESERVATIONS_TICK_INTERVAL_SECONDS`, default 120, minimum 60, `0` off).
- jobs-cron: add `['Tenant reservations tick', invokeTenantReservationsTick]` to
  the hourly list in `apps/jobs-cron/src/index.ts` (no new cron slot).

### 9.2 Reservations tick (`services/rsv-tick-service.ts`)

`runReservationsTickForOrg(orgId, now)`: per-org lock (`busy`), skip with
`region_mismatch`, `no_reservations` (no settings rows) or `flags_unknown`
(sweeps only). Tasks are registered with `registerReservationsTickTask` and each
is bounded:

| #   | Task                                                                                                                                                          | Milestone                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 1   | `expire_holds`, `expire_requests` (+ `request_declined` guest message)                                                                                        | `guest-messages`                                                 |
| 2   | `expire_payments` (+ `checkout_expire` outbox)                                                                                                                | `payments-experiences`                                           |
| 3   | `auto_no_show` (locations with `auto_no_show_after_min` only; never charges)                                                                                  | `guest-messages`                                                 |
| 4   | `waitlist_offers` (notified past deadline -> `no_response`)                                                                                                   | `waitlist`                                                       |
| 5   | `notify_me_match` (dates with `availability_increased_at`; recompute; notify FIFO, first 3 per slot, next batch after 15 min; expire past range)              | `waitlist`                                                       |
| 6   | `deliver_messages` (due `pending`, at most 100 per tick, re-check eligibility and `schedule_version` before sending; retry after 1, 5, 30 min, then `failed`) | `guest-messages`                                                 |
| 7   | `deliver_outbox` (manager alerts at most 50 groups, refund requests, checkout expiry; retry statuses 401/408/425/429/5xx)                                     | `guest-messages` (refund/expiry kinds in `payments-experiences`) |
| 8   | `reconcile_guest_counters` (repair denormalized guest stats for touched guests)                                                                               | `guestbook-reports`                                              |
| 9   | `purge` (idempotency keys > 48 h, rate counters > 2 days, released/expired holds > 7 days, sent messages > 180 days)                                          | `guest-messages`                                                 |

It returns `{ counts, needsFollowUp, nextDueAt }` (the minimum of the next
message `send_at`, the next payment, request or offer deadline, and the next
auto no-show). There is no re-optimization task (out of scope).

### 9.3 Guest messages (`guest-messages`)

Kinds and the milestone that adds each:

| Kind                                                                                                                                                                         | Milestone              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `confirmation`, `modification`, `cancellation_guest`, `cancellation_restaurant`, `reminder`, `reconfirm_request`, `request_received`, `request_approved`, `request_declined` | `guest-messages`       |
| `waitlist_joined`, `waitlist_ready`, `notify_available`                                                                                                                      | `waitlist`             |
| `payment_required`, `payment_received`, `refund_issued`, `fee_charged`, `fee_action_required`, `late_payment_refunded`                                                       | `payments-experiences` |

- All kinds are `transactional`; marketing goes only through journeys (section
  14.3).
- Enqueued inside the write transaction; immediate kinds are sent right after
  commit (best effort), scheduled kinds by the tick. Modify bumps
  `schedule_version` and cancels pending rows of the old version. At most one
  message per dedupe key.
- **Email:** `lib/reservations-email.ts`, plain HTML strings (no React in the
  Durable Object), English and Arabic (`dir="rtl"`), every value escaped, hex
  colors and logo from the context `emailTheme`, location name, address and
  phone, the manage link, an add-to-calendar link, and the operator's
  `custom_note` for that kind and locale. Other guest locales fall back to
  English. Sent with `sendTenantEmail` without marketing context.
- **SMS:** `lib/reservations-sms.ts` wraps `@repo/sms` only when
  `getNodeRegion() === 'us'`, the guest opted in and the switch is on; short
  English/Arabic texts with the manage link. KSA uses email and status pages
  only, without an error to the guest.
- **Quiet hours:** default 21:00-08:00 location time for scheduled kinds.
- **Kill switches** (read live from `process.env`; dropped, not held, so
  re-enabling sends no backlog): `RESERVATIONS_EMAIL_ENABLED`,
  `RESERVATIONS_SMS_ENABLED`. `RESERVATIONS_PUBLIC_ENABLED` answers 503 on every
  public route; operator routes are unaffected.
- **Message settings screen** (`settings.messages.tsx`): per-kind enable,
  reminder and reconfirmation hours, quiet hours, SMS on/off, custom note per
  kind and locale, and a preview rendered by tenant-api
  (`GET /setup/message-texts/preview?kind&locale`, sample data only).

### 9.4 Manager alerts (`guest-messages`)

`rsv_outbox` `manager_alert` rows -> App `POST /resources/reservations/notify`
(copied from `resources+/staffing.notify.ts`): strict event schema
`{ orgId, eventId, kind, locationId, count }`; kinds `large_party_request`,
`waitlist_remote_join`, `unassigned_conflict`, `payment_failed`,
`payment_review`, `dispute_opened`, `message_failed_bulk`. The App resolves
recipients by permission and location scope, applies `NotificationPreference`
(`workflow = 'reservations.<kind>'`; defaults in-app on, email on), writes an
in-app `Notification` (kind, location id, count) and sends an optional email
(honoring `RESERVATIONS_EMAIL_ENABLED` on the App). Idempotent per event id and
member.

### 9.5 Guest message delivery rules

- A message is re-checked at send time: the reservation still in a status the
  kind applies to, the schedule version current, the guest not erased, the
  channel still allowed. Otherwise status `suppressed`.
- Delivery failures store `last_error_code` only (no destination, no body).
- A burst of failures for one location (10 in 15 minutes) raises one
  `message_failed_bulk` manager alert.

### 9.6 Dev-only email capture (`guest-messages`)

Never active in production; no real email is ever redirected.

**tenant-api (Node runtime).**

- `lib/dev-email-capture.ts` exposes `captureDevEmail(record)` and
  `isDevEmailCaptureOn()`. It is active only when all hold:
  `DEV_EMAIL_CAPTURE_DIR` is set, `NODE_ENV !== 'production'`, the runtime is
  Node (the Workers entry never imports the file sink), and OCI email is not
  configured (the message would otherwise only be mock-logged).
- `sendTenantEmail` (`src/lib/tenant-email.ts`) calls the sink on the mock
  branch, after the `[OCI EMAIL MOCK]` log line, so staffing, journey and
  reservation emails are all captured.
- Files: `<DEV_EMAIL_CAPTURE_DIR>/<YYYYMMDDTHHmmssSSS>-<uuid>.json`. The dev
  scripts set `DEV_EMAIL_CAPTURE_DIR=.dev-mail/us` (`npm run dev`) and
  `.dev-mail/ksa` (`npm run dev:ksa`), relative to `apps/tenant-api`.
- `.gitignore` (root) gains `apps/tenant-api/.dev-mail/`.
- Boot log: `DEV EMAIL CAPTURE ACTIVE -> <dir>`. If `DEV_EMAIL_CAPTURE_DIR` is
  set while `NODE_ENV=production`, the node logs a warning and ignores it.

**App (Workers dev).**

- `apps/app/workers/dev-email-capture.ts`, modeled on `dev-s3-mock.ts` and
  guarded by `process.env.MOCKS !== 'true' || import.meta.env.PROD` (so the
  production and CI Node builds never include it): wraps `fetch` for
  `https://api.resend.com/emails` only, stores the message in the control-plane
  table `__dev_email_capture` (created lazily with `CREATE TABLE IF NOT EXISTS`,
  like `__mock_pay_*`) and returns a Resend-shaped success.
- Viewer and JSON API: `apps/app/app/routes/mock-email+/` (`/mock-email`,
  `/mock-email/dev/messages?to=&since=`, `/mock-email/dev/reset`), 404 unless
  `MOCKS === 'true'`, stripped in `build:cf` with the `mock-payments+` rule.
- In Node (`start:mocks`, Vitest) MSW already captures App email into
  `packages/test-utils/fixtures/email/`; that is unchanged.

**Record format** (both sides):

```json
{ "id": "uuid", "capturedAt": "ISO", "source": "tenant-api" | "app", "region": "us" | "ksa" | null,
  "to": "...", "from": "...", "subject": "...", "html": "...", "text": "...",
  "meta": { "orgId": "...", "messageKind": "confirmation", "messageId": "rsv message id" } }
```

`meta` carries ids only. Validators read the newest file for a recipient
(`ls -t apps/tenant-api/.dev-mail/us | head`) or the App JSON API.

---

## 10. Operator App

### 10.1 Access layer (`foundation`)

`apps/app/app/utils/reservations/`:

- `access.server.ts`: `getReservationsFeatureState(orgId)`,
  `requireReservationsFeature` (404), and
  `requireReservationsAccess(request, orgSlug, { feature?, anyOf, locationId? })`
  -> member check, flag 404, permission 403, location 403; returns ids only.
  Every reservations loader and action awaits it first.
- `sections.ts` (`RESERVATIONS_SECTION_REQUIREMENTS`), `nav.ts`.
- `token.server.ts`: `mintReservationsToken`, `SCOPE_POLICIES` folding features
  and location scope.
- `reservations-client.ts`: in-memory token pool per scope, refresh 60 s early,
  shared in-flight mint, one retry on 401, `cache: 'no-store'`.
- `*-api.ts` (typed calls), `*-types.ts` (Zod from `@repo/reservations`),
  `*-view.ts` (pure, tested view math), `errors.ts` (error code -> Lingui
  message), `role-presets.ts`, `region-guard.server.ts` and
  `region-confirmation.ts` (section 5.6), `payments.server.ts` (provider calls,
  section 12).
- Hooks: `use-reservations-client.ts` (`useReservationsClient(scope)`,
  `useReservationsQuery`), `use-reservations-action.ts` (expected version,
  toast, reload on `stale_version`), `use-day-feed.ts` (ETag polling with
  `useVisiblePolling`, pauses during drags and open sheets, `useLiveNow` with
  the server offset for timers).

### 10.2 Route map (`apps/app/app/routes/_app+/$orgSlug_+/reservations+/`)

| File                                                                      | Screen                                                                                                                                                          | Requirement                   | Milestone              |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ---------------------- |
| `_layout.tsx`                                                             | guard, `ReservationsClientProvider`, location picker (hidden with one location)                                                                                 | master + any section          | `foundation`           |
| `_index.tsx`                                                              | redirect to the first allowed section                                                                                                                           | any section                   | `foundation`           |
| `token.ts`                                                                | `GET ?scope=` mint; `private, no-store`; returns `{ jwt, tenantApiUrl, scope, grants, locationIds, features, expiresAt }`                                       | per scope                     | `foundation`           |
| `settings.tsx` (tabs) + `settings._index.tsx`                             | general and online-booking settings, time-zone mismatch banner, validation and conflicts view                                                                   | read settings (write to save) | `setup`                |
| `settings.floor-plan.tsx`                                                 | full-screen floor plan editor, explicit Save, `floorPlanVersion` conflict                                                                                       | settings                      | `setup`                |
| `settings.tables.tsx`                                                     | areas, tables, combinations                                                                                                                                     | settings                      | `setup`                |
| `settings.services.tsx`                                                   | services, weekly templates, turn times, pacing, service availability                                                                                            | settings                      | `setup`                |
| `settings.special-days.tsx`                                               | special days, table and area blocks                                                                                                                             | settings                      | `setup`                |
| `today.tsx`                                                               | host list: Upcoming / Seated / Finished tabs, counters, quick actions, unassigned and conflict panel, walk-in and phone booking buttons                         | read reservation              | `reservation-book`     |
| `book.tsx`                                                                | list by date and service, search, filters, phone booking sheet                                                                                                  | read reservation              | `reservation-book`     |
| detail `Sheet` via `?r=<id>` on today/book/timeline/floor                 | reservation detail, history, side fields, guest summary                                                                                                         | read reservation              | `reservation-book`     |
| `timeline.tsx`                                                            | tables x time: drag to move or reassign (Assign vs Lock prompt), resize duration, click an empty cell to book, unassigned lane, pacing strip, auto-move notices | read (update to drag)         | `host-stand`           |
| `calendar.tsx`                                                            | month view of covers, parties, special days                                                                                                                     | read reservation              | `host-stand`           |
| `overview.tsx`                                                            | service overview (pre-service brief), service notes                                                                                                             | read reservation              | `host-stand`           |
| `floor.tsx`                                                               | live floor plan: tables by status with timers; drag a party onto a table (swap, move, overbook); section overlay                                                | read reservation              | `host-stand`           |
| `settings.sections.tsx`                                                   | section layouts, tables per section; per-service assignment lives on `floor.tsx`                                                                                | settings                      | `host-stand`           |
| `today.tsx` Requests tab, `book.tsx` request filter                       | approve / decline large-party requests                                                                                                                          | update reservation            | `online-booking`       |
| `settings.messages.tsx`                                                   | message settings, custom notes, preview                                                                                                                         | settings                      | `guest-messages`       |
| `waitlist.tsx` + `today.tsx` Waitlist tab                                 | waitlist queue, quotes, notify, seat, reorder; drag a waitlist card onto `floor.tsx`                                                                            | read reservation + `waitlist` | `waitlist`             |
| `settings.waitlist.tsx`                                                   | waitlist and notify-me settings                                                                                                                                 | settings + `waitlist`         | `waitlist`             |
| `guests.tsx`, `guests_.$guestId.tsx`                                      | Guestbook list and profile: history, stats, tags, pinned notes, merge, export, erase                                                                            | read guest                    | `guestbook-reports`    |
| `reports.tsx`                                                             | module reports (charts via `@repo/ui/chart`)                                                                                                                    | report                        | `guestbook-reports`    |
| `settings.policies.tsx`                                                   | payment policies, terms versions                                                                                                                                | settings + `payments`         | `payments-experiences` |
| `payments.fee.ts`, `payments.refund.ts` (actions)                         | charge a fee, execute an operator refund (section 12.5)                                                                                                         | payment                       | `payments-experiences` |
| `experiences.tsx`, `experiences.new.tsx`, `experiences.$experienceId.tsx` | Experiences setup, schedules, caps, publish                                                                                                                     | settings + `experiences`      | `payments-experiences` |

Loaders return ids, flags, location facts (`{ id, name, timeZone }`) and `can`
booleans only; every guest field is fetched in the browser. Reservation detail
is a `Sheet` opened by `?r=<id>` (no route-based dialogs, ADR 023).
`shouldRevalidate` returns false within the organization. No `clientLoader` or
`clientAction`.

### 10.3 Polling and timers

| Screen                                   | Poll        | Notes                                       |
| ---------------------------------------- | ----------- | ------------------------------------------- |
| `today.tsx`, `floor.tsx`, `waitlist.tsx` | 5 s (ETag)  | paused during drags and while a sheet edits |
| `book.tsx`, `timeline.tsx`               | 10 s (ETag) | paused during drags                         |
| `calendar.tsx`, `overview.tsx`           | 60 s        |                                             |
| `bookings-today` dashboard block         | 60 s        | while visible                               |
| Guestbook, settings, reports             | none        |                                             |

Timers (seated time, late, running long) update every 15 s from `useLiveNow`.

### 10.4 UI building blocks

- Timeline and drag and drop modeled on
  `components/staff/schedule/day-timeline.tsx` and `schedule-dnd.tsx` (dnd-kit,
  keyboard sensor, localized spoken announcements, CSS-variable logical
  positioning).
- Floor plan: DOM/SVG absolutely positioned tables (inline
  `left/top/width/height/transform` are lint-allowed), dnd-kit with grid snap,
  custom resize and rotate handles, arrow-key nudge (Shift for 10 units). Room
  geometry is stored and drawn canonical (never mirrored in RTL); the
  surrounding chrome is mirrored.
- Section colors from theme-token keys (the `PositionDot` palette); status
  colors from permitted palettes; `@repo/ui` primitives only; no new App ESLint
  errors.
- Lingui `t`/`Trans` everywhere; `npm run lingui:extract -w app` and Arabic
  `msgstr` filled for every new string.
- Playwright specs (one per App-facing milestone) insert `ConfigFlag` rows and
  stub `**/operator/reservations/**` (staffing pattern).

---

## 11. Sites

Built in `online-booking` unless a bullet names another milestone.

- **Pages:** `src/pages/reserve/index.astro` (booking flow),
  `reserve/manage.astro` (fragment `#t=`), `reserve/waitlist.astro` (join and
  status `#t=`, `waitlist`), `reserve/pay.astro` (payment hand-off for web and
  native, fragment `#r=&t=` or `#f=&t=`, `payments-experiences`),
  `experiences/index.astro` and `experiences/[slug].astro`
  (`payments-experiences`). Locale prefixes (`/ar/reserve`) work through the
  existing middleware rewrite.
- **Gate:** SSR calls App `/resources/sites/reservations` (404 -> a CMS page
  named `reserve` or 404, like careers). Experience pages SSR-fetch the public,
  non-PII `GET {tenantApi}/reservations/experiences` (FormBlock precedent: 3 s
  timeout, short cache). No guest data is fetched or rendered server-side.
- **Routing and caching:** `isSitesReservationsRoute` in
  `src/lib/site-headers.ts`, added to `isSitesAppRoute`; `no-store` for
  `/reserve*`; experience pages `max-age=60`.
- **Flow** (client modules `src/lib/reservations/*`, components
  `src/components/reservations/*`): location -> party size -> date (calendar
  summary) -> time chips with seating-area labels -> nearby alternatives, other
  dates, "Notify me", "Join waitlist" (same day) -> hold with countdown (reuse
  `lib/ordering/hold-timer.ts`, `countdown.ts`, offset by the server `now`) ->
  details (name, phone, email, occasion chips, requests, dietary chips and
  notes, seating preference, SMS opt-in, marketing opt-in, policy text and
  consent) -> payment step when required -> confirmation (code, add-to-calendar
  via `lib/ordering/calendar.ts`, manage link). The manage token is kept in
  `sessionStorage` and the URL fragment, never sent to the Sites server.
- **Voice hand-off** (`integrations`): `/reserve#h=<holdToken>` resumes a
  phone-agent hold through `GET /reservations/holds/current` and opens the
  details step.
- **Signed-in customers** (tokens in `localStorage` via `client-auth.ts`) get
  prefilled details and the `customer_id` binding; `profile.astro` gains an
  "Upcoming reservations" panel from `/reservations/mine`.
- **Large-party requests:** above the online maximum the flow shows the contact
  note or a request form (`POST /reservations/requests`).
- **Block:** `src/components/blocks/ReservationBlock.astro`, registered in
  `RenderBlocks.astro`: a compact party/date/time bar that mounts the same
  client inline or links to `/reserve?location=&party=&date=&time=`.
- **i18n:** six locales (`en`, `ar`, `es`, `fr`, `de`, `zh`) through Lingui
  `msg` in `src/locales/*.po`, non-empty translations required (a label
  completeness test), labels passed to scripts through a JSON label block; RTL
  for `ar`; times in restaurant local time, with the zone shown when the
  visitor's zone differs.
- **Turnstile:** the `PUBLIC_TURNSTILE_SITE_KEY` widget with actions
  `reservation-hold`, `reservation-request`, `reservation-notify`,
  `waitlist-join`; honeypot field `website`. Empty keys locally disable the
  widget; enforcement is covered by tenant-api tests.
- **Regional URL:** the existing `data-tenant-api-url` on `<html>`, read by
  `getBrowserTenantApiUrl()`; CSP `connect-src` already includes the US and KSA
  tenant-api origins.
- **Payment hand-off** (`payments-experiences`): Sites
  `src/pages/api/reservations/payment.ts` and `payment-status.ts` forward opaque
  `{ reservationId | feeId, paymentToken, purpose, locale }` to the App
  (ordering pattern; the token is opaque, not PII). `order-client.ts` and the
  new reservation client accept `http:` checkout URLs only for loopback hosts
  (`localhost`, `127.0.0.1`, `*.localhost`) outside production
  (`payment-mocks`).

---

## 12. Payments

### 12.1 Principles

- The regional tenant-api decides amounts, policy, holds, state and capacity.
  The App is the only component that talks to providers; it sees only opaque
  ids, amounts and currency. The guest types card and email on the provider
  page.
- Provider metadata carries only opaque ids:
  `{ type: 'reservation_payment' | 'reservation_fee' | 'reservation_refund', orgId, reservationId, purpose, feeId? }`.
  Product names are generic: `Reservation deposit`, `Reservation prepayment`,
  `Experience ticket`, `Card guarantee`, `No-show fee`, `Late cancellation fee`.
  An experience title may appear (it is catalog data).
- The flow is the ordering pattern: **quote -> bind once -> status**.
  Idempotency keys are deterministic; terminal states never regress.
- Fees are never charged automatically (I12). Refunds are decided regionally and
  executed by the App through the outbox.
- App rules for provider payloads: map each verified event to an ids-and-amounts
  DTO immediately; never persist raw events; never log payloads or full error
  objects; subscribe only to needed event types; never `expand` customer or
  billing details.
- Gated by `reservations.payments` and by processor capability (12.7).

### 12.2 Processors

|                           | US: Stripe Connect                                                                                                                                                                            | KSA (and any region): Checkout.com                                                                                                                               |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account                   | Express account (existing onboarding); destination charges on the platform with `transfer_data.destination`; no `on_behalf_of`; `statement_descriptor_suffix` from a sanitized org short name | sub-entity (existing invite flow), with the US-only guards removed                                                                                               |
| Deposit / prepay / ticket | Checkout Session `mode: 'payment'`, `payment_method_types: ['card']`, `application_fee_amount`                                                                                                | Hosted Payments Page `hostedPayments.create` with `amount_allocations: [{ id: subEntityId, amount, commission: { amount: platformFeeMinor } }]`, 3DS             |
| Card guarantee            | Checkout Session `mode: 'setup'` with a PII-free Customer per `(orgId, guestRef)`                                                                                                             | HPP with `payment_type: 'Unscheduled'`, store for future use (card verification), returns `src_` and the CIT payment id                                          |
| Fee charge                | off-session PaymentIntent (`off_session: true, confirm: true`)                                                                                                                                | MIT `POST /payments` with `source: { type: 'id', id: 'src_...' }`, `merchant_initiated: true`, `payment_type: 'Unscheduled'`, `previous_payment_id`, allocations |
| Refund                    | `refunds.create` with `reverse_transfer: true`, `refund_application_fee: true`                                                                                                                | `POST /payments/{id}/refunds` with reversal `amount_allocations` (commission reversed proportionally)                                                            |
| Status without webhook    | `checkout.sessions.retrieve` (with `expand: ['setup_intent']` for setup)                                                                                                                      | `GET /hosted-payments/{id}` and `GET /payments/{pay_or_sid}` (from `cko-session-id`)                                                                             |
| Webhooks                  | `api+/stripe+/webhook.tsx`                                                                                                                                                                    | `api+/shop+/webhook.tsx`                                                                                                                                         |
| Currencies                | USD, CAD                                                                                                                                                                                      | SAR (and USD)                                                                                                                                                    |

- `withConnect` (`commerce.ts:300-308`) is fixed to keep the provider error
  class and `code` (`authentication_required`, `card_declined` with
  `decline_code`) instead of flattening them (`payment-mocks`).
- `getStripeWebhookSecrets()` returns
  `[STRIPE_WEBHOOK_SECRET, STRIPE_CONNECT_WEBHOOK_SECRET?]`; the webhook tries
  each, so platform events (`checkout.session.*`, `payment_intent.*`,
  `charge.*`) and Connect events (`account.updated`) both verify
  (`payment-mocks`).
- Checkout.com order checkout moves from Flow `paymentSessions.request` to HPP
  `hostedPayments.create`, with a status lookup that needs no webhook;
  `restaurant.ts:155-182` accepts the HPP id and reference (`payment-mocks`).
- The three US-only Checkout.com guards (`shop-card.tsx:78-84`,
  `settings+/shop.tsx:215-222`, `shop.server.ts:333-335`) are removed
  (`payment-mocks`), so `riyadh-grill` can onboard through the real UI.
- KSA caveat: mada has limited stored-credential and MIT support, and 3DS is
  effectively mandatory for customer-initiated payments. Card guarantees and
  fees on Checkout.com are best effort; a failed MIT uses the pay-link recovery
  (12.5). Operators see "Prepaid deposits are recommended in this region" on the
  policy form for KSA locations.

### 12.3 Platform fee on reservation payments

- The App reads `reservations.platform_fee_bp` (section 5.2) when it creates a
  provider session or charge, computes `platformFeeMinor`, and sends it as
  Stripe `application_fee_amount` or the Checkout.com `commission.amount`.
- The App reports `{ platformFeeBp, platformFeeMinor }` in `/bind` (sessions)
  and `/fee-result` (fees); the regional payment row stores the snapshot.
- Refunds reverse the fee proportionally: Stripe `refund_application_fee: true`
  together with `reverse_transfer: true`; Checkout.com reversal allocations with
  `commission = round(platformFeeMinor * refundMinor / amountMinor)`. Tests
  assert the ledger in the emulators.
- With the seeded default of 0, no fee is taken until Admin sets one.

### 12.4 Deposit, prepayment and experience tickets

1. The browser books on regional `POST /reservations`. A policy that needs
   payment creates `pending_payment`, extends the hold to `payment_hold_minutes`
   (`extended_for_payment = 1`), sets `payment_expires_at`, and returns
   `payment: { paymentToken, purpose, amountMinor, currency, expiresAt, payUrl }`.
2. The browser (or a native app through `payUrl` =
   `<siteOrigin>/reserve/pay#r=<id>&t=<paymentToken>`) calls Sites
   `POST /api/reservations/payment`, which forwards opaque references to App
   `POST /resources/sites/reservation/checkout`.
3. The App resolves the organization by slug or host, checks the processor
   (`resolveReservationOnlinePayment`, a variant of
   `resolveRestaurantOnlinePayment` that takes the currency from the location),
   calls regional `/api/reservations/payments/quote`, recovers a bound session
   if one exists, otherwise creates the provider session (Stripe
   `expires_at = max(now + 31 min, paymentExpiresAt)`; idempotency key
   `reservation_<purpose>_<sha256(orgId|reservationId|purpose|amount|CUR|paymentExpiresAt)[0:40]>`),
   then calls `/bind` once and returns `{ checkoutUrl, processor }`.
4. Success, failure or expiry arrives by webhook, by the browser status poll
   (Sites `/api/reservations/payment-status` -> App
   `/resources/sites/reservation/status`, which retrieves the session or HPP and
   pushes the terminal state), or by the reconcile job. Regional `/status`
   accepts a terminal event only when the session id, processor, amount and
   currency match the bound session; duplicates are idempotent. Success ->
   `booked`, `payment_status = paid`, `payment_received` message.
5. **Expiry:** at `payment_expires_at` the tick expires the reservation
   (`expired`, capacity released) and enqueues `checkout_expire`; the App
   expires the Stripe session (`checkout.sessions.expire`) so a late payment
   becomes unlikely.
6. **Late payment** (success after expiry, reachable because the Stripe session
   minimum is 30 minutes): regional re-runs the plan inside the write path. If
   the slot still fits, it books (`outcome: 'confirmed'`). Otherwise it returns
   `outcome: 'refund_required'`; the App refunds in full at once (idempotency
   key `reservation_late_refund_<paymentRef>`) and reports `/refund-result`; the
   guest gets `late_payment_refunded`. Only if that refund call fails does the
   payment move to `review` with a `payment_review` manager alert.
7. Experiences use the same flow (`purpose: 'experience'`; Stripe line quantity
   = covers when priced per cover).

### 12.5 Card guarantee, no-show and late-cancel fees

- **Guarantee:** the same hand-off with `purpose: 'guarantee'`. Stripe: a
  Customer with no name, email or phone (`metadata: { orgId, guestRef }`,
  `guestRef` = HMAC of the guest id; idempotency key
  `reservation_customer_<sha(orgId|guestRef)>`), then a setup-mode session with
  `currency`, `payment_method_types: ['card']`, the consent text in
  `custom_text.submit.message` (amount cap, trigger, window, time zone; at most
  1200 characters). Checkout.com: an `Unscheduled` CIT that stores the card.
  Completion stores the provider customer, payment method, CIT id and card
  display facts regionally, records consent (`policy_accepted_at`,
  `policy_text_hash`, terms version) and sets `payment_status = guaranteed`. The
  booking stays `pending_payment` until the guarantee completes.
- **Fee charge (staff only):**
  1. The host stand calls regional
     `POST /operator/reservations/payments/reservations/:id/fee` with a
     `payments` token. Regional checks the state (`no_show`, or `cancelled` with
     `late_cancel`), a guarantee on file, no earlier successful fee, and
     computes the amount from the booking-time snapshot (per cover or flat,
     clamped to the cap and to the operator's lower amount, at or above the
     currency minimum). It inserts `rsv_payments` (`fee_pending`), audits, and
     returns `{ feeId, amountMinor }`.
  2. The browser calls App action `reservations+/payments.fee.ts`
     `{ reservationId, feeId }`; the action awaits `requireReservationsAccess`
     with `update:reservation_payment:any`.
  3. The App calls regional `/api/reservations/payments/fee-claim`, which moves
     `pending -> charging` atomically (single shot) and returns the amount,
     currency, provider refs and `attempt`.
  4. The App charges off-session (Stripe) or MIT (Checkout.com), idempotency key
     `reservation_fee_<sha(orgId|reservationId|feeId|attempt)>`, and calls
     `/fee-result`.
  5. Outcomes: `succeeded` -> `fee_charged` and a `fee_charged` message;
     `authentication_required` -> `requires_action`, regional sends
     `fee_action_required` with a pay link
     (`<siteOrigin>/reserve/pay#f=<feeId>&t=<token>`), and the App cancels the
     dangling PaymentIntent; `card_declined` -> `fee_failed` with
     `decline_code`, and the operator may retry once with `attempt + 1` or send
     the pay link.
- **Disputes:** `charge.dispute.created/closed` (Stripe) and Checkout.com
  dispute events are mapped by metadata and reported to `/dispute`
  (`payment_status = disputed`, `dispute_opened` manager alert). Reported only.

### 12.6 Refunds and the internal contract

- **Guest cancel:** regional computes `cancellationTerms` in the location time
  zone from the snapshot (full before the window, partial or none after);
  **restaurant cancel** is always full. It writes a `refund` row (`requested`)
  and a `refund_request` outbox row.
- **Operator partial refund:**
  `POST /operator/reservations/payments/reservations/:id/refund`; regional
  rejects amounts above `amount_minor - refunded_minor`.
- **Execution:** the tick delivers `refund_request` to App
  `POST /resources/reservations/payments`; the App claims it (`/refund-claim`),
  refunds (key `reservation_refund_<sha(orgId|refundRequestId)>`) and reports
  `/refund-result` (`succeeded` | `pending` | `failed`). Pending refunds settle
  through `refund.updated`/`refund.failed` or the reconcile job. Stripe
  processing fees are not returned (the platform pays them).
- **Reconcile job:** jobs-cron calls App
  `/resources/jobs/reservation-payments-reconcile` hourly; the App asks each
  node `/api/reservations/payments/pending` for bound sessions still pending and
  refunds still pending, retrieves them from the provider, and pushes terminal
  states.

Internal contract (all POST, `INTERNAL_COMMAND_TOKEN`, `assertOrgRegion`
fail-closed, ids and amounts only, `private, no-store`, mirroring
`regional-order-api.server.ts`):

| tenant-api endpoint                | Request                                                                                                                                                                                                                                                               | Response                                                                                                                                                                                                                                |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/reservations/payments/quote` | `{ orgId, reservationId \| feeId, paymentToken, purpose }`                                                                                                                                                                                                            | `{ purpose, mode: 'payment' \| 'setup', amountMinor, currency, expiresAt, status, paymentStatus, boundSession?, providerCustomerRef?, locationId, policy: { kind, unitMinor, partySize, capMinor, freeCancelUntilMin, termsVersion } }` |
| `/bind`                            | `{ orgId, reservationId, purpose, sessionId, processor, providerCustomerRef?, platformFeeBp, platformFeeMinor }`                                                                                                                                                      | `204` or `409 { error: 'already_bound' \| 'payment_terminal' \| 'hold_expired' }`                                                                                                                                                       |
| `/status`                          | `{ orgId, reservationId, purpose, sessionId, processor, status: 'paid' \| 'failed' \| 'expired' \| 'setup_succeeded', amountMinor, currency, paymentRef?, paymentMethodRef?, providerCustomerRef?, previousPaymentRef?, card?: { brand, last4, expMonth, expYear } }` | `{ outcome: 'recorded' \| 'duplicate' \| 'confirmed' \| 'refund_required' \| 'review' }`                                                                                                                                                |
| `/fee-claim`                       | `{ orgId, reservationId, feeId }`                                                                                                                                                                                                                                     | `{ amountMinor, currency, providerCustomerRef, paymentMethodRef, previousPaymentRef?, kind, attempt }` or `409`                                                                                                                         |
| `/fee-result`                      | `{ orgId, reservationId, feeId, attempt, paymentRef, status: 'succeeded' \| 'requires_action' \| 'failed', declineCode?, platformFeeBp, platformFeeMinor }`                                                                                                           | `204`                                                                                                                                                                                                                                   |
| `/refund-claim`                    | `{ orgId, refundRequestId? }` (omit for a batch)                                                                                                                                                                                                                      | `{ refunds: [{ refundRequestId, reservationId, paymentRef, processor, amountMinor, currency, platformFeeMinor }] }`                                                                                                                     |
| `/refund-result`                   | `{ orgId, refundRequestId, refundRef, amountMinor, status }`                                                                                                                                                                                                          | `204`                                                                                                                                                                                                                                   |
| `/dispute`                         | `{ orgId, reservationId, paymentRef, disputeRef, status }`                                                                                                                                                                                                            | `204`                                                                                                                                                                                                                                   |
| `/pending`                         | `{ orgId? }`                                                                                                                                                                                                                                                          | `{ sessions: [...], refunds: [...] }` (ids only)                                                                                                                                                                                        |

### 12.7 Capability gating and region switch

- The context `payments` block reflects processor support: `deposit` true for a
  charges-enabled Connect account (US) or an enabled Checkout.com sub-entity;
  `guarantee` true for Connect, and for Checkout.com when the processing channel
  supports stored credentials (always true in mock mode).
- Policies of unsupported kinds cannot be saved; booking fails closed with
  `policy_unavailable` if the processor became unavailable.
- The region-switch guard counts unsettled payments and refuses while any exist
  (section 5.6).
- Payment badges (deposit paid, card on file, fee due, refund pending, disputed)
  appear on host-stand rows and the detail sheet; a payment panel in the sheet
  lists rows and offers Charge fee and Refund to holders of the payment grant.

---

## 13. Payment mocks (summary)

Built in `payment-mocks` and validated against existing online ordering (a US
Stripe order on `acme`, a KSA Checkout.com order on `riyadh-grill`) before any
reservation payment uses them. Full design:
`{missionDir}/library/payment-mocks.md` (distilled from
`research/codebase/payment-mocks-design.md`).

- **Approach:** the real SDKs talk to an in-process, stateful emulator. Stripe:
  `new Stripe(key, { httpClient: Stripe.createFetchHttpClient(mockFetch) })`.
  Checkout.com:
  `new Checkout(key, { host: 'https://checkout-com.mock.invalid', ... })` with a
  fetch wrapper that intercepts only that reserved `.invalid` origin. Code in
  `packages/payments/src/mock/` (subpath `@repo/payments/mock`) and
  `apps/app/app/utils/payments-mock/`.
- **Activation:** `paymentsMockMode(env)`: off unless the bundle includes the
  mock; `PAYMENTS_MOCK=false` forces off; on with `MOCKS=true` or
  `PAYMENTS_MOCK=true`; throws on an `sk_live_` key; a real test key for a
  provider disables that provider's mock. When on, synthetic config makes
  `isProcessorConfigured` behave as in production; organizations still need
  onboarding.
- **Production exclusion, four layers:** (1) a vite define
  `__PAYMENTS_MOCK_BUNDLED__ = !(DEPLOY_TARGET === 'cloudflare' && command === 'build')`;
  (2) `app/routes.ts` ignores `**/mock-payments+/**` and `**/mock-email+/**`
  when `STRIP_DEV_MOCKS=1`, which `build:cf` sets; (3) runtime 404 on every mock
  route unless the mode is on, plus the live-key refusal; (4) a CI check that
  greps the `build:cf` Worker bundle for the sentinel `__MENUZA_PAYMENTS_MOCK__`
  and fails if found. No `NODE_ENV` gate (CI runs
  `NODE_ENV=production MOCKS=true`).
- **State:** `__mock_pay_object`, `__mock_pay_idempotency`, `__mock_pay_event`
  in the control-plane `db` (local D1 in Workers dev, LibSQL in Node), created
  lazily with `CREATE TABLE IF NOT EXISTS`; no Drizzle migration. Time-based
  transitions are evaluated lazily with an injectable clock.
- **Pages** at `/mock-payments/*`: Stripe Checkout (payment and setup) with a
  3DS page; Connect onboarding (Complete / requirements due / payouts
  restricted) and the Express dashboard ledger; Checkout.com HPP with a 3DS
  password page (`Checkout1!`); the Checkout.com dashboard (Activate
  sub-entities, payments, allocations, commission); an event log with Redeliver.
- **Behavior:** real test-card semantics (`4242...`, `3155`, `3184`
  `authentication_required` off-session, `0341`, `9995`, `0002`, `3178`,
  `7726`/`5126` async refunds, `0259` dispute; Checkout.com amount-based
  declines and a mock mada card that declines MIT); signed webhooks dispatched
  in-process to the real route modules, mode `PAYMENTS_MOCK_WEBHOOKS` = `inline`
  (default) | `deferred` | `manual`.
- **Dev control API** `/mock-payments/dev/*`: `onboard`, session and HPP
  `complete`, `sessions/:id/expire`, `refunds/:id/settle`, `disputes`,
  `clock/advance`, `events`, `events/flush`, `events/:id/redeliver`,
  `objects/:provider/:id`, `reset`. Settings -> Shop shows an instant onboarding
  panel in mock mode only.
- **Coverage:** Stripe Connect onboarding (with the `withConnect` fix), Checkout
  payment and setup modes, off-session PaymentIntents, refunds and disputes;
  Checkout.com sub-entities (KSA guards removed), HPP (orders move from Flow to
  HPP), stored instruments and MIT, refunds and allocations.
- **Test harness:** Vitest helpers (`createPaymentsEmulator`,
  `configureShopCommerceForTests(env, { emulator })`) and Playwright page
  objects keyed on `data-testid`; tests assert through status endpoints and
  regional state, never on the redirect alone.

---

## 14. Integrations

### 14.1 Phone agent (`integrations`, US only)

- **Core (generic, no restaurant words):** add
  `action(name: string, input: unknown): Promise<VerticalActionResult>` to
  `VerticalServices` in `packages/phone-agent/src/vertical.ts`, where
  `VerticalActionResult = { ok: true; data: unknown } | { ok: false; reason: 'unavailable' | 'rate_limited' | 'not_enabled' | 'invalid' | 'conflict'; explanation: string }`.
  The worker (`apps/voice-agent/src/services.ts`) POSTs
  `/api/voice/actions/:name` with `{ orgId, callId, scopeId, channel, input }`;
  add it to `controller.toolContext()` and the fakes in `test-fixtures.ts`.
  `packages/phone-agent/src/vocabulary.test.ts` stays green.
- **tenant-api registry:** `services/voice-actions.ts`
  `registerVoiceAction({ name, schema, maxPerCall, run(ctx, input) })`,
  registered at startup in both `src/index.ts` and `workers/index.ts`; route in
  section 7.5.
- **Restaurant actions** (`src/restaurant/reservations-voice.ts`), each
  re-checking `features.voice`, the US region and the location setting through
  the context cache, and each calling the same services as the public routes
  with `channel = 'voice_agent'` and guest-channel rules:
  - `reservations.availability`
    `{ locationId?, date, time?, partySize, areaPref? }` -> up to 3 nearest
    slots `{ localTime, partySizeFits, requiresPayment }`. Never returns guest
    data.
  - `reservations.hold` `{ slot, partySize, firstName }` -> a hold of
    `voice_hold_minutes` (`source = 'voice_agent'`, `voice_call_id`), returning
    the hold token to tenant-api only; the tool then texts
    `/reserve#h=<holdToken>` through `sendLink`, and the guest confirms (and
    pays if needed) on Sites.
  - `reservations.book` (only when `voice_mode = 'confirm_on_call'` and no
    policy requires payment) `{ slot, partySize, firstName, lastName? }` ->
    books with the caller's number as an **unverified** contact, sends the
    confirmation with a manage link.
- **Tools** (`packages/phone-agent-restaurant/src/tools.ts`):
  `check_table_availability` -> `reservations.availability`; `book_table` ->
  `reservations.hold` + `sendLink` by default, or `reservations.book` in
  confirm-on-call mode. `record_request` (type `reservation`) remains the
  fallback when the module is off, an action fails, or the party is too large.
  The prompt switches from request capture to booking when the tools are
  enabled. `classifyPurpose` returns `reservation` when a booking tool ran;
  `summarizeCall` adds "Held a table for 4 on Fri 7:30 pm" (no name).
- **Caller-ID trust:** never look up or read back a guest by caller ID; no
  modify or cancel by phone except texting the manage link to the number on the
  booking; never link a phone booking to an OTP `customers` row.
- **Test calls:** `web_test` runs dry (section 7.5); links are shown on screen
  as today. Validation is tool tests and API calls only (no live calls).
- **App:** the restaurant vertical config builder gains booking facts (no PII);
  the phone-agent settings page shows the toggle when `reservations.voice` is on
  and the organization is US.

### 14.2 Staffing forecast (`integrations`)

- Replace the single order-source slot with a **demand-source registry**
  (`apps/tenant-api/src/services/demand-sources.ts`):
  `registerDemandSource({ id, unit, loadBuckets, loadBooked })`, where `unit` is
  `'orders' | 'visits'` (generic words). `registerOrderSource` stays as a
  wrapper that registers the `orders` source, and `hasOrderSource()` keeps
  `labor-data.ts` and `activeReportCatalog()` behavior unchanged, so registering
  reservations does not flip the sales source or catalog wording.
- `BookedOrderFact` generalizes to `{ date, hour, units }` per source.
- `src/restaurant/reservations-demand-source.ts` registers `visits`:
  `loadBuckets` sums `seated_covers` (or `party_size`) of seated and finished
  reservations and walk-ins by seated time; `loadBooked` sums `party_size` of
  capacity-consuming future reservations by local start hour (`scopeId` =
  location id). Counts only; no guest columns selected.
- Labor standards per unit: `labor_scope_settings.demand_per_labor_hour`
  (migration `0017`). `computeForecastGap`
  (`packages/staffing/src/forecast-gap.ts`) computes need per source and sums
  per position; a position without a standard for a unit ignores that unit.
  Output gains `sources` and per-slot `bookedBySource`.
- UI: `forecast-strip.tsx` shows "12 covers booked" (restaurant wording through
  the scope-wording provider) and labor settings gain a standards input per
  unit. `packages/staffing/src/vocabulary.test.ts` stays green (no "covers" or
  "table" in `packages/staffing`).

### 14.3 Journeys (`integrations`)

- Trigger types `reservation_booked`, `reservation_completed`,
  `reservation_no_show`, `reservation_cancelled` added to
  `JOURNEY_TRIGGER_TYPES`, the `marketing_journeys.trigger_type` enum, and both
  label maps (`workflow-labels.ts` `TENANT_TRIGGER_MSGS` /
  `TENANT_TRIGGER_OPTION_MSGS`, `workflow-config.tsx` `TENANT_TRIGGER_LABELS` /
  `TENANT_TRIGGER_OPTIONS`). The App editor (`marketing+/automations.new.tsx`,
  `automations.$journeyId.tsx`) offers them only when `reservations.enabled` is
  on (allowed list passed into the workflow config).
- **Eligibility:** fire only when the guest is verified
  (`rsv_guests.customer_id` set from an OTP customer) **or** gave explicit
  marketing consent at booking. On consent the booking service upserts an
  unverified `customers` row by normalized phone (precedent:
  `POST /auth/send-code` creates unverified rows), stores it in
  `rsv_guests.marketing_customer_id`, and records `customer_subscriptions` rows
  (topic `reservations`, channels `email` and/or `sms`, source
  `reservation_booking`; the TypeScript enums are widened). Without either, no
  journey runs; reports and the Guestbook still count the visit.
- **Emission:** `src/restaurant/reservations-journeys.ts` runs after the status
  transition commits (host actions and the tick), inserts
  `rsv_journey_emissions (reservation_id, trigger)` first (a conflict means
  already emitted, so nothing happens), then calls
  `evaluateAndSpawnTriggers(orgId, trigger, customerId, tenantApiUrl, contextData)`
  with ids-only `contextData`
  `{ reservationId, locationId, partySize, businessDate, serviceId, channel, experienceId, visitNumber }`.
  Never names, notes or allergies.
- **Consent check in step execution:** `executeJourneyStep` gains a check for
  journeys whose trigger is a `reservation_*` type: a step on a channel without
  an active `customer_subscriptions` row (topic `reservations`) is recorded as
  `skipped`. Other trigger types keep today's behavior.
- Transactional messages (confirmation, reminder, cancellation) are not journeys
  and need no consent topic.

### 14.4 Reports (`guestbook-reports`)

- **Module reports:** the fixed aggregate endpoints in section 7.2, rendered in
  `reports.tsx`; each run is audited.
- **Generic subjects** in `packages/reports/src/catalog-reservations.ts`
  (`RESERVATIONS_REPORT_SUBJECTS`): `bookings` (one row per reservation:
  business date, local time, location, service, party size, covers, status,
  channel, duration, actual turn, tables count, experience, payment status,
  deposit/fee/refund amounts as recorded facts; no contact data) and
  `waitlist_entries` (date, party, channel, quoted vs actual wait, outcome).
  Both added to `RESTRICTED_REPORT_SUBJECTS` and hidden by `catalogForGrants`
  without the grant.
- **Access:** `reports+/token.ts` grants them through
  `resolveReservationsReportAccess()` (master flag plus
  `read:reservation_report:any`, location scope as `scopeIds`, impersonation
  gets none).
- **Loaders:** `apps/tenant-api/src/services/rsv-report-records.ts`, SQL
  aggregates with a row cap and `sourceTruncated`, scope filter from the token,
  records carrying the location time zone, dispatched in `routes/analytics.ts`
  next to staff; each run writes `report.run`.

### 14.5 Dashboard block (`guestbook-reports`)

- `bookings-today` added to `BUILT_IN_BLOCK_TYPES` (lg 6x8, `maxInstances: 1`)
  in `utils/dashboards/config.ts`.
- The server passes only
  `{ tokenUrl: '/<slug>/reservations/token?scope=book', tenantApiUrl, locations }`;
  the browser mints a `book` token and calls
  `GET /operator/reservations/book/today` (counts by status, covers by service,
  next arrivals with first name, time, party and status, waitlist count).
  Refreshes every 60 s while visible.
- Hidden through `hiddenBlockIds` and removed from `addableBuiltInBlockTypes`
  unless the flag is on and the viewer holds `read:reservation:any`; the loader
  computes this from flags and permissions. Nothing is added to
  `loadBuiltInBlockData` (it must not read regional data).

### 14.6 Guestbook and existing customers

- The Guestbook is a regional module CRM at `/operator/reservations/guests/*`
  and App `reservations+/guests*`. The existing `customers.tsx` page is
  unchanged.
- Guests link to tenant customers only by the opaque `customer_id` (verified)
  and `marketing_customer_id` (consent) columns; no guest data is copied into
  `customers`, and booking never creates a login.
- Erasing a guest anonymizes `rsv_guests` (names to "Erased guest", contact and
  notes cleared, tags removed), redacts events and audit rows, cancels future
  bookings with a `cancellation_restaurant` message sent before the contact is
  cleared, and records `guest.erase`. Erasing a tenant customer calls
  `/internal/reservations/erase-customer`.
- Export: JSON of the profile, visits, tags, notes and messages metadata;
  allergy and dietary text excluded unless `includeSensitive` and the update
  guest grant; audited.

---

## 15. Native apps

### 15.1 Server readiness (`native-apps`; the API shape lands in `online-booking`)

- Native clients use the same public routes (section 7.3), sending the site
  origin as `Origin`, `X-Client: ios | android` (channel `native`), and the
  customer access token. Booking from native requires phone-OTP sign-in; the
  verified token substitutes for Turnstile on `/holds`, `/requests`,
  `/waitlist/join` and `/notify-me`, and supplies the phone (no phone field).
- Every mutation is POST; deadline responses carry `expiresAt` and the server's
  `now`.
- Payment: open `payment.payUrl` in the system browser; on return (app resume)
  poll `GET /reservations/manage/payment`.
- **Contract fixtures:**
  `apps/tenant-api/scripts/record-reservations-fixtures.ts` records responses
  from the local tenant-api (seeded `acme`) into
  `packages/reservations/contract-fixtures/*.json` and copies them to
  `apps/ios/Tests/TenantKitTests/Fixtures/Reservations/` and
  `apps/android/app/src/test/resources/reservations/`. A tenant-api Vitest
  contract test (`src/routes/reservations-contract.test.ts`) parses the
  canonical fixtures with the public Zod schemas and checks the native copies
  are byte-identical.

### 15.2 iOS (`apps/ios`)

- **TenantKit (Foundation only, `swift build`/`swift test` on Linux):**
  `Sources/TenantKit/Reservations/ReservationsClient.swift` (methods on the
  existing client through `HTTPTransport` and `CustomerSession.authorized`,
  `Origin` and `X-Client: ios` on every call), `ReservationModels.swift`
  (`Decodable`), `BookingFlow.swift` (pure state machine: search -> slot -> hold
  -> details -> payment -> confirmed; hold countdown from `expiresAt` and the
  server offset; alternatives; modify/cancel eligibility; error mapping for
  `slot_unavailable` 409, `hold_expired` 410, `policy_required` 422,
  `rate_limited` 429), and fixture-based tests.
- **SwiftUI (`Sources/TenantApp/Reservations/`, compiled only in macOS CI):**
  reservations home (Book a table, My reservations), location picker, search
  with party stepper, date strip, time chips and alternatives, details, review
  with the hold countdown, deposit in the system browser with a poll on return
  (`scenePhase`), confirmation, detail with modify, cancel and running late, and
  the waitlist. A `NavigationStack` inside the signed-in branch of `RootView`.
  Keep views thin and close to existing patterns. Manage tokens are stored in
  the Keychain.

### 15.3 Android (`apps/android`)

- **Core (`core/reservations/`, plain Kotlin + org.json, JVM tests):**
  `ReservationsClient` on `TenantApiClient` (POST only, `Origin`,
  `X-Client: android`), models with `fromJson`, the same `BookingFlow` state
  machine, fixture tests.
- **UI (`ui/reservations/`, framework views only):** the same screens as iOS,
  screen keys `res:home`, `res:location`, `res:search`, `res:details`,
  `res:review`, `res:confirmed`, `res:detail:<id>`, `res:waitlist`, and a small
  back stack in `AppState`; time chips as `TextView`s in a wrapping
  `LinearLayout`; `java.time`; framework `DatePickerDialog`; payment through
  `MainActivity.openUrl` with a poll in `onResume`; manage tokens in the
  Keystore-backed storage.
- Six locales (`values`, `values-ar`, `-es`, `-fr`, `-de`, `-zh`), RTL for
  Arabic.
- **Byte budget:** measure with `assembleRelease bundleRelease` and
  `scripts/size-report.mjs` on every iteration (baseline APK 88,676 / 160,000,
  AAB 145,554 / 220,000). If the feature needs more, raise
  `apps/android/size-budget.json` in the same commit with the reason in its
  `$comment`.
- Validation on this machine: `testDebugUnitTest`, `assembleDebug`, `lintDebug`,
  release build and size report, `swift build` and `swift test`. The user checks
  the screens on devices.

---

## 16. Security and testing gates

### 16.1 Required gates (every new route must pass both sweeps)

1. **`apps/tenant-api/src/routes/reservations-security.test.ts`** (scaffold in
   `foundation`, modeled on `staffing-security.test.ts`). It enumerates every
   route of the six operator routers and asserts: 401 without a token, with a
   wrong secret, a wrong audience (including a staffing token and a
   `tenant-api-operator` token) or a wrong `typ`; 401 for an over-long lifetime;
   403 for a grantless token in every scope and for a token of the wrong scope;
   403/404 for a cross-organization token and a token whose `locationIds`
   exclude the location; 403 for impersonated writes; never 5xx. It pins the
   mounts in `app.ts` and refuses any other `/operator/reservations` mount. It
   requires each router's test file to contain cross-organization (`ORG_B`) and
   cross-location cases and to name each route's tail segment. For public
   routes: none returns 2xx without Origin binding; none returns 5xx other than
   503; forged, cross-org, expired and rotated capability tokens return 404;
   writes without Turnstile or a customer token are refused when Turnstile is
   configured. Each milestone adds its routes to the sweep.
2. **`apps/app/app/utils/reservations/reservations-guards.test.ts`**
   (`foundation`): a static check that every `reservations+/` loader and action
   awaits `requireReservationsAccess` (or a verified wrapper) first, reads no
   body before it, and has no `clientLoader`/`clientAction`; resource routes
   matching `/^(reservations\.|sites\.reservation|jobs\.reservation)/` call
   `requireInternalCommandAuth(` (or a permission guard) before any `db` or
   `fetch`. The one operator-session resource route,
   `reservations.region-summary.ts`, is listed explicitly and must call
   `requireUserWithOrganizationPermission(` with `update:settings:any` first.
   The test also asserts that the `website+/_index.tsx` region-change action
   calls `evaluateReservationsRegionGuard(` before the wipe.
3. **Routing:** `reservations-mount.test.ts` and
   `src/lib/reservations-routing.test.ts`.

### 16.2 Test types by package

- **Domain property tests** (`packages/reservations`, fast-check): random floor
  plans, rules and operation sequences (search, hold, book, modify, cancel,
  seat, finish, no-show, block, settings edit, clock advance) assert I1-I8 after
  every step. A brute-force oracle (at most 8 tables, 12 bookings) proves
  soundness and reports the false-negative rate. Scale tests at 120 tables, 80
  combinations and 900 bookings per day assert the budgets (200 / 2,000 / 5,000
  expansions).
- **DST and time tests:** `America/New_York` fall back 2026-11-01 (01:00-01:59
  repeated: shown once, paced once, a 90-minute dinner at 01:15 ends at the
  second 01:45) and spring forward 2027-03-14 (02:00-02:59 skipped, 03:00 once,
  a service end in the gap resolves after it); `America/Los_Angeles` on the same
  dates; `Europe/London` 2026-10-25 and 2027-03-28; `Asia/Riyadh` (no DST;
  services crossing midnight; Ramadan special days); the business-date boundary
  at `day_start_min` +/- 1 minute; release time +/- 1 ms; reminders and quiet
  hours across DST.
- **Database tests** (`packages/tenant-db/src/reservations-schema.test.ts`):
  overlap triggers (insert, update, overbook bypass, inactive rows ignored),
  append-only events, audit and merges (redaction only), hold single conversion,
  checks and defaults; migrations on libsql; Durable Object migrations
  regenerated.
- **Concurrency tests** (tenant-api, real libsql files): N parallel books for
  the last table -> exactly one success; host move vs online booking; payment
  after hold expiry; tick sweep during booking; idempotent replay returns the
  same entity and token; stale version -> 409; two voice holds for the last
  slot.
- **Abuse tests:** the honeypot answers like success; Turnstile is required when
  configured; durable limits survive a new app instance; uniform 404s; manage
  routes reject GET mutations; validation errors echo no values.
- **Staffing regression:** staffing alarm tests, `forecast-gap.test.ts`,
  `schedule.forecast.test.ts`, `labor-data` and vocabulary tests stay green
  after `guest-messages` and `integrations`.
- **App tests:** guards test, view, utility and component tests; Playwright per
  App-facing milestone with tenant-api stubbed.
- **Sites vitest:** client modules, view math, label completeness in six
  locales.
- **Payment emulator tests:** real SDK clients over the in-process transport,
  real error classes, ledger assertions; orders via the emulator.
- **Native tests:** Kotlin and Swift unit tests on the shared fixtures, request
  shape tests (method, path, headers, Origin, Bearer, no PATCH on Android), the
  tenant-api contract test.

### 16.3 Residency and privacy checks

- No guest PII in logs (structured logs carry ids and codes), cross-plane
  payloads (strict schemas reject extra fields), Sites SSR, App loaders or
  dashboard server loaders. Tests assert payload key sets for the context,
  notify, payments and voice contracts.
- Capability tokens are never stored in plaintext (derived or hashed).
- Validation errors never echo rejected values.

### 16.4 Milestone gate (run by scrutiny, in order)

1. Typecheck of all touched workspaces (`--concurrency=2`, 4 GB heap), including
   `@repo/zoned-time` and `@repo/reservations`.
2. oxlint.
3. ESLint for Sites, Admin and marketing-workflow.
4. App ESLint: no new errors beyond the 59 pre-existing errors in the menu
   files.
5. Small test suites (packages).
6. tenant-api tests.
7. App tests, run alone.
8. Android tests, build and size check; then iOS `swift build` and `swift test`.
9. `lingui:check`.

Workers restore the regenerated `packages/reports/src/env.ts` and
`packages/security/src/env.ts` and never commit them.

---

## 17. Environment variables and kill switches

| Variable                             | Where                         | Default           | Meaning                                                                                                                        | Milestone        |
| ------------------------------------ | ----------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `RESERVATIONS_PUBLIC_ENABLED`        | tenant-api                    | unset = on        | `false`/`0`/`off`/`no`/`disabled` answers 503 on every public `/reservations/*` route; operator routes unaffected              | `online-booking` |
| `RESERVATIONS_EMAIL_ENABLED`         | tenant-api, App               | unset = on        | off drops guest emails on tenant-api (dropped, not held) and manager-alert emails in the App (in-app notifications unaffected) | `guest-messages` |
| `RESERVATIONS_SMS_ENABLED`           | tenant-api                    | unset = on        | off drops guest SMS (dropped, not held)                                                                                        | `guest-messages` |
| `RESERVATIONS_TICK_INTERVAL_SECONDS` | tenant-api Node               | 120               | seconds between in-process reservation ticks; minimum 60; `0` off. Workers uses the org alarm                                  | `guest-messages` |
| `DEV_EMAIL_CAPTURE_DIR`              | tenant-api Node (dev scripts) | unset             | dev-only capture folder; ignored when `NODE_ENV=production` or OCI email is configured                                         | `guest-messages` |
| `MOCKS`                              | App (existing)                | `true` in dev     | enables dev mocks, including the payments emulator and App email capture (Workers dev)                                         | existing         |
| `PAYMENTS_MOCK`                      | App                           | unset             | `true` enables the emulator without `MOCKS`; `false` forces it off                                                             | `payment-mocks`  |
| `PAYMENTS_MOCK_ORIGIN`               | App                           | `BASE_URL`        | origin used in mock hosted-page URLs                                                                                           | `payment-mocks`  |
| `PAYMENTS_MOCK_WEBHOOKS`             | App                           | `inline`          | `inline` \| `deferred` \| `manual` webhook delivery                                                                            | `payment-mocks`  |
| `PAYMENTS_MOCK_WEBHOOKS_HTTP`        | App                           | unset             | `1` POSTs webhooks over HTTP instead of in-process                                                                             | `payment-mocks`  |
| `STRIP_DEV_MOCKS`                    | App build                     | set by `build:cf` | ignores `mock-payments+` and `mock-email+` route files                                                                         | `payment-mocks`  |
| `STRIPE_CONNECT_WEBHOOK_SECRET`      | App                           | unset             | second Stripe signing secret (Connect endpoint)                                                                                | `payment-mocks`  |

Existing variables the module relies on (no change): `TENANT_OPERATOR_TOKEN`,
`INTERNAL_COMMAND_TOKEN`, `AUTH_HMAC_SECRET` (capability tokens; tenant-api
only), `JWT_SECRET` (customer tokens), `TURNSTILE_SECRET_KEY` /
`TURNSTILE_HOSTNAMES` (tenant-api), `PUBLIC_TURNSTILE_SITE_KEY` (Sites),
`APP_URL` (tenant-api context), `TENANT_API_URL` / `TENANT_API_URL_KSA` (App),
`VOICE_AGENT_TOKEN`, `TWILIO_*` (US tenant-api only), `STRIPE_*`, `CHECKOUT_*`
(App only), `DATA_REGION`, `TENANT_DB_DIR`.

Organization-level controls (no deploy): the six flags, the location `enabled` /
`online_enabled` switches, per-kind message settings, and the platform fee
override.

Runbook order (documented in `docs/reservations.md`): turn off
`reservations.online` first (stops new public bookings; manage links, reminders
and operator tools keep working), then cancel or export, then turn off the
master. Use the env switches when a node-wide problem needs stopping without a
deploy. Deploy tenant-api before the App.

Add every new variable to `apps/tenant-api/.env.schema` or
`apps/app/.env.schema` and to the AGENTS.md environment list.

---

## 18. Docs to write or update

| Doc                                                 | Content                                                                                                                                                                                                                                          | Milestone                                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `docs/decisions/048-reservations-data-residency.md` | ADR: placement, regional settings and experiences, browser-direct, public origin binding, guest identity without login, payments split, tick generalization, messaging regions, retention and erasure, flags, location scope reuse, platform fee | draft in `foundation`, final in `native-apps`                             |
| `docs/reservations.md`                              | operator guide and runbook: features, flags table, permissions and presets, first-day setup, kill switches, deploy order, symptoms table, region switch, KSA checklist, demo data, CI security checks, known gaps                                | skeleton in `foundation`, extended each milestone, final in `native-apps` |
| `docs/reservations-contract.md`                     | public, operator, internal, voice and native API contract with schemas, error codes and fixtures                                                                                                                                                 | skeleton in `foundation`, final in `native-apps`                          |
| `docs/reservations-plan.md`                         | design summary and per-milestone build log (including any extra migration)                                                                                                                                                                       | every milestone                                                           |
| `docs/payments-mock.md`                             | emulator usage, cards, dev API, exclusion layers                                                                                                                                                                                                 | `payment-mocks`                                                           |
| `AGENTS.md`                                         | "Reservations module" section and the env vars in section 17                                                                                                                                                                                     | `native-apps` (env lines as each lands)                                   |
| `docs/permissions.md`                               | reservations permissions and flags                                                                                                                                                                                                               | `foundation`                                                              |
| `docs/scheduled-jobs.md`                            | org alarm modules, reservations tick, payment reconcile                                                                                                                                                                                          | `guest-messages`, `payments-experiences`                                  |
| `docs/tenant-data-residency.md`                     | guest data rules                                                                                                                                                                                                                                 | `native-apps`                                                             |
| `docs/phone-agent-verticals.md`                     | `services.action` and the action registry                                                                                                                                                                                                        | `integrations`                                                            |
| `apps/tenant-api/README.md`                         | new routes, switches, dev email capture                                                                                                                                                                                                          | `native-apps`                                                             |
| `docs/staffing.md`                                  | shared alarm, demand sources and units, location scope wording                                                                                                                                                                                   | `integrations`                                                            |

---

## 19. Milestone map

The mission runs the milestones in this order. "Depends on" lists the hard
dependencies; each milestone ends with scrutiny review and user testing.

| #   | Id                     | Builds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Depends on                                                        | Migrations                    | Validated through                                                                                        |
| --- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1   | `foundation`           | `@repo/zoned-time`; `@repo/reservations` (flags, permissions, token, time, config schemas, `validateConfig`, `resolveServices`, engine, assignment, state machine, policy and message math, schemas, errors) with property and DST tests; tenant-db `0016` + schema tests; control-plane `0025` + mirrors; App token mint; tenant-api auth, `rsvGuard`, `lib/http.ts`, context cache, `withReservationWrite`, org-router audience and branches; security sweep scaffold, routing tests, App guards test; App access layer, nav, `_layout`; context route; seed script skeleton; ADR 048 draft and doc skeletons | none                                                              | tenant `0016`, control `0025` | unit, property and schema tests; App shows an empty Reservations section only with the flag on (404 off) |
| 2   | `setup`                | location settings, areas, tables, combinations, floor plan editor, services, turn times, pacing, service availability, special days, blocks, validation and conflicts view, tz mismatch banner, location settings card, Playwright spec                                                                                                                                                                                                                                                                                                                                                                         | `foundation`                                                      | none                          | App Settings UI, tenant-api tests                                                                        |
| 3   | `reservation-book`     | phone/host booking with auto-assign, walk-ins, Today list, Book list, detail sheet, full lifecycle and undo, side fields, history, unassigned/conflict panel, audited overbook, guest create/lookup, optimistic versions, ETag day feed and `/changes`, guest export/erase endpoints, region-switch and location-delete guards, seed bookings                                                                                                                                                                                                                                                                   | `setup`                                                           | none                          | App Book and Today                                                                                       |
| 4   | `host-stand`           | timeline, reflow and auto-move notices, calendar, service overview and notes, live floor plan, server sections, polling cadence, keyboard drag and drop with announcements, Playwright spec                                                                                                                                                                                                                                                                                                                                                                                                                     | `reservation-book`                                                | none                          | App Timeline, Floor, Calendar, Overview                                                                  |
| 5   | `online-booking`       | public `/reservations/*` (config, availability, calendar, holds, book, requests, manage, `.ics`, `/mine`), protection, `RESERVATIONS_PUBLIC_ENABLED`, Sites `/reserve` and manage, profile panel, Book a table block (App + Sites), six locales, approve/decline, native-ready shape; tested on `acme` and `riyadh-grill`                                                                                                                                                                                                                                                                                       | `reservation-book`                                                | none                          | Sites end to end; operator sees the booking within one poll                                              |
| 6   | `guest-messages`       | generic org alarm (staffing becomes a module), reservations tick, message kinds, EN/AR email, US SMS, quiet hours, dedupe, kill switches, message settings, manager alerts, jobs-cron hook, dev email capture                                                                                                                                                                                                                                                                                                                                                                                                   | `online-booking`                                                  | none                          | dev capture folder, `[SMS MOCK]` lines, tick tests; staffing alarm tests unchanged                       |
| 7   | `waitlist`             | operator waitlist with quotes, notify, deadlines, on-the-way, seat, reorder; remote join and status page; notify-me and matching; waitlist message kinds; drag a waitlist card onto the floor                                                                                                                                                                                                                                                                                                                                                                                                                   | `guest-messages`, `host-stand`                                    | none                          | App Waitlist, Sites `/reserve/waitlist`                                                                  |
| 8   | `guestbook-reports`    | Guestbook (search, profiles, tags, pinned notes, merge, export, erase UI), guest summary in book and host stand, reports page, report subjects `bookings` and `waitlist_entries`, `bookings-today` block                                                                                                                                                                                                                                                                                                                                                                                                        | `reservation-book`, `waitlist`                                    | none                          | App Guestbook, Reports, Home dashboard                                                                   |
| 9   | `payment-mocks`        | emulators, four exclusion layers, `__mock_pay_*` state, mock pages, dev API, onboarding helper, `withConnect` fix, webhook secrets list, KSA guard removal, Checkout.com orders on HPP, Sites loopback `http:`, test helpers                                                                                                                                                                                                                                                                                                                                                                                    | `foundation` (independent of reservation code)                    | none                          | an existing US Stripe order and a KSA Checkout.com order paid locally                                    |
| 10  | `payments-experiences` | platform fee config (`0026`) and Admin control, policies, deposit/prepay, guarantee, fees with pay-link recovery, refunds and reconcile job, disputes, payment messages, badges and panel, region-switch extension, Experiences setup, public pages, experience booking and prepayment                                                                                                                                                                                                                                                                                                                          | `online-booking`, `guest-messages`, `host-stand`, `payment-mocks` | control `0026`                | Sites booking through the mock hosted pages; App fee/refund actions; Admin fee                           |
| 11  | `integrations`         | `services.action`, voice action registry and caps, restaurant tools, demand-source registry with `visits` and per-unit standards, forecast strip, journey triggers with consent and dedupe, step consent check                                                                                                                                                                                                                                                                                                                                                                                                  | `online-booking`, `guest-messages`                                | tenant `0017`                 | voice action tests and curl; staffing forecast; journey runs in tenant-api tests                         |
| 12  | `native-apps`          | server readiness (customer token for Turnstile, `X-Client`, payment poll, contract fixtures and test), iOS TenantKit + SwiftUI, Android core + views, byte budget, final docs                                                                                                                                                                                                                                                                                                                                                                                                                                   | `online-booking`, `waitlist`, `payments-experiences`              | none                          | Gradle and Swift commands; contract test                                                                 |

---

## 20. Out of scope

- POS integration, Reserve with Google, two-way SMS, the Expo mobile app
  (`apps/mobile`), a diner marketplace, loyalty points and gift cards.
- The background re-optimizer (no `reoptimize` tick task).
- Free-form editing of message templates (EN/AR templates live in code; one
  custom note per kind and locale).
- WebSocket live updates (ETag polling instead).
- Real payment, email or SMS providers, live phone calls, real Stripe or
  Checkout.com sandboxes, and any deployment or `git push`.
- Required phone verification for web bookings (section 22, item 1).
- Automatic fee charging of any kind.
- SaaS billing Stripe, Polar, and the legacy shop's inline Stripe.js card (the
  emulator does not cover them).

---

## 21. Existing code touchpoints

Every existing file the module edits, by area. New files are listed in section
2.2.

| Area            | Existing file                                                                                                                                                                                                                                                                          | Change                                                                                     | Milestone                                  |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------ |
| Time            | `packages/staffing/src/tz.ts`                                                                                                                                                                                                                                                          | becomes `export * from '@repo/zoned-time'`                                                 | `foundation`                               |
| Time            | `packages/staffing/package.json`                                                                                                                                                                                                                                                       | depends on `@repo/zoned-time`                                                              | `foundation`                               |
| Phone           | `apps/tenant-api/src/routes/auth.ts:95`                                                                                                                                                                                                                                                | uses `normalizeGuestPhone` through `lib/phone.ts` (behavior unchanged, tests prove it)     | `foundation`                               |
| Tenant DB       | `packages/tenant-db/src/schema.ts`, `src/index.ts`                                                                                                                                                                                                                                     | section 12, exports                                                                        | `foundation`                               |
| Tenant DB       | `apps/tenant-api/workers/migrations.generated.ts`                                                                                                                                                                                                                                      | regenerated                                                                                | `foundation`, `integrations`               |
| Control plane   | `packages/database/setup-roles.ts`                                                                                                                                                                                                                                                     | eight permissions, admin grants                                                            | `foundation`                               |
| Auth            | `packages/auth/src/organization-permissions.server.ts`                                                                                                                                                                                                                                 | `ORG_PERMISSIONS` + drift test                                                             | `foundation`                               |
| Roles           | `apps/app/app/utils/organization/tenant-role-permissions.ts`, `components/roles/tenant-role-access-manager.tsx`                                                                                                                                                                        | allow-list, implied ids, editor group                                                      | `foundation`                               |
| Nav             | `apps/app/app/root.tsx`, `components/app-sidebar.tsx`                                                                                                                                                                                                                                  | Reservations group                                                                         | `foundation`                               |
| Router          | `apps/tenant-api/workers/org-router.ts`                                                                                                                                                                                                                                                | audience, public, internal, system and voice branches                                      | `foundation` (+ later branches)            |
| Mounts          | `apps/tenant-api/src/app.ts`                                                                                                                                                                                                                                                           | mount reservations routers                                                                 | `foundation` onward                        |
| HTTP helpers    | `apps/tenant-api/src/lib/staff-http.ts`                                                                                                                                                                                                                                                | re-exports from `lib/http.ts`                                                              | `foundation`                               |
| Seeds           | `apps/tenant-api/package.json`                                                                                                                                                                                                                                                         | `seed:reservations`, `fixtures:reservations` scripts                                       | `foundation`, `native-apps`                |
| Locations       | `apps/app/app/routes/_app+/$orgSlug_+/settings+/locations.$locationId.tsx`                                                                                                                                                                                                             | Reservations card, delete guard, context-changed nudge                                     | `setup`, `reservation-book`                |
| Region switch   | `apps/app/app/routes/_app+/$orgSlug_+/website+/_index.tsx` (region-change action, beside `evaluateRegionGuard`), `apps/app/app/components/settings/cards/organization/site-card.tsx` (dialog), new `apps/app/app/routes/resources+/reservations.region-summary.ts`                     | reservation counts, typed confirmation, payment refusal (409)                              | `reservation-book`, `payments-experiences` |
| Website builder | `apps/app/app/utils/website/block-types.ts`, `website+/pages.$pageId.tsx`                                                                                                                                                                                                              | `reservation` block, inspector, preview                                                    | `online-booking`                           |
| Site links      | `packages/common/src/site-link.ts:65`                                                                                                                                                                                                                                                  | reserve `reserve`, `experiences`                                                           | `online-booking`                           |
| Sites           | `apps/sites/src/lib/site-headers.ts`, `components/blocks/RenderBlocks.astro`, `pages/profile.astro`, `src/locales/*.po`                                                                                                                                                                | route detection, block, profile panel, labels                                              | `online-booking`                           |
| Sites           | `apps/sites/src/lib/ordering/order-client.ts:255-257`                                                                                                                                                                                                                                  | loopback `http:` outside production                                                        | `payment-mocks`                            |
| Alarm           | `apps/tenant-api/workers/tenant-org.ts`, `src/lib/staff-alarm.ts`, `src/index.ts`, `workers/index.ts`                                                                                                                                                                                  | generic org alarm, Node interval, module registration                                      | `guest-messages`                           |
| Email           | `apps/tenant-api/src/lib/tenant-email.ts`                                                                                                                                                                                                                                              | dev capture on the mock branch                                                             | `guest-messages`                           |
| Email           | `apps/tenant-api/package.json` dev scripts, root `.gitignore`                                                                                                                                                                                                                          | `DEV_EMAIL_CAPTURE_DIR`, `.dev-mail/`                                                      | `guest-messages`                           |
| Email           | `apps/app/workers/app.ts`                                                                                                                                                                                                                                                              | install `dev-email-capture.ts` like `dev-s3-mock.ts`                                       | `guest-messages`                           |
| Env             | `apps/tenant-api/.env.schema`, `apps/app/.env.schema`                                                                                                                                                                                                                                  | new variables                                                                              | as each lands                              |
| Cron            | `apps/jobs-cron/src/index.ts`                                                                                                                                                                                                                                                          | hourly tick, hourly payment reconcile                                                      | `guest-messages`, `payments-experiences`   |
| Notifications   | `apps/app/app/routes/_app+/$orgSlug_+/settings+/notifications*`                                                                                                                                                                                                                        | reservations alert kinds                                                                   | `guest-messages`                           |
| Reports         | `packages/reports/src/catalog.ts` (registration), `operator-token.ts:32`, `apps/app/.../reports+/token.ts`, `apps/tenant-api/src/routes/analytics.ts`                                                                                                                                  | subjects, restriction, grants, dispatch                                                    | `guestbook-reports`                        |
| Dashboards      | `apps/app/app/utils/dashboards/config.ts`, `visibility.ts`, `components/dashboard/dashboard-block-content.tsx`, add-block dialog                                                                                                                                                       | `bookings-today`                                                                           | `guestbook-reports`                        |
| Payments        | `packages/payments/src/shop/config.ts`, `shop/commerce.ts` (`withConnect`), `providers/stripe.ts`, `connect/checkout-shop.ts`, `shop/restaurant.ts:155-182`                                                                                                                            | mock seams, error fix, HPP                                                                 | `payment-mocks`                            |
| Payments        | `apps/app/app/utils/shop.server.ts:41-59, 333-335`, `settings+/shop.tsx:215-222`, `components/.../shop-card.tsx:78-84`                                                                                                                                                                 | emulator wiring, KSA guards removed, mock panel                                            | `payment-mocks`                            |
| Payments        | `apps/app/app/routes/api+/stripe+/webhook.tsx`, `api+/shop+/webhook.tsx`, `utils/restaurant-orders/payment-webhooks.server.ts`                                                                                                                                                         | secrets list (`payment-mocks`); `reservation_*` metadata branches (`payments-experiences`) | `payment-mocks`, `payments-experiences`    |
| Payments        | `apps/app/app/utils/restaurant-orders/checkout.server.ts`, `payment-config.server.ts`                                                                                                                                                                                                  | Checkout.com HPP for orders; shared helpers reused by reservations                         | `payment-mocks`, `payments-experiences`    |
| Build           | `apps/app/vite.config.ts`, `app/routes.ts`, `apps/app/package.json` (`build:cf`), CI workflow                                                                                                                                                                                          | define, route strip, flag, bundle grep                                                     | `payment-mocks`                            |
| Admin           | `apps/admin` nav                                                                                                                                                                                                                                                                       | link to the platform fee control                                                           | `payments-experiences`                     |
| Voice           | `packages/phone-agent/src/vertical.ts`, `apps/voice-agent/src/services.ts`, `controller` tool context, `test-fixtures.ts`                                                                                                                                                              | `services.action`                                                                          | `integrations`                             |
| Voice           | `packages/phone-agent-restaurant/src/tools.ts`, `prompt.ts:66`, `settings.ts`, purpose/summary helpers                                                                                                                                                                                 | tools, prompt switch, setting                                                              | `integrations`                             |
| Voice           | `apps/tenant-api/src/routes/voice.ts`                                                                                                                                                                                                                                                  | `/actions/:name`                                                                           | `integrations`                             |
| Voice           | App restaurant vertical config builder, `phone-agent+/` settings                                                                                                                                                                                                                       | booking facts, toggle                                                                      | `integrations`                             |
| Staffing        | `apps/tenant-api/src/services/order-source.ts`, `forecast-service.ts`, `labor-data.ts`, `restaurant/staffing-report-catalog.ts`, `packages/staffing/src/forecast-gap.ts`, `apps/app/app/components/staff/schedule/forecast-strip.tsx`, labor settings, `utils/staffing/labor-types.ts` | demand-source registry, units, strip                                                       | `integrations`                             |
| Journeys        | `packages/tenant-db/src/types/journey.ts:22`, `schema.ts:74-76, 137-142`, `apps/tenant-api/src/services/journey-service.ts` (`:114`, `:929`), `packages/marketing-workflow/src/workflow-labels.ts`, `workflow-config.tsx`, `marketing+/automations.*.tsx`                              | triggers, enums, consent check, labels, gated editor list                                  | `integrations`                             |
| Native          | `apps/ios/Sources/TenantKit/Networking/TenantAPIClient.swift`, `Sources/TenantApp/RootView.swift`, `Package.swift` (test resources), `.lproj` files                                                                                                                                    | client, navigation, fixtures, strings                                                      | `native-apps`                              |
| Native          | `apps/android/app/src/main/kotlin/.../core/net/TenantApiClient.kt`, `ui/AppState.kt`, `ui/MainActivity.kt`, `res/values*/strings.xml`, `size-budget.json`                                                                                                                              | client, screen keys, strings, budget                                                       | `native-apps`                              |
| Docs            | section 18 files                                                                                                                                                                                                                                                                       |                                                                                            | as listed                                  |

---

## 22. Resolved design questions

1. **Guest verification for web bookings:** booking without login stays the
   design (Turnstile, honeypot, durable limits, per-phone caps). A per-location
   "require verified phone" option is not built. Native booking requires
   sign-in.
2. **Journeys for guests without accounts:** fire for verified or explicitly
   consenting guests; consent creates an unverified `customers` row used only
   for journeys (section 14.3).
3. **Master flag off with future bookings:** master off hides everything (404)
   and stops messages; turning off only `online` stops new public bookings while
   manage links, reminders and operator tools keep working.
4. **Member location scope:** reuse `UserOrganization.locationScope`.
5. **Live updates:** ETag polling only.
6. **No-show fees:** always staff-confirmed, never automatic, even with auto
   no-show on.
7. **Time-zone code:** the new `@repo/zoned-time` package, re-exported by
   staffing.
8. **Upstream template sync:** clearly named `reservations` paths plus
   `restaurant/` adapters; the generic seams (org alarm, `services.action`,
   voice registry, demand sources, journey consent check, mocks) are
   restaurant-free.
9. **Message templates:** code-owned EN/AR templates with a per-kind custom
   note.
10. **Experiences placement:** regional (`rsv_experiences`), not a control-plane
    definition.
11. **Guestbook placement:** a regional module CRM under
    `/operator/reservations/guests/*`, not an extension of `customers.tsx`.
12. **KSA card guarantees:** offered through Checkout.com stored instruments
    where the processing channel supports them, with the mada caveat shown to
    operators.
