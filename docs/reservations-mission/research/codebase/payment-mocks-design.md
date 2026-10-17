# Payment provider mocks (Stripe Connect, Checkout.com): design

Scope: how GitHub login is mocked today, which payment mocks exist, and a design
for local Stripe and Checkout.com emulators. The emulators must let the full
reservation payment flows (and the existing restaurant order payments) run
locally with no provider keys. The user decided that there will be no real
Stripe or Checkout.com keys, and that validation runs against these mocks.

Paths are relative to `/home/factory-user/repos/menuza` unless absolute. No
repository file was modified. This builds on `payments-deep-dive.md` and
`checkout-com-setup.md` in this folder and does not repeat them.

Confidence labels:

- **Code fact**: read in this repository or in the installed SDKs (`stripe`
  18.5.0, `checkout-sdk-node` 4.1.0).
- **Provider fact (verify)**: provider behavior recalled from the docs. Items
  marked "verify" are ones the earlier reports could not confirm.

---

## 1. How GitHub login is mocked today

### 1.1 Switches

| Switch                                                                                     | Where                                                                                                                                                                                                                                                                                                                       | Effect                                                                                                       |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `MOCKS=true`                                                                               | Set by `apps/app/package.json` scripts `dev` (Workers vite), `dev:node`, `dev:all-mocks`, `start:mocks`; also `apps/app/.env.development:2`. Schema default is `MOCKS=false` (`packages/email/.env.schema`, imported by `apps/app/.env.schema:12`). Playwright forces `MOCKS: 'true'` (`apps/app/playwright.config.ts:60`). | Master mock switch.                                                                                          |
| `GITHUB_CLIENT_ID=MOCK_GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET=MOCK_GITHUB_CLIENT_SECRET` | Schema defaults in `packages/auth/.env.schema:19-27`                                                                                                                                                                                                                                                                        | A `MOCK_` client id turns the mock on even without `MOCKS`.                                                  |
| `NODE_ENV=test`                                                                            | Vitest                                                                                                                                                                                                                                                                                                                      | Also turns on the GitHub mock (`github.server.ts:24-30`).                                                    |
| `CI=true`                                                                                  | `npm run test:e2e:run` and GitHub Actions                                                                                                                                                                                                                                                                                   | Turns off the Workers-dev callback bypass, so OAuth goes through MSW instead (`mock-oauth.server.ts:29-34`). |

### 1.2 Shared first leg: the authorize redirect never reaches github.com

1. `POST /auth/github` runs the action in
   `apps/app/app/routes/_auth+/auth_.$provider.ts:13-37`. It calls
   `handleMockAction(providerName, request)` before
   `authenticator.authenticate`. The mobile API route
   `apps/app/app/routes/api+/auth.$provider.ts:11` does the same.
2. `handleMockAction` (`packages/auth/src/connections.server.ts:12-13`)
   dispatches to `GitHubProvider.handleMockAction`
   (`packages/auth/src/providers/github.server.ts:138-160`). When `shouldMock()`
   is true, it:
   - creates a random `state`;
   - takes `code` from the `x-mock-code-github` header, or defaults to
     `MOCK_CODE_GITHUB_KODY` (`packages/auth/src/constants.ts:3,6`);
   - sets a `github` cookie holding `code` and `state` (HttpOnly, Lax, 10
     minutes);
   - throws a `303` to `/auth/github/callback?code=…&state=…`.

   So the browser never visits github.com. Google follows the same pattern in
   `google.server.ts:105`.

### 1.3 (a) Workers vite dev (`npm run dev -w app`, port 3001)

- **MSW is not loaded in this runtime (verified).**
  - The only MSW bootstrap is `apps/app/index.ts:19-21`
    (`if (process.env.MOCKS === 'true') await import('./tests/mocks/index.ts')`).
    That file is the Node entry.
  - `npm run dev` runs `vite dev` with the Cloudflare plugin. The worker entry
    is `apps/app/workers/app.ts`, and it never imports `tests/mocks`.
  - A grep of `vite.config.ts`, `workers/`, `app/` and `server/` for
    `tests/mocks` or `msw` finds nothing.
- `apps/app/app/routes/_auth+/auth.$provider.callback.ts:40-53` checks
  `isWorkersDevMockOAuthCallback(providerName)` first. That check is
  `MOCKS==='true' && CI!=='true' && isMockOAuthProvider`
  (`packages/auth/src/mock-oauth.server.ts:29-34`). When it is true, the
  callback calls `tryAuthenticateMockProvider` (`mock-oauth.server.ts:41-80`),
  which:
  - returns `null` when `NODE_ENV === 'production'`;
  - checks that the query `state` equals the `state` in the `github` cookie;
  - returns a **fixed profile**: id `1194954954264657`, email
    `Jovan.Runolfsdottir@hotmail.com`, username `Zackary.Carter`. This matches
    `packages/test-utils/fixtures/github/users.0.local.json`, which
    `packages/database/seed.ts:136` writes with
    `insertGitHubUser(MOCK_CODE_GITHUB)`.

  No token exchange or `api.github.com` call happens. The rest of the callback
  (connection lookup, onboarding, session) is the real code.

- The same file has a precedent for Workers-only network mocks:
  `apps/app/workers/dev-s3-mock.ts`. `installDevS3Mock(env)` is called on every
  request in `workers/app.ts:29`. It wraps `globalThis.fetch` and serves the
  mock S3 bucket from the `CACHE` KV binding. It is guarded by
  `process.env.MOCKS !== 'true' || import.meta.env.PROD` (line 28).

### 1.4 (b) Node mock server (Playwright CI: `npm run start:mocks`)

- In Playwright, `webServer.command` is `npm run start:mocks` when `CI` is set
  and `npm run dev` (Workers) otherwise (`playwright.config.ts:46-60`).
  `start:mocks` is `cross-env NODE_ENV=production MOCKS=true node index.ts`, run
  against the production **Node** build (`pretest:e2e:run: npm run build`).
  - The script's `NODE_ENV=production` overrides the `NODE_ENV: 'test'` that
    `playwright.config.ts` passes.
  - Consequence: **CI runs mocks with `NODE_ENV=production`.** A mock guard
    based on `NODE_ENV` would turn the mocks off in CI.
- `index.ts` imports `apps/app/tests/mocks/index.ts`, which re-exports
  `@repo/test-utils/mocks`. `packages/test-utils/src/mocks/index.ts` calls
  `setupServer(...)` with the Stripe, tenant-api, Google Places, Resend, OCI
  email, GitHub, POS, Tigris and pwned-password handlers, then
  `server.listen()`.
