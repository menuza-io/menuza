import {
	createGroupSchema,
	INVENTORY_PERMISSIONS,
	listGroupsQuerySchema,
	updateGroupSchema,
	versionOnlySchema,
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
	createGroup,
	dissolveGroup,
	listGroups,
	updateGroup,
} from '../services/inventory-groups-service.ts'

/**
 * Ingredient groups (#495) under `/operator/inventory`: items that can stand
 * in for each other, named by recipes as one ingredient. Needs the
 * `inventory.recipes` flag (groups only matter to recipes and auto sold out).
 * Reads need `read:inventory:any`, writes `update:inventory:any`.
 */
export const operatorInventoryGroupsRoutes = new Hono()

const reads = (): ReturnType<typeof inventoryGuard> =>
	inventoryGuard({
		scope: ['read', 'write'],
		grant: INVENTORY_PERMISSIONS.READ_INVENTORY,
		feature: 'recipes',
	})
const writes = (): ReturnType<typeof inventoryGuard> =>
	inventoryGuard({
		scope: 'write',
		grant: INVENTORY_PERMISSIONS.UPDATE_INVENTORY,
		feature: 'recipes',
	})

operatorInventoryGroupsRoutes.get('/groups', reads(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const query = parseQuery(c, listGroupsQuerySchema)
		if ('error' in query) return query.error
		const location = requireInventoryLocation(ctx, query.data.locationId)
		if (!location.ok) return location.response
		return respond(
			ctx,
			await listGroups(await getTenantDb(ctx.orgId), {
				locationId: location.locationId,
				cost: inventoryCaller(ctx).cost,
			}),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryGroupsRoutes.post('/groups', writes(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const body = await parseBody(c, createGroupSchema)
		if ('error' in body) return body.error
		return respond(
			ctx,
			await createGroup(inventoryCaller(ctx), {
				body: body.data,
				idempotency: clientIdempotency(
					ctx,
					'groups:create',
					body.data.clientId,
					body.data,
				),
			}),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryGroupsRoutes.patch('/groups/:id', writes(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const id = idParam(c)
		const body = await parseBody(c, updateGroupSchema)
		if ('error' in body) return body.error
		return respond(
			ctx,
			await updateGroup(inventoryCaller(ctx), { groupId: id, body: body.data }),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryGroupsRoutes.post(
	'/groups/:id/dissolve',
	writes(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const id = idParam(c)
			const body = await parseBody(c, versionOnlySchema)
			if ('error' in body) return body.error
			return respond(
				ctx,
				await dissolveGroup(inventoryCaller(ctx), {
					groupId: id,
					expectedVersion: body.data.expectedVersion,
				}),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)
