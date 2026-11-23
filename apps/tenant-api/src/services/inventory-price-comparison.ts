import {
	costMicroFromPackPriceClamped,
	INVENTORY_PERMISSIONS,
	type ItemOthersPay,
	inventoryValueMinorClamped,
	type PriceComparisonEntry,
	type PriceComparisonItem,
	type PriceComparisonQuery,
	type PriceComparisonResult,
	priceChangeBp,
} from '@repo/inventory'
import { addDays } from '@repo/reservations'
import {
	invDeliveries,
	invDeliveryLines,
	invItems,
	invLocationSettings,
	invSuppliers,
} from '@repo/tenant-db'
import { and, eq, gt, gte, isNotNull, lte, sql, type SQL } from 'drizzle-orm'
import { inJsonList } from '../lib/chunked-in.ts'
import { InventoryError } from '../lib/inventory-http.ts'
import { type InventoryReader } from '../lib/inventory-write.ts'
import { locationBusinessDate } from './inventory-common.ts'
import { type InventoryCaller } from './inventory-items-service.ts'

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_LOOKBACK_DAYS = 90

type RawComparisonRow = {
	itemId: string
	itemName: string
	baseUnit: 'g' | 'ml' | 'piece'
	locationId: string
	supplierId: string | null
	supplierName: string | null
	deliveryId: string
	currency: string
	quantity: number
	realWeightQuantity: number | null
	lineTotalMinor: number
	pricedAt: number
	receivedAt: number | null
	createdAt: number
	seq: number
}

function compareRecencyDesc(a: RawComparisonRow, b: RawComparisonRow): number {
	return (
		b.pricedAt - a.pricedAt ||
		(b.receivedAt ?? b.createdAt) - (a.receivedAt ?? a.createdAt) ||
		b.createdAt - a.createdAt ||
		b.seq - a.seq
	)
}

function effectiveLineQuantity(row: {
	realWeightQuantity: number | null
	quantity: number
}): number {
	return row.realWeightQuantity ?? row.quantity
}

async function resolveDefaultRange(
	db: InventoryReader,
	input: {
		from?: string
		to?: string
		caller: Pick<InventoryCaller, 'locationIds' | 'region'>
		now: number
	},
): Promise<{ from: string; to: string }> {
	let defaultTo = new Date(input.now).toISOString().slice(0, 10)
	if (!input.to) {
		const sampleLoc =
			input.caller.locationIds && input.caller.locationIds.length > 0
				? input.caller.locationIds[0]!
				: (
						await db
							.select({ locationId: invLocationSettings.locationId })
							.from(invLocationSettings)
							.limit(1)
							.get()
					)?.locationId
		if (sampleLoc) {
			defaultTo = await locationBusinessDate(db, sampleLoc, input.now)
		}
	}
	const to = input.to ?? defaultTo
	const from = input.from ?? addDays(to, -(DEFAULT_LOOKBACK_DAYS - 1))
	if (from > to) {
		throw new InventoryError('invalid_request', 400, {
			message: 'from date must be on or before to date',
		})
	}
	return { from, to }
}

async function fallbackCurrency(
	db: InventoryReader,
	caller: Pick<InventoryCaller, 'locationIds' | 'region'>,
): Promise<string> {
	const setting =
		caller.locationIds && caller.locationIds.length > 0
			? await db
					.select({ currency: invLocationSettings.currency })
					.from(invLocationSettings)
					.where(inJsonList(invLocationSettings.locationId, caller.locationIds))
					.limit(1)
					.get()
			: await db
					.select({ currency: invLocationSettings.currency })
					.from(invLocationSettings)
					.limit(1)
					.get()
	return setting?.currency ?? (caller.region === 'ksa' ? 'SAR' : 'USD')
}

/**
 * `GET /price-comparison`: compares prices paid per base unit for each item
 * across suppliers and allowed locations in `[from, to]`. Requires
 * `read:inventory_cost:any` and strictly scopes queries to `caller.locationIds`.
 */
