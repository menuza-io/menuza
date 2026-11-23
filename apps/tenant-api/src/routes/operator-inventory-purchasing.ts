import {
	accountantExportQuerySchema,
	cancelDeliverySchema,
	confirmDeliveryPricesSchema,
	confirmInvoicePhotoSchema,
	readInvoiceSchema,
	createSupplierSchema,
	creditMessageRequestSchema,
	INVENTORY_PERMISSIONS,
	invoicePhotoRequestSchema,
	listDeliveriesQuerySchema,
	listSuppliersQuerySchema,
	markDeliveryPaidSchema,
	priceAlertsQuerySchema,
	recordDeliverySchema,
	supplierProductInputSchema,
	undoDeliveryAsOrderedSchema,
	updateSupplierProductSchema,
	updateSupplierSchema,
	versionOnlySchema,
} from '@repo/inventory'
import { toCsv, type CsvCell } from '@repo/common/csv'
import { buildTextLinesPdf, type PdfLine } from '@repo/common/pdf'
import { getTenantDb } from '@repo/tenant-db'
import { readDeliveryInvoice } from '../services/inventory-invoice-read-service.ts'
import { Hono } from 'hono'
import { NO_STORE } from '../lib/http.ts'
import {
	getInventoryAuth,
	inventoryGuard,
	requireInventoryLocation,
} from '../lib/inventory-guard.ts'
import {
	InventoryError,
	inventoryErrorResponse,
} from '../lib/inventory-http.ts'
import {
	clientIdempotency,
	idParam,
	inventoryCaller,
	respond,
	parseBody,
	parseOptionalBody,
	parseQuery,
} from '../lib/inventory-route.ts'
import {
	archiveSupplier,
	archiveSupplierProduct,
	cancelDelivery,
	confirmDeliveryPrices,
	createSupplier,
	createSupplierProduct,
	getDelivery,
	getSupplier,
	listDeliveries,
	listSuppliers,
	markDeliveryPaid,
	recordDelivery,
	undoDeliveryAsOrdered,
	updateSupplier,
	updateSupplierProduct,
} from '../services/inventory-purchasing-service.ts'
import { queryDeliveriesReport } from '../services/inventory-deliveries-report.ts'
import {
	confirmInvoicePhoto,
	getCreditMessage,
	getPriceAlerts,
	requestInvoicePhotoUpload,
} from '../services/inventory-receiving-service.ts'

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
const costReads = (): ReturnType<typeof inventoryGuard> =>
	inventoryGuard({
		scope: ['read', 'write'],
		grant: INVENTORY_PERMISSIONS.READ_INVENTORY_COST,
	})

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
		// Receiving against an order is part of purchasing (the flag).
		if (body.data.orderId && !ctx.features.purchasing) {
			throw new InventoryError('feature_disabled', 403)
		}
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

