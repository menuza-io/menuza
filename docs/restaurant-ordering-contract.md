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
- `GET /operator/orders/:id`: full regional receipt.
- `PATCH /operator/orders/:id`:
  `{ status: 'accepted' | 'preparing' | 'ready' | 'completed' | 'cancelled', markPaid?: boolean }`.

Money remains integer cents. Orders with handoff payment hold capacity durably
immediately. Online orders reserve capacity until their configured hold expiry;
expiration and capacity checks run in the same transaction. Never reset used
inventory when a configured cap changes.
