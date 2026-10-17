# Checkout.com sandbox setup for KSA reservations payments

Scope: how Checkout.com is wired into the App today, what the sandbox provides,
and the simplest realistic setup for local end-to-end tests of a KSA deposit in
SAR, a saved card with a later merchant-initiated (MIT) no-show fee, and a
refund. Paths are relative to `/Users/zama/menuza` unless absolute. No
repository file was modified.

Confidence labels used below:

- **Code fact**: read directly from the repository or the installed SDK
  (`checkout-sdk-node` 4.1.0 in `node_modules/checkout-sdk-node`).
- **Docs (confirmed)**: a Checkout.com page with that title or snippet was found
  by WebSearch.
- **Docs (recalled, verify)**: WebSearch returned page titles but not page
  bodies, so the detail comes from prior knowledge of the Checkout.com docs and
  must be checked on the first sandbox call.

---

## 1. How an organization connects Checkout.com today

### UI path

`/<orgSlug>/settings/shop` (route
`apps/app/app/routes/_app+/$orgSlug_+/settings+/shop.tsx`, card
`apps/app/app/components/settings/cards/organization/shop-card.tsx`).

- The card shows a "Checkout.com" button (`intent=invite-checkout-payout`) only
  when the platform has Checkout.com configured
  (`configuredProcessors.includes('checkout')`, shop-card.tsx:146-170). It also
  offers `intent=open-checkout-dashboard`, which redirects to
  `https://dashboard.sandbox.checkout.com` or `https://dashboard.checkout.com`
  (`getCheckoutDashboardUrl`,
  `packages/payments/src/connect/checkout-shop.ts:69-73`).
- Permission: `ORG_PERMISSIONS.UPDATE_SETTINGS_ANY` (shop.tsx:143-147). Unlike
  `connect-payout`, the Checkout.com invite has **no rate limit**.

### API calls (code fact)

Onboarding is **Platforms hosted onboarding by email invite**, not full API
onboarding:

1. `inviteCheckoutSubEntityOnboarding(org, user.email)`
   (`apps/app/app/utils/shop.server.ts:326-357`) calls
   `ShopCommerce.inviteCheckoutSubEntity` → `inviteCheckoutSubEntity`
   (`checkout-shop.ts:75-103`) → SDK `platforms.onboardSubEntity`, which is
   `POST /accounts/entities` with:

   ```json
   {
   	"reference": "<orgId>",
   	"contact_details": { "invitee": { "email": "<operator email>" } },
   	"is_draft": true
   }
   ```

   Checkout.com emails the invitee a hosted onboarding link. The response `id`
   (an `ent_...` sub-entity id) is stored immediately.

2. Status: `syncCheckoutSubEntityStatus` (`shop.server.ts:298-324`) calls
   `platforms.getSubEntityDetails(id)` (`GET /accounts/entities/{id}`) and
   mirrors `capabilities.payments.enabled` and `capabilities.payouts.enabled`.
   It runs **on every load of the shop settings page** when a sub-entity id is
   set (shop.tsx:85-94), and when the invite is re-sent for an org that already
   has an id. There is no webhook for sub-entity status.

The SDK sends these Platforms calls with the static secret key
(`this.config.sk`, `dist/api/platforms/subentity.js:25,41`). The sandbox-only
Onboarding Simulator (`/simulate/entities/{id}/status`, `/simulate/scenarios`)
exists in the SDK (`dist/api/onboarding-simulator/onboarding-simulator.js`) but
authenticates with an **OAuth access token** (`this.config.access`), which the
App never obtains. The App has no OAuth client support for Checkout.com.

### Storage (code fact)

Control-plane `Organization` table, `packages/database/src/schema.ts:2434-2438`
(migration `packages/database/drizzle/0006_organization_checkout_shop.sql`):

| Column                                         | Meaning                                                              |
| ---------------------------------------------- | -------------------------------------------------------------------- |
| `checkoutSubEntityId` (text)                   | Checkout.com `ent_...` id                                            |
| `checkoutChargesEnabled` (bool, default false) | mirror of `capabilities.payments.enabled`                            |
| `checkoutPayoutsEnabled` (bool, default false) | mirror of `capabilities.payouts.enabled`                             |
| `shopPaymentProvider` (text)                   | set to `'checkout'` on invite (`shopProcessorToDbValue('checkout')`) |