export async function getPriceComparison(
	db: InventoryReader,
	input: {
		query: PriceComparisonQuery
		caller: Pick<InventoryCaller, 'locationIds' | 'cost' | 'region'>
		now: number
	},
): Promise<PriceComparisonResult> {
	const { caller, query } = input
	if (!caller.cost) {
		throw new InventoryError('forbidden', 403, {
			reason: 'grant',
			required: INVENTORY_PERMISSIONS.READ_INVENTORY_COST,
		})
	}
	const { from, to } = await resolveDefaultRange(db, {
		from: query.from,
		to: query.to,
		caller,
		now: input.now,
	})
	if (caller.locationIds !== null && caller.locationIds.length === 0) {
		return {
			from,
			to,
			currency: await fallbackCurrency(db, caller),
			totalSavingMinor: 0,
			items: [],
		}
	}

	const effectiveDateExpr = sql<string>`coalesce(${invDeliveries.invoiceDate}, ${invDeliveries.businessDate})`
	const conditions: SQL[] = [
		eq(invDeliveries.status, 'received'),
		eq(invDeliveries.isCredit, false),
		isNotNull(invDeliveryLines.pricedAt),
		gt(invDeliveryLines.lineTotalMinor, 0),
		gte(effectiveDateExpr, from),
		lte(effectiveDateExpr, to),
	]
	if (query.itemId) {
		conditions.push(eq(invDeliveryLines.itemId, query.itemId))
	}
	if (caller.locationIds !== null) {
		conditions.push(inJsonList(invDeliveries.locationId, caller.locationIds))
	}

	const rows: RawComparisonRow[] = await db
		.select({
			itemId: invDeliveryLines.itemId,
			itemName: invItems.name,
			baseUnit: invItems.baseUnit,
			locationId: invDeliveries.locationId,
			supplierId: invDeliveries.supplierId,
			supplierName: invSuppliers.name,
			deliveryId: invDeliveries.id,
			currency: invDeliveries.currency,
			quantity: invDeliveryLines.quantity,
			realWeightQuantity: invDeliveryLines.realWeightQuantity,
			lineTotalMinor: invDeliveryLines.lineTotalMinor,
			pricedAt: sql<number>`${invDeliveryLines.pricedAt}`,
			receivedAt: invDeliveries.receivedAt,
			createdAt: invDeliveryLines.createdAt,
			seq: sql<number>`"inv_delivery_lines".rowid`,
		})
		.from(invDeliveryLines)
		.innerJoin(invDeliveries, eq(invDeliveries.id, invDeliveryLines.deliveryId))
		.innerJoin(invItems, eq(invItems.id, invDeliveryLines.itemId))
		.leftJoin(invSuppliers, eq(invSuppliers.id, invDeliveries.supplierId))
		.where(and(...conditions))

	const byItem = new Map<string, RawComparisonRow[]>()
	for (const row of rows) {
		if (effectiveLineQuantity(row) <= 0) continue
		const list = byItem.get(row.itemId)
		if (list) list.push(row)
		else byItem.set(row.itemId, [row])
	}

	const items: PriceComparisonItem[] = []
	for (const [itemId, itemRows] of byItem) {
		const sorted = [...itemRows].sort(compareRecencyDesc)
		const newest = sorted[0]
		if (!newest) continue
		const currency = newest.currency
		const sameCurrencyRows = sorted.filter((row) => row.currency === currency)

		const buckets = new Map<
			string,
			{
				locationId: string
				supplierId: string | null
				supplierName: string | null
				quantity: number
				paidMinor: number
				deliveryIds: Set<string>
				latestCostMicro: number
				latestPaidAt: number
				currency: string
			}
		>()

		for (const row of sameCurrencyRows) {
			const qty = effectiveLineQuantity(row)
			const key = `${row.locationId}::${row.supplierId ?? ''}`
			const linePaidAt = row.pricedAt ?? row.receivedAt ?? row.createdAt
			let bucket = buckets.get(key)
			if (!bucket) {
				bucket = {
					locationId: row.locationId,
					supplierId: row.supplierId,
					supplierName: row.supplierName ?? null,
					quantity: 0,
					paidMinor: 0,
					deliveryIds: new Set(),
					// Rows are sorted newest first, so the first row seen sets the latest price.
					latestCostMicro: costMicroFromPackPriceClamped(
						row.lineTotalMinor,
						qty,
					),
					latestPaidAt: linePaidAt,
					currency: row.currency,
				}
				buckets.set(key, bucket)
			}
			bucket.quantity += qty
			bucket.paidMinor += row.lineTotalMinor
			bucket.deliveryIds.add(row.deliveryId)
		}

		const entries: PriceComparisonEntry[] = [...buckets.values()]
			.filter((bucket) => bucket.quantity > 0)
			.map((bucket) => ({
				locationId: bucket.locationId,
				supplierId: bucket.supplierId,
				supplierName: bucket.supplierName,
				costMicro: costMicroFromPackPriceClamped(
					bucket.paidMinor,
					bucket.quantity,
				),
				latestCostMicro: bucket.latestCostMicro,
				latestPaidAt: bucket.latestPaidAt,
				quantity: bucket.quantity,
				paidMinor: bucket.paidMinor,
				deliveriesCount: bucket.deliveryIds.size,
				currency: bucket.currency,
			}))
			.sort(
				(a, b) =>
					a.costMicro - b.costMicro ||
					a.locationId.localeCompare(b.locationId) ||
					(a.supplierName ?? '').localeCompare(b.supplierName ?? ''),
			)

		if (entries.length === 0) continue
		const lowest = entries[0]!
		const highest = entries[entries.length - 1]!
		const spreadCostMicro = Math.max(0, highest.costMicro - lowest.costMicro)
		const spreadBp = priceChangeBp(lowest.costMicro, highest.costMicro) ?? 0
		const totalQuantity = entries.reduce((sum, e) => sum + e.quantity, 0)
		const totalPaidMinor = entries.reduce((sum, e) => sum + e.paidMinor, 0)
		const savingMinor =
			entries.length <= 1 || spreadCostMicro === 0
				? 0
				: Math.max(
						0,
						entries.reduce(
							(sum, entry) =>
								sum +
								(entry.paidMinor -
									inventoryValueMinorClamped(entry.quantity, lowest.costMicro)),
							0,
						),
					)

		items.push({
			itemId,
			itemName: newest.itemName,
			baseUnit: newest.baseUnit,
			currency,
			entries,
			lowestCostMicro: lowest.costMicro,
			lowestLocationId: lowest.locationId,
			lowestSupplierId: lowest.supplierId,
			lowestSupplierName: lowest.supplierName,
			highestCostMicro: highest.costMicro,
			highestLocationId: highest.locationId,
			highestSupplierId: highest.supplierId,
			highestSupplierName: highest.supplierName,
			spreadCostMicro,
			spreadBp,
			totalQuantity,
			totalPaidMinor,
			savingMinor,
		})
	}

	items.sort(
		(a, b) =>
			b.savingMinor - a.savingMinor ||
			b.spreadCostMicro - a.spreadCostMicro ||
			b.totalPaidMinor - a.totalPaidMinor ||
			a.itemName.localeCompare(b.itemName),
	)

	const totalSavingMinor = items.reduce(
		(sum, item) => sum + item.savingMinor,
		0,
	)
	const currency = items[0]?.currency ?? (await fallbackCurrency(db, caller))

	return {
		from,
		to,
		currency,
		totalSavingMinor,
		items,
	}
}

