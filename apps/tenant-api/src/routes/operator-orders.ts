import { Hono, type Context } from 'hono'
import { jwtVerify } from 'jose'
import { z } from 'zod'

import {
	operatorOrderPatchSchema,
	operatorOrderRefundRequestSchema,
} from '@repo/common/restaurant-orders'
import { brand } from '@repo/config/brand'
import {
	getTenantDb,
	TENANT_ORG_ID_PATTERN,
	type RestaurantOrder,
} from '@repo/tenant-db'

import { errorLogFields } from '../lib/error-log.ts'
import { findActiveOrganizationById } from '../lib/origin.ts'
import { getNodeRegion, orgMatchesNodeRegion } from '../lib/region.ts'
import { readIdempotencyKey } from '../lib/reservations-public-auth.ts'
import { getBearerToken, getOperatorToken } from '../lib/secrets.ts'
import {
	listOrderRefunds,
	operatorOrderRefund,
	recordOrderRefund,
} from '../services/order-refund-service.ts'
import {
	getOperatorOrder,
	listOperatorOrders,
	operatorOrder,
	updateOperatorOrder,
} from '../services/order-service.ts'
import {
	resolveOrderCustomerKeys,
	type OrderLinkAccess,
} from '../services/order-customer-link.ts'

export const operatorOrderRoutes = new Hono()

const OPERATOR_LIST_LIMIT = 100

export type OperatorOrderAuth = {
	orgId: string
	/** The signed-in operator the token was minted for. */
	userId: string
	role: string
	scope: 'orders:read' | 'orders:write'
	/** Signed claims from App: which person pages the operator may open. */
	link: OrderLinkAccess
	/**
	 * Signed claims from App: which Station apps this operator may switch on for
	 * a terminal (each needs its own module's settings permission), whether they
	 * may give a host guest details, and at which locations (null: all).
	 */
	stationApps: StationAppClaims
	/**
	 * Locations whose orders this token reaches; null is every location.
	 * Mirrors the member's location scope in the App.
	 */
	locationIds: string[] | null
	/**
	 * May record a refund on an order that loyalty tracks (it takes points back
	 * and restores rewards): App signs it only for holders of
	 * `update:loyalty_redemption:any`, never when impersonating.
	 */
	refundLoyalty: boolean
	impersonated: boolean
}

export type StationAppClaims = {
	timeclock: boolean
	reservations: boolean
	guestDetails: boolean
	locationIds: string[] | null
	/** Staffing workplaces where the time clock may be switched on; null is all. */
	scopeIds: string[] | null
}

/** Reads the claim fail-closed: anything missing or malformed allows nothing. */
function readStationApps(raw: unknown): StationAppClaims {
	const claim = (raw ?? {}) as Record<string, unknown>
	const ids = (value: unknown) =>
		value === null
			? null
			: Array.isArray(value)
				? value.filter((id): id is string => typeof id === 'string')
				: []
	return {
		timeclock: claim.timeclock === true,
		reservations: claim.reservations === true,
		guestDetails: claim.guestDetails === true,
		locationIds: ids(claim.locationIds),
		scopeIds: ids(claim.scopeIds),
	}
}

/**
 * Tokens from an App that predates the claim carry none and keep reaching
 * every location, as they did before; a claim that is present but malformed
 * reaches none.
 */
function readOrderLocationIds(
	payload: Record<string, unknown>,
): string[] | null {
	if (!('locationIds' in payload) || payload.locationIds === null) return null
	const value = payload.locationIds
	if (!Array.isArray(value)) return []
	return value.filter((id): id is string => typeof id === 'string')
}

function orderVisible(auth: OperatorOrderAuth, locationId: string): boolean {
	return auth.locationIds === null || auth.locationIds.includes(locationId)
}

const ORDER_NOT_FOUND = {
	error: 'order_not_found',
	message: 'Order not found.',
} as const