There is no stored sub-entity `status` string, no processing-channel-per-org
column, and no customer/instrument storage anywhere.

### The non-US block

There are **three** layers, all from commit `3797ac1f` "feat(shop): add Polar
and Checkout.com tenant shop processors (#394)". The commit message gives no
reason. The file header of `checkout-shop.ts:1-6` calls it "tenant site commerce
(US marketplace)", and the original shop (single product, orders listed only for
US orgs, shop.tsx:96-99) was a US-only feature. The guard was written for that
legacy shop, before restaurant ordering added region-aware payment gating
(`b09ceeaf`, "production ordering for menus and drops (#30)"), which explicitly
allows Checkout.com in any region
(`apps/app/app/utils/restaurant-orders/payment-config.server.ts:10-12,64-69`).
The guards were never relaxed.

1. UI: `shop-card.tsx:78-84` replaces the whole payout panel for non-US orgs
   with "Shop payouts are available for US organizations only. KSA checkout will
   be supported separately." The Checkout.com button is never rendered.
2. Action: `shop.tsx:215-222`, intent `invite-checkout-payout` redirects with
   the toast "US only" when `dataRegion !== 'us'`.
3. Helper: `shop.server.ts:333-335` throws "Shop payouts are only available for
   US organizations." when `dataRegion !== 'us'`.

All three must be changed for KSA onboarding through the UI. For local tests
they can be bypassed by writing the columns directly (section 6).

---

## 2. How order payments are created with Checkout.com

### API used (code fact)

`createRestaurantOrderHostedCheckout`
(`apps/app/app/utils/restaurant-orders/checkout.server.ts:324-479`) →
`ShopCommerce.createCheckout` (`packages/payments/src/shop/commerce.ts:460-490`)
→ `createCheckoutShopPaymentSession` (`checkout-shop.ts:126-205`) → SDK
`paymentSessions.request` = **`POST /payment-sessions`** (the **Flow**
payment-session endpoint, `dist/api/payment-sessions/payment-sessions.js:38`).

Request body:

```json
{
	"amount": 12345,
	"currency": "SAR",
	"reference": "restaurant_order:<orgId>:<orderId>",
	"description": "Restaurant order",
	"processing_channel_id": "<CHECKOUT_PROCESSING_CHANNEL_ID>",
	"success_url": "<site>/menu/success?order=<orderId>",
	"failure_url": "<site>/menu",
	"billing": { "address": { "country": "SA" } },
	"metadata": {
		"type": "restaurant_order",
		"orgId": "...",
		"orderId": "...",
		"productName": "Restaurant order"
	},
	"amount_allocations": [
		{
			"id": "<checkoutSubEntityId>",
			"amount": 12345,
			"commission": { "amount": 2469 }
		}
	]
}
```

It then requires `session._links.redirect.href` and throws "Checkout.com did not
return a hosted checkout URL" when it is absent (`checkout-shop.ts:193-196`).

**Likely defect (Docs, recalled, verify):** a Flow `POST /payment-sessions`
response contains `id` (`ps_...`), `payment_session_token`,
`payment_session_secret` and `_links.self`. It has **no redirect link**, because
Flow is an embedded web component that needs the public key in the browser. A
redirect URL comes from the **Hosted Payments Page**, `POST /hosted-payments`
(SDK `hostedPayments.create`,
`dist/api/hosted-payments/hosted-payments.js:33-35`), which returns `hpp_...`
and `_links.redirect.href` (`https://pay.sandbox.checkout.com/page/hpp_...`).
HPP also requires `billing.address.country`, which matches this body's shape.
Expect the very first sandbox order checkout to fail with
`502 checkout_session_unavailable`. The likely fix is to switch to
`hostedPayments.create` (same body plus `cancel_url`). No test in the repo
exercises a real response, because `checkout.server.test.ts` mocks
`shop.server.ts`.

### Other details (code fact)

- `processing_channel_id`: one platform-wide value from
  `CHECKOUT_PROCESSING_CHANNEL_ID`. There is no per-org channel.
