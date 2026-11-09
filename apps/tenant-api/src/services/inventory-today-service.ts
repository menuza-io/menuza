import {
	inventoryValueMinor,
	type AttentionItem,
	type Today,
} from '@repo/inventory'
import { addDays, dayOfWeek } from '@repo/reservations'
import {
	invCounts,
	invDeliveries,
	invDeliveryLines,
	invSupplierProducts,
	invSuppliers,
} from '@repo/tenant-db'
import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import { queryInChunks } from '../lib/chunked-in.ts'
import { type InventoryReader } from '../lib/inventory-write.ts'
import { locationClock, wireUnit } from './inventory-common.ts'
import { computeFoodCost } from './inventory-food-cost.ts'
import {
	type InventoryCaller,
	loadLocationStock,
	stockValueMinor,
} from './inventory-items-service.ts'
import { listCounts } from './inventory-counts-service.ts'
import {
	buildSuggestedOrders,
	listDueOrders,
	listOpenOrdersForWeek,
} from './inventory-orders-service.ts'
import { findPriceRises } from './inventory-receiving-service.ts'
import {
	getInventorySettings,
	getInventoryStatus,
} from './inventory-settings-service.ts'
import { wasteSummary } from './inventory-waste-service.ts'

/** A price rise only matters for a delivery this recent. */
const PRICE_RISE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

type Candidate = { item: AttentionItem; money: number; priority: number }

/** Order of kinds when the money at stake ties (or is not known). */
const KIND_PRIORITY: Record<AttentionItem['kind'], number> = {
	count_in_review: 0,
	low_stock: 1,
	// Phase 2 kinds are produced by the region work that follows the contract.
	order_cutoff: 2,
	delivery_expected: 3,
	count_due: 4,
	count_in_progress: 5,
	prices_pending: 6,
	price_rise: 7,
	unpaid_deliveries: 8,
}

/**
 * Items whose latest priced delivery at a location rose by more than the
 * alert threshold, among prices set in the last week (a quantity-only
 * delivery counts from the day its prices were confirmed).
 */
async function recentPriceRises(
	db: InventoryReader,
	locationId: string,
	now: number,
) {
	const rises = await findPriceRises(db, {
		locationId,
		sinceMs: now - PRICE_RISE_WINDOW_MS,
	})
	if (rises.length === 0) return []
	const supplierIds = [
		...new Set(
			rises.map((rise) => rise.supplierId).filter((id): id is string => !!id),
		),
	]
	const suppliers = await queryInChunks(supplierIds, (chunk) =>
		db
			.select({ id: invSuppliers.id, name: invSuppliers.name })
			.from(invSuppliers)
			.where(inArray(invSuppliers.id, chunk)),
	)
	const names = new Map(suppliers.map((row) => [row.id, row.name]))
	return rises.map((rise) => ({
		itemId: rise.itemId,
		itemName: rise.itemName,
		changeBp: rise.changeBp,
		money: inventoryValueMinor(
			rise.quantity,
			Math.max(rise.costMicro - rise.previousCostMicro, 0),
		),
		deliveryId: rise.deliveryId,
		supplierName: rise.supplierId ? (names.get(rise.supplierId) ?? null) : null,
	}))
}

/** The delivery that has waited longest for its prices (Station quantity-only receipts). */
async function oldestPricesPending(db: InventoryReader, locationId: string) {
	const delivery = await db
		.select()
		.from(invDeliveries)
		.where(
			and(
				eq(invDeliveries.locationId, locationId),
				eq(invDeliveries.status, 'received'),
				eq(invDeliveries.quantityOnly, true),
				isNull(invDeliveries.pricesConfirmedAt),
			),
		)
		.orderBy(invDeliveries.createdAt, invDeliveries.id)
		.limit(1)
		.get()
	if (!delivery) return null
	const [supplier, lines] = await Promise.all([
		delivery.supplierId
			? db
					.select({ name: invSuppliers.name })
					.from(invSuppliers)
					.where(eq(invSuppliers.id, delivery.supplierId))
					.get()
			: Promise.resolve(undefined),
		db
			.select({ n: sql<number>`count(*)` })
			.from(invDeliveryLines)
			.where(eq(invDeliveryLines.deliveryId, delivery.id))
			.get(),
	])
	return {
		deliveryId: delivery.id,
		supplierName: supplier?.name ?? null,
		lineCount: Number(lines?.n ?? 0),
	}
}

