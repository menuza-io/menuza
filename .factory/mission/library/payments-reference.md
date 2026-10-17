# Payments reference (reservation deposits, guarantees, fees, refunds)

**What belongs here:** the existing payment code a worker reuses, provider API
call shapes for Stripe Connect and Checkout.com, money and currency rules, test
cards, and payment gotchas, all verified against the repo.

**What does NOT belong here:** the emulator design (see
`library/payment-mocks.md`), the reservation payment flow and internal contract
(see `architecture.md` section 12), and Sites UI details (see
`library/sites-patterns.md`).

Paths are relative to `/home/factory-user/repos/menuza`. Line numbers were
checked on branch `pr/reservations`.

## 1. Ground rules (one line each; details in architecture.md section 12)

- The App is the only component that calls a provider. tenant-api decides
  amounts, policy, state and capacity. See architecture.md 12.1.
- Provider metadata holds opaque ids only:
  `{ type: 'reservation_payment' | 'reservation_fee' | 'reservation_refund', orgId, reservationId, purpose, feeId? }`.
- Flow is quote, then bind once, then status. Idempotency keys are
  deterministic. Terminal states never regress.
- Fees are charged only by staff (invariant I12). Refunds are decided regionally
  and executed by the App from `rsv_outbox`.
- No real keys exist. Every flow is validated against the emulators (milestone
  `payment-mocks`).
- US uses Stripe Connect destination charges. KSA (and any region) uses the
  Checkout.com Hosted Payments Page. The US-only Checkout.com guards are
  removed.
- Platform fee: `reservations.platform_fee_bp` in `ConfigFlag`, default 0,
  per-organization override, edited in Admin. See architecture.md 5.2 and 12.3.

## 2. Existing code map (reuse, do not copy blindly)

