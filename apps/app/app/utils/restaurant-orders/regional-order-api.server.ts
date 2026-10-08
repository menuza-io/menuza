/**
 * App → regional tenant-api client for restaurant orders.
 *
 * Every payload here is non-PII by contract: opaque ids, cents, currency, and
 * payment state only. Customer contact, cart instructions, and receipt
 * capabilities never transit the US control plane. The regional service stays
 * authoritative for order state; App failures fail closed.
 */

import { ENV } from 'varlock/env'
import { z } from 'zod'
import { getRegionalTenantApiUrl } from '#app/utils/sites/tenant-api.server.ts'
import { getBoundTenantApiService } from '#app/utils/tenant-api-service.server.ts'

const COMMAND_TIMEOUT_MS = 10_000

/** Error raised when the regional tenant-api rejects or cannot serve a call. */
export class RegionalOrderApiError extends Error {
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
	paymentStatus: 'paid' | 'pending' | 'failed' | 'unknown'
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
		} | null
		throw new RegionalOrderApiError(
			payload?.error || payload?.message || `http_${response.status}`,
			response.status,
		)
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
}): Promise<void> {
	await callRegionalOrderCommand({
		dataRegion: options.dataRegion,
		path: '/api/orders/payment-status',
		body: {
			orgId: options.orgId,
			orderId: options.orderId,
			sessionId: options.sessionId,
			processor: options.processor,
			status: options.status,
			amountCents: options.amountCents,
			currency: options.currency,
		},
	})
}
