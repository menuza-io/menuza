# Reservations planning: payments deep dive (Stripe Connect, Checkout.com)

Scope: what exists today for processor payments, and a concrete design for
reservation deposits, prepaid Experiences, card guarantees with no-show and
late-cancel fees, and refunds. It also covers how to validate all of this
locally against real Stripe test mode. This report builds on section 4 of
`ordering-locations-sites-payments.md` and does not repeat it. Paths are
relative to `/Users/zama/menuza` unless they are absolute.

I did not modify any repository file. The local databases were queried read-only
(`sqlite3 -readonly`, `mode=ro`). Secret values were never printed. Only whether
a value is present, empty, or a placeholder is reported.

---

## 1. Stripe in the App today

### SDK and client construction

- SDK: `stripe` `^18.5.0` (installed version 18.5.0) in `apps/app`, `apps/admin`
  and `packages/payments`. The API version is pinned to `'2025-08-27.basil'` in
  `packages/payments/src/providers/stripe.ts:35-39`. The client uses
  `httpClient: Stripe.createFetchHttpClient()`, which works on Workers.
- There are two Stripe client instances in the App:
  1. **SaaS billing**: `apps/app/app/utils/payments.server.ts:35-38` calls
     `createStripeProvider(process.env.STRIPE_SECRET_KEY)` and exports `stripe`.
     The webhook route uses this client only for
     `stripe.webhooks.constructEvent`.
  2. **Tenant commerce** (shop, restaurant orders): `getShopCommerce()` in
     `apps/app/app/utils/shop.server.ts:41-53`. It is built once, when the
     module loads, from
     `createShopCommerce(createShopCommerceConfigFromEnv(process.env))`. The
     `ShopCommerce` class is in `packages/payments/src/shop/commerce.ts`; it
     creates its Stripe client lazily in `getStripe()` at lines 266-274.
- `createShopCommerceConfigFromEnv` (`packages/payments/src/shop/config.ts`)
  treats any value that contains `***` as **not configured** (the
  `isConfiguredSecret` check). The schema placeholders `sk_test_***`,
  `pk_test_***` and `whsec_***` therefore leave Connect unconfigured.
  `isProcessorConfigured('connect')` returns false, and order checkout fails
  closed with `409 online_payment_unavailable`.
- `validateStripeKeys` is `MOCKS !== 'true' && NODE_ENV !== 'test'`. When it is
  on, `assertStripePublishableKey` checks that the publishable key matches the
  secret key in both mode (test or live) and account. With `MOCKS=true` this
  check is skipped. The check only runs in the inline-card shop flow.

### Environment variables (App)

These are defined in `apps/app/.env.schema`:

| Var                                                                                                                                                                 | Purpose                                               | Schema default                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------- |
| `STRIPE_SECRET_KEY`                                                                                                                                                 | Platform secret key, used for all Connect calls       | `sk_test_***` placeholder, `@required` |
| `STRIPE_PUBLISHABLE_KEY`                                                                                                                                            | Inline Elements for the legacy shop only              | `pk_test_***`                          |
| `STRIPE_WEBHOOK_SECRET`                                                                                                                                             | The only webhook signing secret                       | `whsec_***`                            |
| `STRIPE_PORTAL_URL`                                                                                                                                                 | SaaS billing portal                                   | placeholder                            |
| `CHECKOUT_SECRET_KEY`, `CHECKOUT_PUBLIC_KEY`, `CHECKOUT_SUBDOMAIN`, `CHECKOUT_PROCESSING_CHANNEL_ID`, `CHECKOUT_ENVIRONMENT` (`sandbox`), `CHECKOUT_WEBHOOK_SECRET` | Checkout.com                                          | empty                                  |
| `POLAR_*`                                                                                                                                                           | Polar merchant of record (not usable for restaurants) | empty                                  |

- There is **no Connect client id** (`ca_...`). Onboarding uses Account Links,
  not OAuth.
- There is **no separate Connect webhook secret** (see section 2, webhooks).
- tenant-api and Sites have no Stripe variables. Only App and Admin hold
  processor secrets.

### Env files (presence only)

| File                                         | Stripe                                                                                                                           | Checkout.com                                     | MOCKS  |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------ |
| `apps/app/.env` (gitignored)                 | absent                                                                                                                           | absent                                           | `true` |
| `apps/app/.env.development`                  | absent                                                                                                                           | absent                                           | `true` |
| `apps/app/.env.test`                         | absent                                                                                                                           | absent                                           | absent |
| `apps/app/.dev.vars` (gitignored, generated) | `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY` and `STRIPE_WEBHOOK_SECRET` are set to the **schema placeholders** (contain `***`) | `CHECKOUT_ENVIRONMENT=sandbox` only; keys absent | `true` |

There are no real Stripe or Checkout.com credentials anywhere locally.

`.dev.vars` is regenerated on every `npm run dev -w app` by
`apps/app/scripts/sync-dev-vars.mjs`, which runs
`varlock load --env development`. Manual edits to `.dev.vars` are overwritten.
Real keys must go into a varlock source:

- `apps/app/.env` is the safe choice because it is gitignored.
- `apps/app/.env.local` is **not** gitignored. `git check-ignore` confirms it,
  so do not put keys there.

### MSW and `MOCKS`: Stripe is not mocked

- `packages/test-utils/src/mocks/stripe.ts` registers handlers for
  GET/POST/PUT/DELETE/PATCH `https://api.stripe.com/*`. Every handler returns
  `passthrough()`, and `packages/test-utils/src/mocks/index.ts` also lists
  `api.stripe.com` and `stripe.com` in `bypassUrls`. **MSW never fakes a Stripe
  response.** Every Stripe call goes to the real API.
- MSW only starts in the **Node** entry: `apps/app/index.ts:19-21`
  (`if (process.env.MOCKS === 'true') await import('./tests/mocks/index.ts')`).
  The scripts that use it are `dev:node`, `dev:all-mocks`, `start:mocks`
  (Playwright in CI) and Vitest via `@repo/test-utils`.
- The default `npm run dev` (`apps/app/package.json:16`) runs `vite dev` with
  the Cloudflare plugin (workerd, entry `apps/app/workers/app.ts`). It sets
  `MOCKS=true`, but **MSW is not loaded at all** in that runtime.
- Conclusion: **real Stripe test mode works locally with `MOCKS=true` left on.**
  Supplying real `sk_test_`/`pk_test_` keys is enough. There is no Stripe-only
  mock switch because none is needed. Keep `MOCKS=true` so the other dev mocks
  keep working.
