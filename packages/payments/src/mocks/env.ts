/**
 * Activation rule for the local payment emulators. Pure and tiny on purpose:
 * production code imports this file, never the emulators themselves.
 *
 * Exclusion layers (see docs/payments-mock.md):
 * 1. `__PAYMENTS_MOCK_BUNDLED__` is `false` in the Cloudflare build, so the
 *    branch that wires the emulators is dead code.
 * 2. `apps/app/app/routes.ts` strips `mock-payments+` when `STRIP_DEV_MOCKS`.
 * 3. Every mock route answers 404 unless this rule is on (and the request is
 *    local), and activation refuses live keys.
 * 4. `scripts/check-no-payment-mocks.mjs` greps the Worker bundle for
 *    `PAYMENTS_MOCK_SENTINEL`.
 *
 * There is deliberately no `NODE_ENV` gate: CI runs the production Node build
 * with `MOCKS=true` and must keep the mock.
 */

export type PaymentsMockEnv = {
	MOCKS?: string
	PAYMENTS_MOCK?: string
	STRIPE_SECRET_KEY?: string
	STRIPE_WEBHOOK_SECRET?: string
	STRIPE_CONNECT_WEBHOOK_SECRET?: string
	CHECKOUT_SECRET_KEY?: string
	CHECKOUT_WEBHOOK_SECRET?: string
	PAYMENTS_MOCK_WEBHOOKS?: string
	PAYMENTS_MOCK_WEBHOOKS_HTTP?: string
	PAYMENTS_MOCK_ORIGIN?: string
	PAYMENTS_MOCK_CKO_SESSION_ID?: string
	BASE_URL?: string
}

export type PaymentsMockMode = { stripe: boolean; checkout: boolean }

export const MOCK_STRIPE_SECRET_KEY = 'sk_test_mock_platform'
export const MOCK_STRIPE_PUBLISHABLE_KEY = 'pk_test_mock_platform'
export const MOCK_STRIPE_WEBHOOK_SECRET = 'whsec_mock_platform'
/** Matches the SDK's `NAS_SANDBOX_SECRET_KEY_REGEX`, so it sends `Bearer`. */
export const MOCK_CHECKOUT_SECRET_KEY = 'sk_sbox_mockplatformmockplatformmoc'
export const MOCK_CHECKOUT_PUBLIC_KEY = 'pk_sbox_mockplatformmockplatformmoc'
export const MOCK_CHECKOUT_SUBDOMAIN = 'mock'
export const MOCK_CHECKOUT_PROCESSING_CHANNEL_ID = 'pc_mockmockmockmockmockm'
export const MOCK_CHECKOUT_WEBHOOK_SECRET = 'cko_whsec_mock_platform'
/** The only origin the Checkout.com SDK is pointed at in mock mode. */
export const MOCK_CHECKOUT_HOST = 'https://checkout-com.mock.invalid'

const OFF: PaymentsMockMode = { stripe: false, checkout: false }

function bundled() {
	return (
		typeof __PAYMENTS_MOCK_BUNDLED__ !== 'undefined' &&
		__PAYMENTS_MOCK_BUNDLED__ === true
	)
}

/** A configured secret: set and not an unreplaced `***` placeholder. */
export function isRealSecret(value: string | undefined | null) {
	const trimmed = value?.trim()
	return Boolean(trimmed && !trimmed.includes('***'))
}

/**
 * Fail closed: only the two shapes that are certainly not live pass. Checkout
 * sandbox secret keys are `sk_sbox_...`, test access keys `ack_test_...`.
 * Anything else (a live `sk_`, a live `ack_`, an MBC key that is a bare UUID,
 * a typo) counts as live.
 */
function looksLiveCheckoutKey(value: string) {
	const key = value.trim().replace(/^Bearer\s+/i, '')
	return !(key.startsWith('sk_sbox_') || key.startsWith('ack_test_'))
}

/** Live secret and restricted keys; test keys are `sk_test_` / `rk_test_`. */
const LIVE_STRIPE_KEY = /^(sk|rk)_live_/

/**
 * Which providers the emulator replaces. Throws when a mock switch is on but a
 * live key is present, so a misconfigured deploy fails loudly at startup.
 */
