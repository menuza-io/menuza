import type Stripe from 'stripe'
import {
	MOCK_CHECKOUT_HOST,
	MOCK_CHECKOUT_PROCESSING_CHANNEL_ID,
	MOCK_CHECKOUT_PUBLIC_KEY,
	MOCK_CHECKOUT_SECRET_KEY,
	MOCK_CHECKOUT_SUBDOMAIN,
	MOCK_STRIPE_PUBLISHABLE_KEY,
	MOCK_STRIPE_SECRET_KEY,
	mockWebhookSecrets,
	type PaymentsMockEnv,
	type PaymentsMockMode,
} from '../mocks/env'
import { type ShopCommerceConfig } from './config'

export type PaymentsMockTransports = {
	stripeHttpClient: Stripe.HttpClient
	checkoutDashboardUrl: string
}

/**
 * Fill synthetic provider settings for each mocked provider so
 * `isProcessorConfigured` behaves as it does in production. Organizations
 * still need onboarding: nothing here turns an org's payments on.
 */
export function applyPaymentsMockConfig(
	config: ShopCommerceConfig,
	env: PaymentsMockEnv,
	mode: PaymentsMockMode,
	transports: PaymentsMockTransports,
): ShopCommerceConfig {
	const secrets = mockWebhookSecrets(env)
	const next: ShopCommerceConfig = {
		...config,
		validateStripeKeys: false,
		mock: {
			...(mode.stripe ? { stripeHttpClient: transports.stripeHttpClient } : {}),
			...(mode.checkout
				? {
						checkoutHost: MOCK_CHECKOUT_HOST,
						checkoutDashboardUrl: transports.checkoutDashboardUrl,
					}
				: {}),
		},
	}
	if (mode.stripe) {
		next.stripeSecretKey = MOCK_STRIPE_SECRET_KEY
		next.stripePublishableKey = MOCK_STRIPE_PUBLISHABLE_KEY
	}
	if (mode.checkout) {
		next.checkoutSecretKey = MOCK_CHECKOUT_SECRET_KEY
		next.checkoutPublicKey = MOCK_CHECKOUT_PUBLIC_KEY
		next.checkoutSubdomain = MOCK_CHECKOUT_SUBDOMAIN
		next.checkoutProcessingChannelId = MOCK_CHECKOUT_PROCESSING_CHANNEL_ID
		next.checkoutEnvironment = 'sandbox'
		next.checkoutWebhookSecret = secrets.checkout
	}
	return next
}
