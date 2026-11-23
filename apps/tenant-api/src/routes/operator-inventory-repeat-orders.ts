import {
	createRepeatOrderSchema,
	INVENTORY_PERMISSIONS,
	listRepeatOrdersQuerySchema,
	skipRepeatOrderRunSchema,
	updateRepeatOrderSchema,
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
	createRepeatOrder,
	listRepeatOrders,
	skipRepeatOrderRun,
	updateRepeatOrder,
} from '../services/inventory-repeat-orders-service.ts'

export const operatorInventoryRepeatOrdersRoutes = new Hono()

const reads = (): ReturnType<typeof inventoryGuard> =>
	inventoryGuard({
		scope: ['read', 'write'],
		grant: INVENTORY_PERMISSIONS.READ_INVENTORY,
		feature: 'purchasing',
	})

const writes = (): ReturnType<typeof inventoryGuard> =>
	inventoryGuard({
		scope: 'write',
		grant: INVENTORY_PERMISSIONS.UPDATE_INVENTORY_PURCHASING,
		feature: 'purchasing',
	})

operatorInventoryRepeatOrdersRoutes.get(
	'/repeat-orders',
	reads(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const query = parseQuery(c, listRepeatOrdersQuerySchema)
			if ('error' in query) return query.error
			const location = requireInventoryLocation(ctx, query.data.locationId)
			if (!location.ok) return location.response
			const db = await getTenantDb(ctx.orgId)
			const data = await listRepeatOrders(db, {
				locationId: query.data.locationId,
				includeCancelled: query.data.includeCancelled,
				runs: query.data.runs,
				now: Date.now(),
			})
			return respond(ctx, data)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryRepeatOrdersRoutes.post(
	'/repeat-orders',
	writes(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const body = await parseBody(c, createRepeatOrderSchema)
			if ('error' in body) return body.error
			const location = requireInventoryLocation(ctx, body.data.locationId)
			if (!location.ok) return location.response
			const repeatOrder = await createRepeatOrder(inventoryCaller(ctx), {
				body: body.data,
				idempotency: clientIdempotency(
					ctx,
					'repeat_order:create',
					body.data.clientId,
					body.data,
				),
			})
			return respond(ctx, repeatOrder, 201)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryRepeatOrdersRoutes.patch(
	'/repeat-orders/:id',
	writes(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const id = idParam(c)
			const body = await parseBody(c, updateRepeatOrderSchema)
			if ('error' in body) return body.error
			const repeatOrder = await updateRepeatOrder(inventoryCaller(ctx), {
				id,
				body: body.data,
			})
			return respond(ctx, repeatOrder)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryRepeatOrdersRoutes.post(
	'/repeat-orders/:id/skip',
	writes(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const id = idParam(c)
			const body = await parseBody(c, skipRepeatOrderRunSchema)
			if ('error' in body) return body.error
			const repeatOrder = await skipRepeatOrderRun(inventoryCaller(ctx), {
				id,
				body: body.data,
			})
			return respond(ctx, repeatOrder)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)
