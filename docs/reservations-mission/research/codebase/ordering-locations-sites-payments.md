# Reservations planning: ordering, locations, Sites, payments (codebase analysis)

Scope: read-only investigation of `/home/factory-user/repos/menuza` to find what
an OpenTable-like Reservations module can reuse and where it must integrate. All
paths are relative to the repo root unless absolute.

---

## 1. Locations

**Model (US control plane, `@repo/database`).** `OrganizationLocation` in
`packages/database/src/schema.ts:2466-2520`. Columns: `id`, `organizationId`,
`name`, `slug` (unique per org), `phone`, `timezone` (IANA, default
`America/New_York`), `taxRate`, `address` (JSON text), `storeHours`,
`onlineHours`, `specialHours` (JSON text), `prepTime`, large-order fields,
`fulfillmentOptions` (`pickup|delivery|dineIn|curbside`), `inHouseTips`,
`scheduling` (`scheduledOrdersEnabled`, `advanceOrderDays`), `deliveryConfig`,
`deliveryZones`, `isActive`, `isDefault`. Not part of the catalog tables; menus
attach per-location via `OrganizationMenuLocationOverride`.

JSON shapes are typed in `packages/common/src/location-types.ts`:

```ts
interface TimeSlot { start: string; end: string }          // "HH:MM"
interface DaySchedule { day: DayOfWeek; isOpen: boolean; slots: TimeSlot[] }
type WeeklySchedule = DaySchedule[]
interface SpecialHour { id; date: 'YYYY-MM-DD'; isOpen; slots: TimeSlot[]; note? }
interface LocationAddress { formattedAddress; city; state; postalCode; country; lat; lng; ... }
```

Overnight hours are split at midnight (`location-availability.ts:10-16`: a slot
whose end is not after its start is "never open"). There is **no** per-location
reservations config, dining-room/table, seating capacity or "dine-in hours" yet.
`fulfillmentOptions.dineIn` is the only dine-in signal.

Staffing uses opaque **scopes**, not locations (`Organization.staffingTimeZone`,
one implicit scope `main`); `packages/staffing-restaurant/src/location-scope.ts`
maps member location grants (`UserOrganizationLocation`) to a token
`locationIds` claim.

**Operator UI.**
`apps/app/app/routes/_app+/$orgSlug_+/settings+/locations._index.tsx`,
`locations.new.tsx`, `locations.$locationId.tsx` (Zod `LocationInputSchema`,
JSON strings for hours, `ensureLocationCoordinates` geocode, then
`purgeOrganizationSiteCache`). Components in
`apps/app/app/components/locations/`: `location-form.tsx`,
`availability-picker.tsx` (weekly hours), `special-hours-picker.tsx`,
`address-autocomplete.tsx`, `delivery-zones-manager.tsx`,
`delivery-zone-map.tsx`. Permission: `ORG_PERMISSIONS.READ_SETTINGS_ANY` to
read.

**How tenant-api obtains location context.**
`GET {APP_URL}/resources/order-context?orgId&locationId[&drop]`
(`apps/app/app/routes/resources+/order-context.ts`), guarded by
`requireInternalCommandAuth` (`INTERNAL_COMMAND_TOKEN`, 302 is rewritten to
403). Only active + `sitePublished` + `hasProvisionedDb` orgs. Response
(`Cache-Control: private, no-store`, never the published KV cache):

```ts
{ orgId, dataRegion: 'us'|'ksa',
  menu: PublicSiteMenuPayload,   // organization{id,name,slug,currency,defaultLocale,locales}, locations[], menus[], locationOverrides
  drop: PublicSiteDropPayload|null, // never drafts
  onlinePayment: { enabled, processor: 'connect'|'checkout'|null } }
```

Validated in tenant-api with `restaurantOrderContextSchema`
(`packages/common/src/restaurant-orders.ts:723-835`; location shape
`publicLocationContextSchema` at `:652-719` includes `timezone`, `onlineHours`,
`storeHours`, `specialHours`, `scheduling`, `address`, `phone`).

Fetcher: `fetchOrderContext` in
`apps/tenant-api/src/services/order-service.ts:137-196`:
`AbortSignal.timeout(5_000)`, `redirect: 'error'`, base URL only from
`APP_URL`/`BASE_URL` env (never browser-supplied), schema-validated, `orgId`
must echo; any failure is `503 ordering_unavailable` (fail closed). **No
caching**: fetched on every `POST /orders`, `GET /orders/options`, and
`/delivery/quote`. The node also checks
`getNodeRegion() === context.dataRegion`.

A second, cached variant exists for staffing:
`apps/tenant-api/src/lib/scope-context.ts` calls
`/resources/staffing/scope-context` with a 3 s timeout, LRU cache fresh 5 min /
stale 24 h, 30 s failure cooldown, and flags trusted at most 30 min stale (fail
closed). That pattern suits read-heavy availability endpoints.

**Would reservations get hours/time zone the same way?** Yes, but not through
the order-context endpoint as-is: it builds the whole priced menu, which is
expensive for an availability grid. Recommend a sibling internal route (e.g.
`/resources/reservations/context?orgId&locationId`) that returns location facts
(name, timezone, hours, special hours, address, phone), the `reservations.*`
flags, the reservation config if it lives in the control plane, and the deposit
processor (`resolveRestaurantOnlinePayment`). Use the `scope-context.ts` caching
strategy for reads (availability) and a fresh fetch (like `fetchOrderContext`)
for writes (booking).

---

## 2. Restaurant ordering flow end to end

Contract doc: `docs/restaurant-ordering-contract.md`; launch/ops:
`docs/restaurant-ordering-launch.md`.

**Routes (tenant-api, Hono, `apps/tenant-api/src/app.ts`).**

- `apps/tenant-api/src/routes/orders.ts` (mounted at `/orders`):
  - `POST /orders`: body size cap 200 KB, `restaurantOrderRequestSchema`
    (strict; no prices, no customerId), optional Turnstile
    (`RESTAURANT_TURNSTILE_ACTION = 'place-order'`, only enforced when
    `TURNSTILE_SECRET_KEY` set), org resolved from browser `Origin` + slug/host
    (`resolveOrderingOrganization` → `resolveOrganizationForBrowserAuth`),
    region and provisioning check, optional customer JWT binding
    (`optionalCustomerId`: invalid/cross-org token is rejected, not ignored),
    per-phone limit `rateLimitByKey('order-create-phone', 10/hour)`.
  - `GET /orders/options`: aggregates only (slot counts, entity usage).
  - `GET /orders/:id`: requires `Authorization: Bearer <receiptToken>`; a
    customer JWT is **not** a receipt capability.
  - Global per-IP limits in `app.ts`: create 12/min, reads 240/min.
