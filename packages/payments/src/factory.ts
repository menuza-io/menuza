/**
 * Payment provider factory
 * Creates the appropriate payment provider based on configuration
 */

import { PolarProvider } from './providers/polar'
import { StripeProvider } from './providers/stripe'
import { type PaymentProvider, type PaymentProviderConfig } from './types'

/**
 * Create a payment provider instance
 * @param config Provider configuration
 * @returns PaymentProvider instance
 * @example
 * ```ts
 * const provider = createPaymentProvider({
 *   provider: 'stripe',
 *   apiKey: process.env.STRIPE_SECRET_KEY!,
 * })
 * ```
 */
export function createPaymentProvider(
	config: PaymentProviderConfig,
): PaymentProvider {
	switch (config.provider) {
		case 'stripe':
			return new StripeProvider({
				apiKey: config.apiKey,
				apiVersion: config.apiVersion,
			})
		case 'polar':
			return new PolarProvider({
				apiKey: config.apiKey,
				organizationId: config.organizationId,
				server: config.server,
			})
		case 'lemon-squeezy':
			throw new Error(
				'Lemon Squeezy provider not yet implemented. Coming soon! For now, use Stripe.',
			)
		default:
			throw new Error(`Unknown payment provider: ${config.provider}`)
	}
}

/**
 * Create a Stripe payment provider instance (convenience function)
 * @param apiKey Stripe API key
 * @param apiVersion Optional Stripe API version
 * @returns StripeProvider instance
 */
export function createStripeProvider(
	apiKey: string,
	apiVersion?: string,
	httpClient?: ConstructorParameters<typeof StripeProvider>[0]['httpClient'],
): StripeProvider {
	return new StripeProvider({ apiKey, apiVersion, httpClient })
}

/**
 * Create a Polar payment provider instance (convenience function)
 * @param apiKey Polar access token
 * @param organizationId Polar organization ID (optional, can be set later)
 * @returns PolarProvider instance
 */
export function createPolarProvider(
	apiKey: string,
	organizationId?: string,
	server?: 'sandbox' | 'production',
): PolarProvider {
	return new PolarProvider({ apiKey, organizationId, server })
}
