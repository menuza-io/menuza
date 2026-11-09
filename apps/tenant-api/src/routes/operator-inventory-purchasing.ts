import {
	cancelDeliverySchema,
	createSupplierSchema,
	INVENTORY_PERMISSIONS,
	listDeliveriesQuerySchema,
	listSuppliersQuerySchema,
	markDeliveryPaidSchema,
	recordDeliverySchema,
	supplierProductInputSchema,
	updateSupplierProductSchema,
	updateSupplierSchema,
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
	respond,
	parseBody,
	parseQuery,
} from '../lib/inventory-route.ts'
import {
	archiveSupplier,
	archiveSupplierProduct,
	cancelDelivery,
	createSupplier,
	createSupplierProduct,
	getDelivery,
	getSupplier,
	listDeliveries,
	listSuppliers,
	markDeliveryPaid,
	recordDelivery,
	updateSupplier,
	updateSupplierProduct,
} from '../services/inventory-purchasing-service.ts'

/**
 * Suppliers, their products and deliveries under `/operator/inventory`.
 * Suppliers are organization-wide (their unpaid totals count only the
 * token's locations); deliveries belong to a location. Changing suppliers,
 * prices and the paid mark needs `update:inventory_purchasing:any`;
 * recording and cancelling a delivery needs `update:inventory:any`.
 */
export const operatorInventoryPurchasingRoutes = new Hono()

const READ = INVENTORY_PERMISSIONS.READ_INVENTORY
const UPDATE = INVENTORY_PERMISSIONS.UPDATE_INVENTORY
const PURCHASING = INVENTORY_PERMISSIONS.UPDATE_INVENTORY_PURCHASING
const reads = (): ReturnType<typeof inventoryGuard> =>
	inventoryGuard({ scope: ['read', 'write'], grant: READ })
const writes = (): ReturnType<typeof inventoryGuard> =>
	inventoryGuard({ scope: 'write', grant: UPDATE })
const purchasing = (): ReturnType<typeof inventoryGuard> =>
	inventoryGuard({ scope: 'write', grant: PURCHASING })

// ── Suppliers ───────────────────────────────────────────────────────────────

operatorInventoryPurchasingRoutes.get('/suppliers', reads(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const query = parseQuery(c, listSuppliersQuerySchema)
		if ('error' in query) return query.error
		return respond(
			ctx,
			await listSuppliers(await getTenantDb(ctx.orgId), {
				includeArchived: query.data.includeArchived,
				caller: inventoryCaller(ctx),
			}),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryPurchasingRoutes.post(
	'/suppliers',
	purchasing(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const body = await parseBody(c, createSupplierSchema)
			if ('error' in body) return body.error
			return respond(
				ctx,
				await createSupplier(inventoryCaller(ctx), {
					body: body.data,
					idempotency: clientIdempotency(
						ctx,
						'suppliers:create',
						body.data.clientId,
						body.data,
					),
				}),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryPurchasingRoutes.get('/suppliers/:id', reads(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const id = idParam(c)
		return respond(
			ctx,
			await getSupplier(await getTenantDb(ctx.orgId), {
				id,
				caller: inventoryCaller(ctx),
			}),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryPurchasingRoutes.patch(
	'/suppliers/:id',
	purchasing(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const id = idParam(c)
			const body = await parseBody(c, updateSupplierSchema)
			if ('error' in body) return body.error
			return respond(
				ctx,
				await updateSupplier(inventoryCaller(ctx), { id, body: body.data }),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryPurchasingRoutes.post(
	'/suppliers/:id/archive',
	purchasing(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const id = idParam(c)
			const body = await parseBody(c, versionOnlySchema)
			if ('error' in body) return body.error
			return respond(
				ctx,
				await archiveSupplier(inventoryCaller(ctx), {
					id,
					expectedVersion: body.data.expectedVersion,
				}),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryPurchasingRoutes.post(
	'/suppliers/:id/products',
	purchasing(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const id = idParam(c)
			const body = await parseBody(c, supplierProductInputSchema)
			if ('error' in body) return body.error
			return respond(
				ctx,
				await createSupplierProduct(inventoryCaller(ctx), {
					supplierId: id,
					body: body.data,
				}),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryPurchasingRoutes.patch(
	'/supplier-products/:id',
	purchasing(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const id = idParam(c)
			const body = await parseBody(c, updateSupplierProductSchema)
			if ('error' in body) return body.error
			return respond(
				ctx,
				await updateSupplierProduct(inventoryCaller(ctx), {
					id,
					body: body.data,
				}),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryPurchasingRoutes.post(
	'/supplier-products/:id/archive',
	purchasing(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const id = idParam(c)
			const body = await parseBody(c, versionOnlySchema)
			if ('error' in body) return body.error
			return respond(
				ctx,
				await archiveSupplierProduct(inventoryCaller(ctx), {
					id,
					expectedVersion: body.data.expectedVersion,
				}),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

// ── Deliveries ──────────────────────────────────────────────────────────────

operatorInventoryPurchasingRoutes.post('/deliveries', writes(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const body = await parseBody(c, recordDeliverySchema)
		if ('error' in body) return body.error
		const location = requireInventoryLocation(ctx, body.data.locationId)
		if (!location.ok) return location.response
		return respond(
			ctx,
			await recordDelivery(inventoryCaller(ctx), {
				body: body.data,
				idempotency: clientIdempotency(
					ctx,
					'deliveries:record',
					body.data.clientId,
					body.data,
				),
			}),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryPurchasingRoutes.get('/deliveries', reads(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const query = parseQuery(c, listDeliveriesQuerySchema)
		if ('error' in query) return query.error
		const location = requireInventoryLocation(ctx, query.data.locationId)
		if (!location.ok) return location.response
		return respond(
			ctx,
			await listDeliveries(await getTenantDb(ctx.orgId), {
				query: query.data,
				cost: inventoryCaller(ctx).cost,
			}),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryPurchasingRoutes.get('/deliveries/:id', reads(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const id = idParam(c)
		return respond(
			ctx,
			await getDelivery(await getTenantDb(ctx.orgId), {
				id,
				caller: inventoryCaller(ctx),
			}),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryPurchasingRoutes.post(
	'/deliveries/:id/paid',
	purchasing(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const id = idParam(c)
			const body = await parseBody(c, markDeliveryPaidSchema)
			if ('error' in body) return body.error
			return respond(
				ctx,
				await markDeliveryPaid(inventoryCaller(ctx), {
					id,
					expectedVersion: body.data.expectedVersion,
					paid: body.data.paid,
				}),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryPurchasingRoutes.post(
	'/deliveries/:id/cancel',
	writes(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const id = idParam(c)
			const body = await parseBody(c, cancelDeliverySchema)
			if ('error' in body) return body.error
			return respond(
				ctx,
				await cancelDelivery(inventoryCaller(ctx), {
					id,
					expectedVersion: body.data.expectedVersion,
					note: body.data.note,
				}),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)
