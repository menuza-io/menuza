/**
 * Reservation payment webhook dispatch (Stripe and Checkout.com).
 *
 * Callers pass signature-verified provider events (the SDK and
 * `verifyCheckoutWebhookEvent` compare in constant time; nothing here weakens
 * that). Each event is mapped to an ids-and-amounts DTO at once, the raw event
 * is never stored or logged, and the DTO goes to the org's region.
 *
 * Failures to reach the region propagate so the route answers 5xx and the
 * provider retries. Permanent regional rejections (unknown payment, mismatched
 * session or amount) are logged by code and acknowledged. Duplicates are
 * idempotent regionally and answer 200.
 */

import {
	buildCheckoutRefundEvent,
	extractCheckoutDisputeWebhook,
	extractCheckoutRefundWebhook,
	isReservationMetadata,
	mapCheckoutDisputeToReservation,
	mapCheckoutWebhookToReservationPayment,
	mapStripeDisputeToReservation,
	mapStripeRefundToReservation,
	mapStripeSessionToReservationPayment,
	type ReservationDisputeEvent,
	type ReservationRefundEvent,
} from '@repo/payments'
import type Stripe from 'stripe'
import {
	isTerminalReservationEvent,
	loadReservationPaymentsOrg,
	logReservationPaymentFailure,
	pushReservationPaymentEvent,
} from '#app/utils/reservations/payments.server.ts'
import {
	RegionalPaymentsApiError,
	reportReservationDispute,
	reportReservationRefundResult,
} from '#app/utils/reservations/regional-payments-api.server.ts'
import { getShopCommerce } from '#app/utils/shop.server.ts'

/** True when a Stripe object's metadata marks it as a reservation payment. */
export function isReservationStripeMetadata(
	metadata: Record<string, string> | null | undefined,
): boolean {
	return isReservationMetadata(metadata)
}

/** Run a regional delivery; ack permanent rejections, rethrow transient ones. */
async function deliver(label: string, operation: () => Promise<unknown>) {
	try {
		await operation()
	} catch (error) {
		if (error instanceof RegionalPaymentsApiError && !error.retryable) {
			logReservationPaymentFailure(`${label} rejected by region`, error)
			return
		}
		throw error
	}
}

async function resolveRegion(
	orgId: string,
): Promise<string | null | undefined> {
	const org = await loadReservationPaymentsOrg(orgId)
	if (!org) {
		console.warn(
			'Reservation payment callback for an unknown organization ignored',
		)
		return undefined
	}
	return org.dataRegion
}

/**
 * Checkout Session events (`completed`, `expired`, `async_payment_*`). A setup
 * session is retrieved with its SetupIntent first: the event object does not
 * carry the saved card.
 */
export async function handleReservationStripeSessionEvent(
	session: Stripe.Checkout.Session,
	eventType: string,
): Promise<void> {
	if (!isReservationMetadata(session.metadata ?? undefined)) return
	const failed = eventType === 'checkout.session.async_payment_failed'
	const source =
		session.mode === 'setup' && eventType === 'checkout.session.completed'
			? await getShopCommerce().retrieveReservationStripeSession(session.id, {
					setup: true,
				})
			: session
	const event = mapStripeSessionToReservationPayment(source, { failed })
	if (!event || !isTerminalReservationEvent(event)) return
	const dataRegion = await resolveRegion(event.orgId)
	if (dataRegion === undefined) return
	await deliver('payment status', () =>
		pushReservationPaymentEvent({ dataRegion }, event),
	)
}

async function reportRefund(event: ReservationRefundEvent) {
	const dataRegion = await resolveRegion(event.orgId)
	if (dataRegion === undefined) return
	if (event.status === 'pending') return
	await deliver('refund result', () =>
		reportReservationRefundResult({
			dataRegion,
			orgId: event.orgId,
			...(event.refundRequestId
				? { refundRequestId: event.refundRequestId }
				: {
						reservationId: event.reservationId,
						paymentRef: event.paymentRef ?? undefined,
						reason: 'late_payment' as const,
					}),
			refundRef: event.refundRef,
			amountMinor: event.amountMinor,
			status: event.status,
		}),
	)
}

/** `refund.updated`, `refund.failed` and `charge.refund.updated` (a Refund object). */
export async function handleReservationStripeRefundEvent(
	refund: Stripe.Refund,
): Promise<void> {
	if (!isReservationMetadata(refund.metadata ?? undefined)) return
	const event = mapStripeRefundToReservation(refund)
	if (!event) return
	await reportRefund(event)
}

async function reportDispute(event: ReservationDisputeEvent) {
	if (!event.orgId) return
	const dataRegion = await resolveRegion(event.orgId)
	if (dataRegion === undefined) return
	await deliver('dispute', () =>
		reportReservationDispute({
			dataRegion,
			orgId: event.orgId!,
			reservationId: event.reservationId ?? undefined,
			paymentRef: event.paymentRef,
			disputeRef: event.disputeRef,
			status: event.status,
		}),
	)
}

/**
 * `charge.dispute.created` / `charge.dispute.closed`. A dispute carries no
 * metadata, so the platform PaymentIntent is looked up; disputes of other
 * payments (orders, the shop) are ignored. Reported only; no evidence is built.
 */
export async function handleReservationStripeDisputeEvent(
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
	if (!isReservationMetadata(intent.metadata ?? undefined)) return
	const event = mapStripeDisputeToReservation(
		dispute,
		intent,
		eventType === 'charge.dispute.closed',
	)
	if (event) await reportDispute(event)
}

/**
 * Verified Checkout.com event: hosted-page payments, refund settlement and
 * disputes. Refund events echo the payment's reference, so the refund request
 * id is read from the refund action's reference (event first, then the
 * payment's action list). Events of other flows are ignored.
 */
export async function handleReservationCheckoutWebhookEvent(verifiedEvent: {
	type: string
	data: unknown
}): Promise<void> {
	const payment = mapCheckoutWebhookToReservationPayment(verifiedEvent)
	if (payment) {
		if (!isTerminalReservationEvent(payment)) return
		const dataRegion = await resolveRegion(payment.orgId)
		if (dataRegion === undefined) return
		await deliver('payment status', () =>
			pushReservationPaymentEvent({ dataRegion }, payment),
		)
		return
	}

	const refund = extractCheckoutRefundWebhook(verifiedEvent)
	if (refund) {
		if (!refund.orgId || !refund.reservationId) return
		let event = buildCheckoutRefundEvent(refund, null)
		if (!event) {
			const actions =
				await getShopCommerce().listReservationCheckoutPaymentActions(
					refund.paymentId,
				)
			const action = actions.find((entry) => entry.id === refund.actionId)
			event = buildCheckoutRefundEvent(refund, action?.reference ?? null)
		}
		if (event) await reportRefund(event)
		return
	}

	const dispute = extractCheckoutDisputeWebhook(verifiedEvent)
	if (dispute) {
		let found
		try {
			found = await getShopCommerce().retrieveReservationCheckoutPayment(
				dispute.paymentId,
			)
		} catch (error) {
			if ((error as { http_code?: number } | null)?.http_code === 404) return
			throw error
		}
		const event = mapCheckoutDisputeToReservation(dispute, found)
		if (event) await reportDispute(event)
	}
}
