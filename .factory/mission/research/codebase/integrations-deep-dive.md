# Reservations integrations deep dive

Scope: how a regional, flag-gated reservations module (guest PII only in the
per-org tenant DB behind `apps/tenant-api`) plugs into the phone agent, the
staffing labor forecast, marketing journeys, reports, Home dashboards,
"Experiences", and the existing customer UI. This builds on
`staffing-module-blueprint.md` (flags, tokens, ticks, outbox, vocabulary) and
`ordering-locations-sites-payments.md` (sections 3, 4, 5, 9, 11), and does not
repeat them. All paths are relative to `/home/factory-user/repos/menuza`.

Naming note carried through every section: the phone-agent core test bans
`/reserv/i`, `order`, `menu`, `location`, `store`, `food` and similar words
(`packages/phone-agent/src/vocabulary.test.ts`); the staffing core bans food and
location words (`packages/staffing/src/vocabulary.test.ts`). The words
`booking`, `visit`, `guest`, `party`, `capacity` and `slot` are allowed in both
cores. Restaurant words ("reservation", "table", "covers") belong in
`packages/phone-agent-restaurant`, `apps/tenant-api/src/restaurant/` and
restaurant UI wording.

---

## 1. Phone agent

### Architecture as built

- **Worker** `apps/voice-agent` (LiveKit Agents for Node, US only;
  `assertUsDataRegion` in `src/models.ts:19` refuses to start unless
  `DATA_REGION=us`). `src/main.ts` joins a room, loads config, builds a
  `CallController` (`src/controller.ts`, 1,401 lines) and an LLM session.
- **Config**: the worker GETs App `/resources/phone-agent-config`
  (`apps/app/app/routes/resources+/phone-agent-config.ts`) with
  `VOICE_AGENT_TOKEN` (`requireVoiceAgentAuth`), by called number or by
  `{orgId, scopeId, flow}` for browser test rooms. `buildRuntimeConfig`
  (`apps/app/app/utils/phone-agent/runtime-config.server.ts`) builds
  `PhoneAgentRuntimeConfig`; the restaurant part comes from
  `restaurantConfigParts` (`packages/phone-agent-restaurant/src/data.ts:52`) via
  `apps/app/app/utils/phone-agent/restaurant/vertical.server.ts`. The vertical
  data is `{ location, menus, orderingOpen }` (published Sites payload, no
  callers). The worker caches configs and tolerates an App outage for a bounded
  time (`createRuntimeConfigLoader`, `src/services.ts:274`).
- **Models** (`apps/voice-agent/src/models.ts`): STT Deepgram `nova-3`
  (`DEEPGRAM_API_KEY`), LLM Google Gemini (`GOOGLE_API_KEY`,
  `PHONE_AGENT_LLM_MODEL`, default `gemini-2.5-flash`, temperature 0.4), TTS
  Cartesia `sonic-3` (`CARTESIA_API_KEY`, `CARTESIA_DEFAULT_VOICE_ID`). No
  OpenAI.
- **Tools** (`apps/voice-agent/src/tools.ts`): `buildAgentTools` = core tools
  (`get_business_info`, `set_call_purpose`, `end_call`, `transfer_to_staff`,
  `transfer_to_contact`, `switch_language`, `tag_call`, `record_request`) plus
  the vertical's tools adapted by `adaptVerticalTool` (records the tool name in
  `state.toolsUsed`, honors `rejectDuplicates` / `blockedDuringTransfer`,
  JSON-clones the result). A vertical tool cannot reuse a core tool name.
- **Vertical contract** (`packages/phone-agent/src/vertical.ts`):
  `VerticalTool { name, description, parameters?: zod object, rejectDuplicates?, blockedDuringTransfer?, execute(args, ctx) }`,
  defined with `defineVerticalTool`. `VerticalToolContext` = config, parsed
  data, settings, `verticalSettings`, `isOpen`, `language`, `formatPrice`,
  `now`, per-call `state`, `channel` (`phone` | `web_test`), `callerPhone`, and
  `services`. **`VerticalServices` has exactly one method:
  `sendLink({ path, payload, phone })`** (built in `controller.ts:325`
  `toolContext()`). Vertical tools therefore cannot call tenant-api for anything
  else today: all restaurant tools (`search_menu`, `get_menu_item`,
  `list_menu_categories`, `get_order`, `add_to_order`, `update_order_line`,
  `suggest_add_ons`, `send_order_link`,
  `packages/phone-agent-restaurant/src/tools.ts`) work on the config's in-memory
  menus plus call state, then text one link.
- **Where tool calls go**: the worker's `tenantApi` client
  (`apps/voice-agent/src/services.ts:319-444`) POSTs to
  `${TENANT_API_URL}/api/voice/*` with
  `Authorization: Bearer VOICE_AGENT_TOKEN`. Routes
  (`apps/tenant-api/src/routes/voice.ts`, mounted at `/api/voice` in
  `apps/tenant-api/src/app.ts:229`): `POST /calls` (start; matches caller ID to
  `customers.phone` only to link the call for operators, nothing returned),
  `POST /calls/:callId/finish`, `POST /handoffs` (stores payload behind a random
  token, texts `site/path#handoff=<token>`; deleted again if the text fails on a
  real call; `web_test` shows it on screen), `POST /website-links`,
  `POST /requests` (`voice_call_requests`). `requireVoiceAgent` (`:284`) returns
  503 when the token is missing/short, 401 on mismatch; `regionalOrganization`
  (`:311`) 404s an org from another region. SMS sends go through per-call and
  per-day caps (`callerSmsCaps`, `reserveSms`). Public
  `GET /voice/handoffs/:token` lets Sites read the payload back.