- `apps/tenant-api/src/routes/order-system.ts` (`/api/orders/*`, App → regional,
  `INTERNAL_COMMAND_TOKEN`, constant-time compare, `assertOrgRegion` fail
  closed): `quote`, `payment-session` (bind once), `payment-status`.
- `apps/tenant-api/src/routes/operator-orders.ts` (`/operator/orders`): operator
  JWT (`TENANT_OPERATOR_TOKEN`, audience `tenant-api-operator`, issuer
  `brand.shortName`, `role: 'operator'`, scope `orders:read|orders:write`),
  region/provision check, `private, no-store`. `GET /`, `GET /:id`,
  `PATCH /:id { status, markPaid? }`.

**Service: `apps/tenant-api/src/services/order-service.ts`.**

- `runExclusive(orgId, fn)` (`:77-91`): in-process per-org promise chain
  (Durable Objects are already single threaded; on Node it serializes writers),
  plus `retryOnSqliteBusy` (`apps/tenant-api/src/lib/sqlite-retry.ts`).
- Capability tokens (`:98-125`):
  `deriveReceiptToken = hmacHash('restaurant-receipt:'+orgId+':'+orderId)` and
  `derivePaymentToken` (HMAC with `AUTH_HMAC_SECRET`), deterministic so
  idempotent replays return the same token; only SHA-256 hashes stored
  (`receipt_token_hash`, `payment_token_hash`); verified with
  `timingSafeEqualString`.
- Idempotency (`:457-498`): `idempotencyKey` (UUID from browser, per checkout
  attempt) is unique; `requestHash = sha256(canonicalOrderRequest(request))`;
  replay with same hash returns `200` + same tokens; different hash is
  `409 idempotency_conflict`. Checked before and inside the transaction.
- Holds with expiry (`:202-232`): `expireHolds(tx, now)` flips lapsed online
  orders (`status accepted`, `paymentStatus pending`, `holdExpiresAt < now`) to
  `expired`. Runs **inside** every write transaction and before every read
  (`sweepExpiredHolds`). Hold length: drop `checkoutHoldMinutes` clamped 1-120,
  default 10 (`RESTAURANT_ONLINE_HOLD_MINUTES`).
- Capacity in one transaction (`:500-608`): after the sweep,
  `assertSlotCapacity` counts active orders for `(pickupWindowId, pickupTime)`
  against `maxOrdersPerSlot`; `assertEntityCapacity` sums
  `restaurant_order_reservations.quantity` joined to active orders for inventory
  and per-slot caps; then inserts the order and its reservation rows. Released
  capacity is implicit: rows only count while the order status is in
  `RESTAURANT_ACTIVE_ORDER_STATUSES`.
- Order numbers: per-UTC-day sequence `YYYYMMDD-NNNN` with unique-constraint
  retries.
- Payment events (`applyPaymentEvent`, `:700-900`): session id, processor,
  amount and currency must match the bound order; duplicates idempotent;
  terminal states never regress; a late `paid` on an expired/cancelled order
  goes to `payment_review` rather than resurrecting capacity.
- Status machine (`OPERATOR_STATUS_TRANSITIONS`, `:906-915`):
  `accepted → preparing|ready|completed|cancelled`,
  `preparing → ready|completed|cancelled`, `ready → completed|cancelled`,
  `payment_review → preparing|ready|completed|cancelled`;
  `completed|cancelled|expired` terminal. `markPaid` only for handoff orders.
- Serializers: `publicOrderSummary`, `receiptOrder`, `operatorOrder`.

**Tenant DB tables:** `restaurant_orders` and `restaurant_order_reservations`
(`packages/tenant-db/src/schema.ts:629-790`, migration
`packages/tenant-db/drizzle/0011_restaurant_orders.sql`). Note the existing
table name `restaurant_order_reservations` (capacity rows), so a new
reservations table needs a distinct name (for example `table_reservations` or
`bookings`).

**Operator UI and "real time".**
`apps/app/app/routes/_app+/$orgSlug_+/menu+/orders._index.tsx` polls every 15 s
(`window.setInterval(..., 15000)` at `:171-174`). Credentials come from
`apps/app/app/routes/_app+/$orgSlug_+/orders-token.ts` (menu read or write
permission → `getOperatorTenantClient` in
`apps/app/app/utils/tenant-api.server.ts`, 15 min JWT) and are cached client
side for 10 min by `apps/app/app/hooks/use-orders-client.ts`, which calls the
regional `/operator/orders` directly. No order data transits App SSR.

Existing push channels, none regional:

- App SSE `apps/app/app/routes/api+/notifications+/stream.tsx` (polls the
  control-plane `Notification` table every 3 s, keep-alive 30 s). Control-plane
  only, so ids and counts only, never PII.
- App Durable Object WebSockets `apps/app/workers/chat-org.ts` (`ChatOrg`,
  hibernation API) for team chat. US control plane only.
- Tenant-api Durable Object `apps/tenant-api/workers/tenant-org.ts`
  (`TenantOrg`, one per org) has no WebSocket handling today; the OCI Node
  runtime has none either.

For a live host-stand view, the pragmatic options are: (a) short polling of a
regional `/operator/reservations` endpoint (same as orders, maybe 5-10 s with
`since` cursors), optionally nudged by a generic control-plane notification
("reservation changed", ids only) through the existing SSE stream; or (b) add
WebSocket support in `TenantOrg` (US Workers) plus an SSE/WebSocket on the KSA
Node runtime. (b) is new infrastructure in two runtimes.

---

## 3. Scheduled drops, pickup windows, slots and time zone helpers

- Drops (control plane): `OrganizationDrop`, `OrganizationDropPickupWindow`
  (`date`, `startTime`, `endTime`, `slotIntervalMinutes` default 30,
  `maxOrdersPerSlot`, `orderLeadTimeMinutes`), `OrganizationDropInventory`,
  `OrganizationDropReminder` (`packages/database/src/schema.ts:3265-3420`).
  Admin UI: `apps/app/app/routes/_app+/$orgSlug_+/menu+/drops.*.tsx`.
- Slot generation: `generatePickupSlots(start, end, interval)` in
  `packages/common/src/menu-types.ts:669-706` (minutes math, a slot must fit
  entirely before end; returns `{ time: 'HH:MM', displayTime }`). The pricer
  regenerates slots server-side and never trusts the client list
  (`restaurant-orders.ts:1906-1925`).
