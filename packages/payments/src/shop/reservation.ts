/**
 * Reservation payment helpers (deposits, prepayments, tickets, card guarantees,
 * staff-charged fees and refunds).
 *
 * The regional tenant service decides every amount, currency and state; the App
 * only talks to providers. Nothing here ever carries guest data: provider
 * metadata, product names, customers and idempotency keys use opaque ids only,
 * and no single-use payment token is ever hashed into a key.
 *
 * Fee math lives in `@repo/reservations` (`platformFeeMinor`); callers pass the
 * resulting minor-unit numbers in. This package never recomputes it.
 */

import { createHash } from 'node:crypto'

export const RESERVATION_PAYMENT_METADATA_TYPE = 'reservation_payment' as const
export const RESERVATION_FEE_METADATA_TYPE = 'reservation_fee' as const
export const RESERVATION_REFUND_METADATA_TYPE = 'reservation_refund' as const

export const RESERVATION_SESSION_PURPOSES = [
	'deposit',
	'prepay',
	'experience',
	'guarantee',
] as const
export type ReservationSessionPurpose =
	(typeof RESERVATION_SESSION_PURPOSES)[number]
export type ReservationPaymentPurpose = ReservationSessionPurpose | 'fee'
export type ReservationFeeKind = 'no_show_fee' | 'late_cancel_fee'
export type ReservationProcessor = 'stripe' | 'checkout'

/** Provider status of a reservation session, mapped to ids and amounts only. */
export type ReservationPaymentEventStatus =
	'paid' | 'failed' | 'expired' | 'setup_succeeded' | 'pending'

/** Non-PII payment event derived from a verified event or a trusted lookup. */
export type ReservationPaymentEvent = {
	orgId: string
	reservationId: string
	feeId: string | null
	purpose: ReservationPaymentPurpose
	/** Regionally bound id: Stripe session id, or the Checkout.com reference. */
	sessionId: string
	processor: ReservationProcessor
	status: ReservationPaymentEventStatus
	amountMinor: number
	/** Upper-case ISO currency. */
	currency: string
	paymentRef: string | null
	paymentMethodRef: string | null
	providerCustomerRef: string | null
	previousPaymentRef: string | null
	card: {
		brand: string
		last4: string
		expMonth: number | null
		expYear: number | null
	} | null
}

export type ReservationRefundEvent = {
	orgId: string
	reservationId: string
	/** Absent for a late-payment refund (identified by the payment). */
	refundRequestId: string | null
	late: boolean
	processor: ReservationProcessor
	paymentRef: string | null
	refundRef: string
	amountMinor: number
	currency: string
	status: 'succeeded' | 'pending' | 'failed'
}

export type ReservationDisputeEvent = {
	orgId: string | null
	reservationId: string | null
	processor: ReservationProcessor
	paymentRef: string
	disputeRef: string
	status: 'opened' | 'won' | 'lost' | 'closed'
}

const SESSION_PRODUCT_NAMES: Record<ReservationSessionPurpose, string> = {
	deposit: 'Reservation deposit',
	prepay: 'Reservation prepayment',
	experience: 'Experience ticket',
	guarantee: 'Card guarantee',
}

const FEE_PRODUCT_NAMES: Record<ReservationFeeKind, string> = {
	no_show_fee: 'No-show fee',
	late_cancel_fee: 'Late cancellation fee',
}

/**
 * Fixed generic product names. An experience may show its catalog title (the
 * quote's `productLabel`); nothing else is ever dynamic.
 */
export function reservationProductName(input: {
	purpose: ReservationPaymentPurpose
	feeKind?: ReservationFeeKind | null
	productLabel?: string | null
}): string {
	if (input.purpose === 'fee') {
		return FEE_PRODUCT_NAMES[input.feeKind ?? 'no_show_fee']
	}
	if (input.purpose === 'experience' && input.productLabel?.trim()) {
		return input.productLabel.trim().slice(0, 100)
	}
	return SESSION_PRODUCT_NAMES[input.purpose]
}

function sha256Hex(material: string) {
	return createHash('sha256').update(material).digest('hex')
}

/* ------------------------------------------------------------------ */
/* Metadata                                                            */
/* ------------------------------------------------------------------ */

export function buildReservationPaymentMetadata(input: {
	orgId: string
	reservationId: string
	purpose: ReservationSessionPurpose
}): Record<string, string> {
	return {
		type: RESERVATION_PAYMENT_METADATA_TYPE,
		orgId: input.orgId,
		reservationId: input.reservationId,
		purpose: input.purpose,
	}
}

export function buildReservationFeeMetadata(input: {
	orgId: string
	reservationId: string
	feeId: string
}): Record<string, string> {
	return {
		type: RESERVATION_FEE_METADATA_TYPE,
		orgId: input.orgId,
		reservationId: input.reservationId,
		purpose: 'fee',
		feeId: input.feeId,
	}
}

