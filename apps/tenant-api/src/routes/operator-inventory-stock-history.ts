import {
	exportChunkSchema,
	INVENTORY_PERMISSIONS,
	stockDayQuerySchema,
	stockDaySchema,
	stockOnDateQuerySchema,
	stockOnDateSchema,
	stockValueExportQuerySchema,
} from '@repo/inventory'
import { EXPORT_CHUNK_ROWS } from '@repo/reports/export'
import { getTenantDb } from '@repo/tenant-db'
import { Hono } from 'hono'
import {
	getInventoryAuth,
	inventoryGuard,
	requireInventoryLocation,
} from '../lib/inventory-guard.ts'
import { inventoryDeny, inventoryErrorResponse } from '../lib/inventory-http.ts'
import { inventoryCaller, parseQuery, respond } from '../lib/inventory-route.ts'
import {
	getStockDay,
	getStockOnDate,
	getStockValueExportChunk,
} from '../services/inventory-stock-history-service.ts'

/**
 * Stock and stock value on a past business day (#521), under
 * `/operator/inventory/stock`. Read only; money needs the cost grant.
 */
export const operatorInventoryStockHistoryRoutes = new Hono()

const READ = INVENTORY_PERMISSIONS.READ_INVENTORY

operatorInventoryStockHistoryRoutes.get(
	'/stock/on-date',
	inventoryGuard({ scope: ['read', 'write'], grant: READ }),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const query = parseQuery(c, stockOnDateQuerySchema)
			if ('error' in query) return query.error
			const location = requireInventoryLocation(ctx, query.data.locationId)
			if (!location.ok) return location.response
			return respond(
				ctx,
				stockOnDateSchema.parse(
					await getStockOnDate(await getTenantDb(ctx.orgId), {
						...query.data,
						locationId: location.locationId,
						caller: inventoryCaller(ctx),
						now: Date.now(),
					}),
				),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryStockHistoryRoutes.get(
	'/stock/day',
	inventoryGuard({ scope: ['read', 'write'], grant: READ }),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const query = parseQuery(c, stockDayQuerySchema)
			if ('error' in query) return query.error
			const location = requireInventoryLocation(ctx, query.data.locationId)
			if (!location.ok) return location.response
			return respond(
				ctx,
				stockDaySchema.parse(
					await getStockDay(await getTenantDb(ctx.orgId), {
						...query.data,
						locationId: location.locationId,
						caller: inventoryCaller(ctx),
						now: Date.now(),
					}),
				),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryStockHistoryRoutes.get(
	'/stock/value-export',
	inventoryGuard({ scope: ['read', 'write'], grant: READ }),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const caller = inventoryCaller(ctx)
			// A file of money: the cost grant, not just the read grant.
			if (!caller.cost) {
				return inventoryDeny(403, 'forbidden', {
					reason: 'grant',
					required: INVENTORY_PERMISSIONS.READ_INVENTORY_COST,
				})
			}
			const query = parseQuery(c, stockValueExportQuerySchema)
			if ('error' in query) return query.error
			const location = requireInventoryLocation(ctx, query.data.locationId)
			if (!location.ok) return location.response
			return respond(
				ctx,
				exportChunkSchema.parse(
					await getStockValueExportChunk(await getTenantDb(ctx.orgId), {
						locationId: location.locationId,
						date: query.data.date,
						cursor: query.data.cursor,
						caller,
						now: Date.now(),
						pageSize: EXPORT_CHUNK_ROWS,
					}),
				),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)
