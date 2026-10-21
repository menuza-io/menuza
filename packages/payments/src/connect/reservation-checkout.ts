/**
 * Checkout.com helpers for reservation payments (Hosted Payments Page with
 * `amount_allocations` to the organization's sub-entity).
 *
 * Opaque ids, amounts and currency only. The merchant reference is
 * deterministic from ids (`reservationCheckoutReference`) and doubles as the
 * regionally bound session id; webhooks and searches echo it.
 */

import {
	parseReservationMetadata,
	parseReservationRefundReference,
	reservationCheckoutReference,
	type ReservationDisputeEvent,
	type ReservationPaymentEvent,
	type ReservationRefundEvent,
} from '../shop/reservation'
import { type CheckoutShopClient } from './checkout-shop'

/**
 * A guarantee on Checkout.com is a customer-initiated `Unscheduled` payment
 * that stores the card, and a payment needs a positive amount. The hosted page
 * charges this verification amount (minor units: 1.00 of the currency) and the
 * App refunds it right after the card is stored.
 */
export const RESERVATION_CHECKOUT_VERIFICATION_MINOR = 100

export type ReservationCheckoutAllocation = {
	id: string
	amount: number
	commission: { amount: number }
}

function allocation(
	subEntityId: string,
	amount: number,
	commission: number,
): ReservationCheckoutAllocation[] {
	return [
		{
			id: subEntityId,
			amount,
			commission: { amount: Math.max(0, Math.min(commission, amount)) },
		},
	]
}

/** Create the hosted page. `guarantee` stores the card (`Unscheduled`). */
export async function createReservationHostedPayment(
	client: CheckoutShopClient,
	input: {
		subEntityId: string
		productName: string
		/** Amount charged now; for a guarantee the verification amount. */
		amountMinor: number
		currency: string
		processingChannelId: string
		reference: string
		guarantee: boolean
		platformFeeMinor: number
		successUrl: string
		failureUrl: string
		cancelUrl: string
		billingCountry: string
		metadata: Record<string, string>
	},
): Promise<{ id: string; url: string; reference: string }> {
	const body = {
		amount: input.amountMinor,
		currency: input.currency.toUpperCase(),
		reference: input.reference,
		description: input.productName.slice(0, 100),
		processing_channel_id: input.processingChannelId,
		...(input.guarantee ? { payment_type: 'Unscheduled' } : {}),
		billing: { address: { country: input.billingCountry } },
		success_url: input.successUrl,
		failure_url: input.failureUrl,
		cancel_url: input.cancelUrl,
		metadata: input.metadata,
		amount_allocations: allocation(
			input.subEntityId,
			input.amountMinor,
			input.guarantee ? 0 : input.platformFeeMinor,
		),
	}
	const session = (await client.hostedPayments.create(body as never)) as {
		id?: string
		_links?: { redirect?: { href?: string } }
	}
	const url = session._links?.redirect?.href
	if (!session.id || !url) {
		throw new Error('Checkout.com did not return a hosted checkout')
	}
	return { id: session.id, url, reference: input.reference }
}

/* ------------------------------------------------------------------ */
/* Payment lookup                                                      */
/* ------------------------------------------------------------------ */

/** A Checkout.com payment, reduced to what reservations need. */
export type ReservationCheckoutPayment = {
	id: string
	reference: string | null
	amountMinor: number
	currency: string
	approved: boolean
	declined: boolean
	status: string
	responseCode: string | null
	sourceId: string | null
	customerId: string | null
	card: ReservationPaymentEvent['card']
	merchantInitiated: boolean
	previousPaymentId: string | null
	metadata: Record<string, string>
}

type RawPayment = {
	id?: string
	amount?: number
	currency?: string
	approved?: boolean
	status?: string
	response_code?: string
	reference?: string
	merchant_initiated?: boolean
	previous_payment_id?: string
	metadata?: Record<string, string | number | boolean>
	source?: {
		id?: string
		last4?: string
		scheme?: string
		expiry_month?: number
		expiry_year?: number
	}
	customer?: { id?: string }
}

export function toReservationCheckoutPayment(
	raw: RawPayment,
	fallbackId = '',
): ReservationCheckoutPayment {
	const metadata: Record<string, string> = {}
	for (const [key, value] of Object.entries(raw.metadata ?? {})) {
		metadata[key] = String(value).slice(0, 500)
	}
	const source = raw.source
	const last4 = source?.last4 ?? ''
	return {
		id: raw.id ?? fallbackId,
		reference: raw.reference ?? null,
		amountMinor: raw.amount ?? 0,
		currency: (raw.currency ?? '').toUpperCase(),
		approved:
			raw.approved === true ||
			raw.status === 'Authorized' ||
			raw.status === 'Captured',
		declined: raw.status === 'Declined',
		status: raw.status ?? 'unknown',
		responseCode: raw.response_code ?? null,
		sourceId: source?.id ?? null,
		customerId: raw.customer?.id ?? null,
		card: /^\d{4}$/.test(last4)
			? {
					brand: (source?.scheme ?? 'card').toLowerCase(),
					last4,
					expMonth: source?.expiry_month ?? null,
					expYear: source?.expiry_year ?? null,
				}
			: null,
		merchantInitiated: raw.merchant_initiated === true,
		previousPaymentId: raw.previous_payment_id ?? null,
		metadata,
	}
}

