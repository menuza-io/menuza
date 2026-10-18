import { z } from 'zod'
import {
	ReservationsApiError,
	type ReservationsScopedClient,
} from '#app/utils/reservations/reservations-client.ts'

/**
 * Browser-side payment calls. Reading the rows and recording a decision (a fee
 * or a refund) go straight to the regional tenant-api with a `payments` token;
 * running the decision at the provider is the App's job, so the second step is
 * a same-origin POST to an App resource route. Amounts are integer minor units.
 */

const PAYMENTS_BASE = '/operator/reservations/payments/reservations'

const nullableText = z.string().nullable().optional()

export const paymentRowSchema = z.object({
	id: z.string(),
	reservationId: z.string(),
	kind: z.string(),
	purpose: nullableText,
	status: z.string(),
	amountMinor: z.number().int(),
	refundedMinor: z.number().int().default(0),
	currency: z.string(),
	platformFeeBp: z.number().int().default(0),
	platformFeeMinor: z.number().int().default(0),
	attempt: z.number().int().default(1),
	cardBrand: nullableText,
	cardLast4: nullableText,
	cardExpMonth: z.number().int().nullable().optional(),
	cardExpYear: z.number().int().nullable().optional(),
	declineCode: nullableText,
	failureCode: nullableText,
	disputeStatus: nullableText,
	parentPaymentId: z.string().nullable().optional(),
	createdAt: z.number(),
	updatedAt: z.number(),
})
export type PaymentRow = z.infer<typeof paymentRowSchema>

export const paymentListSchema = z.object({
	reservation: z.object({
		id: z.string(),
		version: z.number().int(),
		status: z.string(),
		paymentStatus: z.string(),
		lateCancel: z.boolean().default(false),
	}),
	policy: z
		.object({
			kind: z.string(),
			noShowFeeMinor: z.number().int(),
			lateCancelFeeMinor: z.number().int(),
			currency: z.string(),
		})
		.nullable(),
	payments: z.array(paymentRowSchema),
})
export type PaymentList = z.infer<typeof paymentListSchema>

export async function fetchReservationPayments(
	client: ReservationsScopedClient,
	reservationId: string,
	signal?: AbortSignal,
): Promise<PaymentList> {
	const raw = await client.request<unknown>(
		`${PAYMENTS_BASE}/${encodeURIComponent(reservationId)}`,
		{ signal },
	)
	const parsed = paymentListSchema.safeParse(raw)
	if (!parsed.success) {
		throw new ReservationsApiError('malformed_response', 502, {
			error: 'malformed_response',
		})
	}
	return parsed.data
}

const feeRequestResultSchema = z.object({
	feeId: z.string(),
	amountMinor: z.number().int(),
	currency: z.string(),
	kind: z.enum(['no_show_fee', 'late_cancel_fee']),
	attempt: z.number().int(),
})
export type FeeRequestResult = z.infer<typeof feeRequestResultSchema>

/** Step 1 of charging a fee: record it regionally (nothing is charged yet). */
export async function requestReservationFee(
	client: ReservationsScopedClient,
	reservationId: string,
	input: {
		kind: 'no_show_fee' | 'late_cancel_fee'
		amountMinor?: number | null
		expectedVersion: number
	},
): Promise<FeeRequestResult> {
	const raw = await client.request<unknown>(
		`${PAYMENTS_BASE}/${encodeURIComponent(reservationId)}/fee`,
		{
			method: 'POST',
			body: {
				kind: input.kind,
				...(input.amountMinor ? { amountMinor: input.amountMinor } : {}),
				expectedVersion: input.expectedVersion,
			},
		},
	)
	return feeRequestResultSchema.parse(raw)
}

const refundRequestResultSchema = z.object({
	refundId: z.string(),
	amountMinor: z.number().int(),
})
export type RefundRequestResult = z.infer<typeof refundRequestResultSchema>

/** Step 1 of a partial refund: record the request regionally. */
export async function requestReservationRefund(
	client: ReservationsScopedClient,
	reservationId: string,
	input: { amountMinor?: number | null; reason: string },
): Promise<RefundRequestResult> {
	const raw = await client.request<unknown>(
		`${PAYMENTS_BASE}/${encodeURIComponent(reservationId)}/refund`,
		{
			method: 'POST',
			body: {
				...(input.amountMinor ? { amountMinor: input.amountMinor } : {}),
				reason: input.reason.trim(),
			},
		},
	)
	return refundRequestResultSchema.parse(raw)
}

const feeChargeResultSchema = z.object({
	feeId: z.string(),
	attempt: z.number().int(),
	status: z.enum(['succeeded', 'requires_action', 'failed']),
	declineCode: z.string().nullable().optional(),
})
export type FeeChargeResult = z.infer<typeof feeChargeResultSchema>

const refundRunResultSchema = z.object({
	refunds: z.number().int(),
	pending: z.number().int(),
	failed: z.number().int(),
})
export type RefundRunResult = z.infer<typeof refundRunResultSchema>

async function postApp(
	path: string,
	orgSlug: string,
	body: unknown,
	fetchImpl: typeof fetch,
	signal?: AbortSignal,
): Promise<unknown> {
	const response = await fetchImpl(
		`${path}?orgSlug=${encodeURIComponent(orgSlug)}`,
		{
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json',
			},
			body: JSON.stringify(body),
			credentials: 'same-origin',
			cache: 'no-store',
			signal,
		},
	)
	const payload: unknown = await response.json().catch(() => null)
	if (!response.ok) {
		const code =
			payload && typeof payload === 'object'
				? ((payload as { error?: unknown }).error ?? null)
				: null
		throw new ReservationsApiError(
			typeof code === 'string' ? code : `Payment error (${response.status})`,
			response.status,
			payload && typeof payload === 'object' ? payload : undefined,
		)
	}
	return payload
}

/** Step 2 of a fee: the App charges the saved card and reports the result. */
export async function runReservationFee(
	orgSlug: string,
	input: { reservationId: string; feeId: string },
	fetchImpl: typeof fetch = fetch,
	signal?: AbortSignal,
): Promise<FeeChargeResult> {
	return feeChargeResultSchema.parse(
		await postApp(
			'/resources/reservations/payments/fee',
			orgSlug,
			input,
			fetchImpl,
			signal,
		),
	)
}

/** Step 2 of a refund: the App refunds at the provider and reports the result. */
export async function runReservationRefund(
	orgSlug: string,
	input: { refundRequestId: string },
	fetchImpl: typeof fetch = fetch,
	signal?: AbortSignal,
): Promise<RefundRunResult> {
	return refundRunResultSchema.parse(
		await postApp(
			'/resources/reservations/payments/refund',
			orgSlug,
			input,
			fetchImpl,
			signal,
		),
	)
}
