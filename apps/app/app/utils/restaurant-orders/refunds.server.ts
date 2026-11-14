/**
 * Provider refunds of restaurant orders (#80): the App half.
 *
 * The region books a refund (`pending`, a reservation of the amount) and stays
 * the source of truth; the App is the only component that talks to Stripe or
 * Checkout.com. It reads the booked refund back (`refunds-pending`), refunds
 * at the provider with a key derived from the refund id, and reports the
 * provider's answer (`refund-status`). Webhooks and the hourly reconcile job
 * finish what is still pending.
 *
 * Invariants:
 * - Only ids, amounts, currency and provider ids cross: never a guest's
 *   contact, address or cart. Logs carry an error name and code, nothing else.
 * - Safe to run twice and at once: the provider key is the refund id's, an
 *   earlier provider refund of the same row is adopted before a new one is
 *   asked for, and the region accepts one final status per refund.
 * - A provider rejection that is clearly final (already refunded, disputed,
 *   over the balance) reports `failed`; a transient error leaves the refund
 *   `pending` for the reconcile job and is surfaced as retryable.
 * - Never called inside a regional lock or transaction.
 *
 * Fees: restaurant orders are destination charges on the platform (Stripe)
 * and split payments to the organization's sub-entity (Checkout.com), with the
 * platform commission of `calculateShopFees`. A refund reverses the transfer
 * and refunds the platform commission in proportion, exactly as reservation
 * refunds do (Stripe splits it; on Checkout.com the reversal is cumulative so
 * the parts add up to the commission). Card processing fees are not returned
 * by the providers; there is no fee-split product.
 */

import { type OrderProviderRefund } from '@repo/common/restaurant-orders'
import { and, db, eq, Organization } from '@repo/database'
import {
	buildRestaurantOrderRefundIdempotencyKey,
	buildRestaurantOrderRefundMetadata,
	calculateShopFees,
	checkoutRefundActionStatus,
	isStripeTransientError,
	mapStripeRefundToRestaurantOrder,
	restaurantOrderCheckoutReference,
	restaurantOrderCommissionReversal,
	restaurantOrderFromMetadata,
	restaurantOrderRefundFailureCode,
	restaurantOrderRefundReference,
	stripeRefundStatusToRestaurantOrder,
	type RestaurantOrderRefundStatus,
} from '@repo/payments'
import { getShopCommerce } from '#app/utils/shop.server.ts'
import {
	fetchPendingRestaurantOrderRefunds,
	RegionalOrderApiError,
	reportRestaurantOrderRefundStatus,
} from './regional-order-api.server.ts'

/* ------------------------------------------------------------------ */
/* Errors and logging                                                  */
/* ------------------------------------------------------------------ */

/** A refund execution failure with a stable code (never provider text). */
export class RestaurantOrderRefundError extends Error {
	constructor(
		public readonly code: string,
		public readonly httpStatus: number,
		public readonly retryable = false,
	) {
		super(`Restaurant order refund error: ${code}`)
		this.name = 'RestaurantOrderRefundError'
	}
}

/** Log a failure by error name and code only: no message, no payload. */
export function logRestaurantRefundFailure(label: string, error: unknown) {
	const code =
		(error as { code?: unknown } | null)?.code ??
		(error as { http_code?: unknown } | null)?.http_code
	console.error(
		`Restaurant order refunds: ${label}`,
		error instanceof Error ? error.name : 'unknown',
		typeof code === 'string' || typeof code === 'number' ? code : '',
	)
}

/** A provider or regional failure that a later attempt may get past. */
export function isTransientRefundError(error: unknown): boolean {
	if (error instanceof RestaurantOrderRefundError) return error.retryable
	if (error instanceof RegionalOrderApiError) return error.retryable
	const httpCode = (error as { http_code?: unknown } | null)?.http_code
	if (typeof httpCode === 'number') return httpCode >= 500 || httpCode === 429
	return isStripeTransientError(error)
}

/* ------------------------------------------------------------------ */
/* Organization                                                        */
/* ------------------------------------------------------------------ */

