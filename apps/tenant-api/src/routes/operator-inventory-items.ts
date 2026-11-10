import {
	adjustStockSchema,
	bulkCreateItemsSchema,
	createItemSchema,
	createItemUnitSchema,
	INVENTORY_PERMISSIONS,
	listItemsQuerySchema,
	listMovementsQuerySchema,
	locationQuerySchema,
	putItemPlaceSchema,
	updateItemSchema,
	versionOnlySchema,
} from '@repo/inventory'
import { getTenantDb } from '@repo/tenant-db'
import { Hono } from 'hono'
import {
	getInventoryAuth,
	inventoryGuard,
	requireInventoryLocation,
} from '../lib/inventory-guard.ts'
import { inventoryDeny, inventoryErrorResponse } from '../lib/inventory-http.ts'
import {
	APPROVE_EXTRA_GRANT,
	clientIdempotency,
	idParam,
	inventoryCaller,
	optionalLocation,
	respond,
	parseBody,
	parseQuery,
} from '../lib/inventory-route.ts'
import {
	addItemUnit,
	adjustStock,
	bulkCreateItems,
	createItem,
	getItemDetail,
	listItemMovements,
	listItems,
	putItemPlace,
	setItemArchived,
	updateItem,
} from '../services/inventory-items-service.ts'

/**
 * Items, their places and stock history under `/operator/inventory`. The
 * catalogue is organization-wide; every list, read of stock and write that
 * names a location checks it against the token's `locationIds`.
 */
export const operatorInventoryItemsRoutes = new Hono()

const READ = INVENTORY_PERMISSIONS.READ_INVENTORY
const UPDATE = INVENTORY_PERMISSIONS.UPDATE_INVENTORY
const reads = (): ReturnType<typeof inventoryGuard> =>
	inventoryGuard({ scope: ['read', 'write'], grant: READ })
const writes = (): ReturnType<typeof inventoryGuard> =>
	inventoryGuard({ scope: 'write', grant: UPDATE })

operatorInventoryItemsRoutes.get('/items', reads(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const query = parseQuery(c, listItemsQuerySchema)
		if ('error' in query) return query.error
		const location = requireInventoryLocation(ctx, query.data.locationId)
		if (!location.ok) return location.response
		const caller = inventoryCaller(ctx)
		return respond(
			ctx,
			await listItems(await getTenantDb(ctx.orgId), {
				query: query.data,
				cost: caller.cost,
			}),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryItemsRoutes.post('/items/bulk', writes(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const body = await parseBody(c, bulkCreateItemsSchema)
		if ('error' in body) return body.error
		const location = requireInventoryLocation(ctx, body.data.locationId)
		if (!location.ok) return location.response
		return respond(
			ctx,
			await bulkCreateItems(inventoryCaller(ctx), {
				body: body.data,
				idempotency: clientIdempotency(
					ctx,
					'items:bulk',
					body.data.clientId,
					body.data,
				),
			}),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryItemsRoutes.post('/items', writes(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const body = await parseBody(c, createItemSchema)
		if ('error' in body) return body.error
		if (body.data.place) {
			const location = requireInventoryLocation(ctx, body.data.place.locationId)
			if (!location.ok) return location.response
		}
		return respond(
			ctx,
			await createItem(inventoryCaller(ctx), {
				body: body.data,
				idempotency: clientIdempotency(
					ctx,
					'items:create',
					body.data.clientId,
					body.data,
				),
				locationId: body.data.place?.locationId ?? null,
			}),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryItemsRoutes.get('/items/:id', reads(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const id = idParam(c)
		const query = parseQuery(c, locationQuerySchema)
		if ('error' in query) return query.error
		const location = requireInventoryLocation(ctx, query.data.locationId)
		if (!location.ok) return location.response
		return respond(
			ctx,
			await getItemDetail(await getTenantDb(ctx.orgId), {
				itemId: id,
				locationId: location.locationId,
				caller: inventoryCaller(ctx),
			}),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryItemsRoutes.patch('/items/:id', writes(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const id = idParam(c)
		const location = optionalLocation(c, ctx)
		if (!location.ok) return location.response
		const body = await parseBody(c, updateItemSchema)
		if ('error' in body) return body.error
		return respond(
			ctx,
			await updateItem(inventoryCaller(ctx), {
				itemId: id,
				body: body.data,
				locationId: location.locationId,
			}),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

for (const [path, archived] of [
	['archive', true],
	['restore', false],
] as const) {
	operatorInventoryItemsRoutes.post(
		`/items/:id/${path}`,
		writes(),
		async (c) => {
			try {
				const ctx = getInventoryAuth(c)
				const id = idParam(c)
				const location = optionalLocation(c, ctx)
				if (!location.ok) return location.response
				const body = await parseBody(c, versionOnlySchema)
				if ('error' in body) return body.error
				return respond(
					ctx,
					await setItemArchived(inventoryCaller(ctx), {
						itemId: id,
						expectedVersion: body.data.expectedVersion,
						archived,
						locationId: location.locationId,
					}),
				)
			} catch (error) {
				return inventoryErrorResponse(error)
			}
		},
	)
}

operatorInventoryItemsRoutes.post('/items/:id/units', writes(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const id = idParam(c)
		const location = optionalLocation(c, ctx)
		if (!location.ok) return location.response
		const body = await parseBody(c, createItemUnitSchema)
		if ('error' in body) return body.error
		return respond(
			ctx,
			await addItemUnit(inventoryCaller(ctx), {
				itemId: id,
				body: body.data,
				locationId: location.locationId,
			}),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryItemsRoutes.put(
	'/items/:id/places/:locationId',
	writes(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const id = idParam(c)
			const location = requireInventoryLocation(ctx, c.req.param('locationId'))
			if (!location.ok) return location.response
			const body = await parseBody(c, putItemPlaceSchema)
			if ('error' in body) return body.error
			return respond(
				ctx,
				await putItemPlace(inventoryCaller(ctx), {
					itemId: id,
					locationId: location.locationId,
					body: body.data,
				}),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryItemsRoutes.post('/items/:id/adjust', writes(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const caller = inventoryCaller(ctx)
		if (!caller.cost) {
			return inventoryDeny(403, 'forbidden', {
				reason: 'grant',
				required: APPROVE_EXTRA_GRANT,
			})
		}
		const id = idParam(c)
		const body = await parseBody(c, adjustStockSchema)
		if ('error' in body) return body.error
		const location = requireInventoryLocation(ctx, body.data.locationId)
		if (!location.ok) return location.response
		return respond(
			ctx,
			await adjustStock(caller, { itemId: id, body: body.data }),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryItemsRoutes.get('/items/:id/movements', reads(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const id = idParam(c)
		const query = parseQuery(c, listMovementsQuerySchema)
		if ('error' in query) return query.error
		const location = requireInventoryLocation(ctx, query.data.locationId)
		if (!location.ok) return location.response
		return respond(
			ctx,
			await listItemMovements(await getTenantDb(ctx.orgId), {
				itemId: id,
				locationId: location.locationId,
				limit: query.data.limit,
				cursor: query.data.cursor,
				cost: inventoryCaller(ctx).cost,
			}),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})
