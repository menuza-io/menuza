import type Stripe from 'stripe'

/**
 * Set only when the local payment emulators are active. Production never
 * builds this: the code that does is removed from the Cloudflare bundle.
 */
export type ShopCommerceMockConfig = {
	/** Stripe SDK transport into the in-process emulator. */
	stripeHttpClient?: Stripe.HttpClient
	/** Checkout.com SDK host (the dedicated `.invalid` origin). */
	checkoutHost?: string
	/** Where "Open Checkout dashboard" goes instead of the real dashboard. */
	checkoutDashboardUrl?: string
}

export type ShopCommerceConfig = {
	stripeSecretKey?: string
	stripePublishableKey?: string
	polarAccessToken?: string
	polarOrganizationId?: string
	polarServer?: 'sandbox' | 'production'
	polarWebhookSecret?: string
	checkoutSecretKey?: string
	checkoutPublicKey?: string
	checkoutSubdomain?: string
	checkoutProcessingChannelId?: string
	checkoutEnvironment?: 'sandbox' | 'production'
	checkoutWebhookSecret?: string
	validateStripeKeys?: boolean
	mock?: ShopCommerceMockConfig
}

function isConfiguredSecret(value: string | undefined) {
	const trimmed = value?.trim()
	return Boolean(trimmed && !trimmed.includes('***'))
}

export function createShopCommerceConfigFromEnv(env: {
	STRIPE_SECRET_KEY?: string
	STRIPE_PUBLISHABLE_KEY?: string
	POLAR_ACCESS_TOKEN?: string
	POLAR_ORGANIZATION_ID?: string
	POLAR_SERVER?: string
	POLAR_WEBHOOK_SECRET?: string
	CHECKOUT_SECRET_KEY?: string
	CHECKOUT_PUBLIC_KEY?: string
	CHECKOUT_SUBDOMAIN?: string
	CHECKOUT_PROCESSING_CHANNEL_ID?: string
	CHECKOUT_ENVIRONMENT?: string
	CHECKOUT_WEBHOOK_SECRET?: string
	MOCKS?: string
	NODE_ENV?: string
}): ShopCommerceConfig {
	return {
		stripeSecretKey: isConfiguredSecret(env.STRIPE_SECRET_KEY)
			? env.STRIPE_SECRET_KEY!.trim()
			: undefined,
		stripePublishableKey: isConfiguredSecret(env.STRIPE_PUBLISHABLE_KEY)
			? env.STRIPE_PUBLISHABLE_KEY!.trim()
			: undefined,
		polarAccessToken: isConfiguredSecret(env.POLAR_ACCESS_TOKEN)
			? env.POLAR_ACCESS_TOKEN!.trim()
			: undefined,
		polarOrganizationId: env.POLAR_ORGANIZATION_ID?.trim() || undefined,
		polarServer: env.POLAR_SERVER === 'production' ? 'production' : 'sandbox',
		polarWebhookSecret: isConfiguredSecret(env.POLAR_WEBHOOK_SECRET)
			? env.POLAR_WEBHOOK_SECRET!.trim()
			: undefined,
		checkoutSecretKey: isConfiguredSecret(env.CHECKOUT_SECRET_KEY)
			? env.CHECKOUT_SECRET_KEY!.trim()
			: undefined,
		checkoutPublicKey: isConfiguredSecret(env.CHECKOUT_PUBLIC_KEY)
			? env.CHECKOUT_PUBLIC_KEY!.trim()
			: undefined,
		checkoutSubdomain: env.CHECKOUT_SUBDOMAIN?.trim() || undefined,
		checkoutProcessingChannelId:
			env.CHECKOUT_PROCESSING_CHANNEL_ID?.trim() || undefined,
		checkoutEnvironment:
			env.CHECKOUT_ENVIRONMENT === 'production' ? 'production' : 'sandbox',
		checkoutWebhookSecret: isConfiguredSecret(env.CHECKOUT_WEBHOOK_SECRET)
			? env.CHECKOUT_WEBHOOK_SECRET!.trim()
			: undefined,
		validateStripeKeys: env.MOCKS !== 'true' && env.NODE_ENV !== 'test',
	}
}
