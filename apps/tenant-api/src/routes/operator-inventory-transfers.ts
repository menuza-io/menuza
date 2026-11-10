import {
	cancelTransferSchema,
	compareQuerySchema,
	createTransferSchema,
	INVENTORY_PERMISSIONS,
	listTransfersQuerySchema,
	patchTransferSchema,
	receiveTransferSchema,
	sendTransferSchema,
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