export function buildReservationRefundMetadata(input: {
	orgId: string
	reservationId: string
	refundRequestId?: string | null
}): Record<string, string> {
	return {
		type: RESERVATION_REFUND_METADATA_TYPE,
		orgId: input.orgId,
		reservationId: input.reservationId,
		...(input.refundRequestId
			? { refundRequestId: input.refundRequestId }
			: { reason: 'late_payment' }),
	}
}

export type ParsedReservationMetadata = {
	kind: 'payment' | 'fee' | 'refund'
	orgId: string
	reservationId: string
	purpose: ReservationPaymentPurpose | null
	feeId: string | null
	refundRequestId: string | null
	late: boolean
}

const PURPOSES = new Set<string>([...RESERVATION_SESSION_PURPOSES, 'fee'])

export function isReservationMetadata(
	metadata: Record<string, string> | null | undefined,
): boolean {
	const type = metadata?.type
	return (
		type === RESERVATION_PAYMENT_METADATA_TYPE ||
		type === RESERVATION_FEE_METADATA_TYPE ||
		type === RESERVATION_REFUND_METADATA_TYPE
	)
}

/** Parse provider metadata; null when it is not a well-formed reservation tag. */
export function parseReservationMetadata(
	metadata: Record<string, string> | null | undefined,
): ParsedReservationMetadata | null {
	if (!metadata || !isReservationMetadata(metadata)) return null
	const orgId = metadata.orgId
	const reservationId = metadata.reservationId
	if (!orgId || !reservationId) return null
	if (metadata.type === RESERVATION_REFUND_METADATA_TYPE) {
		const refundRequestId = metadata.refundRequestId || null
		const late = metadata.reason === 'late_payment'
		if (!refundRequestId && !late) return null
		return {
			kind: 'refund',
			orgId,
			reservationId,
			purpose: null,
			feeId: null,
			refundRequestId,
			late,
		}
	}
	const purpose = metadata.purpose
	if (!purpose || !PURPOSES.has(purpose)) return null
	const isFee = metadata.type === RESERVATION_FEE_METADATA_TYPE
	if (isFee && (purpose !== 'fee' || !metadata.feeId)) return null
	if (!isFee && purpose === 'fee') return null
	return {
		kind: isFee ? 'fee' : 'payment',
		orgId,
		reservationId,
		purpose: purpose as ReservationPaymentPurpose,
		feeId: metadata.feeId || null,
		refundRequestId: null,
		late: false,
	}
}

/* ------------------------------------------------------------------ */
/* Idempotency keys (never a token, never guest data)                  */
/* ------------------------------------------------------------------ */

/**
 * Session create key. Every quote fact that can change is part of it: Stripe
 * raises `idempotency_error` when a key is reused with other parameters.
 */
export function buildReservationSessionIdempotencyKey(input: {
	orgId: string
	reservationId: string
	/** A fee pay link uses the fee id in place of the purpose-only identity. */
	feeId?: string | null
	purpose: ReservationPaymentPurpose
	amountMinor: number
	currency: string
	paymentExpiresAt: string
	/**
	 * The exact Stripe `expires_at` sent with the session. It can legitimately
	 * differ between attempts (clock-bound for short holds), so it is part of
	 * the identity: same key implies byte-identical session parameters.
	 */
	stripeExpiresAt?: number
}): string {
	const material = [
		input.orgId,
		input.reservationId,
		...(input.feeId ? [input.feeId] : []),
		input.purpose,
		String(input.amountMinor),
		input.currency.toUpperCase(),
		input.paymentExpiresAt,
		...(input.stripeExpiresAt === undefined
			? []
			: [String(input.stripeExpiresAt)]),
	].join('|')
	return `reservation_${input.purpose}_${sha256Hex(material).slice(0, 40)}`
}

export function buildReservationCustomerIdempotencyKey(input: {
	orgId: string
	guestRef: string
}): string {
	return `reservation_customer_${sha256Hex(`${input.orgId}|${input.guestRef}`)}`
}

export function buildReservationFeeIdempotencyKey(input: {
	orgId: string
	reservationId: string
	feeId: string
	attempt: number
}): string {
	return `reservation_fee_${sha256Hex(
		[input.orgId, input.reservationId, input.feeId, String(input.attempt)].join(
			'|',
		),
	)}`
}

export function buildReservationRefundIdempotencyKey(input: {
	orgId: string
	refundRequestId: string
}): string {
	return `reservation_refund_${sha256Hex(`${input.orgId}|${input.refundRequestId}`)}`
}

export function buildReservationLateRefundIdempotencyKey(
	paymentRef: string,
): string {
	return `reservation_late_refund_${paymentRef}`
}

