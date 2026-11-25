import {
	cancelTransferSchema,
	compareQuerySchema,
	createTransferSchema,
	INVENTORY_PERMISSIONS,
	listTransfersQuerySchema,
	patchTransferSchema,
	putTransferTermsSchema,
	receiveTransferSchema,
	sendTransferSchema,
	transferTermsQuerySchema,
	transfersNotOfferedQuerySchema,
	transfersOwedQuerySchema,
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
import { compareLocations } from '../services/inventory-compare-service.ts'
import {
	listNotOffered,
	listTransferTerms,
	putTransferTerms,
	transfersOwed,
} from '../services/inventory-transfer-terms-service.ts'
import {
	cancelTransfer,
	createTransfer,
	getTransfer,
	listTransfers,
	patchTransfer,
	receiveTransfer,
	sendTransfer,
} from '../services/inventory-transfers-service.ts'

/**
 * Transfers and branch requests under `/operator/inventory` (behind
 * `inventory.transfers`). Reads need `read:inventory:any` and a token that
 * covers either end; everything that changes needs `update:inventory:any` and
 * the location the action belongs to (the maker edits, the sender sends, the
 * receiver receives). Money (the value moved) needs the cost grant.
 */
export const operatorInventoryTransfersRoutes = new Hono()

const READ = INVENTORY_PERMISSIONS.READ_INVENTORY
const UPDATE = INVENTORY_PERMISSIONS.UPDATE_INVENTORY

const reads = (): ReturnType<typeof inventoryGuard> =>
	inventoryGuard({
		scope: ['read', 'write'],
		grant: READ,
		feature: 'transfers',
	})
const writes = (): ReturnType<typeof inventoryGuard> =>
	inventoryGuard({ scope: 'write', grant: UPDATE, feature: 'transfers' })

// Several locations side by side (a chain's view; behind the transfers flag).
operatorInventoryTransfersRoutes.get('/compare', reads(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const query = parseQuery(c, compareQuerySchema)
		if ('error' in query) return query.error
		return respond(
			ctx,
			await compareLocations(await getTenantDb(ctx.orgId), {
				caller: inventoryCaller(ctx),
				locationIds: query.data.locationIds,
				now: Date.now(),
			}),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

// Transfer prices and what branches may request (#526), at the sending place.
operatorInventoryTransfersRoutes.get('/transfer-terms', reads(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const query = parseQuery(c, transferTermsQuerySchema)
		if ('error' in query) return query.error
		const location = requireInventoryLocation(ctx, query.data.locationId)
		if (!location.ok) return location.response
		return respond(
			ctx,
			await listTransferTerms(await getTenantDb(ctx.orgId), {
				caller: inventoryCaller(ctx),
				locationId: location.locationId,
				onlySet: query.data.onlySet === 'true',
				search: query.data.search,
			}),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryTransfersRoutes.put(
	'/transfer-terms/:itemId',
	writes(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const itemId = idParam(c, 'itemId')
			const body = await parseBody(c, putTransferTermsSchema)
			if ('error' in body) return body.error
			const location = requireInventoryLocation(ctx, body.data.locationId)
			if (!location.ok) return location.response
			return respond(
				ctx,
				await putTransferTerms(inventoryCaller(ctx), {
					itemId,
					body: body.data,
				}),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

// What a place does not offer to branches, as ids (a branch's request form, #526).
operatorInventoryTransfersRoutes.get(
	'/transfers/not-offered',
	reads(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const query = parseQuery(c, transfersNotOfferedQuerySchema)
			if ('error' in query) return query.error
			return respond(
				ctx,
				await listNotOffered(await getTenantDb(ctx.orgId), {
					fromLocationId: query.data.fromLocationId,
				}),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

// What each branch owes the sending place for what it sent in a period (#526).
operatorInventoryTransfersRoutes.get('/transfers/owed', reads(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const query = parseQuery(c, transfersOwedQuerySchema)
		if ('error' in query) return query.error
		const location = requireInventoryLocation(ctx, query.data.locationId)
		if (!location.ok) return location.response
		return respond(
			ctx,
			await transfersOwed(await getTenantDb(ctx.orgId), {
				caller: inventoryCaller(ctx),
				locationId: location.locationId,
				from: query.data.from,
				to: query.data.to,
			}),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryTransfersRoutes.get('/transfers', reads(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const query = parseQuery(c, listTransfersQuerySchema)
		if ('error' in query) return query.error
		const location = requireInventoryLocation(ctx, query.data.locationId)
		if (!location.ok) return location.response
		return respond(
			ctx,
			await listTransfers(await getTenantDb(ctx.orgId), {
				caller: inventoryCaller(ctx),
				locationId: location.locationId,
				direction: query.data.direction,
				status: query.data.status,
				limit: query.data.limit,
			}),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryTransfersRoutes.post('/transfers', writes(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const body = await parseBody(c, createTransferSchema)
		if ('error' in body) return body.error
		return respond(
			ctx,
			await createTransfer(inventoryCaller(ctx), {
				body: body.data,
				idempotency: clientIdempotency(
					ctx,
					'transfers:create',
					body.data.clientId,
					body.data,
				),
			}),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryTransfersRoutes.get('/transfers/:id', reads(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		return respond(
			ctx,
			await getTransfer(inventoryCaller(ctx), { id: idParam(c) }),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryTransfersRoutes.patch(
	'/transfers/:id',
	writes(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const id = idParam(c)
			const body = await parseBody(c, patchTransferSchema)
			if ('error' in body) return body.error
			return respond(
				ctx,
				await patchTransfer(inventoryCaller(ctx), { id, ...body.data }),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryTransfersRoutes.post(
	'/transfers/:id/send',
	writes(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const id = idParam(c)
			const body = await parseBody(c, sendTransferSchema)
			if ('error' in body) return body.error
			return respond(
				ctx,
				await sendTransfer(inventoryCaller(ctx), { id, ...body.data }),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryTransfersRoutes.post(
	'/transfers/:id/receive',
	writes(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const id = idParam(c)
			const body = await parseBody(c, receiveTransferSchema)
			if ('error' in body) return body.error
			return respond(
				ctx,
				await receiveTransfer(inventoryCaller(ctx), { id, ...body.data }),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryTransfersRoutes.post(
	'/transfers/:id/cancel',
	writes(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const id = idParam(c)
			const body = await parseBody(c, cancelTransferSchema)
			if ('error' in body) return body.error
			return respond(
				ctx,
				await cancelTransfer(inventoryCaller(ctx), { id, ...body.data }),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)