- What `MOCKS=true` controls in the App:
  - Node-mode MSW captures Resend and OCI email
    (`packages/email/src/send-email.ts:161`,
    `packages/email/src/oci/mock-transport.ts`).
  - Mock GitHub/Google OAuth (`packages/auth/src/mock-oauth.server.ts`).
  - Cookie domain relaxation
    (`packages/common/src/cookie-domain.server.ts:114`).
  - The dev S3 mock (`apps/app/workers/dev-s3-mock.ts`).
  - Places autocomplete fixtures.
  - POS and review-integration sandboxes (`packages/integrations/*`).
  - Signup and forgot-password checks.
  - Skipping Stripe key validation.
- Unit tests mock `#app/utils/shop.server.ts` with `vi.mock`
  (`checkout.server.test.ts:57`), so they never call Stripe.

---

## 2. Stripe Connect today

### Account type and onboarding

- **Express** accounts: `createConnectExpressAccount` in
  `packages/payments/src/connect/stripe-connect.ts:17-38` calls
  `accounts.create` with:
  - `type: 'express'`, `country: 'US'`, `business_type: 'company'`
  - `capabilities: { card_payments: { requested: true }, transfers: { requested: true } }`
  - `metadata: { organizationId, organizationName }`
- Onboarding uses **Account Links** (`accountLinks.create`,
  `type: 'account_onboarding'`), not OAuth. `startConnectOnboarding`
  (`apps/app/app/utils/shop.server.ts:241-292`):
  - creates the account once and claims it race-safely with
    `UPDATE ... WHERE stripeConnectAccountId IS NULL`;
  - uses `/<slug>/settings/shop?connect=return|refresh` as the return and
    refresh URLs.
- UI: `apps/app/app/routes/_app+/$orgSlug_+/settings+/shop.tsx`:
  - intent `connect-payout`: US only, rate-limited to one call per 30 s, needs
    `UPDATE_SETTINGS_ANY`;
  - intent `open-payout-dashboard`: an Express login link.
- The loader calls `syncConnectAccountStatus` (`accounts.retrieve`) when it sees
  `?connect=return|refresh`. This lets local onboarding complete **without
  webhooks**.

### Storage (control plane, `Organization`)

The columns are in `packages/database/src/schema.ts:2427-2441`:

- `stripeConnectAccountId` (text)
- `stripeConnectChargesEnabled` (boolean, default false)
- `stripeConnectPayoutsEnabled` (boolean, default false)
- `checkoutSubEntityId`, `checkoutChargesEnabled`, `checkoutPayoutsEnabled`
- `shopPaymentProvider` (text, default `'stripe'`, which normalizes to
  `connect`)

There is no per-capability state. Only `charges_enabled` and `payouts_enabled`
are mirrored, and `transfers` is not tracked separately.

### Seeded `acme` org (read-only query)

| DB                                                                                    | id                         | region | provisioned | published | provider | Connect id | charges | Checkout.com |
| ------------------------------------------------------------------------------------- | -------------------------- | ------ | ----------- | --------- | -------- | ---------- | ------- | ------------ |
| D1 `apps/app/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/a36f84ea...6006.sqlite` | `t58bgatqh3rv0s3movrecyj1` | us     | 1           | 1         | stripe   | **none**   | 0       | none         |
| `packages/database/db/data.db`                                                        | same                       | us     | 1           | 1         | stripe   | **none**   | 0       | none         |

The other two seeded orgs are unprovisioned and unpublished. No org has a
Connect account or a Checkout.com sub-entity.

Which copy matters for payments:

- App (workerd) reads D1. Payment gating (`/resources/order-context`, checkout)
  therefore uses the **D1** copy.
- Local tenant-api reads `packages/database/db/data.db` first for Origin-to-org
  resolution (`apps/tenant-api/src/lib/origin.ts:6,102`), then falls back to
  `APP_URL`. It gets `onlinePayment` from App order-context.

Linking the org in D1 is what matters. Update both copies to keep them
consistent.

### How `onlinePayment.enabled` is computed

`resolveRestaurantOnlinePayment` in
`apps/app/app/utils/restaurant-orders/payment-config.server.ts:46-77`:

- **connect**: `dataRegion === 'us'` AND `stripeConnectAccountId` AND
  `stripeConnectChargesEnabled`. KSA fails closed.
- **checkout**: `checkoutSubEntityId` AND `checkoutChargesEnabled`, in any
  region.
- **polar/mor**: never.

The result is embedded in `/resources/order-context`
(`apps/app/app/routes/resources+/order-context.ts:131`). That route
authenticates with the internal command token. The regional
`order-service.ts:416` then refuses `paymentMethod: 'online'` when the result is
disabled. Platform secrets are checked separately at session creation:
`commerce.isProcessorConfigured(processor)` in `checkout.server.ts:345`.

### Charge model: destination charges on the platform with a 20% application fee

`createShopCheckoutSession` (`stripe-connect.ts:77-133`):

- calls `stripe.checkout.sessions.create` on the **platform account**. There is
  **no `stripeAccount` header**, so these are not direct charges.
- parameters:
  - `mode: 'payment'`, one `price_data` line item
  - `payment_intent_data: { application_fee_amount, transfer_data: { destination: acct }, metadata }`
  - `metadata`, `success_url`, `cancel_url`, optional `expires_at`
  - an idempotency key
- **no `on_behalf_of`**, so the platform is the settlement merchant. The
  statement descriptor and Radar are the platform's.
- **no `payment_method_types`**, so dynamic payment methods apply. Checkout may
  show an accordion (Link, Cash App Pay and others).

Fee: `calculateShopFees` uses `SHOP_PLATFORM_FEE_PERCENT = 20`
(`packages/payments/src/connect/shop-fees.ts`). Restaurant orders inherit this
20% application fee.

Consequence: Customers, PaymentMethods, PaymentIntents, Refunds and disputes all
live on the **platform** account. Funds move to the connected account by
transfer.

### Order session creation details

`createRestaurantOrderHostedCheckout` (`checkout.server.ts:324-484`):

- product name `Restaurant order`
- metadata `{ type: 'restaurant_order', orgId, orderId }`
- `customerEmail: null`
- `expires_at` from the hold, or omitted if the hold ends sooner than 31 min
  from now
- idempotency key
  `restaurant_order_<sha256(orgId|orderId|amount|CUR|holdExpiresAt)[0:40]>`
  (`packages/payments/src/shop/restaurant.ts:98-113`)
- bind once regionally. If the bind fails, the session is expired
  (`checkout.sessions.expire`) and the winning session is recovered.

### Webhooks

There are two endpoints:

1. **Stripe**: `POST /api/stripe/webhook`
   (`apps/app/app/routes/api+/stripe+/webhook.tsx`).
   - Verified with
     `stripe.webhooks.constructEvent(payload, sig, process.env.STRIPE_WEBHOOK_SECRET)`,
     using **one secret**.
   - Dispatch:
     - `customer.subscription.*` and `invoice.*` go to SaaS billing.
     - `checkout.session.completed`, `async_payment_succeeded`,
       `async_payment_failed` and `expired` with
       `metadata.type === 'restaurant_order'` go to
       `handleRestaurantOrderStripeSessionEvent`
       (`apps/app/app/utils/restaurant-orders/payment-webhooks.server.ts`).
       Otherwise the event goes to `recordShopOrderFromConnectWebhook`.
     - `payment_intent.succeeded` is skipped for restaurant orders.
     - `account.updated` goes to `handleConnectAccountUpdated`, which uses
       `account.metadata.organizationId` and requires the account id to match.
   - The restaurant dispatcher looks up the org's `dataRegion` (active orgs
     only) and calls regional `/api/orders/payment-status`. It acks permanent
     regional rejections (4xx) and returns 500 on transient ones so Stripe
     retries.
2. **Checkout.com**: `POST /api/shop/webhook`. Verified with `cko-signature`
   (HMAC-SHA256 of the body with `CHECKOUT_WEBHOOK_SECRET`). It dispatches by
   metadata type as well.

**Gap: platform vs Connect events.** With destination charges, all
`checkout.session.*` events are **platform** events. `account.updated` for a
connected account is a **Connect** event. In the Dashboard that needs a separate
"Connected accounts" endpoint, which has its own signing secret. The code
verifies against a single `STRIPE_WEBHOOK_SECRET`, so in production one of the
two event families will fail verification unless both secrets are accepted.
Locally, `stripe listen` forwards both families with one CLI secret, which hides
the problem.

### Browser status poll (works without webhooks)

The path is browser → Sites `/api/orders/payment/status` → App
`POST /resources/sites/order/status` → `getRestaurantOrderPaymentStatus`
(`checkout.server.ts:515-604`):

1. Fetch the regional quote.
2. If a Connect session is bound and the order is not paid, call
   `checkout.sessions.retrieve(sessionId)` on the platform.
3. Map the result with `mapConnectSessionToRestaurantOrder`
   (`paid`/`no_payment_required` → paid, `status === 'expired'` → expired).
4. Check the metadata type and org.
5. Push the terminal state with `notifyRestaurantOrderPaymentStatus`.

Checkout.com has no session-by-id lookup, so it depends on webhooks. A redirect
alone never marks anything paid.

---

## 3. Checkout.com today

### Integration surface

`packages/payments/src/connect/checkout-shop.ts`, SDK `checkout-sdk-node`
`^4.1.0`:

- Client: `new Checkout(secretKey, { pk, subdomain, environment })`.
- Platforms (sub-entities):
  - `platforms.onboardSubEntity({ reference: orgId, contact_details: { invitee: { email } }, is_draft: true })`
    is a hosted invite to the operator's email.
  - `platforms.getSubEntityDetails(id)` maps `capabilities.payments.enabled` and
    `capabilities.payouts.enabled` to the `checkoutChargesEnabled` and
    `checkoutPayoutsEnabled` columns.
- Hosted payment: `paymentSessions.request` with:
  - `amount`, `currency` (upper case), `reference`
    (`restaurant_order:<orgId>:<orderId>`), `description`,
    `processing_channel_id`, `success_url`, `failure_url`
  - `billing.address.country` (`SA`, `CA` or `US`, from the currency)
  - `metadata` plus `productName`
  - `amount_allocations: [{ id: subEntityId, amount, commission: { amount: fee } }]`
    (20% commission)
  - default capture, so no auth-only
- Status: `payments.get(paymentId)` (`approved`, `Authorized`, `Captured`). A
  payment-session id is not retrievable.
- Webhook events: `payment_approved`, `payment_captured`, `payment_declined`,
  `payment_pending`.

### Env and region rules

- Env vars are listed in section 1. **Sandbox credentials are absent.** No
  `CHECKOUT_*` key is set in any env file.
- Region: `resolveRestaurantOnlinePayment` allows Checkout.com in any region,
  KSA included, and SAR maps to billing country `SA`.
- **However**, the settings action that invites a Checkout.com sub-entity
  (`settings+/shop.tsx:215-222`, intent `invite-checkout-payout`) rejects
  `dataRegion !== 'us'` with "US only". A KSA org therefore cannot onboard
  Checkout.com through the UI today, even though the payment gate would allow
  it. This must be fixed before KSA deposits can work.

### What card-on-file and merchant-initiated charges need on Checkout.com

None of this exists yet. At a high level (check against current Checkout.com
docs before building):

- **Save a card at booking.**
  - Use a hosted session with a 0-amount (card verification) or a deposit
    amount.
  - Set `payment_type: 'Unscheduled'` and the store-for-future-use option, so
    the session returns a reusable `src_...` source id plus the scheme
    transaction id.
  - A Checkout.com `customer` object can be referenced by id. Do not send email
    or name from the App. Let the hosted page collect what it needs.
- **Later MIT charge.**
  - `POST /payments` with `source: { type: 'id', id: 'src_...' }`,
    `merchant_initiated: true`, `payment_type: 'Unscheduled'`, and
    `previous_payment_id` (the initial CIT payment).
  - Also `processing_channel_id` and `amount_allocations` to the sub-entity,
    plus an `Idempotency-Key` header.
- **Refunds.** `POST /payments/{id}/refunds` with `amount` and `reference`, and
  reversal `amount_allocations` for platforms.
- **Account setup.** Card-on-file/MIT must be enabled on the processing channel,
  the Platforms product must be enabled on the sandbox, and a webhook signature
  key is needed.
- **KSA caveats.**
  - mada (the domestic debit scheme) has limited or no support for stored
    credentials and MIT. Many Saudi guests carry mada.
  - SAMA rules make 3DS effectively mandatory for customer-initiated card
    payments.
  - Treat KSA no-show fees as "best effort on Visa/Mastercard" and prefer
    prepaid deposits there.

---

## 4. Proposed reservations payment design

### Principles carried over from orders

- The regional tenant-api is authoritative for amounts, policy, holds and state.
  The App holds processor secrets and only ever sees opaque ids, cents and
  currency.
- Provider metadata contains only opaque ids, for example
  `{ type: 'reservation_payment', orgId, reservationId, purpose }`.
