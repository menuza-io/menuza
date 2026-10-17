---
name: payments-worker
description:
  Builds the local Stripe and Checkout.com emulators behind the real SDKs (mock
  hosted pages, signed webhooks, dev control API, four-layer production
  exclusion) and the App-side provider integration for reservation payments
  (quote, bind once, status; deposits, prepay, card guarantees, staff-charged
  fees, refunds, disputes, HPP, platform fee) - test-first, with
  SDK-against-emulator tests, a production-bundle exclusion check, and
  agent-browser walks through the mock hosted pages including 3DS.
---

# Payments worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the
WORK PROCEDURE.

## Required Skills and Tools

- `agent-browser` skill: invoke it before any browser verification. Mock hosted
  pages (Stripe Checkout, Connect onboarding, Checkout.com HPP, 3DS challenges,
  dashboards, event log) are checked in agent-browser.
- Vitest for `@repo/payments`, App and tenant-api tests. The real `stripe` and
  Checkout.com SDKs already used by online ordering, pointed at the emulator;
  never a real provider.
- References: `library/payment-mocks.md` (the full emulator spec: activation,
  exclusion layers, code locations, `__mock_pay_*` state, hosted pages, test
  cards, webhook modes, dev API, Vitest helpers, Playwright page objects,
  fidelity risks), `library/payments-reference.md` (as-built Stripe and
  Checkout.com code, env vars, HPP, stored instruments, refunds, platform fee
  decisions), `architecture.md` (payments responsibilities and flows, payment
  mocks summary, platform fee, region-switch guard), repo guide
  `docs/skills/project-payments-commerce/SKILL.md`.

## Work Procedure

1. **Understand the feature.** Read the feature, every assertion in its
   `fulfills` list, the payments and payment-mocks sections of
   `architecture.md`, and the relevant parts of `library/payment-mocks.md` /
   `library/payments-reference.md`. List every provider operation involved, its
   request fields, the emulator state change, the webhook it emits, and how the
   App and tenant-api learn the result.
2. **Inspect the existing code paths** you extend or reroute (order checkout
   session creation, Connect onboarding and `withConnect`, webhook routes and
   signature verification, the browser status poll, Checkout.com client
   construction and the US-only guards). Note every place that decides whether
   payments are "configured or enabled".
3. **Write failing tests first:**
   - Emulator: request validation and errors shaped like the real provider's,
     state transitions, test-card outcomes (success, decline, insufficient
     funds, 3DS required, authentication on off-session), idempotency keys, and
     webhook payloads whose signatures the real SDK verification accepts.
   - Integration: the real SDK client against the emulator for each operation
     the feature adds.
   - Safety: the mock refuses to start with live keys; mock routes and code are
     absent from the production build (`build:cf`) and the CI bundle check fails
     when they leak.
   - Money: amounts in minor units, currency handling (USD for acme, SAR for
     riyadh-grill), platform fee `round half-up(amount x bp / 10000)`
     snapshotted at quote or bind time, proportional fee reversal on partial
     refunds, bind-once semantics, late-payment and expiry rules.
   - Internal routes (`/resources/reservations/payments`,
     `/resources/sites/reservation/{checkout,status}`, webhooks): auth first,
     ids and amounts only.
4. **Implement** following `library/payment-mocks.md` exactly for emulator
   behavior and `architecture.md` for reservation flows. Regional tenant-api
   decides amounts, state and capacity; the App alone calls providers. Fees are
   never charged automatically. Never log card data, tokens or guest PII.
5. **Verify in agent-browser** with the mock active (`MOCKS`/`PAYMENTS_MOCK`,
   see `library/payment-mocks.md`): start the services the flow needs, make the
   org's connected account ready (onboarding helper), and walk each flow end to
   end through the mock hosted pages: success, decline, 3DS challenge pass and
   fail, abandoned checkout. Check the mock event log and dashboards, the
   webhook delivery mode, and the resulting order or reservation state.
   Regressions (milestone `payment-mocks`): an existing online-ordering payment
   on acme (Stripe) and on riyadh-grill (Checkout.com HPP) still complete.
6. **Prove production exclusion** whenever you add mock code or routes: run the
   production build and the bundle check named in `library/payment-mocks.md`,
   and confirm the output has no mock routes, hosts or emulator code.
7. **Stop what you started** (services, browser sessions, builds).
8. **Programmatic verification (approved worker scoping), then commit:**
   - When a consolidated feature also includes App UI (`settings.policies.tsx`,
     `experiences*.tsx`, `payment-panel.tsx`), Sites pages (`/reserve/pay`,
     `/experiences*`), and/or tenant-api routes: verify every new App
     loader/action in `reservations-guards.test.ts`, add every new tenant-api
     route to `reservations-security.test.ts`, and run `commands.test_workspace`
     with `sites` when Sites changed.
   - `commands.test_workspace` with `@repo/payments`; targeted App Vitest files
     (`commands.test_files_app`); `commands.test_tenant_api` when tenant-api
     changed.
   - `npx turbo run typecheck --filter=@repo/payments` and
     `commands.typecheck_app` (6 GB heap via
     NODE_OPTIONS=--max-old-space-size=6144; the turbo route OOMs, never at the
     same time as App ESLint); tenant-api typecheck when it changed.
   - `commands.lint_workspace` with `@repo/payments`; `commands.lint_app_files`
     on changed App files; `commands.lint_oxc`; `commands.lingui_check` if
     strings changed.
   - `commands.clean_generated`, review the staged diff (no keys, no card data),
     then commit.

