import { z } from 'zod'
import { isoTimestampSchema } from './common.ts'
import { paymentProviderSchema } from './payments.ts'

/**
 * The internal App <-> regional tenant-api payment contract (architecture
 * section 12.6). Every request and response carries ids, amounts, currency and
 * opaque provider references only: no guest name, phone, email or note ever
 * crosses to the App, and the App never logs these bodies.
 *
 * Money is integer minor units; `currency` is the location currency.
 * `processor` is the regional provider name (`stripe` | `checkout`); the App
 * maps it to its own `connect` | `checkout` processors.
 */

const opaqueId = z
	.string()
	.trim()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9_:.-]+$/)
const minorUnits = z.number().int().min(0).max(100_000_000)
const currencyCode = z.string().regex(/^[A-Z]{3}$/)
const basisPoints = z.number().int().min(0).max(10_000)

/** Purposes of a provider checkout session (a fee pay link uses `fee`). */
export const RESERVATION_SESSION_PURPOSES = [
	'deposit',
	'prepay',
	'experience',
	'guarantee',
] as const
export type ReservationSessionPurpose =
	(typeof RESERVATION_SESSION_PURPOSES)[number]
export const RESERVATION_PAYMENT_PURPOSES = [
	...RESERVATION_SESSION_PURPOSES,
	'fee',
] as const
export type ReservationPaymentPurpose =
	(typeof RESERVATION_PAYMENT_PURPOSES)[number]
export const RESERVATION_FEE_KINDS = ['no_show_fee', 'late_cancel_fee'] as const
export type ReservationFeeKind = (typeof RESERVATION_FEE_KINDS)[number]

/** Provider metadata `type` values (opaque ids only). */
export const RESERVATION_METADATA_TYPES = [
	'reservation_payment',
	'reservation_fee',
	'reservation_refund',
] as const

export const reservationPaymentQuoteRequestSchema = z.union([
	z.strictObject({
		orgId: opaqueId,
		reservationId: opaqueId,
		paymentToken: z.string().trim().min(8).max(512),
		purpose: z.enum(RESERVATION_SESSION_PURPOSES),
	}),
	z.strictObject({
		orgId: opaqueId,
		feeId: opaqueId,
		paymentToken: z.string().trim().min(8).max(512),
		purpose: z.literal('fee'),
	}),
])
export type ReservationPaymentQuoteRequest = z.infer<
	typeof reservationPaymentQuoteRequestSchema
>

export const reservationPaymentQuoteSchema = z.strictObject({
	purpose: z.enum(RESERVATION_PAYMENT_PURPOSES),
	mode: z.enum(['payment', 'setup']),
	reservationId: opaqueId,
	locationId: opaqueId,
	feeId: opaqueId.nullable(),
	feeKind: z.enum(RESERVATION_FEE_KINDS).nullable(),
	/** Gross amount to charge now (0 for `setup`). */
	amountMinor: minorUnits,
	currency: currencyCode,
	/** Covers, for a per-cover line item (`quantity * unitAmountMinor == amountMinor`). */
	quantity: z.number().int().min(1).max(99),
	unitAmountMinor: minorUnits.nullable(),
	/** Payment hold deadline (ISO). */
	expiresAt: isoTimestampSchema,
	now: isoTimestampSchema,
	reservationStatus: z.string(),
	paymentStatus: z.string(),
	locale: z.string().min(2).max(10),
	boundSession: z
		.strictObject({
			sessionId: z.string().min(1),
			processor: paymentProviderSchema,
		})
		.nullable(),
	providerCustomerRef: z.string().nullable(),
	/** HMAC of the regional guest id: lets the App key a PII-free Stripe Customer. */
	guestRef: z.string().min(8).max(128),
	/** Catalog label: experience title in the guest locale, or null. */
	productLabel: z.string().max(200).nullable(),
	policy: z.strictObject({
		kind: z.string(),
		unitMinor: minorUnits,
		partySize: z.number().int().min(1).max(99),
		capMinor: minorUnits.nullable(),
		freeCancelUntilMin: z.number().int().min(0),
		termsVersion: z.number().int().min(1),
	}),
	/** Facts for the guarantee consent text (setup mode only). */
	consent: z
		.strictObject({
			capMinor: minorUnits,
			noShowFeeMinor: minorUnits,
			lateCancelFeeMinor: minorUnits,
			freeCancelUntilMin: z.number().int().min(0),
			timeZone: z.string().min(1).max(64),
			startAtIso: isoTimestampSchema,
		})
		.nullable(),
})
export type ReservationPaymentQuote = z.infer<
	typeof reservationPaymentQuoteSchema
>