- Lead time check: `localDateAndTimeToUtc(window.date, pickup.time, tz)` then
  `slotStart < now + lead` → `422 lead_time` (`restaurant-orders.ts:1926-1937`).
- Per-window capacity: `maxOrdersPerSlot` counted transactionally (section 2).
- Scheduled (non-drop) orders: `validateScheduledFor`
  (`restaurant-orders.ts:1195-1244`) checks `scheduling.scheduledOrdersEnabled`,
  `prepTime` minus a 5 min grace, `advanceOrderDays`, and
  `isLocationOpenForOrdering(location, when)`.
- Open/closed: `isLocationOpenForOrdering` in
  `packages/common/src/location-availability.ts:43-218` (special hours first,
  then `onlineHours || storeHours`, closing-soon within 30 min, overnight
  continuation). Uses `Intl.DateTimeFormat` with the location zone.

Time conversion helpers (three implementations exist):

| Helper                                                                                                                       | Path                                                                | Quality                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `zonedLocalToUtc`, `localParts`, `tzOffsetMs`, `addDays`, `dayOfWeek`, `businessDateOf`, `businessDayStartMs`, `daysBetween` | `packages/staffing/src/tz.ts` (exported from `@repo/staffing` root) | Best. Dependency-free, epoch ms, documented DST rules: spring-forward gap resolves to just after the gap; fall-back ambiguity resolves to the earlier instant. Tested in `tz.test.ts`. Also `isValidTimeZone` in `packages/staffing/src/schemas.ts:21`. |
| `zonedTimeToUtc`, `zonedParts`, `buildScheduleDays`                                                                          | `apps/sites/src/lib/ordering/schedule.ts:93-160`                    | Two-pass, good enough for browser slot pickers; Sites-only.                                                                                                                                                                                             |
| `localDateAndTimeToUtc`, `addLocalDays`                                                                                      | `packages/common/src/location-availability.ts:20,268-294`           | Single-pass offset correction; can be off by the DST delta for times near a transition. Used by drops lead-time today.                                                                                                                                  |

Recommendation: build reservation slot math on `@repo/staffing` `tz.ts`
semantics. Because `@repo/staffing` is a staff-domain package, either import it
deliberately or move `tz.ts` into a neutral package (e.g. `@repo/common/tz`) and
re-export from staffing; do not add a fourth implementation. Store booking times
as epoch ms plus `local_date` (`YYYY-MM-DD`) and minutes, the same convention
the staffing tables use (`packages/tenant-db/src/schema.ts:1951` area comment:
`*_at` epoch ms, `*_date` local date).

Other reusable time pieces on Sites: `apps/sites/src/lib/ordering/calendar.ts`
(`buildIcsDataUrl` "Add to calendar"), `countdown.ts`, `hold-timer.ts`,
`apps/sites/src/lib/menu-hours.ts` (`summarizeHours`).

---

## 4. Payments

**Hosted checkout for orders (App).**

- Browser → Sites `POST /api/orders/payment`
  (`apps/sites/src/pages/api/orders/payment.ts` → `forwardPaymentReference`,
  opaque `orderId` + `paymentToken` only) → App
  `POST /resources/sites/order/checkout`
  (`apps/app/app/routes/resources+/sites.order.checkout.ts`, strict body).
- `createRestaurantOrderHostedCheckout` in
  `apps/app/app/utils/restaurant-orders/checkout.server.ts:324-484`: resolve
  processor (`resolveRestaurantOnlinePayment` in `payment-config.server.ts`:
  Stripe Connect US only, Checkout.com any region, Polar never), check platform
  secrets (`isProcessorConfigured`), regional quote (`/api/orders/quote`),
  recover a bound session instead of creating a second, create the hosted
  session with fixed product name `Restaurant order`
  (`RESTAURANT_ORDER_PRODUCT_NAME`), metadata
  `{ type: 'restaurant_order', orgId, orderId }`
  (`buildRestaurantOrderMetadata`), deterministic Stripe idempotency key
  (`buildRestaurantOrderSessionIdempotencyKey`), Stripe `expires_at` from the
  hold (min 30 min), Checkout.com `reference` and billing country from currency,
  then bind once regionally; on bind conflict expire the new session and recover
  the winner.
- Status poll: `POST /resources/sites/order/status` (trusted Stripe session
  lookup, pushes terminal state regionally).
- Webhooks: Stripe `apps/app/app/routes/api+/stripe+/webhook.tsx`
  (`checkout.session.completed|async_payment_succeeded|async_payment_failed|expired`),
  Checkout.com `apps/app/app/routes/api+/shop+/webhook.tsx`; dispatched by
  metadata type in
  `apps/app/app/utils/restaurant-orders/payment-webhooks.server.ts` →
  `notifyRestaurantOrderPaymentStatus` (`regional-order-api.server.ts`).
  Permanent regional rejections are acked; transient ones bubble so the provider
  retries. Mapping helpers in `packages/payments/src/shop/restaurant.ts`.

**SetupIntents / saved cards / manual capture.**

- No SetupIntent, no `capture_method: 'manual'`, no Checkout `mode: 'setup'`, no
  auth-then-capture, no off-session charge, and no refunds API anywhere in
  `packages/payments` (refunds only exist for duplicate SaaS subscriptions,
  `packages/payments/src/utils/duplicate-subscriptions.ts`). Checkout.com uses
  `paymentSessions.request` (hosted) with default capture
  (`packages/payments/src/connect/checkout-shop.ts:181`).
- The single-product **shop** flow (US only) has inline Stripe Elements with
  `setup_future_usage: 'off_session'` (`createShopPaymentIntent` in
  `packages/payments/src/connect/stripe-connect.ts:148-176`,
  `createInlineCardPayment` in
  `packages/payments/src/shop/commerce.ts:529-556`), a Stripe platform customer,
  and card snapshots in tenant table `customer_payment_methods`
  (`packages/tenant-db/src/schema.ts:501-525`). But
  `apps/app/app/utils/shop.server.ts` opens the tenant DB from App
  (`getTenantDb` at `:563`, `:594`, `:621`, `:651`), which conflicts with
  `docs/tenant-data-residency.md` ("App never reads or writes that table"). It
  is a legacy US-only path; do not copy it for reservations.