- The callback bypass is off (`CI=true`). `authenticator.authenticate` runs the
  real `remix-auth-github` strategy, and MSW intercepts its calls
  (`packages/test-utils/src/mocks/github.ts:136-184`):
  - `POST https://github.com/login/oauth/access_token` finds or creates a fake
    user for `code` and returns `{ access_token: '<code>_mock_access_token' }`;
  - `GET api.github.com/user`, `/user/emails` and `/user/:id` look the user up
    by bearer token or id.
  - Handlers pass through to the real API only when the client id is not `MOCK_`
    and `NODE_ENV !== 'test'` (line 132-134).
- **Fake users** are created with faker by `createGitHubUser(code)`
  (`github.ts:25-68`) and persisted to a **JSON file on disk**,
  `packages/test-utils/fixtures/github/users.<VITEST_POOL_ID|0>.local.json`
  (lines 13-21, 97-99). That file is what shares state between processes:
  - the Playwright fixture `prepareGitHubUser`
    (`apps/app/tests/playwright-utils.ts:194-215`) calls
    `insertGitHubUser(testInfo.testId)`, then routes `/auth/github` to add
    `x-mock-code-github: <testId>`;
  - the server's MSW handler then finds that user in the same file.

### 1.5 How it is kept out of production

The protection is runtime-only. It is not excluded at build time:

1. `MOCKS` defaults to `false`, and deploys never set it.
2. MSW only loads from the Node entry when `MOCKS==='true'`. The production
   runtime is Workers, which never loads it.
3. `tryAuthenticateMockProvider` returns `null` when `NODE_ENV==='production'`.
4. `root.tsx:440-455` (`hasConfiguredProvider`) hides providers whose client id
   starts with `MOCK_` when `NODE_ENV==='production'` and `MOCKS` is not true.
5. Similar dev-only routes 404 unless mocks are on, for example
   `apps/app/app/routes/api+/mock-env.ts:5`.
6. The S3 mock adds a build-time guard (`import.meta.env.PROD`).

**Caveat:** `handleMockAction` keys only on `MOCKS==='true'` or a `MOCK_` client
id. The schema default **is** `MOCK_GITHUB_CLIENT_ID`. Production therefore
relies on real `GITHUB_*` secrets being set, and on the UI hiding `MOCK_`
providers. This is weaker than it looks, and the payment mock should not copy it
(see section 3.2).

---

## 2. Existing payment mocks and "configured or enabled" decisions

### 2.1 Existing mocks

- **Stripe: none.** `packages/test-utils/src/mocks/stripe.ts` returns
  `passthrough()` for every method on `https://api.stripe.com/*`.
  `packages/test-utils/src/mocks/index.ts` also lists `api.stripe.com` and
  `stripe.com` in `bypassUrls`. Even in Node mock mode, every Stripe call would
  go to the real API.
- **Checkout.com: none.** No MSW handler exists, and `api.sandbox.checkout.com`
  is not referenced in test-utils.
- **Polar: none.**
- **Unit tests** stub the App boundary instead:
  - `apps/app/app/utils/restaurant-orders/checkout.server.test.ts:57` uses
    `vi.mock('#app/utils/shop.server.ts')`;
  - `configureShopCommerceForTests(env)`
    (`apps/app/app/utils/shop.server.ts:55-59`) rebuilds the commerce singleton
    from an env-like object;
  - `packages/payments/src/connect/checkout-shop.test.ts` stubs the SDK client
    object.

  No test exercises a real HTTP response shape.

### 2.2 How placeholder keys make online payment "unconfigured"

- `isConfiguredSecret` (`packages/payments/src/shop/config.ts:17-20`) rejects
  any value that contains `***`. `.dev.vars` holds the schema placeholders
  `sk_test_***`, `pk_test_***` and `whsec_***`. Checkout.com keys are absent,
  and `CHECKOUT_SUBDOMAIN` and `CHECKOUT_PROCESSING_CHANNEL_ID` are empty.
- As a result, `stripeSecretKey`, `checkoutSecretKey` and the other values are
  `undefined`, and `ShopCommerce.isProcessorConfigured`
  (`packages/payments/src/shop/commerce.ts:195-211`) returns false for `connect`
  and `checkout`.
- `validateStripeKeys` is `MOCKS !== 'true' && NODE_ENV !== 'test'`
  (`config.ts:67`). It only gates the publishable-key consistency check used by
  the inline-card shop flow.

### 2.3 Every place that decides "payments configured or enabled"

| #   | Location                                                                                                                                                                           | Decision                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `packages/payments/src/shop/config.ts:17-68`                                                                                                                                       | Secrets present and not placeholders.                                                                                                                                          |
| 2   | `commerce.ts:195-211` `isProcessorConfigured`                                                                                                                                      | `connect` needs `stripeSecretKey`. `checkout` needs secret key, public key, subdomain and processing channel. `mor` needs the Polar token.                                     |
| 3   | `commerce.ts:187-193` `listConfiguredProcessors`                                                                                                                                   | Feeds `configuredProcessors` in the Settings → Shop loader (`settings+/shop.tsx:117`). The Checkout.com buttons render only when it includes `checkout` (`shop-card.tsx:146`). |
| 4   | `commerce.ts:236-265` `getCheckoutShop` / `getStripe`                                                                                                                              | Throw "not configured" when keys are missing. `StripeProvider` also requires the `sk_` prefix (`providers/stripe.ts:24-40`).                                                   |
| 5   | `apps/app/app/utils/restaurant-orders/payment-config.server.ts:46-77` `resolveRestaurantOnlinePayment`                                                                             | Org state only. `connect` needs region `us`, `stripeConnectAccountId` and `stripeConnectChargesEnabled`. `checkout` needs `checkoutSubEntityId` and `checkoutChargesEnabled`.  |
| 6   | `apps/app/app/routes/resources+/order-context.ts:131`                                                                                                                              | Embeds #5 as `onlinePayment` for the regional service. Regional `order-service.ts:416` refuses `paymentMethod: 'online'` when it is disabled.                                  |
| 7   | `checkout.server.ts:339-349`                                                                                                                                                       | #5 **and** `commerce.isProcessorConfigured(processor)`, otherwise `409 online_payment_unavailable`.                                                                            |
| 8   | `checkout.server.ts:238-245, 308-318, 553-556`                                                                                                                                     | Processor capabilities: Stripe sessions are recoverable, expirable and pollable. Checkout.com is webhook-only.                                                                 |
| 9   | `shop.server.ts` `findPublishedShopOrganization`, `getPublicShopProduct` (`isShopAvailableForOrganization`), `startConnectOnboarding:243`, `inviteCheckoutSubEntityOnboarding:333` | Legacy shop availability, plus US-only onboarding guards.                                                                                                                      |
| 10  | `settings+/shop.tsx:152-160, 215-222`; `shop-card.tsx:78-84`                                                                                                                       | US-only UI and action guards (three layers for Checkout.com; see `checkout-com-setup.md` §1).                                                                                  |
| 11  | `routes/api+/shop+/webhook.tsx`                                                                                                                                                    | `503` unless `isProcessorConfigured('checkout')`; `500` if `CHECKOUT_WEBHOOK_SECRET` is unset.                                                                                 |
| 12  | `routes/api+/stripe+/webhook.tsx:50-55`                                                                                                                                            | Verifies with `process.env.STRIPE_WEBHOOK_SECRET` read directly. The placeholder `whsec_***` is a usable HMAC key string.                                                      |
| 13  | `apps/sites/src/lib/ordering/order-client.ts:255-257`                                                                                                                              | The browser rejects any `checkoutUrl` that is not `https:`. **A mock checkout page on `http://localhost:3001` would be rejected.**                                             |

