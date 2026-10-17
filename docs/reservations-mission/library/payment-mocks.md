# Payment mocks (Stripe Connect and Checkout.com emulators)

**What belongs here:** the full emulator design for milestone `payment-mocks`:
how the GitHub mock works today, activation and production exclusion, code
layout, state, mock pages, card behavior, webhooks, the dev control API, test
harness, risks, and features F1 to F9 with acceptance.

**What does NOT belong here:** reservation payment flows and the regional
contract (see `architecture.md` sections 12 and 13), provider call shapes and
existing payment code (see `library/payments-reference.md`).

Paths are relative to `/home/factory-user/repos/menuza`. Installed SDKs:
`stripe` 18.5.0, `checkout-sdk-node` 4.1.0. "Verify" marks provider behavior
recalled from docs that could not be confirmed; keep those in the fidelity table
(F9).

## 1. Decisions (one line each; see architecture.md section 13)

- No real keys; every payment flow is validated against these emulators.
- Real SDKs talk to an in-process, stateful emulator. No MSW, no fake
  `ShopCommerce`.
- The mock can never be active in production (four exclusion layers).
- Built and validated against existing online ordering (US Stripe order on
  `acme`, KSA Checkout.com order on `riyadh-grill`) before any reservation
  payment uses it.
- This milestone also removes the three US-only Checkout.com guards, moves order
  checkout from Flow to HPP, fixes `withConnect`, adds
  `getStripeWebhookSecrets()`, and lets Sites accept loopback `http:` checkout
  URLs outside production.

## 2. How GitHub login is mocked today (the precedent)

Switches:

| Switch                      | Where                                                                                                                                                                  | Effect                                                             |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `MOCKS=true`                | `apps/app/package.json` scripts `dev`, `dev:node`, `dev:all-mocks`, `start:mocks`; `apps/app/.env.development`; Playwright forces it (`apps/app/playwright.config.ts`) | master mock switch; schema default is `false`                      |
| `GITHUB_CLIENT_ID=MOCK_...` | `packages/auth/.env.schema` defaults                                                                                                                                   | a `MOCK_` client id turns the GitHub mock on even without `MOCKS`  |
| `NODE_ENV=test`             | Vitest                                                                                                                                                                 | also turns the GitHub mock on                                      |
| `CI=true`                   | `npm run test:e2e:run`, GitHub Actions                                                                                                                                 | disables the Workers-dev callback bypass so OAuth goes through MSW |

Flow:

1. `POST /auth/github` (`apps/app/app/routes/_auth+/auth_.$provider.ts`) calls
   `handleMockAction` before `authenticator.authenticate`
   (`packages/auth/src/connections.server.ts`,
   `packages/auth/src/providers/github.server.ts`). It sets a `github` cookie
   with `code` and `state` and 303s to the callback. github.com is never
   visited.
2. Workers vite dev (`npm run dev -w app`): MSW is **not** loaded (the only MSW
   bootstrap is the Node entry `apps/app/index.ts:19-21`; the Worker entry is
   `apps/app/workers/app.ts`). The callback
   (`_auth+/auth.$provider.callback.ts`) uses `isWorkersDevMockOAuthCallback`
   and `tryAuthenticateMockProvider` (`packages/auth/src/mock-oauth.server.ts`),
   which return a fixed profile.
3. Node mock server (Playwright CI, `npm run start:mocks` =
   `cross-env NODE_ENV=production MOCKS=true node index.ts`): MSW
   (`packages/test-utils/src/mocks/index.ts`, `github.ts`) intercepts the real
   `remix-auth-github` calls. Fake users persist in a JSON file under
   `packages/test-utils/fixtures/github/`.
4. Workers-only network mock precedent: `apps/app/workers/dev-s3-mock.ts`,
   installed on every request by `workers/app.ts:29`, guarded by
   `process.env.MOCKS !== 'true' || import.meta.env.PROD` (`:28`). It wraps
   `globalThis.fetch`.

Lessons the payment mock must follow:

- **CI runs `NODE_ENV=production` with `MOCKS=true`.** A `NODE_ENV` guard would
  turn the mock off in CI and proves nothing about production.
- The GitHub mock activates on a `MOCK_` key prefix, and production relies on
  real secrets being set. The payment mock must not activate on a key prefix.
- MSW does not run in Workers dev, which is the validators' topology.

## 3. What exists today (why the mock is needed)

- Stripe: `packages/test-utils/src/mocks/stripe.ts` is passthrough for every
  method, and `index.ts` lists `api.stripe.com` in `bypassUrls`. Leave them.
- Checkout.com: no handler at all. Polar: none (out of scope).
- Placeholder keys (`sk_test_***`, `pk_test_***`, `whsec_***`) make
  `isConfiguredSecret` (`packages/payments/src/shop/config.ts:17-20`) report
  unset, so `isProcessorConfigured` is false and order checkout fails with
  `409 online_payment_unavailable`.
- Every "payments configured or enabled" decision (all must behave as in
  production once the mock is on):