- Product and line names are generic: `Reservation deposit`,
  `Experience ticket`, `No-show fee`, `Late cancellation fee`. An Experience
  title can appear because it is control-plane catalog data, not guest data.
  Never use guest names or notes.
- Bind once, keep idempotency keys deterministic, and let terminal states never
  regress.
- Keep the **same charge model as orders**: destination charges on the platform
  with `transfer_data.destination`, so that Customers and saved PaymentMethods
  stay on the platform where the off-session charge also runs.
  - If `on_behalf_of` is ever adopted (so the restaurant becomes the settlement
    merchant and its name appears on the statement), it must be set
    consistently: `setup_intent_data.on_behalf_of` at save time and
    `on_behalf_of` on each later PaymentIntent, both pointing at the same
    account. Stripe ties the saved card's network consent to that merchant.
  - Short of that, use `payment_intent_data.statement_descriptor_suffix` (cards)
    with a sanitized org short name. Seeing the restaurant's name reduces "I
    don't recognize this" disputes on no-show fees.
- New metadata type: `reservation_payment`.
  - `apps/app/app/routes/api+/stripe+/webhook.tsx` and the Checkout.com webhook
    need a new branch that calls a new `handleReservationStripeSessionEvent`.
  - This is a **new tenant-api route family `/api/reservations/*`** (internal
    command auth plus `assertOrgRegion`), mirroring
    `apps/tenant-api/src/routes/order-system.ts`.

### a. Deposit, prepayment and Experience tickets (hosted Checkout, payment mode)

**Guest flow.**

1. The browser creates a pending reservation on regional `POST /reservations`.
   Regional takes a capacity hold with `holdExpiresAt` and returns
   `{ reservationId, receiptToken, paymentToken }`. Only hashes are stored, as
   for orders.
2. The browser calls Sites `POST /api/reservations/payment`, which forwards
   opaque references only to App `POST /resources/sites/reservation/checkout`.
   The body is
   `{ slug|host, reservationId, paymentToken, purpose: 'deposit'|'prepay'|'experience', locale }`.
3. App:
   1. resolves the org by slug or host;
   2. runs `resolveRestaurantOnlinePayment` (or a reservation-specific variant);
   3. calls regional `POST /api/reservations/payment-quote`;
   4. checks `quoteAllowsCheckout`;
   5. recovers a bound session if one exists;
   6. otherwise calls `stripe.checkout.sessions.create` (below);
   7. calls regional `POST /api/reservations/payment-session` (bind once);
   8. returns `{ checkoutUrl, sessionId, processor }`.

Stripe call:

```ts
stripe.checkout.sessions.create({
  mode: 'payment',
  payment_method_types: ['card'],          // deterministic hosted page; cards only
  line_items: [{ quantity: 1, price_data: {
    currency: quote.currency.toLowerCase(), // 'usd' | 'cad'
    unit_amount: quote.amountCents,
    product_data: { name: purpose === 'experience' ? 'Experience ticket' : 'Reservation deposit' },
  }}],
  // Experiences: one line with quantity = tickets and unit_amount = price,
  // so per-ticket partial refunds stay simple.
  payment_intent_data: {
    application_fee_amount: reservationFee(quote.amountCents), // policy decision, see (c)
    transfer_data: { destination: org.stripeConnectAccountId },
    metadata: { type: 'reservation_payment', orgId, reservationId, purpose },
    // Deposit plus guarantee in one step (optional):
    // setup_future_usage: 'off_session'  (requires `customer`, see b)
    // customer: cus_xxx
  },
  metadata: { type: 'reservation_payment', orgId, reservationId, purpose },
  success_url: `${site}/reservations/success?reservation=${id}`,
  cancel_url: `${site}/reservations`,
  expires_at: max(now + 31min, holdExpiresAt),   // Stripe: 30 min to 24 h
  custom_text: { submit: { message: policySummary } }, // amounts and windows only
}, { idempotencyKey: `reservation_${purpose}_${sha256(orgId|reservationId|purpose|amount|CUR|holdExpiresAt).slice(0,40)}` })
```

**Regional authority.**

- `payment-status` accepts terminal events only when the session id, processor,
  amount and currency match the bound session. Duplicate events are idempotent.
- **Late payment after hold expiry.** Stripe's 30-minute minimum session
  lifetime makes this reachable when holds are shorter. Regional tries to
  re-acquire the slot atomically:
  - if it succeeds, it returns `outcome: 'confirmed'`;
  - otherwise it returns `outcome: 'refund_required'`. On `refund_required`, App
    immediately calls `refunds.create` (full amount, `reverse_transfer: true`,
    `refund_application_fee: true`, idempotency key
    `reservation_late_refund_<pi>`) and then reports `refund-result`. Use
    `payment_review` only if the refund call fails, so an operator can step in.
    The status poll and the webhook paths both carry this outcome. Simpler
    alternative: make reservation holds at least 31 minutes so the Stripe
    session never outlives the hold.
- An expired session clears the binding so a retry can create a new one, as
  orders do.

**Refund on eligible guest cancellation.**

1. The guest cancels in the browser via regional `POST /reservations/:id/cancel`
   (receipt or customer token).
2. Regional computes eligibility in the location time zone: a full refund before
   `cancelWindowMinutes`, a partial refund or none after it. Experiences can be
   non-refundable. Regional writes a `reservation_refunds` row
   `{ id, amountCents, reason, status: 'requested' }`.
3. Two paths trigger the refund:
   - browser nudge: Sites calls App
     `POST /resources/sites/reservation/refund { reservationId, paymentToken }`;
   - reliability: an App jobs-cron route `/resources/jobs/reservation-refunds`
     pulls pending refunds from every regional node.
4. App calls `POST /api/reservations/refund-claim` to obtain
   `{ paymentIntentId, amountCents, currency, refundRequestId }`, then calls
   Stripe, then calls `refund-result`.

### b. Card guarantee (Checkout setup mode), no-show and late-cancel fees

**Customer without PII.**

- Every Customer field is optional. Create one with **no name, email or phone**:

  ```ts
  stripe.customers.create(
  	{ metadata: { orgId, guestRef } }, // guestRef = regional opaque id (HMAC), never contact data
  	{ idempotencyKey: `reservation_customer_${sha(orgId | guestRef)}` },
  )
  ```

- The Customer lives on the platform (destination-charge model), so it must be
  **scoped to (org, guest)**. Never reuse one Customer across orgs.
- Regional stores the `cus_...` id, either on the customer row or on the
  reservation for guests without an account. It returns the id in the quote only
  when the App needs it.