export async function getToday(
	db: InventoryReader,
	input: {
		locationId: string
		caller: InventoryCaller
		now: number
		/** `inventory.purchasing` is on: orders, cut-offs and expected deliveries. */
		purchasing?: boolean
	},
): Promise<Today> {
	const { locationId, caller, now } = input
	const cost = caller.cost
	const purchasing = input.purchasing === true
	const clock = await locationClock(db, locationId, now)
	const date = clock.date
	const weekFrom = addDays(date, -6)
	const [settings, stock, status, lastCount, openCounts, waste, supplierRows] =
		await Promise.all([
			getInventorySettings(db, caller.region),
			loadLocationStock(db, locationId),
			getInventoryStatus(db, locationId),
			db
				.select({ at: sql<number | null>`max(${invCounts.approvedAt})` })
				.from(invCounts)
				.where(
					and(
						eq(invCounts.locationId, locationId),
						eq(invCounts.status, 'approved'),
					),
				)
				.get(),
			listCounts(db, {
				query: { locationId, status: 'open', limit: 5 },
				caller,
			}),
			wasteSummary(db, { locationId, from: weekFrom, to: date, cost }),
			db.select().from(invSuppliers).where(isNull(invSuppliers.archivedAt)),
		])

	let stockValue = 0
	let currency: string | undefined
	const low = stock.filter((row) => row.status === 'low')
	const out = stock.filter((row) => row.status === 'out')
	for (const row of stock) {
		stockValue += stockValueMinor(row.onHand, row.cost) ?? 0
		currency ??= row.cost?.currency
	}

	const metrics: Today['metrics'] = {
		lastCountAt: lastCount?.at ?? null,
		wasteWeekCount: waste.count,
		lowItems: low.length,
		outItems: out.length,
	}
	if (cost) {
		metrics.stockValueMinor = stockValue
		metrics.wasteWeekMinor = waste.valueMinor ?? 0
		metrics.wasteWeekShareBp =
			waste.purchasesMinor && waste.purchasesMinor > 0
				? Math.round(((waste.valueMinor ?? 0) * 10_000) / waste.purchasesMinor)
				: null
		metrics.foodCost = await computeFoodCost(db, {
			locationId,
			targetBp: settings.targetFoodCostBp,
		})
		currency ??= waste.currency
		if (currency) metrics.currency = currency
	}

	// Needs attention, ranked by the money at stake.
	const candidates: Candidate[] = []
	const push = (item: AttentionItem, money = 0) =>
		candidates.push({ item, money, priority: KIND_PRIORITY[item.kind] })

	const suggestion = purchasing
		? await buildSuggestedOrders(db, { locationId, cost, now })
		: null
	if (suggestion) {
		metrics.toOrderItems = suggestion.toOrderItems
		metrics.toOrderSuppliers = suggestion.suppliers.length
		// An order whose cut-off is today and not yet passed.
		for (const card of suggestion.suppliers) {
			if (
				!card.cutoff ||
				!card.expectedDate ||
				card.cutoff.date !== clock.local.date
			) {
				continue
			}
			push(
				{
					kind: 'order_cutoff',
					supplierId: card.supplierId,
					supplierName: card.supplierName,
					cutoffDate: card.cutoff.date,
					cutoffTime: card.cutoff.time,
					expectedDate: card.expectedDate,
					itemCount: card.lineCount,
					draftOrderId: card.draftOrderId,
				},
				card.totalMinor ?? 0,
			)
		}
		// Open orders due today, or overdue (the oldest few).
		for (const due of (await listDueOrders(db, { locationId, date })).slice(
			0,
			3,
		)) {
			push({
				kind: 'delivery_expected',
				orderId: due.order.id,
				supplierName: due.supplierName,
				expectedDate: due.order.expectedDate!,
				overdue: due.order.expectedDate! < date,
			})
		}
	}
	const pending = await oldestPricesPending(db, locationId)
	if (pending) push({ kind: 'prices_pending', ...pending })

	const lowRows = [...out, ...low]
	if (lowRows.length > 0) {
		const stake = (row: (typeof lowRows)[number]) => {
			const target =
				row.place?.fillUpToQuantity ?? row.place?.orderBelowQuantity ?? null
			const avg = row.cost?.avgCostMicro ?? null
			if (target === null || avg === null) return 0
			return inventoryValueMinor(
				Math.max(0, target - Math.max(0, row.onHand)),
				avg,
			)
		}
		const ranked = lowRows
			.map((row) => ({ row, money: cost ? stake(row) : 0 }))
			.sort(
				(a, b) =>
					b.money - a.money ||
					Number(b.row.status === 'out') - Number(a.row.status === 'out') ||
					a.row.item.name
						.toLowerCase()
						.localeCompare(b.row.item.name.toLowerCase()),
			)
		const top = ranked[0]!
		const supplier = await db
			.select({ id: invSuppliers.id, name: invSuppliers.name })
			.from(invSupplierProducts)
			.innerJoin(
				invSuppliers,
				eq(invSuppliers.id, invSupplierProducts.supplierId),
			)
			.where(
				and(
					eq(invSupplierProducts.itemId, top.row.item.id),
					isNull(invSupplierProducts.archivedAt),
					isNull(invSuppliers.archivedAt),
				),
			)
			.orderBy(desc(invSupplierProducts.preferred), invSuppliers.name)
			.limit(1)
			.get()
		const item: AttentionItem = {
			kind: 'low_stock',
			itemId: top.row.item.id,
			itemName: top.row.item.name,
			onHand: top.row.onHand,
			countUnit: top.row.place?.countUnit
				? wireUnit(top.row.place.countUnit)
				: null,
			baseUnit: top.row.item.baseUnit,
			status: top.row.status === 'out' ? 'out' : 'low',
			supplierId: supplier?.id ?? null,
			supplierName: supplier?.name ?? null,
			more: lowRows.length - 1,
		}
		if (cost) item.valueAtStakeMinor = top.money
		push(item, top.money)
	}

	const reviewing = openCounts.counts.find(
		(entry) => entry.status === 'in_review',
	)
	if (reviewing) {
		push(
			{ kind: 'count_in_review', countId: reviewing.id },
			Math.abs(reviewing.differenceValueMinor ?? 0),
		)
	}
	const counting = openCounts.counts.find(
		(entry) => entry.status === 'counting',
	)
	if (counting) {
		push({
			kind: 'count_in_progress',
			countId: counting.id,
			itemsCounted: counting.itemsCounted,
			itemTotal: counting.itemTotal,
		})
	}
	if (
		settings.countDayOfWeek !== null &&
		dayOfWeek(date) === settings.countDayOfWeek
	) {
		const today = await db
			.select({ id: invCounts.id })
			.from(invCounts)
			.where(
				and(
					eq(invCounts.locationId, locationId),
					eq(invCounts.businessDate, date),
					isNull(invCounts.listId),
					ne(invCounts.status, 'cancelled'),
				),
			)
			.limit(1)
			.get()
		if (!today) push({ kind: 'count_due', date })
	}
	if (cost) {
		for (const rise of await recentPriceRises(db, locationId, now)) {
			push(
				{
					kind: 'price_rise',
					itemId: rise.itemId,
					itemName: rise.itemName,
					changeBp: rise.changeBp,
					deliveryId: rise.deliveryId,
					supplierName: rise.supplierName,
				},
				rise.money,
			)
		}
	}
	candidates.sort(
		(a, b) =>
			b.money - a.money ||
			a.priority - b.priority ||
			(a.item.kind === 'price_rise' && b.item.kind === 'price_rise'
				? b.item.changeBp - a.item.changeBp
				: 0),
	)

	// The next seven days: the count day and each supplier's delivery days.
	const suppliers = supplierRows.sort(
		(a, b) =>
			a.name.toLowerCase().localeCompare(b.name.toLowerCase()) ||
			(a.id < b.id ? -1 : 1),
	)
	const openOrders = purchasing
		? await listOpenOrdersForWeek(db, locationId)
		: []
	const week: Today['week'] = []
	for (let offset = 0; offset < 7; offset++) {
		const day = addDays(date, offset)
		const weekday = dayOfWeek(day)
		if (settings.countDayOfWeek === weekday) {
			week.push({
				date: day,
				kind: 'count',
				supplierId: null,
				supplierName: null,
			})
		}
		for (const supplier of suppliers) {
			if (supplier.deliveryDays.includes(weekday)) {
				const entry: Today['week'][number] = {
					date: day,
					kind: 'delivery',
					supplierId: supplier.id,
					supplierName: supplier.name,
				}
				if (purchasing) {
					entry.orderId =
						openOrders.find(
							(order) =>
								order.supplierId === supplier.id && order.expectedDate === day,
						)?.id ?? null
				}
				week.push(entry)
			}
		}
	}

	return {
		locationId,
		date,
		metrics,
		attention: candidates.slice(0, 5).map((entry) => entry.item),
		week,
		setup: {
			items: status.items,
			storageAreas: status.storageAreas,
			approvedCounts: status.approvedCounts,
			deliveries: status.deliveries,
		},
	}
}