| What                                 | Where                                                                                                                               | Notes for reservations                                                                                                                                                                                                                                                        |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Order hosted checkout (the template) | `apps/app/app/utils/restaurant-orders/checkout.server.ts` `createRestaurantOrderHostedCheckout` (`:324-484`)                        | Quote, recover bound session, create, bind once, expire the unbound session on a bind loss. Copy the shape into `utils/reservations/payments*.server.ts`.                                                                                                                     |
| Order status poll                    | same file, `getRestaurantOrderPaymentStatus` (`:515-604`)                                                                           | Stripe only today (comment at `:553-554`). Reservations need a Checkout.com lookup too.                                                                                                                                                                                       |
| Processor capabilities               | same file, `:238-245`, `:308-318`                                                                                                   | Stripe sessions are recoverable, expirable and pollable. Checkout.com is webhook-only today and unbound Checkout.com sessions are never closed.                                                                                                                               |
| Online payment gate                  | `utils/restaurant-orders/payment-config.server.ts` `resolveRestaurantOnlinePayment` (`:46-77`)                                      | Connect needs `dataRegion === 'us'`, `stripeConnectAccountId`, `stripeConnectChargesEnabled`. Checkout.com needs `checkoutSubEntityId` and `checkoutChargesEnabled`, any region. Write a `resolveReservationOnlinePayment` variant that takes the currency from the location. |
| Billing country                      | same file, `billingCountryForCurrency` (`:86-95`)                                                                                   | `SAR -> SA`, `CAD -> CA`, else `US`.                                                                                                                                                                                                                                          |
| Regional call helper                 | `utils/restaurant-orders/regional-order-api.server.ts`                                                                              | Internal token, `assertOrgRegion` on the regional side, ids and amounts only. Mirror it for `/api/reservations/payments/*`.                                                                                                                                                   |
| Regional order payment routes        | `apps/tenant-api/src/routes/order-system.ts`                                                                                        | The model for `routes/reservations-system.ts`.                                                                                                                                                                                                                                |
| Webhook dispatch                     | `utils/restaurant-orders/payment-webhooks.server.ts`                                                                                | Add `reservation_*` metadata branches next to the `restaurant_order` branches. Ack permanent regional 4xx, return 500 on transient errors so the provider retries.                                                                                                            |
| Stripe webhook route                 | `apps/app/app/routes/api+/stripe+/webhook.tsx` (`constructEvent` at `:51-54`, one secret)                                           | Gains `getStripeWebhookSecrets()` (platform plus Connect secret) in `payment-mocks`.                                                                                                                                                                                          |
| Checkout.com webhook route           | `apps/app/app/routes/api+/shop+/webhook.tsx`                                                                                        | `cko-signature` HMAC; 503 unless `isProcessorConfigured('checkout')`; 500 when `CHECKOUT_WEBHOOK_SECRET` is unset.                                                                                                                                                            |
| Commerce singleton                   | `apps/app/app/utils/shop.server.ts` `getShopCommerce()` (`:41-59`), `configureShopCommerceForTests(env)`                            | Built once at module load from `createShopCommerceConfigFromEnv(process.env)`. Emulator wiring goes here.                                                                                                                                                                     |
| Commerce class                       | `packages/payments/src/shop/commerce.ts`                                                                                            | `listConfiguredProcessors` (`:187-193`), `isProcessorConfigured` (`:195-211`), `getCheckoutShop`/`getStripe` (`:236-274`), `withConnect` (`:300-308`).                                                                                                                        |
| Config from env                      | `packages/payments/src/shop/config.ts`                                                                                              | `isConfiguredSecret` (`:17-20`) treats any value containing `***` as unset. `validateStripeKeys` is `MOCKS !== 'true' && NODE_ENV !== 'test'`.                                                                                                                                |
| Stripe client                        | `packages/payments/src/providers/stripe.ts`                                                                                         | API version `2025-08-27.basil` (`:35-38`), `httpClient: Stripe.createFetchHttpClient()` (`:38`). Requires the `sk_` prefix.                                                                                                                                                   |
| Stripe Connect helpers               | `packages/payments/src/connect/stripe-connect.ts`                                                                                   | Express account create (`:17-38`), `createShopCheckoutSession` (`:77-133`, destination charge, no `on_behalf_of`).                                                                                                                                                            |
| Checkout.com helpers                 | `packages/payments/src/connect/checkout-shop.ts`                                                                                    | Sub-entity invite (`:75-103`), Flow session (`:126-205`, `paymentSessions.request` at `:181`, redirect required at `:193`), payment lookup (`:207-244`), webhook verify (`:267-282`), webhook mapper (`:300-320`, reads `data.processing.payment_session_id` at `:319`).      |
| Order Checkout.com mapper            | `packages/payments/src/shop/restaurant.ts` `mapCheckoutWebhookToRestaurantOrder` (`:155-182`)                                       | Drops the event when `payment.sessionId` is null (`:165`), so it depends on `processing.payment_session_id`. Order idempotency key builder at `:98-113`.                                                                                                                      |
| Order platform fee                   | `packages/payments/src/connect/shop-fees.ts` `SHOP_PLATFORM_FEE_PERCENT = 20`                                                       | Orders and the shop keep it. Reservations never use it.                                                                                                                                                                                                                       |
| Currencies                           | `packages/common/src/location-currency.ts`                                                                                          | `USD`, `CAD`, `SAR`.                                                                                                                                                                                                                                                          |
| Settings, Shop page                  | `apps/app/app/routes/_app+/$orgSlug_+/settings+/shop.tsx`, card `apps/app/app/components/settings/cards/organization/shop-card.tsx` | Connect onboarding (`connect-payout`, US), Checkout.com invite (`invite-checkout-payout`), `?connect=return` status sync, Checkout.com status sync on every load (`:85-94`).                                                                                                  |
| Legacy shop return                   | `apps/app/app/routes/resources+/sites.shop.checkout.return.ts`                                                                      | Forwards `cko-payment-id` and `cko-session-id`; shows that `GET /payments/{sid}` works.                                                                                                                                                                                       |
| Sites order payment endpoints        | `apps/sites/src/pages/api/orders/payment.ts`, `payment-status.ts`                                                                   | Model for `apps/sites/src/pages/api/reservations/payment.ts` and `payment-status.ts`.                                                                                                                                                                                         |
| App Sites order endpoints            | `apps/app/app/routes/resources+/sites.order.checkout.ts`, `sites.order.status.ts` (with tests)                                      | Model for `sites.reservation.checkout.ts` and `.status.ts`.                                                                                                                                                                                                                   |