## Example Handoff

```json
{
	"salientSummary": "Built the Stripe Checkout emulator (payment and setup modes, 3DS challenge page, signed checkout.session.completed and payment_intent events with inline/deferred/manual dispatch) behind the real stripe SDK via createFetchHttpClient; 58 emulator and SDK-integration tests pass, the build:cf bundle check proves no mock code ships, and agent-browser completed an acme order payment with 4242 and a 3DS card.",
	"whatWasImplemented": "packages/payments/src/mock/stripe/: router handling POST /v1/checkout/sessions, GET /v1/checkout/sessions/:id, PaymentIntents and SetupIntents with Stripe-shaped errors; state in __mock_pay_stripe_* tables (control-plane, created only in mock mode); test cards 4242 (success), 0002 (generic decline), 9995 (insufficient funds), 3155 (3DS required). Webhooks signed with the configured whsec_ secret so stripe.webhooks.constructEvent accepts them; dispatch mode per session (inline, deferred 2 s, manual from the event log). apps/app/app/routes/mock-payments+/stripe.checkout.$sessionId.tsx renders the mock hosted page and 3DS challenge. getStripe() uses createFetchHttpClient to the in-process emulator when PAYMENTS_MOCK is active and refuses to start if the key starts with sk_live_. Layers: vite define __PAYMENTS_MOCK__=false and route stripping in build:cf, plus scripts/check-no-payment-mocks.mjs in CI.",
	"whatWasLeftUndone": "",
	"verification": {
		"commandsRun": [
			{
				"command": "cd packages/payments && CI=true npx vitest run src/mock",
				"exitCode": 0,
				"observation": "6 files, 58 tests passed (before implementation 58 failed)."
			},
			{
				"command": "CI=true npm run test -w @repo/payments",
				"exitCode": 0,
				"observation": "15 files, 139 tests passed."
			},
			{
				"command": "cd apps/app && CI=true npx vitest run app/utils/payments-mock app/routes/mock-payments+",
				"exitCode": 0,
				"observation": "4 files, 31 tests passed."
			},
			{
				"command": "cd apps/app && npm run build:cf && node ../../scripts/check-no-payment-mocks.mjs build",
				"exitCode": 0,
				"observation": "Bundle check: 0 matches for mock-payments routes, checkout-com.mock.invalid and emulator symbols."
			},
			{
				"command": "Temporarily removed the route-stripping step and re-ran the bundle check",
				"exitCode": 1,
				"observation": "Check failed listing mock-payments+/stripe.checkout.$sessionId; restored the step."
			},
			{
				"command": "npx turbo run typecheck --filter=@repo/payments && cd apps/app && NODE_OPTIONS=--max-old-space-size=6144 npm run typecheck",
				"exitCode": 0,
				"observation": "Clean."
			},
			{
				"command": "npm run lint -w @repo/payments && cd apps/app && NODE_OPTIONS=--max-old-space-size=4096 npx eslint app/routes/mock-payments+ app/utils/payments-mock",
				"exitCode": 0,
				"observation": "0 errors."
			}
		],
		"interactiveChecks": [
			{
				"action": "agent-browser: acme storefront order checkout with card 4242 4242 4242 4242",
				"observed": "Redirected to http://localhost:3001/mock-payments/stripe/checkout/cs_mock_...; paid; returned to the order page showing Paid; event log lists checkout.session.completed delivered inline (200)."
			},
			{
				"action": "Same with the 3DS card, chose 'Fail authentication' on the challenge page",
				"observed": "Returned to checkout with 'Your card was not authenticated'; order stays unpaid; payment_intent.payment_failed in the event log."
			},
			{
				"action": "Set dispatch mode to manual, paid, then delivered the event from the event log",
				"observed": "Order showed Processing until delivery, then Paid."
			}
		]
	},
	"tests": {
		"added": [
			{
				"file": "packages/payments/src/mock/stripe/checkout.test.ts",
				"cases": [
					{
						"name": "real SDK creates and retrieves a session through the emulator",
						"description": "stripe.checkout.sessions.create/retrieve round-trip with createFetchHttpClient."
					},
					{
						"name": "webhook signature verifies with the real SDK",
						"description": "constructEvent accepts the emulator's signature and rejects a tampered payload."
					},
					{
						"name": "refuses live keys",
						"description": "Activation with sk_live_ throws before any request."
					}
				]
			}
		]
	},
	"discoveredIssues": [
		{
			"severity": "medium",
			"description": "The existing order webhook handler ignores checkout.session.async_payment_failed, so a delayed failure leaves the order in Processing.",
			"suggestedFix": "Handle async_payment_failed in the order webhook (existing ordering bug; outside this feature)."
		}
	]
}
```

## When to Return to Orchestrator

- The emulator cannot faithfully reproduce an operation the feature needs, or
  the real SDK rejects emulator responses in a way that requires a design
  change.
- Production exclusion cannot be proven with the four layers.
- A flow would require a real provider key, real network access, card data
  storage, or guest PII on the App side.
- An existing ordering payment flow breaks and the fix is outside the feature.
