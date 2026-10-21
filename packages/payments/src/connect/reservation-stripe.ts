/**
 * Stripe Connect helpers for reservation payments (destination charges on the
 * platform account, no `on_behalf_of`).
 *
 * Every call carries opaque ids only. No guest name, email or phone is ever sent
 * (the Customer for a card guarantee has `metadata { orgId, guestRef }` and
 * nothing else), and amounts, currency and the platform fee come from callers
 * as integer minor units. Provider calls here are never made inside a regional
 * lock or transaction; that is the caller's responsibility.
 */

import Stripe from 'stripe'
import {
	buildReservationCustomerIdempotencyKey,
	parseReservationMetadata,
	type ReservationDisputeEvent,
	type ReservationPaymentEvent,
	type ReservationRefundEvent,
} from '../shop/reservation'

export type ReservationStripeSessionInput = {
	connectedAccountId: string
	productName: string
	amountMinor: number
	/** Lower- or upper-case ISO currency. */
	currency: string
	/** Per-cover line item: quantity * unitAmountMinor must equal amountMinor. */
	quantity?: number | null
	unitAmountMinor?: number | null
	platformFeeMinor: number
	successUrl: string
	cancelUrl: string
	/** Unix seconds (see `reservationStripeExpiresAt`). */
	expiresAt: number
	statementDescriptorSuffix?: string | null
	idempotencyKey: string
	metadata: Record<string, string>
}

const CARD_ONLY = [
	'card',
] as Stripe.Checkout.SessionCreateParams.PaymentMethodType[]

/**
 * Create a hosted payment-mode Checkout Session as a destination charge. The
 * metadata rides on both the session and the PaymentIntent.
 */
export async function createReservationPaymentSession(
	stripe: Stripe,
	input: ReservationStripeSessionInput,
): Promise<Stripe.Checkout.Session> {
	const perCover =
		input.unitAmountMinor != null &&
		input.quantity != null &&
		input.quantity > 1 &&
		input.unitAmountMinor * input.quantity === input.amountMinor
	return stripe.checkout.sessions.create(
		{
			mode: 'payment',
			payment_method_types: CARD_ONLY,
			line_items: [
				{
					quantity: perCover ? input.quantity! : 1,
					price_data: {
						currency: input.currency.toLowerCase(),
						unit_amount: perCover ? input.unitAmountMinor! : input.amountMinor,
						product_data: { name: input.productName },
					},
				},
			],
			payment_intent_data: {
				...(input.platformFeeMinor > 0
					? { application_fee_amount: input.platformFeeMinor }
					: {}),
				transfer_data: { destination: input.connectedAccountId },
				...(input.statementDescriptorSuffix
					? { statement_descriptor_suffix: input.statementDescriptorSuffix }
					: {}),
				metadata: input.metadata,
			},
			metadata: input.metadata,
			success_url: input.successUrl,
			cancel_url: input.cancelUrl,
			expires_at: input.expiresAt,
		},
		{ idempotencyKey: input.idempotencyKey },
	)
}

/** PII-free Customer scoped to (orgId, guestRef). */
export async function createReservationStripeCustomer(
	stripe: Stripe,
	input: { orgId: string; guestRef: string },
): Promise<string> {
	const customer = await stripe.customers.create(
		{ metadata: { orgId: input.orgId, guestRef: input.guestRef } },
		{ idempotencyKey: buildReservationCustomerIdempotencyKey(input) },
	)
	return customer.id
}

/** Setup-mode session that saves a card for a guarantee (nothing is charged). */
export async function createReservationSetupSession(
	stripe: Stripe,
	input: {
		customerId: string
		currency: string
		successUrl: string
		cancelUrl: string
		expiresAt: number
		consentText: string
		idempotencyKey: string
		metadata: Record<string, string>
	},
): Promise<Stripe.Checkout.Session> {
	return stripe.checkout.sessions.create(
		{
			mode: 'setup',
			currency: input.currency.toLowerCase(),
			payment_method_types: CARD_ONLY,
			customer: input.customerId,
			setup_intent_data: { metadata: input.metadata },
			metadata: input.metadata,
			custom_text: { submit: { message: input.consentText.slice(0, 1200) } },
			success_url: input.successUrl,
			cancel_url: input.cancelUrl,
			expires_at: input.expiresAt,
		},
		{ idempotencyKey: input.idempotencyKey },
	)
}

