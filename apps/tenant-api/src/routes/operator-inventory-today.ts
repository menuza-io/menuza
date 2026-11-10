import { INVENTORY_PERMISSIONS, locationQuerySchema } from '@repo/inventory'
import { getTenantDb } from '@repo/tenant-db'
import { Hono } from 'hono'
import {
	getInventoryAuth,
	inventoryGuard,
	requireInventoryLocation,
} from '../lib/inventory-guard.ts'
import { inventoryErrorResponse } from '../lib/inventory-http.ts'
import { inventoryCaller, respond, parseQuery } from '../lib/inventory-route.ts'
import { getToday } from '../services/inventory-today-service.ts'

/** The Today page of `/operator/inventory`: computed by rules, one location. */
export const operatorInventoryTodayRoutes = new Hono()

operatorInventoryTodayRoutes.get(
	'/today',
	inventoryGuard({
		scope: ['read', 'write'],
		grant: INVENTORY_PERMISSIONS.READ_INVENTORY,
	}),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const query = parseQuery(c, locationQuerySchema)
			if ('error' in query) return query.error
			const location = requireInventoryLocation(ctx, query.data.locationId)
			if (!location.ok) return location.response
			return respond(
				ctx,
				await getToday(await getTenantDb(ctx.orgId), {
					locationId: location.locationId,
					caller: inventoryCaller(ctx),
					now: Date.now(),
					purchasing: ctx.features.purchasing,
					recipes: ctx.features.recipes,
				}),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)
