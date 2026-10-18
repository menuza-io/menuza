import { createShopCommerceConfigFromEnv } from '../../shop/config'
import { applyPaymentsMockConfig } from '../../shop/mock-config'
import { createPaymentsEmulator } from '../emulator'
import { paymentsMockMode } from '../env'
import { createMemoryStore } from '../store'
import { createMockStripeHttpClient } from '../transport'

/** Mirrors how the App wires the mock: behind the build-time constant. */
export function wire(env: Record<string, string>) {
	const base = createShopCommerceConfigFromEnv(env)
	if (
		typeof __PAYMENTS_MOCK_BUNDLED__ !== 'undefined' &&
		__PAYMENTS_MOCK_BUNDLED__
	) {
		const emulator = createPaymentsEmulator({ store: createMemoryStore() })
		return applyPaymentsMockConfig(base, env, paymentsMockMode(env), {
			stripeHttpClient: createMockStripeHttpClient(emulator),
			checkoutDashboardUrl:
				'http://localhost/mock-payments/checkout-com/dashboard',
		})
	}
	return base
}
