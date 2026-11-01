import { Hono, type Context } from 'hono'
import { ENV } from 'varlock/env'

import {
	QR_TAB_TOKEN_HEADER,
	QR_TABLE_TOKEN_HEADER,
	qrTabPayRequestSchema,
	readQrOrderingFeatures,
} from '@repo/common/qr-ordering'
import {
	RESTAURANT_TURNSTILE_ACTION,
	restaurantOrderDiscountQuoteSchema,
	restaurantOrderRequestSchema,
} from '@repo/common/restaurant-orders'
import {
	isTurnstileConfigured,
	parseTurnstileHostnames,
	verifyTurnstileToken,
} from '@repo/common/turnstile'
import { normalizeDiscountCode } from '@repo/discounts'
import { getTenantDb } from '@repo/tenant-db'
import crypto from 'node:crypto'
import { z } from 'zod'

import {
	chargeCouponGuess,
	enforceDiscountLimit,
	refundCouponGuess,
	type CouponGuessSubject,
} from '../lib/discount-rate-limit.ts'
import {
	resolveOrganizationForBrowserAuth,
	type PublishedOrganization,
} from '../lib/origin.ts'
import { isQrDineInDisabled } from '../lib/qr-tokens.ts'
import { rateLimitByKey } from '../lib/rate-limit.ts'
import { orgMatchesNodeRegion } from '../lib/region.ts'
import { getBearerToken, syncEnvFromProcess } from '../lib/secrets.ts'
import { quoteOrderDiscounts } from '../services/discount-quote.ts'
import {
	buildOrderingOptionsWithContext,
	fetchOrderContext,
	getOrderReceipt,
	placeOrder,
	publicOrderSummary,
	receiptOrder,
	type OrderServiceFailure,
} from '../services/order-service.ts'
import type { DineInCapability } from '../services/qr-dine-in.ts'
import {
	getPublicTab,
	getTableContext,
	prepareTabPayment,
	withTabDiscounts,
} from '../services/qr-tab-service.ts'
import { authenticateCustomer } from './auth.ts'

export const publicOrderRoutes = new Hono()

const MAX_ORDER_BODY_BYTES = 200_000

function orderFailureResponse(failure: OrderServiceFailure) {
	return Response.json(
		{
			error: failure.code,
			message: failure.message,
			...(failure.reason ? { reason: failure.reason } : {}),
			...(failure.quote ? { quote: failure.quote } : {}),
			...(failure.details ? { details: failure.details } : {}),
		},
		{ status: failure.status, headers: { 'Cache-Control': 'no-store' } },
	)
}

function noStoreHeaders() {
	return { 'Cache-Control': 'no-store' }
}

/** Table and tab capabilities ride in headers (from the URL fragment). */
function dineInCapability(c: Context): DineInCapability | null {
	const tableToken = c.req.header(QR_TABLE_TOKEN_HEADER)?.trim() || null
	const tabToken = c.req.header(QR_TAB_TOKEN_HEADER)?.trim() || null
	return tableToken || tabToken ? { tableToken, tabToken } : null
}

function dineInUnavailable() {
	return Response.json(
		{ error: 'unavailable' },
		{ status: 503, headers: noStoreHeaders() },
	)
}

function clientIp(c: Context) {
	const cfConnectingIp = c.req.header('cf-connecting-ip')?.trim()
	if (cfConnectingIp) return cfConnectingIp
	// The last entry is the one our proxy appended. The first is client-supplied.
	const forwardedFor = c.req.header('x-forwarded-for')
	const last = forwardedFor?.split(',').at(-1)?.trim()
	return last || undefined
}

function couponGuestSubject(c: Context): string | null {
	const ip = clientIp(c)
	if (ip) return ip
	const sessionToken =
		c.req.header('x-session-id') ??
		c.req.header('authorization')?.slice(-16) ??
		null
	return sessionToken ? `s:${sessionToken}` : null
}

function couponSubject(
	c: Context,
	customerId: string | null | undefined,
): CouponGuessSubject {
	if (customerId) return { kind: 'customer', customerId }
	return { kind: 'guest', address: couponGuestSubject(c) }
}

function couponLimitedResponse(retryAfterSeconds: number) {
	return Response.json(
		{
			error: 'rate_limit_exceeded',
			message: 'Too many coupon attempts. Please try again shortly.',
			retryAfterSeconds,
		},
		{
			status: 429,
			headers: {
				...noStoreHeaders(),
				'Retry-After': String(Math.max(1, retryAfterSeconds)),
			},
		},
	)
}