- Do **not** copy `createConnectPlatformCustomer` (`commerce.ts:560-575`). It
  sends name, email and phone from the App.

Setup session:

```ts
stripe.checkout.sessions.create(
	{
		mode: 'setup',
		currency: quote.currency.toLowerCase(), // required in setup mode unless payment_method_types is set
		payment_method_types: ['card'], // cards only: chargeable off-session
		customer: cusId,
		setup_intent_data: {
			metadata: {
				type: 'reservation_payment',
				orgId,
				reservationId,
				purpose: 'guarantee',
			},
			description: 'Reservation card guarantee',
			// on_behalf_of: acct  // only if adopting OBO everywhere
		},
		metadata: {
			type: 'reservation_payment',
			orgId,
			reservationId,
			purpose: 'guarantee',
		},
		custom_text: { submit: { message: consentText } }, // see gotchas
		success_url,
		cancel_url,
		expires_at,
	},
	{
		idempotencyKey: `reservation_guarantee_${sha(orgId | reservationId | holdExpiresAt)}`,
	},
)
```

Completion:

- `checkout.session.completed` (`mode: 'setup'`) or the status poll retrieves
  the session with `expand: ['setup_intent']`.
- With `setup_intent.status === 'succeeded'`, App reports to regional
  `payment-status`:
  `{ purpose: 'guarantee', sessionId, setupIntentId, paymentMethodId, customerId, cardBrand?, last4?, expMonth?, expYear? }`.
- Brand, last4 and expiry are payment-instrument facts, not contact data. Store
  them **regionally** only, for the host-stand UI and expiry warnings.
- Regional records the consent: timestamp, a hash of the policy text and
  version, the amounts, and the window.

**Does Stripe-hosted collection count as App receiving PII?**

- Checkout **always asks for an email**. When the Customer has none, Checkout
  writes the entered email onto the Customer (Stripe API docs for `customer`).
  Name, postal code and country are collected for the card. All of this goes
  from the guest's browser to Stripe; it does not pass through App servers.
- The App does receive it in two places:
  - webhook payloads (`checkout.session.completed.customer_details`,
    `payment_method.billing_details`, `charge.billing_details`,
    `receipt_email`);
  - full objects returned by `sessions.retrieve` and `paymentIntents.retrieve`.
- Rules for the App:
  1. Map each verified event to an ids-and-amounts DTO immediately and pass only
     that on.
  2. Never persist raw events.
  3. Never log payloads or full error objects that embed them. Today's code only
     logs on error, so keep it that way.
  4. Subscribe only to the needed event types.
  5. Never `expand` customer or billing details.
- The existing order checkout already has exactly this exposure, so this is not
  a new class of exposure.
- KSA guests never touch Stripe because Connect is US only.
- Alternative that avoids hosted email collection: Stripe Elements (Payment
  Element) on the Sites page with a SetupIntent `client_secret` minted by the
  App. The legacy shop already uses Elements, with a CSP helper in
  `packages/payments/src/shop/client-csp.ts`. The browser talks to Stripe
  directly and no email field is needed. This costs more frontend work and needs
  `STRIPE_PUBLISHABLE_KEY` on Sites.

**Operator-initiated fee (no-show or late cancel).**

1. The host-stand UI (browser) calls regional
   `POST /operator/reservations/:id/fees` with an operator JWT whose scope
   includes `reservations:write`. Regional validates the state
   (`no_show`/`late_cancelled`, a guarantee is on file, no prior fee) and
   computes the amount from the **policy snapshot taken at booking**:
   - `perPersonCents * partySizeAtBooking`, or a flat amount;
   - clamped to `feeCapCents` and to the operator's requested amount, which can
     only go down;
   - at or above the currency minimum (USD/CAD 50).

   It inserts
   `reservation_fees { id, kind, amountCents, currency, status: 'pending' }` and
   returns `{ feeId }`.

2. The browser calls App
   `POST /:orgSlug/reservations/fees/charge { reservationId, feeId }`. This uses
   the operator session and the App re-checks the permission.
3. App calls regional
   `POST /api/reservations/fee-claim { orgId, reservationId, feeId }`. Regional
   moves `pending → charging` atomically, which makes the claim single-shot, and
   returns
   `{ amountCents, currency, customerId, paymentMethodId, kind, attempt }`.
4. App creates the PaymentIntent:

   ```ts
   stripe.paymentIntents.create(
   	{
   		amount,
   		currency,
   		customer: cusId,
   		payment_method: pmId,
   		off_session: true,
   		confirm: true,
   		payment_method_types: ['card'],
   		application_fee_amount: fee(amount),
   		transfer_data: { destination: acct },
   		description:
   			kind === 'no_show' ? 'No-show fee' : 'Late cancellation fee',
   		statement_descriptor_suffix: orgShort,
   		metadata: { type: 'reservation_fee', orgId, reservationId, feeId, kind },
   	},
   	{
   		idempotencyKey: `reservation_fee_${sha(orgId | reservationId | feeId | attempt)}`,
   	},
   )
   ```

5. Outcomes:
   - `status: 'succeeded'` →
     `fee-result { status: 'succeeded', paymentIntentId }`.
   - A `StripeCardError` with `code: 'authentication_required'`: the
     PaymentIntent (`error.raw.payment_intent`) is `requires_payment_method` (or
     `requires_action`) →
     `fee-result { status: 'requires_action', paymentIntentId }`. **Recovery:**
     1. Regional emails or texts the guest a Sites link,
        `/reservations/pay?fee=<feeId>&t=<feePaymentToken>`. Regional has the
        contact data.
     2. The link opens a Checkout payment-mode session for the fee
        (`customer: cusId`), created on demand by App from opaque references,
        following the order pattern.
     3. App cancels the failed off-session PaymentIntent
        (`paymentIntents.cancel`) so it is not left dangling.
   - `card_declined` (with a `decline_code`) →
     `fee-result { status: 'failed', declineCode }`. Regional may allow one
     operator retry with `attempt + 1` and a new key, or offer the same pay-link
     recovery.
6. Idempotency:
   - Stripe keeps idempotency keys for about 24 h, and reusing a key with
     different parameters raises `idempotency_error`.
   - The regional single-shot claim is the real duplicate guard.
   - Use a new `attempt` only after a terminal failure.
7. Disputes are common for no-show fees. Subscribe to `charge.dispute.created`
   and `charge.dispute.closed`, map them by
   `payment_intent.metadata.type === 'reservation_fee'`, and report ids and
   status regionally.