export type RestaurantRefundOrg = {
	id: string
	dataRegion: string | null
	hasProvisionedDb: boolean
	checkoutSubEntityId: string | null
}

/** An active organization by id (from a trusted caller, never the browser). */
export async function loadRestaurantRefundOrg(
	orgId: string,
): Promise<RestaurantRefundOrg | null> {
	const org = await db.query.Organization.findFirst({
		where: and(eq(Organization.id, orgId), eq(Organization.active, true)),
		columns: {
			id: true,
			dataRegion: true,
			hasProvisionedDb: true,
			checkoutSubEntityId: true,
		},
	})
	return org ?? null
}

/* ------------------------------------------------------------------ */
/* Provider calls                                                      */
/* ------------------------------------------------------------------ */

export type RestaurantProviderRefundOutcome = {
	status: RestaurantOrderRefundStatus
	providerRefundId: string | null
	failureCode: string | null
}

const failed = (code: string): RestaurantProviderRefundOutcome => ({
	status: 'failed',
	providerRefundId: null,
	failureCode: restaurantOrderRefundFailureCode(code),
})

function isNotFound(error: unknown): boolean {
	return (
		(error as { statusCode?: unknown } | null)?.statusCode === 404 ||
		(error as { http_code?: unknown } | null)?.http_code === 404 ||
		(error as { code?: unknown } | null)?.code === 'resource_missing'
	)
}

/** True when a payment's metadata names exactly this organization's order. */
function belongsToOrder(
	metadata: Record<string, string> | null | undefined,
	orgId: string,
	orderId: string,
): boolean {
	const order = restaurantOrderFromMetadata(metadata)
	return order?.orgId === orgId && order.orderId === orderId
}

/**
 * The Stripe PaymentIntent of the refund's payment, checked against the
 * order's metadata. Null when it cannot be found or is not this order's.
 */
async function resolveStripePaymentIntent(
	orgId: string,
	refund: OrderProviderRefund,
): Promise<string | null> {
	const commerce = getShopCommerce()
	try {
		const direct = refund.paymentId?.startsWith('pi_')
			? refund.paymentId
			: refund.sessionId.startsWith('pi_')
				? refund.sessionId
				: null
		if (direct) {
			const intent = await commerce.retrieveReservationPaymentIntent(direct)
			return belongsToOrder(intent.metadata, orgId, refund.orderId)
				? intent.id
				: null
		}
		const session = await commerce.retrieveConnectCheckoutSession(
			refund.sessionId,
		)
		if (!belongsToOrder(session.metadata, orgId, refund.orderId)) return null
		const intent = session.payment_intent
		return typeof intent === 'string' ? intent : (intent?.id ?? null)
	} catch (error) {
		if (isNotFound(error)) return null
		throw error
	}
}

/**
 * The Checkout.com payment the refund returns money from: the stored payment
 * id, a payment id stored as the session (a tab's review payment), or the one
 * approved payment of the order's reference. Null when there is none, or more
 * than one and nothing says which.
 */
async function resolveCheckoutPayment(
	orgId: string,
	refund: OrderProviderRefund,
) {
	const commerce = getShopCommerce()
	try {
		const direct = refund.paymentId?.startsWith('pay_')
			? refund.paymentId
			: refund.sessionId.startsWith('pay_')
				? refund.sessionId
				: null
		if (direct) {
			const payment = await commerce.retrieveReservationCheckoutPayment(direct)
			return belongsToOrder(payment.metadata, orgId, refund.orderId)
				? payment
				: null
		}
		const reference = restaurantOrderCheckoutReference(orgId, refund.orderId)
		if (refund.sessionId !== reference) return null
		const approved = (
			await commerce.findReservationCheckoutPayments(reference)
		).filter(
			(payment) =>
				payment.approved &&
				belongsToOrder(payment.metadata, orgId, refund.orderId),
		)
		return approved.length === 1 ? approved[0]! : null
	} catch (error) {
		if (isNotFound(error)) return null
		throw error
	}
}

