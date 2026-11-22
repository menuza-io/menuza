import {
	hasInventoryGrant,
	INVENTORY_PERMISSIONS,
	mergeItemBodySchema,
	mergePreviewQuerySchema,
	mergeSupplierBodySchema,
} from '@repo/inventory'
import { getTenantDb } from '@repo/tenant-db'
import { Hono } from 'hono'
import { z } from 'zod'
import { getInventoryAuth, inventoryGuard } from '../lib/inventory-guard.ts'
import { inventoryDeny, inventoryErrorResponse } from '../lib/inventory-http.ts'
import {
	idParam,
	inventoryCaller,
	parseBody,
	parseQuery,
	respond,
} from '../lib/inventory-route.ts'
import {
	mergeCandidates,
	mergeItems,
	mergeKind,
	mergeSuppliers,
	previewItemMerge,
	previewSupplierMerge,
	undoMerge,
} from '../services/inventory-merge-service.ts'

/**
 * Merge duplicate items and suppliers (#493) under `/operator/inventory`.
 * Items need `update:inventory:any` (recipes moving also need the recipe
 * grant, checked by the service); suppliers need the purchasing grant. Undo
 * works for 24 hours.
 */
export const operatorInventoryMergeRoutes = new Hono()

const READ = INVENTORY_PERMISSIONS.READ_INVENTORY
const UPDATE = INVENTORY_PERMISSIONS.UPDATE_INVENTORY
const PURCHASING = INVENTORY_PERMISSIONS.UPDATE_INVENTORY_PURCHASING

const reads = () => inventoryGuard({ scope: ['read', 'write'], grant: READ })
const writes = () => inventoryGuard({ scope: 'write', grant: UPDATE })
const supplierReads = () =>
	inventoryGuard({
		scope: ['read', 'write'],
		grant: READ,
		feature: 'purchasing',
	})
const supplierWrites = () =>
	inventoryGuard({ scope: 'write', grant: PURCHASING, feature: 'purchasing' })

const undoBodySchema = z.object({}).strict()

/**
 * Merging and undoing move stock at every place the item is kept, so a token
 * limited to some locations may not do either (like the settings).
 */
function organizationWide(ctx: { locationIds: readonly string[] | null }) {
	return ctx.locationIds === null
		? null
		: inventoryDeny(403, 'location_forbidden')
}

operatorInventoryMergeRoutes.get(
	'/items/:id/merge-candidates',
	reads(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			return respond(
				ctx,
				await mergeCandidates(await getTenantDb(ctx.orgId), {
					itemId: idParam(c),
				}),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryMergeRoutes.get(
	'/items/:id/merge-preview',
	reads(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const id = idParam(c)
			const query = parseQuery(c, mergePreviewQuerySchema)
			if ('error' in query) return query.error
			return respond(
				ctx,
				await previewItemMerge(await getTenantDb(ctx.orgId), {
					itemId: id,
					intoItemId: query.data.intoItemId,
					caller: inventoryCaller(ctx),
				}),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryMergeRoutes.post('/items/:id/merge', writes(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const scoped = organizationWide(ctx)
		if (scoped) return scoped
		const id = idParam(c)
		const body = await parseBody(c, mergeItemBodySchema)
		if ('error' in body) return body.error
		return respond(
			ctx,
			await mergeItems(inventoryCaller(ctx), { itemId: id, body: body.data }),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryMergeRoutes.get(
	'/suppliers/:id/merge-preview',
	supplierReads(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const id = idParam(c)
			const raw = c.req.query('intoSupplierId')
			const parsed = z.string().min(1).max(64).safeParse(raw)
			if (!parsed.success) {
				return inventoryDeny(400, 'invalid_request')
			}
			return respond(
				ctx,
				await previewSupplierMerge(await getTenantDb(ctx.orgId), {
					supplierId: id,
					intoSupplierId: parsed.data,
					cost: inventoryCaller(ctx).cost,
				}),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryMergeRoutes.post(
	'/suppliers/:id/merge',
	supplierWrites(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const id = idParam(c)
			const body = await parseBody(c, mergeSupplierBodySchema)
			if ('error' in body) return body.error
			return respond(
				ctx,
				await mergeSuppliers(inventoryCaller(ctx), {
					supplierId: id,
					body: body.data,
				}),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryMergeRoutes.post('/merges/:id/undo', writes(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const id = idParam(c)
		const body = await parseBody(c, undoBodySchema)
		if ('error' in body) return body.error
		const kind = await mergeKind(await getTenantDb(ctx.orgId), id)
		if (kind === 'item') {
			const scoped = organizationWide(ctx)
			if (scoped) return scoped
		} else if (
			// A supplier merge needs what merging suppliers needs.
			!hasInventoryGrant(ctx.grants, PURCHASING) ||
			!ctx.features.purchasing
		) {
			return ctx.features.purchasing
				? inventoryDeny(403, 'forbidden', {
						reason: 'grant',
						required: PURCHASING,
					})
				: inventoryDeny(403, 'feature_disabled')
		}
		return respond(
			ctx,
			await undoMerge(inventoryCaller(ctx), { mergeId: id, kind }),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})
