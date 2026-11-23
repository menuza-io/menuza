import {
	applySetupImportSchema,
	INVENTORY_PERMISSIONS,
	priceListApplySchema,
	priceListParseSchema,
	readRawInvoiceSchema,
	startSetupImportSchema,
} from '@repo/inventory'
import { getTenantDb } from '@repo/tenant-db'
import { Hono } from 'hono'
import { getInventoryAuth, inventoryGuard } from '../lib/inventory-guard.ts'
import { inventoryErrorResponse } from '../lib/inventory-http.ts'
import {
	idParam,
	inventoryCaller,
	parseBody,
	respond,
} from '../lib/inventory-route.ts'
import { readRawInvoice } from '../services/inventory-invoice-read-service.ts'
import {
	applySupplierPriceList,
	listItemPriceHistory,
	listSupplierProductPrices,
	parseSupplierPriceList,
} from '../services/inventory-price-list-service.ts'
import {
	applySetupImport,
	getSetupImport,
	listSetupImports,
	startSetupImport,
} from '../services/inventory-setup-import-service.ts'

/**
 * Operator inventory import and document-reading routes under
 * `/operator/inventory`:
 * - #505 supplier price list parse, apply, and price history
 * - #506 resumable multi-file setup imports
 * - #504 raw invoice reading before a delivery is saved
 */
export const operatorInventoryImportsRoutes = new Hono()

const READ = INVENTORY_PERMISSIONS.READ_INVENTORY
const PURCHASING = INVENTORY_PERMISSIONS.UPDATE_INVENTORY_PURCHASING
const COST = INVENTORY_PERMISSIONS.READ_INVENTORY_COST

const reads = (): ReturnType<typeof inventoryGuard> =>
	inventoryGuard({ scope: ['read', 'write'], grant: READ })
const purchasing = (): ReturnType<typeof inventoryGuard> =>
	inventoryGuard({ scope: 'write', grant: PURCHASING })
const costReads = (): ReturnType<typeof inventoryGuard> =>
	inventoryGuard({ scope: ['read', 'write'], grant: COST })

// ── #505 Supplier price-list import & price history ─────────────────────────

operatorInventoryImportsRoutes.post(
	'/suppliers/:id/price-list/parse',
	purchasing(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const id = idParam(c)
			const body = await parseBody(c, priceListParseSchema)
			if ('error' in body) return body.error
			return respond(
				ctx,
				await parseSupplierPriceList(inventoryCaller(ctx), {
					supplierId: id,
					body: body.data,
				}),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryImportsRoutes.post(
	'/suppliers/:id/price-list/apply',
	purchasing(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const id = idParam(c)
			const body = await parseBody(c, priceListApplySchema)
			if ('error' in body) return body.error
			return respond(
				ctx,
				await applySupplierPriceList(inventoryCaller(ctx), {
					supplierId: id,
					body: body.data,
				}),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryImportsRoutes.get(
	'/supplier-products/:id/prices',
	costReads(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const id = idParam(c)
			return respond(
				ctx,
				await listSupplierProductPrices(await getTenantDb(ctx.orgId), id),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryImportsRoutes.get(
	'/items/:id/price-history',
	costReads(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const id = idParam(c)
			return respond(
				ctx,
				await listItemPriceHistory(await getTenantDb(ctx.orgId), id),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

// ── #506 Start inventory from past invoices & price lists ───────────────────

operatorInventoryImportsRoutes.get('/setup/imports', reads(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		return respond(
			ctx,
			await listSetupImports(ctx.orgId, inventoryCaller(ctx).cost),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryImportsRoutes.post(
	'/setup/imports',
	purchasing(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const body = await parseBody(c, startSetupImportSchema)
			if ('error' in body) return body.error
			return respond(
				ctx,
				await startSetupImport(inventoryCaller(ctx), body.data),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryImportsRoutes.get('/setup/imports/:id', reads(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const id = idParam(c)
		return respond(
			ctx,
			await getSetupImport(ctx.orgId, id, inventoryCaller(ctx).cost),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryImportsRoutes.post(
	'/setup/imports/:id/apply',
	purchasing(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const id = idParam(c)
			const body = await parseBody(c, applySetupImportSchema)
			if ('error' in body) return body.error
			return respond(
				ctx,
				await applySetupImport(inventoryCaller(ctx), id, body.data),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

// ── #504 Raw invoice read (pre-delivery save) ───────────────────────────────

operatorInventoryImportsRoutes.post(
	'/deliveries/invoice/read',
	purchasing(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const body = await parseBody(c, readRawInvoiceSchema)
			if ('error' in body) return body.error
			return respond(ctx, await readRawInvoice(inventoryCaller(ctx), body.data))
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)