/** A Stripe refund already made for this refund row (adopted, never doubled). */
async function findExistingStripeRefund(
	orgId: string,
	refund: OrderProviderRefund,
	paymentIntentId: string,
) {
	const listed =
		await getShopCommerce().listStripeRefundsForPaymentIntent(paymentIntentId)
	for (const candidate of listed) {
		const event = mapStripeRefundToRestaurantOrder(candidate)
		if (
			event?.orgId === orgId &&
			event.refundId === refund.refundId &&
			event.orderId === refund.orderId
		) {
			return event
		}
	}
	return null
}

async function refundAtStripe(
	org: RestaurantRefundOrg,
	refund: OrderProviderRefund,
): Promise<RestaurantProviderRefundOutcome> {
	const paymentIntentId = await resolveStripePaymentIntent(org.id, refund)
	if (!paymentIntentId) return failed('payment_not_found')
	const existing = await findExistingStripeRefund(
		org.id,
		refund,
		paymentIntentId,
	)
	if (existing) {
		return {
			status: existing.status,
			providerRefundId: existing.providerRefundId,
			failureCode: existing.failureCode,
		}
	}
	const outcome = await getShopCommerce().createReservationStripeRefund({
		paymentIntentId,
		amountMinor: refund.amountCents,
		idempotencyKey: buildRestaurantOrderRefundIdempotencyKey({
			orgId: org.id,
			refundId: refund.refundId,
		}),
		metadata: buildRestaurantOrderRefundMetadata({
			orgId: org.id,
			orderId: refund.orderId,
			refundId: refund.refundId,
		}),
	})
	if (outcome.status === 'failed' && !outcome.refundRef) {
		// "Already refunded" may be this very refund, made a moment ago by a
		// concurrent run of the same row: adopt it rather than report failed.
		const made = await findExistingStripeRefund(org.id, refund, paymentIntentId)
		if (made) {
			return {
				status: made.status,
				providerRefundId: made.providerRefundId,
				failureCode: made.failureCode,
			}
		}
	}
	return {
		status: outcome.status,
		providerRefundId: outcome.refundRef,
		failureCode:
			outcome.status === 'failed'
				? restaurantOrderRefundFailureCode(outcome.failureCode)
				: null,
	}
}

async function refundAtCheckout(
	org: RestaurantRefundOrg,
	refund: OrderProviderRefund,
): Promise<RestaurantProviderRefundOutcome> {
	if (!org.checkoutSubEntityId) return failed('processor_unavailable')
	const payment = await resolveCheckoutPayment(org.id, refund)
	if (!payment) return failed('payment_not_found')
	const commerce = getShopCommerce()
	// An id too long for a reference sends a shortened one that never parses
	// back as a refund id; webhooks then name the refund by its action id.
	const reference =
		restaurantOrderRefundReference(refund.refundId) ??
		`rorx_${refund.refundId.slice(0, 45)}`
	const actions = (
		await commerce.listReservationCheckoutPaymentActions(payment.id)
	).filter((action) => action.type === 'Refund')
	// A refund action of this row from an earlier run: adopt it.
	const mine = actions.find((action) => action.reference === reference)
	if (mine) {
		const status = checkoutRefundActionStatus(mine)
		return {
			status,
			providerRefundId: mine.id,
			failureCode: status === 'failed' ? 'refund_declined' : null,
		}
	}
	const refundedBeforeCents = actions
		.filter((action) => action.approved !== false)
		.reduce((sum, action) => sum + action.amountMinor, 0)
	const outcome = await commerce.createReservationCheckoutRefund({
		paymentId: payment.id,
		subEntityId: org.checkoutSubEntityId,
		amountMinor: refund.amountCents,
		feeReversalMinor: restaurantOrderCommissionReversal({
			paymentCents: payment.amountMinor,
			commissionCents: calculateShopFees(payment.amountMinor).platformFeeCents,
			refundedBeforeCents,
			amountCents: refund.amountCents,
		}),
		reference,
		idempotencyKey: buildRestaurantOrderRefundIdempotencyKey({
			orgId: org.id,
			refundId: refund.refundId,
		}),
	})
	if (outcome.status === 'failed' && !outcome.refundRef) {
		// Over the balance may mean this refund already exists (a concurrent
		// run of the same row): adopt it rather than report failed.
		const made = (
			await commerce.listReservationCheckoutPaymentActions(payment.id)
		).find(
			(action) => action.type === 'Refund' && action.reference === reference,
		)
		if (made) {
			const status = checkoutRefundActionStatus(made)
			return {
				status,
				providerRefundId: made.id,
				failureCode: status === 'failed' ? 'refund_declined' : null,
			}
		}
	}
	return {
		status: outcome.status,
		providerRefundId: outcome.refundRef,
		failureCode:
			outcome.status === 'failed'
				? restaurantOrderRefundFailureCode(outcome.failureCode)
				: null,
	}
}

