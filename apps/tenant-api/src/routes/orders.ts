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
	restaurantOrderRequestSchema,
} from '@repo/common/restaurant-orders'
import {
	isTurnstileConfigured,
	parseTurnstileHostnames,
	verifyTurnstileToken,
} from '@repo/common/turnstile'
import { z } from 'zod'

import {
	resolveOrganizationForBrowserAuth,
	type PublishedOrganization,
} from '../lib/origin.ts'
import { isQrDineInDisabled } from '../lib/qr-tokens.ts'
import { rateLimitByKey } from '../lib/rate-limit.ts'
import { orgMatchesNodeRegion } from '../lib/region.ts'
import { getBearerToken, syncEnvFromProcess } from '../lib/secrets.ts'
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
	checkTabDineInFlag,
	getPublicTab,
	getTableContext,
	prepareTabPayment,
} from '../services/qr-tab-service.ts'
import { authenticateCustomer } from './auth.ts'

export const publicOrderRoutes = new Hono()

const MAX_ORDER_BODY_BYTES = 200_000

function orderFailureResponse(failure: OrderServiceFailure) {
	return Response.json(
		{ error: failure.code, message: failure.message },
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
	const forwardedFor = c.req.header('x-forwarded-for')
	return forwardedFor
		? forwardedFor.split(',')[0]?.trim() || undefined
		: undefined
}

async function verifyOrderTurnstile(c: Context, token: unknown) {
	syncEnvFromProcess()
	const secret = ENV.TURNSTILE_SECRET_KEY ?? ''
	if (!isTurnstileConfigured(secret)) return true
	if (typeof token !== 'string' || !token.trim()) return false
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

	// Table rounds may come without a phone; the durable per-table limit
	// covers them inside the placement transaction.
	const phoneLimit = request.contact.phone
		? rateLimitByKey('order-create-phone', request.contact.phone, {
				maxRequests: 10,
				windowMs: 60 * 60 * 1000,
			})
		: { limited: false as const, retryAfter: 0 }
	if (phoneLimit.limited) {
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
		return c.json(
			{ error: 'unauthorized', message: 'A tab code is required.' },
			401,
			noStoreHeaders(),
		)
	}
	try {
		const result = await getPublicTab(organization.organization.id, tabToken)
		if (!result.ok) return orderFailureResponse(result.failure)
		// The QR flags come from the tab location's fresh order context, like
		// placement: with dine-in off the tab is not served.
		const flagDenied = await checkTabDineInFlag(
			organization.organization.id,
			result.data.table.locationId,
		)
		if (flagDenied) return orderFailureResponse(flagDenied)
		return c.json({ tab: result.data }, 200, noStoreHeaders())
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
	const organization = await resolveOrderingOrganization(c, {
		slug: parsed.data.slug,
		host: parsed.data.host,
	})
	if ('error' in organization) return organization.error
	const tabToken = c.req.header(QR_TAB_TOKEN_HEADER)?.trim()
	if (!tabToken) {
		return c.json(
			{ error: 'unauthorized', message: 'A tab code is required.' },
			401,
			noStoreHeaders(),
		)
	}
	const orgId = organization.organization.id
	try {
		// The tab's own location decides whether online payment is on.
		const tab = await getPublicTab(orgId, tabToken)
		if (!tab.ok) return orderFailureResponse(tab.failure)
		const context = await fetchOrderContext(
			orgId,
			tab.data.table.locationId,
			null,
		)
		if (!context.ok) return orderFailureResponse(context.failure)
		const features = readQrOrderingFeatures(
			(context.data as { qrOrdering?: unknown }).qrOrdering,
		)
		const result = await prepareTabPayment(orgId, tabToken, {
			tipPercent: parsed.data.tipPercent,
			contact: parsed.data.contact,
			features,
			onlinePayment: context.data.onlinePayment,
		})
		if (!result.ok) return orderFailureResponse(result.failure)
		return c.json(result.data, 200, noStoreHeaders())
	} catch (error) {
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