- Implication: a **prepaid deposit** can reuse the order hosted-checkout pattern
  almost verbatim (new metadata type, e.g. `reservation_deposit`,
  quote/bind/status endpoints in tenant-api). A **no-show card guarantee**
  (SetupIntent / Checkout `mode: 'setup'` on the connected account, later
  off-session charge) or **auth-hold** needs new code in `packages/payments`,
  new webhook event types (`setup_intent.succeeded`,
  `checkout.session.completed` with `mode=setup`), and a regional record of an
  opaque payment-method reference. KSA: Stripe Connect fails closed; only
  Checkout.com could serve SAR deposits, and its card-on-file/auth flows are not
  implemented.

**Local credentials (presence only).** Schema: `apps/app/.env.schema`
(STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET, POLAR_*,
CHECKOUT_SECRET_KEY, CHECKOUT_PUBLIC_KEY, CHECKOUT_SUBDOMAIN,
CHECKOUT_PROCESSING_CHANNEL_ID, CHECKOUT_ENVIRONMENT, CHECKOUT_WEBHOOK_SECRET).
Files present: `apps/app/.env`, `apps/app/.env.development`,
`apps/app/.env.test`, `apps/app/.dev.vars`; `apps/tenant-api` has only
`.env.example`, `.dev.vars.example`, `.env.schema`; `apps/sites` has
`.env.schema`; `packages/payments/.env.schema`. In `apps/app/.dev.vars`: Stripe
secret, publishable and webhook keys are present but **placeholder/mock-like
values**; Checkout.com keys absent; Polar token absent; `MOCKS` set;
`INTERNAL_COMMAND_TOKEN`, `TENANT_OPERATOR_TOKEN`, `TENANT_API_URL`,
`TENANT_API_URL_KSA`, `EMAIL_PROVIDER` present. Stripe is mocked with MSW in
`apps/app/tests/mocks/stripe.ts`. No real processor credentials locally.

---

## 5. Customer identity

- Table `customers` (`packages/tenant-db/src/schema.ts:22-46`): `id`, `name`,
  `email`, `phone` (unique), `phoneVerified`, OTP hash + expiry, legacy refresh
  hash, `stripeCustomerId`. `customer_refresh_tokens` (rotation + reuse
  detection), `customer_subscriptions` (consent per topic/channel; topics enum
  currently `['drops']`, channels `['sms']`, sources enum).
- `apps/tenant-api/src/routes/auth.ts`: `POST /auth/send-code` (per-IP 5/10 min,
  per org+phone 3/10 min, global send cap, 6-digit code HMAC-hashed, 10 min
  expiry, creates a blank-name customer on first send), `POST /auth/verify`
  (atomic consume, issues 15 min HS256 access JWT
  `{customerId, orgId, name, orgSlug, customDomain, type:'access'}`, issuer
  `brand.slug`, audience `tenant-api`, plus 30-day refresh token; fires
  `phone_verified` journey trigger), `/auth/refresh` (rotation), `/auth/logout`,
  `/auth/profile` (name/email; fires `profile_completed`), `GET /auth/me`.
  `authenticateCustomer(c)` (`:281-336`) is the reusable guard (fails closed if
  the org is inactive or moved region).
- Sites: tokens in `localStorage` (`tenant_access_token`,
  `tenant_refresh_token`) via `apps/sites/src/lib/client-auth.ts` (`tenantFetch`
  auto-refresh, `getOrgBinding`, `getBrowserTenantApiUrl`). Pages:
  `login.astro`, `verify.astro`, `complete-name.astro`, `profile.astro`,
  `profile/orders.astro`. The orders history page only lists **shop** orders
  (`apps/sites/src/scripts/profile-shop-data.ts` calls `/shop/orders`,
  `/shop/payment-methods`); there is no "my restaurant orders" endpoint.
- Restaurant orders attach to a customer only when a valid customer JWT is sent
  (`restaurant_orders.customer_id`, nullable, `ON DELETE SET NULL`); guests
  checkout with contact fields and a receipt capability token.
- Operator CRM: App `apps/app/app/routes/_app+/$orgSlug_+/customers.tsx` calls
  regional `GET /operator/customers` and `PATCH /operator/customers/:id`
  (`apps/tenant-api/src/routes/operator.ts:97,149`) browser-direct.

**Reservation attachment model (recommended).** Mirror orders: guest booking
with name/phone/email plus a derived manage-booking capability token (HMAC like
`deriveReceiptToken`, hash stored), optional customer JWT binding
(`optionalCustomerId` pattern). For a guest CRM, add a regional `guest_profiles`
(or extend `customers`) keyed by normalized phone with visit counts, notes,
tags, allergies; link reservations by `guest_id` and optionally `customer_id`.
Do not auto-merge an unverified guest phone into a verified customer without
OTP; a phone typed by a guest is not proof of identity (same reasoning as voice
caller ID in `apps/voice-agent/src/services.ts:328-331`). A "manage my booking"
link should use a token in the URL fragment (like `#order=` voice handoff and
`/my-schedule`) so it never reaches a server log.

---

## 6. Sites (`apps/sites`, Astro 7, Cloudflare adapter, `output: 'server'`)

- Structure: `src/pages` (`[...slug].astro` CMS pages, `index.astro`,
  `menu.astro`, `menu/checkout.astro`, `menu/success.astro`, `drops.astro`,
  `drop/[slug].astro`, `careers/index.astro`, `careers/[slug].astro`,
  `shop*.astro`, auth/profile pages, `pages/api/*` server endpoints),
  `src/components/blocks/*` (rendered by `RenderBlocks.astro`),
  `src/components/ordering/*`, `src/lib/ordering/*`, `src/lib/careers/*`.
- Middleware `apps/sites/src/middleware.ts`: resolves org from host
  (`resolveHost`: slug subdomain or custom domain), fetches the published org
  from App (`/resources/sites`), resolves locale (`resolveSiteLocaleRequest`:
  redirect, rewrite, or 404 for disabled locales), applies tenant redirects,
  preloads the CMS page for non-app routes (`isSitesAppRoute`), edge HTML cache
  (`shouldCachePublishedHtml`, `max-age=60, swr=300`), explicit `no-store` for
  drop visibility and careers pages.
- App route registry: `apps/sites/src/lib/site-headers.ts:99-130`
  (`APP_ROUTE_SLUGS` = login, verify, complete-name, profile, shop, menu; plus
  `isSitesMenuRoute`, `isSitesShopRoute`, `isSitesCareersRoute`). A new
  `/reserve` (or `/reservations`) route must be added here, and to
  `shouldCachePublishedHtml`/a `no-store` rule because availability changes.
  Also add to `SITE_LINK_RESERVED_PATHS` (`packages/common/src/site-link.ts:65`)
  if CMS pages must not collide.