/**
 * Refund one booked refund at its provider. Definitive rejections come back
 * `failed` with a code; transient failures throw (the caller retries later).
 */
export async function issueRestaurantOrderProviderRefund(
	org: RestaurantRefundOrg,
	refund: OrderProviderRefund,
): Promise<RestaurantProviderRefundOutcome> {
	const commerce = getShopCommerce()
	if (!commerce.isProcessorConfigured(refund.processor)) {
		// Platform keys missing: a deploy fault, not the guest's payment.
		throw new RestaurantOrderRefundError('processor_unconfigured', 503, true)
	}
	return refund.processor === 'connect'
		? refundAtStripe(org, refund)
		: refundAtCheckout(org, refund)
}

/**
 * Read an executed refund back from its provider. `pending` when it is not
 * decided yet, or when the provider object does not belong to this refund.
 */
export async function readRestaurantOrderProviderRefund(
	org: RestaurantRefundOrg,
	refund: OrderProviderRefund & { providerRefundId: string },
): Promise<RestaurantProviderRefundOutcome> {
	const commerce = getShopCommerce()
	if (refund.processor === 'connect') {
		const stored = await commerce.retrieveReservationStripeRefund(
			refund.providerRefundId,
		)
		const event = mapStripeRefundToRestaurantOrder(stored)
		if (
			!event ||
			event.orgId !== org.id ||
			event.refundId !== refund.refundId
		) {
			return {
				status: 'pending',
				providerRefundId: refund.providerRefundId,
				failureCode: null,
			}
		}
		return {
			status: stripeRefundStatusToRestaurantOrder(stored.status),
			providerRefundId: stored.id,
			failureCode: event.failureCode,
		}
	}
	const payment = await resolveCheckoutPayment(org.id, refund)
	if (!payment) {
		return {
			status: 'pending',
			providerRefundId: refund.providerRefundId,
			failureCode: null,
		}
	}
	const actions = await commerce.listReservationCheckoutPaymentActions(
		payment.id,
	)
	const action = actions.find((entry) => entry.id === refund.providerRefundId)
	const status = action ? checkoutRefundActionStatus(action) : 'pending'
	return {
		status,
		providerRefundId: refund.providerRefundId,
		failureCode: status === 'failed' ? 'refund_declined' : null,
	}
}

/* ------------------------------------------------------------------ */
/* Reporting                                                           */
/* ------------------------------------------------------------------ */

const REPORT_ATTEMPTS = 3

/** Report one provider answer, retrying transient regional failures briefly. */
export async function reportRestaurantRefundOutcome(
	org: Pick<RestaurantRefundOrg, 'id' | 'dataRegion'>,
	refund: OrderProviderRefund,
	outcome: RestaurantProviderRefundOutcome,
): Promise<RestaurantOrderRefundStatus> {
	let lastError: unknown
	for (let attempt = 0; attempt < REPORT_ATTEMPTS; attempt += 1) {
		try {
			const answer = await reportRestaurantOrderRefundStatus({
				dataRegion: org.dataRegion,
				orgId: org.id,
				orderId: refund.orderId,
				refundId: refund.refundId,
				processor: refund.processor,
				status: outcome.status,
				...(outcome.providerRefundId
					? { providerRefundId: outcome.providerRefundId }
					: {}),
				...(outcome.status === 'failed' && outcome.failureCode
					? { failureCode: outcome.failureCode }
					: {}),
				amountCents: refund.amountCents,
				currency: refund.currency,
			})
			// The region's stored status wins (a webhook may have settled it first).
			return answer.status
		} catch (error) {
			lastError = error
			if (!(error instanceof RegionalOrderApiError) || !error.retryable) {
				throw error
			}
			await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)))
		}
	}
	throw lastError
}