/**
 * What makes two coupon requests the same question: the code and the cart (or
 * the tab) it was tried on. The Sites page re-quotes on every cart change and
 * again when the order is placed; none of those repeats is a new guess.
 */
export function couponFingerprint(code: string, ...parts: unknown[]): string {
	return crypto
		.createHash('sha256')
		.update(JSON.stringify([normalizeDiscountCode(code), ...parts]))
		.digest('hex')
}

/** Refusals the customer can fix by changing the cart, so they are not probes. */
const FIXABLE_COUPON_REASONS = new Set(['minimum_not_met', 'quantity_not_met'])

/**
 * Whether a failed placement, quote or tab payment counts as a wrong coupon
 * guess. A code the customer can still make work (minimum or quantity not met)
 * is not a guess. A valid code beaten by an automatic discount (`replaced`)
 * is one: it proves the code exists, so a probe is never free.
 */
export function failureCountsAsCouponGuess(failure: {
	code: string
	reason?: string | undefined
}): boolean {
	if (failure.code === 'coupon_refused') {
		return !FIXABLE_COUPON_REASONS.has(failure.reason ?? '')
	}
	return (
		failure.code === 'discount_changed' &&
		failure.reason === 'replaced_by_better_discount'
	)
}

/** The same rule for the `coupon` field of a quote answer. */
export function couponStatusCountsAsGuess(
	coupon: { status: string; reason?: string | undefined } | null | undefined,
): boolean {
	if (!coupon) return false
	if (coupon.status === 'replaced') return true
	return (
		coupon.status === 'refused' &&
		!FIXABLE_COUPON_REASONS.has(coupon.reason ?? '')
	)
}

export type CouponGuard =
	| { blocked: Response }
	| {
			blocked: null
			/**
			 * Call once the answer is known. A code that was refused as not a
			 * working code stays counted (`refused: true`); anything else gives
			 * the attempt back, so only wrong guesses use up the budget.
			 */
			settle: (outcome: { refused: boolean }) => Promise<void>
	  }

/**
 * Counts a coupon attempt before the code is checked, for the address and for
 * the organization, and answers 429 when either is over its budget. The count
 * is taken first and given back when the code applies, so parallel requests
 * cannot all slip under the limit the way a read-then-charge check lets them.
 * No code, no count.
 */
export async function guardCouponGuess(
	orgId: string,
	c: Context,
	code: string | null | undefined,
	fingerprintParts: unknown[],
	customerId?: string | null,
): Promise<CouponGuard> {
	if (!code) return { blocked: null, settle: async () => {} }
	const db = await getTenantDb(orgId)
	const result = await chargeCouponGuess(db, {
		orgId,
		subject: couponSubject(c, customerId),
		fingerprint: couponFingerprint(code, ...fingerprintParts),
	})
	if (!result.ok) {
		return { blocked: couponLimitedResponse(result.retryAfterSeconds) }
	}
	return {
		blocked: null,
		settle: async ({ refused }) => {
			if (!refused) await refundCouponGuess(db, result.charge)
		},
	}
}

/**
 * `POST /orders` requires a Turnstile token whenever the node has a secret.
 * `optional` (tab payment) only checks a token that was sent: the phone's tab
 * code is an unguessable capability and coupon guesses have their own limits,
 * and no client sends a token on that flow, so requiring one would refuse every
 * tab payment on a node with a secret.
 */
async function verifyOrderTurnstile(
	c: Context,
	token: unknown,
	options: { optional?: boolean } = {},
) {
	syncEnvFromProcess()
	const secret = ENV.TURNSTILE_SECRET_KEY ?? ''
	if (!isTurnstileConfigured(secret)) return true
	if (typeof token !== 'string' || !token.trim())
		return options.optional === true
	const result = await verifyTurnstileToken({
		secret,
		token,
		remoteIp: clientIp(c),
		expectedAction: RESTAURANT_TURNSTILE_ACTION,
		expectedHostnames: parseTurnstileHostnames(ENV.TURNSTILE_HOSTNAMES),
	})
	return result.success
}

/**
 * Binds the request to the organization identified by the browser Origin plus
 * slug/host identity — the same rule auth uses. A client-chosen orgId is never
 * accepted, and the org must be served by this node's region.
 */