Also relevant:

- `ShopCommerce.withConnect` (`commerce.ts:300-308`) rewraps every Stripe error
  as a plain `Error`. That drops `type`, `code`, `decline_code` and
  `raw.payment_intent`, which the off-session fee flow needs. Reservations code
  must preserve them, and the mock's tests will catch it if it does not.
- The legacy single-product shop uses Stripe.js inline card for `connect`
  (`processors.ts:16`, `supportsInlineCard: true`). A server-side mock cannot
  emulate this browser SDK. It is out of scope.

---

## 3. Design: provider emulators "the GitHub way"

### 3.1 Approach

There are three candidate approaches:

| Option                                                              | Verdict                                                                                                                                                                            |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MSW handlers                                                        | **Rejected as the primary path.** MSW does not run in Workers vite dev, which is the validators' topology. It would need a second implementation there anyway, as S3 already does. |
| Hand-written fake `ShopCommerce` or adapter interface               | **Rejected.** It bypasses the real SDKs, so request encoding, error classes and response typing all go untested. It drifts from real behavior fastest.                             |
| **Real SDKs with an in-process transport into a stateful emulator** | **Chosen.**                                                                                                                                                                        |

How the chosen approach works:

- **Stripe:**
  `new Stripe(key, { httpClient: Stripe.createFetchHttpClient(mockFetch) })`.
  `createFetchHttpClient(fetchFn)` accepts a custom fetch (code fact:
  `node_modules/stripe/cjs/net/FetchHttpClient.js:15-24`). The emulator receives
  the SDK's real form-encoded requests. Its JSON or error responses are turned
  into real `Stripe.errors.StripeCardError` and other error classes by the SDK
  itself. No global patching is needed.
- **Checkout.com:**
  `new Checkout(key, { host: 'https://checkout-com.mock.invalid', subdomain, pk })`.
  The SDK accepts a custom `host` (`dist/auth-builder.js` `setupCustomHost`). It
  always calls **global** `fetch(path, …)` (`dist/services/http.js:285`) and has
  no injectable fetch. A wrapper therefore intercepts **only** the reserved
  `.invalid` origin, which can never resolve in reality. This is the same
  pattern as `dev-s3-mock.ts`. The wrapper is idempotent and is installed when
  the Checkout.com client is built in mock mode.
- One emulator core, a pure `(Request) => Promise<Response>` plus a store, runs
  unchanged in Workers dev, the Node dev server, Node `start:mocks` (Playwright
  CI) and Vitest. MSW Stripe handlers stay passthrough, so real keys keep
  working if anyone ever adds them.

### 3.2 Activation and production exclusion

**Activation rule.** It lives in `packages/payments/src/mock/env.ts`:

```ts
// Compile-time constant: false in the Cloudflare production build.
declare const __PAYMENTS_MOCK_BUNDLED__: boolean

export function paymentsMockMode(env) {
	if (!__PAYMENTS_MOCK_BUNDLED__) return { stripe: false, checkout: false }
	if (env.PAYMENTS_MOCK === 'false') return { stripe: false, checkout: false }
	const on = env.MOCKS === 'true' || env.PAYMENTS_MOCK === 'true'
	if (!on) return { stripe: false, checkout: false }
	if (/^sk_live_/.test(env.STRIPE_SECRET_KEY ?? ''))
		throw new Error('Refusing payments mock with a live Stripe key')
	return {
		// A real test key wins, so opting in to real sandboxes later needs no code change.
		stripe: !isRealSecret(env.STRIPE_SECRET_KEY),
		checkout: !isRealSecret(env.CHECKOUT_SECRET_KEY),
	}
}
```

Notes on the rule:

- **No `NODE_ENV` gate.** CI runs `NODE_ENV=production MOCKS=true` (section
  1.4).