| #   | Location                                                                     | Decision                                                                                              |
| --- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1   | `packages/payments/src/shop/config.ts`                                       | secrets present and not placeholders                                                                  |
| 2   | `shop/commerce.ts:195-211` `isProcessorConfigured`                           | `connect` needs the Stripe secret; `checkout` needs secret, public key, subdomain, processing channel |
| 3   | `commerce.ts:187-193` `listConfiguredProcessors`                             | feeds `configuredProcessors` on Settings, Shop; Checkout.com buttons need `checkout`                  |
| 4   | `commerce.ts:236-274` `getCheckoutShop` / `getStripe`; `providers/stripe.ts` | throw when unconfigured; Stripe needs the `sk_` prefix                                                |
| 5   | `utils/restaurant-orders/payment-config.server.ts:46-77`                     | org state only (Connect: US + account + charges; Checkout.com: sub-entity + charges)                  |
| 6   | `routes/resources+/order-context.ts`                                         | embeds #5 as `onlinePayment` for the regional service                                                 |
| 7   | `checkout.server.ts:339-349`                                                 | #5 and `isProcessorConfigured`, else 409                                                              |
| 8   | `checkout.server.ts:238-245, 308-318, 553-556`                               | processor capabilities (Stripe pollable, Checkout.com webhook-only)                                   |
| 9   | `apps/app/app/utils/shop.server.ts`                                          | legacy shop availability and onboarding guards                                                        |
| 10  | `settings+/shop.tsx`, `shop-card.tsx`                                        | US-only UI and action guards                                                                          |
| 11  | `routes/api+/shop+/webhook.tsx`                                              | 503 unless Checkout.com configured; 500 without `CHECKOUT_WEBHOOK_SECRET`                             |
| 12  | `routes/api+/stripe+/webhook.tsx:51-54`                                      | verifies with `process.env.STRIPE_WEBHOOK_SECRET`; `whsec_***` is a usable HMAC key string            |
| 13  | `apps/sites/src/lib/ordering/order-client.ts:255-257`                        | rejects any non-`https:` `checkoutUrl`, so a mock page on `http://localhost:3001` would fail          |

## 4. Approach

| Option                                                          | Verdict                                                                        |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| MSW handlers                                                    | rejected: MSW does not run in Workers dev                                      |
| Fake `ShopCommerce` or adapter                                  | rejected: bypasses the SDKs, so encoding, error classes and typing go untested |
| Real SDKs with an in-process transport into a stateful emulator | chosen                                                                         |

- Stripe:
  `new Stripe(key, { httpClient: Stripe.createFetchHttpClient(mockFetch) })`.
  `createFetchHttpClient(fetchFn)` accepts a custom fetch
  (`node_modules/stripe/cjs/net/FetchHttpClient.js`). The emulator receives real
  form-encoded requests; the SDK turns its error envelopes into real
  `Stripe.errors.StripeCardError` and friends.
- Checkout.com:
  `new Checkout(key, { host: 'https://checkout-com.mock.invalid', subdomain, pk })`.
  The SDK always calls global `fetch` (`dist/services/http.js`), so an
  idempotent wrapper intercepts only the reserved `.invalid` origin (same
  pattern as `dev-s3-mock.ts`), installed when the client is built in mock mode.
- One core, a pure `(Request) => Promise<Response>` plus a store, runs unchanged
  in Workers dev, Node dev, Node `start:mocks` and Vitest.

## 5. Activation (`packages/payments/src/mock/env.ts`)

```ts
declare const __PAYMENTS_MOCK_BUNDLED__: boolean // false in the Cloudflare production build

export function paymentsMockMode(env) {
	if (!__PAYMENTS_MOCK_BUNDLED__) return { stripe: false, checkout: false }
	if (env.PAYMENTS_MOCK === 'false') return { stripe: false, checkout: false }
	const on = env.MOCKS === 'true' || env.PAYMENTS_MOCK === 'true'
	if (!on) return { stripe: false, checkout: false }
	if (/^sk_live_/.test(env.STRIPE_SECRET_KEY ?? ''))
		throw new Error('Refusing payments mock with a live Stripe key')
	return {
		stripe: !isRealSecret(env.STRIPE_SECRET_KEY), // a real test key wins
		checkout: !isRealSecret(env.CHECKOUT_SECRET_KEY),
	}
}
```

- No `NODE_ENV` gate. No key-prefix activation.
- Vitest and other non-Vite consumers need `__PAYMENTS_MOCK_BUNDLED__` defined
  (a `globalThis` fallback or a Vitest `define`); decide once in F1 and document
  it.
- When on, `createShopCommerceConfigFromEnv` fills synthetic values:
  `stripeSecretKey: 'sk_test_mock_platform'`; a Checkout.com key matching
  `NAS_SANDBOX_SECRET_KEY_REGEX` (`/^sk_sbox_?[a-z2-7]{26}[a-z2-7*#$=]$/` in
  `node_modules/checkout-sdk-node/dist/config.js:25`) so the SDK adds `Bearer`;
  a matching public key; `checkoutSubdomain: 'mock'`;
  `checkoutProcessingChannelId: 'pc_mock...'`; a webhook secret; a `mock`
  transport handle.