**Optional auth-hold** (bookings within 7 days): use a PaymentIntent with
`capture_method: 'manual'` through a Checkout payment session
(`payment_intent_data.capture_method: 'manual'`), then capture a partial amount
on no-show or cancel the PaymentIntent. Card authorizations expire after about 7
days online. Use this only as a secondary option; SetupIntent covers any lead
time.

### c. Refunds, partial refunds, application fees, currency

**Refunds.**

```ts
stripe.refunds.create({
  payment_intent,
  amount?,                         // omit for full; partial for ticket or policy refunds
  reason: 'requested_by_customer',
  reverse_transfer: true,          // pull the restaurant's share back from the connected account
  refund_application_fee: true,    // proportionally return the platform fee (policy)
  metadata: { type: 'reservation_refund', orgId, reservationId, refundRequestId },
}, { idempotencyKey: `reservation_refund_${sha(orgId|refundRequestId)}` })
```

- Several partial refunds are allowed up to the captured amount.
- Regional tracks `refundedCents` and rejects over-refunds before the App calls
  Stripe.
- A refund can be `pending` and later `succeeded` or `failed`. Handle
  `refund.updated` and `refund.failed` via webhook or a reconciliation job. Test
  cards `4000000000007726` and `4000000000005126` simulate this.
- Stripe does not return its processing fee on refunds. With destination charges
  the **platform** pays it.

**Application fees.**

- Today it is a flat 20% (`SHOP_PLATFORM_FEE_PERCENT`). That is very high for
  deposits and no-show fees and is a product decision.
- Recommend a reservation-specific fee function: 0% or a small percentage, or
  per-cover pricing billed through SaaS billing instead.
- Make sure refunds reverse the fee proportionally. For destination charges,
  `refund_application_fee` only applies together with `reverse_transfer`, so
  verify that combination.

**Currency.**

- Amounts are integer minor units, as today.
- `LocationCurrency` is `USD | CAD | SAR`
  (`packages/common/src/location-currency.ts`).
- The order-context route derives `USD`/`SAR` from the region. Reservations
  should take the currency from the location.
- A US Express account can accept CAD, settled to USD after conversion.
- Stripe minimums: USD and CAD 0.50, SAR about 2.00. SAR is not usable on Stripe
  here anyway.
- SAR only works through Checkout.com, for KSA orgs.
- Use the same currency for the SetupIntent and the later fee.

### d. App-side vs regional, and the internal contract

**App (holds the secret keys).** Every Stripe and Checkout.com API call:

- creating Customers with no PII;
- Checkout payment and setup sessions, and expiring them;
- session and PaymentIntent retrieval;
- off-session PaymentIntents, cancels and refunds;
- webhook verification and dispatch;
- Connect account management.

Rules: no persistence of guest data and no logs of payloads.

**Regional (tenant-api).** Everything else:

- policy (deposit, prepay, guarantee, per person or flat, cap, windows);
- capacity holds, amounts and state machines;
- bind-once and fee claims;
- refund eligibility and requests;
- consent records;
- stored opaque references (`cus_`, `pm_`, `seti_`, `pi_`, `cs_`, `re_`) and
  card display facts;
- guest notifications, including pay links;
- the audit log.

**Internal contract.** All routes are `POST`, use `INTERNAL_COMMAND_TOKEN`, run
`assertOrgRegion` fail-closed, carry ids and amounts only, and return
`private, no-store`. Mirror `regional-order-api.server.ts`.

| Endpoint (tenant-api)               | Request                                                                                                                                                                                                                                               | Response                                                                                                                                                                                                                                                                                     |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/reservations/payment-quote`   | `{ orgId, reservationId, paymentToken, purpose }`                                                                                                                                                                                                     | `{ orgId, reservationId, purpose, mode: 'payment'\|'setup', amountCents, currency, holdExpiresAt, status, paymentStatus, boundSession?: { sessionId, processor }, customerId?, policy: { kind: 'per_person'\|'flat', unitCents, partySize, capCents, cancelWindowMinutes, policyVersion } }` |
| `/api/reservations/payment-session` | `{ orgId, reservationId, purpose, sessionId, processor, customerId? }`                                                                                                                                                                                | `204` or `409 { code: 'already_bound'\|'payment_terminal'\|'hold_expired' }`                                                                                                                                                                                                                 |
| `/api/reservations/payment-status`  | `{ orgId, reservationId, purpose, sessionId, processor, status: 'paid'\|'failed'\|'expired'\|'setup_succeeded', amountCents, currency, paymentIntentId?, setupIntentId?, paymentMethodId?, customerId?, card?: { brand, last4, expMonth, expYear } }` | `{ outcome: 'recorded'\|'duplicate'\|'confirmed'\|'refund_required'\|'review' }`                                                                                                                                                                                                             |
| `/api/reservations/fee-claim`       | `{ orgId, reservationId, feeId }`                                                                                                                                                                                                                     | `{ amountCents, currency, customerId, paymentMethodId, kind, attempt }` or `409`                                                                                                                                                                                                             |
| `/api/reservations/fee-result`      | `{ orgId, reservationId, feeId, attempt, paymentIntentId, status: 'succeeded'\|'requires_action'\|'failed', declineCode? }`                                                                                                                           | `204`                                                                                                                                                                                                                                                                                        |
| `/api/reservations/refund-claim`    | `{ orgId, reservationId?, refundRequestId? }` (a cron sweep omits ids and gets a batch)                                                                                                                                                               | `{ refunds: [{ refundRequestId, reservationId, paymentIntentId, amountCents, currency }] }`                                                                                                                                                                                                  |
| `/api/reservations/refund-result`   | `{ orgId, refundRequestId, refundId, amountCents, status: 'succeeded'\|'pending'\|'failed' }`                                                                                                                                                         | `204`                                                                                                                                                                                                                                                                                        |
| `/api/reservations/dispute-status`  | `{ orgId, reservationId, paymentIntentId, disputeId, status }`                                                                                                                                                                                        | `204`                                                                                                                                                                                                                                                                                        |

App public and operator surfaces:

- `POST /resources/sites/reservation/checkout`,
  `POST /resources/sites/reservation/status`, and
  `POST /resources/sites/reservation/refund`. These are browser-originated
  through Sites forwarding, with opaque references only.
- `POST /:orgSlug/reservations/fees/charge` (operator).
- Jobs: `/resources/jobs/reservation-refunds` and
  `/resources/jobs/reservation-payment-reconcile`. The reconcile job re-checks
  bound sessions that are still pending, because the poll needs a browser.

---

## 5. Testing plan: real end-to-end validation locally

### Credentials the user must provide

1. **Platform test secret key** `sk_test_...` (a full secret key, not a
   restricted `rk_` key). Use a Stripe account, ideally a dedicated **Sandbox**,
   with **Connect enabled** and country **US**.
2. **Publishable key** `pk_test_...` from the same account. It is only needed
   for the legacy shop and Elements, but the schema marks it `@required`.
3. A webhook signing secret is **not** needed from the user.
   `stripe listen --api-key "$STRIPE_SECRET_KEY" --print-secret` prints it
   non-interactively. If the user prefers a Dashboard endpoint, they need a
   public tunnel URL and that endpoint's `whsec_`, plus a second Connect
   endpoint and secret for `account.updated`.

Dashboard steps for the user (test mode or Sandbox):

1. Dashboard, then the account switcher, then **Sandboxes**, then create one (or
   toggle Test mode).
2. **Developers → API keys**: copy the publishable key and reveal the secret
   key.
3. **Connect → Get started**: choose Platform/Marketplace and complete the
   **platform profile**, including the **loss liability / responsibilities**
   review. Without it, `accounts.create` fails with "review the responsibilities
   of managing losses".
4. **Settings → Connect → Branding**: set the business name, icon and color.
   Account Links fail without them.
5. Optional: **Settings → Payment methods**: turn off Link and other methods to
   simplify the hosted page. The design also forces
   `payment_method_types: ['card']`.
6. If `consent_collection.terms_of_service` is used: **Settings → Public
   details**, set a Terms of Service URL.

Put the keys in `apps/app/.env` (gitignored; `.env.local` is not):

```
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...   # from stripe listen --print-secret
```

Restart `npm run dev -w app`. The `sync-dev-vars` step writes them into
`.dev.vars`. Keep `MOCKS=true`.

### A charges-enabled test connected account without manual onboarding

- **Option A (realistic, uses existing code).** On `/acme/settings/shop`, click
  "Connect payout". The App creates an Express account, and the Express
  onboarding page accepts test values:
  - phone: use the test phone, SMS code `000-000`
  - DOB `1901-01-01`, SSN `000-00-0000` (or last 4 `0000`)
  - address line1 `address_full_match`
  - website `https://accessible.stripe.com`
  - bank routing `110000000`, account `000123456789`

  On return, `?connect=return` syncs `charges_enabled` into D1 with no webhook.
  A browser agent can do this, but it is a multi-step form.

