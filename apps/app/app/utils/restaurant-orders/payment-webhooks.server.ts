/**
 * Restaurant order payment webhook dispatch.
 *
 * Verified provider events carrying `restaurant_order` metadata are forwarded
 * to the org's regional tenant service over the internal command channel with
 * only non-PII payment facts (opaque ids, status, amount, currency). The
 * regional service verifies the session binding and the immutable
 * amount/currency before recording anything — App never marks an order paid on
 * a redirect, and never touches regional customer data.
 *
 * Transient regional failures propagate so the provider retries; permanent
 * regional rejections (unknown order, session/amount mismatch) are logged and
 * acknowledged so the provider does not retry forever on a doomed event.
 */

import { and, db, eq, Organization } from '@repo/database'
import {
	isRestaurantOrderMetadata,
	isTerminalRestaurantPaymentStatus,
	mapCheckoutDisputeWebhookToRestaurantOrder,
	mapCheckoutRefundWebhookToRestaurantOrder,
	mapCheckoutWebhookToRestaurantOrder,
	mapConnectSessionToRestaurantOrder,
	mapStripeDisputeStatusToRestaurantOrder,
	mapStripeRefundToRestaurantOrder,
	parseRestaurantOrderRefundReference,
	restaurantOrderFromMetadata,
	restaurantOrderRefundFailureCode,
	type RestaurantOrderDisputeStatus,
	type RestaurantOrderPaymentEvent,
	type RestaurantOrderRefundStatus,
} from '@repo/payments'
import type Stripe from 'stripe'
import { getShopCommerce } from '#app/utils/shop.server.ts'
import {
	notifyRestaurantOrderPaymentStatus,
	RegionalOrderApiError,
	reportRestaurantOrderDisputeStatus,
	reportRestaurantOrderRefundStatus,
} from './regional-order-api.server.ts'

async function resolveActiveOrgRegion(orgId: string): Promise<string | null> {
	const org = await db.query.Organization.findFirst({
		where: and(eq(Organization.id, orgId), eq(Organization.active, true)),
		columns: { dataRegion: true },
	})
	return org?.dataRegion ?? null
}

async function dispatchTerminalRestaurantPayment(
	event: RestaurantOrderPaymentEvent,
): Promise<void> {
	if (!isTerminalRestaurantPaymentStatus(event.status)) return

	const dataRegion = await resolveActiveOrgRegion(event.orgId)
	if (!dataRegion) {
		// The org is gone or inactive; its regional order data is gone with it.
		console.warn(
			`Restaurant payment callback for unknown org ${event.orgId} ignored`,
		)
		return
	}

	try {
		await notifyRestaurantOrderPaymentStatus({
			dataRegion,
			orgId: event.orgId,
			orderId: event.orderId,
			sessionId: event.sessionId,
			processor: event.processor,
			status: event.status,
			amountCents: event.amountCents,
			currency: event.currency,
			paymentId: event.paymentId,
		})
	} catch (error) {
		if (error instanceof RegionalOrderApiError && !error.retryable) {
			// Permanent rejection (unknown order, unbound session, amount/currency
			// mismatch): the regional service refuses to confirm, and no retry
			// will change that. Ack so the provider stops retrying.
			console.error(
				`Regional service rejected restaurant payment callback for order ${event.orderId}:`,
				error,
			)
			return
		}
		throw error
	}
}

/**
 * Dispatch a signature-verified Stripe Checkout session event for a restaurant
 * order. Sessions are the session-level source of truth for hosted restaurant
 * payments; `payment_intent.*` events have no session reference and are skipped
 * by the caller.
 */
export async function handleRestaurantOrderStripeSessionEvent(
	session: Stripe.Checkout.Session,
	eventType: string,
): Promise<void> {
	if (!isRestaurantOrderMetadata(session.metadata)) return
	const event = mapConnectSessionToRestaurantOrder(session, {
		failed: eventType === 'checkout.session.async_payment_failed',
	})
	if (!event) return
	if (!isTerminalRestaurantPaymentStatus(event.status)) return
	await dispatchTerminalRestaurantPayment(event)
}

