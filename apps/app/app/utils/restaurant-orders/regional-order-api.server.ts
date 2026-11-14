/**
 * App → regional tenant-api client for restaurant orders.
 *
 * Every payload here is non-PII by contract: opaque ids, cents, currency, and
 * payment state only. Customer contact, cart instructions, and receipt
 * capabilities never transit the US control plane. The regional service stays
 * authoritative for order state; App failures fail closed.
 */

import { parseTabOrderRef } from '@repo/common/qr-ordering'
import {
	ORDER_REFUND_MAX_LOCATION_IDS,
	type OrderDisputeStatusRequest,
	orderDisputeStatusRequestSchema,
	type OrderProviderRefund,
	type OrderRefundIntentRequest,
	orderRefundIntentRequestSchema,
	type OrderRefundIntentResponse,
	orderRefundIntentResponseSchema,
	orderRefundsPendingRequestSchema,
	orderRefundsPendingResponseSchema,
	type OrderRefundStatusRequest,
	orderRefundStatusRequestSchema,
	type OrderRefundStatusResponse,
	orderRefundStatusResponseSchema,
} from '@repo/common/restaurant-orders'
import { ENV } from 'varlock/env'
import { z } from 'zod'
import { getRegionalTenantApiUrl } from '#app/utils/sites/tenant-api.server.ts'
import { getBoundTenantApiService } from '#app/utils/tenant-api-service.server.ts'

const COMMAND_TIMEOUT_MS = 10_000

/** Error raised when the regional tenant-api rejects or cannot serve a call. */
export class RegionalOrderApiError extends Error {
	/**
	 * What is still refundable, when the region refused an over-refund
	 * (`refund_exceeds_payment`). The only detail ever read from an error body.
	 */
	public refundableCents?: number

	constructor(
		public readonly code: string,
		public readonly httpStatus: number,
		message?: string,
	) {
		super(message || `Regional order API error: ${code} (${httpStatus})`)
		this.name = 'RegionalOrderApiError'
	}

	/** Transient failures are worth retrying (webhooks, browser polls). */
	get retryable(): boolean {
		return this.httpStatus >= 500 || this.httpStatus === 429
	}
}

const quoteResponseSchema = z.object({
	orgId: z.string(),
	orderId: z.string(),
	totalCents: z.number().int().nonnegative(),
	currency: z.string().min(3).max(3),
	holdExpiresAt: z.string().nullable(),
	status: z.string(),
	// Extended (negotiated) fields: an already-bound provider session for this
	// order, if one exists. Absent when no session has been bound yet.
	sessionId: z.string().optional(),
	processor: z.string().optional(),
	paymentStatus: z.string().optional(),
})

export type RestaurantOrderQuote = {
	orgId: string
	orderId: string
	/** Authoritative total for this order, in cents. */
	totalCents: number
	/** Uppercase ISO currency, e.g. 'USD', 'CAD', 'SAR'. */
	currency: string
	/** Reservation expiry for the order's capacity/stock hold, or null. */
	holdExpiresAt: string | null
	/** Order status as reported by the regional service. */
	status: string
	/** Payment status ('pending' | 'paid' | ...) when reported separately. */
	paymentStatus: 'paid' | 'pending' | 'failed' | 'not_required' | 'unknown'
	/** Provider session already bound to this order, if any. */
	boundSession: { sessionId: string; processor: 'connect' | 'checkout' } | null
}

function getCommandToken() {
	const token =
		process.env.INTERNAL_COMMAND_TOKEN || ENV.INTERNAL_COMMAND_TOKEN || ''
	if (token.length < 16) {
		throw new Error('INTERNAL_COMMAND_TOKEN is not configured')
	}
	return token
}

