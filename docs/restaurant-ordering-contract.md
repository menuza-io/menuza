# Regional restaurant ordering implementation contract

Customer information is sent only browser → regional tenant-api. App payment
routes accept opaque references, never customer contact fields or customer JWTs.

## Browser → regional API

`POST /orders` JSON:

```ts
{
  slug?: string
  host?: string
  idempotencyKey: string // UUID; per checkout attempt, reused for retries
  locale: string
  locationId: string
  dropSlug?: string
  pickup?: { windowId: string; time: string } // HH:MM in location timezone
  fulfillment: 'pickup' | 'delivery'
  paymentMethod: 'handoff' | 'online'
  contact: { name: string; phone: string; email?: string }
  delivery?: { address: string; city: string; unit?: string; notes?: string }
  tipPercent: number // legacy; see "Tips and the service fee"
  tip?: { percent: number } | { amountMinor: number } // instead of tipPercent
  expectedServiceFeeMinor?: number // the fee the page showed; missing reads as 0
  lines: Array<{
    itemId: string
    variantId?: string
    quantity: number
    instructions?: string
    options: Array<{ groupId: string; optionId: string; half?: 'whole' | 'left' | 'right'; quantity?: number }>
  }>
  // Optional loyalty reward picked by a signed-in member (customer token)
  loyalty?: { rewardId: string; rewardVersion: number; expectedDiscountMinor: number; targetLineId: string | null }
}
```