export async function retrieveReservationCheckoutPayment(
	client: CheckoutShopClient,
	paymentId: string,
): Promise<ReservationCheckoutPayment> {
	const raw = (await client.payments.get(paymentId)) as RawPayment
	return toReservationCheckoutPayment(raw, paymentId)
}

/** Payments for one merchant reference (newest first). */
export async function findReservationCheckoutPaymentsByReference(
	client: CheckoutShopClient,
	reference: string,
): Promise<ReservationCheckoutPayment[]> {
	const escaped = reference.replaceAll("'", '')
	const result = (await client.payments.search({
		query: `reference:'${escaped}'`,
		limit: 20,
	} as never)) as { data?: RawPayment[] }
	return (result.data ?? []).map((payment) =>
		toReservationCheckoutPayment(payment),
	)
}

export type ReservationCheckoutAction = {
	id: string
	type: string
	approved: boolean | null
	amountMinor: number
	reference: string | null
}

export async function listReservationCheckoutActions(
	client: CheckoutShopClient,
	paymentId: string,
): Promise<ReservationCheckoutAction[]> {
	const actions = (await client.payments.getActions(paymentId)) as Array<{
		id?: string
		type?: string
		approved?: boolean | null
		amount?: number
		reference?: string | null
	}>
	return (Array.isArray(actions) ? actions : []).map((action) => ({
		id: action.id ?? '',
		type: action.type ?? '',
		approved: action.approved ?? null,
		amountMinor: action.amount ?? 0,
		reference: action.reference ?? null,
	}))
}

/* ------------------------------------------------------------------ */
/* Error classification                                                */
/* ------------------------------------------------------------------ */

/**
 * A request the provider rejected for good (validation, not allowed, not
 * found). Everything else, including timeouts, 5xx, rate limits, auth and
 * idempotency conflicts, is rethrown so it is retried and never reported as a
 * terminal failure.
 */
export function isCheckoutDefinitiveRejection(error: unknown): boolean {
	const code = (error as { http_code?: unknown } | null)?.http_code
	return code === 400 || code === 403 || code === 404 || code === 422
}

/** Stable, PII-free error code for logs and responses. */
export function checkoutErrorCode(error: unknown): string {
	const body = (error as { body?: { error_codes?: unknown } } | null)?.body
	const codes = body?.error_codes
	if (Array.isArray(codes) && typeof codes[0] === 'string') return codes[0]
	return error instanceof Error ? error.name : 'unknown_error'
}

/* ------------------------------------------------------------------ */
/* Merchant-initiated fee charge                                       */
/* ------------------------------------------------------------------ */

export type ReservationCheckoutFeeOutcome =
	| { status: 'succeeded'; paymentRef: string }
	| { status: 'requires_action'; paymentRef: string | null }
	| { status: 'failed'; paymentRef: string | null; declineCode: string | null }

/** Reference of a merchant-initiated fee charge (never a hosted-page reference). */
export function reservationFeeChargeReference(input: {
	feeId: string
	attempt: number
}): string {
	return `rsv_mit_${input.feeId}_${input.attempt}`.slice(0, 50)
}

const AUTHENTICATION_RESPONSE_CODES = new Set(['20154', '20155', '20156'])

function needsAuthentication(response: {
	status?: string
	response_code?: string
	response_summary?: string
	_links?: { redirect?: unknown }
}) {
	if (response.status === 'Pending' && response._links?.redirect) return true
	if (
		response.response_code &&
		AUTHENTICATION_RESPONSE_CODES.has(response.response_code)
	) {
		return true
	}
	return /authenticat|3d.?s(ecure)?|sca/i.test(response.response_summary ?? '')
}

/**
 * MIT charge against a stored `src_` card. Declines return 201 with
 * `approved: false`; a definitive rejection (invalid source, not allowed) is
 * reported as `failed`; everything else is rethrown.
 */