export const reservationPaymentBindRequestSchema = z.strictObject({
	orgId: opaqueId,
	reservationId: opaqueId,
	feeId: opaqueId.optional(),
	purpose: z.enum(RESERVATION_PAYMENT_PURPOSES),
	sessionId: z.string().trim().min(1).max(255),
	processor: paymentProviderSchema,
	providerCustomerRef: z.string().trim().min(1).max(255).nullish(),
	platformFeeBp: basisPoints,
	platformFeeMinor: minorUnits,
})
export type ReservationPaymentBindRequest = z.infer<
	typeof reservationPaymentBindRequestSchema
>
export const RESERVATION_BIND_ERRORS = [
	'already_bound',
	'payment_terminal',
	'hold_expired',
] as const

export const RESERVATION_PAYMENT_STATUS_EVENTS = [
	'paid',
	'failed',
	'expired',
	'setup_succeeded',
] as const
export const reservationPaymentStatusRequestSchema = z.strictObject({
	orgId: opaqueId,
	reservationId: opaqueId,
	feeId: opaqueId.optional(),
	purpose: z.enum(RESERVATION_PAYMENT_PURPOSES),
	sessionId: z.string().trim().min(1).max(255),
	processor: paymentProviderSchema,
	status: z.enum(RESERVATION_PAYMENT_STATUS_EVENTS),
	amountMinor: minorUnits,
	currency: currencyCode,
	paymentRef: z.string().trim().min(1).max(255).nullish(),
	paymentMethodRef: z.string().trim().min(1).max(255).nullish(),
	providerCustomerRef: z.string().trim().min(1).max(255).nullish(),
	previousPaymentRef: z.string().trim().min(1).max(255).nullish(),
	card: z
		.strictObject({
			brand: z.string().trim().min(1).max(32),
			last4: z.string().regex(/^\d{4}$/),
			expMonth: z.number().int().min(1).max(12).nullish(),
			expYear: z.number().int().min(2000).max(2200).nullish(),
		})
		.nullish(),
})
export type ReservationPaymentStatusRequest = z.infer<
	typeof reservationPaymentStatusRequestSchema
>

export const reservationRefundDirectiveSchema = z.strictObject({
	reservationId: opaqueId,
	paymentRef: z.string().min(1),
	processor: paymentProviderSchema,
	amountMinor: minorUnits,
	currency: currencyCode,
	/** Gross amount of the payment being refunded and the fee snapshot on it. */
	paymentAmountMinor: minorUnits,
	platformFeeMinor: minorUnits,
	/** Refunded so far on this payment (before this refund) and the fee already reversed. */
	refundedBeforeMinor: minorUnits.default(0),
	feeReversedBeforeMinor: minorUnits.default(0),
	/** Fee to reverse with THIS refund (cumulative rounding, parts sum to the snapshot). */
	feeReversalMinor: minorUnits.default(0),
})
export type ReservationRefundDirective = z.infer<
	typeof reservationRefundDirectiveSchema
>

export const RESERVATION_STATUS_OUTCOMES = [
	'recorded',
	'duplicate',
	'confirmed',
	'refund_required',
	'review',
] as const
export const reservationPaymentStatusResponseSchema = z.strictObject({
	outcome: z.enum(RESERVATION_STATUS_OUTCOMES),
	reservationStatus: z.string().optional(),
	paymentStatus: z.string().optional(),
	/** Present with `refund_required`: refund this in full at once. */
	refund: reservationRefundDirectiveSchema.optional(),
})
export type ReservationPaymentStatusResponse = z.infer<
	typeof reservationPaymentStatusResponseSchema
>

export const reservationFeeClaimRequestSchema = z.strictObject({
	orgId: opaqueId,
	reservationId: opaqueId,
	feeId: opaqueId,
})
export const reservationFeeClaimResponseSchema = z.strictObject({
	feeId: opaqueId,
	reservationId: opaqueId,
	locationId: opaqueId,
	kind: z.enum(RESERVATION_FEE_KINDS),
	attempt: z.number().int().min(1).max(2),
	amountMinor: minorUnits,
	currency: currencyCode,
	processor: paymentProviderSchema,
	providerCustomerRef: z.string().nullable(),
	paymentMethodRef: z.string().nullable(),
	previousPaymentRef: z.string().nullable(),
})
export type ReservationFeeClaim = z.infer<
	typeof reservationFeeClaimResponseSchema
>

export const reservationFeeResultRequestSchema = z.strictObject({
	orgId: opaqueId,
	reservationId: opaqueId,
	feeId: opaqueId,
	attempt: z.number().int().min(1).max(2),
	paymentRef: z.string().trim().min(1).max(255).nullish(),
	status: z.enum(['succeeded', 'requires_action', 'failed']),
	declineCode: z.string().trim().max(64).nullish(),
	platformFeeBp: basisPoints,
	platformFeeMinor: minorUnits,
})
export type ReservationFeeResultRequest = z.infer<
	typeof reservationFeeResultRequestSchema