export async function resolveOrderingOrganization(
	c: Context,
	identity: { slug?: string; host?: string },
): Promise<{ organization: PublishedOrganization } | { error: Response }> {
	const organization = await resolveOrganizationForBrowserAuth(
		c.req.header('Origin'),
		identity,
	)
	if (!organization) {
		return {
			error: Response.json(
				{ error: 'Organization not found' },
				{ status: 404 },
			),
		}
	}
	if (
		!organization.hasProvisionedDb ||
		!orgMatchesNodeRegion(organization.dataRegion)
	) {
		return {
			error: Response.json(
				{ error: 'Organization is not available in this region' },
				{ status: 404 },
			),
		}
	}
	return { organization }
}

/**
 * Optional customer identity: when the browser presents a customer access
 * token it is authenticated and the order is bound to that customer. A
 * browser-supplied customerId is never accepted (strict schema rejects it).
 * An invalid or cross-org token is rejected rather than silently ignored.
 */
async function optionalCustomerId(
	c: Context,
	organization: PublishedOrganization,
): Promise<{ customerId: string | null } | { error: Response }> {
	if (!getBearerToken(c.req.header('Authorization'))) {
		return { customerId: null }
	}
	try {
		const auth = await authenticateCustomer(c)
		if (auth.organization.id !== organization.id) {
			return {
				error: Response.json(
					{ error: 'Customer token does not match this organization' },
					{ status: 403 },
				),
			}
		}
		return { customerId: auth.customerId }
	} catch (response) {
		return { error: response as Response }
	}
}

// ---------------------------------------------------------------------------
// POST /orders — place an order (prices are always re-derived server-side)
// ---------------------------------------------------------------------------

publicOrderRoutes.post('/', async (c) => {
	const contentLength = Number(c.req.header('content-length') ?? 0)
	if (contentLength > MAX_ORDER_BODY_BYTES) {
		return c.json({ error: 'Payload too large' }, 413, noStoreHeaders())
	}

	const rawBody = await c.req.json().catch(() => null)
	const parsed = restaurantOrderRequestSchema.safeParse(rawBody)
	if (!parsed.success) {
		return c.json(
			{
				error: 'invalid_request',
				message: parsed.error.issues[0]?.message ?? 'Invalid order request',
			},
			400,
			noStoreHeaders(),
		)
	}
	const request = parsed.data
	const dineIn = dineInCapability(c)
	if ((request.fulfillment === 'dine_in' || dineIn) && isQrDineInDisabled()) {
		return dineInUnavailable()
	}

	if (
		!(await verifyOrderTurnstile(
			c,
			(rawBody as { turnstileToken?: unknown } | null)?.turnstileToken,
		))
	) {
		return c.json(
			{ error: 'Verification failed. Please try again.' },
			403,
			noStoreHeaders(),
		)
	}

	const organization = await resolveOrderingOrganization(c, {
		slug: request.slug,
		host: request.host,
	})
	if ('error' in organization) return organization.error

	const customer = await optionalCustomerId(c, organization.organization)
	if ('error' in customer) return customer.error

	const couponGuard = await guardCouponGuess(
		organization.organization.id,
		c,
		request.discounts?.code,
		[
			request.locationId,
			request.fulfillment,
			request.dropSlug ?? null,
			request.lines,
		],
		customer.customerId,
	)
	if (couponGuard.blocked) return couponGuard.blocked

	// Table rounds may come without a phone; the durable per-table limit
	// covers them inside the placement transaction.
	const phoneLimit = request.contact.phone
		? rateLimitByKey('order-create-phone', request.contact.phone, {
				maxRequests: 10,
				windowMs: 60 * 60 * 1000,
			})
		: { limited: false as const, retryAfter: 0 }
	if (phoneLimit.limited) {
		await couponGuard.settle({ refused: false })
		return c.json(
			{
				error: 'rate_limit_exceeded',
				message: 'Too many orders. Please try again later.',
				retry_after: phoneLimit.retryAfter,
			},
			429,
			{
				...noStoreHeaders(),
				'Retry-After': String(phoneLimit.retryAfter),
			},
		)
	}

	try {
		const result = await placeOrder({
			organization: organization.organization,
			request,
			customerId: customer.customerId,
			dineIn,
		})
		await couponGuard.settle({
			refused: !result.ok && failureCountsAsCouponGuess(result.failure),
		})
		if (!result.ok) return orderFailureResponse(result.failure)

		const body = {
			order: publicOrderSummary(result.data.order),
			receiptToken: result.data.receiptToken,
			...(result.data.paymentToken
				? { paymentToken: result.data.paymentToken }
				: {}),
			...(result.data.tab ? { tab: result.data.tab } : {}),
		}
		return c.json(body, result.data.status, noStoreHeaders())
	} catch (error) {
		await couponGuard.settle({ refused: false }).catch(() => {})
		console.error(
			`Failed to place order for org ${organization.organization.id}:`,
			error instanceof Error ? error.message : error,
		)
		return c.json(
			{ error: 'internal_error', message: 'We could not place this order.' },
			500,
			noStoreHeaders(),
		)
	}
})

