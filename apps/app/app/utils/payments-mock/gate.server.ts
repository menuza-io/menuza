import {
	isLocalDeployment,
	isLocalUrl,
	isPaymentsMockOn,
	paymentsMockMode,
	type PaymentsMockEnv,
	type PaymentsMockMode,
} from '@repo/payments'

/**
 * Runtime gate (exclusion layer 3) shared by every mock route and the Settings,
 * Shop panel. Deliberately tiny: it is the one payment-mock module that ships
 * in production bundles, where `paymentsMockMode` is always off.
 *
 * A mock answers only when BOTH hold:
 * - the mock mode is on (`MOCKS=true` or `PAYMENTS_MOCK=true`, not forced off,
 *   no live keys, and the build still contains the emulator), and
 * - the deployment is local: the request and the configured origin are
 *   loopback or a special-use `.test` / `.localhost` name.
 */
export type PaymentsMockStatus = PaymentsMockMode & { enabled: boolean }

const OFF: PaymentsMockStatus = {
	enabled: false,
	stripe: false,
	checkout: false,
}

export function getPaymentsMockStatus(
	request?: Request,
	env: PaymentsMockEnv = process.env,
): PaymentsMockStatus {
	let mode: PaymentsMockMode
	try {
		mode = paymentsMockMode(env)
	} catch {
		// A live key with the mock switched on is refused at startup
		// (`withPaymentsMock`); a route never serves a mock page for it.
		return OFF
	}
	if (!isPaymentsMockOn(mode)) return OFF
	if (!isLocalDeployment(env)) return OFF
	if (request && !isLocalUrl(request.url)) return OFF
	return { ...mode, enabled: true }
}

/** 404 unless the mock is on and the request is local. */
export function requirePaymentsMock(
	request: Request,
	provider?: 'stripe' | 'checkout',
	env: PaymentsMockEnv = process.env,
): PaymentsMockStatus {
	const status = getPaymentsMockStatus(request, env)
	if (!status.enabled || (provider && !status[provider])) {
		throw new Response('Not Found', { status: 404 })
	}
	return status
}