export function paymentsMockMode(env: PaymentsMockEnv): PaymentsMockMode {
	if (!bundled()) return OFF
	if (env.PAYMENTS_MOCK === 'false') return OFF
	if (env.MOCKS !== 'true' && env.PAYMENTS_MOCK !== 'true') return OFF
	// Webhook secrets (`whsec_...`) carry no live/test marker, so the secret
	// key is the only Stripe signal there is.
	if (LIVE_STRIPE_KEY.test(env.STRIPE_SECRET_KEY?.trim() ?? '')) {
		throw new Error('Refusing payments mock with a live Stripe key')
	}
	if (
		isRealSecret(env.CHECKOUT_SECRET_KEY) &&
		looksLiveCheckoutKey(env.CHECKOUT_SECRET_KEY!)
	) {
		throw new Error('Refusing payments mock with a live Checkout.com key')
	}
	return {
		// A real test key wins: that provider keeps talking to the real sandbox.
		stripe: !isRealSecret(env.STRIPE_SECRET_KEY),
		checkout: !isRealSecret(env.CHECKOUT_SECRET_KEY),
	}
}

export function isPaymentsMockOn(mode: PaymentsMockMode) {
	return mode.stripe || mode.checkout
}

export type MockWebhookMode = 'inline' | 'deferred' | 'manual'

export function parseMockWebhookMode(
	value: string | undefined,
): MockWebhookMode {
	return value === 'deferred' || value === 'manual' ? value : 'inline'
}

/**
 * The platform webhook secret exactly as the route verifies with it, even when
 * it is still the `whsec_***` placeholder (any string is a usable HMAC key).
 * Only a missing value falls back to the mock's own secret.
 */
function platformWebhookSecret(env: PaymentsMockEnv, mockOn: boolean) {
	const configured = env.STRIPE_WEBHOOK_SECRET?.trim()
	if (configured) return configured
	return mockOn ? MOCK_STRIPE_WEBHOOK_SECRET : null
}

/** Secrets the mock signs with; they are the ones the real routes verify with. */
export function mockWebhookSecrets(env: PaymentsMockEnv) {
	const platform = platformWebhookSecret(env, true)!
	return {
		stripePlatform: platform,
		stripeConnect: isRealSecret(env.STRIPE_CONNECT_WEBHOOK_SECRET)
			? env.STRIPE_CONNECT_WEBHOOK_SECRET!.trim()
			: platform,
		checkout: isRealSecret(env.CHECKOUT_WEBHOOK_SECRET)
			? env.CHECKOUT_WEBHOOK_SECRET!.trim()
			: MOCK_CHECKOUT_WEBHOOK_SECRET,
	}
}

/**
 * Secrets the Stripe webhook route verifies with: the platform secret (the
 * mock's own only for a local request, see below) and, when set, the Connect
 * secret (Connect events such as `account.updated` are
 * signed by a second endpoint secret in production).
 */
export function getStripeWebhookSecrets(
	env: PaymentsMockEnv,
	request?: { url: string },
): string[] {
	const secrets: string[] = []
	// The mock's own (public) secret is a fallback only when the request is
	// local too: a node started with MOCKS=true must not accept forged events
	// from the internet when no real secret is set.
	const mockFallback =
		isPaymentsMockOn(safeMode(env)) &&
		isLocalDeployment(env) &&
		Boolean(request) &&
		isLocalUrl(request!.url)
	const platform = platformWebhookSecret(env, mockFallback)
	if (platform) secrets.push(platform)
	if (isRealSecret(env.STRIPE_CONNECT_WEBHOOK_SECRET)) {
		secrets.push(env.STRIPE_CONNECT_WEBHOOK_SECRET!.trim())
	}
	return [...new Set(secrets)]
}

function safeMode(env: PaymentsMockEnv) {
	try {
		return paymentsMockMode(env)
	} catch {
		return OFF
	}
}

/** Loopback and special-use local names. Mock pages never answer anywhere else. */
export function isLocalHostname(hostname: string) {
	const host = hostname
		.trim()
		.toLowerCase()
		.replace(/^\[|\]$/g, '')
	return (
		host === 'localhost' ||
		host === '127.0.0.1' ||
		host === '::1' ||
		host.endsWith('.localhost') ||
		host.endsWith('.test')
	)
}

export function isLocalUrl(value: string | undefined | null) {
	if (!value) return false
	try {
		return isLocalHostname(new URL(value).hostname)
	} catch {
		return false
	}
}

/** The configured public origin (if any) is local too. */
export function isLocalDeployment(env: PaymentsMockEnv) {
	const configured = env.PAYMENTS_MOCK_ORIGIN?.trim() || env.BASE_URL?.trim()
	return !configured || isLocalUrl(configured)
}