/**
 * Operator JWT authentication with separately enforced read/write scopes.
 * `orders:read` may list and inspect; `orders:write` is required for any
 * lifecycle change. Both scopes are minted by App after menu-read /
 * menu-write authorization, and this node verifies only its own
 * TENANT_OPERATOR_TOKEN audience.
 */
export async function authenticateOrdersOperator(
	c: Context,
	required: 'orders:read' | 'orders:write',
): Promise<{ auth: OperatorOrderAuth } | { error: Response }> {
	const token = getBearerToken(c.req.header('Authorization'))
	if (!token) {
		return {
			error: Response.json({ error: 'Unauthorized' }, { status: 401 }),
		}
	}
	const operatorToken = getOperatorToken()
	if (operatorToken.length < 16) {
		return {
			error: Response.json({ error: 'Not configured' }, { status: 503 }),
		}
	}

	let decoded: {
		sub?: string
		orgId?: string
		role?: string
		scope?: string
		linkCustomers?: boolean
		linkGuests?: boolean
		stationApps?: unknown
		locationIds?: unknown
		refundLoyalty?: boolean
		impersonated?: boolean
	}
	try {
		const secret = new TextEncoder().encode(operatorToken)
		const { payload } = await jwtVerify(token, secret, {
			audience: 'tenant-api-operator',
			issuer: brand.shortName,
		})
		decoded = payload as typeof decoded
	} catch {
		return {
			error: Response.json({ error: 'Unauthorized' }, { status: 401 }),
		}
	}

	if (!decoded.orgId || !TENANT_ORG_ID_PATTERN.test(decoded.orgId)) {
		return { error: Response.json({ error: 'Unauthorized' }, { status: 401 }) }
	}
	if (decoded.role !== 'operator') {
		return { error: Response.json({ error: 'Invalid role' }, { status: 403 }) }
	}
	if (decoded.scope !== 'orders:read' && decoded.scope !== 'orders:write') {
		return {
			error: Response.json({ error: 'Missing orders scope' }, { status: 403 }),
		}
	}
	if (required === 'orders:write' && decoded.scope !== 'orders:write') {
		return {
			error: Response.json(
				{ error: 'Write scope required for this action' },
				{ status: 403 },
			),
		}
	}
	return {
		auth: {
			orgId: decoded.orgId,
			userId: decoded.sub ?? 'unknown',
			role: decoded.role,
			scope: decoded.scope,
			link: {
				linkCustomers: decoded.linkCustomers === true,
				linkGuests: decoded.linkGuests === true,
			},
			stationApps: readStationApps(decoded.stationApps),
			locationIds: readOrderLocationIds(decoded),
			refundLoyalty: decoded.refundLoyalty === true,
			impersonated: decoded.impersonated === true,
		},
	}
}

async function withCustomerKeys(
	auth: OperatorOrderAuth,
	orders: RestaurantOrder[],
) {
	if (!auth.link.linkCustomers && !auth.link.linkGuests) {
		return orders.map((order) => operatorOrder(order))
	}
	const db = await getTenantDb(auth.orgId)
	const keys = await resolveOrderCustomerKeys(db, orders, auth.link)
	return orders.map((order) => operatorOrder(order, keys.get(order.id) ?? null))
}

/**
 * Region + provisioning fail-closed check for operator access, mirroring the
 * other operator surfaces. Responses are always `private, no-store`.
 */
export async function assertOperatorOrg(
	orgId: string,
): Promise<{ error: Response } | null> {
	const nodeRegion = getNodeRegion()
	const organization = await findActiveOrganizationById(orgId)
	if (!organization) {
		return {
			error: Response.json(
				{ error: 'Organization not found' },
				{ status: 404 },
			),
		}
	}
	if (!orgMatchesNodeRegion(organization.dataRegion)) {
		return {
			error: Response.json(
				{
					error: 'region_mismatch',
					message: `Organization dataRegion "${organization.dataRegion}" does not match this node ("${nodeRegion}")`,
				},
				{ status: 409 },
			),
		}
	}
	if (!organization.hasProvisionedDb) {
		return {
			error: Response.json(
				{ error: 'Organization is not provisioned in this region' },
				{ status: 404 },
			),
		}
	}
	return null
}