- Split: `amount_allocations` to the org's sub-entity for the **full amount**,
  with `commission.amount` = 20% (`calculateShopFees`,
  `SHOP_PLATFORM_FEE_PERCENT = 20`,
  `packages/payments/src/connect/shop-fees.ts`). The sub-entity must exist and
  be allowed to process, and Platforms must be enabled on the account. Otherwise
  Checkout.com rejects the request.
- Currency: `quote.currency.toUpperCase()`, so `SAR`. Amount is minor units
  (halalas). `billingCountryForCurrency` maps `SAR → SA`, `CAD → CA`, else `US`
  (`payment-config.server.ts:86-95`).
- 3DS: not set. No `3ds` object, so 3DS is left to the hosted page and the
  account's risk/3DS defaults. KSA cards (SAMA rules, mada) normally require 3DS
  for customer-initiated payments, which HPP handles.
- Capture: default (auto-capture). There is no auth-only option.
- Idempotency: none for Checkout.com (`idempotencyKey` is only passed for
  `connect`, checkout.server.ts:407-416). Replays rely on the regional
  single-shot bind; a replay with a bound Checkout.com session returns
  `409 session_in_progress` (checkout.server.ts:243-245). No customer email is
  sent (`customerEmail: null`).
- Unbound sessions are not cancelled for Checkout.com (`closeUnboundSession`
  only handles `connect`, checkout.server.ts:308-318).

### Webhook route and verification (code fact)

- `POST /api/shop/webhook` (`apps/app/app/routes/api+/shop+/webhook.tsx`). A
  request with a `cko-signature` header is treated as Checkout.com.
- Returns 503 unless `isProcessorConfigured('checkout')` (secret key, public
  key, subdomain and processing channel all set; commerce.ts:202-207).
- Verification: `hex(HMAC-SHA256(rawBody, CHECKOUT_WEBHOOK_SECRET))` compared in
  constant time with `cko-signature` (`checkout-shop.ts:267-282`). If the secret
  is unset, `verifyCheckoutWebhook` throws "not configured" and the route
  returns 500.
- Handled event types: `payment_approved`, `payment_captured`,
  `payment_declined`, `payment_pending` (`checkout-shop.ts:288-293`).
- Restaurant dispatch: `handleRestaurantOrderCheckoutWebhookEvent`
  (`apps/app/app/utils/restaurant-orders/payment-webhooks.server.ts:102-...`) →
  `mapCheckoutWebhookToRestaurantOrder`
  (`packages/payments/src/shop/restaurant.ts:155-182`). It requires
  `metadata.type === 'restaurant_order'`, `orgId`, `orderId` **and**
  `data.processing.payment_session_id`; the event is ignored without that field.
  Whether a payment made through HPP (or Flow) carries the `ps_`/`hpp_` id in
  `processing.payment_session_id` is unverified. If it does not, every
  restaurant webhook is silently dropped. The regional service matches on that
  session id.

### Metadata and reference (code fact)

- `reference`: `restaurant_order:<orgId>:<orderId>` (shop default is the orgId).
- `metadata`: `{ type, orgId, orderId, productName }`, values truncated to 500
  characters on read.

---

## 3. Can the App learn payment status without a webhook?

**Restaurant orders: webhook-only today (code fact).**
`getRestaurantOrderPaymentStatus` (checkout.server.ts:515-604) only does a
provider lookup when `bound.processor === 'connect'`. The comment at 553-554
reads "Checkout.com does not expose session retrieval by id, so webhooks remain
its path". For Checkout.com the poll returns only the regional state, which
changes only when `/api/shop/webhook` delivers. The success URL carries only
`?order=<id>`.

**Legacy shop: has an API lookup (code fact).**
`/resources/sites/shop/checkout/return` forwards `cko-payment-id` and
`cko-session-id` from the redirect to the site success page
(`apps/app/app/routes/resources+/sites.shop.checkout.return.ts`), and
`ShopCommerce.getOrderStatus` calls `payments.get(paymentId)` =
`GET /payments/{id}` (commerce.ts:660-680; `retrieveCheckoutShopPayment`,
checkout-shop.ts:207-244). Paid means `approved === true` or status
`Authorized`/`Captured`.