export async function chargeReservationFeeMit(
	client: CheckoutShopClient,
	input: {
		subEntityId: string
		sourceId: string
		previousPaymentId: string
		amountMinor: number
		currency: string
		processingChannelId: string
		reference: string
		platformFeeMinor: number
		idempotencyKey: string
		metadata: Record<string, string>
	},
): Promise<ReservationCheckoutFeeOutcome> {
	let response: {
		id?: string
		approved?: boolean
		status?: string
		response_code?: string
		response_summary?: string
		_links?: { redirect?: unknown }
	}
	try {
		response = (await client.payments.request(
			{
				source: { type: 'id', id: input.sourceId },
				merchant_initiated: true,
				payment_type: 'Unscheduled',
				previous_payment_id: input.previousPaymentId,
				amount: input.amountMinor,
				currency: input.currency.toUpperCase(),
				processing_channel_id: input.processingChannelId,
				reference: input.reference,
				metadata: input.metadata,
				amount_allocations: allocation(
					input.subEntityId,
					input.amountMinor,
					input.platformFeeMinor,
				),
			} as never,
			input.idempotencyKey,
		)) as typeof response
	} catch (error) {
		if (isCheckoutDefinitiveRejection(error)) {
			return {
				status: 'failed',
				paymentRef: null,
				declineCode: checkoutErrorCode(error),
			}
		}
		throw error
	}
	const paymentRef = response.id ?? null
	if (response.approved === true) {
		if (!paymentRef) throw new Error('Checkout.com returned no payment id')
		return { status: 'succeeded', paymentRef }
	}
	if (needsAuthentication(response)) {
		return { status: 'requires_action', paymentRef }
	}
	return {
		status: 'failed',
		paymentRef,
		declineCode: response.response_code ?? 'declined',
	}
}

/* ------------------------------------------------------------------ */
/* Refunds                                                             */
/* ------------------------------------------------------------------ */

export type ReservationCheckoutRefundOutcome = {
	status: 'succeeded' | 'pending' | 'failed'
	refundRef: string | null
	amountMinor: number
}

/**
 * Refund with reversal allocations. `feeReversalMinor` is the commission to
 * reverse with this refund, decided regionally (cumulative rounding), so the
 * reversals sum to the platform fee snapshot. The result is `pending`: the
 * action id settles through `payment_refunded` / `payment_refund_declined` or
 * the reconcile job.
 */
export async function createReservationCheckoutRefund(
	client: CheckoutShopClient,
	input: {
		paymentId: string
		subEntityId: string
		amountMinor: number
		feeReversalMinor: number
		reference: string
		idempotencyKey: string
	},
): Promise<ReservationCheckoutRefundOutcome> {
	try {
		const response = (await client.payments.refund(
			input.paymentId,
			{
				amount: input.amountMinor,
				reference: input.reference,
				amount_allocations: allocation(
					input.subEntityId,
					input.amountMinor,
					input.feeReversalMinor,
				),
			} as never,
			input.idempotencyKey,
		)) as { action_id?: string }
		if (!response.action_id) {
			throw new Error('Checkout.com returned no refund action id')
		}
		return {
			status: 'pending',
			refundRef: response.action_id,
			amountMinor: input.amountMinor,
		}
	} catch (error) {
		if (isCheckoutDefinitiveRejection(error)) {
			return {
				status: 'failed',
				refundRef: null,
				amountMinor: input.amountMinor,
			}
		}
		throw error
	}
}

export function checkoutRefundActionStatus(
	action: Pick<ReservationCheckoutAction, 'approved'>,
): 'succeeded' | 'pending' | 'failed' {
	if (action.approved === true) return 'succeeded'
	if (action.approved === false) return 'failed'
	return 'pending'
}

/* ------------------------------------------------------------------ */
/* Mappers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Map a Checkout.com payment (webhook or trusted lookup) of a hosted
 * reservation page. Null when it is not a reservation payment, when it is a
 * merchant-initiated fee charge (those complete synchronously), or when its
 * reference is not the one these ids would have produced.
 */
export function mapCheckoutPaymentToReservationPayment(
	payment: ReservationCheckoutPayment,
): ReservationPaymentEvent | null {
	const meta = parseReservationMetadata(payment.metadata)
	if (!meta || meta.kind === 'refund' || !meta.purpose) return null
	if (payment.merchantInitiated) return null
	const reference = reservationCheckoutReference({
		orgId: meta.orgId,
		reservationId: meta.reservationId,
		feeId: meta.feeId,
		purpose: meta.purpose,
	})
	if (payment.reference !== reference) return null

	const guarantee = meta.purpose === 'guarantee'
	const status: ReservationPaymentEvent['status'] = payment.approved
		? guarantee
			? 'setup_succeeded'
			: 'paid'
		: payment.declined
			? 'failed'
			: 'pending'
	return {
		orgId: meta.orgId,
		reservationId: meta.reservationId,
		feeId: meta.feeId,
		purpose: meta.purpose,
		sessionId: reference,
		processor: 'checkout',
		status,
		amountMinor: guarantee ? 0 : payment.amountMinor,
		currency: payment.currency,
		paymentRef: payment.id,
		paymentMethodRef: guarantee ? payment.sourceId : null,
		providerCustomerRef: guarantee ? payment.customerId : null,
		previousPaymentRef: guarantee ? payment.id : null,
		card: guarantee ? payment.card : null,
	}
}

