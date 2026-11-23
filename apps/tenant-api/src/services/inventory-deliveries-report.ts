import {
	type AccountantExport,
	type AccountantExportRow,
} from '@repo/inventory'
import {
	type ReportDefinition,
	type ReportRecord,
	timeframeLoadWindow,
} from '@repo/reports'
import {
	invDeliveries,
	invDeliveryLines,
	invItems,
	invLocationSettings,
	invSuppliers,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, asc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm'
import { queryInChunks } from '../lib/chunked-in.ts'
import { type InventoryReader } from '../lib/inventory-write.ts'

export type DeliveriesReportRowInternal = AccountantExportRow & {
	receivedAt: number
}

export type DeliveriesReportResult = AccountantExport & {
	internalRows: DeliveriesReportRowInternal[]
}

export type DeliveriesReportQuery = {
	from?: string
	to?: string
	receivedAtFromMs?: number
	receivedAtToMs?: number
	locationId?: string
	locationIds?: readonly string[] | null
	fallbackCurrency?: string
}

/**
 * Queries received deliveries (including credit notes and cash market purchases)
 * with supplier details, invoice/ZATCA metadata, and per-category net breakdown.
 * Shared identically between Purchasing "Export for accountant" (`#507`) and
 * the `inventory_deliveries` Analytics subject.
 */
export async function queryDeliveriesReport(
	db: InventoryReader | TenantDatabase,
	query: DeliveriesReportQuery,
): Promise<DeliveriesReportResult> {
	if (
		query.locationIds !== undefined &&
		query.locationIds !== null &&
		query.locationIds.length === 0
	) {
		return emptyReport(query)
	}

	const conditions: SQL[] = [eq(invDeliveries.status, 'received')]
	const effectiveDateExpr = sql<string>`coalesce(${invDeliveries.invoiceDate}, ${invDeliveries.businessDate})`
	const receivedAtExpr = sql<number>`coalesce(${invDeliveries.receivedAt}, ${invDeliveries.createdAt})`

	if (query.from) {
		conditions.push(gte(effectiveDateExpr, query.from))
	}
	if (query.to) {
		conditions.push(lte(effectiveDateExpr, query.to))
	}
	if (query.receivedAtFromMs !== undefined) {
		conditions.push(gte(receivedAtExpr, query.receivedAtFromMs))
	}
	if (query.receivedAtToMs !== undefined) {
		conditions.push(lte(receivedAtExpr, query.receivedAtToMs))
	}
	if (query.locationId && query.locationId !== 'all') {
		conditions.push(eq(invDeliveries.locationId, query.locationId))
	}
	if (query.locationIds && query.locationIds.length > 0) {
		conditions.push(inArray(invDeliveries.locationId, [...query.locationIds]))
	}

	const deliveries = await db
		.select({
			delivery: invDeliveries,
			supplierName: invSuppliers.name,
			supplierVatNumber: invSuppliers.vatNumber,
		})
		.from(invDeliveries)
		.leftJoin(invSuppliers, eq(invSuppliers.id, invDeliveries.supplierId))
		.where(and(...conditions))
		.orderBy(
			asc(effectiveDateExpr),
			asc(invDeliveries.createdAt),
			asc(invDeliveries.id),
		)

	const deliveryIds = deliveries.map((d) => d.delivery.id)
	const lineRows = await queryInChunks(deliveryIds, (chunk) =>
		db
			.select({
				deliveryId: invDeliveryLines.deliveryId,
				lineTotalMinor: invDeliveryLines.lineTotalMinor,
				category: invItems.category,
			})
			.from(invDeliveryLines)
			.innerJoin(invItems, eq(invItems.id, invDeliveryLines.itemId))
			.where(inArray(invDeliveryLines.deliveryId, chunk)),
	)

	const linesByDelivery = new Map<
		string,
		{ linesTotal: number; categories: Map<string, number> }
	>()
	const allCategories = new Set<string>()
	for (const line of lineRows) {
		const cat = line.category?.trim() || 'uncategorized'
		allCategories.add(cat)
		let entry = linesByDelivery.get(line.deliveryId)
		if (!entry) {
			entry = { linesTotal: 0, categories: new Map() }
			linesByDelivery.set(line.deliveryId, entry)
		}
		entry.linesTotal += line.lineTotalMinor
		entry.categories.set(
			cat,
			(entry.categories.get(cat) ?? 0) + line.lineTotalMinor,
		)
	}

	const categories = [...allCategories].sort((a, b) => a.localeCompare(b))
	const internalRows: DeliveriesReportRowInternal[] = []
	const supplierMap = new Map<
		string,
		{
			supplierId: string | null
			supplierName: string
			supplierVatNumber: string | null
			deliveryCount: number
			netMinor: number
			vatMinor: number
			totalMinor: number
			paidMinor: number
			unpaidMinor: number
		}
	>()
	const categoryTotals: Record<string, number> = {}
	for (const cat of categories) {
		categoryTotals[cat] = 0
	}

	let totalNet = 0
	let totalVat = 0
	let totalGrand = 0
	let totalPaid = 0
	let totalUnpaid = 0
	const currencyMap = new Map<
		string,
		{
			currency: string
			count: number
			netMinor: number
			vatMinor: number
			totalMinor: number
			paidMinor: number
			unpaidMinor: number
		}
	>()

	for (const entry of deliveries) {
		const row = entry.delivery
		const lines = linesByDelivery.get(row.id)
		const linesTotal = lines?.linesTotal ?? 0
		const baseVat = row.vatMinor ?? 0
		const baseTotal = row.totalMinor ?? linesTotal + baseVat
		const baseNet = row.totalMinor !== null ? baseTotal - baseVat : linesTotal
		const sign = row.isCredit ? -1 : 1

		const netMinor = sign * baseNet
		const vatMinor = sign * baseVat
		const totalMinor = sign * baseTotal
		const paid = row.paidAt !== null
		const date = row.invoiceDate ?? row.businessDate
		const supplierName = entry.supplierName ?? 'No supplier'
		const supplierVatNumber = entry.supplierVatNumber ?? null

		const categoryBreakdown: Record<string, number> = {}
		if (lines) {
			for (const [cat, amount] of lines.categories) {
				const signedAmount = sign * amount
				categoryBreakdown[cat] = signedAmount
				categoryTotals[cat] = (categoryTotals[cat] ?? 0) + signedAmount
			}
		}

		internalRows.push({
			deliveryId: row.id,
			date,
			businessDate: row.businessDate,
			invoiceDate: row.invoiceDate,
			locationId: row.locationId,
			supplierId: row.supplierId,
			supplierName,
			supplierVatNumber,
			invoiceNumber: row.invoiceNumber,
			zatcaReference: row.zatcaReference,
			paid,
			isCredit: row.isCredit,
			netMinor,
			vatMinor,
			totalMinor,
			currency: row.currency,
			categoryBreakdown,
			receivedAt: row.receivedAt ?? row.createdAt,
		})

		totalNet += netMinor
		totalVat += vatMinor
		totalGrand += totalMinor
		if (paid) {
			totalPaid += totalMinor
		} else {
			totalUnpaid += totalMinor
		}

		let curEntry = currencyMap.get(row.currency)
		if (!curEntry) {
			curEntry = {
				currency: row.currency,
				count: 0,
				netMinor: 0,
				vatMinor: 0,
				totalMinor: 0,
				paidMinor: 0,
				unpaidMinor: 0,
			}
			currencyMap.set(row.currency, curEntry)
		}
		curEntry.count += 1
		curEntry.netMinor += netMinor
		curEntry.vatMinor += vatMinor
		curEntry.totalMinor += totalMinor
		if (paid) {
			curEntry.paidMinor += totalMinor
		} else {
			curEntry.unpaidMinor += totalMinor
		}

		const supKey = row.supplierId ?? `__none__:${supplierName}`
		let sup = supplierMap.get(supKey)
		if (!sup) {
			sup = {
				supplierId: row.supplierId,
				supplierName,
				supplierVatNumber,
				deliveryCount: 0,
				netMinor: 0,
				vatMinor: 0,
				totalMinor: 0,
				paidMinor: 0,
				unpaidMinor: 0,
			}
			supplierMap.set(supKey, sup)
		}
		sup.deliveryCount += 1
		sup.netMinor += netMinor
		sup.vatMinor += vatMinor
		sup.totalMinor += totalMinor
		if (paid) {
			sup.paidMinor += totalMinor
		} else {
			sup.unpaidMinor += totalMinor
		}
	}

	const rows: AccountantExportRow[] = internalRows.map(
		({ receivedAt: _receivedAt, ...rest }) => rest,
	)
	const supplierTotals = [...supplierMap.values()].sort((a, b) =>
		a.supplierName.localeCompare(b.supplierName),
	)

	let currency = internalRows[0]?.currency ?? query.fallbackCurrency
	if (!currency) {
		const locSetting = await db
			.select({ currency: invLocationSettings.currency })
			.from(invLocationSettings)
			.where(
				query.locationId && query.locationId !== 'all'
					? eq(invLocationSettings.locationId, query.locationId)
					: undefined,
			)
			.limit(1)
			.get()
		currency = locSetting?.currency ?? 'USD'
	}

	const totalsByCurrency = [...currencyMap.values()].sort((a, b) =>
		a.currency.localeCompare(b.currency),
	)

	return {
		from: query.from ?? '',
		to: query.to ?? '',
		locationId: query.locationId ?? 'all',
		currency,
		categories,
		rows,
		supplierTotals,
		categoryTotals,
		totals: {
			count: rows.length,
			netMinor: totalNet,
			vatMinor: totalVat,
			totalMinor: totalGrand,
			paidMinor: totalPaid,
			unpaidMinor: totalUnpaid,
		},
		...(totalsByCurrency.length > 1 ? { totalsByCurrency } : {}),
		internalRows,
	}
}

function emptyReport(query: DeliveriesReportQuery): DeliveriesReportResult {
	return {
		from: query.from ?? '',
		to: query.to ?? '',
		locationId: query.locationId ?? 'all',
		currency: query.fallbackCurrency ?? 'USD',
		categories: [],
		rows: [],
		supplierTotals: [],
		categoryTotals: {},
		totals: {
			count: 0,
			netMinor: 0,
			vatMinor: 0,
			totalMinor: 0,
			paidMinor: 0,
			unpaidMinor: 0,
		},
		internalRows: [],
	}
}

export const INVENTORY_DELIVERIES_REPORT_MAX_ROWS = 50_000

/**
 * Loads `inventory_deliveries` report records for the Analytics engine (`#507`),
 * reusing `queryDeliveriesReport` so numbers match the accountant export identically.
 */
export async function loadInventoryDeliveryRecords(
	ctx: {
		db: TenantDatabase
		locationIds: readonly string[] | null
		locationNames: ReadonlyMap<string, string>
		now: number
	},
	definition: ReportDefinition,
): Promise<{ records: ReportRecord[]; truncated: boolean }> {
	const window = timeframeLoadWindow(
		definition.timeframe.preset,
		new Date(ctx.now),
		definition.timeframe,
	)
	const report = await queryDeliveriesReport(ctx.db, {
		receivedAtFromMs: window.start?.getTime(),
		receivedAtToMs: window.end.getTime(),
		locationIds: ctx.locationIds,
	})
	const sliced =
		report.internalRows.length > INVENTORY_DELIVERIES_REPORT_MAX_ROWS
			? report.internalRows.slice(-INVENTORY_DELIVERIES_REPORT_MAX_ROWS)
			: report.internalRows
	const records: ReportRecord[] = sliced.map((row) => ({
		receivedAt: new Date(row.receivedAt),
		businessDate: row.businessDate,
		invoiceDate: row.invoiceDate ?? row.businessDate,
		location: ctx.locationNames.get(row.locationId) ?? row.locationId,
		supplierName: row.supplierName,
		supplierVatNumber: row.supplierVatNumber ?? '',
		invoiceNumber: row.invoiceNumber ?? '',
		zatcaReference: row.zatcaReference ?? '',
		paid: row.paid,
		isCredit: row.isCredit,
		// Report engine currency fields store major currency units (matching sales/gift cards).
		netMinor: row.netMinor / 100,
		vatMinor: row.vatMinor / 100,
		totalMinor: row.totalMinor / 100,
		currency: row.currency,
	}))
	return {
		records,
		truncated:
			report.internalRows.length > INVENTORY_DELIVERIES_REPORT_MAX_ROWS,
	}
}
