import {
	applyPaymentsMockConfig,
	isLocalUrl,
	isPaymentsMockOn,
	paymentsMockMode,
	type PaymentsEmulator,
	type PaymentsMockEnv,
	type ShopCommerceConfig,
} from '@repo/payments'
import {
	installCheckoutComMockFetch,
	createMockStripeHttpClient,
} from '@repo/payments/mock'
import {
	getPaymentsEmulator,
	logPaymentsMockBoot,
	resolveMockOrigin,
} from './emulator.server.ts'

/**
 * Point the shop commerce at the local emulators. Only reachable through the
 * `__PAYMENTS_MOCK_BUNDLED__` branch in `shop.server.ts`.
 *
 * Throws (loudly, at startup) when a mock switch is on together with a live
 * key, or when the configured origin is not local.
 */
export function withPaymentsMock(
	config: ShopCommerceConfig,
	env: PaymentsMockEnv = process.env,
	emulator?: PaymentsEmulator,
): ShopCommerceConfig {
	const mode = paymentsMockMode(env)
	if (!isPaymentsMockOn(mode)) return config
	const origin = resolveMockOrigin(env)
	if (!isLocalUrl(origin)) {
		throw new Error(
			`Refusing the payments mock on a non-local origin (${origin}). Unset MOCKS and PAYMENTS_MOCK, or use a local BASE_URL.`,
		)
	}
	const active = emulator ?? getPaymentsEmulator(env)
	if (mode.checkout) installCheckoutComMockFetch(active)
	logPaymentsMockBoot(env)
	return applyPaymentsMockConfig(config, env, mode, {
		stripeHttpClient: createMockStripeHttpClient(active),
		checkoutDashboardUrl: `${origin}/mock-payments/checkout-com/dashboard`,
	})
}