- **Reservation today**: request capture only. Restaurant definitions add call
  purpose and request type `reservation`
  (`packages/phone-agent-restaurant/src/definitions.ts`), FAQ category
  `reservations`, purpose inference `/reserv|book|table/i` (`vertical.ts`),
  prompt task "collect the party size, date, time, and a name, then save it with
  record_request ... a request and the team will confirm it" (`prompt.ts:66`).
  `record_request` (`tools.ts:30-84`) sends
  `{ type, callerName, callerPhone (spoken callback number or caller ID), details: key/value up to 20 }`
  to `POST /api/voice/requests`; operators see it under phone calls
  (`GET/PATCH /operator/calls/requests`).
- **Trust rules already encoded**: caller ID is spoofable; the worker ignores
  any customer data from `/calls` (`StartCallResponseSchema` comment,
  `services.ts:328`); handoff tokens live in URL fragments.

### Credentials (names only; checked in `apps/app/.env`, `.env.development`, `.dev.vars`, `apps/voice-agent`, `apps/tenant-api`, and the shell)

| Variable                                                        | Needed by                                    | Local status                                                                                                                                                                                     |
| --------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `VOICE_AGENT_TOKEN`                                             | App, tenant-api, worker                      | Present in `apps/app/.dev.vars`; tenant-api and voice-agent have no env file but their `.env.schema` carries the dev default (varlock fills it)                                                  |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`          | App (browser test call token), worker        | Absent in App (empty schema default, which hides browser test calls). Worker schema defaults to `ws://localhost:7880` / `devkey` / `secret`, but no `livekit-server` or `lk` binary is installed |
| `LIVEKIT_SIP_OUTBOUND_TRUNK_ID`                                 | worker, warm transfers                       | Absent (optional)                                                                                                                                                                                |
| `DEEPGRAM_API_KEY`                                              | worker STT                                   | Absent                                                                                                                                                                                           |
| `GOOGLE_API_KEY`, `PHONE_AGENT_LLM_MODEL`                       | worker LLM (App also lists `GOOGLE_API_KEY`) | Key absent; model has a default                                                                                                                                                                  |
| `CARTESIA_API_KEY`, `CARTESIA_DEFAULT_VOICE_ID`                 | worker TTS, App voice picker                 | Absent                                                                                                                                                                                           |
| `GOOGLE_GENERATIVE_AI_API_KEY`                                  | App AI features (FAQ generation)             | Absent                                                                                                                                                                                           |
| `OPENAI_API_KEY`                                                | not used by the phone agent                  | Absent                                                                                                                                                                                           |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | tenant-api SMS                               | Absent (SMS logs `[SMS MOCK]` outside production)                                                                                                                                                |
| `RECORDING_S3_*`                                                | worker recordings                            | Absent (recording skipped)                                                                                                                                                                       |

A live or browser test call needs LiveKit (server + keys in App and worker),
Deepgram, Gemini and Cartesia keys, App, US tenant-api and the worker running.
**None of that is possible locally right now.**

### Tests and what runs locally

- Worker unit tests with fakes, no LLM (`apps/voice-agent/src/*.test.ts`):
  `test-fixtures.ts` `setupTools()` builds a real `CallController` with fake
  services (`createRequest`, `createHandoff`, `sendWebsiteLink` as `vi.fn`) and
  returns `run(toolName, args)` that calls a tool's `execute` directly;
  `setupController()` adds a `FakeSession`, fake dialer, room and speech.
  `restaurant.test.ts` (26 tests) and `tools.test.ts` (10) pass locally in about
  6 s (verified). There is no fake LLM and no text-mode simulator: the model is
  never exercised in tests; tests drive tools and controller events directly.
- Core and vertical: `packages/phone-agent/src/*.test.ts` (flow, prompt,
  vertical, vocabulary; vocabulary passes), and
  `packages/phone-agent-restaurant/src/*.test.ts` (vertical, menu, location).
- tenant-api: `apps/tenant-api/src/routes/voice.test.ts` (65 tests, Hono
  `app.request` with the dev token, temp SQLite) passes locally.
- Manual: with `npm run dev:tenant-api` running,
  `curl -X POST http://localhost:3007/api/voice/... -H "Authorization: Bearer $VOICE_AGENT_TOKEN"`
  works for every system route (needs a provisioned org and a started call id
  from `POST /calls`).

### Gaps for "check availability" and "book"

1. Vertical tools have no way to read live regional data (availability changes
   per minute; it cannot be baked into the cached config).
2. The worker always posts to the US `TENANT_API_URL`; KSA orgs have no phone
   agent at all, so phone booking is US only.
3. `web_test` calls must not create real bookings or text guests.
4. Caller ID cannot identify a guest; nothing about an existing guest (name,
   history, other bookings) may be read back to the caller.

### Recommended approach

1. **Generic core service, no restaurant words.** Add to `VerticalServices` a
   second method, for example
   `action(name: string, input: unknown): Promise<VerticalActionResult>`
   (worker: `POST /api/voice/actions/:name` with
   `{ orgId, callId, scopeId, channel, input }`), with typed failures like
   `SEND_LINK_FAILURES` (`unavailable`, `rate_limited`, `not_enabled`,
   `invalid`). Add it to `controller.toolContext()`, `tenantApi` in
   `services.ts`, and the fakes in `test-fixtures.ts`. Document it in
   `docs/phone-agent-verticals.md`.