// ---------------------------------------------------------------------------
// POST /orders/quote — price discounts (and a reward, when sent). No hold.
// ---------------------------------------------------------------------------

publicOrderRoutes.post('/quote', async (c) => {
	const contentLength = Number(c.req.header('content-length') ?? 0)
	if (contentLength > MAX_ORDER_BODY_BYTES) {
		return c.json({ error: 'Payload too large' }, 413, noStoreHeaders())
	}
	const rawBody = await c.req.json().catch(() => null)
	const parsed = restaurantOrderDiscountQuoteSchema.safeParse(rawBody)
	if (!parsed.success) {
		return c.json(
			{
				error: 'invalid_request',
				message: parsed.error.issues[0]?.message ?? 'Invalid order request',
			},
			400,
			noStoreHeaders(),
		)
	}
	const request = parsed.data
	if (request.fulfillment === 'dine_in' && isQrDineInDisabled()) {
		return dineInUnavailable()
	}
	const organization = await resolveOrderingOrganization(c, {
		slug: request.slug,
		host: request.host,
	})
	if ('error' in organization) return organization.error
	const customer = await optionalCustomerId(c, organization.organization)
	if ('error' in customer) return customer.error

	const db = await getTenantDb(organization.organization.id)
	const ip = clientIp(c) ?? 'unknown'
	const quoteLimit = await enforceDiscountLimit(
		db,
		'quoteIp',
		`${organization.organization.id}:${ip}`,
	)
	if (!quoteLimit.ok) {
		return c.json(
			{
				error: 'rate_limit_exceeded',
				message: 'Too many price checks. Please try again shortly.',
				retryAfterSeconds: quoteLimit.retryAfterSeconds,
			},
			429,
			{
				...noStoreHeaders(),
				'Retry-After': String(quoteLimit.retryAfterSeconds),
			},
		)
	}
	const couponGuard = await guardCouponGuess(
		organization.organization.id,
		c,
		request.discounts?.code,
		[
			request.locationId,
			request.fulfillment,
			request.dropSlug ?? null,
			request.lines,
		],
		customer.customerId,
	)
	if (couponGuard.blocked) return couponGuard.blocked

	try {
		const result = await quoteOrderDiscounts({
			organization: organization.organization,
			request,
			customerId: customer.customerId,
		})
		// A refused code stays counted; a code that applied, or any other
		// answer, gives the attempt back.
		await couponGuard.settle({
			refused: result.ok
				? couponStatusCountsAsGuess(result.data.coupon)
				: failureCountsAsCouponGuess(result.failure),
		})
		if (!result.ok) return orderFailureResponse(result.failure)
		return c.json(result.data, 200, noStoreHeaders())
	} catch (error) {
		await couponGuard.settle({ refused: false }).catch(() => {})
		console.error(
			`Failed to quote an order for org ${organization.organization.id}:`,
			error instanceof Error ? error.message : error,
		)
		return c.json(
			{ error: 'internal_error', message: 'We could not price this order.' },
			500,
			noStoreHeaders(),
		)
	}
})

// ---------------------------------------------------------------------------
// GET /orders/options — public capability + availability, no PII
// ---------------------------------------------------------------------------

const optionsQuerySchema = z.object({
	slug: z.string().trim().min(1).max(100).optional(),
	host: z.string().trim().min(1).max(253).optional(),
	locationId: z.string().trim().min(1).max(100),
	dropSlug: z.string().trim().min(1).max(120).optional(),
})

