import {
	createCountListSchema,
	createStorageAreaSchema,
	INVENTORY_PERMISSIONS,
	locationQuerySchema,
	renameStorageAreaSchema,
	reorderStorageAreasSchema,
	setAreaItemOrderSchema,
	updateCountListSchema,
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
	idParam,
	inventoryCaller,
	respond,
	parseBody,
	parseQuery,
} from '../lib/inventory-route.ts'
import {
	archiveCountList,
	archiveStorageArea,
	createCountList,
	createStorageArea,
	listCountLists,
	listStorageAreas,
	renameStorageArea,
	reorderStorageAreas,
	setAreaItemOrder,
	updateCountList,
} from '../services/inventory-places-service.ts'

/**
 * Storage areas (walking order) and saved count lists under
 * `/operator/inventory`. Both belong to one location; records addressed by id
 * are checked against the token's locations through their own location.
 */
export const operatorInventoryPlacesRoutes = new Hono()

const READ = INVENTORY_PERMISSIONS.READ_INVENTORY
const UPDATE = INVENTORY_PERMISSIONS.UPDATE_INVENTORY
const reads = (): ReturnType<typeof inventoryGuard> =>
	inventoryGuard({ scope: ['read', 'write'], grant: READ })
const writes = (): ReturnType<typeof inventoryGuard> =>
	inventoryGuard({ scope: 'write', grant: UPDATE })

operatorInventoryPlacesRoutes.get('/storage-areas', reads(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const query = parseQuery(c, locationQuerySchema)
		if ('error' in query) return query.error
		const location = requireInventoryLocation(ctx, query.data.locationId)
		if (!location.ok) return location.response
		return respond(
			ctx,
			await listStorageAreas(await getTenantDb(ctx.orgId), location.locationId),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryPlacesRoutes.post('/storage-areas', writes(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const body = await parseBody(c, createStorageAreaSchema)
		if ('error' in body) return body.error
		const location = requireInventoryLocation(ctx, body.data.locationId)
		if (!location.ok) return location.response
		return respond(
			ctx,
			await createStorageArea(inventoryCaller(ctx), body.data),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryPlacesRoutes.post(
	'/storage-areas/reorder',
	writes(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const body = await parseBody(c, reorderStorageAreasSchema)
			if ('error' in body) return body.error
			const location = requireInventoryLocation(ctx, body.data.locationId)
			if (!location.ok) return location.response
			return respond(
				ctx,
				await reorderStorageAreas(inventoryCaller(ctx), body.data),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryPlacesRoutes.patch(
	'/storage-areas/:id',
	writes(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const id = idParam(c)
			const body = await parseBody(c, renameStorageAreaSchema)
			if ('error' in body) return body.error
			return respond(
				ctx,
				await renameStorageArea(inventoryCaller(ctx), {
					id,
					expectedVersion: body.data.expectedVersion,
					name: body.data.name,
				}),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryPlacesRoutes.put(
	'/storage-areas/:id/items',
	writes(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const id = idParam(c)
			const body = await parseBody(c, setAreaItemOrderSchema)
			if ('error' in body) return body.error
			return respond(
				ctx,
				await setAreaItemOrder(inventoryCaller(ctx), {
					id,
					itemIds: body.data.itemIds,
				}),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryPlacesRoutes.post(
	'/storage-areas/:id/archive',
	writes(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const id = idParam(c)
			const body = await parseBody(c, versionOnlySchema)
			if ('error' in body) return body.error
			return respond(
				ctx,
				await archiveStorageArea(inventoryCaller(ctx), {
					id,
					expectedVersion: body.data.expectedVersion,
				}),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryPlacesRoutes.get('/count-lists', reads(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const query = parseQuery(c, locationQuerySchema)
		if ('error' in query) return query.error
		const location = requireInventoryLocation(ctx, query.data.locationId)
		if (!location.ok) return location.response
		return respond(
			ctx,
			await listCountLists(await getTenantDb(ctx.orgId), location.locationId),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryPlacesRoutes.post('/count-lists', writes(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const body = await parseBody(c, createCountListSchema)
		if ('error' in body) return body.error
		const location = requireInventoryLocation(ctx, body.data.locationId)
		if (!location.ok) return location.response
		return respond(ctx, await createCountList(inventoryCaller(ctx), body.data))
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryPlacesRoutes.patch('/count-lists/:id', writes(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const id = idParam(c)
		const body = await parseBody(c, updateCountListSchema)
		if ('error' in body) return body.error
		return respond(
			ctx,
			await updateCountList(inventoryCaller(ctx), { id, body: body.data }),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryPlacesRoutes.post(
	'/count-lists/:id/archive',
	writes(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const id = idParam(c)
			const body = await parseBody(c, versionOnlySchema)
			if ('error' in body) return body.error
			return respond(
				ctx,
				await archiveCountList(inventoryCaller(ctx), {
					id,
					expectedVersion: body.data.expectedVersion,
				}),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)
