/**
 * Restaurant order payment helpers.
 *
 * Restaurant orders are dynamic carts priced by the regional tenant service;
 * unlike the single-product shop they never carry customer data into the
 * provider. Hosted payment sessions use a fixed generic product name and the
 * metadata below; every amount/currency comes from the regional quote.
 */

import { createHash } from 'node:crypto'
import type Stripe from 'stripe'
import {
	mapCheckoutWebhookToPayment,
	type CheckoutShopPayment,
} from '../connect/checkout-shop'
import { normalizeShopProcessor } from './processors'

export const RESTAURANT_ORDER_METADATA_TYPE = 'restaurant_order' as const

/**
 * Generic hosted-checkout product name. Deliberately constant: it must never
 * contain customer data, cart contents, or order instructions.
 */
export const RESTAURANT_ORDER_PRODUCT_NAME = 'Restaurant order' as const

/** Processors that can host a restaurant order checkout. Polar (mor) cannot. */
export const RESTAURANT_ORDER_PROCESSORS = ['connect', 'checkout'] as const
export type RestaurantOrderProcessor =
	(typeof RESTAURANT_ORDER_PROCESSORS)[number]

/** Payment states reported to the regional order service. */
export const RESTAURANT_TERMINAL_PAYMENT_STATUSES = [
	'paid',
	'failed',
	'expired',
] as const
export type RestaurantTerminalPaymentStatus =
	(typeof RESTAURANT_TERMINAL_PAYMENT_STATUSES)[number]

export type RestaurantOrderPaymentStatus =
	RestaurantTerminalPaymentStatus | 'pending'

/**
 * Non-PII payment event for a restaurant order, derived from a verified
 * provider event or a trusted provider session lookup.
 */
export type RestaurantOrderPaymentEvent = {
	orgId: string
	orderId: string
	/** Provider checkout session id; must match the regionally bound session. */
	sessionId: string
	processor: RestaurantOrderProcessor
	status: RestaurantOrderPaymentStatus
	amountCents: number
	/** Lowercase ISO currency code, e.g. 'usd', 'cad', 'sar'. */
	currency: string
}

export function isRestaurantOrderMetadata(
	metadata: Record<string, string> | null | undefined,
): boolean {
	return metadata?.type === RESTAURANT_ORDER_METADATA_TYPE
}

export function isRestaurantOrderProcessor(
	processor: string | null | undefined,
): processor is RestaurantOrderProcessor {
	// `normalizeShopProcessor` defaults null/unknown values to connect; an
	// absent processor is never a restaurant processor.
	if (!processor) return false
	const normalized = normalizeShopProcessor(processor)
	return normalized === 'connect' || normalized === 'checkout'
}

/**
 * Hosted payment metadata for a restaurant order. Contains only opaque
 * identifiers — never customer contact, cart contents, or instructions.
 */
export function buildRestaurantOrderMetadata(
	orgId: string,
	orderId: string,
): Record<string, string> {
	return {
		type: RESTAURANT_ORDER_METADATA_TYPE,
		orgId,
		orderId,
	}
}

/**
 * Deterministic provider idempotency key so retried checkout creates for the
 * same order (and the same authoritative quote) reuse one provider session
 * instead of creating duplicates. The quote facts are part of the key: a
 * re-issued hold produces a new key while the amount stays immutable.
 */
export function buildRestaurantOrderSessionIdempotencyKey(input: {
	orgId: string
	orderId: string
	amountCents: number
	currency: string
	holdExpiresAt: string | null
}): string {
	const material = [
		input.orgId,
		input.orderId,
		String(input.amountCents),
		input.currency.toUpperCase(),
		input.holdExpiresAt ?? 'none',
	].join('|')
	const digest = createHash('sha256').update(material).digest('hex')
	return `restaurant_order_${digest.slice(0, 40)}`
}

/**
 * Map a Stripe Checkout session (webhook event or trusted retrieval) to a
 * restaurant order payment event. Returns null for sessions that are not
 * restaurant orders or lack the opaque order references.
 */
export function mapConnectSessionToRestaurantOrder(
	session: Stripe.Checkout.Session,
	options: { failed?: boolean } = {},
): RestaurantOrderPaymentEvent | null {
	if (!isRestaurantOrderMetadata(session.metadata)) return null
	const orgId = session.metadata?.orgId
	const orderId = session.metadata?.orderId
	if (!orgId || !orderId) return null
	if (session.amount_total == null) return null

	const status: RestaurantOrderPaymentStatus =
		session.payment_status === 'paid' ||
		session.payment_status === 'no_payment_required'
			? 'paid'
			: options.failed
				? 'failed'
				: session.status === 'expired'
					? 'expired'
					: 'pending'

	return {
		orgId,
		orderId,
		sessionId: session.id,
		processor: 'connect',
		status,
		amountCents: session.amount_total,
		currency: (session.currency || 'usd').toLowerCase(),
	}
}

/**
 * Map a verified Checkout.com webhook event to a restaurant order payment
 * event. Returns null for non-restaurant payments, or payments without the
 * session reference needed to verify the regional binding.
 */
export function mapCheckoutWebhookToRestaurantOrder(event: {
	type: string
	data: unknown
}): RestaurantOrderPaymentEvent | null {
	const payment: CheckoutShopPayment | null = mapCheckoutWebhookToPayment(event)
	if (!payment) return null
	if (!isRestaurantOrderMetadata(payment.metadata)) return null
	const orgId = payment.metadata.orgId
	const orderId = payment.metadata.orderId
	if (!orgId || !orderId) return null
	if (!payment.sessionId) return null

	const status: RestaurantOrderPaymentStatus = payment.paid
		? 'paid'
		: event.type === 'payment_pending'
			? 'pending'
			: 'failed'

	return {
		orgId,
		orderId,
		sessionId: payment.sessionId,
		processor: 'checkout',
		status,
		amountCents: payment.amountCents,
		currency: payment.currency.toLowerCase(),
	}
}

/** Terminal statuses are the only ones worth reporting to the regional service. */
export function isTerminalRestaurantPaymentStatus(
	status: RestaurantOrderPaymentStatus,
): status is RestaurantTerminalPaymentStatus {
	return status === 'paid' || status === 'failed' || status === 'expired'
}