2. **tenant-api action registry** (mirrors `registerOrderSource`):
   `apps/tenant-api/src/services/voice-actions.ts` with
   `registerVoiceAction({ name, schema, maxPerCall, run(ctx, input) })`; the
   route in `voice.ts` checks `requireVoiceAgent`, `regionalOrganization`, that
   the call exists and is unfinished, per-call caps (count rows in a small
   `voice_call_actions` log, like `voice_sms_sends`), and dispatches. The
   restaurant registers `booking_availability` and `booking_hold` (and
   optionally `booking_create`) from
   `apps/tenant-api/src/restaurant/voice-booking-actions.ts`, which call the
   same reservation service as the public `/reservations/*` routes. Each action
   re-checks the reservations flag through the cached control-plane context
   (scope-context pattern) and returns only slot facts (times, party-size fit,
   deposit required yes/no), never guest data.
3. **Restaurant tools** in `packages/phone-agent-restaurant/src/tools.ts` (gated
   by a new restaurant setting `reservations.enabled` in `settings.ts` and by
   config data from App, e.g.
   `data.booking = { enabled, maxPartySize, bookingWindowDays, phoneMode }`):
   - `check_table_availability({ date, time?, partySize, areaPreference? })` →
     `services.action('booking_availability', ...)`, returns up to 3 nearest
     times.
   - `book_table({ date, time, partySize, name, notes?, phone? })`: default mode
     **hold + confirm link**: action `booking_hold` creates a short hold (10 to
     15 min, `source='phone'`, linked to `callId`), then
     `services.sendLink({ path: '/reserve/confirm', payload: { holdId } })`
     texts the link; the guest confirms (and pays a deposit if needed) on Sites,
     which turns the hold into a booking. Optional owner mode "confirm on the
     call" (action `booking_create`) for orgs without deposits: books directly
     with the spoken name and the caller ID or spoken number as an
     **unverified** contact, and texts a confirmation with a manage link
     (fragment token). Deposits always use the link.
   - Keep `record_request` with type `reservation` as the fallback when the
     module is off, the action fails, or the party is too large; the prompt line
     in `prompt.ts:66` becomes conditional on the setting.
   - Purpose classification: `classifyPurpose` returns `reservation` when a
     booking tool was used; `summarizeCall` adds "Held a table for 4 on Fri 7:30
     pm" (no name). Add the tool names to the call log's used tools and a
     `booking_id` on the call row for operators.
4. **Caller-ID trust**: never look up a guest by caller ID for the caller; never
   offer "cancel/change my existing booking" by phone except by texting the
   manage link to the number on the booking; create or match a guest profile by
   phone only as `phone_verified=false`; never link a phone booking to an OTP
   `customers` row.
5. **Test calls**: on `channel='web_test'`, availability is real, holds and
   bookings are dry runs (no row, `simulated: true`), and links are shown on
   screen as today.
6. **Region**: hide the phone booking setting for KSA orgs (the worker is US
   only); tenant-api still refuses by region.
7. **App**: extend the restaurant vertical config builder with the booking facts
   (no PII) and add the setting to the phone-agent settings page.

### Test approach

- `packages/phone-agent/src/vocabulary.test.ts` must stay green (use "action",
  "booking", "slot" in core).
- Core: `vertical.test.ts` for the new service type and result union.
- Restaurant: `packages/phone-agent-restaurant/src/vertical.test.ts` / new
  `booking-tools.test.ts`: tools hidden when disabled; argument validation;
  prompt text switches between request capture and booking.
- Worker: extend `setupTools()` fakes with `runAction: vi.fn()`; in
  `restaurant.test.ts`, `run('check_table_availability', ...)` and
  `run('book_table', ...)` assert the action calls, the handoff payload, the
  `web_test` dry run, transfer blocking, and failure wording.
- tenant-api: new `routes/voice.actions.test.ts`: 401/503 token cases, region
  404, unknown action 404, finished call 409, per-call caps 429, flag off 404,
  availability returns no guest fields, hold expiry, dry run on `web_test`, and
  a concurrency test (two holds for the last slot).
- Manual locally: curl `POST /api/voice/calls` then
  `POST /api/voice/actions/booking_availability` with the dev token. A live call
  stays a staging-only check (needs LiveKit, Deepgram, Gemini, Cartesia).

---

## 2. Staffing labor forecast

### As built

- `apps/tenant-api/src/services/order-source.ts`: **single slot**
  (`let current`), `registerOrderSource(source | null)`, `getOrderSource()`.
  Registered at startup by both runtimes (`apps/tenant-api/src/index.ts:13`,
  `apps/tenant-api/workers/index.ts:34`) via `registerRestaurantOrderSource()`.
- Source shape (`OrderSource`):
  - `loadBuckets(db, scopeId, { fromSeconds, toSeconds, alignSeconds })` →
    `OrderBucketRow[]` =
    `{ bucket (15-min index, DEMAND_BUCKET_SECONDS=900), currency (upper case), fulfillment: 'pickup'|'delivery', orders, subtotalMinor, tipMinor }`.
    Feeds the demand guide (median by weekday and hour over trailing weeks) and
    labor sales.
  - `loadBooked(db, scopeId, { fromSeconds, toSeconds, timeZone })` →
    `BookedOrderFact[]` = `{ date, hour, orders }` (future orders by
    `scheduledFor`, local hour).