/* ------------------------------------------------------------------ */
/* Execute                                                             */
/* ------------------------------------------------------------------ */

export type RestaurantRefundExecution =
	| {
			outcome: 'executed'
			refundId: string
			orderId: string
			amountCents: number
			currency: string
			status: RestaurantOrderRefundStatus
			providerRefundId: string | null
			failureCode: string | null
	  }
	/** The refund is not pending any more (another run or a webhook finished it). */
	| { outcome: 'not_pending'; refundId: string }

/**
 * Execute one booked refund whose row is already in hand: provider (adopting
 * an earlier provider refund of the row), then report. A row that already has
 * a provider refund is only read back. Transient failures throw a retryable
 * `RestaurantOrderRefundError` and leave the row pending.
 */
export async function executeBookedRestaurantRefund(
	org: RestaurantRefundOrg,
	refund: OrderProviderRefund,
): Promise<Extract<RestaurantRefundExecution, { outcome: 'executed' }>> {
	let outcome: RestaurantProviderRefundOutcome
	try {
		outcome = refund.providerRefundId
			? await readRestaurantOrderProviderRefund(org, {
					...refund,
					providerRefundId: refund.providerRefundId,
				})
			: await issueRestaurantOrderProviderRefund(org, refund)
	} catch (error) {
		// Transient or not understood: never reported as terminal. The row
		// stays pending; a retry (same key) or the reconcile job finishes it.
		logRestaurantRefundFailure('provider refund', error)
		throw new RestaurantOrderRefundError('provider_unavailable', 503, true)
	}
	// Nothing new to say: a still-pending refund that already has its id.
	const changed =
		outcome.status !== 'pending' ||
		(outcome.providerRefundId !== null &&
			outcome.providerRefundId !== refund.providerRefundId)
	let status = outcome.status
	if (changed) {
		try {
			status = await reportRestaurantRefundOutcome(org, refund, outcome)
		} catch (error) {
			logRestaurantRefundFailure('refund status report', error)
			if (error instanceof RegionalOrderApiError && !error.retryable) {
				// The region refused the report (a final status already, or a
				// mismatch): nothing a retry changes.
				throw new RestaurantOrderRefundError(error.code, error.httpStatus)
			}
			throw new RestaurantOrderRefundError('regional_unavailable', 503, true)
		}
	}
	return {
		outcome: 'executed',
		refundId: refund.refundId,
		orderId: refund.orderId,
		amountCents: refund.amountCents,
		currency: refund.currency,
		status,
		providerRefundId: outcome.providerRefundId,
		failureCode: status === 'failed' ? outcome.failureCode : null,
	}
}

/**
 * Execute one booked refund by id: read it back from the region, refund at
 * the provider, report. Safe to call twice and at once.
 */
export async function executeRestaurantOrderRefund(input: {
	orgId: string
	refundId: string
}): Promise<RestaurantRefundExecution> {
	const org = await loadRestaurantRefundOrg(input.orgId)
	if (!org || !org.hasProvisionedDb) {
		throw new RestaurantOrderRefundError('org_not_found', 404)
	}
	let pending: OrderProviderRefund[]
	try {
		pending = await fetchPendingRestaurantOrderRefunds({
			dataRegion: org.dataRegion,
			orgId: org.id,
			refundId: input.refundId,
			limit: 1,
		})
	} catch (error) {
		logRestaurantRefundFailure('pending refund read', error)
		if (error instanceof RegionalOrderApiError && !error.retryable) {
			throw new RestaurantOrderRefundError(error.code, error.httpStatus)
		}
		throw new RestaurantOrderRefundError('regional_unavailable', 503, true)
	}
	const refund = pending.find((row) => row.refundId === input.refundId)
	if (!refund || refund.status !== 'pending') {
		return { outcome: 'not_pending', refundId: input.refundId }
	}
	return executeBookedRestaurantRefund(org, refund)
}
