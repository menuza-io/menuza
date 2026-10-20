# Payment mocks (Stripe and Checkout.com emulators)

Local emulators for Stripe (Connect, Checkout, PaymentIntents, refunds,
disputes) and Checkout.com (sub-entities, Hosted Payments Page, MIT, refunds,
allocations). The real `stripe` and `checkout-sdk-node` clients talk to an
in-process, stateful emulator, so request encoding, error classes and webhook
signatures are exercised. No real key is ever used.

Code: `packages/payments/src/mocks/` (export `@repo/payments/mock`) and
`apps/app/app/utils/payments-mock/`. Pages and dev API:
`apps/app/app/routes/mock-payments+/`. The activation rule
(`packages/payments/src/mocks/env.ts`) is tiny and pure on purpose: production
code imports it, never the emulators themselves.

## Turning it on

| Switch                                                                                | Effect                                                     |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `MOCKS=true`                                                                          | On (root `npm run dev`, Playwright set it).                |
| `PAYMENTS_MOCK=true`                                                                  | On without `MOCKS`.                                        |
| `PAYMENTS_MOCK=false`                                                                 | Forced off even with `MOCKS=true`.                         |
| a real `STRIPE_SECRET_KEY`                                                            | That provider stays real (same for `CHECKOUT_SECRET_KEY`). |
| `sk_live_` / `rk_live_`, or a Checkout.com key that is not `sk_sbox_*` / `ack_test_*` | Startup throws (anything unrecognised counts as live).     |

There is no bare `NODE_ENV` gate: CI and `start:mocks` run the production Node
build with `MOCKS=true`. The runtime gate is the public origin instead: with a
mock switch on, `BASE_URL` (and `PAYMENTS_MOCK_ORIGIN`, when set) must be a
local host (`localhost`, `127.0.0.1`, `::1`, `*.test`, `*.localhost`), whatever
key variables are set. Any other origin makes startup throw, so a real deploy
with a stray switch fails closed. Placeholder keys (`sk_test_***`) get synthetic
values so `listConfiguredProcessors()` returns `connect` and `checkout`.
Organizations still need onboarding: Settings, Shop shows a "Mock payments"
panel with instant-enable buttons. The App logs
`PAYMENTS MOCK ACTIVE (stripe, checkout.com)`.

Other variables: `PAYMENTS_MOCK_ORIGIN` (hosted page origin, default
`BASE_URL`), `PAYMENTS_MOCK_WEBHOOKS` (`inline` default, `deferred`, `manual`),
`PAYMENTS_MOCK_WEBHOOKS_HTTP=1` (POST webhooks over HTTP instead of calling the
route in process), `PAYMENTS_MOCK_CKO_SESSION_ID=true` (fidelity switch, below),
`STRIPE_CONNECT_WEBHOOK_SECRET` (second secret for Connect events; the Stripe
webhook route accepts either secret). With no `STRIPE_WEBHOOK_SECRET` set, the
route falls back to the mock's public secret only for a local request on a local
deployment, so a node started with `MOCKS=true` never accepts forged events from
elsewhere.

## Production exclusion (four layers)

1. `vite.config.ts` defines `__PAYMENTS_MOCK_BUNDLED__` as
   `!(DEPLOY_TARGET=cloudflare && command=build)`. In `build:cf` the mock
   branches are dead code and tree-shaken. Where it is undefined the mock stays
   off. The Settings panel and its link to the mock dashboard are gated by the
   same constant inline in `ShopCard`, so they are removed too.
2. `app/routes.ts` drops `mock-payments+` when `STRIP_DEV_MOCKS=true`
   (`build:cf` and `scripts/cf-workers-ci.mjs` set it).
3. Every mock route and the Settings panel answer 404 unless the mode is on
   **and** the request and `BASE_URL` are local (loopback, `*.localhost`,
   `*.test`). Startup refuses a non-local `BASE_URL` or mock origin (even with
   no keys set) and live keys.
4. `node scripts/check-no-payment-mocks.mjs [dir]` fails when the bundle holds
   `__PAYMENTS_MOCK__`, `checkout-com.mock.invalid`, `__mock_pay_` or the mock
   route ids (`/mock-payments/`). `exclusion.test.ts` bundles what production
   code imports with the define off and runs the scanner on the result. CI runs
   it after `build:cf` (`deploy.yml`, and before every Worker deploy in
   `cf-workers-ci.mjs`). Do not point it at the Node build that Playwright uses:
   that one keeps the mock on purpose.

## State