/**
 * The Checkout.com merchant reference of a reservation session (at most 50
 * characters, deterministic from opaque ids). It is also the regionally bound
 * session id, exactly like `restaurantOrderCheckoutReference`: payments and
 * webhooks echo the reference, while a hosted page id is not guaranteed to come
 * back.
 */
export function reservationCheckoutReference(input: {
	orgId: string
	reservationId: string
	feeId?: string | null
	purpose: ReservationPaymentPurpose
}): string {
	const digest = sha256Hex(
		[input.orgId, input.reservationId, input.feeId ?? '', input.purpose].join(
			'|',
		),
	).slice(0, 32)
	return `rsv_${input.purpose}_${digest}`
}

/** Checkout.com limits `reference` to 50 characters. */
const CHECKOUT_REFERENCE_MAX = 50
const REFUND_REFERENCE_PREFIX = 'rsv_rf_'
/** Pre-compact prefix, decoded for references already at the provider. */
const LEGACY_REFUND_REFERENCE_PREFIX = 'rsv_refund_'

/**
 * Checkout.com reference of a refund: carries the opaque request id intact
 * (`pay_<uuid>` is 40 characters, so the short prefix fits the 50 character
 * limit). An id that cannot fit throws: truncating would point webhooks at a
 * refund row that does not exist.
 */
export function reservationRefundReference(input: {
	refundRequestId?: string | null
	paymentRef: string
}): string {
	if (input.refundRequestId) {
		const reference = `${REFUND_REFERENCE_PREFIX}${input.refundRequestId}`
		if (reference.length > CHECKOUT_REFERENCE_MAX) {
			throw new Error('Refund reference does not fit the provider limit')
		}
		return reference
	}
	return `rsv_late_${input.paymentRef}`.slice(0, CHECKOUT_REFERENCE_MAX)
}

/** Read the refund request id back from a Checkout.com refund reference. */
export function parseReservationRefundReference(
	reference: string | null | undefined,
): { refundRequestId: string | null; late: boolean } | null {
	if (!reference) return null
	for (const prefix of [
		REFUND_REFERENCE_PREFIX,
		LEGACY_REFUND_REFERENCE_PREFIX,
	]) {
		if (reference.startsWith(prefix)) {
			const id = reference.slice(prefix.length)
			return id ? { refundRequestId: id, late: false } : null
		}
	}
	if (reference.startsWith('rsv_late_')) {
		return { refundRequestId: null, late: true }
	}
	return null
}

/* ------------------------------------------------------------------ */
/* Provider presentation                                               */
/* ------------------------------------------------------------------ */

/**
 * Statement descriptor suffix from the organization name: upper-case ASCII
 * letters, digits and spaces, at most 22 characters, with at least one letter.
 * Null when nothing usable remains.
 */
export function sanitizeStatementDescriptorSuffix(
	name: string | null | undefined,
): string | null {
	const cleaned = (name ?? '')
		.normalize('NFKD')
		.replace(/[^A-Za-z0-9 ]/g, '')
		.replace(/\s+/g, ' ')
		.trim()
		.toUpperCase()
		.slice(0, 22)
		.trim()
	return /[A-Z]/.test(cleaned) ? cleaned : null
}

const STRIPE_MIN_SESSION_MS = 31 * 60_000
const STRIPE_MAX_SESSION_MS = 24 * 60 * 60_000 - 60_000
/**
 * The clock-derived bounds snap to this grid, so a retry seconds after a lost
 * response submits the same `expires_at` (Stripe rejects a reused idempotency
 * key whose parameters changed).
 */
const STRIPE_EXPIRY_GRID_MS = 5 * 60_000

/**
 * Stripe `expires_at` (unix seconds): the hold (`paymentExpiresAt`, a stable
 * regional value) when it is at least 31 minutes away, otherwise the clock
 * bound rounded UP to a 5 minute grid; capped below Stripe's 24 hour maximum
 * (rounded down). Only the clock-derived bounds vary with `nowMs`, and only per
 * grid step, so callers put the result in the idempotency key. A late payment
 * on a session that outlives the hold is handled regionally.
 */
export function reservationStripeExpiresAt(
	nowMs: number,
	paymentExpiresAt: string,
): number {
	const hold = new Date(paymentExpiresAt).getTime()
	const earliest =
		Math.ceil((nowMs + STRIPE_MIN_SESSION_MS) / STRIPE_EXPIRY_GRID_MS) *
		STRIPE_EXPIRY_GRID_MS
	const latest =
		Math.floor((nowMs + STRIPE_MAX_SESSION_MS) / STRIPE_EXPIRY_GRID_MS) *
		STRIPE_EXPIRY_GRID_MS
	const wanted = Number.isFinite(hold) ? Math.max(earliest, hold) : earliest
	return Math.floor(Math.min(wanted, latest) / 1000)
}
