# Integrations reference (phone agent, staffing, journeys, reports, dashboard, Experiences, Guestbook)

**What belongs here:** how the existing phone agent, staffing forecast,
marketing journeys, reports, Home dashboards, drops and customers code work
today, the exact seams reservations plug into, test files to extend, and
gotchas, all verified against the repo.

**What does NOT belong here:** the integration design itself (see
`architecture.md` section 14, with routes in 7.5 and data in 4.5), payment flows
(`library/payments-reference.md`), staffing module patterns in general
(`library/staffing-patterns.md`).

Paths are relative to `/home/factory-user/repos/menuza`.

## 1. Decisions (one line each; see architecture.md section 14)

- Phone agent: generic `services.action` in the core, a tenant-api voice action
  registry, restaurant tools `check_table_availability` and `book_table`; US
  only. See 14.1 and 7.5.
- Staffing: a demand-source registry with units `orders` and `visits`;
  `registerOrderSource` stays as a wrapper. See 14.2.
- Journeys: four `reservation_*` triggers, verified or consenting guests only,
  deduped per booking and trigger, ids-only context, consent check in step
  execution. See 14.3.
- Reports: subjects `bookings` and `waitlist_entries`, restricted. See 14.4.
- Dashboard: built-in block `bookings-today`, browser-fetched. See 14.5.
- Experiences are **regional** (`rsv_experiences`, `rsv_experience_schedules`).
  See 4.1 and 22 item 10.
- The Guestbook is a **regional module CRM** under
  `/operator/reservations/guests/*`; the existing Customers page is unchanged.
  See 14.6 and 22 item 11.

## 2. Phone agent

### 2.1 As built

- Worker: `apps/voice-agent` (LiveKit Agents for Node). `src/models.ts`
  `assertUsDataRegion` refuses to start unless `DATA_REGION=us`. Models:
  Deepgram `nova-3`, Gemini (`PHONE_AGENT_LLM_MODEL`, default
  `gemini-2.5-flash`), Cartesia `sonic-3`.
- Config: the worker GETs App `/resources/phone-agent-config`
  (`apps/app/app/routes/resources+/phone-agent-config.ts`, `VOICE_AGENT_TOKEN`).
  `buildRuntimeConfig` is in
  `apps/app/app/utils/phone-agent/runtime-config.server.ts`; the restaurant part
  comes from `restaurantConfigParts`
  (`packages/phone-agent-restaurant/src/data.ts`) via
  `apps/app/app/utils/phone-agent/restaurant/vertical.server.ts`. The data is
  `{ location, menus, orderingOpen }`, no callers. The worker caches config.
- Tools: `apps/voice-agent/src/tools.ts` `buildAgentTools` = core tools
  (`get_business_info`, `set_call_purpose`, `end_call`, `transfer_to_staff`,
  `transfer_to_contact`, `switch_language`, `tag_call`, `record_request`) plus
  vertical tools via `adaptVerticalTool` (records `state.toolsUsed`, honors
  `rejectDuplicates` / `blockedDuringTransfer`). A vertical tool cannot reuse a
  core tool name.
- Vertical contract: `packages/phone-agent/src/vertical.ts`.
  `VerticalTool { name, description, parameters?, rejectDuplicates?, blockedDuringTransfer?, execute(args, ctx) }`
  via `defineVerticalTool`. `VerticalServices` (`:94-95`) has exactly one
  method, `sendLink(input)`; typed failures in `SEND_LINK_FAILURES` (`:60`). The
  context is built in `apps/voice-agent/src/controller.ts:325` `toolContext()`.
- Worker to tenant-api: the `tenantApi` client in
  `apps/voice-agent/src/services.ts` POSTs `${TENANT_API_URL}/api/voice/*` with
  `Authorization: Bearer VOICE_AGENT_TOKEN`. Routes in
  `apps/tenant-api/src/routes/voice.ts` (`POST /calls`, `/calls/:callId/finish`,
  `/handoffs`, `/website-links`, `/requests`), with `requireVoiceAgent` (503
  when the token is missing or short, 401 on mismatch) and
  `regionalOrganization` (404 for another region). SMS goes through per-call and
  per-day caps (`voice_sms_sends`).
