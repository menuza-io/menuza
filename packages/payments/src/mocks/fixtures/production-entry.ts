import {
	createShopCommerceConfigFromEnv,
	getStripeWebhookSecrets,
	isLocalUrl,
	paymentsMockMode,
} from '../../../index'

/**
 * What a production build keeps of the mock feature: the code the Settings
 * page, the webhook route and the shop config import from the package barrel,
 * with the gated Settings panel.
 */
export function panelLink(paymentsMock?: { enabled: boolean }) {
	// Same shape as `ShopCard`: the inline build-time check is what the bundler
	// folds, so the panel and its link to the mock dashboard are dead code.
	return typeof __PAYMENTS_MOCK_BUNDLED__ !== 'undefined' &&
		__PAYMENTS_MOCK_BUNDLED__ &&
		paymentsMock?.enabled
		? { testId: 'mock-payments-panel', href: '/mock-payments/dashboard' }
		: null
}

export function webhook(request: { url: string }, env: Record<string, string>) {
	return {
		secrets: getStripeWebhookSecrets(env, request),
		local: isLocalUrl(request.url),
		mode: paymentsMockMode(env),
		config: createShopCommerceConfigFromEnv(env),
	}
}
