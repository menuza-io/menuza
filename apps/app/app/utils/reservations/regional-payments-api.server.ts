/**
 * App -> regional tenant-api client for reservation payments
 * (`POST /api/reservations/payments/*`).
 *
 * Every body and response is ids, amounts and currency only, validated with the
 * shared contract schemas in `@repo/reservations` (strict: an extra field, such
 * as one that could carry a guest, fails before the request leaves the App).
 * The regional service stays authoritative for amounts, state and capacity.
 * Region resolution fails closed, redirects are never followed, and neither
 * bodies nor tokens are logged.
 */

import {
	reservationDisputeRequestSchema,
	reservationFeeClaimRequestSchema,
	reservationFeeClaimResponseSchema,
	reservationFeeResultRequestSchema,
	reservationPaymentBindRequestSchema,
	reservationPaymentQuoteRequestSchema,
	reservationPaymentQuoteSchema,
	reservationPaymentStatusRequestSchema,
	reservationPaymentStatusResponseSchema,
	reservationPendingRequestSchema,
	reservationPendingResponseSchema,
	reservationRefundClaimRequestSchema,
	reservationRefundClaimResponseSchema,
	reservationRefundResultRequestSchema,
	type ReservationDisputeRequest,
	type ReservationFeeClaim,
	type ReservationFeeResultRequest,
	type ReservationPaymentBindRequest,
	type ReservationPaymentQuote,
	type ReservationPaymentQuoteRequest,
	type ReservationPaymentStatusRequest,
	type ReservationPaymentStatusResponse,
	type ReservationPendingResponse,
	type ReservationRefundClaim,
	type ReservationRefundResultRequest,
} from '@repo/reservations'
import { ENV } from 'varlock/env'
import { type z } from 'zod'
import { getRegionalTenantApiUrl } from '#app/utils/sites/tenant-api.server.ts'
import { getBoundTenantApiService } from '#app/utils/tenant-api-service.server.ts'

const COMMAND_TIMEOUT_MS = 10_000

export const RESERVATION_PAYMENT_ENDPOINTS = [
	'quote',
	'bind',
	'status',
	'fee-claim',
	'fee-result',
	'refund-claim',
	'refund-result',
	'dispute',
	'pending',
] as const
export type ReservationPaymentEndpoint =
	(typeof RESERVATION_PAYMENT_ENDPOINTS)[number]

/** The regional tenant-api rejected or could not serve a payments call. */
export class RegionalPaymentsApiError extends Error {
	constructor(
		public readonly code: string,
		public readonly httpStatus: number,
	) {
		super(`Regional reservation payments error: ${code} (${httpStatus})`)
		this.name = 'RegionalPaymentsApiError'
	}

	/** Transient failures are worth retrying (webhooks, outbox, browser polls). */
	get retryable(): boolean {
		return this.httpStatus >= 500 || this.httpStatus === 429
	}
}

function commandToken() {
	const token =
		process.env.INTERNAL_COMMAND_TOKEN || ENV.INTERNAL_COMMAND_TOKEN || ''
	if (token.length < 16) {
		throw new RegionalPaymentsApiError('token_unconfigured', 503)
	}
	return token
}

const STABLE_CODE = /^[a-z][a-z0-9_]{0,63}$/

