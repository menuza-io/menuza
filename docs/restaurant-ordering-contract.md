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
  tipPercent: number
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
    loyaltyDiscountCents: number; // a reward's discount, off the subtotal before tax
    totalCents: number; holdExpiresAt: string | null }
  receiptToken: string
  paymentToken?: string // online only; capability to request an opaque quote
}
```

`GET /orders/:id?slug=...` with `Authorization: Bearer <receiptToken>` returns
the authoritative receipt including contact, priced lines and pickup summary. An
existing authenticated customer token is not a receipt capability.

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
order must be `paid` or `not_required`, no kitchen ticket dish past New
(`kds_tickets`, source `online`), scheduled orders until `scheduledLeadMinutes`
before their time (never less than the ASAP window), drop orders never after the
drop's `ordersCloseAt` (a closed or missing drop closes it).

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
  answer's `refund` is `pending` with the amount. Handoff and free orders:
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
never carries `cancel`; it shows `cancelledBy: "guest"`.

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
  `roundsPending`. No contact fields.
- `POST /orders/tab/pay` with `X-Tab-Token` and
  `{ slug?, host?, tipPercent, contact: { name, phone }, loyalty? }` returns
  `{ orderRef: 'tab:<id>', tabPaymentToken, amountCents, tipCents, loyaltyDiscountCents, currency }`.
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