- Organizations still need onboarding (section 10). The mock never flips org
  columns by itself.
- Stripe webhook secret: the emulator signs with the same value the route
  verifies with, even the `whsec_***` placeholder. Use
  `stripe.webhooks.generateTestHeaderString({ payload, secret })` (an async
  variant `generateTestHeaderStringAsync` also exists). With
  `getStripeWebhookSecrets()` the mock signs Connect events (`account.updated`)
  with `STRIPE_CONNECT_WEBHOOK_SECRET` when set.
- Visibility: boot log `PAYMENTS MOCK ACTIVE (stripe, checkout.com)`, a "Mock
  payments" badge on Settings, Shop, and a banner on every mock page.

## 6. Production exclusion (four layers)

1. **Build-time define.** `apps/app/vite.config.ts` defines
   `__PAYMENTS_MOCK_BUNDLED__ = !(DEPLOY_TARGET === 'cloudflare' && command === 'build')`.
   In `build:cf` / `deploy:cf` the mock branch is dead code and the dynamic
   `import('@repo/payments/mock')` is eliminated. The Node build used by CI
   keeps the mock.
2. **Route strip.** `apps/app/app/routes.ts` adds `'**/mock-payments+/**'` and
   `'**/mock-email+/**'` to `ignoredRouteFiles` when `STRIP_DEV_MOCKS=1`. The
   `build:cf` script in `apps/app/package.json` sets it (today it is
   `cross-env NODE_OPTIONS=... DEPLOY_TARGET=cloudflare react-router build`).
3. **Runtime gate.** Every mock route loader and action returns 404 unless
   `paymentsMockMode()` is on (like `apps/app/app/routes/api+/mock-env.ts`).
   Startup throws on an `sk_live_` key while mocks are on.
4. **CI bundle check.** After `build:cf`, grep the Worker bundle for the
   sentinel string `__MENUZA_PAYMENTS_MOCK__` (placed in the mock module) and
   fail if found.

## 7. Code layout

```
packages/payments/src/mock/            subpath export "@repo/payments/mock" (add to packages/payments/package.json "exports")
  env.ts                 activation rule, synthetic keys, origins
  store.ts               MockStore interface + createMemoryStore() (Vitest)
  clock.ts, ids.ts       injectable clock; provider-shaped ids (cs_test_, pi_, seti_, pm_, cus_, re_, acct_, evt_; hpp_, pay_, src_, sid_, ent_, act_)
  cards.ts               shared test-card catalog and behavior profiles
  emulator.ts            createPaymentsEmulator({ store, clock, origin, secrets })
  stripe/router.ts       method+path dispatch; form decoding with qs; Stripe-Version check
  stripe/objects.ts      builders typed `satisfies Stripe.Checkout.Session` etc.
  stripe/errors.ts       error envelopes (400/402/404/409) + idempotency_error
  stripe/{accounts,customers,checkout-sessions,setup-intents,payment-methods,payment-intents,refunds,ledger,events}.ts
  checkout-com/router.ts JSON dispatch; Authorization check; Cko-Idempotency-Key
  checkout-com/{entities,hosted-payments,payment-sessions,payments,refunds,allocations,events}.ts
  transport.ts           createMockStripeHttpClient(emulator); installCheckoutComMockFetch(emulator)
  testing.ts             Vitest helpers (completeCheckout, settleRefund, advanceClock)

apps/app/app/utils/payments-mock/
  store.server.ts              SQL MockStore over @repo/database `db`
  emulator.server.ts           singleton wiring (origin, secrets, store)
  webhook-dispatch.server.ts   signed delivery to the real webhook routes
  onboard.server.ts            instant onboarding helper
apps/app/app/routes/mock-payments+/   hosted pages + dev API (stripped in build:cf)
```

Small edits to existing code:

- `ShopCommerceConfig` gains `mock?: { stripeHttpClient; checkoutHost }`.
- `StripeProvider` / `createStripeProvider` (`providers/stripe.ts`, which
  hard-codes `Stripe.createFetchHttpClient()` at `:38`) accept `httpClient`.
- `createCheckoutShopClient` (`connect/checkout-shop.ts`) accepts `host`.
- `apps/app/app/utils/shop.server.ts:41-59` wires the emulator when the mock is
  on; `configureShopCommerceForTests(env, { emulator })`.
- `routes.ts`, `vite.config.ts`, `build:cf` and CI implement exclusion.
- Sites `order-client.ts:255-257` allows `http:` only for `localhost`,
  `127.0.0.1` and `*.localhost`, and only outside production. Keep a test.
- `apps/app/.env.schema` documents `PAYMENTS_MOCK`, `PAYMENTS_MOCK_ORIGIN`
  (defaults to `BASE_URL`), `PAYMENTS_MOCK_WEBHOOKS`,
  `PAYMENTS_MOCK_WEBHOOKS_HTTP`, `STRIPE_CONNECT_WEBHOOK_SECRET`.