Do not copy:

- `createConnectPlatformCustomer` (`commerce.ts:560-575`): it sends name, email
  and phone from the App. Reservation Customers carry no PII.
- `apps/app/app/utils/shop.server.ts` legacy shop helpers that open the tenant
  DB from the App.
- `calculateShopFees` (20%).

## 3. US-only guards to know about

Removed in `payment-mocks` (the three Checkout.com guards):

1. `apps/app/app/components/settings/cards/organization/shop-card.tsx:78-84`:
   non-US orgs see "Shop payouts are available for US organizations only"
   instead of the payout panel (`isUsRegion` at `:43`).
2. `settings+/shop.tsx:215-222`: intent `invite-checkout-payout` redirects with
   "US only".
3. `apps/app/app/utils/shop.server.ts:333-335`:
   `inviteCheckoutSubEntityOnboarding` throws for non-US orgs.

Keep (they are correct):

- `settings+/shop.tsx:153` (`connect-payout`): Stripe Connect is US only.
- `settings+/shop.tsx:274` (`enable-hosted-checkout`): the legacy single-product
  shop. Not part of reservations.
- `resolveRestaurantOnlinePayment`: Connect fails closed outside the US.

After the change, the shop card must still hide the Stripe button for KSA and
show only Checkout.com there.

## 4. Organization payment columns (control plane)

`Organization` in `packages/database/src/schema.ts` (around `:2427-2441`):
`stripeConnectAccountId`, `stripeConnectChargesEnabled`,
`stripeConnectPayoutsEnabled`, `checkoutSubEntityId`, `checkoutChargesEnabled`,
`checkoutPayoutsEnabled`, `shopPaymentProvider` (default `'stripe'`, normalized
to `connect`; set to `'checkout'` on invite).

- No per-capability state is mirrored. `charges_enabled` reflects
  `card_payments`; destination transfers also need `transfers: active`. Check
  both at charge time.
- The App reads local D1. Writing only `packages/database/db/data.db` does not
  open the gate. With the emulator, use the onboarding helper instead of SQL.

## 5. Stripe Connect call shapes (destination charges)

All calls run on the platform account (no `stripeAccount` header, no
`on_behalf_of`). Customers, PaymentMethods, PaymentIntents, refunds and disputes
live on the platform.

Deposit, prepay, experience ticket (`mode: 'payment'`):

```ts
stripe.checkout.sessions.create(
	{
		mode: 'payment',
		payment_method_types: ['card'],
		line_items: [
			{
				quantity,
				price_data: {
					currency: 'usd',
					unit_amount,
					product_data: { name: 'Reservation deposit' },
				},
			},
		],
		payment_intent_data: {
			application_fee_amount: platformFeeMinor,
			transfer_data: { destination: acctId },
			statement_descriptor_suffix: orgShort,
			metadata: { type: 'reservation_payment', orgId, reservationId, purpose },
		},
		metadata: { type: 'reservation_payment', orgId, reservationId, purpose },
		success_url,
		cancel_url,
		expires_at, // 30 min .. 24 h from now
		custom_text: { submit: { message } }, // amounts and windows only, <= 1200 chars
	},
	{ idempotencyKey },
)
```

Card guarantee (`mode: 'setup'`):

```ts
const customer = await stripe.customers.create(
  { metadata: { orgId, guestRef } },   // no name, email or phone
  { idempotencyKey: `reservation_customer_${sha(orgId|guestRef)}` })
stripe.checkout.sessions.create({
  mode: 'setup', currency: 'usd', payment_method_types: ['card'],
  customer: customer.id,
  setup_intent_data: { metadata: { type: 'reservation_payment', orgId, reservationId, purpose: 'guarantee' } },
  metadata: { ... }, custom_text: { submit: { message: consentText } },
  success_url, cancel_url, expires_at,
}, { idempotencyKey })
// completion: sessions.retrieve(id, { expand: ['setup_intent'] }); setup_intent.status === 'succeeded'
```

Off-session fee:

