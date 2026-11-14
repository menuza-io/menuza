/**
 * Provider refunds and disputes of restaurant orders (#80).
 *
 * The region books a refund (`refundId`); the App refunds at the provider with
 * the helpers reservations already use (`createReservationStripeRefund`,
 * `createReservationCheckoutRefund`), passing the ids below. Everything here
 * is opaque ids, amounts and currency: never a guest's contact or the cart.
 */

import { createHash } from 'node:crypto'
import type Stripe from 'stripe'
import {
	isRestaurantOrderMetadata,
	RESTAURANT_ORDER_METADATA_TYPE,
} from './restaurant'

/** A provider refund's state as the region records it. */
export type RestaurantOrderRefundStatus = 'pending' | 'succeeded' | 'failed'

/** A dispute's state as the region records it. */
export type RestaurantOrderDisputeStatus = 'open' | 'won' | 'lost'

/**
 * Metadata of a Stripe refund of a restaurant order. The `type` is the order's
 * own, so a refund object reads as belonging to restaurant orders; `refundId`
 * (the regional refund row) is what tells it apart from a payment.
 */
export function buildRestaurantOrderRefundMetadata(input: {
	orgId: string
	orderId: string
	refundId: string
}): Record<string, string> {
	return {
		type: RESTAURANT_ORDER_METADATA_TYPE,
		orgId: input.orgId,
		orderId: input.orderId,
		refundId: input.refundId,
	}
}

/**
 * Provider idempotency key of one regional refund row: every execution of the
 * same row (operator action, region kick, reconcile, a concurrent retry) sends
 * the same key, so the provider makes one refund at most.
 */
export function buildRestaurantOrderRefundIdempotencyKey(input: {
	orgId: string
	refundId: string
}): string {
	const digest = createHash('sha256')
		.update(`${input.orgId}|${input.refundId}`)
		.digest('hex')
	return `restaurant_order_refund_${digest.slice(0, 40)}`
}

const REFUND_REFERENCE_PREFIX = 'ror_'
/** Checkout.com caps a refund reference; longer ids fall back to the action id. */
const REFUND_REFERENCE_MAX = 50

/**
 * Checkout.com refund reference carrying the regional refund id. Refund events
 * echo the payment's reference, so the App reads this back from the refund
 * action. Null when the id would not fit (the action id then identifies it).
 */
export function restaurantOrderRefundReference(
	refundId: string,
): string | null {
	const reference = `${REFUND_REFERENCE_PREFIX}${refundId}`
	return reference.length <= REFUND_REFERENCE_MAX ? reference : null
}

export function parseRestaurantOrderRefundReference(
	reference: string | null | undefined,
): string | null {
	if (!reference?.startsWith(REFUND_REFERENCE_PREFIX)) return null
	const refundId = reference.slice(REFUND_REFERENCE_PREFIX.length)
	return refundId.length > 0 ? refundId : null
}

/** Stripe's refund status in the region's words. */
export function stripeRefundStatusToRestaurantOrder(
	status: string | null | undefined,
): RestaurantOrderRefundStatus {
	if (status === 'succeeded') return 'succeeded'
	if (status === 'failed' || status === 'canceled') return 'failed'
	return 'pending'
}

/** A short machine code for a failed refund (never free text). */
export function restaurantOrderRefundFailureCode(
	value: string | null | undefined,
	fallback = 'provider_failed',
): string {
	const cleaned = (value ?? '')
		.toLowerCase()
		.replace(/[^a-z0-9_.-]/g, '_')
		.slice(0, 64)
	return cleaned || fallback
}

export type RestaurantOrderStripeRefundEvent = {
	orgId: string
	orderId: string
	refundId: string
	providerRefundId: string
	paymentId: string | null
	amountCents: number
	/** Upper-case ISO currency. */
	currency: string
	status: RestaurantOrderRefundStatus
	failureCode: string | null
}

/**
 * Map a Stripe refund (webhook object or retrieval) of a restaurant order.
 * Null for refunds of anything else, or without the regional refund id.
 */
export function mapStripeRefundToRestaurantOrder(
	refund: Pick<
		Stripe.Refund,
		| 'id'
		| 'amount'
		| 'currency'
		| 'status'
		| 'metadata'
		| 'payment_intent'
		| 'failure_reason'
	>,
): RestaurantOrderStripeRefundEvent | null {
	const metadata = refund.metadata ?? undefined
	if (!isRestaurantOrderMetadata(metadata)) return null
	const orgId = metadata?.orgId
	const orderId = metadata?.orderId
	const refundId = metadata?.refundId
	if (!orgId || !orderId || !refundId) return null
	const status = stripeRefundStatusToRestaurantOrder(refund.status)
	const paymentIntent = refund.payment_intent
	return {
		orgId,
		orderId,
		refundId,
		providerRefundId: refund.id,
		paymentId:
			typeof paymentIntent === 'string'
				? paymentIntent
				: (paymentIntent?.id ?? null),
		amountCents: refund.amount,
		currency: (refund.currency ?? '').toUpperCase(),
		status,
		failureCode:
			status === 'failed'
				? restaurantOrderRefundFailureCode(refund.failure_reason)
				: null,
	}
}