## 8. State

In-memory state is unusable (vite Workers dev reloads modules, isolates recycle,
validators restart the App). State lives in the control-plane `db` (local D1
under `apps/app/.wrangler/state` in Workers dev; LibSQL
`packages/database/db/data.db` in Node), created lazily with
`CREATE TABLE IF NOT EXISTS` via `db.run(sql...)` on first use. **No Drizzle
migration; production schema is untouched.**

```sql
CREATE TABLE IF NOT EXISTS __mock_pay_object (
  provider TEXT NOT NULL, id TEXT NOT NULL, type TEXT NOT NULL, parent_id TEXT,
  json TEXT NOT NULL, transition_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (provider, id));
CREATE TABLE IF NOT EXISTS __mock_pay_idempotency (
  provider TEXT, key TEXT, request_hash TEXT, status INTEGER, response TEXT, created_at INTEGER,
  PRIMARY KEY (provider, key));
CREATE TABLE IF NOT EXISTS __mock_pay_event (
  provider TEXT, id TEXT, type TEXT, payload TEXT, connect_account TEXT,
  created_at INTEGER, delivered_at INTEGER, attempts INTEGER DEFAULT 0, last_status INTEGER,
  PRIMARY KEY (provider, id));
```

- Atomic transitions: `UPDATE ... WHERE json->>'$.status' = ?` with the row
  count checked (single-shot completion; no over-refund under concurrency).
- State survives App restarts; `npm run db:reset` or dev `reset` wipes it.
- Workers-dev D1 and Node `data.db` are separate; each runtime is
  self-consistent. Tests always use the HTTP dev API, never the database.
- Time-based transitions (session `expires_at`, pending refund settles) are
  evaluated lazily on read using `transition_at` and the injectable clock.

## 9. Mock hosted pages (`apps/app/app/routes/mock-payments+/`)

