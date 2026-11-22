import {
	INVENTORY_PERMISSIONS,
	setupChecksQuerySchema,
	setupFindingRefSchema,
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
	inventoryCaller,
	parseBody,
	parseQuery,
	respond,
} from '../lib/inventory-route.ts'
import {
	dismissFinding,
	fixFinding,
	listSetupChecks,
} from '../services/inventory-setup-checks.ts'

/**
 * "Check your setup" under `/operator/inventory` (#510). Reading needs
 * `read:inventory:any` (price findings need the cost grant and are left out
 * without it); dismissing and fixing need `update:inventory:any`, a price fix
 * also the purchasing grant, like the screen it mirrors.
 */
export const operatorInventorySetupChecksRoutes = new Hono()

const reads = () =>
	inventoryGuard({
		scope: ['read', 'write'],
		grant: INVENTORY_PERMISSIONS.READ_INVENTORY,
	})
const writes = () =>
	inventoryGuard({
		scope: 'write',
		grant: INVENTORY_PERMISSIONS.UPDATE_INVENTORY,
	})

operatorInventorySetupChecksRoutes.get('/setup-checks', reads(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const query = parseQuery(c, setupChecksQuerySchema)
		if ('error' in query) return query.error
		const location = requireInventoryLocation(ctx, query.data.locationId)
		if (!location.ok) return location.response
		return respond(
			ctx,
			await listSetupChecks(await getTenantDb(ctx.orgId), {
				locationId: location.locationId,
				caller: inventoryCaller(ctx),
			}),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventorySetupChecksRoutes.post(
	'/setup-checks/dismiss',
	writes(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const body = await parseBody(c, setupFindingRefSchema)
			if ('error' in body) return body.error
			const location = requireInventoryLocation(ctx, body.data.locationId)
			if (!location.ok) return location.response
			return respond(
				ctx,
				await dismissFinding(inventoryCaller(ctx), { body: body.data }),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventorySetupChecksRoutes.post(
	'/setup-checks/fix',
	writes(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const body = await parseBody(c, setupFindingRefSchema)
			if ('error' in body) return body.error
			const location = requireInventoryLocation(ctx, body.data.locationId)
			if (!location.ok) return location.response
			return respond(
				ctx,
				await fixFinding(inventoryCaller(ctx), {
					body: body.data,
					db: await getTenantDb(ctx.orgId),
				}),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)