async function callRegionalOrderCommand(options: {
	dataRegion: string | null | undefined
	path:
		| '/api/orders/quote'
		| '/api/orders/payment-session'
		| '/api/orders/payment-status'
		| '/api/orders/refund-intent'
		| '/api/orders/refund-status'
		| '/api/orders/dispute-status'
		| '/api/orders/refunds-pending'
	body: Record<string, unknown>
}): Promise<unknown> {
	// Resolves (and validates) the regional URL; throws when the region has no
	// configured tenant-api origin — fail closed, never fall back to the other
	// region.
	let tenantApiUrl: string
	try {
		tenantApiUrl = getRegionalTenantApiUrl(options.dataRegion)
	} catch (error) {
		throw new RegionalOrderApiError(
			'region_unconfigured',
			503,
			`No regional tenant API for dataRegion "${options.dataRegion || 'us'}": ${
				error instanceof Error ? error.message : String(error)
			}`,
		)
	}

	const token = getCommandToken()

	const boundService =
		(options.dataRegion || 'us').toLowerCase() === 'us'
			? getBoundTenantApiService()
			: null
	const fetchImpl = boundService ? boundService.fetch.bind(boundService) : fetch

	let response: Response
	try {
		response = await fetchImpl(`${tenantApiUrl}${options.path}`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(options.body),
			redirect: 'error',
			signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS),
		})
	} catch (error) {
		throw new RegionalOrderApiError(
			'regional_unreachable',
			503,
			`Failed to reach regional tenant API at ${tenantApiUrl}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		)
	}

	if (!response.ok) {
		const payload = (await response.json().catch(() => null)) as {
			error?: string
			message?: string
			refundableCents?: unknown
		} | null
		const error = new RegionalOrderApiError(
			payload?.error || payload?.message || `http_${response.status}`,
			response.status,
		)
		const refundable = payload?.refundableCents
		if (
			typeof refundable === 'number' &&
			Number.isInteger(refundable) &&
			refundable >= 0
		) {
			error.refundableCents = refundable
		}
		throw error
	}

	return response.json().catch(() => {
		throw new RegionalOrderApiError('invalid_response', 502)
	})
}

/**
 * Fetch the authoritative quote for an online restaurant order. The
 * `paymentToken` is the opaque capability the browser received when the order
 * was created; the regional service verifies it against the order and org —
 * cross-org or forged tokens fail here and never reach a payment provider.
 */
export async function fetchRestaurantOrderQuote(options: {
	dataRegion: string | null | undefined
	orgId: string
	orderId: string
	paymentToken: string
}): Promise<RestaurantOrderQuote> {
	const raw = await callRegionalOrderCommand({
		dataRegion: options.dataRegion,
		path: '/api/orders/quote',
		body: {
			orgId: options.orgId,
			orderId: options.orderId,
			paymentToken: options.paymentToken,
		},
	})

	const parsed = quoteResponseSchema.safeParse(raw)
	if (!parsed.success) {
		throw new RegionalOrderApiError('invalid_quote_response', 502)
	}

	// Defense in depth: the regional service must echo the org we asked about.
	if (
		parsed.data.orgId !== options.orgId ||
		parsed.data.orderId !== options.orderId
	) {
		throw new RegionalOrderApiError('org_mismatch', 502)
	}

	const paymentStatusRaw =
		parsed.data.paymentStatus ??
		(parsed.data.status === 'paid' ? 'paid' : 'pending')
	const paymentStatus: RestaurantOrderQuote['paymentStatus'] =
		paymentStatusRaw === 'paid'
			? 'paid'
			: paymentStatusRaw === 'failed'
				? 'failed'
				: paymentStatusRaw === 'pending'
					? 'pending'
					: paymentStatusRaw === 'not_required'
						? 'not_required'
						: 'unknown'

	const boundSession =
		parsed.data.sessionId && parsed.data.processor === 'connect'
			? { sessionId: parsed.data.sessionId, processor: 'connect' as const }
			: parsed.data.sessionId && parsed.data.processor === 'checkout'
				? { sessionId: parsed.data.sessionId, processor: 'checkout' as const }
				: null

	return {
		orgId: parsed.data.orgId,
		orderId: parsed.data.orderId,
		totalCents: parsed.data.totalCents,
		currency: parsed.data.currency.toUpperCase(),
		holdExpiresAt: parsed.data.holdExpiresAt,
		status: parsed.data.status,
		paymentStatus,
		boundSession,
	}
}

/**
 * Bind a provider checkout session to its regional order. The regional service
 * binds exactly once; a second bind attempt fails with `already_bound`.
 */
export async function bindRestaurantOrderPaymentSession(options: {
	dataRegion: string | null | undefined
	orgId: string
	orderId: string
	sessionId: string
	processor: 'connect' | 'checkout'
}): Promise<void> {
	await callRegionalOrderCommand({
		dataRegion: options.dataRegion,
		path: '/api/orders/payment-session',
		body: {
			orgId: options.orgId,
			orderId: options.orderId,
			sessionId: options.sessionId,
			processor: options.processor,
		},
	})
}

/**
 * Report a terminal provider payment state to the regional service. The
 * regional service verifies the session binding and the immutable
 * amount/currency before applying anything; duplicate events are idempotent.
 *
 * `currency` is a lowercase ISO code ('usd', 'cad', 'sar') matching the
 * provider's own event payloads.
 */
export async function notifyRestaurantOrderPaymentStatus(options: {
	dataRegion: string | null | undefined
	orgId: string
	orderId: string
	sessionId: string
	processor: 'connect' | 'checkout'
	status: 'paid' | 'failed' | 'expired'
	amountCents: number
	currency: string
	paymentId?: string
}): Promise<void> {
	const isTab = parseTabOrderRef(options.orderId) !== null
	// The payment's own id (`pi_…`, `pay_…`): the region stores it on the
	// order so a refund names the exact payment. A QR tab keys each payment by
	// it, which only Checkout.com needs (a Stripe session is one payment, and
	// the tab's refund and dispute paths read its session id).
	const paymentId =
		options.paymentId && (!isTab || options.processor === 'checkout')
			? options.paymentId
			: undefined
	const body = {
		orgId: options.orgId,
		orderId: options.orderId,
		sessionId: options.sessionId,
		processor: options.processor,
		status: options.status,
		amountCents: options.amountCents,
		currency: options.currency,
	}
	try {
		await callRegionalOrderCommand({
			dataRegion: options.dataRegion,
			path: '/api/orders/payment-status',
			body: paymentId ? { ...body, paymentId } : body,
		})
	} catch (error) {
		// A region that predates `paymentId` refuses unknown keys (400). The
		// payment itself must still count there: send it again without the id,
		// which is only a refund convenience. Tabs always needed the field.
		if (
			paymentId &&
			!isTab &&
			error instanceof RegionalOrderApiError &&
			error.httpStatus === 400
		) {
			await callRegionalOrderCommand({
				dataRegion: options.dataRegion,
				path: '/api/orders/payment-status',
				body,
			})
			return
		}
		throw error
	}
}

/* ------------------------------------------------------------------ */
/* Provider refunds and disputes (#80)                                 */
/* ------------------------------------------------------------------ */

/**
 * Parse an outgoing system body with its shared contract before it leaves:
 * the region refuses unknown keys, so a caller bug fails here, loudly, and
 * never reaches the region with something it did not mean to send.
 */
function outgoing<T>(
	schema: { safeParse: (value: unknown) => { success: boolean; data?: T } },
	body: unknown,
): T {
	const parsed = schema.safeParse(body)
	if (!parsed.success) throw new RegionalOrderApiError('invalid_request', 400)
	return parsed.data as T
}

/**
 * Book a provider refund in the region (`pending`, a reservation of the
 * amount). A replay with the same idempotency key returns the same refund,
 * whatever its status now. Region refusals keep their code and status
 * (`refund_pending`, `payment_disputed`, `refund_exceeds_payment` with
 * `refundableCents`, `order_not_refundable`, `idempotency_conflict`, 404).
 */
export async function requestRestaurantOrderRefundIntent(
	options: { dataRegion: string | null | undefined } & OrderRefundIntentRequest,
): Promise<OrderRefundIntentResponse> {
	const { dataRegion, ...request } = options
	// A member limited to some locations: the region must check the order's
	// location itself (the App cannot see it). Anything short of the region
	// confirming that check is `location_scope_unsupported` (403), never a
	// refund made on trust.
	const scoped = request.locationIds != null
	if (
		scoped &&
		(request.locationIds?.length ?? 0) > ORDER_REFUND_MAX_LOCATION_IDS
	) {
		throw locationScopeUnsupported()
	}
	// A member without the loyalty grant: the region must refuse an order
	// loyalty tracks (the App cannot see that). Anything short of the region
	// confirming the check is refused here, never a refund made on trust. A
	// member with the grant sends nothing: there is nothing to check.
	const loyaltyLimited = request.loyaltyAccess?.refundLoyalty === false
	if (request.loyaltyAccess && !loyaltyLimited) {
		const { loyaltyAccess: ignoredAccess, ...rest } = request
		return requestRestaurantOrderRefundIntent({ dataRegion, ...rest })
	}
	const body = outgoing(orderRefundIntentRequestSchema, request)
	let raw: unknown
	try {
		raw = await callRegionalOrderCommand({
			dataRegion,
			path: '/api/orders/refund-intent',
			body,
		})
	} catch (error) {
		// A region that predates `locationIds` (or `loyaltyAccess`) refuses the
		// unknown key (strict body, 400): it cannot enforce the check, so
		// nothing was booked.
		if (error instanceof RegionalOrderApiError && error.httpStatus === 400) {
			if (scoped) throw locationScopeUnsupported()
			if (loyaltyLimited) throw loyaltyCheckUnsupported()
		}
		throw error
	}
	const parsed = orderRefundIntentResponseSchema.safeParse(raw)
	if (!parsed.success) {
		throw new RegionalOrderApiError('invalid_refund_response', 502)
	}
	if (parsed.data.orderId !== request.orderId) {
		throw new RegionalOrderApiError('org_mismatch', 502)
	}
	const unchecked =
		scoped && parsed.data.locationScoped !== true
			? 'location_scope_unsupported'
			: loyaltyLimited && parsed.data.loyaltyChecked !== true
				? 'loyalty_check_unsupported'
				: null
	if (unchecked) {
		// Booked without the check (a region that ignores the field). Release
		// a refund this call just booked and never sent, so neither this
		// action nor the reconcile job executes it; anything older is left to
		// finish as it was.
		const intent = parsed.data
		if (
			intent.status === 'pending' &&
			!intent.replayed &&
			intent.providerRefundId === null
		) {
			await reportRestaurantOrderRefundStatus({
				dataRegion,
				orgId: request.orgId,
				orderId: intent.orderId,
				refundId: intent.refundId,
				processor: intent.processor,
				status: 'failed',
				failureCode: unchecked,
				amountCents: intent.amountCents,
				currency: intent.currency,
			}).catch((error: unknown) => {
				console.error(
					`Could not release unchecked refund ${intent.refundId}:`,
					error instanceof RegionalOrderApiError ? error.code : 'unknown',
				)
			})
		}
		throw unchecked === 'location_scope_unsupported'
			? locationScopeUnsupported()
			: loyaltyCheckUnsupported()
	}
	return parsed.data
}

function locationScopeUnsupported() {
	return new RegionalOrderApiError('location_scope_unsupported', 403)
}

function loyaltyCheckUnsupported() {
	return new RegionalOrderApiError('loyalty_check_unsupported', 403)
}

/**
 * Report a provider's answer for one refund. Idempotent in the region: only
 * the first final status moves money, a replay answers `applied: false`.
 */
export async function reportRestaurantOrderRefundStatus(
	options: { dataRegion: string | null | undefined } & OrderRefundStatusRequest,
): Promise<OrderRefundStatusResponse> {
	const { dataRegion, ...request } = options
	const body = outgoing(orderRefundStatusRequestSchema, request)
	const raw = await callRegionalOrderCommand({
		dataRegion,
		path: '/api/orders/refund-status',
		body,
	})
	const parsed = orderRefundStatusResponseSchema.safeParse(raw)
	if (!parsed.success) {
		throw new RegionalOrderApiError('invalid_refund_response', 502)
	}
	return parsed.data
}

/** Report a dispute opening or closing on an order's (or a tab's) payment. */
export async function reportRestaurantOrderDisputeStatus(
	options: {
		dataRegion: string | null | undefined
	} & OrderDisputeStatusRequest,
): Promise<void> {
	const { dataRegion, ...request } = options
	const body = outgoing(orderDisputeStatusRequestSchema, request)
	await callRegionalOrderCommand({
		dataRegion,
		path: '/api/orders/dispute-status',
		body,
	})
}

/**
 * Provider refunds the region still has `pending` (ids and amounts only),
 * oldest first. `refundId` narrows to one refund.
 */
export async function fetchPendingRestaurantOrderRefunds(options: {
	dataRegion: string | null | undefined
	orgId: string
	refundId?: string
	olderThanMs?: number
	limit?: number
}): Promise<OrderProviderRefund[]> {
	const { dataRegion, ...request } = options
	const body = outgoing(orderRefundsPendingRequestSchema, request)
	const raw = await callRegionalOrderCommand({
		dataRegion,
		path: '/api/orders/refunds-pending',
		body,
	})
	const parsed = orderRefundsPendingResponseSchema.safeParse(raw)
	if (!parsed.success) {
		throw new RegionalOrderApiError('invalid_refund_response', 502)
	}
	return parsed.data.refunds
}