**What is possible without webhooks (Docs, confirmed or recalled):**

- `GET /payments/{id}` accepts a payment id **or** the `cko-session-id`
  (`sid_...`) appended to the redirect URL (Docs, confirmed: "Get payment
  details" says the session id is "provided in the cko-session-id query
  parameter included in the redirect URL back to your site").
- `GET /hosted-payments/{hpp_id}` (SDK `hostedPayments.get`) returns the HPP
  status and, once paid, the payment id (Docs, recalled, verify). The App
  already stores the bound session id regionally, so a server-side poll needs no
  browser parameter.
- `POST /payments/search` (SDK `payments.search`,
  `dist/api/payments/payments.js:252-254`) can find payments by `reference`
  (Docs, recalled, verify). This suits a jobs-cron reconciliation sweep.

Recommendation: for reservations, bind the `hpp_...` id, and in the status poll
call `GET /hosted-payments/{id}` then `GET /payments/{payment_id}`, checking
`metadata.orgId`/`reservationId`, amount, currency and `reference`. Treat
`cko-session-id` on the redirect as a hint only. This makes local tests
independent of inbound webhooks.

---

## 4. Env vars by flow (code fact)

All are App-only (`apps/app/.env.schema:84-105`). tenant-api and Sites need
none. `isConfiguredSecret` treats any value containing `***` as unset.

| Var                                         | Needed for                            | Notes                                                                                                                                                                                                   |
| ------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHECKOUT_SECRET_KEY` (`sk_sbox_...`)       | Everything                            | Must match `^sk_sbox_?[a-z2-7]{26}[a-z2-7*#$=]$` to get the `Bearer` prefix (`dist/config.js:25`, `auth-builder.js`). The SDK picks sandbox or live **from the key**, not from `CHECKOUT_ENVIRONMENT`.  |
| `CHECKOUT_PUBLIC_KEY` (`pk_sbox_...`)       | Gate only (`isProcessorConfigured`)   | Not sent anywhere for hosted flows. Needed later by Flow/Frames in the browser.                                                                                                                         |
| `CHECKOUT_SUBDOMAIN`                        | Gate and API host                     | The account prefix; host becomes `https://<prefix>.api.sandbox.checkout.com`. Must match `^(?:pl-)?[a-z0-9]+$` or the SDK silently falls back to `api.sandbox.checkout.com` with a deprecation warning. |
| `CHECKOUT_PROCESSING_CHANNEL_ID` (`pc_...`) | Gate and every payment                | One channel for all orgs.                                                                                                                                                                               |
| `CHECKOUT_ENVIRONMENT=sandbox`              | Dashboard link only                   | Ignored by the SDK for static keys.                                                                                                                                                                     |
| `CHECKOUT_WEBHOOK_SECRET`                   | `/api/shop/webhook` verification only | Not part of `isProcessorConfigured`; checkout works without it, webhooks then return 500.                                                                                                               |

Flow matrix:

- Sub-entity invite and status sync: secret key, public key, subdomain,
  processing channel (all four are required by `getCheckoutShop()`,
  commerce.ts:236-244, even though only the secret key and subdomain are used).
- Order checkout session: same four, plus an org with `checkoutSubEntityId` and
  `checkoutChargesEnabled = 1` and `shopPaymentProvider = 'checkout'`.
- Webhooks: the four plus `CHECKOUT_WEBHOOK_SECRET`.
- Dashboard link: the four plus `CHECKOUT_ENVIRONMENT`.

Put them in `apps/app/.env` (gitignored). `apps/app/.env.local` is not
gitignored, and `.dev.vars` is regenerated by `scripts/sync-dev-vars.mjs` on
`npm run dev -w app`.

---

## 5. What Checkout.com documentation says

WebSearch returned page titles and short snippets but not full bodies for these
pages, so most details below are "recalled, verify".

### What a sandbox account provides

- Sign-up: `https://www.checkout.com/get-test-account`. Support article "Create
  a sandbox account" (Docs, confirmed): "You can test card payments straight
  away with your sandbox account. To test alternative payment methods, or
  payments that u[se ...]" (truncated; the rest says to contact Checkout.com for
  those).
- Keys: Dashboard (`dashboard.sandbox.checkout.com`) → Developers → Keys,
  "Create a new key" (Docs, confirmed: "Generate and manage test API keys"). A
  default secret/public key pair is usually created at sign-up. The secret is
  shown once.
- Subdomain prefix: Dashboard → Developers → Overview shows the account's unique
  base URL `https://{prefix}.api.sandbox.checkout.com` (SDK `Environment.js:7`
  and its deprecation message say the same).
- Processing channel: a default channel (`pc_...`) is created with the account.
  It is shown under Settings → Channels / processing channels, and on the key
  details (recalled, verify).
- Webhooks: Dashboard → Developers → Webhooks (or Workflows). You supply an
  endpoint URL and a signature key; `cko-signature` is the HMAC-SHA256 of the
  body with that key (matches the code). A public URL is required.

### Platforms (sub-entities, amount_allocations)

- Platforms is a separate product. A self-serve sandbox account is a standard
  merchant account; Platforms (the `/accounts/entities` API, sub-entities,
  `amount_allocations`) has to be **enabled by Checkout.com** (account manager,
  solutions engineer or support) (recalled, verify). Without it,
  `POST /accounts/entities` returns 401/403 and payments with
  `amount_allocations` are rejected.
- Platforms docs come in "for SaaS" and "for PayFac" variants (Docs, confirmed:
  "Onboard sub-entities", "Onboard with Hosted Onboarding", "Onboard a
  sub-entity using the API", "Sub-entity status", "Process payments on a full
  account"). Which model the platform is on decides which fields are required.
- Authentication for Platforms endpoints is typically OAuth client credentials
  (`ack_...` access key id plus secret, scope `accounts`); static keys may need
  that scope (recalled, verify). The installed SDK sends the static key.
- Sandbox activation: the sandbox-only **Onboarding Simulator** sets a
  sub-entity's status or runs scenarios (SDK endpoints `/simulate/...`; Docs
  page title "Sub-entity status" confirmed). Without it, a sandbox sub-entity
  stays in review or "requirements due". Programmatic `POST /accounts/entities`
  with full company details (not `is_draft`) plus the simulator is the reliable
  way to reach an active sub-entity in sandbox. The hosted-invite flow the App
  uses depends on someone completing the emailed form, and activation may still
  need the simulator.

### Stored cards and MIT (Docs: "Unscheduled payments with stored card details", "Recurring payments with stored card details" confirmed; fields recalled, verify)

1. First payment, customer-initiated (CIT) with 3DS:
   `payment_type: "Unscheduled"`, `merchant_initiated: false`, a card or token
   source, and `store_for_future_use: true` (default for card sources). The
   response carries `source.id` (`src_...`, the stored instrument),
   `customer.id` (`cus_...`) and `scheme_id` (network transaction id). Save `id`
   (the `pay_...`) as the future `previous_payment_id`.
2. Later charge (MIT): `POST /payments` with
   `{ "source": { "type": "id", "id": "src_..." }, "payment_type": "Unscheduled", "merchant_initiated": true, "previous_payment_id": "pay_...", "amount": ..., "currency": "SAR", "processing_channel_id": "pc_...", "reference": "...", "amount_allocations": [...] }`
   and an `Idempotency-Key` header (SDK
   `payments.request(body, idempotencyKey)`). No 3DS; MITs are out of scope of
   SCA (Checkout.com blog "What are merchant initiated transactions (MIT)?"
   confirmed).
3. A zero-amount card verification (`amount: 0`) via `POST /payments` is the
   usual way to save a card without charging; HPP may not accept 0. Whether the
   HPP response exposes a reusable `src_` for later MIT, and whether HPP accepts
   `payment_type: "Unscheduled"`, must be verified. If not, the guarantee flow
   needs Flow or Frames in the guest's browser (card data goes from the browser
   straight to Checkout.com) and a server `POST /payments` with the token.

