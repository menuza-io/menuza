import { Hono, type Context } from 'hono'
import { jwtVerify } from 'jose'
import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'

import {
	operatorDailyDishChangeSchema,
	operatorDailyDishStatusQuerySchema,
} from '@repo/common/daily-dish-limits'
import {
	operatorOrderPatchSchema,
	operatorOrderRefundRequestSchema,
	operatorSlotLimitsResetSchema,
	operatorSlotLimitsTodayQuerySchema,
} from '@repo/common/restaurant-orders'
import { brand } from '@repo/config/brand'
import {
	getTenantDb,
	restaurantOrders,
	TENANT_ORG_ID_PATTERN,
	type RestaurantOrder,
} from '@repo/tenant-db'

import { errorLogFields } from '../lib/error-log.ts'
import { findActiveOrganizationById } from '../lib/origin.ts'
import { getNodeRegion, orgMatchesNodeRegion } from '../lib/region.ts'
import { readIdempotencyKey } from '../lib/reservations-public-auth.ts'
import { getBearerToken, getOperatorToken } from '../lib/secrets.ts'
import {
	listRefundsForOrders,
	operatorOrderRefund,
	operatorOrderRefundFields,
	recordOrderRefund,
} from '../services/order-refund-service.ts'
import {
	fetchOrderContext,
	getOperatorOrder,
	listOperatorOrders,
	operatorOrder,
	updateOperatorOrderWithRefund,
} from '../services/order-service.ts'
import {
	adjustDailyDish,
	getOperatorDailyDishStatus,
} from '../services/order-dish-daily-operator.ts'
import {
	getOperatorSlotLimitsToday,
	resetOperatorSlotLimits,
} from '../services/order-slot-limits-service.ts'
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
	/**
	 * May start a refund through the payment provider with a cancel
	 * (`refund: 'full'` on PATCH): App signs it only for holders of
	 * `update:order_refund:any`, never when impersonating. Absent reads as
	 * false (fail closed).
	 */
	refundProvider: boolean
	impersonated: boolean
}

export type StationAppClaims = {
	timeclock: boolean
	reservations: boolean
	/**
	 * May switch the Stock app on for a terminal (`update:inventory:any` with
	 * `inventory.enabled`). Absent from a token minted by an App that predates
	 * it, which reads as false: fail closed, so deploy App before tenant-api.
	 */
	inventory: boolean
	/** Locations where Stock may be switched on; null is all (and meaningless while `inventory` is false). */
	inventoryLocationIds: string[] | null
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
		inventory: claim.inventory === true,
		inventoryLocationIds: ids(claim.inventoryLocationIds),
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
		area?: unknown
		linkCustomers?: boolean
		linkGuests?: boolean
		stationApps?: unknown
		locationIds?: unknown
		refundLoyalty?: boolean
		refundProvider?: boolean
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
	// A browser token bound to another page's area (see `authenticateOperator`)
	// never reaches orders or the till.
	if (decoded.area !== undefined) {
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
			// Never with impersonation, whatever the token says.
			refundProvider:
				decoded.refundProvider === true && decoded.impersonated !== true,
			impersonated: decoded.impersonated === true,
		},
	}
}

/**
 * The operator JSON of each order with its refunds: the rows, what waits on
 * the payment provider, what is still refundable and the summary status.
 */
