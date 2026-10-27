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
}
```

No browser prices are accepted. Successful response:

```ts
{
  order: { id: string; number: string; status: string; paymentStatus: string;
    currency: string; subtotalCents: number; taxCents: number;
    deliveryFeeCents: number; tipCents: number; totalCents: number;
    holdExpiresAt: string | null }
  receiptToken: string
  paymentToken?: string // online only; capability to request an opaque quote
}
```

`GET /orders/:id?slug=...` with `Authorization: Bearer <receiptToken>` returns
the authoritative receipt including contact, priced lines and pickup summary. An
existing authenticated customer token is not a receipt capability.

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
`{ orgId, orderId, sessionId, processor, status: 'paid' | 'failed' | 'expired', amountCents, currency }`.
Verify provider/session, immutable amount and currency. `currency` arrives as a
lowercase ISO code ('usd', 'cad', 'sar') from provider events; compare
case-insensitively. Duplicate events are idempotent. Terminal states cannot
regress. A late paid event must never resurrect an expired reservation or
overbook stock; expose `payment_review` for operator intervention instead. A
bound session the provider reports `expired` should clear the binding (or move
the order to `payment_review`) so a retry can bind a fresh session; App reports
provider session expiry with `status: 'expired'`.

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
  `{ slug?, host?, tipPercent, contact: { name, phone } }` returns
  `{ orderRef: 'tab:<id>', tabPaymentToken, amountCents, tipCents, currency }`.
  The browser then uses the hosted-payment calls below with `orderId = orderRef`
  and `paymentToken = tabPaymentToken`.

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
`GET|PATCH /settings`, `GET /tabs?status=open|closed|cancelled|recent`,
`GET /tabs/:id`, `POST /tabs/:id/close`
(`{ paymentMethod: 'counter', tipCents? }`), `POST /tabs/:id/void`
(`{ reason }`), `POST /tabs/:id/lock`. `GET /operator/orders` rows add `table`,
`tabId` and `source`; `markPaid` on a tab round answers
`tab_settlement_required`.
