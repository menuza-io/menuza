import {
	approveCountSchema,
	countEntriesSchema,
	INVENTORY_PERMISSIONS,
	listCountsQuerySchema,
	startCountSchema,
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
	respond,
	parseBody,
	parseQuery,
} from '../lib/inventory-route.ts'
import {
	addCountEntries,
	approveCount,
	getCountReview,
	getCountSheet,
	listCounts,
	startCount,
	transitionCount,
} from '../services/inventory-counts-service.ts'

/**
 * Stock counts under `/operator/inventory`: start, the counting sheet,
 * entries from several people, send for review, review and approve. A count
 * belongs to one location; the location of a count addressed by id is checked
 * against the token inside the service.
 */
export const operatorInventoryCountsRoutes = new Hono()

const READ = INVENTORY_PERMISSIONS.READ_INVENTORY
const UPDATE = INVENTORY_PERMISSIONS.UPDATE_INVENTORY
const reads = (): ReturnType<typeof inventoryGuard> =>
	inventoryGuard({ scope: ['read', 'write'], grant: READ })
const writes = (): ReturnType<typeof inventoryGuard> =>
	inventoryGuard({ scope: 'write', grant: UPDATE })

operatorInventoryCountsRoutes.post('/counts', writes(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const body = await parseBody(c, startCountSchema)
		if ('error' in body) return body.error
		const location = requireInventoryLocation(ctx, body.data.locationId)
		if (!location.ok) return location.response
		return respond(
			ctx,
			await startCount(inventoryCaller(ctx), {
				...body.data,
				idempotency: clientIdempotency(
					ctx,
					'counts:start',
					body.data.clientId,
					body.data,
				),
			}),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryCountsRoutes.get('/counts', reads(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const query = parseQuery(c, listCountsQuerySchema)
		if ('error' in query) return query.error
		const location = requireInventoryLocation(ctx, query.data.locationId)
		if (!location.ok) return location.response
		return respond(
			ctx,
			await listCounts(await getTenantDb(ctx.orgId), {
				query: query.data,
				caller: inventoryCaller(ctx),
			}),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryCountsRoutes.get('/counts/:id', reads(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const id = idParam(c)
		return respond(
			ctx,
			await getCountSheet(await getTenantDb(ctx.orgId), {
				id,
				caller: inventoryCaller(ctx),
			}),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryCountsRoutes.post(
	'/counts/:id/entries',
	writes(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const id = idParam(c)
			const body = await parseBody(c, countEntriesSchema)
			if ('error' in body) return body.error
			return respond(
				ctx,
				await addCountEntries(inventoryCaller(ctx), { id, body: body.data }),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

for (const action of ['send', 'reopen', 'cancel'] as const) {
	operatorInventoryCountsRoutes.post(
		`/counts/:id/${action}`,
		writes(),
		async (c) => {
			try {
				const ctx = getInventoryAuth(c)
				const id = idParam(c)
				const body = await parseBody(c, versionOnlySchema)
				if ('error' in body) return body.error
				return respond(
					ctx,
					await transitionCount(inventoryCaller(ctx), {
						id,
						expectedVersion: body.data.expectedVersion,
						action,
					}),
				)
			} catch (error) {
				return inventoryErrorResponse(error)
			}
		},
	)
}

operatorInventoryCountsRoutes.get('/counts/:id/review', reads(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const id = idParam(c)
		return respond(
			ctx,
			await getCountReview(await getTenantDb(ctx.orgId), {
				id,
				caller: inventoryCaller(ctx),
			}),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryCountsRoutes.post(
	'/counts/:id/approve',
	writes(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			// Approving posts adjustments in money: it also needs the cost grant.
			const caller = inventoryCaller(ctx)
			if (!caller.cost) {
				return inventoryDeny(403, 'forbidden', {
					reason: 'grant',
					required: APPROVE_EXTRA_GRANT,
				})
			}
			const id = idParam(c)
			const body = await parseBody(c, approveCountSchema)
			if ('error' in body) return body.error
			return respond(ctx, await approveCount(caller, { id, body: body.data }))
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)