>

export const reservationRefundClaimRequestSchema = z.strictObject({
	orgId: opaqueId,
	refundRequestId: opaqueId.optional(),
})
export const reservationRefundClaimSchema =
	reservationRefundDirectiveSchema.extend({
		refundRequestId: opaqueId,
	})
export const reservationRefundClaimResponseSchema = z.strictObject({
	refunds: z.array(reservationRefundClaimSchema),
})
export type ReservationRefundClaim = z.infer<
	typeof reservationRefundClaimSchema
>

export const reservationRefundResultRequestSchema = z
	.strictObject({
		orgId: opaqueId,
		refundRequestId: opaqueId.optional(),
		/** Late-payment refunds have no request row: identify by payment. */
		reservationId: opaqueId.optional(),
		paymentRef: z.string().trim().min(1).max(255).optional(),
		reason: z.enum(['late_payment']).optional(),
		refundRef: z.string().trim().min(1).max(255).nullish(),
		amountMinor: minorUnits,
		status: z.enum(['succeeded', 'pending', 'failed']),
	})
	.refine(
		(value) =>
			Boolean(value.refundRequestId) ||
			(value.reason === 'late_payment' &&
				Boolean(value.reservationId) &&
				Boolean(value.paymentRef)),
		{ message: 'refundRequestId or a late_payment identity is required' },
	)
export type ReservationRefundResultRequest = z.infer<
	typeof reservationRefundResultRequestSchema
>

export const reservationDisputeRequestSchema = z.strictObject({
	orgId: opaqueId,
	reservationId: opaqueId.optional(),
	paymentRef: z.string().trim().min(1).max(255),
	disputeRef: z.string().trim().min(1).max(255),
	status: z.enum(['opened', 'won', 'lost', 'closed']),
})
export type ReservationDisputeRequest = z.infer<
	typeof reservationDisputeRequestSchema
>

export const reservationPendingRequestSchema = z.strictObject({
	orgId: opaqueId,
})
export const reservationPendingResponseSchema = z.strictObject({
	sessions: z.array(
		z.strictObject({
			reservationId: opaqueId,
			feeId: opaqueId.nullable(),
			purpose: z.enum(RESERVATION_PAYMENT_PURPOSES),
			sessionId: z.string(),
			processor: paymentProviderSchema,
			amountMinor: minorUnits,
			currency: currencyCode,
		}),
	),
	refunds: z.array(
		z.strictObject({
			refundRequestId: opaqueId,
			reservationId: opaqueId,
			paymentRef: z.string(),
			processor: paymentProviderSchema,
			/** null: not issued at the provider yet; issue it (idempotent key) and report. */
			refundRef: z.string().nullable(),
			amountMinor: minorUnits,
			currency: currencyCode,
			paymentAmountMinor: minorUnits,
			platformFeeMinor: minorUnits,
			feeReversalMinor: minorUnits,
		}),
	),
})
export type ReservationPendingResponse = z.infer<
	typeof reservationPendingResponseSchema
>

/**
 * Regional -> App outbox delivery (`POST /resources/reservations/payments`).
 * The App claims the refund through `/refund-claim` before it executes.
 */
export const reservationPaymentCommandSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('refund_request'),
		orgId: opaqueId,
		refundRequestId: opaqueId,
	}),
	z.strictObject({
		kind: z.literal('checkout_expire'),
		orgId: opaqueId,
		reservationId: opaqueId,
		sessionId: z.string().trim().min(1).max(255),
		processor: paymentProviderSchema,
	}),
])
export type ReservationPaymentCommand = z.infer<
	typeof reservationPaymentCommandSchema
>

/** Browser/Sites -> App (via Sites server): opaque references only. */
export const reservationCheckoutRequestSchema = z
	.strictObject({
		slug: z.string().trim().min(1).max(100).optional(),
		host: z.string().trim().min(1).max(255).optional(),
		reservationId: opaqueId.optional(),
		feeId: opaqueId.optional(),
		paymentToken: z.string().trim().min(8).max(512),
		purpose: z.enum(RESERVATION_PAYMENT_PURPOSES),
		locale: z.string().trim().max(10).optional(),
	})
	.refine((value) => Boolean(value.slug) !== Boolean(value.host), {
		message: 'Exactly one of slug or host is required',
	})
	.refine(
		(value) =>
			value.purpose === 'fee'
				? Boolean(value.feeId) && !value.reservationId
				: Boolean(value.reservationId) && !value.feeId,
		{ message: 'reservationId (or feeId for a fee) is required' },
	)
export type ReservationCheckoutRequest = z.infer<
	typeof reservationCheckoutRequestSchema
>