- Restaurant implementation
  `apps/tenant-api/src/restaurant/staffing-order-source.ts`: groups
  `restaurant_orders` by `location_id = scopeId` and `countedOrderCondition()`;
  counts and money only.
- `apps/tenant-api/src/services/forecast-service.ts` `loadForecastGap`: demand
  guide (`loadDemandGuide`), labor settings
  (`labor_scope_settings.orders_per_labor_hour` JSON, position → standard),
  booked orders, live shifts → `computeForecastGap`
  (`packages/staffing/src/forecast-gap.ts:118`): per hour
  `orders = max(median, booked)`, `needed = ceil(orders / standard)` per
  position, status short/over/ok/quiet; output `source: 'online_orders'`,
  `method: 'median_orders_per_labor_hour'`.
- Other consumers of the slot: `services/labor-data.ts` (sales source switches
  to order-source sales when registered) and
  `restaurant/staffing-report-catalog.ts` `activeReportCatalog()` (uses the
  slot's presence to pick restaurant wording). Changing the slot affects all
  three.
- Routes: `GET /operator/schedule/demand` and `/forecast`
  (`apps/tenant-api/src/routes/schedule.ts:156,168`, forecast behind the labor
  grant).
- App UI: `apps/app/app/components/staff/schedule/forecast-strip.tsx` (24 cells
  per day, copy "against the orders you usually get"), `demand-strip.tsx`,
  `recommend-dialog.tsx`, `week-grid.tsx`, `schedule-page.tsx`; types in
  `apps/app/app/utils/staffing/labor-types.ts`.

### How covers fit

Covers are a different unit from orders (one 4-top is one order but four covers,
and servers scale with covers while kitchen scales with orders and covers).
Adding covers into `orders` would corrupt the standards managers already set. A
separate demand signal is needed.

### Recommended approach

1. Replace the single slot with a **registry of demand sources** keyed by a
   neutral unit, keeping `registerOrderSource` as a wrapper so existing code and
   tests keep working:
   `registerDemandSource({ id: 'orders' | 'visits' | string, label, loadBuckets, loadBooked })`.
   Keep a helper `hasOrderSource()` for `labor-data.ts` and
   `activeReportCatalog()`, so registering reservations does not flip the sales
   source or catalog wording.
2. Reservations register a `visits` source (generic name; the restaurant UI says
   "covers") from `apps/tenant-api/src/restaurant/staffing-booking-source.ts`:
   - `loadBuckets`: party sizes of seated/completed bookings plus logged
     walk-ins, bucketed by seated time (the history the median needs).
   - `loadBooked`: confirmed future bookings by start time, `units = partySize`,
     excluding cancelled and no-shows (and expired holds).
   - Generalize `BookedOrderFact` to `{ date, hour, units }` per source.
3. Labor settings: add per-unit standards, e.g. `demand_per_labor_hour` JSON
   `{ [sourceId]: { [positionId]: n } }` (migrate `orders_per_labor_hour` into
   `orders`). `computeForecastGap` computes need per source and sums per
   position (a position without a standard for a unit ignores that unit). Output
   carries `sources: ['online_orders', 'visits']` and per-slot `bookedBySource`.
4. UI: one extra row or tooltip line in `forecast-strip.tsx` ("12 covers
   booked"), a standards input per unit in labor settings, and wording via the
   scope-wording provider. Only counts, never names.
5. Keep the vocabulary rule: no "covers"/"table" in `packages/staffing`.

### Test approach

- Existing guards that must stay green:
  `packages/staffing/src/forecast-gap.test.ts`, `schedule-demand.test.ts`,
  `vocabulary.test.ts`; `apps/tenant-api/src/routes/schedule.forecast.test.ts`,
  `schedule.demand.test.ts`, `labor.test.ts`, `labor.tips.test.ts`,
  `analytics.staffing.test.ts`,
  `apps/tenant-api/src/restaurant/staffing-order-source.test.ts`;
  `apps/app/app/utils/staffing/labor-types.test.ts`.
  (`schedule.forecast.test.ts` passes locally.)
- New: pure tests for multi-source `computeForecastGap` (orders only gives
  identical output to today; visits-only; both summed per position; booked >
  median wins per unit); a `staffing-booking-source.test.ts` (scope filter,
  cancelled/no-show excluded, DST hour bucketing, no guest columns selected);
  route test that the forecast view has no names and stays behind the labor
  grant; registry test that registering `visits` does not change `labor-data`
  sales source or catalog wording.

---

## 3. Marketing journeys

### As built

- Trigger types:
  `JOURNEY_TRIGGER_TYPES = ['phone_verified', 'profile_completed', 'custom_event', 'manual']`
  in `packages/tenant-db/src/types/journey.ts:22` (zod
  `journeyTriggerTypeSchema` used by create/update input schemas) and a
  duplicate TS enum on `marketing_journeys.trigger_type`
  (`packages/tenant-db/src/schema.ts:137-142`, no SQL CHECK constraint, so a new
  value needs no migration).
- `evaluateAndSpawnTriggers(orgId, triggerType, customerId, tenantApiUrl?, contextData)`
  (`apps/tenant-api/src/services/journey-service.ts:929`): selects active
  journeys with that trigger type, inserts a `journey_runs` row per journey
  (`customer_id NOT NULL` FK to `customers`, `context_data` JSON), and POSTs a
  zero-PII payload (org, run, customer id, graph) to the jobs-cron worker
  `${JOBS_CRON_WORKER_URL}/api/workflows/marketing-journey/start` with
  `INTERNAL_COMMAND_TOKEN`. Dispatch failures are recorded on the run.
  **`triggerConfig` is not used for filtering**, and there is **no dedupe**:
  each call spawns a run per journey. Called fire-and-forget (`void`) from
  `routes/auth.ts:538` (verify) and `:856` (profile).
- Steps: the workflow calls back `/api/journeys/*`; `executeJourneyStep`
  (`:114`) loads the `customers` row (404 if missing), sends email via
  `sendTenantEmail` (with marketing context headers) or SMS via `sendSms`,
  idempotent per run+node. `evaluateJourneyCondition` (`:703`) reads a field
  from the customer row or `contextData`, so reservation facts in `contextData`
  can drive condition nodes.
- **Consent**: `customer_subscriptions` (topic enum `['drops']`, channel
  `['sms']`, sources enum) is only checked by drop alerts
  (`routes/subscriptions.ts`). **Journey steps do not check consent**, and
  campaigns only segment by `audience: all | verified | unverified`
  (`routes/operator.ts:485-510`). Merge tags are customer fields only
  (`packages/common/src/merge-tags.ts`: firstName, lastName, name, email, phone,
  organizationName).
- Labels: two parallel maps that both need entries:
  `packages/marketing-workflow/src/workflow-labels.ts` (`TENANT_TRIGGER_MSGS`,
  `TENANT_TRIGGER_OPTION_MSGS`, Lingui) and
  `packages/marketing-workflow/src/workflow-config.tsx`
  (`TENANT_TRIGGER_LABELS`, `TENANT_TRIGGER_OPTIONS`).
- App editor:
  `apps/app/app/routes/_app+/$orgSlug_+/marketing+/automations.new.tsx` and
  `automations.$journeyId.tsx` read `triggerType`/`config` from the trigger
  node; tests `automations.test.ts`, `automations.adversarial.test.ts`,
  `automations.e2e.test.ts`.
- Segments/audiences: no first-class segment model.

### Guests not linked to an OTP customer

Journeys need a `customers` row. Precedent: `POST /auth/send-code` already
creates a blank-name, unverified `customers` row on first send, so unverified
rows exist. But a phone typed into a booking form is not proof of identity, and
marketing to it needs explicit consent.

### Recommended approach

1. Add trigger types `reservation_booked`, `reservation_cancelled`,
   `reservation_completed`, `reservation_no_show` to both enums and both label
   maps (restaurant wording is acceptable here: these packages already carry
   restaurant subjects; if upstream neutrality matters, use `booking_*` ids with
   restaurant labels). Offer them in the editor only when the reservations flag
   is on (pass the allowed list into the workflow config).
2. Fire from the reservation service after the status transition commits, once
   per booking and trigger (dedupe column or a small `booking_journey_events`
   outbox with a unique `(booking_id, trigger)`), driven by host actions and the
   regional tick (no-show and completed). `contextData` = ids and facts only:
   `bookingId`, `scopeId`, `partySize`, `localDate`, `serviceId`, `source`,
   `experienceId`, `visitNumber`. Never notes, allergies, names.
3. Guest identity: fire only when the booking has a `customer_id` (booked while
   signed in, or OTP verified during booking) **or** the guest gave explicit
   marketing consent at booking. On consent, upsert an unverified `customers`
   row by normalized phone, link it from the guest profile, and record consent
   (`customer_subscriptions` topic `visits` or `reservations`, channels `sms`
   and `email`, source `reservation`; both enums widened). Without consent, no
   journey run, but reports and the Guestbook still count the visit.
4. Add a consent check in `executeJourneyStep` for these triggers (and ideally
   for all marketing steps): skip with status `skipped` when the customer has no
   active subscription for the channel. This closes an existing gap that
   reservations would otherwise widen.
5. Transactional messages (confirmation, reminder, cancellation) are not
   journeys; send them from the reservation outbox without consent topics.

### Test approach

- `apps/tenant-api/src/routes/journeys.test.ts`: create/update journeys with
  each new trigger type; reject unknown types.
- New `reservation-journeys.test.ts` modelled on `auth-trigger.test.ts` (mocks
  `../lib/origin.ts` and fetch to the workflow worker): each transition spawns
  exactly one run per active journey, repeat transitions do not, contextData has
  no PII keys, no run without consent/customer.
- `journeys.e2e-integration.test.ts`: condition on `partySize` from contextData;
  step skipped when consent is withdrawn.
- `packages/marketing-workflow/src/serialization.test.ts` / `validation.test.ts`
  for the new options; App `automations.test.ts` for the flag-gated trigger
  list; `npm run lingui:extract`.

---

## 4. Reports

### As built

- Catalog: `packages/reports/src/catalog.ts`
  (`ReportSubject { id, label, description, scope, source: 'control-plane'|'tenant-api'|'integrations', fields, currencyField?, timeZoneField?, defaultColumns? }`;
  `ReportField { id, label, type: datetime|boolean|enum|string|number|currency|duration|ratio, filterable, groupable, timeframe, options, listable, requiresSubject, sumLabel/averageLabel, ratio { numerator, denominator, unit: percent|per_hour }, showTime }`).
  Staff subjects live in `catalog-staffing.ts` (`STAFFING_REPORT_SUBJECTS`,
  `scopeField`, records carry the scope time zone). Templates in `templates.ts`
  (`sales-*`, `orders-*`, `items-*`). Engine `engine.ts` (`runReport`) runs on
  the records server-side in tenant-api; the DSL is `dsl.ts`.
- Restricted subjects: `RESTRICTED_REPORT_SUBJECTS` in
  `packages/reports/src/operator-token.ts:32` (phone_calls, orders, order_items,
  order_options, staff subjects, staff_pay); `operatorTokenAllowsSubject` lets
  unrestricted subjects through for any analytics token.
- Access: App token route
  `apps/app/app/routes/_app+/$orgSlug_+/reports+/token.ts` requires one of
  `READ_ANALYTICS_ANY | READ_SETTINGS_ANY | READ_WEBSITE_ANY`, then adds
  `phone_calls` (call permission), order subjects (menu permission) and staff
  subjects from `resolveStaffReportAccess`
  (`apps/app/app/utils/staffing/report-access.server.ts`: flags, permissions,
  scope ids, none when impersonating). Token: 15 min, audience
  `tenant-api-operator`, signed from `INTERNAL_COMMAND_TOKEN`.
  `packages/reports/src/access.ts` `catalogForGrants` hides staff subjects
  without a grant (UI side).
- Regional run: browser → tenant-api `POST /analytics/query`
  (`apps/tenant-api/src/routes/analytics.ts:256`): verifies token, subject
  known, token grants subject and every `requiresSubject` field, org active and
  in region, then dispatches by subject to loaders in
  `services/report-records.ts` (customers, orders, items, options, text
  subscribers) or `services/staffing-report-records.ts` (with an audit row per
  run), then `runReport(activeReportCatalog(), ...)`. Row caps
  (`ORDER_REPORT_MAX_ROWS = 50_000`) are reported as `sourceTruncated`.
- PII today: the `customers`, `orders` and `phone_calls` subjects include
  name/phone/email fields, which reach the operator's browser directly (allowed
  by residency). Staff loaders never log Drizzle errors (they quote bound
  values).

### What a reservations report set needs

Subjects (restricted, regional, new file `catalog-bookings.ts`):

- `bookings` (one record per booking): `bookedAt`, `startsAt` (timeframe,
  `showTime`), `localDate`, `scope`, `service` (enum from settings), `source`
  (web, phone, host, walk-in, google later), `status` (booked, seated,
  completed, cancelled, no_show), `partySize` (number, sum label "Covers"),
  `partySizeBucket` (enum 1-2, 3-4, 5-6, 7+), `turnMinutes` (duration, seated →
  completed), `leadTimeDays`, `cancelledBy`, `cancelledLeadHours`, `experience`,
  `depositMinor` / `feeMinor` / `refundedMinor` (currency) with `currency`,
  `timeZone`, `isRepeatGuest`, ratio fields `noShowRate` (no_show / booked
  count) and `cancellationRate`. Optional PII columns `guestName`, `guestPhone`
  gated by `requiresSubject: 'booking_guests'` (a second restricted grant for
  guest-level lists), so aggregates never need PII access.
- `waitlist_entries`: `addedAt`, `scope`, `partySize`, `quotedMinutes`,
  `waitedMinutes`, `outcome` (seated, left, removed, converted_to_booking),
  ratio `conversionRate`.
- Templates: covers by day/service/source, no-shows by week and rate,
  cancellations by lead time, average turn time by party size bucket, waitlist
  conversion, deposits and fees collected by month.

### Recommended approach

1. Add `bookings`, `waitlist_entries` (and `booking_guests` as a field grant) to
   `RESTRICTED_REPORT_SUBJECTS`; grant them in `reports+/token.ts` through a
   `resolveBookingReportAccess()` (flag `reservations.enabled` plus a
   `read:booking:any` permission, location scope like staff, impersonation gets
   none).
2. Loaders in `apps/tenant-api/src/services/booking-report-records.ts`: SQL
   aggregates on regional tables, select guest columns only when the definition
   references a `booking_guests` field, row cap with `sourceTruncated`, scope
   filter from token `scopeIds`, records carry the location time zone. Dispatch
   in `routes/analytics.ts` next to staff.
3. `catalogForGrants` already handles restricted subjects generically for staff;
   extend it so bookings are hidden without the grant.
4. Keep money as recorded facts (deposit captured, fee charged, refund
   recorded), never inferred.

### Test approach

- `packages/reports/src/catalog-bookings.test.ts` (fields valid, ratios
  reference existing fields, every PII field has `requiresSubject`),
  `templates.test.ts` for the new templates, `access.test`-style checks for
  `catalogForGrants`.
- tenant-api `routes/analytics.bookings.test.ts` modelled on
  `analytics.staffing.test.ts`: 403 without grant, 403 for guest fields without
  `booking_guests`, scope limits, cross-org token rejected, region mismatch 409,
  aggregates correct for a seeded fixture (no-show rate, turn time by party
  size).
- App `reports+/token.bookings.test.ts` modelled on `token.staffing.test.ts`
  (flag off, permission missing, impersonation).

---

## 5. Dashboards

### As built

- `apps/app/app/utils/dashboards/config.ts`:
  `BUILT_IN_BLOCK_TYPES = ['stats','notes-chart','onboarding','leaderboard']` +
  `report`; `BLOCK_DEFINITIONS` (title, description, default/min sizes per
  `lg`/`md`, `maxInstances`); `dashboardBlockSchema` is a discriminated union
  (built-ins have no config; `report` has
  `{ source: 'saved', reportId } | { source: 'template', templateId }`);
  `defaultHomeConfig()`; `canAddBlockType`,
  `addableBuiltInBlockTypes(blocks, { onboardingAvailable })`.
- Rendering: `components/dashboard/dashboard-block-content.tsx` switch on
  `block.type`; built-in data is loaded server-side in
  `utils/dashboards/block-data.server.ts` `loadBuiltInBlockData` (control plane
  only). `visibility.ts` `hiddenBlockIds` hides onboarding when done.
- Browser-fetched pattern: `components/dashboard/blocks/report-block-result.tsx`
  uses `useReportRunner` from `@repo/reports/ui` with `runUrl`, `tokenUrl`
  (`/${slug}/reports/token`) and `tenantApiUrl` from `loadReportBlockData` (the
  server never queries customer data; access is decided by the token responses;
  403 shows "No access").
- Permissions/flags: there is no per-block permission or flag gating apart from
  onboarding visibility; report blocks rely on the regional token grants.

### Recommended approach for "Today's reservations"

- Fastest path, no new block type: ship report templates (`bookings` subject,
  timeframe today, group by status; covers by service) and let operators add
  them as `report` blocks. Works with existing token gating.
- Dedicated block (better UX): add `'bookings-today'` to `BUILT_IN_BLOCK_TYPES`
  with a definition (lg 6x8, `maxInstances: 1`). Server side passes only
  `{ tokenUrl: '/${slug}/reservations/token', tenantApiUrl, locations }`; the
  browser mints a short-lived reservations operator token (scopes
  `reservations:read`) and calls a new regional endpoint
  `GET /operator/reservations/today?scopeId=` that returns counts by status,
  covers by service, and the next N arrivals as
  `{ time, partySize, area, status, guestFirstName? }`. First names are
  acceptable only because the call is browser-direct with an operator token;
  drop them when the viewer lacks guest access. Hide the block
  (`hiddenBlockIds`) and remove it from the picker (`addableBuiltInBlockTypes`)
  when the flag is off or the viewer lacks the permission; the loader must
  compute that from flags and permissions, not from the client. Poll every 60 s
  while visible.
- Do not put booking counts into `loadBuiltInBlockData`: that runs on the App
  server and must not read regional data.

### Test approach

- `config.test.ts` (schema accepts the new type, size limits, max instances),
  `visibility.test.ts` (hidden when flag off / no permission),
  `block-data.server.test.ts` (no regional fetch on the server),
  `add-block-dialog.test.tsx` (not offered without access), a component test for
  the block with MSW-mocked tenant-api (loading, 403, empty day, RTL), and a
  tenant-api route test for `/operator/reservations/today` (scope limits, no
  phone/email/notes in the response).

---

## 6. Experiences (ticketed or prix-fixe events)

### What exists

- **Drops** (control plane, `packages/database/src/schema.ts:3265-3420`):
  `OrganizationDrop` (`menuId` NOT NULL, `title`, `slug` unique per org,
  `description`, `coverImageKey`, `coverImageUrl`, `status`,
  `ordersOpenAt`/`ordersCloseAt`, `visibility`, `checkoutHoldMinutes` default 5,
  display toggles, `includeGiftCard`), `OrganizationDropPickupWindow` (`date`,
  `startTime`, `endTime`, `slotIntervalMinutes`, `maxOrdersPerSlot`,
  `orderLeadTimeMinutes`), `OrganizationDropInventory`,
  `OrganizationDropReminder`. App UI
  `apps/app/app/routes/_app+/$orgSlug_+/menu+/drops.*.tsx` and
  `components/menu/drop-wizard/drop-form.tsx`; public payload
  `utils/menu/public-drop-context.server.ts` and
  `routes/resources+/sites.drops.ts`.
- **Regional side of drops**: capacity and holds are counted in
  `restaurant_order_reservations` (`kind item|category`, `entity_id`,
  `window_id`, `slot_time`, `quantity`, tied to `restaurant_orders`) inside the
  order transaction; payment by hosted checkout.
- **Single-product shop**: `Organization.shopProductName`,
  `shopProductDescription`, `shopProductPriceCents` (US only, legacy path that
  opens the tenant DB from App; do not copy).
- **Media**: `OrganizationMediaAsset` (`objectKey`, `storageScope`, `mimeType`,
  size, dimensions, `altText`, `caption`, `source`) is the org media library;
  entities store `imageKey` / `coverImageKey` (+ a cached URL) and public
  payloads resolve the key through the media map
  (`public-drop-context.server.ts:381`). Picker:
  `apps/app/app/components/media-library/media-library-picker.tsx`. No PII.

### Assessment

Drops are bound to a menu and to orders (pickup windows, item inventory, order
checkout); an Experience is bound to a time, seats and a party. Reusing drop
tables would force a fake menu and mis-model capacity. The patterns are
reusable: control-plane definition with open/close window and cover image,
public non-PII payload for Sites SSR, regional holds counted in one transaction
with hold expiry, hosted checkout for prepayment.

### Recommended approach

- An Experience is a **reservations-module entity**, split like drops:
  - **Definition (control plane, non-PII)**: `OrganizationExperience` (title,
    slug, localized description, `coverImageKey` from the media library,
    `locationId`, `pricePerPersonMinor`, currency,
    `payment: deposit | full | none`, `depositPerPersonMinor`, min/max party,
    booking window open/close, cancellation policy text, status, visibility) and
    `OrganizationExperienceSession` (date, start, duration, capacity in seats,
    optional area/table ids, `exclusive: boolean` meaning the linked area or
    tables are blocked for regular bookings during the session). This keeps the
    Sites page SSR-renderable and cacheable like drops, and lets the App edit it
    without regional calls.
  - **Bookings and capacity (regional)**: an experience booking is a normal
    booking with `experience_id` and `session_id`; seat counts and holds are
    computed in the booking transaction; prepayment uses the reservation-deposit
    hosted checkout (metadata type, e.g. `booking_payment`).
  - The availability engine treats an exclusive session as a block on its
    areas/tables, fetched with the cached reservation context.
- If the module decides all reservation config is regional instead, the
  Experience definition should follow it there (one home for config); then Sites
  must fetch the public definition from tenant-api at SSR the way
  `FormBlock.astro` does. Either way, guests and payments stay regional.

### Test approach

- Control plane: schema/migration test, App action tests (validation, media key
  ownership via `utils/menu/ownership.server.ts`-style check), public payload
  test (no hidden or draft sessions, no PII).
- Regional: capacity tests (last seat race, hold expiry, party larger than
  remaining seats, exclusive session blocks regular slots), payment status tests
  modelled on order payment tests, report fields for experience revenue.
- Sites: page renders with flag off (404) and on, `no-store` on availability.

---

## 7. Existing customer UI and the Guestbook

### As built

- App `apps/app/app/routes/_app+/$orgSlug_+/customers.tsx` (626 lines): loader
  requires `READ_SETTINGS_ANY` and returns `{ jwt, tenantApiUrl }` from
  `getOperatorTenantClient`; the browser fetches
  `GET {tenantApi}/operator/customers` (page/limit up to 500, default 100;
  fields `id, name, email, phone, phoneVerified, createdAt, updatedAt`) and
  filters **client-side** with `@repo/ui/filters`; an edit `Sheet` PATCHes
  `/operator/customers/:id` (name, email only). No detail page, no history, no
  notes, no tags, no segments (`apps/tenant-api/src/routes/operator.ts:97,149`).
- Keying: `customers.phone` is unique (nullable), `email` free, `phoneVerified`
  flag, `stripeCustomerId` unique. `packages/tenant-db/src/schema.ts:22-46`.
- Guest vs account matching for reports: `phoneKey()` (last nine digits) and
  `orderIdentity` in `apps/tenant-api/src/services/report-records.ts:100-300`
  merge signed-in and guest orders per person for the `customers` report subject
  (`orderCount`, `totalSpent`, `firstOrderAt`, ...).
- Marketing audiences: `all | verified | unverified` only.

### Recommended approach

- **Guest profile as its own regional table** (`guest_profiles`: normalized
  phone key, display name, email, `customer_id` nullable link, tags, notes,
  allergies/dietary, visit/no-show/cancel counters, first/last visit,
  `phone_verified_via` none|otp). Reasons: `customers` is the OTP login record
  with marketing implications; guests booked by phone or host must not become
  login records or marketing audience by default; notes and allergies are more
  sensitive than login data. Link to `customers` only through OTP (booking while
  signed in, or verifying at booking) or explicit consent (section 3).
- **One customer UI, two lenses**: extend the existing Customers page instead of
  a parallel CRM: add a row detail `Sheet` (visits, upcoming bookings, orders
  summary, tags, notes, allergies) fetched browser-direct from a new
  `GET /operator/guests/:id` with a reservations operator token; add a "Guests"
  tab or filter when the reservations flag is on. Reuse `@repo/ui/filters` and
  the same Sheet layout. Move filtering to the server when lists grow (current
  client filtering over 100 rows will not scale to a guestbook).
- The host-stand booking panel shows the same profile summary component.
- Erasure/export: include guest profiles, notes and bookings in the regional
  erase and export paths; KSA follows the region wipe rule.
- Permissions: guest notes/allergies behind a dedicated permission (for example
  `read:guest:any`), separate from `READ_SETTINGS_ANY`.

### Test approach

- tenant-api: guest profile upsert by phone key (formatting variants collapse),
  no auto-link to `customers` without OTP, operator routes scope and permission
  tests, erase removes notes and profile, cross-org token rejected.
- App: customers page tests for the detail sheet and flag-gated tab (MSW
  tenant-api), no server-side regional fetch in the loader.

---

## Cross-cutting checks

- Everything new in tenant-api follows the staffing security gates pattern
  (`apps/tenant-api/src/routes/staffing-security.test.ts`): every route refuses
  missing, forged or grantless tokens and has cross-org tests.
- Vocabulary tests stay green; restaurant words only in restaurant folders and
  packages.
- Locally verified passing: `apps/voice-agent` `tools.test.ts` +
  `restaurant.test.ts` (36 tests), `packages/phone-agent` `vocabulary.test.ts`,
  `apps/tenant-api` `voice.test.ts`, `schedule.forecast.test.ts`,
  `auth-trigger.test.ts` (76 tests).