function noStoreHeaders() {
	return { 'Cache-Control': 'private, no-store' }
}

function orderStatus(value: string): RestaurantOrder['status'] | null {
	const allowed: RestaurantOrder['status'][] = [
		'accepted',
		'preparing',
		'ready',
		'completed',
		'cancelled',
		'expired',
		'payment_review',
	]
	return allowed.includes(value as RestaurantOrder['status'])
		? (value as RestaurantOrder['status'])
		: null
}

const listQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(200).optional(),
	status: z.string().trim().min(1).max(40).optional(),
})

operatorOrderRoutes.get('/', async (c) => {
	const auth = await authenticateOrdersOperator(c, 'orders:read')
	if ('error' in auth) return auth.error
	const denied = await assertOperatorOrg(auth.auth.orgId)
	if (denied) return denied.error

	const parsed = listQuerySchema.safeParse(c.req.query())
	if (!parsed.success) {
		return c.json({ error: 'Invalid query' }, 400, noStoreHeaders())
	}
	const status = parsed.data.status ? orderStatus(parsed.data.status) : null
	if (parsed.data.status && !status) {
		return c.json({ error: 'Invalid status filter' }, 400, noStoreHeaders())
	}

	try {
		const orders = await listOperatorOrders(auth.auth.orgId, {
			limit: parsed.data.limit ?? OPERATOR_LIST_LIMIT,
			status: status ?? undefined,
			locationIds: auth.auth.locationIds,
		})
		return c.json(
			{ orders: await withCustomerKeys(auth.auth, orders) },
			200,
			noStoreHeaders(),
		)
	} catch (error) {
		console.error(
			`Failed to list orders for org ${auth.auth.orgId}:`,
			error instanceof Error ? error.message : error,
		)
		return c.json(
			{ error: 'Tenant Database unavailable' },
			500,
			noStoreHeaders(),
		)
	}
})

operatorOrderRoutes.get('/:id', async (c) => {
	const auth = await authenticateOrdersOperator(c, 'orders:read')
	if ('error' in auth) return auth.error
	const denied = await assertOperatorOrg(auth.auth.orgId)
	if (denied) return denied.error

	try {
		const result = await getOperatorOrder(auth.auth.orgId, c.req.param('id'))
		if (!result.ok) {
			return c.json(
				{ error: result.failure.code, message: result.failure.message },
				result.failure.status as 404 | 500,
				noStoreHeaders(),
			)
		}
		if (!orderVisible(auth.auth, result.data.locationId)) {
			return c.json(ORDER_NOT_FOUND, 404, noStoreHeaders())
		}
		const [order] = await withCustomerKeys(auth.auth, [result.data])
		const refunds = await listOrderRefunds(auth.auth.orgId, result.data.id)
		return c.json(
			{ order: { ...order, refunds: refunds.map(operatorOrderRefund) } },
			200,
			noStoreHeaders(),
		)
	} catch (error) {
		console.error(
			`Failed to load order for org ${auth.auth.orgId}:`,
			error instanceof Error ? error.message : error,
		)
		return c.json(
			{ error: 'Tenant Database unavailable' },
			500,
			noStoreHeaders(),
		)
	}
})