- Tenant-api URL injection: `apps/sites/src/lib/tenant-api.ts`
  (`getTenantApiUrl(dataRegion)` picks `TENANT_API_URL_KSA` for KSA), rendered
  as `data-tenant-api-url` on `<html>` in
  `apps/sites/src/layouts/SiteLayout.astro:92` (passed by `SitePage.astro:122`)
  and read by `getBrowserTenantApiUrl()`. CSP `connect-src` allows App, US and
  KSA tenant-api (`middleware.ts:47-66`).
- i18n: six content locales `en, ar, es, fr, de, zh`
  (`packages/common/src/site-locales.ts`), RTL for `ar`, locale-prefixed URLs
  for non-default locales (`/ar/menu`), Lingui `msg` extracted with
  `npm run lingui:extract -w sites` into `src/locales/*.po`; ordering surfaces
  require non-empty translations in all locales (`docs/sites-ordering-ux.md`
  section 8). Labels are passed to client scripts via JSON label blocks
  (`OrderingLabels.astro`). Locale links: `getLocaleHref`, `siteLocaleHref`,
  `browserLocaleHref`.
- Turnstile: `PUBLIC_TURNSTILE_SITE_KEY` (empty disables), widget `data-action`
  per form (`website-form`, `careers-apply`, `place-order`); server-side
  verification in tenant-api with `verifyTurnstileToken` and
  `TURNSTILE_HOSTNAMES` (`packages/common/src/turnstile.server.ts`).
- Ordering pages: one ordering engine (`src/lib/ordering/*`), browser calls
  `POST {tenantApi}/orders`, receipts in `sessionStorage`, payment handoff via
  Sites `/api/orders/payment*` with opaque references only.
- Careers: `pages/careers/index.astro` fetches public postings from App
  `/resources/sites/careers` (null when `staffing.hiring` off → falls back to a
  CMS page named `careers` or 404); `components/careers/ApplyPanel.astro` posts
  browser-direct to `POST {tenantApi}/careers/apply` with Turnstile + honeypot.
- Blocks: `FormBlock.astro` is the closest analog for an embeddable widget: SSR
  fetches only the public **definition** from tenant-api (3 s timeout, cached),
  and the browser posts submissions straight to tenant-api with Turnstile and a
  honeypot.

**How to add Reservations.** Both:

1. A dedicated route `pages/reserve.astro` (plus `reserve/manage.astro` for
   view/cancel via fragment token) that is flag-gated like careers: SSR asks App
   for a non-PII public payload (location list, party size limits, booking
   window, policy text); availability and booking calls go browser → regional
   tenant-api.
2. A `reservation` block (`components/blocks/ReservationBlock.astro`) that
   renders a compact party/date/time picker and either links to `/reserve` with
   query params or mounts the same client module inline. Register it in
   `RenderBlocks.astro`.

---

## 7. Website builder in the App

- Block registry: `apps/app/app/utils/website/block-types.ts` (`BLOCK_TYPES`
  with `label`, `icon`, `description`, `defaultConfig`, `locked`; header/footer
  are locked site chrome). Localized fields per block in `LOCALIZED_FIELDS`
  (`:377-406`). Templates in `PAGE_TEMPLATES`.
- Editor/inspector:
  `apps/app/app/routes/_app+/$orgSlug_+/website+/pages.$pageId.tsx` has per-type
  preview and inspector switches (`case 'form':` at `:2115` and `:2825`). Link
  editing: `apps/app/app/components/website/link-inspector.tsx` with the
  `SiteLink` model (`packages/common/src/site-link.ts`: types `url`, `page`,
  `email`, `phone`, `file`; there is no "app route" link type, so `/menu` or
  `/careers` are entered as plain URLs).
- Storage/publish: `WebsitePage` + `WebsitePageSection` (`type`, JSON `config`,
  `position`), published snapshot in `WebsitePage.publishedData`, served by
  `apps/app/app/utils/sites/public-org.server.ts` (`:396-480`), Sites KV cache
  purge via `purgeOrganizationSiteCache`.
- Navigation/CTAs: header `navLinks`, `ctaLabel`, `ctaUrl` and footer columns
  are operator-edited block configs (stored in `Organization.siteHeaderConfig` /
  `siteFooterConfig`); `apps/sites/src/components/SiteHeader.astro` renders
  `config.navLinks`. Nothing auto-injects Menu or Careers links.
- To add "Book a table": a `reservation` entry in `BLOCK_TYPES` (config:
  `locationId` or `all`, `heading`, `buttonLabel`, `defaultPartySize`,
  `layout: inline|button`), `LOCALIZED_FIELDS`, an inspector + preview case in
  `pages.$pageId.tsx`, the Sites renderer, and tests (`block-types.test.ts`).
  For CTAs, either keep plain `/reserve` URLs or add a `route` link type (with
  menu/careers/reserve) to `SiteLink`, which touches both App and Sites.

---

## 8. Customer notifications

- **Order confirmations: none exist.** `docs/restaurant-ordering-launch.md`
  "Known limits": no SMS/email order confirmation; the receipt page is the
  record. So reservations confirmations/reminders are net new.
- Email from tenant-api: `apps/tenant-api/src/lib/tenant-email.ts`
  (`sendTenantEmail` → `@repo/email` `sendOciEmail`, OCI Email Delivery, adds
  marketing headers only when a campaign/journey context is passed). Used by
  journeys, hiring (`apps/tenant-api/src/lib/applicant-email.ts`), staff tick
  (`apps/tenant-api/src/lib/staff-email.ts`), operator campaigns, voice.
  Operational templates are plain HTML strings with escaped values and a shared
  `layout` (no React inside Durable Objects); only `en`/`ar` today in
  staff/applicant mail.
- Dev behavior (`packages/email/src/oci/send-oci-email.ts:36-63`,
  `mock-transport.ts`): `MOCKS=true` posts to an MSW-intercepted URL; no OCI
  config in non-production logs `[OCI EMAIL MOCK] To: ... | Subject: ...` and
  returns `skipped`; production without config returns an error.
- SMS: `@repo/sms` `sendSms` (`packages/sms/src/index.ts`): without Twilio
  credentials logs `[SMS MOCK] To: ... | Message: ...` (throws in production);
  in production on `DATA_REGION=ksa` Twilio is blocked. So SMS reminders are US
  only until an in-kingdom provider exists.
