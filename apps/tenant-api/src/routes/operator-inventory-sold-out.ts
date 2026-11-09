import { INVENTORY_PERMISSIONS, undoSoldOutSchema } from '@repo/inventory'
import { z } from 'zod'
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
	parseBody,
	parseQuery,
	respond,
} from '../lib/inventory-route.ts'
import {
	listSoldOut,
	undoSoldOut,
} from '../services/inventory-sold-out-service.ts'

/**
 * Dishes taken off the menu by stock (auto sold out), under
 * `/operator/inventory`. Both routes need the `inventory.recipes` flag.
 * Reading needs `read:inventory:any`; the manager's undo is kitchen work
 * (`update:inventory:any`). Ids only: the App joins the dish names.
 */
export const operatorInventorySoldOutRoutes = new Hono()

const READ = INVENTORY_PERMISSIONS.READ_INVENTORY
const UPDATE = INVENTORY_PERMISSIONS.UPDATE_INVENTORY

const locationQuerySchema = z.object({ locationId: z.string().min(1).max(64) })

operatorInventorySoldOutRoutes.get(
	'/sold-out',
	inventoryGuard({
		scope: ['read', 'write'],
		grant: READ,
		feature: 'recipes',
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
				await listSoldOut(await getTenantDb(ctx.orgId), {
					locationId: location.locationId,
				}),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventorySoldOutRoutes.post(
	'/sold-out/:id/undo',
	inventoryGuard({ scope: 'write', grant: UPDATE, feature: 'recipes' }),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const id = idParam(c)
			const body = await parseBody(c, undoSoldOutSchema)
			if ('error' in body) return body.error
			return respond(ctx, await undoSoldOut(inventoryCaller(ctx), { id }))
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)