/**
 * Retrieve a session. For setup mode the SetupIntent is expanded and its saved
 * PaymentMethod is attached so card display facts can be mapped. Customer and billing details
 * are never expanded.
 */
export async function retrieveReservationStripeSession(
	stripe: Stripe,
	sessionId: string,
	options: { setup?: boolean } = {},
): Promise<Stripe.Checkout.Session> {
	if (!options.setup) return stripe.checkout.sessions.retrieve(sessionId)
	const session = await stripe.checkout.sessions.retrieve(sessionId, {
		expand: ['setup_intent'],
	})
	const setupIntent = session.setup_intent
	if (
		setupIntent &&
		typeof setupIntent === 'object' &&
		setupIntent.status === 'succeeded' &&
		typeof setupIntent.payment_method === 'string'
	) {
		// A separate lookup keeps the expansion shallow (and works against the
		// local emulator); only the saved card's display facts are read from it.
		setupIntent.payment_method = await stripe.paymentMethods.retrieve(
			setupIntent.payment_method,
		)
	}
	return session
}

/* ------------------------------------------------------------------ */
/* Error classification                                                */
/* ------------------------------------------------------------------ */

/** Network, rate-limit and 5xx failures: retry later, never report terminal. */
export function isStripeTransientError(error: unknown): boolean {
	if (
		error instanceof Stripe.errors.StripeConnectionError ||
		error instanceof Stripe.errors.StripeRateLimitError ||
		error instanceof Stripe.errors.StripeAPIError
	) {
		return true
	}
	const statusCode = (error as { statusCode?: number } | null)?.statusCode
	if (typeof statusCode === 'number') return statusCode >= 500
	return !(error instanceof Stripe.errors.StripeError)
}

/** Stable, PII-free error code for logs and responses. */
export function stripeErrorCode(error: unknown): string {
	const code = (error as { code?: unknown } | null)?.code
	if (typeof code === 'string' && code) return code
	return error instanceof Error ? error.name : 'unknown_error'
}

/* ------------------------------------------------------------------ */
/* Off-session fee charge                                              */
/* ------------------------------------------------------------------ */

export type ReservationFeeChargeOutcome =
	| { status: 'succeeded'; paymentRef: string }
	| {
			status: 'requires_action'
			paymentRef: string | null
			/** The dangling PaymentIntent the caller should cancel. */
			danglingPaymentIntentId: string | null
	  }
	| { status: 'failed'; paymentRef: string | null; declineCode: string | null }

/**
 * Charge a saved card off-session (`off_session: true, confirm: true`) as a
 * destination charge. Card errors map to outcomes; transient failures and other
 * non-card errors are rethrown so the caller never reports them as terminal.
 */