- **No key-prefix-only activation** (unlike GitHub's `MOCK_`). `MOCKS` or
  `PAYMENTS_MOCK` must be on explicitly.

**When the mock is on,** `createShopCommerceConfigFromEnv` fills in synthetic
values:

- `stripeSecretKey: 'sk_test_mock_platform'`
- a Checkout.com sandbox-shaped key that matches `NAS_SANDBOX_SECRET_KEY_REGEX`,
  so the SDK adds the `Bearer` prefix
- `checkoutPublicKey`, `checkoutSubdomain: 'mock'`,
  `checkoutProcessingChannelId: 'pc_mock…'`
- `checkoutWebhookSecret`
- a `mock` transport handle

`isProcessorConfigured`, `listConfiguredProcessors` and every gate in section
2.3 then behave exactly as in production. Online payment still needs the org to
be onboarded, which is the job of the onboarding helper (§3.7).

**Stripe webhook secret.** The route reads `process.env.STRIPE_WEBHOOK_SECRET`
directly. The emulator signs with the same value, even when it is the
`whsec_***` placeholder (any string is a valid HMAC key). Signing uses the SDK's
`stripe.webhooks.generateTestHeaderString({ payload, secret })`. It is better to
also introduce `getStripeWebhookSecrets()`, which accepts a list (platform
secret plus Connect secret). That fixes the production gap found in the deep
dive, and the mock then signs Connect events with the second secret.

**Production exclusion has four layers.** This is stronger than GitHub's
protection.

1. **Build-time stripping.**
   - `vite.config.ts` defines `__PAYMENTS_MOCK_BUNDLED__` as
     `!(DEPLOY_TARGET==='cloudflare' && command==='build')`. In
     `build:cf`/`deploy:cf`, the mock branch becomes dead code and dynamic
     `import('@repo/payments/mock')` calls are eliminated.
   - `app/routes.ts` adds `'**/mock-payments+/**'` to `ignoredRouteFiles` when
     an explicit `STRIP_DEV_MOCKS=1` is set. `build:cf` sets it, so there is no
     reliance on `NODE_ENV` inference at build time.
   - The Node build used by CI keeps the mock.
2. **Runtime gate.** `MOCKS` defaults to false. Every mock route loader/action
   returns `404` unless `paymentsMockMode()` is on, as `api+/mock-env.ts` does.
3. **Live-key refusal.** Startup throws if `sk_live_` is present while mocks are
   on.
4. **A CI assertion** after `build:cf`: grep the Worker bundle for a sentinel
   string such as `__MENUZA_PAYMENTS_MOCK__` and fail if it is found.

Visibility while the mock is on:

- Boot log: `PAYMENTS MOCK ACTIVE (stripe, checkout.com)`.
- A "Mock payments" badge on Settings → Shop.
- A banner on every mock page.

### 3.3 Where the code lives

```
packages/payments/src/mock/            (new subpath export "@repo/payments/mock")
  env.ts                 activation rule, synthetic keys, origins
  store.ts               MockStore interface + createMemoryStore() (Vitest)
  clock.ts, ids.ts       injectable clock; provider-shaped ids (cs_test_…, pi_…, seti_…, pm_…, cus_…, re_…, acct_…, evt_…; hpp_…, pay_…, src_…, sid_…, ent_…, act_…)
  cards.ts               shared test-card catalog and behavior profiles (both providers)
  emulator.ts            createPaymentsEmulator({ store, clock, origin, secrets })
  stripe/router.ts       method+path dispatch; form decoding with qs (already in node_modules); Stripe-Version check
  stripe/objects.ts      builders typed `satisfies Stripe.Checkout.Session` etc.
  stripe/errors.ts       Stripe error envelopes (400/402/404/409) + idempotency_error
  stripe/{accounts,customers,checkout-sessions,setup-intents,payment-methods,payment-intents,refunds,ledger,events}.ts
  checkout-com/router.ts JSON dispatch; Authorization check; Cko-Idempotency-Key
  checkout-com/{entities,hosted-payments,payment-sessions,payments,refunds,allocations,events}.ts
  transport.ts           createMockStripeHttpClient(emulator); installCheckoutComMockFetch(emulator)
  testing.ts             helpers for Vitest (completeCheckout, settleRefund, advanceClock)

apps/app/app/utils/payments-mock/
  store.server.ts        SQL MockStore over @repo/database `db` (D1 in Workers, LibSQL in Node)
  emulator.server.ts     singleton wiring (origin, secrets, store)
  webhook-dispatch.server.ts  signed delivery to the real webhook routes
  onboard.server.ts      instant onboarding helper
apps/app/app/routes/mock-payments+/   (hosted pages + dev API; stripped in build:cf)
```

Edits to existing code, all small:

- `ShopCommerceConfig` gains `mock?: { stripeHttpClient; checkoutHost }`.
- `StripeProvider` / `createStripeProvider` accept `httpClient`.
- `createCheckoutShopClient` accepts `host`.
- `shop.server.ts:41-59` wires the emulator when the mock is on, and
  `configureShopCommerceForTests` accepts an emulator.
- `routes.ts`, `vite.config.ts` and the `build:cf` script implement the
  exclusion.
- Sites `order-client.ts:256` allows `http:` **only** for the loopback hosts
  `localhost`, `127.0.0.1` and `*.localhost`. A production App can never return
  such a URL, so this is safe in production. The alternative is the
  `https://app.menuza.test:2999` proxy, which validators do not run.
- `apps/app/.env.schema` documents `PAYMENTS_MOCK` and `PAYMENTS_MOCK_ORIGIN`.
  The origin defaults to `BASE_URL`, which is `http://localhost:3001` in the
  current `.dev.vars`.

### 3.4 State persistence

In-memory state is not usable: vite Workers dev reloads modules, isolates
recycle, and validators restart the App. Encoding state deterministically in ids
also fails, because refunds, attachments, expiry and idempotency are mutable.

Instead, `MockStore` has an SQL implementation over the **control-plane `db`**.
That is local D1 under `.wrangler/state` in Workers dev, and `packages/database`
LibSQL in Node. The tables are created lazily with `CREATE TABLE IF NOT EXISTS`
through `db.run(sql…)` on first use. **No Drizzle migration is needed, so
production schema is untouched.**

```sql
CREATE TABLE IF NOT EXISTS __mock_pay_object (
  provider TEXT NOT NULL,          -- 'stripe' | 'checkout'
  id TEXT NOT NULL,                -- provider-shaped id
  type TEXT NOT NULL,              -- 'checkout.session', 'payment_intent', 'hpp', 'payment', …
  parent_id TEXT,                  -- e.g. customer for pm, payment for refund, account for charge
  json TEXT NOT NULL,              -- full provider object as returned by the API
  transition_at INTEGER,           -- next scheduled state change (refund settle, session expiry)
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

- **Atomic state changes** use `UPDATE … WHERE json->>'$.status' = ?` with the
  row count checked. This gives single-shot completion and protects against
  refunding more than was charged under concurrency. SQLite JSON functions are
  available in both D1 and LibSQL.
- **Restarts:** state persists across App restarts. `npm run db:reset`, or the
  dev API `reset`, wipes it.
- **Topology:** the Workers-dev D1 and the Node `data.db` are separate. Each
  runtime is self-consistent, and only one App runs at a time.
- **Tests always talk to mock state through the dev HTTP API (§3.8)**, never
  through the database directly, so the same test works on both topologies.
  GitHub's JSON-file trick only works because Node CI shares a filesystem.
- **Time-based transitions** (session `expires_at`, pending refund → settled)
  are evaluated **lazily** on any read of the object, using `transition_at` and
  the injectable clock. The dev API can also force them.

### 3.5 Mock hosted pages served by the App

These are plain SSR routes under `apps/app/app/routes/mock-payments+/`. They are
progressive-enhancement forms with no client JS required. Each has labeled
inputs and stable `data-testid`s for browser agents, and a fixed banner reading
"Mock Stripe Checkout (local)" or "Mock Checkout.com HPP (local)".

**Stripe Checkout:** `GET /mock-payments/stripe/checkout/:sessionId`. This is
the session `url` that `checkout.sessions.create` returns.

- The page shows:
  - the merchant: the platform name and the connected account's display name;
  - the line items, amount and currency;
  - the **mode** (payment vs setup: "Save card for later charges");
  - `custom_text.submit.message`, where reservation consent text appears;
  - the `expires_at` countdown.
- Fields: email (Stripe always collects one), card number, expiry, CVC,
  cardholder name, ZIP.
- Buttons: **Pay** or **Save card**, and **Back** (which goes to `cancel_url`).
- Validation mirrors the real page: Luhn, a future expiry, and a 3–4 digit CVC.
  A valid card number that is not a test card is rejected with "Your card was
  declined. Your request was in test mode, but used a non test card", which is
  real test-mode behavior.
- On a decline the page re-renders with an inline error and the session stays
  `open`, as on real Stripe.
- An expired or completed session shows Stripe's "This Checkout Session is no
  longer active" state.
- **3DS:** when the card profile requires it, the page redirects to
  `/mock-payments/stripe/3ds/:attemptId`. That page has **Complete
  authentication** and **Fail authentication** buttons, mirroring Stripe's test
  3DS page.
- **Completion:**
  1. update the session to `complete` and `payment_status` to `paid` (or
     `no_payment_required` in setup mode);
  2. update the PaymentIntent or SetupIntent, the PaymentMethod, and the charge,
     transfer and application fee;
  3. queue events;
  4. optionally deliver them (§3.6);
  5. `303` to `success_url`, with `{CHECKOUT_SESSION_ID}` substituted when it is
     present.

**Checkout.com HPP:** `GET /mock-payments/checkout-com/hpp/:hppId`. This is
`_links.redirect.href` from `POST /hosted-payments`.

- Same layout, with Checkout.com test cards.
- 3DS challenge page with a password field. `Checkout1!` succeeds and anything
  else fails.
- Amount-based declines (§3.6) are applied at submit.
- Redirects:
  - success: `success_url?cko-session-id=sid_…`;
  - failure: `failure_url?cko-session-id=sid_…`;
  - Back: `cancel_url`.

  The `sid_` resolves through `GET /payments/sid_…`.

**Onboarding pages:**

- `/mock-payments/stripe/connect/onboard/:accountLinkId` is the Account Link
  `url`. It offers three outcomes:
  - **Complete**: `charges_enabled`, `payouts_enabled` and `details_submitted`
    all true, and capabilities `active`;
  - **Submit with requirements due**: charges disabled;
  - **Payouts restricted**.

  It then sends `account.updated` and redirects to the stored `return_url`. The
  existing loader (`?connect=return`, `settings+/shop.tsx:69-82`) syncs the
  columns. **The existing "Connect payout account" button works unchanged.**

- `/mock-payments/stripe/connect/dashboard/:accountId` is the Express login
  link. It lists the account's charges, transfers, application fees, refunds and
  reversals, so validators can check the platform fee.
- `/mock-payments/checkout-com/dashboard` is the mock dashboard. The "Open
  Checkout dashboard" action redirects here in mock mode. It lists sub-entities
  with **Activate payments** / **Activate payouts** (the Onboarding Simulator
  equivalent), payments, actions, allocations and commission.
- `/mock-payments/dashboard` is an index of everything, plus an event log with
  delivery status and a **Redeliver** button.

### 3.6 Behavior: test-card semantics and operation coverage

**Stripe card profiles** (the real Stripe test numbers):

| Card                  | Setup / CIT (on-session)                                           | Later off-session PaymentIntent                                                                                                                       |
| --------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `4242 4242 4242 4242` | success, no 3DS                                                    | `succeeded`                                                                                                                                           |
| `4000 0025 0000 3155` | 3DS challenge                                                      | `succeeded` (authenticated at setup)                                                                                                                  |
| `4000 0027 6000 3184` | 3DS challenge                                                      | `402 card_error code=authentication_required`; PI saved as `requires_payment_method` with `last_payment_error` and returned in `error.payment_intent` |
| `4000 0000 0000 0341` | setup succeeds (attaches); payment-mode charge declines            | `402 card_declined decline_code=generic_decline`                                                                                                      |
| `4000 0000 0000 9995` | payment mode `insufficient_funds`; **setup fails** (cannot attach) | n/a                                                                                                                                                   |
| `4000 0000 0000 0002` | `card_declined generic_decline`                                    | same                                                                                                                                                  |
| `4000 0082 6000 3178` | 3DS, then `insufficient_funds`                                     | `insufficient_funds`                                                                                                                                  |
| `4000 0000 0000 7726` | success                                                            | success; **refunds go `pending` → `succeeded`**                                                                                                       |
| `4000 0000 0000 5126` | success                                                            | success; **refunds go `pending` → `failed`** (`refund.failed`, `charge.refund.updated`)                                                               |
| `4000 0000 0000 0259` | success, then `charge.dispute.created` (bonus)                     | same                                                                                                                                                  |

Server-side PaymentMethod tokens are also accepted, for Vitest without the page:
`pm_card_visa`, `pm_card_authenticationRequired`, `pm_card_chargeCustomerFail`,
`pm_card_visa_chargeDeclinedInsufficientFunds`, `pm_card_threeDSecure2Required`.
Only brand, last4, expiry and the profile key are stored. The full card number
is never stored.

**Stripe operations emulated** (API version `2025-08-27.basil`):

- **Connect accounts:**
  - `POST /v1/accounts`: Express or Custom, with `metadata` and requested
    capabilities. Starts not charges-enabled.
  - `GET /v1/accounts/:id`
  - `POST /v1/account_links`: `account_onboarding`; stores `return_url` and
    `refresh_url`.
  - `POST /v1/accounts/:id/login_links`
- **Customers:** `POST /v1/customers` (no fields required),
  `GET /v1/customers/:id`, `GET /v1/customers/:id/payment_methods`.
- **Checkout sessions:**
  - `POST /v1/checkout/sessions`. **Payment mode:** `line_items.price_data`,
    `payment_intent_data.{application_fee_amount, transfer_data.destination, metadata, setup_future_usage, capture_method, statement_descriptor_suffix}`,
    `customer`, `payment_method_types`, `metadata`, `success_url`, `cancel_url`,
    `expires_at`, `custom_text`. **Setup mode:** `currency` or
    `payment_method_types` required, `customer`, `setup_intent_data.metadata`.
  - `GET /v1/checkout/sessions/:id`, including `expand[]=setup_intent` and
    `payment_intent`.
  - `POST /v1/checkout/sessions/:id/expire`.
- **Setup intents and payment methods:** `GET /v1/setup_intents/:id`,
  `GET /v1/payment_methods/:id`, `POST /v1/payment_methods/:id/attach` (returns
  `resource_already_exists` semantics as in `commerce.ts:577-595`).
- **Payment intents:**
  - `POST /v1/payment_intents`: `customer`, `payment_method`, `off_session`,
    `confirm`, `application_fee_amount`, `transfer_data`, `metadata`,
    `statement_descriptor_suffix`, `capture_method=manual`. Outcomes follow the
    table above.
  - `GET /v1/payment_intents/:id` (`expand payment_method`, `latest_charge`)
  - `POST /v1/payment_intents/:id/cancel` and `/capture`
- **Refunds:**
  - `POST /v1/refunds`: `payment_intent`, `amount`, `reason`,
    `reverse_transfer`, `refund_application_fee`, `metadata`. Over-refunds get
    `400 charge_already_refunded` or `amount_too_large`.
  - `GET /v1/refunds/:id`.
- **Ledger** (dashboard and assertions only): `ch_`, `tr_`, `fee_`, `trr_` and
  `fr_` objects. Their consistency is enforced: application fee ≤ amount, and
  transfer = amount − fee.
- **Validation errors** worth having because they catch real bugs:
  - `expires_at` outside 30 min – 24 h;
  - a destination account missing, or not `charges_enabled` with `transfers`
    active;
  - an amount below 50 for USD or CAD;
  - SAR (unsupported on these accounts);
  - setup mode without a currency or payment method types;
  - `off_session` with a PaymentMethod not attached to the customer;
  - `custom_text.submit.message` over 1200 characters;
  - unknown parameters → `400 parameter_unknown`.

  Error envelopes use Stripe's shape:
  `{ error: { type, code, decline_code, message, param, payment_intent, doc_url } }`.

- **Idempotency** (`Idempotency-Key`): the same key and parameters replay the
  stored response; the same key with different parameters returns
  `400 idempotency_error`. The 24-hour retention is modeled.
- **Unimplemented endpoints** return `501` with a loud log line naming the
  method and path. They never pass through and never succeed silently.
- **Webhook events** are built as full `Stripe.Event` objects:
  - `checkout.session.completed`, `.expired`, `.async_payment_succeeded`,
    `.async_payment_failed`;
  - `setup_intent.succeeded`;
  - `payment_intent.succeeded`, `.payment_failed`, `.requires_action`;
  - `charge.refunded`, `refund.created`, `refund.updated`, `refund.failed`;
  - `charge.dispute.created`, `.closed`;
  - `account.updated` (with `account: acct_…`, as a Connect event).

**Checkout.com behavior:**

- Cards (from `checkout-com-setup.md`; verify against the "Test cards" page):

  | Card                                                      | Behavior                                                                                                                                                                     |
  | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Visa `4242424242424242`, Mastercard `5436031030606378`    | frictionless                                                                                                                                                                 |
  | Visa `4543474002249996`, Mastercard `5352151570003404`    | 3DS challenge, password `Checkout1!`                                                                                                                                         |
  | **Mock-only** "mada (co-badged)" profile, clearly labeled | CIT approves; MIT declines with `response_code 20046` and summary "MIT not supported (mock)". Models the unconfirmed mada risk so the KSA "best effort" path gets exercised. |

- **Amount-based declines,** in both CIT and MIT: an amount ending in `05` gives
  `20005` (Do not honour), `51` gives `20051`, `12` gives `20012`, `54` gives
  `20054`. Declined payments return **201 with `approved: false`,
  `status: 'Declined'`** (provider fact, verify). Request validation errors
  return
  `422 { request_id, error_type: 'request_invalid', error_codes: [...] }`. Bad
  auth returns `401`.
- **Sub-entities:**
  - `POST /accounts/entities` (`reference`, `contact_details.invitee.email`,
    `is_draft`) returns `ent_…` with status `draft`/`pending` and
    `capabilities.payments.enabled=false`;
  - `GET /accounts/entities/:id`.

  Activation happens through the mock dashboard or the dev API. Status is read
  on every Settings → Shop load (`shop.tsx:85-94`).

- **Hosted Payments Page:**
  - `POST /hosted-payments` returns 201
    `{ id: 'hpp_…', reference, _links: { self, redirect } }`. Required:
    `amount`, `currency`, `reference`, `billing.address.country`,
    `processing_channel_id`, `success_url`, `failure_url`, `cancel_url`.
    Optional: `payment_type` (`Regular` | `Unscheduled`), `metadata`,
    `amount_allocations`, `3ds`.
  - `GET /hosted-payments/:id` returns status plus the payment id once paid
    (exact field names: verify).
  - After a CIT with `payment_type: 'Unscheduled'`, the payment has `source.id`
    (`src_…`, reusable), `customer.id` and `scheme_id`.
- **`POST /payment-sessions` (Flow)** is emulated **faithfully**: it returns
  `id`, `payment_session_token`, `payment_session_secret` and `_links.self`, and
  **no redirect link**. The existing restaurant order Checkout.com path
  (`checkout-shop.ts:181-196`) therefore fails in mock mode exactly as it most
  likely fails against the real API. It is fixed by switching to
  `hostedPayments.create` (§4, feature F7). A per-run switch
  `PAYMENTS_MOCK_CKO_FLOW_REDIRECT=true` can be added, but only as a stopgap.
- **Payments:**
  - `GET /payments/:id` (also accepts `sid_…`)
  - `GET /payments/:id/actions`
  - `POST /payments`: MIT with `source: { type: 'id', id }`,
    `merchant_initiated: true`, `payment_type: 'Unscheduled'`,
    `previous_payment_id`, `amount_allocations`, `processing_channel_id`,
    `reference`, `metadata`. The previous payment must be a CIT on the same
    source.
  - `POST /payments/:id/refunds` (`amount`, `reference`, `amount_allocations`)
    returns 202 `{ action_id }`. The refund then settles lazily, approved by
    default. A declined refund can be forced from the dev API.
  - `POST /payments/:id/voids`; `POST /payments/search` by `reference` (bonus,
    for reconciliation jobs).
- **Allocation and commission validation:**
  - every `id` must be a known sub-entity with payments enabled;
  - the allocation amounts must sum to the payment amount;
  - `0 ≤ commission.amount ≤ allocation.amount`;
  - refund reversals must not exceed what was allocated.

  Failures return `422` with `amount_allocations_invalid`-style codes. This is
  how the Admin platform-fee override gets validated.

- **Idempotency:** `Cko-Idempotency-Key` is honored on payments and refunds.
- **Webhooks:** `payment_approved`, `payment_captured`, `payment_declined`,
  `payment_pending`, `payment_refunded`, `payment_refund_declined`. The envelope
  is
  `{ id: 'evt_…', type, created_on, data: { id, action_id, amount, currency, reference, metadata, source, processing, amount_allocations } }`.
  The signature is `cko-signature` = hex HMAC-SHA256 of the body with the mock
  webhook secret (matches `checkout-shop.ts:267-282`).
  - Whether `data.processing.payment_session_id` is present for HPP is
    **unverified**. It is a named fidelity switch, defaulting to **absent**, so
    the existing order mapper's dependency on it (`restaurant.ts:155-182`) shows
    up as a defect instead of being hidden.

**PII realism.** The emulator fills `customer_details`, `billing_details`,
`receipt_email` and Checkout.com `customer` with obviously fake but realistic
values, such as the email typed on the page. Tests can then assert that App code
maps provider objects to ids-and-amounts DTOs and never forwards or logs those
fields to regional services.

### 3.6.1 Is webhook emission needed?

Yes. It is cheap once the event objects exist, and several paths depend on it:

- Checkout.com restaurant orders are **webhook-only** today
  (`checkout.server.ts:553-556`).
- Async refunds, disputes and `account.updated` are event-driven.
- "Guest paid and closed the tab" can only be tested through webhooks.

Delivery mode is set with `PAYMENTS_MOCK_WEBHOOKS`:

- `inline` (default): signed delivery before the redirect, which is how Stripe
  usually behaves.
- `deferred`: delivered after the redirect response (`ctx.waitUntil` /
  microtask).
- `manual`: queued only. Lets tests prove the poll-only path, then call `flush`
  to prove that a late webhook is idempotent.

**Transport.** The dispatcher builds a real `Request` with the signed raw body
and calls the **real route module's `action`** in-process
(`await import('#app/routes/api+/stripe+/webhook.tsx')` and
`api+/shop+/webhook.tsx`). This exercises signature verification and dispatch
without depending on workerd's self-fetch to `localhost:3001`.
`PAYMENTS_MOCK_WEBHOOKS_HTTP=1` optionally POSTs to `${PAYMENTS_MOCK_ORIGIN}`
instead. Delivery results (status, attempts) are recorded. A `500` is retried on
`flush`, mirroring provider retries.

### 3.7 Onboarding helper (Settings → Shop)

There are two paths. Both use the emulator's API, so the org columns are written
by the **real** sync code.

1. **Realistic path, no code change.** Click the existing **Connect payout
   account** button, go through the mock onboarding page, choose **Complete**,
   and the `?connect=return` sync runs. For Checkout.com, use **Invite Checkout
   payout contact**, then **Open Checkout dashboard** → **Activate**, then
   reload Settings → Shop.
2. **Instant path, mock mode only.** Settings → Shop shows a "Mock payments"
   panel with two buttons:
   - **Instantly enable Stripe (mock)**
   - **Instantly enable Checkout.com (mock)**

   They post intents `mock-onboard-stripe` and `mock-onboard-checkout`, which
   need the same `UPDATE_SETTINGS_ANY` permission. `onboard.server.ts` then:
   - creates the account or sub-entity through the emulator;
   - marks it complete;
   - calls the existing `syncConnectAccountStatus` or
     `syncCheckoutSubEntityStatus`;
   - sets `shopPaymentProvider`.

   The panel is rendered only when `paymentsMockMode()` is on, and the intents
   404 otherwise. The same helper is exposed as
   `POST /mock-payments/dev/onboard { orgSlug, provider }` for agents and
   Playwright.

Dependency: the three **US-only Checkout.com guards** (`shop-card.tsx:78-84`,
`shop.tsx:215-222`, `shop.server.ts:333-335`) still block KSA orgs. The instant
helper should **not** bypass them. Relaxing them is part of the reservations
work, so mock validation exercises the real fix.

### 3.8 Dev control API (JSON; mock mode only; stripped in `build:cf`)

All under `/mock-payments/dev/*`:

| Endpoint                                                                     | Purpose                                                   |
| ---------------------------------------------------------------------------- | --------------------------------------------------------- |
| `onboard`                                                                    | Onboard an org (above).                                   |
| `stripe/sessions/:id/complete { card, email?, threeDS: 'complete'\|'fail' }` | Pay headlessly, for API-level tests.                      |
| `checkout-com/hpp/:id/complete { card, password? }`                          | Same, for Checkout.com.                                   |
| `sessions/:id/expire`                                                        | Force an expiry instead of waiting the 30-minute minimum. |
| `refunds/:id/settle { outcome }`                                             | Settle a pending refund.                                  |
| `disputes { paymentIntent }`                                                 | Open a dispute.                                           |
| `clock/advance { seconds }`                                                  | Move the injectable clock.                                |
| `events?provider=&type=`                                                     | List events.                                              |
| `events/flush`                                                               | Deliver queued events.                                    |
| `events/:id/redeliver`                                                       | Redeliver one event.                                      |
| `objects/:provider/:id`                                                      | Raw object, for assertions.                               |
| `reset`                                                                      | Wipe mock state.                                          |

These endpoints are unauthenticated, because they exist only when mocks are on.
If shared dev machines are a concern, they can require `INTERNAL_COMMAND_TOKEN`.

### 3.9 Vitest and Playwright

- **Vitest** (`packages/payments`; `apps/app` unit and integration tests):
  - `createPaymentsEmulator({ store: createMemoryStore(), clock: fakeClock })`
  - `configureShopCommerceForTests(env, { emulator })`
  - Call the real `createRestaurantOrderHostedCheckout`, then
    `emulator.testing.completeCheckout(sessionId, { card: '4000002760003184' })`,
    then `getRestaurantOrderPaymentStatus`.
  - Regional calls stay on the existing MSW tenant-api handlers
    (`packages/test-utils/src/mocks/tenant-api.ts`).
  - Emulator unit tests run against the **real SDK clients** over the in-process
    transport. They assert real error classes, for example
    `instanceof Stripe.errors.StripeCardError` with `code`.
- **Playwright.** Locally it runs Workers `npm run dev`; in CI it runs Node
  `start:mocks`. `MOCKS=true` already holds in both, so no configuration change
  is needed.
  - Use page objects for the mock checkout, 3DS and onboarding pages, keyed on
    `data-testid`.
  - Use the dev API for setup, clock control and event flushing.
  - Assert through App or Sites status endpoints and regional state, never on
    the redirect alone.
  - The App's Playwright job starts only the App. Sites and tenant-api flows are
    validated by the mission's multi-service topology (App :3001, tenant-api
    :3007/:3009, Sites :3008).

### 3.10 Risks and how to keep the mock faithful

1. **Divergence from real providers** is the main risk. Mitigations:
   - Response builders are written `satisfies Stripe.<Type>` against the SDK
     types for the pinned API version, so types are complete and nullable fields
     are explicit.
   - Request handling decodes what the real SDK actually sends: form encoding,
     `Stripe-Version`, `Idempotency-Key`.
   - Errors use the documented envelopes, and the SDK's own classes are asserted
     in tests.
   - Unimplemented endpoints fail loudly.
   - Optional contract job: run the same request corpus against the official
     stateless `stripe-mock` (OpenAPI-backed). Diff key sets and types, not
     values. `stripe-mock` cannot replace this emulator because it keeps no
     state.
   - Checkout.com: the SDK has no TS types (JS only). Write Zod schemas from the
     API reference for requests and responses, keep doc examples as fixtures,
     and collect every "verify" assumption in one fidelity table with named
     switches. Review them first if real sandbox keys ever appear. Real keys
     automatically disable the mock, so this needs no code change.
2. **The mock passes where the real provider fails.** Known cases are modeled
   faithfully on purpose:
   - Flow payment-sessions has no redirect link;
   - `payment_session_id` may be absent on HPP webhooks;
   - the Platforms enablement requirement;
   - the 30-minute session minimum;
   - test-mode rejection of non-test cards.
3. **Production leak.** Covered by the four layers in §3.2. A `NODE_ENV` guard
   cannot be relied on because CI runs `NODE_ENV=production`.
4. **Global fetch wrapping for Checkout.com** is scoped to a reserved `.invalid`
   origin. It is idempotent and installed only in mock mode.
5. **The Sites `https:` check** needs a loopback-only relaxation. Keep it
   tested.
6. **The browser-agent DOM differs from the real hosted pages.** Tests written
   against the mock pages will not port to `checkout.stripe.com` or
   `pay.checkout.com`. This is acceptable given the user's decision. Mitigate by
   keeping UI tests thin and covering logic through the dev API.
7. **Out of scope:** the legacy shop's Stripe.js inline card, Polar, and SaaS
   billing Stripe (`payments.server.ts`, Admin).
8. **`withConnect` error flattening** (`commerce.ts:300-308`) will hide
   `authentication_required` from reservation code. Fix it in the reservations
   work. The emulator's off-session tests catch a regression.
9. **Two separate mock databases** (Workers D1 vs Node `data.db`). Tests use the
   HTTP dev API, so this does not matter.

---

## 4. Size estimate and feature split

### 4.1 Size

About **50 files**, roughly **4,800 LOC of implementation** plus **2,300 LOC of
tests**.

| Area                                                                                                                                                                                                                                                                   | Files | LOC    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------ |
| Package core (`env`, `store` + memory, `clock`, `ids`, `cards`, `emulator`, `transport`, `testing`)                                                                                                                                                                    | 9     | ~700   |
| Stripe emulator: router/errors/idempotency ~300, accounts and links ~150, customers and payment methods ~160, checkout sessions ~320, setup intents ~80, payment intents incl. off-session ~300, refunds ~150, ledger ~120, events and signing ~150                    | 10    | ~1,700 |
| Checkout.com emulator: router/auth/errors ~150, entities ~120, HPP ~220, payment-sessions ~60, payments and MIT and actions ~300, refunds ~120, allocations ~100, events and signing ~120                                                                              | 8     | ~1,200 |
| App wiring: SQL store ~150, emulator singleton ~60, webhook dispatcher ~150, onboarding helper ~100, `config.ts`/`commerce.ts`/`StripeProvider`/`checkout-shop.ts`/`shop.server.ts` edits ~100, `routes.ts`/`vite.config.ts`/`build:cf`/CI grep ~40, `.env.schema` ~20 | 9     | ~620   |
| Mock pages and dev API (`mock-payments+`): Stripe checkout ~300, Stripe 3DS ~100, Connect onboarding and dashboard ~220, Checkout.com HPP and 3DS ~300, Checkout.com dashboard ~150, index and event log ~150, dev API ~250                                            | 10    | ~1,470 |
| Settings → Shop mock panel and intents; Sites loopback relaxation                                                                                                                                                                                                      | 3     | ~120   |
| Docs: `docs/payments-mock.md`, `docs/offline-development.md` section, AGENTS.md env lines                                                                                                                                                                              | 3     | ~250   |
| Tests: emulator unit and SDK-level ~1,300, App integration (orders via emulator) ~400, Playwright (order pay, Connect onboarding, Checkout.com HPP) ~400, build-strip and guard tests ~200                                                                             | ~12   | ~2,300 |

### 4.2 Implementable features (in order)

Each feature can be validated on its own.

| ID     | Feature                                                                                                                                                                                                                                                                                                              | Depends on              | Acceptance                                                                                                                                                                                    |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F1** | **Mock foundation and production exclusion.** Activation rule, synthetic config, Stripe `httpClient` and Checkout.com `host` seams, scoped fetch wrapper, store interface with memory and SQL stores, `501` fallthrough, `vite` define, `routes.ts` strip, `build:cf` flag, CI bundle-grep, boot log, docs skeleton. | —                       | With `MOCKS=true` and placeholder keys, `listConfiguredProcessors()` returns `connect` and `checkout`. The `build:cf` bundle has no mock sentinel. With `MOCKS` unset, every mock route 404s. |
| **F2** | **Stripe Connect onboarding.** Accounts, account links, login links, `account.updated`, mock onboarding and Express dashboard pages, the Settings → Shop mock panel, and dev `onboard`.                                                                                                                              | F1                      | "Connect payout account" then Complete gives `onlinePayment.enabled: true` for `acme` in `/resources/order-context`.                                                                          |
| **F3** | **Stripe Checkout payment mode, end to end.** Sessions create, retrieve and expire; mock hosted page; 3DS page; charge, transfer and fee ledger; signed webhooks (inline, deferred, manual); dev complete, expire and flush.                                                                                         | F2                      | An **existing restaurant order** pays locally through Sites → mock page → success, both by poll and by webhook. A declined card shows an inline error. Expiry clears the binding.             |
| **F4** | **Stripe setup mode and off-session.** Customers, setup intents, payment methods, off-session PaymentIntents with every card profile, cancel, manual capture.                                                                                                                                                        | F3                      | `3155` setup then fee succeeds. `3184` gives `authentication_required` with `raw.payment_intent`. `0341` declines. `9995` setup fails.                                                        |
| **F5** | **Stripe refunds and disputes.** Sync, pending, succeeded and failed refunds; reverse transfer and application-fee refund in the ledger; refund and dispute events; dashboard ledger.                                                                                                                                | F3                      | Partial, full and over-refund behaviors match. `7726` and `5126` settle as specified.                                                                                                         |
| **F6** | **Checkout.com sub-entities.** Entities API, mock dashboard Activate, instant helper. Coordinate with the reservations work for the KSA guard relaxation.                                                                                                                                                            | F1                      | A KSA test org reaches `checkoutChargesEnabled=1` through the UI after the guards are fixed.                                                                                                  |
| **F7** | **Checkout.com HPP.** `/hosted-payments` create and get, payment `pay_`/`sid_` lookup, 3DS password, amount declines, webhooks, faithful payment-sessions. Includes the small fix moving order checkout to HPP plus an API status lookup.                                                                            | F6                      | A SAR order or deposit pays locally. A decline amount (`…05`) fails. Status resolves without a webhook through the HPP and payment lookup.                                                    |
| **F8** | **Checkout.com stored instrument, MIT, refunds.** `Unscheduled` CIT storing `src_`, MIT `POST /payments`, actions, refunds with allocation reversal, commission validation, mock mada MIT decline.                                                                                                                   | F7                      | MIT fee approves for Visa, declines for amount `…05` and the mock mada card. Refund actions settle. Bad allocations get `422`.                                                                |
| **F9** | **Test harness and fidelity.** Vitest helpers, Playwright page objects and fixtures, the fidelity table, the optional `stripe-mock` contract job.                                                                                                                                                                    | F3 (start), F8 (finish) | CI runs the emulator suite on Node. Local Playwright passes on the Workers-dev topology.                                                                                                      |

Parallelism: after F1, the Stripe track (F2 → F3 → F4/F5) and the Checkout.com
track (F6 → F7 → F8) can run in parallel. F3 is the template for the others.
Each reservation payment feature should state which mock feature it needs:
deposits and Experiences need F3 and F7, card guarantees and fees need F4 and
F8, and refunds need F5 and F8.