/**
 * Dispatch a signature-verified Checkout.com webhook event for a restaurant
 * order. Only events carrying the payment session reference (needed to verify
 * the regional binding) are forwarded.
 */
export async function handleRestaurantOrderCheckoutWebhookEvent(verifiedEvent: {
	type: string
	data: unknown
}): Promise<void> {
	const event = mapCheckoutWebhookToRestaurantOrder(verifiedEvent)
	if (!event) return
	if (!isTerminalRestaurantPaymentStatus(event.status)) return
	await dispatchTerminalRestaurantPayment(event)
}

/** True when a Stripe object's metadata marks it as a restaurant order. */
export function isRestaurantStripeMetadata(
	metadata: Record<string, string> | null | undefined,
): boolean {
	return isRestaurantOrderMetadata(metadata)
}

/* ------------------------------------------------------------------ */
/* Refunds and disputes (#80)                                          */
/* ------------------------------------------------------------------ */

/**
 * Regional answers that mean "this report does not apply" and that no retry
 * changes: an unknown refund or order (also a region that predates the route:
 * 404), a refund that is already final or reported with other facts (409,
 * 422). Anything else (400 contract skew, 401/403 after a rotation, 5xx) is
 * the wiring: the provider redelivers.
 */
const FINAL_REGIONAL_STATUSES = new Set([404, 409, 422])

async function deliverToRegion(
	label: string,
	operation: () => Promise<unknown>,
): Promise<void> {
	try {
		await operation()
	} catch (error) {
		if (
			error instanceof RegionalOrderApiError &&
			FINAL_REGIONAL_STATUSES.has(error.httpStatus)
		) {
			console.warn(
				`Restaurant order ${label} not applied by the region:`,
				error.code,
			)
			return
		}
		if (error instanceof RegionalOrderApiError) {
			console.error(
				`Restaurant order ${label} not delivered, will retry:`,
				error.code,
			)
		}
		throw error
	}
}

async function reportRefundFromProvider(input: {
	orgId: string
	orderId: string
	refundId: string | null
	providerRefundId: string
	processor: 'connect' | 'checkout'
	status: RestaurantOrderRefundStatus
	failureCode: string | null
	amountCents: number
	currency: string
}): Promise<void> {
	// `pending` adds nothing the App's own report did not say already.
	if (input.status === 'pending') return
	const dataRegion = await resolveActiveOrgRegion(input.orgId)
	if (!dataRegion) return
	const amountCents =
		Number.isInteger(input.amountCents) && input.amountCents > 0
			? input.amountCents
			: undefined
	const currency = /^[A-Z]{3}$/.test(input.currency)
		? input.currency
		: undefined
	await deliverToRegion('refund status', () =>
		reportRestaurantOrderRefundStatus({
			dataRegion,
			orgId: input.orgId,
			orderId: input.orderId,
			...(input.refundId ? { refundId: input.refundId } : {}),
			providerRefundId: input.providerRefundId,
			processor: input.processor,
			status: input.status,
			...(input.status === 'failed'
				? {
						failureCode: restaurantOrderRefundFailureCode(input.failureCode),
					}
				: {}),
			...(amountCents ? { amountCents } : {}),
			...(currency ? { currency } : {}),
		}),
	)
}

async function reportDisputeFromProvider(input: {
	orgId: string
	orderId: string
	processor: 'connect' | 'checkout'
	status: RestaurantOrderDisputeStatus
}): Promise<void> {
	const dataRegion = await resolveActiveOrgRegion(input.orgId)
	if (!dataRegion) return
	await deliverToRegion('dispute status', () =>
		reportRestaurantOrderDisputeStatus({
			dataRegion,
			orgId: input.orgId,
			orderId: input.orderId,
			processor: input.processor,
			status: input.status,
		}),
	)
}

