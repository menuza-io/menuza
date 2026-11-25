import {
	INVENTORY_PERMISSIONS,
	varianceMovementsQuerySchema,
	varianceQuerySchema,
} from '@repo/inventory'
import { getTenantDb } from '@repo/tenant-db'
import { Hono } from 'hono'
import {
	getInventoryAuth,
	inventoryGuard,
	requireInventoryLocation,
} from '../lib/inventory-guard.ts'
import { inventoryErrorResponse } from '../lib/inventory-http.ts'
import { inventoryCaller, parseQuery, respond } from '../lib/inventory-route.ts'
import {
	getVariance,
	getVarianceMovements,
} from '../services/inventory-variance-service.ts'

/**
 * Expected versus actual use by item between approved full counts (#509),
 * under `/operator/inventory` and behind `inventory.recipes` (expected use
 * comes from sales and batches through recipes). Reads need
 * `read:inventory:any`; money (the gap in money and its share of sales) needs
 * `read:inventory_cost:any` and is left out without it.
 */
export const operatorInventoryVarianceRoutes = new Hono()

const reads = (): ReturnType<typeof inventoryGuard> =>
	inventoryGuard({
		scope: ['read', 'write'],
		grant: INVENTORY_PERMISSIONS.READ_INVENTORY,
		feature: 'recipes',
	})

operatorInventoryVarianceRoutes.get('/variance', reads(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const query = parseQuery(c, varianceQuerySchema)
		if ('error' in query) return query.error
		const location = requireInventoryLocation(ctx, query.data.locationId)
		if (!location.ok) return location.response
		return respond(
			ctx,
			await getVariance(await getTenantDb(ctx.orgId), {
				caller: inventoryCaller(ctx),
				locationId: location.locationId,
				closingCountId: query.data.closingCountId,
			}),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryVarianceRoutes.get(
	'/variance/movements',
	reads(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const query = parseQuery(c, varianceMovementsQuerySchema)
			if ('error' in query) return query.error
			const location = requireInventoryLocation(ctx, query.data.locationId)
			if (!location.ok) return location.response
			return respond(
				ctx,
				await getVarianceMovements(await getTenantDb(ctx.orgId), {
					caller: inventoryCaller(ctx),
					locationId: location.locationId,
					closingCountId: query.data.closingCountId,
					itemId: query.data.itemId,
				}),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)