`__mock_pay_object`, `__mock_pay_idempotency`, `__mock_pay_event` in the
control-plane database (local D1 in Workers dev, LibSQL in Node), created lazily
with `CREATE TABLE IF NOT EXISTS`. No migration. State survives restarts;
`POST /mock-payments/dev/reset` wipes it and clears the onboarding columns of
mocked providers. Mock time (`clock/advance`) is an offset stored there.

## Pages

`/mock-payments/dashboard` (event log, Redeliver), `/stripe/checkout/:id`,
`/stripe/3ds/:attemptId`, `/stripe/connect/onboard/:linkId`,
`/stripe/connect/dashboard/:accountId`, `/checkout-com/hpp/:id`,
`/checkout-com/3ds/:attemptId`, `/checkout-com/dashboard`. Forms are plain POSTs
with stable `data-testid`s.

## Test cards

Stripe: `4242...4242` ok; `4000 0025 0000 3155` 3DS; `...3184` 3DS, off-session
`authentication_required`; `...0341` attaches, charges decline; `...9995`
insufficient funds (setup fails); `...0002` declined; `...3178` 3DS then
insufficient funds; `...7726` refunds pending then succeed; `...5126` pending
then fail; `...0259` dispute. Tokens: `pm_card_visa`,
`pm_card_authenticationRequired`, `pm_card_chargeCustomerFail`,
`pm_card_visa_chargeDeclinedInsufficientFunds`, `pm_card_threeDSecure2Required`.

Checkout.com: `4242424242424242`, `5436031030606378` frictionless;
`4543474002249996`, `5352151570003404` 3DS; `5297412542005689` is a mock-only
mada card whose MIT declines (`20046`). Amounts ending `05`, `51`, `12`, `54`
decline (`20005`, `20051`, `20012`, `20054`). The 3DS password is `Checkout1!`.

## Dev control API (`/mock-payments/dev/*`, JSON, local only)

State-changing calls need `Content-Type: application/json` (415 otherwise) and
must not be cross-site: a `Sec-Fetch-Site` other than `same-origin` or `none`,
or an `Origin` that differs from the request origin, gets 403. curl needs
`-H 'Content-Type: application/json'`.

`POST onboard {orgSlug, provider}`, `POST stripe/sessions/:id/complete`,
`POST checkout-com/hpp/:id/complete`, `POST sessions/:id/expire`,
`POST refunds/:id/settle {outcome}`, `POST disputes {paymentIntent}`,
`POST clock/advance {seconds}`, `GET events?provider=&type=`,
`POST events/flush`, `POST events/:id/redeliver`, `GET objects/:provider/:id`
(`stripe` | `checkout`; `sid_` resolves), `POST reset`.

## Webhooks

Signed with the secret the real route verifies with (`Stripe-Signature`
`t=,v1=`; `cko-signature` hex HMAC-SHA256) and delivered by calling the route's
`action` in process. `inline` delivers before the redirect, `deferred` about a
second later (or on the next mock request), `manual` only on flush. A non-2xx is
retried on flush; redelivery re-signs the same body.

## Checkout.com orders

Shop orders use the Hosted Payments Page (`POST /hosted-payments`), not Flow
(Flow has no redirect link, and the emulator keeps it that way). The merchant
reference is the organization id, because payment events and
`POST /payments/search` echo the reference while the hosted page id is not
guaranteed to come back. A status poll finds the payment by reference
(`ShopCommerce.findCheckoutPaymentsByReference`), so an order is confirmed with
no webhook.

## Fidelity assumptions (unverified against the real APIs)

| Assumption                                                    | Switch / note                                       |
| ------------------------------------------------------------- | --------------------------------------------------- |
| HPP payment webhooks carry no `processing.payment_session_id` | `PAYMENTS_MOCK_CKO_SESSION_ID=true` adds the HPP id |
| Declines are 201 with `approved:false`, `status:'Declined'`   |                                                     |
| 3DS failure response code `20153`, unknown card `20014`       |                                                     |
| `payments/search` accepts `reference:'...'`                   |                                                     |
| Duplicate `Cko-Idempotency-Key` with another body is 409      |                                                     |
| Stripe `refund_application_fee` needs `reverse_transfer`      |                                                     |

## Tests

Vitest: `cd packages/payments && npx vitest run src/mocks src/shop`;
`cd apps/app && npx vitest run app/utils/payments-mock app/routes/mock-payments+`.
Playwright: `apps/app/tests/e2e/payment-mocks.test.ts` with the page objects in
`apps/app/tests/playwright-payments-mock.ts` (needs the spec and the App to
share a database: the CI Node server).