export async function chargeReservationFeeOffSession(
	stripe: Stripe,
	input: {
		connectedAccountId: string
		customerId: string
		paymentMethodId: string
		amountMinor: number
		currency: string
		platformFeeMinor: number
		statementDescriptorSuffix?: string | null
		idempotencyKey: string
		metadata: Record<string, string>
	},
): Promise<ReservationFeeChargeOutcome> {
	try {
		const intent = await stripe.paymentIntents.create(
			{
				amount: input.amountMinor,
				currency: input.currency.toLowerCase(),
				customer: input.customerId,
				payment_method: input.paymentMethodId,
				off_session: true,
				confirm: true,
				payment_method_types: ['card'],
				...(input.platformFeeMinor > 0
					? { application_fee_amount: input.platformFeeMinor }
					: {}),
				transfer_data: { destination: input.connectedAccountId },
				...(input.statementDescriptorSuffix
					? { statement_descriptor_suffix: input.statementDescriptorSuffix }
					: {}),
				metadata: input.metadata,
			},
			{ idempotencyKey: input.idempotencyKey },
		)
		if (intent.status === 'succeeded') {
			return { status: 'succeeded', paymentRef: intent.id }
		}
		if (intent.status === 'requires_action') {
			return {
				status: 'requires_action',
				paymentRef: intent.id,
				danglingPaymentIntentId: intent.id,
			}
		}
		// processing / requires_capture: the outcome is not known yet.
		const pending = new Error('payment_processing')
		pending.name = 'ReservationPaymentProcessingError'
		throw pending
	} catch (error) {
		if (error instanceof Stripe.errors.StripeCardError) {
			const raw = (error.raw ?? {}) as {
				payment_intent?: { id?: string } | null
			}
			const intentId = raw.payment_intent?.id ?? null
			if (error.code === 'authentication_required') {
				return {
					status: 'requires_action',
					paymentRef: intentId,
					danglingPaymentIntentId: intentId,
				}
			}
			return {
				status: 'failed',
				paymentRef: intentId,
				declineCode: error.decline_code ?? error.code ?? 'card_declined',
			}
		}
		throw error
	}
}

/** Cancel a PaymentIntent (the dangling one of an `authentication_required`). */
export async function cancelReservationPaymentIntent(
	stripe: Stripe,
	paymentIntentId: string,
): Promise<void> {
	await stripe.paymentIntents.cancel(paymentIntentId)
}

/* ------------------------------------------------------------------ */
/* Refunds                                                             */
/* ------------------------------------------------------------------ */

export type ReservationRefundOutcome = {
	status: 'succeeded' | 'pending' | 'failed'
	refundRef: string | null
	amountMinor: number
}

function mapStripeRefundStatus(
	status: string | null | undefined,
): 'succeeded' | 'pending' | 'failed' {
	if (status === 'succeeded') return 'succeeded'
	if (status === 'failed' || status === 'canceled') return 'failed'
	return 'pending'
}

/**
 * Refund a destination charge, reversing the transfer and the platform fee
 * proportionally (Stripe computes the split). A definitive provider rejection
 * (invalid request, card error) is reported as `failed`; transient failures are
 * rethrown for the caller to retry.
 */
export async function createReservationStripeRefund(
	stripe: Stripe,
	input: {
		paymentIntentId: string
		amountMinor: number
		idempotencyKey: string
		metadata: Record<string, string>
	},
): Promise<ReservationRefundOutcome> {
	try {
		const refund = await stripe.refunds.create(
			{
				payment_intent: input.paymentIntentId,
				amount: input.amountMinor,
				reason: 'requested_by_customer',
				reverse_transfer: true,
				refund_application_fee: true,
				metadata: input.metadata,
			},
			{ idempotencyKey: input.idempotencyKey },
		)
		return {
			status: mapStripeRefundStatus(refund.status),
			refundRef: refund.id,
			amountMinor: refund.amount,
		}
	} catch (error) {
		if (isStripeTransientError(error)) throw error
		if (error instanceof Stripe.errors.StripeIdempotencyError) throw error
		return { status: 'failed', refundRef: null, amountMinor: input.amountMinor }
	}
}

export async function retrieveReservationStripeRefund(
	stripe: Stripe,
	refundId: string,
): Promise<Stripe.Refund> {
	return stripe.refunds.retrieve(refundId)
}

/* ------------------------------------------------------------------ */
/* Mappers: provider object -> ids-and-amounts DTO                     */
/* ------------------------------------------------------------------ */

function objectId(value: string | { id: string } | null | undefined) {
	if (!value) return null
	return typeof value === 'string' ? value : value.id
}

function cardFacts(
	method: Stripe.PaymentMethod | string | null | undefined,
): ReservationPaymentEvent['card'] {
	if (!method || typeof method === 'string' || !method.card) return null
	const last4 = method.card.last4
	if (!/^\d{4}$/.test(last4 ?? '')) return null
	return {
		brand: method.card.brand || 'card',
		last4,
		expMonth: method.card.exp_month ?? null,
		expYear: method.card.exp_year ?? null,
	}
}