Plain SSR, progressive-enhancement forms (no client JS needed), labeled inputs,
stable `data-testid`s, a fixed banner ("Mock Stripe Checkout (local)", "Mock
Checkout.com HPP (local)").

**Stripe Checkout** `GET /mock-payments/stripe/checkout/:sessionId` (the session
`url`):

- Shows merchant (platform name and connected account display name), line items,
  amount, currency, mode (payment, or setup: "Save card for later charges"),
  `custom_text.submit.message`, `expires_at` countdown.
- Fields: email, card number, expiry, CVC, cardholder name, ZIP. Buttons **Pay**
  / **Save card** and **Back** (to `cancel_url`).
- Validation: Luhn, future expiry, 3 to 4 digit CVC. A valid non-test card is
  rejected with "Your card was declined. Your request was in test mode, but used
  a non test card".
- Decline: re-render with an inline error; the session stays `open`.
- Expired or completed session: "This Checkout Session is no longer active".
- 3DS: redirect to `/mock-payments/stripe/3ds/:attemptId` with **Complete
  authentication** / **Fail authentication**.
- Completion: session `complete`, `payment_status` `paid` (or
  `no_payment_required` in setup mode); update PaymentIntent or SetupIntent,
  PaymentMethod, charge, transfer and application fee; queue events; deliver per
  mode (section 12); 303 to `success_url` with `{CHECKOUT_SESSION_ID}`
  substituted.

**Checkout.com HPP** `GET /mock-payments/checkout-com/hpp/:hppId` (the
`_links.redirect.href`):

- Same layout with Checkout.com test cards; 3DS page with a password field
  (`Checkout1!` succeeds, anything else fails); amount-based declines at submit.
- Redirects: success `success_url?cko-session-id=sid_...`, failure
  `failure_url?cko-session-id=sid_...`, Back `cancel_url`. `sid_` resolves
  through `GET /payments/sid_...`.

**Onboarding and dashboards:**

- `/mock-payments/stripe/connect/onboard/:accountLinkId` (Account Link `url`):
  **Complete** (charges, payouts, details submitted, capabilities active),
  **Submit with requirements due** (charges disabled), **Payouts restricted**.
  Sends `account.updated` and redirects to `return_url`; the existing
  `?connect=return` loader sync writes the columns. The existing "Connect payout
  account" button works unchanged.
- `/mock-payments/stripe/connect/dashboard/:accountId` (Express login link):
  charges, transfers, application fees, refunds, reversals.
- `/mock-payments/checkout-com/dashboard` ("Open Checkout dashboard" redirects
  here in mock mode): sub-entities with **Activate payments** / **Activate
  payouts**, payments, actions, allocations, commission.
- `/mock-payments/dashboard`: index plus the event log with delivery status and
  **Redeliver**.

## 10. Onboarding helper (Settings, Shop)

1. Realistic path, no code change: "Connect payout account", mock onboarding,
   **Complete**, then the `?connect=return` sync. Checkout.com: "Invite Checkout
   payout contact", then "Open Checkout dashboard", **Activate**, reload
   Settings, Shop (status syncs on every load, `shop.tsx:85-94`).
2. Instant path (mock mode only): a "Mock payments" panel with **Instantly
   enable Stripe (mock)** and **Instantly enable Checkout.com (mock)** (intents
   `mock-onboard-stripe`, `mock-onboard-checkout`, permission
   `UPDATE_SETTINGS_ANY`; 404 when the mock is off). `onboard.server.ts` creates
   the account or sub-entity through the emulator, completes it, calls the real
   `syncConnectAccountStatus` / `syncCheckoutSubEntityStatus`, and sets
   `shopPaymentProvider`. Also exposed as
   `POST /mock-payments/dev/onboard { orgSlug, provider }`.

- The helper must not bypass region rules: Stripe stays US only; KSA
  (`riyadh-grill`) onboards Checkout.com through the real UI once the three
  US-only Checkout.com guards are removed (F6).

## 11. Behavior

### 11.1 Stripe card profiles

| Card                  | Setup / on-session                                             | Later off-session PaymentIntent                                                                                                                 |
| --------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `4242 4242 4242 4242` | success, no 3DS                                                | `succeeded`                                                                                                                                     |
| `4000 0025 0000 3155` | 3DS challenge                                                  | `succeeded`                                                                                                                                     |
| `4000 0027 6000 3184` | 3DS challenge                                                  | `402 card_error code=authentication_required`; PI saved `requires_payment_method` with `last_payment_error`, returned in `error.payment_intent` |
| `4000 0000 0000 0341` | setup attaches; payment-mode charge declines                   | `402 card_declined decline_code=generic_decline`                                                                                                |
| `4000 0000 0000 9995` | payment mode `insufficient_funds`; setup fails (cannot attach) | n/a                                                                                                                                             |
| `4000 0000 0000 0002` | `card_declined generic_decline`                                | same                                                                                                                                            |
| `4000 0082 6000 3178` | 3DS, then `insufficient_funds`                                 | `insufficient_funds`                                                                                                                            |
| `4000 0000 0000 7726` | success                                                        | success; refunds `pending` then `succeeded`                                                                                                     |
| `4000 0000 0000 5126` | success                                                        | success; refunds `pending` then `failed` (`refund.failed`, `charge.refund.updated`)                                                             |
| `4000 0000 0000 0259` | success, then `charge.dispute.created`                         | same                                                                                                                                            |

Server-side tokens for Vitest: `pm_card_visa`, `pm_card_authenticationRequired`,
`pm_card_chargeCustomerFail`, `pm_card_visa_chargeDeclinedInsufficientFunds`,
`pm_card_threeDSecure2Required`. Store only brand, last4, expiry and the profile
key, never the full number.

### 11.2 Stripe operations (API version `2025-08-27.basil`)

- Connect: `POST /v1/accounts` (Express or Custom, metadata, capabilities;
  starts not charges-enabled), `GET /v1/accounts/:id`, `POST /v1/account_links`
  (`account_onboarding`; stores `return_url`, `refresh_url`),
  `POST /v1/accounts/:id/login_links`.
- Customers: `POST /v1/customers` (no fields required), `GET`,
  `GET /v1/customers/:id/payment_methods`.
- Checkout sessions: `POST /v1/checkout/sessions` (payment mode:
  `line_items.price_data`,
  `payment_intent_data.{application_fee_amount, transfer_data.destination, metadata, setup_future_usage, capture_method, statement_descriptor_suffix}`,
  `customer`, `payment_method_types`, `metadata`, `success_url`, `cancel_url`,
  `expires_at`, `custom_text`; setup mode: `currency` or `payment_method_types`,
  `customer`, `setup_intent_data.metadata`), `GET` with `expand[]=setup_intent`
  / `payment_intent`, `POST .../expire`.
- `GET /v1/setup_intents/:id`, `GET /v1/payment_methods/:id`,
  `POST /v1/payment_methods/:id/attach` (`resource_already_exists` semantics as
  in `commerce.ts:577-595`).
- PaymentIntents: `POST /v1/payment_intents` (`customer`, `payment_method`,
  `off_session`, `confirm`, `application_fee_amount`, `transfer_data`,
  `metadata`, `statement_descriptor_suffix`, `capture_method=manual`), `GET`
  (expand `payment_method`, `latest_charge`), `/cancel`, `/capture`.
- Refunds: `POST /v1/refunds` (`payment_intent`, `amount`, `reason`,
  `reverse_transfer`, `refund_application_fee`, `metadata`; over-refund ->
  `400 charge_already_refunded` or `amount_too_large`), `GET`.
- Ledger (dashboard and assertions): `ch_`, `tr_`, `fee_`, `trr_`, `fr_`;
  application fee <= amount; transfer = amount - fee.
- Validation errors that catch real bugs: `expires_at` outside 30 min to 24 h;
  destination missing or not charges-enabled with transfers active; amount below
  50 for USD or CAD; SAR; setup mode without currency or payment method types;
  `off_session` with a PaymentMethod not attached to the customer;
  `custom_text.submit.message` over 1200 characters; unknown parameters ->
  `400 parameter_unknown`.
- Error envelope:
  `{ error: { type, code, decline_code, message, param, payment_intent, doc_url } }`.
- `Idempotency-Key`: same key and params replay the stored response; same key
  and different params -> `400 idempotency_error`; 24-hour retention.
- Unimplemented endpoints return 501 with a loud log naming method and path.
  Never pass through, never succeed silently.
- Events (full `Stripe.Event`): `checkout.session.completed`, `.expired`,
  `.async_payment_succeeded`, `.async_payment_failed`; `setup_intent.succeeded`;
  `payment_intent.succeeded`, `.payment_failed`, `.requires_action`;
  `charge.refunded`, `refund.created`, `refund.updated`, `refund.failed`;
  `charge.dispute.created`, `.closed`; `account.updated` (with
  `account: acct_...`, a Connect event).

### 11.3 Checkout.com behavior

| Card                                                   | Behavior                                                                     |
| ------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Visa `4242424242424242`, Mastercard `5436031030606378` | frictionless                                                                 |
| Visa `4543474002249996`, Mastercard `5352151570003404` | 3DS challenge, password `Checkout1!`                                         |
| Mock-only "mada (co-badged)", clearly labeled          | CIT approves; MIT declines `response_code 20046`, "MIT not supported (mock)" |

- Amount-based declines in CIT and MIT: ending `05` -> `20005` (Do not honour),
  `51` -> `20051`, `12` -> `20012`, `54` -> `20054`. Declines return 201 with
  `approved: false`, `status: 'Declined'` (verify). Validation errors:
  `422 { request_id, error_type: 'request_invalid', error_codes }`. Bad
  auth: 401.
- Sub-entities: `POST /accounts/entities` (`reference`,
  `contact_details.invitee.email`, `is_draft`) -> `ent_...`, status
  `draft`/`pending`, `capabilities.payments.enabled=false`;
  `GET /accounts/entities/:id`. Activated through the mock dashboard or dev API.
- HPP: `POST /hosted-payments` -> 201
  `{ id: 'hpp_...', reference, _links: { self, redirect } }`. Required:
  `amount`, `currency`, `reference`, `billing.address.country`,
  `processing_channel_id`, `success_url`, `failure_url`, `cancel_url`. Optional:
  `payment_type` (`Regular` | `Unscheduled`), `metadata`, `amount_allocations`,
  `3ds`. `GET /hosted-payments/:id` returns status and the payment id once paid
  (field names: verify). After an `Unscheduled` CIT the payment has `source.id`
  (`src_...`), `customer.id`, `scheme_id`.
- `POST /payment-sessions` (Flow) is emulated faithfully: `id`,
  `payment_session_token`, `payment_session_secret`, `_links.self`, **no
  redirect link**. Today's order path (`checkout-shop.ts:181-196`) therefore
  fails in mock mode exactly as it would against the real API. The fix is moving
  orders to `hostedPayments.create` (F7). No stopgap switch is needed.
- Payments: `GET /payments/:id` (accepts `sid_...`),
  `GET /payments/:id/actions`, `POST /payments` (MIT with
  `source: { type: 'id', id }`, `merchant_initiated: true`,
  `payment_type: 'Unscheduled'`, `previous_payment_id` that must be a CIT on the
  same source, `amount_allocations`, `processing_channel_id`, `reference`,
  `metadata`), `POST /payments/:id/refunds` (202 `{ action_id }`, settles
  lazily, approved by default; a decline can be forced from the dev API),
  `POST /payments/:id/voids`, `POST /payments/search` by `reference`.
- Allocations: every `id` is a known sub-entity with payments enabled; amounts
  sum to the payment amount; `0 <= commission.amount <= allocation.amount`;
  refund reversals do not exceed what was allocated. Failures return 422 with
  `amount_allocations_invalid`-style codes. This is how the platform fee
  override is validated.
- `Cko-Idempotency-Key` honored on payments and refunds.
- Events: `payment_approved`, `payment_captured`, `payment_declined`,
  `payment_pending`, `payment_refunded`, `payment_refund_declined`. Envelope
  `{ id: 'evt_...', type, created_on, data: { id, action_id, amount, currency, reference, metadata, source, processing, amount_allocations } }`.
  `cko-signature` = hex HMAC-SHA256 of the body (matches
  `checkout-shop.ts:267-282`).
- Fidelity switch: `data.processing.payment_session_id` on HPP webhooks defaults
  to **absent** (unverified), so the order mapper's dependency
  (`checkout-shop.ts:319`, `restaurant.ts:165`) shows up as a defect and gets
  fixed to match on the HPP id or reference.

### 11.4 PII realism

The emulator fills `customer_details`, `billing_details`, `receipt_email` and
Checkout.com `customer` with fake but realistic values (for example the email
typed on the page), so tests can assert that App code maps provider objects to
ids-and-amounts DTOs and never forwards or logs those fields.

## 12. Webhooks

Needed: Checkout.com orders are webhook-only today; async refunds, disputes and
`account.updated` are event-driven; "guest paid and closed the tab" is only
testable through webhooks.

`PAYMENTS_MOCK_WEBHOOKS`:

- `inline` (default): signed delivery before the redirect.
- `deferred`: delivered after the redirect response (`ctx.waitUntil` or a
  microtask).
- `manual`: queued only; tests prove the poll-only path, then `flush` proves a
  late webhook is idempotent.

Transport: the dispatcher builds a real `Request` with the signed raw body and
calls the real route module's `action` in-process
(`await import('#app/routes/api+/stripe+/webhook.tsx')`,
`api+/shop+/webhook.tsx`). This avoids workerd self-fetch to `localhost:3001`.
`PAYMENTS_MOCK_WEBHOOKS_HTTP=1` POSTs to `PAYMENTS_MOCK_ORIGIN` instead.
Delivery status and attempts are recorded; a 500 is retried on `flush`.

## 13. Dev control API (`/mock-payments/dev/*`, JSON, mock mode only)

| Endpoint                                                                       | Purpose                                  |
| ------------------------------------------------------------------------------ | ---------------------------------------- |
| `onboard { orgSlug, provider }`                                                | onboard an org                           |
| `stripe/sessions/:id/complete { card, email?, threeDS: 'complete' \| 'fail' }` | pay headlessly                           |
| `checkout-com/hpp/:id/complete { card, password? }`                            | same for Checkout.com                    |
| `sessions/:id/expire`                                                          | force expiry (instead of waiting 30 min) |
| `refunds/:id/settle { outcome }`                                               | settle a pending refund                  |
| `disputes { paymentIntent }`                                                   | open a dispute                           |
| `clock/advance { seconds }`                                                    | move the injectable clock                |
| `events?provider=&type=`                                                       | list events                              |
| `events/flush`                                                                 | deliver queued events                    |
| `events/:id/redeliver`                                                         | redeliver one event                      |
| `objects/:provider/:id`                                                        | raw object for assertions                |
| `reset`                                                                        | wipe mock state                          |

Unauthenticated because they exist only in mock mode; they may require
`INTERNAL_COMMAND_TOKEN` if shared machines are a concern.

## 14. Test harness

- Vitest (`packages/payments`, `apps/app`):
  `createPaymentsEmulator({ store: createMemoryStore(), clock: fakeClock })`,
  `configureShopCommerceForTests(env, { emulator })`, call the real
  `createRestaurantOrderHostedCheckout`, then
  `emulator.testing.completeCheckout(sessionId, { card: '4000002760003184' })`,
  then `getRestaurantOrderPaymentStatus`. Regional calls stay on the MSW
  tenant-api handlers (`packages/test-utils/src/mocks/tenant-api.ts`).
- Emulator unit tests use the real SDK clients over the in-process transport and
  assert real error classes (for example
  `instanceof Stripe.errors.StripeCardError` with `code`).
- Playwright: local runs use Workers `npm run dev`, CI uses Node `start:mocks`;
  `MOCKS=true` holds in both. Page objects key on `data-testid`; setup, clock
  and flush go through the dev API; assertions go through App or Sites status
  endpoints and regional state, never the redirect alone.
- Multi-service flows (App :3001, tenant-api :3007/:3009, Sites :3008) are
  validated by the mission topology, not the App's Playwright job.
- Admin writes `data.db` while the App reads D1: validators set the platform fee
  in Admin and copy it into D1 (`wrangler d1 execute DB --local`) before
  checking amounts.

## 15. Risks and fidelity

1. Divergence from real providers: builders `satisfies Stripe.<Type>`; decode
   what the SDK sends (form encoding, `Stripe-Version`, `Idempotency-Key`);
   documented error envelopes; loud 501s; optional contract job against the
   stateless official `stripe-mock` (diff key sets and types, not values).
   Checkout.com has no TS types: write Zod schemas from the API reference, keep
   doc examples as fixtures, and list every "verify" assumption in one fidelity
   table with named switches.
2. Faithful failures kept on purpose: Flow has no redirect link;
   `payment_session_id` may be absent on HPP webhooks; Platforms enablement; the
   30-minute session minimum; test-mode rejection of non-test cards.
3. Production leak: four layers (section 6). No `NODE_ENV` guard.
4. Global fetch wrapping for Checkout.com is scoped to the `.invalid` origin,
   idempotent, installed only in mock mode.
5. The Sites `https:` relaxation is loopback-only and tested.
6. Mock page DOM differs from `checkout.stripe.com` and `pay.checkout.com`; keep
   UI tests thin and cover logic through the dev API.
7. Out of scope: the legacy shop's Stripe.js inline card (`processors.ts:16`,
   `supportsInlineCard: true`), Polar, SaaS billing Stripe
   (`apps/app/app/utils/payments.server.ts`, Admin).