publicOrderRoutes.get('/options', async (c) => {
	const parsed = optionsQuerySchema.safeParse(c.req.query())
	if (!parsed.success) {
		return c.json(
			{ error: 'invalid_request', message: 'Invalid ordering options request' },
			400,
			noStoreHeaders(),
		)
	}
	const organization = await resolveOrderingOrganization(c, {
		slug: parsed.data.slug,
		host: parsed.data.host,
	})
	if ('error' in organization) return organization.error

	const dineIn = dineInCapability(c)
	if (dineIn && isQrDineInDisabled()) return dineInUnavailable()

	try {
		const result = await buildOrderingOptionsWithContext(
			organization.organization,
			{
				slug: parsed.data.slug ?? null,
				locationId: parsed.data.locationId,
				dropSlug: parsed.data.dropSlug ?? null,
			},
		)
		if (!result.ok) return orderFailureResponse(result.failure)
		const { options, context } = result.data
		if (!dineIn) return c.json(options, 200, noStoreHeaders())
		// A scanned table adds its label, the dine-in policy and the open tab
		// (so a re-scan resumes it). The QR flags come from the same fresh
		// order context the placement path reads.
		const table = await getTableContext(organization.organization.id, {
			capability: dineIn,
			locationId: parsed.data.locationId,
			context,
		})
		if (!table.ok) return orderFailureResponse(table.failure)
		return c.json({ ...options, ...table.data }, 200, noStoreHeaders())
	} catch (error) {
		console.error(
			`Failed to build ordering options for org ${organization.organization.id}:`,
			error instanceof Error ? error.message : error,
		)
		return c.json(
			{
				error: 'internal_error',
				message: 'Ordering is unavailable right now.',
			},
			500,
			noStoreHeaders(),
		)
	}
})

// ---------------------------------------------------------------------------
// GET /orders/tab — the open (or settled) tab behind an X-Tab-Token
// ---------------------------------------------------------------------------

publicOrderRoutes.get('/tab', async (c) => {
	const identitySchema = z.object({
		slug: z.string().trim().min(1).max(100).optional(),
		host: z.string().trim().min(1).max(253).optional(),
	})
	const identity = identitySchema.safeParse(c.req.query())
	if (!identity.success) {
		return c.json({ error: 'Organization not found' }, 404, noStoreHeaders())
	}
	if (isQrDineInDisabled()) return dineInUnavailable()
	const organization = await resolveOrderingOrganization(c, identity.data)
	if ('error' in organization) return organization.error

	const tabToken = c.req.header(QR_TAB_TOKEN_HEADER)?.trim()
	if (!tabToken) {
		// Not a 401: that status means the customer's token was refused (Sites
		// signs the customer out on it). A missing tab code reads like a wrong one.
		return c.json(
			{ error: 'tab_not_found', message: 'A tab code is required.' },
			404,
			noStoreHeaders(),
		)
	}
	// A customer token is optional: a signed-in guest may qualify for
	// discounts a guest does not, and the tab shows what they would get.
	const customer = await optionalCustomerId(c, organization.organization)
	if ('error' in customer) return customer.error
	try {
		const result = await getPublicTab(organization.organization.id, tabToken)
		if (!result.ok) return orderFailureResponse(result.failure)
		const [shown] = await withTabDiscounts(
			organization.organization.id,
			[result.data],
			{ customerId: customer.customerId },
		)
		return c.json({ tab: shown ?? result.data }, 200, noStoreHeaders())
	} catch (error) {
		console.error(
			`Failed to load tab for org ${organization.organization.id}:`,
			error instanceof Error ? error.message : error,
		)
		return c.json(
			{ error: 'internal_error', message: 'We could not load this tab.' },
			500,
			noStoreHeaders(),
		)
	}
})

// ---------------------------------------------------------------------------
// POST /orders/tab/pay — the guest pays the tab from the phone
// ---------------------------------------------------------------------------

