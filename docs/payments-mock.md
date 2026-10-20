# Payment mocks (Stripe and Checkout.com emulators)

Local emulators for Stripe (Connect, Checkout, PaymentIntents, refunds,
disputes) and Checkout.com (sub-entities, Hosted Payments Page, MIT, refunds,
allocations). The real `stripe` and `checkout-sdk-node` clients talk to an
in-process, stateful emulator, so request encoding, error classes and webhook
signatures are exercised. No real key is ever used.

Code: `packages/payments/src/mocks/` (export `@repo/payments/mock`). The
activation rule (`packages/payments/src/mocks/env.ts`) is tiny and pure on
purpose: production code imports it, never the emulators themselves.

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

Vitest: `cd packages/payments && npx vitest run src/mocks src/shop`.