- Reservations today are request capture only:
  `packages/phone-agent-restaurant/src/definitions.ts` (purpose and request type
  `reservation`), `prompt.ts:66` ("collect the party size, date, time, and a
  name, then save it with record_request. Make clear it is a request and the
  team will confirm it."), `record_request` in `apps/voice-agent/src/tools.ts`.
  `classifyPurpose` and `summarizeCall` live in
  `packages/phone-agent-restaurant/src/vertical.ts`.
- Trust rules already encoded: caller ID is spoofable; the worker ignores
  customer data from `/calls` (`StartCallResponseSchema` comment in
  `services.ts`); handoff tokens live in URL fragments.

### 2.2 What reservations add (names from architecture.md)

| Piece                                                                                                                                                                               | Where                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `action(name, input): Promise<VerticalActionResult>` on `VerticalServices`; reasons `unavailable`, `rate_limited`, `not_enabled`, `invalid`, `conflict`                             | `packages/phone-agent/src/vertical.ts`                                                                                     |
| Worker POST `/api/voice/actions/:name` `{ orgId, callId, scopeId, channel, input }`                                                                                                 | `apps/voice-agent/src/services.ts`, `controller.ts` `toolContext()`, fakes in `src/test-fixtures.ts`                       |
| Generic registry `registerVoiceAction({ name, schema, maxPerCall, run })`                                                                                                           | `apps/tenant-api/src/services/voice-actions.ts` (new)                                                                      |
| Route `/api/voice/actions/:name` with call-exists check (409 if finished), unknown 404, schema validation, per-call cap via new `voice_call_actions` rows (429), `web_test` dry run | `apps/tenant-api/src/routes/voice.ts` (or `routes/voice-actions.ts` mounted inside it)                                     |
| Restaurant registrations `reservations.availability` (cap 10), `reservations.hold` (cap 2), `reservations.book` (cap 1, only in `confirm_on_call` mode without a payment policy)    | `apps/tenant-api/src/restaurant/reservations-voice.ts` (new), registered in **both** `src/index.ts` and `workers/index.ts` |
| Tools `check_table_availability`, `book_table` (hold + text `/reserve#h=<holdToken>` by default)                                                                                    | `packages/phone-agent-restaurant/src/tools.ts`, setting in `settings.ts`, prompt switch in `prompt.ts:66`                  |
| Booking facts in config (no PII); settings toggle when `reservations.voice` is on and the org is US                                                                                 | App restaurant vertical config builder, `phone-agent+/` settings                                                           |

- Draft names `reservations.link-payload`, `booking_availability`,
  `booking_hold`, `booking_create`, `voice-booking-actions.ts` and path
  `/reserve/confirm` are superseded by the table above.
- `record_request` (type `reservation`) stays the fallback when the module is
  off, an action fails or the party is too large.

### 2.3 Tests

- Keep green: `packages/phone-agent/src/vocabulary.test.ts` (bans `/reserv/i`,
  `order`, `menu`, `location`, `store`, `food` in the core; `action`, `booking`,
  `slot`, `guest`, `party`, `capacity` are allowed).
- Worker: `apps/voice-agent/src/test-fixtures.ts` `setupTools()` builds a real
  `CallController` with fake services and `run(toolName, args)`. Extend the
  fakes with `action: vi.fn()`. Existing
  `apps/voice-agent/src/restaurant.test.ts` and `tools.test.ts` run in about 6
  seconds. There is no fake LLM; tests drive tools directly.
- Restaurant package: `packages/phone-agent-restaurant/src/vertical.test.ts`
  (tools hidden when disabled, prompt switches between request capture and
  booking).
- tenant-api: `apps/tenant-api/src/routes/voice.test.ts` (Hono `app.request`,
  dev token, temp SQLite) is the model for action tests: 401 and 503 token
  cases, region 404, unknown action 404, finished call 409, caps 429, flag off,
  no guest fields, `web_test` dry run, two holds racing for the last slot.
- Manual: with tenant-api on 3007, `POST /api/voice/calls` then
  `POST /api/voice/actions/reservations.availability` with
  `Authorization: Bearer $VOICE_AGENT_TOKEN`. Live calls are impossible locally
  (no LiveKit, Deepgram, Gemini or Cartesia keys) and out of scope.

## 3. Staffing forecast

### 3.1 As built

- `apps/tenant-api/src/services/order-source.ts`: a single slot,
  `registerOrderSource(source | null)`, `getOrderSource()`. Registered at
  startup in `apps/tenant-api/src/index.ts:13` and
  `apps/tenant-api/workers/index.ts:34` via `registerRestaurantOrderSource()`
  (`src/restaurant/staffing-order-source.ts`).
- `OrderSource.loadBuckets(db, scopeId, { fromSeconds, toSeconds, alignSeconds })`
  -> rows of
  `{ bucket (15-minute index, DEMAND_BUCKET_SECONDS = 900), currency, fulfillment, orders, subtotalMinor, tipMinor }`.
  `loadBooked(db, scopeId, { fromSeconds, toSeconds, timeZone })` ->
  `BookedOrderFact[]` `{ date, hour, orders }`.
- Consumers of the slot: `services/forecast-service.ts` (`loadForecastGap`),
  `services/labor-data.ts` (sales source switches when a source is registered),
  `restaurant/staffing-report-catalog.ts` (`activeReportCatalog()` wording; also
  read by `routes/analytics.ts`).
- Math: `packages/staffing/src/forecast-gap.ts` `computeForecastGap`: per hour
  `orders = max(median, booked)`, `needed = ceil(orders / standard)` per
  position. Standards in `labor_scope_settings.orders_per_labor_hour` (JSON,
  `packages/tenant-db/src/schema.ts:2287`).
- Routes: `GET /operator/schedule/demand` and `/forecast` in
  `apps/tenant-api/src/routes/schedule.ts`.
- UI: `apps/app/app/components/staff/schedule/forecast-strip.tsx`; types in
  `apps/app/app/utils/staffing/labor-types.ts`.

### 3.2 Why a separate unit

Covers are not orders (one 4-top is one order and four covers). Adding covers
into `orders` would corrupt standards managers already set. Hence the `visits`
unit with its own standards (`demand_per_labor_hour`, tenant migration `0017`).
The source file is
`apps/tenant-api/src/restaurant/reservations-demand-source.ts` (draft names
`staffing-booking-source.ts` and unit `booked_guests` are superseded).

### 3.3 Tests that must stay green

`packages/staffing/src/forecast-gap.test.ts`, `schedule-demand.test.ts`,
`vocabulary.test.ts` (no "covers" or "table" in `packages/staffing`);
`apps/tenant-api/src/routes/schedule.forecast.test.ts`,
`schedule.demand.test.ts`, `labor.test.ts`, `labor.tips.test.ts`,
`analytics.staffing.test.ts`,
`apps/tenant-api/src/restaurant/staffing-order-source.test.ts`;
`apps/app/app/utils/staffing/labor-types.test.ts`.

New tests: orders-only input gives output identical to today; visits only; both
summed per position; booked above median wins per unit; the demand source
filters by scope, excludes cancelled, no-show and expired holds, buckets by
local hour across DST, selects no guest columns; registering `visits` does not
change `labor-data` sales or catalog wording.

## 4. Marketing journeys

### 4.1 As built

- `JOURNEY_TRIGGER_TYPES = ['phone_verified', 'profile_completed', 'custom_event', 'manual']`
  in `packages/tenant-db/src/types/journey.ts:22` (Zod
  `journeyTriggerTypeSchema`), plus a duplicate TypeScript enum on
  `marketing_journeys.trigger_type`
  (`packages/tenant-db/src/schema.ts:137-142`). No SQL CHECK, so a new value
  needs no migration.
- `evaluateAndSpawnTriggers(orgId, triggerType, customerId, tenantApiUrl?, contextData)`
  (`apps/tenant-api/src/services/journey-service.ts:929`): inserts one
  `journey_runs` row per active journey (`customer_id` NOT NULL, FK to
  `customers`) and POSTs a zero-PII start payload to
  `${JOBS_CRON_WORKER_URL}/api/workflows/marketing-journey/start`.
  `triggerConfig` is not used for filtering and there is **no dedupe**. Called
  fire-and-forget from `routes/auth.ts`.
- `executeJourneyStep` (`:114`) loads the `customers` row and sends email
  (`sendTenantEmail`) or SMS (`sendSms`); it does **not** check consent.
  `evaluateJourneyCondition` reads customer fields or `contextData`, so
  `partySize` in context can drive conditions.
- Consent: `customer_subscriptions` (topics `['drops']`, channels `['sms']`,
  TypeScript enums at `schema.ts:74-75`) is only checked by drop alerts
  (`apps/tenant-api/src/routes/subscriptions.ts`).
- Labels live in two maps that both need entries:
  `packages/marketing-workflow/src/workflow-labels.ts` (`TENANT_TRIGGER_MSGS`,
  `TENANT_TRIGGER_OPTION_MSGS`, Lingui `msg`) and
  `packages/marketing-workflow/src/workflow-config.tsx`
  (`TENANT_TRIGGER_LABELS`, `TENANT_TRIGGER_OPTIONS`). Both are typed
  `Record<string, ...>`, so a missing entry does **not** fail typecheck; add a
  test.
- Editor: `apps/app/app/routes/_app+/$orgSlug_+/marketing+/automations.new.tsx`
  and `automations.$journeyId.tsx`.
- Merge tags are customer fields only (`packages/common/src/merge-tags.ts`).
- Precedent for unverified customers: `POST /auth/send-code` creates a blank,
  unverified `customers` row.

### 4.2 Tests

- `apps/tenant-api/src/routes/journeys.test.ts`: create and update with each new
  trigger; reject unknown types.
- Model new emission tests on `apps/tenant-api/src/routes/auth-trigger.test.ts`
  (mocks `../lib/origin.ts` and fetch to the workflow worker): one run per
  active journey per transition, none on repeat, no PII keys in `contextData`,
  no run without a verified customer or consent, steps `skipped` without an
  active `reservations` subscription.
- `packages/marketing-workflow` serialization and validation tests; App
  `automations.test.ts` for the flag-gated list; Lingui extract for the new
  labels.

## 5. Reports

### 5.1 As built

- Catalog types in `packages/reports/src/catalog.ts` (`ReportSubject`,
  `ReportField` with `type`, `filterable`, `groupable`, `timeframe`,
  `requiresSubject`, `ratio`, `showTime`). Staff subjects in
  `catalog-staffing.ts` (model for `catalog-reservations.ts`). Templates in
  `templates.ts`. Engine `engine.ts` (`runReport`) runs in tenant-api.
- Restricted subjects: `RESTRICTED_REPORT_SUBJECTS` in
  `packages/reports/src/operator-token.ts:32`. `catalogForGrants` in
  `packages/reports/src/access.ts` hides restricted subjects without a grant.
- Token: `apps/app/app/routes/_app+/$orgSlug_+/reports+/token.ts` requires
  `READ_ANALYTICS_ANY | READ_SETTINGS_ANY | READ_WEBSITE_ANY`, then adds
  subjects (staff via `resolveStaffReportAccess` in
  `apps/app/app/utils/staffing/report-access.server.ts`: flags, permissions,
  scope ids, none when impersonating). Known issue: no role grants
  `read:analytics:any`.
- Run: browser -> tenant-api `POST /analytics/query`
  (`apps/tenant-api/src/routes/analytics.ts`), dispatch by subject to
  `services/report-records.ts` or `services/staffing-report-records.ts` (audit
  row per run), row caps reported as `sourceTruncated`.
- Staff loaders never log Drizzle errors (they quote bound values). Do the same
  in `services/rsv-report-records.ts`.

### 5.2 Reservations specifics

- Subjects `bookings` and `waitlist_entries` (`RESERVATIONS_REPORT_SUBJECTS`),
  no contact fields at all. Draft names `reservations`, `catalog-bookings.ts`,
  `booking-report-records.ts`, `resolveBookingReportAccess`, `read:booking:any`
  and the `booking_guests` PII field grant are superseded.
- Access through `resolveReservationsReportAccess()` (master flag plus
  `read:reservation_report:any`, location scope as `scopeIds`).
- Tests modeled on `apps/tenant-api/src/routes/analytics.staffing.test.ts` and
  the App staffing token tests: 403 without grant, scope limits, cross-org
  token, region mismatch, correct aggregates on a seeded fixture.

## 6. Home dashboard block

- `apps/app/app/utils/dashboards/config.ts`: `BUILT_IN_BLOCK_TYPES` (`:11`,
  today `stats`, `notes-chart`, `onboarding`, `leaderboard`, plus `report`),
  `BLOCK_DEFINITIONS`, `dashboardBlockSchema`, `addableBuiltInBlockTypes`.
- Rendering switch:
  `apps/app/app/components/dashboard/dashboard-block-content.tsx`. Server data
  for built-ins: `utils/dashboards/block-data.server.ts` `loadBuiltInBlockData`
  (control plane only; never add regional reads). Visibility:
  `utils/dashboards/visibility.ts` `hiddenBlockIds`.
- Browser-direct precedent:
  `components/dashboard/blocks/report-block-result.tsx` (`useReportRunner` with
  `tokenUrl` and `tenantApiUrl`; 403 shows "No access").
- Today there is no per-block flag or permission gating except onboarding;
  `bookings-today` adds it in the loader. Draft name `reservations-today` is
  superseded.
- Tests: `config.test.ts`, `visibility.test.ts`, `block-data.server.test.ts` (no
  regional fetch), the add-block dialog test, a component test with MSW-mocked
  tenant-api (loading, 403, empty, RTL).

## 7. Experiences (regional)

- Existing pattern to learn from, not reuse: drops (control plane,
  `packages/database/src/schema.ts` `OrganizationDrop`,
  `OrganizationDropPickupWindow`, ...; App `menu+/drops.*.tsx`; public payload
  `apps/app/app/utils/menu/public-drop-context.server.ts`; regional capacity in
  `restaurant_order_reservations`). Drops are bound to menus and orders;
  Experiences are bound to time, seats and parties.
- Media: entities store a media key; the picker is
  `apps/app/app/components/media-library/media-library-picker.tsx`; public
  payloads resolve keys through the media map (`public-drop-context.server.ts`).
  `rsv_experiences.image_url` holds the resolved public URL.
- Placement: `rsv_experiences` and `rsv_experience_schedules` in the regional
  tenant DB, edited under `/operator/reservations/setup/experiences` (feature
  `experiences`), published to Sites through public
  `GET /reservations/experiences` and `/experiences/:slug` (non-PII; Sites SSR
  may call them). The research option of a control-plane
  `OrganizationExperience` / `OrganizationExperienceSession` is superseded.
- Kinds `ticketed` and `prix_fixe`; `uses_tables`, `exclusive`, per-seating and
  per-day cover caps; prepayment through the same checkout with
  `purpose: 'experience'`.
- Tests: last-seat race, hold expiry, party above remaining covers, exclusive
  windows block regular slots, draft or archived experiences never public, flag
  off -> 404.

## 8. Customers page and the Guestbook

- Existing Customers page: `apps/app/app/routes/_app+/$orgSlug_+/customers.tsx`
  (loader needs `READ_SETTINGS_ANY`; browser fetches `GET /operator/customers`
  from `apps/tenant-api/src/routes/operator.ts` and filters client-side; edit
  sheet PATCHes name and email). **It stays unchanged.** The research suggestion
  to extend it with a guest tab is superseded.
- `customers.phone` is unique and nullable; `phoneVerified` flags OTP customers
  (`packages/tenant-db/src/schema.ts:22-46`). A guest links to a customer only
  by `rsv_guests.customer_id` (verified) or `marketing_customer_id` (consent).
  Booking never creates a login.
- Phone matching precedent: `phoneKey()` and `orderIdentity` in
  `apps/tenant-api/src/services/report-records.ts`. Reservations normalize with
  `normalizeGuestPhone` (E.164) in `@repo/reservations`, which
  `apps/tenant-api/src/routes/auth.ts:95` adopts with unchanged behavior.
- Guestbook filtering is server-side with cursor pages of 50 (the client-side
  filtering in `customers.tsx` would not scale).
- Erasing a tenant customer calls `/internal/reservations/erase-customer`.

## 9. Gotchas

1. The phone-agent and staffing cores have vocabulary tests. Restaurant words go
   only in `packages/phone-agent-restaurant`, `apps/tenant-api/src/restaurant/`,
   `packages/staffing-restaurant` and UI wording.
2. Register voice actions and demand sources in **both**
   `apps/tenant-api/src/index.ts` (Node) and `workers/index.ts` (Workers), or
   one runtime silently lacks them.
3. The voice worker always calls the US `TENANT_API_URL`; KSA orgs have no phone
   agent. Hide the toggle for KSA and let tenant-api refuse by region.
4. Caller ID never identifies a guest: no lookup, no read-back, no modify or
   cancel by phone except texting the manage link to the number on the booking.
5. `web_test` calls must not write holds or bookings or text anyone; return
   `simulated: true`.
6. `evaluateAndSpawnTriggers` has no dedupe; the `rsv_journey_emissions` primary
   key is the only guard. Insert it first, inside or right after the committing
   transaction.
7. `journey_runs.customer_id` is NOT NULL: no customer, no journey.
8. Trigger label maps are `Record<string, ...>`: typecheck will not catch a
   missing label.
9. `customer_subscriptions` topics and channels are TypeScript enums only;
   widening them (`reservations`, `email`, source `reservation_booking`) needs
   no SQL migration but does need Zod and type updates.
10. `hasOrderSource()` must keep `labor-data.ts` sales and
    `activeReportCatalog()` wording unchanged after `visits` registers.
11. Dashboard server loaders must never read regional data; the block gets only
    a token URL, the tenant-api URL and location ids.
12. Report loaders must not log Drizzle errors (they embed bound values, which
    can be guest data).