/**
 * Computes "Others pay" for `GET /items/:id`: the cheapest recent (90-day)
 * unit price paid for the item among allowed locations and suppliers. Returns
 * `undefined` when `!caller.cost` and `null` when no cheaper allowed price
 * exists.
 */
export async function getItemOthersPay(
	db: InventoryReader,
	input: {
		itemId: string
		locationId: string | null
		caller: Pick<InventoryCaller, 'locationIds' | 'cost'>
		costRow: { lastCostMicro: number | null; currency: string } | null
		now: number
	},
): Promise<ItemOthersPay | null | undefined> {
	const { caller } = input
	if (!caller.cost) return undefined
	if (caller.locationIds !== null && caller.locationIds.length === 0) {
		return null
	}

	const sinceMs = input.now - DEFAULT_LOOKBACK_DAYS * DAY_MS
	const conditions: SQL[] = [
		eq(invDeliveryLines.itemId, input.itemId),
		eq(invDeliveries.status, 'received'),
		eq(invDeliveries.isCredit, false),
		isNotNull(invDeliveryLines.pricedAt),
		gte(invDeliveryLines.pricedAt, sinceMs),
		gt(invDeliveryLines.lineTotalMinor, 0),
	]
	if (caller.locationIds !== null) {
		conditions.push(inJsonList(invDeliveries.locationId, caller.locationIds))
	}

	const rows = await db
		.select({
			locationId: invDeliveries.locationId,
			supplierId: invDeliveries.supplierId,
			supplierName: invSuppliers.name,
			currency: invDeliveries.currency,
			quantity: invDeliveryLines.quantity,
			realWeightQuantity: invDeliveryLines.realWeightQuantity,
			lineTotalMinor: invDeliveryLines.lineTotalMinor,
			pricedAt: sql<number>`${invDeliveryLines.pricedAt}`,
			receivedAt: invDeliveries.receivedAt,
			createdAt: invDeliveryLines.createdAt,
			seq: sql<number>`"inv_delivery_lines".rowid`,
		})
		.from(invDeliveryLines)
		.innerJoin(invDeliveries, eq(invDeliveries.id, invDeliveryLines.deliveryId))
		.leftJoin(invSuppliers, eq(invSuppliers.id, invDeliveries.supplierId))
		.where(and(...conditions))

	const valid = rows
		.filter((row) => effectiveLineQuantity(row) > 0)
		.sort(
			(a, b) =>
				b.pricedAt - a.pricedAt ||
				(b.receivedAt ?? b.createdAt) - (a.receivedAt ?? a.createdAt) ||
				b.createdAt - a.createdAt ||
				b.seq - a.seq,
		)

	if (valid.length === 0) return null

	const currentLocationRow = input.locationId
		? valid.find((row) => row.locationId === input.locationId)
		: undefined
	const currentCurrency =
		currentLocationRow?.currency ??
		input.costRow?.currency ??
		valid[0]!.currency
	const currentCostMicro = currentLocationRow
		? costMicroFromPackPriceClamped(
				currentLocationRow.lineTotalMinor,
				effectiveLineQuantity(currentLocationRow),
			)
		: (input.costRow?.lastCostMicro ?? null)

	// Latest price per (locationId, supplierId) in the same currency.
	const latestByPlaceSupplier = new Map<
		string,
		{
			locationId: string
			supplierId: string | null
			supplierName: string | null
			costMicro: number
			currency: string
			lastPaidAt: number
		}
	>()
	for (const row of valid) {
		if (row.currency !== currentCurrency) continue
		const key = `${row.locationId}::${row.supplierId ?? ''}`
		if (latestByPlaceSupplier.has(key)) continue
		latestByPlaceSupplier.set(key, {
			locationId: row.locationId,
			supplierId: row.supplierId,
			supplierName: row.supplierName ?? null,
			costMicro: costMicroFromPackPriceClamped(
				row.lineTotalMinor,
				effectiveLineQuantity(row),
			),
			currency: row.currency,
			lastPaidAt: row.pricedAt ?? row.receivedAt ?? row.createdAt,
		})
	}

	const entries = [...latestByPlaceSupplier.values()]
	const candidates = currentLocationRow
		? entries.filter(
				(entry) =>
					currentCostMicro !== null && entry.costMicro < currentCostMicro,
			)
		: input.locationId
			? entries.filter((entry) => entry.locationId !== input.locationId)
			: entries.filter(
					(entry) =>
						currentCostMicro === null || entry.costMicro < currentCostMicro,
				)

	if (candidates.length === 0) return null

	candidates.sort((a, b) => {
		if (a.costMicro !== b.costMicro) return a.costMicro - b.costMicro
		// Prefer another location on an exact price tie.
		if (input.locationId) {
			const aOther = a.locationId !== input.locationId ? 0 : 1
			const bOther = b.locationId !== input.locationId ? 0 : 1
			if (aOther !== bOther) return aOther - bOther
		}
		return (
			b.lastPaidAt - a.lastPaidAt || a.locationId.localeCompare(b.locationId)
		)
	})

	const cheapest = candidates[0]!
	const hasHigherCurrent =
		currentLocationRow !== undefined &&
		currentCostMicro !== null &&
		currentCostMicro > cheapest.costMicro
	const diffCostMicro = hasHigherCurrent
		? currentCostMicro - cheapest.costMicro
		: null
	const savingBp =
		hasHigherCurrent && currentCostMicro > 0
			? Math.round(
					((currentCostMicro - cheapest.costMicro) * 10_000) / currentCostMicro,
				)
			: null

	return {
		locationId: cheapest.locationId,
		supplierId: cheapest.supplierId,
		supplierName: cheapest.supplierName,
		costMicro: cheapest.costMicro,
		currency: cheapest.currency,
		currentCostMicro: hasHigherCurrent ? currentCostMicro : null,
		diffCostMicro,
		savingBp,
		lastPaidAt: cheapest.lastPaidAt,
	}
}