```ts
stripe.paymentIntents.create(
	{
		amount,
		currency,
		customer,
		payment_method,
		off_session: true,
		confirm: true,
		payment_method_types: ['card'],
		application_fee_amount,
		transfer_data: { destination: acctId },
		statement_descriptor_suffix: orgShort,
		metadata: { type: 'reservation_fee', orgId, reservationId, purpose, feeId },
	},
	{
		idempotencyKey: `reservation_fee_${sha(orgId | reservationId | feeId | attempt)}`,
	},
)
```

- `StripeCardError` with `code: 'authentication_required'`: the PaymentIntent is
  in `error.raw.payment_intent` (status `requires_payment_method`). Report
  `requires_action`, then cancel it with `paymentIntents.cancel`.
- `card_declined` carries `decline_code`. Report `failed`.
- `withConnect` currently rewraps every error as a plain `Error`, which loses
  `type`, `code`, `decline_code` and `raw.payment_intent`. It must be fixed
  before fees can work (`payment-mocks`).

Refund:

```ts
stripe.refunds.create(
	{
		payment_intent,
		amount, // omit amount for a full refund
		reason: 'requested_by_customer',
		reverse_transfer: true,
		refund_application_fee: true,
		metadata: {
			type: 'reservation_refund',
			orgId,
			reservationId,
			refundRequestId,
		},
	},
	{ idempotencyKey: `reservation_refund_${sha(orgId | refundRequestId)}` },
)
```

- `refund_application_fee` only works together with `reverse_transfer` on
  destination charges, and it returns the fee proportionally.
- A refund can be `pending`, then `succeeded` or `failed` (`refund.updated`,
  `refund.failed`). Stripe keeps its processing fee; the platform pays it.

Webhook events to handle: `checkout.session.completed`, `.expired`,
`.async_payment_succeeded`, `.async_payment_failed`, `setup_intent.succeeded`,
`payment_intent.succeeded`, `.payment_failed`, `charge.refunded`,
`refund.updated`, `refund.failed`, `charge.dispute.created`, `.closed`,
`account.updated` (a Connect event, signed by the second secret).

## 6. Checkout.com call shapes (Hosted Payments Page)

Deposit, prepay, ticket (`POST /hosted-payments`, SDK `hostedPayments.create`):

```json
{
	"amount": 12000,
	"currency": "SAR",
	"reference": "reservation_payment:<orgId>:<reservationId>",
	"description": "Reservation deposit",
	"processing_channel_id": "pc_...",
	"billing": { "address": { "country": "SA" } },
	"success_url": "...",
	"failure_url": "...",
	"cancel_url": "...",
	"metadata": {
		"type": "reservation_payment",
		"orgId": "...",
		"reservationId": "...",
		"purpose": "deposit"
	},
	"amount_allocations": [
		{ "id": "ent_...", "amount": 12000, "commission": { "amount": 0 } }
	]
}
```

- Response 201: `{ id: 'hpp_...', reference, _links: { self, redirect } }`.
  Redirect to `_links.redirect.href`.
- The redirect back carries `cko-session-id=sid_...`; treat it as a hint.
- Status without a webhook: `GET /hosted-payments/{hpp}`, then
  `GET /payments/{pay_or_sid}` (paid when `approved === true` or status
  `Authorized`/`Captured`). Check metadata `orgId`/`reservationId`, amount,
  currency and reference.
- Pass a `Cko-Idempotency-Key` on payments and refunds. Orders pass none today
  (`checkout.server.ts:407-416` only passes keys for Connect).

Card guarantee: HPP with `payment_type: 'Unscheduled'` and store-for-future use.
Keep `source.id` (`src_...`), the CIT payment id (`pay_...`, the future
`previous_payment_id`) and `customer.id`.

Fee (MIT, `POST /payments`):

```json
{ "source": { "type": "id", "id": "src_..." }, "merchant_initiated": true,
  "payment_type": "Unscheduled", "previous_payment_id": "pay_...",
  "amount": 5000, "currency": "SAR", "processing_channel_id": "pc_...",
  "reference": "...", "amount_allocations": [ ... ] }
```

- Declines return 201 with `approved: false`, `status: 'Declined'` and a
  `response_code`. Validation errors return 422 `request_invalid`.

