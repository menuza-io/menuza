import {
	confirmLotsSchema,
	freshnessQuerySchema,
	INVENTORY_PERMISSIONS,
	wasteLotSchema,
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
	confirmLots,
	getFreshness,
	getItemLots,
	wasteLot,
} from '../services/inventory-lots-service.ts'

/**
 * Use-by dates under `/operator/inventory` (#479), behind `inventory.use_by`:
 * the Today lists, stock by date for one item, confirming the dates on the
 * shelf and one-tap waste of expired stock.
 */
export const operatorInventoryFreshnessRoutes = new Hono()

const READ = INVENTORY_PERMISSIONS.READ_INVENTORY
const UPDATE = INVENTORY_PERMISSIONS.UPDATE_INVENTORY

operatorInventoryFreshnessRoutes.get(
	'/freshness',
	inventoryGuard({ scope: ['read', 'write'], grant: READ, feature: 'useBy' }),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const query = parseQuery(c, freshnessQuerySchema)
			if ('error' in query) return query.error
			const location = requireInventoryLocation(ctx, query.data.locationId)
			if (!location.ok) return location.response
			return respond(
				ctx,
				await getFreshness(await getTenantDb(ctx.orgId), {
					locationId: location.locationId,
					caller: inventoryCaller(ctx),
					now: Date.now(),
				}),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryFreshnessRoutes.get(
	'/items/:id/lots',
	inventoryGuard({ scope: ['read', 'write'], grant: READ, feature: 'useBy' }),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const query = parseQuery(c, freshnessQuerySchema)
			if ('error' in query) return query.error
			const location = requireInventoryLocation(ctx, query.data.locationId)
			if (!location.ok) return location.response
			return respond(
				ctx,
				await getItemLots(await getTenantDb(ctx.orgId), {
					itemId: idParam(c),
					locationId: location.locationId,
					caller: inventoryCaller(ctx),
					now: Date.now(),
				}),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryFreshnessRoutes.post(
	'/items/:id/lots/confirm',
	inventoryGuard({ scope: 'write', grant: UPDATE, feature: 'useBy' }),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const body = await parseBody(c, confirmLotsSchema)
			if ('error' in body) return body.error
			const location = requireInventoryLocation(ctx, body.data.locationId)
			if (!location.ok) return location.response
			const itemId = idParam(c)
			return respond(
				ctx,
				await confirmLots(inventoryCaller(ctx), {
					itemId,
					body: body.data,
					idempotency: clientIdempotency(
						ctx,
						`lots-confirm:${itemId}`,
						body.data.clientId,
						body.data,
					),
				}),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryFreshnessRoutes.post(
	'/lots/:lotId/waste',
	inventoryGuard({ scope: 'write', grant: UPDATE, feature: 'useBy' }),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const body = await parseBody(c, wasteLotSchema)
			if ('error' in body) return body.error
			const location = requireInventoryLocation(ctx, body.data.locationId)
			if (!location.ok) return location.response
			const lotId = idParam(c, 'lotId')
			return respond(
				ctx,
				await wasteLot(inventoryCaller(ctx), {
					lotId,
					body: body.data,
					idempotency: clientIdempotency(
						ctx,
						`lot-waste:${lotId}`,
						body.data.clientId,
						body.data,
					),
				}),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)