/**
 * Stripe dispute state for the region, or null when it is not a chargeback.
 * `needs_response` and `under_review` are `open` (blocks refunds); a closed
 * chargeback is `lost` only when Stripe says so, and `won` otherwise.
 *
 * A Stripe inquiry (`warning_needs_response`, `warning_under_review`,
 * `warning_closed`) is not a chargeback: Stripe allows refunding during one,
 * and refunding is usually the cheapest way to settle it, so it must not block
 * the refund (409 `payment_disputed`) nor mark the order disputed. It reports
 * null. If the inquiry escalates, Stripe moves the same dispute to
 * `needs_response` and the next event reports `open`.
 */
export function mapStripeDisputeStatusToRestaurantOrder(
	dispute: Pick<Stripe.Dispute, 'status'>,
	closed: boolean,
): RestaurantOrderDisputeStatus | null {
	if (
		dispute.status === 'warning_needs_response' ||
		dispute.status === 'warning_under_review' ||
		dispute.status === 'warning_closed'
	) {
		return null
	}
	if (dispute.status === 'lost') return 'lost'
	if (dispute.status === 'won') return 'won'
	return closed ? 'won' : 'open'
}

/** The restaurant order a payment's metadata names, or null. */
export function restaurantOrderFromMetadata(
	metadata: Record<string, string> | null | undefined,
): { orgId: string; orderId: string } | null {
	if (!isRestaurantOrderMetadata(metadata)) return null
	const orgId = metadata?.orgId
	const orderId = metadata?.orderId
	if (!orgId || !orderId) return null
	// A refund object carries the order's type too; it is never a payment.
	if (metadata?.refundId) return null
	return { orgId, orderId }
}

export type RestaurantOrderCheckoutRefundWebhook = {
	orgId: string
	orderId: string
	/** Checkout.com payment id. */
	paymentId: string
	/** The refund action id (`providerRefundId`). */
	actionId: string
	amountCents: number
	/** Upper-case ISO currency. */
	currency: string
	declined: boolean
	responseCode: string | null
}

/**
 * Facts of a `payment_refunded` / `payment_refund_declined` event of a
 * restaurant order payment (the payment's metadata names the order). The
 * regional refund id is not in the event: the caller reads it from the refund
 * action's reference, or reports by `providerRefundId`.
 */
export function mapCheckoutRefundWebhookToRestaurantOrder(event: {
	type: string
	data: unknown
}): RestaurantOrderCheckoutRefundWebhook | null {
	if (
		event.type !== 'payment_refunded' &&
		event.type !== 'payment_refund_declined'
	) {
		return null
	}
	const raw = event.data as {
		id?: string
		action_id?: string
		amount?: number
		currency?: string
		response_code?: string | null
		metadata?: Record<string, unknown>
	} | null
	if (!raw?.id || !raw.action_id) return null
	const metadata: Record<string, string> = {}
	for (const [key, value] of Object.entries(raw.metadata ?? {})) {
		metadata[key] = String(value)
	}
	const order = restaurantOrderFromMetadata(metadata)
	if (!order) return null
	return {
		...order,
		paymentId: raw.id,
		actionId: raw.action_id,
		amountCents: typeof raw.amount === 'number' ? raw.amount : 0,
		currency: (raw.currency ?? '').toUpperCase(),
		declined: event.type === 'payment_refund_declined',
		responseCode: raw.response_code ?? null,
	}
}

const CHECKOUT_DISPUTE_STATUS: Record<string, RestaurantOrderDisputeStatus> = {
	dispute_received: 'open',
	dispute_evidence_required: 'open',
	dispute_evidence_submitted: 'open',
	dispute_won: 'won',
	dispute_canceled: 'won',
	dispute_resolved: 'won',
	dispute_lost: 'lost',
	dispute_accepted: 'lost',
	dispute_expired: 'lost',
}

/**
 * A Checkout.com dispute event in the region's words. Disputes carry no
 * metadata: the caller retrieves the payment to learn the order.
 */
export function mapCheckoutDisputeWebhookToRestaurantOrder(event: {
	type: string
	data: unknown
}): { paymentId: string; status: RestaurantOrderDisputeStatus } | null {
	const status = CHECKOUT_DISPUTE_STATUS[event.type]
	if (!status) return null
	const raw = event.data as { payment_id?: string } | null
	if (!raw?.payment_id) return null
	return { paymentId: raw.payment_id, status }
}

/**
 * Platform commission to reverse with one Checkout.com refund, so that the
 * reversals of every refund of a payment add up to the commission taken
 * (cumulative rounding, like reservation refunds). `refundedBeforeCents` is
 * what earlier refunds of the payment returned (pending ones included).
 */
export function restaurantOrderCommissionReversal(input: {
	paymentCents: number
	commissionCents: number
	refundedBeforeCents: number
	amountCents: number
}): number {
	const { paymentCents, commissionCents, amountCents } = input
	if (paymentCents <= 0 || commissionCents <= 0 || amountCents <= 0) return 0
	const before = Math.max(0, Math.min(input.refundedBeforeCents, paymentCents))
	const after = Math.min(paymentCents, before + amountCents)
	const share = (cents: number) =>
		cents >= paymentCents
			? commissionCents
			: Math.floor((commissionCents * cents) / paymentCents)
	return Math.max(0, Math.min(amountCents, share(after) - share(before)))
}