Refund: `POST /payments/{id}/refunds` with `amount`, `reference` and reversal
`amount_allocations` (commission reversed proportionally). Returns 202 with an
`action_id`; the outcome arrives as `payment_refunded` /
`payment_refund_declined` or in `GET /payments/{id}/actions`.

Webhook signature: `cko-signature` = hex HMAC-SHA256 of the raw body with
`CHECKOUT_WEBHOOK_SECRET`. Events: `payment_approved`, `payment_captured`,
`payment_declined`, `payment_pending`, `payment_refunded`,
`payment_refund_declined`.

KSA caveats: mada (domestic debit, often co-badged) has limited
stored-credential and MIT support, and 3DS is effectively mandatory for
customer-initiated payments. Guarantees and fees on Checkout.com are best
effort. A failed MIT falls back to the pay link. KSA policy forms show "Prepaid
deposits are recommended in this region".

## 7. Money rules

- Amounts are integer minor units everywhere (cents, halalas).
- Currency comes from the location (`USD | CAD | SAR`), not the region.
- Stripe: USD and CAD only here; minimum 50 minor units. SAR is never sent to
  Stripe.
- Checkout.com: SAR (and USD); upper-case currency codes.
- Use the same currency for a guarantee and the later fee.
- `platformFeeMinor = floor(amountMinor * bp / 10000)`; refunds reverse
  `round(platformFeeMinor * refundMinor / amountMinor)`.
- Fee amounts come from the booking-time policy snapshot (per cover or flat),
  clamped to the cap and to a lower operator amount, and at or above the
  currency minimum.
- Regional rejects a refund above `amount_minor - refunded_minor` before the App
  calls a provider.

## 8. Idempotency keys

| Call                                    | Key                                                                                                  |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Payment or setup session                | `reservation_<purpose>_<sha256(orgId\|reservationId\|purpose\|amount\|CUR\|paymentExpiresAt)[0:40]>` |
| PII-free Stripe Customer                | `reservation_customer_<sha(orgId\|guestRef)>`                                                        |
| Fee charge                              | `reservation_fee_<sha(orgId\|reservationId\|feeId\|attempt)>`                                        |
| Refund                                  | `reservation_refund_<sha(orgId\|refundRequestId)>`                                                   |
| Late-payment refund                     | `reservation_late_refund_<paymentRef>`                                                               |
| Regional `rsv_payments.idempotency_key` | `rsv:<reservationId>:<kind>:<attempt>`                                                               |

- Stripe keeps keys for about 24 hours. The same key with different parameters
  raises `idempotency_error`, so a key must include every quote fact that can
  change.
- The regional single-shot claim (`fee-claim`, `refund-claim`, bind once) is the
  real duplicate guard. Use a new `attempt` only after a terminal failure.

## 9. Stripe session rules that catch bugs

- `expires_at` must be 30 minutes to 24 hours from now. Use
  `max(now + 31 min, paymentExpiresAt)`. With `payment_hold_minutes` defaulting
  to 20, a session can outlive the hold, so late payments are real
  (architecture.md 12.4 item 6).
- Setup mode needs `currency` or `payment_method_types`; pass both.
- `custom_text.submit.message` is at most 1200 characters.
- Force `payment_method_types: ['card']`; dynamic methods add Link and others to
  the hosted page and are not chargeable off-session.
- An off-session PaymentIntent needs a PaymentMethod attached to the same
  Customer.
- Scope every Customer to `(orgId, guestRef)`. Never reuse one across orgs.

## 10. Test cards (same numbers in the emulator)

Stripe (any future expiry, any CVC, ZIP 94103):

| Card                  | Behavior                                                                      |
| --------------------- | ----------------------------------------------------------------------------- |
| `4242 4242 4242 4242` | Success, no 3DS; later off-session charges succeed                            |
| `4000 0025 0000 3155` | 3DS at setup; later off-session charges succeed (canonical guarantee)         |
| `4000 0027 6000 3184` | 3DS at setup; off-session fee fails `authentication_required` (pay-link test) |
| `4000 0000 0000 0341` | Setup succeeds; later charge declines (`generic_decline`)                     |
| `4000 0000 0000 9995` | `insufficient_funds`; cannot be attached, so setup fails                      |
| `4000 0000 0000 0002` | `card_declined generic_decline`                                               |
| `4000 0082 6000 3178` | 3DS, then `insufficient_funds`                                                |
| `4000 0000 0000 7726` | Refunds go `pending` then `succeeded`                                         |
| `4000 0000 0000 5126` | Refunds go `pending` then `failed`                                            |
| `4000 0000 0000 0259` | Charge succeeds, then a dispute                                               |

