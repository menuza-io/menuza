import { Hono, type Context } from 'hono'
import { jwtVerify } from 'jose'
import { z } from 'zod'

import { operatorOrderPatchSchema } from '@repo/common/restaurant-orders'
import { brand } from '@repo/config/brand'
import { TENANT_ORG_ID_PATTERN, type RestaurantOrder } from '@repo/tenant-db'

import { findActiveOrganizationById } from '../lib/origin.ts'
import { getNodeRegion, orgMatchesNodeRegion } from '../lib/region.ts'
import { getBearerToken, getOperatorToken } from '../lib/secrets.ts'
import {
	getOperatorOrder,
	listOperatorOrders,
	operatorOrder,
	updateOperatorOrder,
} from '../services/order-service.ts'

export const operatorOrderRoutes = new Hono()

const OPERATOR_LIST_LIMIT = 100

export type OperatorOrderAuth = {
	orgId: string
	role: string
	scope: 'orders:read' | 'orders:write'
}

/**
 * Operator JWT authentication with separately enforced read/write scopes.
 * `orders:read` may list and inspect; `orders:write` is required for any
 * lifecycle change. Both scopes are minted by App after menu-read /
 * menu-write authorization, and this node verifies only its own
 * TENANT_OPERATOR_TOKEN audience.
 */
async function authenticateOrdersOperator(
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

	let decoded: { orgId?: string; role?: string; scope?: string }
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
			role: decoded.role,
			scope: decoded.scope,
		},
	}
}

/**
 * Region + provisioning fail-closed check for operator access, mirroring the
 * other operator surfaces. Responses are always `private, no-store`.
 */
async function assertOperatorOrg(
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
		})
		return c.json({ orders: orders.map(operatorOrder) }, 200, noStoreHeaders())
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
		return c.json({ order: operatorOrder(result.data) }, 200, noStoreHeaders())
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
		return c.json({ order: operatorOrder(result.data) }, 200, noStoreHeaders())
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
