import {
	INVENTORY_PERMISSIONS,
	levelSuggestionsQuerySchema,
	listLevelsQuerySchema,
	putLevelsSchema,
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
	inventoryCaller,
	parseBody,
	parseQuery,
	respond,
} from '../lib/inventory-route.ts'
import {
	listLevels,
	putLevels,
	suggestLevels,
} from '../services/inventory-levels-service.ts'

/**
 * Levels under `/operator/inventory` (phase 2, flag `inventory.purchasing`):
 * "order more when below" and "fill up to" for every item at one location,
 * suggestions from what was used, and the bulk save. Quantities only.
 */
export const operatorInventoryLevelsRoutes = new Hono()

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

operatorInventoryLevelsRoutes.get('/levels', reads(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const query = parseQuery(c, listLevelsQuerySchema)
		if ('error' in query) return query.error
		const location = requireInventoryLocation(ctx, query.data.locationId)
		if (!location.ok) return location.response
		return respond(
			ctx,
			await listLevels(await getTenantDb(ctx.orgId), { query: query.data }),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryLevelsRoutes.get('/levels/suggestions', reads(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const query = parseQuery(c, levelSuggestionsQuerySchema)
		if ('error' in query) return query.error
		const location = requireInventoryLocation(ctx, query.data.locationId)
		if (!location.ok) return location.response
		return respond(
			ctx,
			await suggestLevels(await getTenantDb(ctx.orgId), {
				query: query.data,
				now: Date.now(),
			}),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryLevelsRoutes.put('/levels/bulk', purchasing(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const body = await parseBody(c, putLevelsSchema)
		if ('error' in body) return body.error
		const location = requireInventoryLocation(ctx, body.data.locationId)
		if (!location.ok) return location.response
		return respond(
			ctx,
			await putLevels(inventoryCaller(ctx), {
				body: body.data,
				idempotency: clientIdempotency(
					ctx,
					'levels:bulk',
					body.data.clientId,
					body.data,
				),
			}),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})
