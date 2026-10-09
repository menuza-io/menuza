import { Hono, type Context } from 'hono'
import { ENV } from 'varlock/env'

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
import { rateLimitByKey } from '../lib/rate-limit.ts'
import { orgMatchesNodeRegion } from '../lib/region.ts'
import { getBearerToken, syncEnvFromProcess } from '../lib/secrets.ts'
import {
	buildOrderingOptions,
	getOrderReceipt,
	placeOrder,
	publicOrderSummary,
	receiptOrder,
	type OrderServiceFailure,
} from '../services/order-service.ts'
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

	const phoneLimit = rateLimitByKey(
		'order-create-phone',
		request.contact.phone,
		{
			maxRequests: 10,
			windowMs: 60 * 60 * 1000,
		},
	)
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
		})
		if (!result.ok) return orderFailureResponse(result.failure)

		const body = {
			order: publicOrderSummary(result.data.order),
			receiptToken: result.data.receiptToken,
			...(result.data.paymentToken
				? { paymentToken: result.data.paymentToken }
				: {}),
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

	try {
		const result = await buildOrderingOptions(organization.organization, {
			slug: parsed.data.slug ?? null,
			locationId: parsed.data.locationId,
			dropSlug: parsed.data.dropSlug ?? null,
		})
		if (!result.ok) return orderFailureResponse(result.failure)
		return c.json(result.data, 200, noStoreHeaders())
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