async function call(options: {
	dataRegion: string | null | undefined
	endpoint: ReservationPaymentEndpoint
	body: unknown
}): Promise<Response> {
	// Fails closed: a region with no configured origin never falls back to the
	// other one.
	let origin: string
	try {
		origin = getRegionalTenantApiUrl(options.dataRegion)
	} catch {
		throw new RegionalPaymentsApiError('region_unconfigured', 503)
	}
	const token = commandToken()
	const isUs = (options.dataRegion || 'us').toLowerCase() !== 'ksa'
	const bound = isUs ? getBoundTenantApiService() : null
	const fetchImpl = bound ? bound.fetch.bind(bound) : fetch

	let response: Response
	try {
		response = await fetchImpl(
			`${origin}/api/reservations/payments/${options.endpoint}`,
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${token}`,
				},
				body: JSON.stringify(options.body),
				redirect: 'manual',
				signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS),
			},
		)
	} catch {
		throw new RegionalPaymentsApiError('regional_unreachable', 503)
	}

	if (response.status >= 300 && response.status < 400) {
		throw new RegionalPaymentsApiError('unexpected_redirect', 502)
	}
	if (!response.ok) {
		const payload = (await response.json().catch(() => null)) as {
			error?: unknown
		} | null
		const code =
			typeof payload?.error === 'string' && STABLE_CODE.test(payload.error)
				? payload.error
				: `http_${response.status}`
		throw new RegionalPaymentsApiError(code, response.status)
	}
	return response
}

function parseOutgoing<S extends z.ZodTypeAny>(
	schema: S,
	body: unknown,
): z.infer<S> {
	const parsed = schema.safeParse(body)
	if (!parsed.success) {
		// Never echo the rejected values.
		throw new RegionalPaymentsApiError('invalid_request', 500)
	}
	return parsed.data
}

async function callParsed<S extends z.ZodTypeAny>(
	options: Parameters<typeof call>[0],
	schema: S,
): Promise<z.infer<S>> {
	const response = await call(options)
	const raw = await response.json().catch(() => null)
	const parsed = schema.safeParse(raw)
	if (!parsed.success) {
		throw new RegionalPaymentsApiError('invalid_response', 502)
	}
	return parsed.data
}

type Region = { dataRegion: string | null | undefined }

/**
 * Authoritative quote. The `paymentToken` is the opaque capability the browser
 * received; the regional service verifies it, so a forged or cross-org token
 * fails here and never reaches a provider.
 */
export async function fetchReservationPaymentQuote(
	options: Region & ReservationPaymentQuoteRequest,
): Promise<ReservationPaymentQuote> {
	const { dataRegion, ...rest } = options
	const body = parseOutgoing(reservationPaymentQuoteRequestSchema, rest)
	const quote = await callParsed(
		{ dataRegion, endpoint: 'quote', body },
		reservationPaymentQuoteSchema,
	)
	// Defense in depth: the regional service must echo what we asked about.
	const askedFee = 'feeId' in body ? body.feeId : null
	if (askedFee) {
		if (quote.feeId !== askedFee) {
			throw new RegionalPaymentsApiError('quote_mismatch', 502)
		}
	} else if (
		'reservationId' in body &&
		(quote.reservationId !== body.reservationId || quote.feeId !== null)
	) {
		throw new RegionalPaymentsApiError('quote_mismatch', 502)
	}
	return quote
}

/** Bind a provider session once. 409 codes: already_bound, payment_terminal, hold_expired. */
export async function bindReservationPaymentSession(
	options: Region & ReservationPaymentBindRequest,
): Promise<void> {
	const { dataRegion, ...rest } = options
	const body = parseOutgoing(reservationPaymentBindRequestSchema, rest)
	await call({ dataRegion, endpoint: 'bind', body })
}

/** Report a terminal provider payment state; duplicates are idempotent regionally. */
export async function notifyReservationPaymentStatus(
	options: Region & ReservationPaymentStatusRequest,
): Promise<ReservationPaymentStatusResponse> {
	const { dataRegion, ...rest } = options
	const body = parseOutgoing(reservationPaymentStatusRequestSchema, rest)
	return callParsed(
		{ dataRegion, endpoint: 'status', body },
		reservationPaymentStatusResponseSchema,
	)
}

/** Move a fee pending -> charging once; 409 when it is not claimable. */
export async function claimReservationFee(
	options: Region & {
		orgId: string
		reservationId: string
		feeId: string
		/** The operator's locations (`null` for all); the region enforces it. */
		locationIds: string[] | null
	},
): Promise<ReservationFeeClaim> {
	const { dataRegion, ...rest } = options
	const body = parseOutgoing(reservationFeeClaimRequestSchema, rest)
	return callParsed(
		{ dataRegion, endpoint: 'fee-claim', body },
		reservationFeeClaimResponseSchema,
	)
}

export async function reportReservationFeeResult(
	options: Region & ReservationFeeResultRequest,
): Promise<void> {
	const { dataRegion, ...rest } = options
	const body = parseOutgoing(reservationFeeResultRequestSchema, rest)
	await call({ dataRegion, endpoint: 'fee-result', body })
}

/** Claim one refund request (or, without an id, the batch that is due). */
export async function claimReservationRefunds(
	options: Region & {
		orgId: string
		refundRequestId?: string
		/** Set for an operator's request; the region refuses other locations. */
		locationIds?: string[] | null
	},
): Promise<ReservationRefundClaim[]> {
	const { dataRegion, ...rest } = options
	const body = parseOutgoing(reservationRefundClaimRequestSchema, rest)
	const result = await callParsed(
		{ dataRegion, endpoint: 'refund-claim', body },
		reservationRefundClaimResponseSchema,
	)
	return result.refunds
}

export async function reportReservationRefundResult(
	options: Region & ReservationRefundResultRequest,
): Promise<void> {
	const { dataRegion, ...rest } = options
	const body = parseOutgoing(reservationRefundResultRequestSchema, rest)
	await call({ dataRegion, endpoint: 'refund-result', body })
}

export async function reportReservationDispute(
	options: Region & ReservationDisputeRequest,
): Promise<void> {
	const { dataRegion, ...rest } = options
	const body = parseOutgoing(reservationDisputeRequestSchema, rest)
	await call({ dataRegion, endpoint: 'dispute', body })
}

/** Bound sessions still pending and refunds still pending (ids only). */
export async function fetchPendingReservationPayments(
	options: Region & { orgId: string },
): Promise<ReservationPendingResponse> {
	const { dataRegion, ...rest } = options
	const body = parseOutgoing(reservationPendingRequestSchema, rest)
	return callParsed(
		{ dataRegion, endpoint: 'pending', body },
		reservationPendingResponseSchema,
	)
}