operatorInventoryPurchasingRoutes.post(
	'/deliveries/:id/undo',
	writes(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const id = idParam(c)
			const body = await parseBody(c, undoDeliveryAsOrderedSchema)
			if ('error' in body) return body.error
			return respond(
				ctx,
				await undoDeliveryAsOrdered(inventoryCaller(ctx), {
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

operatorInventoryPurchasingRoutes.post(
	'/deliveries/:id/confirm-prices',
	purchasing(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const id = idParam(c)
			const body = await parseBody(c, confirmDeliveryPricesSchema)
			if ('error' in body) return body.error
			return respond(
				ctx,
				await confirmDeliveryPrices(inventoryCaller(ctx), {
					id,
					body: body.data,
				}),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

// A POST only because it has a body: it changes nothing, so a read token may call it.
operatorInventoryPurchasingRoutes.post(
	'/deliveries/:id/credit-message',
	reads(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const id = idParam(c)
			const body = await parseOptionalBody(c, creditMessageRequestSchema)
			if ('error' in body) return body.error
			return respond(
				ctx,
				await getCreditMessage(await getTenantDb(ctx.orgId), {
					id,
					body: body.data,
					caller: inventoryCaller(ctx),
				}),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryPurchasingRoutes.post(
	'/deliveries/:id/invoice-photo',
	writes(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const id = idParam(c)
			const body = await parseBody(c, invoicePhotoRequestSchema)
			if ('error' in body) return body.error
			return respond(
				ctx,
				await requestInvoicePhotoUpload(await getTenantDb(ctx.orgId), {
					id,
					body: body.data,
					caller: inventoryCaller(ctx),
				}),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryPurchasingRoutes.post(
	'/deliveries/:id/invoice-photo/confirm',
	writes(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const id = idParam(c)
			const body = await parseBody(c, confirmInvoicePhotoSchema)
			if ('error' in body) return body.error
			return respond(
				ctx,
				await confirmInvoicePhoto(inventoryCaller(ctx), {
					id,
					key: body.data.key,
				}),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryPurchasingRoutes.post(
	'/deliveries/:id/invoice-photo/read',
	purchasing(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const id = idParam(c)
			const body = await parseBody(c, readInvoiceSchema)
			if ('error' in body) return body.error
			return respond(
				ctx,
				await readDeliveryInvoice(inventoryCaller(ctx), { id }),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

// ── Price alerts ────────────────────────────────────────────────────────────

operatorInventoryPurchasingRoutes.get(
	'/price-alerts',
	costReads(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const query = parseQuery(c, priceAlertsQuerySchema)
			if ('error' in query) return query.error
			const location = requireInventoryLocation(ctx, query.data.locationId)
			if (!location.ok) return location.response
			return respond(
				ctx,
				await getPriceAlerts(await getTenantDb(ctx.orgId), {
					query: query.data,
					now: Date.now(),
				}),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

function minorToMajor(minor: number): number {
	return Number((minor / 100).toFixed(2))
}

function formatMoneyText(minor: number): string {
	return (minor / 100).toFixed(2)
}

operatorInventoryPurchasingRoutes.get(
	'/purchasing/accountant-export',
	costReads(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const query = parseQuery(c, accountantExportQuerySchema)
			if ('error' in query) return query.error
			const { from, to, locationId, format } = query.data
			if (from > to) {
				throw new InventoryError('invalid_request', 400, {
					message: 'from date must be on or before to date',
				})
			}
			if (locationId !== 'all') {
				const location = requireInventoryLocation(ctx, locationId)
				if (!location.ok) return location.response
			}
			const report = await queryDeliveriesReport(await getTenantDb(ctx.orgId), {
				from,
				to,
				locationId,
				locationIds: ctx.locationIds,
			})
			const { internalRows: _internalRows, ...accountantExport } = report

			if (format === 'csv') {
				const headers = [
					'Date',
					'Business date',
					'Invoice date',
					'Location',
					'Supplier',
					'Supplier VAT',
					'Invoice #',
					'ZATCA Ref',
					'Type',
					'Paid',
					'Net',
					'VAT',
					'Total',
					'Currency',
					...accountantExport.categories.map((cat) => `Category: ${cat}`),
				]
				const csvRows: CsvCell[][] = accountantExport.rows.map((row) => [
					row.date,
					row.businessDate,
					row.invoiceDate ?? '',
					row.locationId,
					row.supplierName,
					row.supplierVatNumber ?? '',
					row.invoiceNumber ?? '',
					row.zatcaReference ?? '',
					row.isCredit ? 'Credit' : 'Delivery',
					row.paid ? 'Paid' : 'Unpaid',
					minorToMajor(row.netMinor),
					minorToMajor(row.vatMinor),
					minorToMajor(row.totalMinor),
					row.currency,
					...accountantExport.categories.map((cat) =>
						minorToMajor(row.categoryBreakdown[cat] ?? 0),
					),
				])
				csvRows.push([])
				csvRows.push(['Supplier totals'])
				csvRows.push([
					'Supplier',
					'Supplier VAT',
					'Deliveries',
					'Net',
					'VAT',
					'Total',
					'Paid',
					'Unpaid',
				])
				for (const sup of accountantExport.supplierTotals) {
					csvRows.push([
						sup.supplierName,
						sup.supplierVatNumber ?? '',
						sup.deliveryCount,
						minorToMajor(sup.netMinor),
						minorToMajor(sup.vatMinor),
						minorToMajor(sup.totalMinor),
						minorToMajor(sup.paidMinor),
						minorToMajor(sup.unpaidMinor),
					])
				}
				csvRows.push([])
				csvRows.push(['Category totals'])
				for (const cat of accountantExport.categories) {
					csvRows.push([
						cat,
						minorToMajor(accountantExport.categoryTotals[cat] ?? 0),
					])
				}
				csvRows.push([])
				csvRows.push([
					'Grand totals',
					`Count: ${accountantExport.totals.count}`,
					`Net: ${formatMoneyText(accountantExport.totals.netMinor)}`,
					`VAT: ${formatMoneyText(accountantExport.totals.vatMinor)}`,
					`Total: ${formatMoneyText(accountantExport.totals.totalMinor)}`,
					`Paid: ${formatMoneyText(accountantExport.totals.paidMinor)}`,
					`Unpaid: ${formatMoneyText(accountantExport.totals.unpaidMinor)}`,
				])
				const csv = toCsv(headers, csvRows, { bom: true })
				return new Response(csv, {
					status: 200,
					headers: {
						'Content-Type': 'text/csv; charset=utf-8',
						'Content-Disposition': `attachment; filename="accountant-export-${from}-to-${to}.csv"`,
						...NO_STORE,
					},
				})
			}

			if (format === 'pdf') {
				const lines: PdfLine[] = [
					{
						text: `Deliveries Accountant Export (${from} to ${to})`,
						bold: true,
						size: 13,
					},
					{
						text: `Location: ${locationId}   Currency: ${accountantExport.currency}   Deliveries: ${accountantExport.totals.count}`,
						size: 9,
					},
					{ text: '' },
					{
						text: 'Date | Supplier | VAT # | Invoice # | ZATCA | Net | VAT | Total | Status',
						bold: true,
						size: 9,
					},
				]
				for (const row of accountantExport.rows) {
					const catText = accountantExport.categories
						.filter((cat) => (row.categoryBreakdown[cat] ?? 0) !== 0)
						.map(
							(cat) => `${cat}=${formatMoneyText(row.categoryBreakdown[cat]!)}`,
						)
						.join(', ')
					lines.push({
						text: `${row.date} | ${row.supplierName}${row.isCredit ? ' (Credit)' : ''} | ${row.supplierVatNumber ?? '-'} | ${row.invoiceNumber ?? '-'} | ${row.zatcaReference ?? '-'} | ${formatMoneyText(row.netMinor)} | ${formatMoneyText(row.vatMinor)} | ${formatMoneyText(row.totalMinor)} | ${row.paid ? 'Paid' : 'Unpaid'}`,
						size: 8,
					})
					if (catText) {
						lines.push({ text: `   Categories: ${catText}`, size: 8 })
					}
				}
				lines.push({ text: '' })
				lines.push({ text: 'Supplier Totals', bold: true, size: 10 })
				for (const sup of accountantExport.supplierTotals) {
					lines.push({
						text: `${sup.supplierName} (${sup.supplierVatNumber ?? 'No VAT'}) | ${sup.deliveryCount}x | Net ${formatMoneyText(sup.netMinor)} | VAT ${formatMoneyText(sup.vatMinor)} | Total ${formatMoneyText(sup.totalMinor)} | Paid ${formatMoneyText(sup.paidMinor)} | Unpaid ${formatMoneyText(sup.unpaidMinor)}`,
						size: 8,
					})
				}
				lines.push({ text: '' })
				lines.push({ text: 'Category Totals', bold: true, size: 10 })
				for (const cat of accountantExport.categories) {
					lines.push({
						text: `${cat}: ${formatMoneyText(accountantExport.categoryTotals[cat] ?? 0)}`,
						size: 8,
					})
				}
				lines.push({ text: '' })
				lines.push({
					text: `Grand Total: Net ${formatMoneyText(accountantExport.totals.netMinor)} | VAT ${formatMoneyText(accountantExport.totals.vatMinor)} | Total ${formatMoneyText(accountantExport.totals.totalMinor)} | Paid ${formatMoneyText(accountantExport.totals.paidMinor)} | Unpaid ${formatMoneyText(accountantExport.totals.unpaidMinor)}`,
					bold: true,
					size: 10,
				})
				const pdfBytes = buildTextLinesPdf(lines)
				const pdfBody = new Uint8Array(pdfBytes)
				return new Response(pdfBody, {
					status: 200,
					headers: {
						'Content-Type': 'application/pdf',
						'Content-Disposition': `attachment; filename="accountant-export-${from}-to-${to}.pdf"`,
						...NO_STORE,
					},
				})
			}

			return respond(ctx, accountantExport)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)