publicOrderRoutes.post('/tab/pay', async (c) => {
	if (isQrDineInDisabled()) return dineInUnavailable()
	const parsed = qrTabPayRequestSchema.safeParse(
		await c.req.json().catch(() => null),
	)
	if (!parsed.success) {
		return c.json(
			{
				error: 'invalid_request',
				message: parsed.error.issues[0]?.message ?? 'Invalid request',
			},
			400,
			noStoreHeaders(),
		)
	}
	if (
		!(await verifyOrderTurnstile(c, parsed.data.turnstileToken, {
			optional: true,
		}))
	) {
		return c.json(
			{ error: 'Verification failed. Please try again.' },
			403,
			noStoreHeaders(),
		)
	}

	const organization = await resolveOrderingOrganization(c, {
		slug: parsed.data.slug,
		host: parsed.data.host,
	})
	if ('error' in organization) return organization.error
	const tabToken = c.req.header(QR_TAB_TOKEN_HEADER)?.trim()
	if (!tabToken) {
		// Not a 401: that status means the customer's token was refused (Sites
		// signs the customer out on it). A missing tab code reads like a wrong one.
		return c.json(
			{ error: 'tab_not_found', message: 'A tab code is required.' },
			404,
			noStoreHeaders(),
		)
	}
	// A customer token is optional here: a signed-in member collects the
	// tab's points, and only a signed-in member may spend a reward on it.
	const customer = await optionalCustomerId(c, organization.organization)
	if ('error' in customer) return customer.error
	const orgId = organization.organization.id
	const couponGuard = await guardCouponGuess(
		orgId,
		c,
		parsed.data.discounts?.code,
		['tab', tabToken],
		customer.customerId,
	)
	if (couponGuard.blocked) return couponGuard.blocked
	try {
		// The tab's own location decides whether online payment is on.
		const tab = await getPublicTab(orgId, tabToken)
		if (!tab.ok) {
			await couponGuard.settle({ refused: false })
			return orderFailureResponse(tab.failure)
		}
		const context = await fetchOrderContext(
			orgId,
			tab.data.table.locationId,
			null,
		)
		if (!context.ok) {
			await couponGuard.settle({ refused: false })
			return orderFailureResponse(context.failure)
		}
		const features = readQrOrderingFeatures(
			(context.data as { qrOrdering?: unknown }).qrOrdering,
		)
		const result = await prepareTabPayment(orgId, tabToken, {
			tipPercent: parsed.data.tipPercent,
			contact: parsed.data.contact,
			features,
			onlinePayment: context.data.onlinePayment,
			customerId: customer.customerId,
			loyalty: parsed.data.loyalty ?? null,
			context: context.data,
			discounts: parsed.data.discounts ?? null,
		})
		await couponGuard.settle({
			refused: !result.ok && failureCountsAsCouponGuess(result.failure),
		})
		if (!result.ok) return orderFailureResponse(result.failure)
		return c.json(result.data, 200, noStoreHeaders())
	} catch (error) {
		await couponGuard.settle({ refused: false }).catch(() => {})
		console.error(
			`Failed to start tab payment for org ${orgId}:`,
			error instanceof Error ? error.message : error,
		)
		return c.json(
			{ error: 'internal_error', message: 'We could not start the payment.' },
			500,
			noStoreHeaders(),
		)
	}
})

// ---------------------------------------------------------------------------
// GET /orders/:id — authoritative receipt (secret capability, origin checked)
// ---------------------------------------------------------------------------

publicOrderRoutes.get('/:id', async (c) => {
	const identitySchema = z.object({
		slug: z.string().trim().min(1).max(100).optional(),
		host: z.string().trim().min(1).max(253).optional(),
	})
	const identity = identitySchema.safeParse(c.req.query())
	if (!identity.success) {
		return c.json({ error: 'Organization not found' }, 404, noStoreHeaders())
	}
	const organization = await resolveOrderingOrganization(c, identity.data)
	if ('error' in organization) return organization.error

	const receiptToken = getBearerToken(c.req.header('Authorization'))
	if (!receiptToken) {
		return c.json(
			{ error: 'unauthorized', message: 'A receipt token is required.' },
			401,
			noStoreHeaders(),
		)
	}

	try {
		const result = await getOrderReceipt(
			organization.organization.id,
			c.req.param('id'),
			receiptToken,
		)
		if (!result.ok) return orderFailureResponse(result.failure)
		return c.json(
			{ order: receiptOrder(result.data.order) },
			200,
			noStoreHeaders(),
		)
	} catch (error) {
		console.error(
			`Failed to load order receipt for org ${organization.organization.id}:`,
			error instanceof Error ? error.message : error,
		)
		return c.json(
			{ error: 'internal_error', message: 'We could not load this order.' },
			500,
			noStoreHeaders(),
		)
	}
})
