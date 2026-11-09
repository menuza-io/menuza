import {
	INVENTORY_PERMISSIONS,
	listWasteQuerySchema,
	logWasteSchema,
	undoWasteSchema,
	wasteSummaryQuerySchema,
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
	idParam,
	inventoryCaller,
	respond,
	parseBody,
	parseQuery,
} from '../lib/inventory-route.ts'
import {
	listWaste,
	logWaste,
	undoWaste,
	wasteSummary,
} from '../services/inventory-waste-service.ts'

/**
 * Waste under `/operator/inventory`: log (several entries at once for
 * Station queues), undo by a reversing entry, the log and its summary.
 * Every entry names its location, which is checked against the token.
 */
export const operatorInventoryWasteRoutes = new Hono()

const READ = INVENTORY_PERMISSIONS.READ_INVENTORY
const UPDATE = INVENTORY_PERMISSIONS.UPDATE_INVENTORY

operatorInventoryWasteRoutes.post(
	'/waste',
	inventoryGuard({ scope: 'write', grant: UPDATE }),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const body = await parseBody(c, logWasteSchema)
			if ('error' in body) return body.error
			for (const entry of body.data.entries) {
				const location = requireInventoryLocation(ctx, entry.locationId)
				if (!location.ok) return location.response
			}
			return respond(ctx, await logWaste(inventoryCaller(ctx), body.data))
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryWasteRoutes.get(
	'/waste/summary',
	inventoryGuard({ scope: ['read', 'write'], grant: READ }),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const query = parseQuery(c, wasteSummaryQuerySchema)
			if ('error' in query) return query.error
			const location = requireInventoryLocation(ctx, query.data.locationId)
			if (!location.ok) return location.response
			return respond(
				ctx,
				await wasteSummary(await getTenantDb(ctx.orgId), {
					locationId: location.locationId,
					from: query.data.from,
					to: query.data.to,
					cost: inventoryCaller(ctx).cost,
				}),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryWasteRoutes.get(
	'/waste',
	inventoryGuard({ scope: ['read', 'write'], grant: READ }),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const query = parseQuery(c, listWasteQuerySchema)
			if ('error' in query) return query.error
			const location = requireInventoryLocation(ctx, query.data.locationId)
			if (!location.ok) return location.response
			return respond(
				ctx,
				await listWaste(await getTenantDb(ctx.orgId), {
					query: query.data,
					cost: inventoryCaller(ctx).cost,
				}),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryWasteRoutes.post(
	'/waste/:id/undo',
	inventoryGuard({ scope: 'write', grant: UPDATE }),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const id = idParam(c)
			const body = await parseBody(c, undoWasteSchema)
			if ('error' in body) return body.error
			return respond(
				ctx,
				await undoWaste(inventoryCaller(ctx), {
					id,
					clientId: body.data.clientId,
				}),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)