No browser prices are accepted. A `loyalty` selection is re-quoted in the region
and bound in the placement transaction; a changed reward, balance or cart is
refused with the loyalty error code, never applied silently
([loyalty.md](./loyalty.md#redemption)). Successful response:

```ts
{
  order: { id: string; number: string; status: string; paymentStatus: string;
    currency: string; subtotalCents: number; taxCents: number;
    deliveryFeeCents: number; tipCents: number;
    serviceFeeCents: number; serviceFeeTaxCents: number; // the fee before its tax; the tax is in taxCents
    serviceFeeLabel: string | null; // the name the guest saw
    loyaltyDiscountCents: number; // a reward's discount, off the subtotal before tax
    totalCents: number; holdExpiresAt: string | null }
  receiptToken: string
  paymentToken?: string // online only; capability to request an opaque quote
}
```

`GET /orders/:id?slug=...` with `Authorization: Bearer <receiptToken>` returns
the authoritative receipt including contact, priced lines and pickup summary. An
existing authenticated customer token is not a receipt capability.

### Tips and the service fee (#118, #123)

**Tip.** The body carries a share (`tipPercent` 0 to 30, or `tip: { percent }`)
or an exact amount (`tip: { amountMinor }`). Sending `tip` with a non-zero
`tipPercent` is a 400. A share is taken on the subtotal before discounts and
before tax (`docs/discounts-plan.md`, decision 2); an exact amount is charged as
it is and stored with a null `tip_percent`. Above the larger of half the
subtotal or the currency cap (`TIP_CAP_MAJOR` in `@repo/common/order-tips`: 200
USD, 750 SAR, 200 major units for any other currency) the answer is 422
`tip_too_large`. Tips switched off for the order type (`inHouseTips`) are still
422 `tips_disabled`. The same `tip` field is accepted by `POST /orders/tab/pay`
and `POST /loyalty/tab/quote`; the table tab also answers 422 `tips_disabled`
when the location's dine-in tips are off. The location's choices are
`OrganizationLocation.tipSettings` (`TipSettingsSchema` in
`@repo/common/location-types`: per `pickup`, `delivery` and `qrTab` up to four
choices, a default index or none, and whether Custom is shown). They reach the
page through `GET /orders/options` (`tipChoices`) and, for a table, the tab view
(`tipChoices`). The region does not require a guest to use one of the buttons:
only the cap and the switches are enforced.

**Service fee.** Flag `ordering.service_fee` (default off). The settings are
`OrganizationLocation.serviceFee` (`serviceFeeSettingsSchema` in
`@repo/common/service-fee`) and reach the region as
`context.serviceFee = { version: 1, locations: { [locationId]: settings } }`,
listing only locations whose fee is on. `computeServiceFee` prices it: a
percentage of the subtotal after discounts and rewards (before tax and tip,
never on the tip) plus a fixed amount, capped afterwards; below the small-order
limit the small-order fee is charged instead; nothing on a base of 0 (a free
order) or for an order type the fee does not cover. With `taxable`, tax follows
the location's rate: added on top when prices exclude tax, carved out of the fee
when they include it. Either way the fee's tax is part of `tax_cents`, so every
existing total still adds up
(`total = subtotal - discounts + tax (exclusive only) + tip + delivery - delivery discount + fee`).
The browser sends `expectedServiceFeeMinor`; a different amount is 409
`service_fee_changed` with `details: { serviceFeeMinor }` and nothing is placed.
A fee on but unreadable at this node (a settings value that does not parse, or a
`version` newer than the node knows) is 503 `service_fee_unavailable`: the
region refuses the order rather than place it without its fee. Nodes that
predate the fee refuse `tip` and `expectedServiceFeeMinor` (strict body), so
deploy tenant-api before Sites.

Rollout: a client that does not send `expectedServiceFeeMinor` (a cached Sites
page, an older build) is refused with 409 where a fee is due, and cannot act on
`details.serviceFeeMinor`. Deploy App, then tenant-api, then Sites, and turn
`ordering.service_fee` on for an organization only after Sites has shipped.
Customer and Station apps do not place these orders (the customer app opens the
website's checkout), so nothing else has to ship first. A table tab polls
`GET /orders/tab` every 20 seconds; the fee and tip view it adds is read through
the same 10-second shared cache as the tab's discounts, one fetch at a time per
location.

Placed orders keep what they were charged: `restaurant_orders.service_fee_cents`
(before tax), `service_fee_tax_cents`, `service_fee_label`; changing or turning
off the fee never rewrites them. A table round carries no fee: a tab pays it
when it is paid from the phone (`qr_tabs.payment_service_fee_*` while the
session is bound, `service_fee_*` once the tab closes). Counter closes and
Station sales have none.

**Refunds.** A full refund gives back everything refundable, the fee included. A
partial refund (`amountCents`) adds the fee that is left, on top of the amount,
only with `includeServiceFee: true` (fee plus its tax, or the fee alone when
prices include tax); the fee part is recorded in
`restaurant_order_refunds.service_fee_cents`, so it is never refunded twice.
Table-tab refunds have no separate tick (a full refund includes the fee).

**Reports.** The `orders` report has a Service fee measure (`serviceFee`), the
tab's fee riding on its latest round like the tab's discount.

### Checkout rules (#251, #257, #355, #408, #409, #422)

Six location and menu rules that shape one order. All of them reach the region
through the order context, all of them are checked again at placement (the page
is never trusted), and every field a browser sends is optional so an older
client keeps working. The strict order body refuses the new fields on an older
node, so deploy **App, then tenant-api, then Sites** (Station and the customer
app, which opens the website's checkout, follow).

`GET /orders/options` carries what a guest page needs, with older nodes simply
omitting it: `packagingFee` (the location's settings while the fee is on, else
null), `utensils` (`{ enabled, defaultRequested }` or null),
`pickupInstructions` (the text as the operator saved it, plain or a localized
JSON map; null on a drop, whose own pickup location and windows win),
`dineInMaxGuests` (see the size cap) and `dailyAvailability` (see daily limits).
The order and receipt carry `packagingFeeCents` / `packagingFeeTaxCents` /
`packagingFeeLabel`, `utensilsRequested`, `pickupInstructions` and
`largeOrderExtraMinutes`, the link receipt too (none of it is personal data).
`POST /orders/quote` carries `packagingFeeMinor`.

**Pickup instructions (#251).** `OrganizationLocation.pickupInstructions`, a
localized value like menu copy, at most 300 characters, plain text (escape it
everywhere, keep line breaks, never make links clickable). The order stores the
copy the guest saw (`restaurant_orders.pickup_instructions`, in the order's
language with the default as fallback), so editing the text never rewrites a
placed order. Pickup orders only; none for a drop order. Shown on the checkout
and confirmation pages and in the receipt, accepted, ready and changed-time
emails (never in a cancellation).

**Utensils (#257).**
`onlineOrderingSettings.utensils = { enabled, defaultRequested }`, reaching the
region as `context.utensils[locationId]`. `utensilsRequested` is read for pickup
and delivery only and ignored while the location does not ask; a missing answer
reads the default. Stored on the order (`utensils_requested`, nullable: null
means it was not asked), shown on the Kitchen ticket, the Orders detail, the
Station detail and the receipt email.

**Large orders (#355).** The rule is "more than N items or over AMOUNT, add M
minutes":
`onlineOrderingSettings.largeOrder = { itemThreshold, amountMinor, extraMinutes }`,
either threshold optional, whichever is reached first (a rule saved before keeps
working from the old location columns until it is saved again; saved but empty
means off). `largeOrder[locationId]` of the context is a `LargeOrderRule`
(`@repo/common/promised-time`: `itemThreshold`, `amountThresholdMinor`, plus the
old single `threshold` / `thresholdType` an older region reads). The item count
is dish quantities minus dishes and categories marked "Don't count toward order
limits" (#256), from one function: `buildOrderLimitCatalogFromMenus` +
`orderDishUnits`, used by placement, Sites and the per-item packaging fee, so
every channel computes the same `promisedAt`. The extra time is stored on the
order (`large_order_extra_minutes`) and shown as "Large order +N min". The phone
agent quotes only the location's base wait (it has no cart), and table rounds
are never affected.

**Order size cap (#422).** `OrganizationLocation.orderCaps`, per order type a
maximum item subtotal (before discounts and tips) and, for dine-in, a maximum
head count; it reaches the region as `context.orderCaps = { locations }`. An
order over the cap is 422 `order_too_large` with
`details: { kind: 'amount' | 'guests', fulfillment }`: the message points to
catering or the phone, or to a team member for a big table, and never names the
number. It is applied by the pricing engine, so the quote and placement both
refuse it (the quote endpoint itself answers 404 while the organization has no
discounts, so the checkout page may only learn it when placing). Station and
other walk-in sales are never refused. A table has no head count of its own, so
Sites asks "How many are at your table?" only where `dineInMaxGuests` is set and
sends `guestCount`.

**Packaging fee (#408).** Flag `ordering.packaging_fee` (default off).
`OrganizationLocation.packagingFee` (`packagingFeeSettingsSchema` in
`@repo/common/packaging-fee`): a fixed amount per order or per dish, for pickup
and delivery, never dine-in, with its own label and optional tax at the
location's rate. It reaches the region as
`context.packagingFee = { version: 1, locations }` and is priced like the
service fee: the fee's tax is part of `tax_cents`, the browser sends
`expectedPackagingFeeMinor` and a different amount is 409
`packaging_fee_changed` with `details: { packagingFeeMinor }`, a fee that is on
but unreadable is 503 `packaging_fee_unavailable`. Per-dish mode counts the same
dishes as the large-order rule. A discount can waive it:
`Discount.waivesPackagingFee` (`DiscountDefinition.waivesPackagingFee`, sent to
the region only when true) makes `evaluateDiscounts` return `packagingWaived`,
and the quote and placement price the fee as 0. Placed orders keep what was
charged (`packaging_fee_cents`, `packaging_fee_tax_cents`,
`packaging_fee_label`). A full refund includes it (it is inside the total) and a
partial refund is the amount the operator types, so there is no separate tick.
Reports have a Packaging fee measure (`packagingFee`) and a "Packaging fees"
template, and every place that reads whether prices include tax from the totals
counts the fee (`restaurantOrderNetMinor`, `orderTaxInclusive`,
`orderServiceFeeChargeCents`).

**Daily dish limits (#409).** Flag `ordering.daily_dish_limits` (default off).
`OrganizationMenuItem.dailySaleLimit` and
`OrganizationMenuOption.dailySaleLimit` (JSON `DailySaleLimit` in
`@repo/common/daily-dish-limits`): a limit, an optional per-location override
(`null` lifts it there) and whether guests may see "Only N left". The cap rides
in `context.dailyDishLimits = { enabled, entries }` (id, name, config of every
capped dish or option), never in the public menu. Every order claims its units
in `order_dish_daily_claims` (one row per order and counter key, `item:<id>` or
`option:<id>`; an option counts its quantity times the line's): `held` while an
online order waits for payment (an open cart), `sold` once it counts, `released`
when it is cancelled, rejected, expired or in payment review. The claim state
follows the order through the `order_dish_daily_claims_sync` trigger (tenant-db
migration 0050, hand-written), so no path that changes an order can forget it,
and a repeated event cannot count twice (`dailyDishClaimState` is the same rule
in TypeScript, and a test keeps the two equal). The allowance is the configured
limit (read live, so editing it takes effect at once) plus the day's top-up
(`order_dish_daily_topups`), minus claims that are held or sold. The day is the
location's business day (its time zone and day start, 04:00 by default) so a
late-night order belongs to the dinner shift, and the next day starts again at
the limit. Placement checks and records inside the org lock and the placement
transaction, so two guests cannot both take the last unit: 422
`daily_dish_sold_out` with `details.short` (the keys that cannot be covered;
`remaining` only when the operator allows "Only N left"). The cart quote checks
too. A guest page reads `dailyAvailability` from the options: only sold out
(`remaining: 0`) and, where allowed, a low number (5 or fewer), so a cap that is
not shown never leaves the region. Orders placed before the flag was turned on,
and Station sales, are not counted; a manager corrects the day with a top-up.

- `GET /operator/orders/daily-limits?locationId=` (`orders:read`): today's
  figures for every capped dish and option (`DailyDishStatusData`).
- `POST /operator/orders/daily-limits/top-up` (`orders:write`, not while
  impersonating): `{ locationId, key, addUnits }` (a fresh batch) or
  `{ locationId, key, amountLeft }` (a count at the pass), exactly one; the
  allowance moves, the configured limit does not. The App audits it.
- Station: `GET /pos/online-orders/controls/daily-limits` and
  `POST .../controls/daily-limits/top-up` (`{ key, addUnits | amountLeft }`),
  manager only like the other controls.

### Order link ("View your order")

Guest order emails link to
`<site origin>/menu/success?order=<orderId>#link=<token>`. The token is an HMAC
of `AUTH_HMAC_SECRET` over the purpose `order-link:v1`, the organization and the
order (`lib/order-link.ts`): 64 lowercase hex characters, never the receipt or
payment token. It rides in the URL fragment only, so Sites SSR never sees it;
the page reads it from `location.hash` and sends it from the browser. It lapses
90 days after the order was placed and dies when the order's person is erased.
It never signs anyone in; besides reads and the re-send below, its only write is
the guest's own cancel while the location allows it (see "Guest cancel").

`GET /orders/:id?slug=...` also accepts `X-Order-Link: <token>`:

- With the header, either a valid receipt token (Bearer) or a valid link token
  opens the order and returns `200 { order }`. Which body depends on the
  credential that verified:
  - A valid receipt token (with or without a link header): the full receipt body
    above.
  - A valid link token and no valid receipt token (missing, forged, another
    order's): the link body. The link is emailed and texted, so it gets
    forwarded and kept; its body carries nothing that names, reaches or locates
    the guest. Against the receipt body: there is no `contact` key; `delivery`
    is `{ feeCents, zoneId }` (no `address`, `city`, `unit`, `postalCode` or
    `notes`) on a delivery order and `null` otherwise (`fulfillment` still says
    `delivery`); every line's `instructions` is `null`. Every other key is the
    same. A page opened from the link shows the order, its status and promised
    time, not who it is for or where it goes.
- Every refusal (forged, tampered, expired, erased, another order, another
  organization, a receipt or payment token in the header, a value that is not 64
  lowercase hex characters) is
  `404 { "error": "order_not_found", "message": "Order not found." }`, the same
  answer as an order that does not exist. A header that is not 64 lowercase hex
  characters is refused before any database work; a well-formed one costs one
  order read, and expired holds are swept only after it verified.
- Without the header nothing changes: no Bearer is `401 unauthorized`, a wrong
  Bearer (a link token included) is `403 invalid_receipt_token`.
- The organization still comes from the browser `Origin` plus `slug`/`host`.

The link token opens nothing else (except the guest cancel below): tabs and tab
payment keep `X-Tab-Token`, placement keeps the customer token, the App's quote
and payment session keep the payment token.

`POST /orders/:id/resend-link` e-mails the receipt (with its link) again:

- Body: `{ slug?: string; host?: string }` (strict, used with `Origin` to find
  the organization and route the Worker; max 2 kB).
- Credential: `Authorization: Bearer <receiptToken>` or `X-Order-Link: <token>`.
  None or an invalid one: the same `404 order_not_found` as above, and nothing
  is counted.
- Limit: 3 per order per sliding hour, counted durably in the organization's
  database before sending (refused attempts count too). Over it:
  `429 { "error": "rate_limit_exceeded", "message": string, "retryAfterSeconds": number }`
  with `Retry-After`.
- Otherwise always `202 { "ok": true }`, whether or not the order has an email,
  guest emails are on, or the send succeeds; the send runs after the response.
  Dine-in and tab rounds get nothing.
- All answers are `Cache-Control: no-store`.

### Guest cancel (#111)

The guest may cancel their own order for a few minutes after placing (handoff)
or paying (online), while the location offers it. The policy comes from the
CURRENT order context (`guestCancel[locationId]`, present only while
`ordering.guest_cancel` is on and the location has a window of 1, 2, 5 or 10
minutes), so switching it off stops cancels at once. The rule is
`guestCancelWindow` in `@repo/common/restaurant-orders`: only `accepted` or
`pending_acceptance`, not dine-in, QR table rounds or tab rounds, an online
order must be `paid` or `not_required`, a pay-at-handoff order already marked
`paid` (counter or phone) is `not_cancellable` (no refund is booked for it), no
kitchen ticket dish past New (`kds_tickets`, source `online`), scheduled orders
until `scheduledLeadMinutes` before their time (never less than the ASAP
window), drop orders never after the drop's `ordersCloseAt` (a closed or missing
drop closes it).

Both routes take the same credential and organization as the order link: the
`Origin` plus `slug`/`host`, and `Authorization: Bearer <receiptToken>` or
`X-Order-Link: <token>`. Every refusal (none, forged, expired, erased, another
order, another organization, a malformed link) is the uniform
`404 order_not_found`, refused before any limit is counted, and a malformed link
before any database work. Answers are `Cache-Control: no-store`, with no
personal data.

`GET /orders/:id/cancel?slug=...` answers
`200 { allowed: boolean, until: string | null, reason: null | "disabled" | "not_cancellable" | "cancel_window_closed" | "order_in_preparation" }`
(`guestCancelResponseSchema`). Limits: 60 per order and 300 per client address
per sliding 10 minutes (`429 rate_limit_exceeded` with `retryAfterSeconds` and
`Retry-After`). `503 ordering_unavailable` when the order context cannot be
read.

`POST /orders/:id/cancel`:

- Body `{ slug?: string; host?: string }` (strict, max 2 kB, as resend-link).
- Header `Idempotency-Key`: 8 to 200 visible ASCII characters, one per tap
  (reuse it on a network retry). Missing or malformed:
  `400 idempotency_key_required`.
- Limits: 5 per order and 30 per client address per sliding 10 minutes, counted
  after the credential verified (refusals count). Over: `429` as above.
- Success:
  `200 { allowed: false, until, reason: null, status: "cancelled", refund: { status: "none" | "pending" | "succeeded" | "failed", amountCents } }`.
  The order is `cancelled` with `cancelled_by = guest` and
  `cancel_reason = guest_asked`, through the operator cancel's own write
  (discount uses released, loyalty and inventory settled, the `cancelled` guest
  message queued). A paid online order books a full provider refund in the same
  transaction (`kind = provider`, `origin = guest`, actor `guest`, idempotency
  key `cancel:<orderId>`) and the region kicks the App with ids only; the
  answer's `refund` is `pending` with the amount. When another provider refund
  of the order is still pending, the full refund is owed instead (see "Provider
  refunds" below) and the answer's `refund` is `pending` with everything not yet
  back. Free orders (and handoff orders not yet paid):
  `refund: { status: "none", amountCents: 0 }`.
- The same `Idempotency-Key` again (24 hours) returns the stored answer byte for
  byte with `Idempotent-Replayed: true`: no second cancel, refund, kick or
  message. A new key on a cancelled order is `409 not_cancellable`.
- Refused by the rule: `409 { error, message, allowed: false, until, reason }`
  with `error` = `guest_cancel_disabled` (flag off or location Off),
  `not_cancellable`, `cancel_window_closed` or `order_in_preparation`. Nothing
  is written.
- `503 ordering_unavailable` when the order context cannot be read.

The guest's receipt reads (`GET /orders/:id` by receipt token or link) carry
`cancel: { allowed, until }` so the page can show "Cancel order" and a countdown
without a second request. It may be up to 30 seconds behind the settings (the
cancel itself always checks fresh); an order past any possible window answers
`{ allowed: false, until: null }` without asking the App. The operator view
never carries `cancel`; it shows `cancelledBy: "guest"`. Both reads also carry
`refundsOnCancel: boolean` (true only for an order paid online): Sites words the
confirm box from it and promises a refund only then. Optional on the wire
(`publicOrderLifecycleSchema`), so an older region simply omits it.

## App → regional API (internal command token)

`POST /api/orders/quote`: `{ orgId, orderId, paymentToken }`. Return only:

```ts
{
  orgId: string
  orderId: string
  totalCents: number
  currency: string // uppercase ISO: 'USD' | 'CAD' | 'SAR'
  holdExpiresAt: string | null
  status: string // order status, e.g. 'pending'
  // Negotiated extensions (omit when not applicable):
  paymentStatus?: 'pending' | 'paid' | 'failed' // distinct payment status
  sessionId?: string // provider session already bound to this order
  processor?: 'connect' | 'checkout' // processor of the bound session
}
```

App treats `paymentStatus === 'paid'` as paid (falling back to
`status === 'paid'`), and replays against a bound `sessionId` instead of ever
creating a second chargeable session.

`POST /api/orders/payment-session`: `{ orgId, orderId, sessionId, processor }`.
Bind provider session exactly once. A second bind for the same order fails with
`409 { error: 'already_bound' }`.

`POST /api/orders/payment-status`:
`{ orgId, orderId, sessionId, processor, status: 'paid' | 'failed' | 'expired', amountCents, currency, paymentId? }`.
`paymentId` (optional, additive) is the provider's id for this one payment:
Checkout.com binds the order reference as its session, so it is what tells two
payments on one QR tab apart. Verify provider/session, immutable amount and
currency. `currency` arrives as a lowercase ISO code ('usd', 'cad', 'sar') from
provider events; compare case-insensitively. Duplicate events are idempotent.
Terminal states cannot regress. A late paid event must never resurrect an
expired reservation or overbook stock; expose `payment_review` for operator
intervention instead. A bound session the provider reports `expired` should
clear the binding (or move the order to `payment_review`) so a retry can bind a
fresh session; App reports provider session expiry with `status: 'expired'`.

Transient regional failures surface as 5xx so providers retry; permanent
rejections (unknown order, unbound session, amount/currency mismatch) may be 4xx
— App acknowledges those without confirming.

## Regional API → App catalog

`GET /resources/order-context?orgId=...&locationId=...&drop=...` authenticated
with `INTERNAL_COMMAND_TOKEN`. This route must use fresh authoritative catalog
data, not published KV caches. Returns:

```ts
{
	orgId: string
	dataRegion: 'us' | 'ksa'
	menu: PublicSiteMenuPayload // location-derived pricing/fulfillment, no PII
	drop: PublicDropData | null // current windows and configured inventory caps
	onlinePayment: {
		enabled: boolean
		processor: 'connect' | 'checkout' | null
	}
}
```

The App owns processor account configuration and never exposes processor
secrets. The tenant service fetches context server-side, with a short timeout
and no browser-supplied URL. All order prices, membership, availability, min/max
and nested options, operating hours, pickup timezone, lead time, inventory and
slot capacity are revalidated before writing.

## Browser → App hosted payment

`POST /resources/sites/order/checkout`:
`{ slug?: string; host?: string; orderId: string; paymentToken: string; locale?: string }`.
Strict body — unknown properties (including any contact fields or success/cancel
URLs) are rejected with 400. Returns `{ checkoutUrl, sessionId, processor }`.
Quote is fetched from the regional API with internal command authentication.
Hosted payment metadata is `{ type: 'restaurant_order', orgId, orderId }`. The
hosted line item is a fixed generic `Restaurant order` product with the regional
quote's authoritative amount and currency (Stripe accepts `usd`/`cad`/`sar`;
Checkout.com sessions derive the billing country from the currency). Provider
success/cancel URLs are generated server-side on the org's canonical site host
with a validated locale path — success carries only `?order={orderId}`; the
browser's receipt capability stays in sessionStorage. No contact, receipt token,
cart instructions or product name is sent to App.

`POST /resources/sites/order/status` (browser poll after redirect):
`{ slug?: string; host?: string; orderId: string; paymentToken: string }`,
strict body. Returns
`{ paymentStatus: 'paid' | 'pending' | 'failed' | 'unknown', orderStatus: string, holdExpiresAt: string | null, processor: 'connect' | 'checkout' | null }`.
For Stripe Connect, App performs a trusted provider session lookup and pushes
any terminal state to the regional API (idempotent) before answering; the
receipt itself stays regional. A redirect alone never marks an order paid.

Signed webhook events send minimal payment status to the regional API.
Payment-session IDs and processor amounts/currencies must match the bound order.
The browser must never mark an order paid based on redirect/query parameters.

## Operator → regional API

Read scope `orders:read`, write scope `orders:write`, separately minted after
App menu-read/menu-write authorization. Endpoint checks node region and active
provisioned organization, and uses `private, no-store`.

- `GET /operator/orders`: recent orders.
- `GET /operator/orders/:id`: full regional receipt. Both reads add
  `customerKey` (`c_<id>`, `g_<id>` or null) only when the token carries the
  `linkCustomers` / `linkGuests` claims App signs; matching is `customer_id`,
  then verified phone, never name or email.
- `PATCH /operator/orders/:id`:
  `{ status: 'accepted' | 'preparing' | 'ready' | 'completed' | 'cancelled', markPaid?: boolean }`.
- `POST /operator/orders/:id/refunds` (`orders:write`, `Idempotency-Key`
  required): `{ amountCents, note }` or `{ full: true, note }` (note 3 to 280
  characters) records money returned for a paid online order. A record only: the
  refund itself happens in the provider's dashboard and the region never calls a
  provider. Answers 201 `{ order, refund, replayed: false }` (200 and
  `replayed: true` for the same key and body), 422 `refund_exceeds_payment` with
  `refundableCents`, and 409 `refund_complete`, `refund_not_online`,
  `refund_not_paid` or `idempotency_conflict`. Refunds are append-only
  `restaurant_order_refunds` rows; `refundedCents` on the order only grows and
  never passes `totalCents`, and `paymentStatus` stays `paid`. Operator order
  reads carry `refundedCents`, and `GET /operator/orders/:id` adds `refunds`
  (`{ id, amountCents, currency, full, note, actorId, createdAt }`, oldest
  first). Loyalty takes earned points back from `refundedCents`
  ([loyalty.md](./loyalty.md#refunds)).

### Provider refunds (#80)

The App books a provider refund with `POST /api/orders/refund-intent` (internal
token) and reports the provider's answer with `POST /api/orders/refund-status`;
`POST /api/orders/dispute-status` records disputes. Rules that callers rely on:

- What is back: `refunded_cents` counts succeeded refunds and never shrinks. A
  refund the provider moves from `succeeded` to `failed` later (Stripe
  `refund.failed` / `refund.updated`) is reported as `failed` on the same
  refund: the row stays `succeeded` and is marked reversed (`reversed_at`,
  `reversal_code`, once; a replay answers `applied: false`), and
  `restaurant_orders.refund_reversed_cents` grows by its amount. Every read
  (operator, Station, guest receipt and link, person orders, the cancelled
  email, loyalty) uses the net `refunded_cents - refund_reversed_cents`; the
  refund reads `failed` with the reversal's code and `reversedAt`, and the
  amount is refundable again (paid − succeeded − pending + reversed). Loyalty
  points taken back and discount uses given back stay as they are: a retry that
  succeeds returns the same money and takes nothing back a second time.
- Loyalty grant: the App sends `loyaltyAccess: { refundLoyalty: false }` for a
  member without `update:loyalty_redemption:any`; the region then refuses an
  order loyalty tracks with 403 `loyalty_refund_forbidden` and confirms the
  check with `loyaltyChecked: true` (the App refuses an answer without it, 403
  `loyalty_check_unsupported`, releasing what was booked). A member with the
  grant sends nothing. The operator cancel with `refund: 'full'` checks the
  orders token's `refundLoyalty` claim the same way (`refundError`, the cancel
  stands). Rejections, the acceptance timeout and the guest's cancel are not
  gated.
- A cancel that asks for a full refund (operator `refund: 'full'`, a rejection,
  the timeout, the guest's cancel) while another provider refund of the order is
  pending, or while its payment has an open dispute, cannot book it (one at a
  time; none while disputed). The order is marked `cancel_refund_due_at` and the
  answer says `refund_pending` / `payment_disputed`. Once the other refund is
  final (succeeded or failed), or the dispute is won, the region books whatever
  is refundable then (key `cancel:<orderId>:rest`, origin `system`) and kicks
  the App; the orders tick does the same as a backstop (open disputes are
  skipped). The mark is dropped when nothing is left, or when the dispute is
  lost (the chargeback returned the money). If that refund fails later, it is
  shown as failed like any other and a person refunds again.
- Disputes are monotonic: once a dispute closed (`won` or `lost`), a late or
  redelivered `open` is ignored (logged by id; the answer carries the stored
  state with `applied: false`). A closed state may still change to the other
  closed state. A payment has one dispute at both providers, so no dispute id is
  carried.

### Manual acceptance (#107)

While `ordering.manual_acceptance` is on, the order context carries
`acceptance[locationId]`
(`{ mode: 'manual', timeoutMinutes: 3|5|10, minTotalCents, scheduledOnly }`;
anything missing or malformed reads as Automatic, which places orders exactly as
before). `orderNeedsAcceptance` decides at placement: never dine-in, QR table
rounds or tab rounds; only orders whose total is strictly over `minTotalCents`;
with `scheduledOnly`, only scheduled orders (a chosen time or a drop's pickup
slot). The deadline is `acceptanceDeadline`: now plus the minutes, or for a
scheduled order 30 minutes before the kitchen starts it (scheduled time minus
the location's prep time) when that is later.

- A pay-at-handoff or free order is placed `pending_acceptance` with
  `acceptance_deadline_at`. An online order that still has to be paid is placed
  as before (`accepted`, payment `pending`) with the deadline as a mark only
  (not shown in operator or guest views); its paid event moves it to
  `pending_acceptance` with the deadline `max(placed deadline, paid + minutes)`.
  A payment that arrives after the hold lapsed still goes to `payment_review`
  and never waits.
- A waiting order holds slot and drop capacity like `accepted`, is not a kitchen
  ticket, not a sale (reports, customer spend, stock) and earns no loyalty; its
  discount use stays reserved. The receipt message goes out as usual ("we
  received your order").
- `PATCH /operator/orders/:id` `{ status: 'accepted' }` accepts (sets
  `accepted_at`): stock, loyalty and the discount use (online paid or free)
  settle exactly as for an order accepted at placement, the kitchen sees it, and
  the guest gets the `accepted` message (only ever on this manual accept).
  `{ status: 'cancelled', rejectReason }`
  (`out_of_stock | kitchen_closed | too_busy | other`; a `cancelReason` alone is
  taken as the reason) rejects: `rejected_reason` and `cancel_reason` set,
  `cancelled_by = 'operator'`, discount use released, `cancelled` message; a
  paid online order is refunded in full through the payment provider
  (`refundIntent` / `refundError` in the answer, no refund claim needed, the App
  is kicked). Errors: 422 `reject_reason_required`, 403 `refund_forbidden`
  (impersonating, paid online order), 409 `order_not_pending` (accepting an
  order that waited but is no longer waiting, or rejecting one already
  accepted), 404 for another location's or organization's order. A repeat of the
  same decision answers the order as it is (200); two decisions at once are
  serialized and the second is refused. Accepting after the deadline is allowed
  while the order still waits.
- `GET /operator/orders?status=pending_acceptance` lists the waiting orders
  (badge). Operator orders carry `acceptanceDeadlineAt`, `acceptedAt` and
  `rejectedReason`.
- Timeout: `processOrderAcceptance` (orders tick, see
  [scheduled-jobs.md](./scheduled-jobs.md#order-messages-tick)) rejects with
  `not_accepted_in_time`, `cancelled_by = 'system'`, a full refund with origin
  `system` for a paid online order.
- Guest views (`receiptOrder`, `linkReceiptOrder`): `acceptanceDeadlineAt` (only
  while `pending_acceptance`, else null) and `rejected` (boolean). The reason
  shown is only the guest-visible `cancelReason`. The guest may still cancel a
  waiting order (#111); that is not a rejection.

Money remains integer cents. Orders with handoff payment hold capacity durably
immediately. Online orders reserve capacity until their configured hold expiry;
expiration and capacity checks run in the same transaction. Never reset used
inventory when a configured cap changes.

## QR table ordering

Operator guide: [qr-ordering.md](./qr-ordering.md). Every addition is optional;
pickup and delivery requests are unchanged.

### Browser → regional API

- `POST /orders` with `fulfillment: 'dine_in'` places one round. It needs an
  `X-Table-Token` (the table's code from the URL fragment) or an `X-Tab-Token`
  (the open tab). `contact` fields become optional (`{ name?, phone?, email? }`)
  and the org's QR settings decide what is required (`contact_name_required`,
  `contact_phone_required`). A dine-in body must not carry `dropSlug`, `pickup`,
  `delivery`, `scheduledFor`, a tip, `paymentMethod: 'online'` or a `source`.
  The response adds `tab: { id, tabNumber, tabToken }`.
- Pickup and delivery orders may send `source: 'qr_poster'` (stored only while
  QR ordering is on).
- `GET /orders/options` with `X-Table-Token` adds
  `table: { label, locationId }`,
  `dineIn: { enabled, requireGuestName, requireGuestPhone, onlineTabPayAvailable }`
  and
  `openTab: { id, tabToken, tabNumber, openedAt, roundsCount, totalCents } | null`.
- `GET /orders/tab?slug=…` with `X-Tab-Token` returns `{ tab: QrPublicTab }`
  (`@repo/common/qr-ordering`): rounds with their statuses and lines, totals,
  `roundsPending`, and `serviceFee` (the location's settings and tax rate while
  the fee is on for tables) and `tipChoices`
  (`{ enabled, currency, settings }`). No contact fields.
- `POST /orders/tab/pay` with `X-Tab-Token` and
  `{ slug?, host?, tipPercent | tip, expectedServiceFeeMinor?, contact: { name, phone }, loyalty? }`
  returns
  `{ orderRef: 'tab:<id>', tabPaymentToken, amountCents, tipCents, serviceFeeCents, loyaltyDiscountCents, currency }`.
  The browser then uses the hosted-payment calls below with `orderId = orderRef`
  and `paymentToken = tabPaymentToken`. `loyalty` (the same selection as
  `POST /orders`, customer token required) spends one reward on the tab; asking
  again gives an earlier reward back first. Rewards on a tab are priced with
  `POST /loyalty/tab/quote` ([loyalty.md](./loyalty.md#earning)).

Errors: `table_not_found` (404), `table_archived` (410),
`table_location_mismatch` (422), `tab_closed` (409), `tab_locked` (423),
`tab_paying` (409), `rounds_pending` (409), `table_rate_limited` (429),
`dine_in_unavailable` (404, flags off), `online_pay_unavailable` (409). The kill
switch `QR_DINE_IN_ENABLED=false` answers 503 `{ error: 'unavailable' }`.

### App → regional API

`/api/orders/quote`, `/payment-session` and `/payment-status` accept
`orderId: 'tab:<id>'`. The quote amount is the tab total plus the tip; a paid
event closes the tab and marks every counting round paid; a paid event on a tab
staff already settled is kept as `paymentStatus: 'review'`; failed or expired
events unbind the session. The order-context response adds
`qrOrdering: { enabled, dineIn, online }` (missing or malformed reads as off). A
tab payment returns to `/menu?tab=paid|cancelled`.

### Operator → regional API

`/operator/qr/*` with `qr:read` / `qr:write` operator tokens (App route
`/:orgSlug/qr-token`; `canImportFloorPlan` is a separate fail-closed claim):
`GET|POST /tables`, `POST /tables/bulk`, `PATCH /tables/:id`
(`{ label?, archived?, regenerateToken? }`), `POST /tables/import-floor-plan`,
`GET|PATCH /settings`,
`GET /tabs?status=open|closed|cancelled|recent|review|station` (`station`:
counter closes marked `rungUpOnStation` in the last 24 hours, newest close
first), `GET /tabs/:id`, `POST /tabs/:id/close`
(`{ paymentMethod: 'counter', tipCents?, acknowledgeReview?, expectedTotalCents?, rungUpOnStation? }`;
`rungUpOnStation: true` means the till sale earns loyalty points, so the tab
does not), `POST /tabs/:id/clear-station-flag` (undoes a mistaken mark; the tab
earns), `POST /tabs/:id/void` (`{ reason }`), `POST /tabs/:id/lock`.
`GET /operator/orders` rows add `table`, `tabId` and `source`; `markPaid` on a
tab round answers `tab_settlement_required`.