const PAYMENT_EVENT_TYPES = new Set([
	'payment_approved',
	'payment_captured',
	'payment_declined',
	'payment_pending',
])

/** Verified webhook event -> reservation payment event (payment events only). */
export function mapCheckoutWebhookToReservationPayment(event: {
	type: string
	data: unknown
}): ReservationPaymentEvent | null {
	if (!PAYMENT_EVENT_TYPES.has(event.type)) return null
	const raw = event.data as RawPayment | null
	if (!raw?.id) return null
	const payment = toReservationCheckoutPayment(raw)
	const approved =
		event.type === 'payment_approved' ||
		event.type === 'payment_captured' ||
		raw.approved === true
	return mapCheckoutPaymentToReservationPayment({
		...payment,
		approved,
		declined: event.type === 'payment_declined',
	})
}

export type CheckoutRefundWebhook = {
	declined: boolean
	paymentId: string
	actionId: string
	amountMinor: number
	currency: string
	/** The refund reference when the event carries one. */
	reference: string | null
	orgId: string | null
	reservationId: string | null
}

/** Extract the facts of a `payment_refunded` / `payment_refund_declined` event. */
export function extractCheckoutRefundWebhook(event: {
	type: string
	data: unknown
}): CheckoutRefundWebhook | null {
	if (
		event.type !== 'payment_refunded' &&
		event.type !== 'payment_refund_declined'
	) {
		return null
	}
	const raw = event.data as (RawPayment & { action_id?: string }) | null
	if (!raw?.id || !raw.action_id) return null
	const meta = parseReservationMetadata(
		toReservationCheckoutPayment(raw).metadata,
	)
	return {
		declined: event.type === 'payment_refund_declined',
		paymentId: raw.id,
		actionId: raw.action_id,
		amountMinor: raw.amount ?? 0,
		currency: (raw.currency ?? '').toUpperCase(),
		reference: raw.reference ?? null,
		orgId: meta?.orgId ?? null,
		reservationId: meta?.reservationId ?? null,
	}
}

/**
 * Build the refund event from the extracted webhook and the refund action's
 * reference (`rsv_refund_<refundRequestId>`), which the caller reads from the
 * event or, failing that, from the payment's action list.
 */
export function buildCheckoutRefundEvent(
	webhook: CheckoutRefundWebhook,
	actionReference: string | null,
): ReservationRefundEvent | null {
	if (!webhook.orgId || !webhook.reservationId) return null
	const parsed = parseReservationRefundReference(
		actionReference ?? webhook.reference,
	)
	if (!parsed) return null
	return {
		orgId: webhook.orgId,
		reservationId: webhook.reservationId,
		refundRequestId: parsed.refundRequestId,
		late: parsed.late,
		processor: 'checkout',
		paymentRef: webhook.paymentId,
		refundRef: webhook.actionId,
		amountMinor: webhook.amountMinor,
		currency: webhook.currency,
		status: webhook.declined ? 'failed' : 'succeeded',
	}
}

const DISPUTE_STATUS: Record<string, ReservationDisputeEvent['status']> = {
	dispute_received: 'opened',
	dispute_evidence_required: 'opened',
	dispute_won: 'won',
	dispute_lost: 'lost',
	dispute_accepted: 'lost',
	dispute_expired: 'lost',
	dispute_canceled: 'closed',
	dispute_resolved: 'closed',
}

export type CheckoutDisputeWebhook = {
	disputeRef: string
	paymentId: string
	status: ReservationDisputeEvent['status']
}

export function extractCheckoutDisputeWebhook(event: {
	type: string
	data: unknown
}): CheckoutDisputeWebhook | null {
	const status = DISPUTE_STATUS[event.type]
	if (!status) return null
	const raw = event.data as { id?: string; payment_id?: string } | null
	if (!raw?.id || !raw.payment_id) return null
	return { disputeRef: raw.id, paymentId: raw.payment_id, status }
}

/** Disputes carry no metadata: the caller retrieves the payment first. */
export function mapCheckoutDisputeToReservation(
	webhook: CheckoutDisputeWebhook,
	payment: ReservationCheckoutPayment,
): ReservationDisputeEvent | null {
	const meta = parseReservationMetadata(payment.metadata)
	if (!meta || meta.kind === 'refund') return null
	return {
		orgId: meta.orgId,
		reservationId: meta.reservationId,
		processor: 'checkout',
		paymentRef: payment.id,
		disputeRef: webhook.disputeRef,
		status: webhook.status,
	}
}