8. `withConnect` flattening (`commerce.ts:300-308`) would hide
   `authentication_required`; the emulator's off-session tests catch it.
9. Two separate mock databases (Workers D1 vs Node `data.db`); tests use the dev
   API, so it does not matter.

## 16. Features F1 to F9

Size estimate: about 50 files, about 4,800 lines of implementation and 2,300
lines of tests. After F1, the Stripe track (F2 -> F3 -> F4/F5) and the
Checkout.com track (F6 -> F7 -> F8) can run in parallel. F3 is the template for
the others.

| ID  | Feature                                                                                                                                                                                                                                                                                                                     | Depends on              | Acceptance                                                                                                                                                                                                            |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | **Foundation and production exclusion.** Activation rule, synthetic config, Stripe `httpClient` and Checkout.com `host` seams, scoped fetch wrapper, memory and SQL stores, 501 fallthrough, vite define, `routes.ts` strip, `build:cf` flag, CI bundle grep, boot log, `docs/payments-mock.md` skeleton, env schema lines. | none                    | With `MOCKS=true` and placeholder keys, `listConfiguredProcessors()` returns `connect` and `checkout`. The `build:cf` bundle has no sentinel. With `MOCKS` unset, every mock route 404s. `sk_live_` refuses to start. |
| F2  | **Stripe Connect onboarding.** Accounts, account links, login links, `account.updated` (signed with the Connect secret via `getStripeWebhookSecrets()`), mock onboarding and Express dashboard pages, Settings, Shop mock panel, dev `onboard`.                                                                             | F1                      | "Connect payout account" then Complete gives `onlinePayment.enabled: true` for `acme` in `/resources/order-context`.                                                                                                  |
| F3  | **Stripe Checkout payment mode end to end.** Sessions create, retrieve, expire; hosted page; 3DS page; charge, transfer and fee ledger; signed webhooks (inline, deferred, manual); dev complete, expire, flush; Sites loopback `http:`.                                                                                    | F2                      | An existing `acme` restaurant order pays locally through Sites -> mock page -> success, by poll and by webhook. A declined card shows an inline error. Expiry clears the binding.                                     |
| F4  | **Stripe setup mode and off-session.** Customers, setup intents, payment methods, off-session PaymentIntents for every card profile, cancel, manual capture; the `withConnect` fix.                                                                                                                                         | F3                      | `3155` setup then fee succeeds. `3184` gives `authentication_required` with `raw.payment_intent` surviving `withConnect`. `0341` declines. `9995` setup fails.                                                        |
| F5  | **Stripe refunds and disputes.** Sync, pending, succeeded and failed refunds; reverse transfer and application-fee refund in the ledger; refund and dispute events; dashboard ledger.                                                                                                                                       | F3                      | Partial, full and over-refund behave as specified. `7726` and `5126` settle as specified.                                                                                                                             |
| F6  | **Checkout.com sub-entities.** Entities API, mock dashboard Activate, instant helper; remove the three US-only guards (`shop-card.tsx:78-84`, `settings+/shop.tsx:215-222`, `shop.server.ts:333-335`).                                                                                                                      | F1                      | `riyadh-grill` (KSA) reaches `checkoutChargesEnabled=1` through the UI.                                                                                                                                               |
| F7  | **Checkout.com HPP.** `/hosted-payments` create and get, `pay_`/`sid_` lookup, 3DS password, amount declines, webhooks, faithful payment-sessions; move order checkout from Flow to HPP; add a Checkout.com status lookup to the order status poll; fix the webhook mapper's `payment_session_id` dependency.               | F6                      | A SAR order on `riyadh-grill` pays locally. A decline amount (`...05`) fails. Status resolves without a webhook (manual mode) through the HPP and payment lookup.                                                     |
| F8  | **Checkout.com stored instrument, MIT, refunds.** `Unscheduled` CIT storing `src_`, MIT `POST /payments`, actions, refunds with allocation reversal, commission validation, mock mada MIT decline.                                                                                                                          | F7                      | MIT approves for Visa, declines for amount `...05` and the mock mada card. Refund actions settle. Bad allocations get 422.                                                                                            |
| F9  | **Test harness and fidelity.** Vitest helpers, Playwright page objects and fixtures, the fidelity table, optional `stripe-mock` contract job, `docs/payments-mock.md` completed.                                                                                                                                            | F3 (start), F8 (finish) | CI runs the emulator suite on Node. Local Playwright passes on the Workers-dev topology.                                                                                                                              |

Which reservation payment features need which mock feature
(`payments-experiences`): deposits, prepay and Experiences need F3 and F7; card
guarantees and fees need F4 and F8; refunds need F5 and F8.

## 17. Superseded research items

- "Validate against real Stripe test mode with the Stripe CLI, Custom accounts
  and test-token onboarding": superseded; no real keys are used.
- "KSA v1 is prepaid deposits only; guarantees are US only": superseded;
  Checkout.com stored instruments are offered best effort (architecture.md 12.2,
  22 item 12).
- `PAYMENTS_MOCK_CKO_FLOW_REDIRECT` stopgap: not needed; orders move to HPP.
- "The instant helper should not bypass the KSA guards; relaxing them is
  reservations work": the guards are now removed inside `payment-mocks` (F6).
- The 20% `SHOP_PLATFORM_FEE_PERCENT` does not apply to reservation payments.
