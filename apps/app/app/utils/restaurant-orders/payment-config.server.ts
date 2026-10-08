/**
 * Restaurant order online-payment gating.
 *
 * Restaurant orders are dynamic carts priced by the regional tenant service,
 * so they intentionally do NOT depend on the single-product shop config
 * (`shopEnabled`, `shopProductName`, `shopProductPriceCents`). Online payment
 * is enabled purely from the organization's configured processor account
 * state:
 *
 * - Stripe Connect: US organizations only. KSA Stripe onboarding is
 *   unsupported, so KSA orgs fail closed (online payment disabled).
 * - Checkout.com: any region, requires a sub-entity with charges enabled.
 * - Polar (merchant of record): never. Its static fixed-product checkout is
 *   inappropriate for restaurant carts — fail closed.
 *
 * No processor secrets are exposed here; platform-level secret configuration
 * is checked separately at session-creation time (fail closed there too).
 */

import {
	isRestaurantOrderProcessor,
	normalizeShopProcessor,
	type RestaurantOrderProcessor,
} from '@repo/payments'

/** Control-plane columns the restaurant online-payment gate reads. No PII. */
export type RestaurantPaymentOrgConfig = {
	dataRegion: string | null
	shopPaymentProvider: string | null
	stripeConnectAccountId: string | null
	stripeConnectChargesEnabled: boolean
	checkoutSubEntityId: string | null
	checkoutChargesEnabled: boolean
}

export type RestaurantOnlinePayment = {
	enabled: boolean
	processor: RestaurantOrderProcessor | null
}

/**
 * Resolve whether the organization may accept online restaurant-order
 * payments, and on which processor. The result is embedded in the internal
 * order context so the regional service can offer `paymentMethod: 'online'`.
 */
export function resolveRestaurantOnlinePayment(
	org: RestaurantPaymentOrgConfig,
): RestaurantOnlinePayment {
	const dataRegion = (org.dataRegion || 'us').toLowerCase()
	const processor = normalizeShopProcessor(org.shopPaymentProvider)

	if (processor === 'connect') {
		// KSA Stripe onboarding is unsupported: fail closed rather than routing
		// Saudi commerce through a US platform account.
		if (dataRegion !== 'us') {
			return { enabled: false, processor: null }
		}
		const enabled = Boolean(
			org.stripeConnectAccountId && org.stripeConnectChargesEnabled,
		)
		return { enabled, processor: enabled ? 'connect' : null }
	}

	if (processor === 'checkout') {
		const enabled = Boolean(
			org.checkoutSubEntityId && org.checkoutChargesEnabled,
		)
		return { enabled, processor: enabled ? 'checkout' : null }
	}

	// Polar (mor): a static fixed-product checkout cannot represent a
	// restaurant cart. Fail closed.
	return { enabled: false, processor: null }
}

export function isRestaurantPaymentProcessor(
	processor: string | null | undefined,
): processor is RestaurantOrderProcessor {
	return isRestaurantOrderProcessor(processor)
}

/**
 * Map an order currency (uppercase ISO, e.g. 'USD', 'CAD', 'SAR') to the
 * billing country Checkout.com hosted sessions should assume.
 */
export function billingCountryForCurrency(currency: string): string {
	switch (currency.toUpperCase()) {
		case 'SAR':
			return 'SA'
		case 'CAD':
			return 'CA'
		default:
			return 'US'
	}
}