- **Option B (fully programmatic, fast and repeatable).** Create a
  **Custom-style** account via the API. Stripe test tokens satisfy verification,
  so `charges_enabled` and `payouts_enabled` become true within seconds:

  ```ts
  stripe.accounts.create({
  	type: 'custom',
  	country: 'US',
  	business_type: 'individual',
  	capabilities: {
  		card_payments: { requested: true },
  		transfers: { requested: true },
  	},
  	business_profile: {
  		mcc: '5812',
  		url: 'https://accessible.stripe.com',
  		product_description: 'Restaurant',
  	},
  	individual: {
  		first_name: 'Test',
  		last_name: 'Owner',
  		email: 'owner@example.com',
  		phone: '0000000000',
  		dob: { day: 1, month: 1, year: 1901 },
  		ssn_last_4: '0000',
  		id_number: '000000000',
  		address: {
  			line1: 'address_full_match',
  			city: 'San Francisco',
  			state: 'CA',
  			postal_code: '94103',
  			country: 'US',
  		},
  	},
  	external_account: 'btok_us_verified',
  	tos_acceptance: { date: Math.floor(Date.now() / 1000), ip: '127.0.0.1' },
  	metadata: {
  		organizationId: 't58bgatqh3rv0s3movrecyj1',
  		organizationName: 'Acme',
  	},
  })
  ```

  Then poll `accounts.retrieve` until `charges_enabled` is true and
  `capabilities.transfers === 'active'`.
  - The charge mechanics (destination charges) are identical to Express.
  - Only `createConnectLoginLink` (the Express dashboard) will not work for a
    Custom account.
  - Express accounts cannot accept ToS through the API, so Option B must use
    Custom, or controller properties with
    `requirement_collection: 'application'`.

- **Link the org locally** (run from `apps/app`). This writes to the local dev
  DB only:

  ```
  npx wrangler d1 execute DB --local --command "UPDATE Organization SET stripeConnectAccountId='acct_...', stripeConnectChargesEnabled=1, stripeConnectPayoutsEnabled=1, shopPaymentProvider='stripe' WHERE slug='acme'"
  ```

  Apply the same `UPDATE` to `packages/database/db/data.db` with `sqlite3` to
  keep it consistent. A KV-cached published site may need a republish if Sites
  caches the payment flag. Check `/resources/order-context?orgId=...` for
  `onlinePayment.enabled: true`.

### Are webhooks required?

- **Deposits and prepay**: the happy path is covered by the redirect and
  `status` poll. Webhooks are required for robustness, for example when a guest
  pays and closes the tab. Locally, test both: with `stripe listen` running, and
  with it stopped (poll only).
- **Guarantee (setup mode)**: the poll can retrieve the session with the
  expanded `setup_intent`. Same caveat as deposits.
- **Off-session fees and refunds**: the API responses are synchronous. Webhooks
  are only needed for `refund.updated`/`refund.failed` and disputes.
- **Connect `account.updated`**: not needed locally (the `?connect=return` sync
  or Option B polling covers it).
- Conclusion: webhooks are not strictly needed for local end-to-end flows, but
  they should be part of the validation.

**Stripe CLI.** It is not installed. The latest release is v1.53.1, and GitHub
is reachable from this machine. Install without root:

```
mkdir -p ~/.local/bin && curl -fsSL https://github.com/stripe/stripe-cli/releases/download/v1.53.1/stripe_1.53.1_linux_x86_64.tar.gz | tar -xz -C ~/.local/bin stripe
~/.local/bin/stripe listen --api-key "$STRIPE_SECRET_KEY" --print-secret        # whsec_ for .env
~/.local/bin/stripe listen --api-key "$STRIPE_SECRET_KEY" \
  --events checkout.session.completed,checkout.session.expired,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,setup_intent.succeeded,payment_intent.succeeded,payment_intent.payment_failed,charge.refunded,refund.updated,refund.failed,charge.dispute.created,account.updated \
  --forward-to http://localhost:3001/api/stripe/webhook
```

- No `stripe login` is needed: `--api-key` (or the `STRIPE_API_KEY` env var)
  works non-interactively.
- Connect events go to the same URL by default (`--forward-connect-to` defaults
  to `--forward-to`).
- Use `--skip-verify` if forwarding to the self-signed
  `https://app.menuza.test:2999` proxy.