- Branded marketing email (React Email + org theme) is rendered at design time
  in App (`@repo/email/marketing`, `packages/common/src/email-theme.ts`); the
  regional side only interpolates merge tags. For transactional reservation
  email, follow the staff/applicant plain-HTML pattern, or pre-render a branded
  template in App and store it regionally like journey email bodies.
- Kill-switch precedent: `apps/tenant-api/src/lib/email-switch.ts`
  (`STAFFING_EMAIL_ENABLED`), suggests a `RESERVATIONS_EMAIL_ENABLED` /
  `RESERVATIONS_SMS_ENABLED` per node.
- Scheduling reminders: the staff outbox `notification_outbox`
  (`packages/tenant-db/src/schema.ts:1815-1840`) is staff specific (`staff_id`
  not null), but its shape (dedupe key, attempts, next attempt, status) is the
  pattern to copy for a guest notification outbox.

---

## 9. AI phone agent

- Restaurant vertical already defines reservations as **request capture only**:
  call purpose `reservation`, request type `reservation`
  (`packages/phone-agent-restaurant/src/definitions.ts:9-25`), FAQ category
  `reservations` with questions like `reservations_accepted`,
  `reservation_advance` (`:73`, `:211-230`), purpose inference regex
  `/reserv|book|table/i` (`vertical.ts:43,61`), and the prompt task:
  "Reservations: collect the party size, date, time, and a name, then save it
  with record_request. Make clear it is a request and the team will confirm it."
  (`packages/phone-agent-restaurant/src/prompt.ts:66`).
- Storage: `record_request` (worker tool in `apps/voice-agent/src/tools.ts:202`)
  → tenant-api `POST /api/voice/requests` → `voice_call_requests` (`type`,
  `status open|done`, `callerName`, `callerPhone`, `details` JSON) shown in App
  under phone calls (`GET/PATCH /operator/calls/requests`).
- Restaurant tools today (`packages/phone-agent-restaurant/src/tools.ts`):
  `search_menu`, `get_menu_item`, `list_menu_categories`, `get_order`,
  `add_to_order`, `update_order_line`, `suggest_add_ons`, `send_order_link`. No
  availability or booking tool.
- Link handoff (`docs/phone-agent-verticals.md`):
  `services.sendLink({ path, payload, phone })` stores a payload and texts
  `site/path#token`; Sites reads it
  (`apps/sites/src/scripts/voice-order-handoff.ts`,
  `GET /voice/handoffs/:token`).
- Region: the voice worker is US only and posts to `ENV.TENANT_API_URL`
  (`apps/voice-agent/src/services.ts:319-326`).

Integration needs: vertical tools
`check_table_availability({ date, time, partySize })` and `book_table(...)` (or
`send_booking_link` with a prefilled payload to `/reserve`), executed through
new `/api/voice/*` system routes authenticated with `VOICE_AGENT_TOKEN`; the
vertical `data` built in App (`restaurantConfigParts`,
`apps/app/app/utils/phone-agent/*`) must carry the reservation config; keep
words like "reservation"/"table" in the restaurant package (core vocabulary test
`packages/phone-agent/src/vocabulary.test.ts` rejects `/reserv/i`). Caller ID
must not identify a guest profile. Gate tools behind the reservations flag so
the existing "request" path stays the fallback.

---

## 10. Native and operator mobile apps

- `apps/ios` (SwiftUI, `TenantKit`): branded shell, phone OTP sign-in, profile,
  Keychain session (`AuthViews.swift`, `ProfileView.swift`,
  `TenantAPIClient.swift`, `SiteTheme*.swift`). No ordering, no staffing.
- `apps/android` (Kotlin, framework views only, size budget): same feature set
  (`Screens.kt`, `ProfileScreen.kt`, `TenantApiClient.kt`,
  `KeystoreTokenStorage.kt`). No ordering, no staffing.
- `apps/mobile` (Expo, operator app): auth (sign in/up, verify, onboarding),
  organizations list/create, settings (profile, security). No orders, menu,
  staffing or phone-agent screens.

Conclusion: none of the native apps has commerce surfaces; reservations there
would be greenfield. Recommend leaving native apps out of this mission (the
mobile web booking flow on Sites covers customers; the App web covers hosts).

---

## 11. Marketing and journeys

- Trigger types are a fixed enum on `marketing_journeys.trigger_type`:
  `phone_verified | profile_completed | custom_event | manual`
  (`packages/tenant-db/src/schema.ts:137-142`; the SQL column has no CHECK
  constraint, so adding values is a TypeScript change plus UI labels).
- Trigger evaluation:
  `evaluateAndSpawnTriggers(orgId, triggerType, customerId, tenantApiUrl?, contextData)`
  in `apps/tenant-api/src/services/journey-service.ts:929`, called
  fire-and-forget from `auth.ts` on verify and profile update. Requires a
  `customerId`, so guest bookings without a customer row cannot enter journeys.
- UI labels/palette: `packages/marketing-workflow/src/workflow-labels.ts`
  (`TENANT_TRIGGER_MSGS`), `serialization.ts`.
- Reservation events (`reservation_booked`, `reservation_completed`/"visited",
  `reservation_no_show`, `reservation_cancelled`) can plug in by adding trigger
  types and calling `evaluateAndSpawnTriggers` from the reservation service,
  with `contextData` limited to ids, party size, local date. Marketing sends
  need explicit consent (`customer_subscriptions` topics enum would need a
  reservations topic). Segments do not exist as a first-class model; the
  customers list is client-side filtered.

---

## 12. Reviews and Google integrations

- `docs/reviews-integrations.md`: location-scoped review providers (GBP, Yelp,
  TripAdvisor, Deliveroo, Just Eat, **OpenTable**, **Resy**) in
  `@repo/integrations` (`unified-reviews.ts`), reviews only; replies via API or
  deep links, shown in Mailbox → Reviews.