/** True when a Stripe refund object is a restaurant order's provider refund. */
export function isRestaurantStripeRefund(
	refund: Pick<Stripe.Refund, 'metadata'>,
): boolean {
	return (
		isRestaurantOrderMetadata(refund.metadata ?? undefined) &&
		Boolean(refund.metadata?.refundId)
	)
}

/**
 * `refund.updated`, `refund.failed` and `charge.refund.updated` of a refund
 * the App made for a restaurant order (its metadata names the regional
 * refund). Ids, amount and currency go to the region; replays are idempotent
 * there. Refunds of anything else are ignored.
 */
export async function handleRestaurantOrderStripeRefundEvent(
	refund: Stripe.Refund,
): Promise<void> {
	const event = mapStripeRefundToRestaurantOrder(refund)
	if (!event) return
	await reportRefundFromProvider({
		orgId: event.orgId,
		orderId: event.orderId,
		refundId: event.refundId,
		providerRefundId: event.providerRefundId,
		processor: 'connect',
		status: event.status,
		failureCode: event.failureCode,
		amountCents: event.amountCents,
		currency: event.currency,
	})
}

/**
 * `charge.dispute.created|updated|closed`. A dispute carries no metadata, so
 * the platform PaymentIntent is read; disputes of anything but a restaurant
 * order payment are ignored.
 */
export async function handleRestaurantOrderStripeDisputeEvent(
	dispute: Stripe.Dispute,
	eventType: string,
): Promise<void> {
	const intentId =
		typeof dispute.payment_intent === 'string'
			? dispute.payment_intent
			: dispute.payment_intent?.id
	if (!intentId) return
	let intent: Stripe.PaymentIntent
	try {
		intent = await getShopCommerce().retrieveReservationPaymentIntent(intentId)
	} catch (error) {
		if ((error as { statusCode?: number } | null)?.statusCode === 404) return
		throw error
	}
	const order = restaurantOrderFromMetadata(intent.metadata ?? undefined)
	if (!order) return
	await reportDisputeFromProvider({
		...order,
		processor: 'connect',
		status: mapStripeDisputeStatusToRestaurantOrder(
			dispute,
			eventType === 'charge.dispute.closed',
		),
	})
}

/**
 * Checkout.com refund and dispute events of restaurant order payments. The
 * refund id is read from the refund action's reference (from the payment's
 * actions; the event echoes the payment's reference); the action id always
 * rides along, so the region finds the refund either way.
 */
export async function handleRestaurantOrderCheckoutRefundOrDisputeEvent(verifiedEvent: {
	type: string
	data: unknown
}): Promise<void> {
	const refund = mapCheckoutRefundWebhookToRestaurantOrder(verifiedEvent)
	if (refund) {
		const actions =
			await getShopCommerce().listReservationCheckoutPaymentActions(
				refund.paymentId,
			)
		const action = actions.find((entry) => entry.id === refund.actionId)
		const refundId = parseRestaurantOrderRefundReference(action?.reference)
		await reportRefundFromProvider({
			orgId: refund.orgId,
			orderId: refund.orderId,
			refundId,
			providerRefundId: refund.actionId,
			processor: 'checkout',
			status: refund.declined ? 'failed' : 'succeeded',
			failureCode: refund.declined ? 'refund_declined' : null,
			amountCents: refund.amountCents,
			currency: refund.currency,
		})
		return
	}

	const dispute = mapCheckoutDisputeWebhookToRestaurantOrder(verifiedEvent)
	if (!dispute) return
	let payment
	try {
		payment = await getShopCommerce().retrieveReservationCheckoutPayment(
			dispute.paymentId,
		)
	} catch (error) {
		if ((error as { http_code?: number } | null)?.http_code === 404) return
		throw error
	}
	const order = restaurantOrderFromMetadata(payment.metadata)
	if (!order) return
	await reportDisputeFromProvider({
		...order,
		processor: 'checkout',
		status: dispute.status,
	})
}
