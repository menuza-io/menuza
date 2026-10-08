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
	mapCheckoutWebhookToRestaurantOrder,
	mapConnectSessionToRestaurantOrder,
	type RestaurantOrderPaymentEvent,
} from '@repo/payments'
import type Stripe from 'stripe'
import {
	notifyRestaurantOrderPaymentStatus,
	RegionalOrderApiError,
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