operatorOrderRoutes.patch('/:id', async (c) => {
	const auth = await authenticateOrdersOperator(c, 'orders:write')
	if ('error' in auth) return auth.error
	const denied = await assertOperatorOrg(auth.auth.orgId)
	if (denied) return denied.error

	const parsed = operatorOrderPatchSchema.safeParse(
		await c.req.json().catch(() => null),
	)
	if (!parsed.success) {
		return c.json(
			{ error: parsed.error.issues[0]?.message ?? 'Invalid update' },
			400,
			noStoreHeaders(),
		)
	}

	try {
		if (auth.auth.locationIds !== null) {
			const current = await getOperatorOrder(auth.auth.orgId, c.req.param('id'))
			if (!current.ok || !orderVisible(auth.auth, current.data.locationId)) {
				return c.json(ORDER_NOT_FOUND, 404, noStoreHeaders())
			}
		}
		const result = await updateOperatorOrder(
			auth.auth.orgId,
			c.req.param('id'),
			parsed.data,
		)
		if (!result.ok) {
			return c.json(
				{ error: result.failure.code, message: result.failure.message },
				result.failure.status as 400 | 404 | 409 | 422 | 500,
				noStoreHeaders(),
			)
		}
		const [order] = await withCustomerKeys(auth.auth, [result.data])
		return c.json({ order }, 200, noStoreHeaders())
	} catch (error) {
		console.error(
			`Failed to update order for org ${auth.auth.orgId}:`,
			error instanceof Error ? error.message : error,
		)
		return c.json(
			{ error: 'Tenant Database unavailable' },
			500,
			noStoreHeaders(),
		)
	}
})

/**
 * Records money returned for a paid online order. A record only: the refund
 * itself happens in the payment provider's dashboard. Loyalty takes its
 * points back from the order's refunded total, whatever its flags say.
 */
operatorOrderRoutes.post('/:id/refunds', async (c) => {
	const auth = await authenticateOrdersOperator(c, 'orders:write')
	if ('error' in auth) return auth.error
	const denied = await assertOperatorOrg(auth.auth.orgId)
	if (denied) return denied.error

	const idempotencyKey = readIdempotencyKey(c)
	if (!idempotencyKey) {
		return c.json(
			{
				error: 'idempotency_key_required',
				message: 'An Idempotency-Key header is required.',
			},
			400,
			noStoreHeaders(),
		)
	}
	const parsed = operatorOrderRefundRequestSchema.safeParse(
		await c.req.json().catch(() => null),
	)
	if (!parsed.success) {
		return c.json(
			{
				error: 'invalid_refund',
				message: 'Give an amount or refund everything, with a note.',
			},
			400,
			noStoreHeaders(),
		)
	}

	try {
		const current = await getOperatorOrder(auth.auth.orgId, c.req.param('id'))
		if (!current.ok || !orderVisible(auth.auth, current.data.locationId)) {
			return c.json(ORDER_NOT_FOUND, 404, noStoreHeaders())
		}
		const result = await recordOrderRefund(auth.auth.orgId, c.req.param('id'), {
			request: parsed.data,
			actorId: auth.auth.userId,
			idempotencyKey,
			loyaltyAccess: {
				refundLoyalty: auth.auth.refundLoyalty,
				impersonated: auth.auth.impersonated,
			},
		})
		if (!result.ok) {
			return c.json(
				{
					error: result.failure.code,
					message: result.failure.message,
					...result.failure.details,
				},
				result.failure.status as 403 | 404 | 409 | 422,
				noStoreHeaders(),
			)
		}
		const [order] = await withCustomerKeys(auth.auth, [result.data.order])
		const refunds = await listOrderRefunds(
			auth.auth.orgId,
			result.data.order.id,
		)
		return c.json(
			{
				order: { ...order, refunds: refunds.map(operatorOrderRefund) },
				refund: operatorOrderRefund(result.data.refund),
				replayed: result.data.replayed,
			},
			result.data.replayed ? 200 : 201,
			noStoreHeaders(),
		)
	} catch (error) {
		console.error(
			`Failed to record a refund for org ${auth.auth.orgId}:`,
			errorLogFields(error),
		)
		return c.json(
			{ error: 'Tenant Database unavailable' },
			500,
			noStoreHeaders(),
		)
	}
})