Server-side PaymentMethod tokens: `pm_card_visa`,
`pm_card_authenticationRequired`, `pm_card_chargeCustomerFail`,
`pm_card_visa_chargeDeclinedInsufficientFunds`, `pm_card_threeDSecure2Required`.

Checkout.com: Visa `4242424242424242` and Mastercard `5436031030606378`
(frictionless); Visa `4543474002249996` and Mastercard `5352151570003404` (3DS,
password `Checkout1!`); amount-based declines (ending `05` -> 20005, `51` ->
20051, `12` -> 20012, `54` -> 20054, for example SAR 10.05 = `1005`); a
mock-only mada card that approves CIT and declines MIT (`20046`).

## 11. PII rules for provider payloads

- Stripe Checkout always collects an email and writes it onto the Customer;
  billing name and postal code come with the card. Checkout.com HPP collects
  similar data. It goes browser to provider directly.
- The App still receives it in webhook payloads (`customer_details`,
  `billing_details`, `receipt_email`) and in retrieved objects. Map each
  verified event to an ids-and-amounts DTO at once; never persist raw events;
  never log payloads or full error objects; never `expand` customer or billing
  details.
- Card brand, last4 and expiry are display facts; they are stored only in the
  regional `rsv_payments` setup row.
- Tests assert payload key sets for every internal payment call.

## 12. Gotchas

1. One Stripe webhook secret cannot verify both platform and Connect events in
   production. `getStripeWebhookSecrets()` fixes this.
2. `withConnect` flattens Stripe errors (see section 5). Side effect today:
   `attachPaymentMethodToCustomer` (`commerce.ts:577-595`) checks
   `error.code === 'resource_already_exists'` on an error that already lost its
   `code`, so that branch never matches. The fix makes it work.
3. Checkout.com order checkout calls Flow `paymentSessions.request`, which has
   no redirect link, so it would fail with `checkout_session_unavailable`.
   Orders move to `hostedPayments.create` in `payment-mocks`.
4. The Checkout.com order webhook mapper needs `processing.payment_session_id`,
   which HPP payments may not carry. Match on the HPP id or reference instead.
5. `CHECKOUT_SECRET_KEY` must match the sandbox key pattern for the SDK to add
   `Bearer`; the SDK picks sandbox or live from the key, not from
   `CHECKOUT_ENVIRONMENT`. The emulator's synthetic key matches.
6. `CHECKOUT_SUBDOMAIN` must match `^(?:pl-)?[a-z0-9]+$` or the SDK silently
   falls back to the default host.
7. `isProcessorConfigured('checkout')` needs secret key, public key, subdomain
   and processing channel, even though hosted flows use only two.
8. The `.dev.vars` file is regenerated on every App dev start by
   `apps/app/scripts/sync-dev-vars.mjs`; `apps/app/.env.local` is not
   gitignored. Never put keys in either.
9. MSW Stripe handlers in `packages/test-utils/src/mocks/stripe.ts` are
   passthrough; do not add Stripe mocks there. The emulator is the mock.
10. Unit tests that `vi.mock('#app/utils/shop.server.ts')`
    (`checkout.server.test.ts:57`) never exercise a provider response. Prefer
    `configureShopCommerceForTests(env, { emulator })` for new tests.
11. Destination charges without `on_behalf_of` show the platform's statement
    descriptor; set `statement_descriptor_suffix` from a sanitized org short
    name to reduce "unrecognized charge" disputes on fees.
12. Do not assert "paid" on a redirect. Assert through the status endpoint and
    the regional state.
13. Disputes are reported only (`payment_status = disputed`, manager alert). No
    evidence submission is built.
14. Card authorizations expire in about 7 days, so manual-capture holds are not
    used; setup mode covers any lead time.
