import {
	cancelOrderSchema,
	createOrderSchema,
	INVENTORY_PERMISSIONS,
	listOrdersQuerySchema,
	orderTextQuerySchema,
	sendOrderSchema,
	suggestedOrdersQuerySchema,
	updateOrderSchema,
} from '@repo/inventory'
import { getTenantDb } from '@repo/tenant-db'
import { Hono } from 'hono'
import {
	getInventoryAuth,
	inventoryGuard,
	requireInventoryLocation,
} from '../lib/inventory-guard.ts'
import { inventoryErrorResponse } from '../lib/inventory-http.ts'
import {
	clientIdempotency,
	idParam,
	inventoryCaller,
	parseBody,
	parseQuery,
	respond,
} from '../lib/inventory-route.ts'
import {
	buildSuggestedOrders,
	cancelOrder,
	createOrder,
	getOrder,
	getOrderText,
	getReceivePrefill,
	listOrders,
	sendOrder,
	updateOrder,
} from '../services/inventory-orders-service.ts'

/**
 * Suggested orders and orders under `/operator/inventory` (phase 2, flag
 * `inventory.purchasing`). Reads need `read:inventory:any`; creating,
 * editing, sending and cancelling need `update:inventory_purchasing:any`.
 * Money (prices, totals, minimums) only for the cost grant; the order text
 * never contains money.
 */
export const operatorInventoryOrdersRoutes = new Hono()

const reads = (): ReturnType<typeof inventoryGuard> =>
	inventoryGuard({
		scope: ['read', 'write'],
		grant: INVENTORY_PERMISSIONS.READ_INVENTORY,
		feature: 'purchasing',
	})
const purchasing = (): ReturnType<typeof inventoryGuard> =>
	inventoryGuard({
		scope: 'write',
		grant: INVENTORY_PERMISSIONS.UPDATE_INVENTORY_PURCHASING,
		feature: 'purchasing',
	})

// Static paths first: `/orders/suggested` must not read as an order id.
operatorInventoryOrdersRoutes.get('/orders/suggested', reads(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const query = parseQuery(c, suggestedOrdersQuerySchema)
		if ('error' in query) return query.error
		const location = requireInventoryLocation(ctx, query.data.locationId)
		if (!location.ok) return location.response
		return respond(
			ctx,
			await buildSuggestedOrders(await getTenantDb(ctx.orgId), {
				locationId: location.locationId,
				cost: inventoryCaller(ctx).cost,
				now: Date.now(),
			}),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryOrdersRoutes.post('/orders', purchasing(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const body = await parseBody(c, createOrderSchema)
		if ('error' in body) return body.error
		const location = requireInventoryLocation(ctx, body.data.locationId)
		if (!location.ok) return location.response
		return respond(
			ctx,
			await createOrder(inventoryCaller(ctx), {
				body: body.data,
				idempotency: clientIdempotency(
					ctx,
					'orders:create',
					body.data.clientId,
					body.data,
				),
			}),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryOrdersRoutes.get('/orders', reads(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const query = parseQuery(c, listOrdersQuerySchema)
		if ('error' in query) return query.error
		const location = requireInventoryLocation(ctx, query.data.locationId)
		if (!location.ok) return location.response
		return respond(
			ctx,
			await listOrders(await getTenantDb(ctx.orgId), {
				query: query.data,
				cost: inventoryCaller(ctx).cost,
			}),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryOrdersRoutes.get('/orders/:id', reads(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const id = idParam(c)
		return respond(
			ctx,
			await getOrder(await getTenantDb(ctx.orgId), {
				id,
				caller: inventoryCaller(ctx),
			}),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryOrdersRoutes.patch('/orders/:id', purchasing(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const id = idParam(c)
		const body = await parseBody(c, updateOrderSchema)
		if ('error' in body) return body.error
		return respond(
			ctx,
			await updateOrder(inventoryCaller(ctx), { id, body: body.data }),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryOrdersRoutes.post(
	'/orders/:id/send',
	purchasing(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const id = idParam(c)
			const body = await parseBody(c, sendOrderSchema)
			if ('error' in body) return body.error
			return respond(
				ctx,
				await sendOrder(inventoryCaller(ctx), { id, body: body.data }),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryOrdersRoutes.post(
	'/orders/:id/cancel',
	purchasing(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const id = idParam(c)
			const body = await parseBody(c, cancelOrderSchema)
			if ('error' in body) return body.error
			return respond(
				ctx,
				await cancelOrder(inventoryCaller(ctx), {
					id,
					expectedVersion: body.data.expectedVersion,
					note: body.data.note,
				}),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryOrdersRoutes.get('/orders/:id/text', reads(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const id = idParam(c)
		const query = parseQuery(c, orderTextQuerySchema)
		if ('error' in query) return query.error
		return respond(
			ctx,
			await getOrderText(await getTenantDb(ctx.orgId), {
				id,
				locale: query.data.locale,
				caller: inventoryCaller(ctx),
			}),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryOrdersRoutes.get(
	'/orders/:id/receive-prefill',
	reads(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const id = idParam(c)
			return respond(
				ctx,
				await getReceivePrefill(await getTenantDb(ctx.orgId), {
					id,
					caller: inventoryCaller(ctx),
				}),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)
