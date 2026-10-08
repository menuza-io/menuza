# Restaurant ordering: launch and operations

Production checklist for customer ordering on tenant Sites (menu + drops). Read
`docs/restaurant-ordering-contract.md` for the API contract and
`docs/sites-ordering-ux.md` for the UX spec. The residency rules in
`docs/tenant-data-residency.md` apply end to end: customer PII moves only
browser → regional tenant-api; App sees opaque order/payment references only.

## Architecture in one paragraph

The browser submits the cart (catalog IDs only, never prices) to the regional
tenant-api `POST /orders`, which re-prices from a fresh App catalog context,
reserves capacity, and returns a receipt capability token. Online payment is
brokered by App: the browser sends an opaque `paymentToken` to Sites
`/api/orders/payment`, which forwards it to App
`POST /resources/sites/order/checkout`; App quotes the regional API, creates the
hosted processor session, and signed webhooks push terminal payment status back
to the regional API. Operators work the order inbox in App
(`/<org>/menu/orders`), which holds scoped regional JWTs minted by
`/<org>/orders-token` and calls `GET/PATCH /operator/orders` directly.

## Environment checklist

App (control plane):

- `INTERNAL_COMMAND_TOKEN` — shared with every tenant-api node (quote,
  payment-session, payment-status, order-context).
- `TENANT_OPERATOR_TOKEN` — signs operator `orders:read` / `orders:write` JWTs
  verified by tenant-api.
- `TENANT_API_URL` / `TENANT_API_URL_KSA` — regional node origins.
- Stripe Connect: platform secret + webhook endpoint `POST /api/stripe/webhook`
  subscribed to `checkout.session.completed`,
  `checkout.session.async_payment_succeeded`,
  `checkout.session.async_payment_failed`, `checkout.session.expired`.
- Checkout.com: platform secret + webhook endpoint `POST /api/shop/webhook`
  (shared with the shop flow; restaurant events are dispatched by metadata
  type).

Sites (public storefront):

- `APP_URL` (or the deployed equivalent) so `/api/orders/payment*` can reach
  App. No new secrets; no customer tokens ever touch Sites.

Tenant-api (regional):

- `INTERNAL_COMMAND_TOKEN`, `TENANT_OPERATOR_TOKEN`, `JWT_SECRET`,
  `AUTH_HMAC_SECRET`, `DATA_REGION`, `TENANT_DB_DIR`, `APP_URL` (for the
  order-context fetch).
- Optional: `TURNSTILE_SECRET_KEY` + `TURNSTILE_HOSTNAMES` enable the
  `place-order` Turnstile action on `POST /orders`.

Apply tenant-db migrations (includes `0011_restaurant_orders`) to every regional
node before enabling ordering.

## Processor onboarding per organization

Online payment availability is resolved per org in
`apps/app/app/utils/restaurant-orders/payment-config.server.ts`:

- **Stripe Connect** — US orgs only. Requires `stripeConnectAccountId` with
  charges enabled. KSA orgs fail closed (no Saudi card volume through a US
  platform account).
- **Checkout.com** — any region. Requires a sub-entity with charges enabled.
  This is the KSA online-payment path; SAR orders are billed as country SA.
- **Polar** — never for restaurant carts (fixed-product checkout).

When no processor qualifies, checkout automatically offers pay-at-handoff only;
nothing to configure on Sites.

## Operator workflow

1. Operator opens `<org> → Menu → Orders` in App.
2. App mints `orders:read` (and `orders:write` when the operator has menu write
   permission) via `/<org>/orders-token`; the browser polls the regional
   `GET /operator/orders` every 15s.
3. New orders arrive as `accepted` (capacity already held). Online orders show
   "Awaiting payment" until the webhook lands.
4. Transitions: accepted → preparing → ready → completed, plus cancel from any
   non-terminal state. Handoff orders must be marked paid at completion
   (checkbox in the UI). `payment_review` orders (e.g. a late paid event on an
   expired hold) require manual review; cancelling an online order does not
   refund — refund in the processor dashboard.

## Customer flow states

- Handoff: order is placed, capacity held durably, success page renders the
  authoritative receipt from the regional API (capability token in
  `sessionStorage`; receipts are per-device).
- Online: order is placed with a hold (`holdExpiresAt`), browser redirects to
  the hosted checkout; the success page polls App
  `/resources/sites/order/status` and only trusts the regional receipt — never
  redirect query params. Expired holds release capacity and the customer is told
  to order again.

## Capacity semantics

- Drop slot `maxOrdersPerSlot`, per-item/per-category inventory,
  `maxPerPickupSlot`, and `maxPerOrder` are enforced transactionally in the
  regional service; expiry sweeps run inside the placement transaction.
- Handoff orders consume capacity immediately; online orders hold until
  `holdExpiresAt` (drop `checkoutHoldMinutes`, else 10 minutes).
- `cancelled`, `expired`, and `payment_review` release capacity. Changing a
  configured cap never resets used inventory.

## Rate limits

- Browser → regional: 12 order creations/min/IP, 240 reads/min/IP.
- Browser → App: checkout session 10/min, status poll 60/min (per IP+order).

## Known limits

- No SMS/email order confirmation yet — the receipt page is the record of order.
  Receipt tokens are per-device (`sessionStorage`); a customer who loses the tab
  cannot retrieve the receipt (by design, no PII lookup without auth; signed-in
  customers are bound via customer JWT).
- The operator inbox is poll-based (15s), not push.
- Refunds are manual in the processor dashboard.