- `docs/google-business-profile.md`: GBP import of name, address, phone, hours
  into a Menuza location; read-only toward Google ("Menuza does not write
  changes back to Google"); full listing retained in integration config.
- No "Reserve with Google" / Actions Center / booking feed hook exists. The
  OpenTable/Resy providers are review-only. A future Reserve-with-Google
  integration would need a booking server API (availability + booking feeds) and
  partner onboarding; out of scope, but keep reservation availability behind a
  clean service so a feed could be added later. A "Book" place action link
  pointing at `/reserve` on the org site is the cheap first step (GBP write
  access would be new).

---

## Reuse opportunities

| Need                                      | Reuse                                                                                                                                                                                     | Path                                                                                                                                                       |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Location hours, zone, special closures    | `OrganizationLocation` JSON shapes, `publicLocationContextSchema`, `isLocationOpenForOrdering`                                                                                            | `packages/common/src/location-types.ts`, `packages/common/src/restaurant-orders.ts:599-721`, `packages/common/src/location-availability.ts`                |
| Local time ↔ instant, DST                 | `zonedLocalToUtc`, `localParts`, `addDays`, `dayOfWeek`, `isValidTimeZone`                                                                                                                | `packages/staffing/src/tz.ts`, `packages/staffing/src/schemas.ts:21`                                                                                       |
| Slot grid                                 | `generatePickupSlots` (interval slots)                                                                                                                                                    | `packages/common/src/menu-types.ts:669`                                                                                                                    |
| Control-plane context fetch               | `fetchOrderContext` (fresh, fail closed) and `scope-context.ts` (cached, stale-tolerant, cooldown)                                                                                        | `apps/tenant-api/src/services/order-service.ts:137`, `apps/tenant-api/src/lib/scope-context.ts`                                                            |
| Internal route guard                      | `requireInternalCommandAuth` + 302→403                                                                                                                                                    | `apps/app/app/routes/resources+/order-context.ts`                                                                                                          |
| Browser org binding                       | `resolveOrderingOrganization` / `resolveOrganizationForBrowserAuth` (Origin + slug/host, region)                                                                                          | `apps/tenant-api/src/routes/orders.ts:76`, `apps/tenant-api/src/lib/origin.ts:306`                                                                         |
| Optional customer binding                 | `optionalCustomerId`, `authenticateCustomer`                                                                                                                                              | `apps/tenant-api/src/routes/orders.ts:112`, `apps/tenant-api/src/routes/auth.ts:281`                                                                       |
| Idempotency                               | `idempotencyKey` unique + `requestHash` replay/409                                                                                                                                        | `order-service.ts:457-498`, `canonicalOrderRequest` in `restaurant-orders.ts:367`                                                                          |
| Capability tokens                         | `deriveReceiptToken`/`verifyReceiptToken` (HMAC, hash stored)                                                                                                                             | `order-service.ts:98-125`, `apps/tenant-api/src/lib/secrets.ts` (`hmacHash`, `timingSafeEqualString`)                                                      |
| Hold + capacity in one transaction        | `runExclusive` + `retryOnSqliteBusy` + in-tx `expireHolds` + count active rows                                                                                                            | `order-service.ts:77-91,202-330,500-608`, `apps/tenant-api/src/lib/sqlite-retry.ts`                                                                        |
| Monotonic payment events, late-pay review | `bindPaymentSession`, `applyPaymentEvent`                                                                                                                                                 | `order-service.ts:626-900`                                                                                                                                 |
| Hosted deposit checkout                   | `createRestaurantOrderHostedCheckout`, metadata/idempotency helpers, webhook dispatch                                                                                                     | `apps/app/app/utils/restaurant-orders/*`, `packages/payments/src/shop/restaurant.ts`                                                                       |
| Operator token + client                   | `getOperatorTenantClient`, `orders-token.ts`, `useOrdersClient`                                                                                                                           | `apps/app/app/utils/tenant-api.server.ts:64`, `apps/app/app/routes/_app+/$orgSlug_+/orders-token.ts`, `apps/app/app/hooks/use-orders-client.ts`            |
| Rate limits                               | `rateLimit`, `rateLimitByKey`, per-route gates                                                                                                                                            | `apps/tenant-api/src/lib/rate-limit.ts`, `apps/tenant-api/src/app.ts`                                                                                      |
| Turnstile                                 | `verifyTurnstileToken`, action names                                                                                                                                                      | `packages/common/src/turnstile.server.ts`, `orders.ts:56`                                                                                                  |
| Sites booking UI                          | ordering engine pieces: `calendar.ts` (.ics), `countdown.ts`, `hold-timer.ts`, `schedule.ts`, `order-client.ts`, `order-errors.ts`, `money.ts`, `pickup.ts` chips, `OrderingLabels.astro` | `apps/sites/src/lib/ordering/`, `apps/sites/src/components/ordering/`                                                                                      |
| Sites widget pattern                      | `FormBlock.astro`, `ApplyPanel.astro` (browser-direct, Turnstile, honeypot)                                                                                                               | `apps/sites/src/components/blocks/FormBlock.astro`, `apps/sites/src/components/careers/ApplyPanel.astro`                                                   |
| Flag-gated public page                    | careers (`/resources/sites/careers` null when off, CMS fallback)                                                                                                                          | `apps/sites/src/pages/careers/index.astro`, `apps/app/app/routes/resources+/sites.careers.ts`                                                              |
| Flags                                     | `getFeatureFlag`, `isFlagOn`, key constants pattern                                                                                                                                       | `packages/common/src/feature-flags.server.ts:26`, `packages/staffing/src/flags.ts`                                                                         |
| Notifications                             | `sendTenantEmail` (OCI, mock in dev), `sendSms` (US only), outbox shape, email kill switch, generic manager alert (`/resources/staffing/notify`)                                          | `apps/tenant-api/src/lib/tenant-email.ts`, `packages/sms/src/index.ts`, `packages/tenant-db/src/schema.ts:1815`, `apps/tenant-api/src/lib/email-switch.ts` |
| Reminders timing                          | hourly cron fan-out + `TenantOrg` alarm + Node interval                                                                                                                                   | `apps/tenant-api/src/lib/staff-alarm.ts`, `apps/tenant-api/workers/tenant-org.ts`, `docs/scheduled-jobs.md`                                                |
| Demand for staffing                       | `registerOrderSource` (counts only)                                                                                                                                                       | `apps/tenant-api/src/services/order-source.ts`, `apps/tenant-api/src/restaurant/staffing-order-source.ts`                                                  |
| Phone agent                               | link handoff, `record_request`, vertical tools contract                                                                                                                                   | `packages/phone-agent/src/vertical.ts`, `packages/phone-agent-restaurant/src/tools.ts`, `apps/tenant-api/src/routes/voice.ts`                              |

## Integration points a reservations module must touch

Control plane (App, `@repo/database`):

- `packages/database/src/schema.ts`: per-location reservation settings (either
  new columns/JSON on `OrganizationLocation` or a new
  `OrganizationReservationSettings`/floor-plan tables if floor plans are treated
  as non-PII config). Migration via `drizzle-kit generate`.
- Flags: new key constants (e.g. `reservations.enabled`,
  `reservations.deposits`, `reservations.waitlist`) read with `getFeatureFlag`;
  enforce at token mint and every loader/action.
- Permissions: `packages/database/setup-roles.ts` (new entity, e.g.
  `reservation`), role presets
  (`apps/app/app/routes/_app+/$orgSlug_+/settings+/roles.*`).
- Operator token scopes: extend `getOperatorTenantClient` scope union
  (`apps/app/app/utils/tenant-api.server.ts:68`) with `reservations:read|write`,
  plus a `reservations-token.ts` route like `orders-token.ts`.
- Internal context route: `apps/app/app/routes/resources+/` new
  `reservation-context.ts` (INTERNAL_COMMAND_TOKEN).
- Public Sites payload route: `apps/app/app/routes/resources+/sites.*` for the
  `/reserve` page (non-PII config, null when flag off).
- App UI: sidebar nav (`apps/app/app/components/app-sidebar.tsx`, computed nav
  access in `apps/app/app/root.tsx` like `staffingNav`), new route group under
  `apps/app/app/routes/_app+/$orgSlug_+/` (host stand, book, floor plan,
  settings), location settings (`settings+/locations.*`,
  `components/locations/*`).
- Website builder: `apps/app/app/utils/website/block-types.ts`,
  `apps/app/app/routes/_app+/$orgSlug_+/website+/pages.$pageId.tsx`, optionally
  `packages/common/src/site-link.ts`.
- Payments (if deposits): `packages/payments/src/shop/` new helper (metadata
  type, mapping), `apps/app/app/utils/restaurant-orders/`-style checkout +
  status + webhook dispatch, `api+/stripe+/webhook.tsx`,
  `api+/shop+/webhook.tsx`.
- Phone agent config: `apps/app/app/utils/phone-agent/*` (vertical data).

Regional (tenant-api, `@repo/tenant-db`):

- `packages/tenant-db/src/schema.ts` + new migration in
  `packages/tenant-db/drizzle/` (reservations, waitlist entries, guest
  profiles/notes, guest notification outbox; avoid the name
  `restaurant_order_reservations`). Durable Object migrations are generated
  (`apps/tenant-api/workers/migrations.generated.ts`).
- Routes in `apps/tenant-api/src/app.ts`: public `/reservations/*`
  (availability, create, get/cancel via capability), `/operator/reservations/*`,
  `/api/reservations/*` (deposit quote/bind/status), optional `/api/voice/*`
  additions; per-route rate limits.
- Services: availability engine, booking transaction, waitlist, reminders
  (hourly tick and alarms; `TenantOrg` has a single storage alarm currently
  owned by the staff tick).
- Journeys: `apps/tenant-api/src/services/journey-service.ts`, trigger enum in
  tenant schema, `packages/marketing-workflow/src/workflow-labels.ts`.
- Erasure/export and region-change wipe: include new tables wherever customer
  data is erased or exported (data-subject flows; `jobs.gdpr-erasure.ts` in App
  dispatches to regional erasure endpoints).

Sites:

- `apps/sites/src/pages/reserve*.astro`,
  `apps/sites/src/components/blocks/RenderBlocks.astro`
  - new block, `apps/sites/src/lib/site-headers.ts` (app routes, cache rules),
    `apps/sites/src/lib/org.ts` (public payload fetcher), new
    `src/lib/reservations/*` client module, locale catalogs `src/locales/*.po`
    for six locales.

## Risks and constraints

1. **Data residency.** Guest names, phones, emails, notes, allergies, party
   details tied to a person must live only in the regional tenant DB. Sites SSR
   must never fetch or render them (the manage-booking page is client-rendered
   from a fragment token). App may only see opaque ids and counts (payment
   metadata, manager alerts). Region change wipes the old DB; no migration.
2. **App currently touches tenant DB for the shop**
   (`apps/app/app/utils/shop.server.ts`); do not use it as a template.
3. **No per-request context caching for orders.** Availability grids hitting App
   on every call would add up to 5 s latency and load; use a cached context
   (scope-context pattern) for reads and a fresh fetch for booking.
4. **Concurrency.** `runExclusive` is in-process only; correctness on Node/OCI
   relies on one process per node and SQLite busy retries. Table assignment must
   use the same in-transaction "sweep then count then insert" approach to avoid
   double booking.
5. **Time zones.** The common `localDateAndTimeToUtc` is not DST-robust; use
   `@repo/staffing` `tz.ts` semantics and store local date + minutes + instant.
   The App UI renders in the operator browser zone via client hints, but host
   views must render in the location zone.
6. **Real time.** There is no regional push channel; host-stand freshness will
   be polling unless new WebSocket/SSE infrastructure is built in both the
   Workers DO and the Node runtime.
7. **Payments.** Card guarantees/no-show fees need SetupIntent or auth/capture
   support that does not exist; KSA has no Stripe; Checkout.com card-on-file is
   unimplemented; refunds are manual. A prepaid deposit via hosted checkout is
   the only low-risk option. Local Stripe keys are placeholders (MSW mocks).
8. **Notifications.** No transactional customer confirmations exist yet; SMS is
   US only (Twilio blocked for KSA production); email depends on OCI config
   (mocked in dev). Reminder timing is hourly unless an alarm drives it, and the
   `TenantOrg` storage alarm is a single slot used by the staff tick, so
   reminders must share it (multiplex) rather than overwrite it.
9. **Rate limits are in memory** (per isolate / per DO); booking abuse limits
   that must hold across restarts need DB-backed counters (as careers does).
10. **Phone agent.** Voice worker is US only; KSA orgs cannot book by phone.
    Caller ID is spoofable and must not authenticate a guest. Core vocabulary
    test forbids reservation words outside the restaurant package.
11. **Journeys require a `customerId`.** Guest bookings without a customer row
    cannot trigger journeys; marketing consent is per topic/channel and the
    topic enum only has `drops`.
12. **Sites caching.** Published HTML is edge-cached 60 s with SWR 300 s; any
    page showing availability must be `no-store` like careers/drops, and
    `isSitesAppRoute` must list the new routes so CMS page preloading is
    skipped.
13. **Naming collision.** `restaurant_order_reservations` already exists (drop
    capacity holds); `reservation` is also an existing phone-agent request type
    id (stored on calls; keep that id stable).