/**
 * Map a Checkout Session (verified webhook object or trusted retrieval) to a
 * reservation payment event. Returns null for sessions that are not
 * reservation payments or lack the opaque references. Setup-mode sessions need
 * the retrieval expanded with `setup_intent.payment_method`.
 */
export function mapStripeSessionToReservationPayment(
	session: Stripe.Checkout.Session,
	options: { failed?: boolean } = {},
): ReservationPaymentEvent | null {
	const meta = parseReservationMetadata(session.metadata ?? undefined)
	if (!meta || meta.kind === 'refund' || !meta.purpose) return null
	const currency = (session.currency ?? '').toUpperCase()
	if (!/^[A-Z]{3}$/.test(currency)) return null

	const base = {
		orgId: meta.orgId,
		reservationId: meta.reservationId,
		feeId: meta.feeId,
		purpose: meta.purpose,
		sessionId: session.id,
		processor: 'stripe' as const,
		currency,
		paymentRef: null as string | null,
		paymentMethodRef: null as string | null,
		providerCustomerRef: null as string | null,
		previousPaymentRef: null as string | null,
		card: null as ReservationPaymentEvent['card'],
	}

	if (session.mode === 'setup') {
		const setupIntent =
			typeof session.setup_intent === 'object' ? session.setup_intent : null
		const succeeded =
			session.status === 'complete' && setupIntent?.status === 'succeeded'
		const method = setupIntent?.payment_method
		return {
			...base,
			status: succeeded
				? 'setup_succeeded'
				: options.failed
					? 'failed'
					: session.status === 'expired'
						? 'expired'
						: 'pending',
			amountMinor: 0,
			providerCustomerRef: objectId(session.customer as string | null),
			paymentMethodRef: succeeded ? objectId(method) : null,
			card: succeeded ? cardFacts(method) : null,
		}
	}

	if (session.amount_total == null) return null
	return {
		...base,
		status:
			session.payment_status === 'paid' ||
			session.payment_status === 'no_payment_required'
				? 'paid'
				: options.failed
					? 'failed'
					: session.status === 'expired'
						? 'expired'
						: 'pending',
		amountMinor: session.amount_total,
		paymentRef: objectId(session.payment_intent),
	}
}

/**
 * Map a refund (webhook object or retrieval). The opaque refund request id (or
 * the late-payment marker) is read back from the refund metadata.
 */
export function mapStripeRefundToReservation(
	refund: Stripe.Refund,
): ReservationRefundEvent | null {
	const meta = parseReservationMetadata(refund.metadata ?? undefined)
	if (!meta || meta.kind !== 'refund') return null
	return {
		orgId: meta.orgId,
		reservationId: meta.reservationId,
		refundRequestId: meta.refundRequestId,
		late: meta.late,
		processor: 'stripe',
		paymentRef: objectId(refund.payment_intent),
		refundRef: refund.id,
		amountMinor: refund.amount,
		currency: (refund.currency ?? '').toUpperCase(),
		status: mapStripeRefundStatus(refund.status),
	}
}

/**
 * Map a dispute. Stripe does not copy payment metadata onto the dispute, so the
 * caller retrieves the PaymentIntent (platform account) and passes it in.
 */
export function mapStripeDisputeToReservation(
	dispute: Stripe.Dispute,
	paymentIntent: Pick<Stripe.PaymentIntent, 'id' | 'metadata'> | null,
	closed: boolean,
): ReservationDisputeEvent | null {
	const meta = parseReservationMetadata(paymentIntent?.metadata ?? undefined)
	if (!meta || meta.kind === 'refund' || !paymentIntent) return null
	return {
		orgId: meta.orgId,
		reservationId: meta.reservationId,
		processor: 'stripe',
		paymentRef: paymentIntent.id,
		disputeRef: dispute.id,
		status: !closed
			? 'opened'
			: dispute.status === 'won'
				? 'won'
				: dispute.status === 'lost'
					? 'lost'
					: 'closed',
	}
}