async function withCustomerKeys(
	auth: OperatorOrderAuth,
	orders: RestaurantOrder[],
) {
	const refunds = await listRefundsForOrders(
		auth.orgId,
		orders.map((order) => order.id),
	)
	const keys =
		auth.link.linkCustomers || auth.link.linkGuests
			? await resolveOrderCustomerKeys(
					await getTenantDb(auth.orgId),
					orders,
					auth.link,
				)
			: null
	return orders.map((order) => {
		const fields = operatorOrderRefundFields(order, refunds.get(order.id) ?? [])
		return {
			...operatorOrder(order, keys?.get(order.id) ?? null, {
				refundStatus: fields.refundStatus,
				pendingCents: fields.refundPendingCents,
			}),
			...fields,
		}
	})
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
		// Waiting for a person to accept (#107): the Orders page badge.
		'pending_acceptance',
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
			{
				orders: await withCustomerKeys(auth.auth, orders),
				// This node's clock: the operator screens count down to deadlines
				// it set (such as the time left to accept) against it, not against
				// a computer clock that may be minutes off.
				serverNow: Date.now(),
			},
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

/**
 * Counts for the home page's Needs attention feed: orders waiting in
 * "Payment needs review", per location the token may see. Counts only, no
 * order or guest field. Registered before `/:id`.
 */
operatorOrderRoutes.get('/limits/today', async (c) => {
	const auth = await authenticateOrdersOperator(c, 'orders:read')
	if ('error' in auth) return auth.error
	const denied = await assertOperatorOrg(auth.auth.orgId)
	if (denied) return denied.error
	const parsed = operatorSlotLimitsTodayQuerySchema.safeParse(c.req.query())
	if (!parsed.success) {
		return c.json({ error: 'invalid_request' }, 400, noStoreHeaders())
	}
	if (!orderVisible(auth.auth, parsed.data.locationId)) {
		return c.json({ error: 'location_not_found' }, 404, noStoreHeaders())
	}
	const contextResult = await fetchOrderContext(
		auth.auth.orgId,
		parsed.data.locationId,
		null,
	)
	if (!contextResult.ok) {
		return c.json(
			{
				error: contextResult.failure.code,
				message: contextResult.failure.message,
			},
			contextResult.failure.status as 503,
			noStoreHeaders(),
		)
	}
	try {
		const body = await getOperatorSlotLimitsToday(
			auth.auth.orgId,
			contextResult.data,
			parsed.data.locationId,
			parsed.data.fulfillment,
		)
		if (!body) {
			return c.json({ error: 'slot_limits_disabled' }, 404, noStoreHeaders())
		}
		return c.json(body, 200, noStoreHeaders())
	} catch (error) {
		console.error(
			`Failed to load slot limits for org ${auth.auth.orgId}:`,
			error instanceof Error ? error.message : error,
		)
		return c.json(
			{ error: 'Tenant Database unavailable' },
			500,
			noStoreHeaders(),
		)
	}
})

operatorOrderRoutes.post('/limits/reset', async (c) => {
	const auth = await authenticateOrdersOperator(c, 'orders:write')
	if ('error' in auth) return auth.error
	const denied = await assertOperatorOrg(auth.auth.orgId)
	if (denied) return denied.error
	if (auth.auth.impersonated) {
		return c.json(
			{ error: 'forbidden', message: 'Not allowed while impersonating.' },
			403,
			noStoreHeaders(),
		)
	}
	let body: unknown
	try {
		body = await c.req.json()
	} catch {
		return c.json({ error: 'invalid_request' }, 400, noStoreHeaders())
	}
	const parsed = operatorSlotLimitsResetSchema.safeParse(body)
	if (!parsed.success) {
		return c.json({ error: 'invalid_request' }, 400, noStoreHeaders())
	}
	if (!orderVisible(auth.auth, parsed.data.locationId)) {
		return c.json({ error: 'location_not_found' }, 404, noStoreHeaders())
	}
	try {
		const result = await resetOperatorSlotLimits({
			orgId: auth.auth.orgId,
			locationId: parsed.data.locationId,
		})
		if (!result.ok) {
			return c.json(
				{ error: result.failure.code, message: result.failure.message },
				result.failure.status,
				noStoreHeaders(),
			)
		}
		return c.json(
			{ ok: true, slotsCleared: result.slotsCleared },
			200,
			noStoreHeaders(),
		)
	} catch (error) {
		console.error(
			`Failed to reset slot limits for org ${auth.auth.orgId}:`,
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
 * Daily dish limits (#409): today's figures for every capped dish and option
 * at one location, and the manager's top-up. Ids and counts only. Registered
 * before `/:id`.
 */
operatorOrderRoutes.get('/daily-limits', async (c) => {
	const auth = await authenticateOrdersOperator(c, 'orders:read')
	if ('error' in auth) return auth.error
	const denied = await assertOperatorOrg(auth.auth.orgId)
	if (denied) return denied.error
	const parsed = operatorDailyDishStatusQuerySchema.safeParse(c.req.query())
	if (!parsed.success) {
		return c.json({ error: 'invalid_request' }, 400, noStoreHeaders())
	}
	if (!orderVisible(auth.auth, parsed.data.locationId)) {
		return c.json({ error: 'location_not_found' }, 404, noStoreHeaders())
	}
	try {
		const result = await getOperatorDailyDishStatus({
			orgId: auth.auth.orgId,
			locationId: parsed.data.locationId,
		})
		if (!result.ok) {
			return c.json(
				{ error: result.failure.code, message: result.failure.message },
				result.failure.status,
				noStoreHeaders(),
			)
		}
		return c.json(result.data, 200, noStoreHeaders())
	} catch (error) {
		console.error(
			`Failed to load daily dish limits for org ${auth.auth.orgId}:`,
			error instanceof Error ? error.message : error,
		)
		return c.json(
			{ error: 'Tenant Database unavailable' },
			500,
			noStoreHeaders(),
		)
	}
})

operatorOrderRoutes.post('/daily-limits/top-up', async (c) => {
	const auth = await authenticateOrdersOperator(c, 'orders:write')
	if ('error' in auth) return auth.error
	const denied = await assertOperatorOrg(auth.auth.orgId)
	if (denied) return denied.error
	if (auth.auth.impersonated) {
		return c.json(
			{ error: 'forbidden', message: 'Not allowed while impersonating.' },
			403,
			noStoreHeaders(),
		)
	}
	let body: unknown
	try {
		body = await c.req.json()
	} catch {
		return c.json({ error: 'invalid_request' }, 400, noStoreHeaders())
	}
	const parsed = operatorDailyDishChangeSchema.safeParse(body)
	if (!parsed.success) {
		return c.json({ error: 'invalid_request' }, 400, noStoreHeaders())
	}
	if (!orderVisible(auth.auth, parsed.data.locationId)) {
		return c.json({ error: 'location_not_found' }, 404, noStoreHeaders())
	}
	try {
		const result = await adjustDailyDish({
			orgId: auth.auth.orgId,
			locationId: parsed.data.locationId,
			key: parsed.data.key,
			change:
				parsed.data.addUnits !== undefined
					? { addUnits: parsed.data.addUnits }
					: { amountLeft: parsed.data.amountLeft! },
			userId: auth.auth.userId,
		})
		if (!result.ok) {
			return c.json(
				{ error: result.failure.code, message: result.failure.message },
				result.failure.status,
				noStoreHeaders(),
			)
		}
		return c.json({ ok: true, row: result.data }, 200, noStoreHeaders())
	} catch (error) {
		console.error(
			`Failed to top up a daily dish limit for org ${auth.auth.orgId}:`,
			error instanceof Error ? error.message : error,
		)
		return c.json(
			{ error: 'Tenant Database unavailable' },
			500,
			noStoreHeaders(),
		)
	}
})

operatorOrderRoutes.get('/attention', async (c) => {
	const auth = await authenticateOrdersOperator(c, 'orders:read')
	if ('error' in auth) return auth.error
	const denied = await assertOperatorOrg(auth.auth.orgId)
	if (denied) return denied.error
	const { locationIds } = auth.auth
	if (locationIds !== null && locationIds.length === 0) {
		return c.json({ locations: [] }, 200, noStoreHeaders())
	}
	try {
		const db = await getTenantDb(auth.auth.orgId)
		const conditions = [
			eq(restaurantOrders.orgId, auth.auth.orgId),
			eq(restaurantOrders.status, 'payment_review'),
		]
		// Location-scoped tokens are narrowed below by orderVisible, so no
		// unbounded IN list reaches the statement (100 bound-parameter limit).
		const rows = await db
			.select({
				locationId: restaurantOrders.locationId,
				paymentReview: sql<number>`count(*)`,
			})
			.from(restaurantOrders)
			.where(and(...conditions))
			.groupBy(restaurantOrders.locationId)
		return c.json(
			{
				locations: rows
					.filter((row) => orderVisible(auth.auth, row.locationId))
					.map((row) => ({
						locationId: row.locationId,
						paymentReview: Number(row.paymentReview),
					})),
			},
			200,
			noStoreHeaders(),
		)
	} catch (error) {
		console.error(
			`Failed to count attention orders for org ${auth.auth.orgId}:`,
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
		return c.json({ order, serverNow: Date.now() }, 200, noStoreHeaders())
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
		const result = await updateOperatorOrderWithRefund(
			auth.auth.orgId,
			c.req.param('id'),
			parsed.data,
			{},
			{
				mayRefund: auth.auth.refundProvider,
				origin: 'operator',
				actorId: auth.auth.userId,
				cancelledBy: 'operator',
				impersonated: auth.auth.impersonated,
				// A refund that moves loyalty points needs the loyalty grant, as
				// a recorded refund does (a rejection's refund never asks).
				loyaltyAccess: {
					refundLoyalty: auth.auth.refundLoyalty,
					impersonated: auth.auth.impersonated,
				},
			},
		)
		if (!result.ok) {
			return c.json(
				{ error: result.failure.code, message: result.failure.message },
				result.failure.status as 400 | 403 | 404 | 409 | 422 | 500,
				noStoreHeaders(),
			)
		}
		const [order] = await withCustomerKeys(auth.auth, [result.data.order])
		const refund = result.data.refund
		return c.json(
			{
				order,
				// Only when the request asked for `refund: 'full'`: the booked
				// provider refund for the App to complete (ids and amounts), or
				// why none was started (the cancel stands either way).
				...(refund
					? {
							refundIntent: refund.refund
								? { ...refund.refund, replayed: refund.replayed }
								: null,
							refundError: refund.code,
						}
					: {}),
			},
			200,
			noStoreHeaders(),
		)
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
 * Records money returned for an order paid at handoff (cash or card at the
 * counter). A record only: no provider is called. An order paid online is
 * refused with 409 `refund_requires_provider` (the App's refund action goes
 * through the payment provider). Loyalty takes its points back from the
 * order's refunded total, whatever its flags say.
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
		return c.json(
			{
				order,
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