### mada

- Checkout.com has mada pages (Docs, confirmed: "Mada", "Mada for Unified
  Payments API"). mada is the Saudi domestic debit scheme, usually co-badged
  with Visa or Mastercard. Customer-initiated mada payments require 3DS.
- MIT and card-on-file on the mada rail: **not confirmed**. Historically mada
  did not support merchant-initiated or recurring charges; co-badged cards can
  sometimes be processed on the international scheme instead, with different
  fees and approval rates. Ask Checkout.com explicitly, and test with the mada
  test cards before promising no-show fees in KSA.

### Refunds (Docs, confirmed: "Refund a payment", "Payment refunded" event, "Process payments on a full account")

- `POST /payments/{id}/refunds` with optional `amount` (partial) and
  `reference`, plus an `Idempotency-Key` (SDK `payments.refund(id, body, key)`,
  `dist/api/payments/payments.js:197-199`). Response is `202` with an action id;
  the outcome arrives as `payment_refunded` or `payment_refund_declined`
  webhooks, or as an entry in `GET /payments/{id}/actions` (SDK
  `payments.getActions`). The action list gives a webhook-free check.
- For Platforms payments, the refund body accepts `amount_allocations` to say
  how much each sub-entity returns and how much commission is reversed
  (recalled, verify).
- `POST /payments/{id}/reversals` voids or refunds depending on state.

### Test cards (Docs page "Test cards" confirmed; numbers recalled, verify against that page)

| Card                             | Use                                                                                                                                                                                                                           |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Visa `4242 4242 4242 4242`       | Success, frictionless                                                                                                                                                                                                         |
| Mastercard `5436 0310 3060 6378` | Success                                                                                                                                                                                                                       |
| Visa `4543 4740 0224 9996`       | 3DS challenge                                                                                                                                                                                                                 |
| Mastercard `5352 1515 7000 3404` | 3DS challenge                                                                                                                                                                                                                 |
| 3DS simulator password           | `Checkout1!`                                                                                                                                                                                                                  |
| Declines                         | Sandbox simulates response codes by **amount**: an amount ending in `05` declines "Do not honour" (20005), `51` insufficient funds (20051), `12` invalid transaction, `54` expired card. Use e.g. SAR 10.05 = `1005` halalas. |
| mada                             | Use the "mada" section of the test cards page. I could not retrieve the numbers, so none are listed here.                                                                                                                     |

Any future expiry and any CVC (`100` is a common default) work.

---

## 6. Recommended simplest sandbox setup

### Decision: sub-entity or platform entity?

- Every existing Checkout.com payment sends `amount_allocations` with the org's
  sub-entity, and online payment is only enabled for an org with
  `checkoutSubEntityId` and `checkoutChargesEnabled`. Without Platforms enabled
  on the sandbox, every payment would be rejected.
- **Fastest path (no Checkout.com support ticket):** charge the platform entity
  directly in sandbox, with **no `amount_allocations`**. A plain sandbox account
  can do (a) HPP in SAR, (b) save card plus MIT, and (c) refunds. This needs a
  small code change in the reservations work: omit `amount_allocations` when a
  sandbox-only switch is on (for example `CHECKOUT_PLATFORMS_ENABLED=false`, or
  when the org's sub-entity id is a sentinel). The org columns can then be set
  to a placeholder so the payment gate opens. Caveat: the settings loader
  re-syncs any non-null `checkoutSubEntityId` on every visit (shop.tsx:85-94). A
  placeholder id fails the lookup and is only logged, but a real sub-entity
  reporting `payments.enabled = false` flips `checkoutChargesEnabled` back to 0.
- **High-fidelity path:** ask Checkout.com to enable Platforms on the sandbox,
  then test the split and commission reversal for real.

### Steps for the user

1. Create a sandbox account at `https://www.checkout.com/get-test-account` and
   sign in at `https://dashboard.sandbox.checkout.com`.
2. Developers → Overview: copy the account prefix (the part before
   `.api.sandbox.checkout.com`).
3. Developers → Keys: create (or reveal) a secret key `sk_sbox_...` and the
   public key `pk_sbox_...`. Give the secret key all default scopes.
4. Settings → Processing channels (or the channel shown on the key): copy the
   `pc_...` id. Confirm SAR is enabled on that channel; ask support if a SAR
   test payment is rejected.
5. Optional, for webhooks: only with a public tunnel. Add a webhook on
   `payment_approved`, `payment_captured`, `payment_declined`,
   `payment_pending`, `payment_refunded`, `payment_refund_declined` pointing at
   `https://<tunnel>/api/shop/webhook`, and copy its signature key.
6. Ask Checkout.com support or your account contact for:
   - Platforms enabled on the sandbox (only for the high-fidelity path),
     including the OAuth client (`ack_...`, scope `accounts`) and access to the
     Onboarding Simulator;
   - card-on-file / MIT (`payment_type: Unscheduled`, `merchant_initiated`)
     enabled on the processing channel;
   - mada enabled for test, plus confirmation of whether mada supports MIT and
     whether co-badged cards can be routed internationally for MIT;
   - SAR on the processing channel;
   - whether HPP can store a card for later MIT and accept
     `payment_type: "Unscheduled"`.

### `apps/app/.env`

```
CHECKOUT_SECRET_KEY=sk_sbox_...
CHECKOUT_PUBLIC_KEY=pk_sbox_...
CHECKOUT_SUBDOMAIN=<prefix>
CHECKOUT_PROCESSING_CHANNEL_ID=pc_...
CHECKOUT_ENVIRONMENT=sandbox
CHECKOUT_WEBHOOK_SECRET=<signature key, only if a tunnel is used>
```

Restart `npm run dev -w app` so `.dev.vars` is regenerated. Keep `MOCKS=true`;
MSW does not run in the default workerd dev runtime.

### Linking a KSA test org locally

The seeded `acme` org is `us`. Use a KSA org:

1. Create an org in the App and set **Customer data region** to KSA, so it is
   provisioned on the KSA tenant-api (`:3009`). (Changing `acme` to KSA wipes
   its tenant DB.) Publish its site.
2. Write the columns in local D1 (from `apps/app`):

   ```
   npx wrangler d1 execute DB --local --command "UPDATE Organization SET shopPaymentProvider='checkout', checkoutSubEntityId='<ent_... or sandbox placeholder>', checkoutChargesEnabled=1, checkoutPayoutsEnabled=1 WHERE slug='<ksa-slug>'"
   ```

   Apply the same update to `packages/database/db/data.db` with `sqlite3` to
   keep the copies consistent. Check `/resources/order-context?orgId=...` for
   `onlinePayment.enabled: true` and `processor: 'checkout'`.

### Test plan

- **(a) Deposit in SAR via HPP:** create the HPP with `currency: "SAR"`,
  `billing.address.country: "SA"`, pay with `4242...` and with the 3DS card
  (`Checkout1!`), then confirm by API (`GET /hosted-payments/{id}` →
  `GET /payments/{pay_id}`). No webhook needed. Also test a decline amount
  ending in `05`.
- **(b) Saved card and MIT no-show fee:** CIT with `payment_type: "Unscheduled"`
  (deposit or a zero-amount verification, with 3DS) → keep `source.id` and `id`
  → `POST /payments` with `source.type: "id"`, `merchant_initiated: true`,
  `previous_payment_id`, and an idempotency key. The response is synchronous.
  Use Visa/Mastercard only until mada MIT is confirmed.
- **(c) Refund:** `POST /payments/{id}/refunds` with `amount` and `reference`,
  then poll `GET /payments/{id}/actions` until a `Refund` action with
  `approved: true` appears.

### Feasibility summary

| Item                                   | Feasible in a plain sandbox               | Notes                                                         |
| -------------------------------------- | ----------------------------------------- | ------------------------------------------------------------- |
| HPP in SAR, 3DS, declines              | Yes                                       | Needs the `/hosted-payments` switch; SAR on channel to verify |
| Status by API, no webhooks             | Yes                                       | Needs new code for Checkout.com; today it is webhook-only     |
| Saved card plus MIT (Visa/MC)          | Yes, if MIT is enabled on the channel     | HPP storage to verify; Flow/Frames is the fallback            |
| mada MIT                               | Unconfirmed                               | Ask Checkout.com                                              |
| Refunds                                | Yes                                       | Async outcome; poll actions                                   |
| Sub-entities and `amount_allocations`  | Only after Checkout.com enables Platforms | Activation via Onboarding Simulator (OAuth)                   |
| Hosted invite onboarding in KSA via UI | No                                        | Three US-only guards                                          |
| Inbound webhooks locally               | No                                        | Needs a public tunnel                                         |