- Run it with fireAndForget; it is a long-running process.

### Browser automation on Stripe-hosted Checkout (test mode)

Test cards (any future expiry such as 12/34, any CVC, ZIP 94103):

| Card                           | Use                                                                                                                                                       |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `4242 4242 4242 4242`          | Success, no 3DS. Deposit, guarantee and off-session fee all succeed.                                                                                      |
| `4000 0025 0000 3155`          | "Authenticate unless set up". The 3DS challenge appears at setup or payment; later off-session charges **succeed**. This is the canonical guarantee test. |
| `4000 0027 6000 3184`          | Always authenticate. Setup succeeds after 3DS; the off-session fee fails with **`authentication_required`**. Use it to test the pay-link recovery.        |
| `4000 0000 0000 0341`          | Attaches to the Customer (setup succeeds); later charge **declines**. Off-session decline test.                                                           |
| `4000 0082 6000 3178`          | Needs authentication, then always `insufficient_funds`.                                                                                                   |
| `4000 0000 0000 9995`          | Declines with `insufficient_funds`. **Cannot be attached to a Customer**, so setup mode fails; use it only for deposit-decline tests.                     |
| `4000 0000 0000 7726` / `5126` | Asynchronous refund success / failure.                                                                                                                    |
| `4000 0000 0000 0259`          | Charge succeeds, then a fraud dispute.                                                                                                                    |

Server-side tests can skip the hosted page with `pm_card_visa`,
`pm_card_authenticationRequired`, `pm_card_chargeCustomerFail` and similar
PaymentMethods: attach them to a Customer, then call the off-session
PaymentIntent.

Hosted-page pitfalls:

- The page is `checkout.stripe.com`. Fields are inputs on the page (`#email`,
  `#cardNumber`, `#cardExpiry`, `#cardCvc`, `#billingName`,
  `#billingPostalCode`, `#billingCountry`). Do not hard-code them; snapshot
  first, because Stripe changes markup.
- If `payment_method_types` is not forced to `['card']`, there is an accordion
  and "Card" must be clicked first.
- **Link**: typing an email that has a Link sandbox account triggers an OTP
  prompt. Any 6 digits except `000001`–`000003` succeed. Use fresh
  `+tag@example.com` emails or turn Link off. Untick "Save my information".
- The 3DS test challenge is in nested iframes (`__privateStripeFrame*`, then the
  challenge frame) with "Complete" and "Fail" buttons. Wait for the frames to
  attach.
- After submit there is a processing spinner, then a redirect to `success_url`.
  Locally that is `http://acme.localhost:3008/...` (`getSiteBaseUrl`;
  `PUBLIC_SITE_HOST_SUFFIXES` is empty). Chromium resolves `*.localhost`.
- Do not assert "paid" on the redirect alone. Assert regional state through the
  status poll.
- Test-mode rate limits are stricter. Captcha can be forced with
  `4000 0000 0000 1208`; avoid that card.
- Test mode never sends Stripe receipt emails to real addresses.

---

## 6. Gotchas and risks

1. **Single webhook secret vs platform plus Connect endpoints.** In production,
   `account.updated` (Connect) and `checkout.session.*` (platform) come from
   different endpoints with different secrets. Accept multiple secrets, for
   example a new `STRIPE_CONNECT_WEBHOOK_SECRET`.
2. **The 20% application fee** applies to everything that uses
   `calculateShopFees`. Reservations need their own fee policy and a refund-fee
   policy.
3. **Destination charges without `on_behalf_of`.** The platform is the merchant
   of record for card-network purposes. The statement shows the platform's
   descriptor (dispute risk on no-show fees), and the platform carries disputes
   and negative balances. If `on_behalf_of` is adopted later, SetupIntents and
   PaymentIntents must use the same value.
4. **Capabilities.** `charges_enabled` reflects `card_payments`. Destination
   transfers need `transfers: active`. Gate on both, and add a
   `stripeConnectTransfersActive` mirror or check at charge time.
5. **Setup-mode requirements.**
   - `currency` is required unless `payment_method_types` is set; pass both.
   - Session `expires_at` must be 30 min to 24 h.
   - `custom_text.submit.message` is limited to 1200 characters.
   - `consent_collection.terms_of_service` needs a ToS URL in the Dashboard.
6. **Card-on-file consent.** Card networks and SCA require clear
   merchant-initiated-transaction terms before saving the card. Show the
   restaurant name, the maximum amount (per person times party size, capped),
   the trigger (no-show, or cancellation within N hours), and the time zone.
   Record the consent and policy version regionally. Never charge more than the
   disclosed cap; the regional clamp enforces it.
7. **SCA and off-session.** EEA/UK cards and `3184`-type cards can still demand
   authentication. The pay-link recovery is mandatory, not optional. US cards
   rarely need it.
8. **Stripe will hold guest email, name and postal code** on the platform's
   Customer and PaymentMethod objects. This is collected by Stripe directly,
   which is the same as orders today. Webhook payloads and retrieved objects
   carry it into App memory. Enforce "map to ids, never log or persist". If that
   is unacceptable, use Elements with a SetupIntent instead.
9. **Platform-level Customers across orgs.** Scope every Customer to
   `(orgId, guestRef)` and never reuse it across orgs.
10. **Idempotency keys** expire after about 24 h, and reusing a key with
    different parameters errors. The regional single-shot claim is the real
    guard. Include the quote facts (amount, hold) in session keys, as orders do.
11. **Hold vs the Stripe 30-minute minimum.** A late payment is reachable when
    holds are shorter than 31 min. Use auto-refund or re-acquire, or make holds
    at least 31 min.
12. **KSA.**
    - No Stripe: Connect fails closed.
    - Checkout.com is the only path. The UI blocks Checkout.com onboarding for
      non-US orgs (`settings+/shop.tsx:215-222`).
    - No sandbox credentials exist.
    - Card-on-file and MIT are unimplemented, and mada may not support MIT.
    - Recommendation: KSA v1 is prepaid deposits and Experiences only;
      guarantees are US (Stripe) only.
13. **Card expiry before the reservation date.** Warn the operator regionally
    using the stored exp month and year.
14. **Refunds** can be asynchronous, and Stripe processing fees are not
    returned.
15. **`.env.local` is not gitignored** in `apps/app`. Put keys in
    `apps/app/.env`. `.dev.vars` is regenerated, so do not edit it by hand.
16. **Varlock placeholder detection.** Any value containing `***` is
    "unconfigured". This is useful for a fail-closed check: online payment
    simply stays off until real keys are present.
