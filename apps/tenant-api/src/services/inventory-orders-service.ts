import { createHash } from 'node:crypto'
import {
	addDaysIso,
	costMicroFromPackPriceClamped,
	expectedUseUntilDelivery,
	INVENTORY_LIMITS,
	inventoryNotifyDedupeKey,
	type InventoryNotifyEvent,
	isOrderCountStale,
	MAX_ENTRY_QUANTITY,
	milliToPacks,
	mulDiv,
	needsOrder,
	nextOrderableDelivery,
	OPEN_ORDER_STATUSES,
	orderCutoffFor,
	orderLineComplete,
	orderLineExplanationSchema,
	orderLineTotalMinor,
	orderTotalMinor,
	outstandingQuantity,
	PACK_SCALE,
	packsQuantity,
	packsToMilli,
	PRICED_BY_WEIGHT_PACK_STEP_MILLI,
	rawPacksMilli,
	shortOfMinimumMinor,
	suggestOrderQuantity,
	type InventoryBaseUnit,
	type OrderDetail,
	type OrderLine,
	type OrderLineExplanation,
	type OrderSendChannel,
	type OrderStatus,
	type OrderSummary,
	type OrderText,
	type OrderTextLocale,
	type OrderWireStatus,
	type OverdueOrderWarning,
	type ReceivePrefill,
	type RecordDelivery,
	type RecordDeliveryResult,
	type SendOrderResult,
	type SuggestedOrderLine,
	type SuggestedOrders,
	type SuggestedSupplierOrder,
	type SupplierSchedule,
} from '@repo/inventory'
import { localParts } from '@repo/reservations'
import {
	getTenantDb,
	invCountEntries,
	invCounts,
	invDeliveries,
	invDeliveryLines,
	invItemPlaces,
	invItems,
	invLocationSettings,
	invOrderLines,
	invOrders,
	invSettings,
	invSupplierProductPrices,
	invSupplierProducts,
	invSuppliers,
	type TenantDatabase,
} from '@repo/tenant-db'
import {
	and,
	count,
	desc,
	eq,
	gte,
	inArray,
	isNotNull,
	isNull,
	ne,
	or,
	sql,
} from 'drizzle-orm'
import { queryInChunks, insertRowsInChunks } from '../lib/chunked-in.ts'
import { InventoryError } from '../lib/inventory-http.ts'
import {
	type InventoryNotifyOutcome,
	postInventoryNotify,
} from '../lib/inventory-notify.ts'
import {
	type InventoryIdempotency,
	type InventoryReader,
	type InventoryTx,
	withInventoryWrite,
} from '../lib/inventory-write.ts'
import { canSendTenantEmail, sendTenantEmail } from '../lib/tenant-email.ts'
import { cateringNeedByItem } from './catering-demand.ts'
import { recordInventoryAudit } from './inventory-audit.ts'
import {
	assertLocationAllowed,
	assertVersion,
	badRequest,
	decodeCursor,
	encodeCursor,
	locationBusinessDate,
	locationClock,
	newId,
	notFound,
	onHandByItem,
	stateConflict,
	wireUnit,
} from './inventory-common.ts'
import {
	getLocationCurrency,
	getLocationSettings,
} from './inventory-location-settings.ts'
import {
	recordDelivery,
	replayDeliveryResult,
	type RecordDeliveryOptions,
} from './inventory-purchasing-service.ts'
import {
	type ApproveOrderInput,
	type CreateOrderInput,
	type ListOrdersQuery,
	type RejectOrderInput,
	type SendOrderInput,
	type UpdateOrderInput,
} from './inventory-contract-types.ts'
import { loadUseHistory } from './inventory-days-left.ts'
import {
	type InventoryCaller,
	loadLocationStock,
} from './inventory-items-service.ts'
import {
	buildMailtoLink,
	buildWhatsAppLink,
	orderTextToHtml,
	renderOrderText,
} from './inventory-order-text.ts'
import { getInventorySettings } from './inventory-settings-service.ts'

type OrderRow = typeof invOrders.$inferSelect
type OrderLineRow = typeof invOrderLines.$inferSelect
type SupplierRow = typeof invSuppliers.$inferSelect
type ProductRow = typeof invSupplierProducts.$inferSelect

const SUGGESTION_STATUSES = ['sent', 'partly_received'] as const

// ── Rows ────────────────────────────────────────────────────────────────────

export function supplierSchedule(supplier: SupplierRow): SupplierSchedule {
	return {
		deliveryDays: supplier.deliveryDays,
		cutoffTime: supplier.cutoffTime,
		cutoffDaysBefore: supplier.cutoffDaysBefore,
	}
}

/** The cut-off shown to people: only a supplier that has one configured. */
function visibleCutoff(
	supplier: SupplierRow,
	expectedDate: string | null,
): { date: string; time: string } | null {
	if (!expectedDate || !supplier.cutoffTime) return null
	return orderCutoffFor(expectedDate, supplierSchedule(supplier))
}

/** What each order line has received so far over the received deliveries (cancelled ones do not count). */
export async function receivedByOrderLine(
	db: InventoryReader,
	lineIds: readonly string[],
	options: { upToCreatedAt?: number } = {},
): Promise<Map<string, number>> {
	const rows = await queryInChunks(lineIds, (chunk) =>
		db
			.select({
				lineId: invDeliveryLines.orderLineId,
				total: sql<number>`coalesce(sum(${invDeliveryLines.quantity}), 0)`,
			})
			.from(invDeliveryLines)
			.innerJoin(
				invDeliveries,
				eq(invDeliveries.id, invDeliveryLines.deliveryId),
			)
			.where(
				and(
					inArray(invDeliveryLines.orderLineId, chunk),
					eq(invDeliveries.status, 'received'),
					options.upToCreatedAt === undefined
						? undefined
						: sql`${invDeliveries.createdAt} <= ${options.upToCreatedAt}`,
				),
			)
			.groupBy(invDeliveryLines.orderLineId),
	)
	return new Map(rows.map((row) => [row.lineId!, Number(row.total)]))
}

export async function loadOrderRow(
	db: InventoryReader,
	id: string,
	caller: Pick<InventoryCaller, 'locationIds'>,
): Promise<OrderRow> {
	const row = await db
		.select()
		.from(invOrders)
		.where(eq(invOrders.id, id))
		.get()
	if (!row) throw notFound()
	assertLocationAllowed(caller.locationIds, row.locationId)
	return row
}

async function loadOrderLines(
	db: InventoryReader,
	orderIds: readonly string[],
): Promise<Map<string, OrderLineRow[]>> {
	const rows = await queryInChunks(orderIds, (chunk) =>
		db
			.select()
			.from(invOrderLines)
			.where(inArray(invOrderLines.orderId, chunk))
			.orderBy(invOrderLines.sortOrder, invOrderLines.id),
	)
	const map = new Map<string, OrderLineRow[]>()
	for (const row of rows) {
		const list = map.get(row.orderId)
		if (list) list.push(row)
		else map.set(row.orderId, [row])
	}
	return map
}

type OrderContext = {
	suppliers: Map<string, SupplierRow>
	lines: Map<string, OrderLineRow[]>
	received: Map<string, number>
}

async function loadOrderContext(
	db: InventoryReader,
	rows: readonly OrderRow[],
): Promise<OrderContext> {
	const supplierIds = [...new Set(rows.map((row) => row.supplierId))]
	const [suppliers, lines] = await Promise.all([
		queryInChunks(supplierIds, (chunk) =>
			db.select().from(invSuppliers).where(inArray(invSuppliers.id, chunk)),
		),
		loadOrderLines(
			db,
			rows.map((row) => row.id),
		),
	])
	const lineIds = [...lines.values()].flat().map((line) => line.id)
	return {
		suppliers: new Map(suppliers.map((row) => [row.id, row])),
		lines,
		received: await receivedByOrderLine(db, lineIds),
	}
}

function wireOrderStatus(row: OrderRow): OrderWireStatus {
	if (row.status === 'draft' && row.approvalStatus === 'waiting_approval') {
		return 'waiting_for_approval'
	}
	return row.status
}

function toSummary(
	row: OrderRow,
	context: OrderContext,
	cost: boolean,
): OrderSummary {
	const supplier = context.suppliers.get(row.supplierId)!
	const lines = context.lines.get(row.id) ?? []
	const summary: OrderSummary = {
		id: row.id,
		number: row.number,
		locationId: row.locationId,
		supplierId: row.supplierId,
		supplierName: supplier.name,
		status: wireOrderStatus(row),
		expectedDate: row.expectedDate,
		cutoff: visibleCutoff(supplier, row.expectedDate),
		note: row.note,
		createdBy: { kind: row.createdByKind, id: row.createdById },
		createdAt: row.createdAt,
		sentAt: row.sentAt,
		sentVia: row.sentVia,
		closedAt: row.closedAt,
		lineCount: lines.length,
		receivedLineCount: lines.filter((line) =>
			orderLineComplete({
				orderedQuantity: line.quantity,
				receivedQuantity: context.received.get(line.id) ?? 0,
				pricedByWeight: line.pricedByWeight,
			}),
		).length,
		version: row.version,
		confirmedAt: row.confirmedAt ?? null,
		confirmedBy: row.confirmedAt
			? {
					kind: row.confirmedByKind ?? 'operator',
					id: row.confirmedById,
				}
			: null,
		approvalStatus: row.approvalStatus ?? null,
		requestedSendChannel: row.requestedSendChannel ?? null,
		approvalRequestedAt: row.approvalRequestedAt ?? null,
		approvalRequestedBy: row.approvalRequestedAt
			? {
					kind: row.approvalRequestedByKind ?? 'operator',
					id: row.approvalRequestedById,
				}
			: null,
		approvalBreachedOrderLimit: row.approvalBreachedOrderLimit,
		approvalBreachedMonthlyLimit: row.approvalBreachedMonthlyLimit,
		approvedAt: row.approvedAt ?? null,
		approvedBy: row.approvedAt
			? {
					kind: row.approvedByKind ?? 'operator',
					id: row.approvedById,
				}
			: null,
		rejectedAt: row.rejectedAt ?? null,
		rejectedBy: row.rejectedAt
			? {
					kind: row.rejectedByKind ?? 'operator',
					id: row.rejectedById,
				}
			: null,
		rejectionReason: row.rejectionReason ?? null,
	}
	if (cost) {
		const money = orderTotalMinor(
			lines.map((line) => ({
				packs: milliToPacks(line.packs),
				packPriceMinor: line.priceMinor,
			})),
		)
		const currency = row.currency ?? supplier.currency
		if (currency) summary.currency = currency
		summary.totalMinor = money.totalMinor
		if (supplier.minimumOrderMinor !== null) {
			summary.minimumOrderMinor = supplier.minimumOrderMinor
		}
		summary.shortOfMinimumMinor = shortOfMinimumMinor(
			money.totalMinor,
			supplier.minimumOrderMinor,
		)
		summary.unpricedLines = money.unpricedLines
	}
	return summary
}

/** Order summaries (lists, the delivery result, Today). */
export async function orderSummaries(
	db: InventoryReader,
	rows: readonly OrderRow[],
	cost: boolean,
): Promise<OrderSummary[]> {
	const context = await loadOrderContext(db, rows)
	return rows.map((row) => toSummary(row, context, cost))
}

/** Strips or preserves money fields on an explanation based on `cost` grant. */
function maskExplanationForCost(
	explanation: OrderLineExplanation,
	cost: boolean,
): OrderLineExplanation {
	if (!cost) {
		return {
			onHandQuantity: explanation.onHandQuantity,
			lastCountedAt: explanation.lastCountedAt,
			onOrderQuantity: explanation.onOrderQuantity,
			orderBelowQuantity: explanation.orderBelowQuantity,
			fillUpToQuantity: explanation.fillUpToQuantity,
			expectedUseUntilDeliveryQuantity:
				explanation.expectedUseUntilDeliveryQuantity,
			...(explanation.cateringQuantity !== undefined
				? { cateringQuantity: explanation.cateringQuantity }
				: {}),
			neededQuantity: explanation.neededQuantity,
			packName: explanation.packName,
			packBaseQuantity: explanation.packBaseQuantity,
			rawPacksMilli: explanation.rawPacksMilli,
			roundedPacksMilli: explanation.roundedPacksMilli,
			warnings: {
				notCountedIn10Days: explanation.warnings.notCountedIn10Days,
				priceChangedSinceLastOrder: false,
				belowSupplierMinimum: false,
			},
		}
	}
	return {
		...explanation,
		previousOrderPackPriceMinor:
			explanation.previousOrderPackPriceMinor ?? null,
		currentPackPriceMinor: explanation.currentPackPriceMinor ?? null,
	}
}

function adjustPackPrice(
	priceMinor: number,
	fromPackBase: number,
	toPackBase: number,
): number {
	if (fromPackBase === toPackBase) return priceMinor
	return mulDiv(priceMinor, toPackBase, fromPackBase, 'half_up')
}

function packPricesDiffer(
	aPrice: number,
	aPackBase: number,
	bPrice: number,
	bPackBase: number,
): boolean {
	if (aPackBase === bPackBase) return aPrice !== bPrice
	return (
		BigInt(aPrice) * BigInt(bPackBase) !== BigInt(bPrice) * BigInt(aPackBase)
	)
}

type PreviousPriceResult = {
	previousOrderPackPriceMinor: number | null
	priceChangedSinceLastOrder: boolean
}

/**
 * Compares each `(supplierId, itemId)` pair's current pack price against the
 * most recent non-draft/non-cancelled order line for `(supplierId, itemId)`,
 * falling back to `inv_supplier_product_prices` when no prior order exists.
 * Pack prices are normalized per base unit when pack size changed.
 * Only call when `caller.cost === true`.
 */
async function loadPreviousPackPrices(
	db: InventoryReader,
	pairs: ReadonlyArray<{
		supplierId: string
		itemId: string
		packBaseQuantity: number
		currentPriceMinor: number | null
	}>,
	options: { excludeOrderId?: string } = {},
): Promise<Map<string, PreviousPriceResult>> {
	const result = new Map<string, PreviousPriceResult>()
	if (pairs.length === 0) return result

	const supplierIds = [...new Set(pairs.map((p) => p.supplierId))]
	const itemIds = [...new Set(pairs.map((p) => p.itemId))]

	const priorOrderRows = await queryInChunks(itemIds, (itemChunk) =>
		db
			.select({
				supplierId: invOrders.supplierId,
				itemId: invOrderLines.itemId,
				priceMinor: invOrderLines.priceMinor,
				packBaseQuantity: invOrderLines.packBaseQuantity,
			})
			.from(invOrderLines)
			.innerJoin(invOrders, eq(invOrders.id, invOrderLines.orderId))
			.where(
				and(
					inArray(invOrders.supplierId, supplierIds),
					inArray(invOrderLines.itemId, itemChunk),
					inArray(invOrders.status, ['sent', 'partly_received', 'received']),
					sql`${invOrderLines.priceMinor} is not null`,
					options.excludeOrderId
						? ne(invOrders.id, options.excludeOrderId)
						: undefined,
				),
			)
			.orderBy(
				desc(sql`coalesce(${invOrders.sentAt}, ${invOrders.createdAt})`),
				desc(invOrderLines.createdAt),
				desc(invOrderLines.id),
			),
	)

	const priorByPair = new Map<
		string,
		{ priceMinor: number; packBaseQuantity: number }
	>()
	for (const row of priorOrderRows) {
		if (row.priceMinor === null) continue
		const key = `${row.supplierId}:${row.itemId}`
		if (!priorByPair.has(key)) {
			priorByPair.set(key, {
				priceMinor: row.priceMinor,
				packBaseQuantity: row.packBaseQuantity,
			})
		}
	}

	const missingItemIds = [
		...new Set(
			pairs
				.filter((p) => !priorByPair.has(`${p.supplierId}:${p.itemId}`))
				.map((p) => p.itemId),
		),
	]
	const historyByPair = new Map<
		string,
		Array<{ priceMinor: number; packBaseQuantity: number }>
	>()
	if (missingItemIds.length > 0) {
		const historyRows = await queryInChunks(missingItemIds, (itemChunk) =>
			db
				.select({
					supplierId: invSupplierProductPrices.supplierId,
					itemId: invSupplierProductPrices.itemId,
					priceMinor: invSupplierProductPrices.priceMinor,
					packBaseQuantity: invSupplierProductPrices.packBaseQuantity,
				})
				.from(invSupplierProductPrices)
				.where(
					and(
						inArray(invSupplierProductPrices.supplierId, supplierIds),
						inArray(invSupplierProductPrices.itemId, itemChunk),
					),
				)
				.orderBy(
					desc(invSupplierProductPrices.effectiveAt),
					desc(invSupplierProductPrices.createdAt),
					desc(invSupplierProductPrices.id),
				),
		)
		for (const row of historyRows) {
			const key = `${row.supplierId}:${row.itemId}`
			const list = historyByPair.get(key) ?? []
			if (list.length < 2) {
				list.push({
					priceMinor: row.priceMinor,
					packBaseQuantity: row.packBaseQuantity,
				})
				historyByPair.set(key, list)
			}
		}
	}

	for (const pair of pairs) {
		const key = `${pair.supplierId}:${pair.itemId}`
		const priorOrder = priorByPair.get(key)
		if (priorOrder) {
			const prevAdjusted = adjustPackPrice(
				priorOrder.priceMinor,
				priorOrder.packBaseQuantity,
				pair.packBaseQuantity,
			)
			const changed =
				pair.currentPriceMinor !== null &&
				packPricesDiffer(
					priorOrder.priceMinor,
					priorOrder.packBaseQuantity,
					pair.currentPriceMinor,
					pair.packBaseQuantity,
				)
			result.set(key, {
				previousOrderPackPriceMinor: prevAdjusted,
				priceChangedSinceLastOrder: changed,
			})
			continue
		}
		const history = historyByPair.get(key) ?? []
		const newest = history[0]
		const earlier = history[1]
		if (!newest) {
			result.set(key, {
				previousOrderPackPriceMinor: null,
				priceChangedSinceLastOrder: false,
			})
			continue
		}
		if (pair.currentPriceMinor === null) {
			result.set(key, {
				previousOrderPackPriceMinor: adjustPackPrice(
					newest.priceMinor,
					newest.packBaseQuantity,
					pair.packBaseQuantity,
				),
				priceChangedSinceLastOrder: false,
			})
			continue
		}
		if (
			packPricesDiffer(
				newest.priceMinor,
				newest.packBaseQuantity,
				pair.currentPriceMinor,
				pair.packBaseQuantity,
			)
		) {
			result.set(key, {
				previousOrderPackPriceMinor: adjustPackPrice(
					newest.priceMinor,
					newest.packBaseQuantity,
					pair.packBaseQuantity,
				),
				priceChangedSinceLastOrder: true,
			})
			continue
		}
		if (earlier) {
			result.set(key, {
				previousOrderPackPriceMinor: adjustPackPrice(
					earlier.priceMinor,
					earlier.packBaseQuantity,
					pair.packBaseQuantity,
				),
				priceChangedSinceLastOrder: packPricesDiffer(
					earlier.priceMinor,
					earlier.packBaseQuantity,
					pair.currentPriceMinor,
					pair.packBaseQuantity,
				),
			})
			continue
		}
		result.set(key, {
			previousOrderPackPriceMinor: null,
			priceChangedSinceLastOrder: false,
		})
	}
	return result
}

async function lastCountedByItemIds(
	db: InventoryReader,
	locationId: string,
	itemIds: readonly string[],
): Promise<Map<string, number>> {
	if (itemIds.length === 0) return new Map()
	const rows = await queryInChunks(itemIds, (chunk) =>
		db
			.select({
				itemId: invCountEntries.itemId,
				at: sql<number>`max(${invCounts.approvedAt})`,
			})
			.from(invCountEntries)
			.innerJoin(invCounts, eq(invCounts.id, invCountEntries.countId))
			.where(
				and(
					eq(invCounts.locationId, locationId),
					eq(invCounts.status, 'approved'),
					inArray(invCountEntries.itemId, chunk),
				),
			)
			.groupBy(invCountEntries.itemId),
	)
	return new Map(rows.map((row) => [row.itemId, Number(row.at)]))
}

async function toDetail(
	db: InventoryReader,
	row: OrderRow,
	cost: boolean,
	now = Date.now(),
): Promise<OrderDetail> {
	const context = await loadOrderContext(db, [row])
	const summary = toSummary(row, context, cost)
	const supplier = context.suppliers.get(row.supplierId)!
	const lines = context.lines.get(row.id) ?? []
	const itemIds = [...new Set(lines.map((line) => line.itemId))]
	const [items, places, onHand, deliveries] = await Promise.all([
		queryInChunks(itemIds, (chunk) =>
			db.select().from(invItems).where(inArray(invItems.id, chunk)),
		),
		queryInChunks(itemIds, (chunk) =>
			db
				.select()
				.from(invItemPlaces)
				.where(
					and(
						eq(invItemPlaces.locationId, row.locationId),
						// bounded: its own statement, one chunk of at most 90 ids
						inArray(invItemPlaces.itemId, chunk),
					),
				),
		),
		onHandByItem(db, row.locationId),
		db
			.select({
				id: invDeliveries.id,
				receivedAt: invDeliveries.receivedAt,
				invoiceNumber: invDeliveries.invoiceNumber,
			})
			.from(invDeliveries)
			.where(
				and(
					eq(invDeliveries.orderId, row.id),
					eq(invDeliveries.status, 'received'),
				),
			)
			.orderBy(invDeliveries.createdAt, invDeliveries.id),
	])
	const itemById = new Map(items.map((item) => [item.id, item]))
	const placeById = new Map(places.map((place) => [place.itemId, place]))

	const parsedSavedExplanations = new Map<string, OrderLineExplanation>()
	const linesNeedingFallback: OrderLineRow[] = []
	for (const line of lines) {
		if (line.suggestionExplanationJson) {
			try {
				const parsed = orderLineExplanationSchema.safeParse(
					JSON.parse(line.suggestionExplanationJson),
				)
				if (parsed.success) {
					parsedSavedExplanations.set(line.id, parsed.data)
					continue
				}
			} catch {
				// Fall through to fallback recomputation if JSON is malformed.
			}
		}
		if (line.suggestedPacks !== null) {
			linesNeedingFallback.push(line)
		}
	}

	const fallbackClock =
		linesNeedingFallback.length > 0
			? await locationClock(db, row.locationId, now)
			: null
	const [fallbackLastCounted, fallbackOnOrder, fallbackUseHistory] =
		linesNeedingFallback.length > 0 && fallbackClock
			? await Promise.all([
					lastCountedByItemIds(
						db,
						row.locationId,
						linesNeedingFallback.map((line) => line.itemId),
					),
					onOrderByItem(db, row.locationId, {
						todayDate: fallbackClock.local.date,
					}),
					loadUseHistory(db, row.locationId, fallbackClock.local.date),
				])
			: [
					new Map<string, number>(),
					new Map<string, number>(),
					new Map<string, { date: string; quantity: number }[]>(),
				]

	const linesNeedingPriceLookup = cost
		? lines.filter((line) => {
				const saved = parsedSavedExplanations.get(line.id)
				if (saved) {
					return (
						saved.previousOrderPackPriceMinor === undefined ||
						saved.currentPackPriceMinor === undefined
					)
				}
				return line.suggestedPacks !== null
			})
		: []
	const prevPrices =
		cost && linesNeedingPriceLookup.length > 0
			? await loadPreviousPackPrices(
					db,
					linesNeedingPriceLookup.map((line) => ({
						supplierId: row.supplierId,
						itemId: line.itemId,
						packBaseQuantity: line.packBaseQuantity,
						currentPriceMinor: line.priceMinor,
					})),
					{ excludeOrderId: row.id },
				)
			: new Map<string, PreviousPriceResult>()
	const belowMinimumNow = cost && (summary.shortOfMinimumMinor ?? 0) > 0
	const spendingContext =
		cost && row.status === 'draft' && row.approvalStatus === 'waiting_approval'
			? await (async () => {
					const [locSettings, spent] = await Promise.all([
						getLocationSettings(db, row.locationId, { cost: true }),
						monthlySpentMinor(db, row.locationId, now),
					])
					return {
						...(locSettings.orderLimitMinor != null
							? { orderLimitMinor: locSettings.orderLimitMinor }
							: {}),
						...(locSettings.monthlyLimitMinor != null
							? { monthlyLimitMinor: locSettings.monthlyLimitMinor }
							: {}),
						monthlySpentMinor: spent,
					}
				})()
			: null

	return {
		...summary,
		lines: lines.map((line): OrderLine => {
			const item = itemById.get(line.itemId)
			const place = placeById.get(line.itemId)
			const out: OrderLine = {
				id: line.id,
				itemId: line.itemId,
				itemName: item?.name ?? '',
				baseUnit: (item?.baseUnit ?? 'piece') as InventoryBaseUnit,
				countUnit: place?.countUnit ? wireUnit(place.countUnit) : null,
				supplierProductId: line.supplierProductId,
				packName: line.packName,
				packBaseQuantity: line.packBaseQuantity,
				pricedByWeight: line.pricedByWeight,
				packs: milliToPacks(line.packs),
				quantity: line.quantity,
				receivedQuantity: context.received.get(line.id) ?? 0,
				suggestedPacks:
					line.suggestedPacks === null
						? null
						: milliToPacks(line.suggestedPacks),
				onHand: onHand.get(line.itemId) ?? 0,
				fillUpToQuantity: place?.fillUpToQuantity ?? null,
			}
			if (cost && line.priceMinor !== null) {
				out.packPriceMinor = line.priceMinor
				out.lineTotalMinor = orderLineTotalMinor({
					packsMilli: line.packs,
					packPriceMinor: line.priceMinor,
				})
			}

			let explanation = parsedSavedExplanations.get(line.id) ?? null
			if (!explanation && line.suggestedPacks !== null && fallbackClock) {
				const onHandVal = onHand.get(line.itemId) ?? 0
				const onOrderVal = fallbackOnOrder.get(line.itemId) ?? 0
				const orderBelowVal = place?.orderBelowQuantity ?? null
				const fillUpToVal = place?.fillUpToQuantity ?? null
				const target = fillUpToVal ?? orderBelowVal
				const have = Math.max(onHandVal, 0) + Math.max(onOrderVal, 0)
				const neededVal =
					target !== null
						? Math.max(target - have, 0)
						: packsQuantity(line.suggestedPacks, line.packBaseQuantity)
				const lastCounted = fallbackLastCounted.get(line.itemId) ?? null
				explanation = {
					onHandQuantity: onHandVal,
					lastCountedAt: lastCounted,
					onOrderQuantity: onOrderVal,
					orderBelowQuantity: orderBelowVal,
					fillUpToQuantity: fillUpToVal,
					expectedUseUntilDeliveryQuantity: expectedUseUntilDelivery({
						today: fallbackClock.local.date,
						expectedDate: row.expectedDate,
						history: fallbackUseHistory.get(line.itemId) ?? [],
					}),
					neededQuantity: neededVal,
					packName: line.packName,
					packBaseQuantity: line.packBaseQuantity,
					rawPacksMilli: rawPacksMilli(neededVal, line.packBaseQuantity),
					roundedPacksMilli: line.suggestedPacks,
					warnings: {
						notCountedIn10Days: isOrderCountStale(lastCounted, now),
						priceChangedSinceLastOrder: false,
						belowSupplierMinimum: false,
					},
				}
			}

			if (explanation) {
				if (cost) {
					const priceInfo = prevPrices.get(`${row.supplierId}:${line.itemId}`)
					const prevPrice =
						explanation.previousOrderPackPriceMinor !== undefined
							? explanation.previousOrderPackPriceMinor
							: (priceInfo?.previousOrderPackPriceMinor ?? null)
					const currPrice =
						explanation.currentPackPriceMinor !== undefined
							? explanation.currentPackPriceMinor
							: line.priceMinor
					const priceChanged =
						explanation.previousOrderPackPriceMinor !== undefined &&
						explanation.currentPackPriceMinor !== undefined
							? explanation.warnings.priceChangedSinceLastOrder
							: (priceInfo?.priceChangedSinceLastOrder ?? false)
					explanation = maskExplanationForCost(
						{
							...explanation,
							previousOrderPackPriceMinor: prevPrice,
							currentPackPriceMinor: currPrice,
							warnings: {
								...explanation.warnings,
								priceChangedSinceLastOrder: priceChanged,
								belowSupplierMinimum: belowMinimumNow,
							},
						},
						true,
					)
				} else {
					explanation = maskExplanationForCost(explanation, false)
				}
				out.explanation = explanation
			}
			return out
		}),
		deliveries,
		supplierOrderChannel: supplier.orderChannel,
		supplierEmail: supplier.email,
		supplierPhone: supplier.phone,
		...spendingContext,
	}
}

export async function getOrder(
	db: InventoryReader,
	input: { id: string; caller: InventoryCaller },
): Promise<OrderDetail> {
	const row = await loadOrderRow(db, input.id, input.caller)
	return toDetail(db, row, input.caller.cost)
}

export async function listOrders(
	db: InventoryReader,
	input: { query: ListOrdersQuery; cost: boolean },
) {
	const { query } = input
	const cursor = decodeCursor(query.cursor)
	const statusFilter =
		query.status === 'all'
			? undefined
			: query.status === 'open'
				? inArray(invOrders.status, [...OPEN_ORDER_STATUSES])
				: query.status === 'closed'
					? inArray(invOrders.status, ['received', 'cancelled'])
					: query.status === 'waiting_for_approval'
						? and(
								eq(invOrders.status, 'draft'),
								eq(invOrders.approvalStatus, 'waiting_approval'),
							)
						: query.status === 'draft'
							? and(
									eq(invOrders.status, 'draft'),
									or(
										isNull(invOrders.approvalStatus),
										ne(invOrders.approvalStatus, 'waiting_approval'),
									),
								)
							: eq(invOrders.status, query.status)
	const rows = await db
		.select()
		.from(invOrders)
		.where(
			and(
				eq(invOrders.locationId, query.locationId),
				// bounded: at most five order statuses
				statusFilter,
				query.supplierId
					? eq(invOrders.supplierId, query.supplierId)
					: undefined,
				cursor
					? or(
							sql`${invOrders.createdAt} < ${cursor.sort}`,
							and(
								eq(invOrders.createdAt, cursor.sort),
								sql`${invOrders.id} < ${cursor.id}`,
							),
						)
					: undefined,
			),
		)
		.orderBy(desc(invOrders.createdAt), desc(invOrders.id))
		.limit(query.limit + 1)
	const page = rows.slice(0, query.limit)
	const last = page.at(-1)
	return {
		orders: await orderSummaries(db, page, input.cost),
		nextCursor:
			rows.length > query.limit && last
				? encodeCursor(last.createdAt, last.id)
				: null,
	}
}

// ── Supplier products and the suggestion ────────────────────────────────────

export type ProductChoice = { product: ProductRow; supplier: SupplierRow }

/** Every active product of an active supplier, by item. */
export async function loadProductChoices(
	db: InventoryReader,
): Promise<Map<string, ProductChoice[]>> {
	const rows = await db
		.select({ product: invSupplierProducts, supplier: invSuppliers })
		.from(invSupplierProducts)
		.innerJoin(
			invSuppliers,
			eq(invSuppliers.id, invSupplierProducts.supplierId),
		)
		.where(
			and(
				isNull(invSupplierProducts.archivedAt),
				isNull(invSuppliers.archivedAt),
			),
		)
		.orderBy(invSupplierProducts.createdAt, invSupplierProducts.id)
	const map = new Map<string, ProductChoice[]>()
	for (const row of rows) {
		const list = map.get(row.product.itemId)
		if (list) list.push(row)
		else map.set(row.product.itemId, [row])
	}
	return map
}

function perBaseUnit(product: ProductRow): number | null {
	return product.priceMinor === null
		? null
		: costMicroFromPackPriceClamped(
				product.priceMinor,
				product.packBaseQuantity,
			)
}

/**
 * The supplier product a suggestion buys an item with: the preferred one,
 * else the only one, else the cheapest per base unit (a product with no price
 * comes last; ties by supplier name, then id).
 */
export function chooseSupplierProduct(
	candidates: readonly ProductChoice[],
): ProductChoice | null {
	if (candidates.length === 0) return null
	const stable = (list: readonly ProductChoice[]) =>
		[...list].sort(
			(a, b) =>
				a.supplier.name
					.toLowerCase()
					.localeCompare(b.supplier.name.toLowerCase()) ||
				(a.product.id < b.product.id ? -1 : 1),
		)
	const preferred = candidates.filter((entry) => entry.product.preferred)
	if (preferred.length > 0) return stable(preferred)[0]!
	if (candidates.length === 1) return candidates[0]!
	return (
		[...stable(candidates)].sort((a, b) => {
			const left = perBaseUnit(a.product)
			const right = perBaseUnit(b.product)
			if (left === null && right === null) return 0
			if (left === null) return 1
			if (right === null) return -1
			return left - right
		})[0] ?? null
	)
}

/**
 * Still to arrive on sent and partly received orders at a location, by item.
 *
 * Goods that came in on a delivery NOT linked to the order (a Station receipt
 * that did not pick the order) still count against it: what the same supplier
 * delivered after the order was sent offsets that item's outstanding quantity,
 * oldest order first. Without this the same goods would count twice (on hand
 * and on order) and the suggestion would under-order.
 */
export async function onOrderByItem(
	db: InventoryReader,
	locationId: string,
	options: { todayDate?: string } = {},
): Promise<Map<string, number>> {
	const todayDate =
		options.todayDate ??
		(await locationBusinessDate(db, locationId, Date.now()))
	const cutoffDate = addDaysIso(todayDate, -2)
	const lines = await db
		.select({
			line: invOrderLines,
			supplierId: invOrders.supplierId,
			sentAt: invOrders.sentAt,
			createdAt: invOrders.createdAt,
		})
		.from(invOrderLines)
		.innerJoin(invOrders, eq(invOrders.id, invOrderLines.orderId))
		.where(
			and(
				eq(invOrders.locationId, locationId),
				inArray(invOrders.status, [...SUGGESTION_STATUSES]),
				or(
					isNull(invOrders.expectedDate),
					sql`${invOrders.expectedDate} >= ${cutoffDate}`,
				),
			),
		)
	const received = await receivedByOrderLine(
		db,
		lines.map((entry) => entry.line.id),
	)
	const since = Math.min(
		...lines.map((entry) => entry.sentAt ?? entry.createdAt),
		Number.MAX_SAFE_INTEGER,
	)
	const unlinked =
		lines.length === 0
			? []
			: await db
					.select({
						itemId: invDeliveryLines.itemId,
						supplierId: invDeliveries.supplierId,
						quantity: invDeliveryLines.quantity,
						at: invDeliveries.receivedAt,
					})
					.from(invDeliveryLines)
					.innerJoin(
						invDeliveries,
						eq(invDeliveries.id, invDeliveryLines.deliveryId),
					)
					.where(
						and(
							eq(invDeliveries.locationId, locationId),
							eq(invDeliveries.status, 'received'),
							isNull(invDeliveries.orderId),
							sql`${invDeliveries.supplierId} is not null`,
							sql`${invDeliveries.receivedAt} >= ${since}`,
							sql`${invDeliveryLines.quantity} > 0`,
						),
					)
	const pool = new Map<string, { at: number; quantity: number }[]>()
	for (const row of unlinked) {
		const key = `${row.supplierId}:${row.itemId}`
		const list = pool.get(key) ?? []
		list.push({ at: row.at ?? 0, quantity: row.quantity })
		pool.set(key, list)
	}
	const map = new Map<string, number>()
	const oldestFirst = [...lines].sort(
		(a, b) =>
			(a.sentAt ?? a.createdAt) - (b.sentAt ?? b.createdAt) ||
			(a.line.id < b.line.id ? -1 : 1),
	)
	for (const entry of oldestFirst) {
		const { line } = entry
		let outstanding = outstandingQuantity(
			line.quantity,
			received.get(line.id) ?? 0,
		)
		const sentAt = entry.sentAt ?? entry.createdAt
		for (const part of pool.get(`${entry.supplierId}:${line.itemId}`) ?? []) {
			if (outstanding <= 0) break
			if (part.at < sentAt || part.quantity <= 0) continue
			const take = Math.min(outstanding, part.quantity)
			part.quantity -= take
			outstanding -= take
		}
		map.set(line.itemId, (map.get(line.itemId) ?? 0) + outstanding)
	}
	return map
}

async function draftBySupplier(
	db: InventoryReader,
	locationId: string,
): Promise<Map<string, string>> {
	const rows = await db
		.select({ id: invOrders.id, supplierId: invOrders.supplierId })
		.from(invOrders)
		.where(
			and(
				eq(invOrders.locationId, locationId),
				eq(invOrders.status, 'draft'),
				or(
					isNull(invOrders.approvalStatus),
					ne(invOrders.approvalStatus, 'waiting_approval'),
				),
			),
		)
		.orderBy(desc(invOrders.createdAt), desc(invOrders.id))
	const map = new Map<string, string>()
	for (const row of rows) {
		if (!map.has(row.supplierId)) map.set(row.supplierId, row.id)
	}
	return map
}

/**
 * The suggested orders at a location: what to buy from whom, by the rules in
 * `@repo/inventory` (`needsOrder`, `suggestOrderQuantity`, supplier choice,
 * `nextOrderableDelivery`). Reads only; money only for the cost grant.
 */
export async function buildSuggestedOrders(
	db: InventoryReader,
	input: { locationId: string; cost: boolean; now: number; recipes?: boolean },
): Promise<SuggestedOrders> {
	const { locationId, cost } = input
	const clock = await locationClock(db, locationId, input.now)
	const overdueCutoff = addDaysIso(clock.date, -2)
	const [stock, choices, onOrder, drafts, overdueRows, useHistory] =
		await Promise.all([
			loadLocationStock(db, locationId),
			loadProductChoices(db),
			onOrderByItem(db, locationId, { todayDate: clock.date }),
			draftBySupplier(db, locationId),
			db
				.select({
					orderId: invOrders.id,
					number: invOrders.number,
					supplierId: invOrders.supplierId,
					supplierName: invSuppliers.name,
					expectedDate: invOrders.expectedDate,
				})
				.from(invOrders)
				.innerJoin(invSuppliers, eq(invSuppliers.id, invOrders.supplierId))
				.where(
					and(
						eq(invOrders.locationId, locationId),
						inArray(invOrders.status, [...SUGGESTION_STATUSES]),
						sql`${invOrders.expectedDate} is not null`,
						sql`${invOrders.expectedDate} < ${overdueCutoff}`,
					),
				)
				.orderBy(invOrders.expectedDate, invOrders.number),
			loadUseHistory(db, locationId, clock.local.date),
		])
	const overdueOrderWarnings: OverdueOrderWarning[] = overdueRows.map(
		(row) => ({
			orderId: row.orderId,
			number: row.number,
			supplierId: row.supplierId,
			supplierName: row.supplierName,
			expectedDate: row.expectedDate!,
			daysOverdue: Math.round(
				(Date.parse(`${clock.date}T00:00:00Z`) -
					Date.parse(`${row.expectedDate!}T00:00:00Z`)) /
					86_400_000,
			),
		}),
	)
	// Confirmed catering orders in the next two weeks add their ingredients on top
	// of the usual levels, so the order before the delivery that arrives in time
	// includes them (#513). A cancelled order is not confirmed: its need is gone.
	const cateringNeed =
		input.recipes === false
			? new Map<string, number>()
			: await cateringNeedByItem(db, locationId, input.now)
	const cards = new Map<string, SuggestedSupplierOrder>()
	const supplierById = new Map<string, SupplierRow>()
	const priceByLineKey = new Map<string, number | null>()
	const unsourced: SuggestedOrders['unsourced'] = []
	for (const row of stock) {
		const place = row.place
		const catering = cateringNeed.get(row.item.id) ?? 0
		if (!place && catering <= 0) continue
		// Catering is stock on top of the usual levels (a level may be unset).
		const orderBelow =
			catering > 0
				? (place?.orderBelowQuantity ?? 0) + catering
				: (place?.orderBelowQuantity ?? null)
		const fillUpTo =
			catering > 0
				? (place?.fillUpToQuantity ?? place?.orderBelowQuantity ?? 0) + catering
				: (place?.fillUpToQuantity ?? null)
		const pending = onOrder.get(row.item.id) ?? 0
		if (
			!needsOrder({
				onHand: row.onHand,
				onOrder: pending,
				orderBelow,
				fillUpTo,
			})
		) {
			continue
		}
		const countUnit = place?.countUnit ? wireUnit(place.countUnit) : null
		const choice = chooseSupplierProduct(choices.get(row.item.id) ?? [])
		if (!choice) {
			unsourced.push({
				itemId: row.item.id,
				itemName: row.item.name,
				baseUnit: row.item.baseUnit,
				countUnit,
				onHand: row.onHand,
				orderBelowQuantity: orderBelow,
				fillUpToQuantity: fillUpTo,
			})
			continue
		}
		const { product, supplier } = choice
		const suggestion = suggestOrderQuantity({
			onHand: row.onHand,
			onOrder: pending,
			orderBelow,
			fillUpTo,
			packBase: product.packBaseQuantity,
			pricedByWeight: product.pricedByWeight,
		})
		if (!suggestion) continue
		let card = cards.get(supplier.id)
		if (!card) {
			const next = nextOrderableDelivery(
				supplierSchedule(supplier),
				clock.local,
			)
			card = {
				supplierId: supplier.id,
				supplierName: supplier.name,
				orderChannel: supplier.orderChannel,
				expectedDate: next?.expectedDate ?? null,
				cutoff: next && supplier.cutoffTime ? next.cutoff : null,
				cutoffPassed: next === null && supplier.deliveryDays.length > 0,
				draftOrderId: drafts.get(supplier.id) ?? null,
				lineCount: 0,
				lines: [],
			}
			cards.set(supplier.id, card)
			supplierById.set(supplier.id, supplier)
		}
		const expectedUse = expectedUseUntilDelivery({
			today: clock.local.date,
			expectedDate: card.expectedDate,
			history: useHistory.get(row.item.id) ?? [],
		})
		const explanation: OrderLineExplanation = {
			onHandQuantity: row.onHand,
			lastCountedAt: row.lastCountedAt,
			onOrderQuantity: pending,
			orderBelowQuantity: orderBelow,
			fillUpToQuantity: fillUpTo,
			expectedUseUntilDeliveryQuantity: expectedUse,
			neededQuantity: suggestion.needed,
			...(catering > 0 ? { cateringQuantity: catering } : {}),
			packName: product.packName,
			packBaseQuantity: product.packBaseQuantity,
			rawPacksMilli: suggestion.rawPacksMilli,
			roundedPacksMilli: suggestion.packsMilli,
			warnings: {
				notCountedIn10Days: isOrderCountStale(row.lastCountedAt, input.now),
				priceChangedSinceLastOrder: false,
				belowSupplierMinimum: false,
			},
		}
		const line: SuggestedOrderLine = {
			itemId: row.item.id,
			itemName: row.item.name,
			baseUnit: row.item.baseUnit,
			countUnit,
			onHand: row.onHand,
			onOrderQuantity: pending,
			orderBelowQuantity: orderBelow,
			fillUpToQuantity: fillUpTo,
			status: row.status,
			supplierProductId: product.id,
			packName: product.packName,
			packBaseQuantity: product.packBaseQuantity,
			pricedByWeight: product.pricedByWeight,
			packs: suggestion.packs,
			quantity: suggestion.quantity,
			explanation,
		}
		if (cost && product.priceMinor !== null) {
			line.packPriceMinor = product.priceMinor
			line.lineTotalMinor = orderLineTotalMinor({
				packsMilli: suggestion.packsMilli,
				packPriceMinor: product.priceMinor,
			})
		}
		priceByLineKey.set(`${supplier.id}:${row.item.id}`, product.priceMinor)
		card.lines.push(line)
		card.lineCount += 1
	}
	const suppliers = [...cards.values()]
	if (cost && suppliers.length > 0) {
		const pricePairs = suppliers.flatMap((card) =>
			card.lines.map((line) => ({
				supplierId: card.supplierId,
				itemId: line.itemId,
				packBaseQuantity: line.packBaseQuantity,
				currentPriceMinor:
					priceByLineKey.get(`${card.supplierId}:${line.itemId}`) ?? null,
			})),
		)
		const prevPrices = await loadPreviousPackPrices(db, pricePairs)
		for (const card of suppliers) {
			const supplier = supplierById.get(card.supplierId)
			const money = orderTotalMinor(
				card.lines.map((line) => ({
					packs: line.packs,
					packPriceMinor: line.packPriceMinor ?? null,
				})),
			)
			card.totalMinor = money.totalMinor
			card.unpricedLines = money.unpricedLines
			const currency = supplier?.currency
			if (currency) card.currency = currency
			if (supplier?.minimumOrderMinor != null) {
				card.minimumOrderMinor = supplier.minimumOrderMinor
				card.belowMinimum =
					shortOfMinimumMinor(money.totalMinor, supplier.minimumOrderMinor) > 0
			}
			for (const line of card.lines) {
				if (!line.explanation) continue
				const key = `${card.supplierId}:${line.itemId}`
				const prev = prevPrices.get(key)
				const currentPrice = priceByLineKey.get(key) ?? null
				line.explanation = maskExplanationForCost(
					{
						...line.explanation,
						previousOrderPackPriceMinor:
							prev?.previousOrderPackPriceMinor ?? null,
						currentPackPriceMinor: currentPrice,
						warnings: {
							...line.explanation.warnings,
							priceChangedSinceLastOrder:
								prev?.priceChangedSinceLastOrder ?? false,
							belowSupplierMinimum: card.belowMinimum === true,
						},
					},
					true,
				)
			}
		}
	}
	suppliers.sort(
		(a, b) =>
			b.lineCount - a.lineCount ||
			a.supplierName
				.toLowerCase()
				.localeCompare(b.supplierName.toLowerCase()) ||
			(a.supplierId < b.supplierId ? -1 : 1),
	)
	unsourced.sort(
		(a, b) =>
			a.itemName.toLowerCase().localeCompare(b.itemName.toLowerCase()) ||
			(a.itemId < b.itemId ? -1 : 1),
	)
	return {
		locationId,
		generatedAt: input.now,
		suppliers,
		unsourced,
		toOrderItems: suppliers.reduce((sum, card) => sum + card.lineCount, 0),
		overdueOrderWarnings,
	}
}

// ── Create and edit ─────────────────────────────────────────────────────────

type ResolvedLine = {
	itemId: string
	product: ProductRow
	packsMilli: number
	suggestedPacksMilli: number | null
	suggestionExplanationJson: string | null
}

/** Validates typed lines against the supplier's products and snapshots them. */
async function resolveLines(
	tx: InventoryTx,
	supplierId: string,
	lines: ReadonlyArray<{
		itemId: string
		supplierProductId: string
		packs: number
		suggestedPacksMilli?: number | null
		suggestionExplanationJson?: string | null
	}>,
): Promise<ResolvedLine[]> {
	const productIds = [...new Set(lines.map((line) => line.supplierProductId))]
	if (productIds.length !== lines.length) throw badRequest('duplicate_line')
	const products = await queryInChunks(productIds, (chunk) =>
		tx
			.select()
			.from(invSupplierProducts)
			.where(
				and(
					inArray(invSupplierProducts.id, chunk),
					isNull(invSupplierProducts.archivedAt),
				),
			),
	)
	const productById = new Map(products.map((row) => [row.id, row]))
	const itemIds = [...new Set(lines.map((line) => line.itemId))]
	const items = await queryInChunks(itemIds, (chunk) =>
		tx
			.select({ id: invItems.id, archivedAt: invItems.archivedAt })
			.from(invItems)
			.where(inArray(invItems.id, chunk)),
	)
	const activeItems = new Set(
		items.filter((item) => item.archivedAt === null).map((item) => item.id),
	)
	return lines.map((line) => {
		const product = productById.get(line.supplierProductId)
		if (!product) throw notFound()
		if (product.supplierId !== supplierId) {
			throw new InventoryError('supplier_mismatch', 409)
		}
		if (product.itemId !== line.itemId || !activeItems.has(line.itemId)) {
			throw notFound()
		}
		const packsMilli = packsToMilli(line.packs)
		const step = product.pricedByWeight
			? PRICED_BY_WEIGHT_PACK_STEP_MILLI
			: PACK_SCALE
		if (packsMilli <= 0 || packsMilli % step !== 0)
			throw badRequest('pack_step')
		return {
			itemId: line.itemId,
			product,
			packsMilli,
			suggestedPacksMilli: line.suggestedPacksMilli ?? null,
			suggestionExplanationJson: line.suggestionExplanationJson ?? null,
		}
	})
}

function lineQuantity(packsMilli: number, packBase: number): number {
	let quantity: number
	try {
		quantity = packsQuantity(packsMilli, packBase)
	} catch {
		throw badRequest('amount_out_of_range')
	}
	if (quantity <= 0 || quantity > MAX_ENTRY_QUANTITY) {
		throw badRequest('amount_out_of_range')
	}
	return quantity
}

async function insertLines(
	tx: InventoryTx,
	orderId: string,
	lines: readonly ResolvedLine[],
	now: number,
): Promise<void> {
	const rows = lines.map((line, index) => ({
		id: newId(),
		orderId,
		itemId: line.itemId,
		supplierProductId: line.product.id,
		packName: line.product.packName,
		packBaseQuantity: line.product.packBaseQuantity,
		pricedByWeight: line.product.pricedByWeight,
		packs: line.packsMilli,
		quantity: lineQuantity(line.packsMilli, line.product.packBaseQuantity),
		priceMinor: line.product.priceMinor,
		suggestedPacks: line.suggestedPacksMilli,
		suggestionExplanationJson: line.suggestionExplanationJson,
		sortOrder: index,
		createdAt: now,
	}))
	await insertRowsInChunks(invOrderLines, rows, (chunk) =>
		tx.insert(invOrderLines).values(chunk),
	)
}

/** The next human number ("Order 12"), taken inside the write that creates the order. */
async function takeOrderNumber(
	tx: InventoryTx,
	region: 'us' | 'ksa',
	now: number,
): Promise<number> {
	const row = await tx
		.select()
		.from(invSettings)
		.where(eq(invSettings.id, 'default'))
		.get()
	if (!row) {
		// A row at version 0 reads exactly as "never saved" (`getInventorySettings`).
		const defaults = await getInventorySettings(tx, region)
		await tx.insert(invSettings).values({
			id: 'default',
			targetFoodCostBp: defaults.targetFoodCostBp,
			unitSystem: defaults.unitSystem,
			countDayOfWeek: defaults.countDayOfWeek,
			nextOrderNumber: 2,
			version: 0,
			updatedAt: now,
		})
		return 1
	}
	await tx
		.update(invSettings)
		.set({ nextOrderNumber: row.nextOrderNumber + 1 })
		.where(eq(invSettings.id, 'default'))
	return row.nextOrderNumber
}

async function loadSupplierRow(
	db: InventoryReader,
	id: string,
	options: { archived?: boolean } = {},
): Promise<SupplierRow> {
	const row = await db
		.select()
		.from(invSuppliers)
		.where(eq(invSuppliers.id, id))
		.get()
	if (!row || (row.archivedAt !== null && !options.archived)) throw notFound()
	return row
}

export async function createOrder(
	caller: InventoryCaller,
	input: { body: CreateOrderInput; idempotency: InventoryIdempotency },
): Promise<OrderDetail> {
	const { body } = input
	assertLocationAllowed(caller.locationIds, body.locationId)
	return withInventoryWrite(
		{ orgId: caller.orgId, idempotency: input.idempotency },
		async (tx, ctx) => {
			const supplier = await loadSupplierRow(tx, body.supplierId)
			const open = await tx
				.select({ n: count() })
				.from(invOrders)
				.where(
					and(
						eq(invOrders.locationId, body.locationId),
						inArray(invOrders.status, [...OPEN_ORDER_STATUSES]),
					),
				)
				.get()
			if (Number(open?.n ?? 0) >= INVENTORY_LIMITS.openOrdersPerLocation) {
				throw new InventoryError('limit_reached', 409)
			}

			let typed: Array<{
				itemId: string
				supplierProductId: string
				packs: number
				suggestedPacksMilli?: number | null
				suggestionExplanationJson?: string | null
			}> = (body.lines ?? []).map((line) => ({
				itemId: line.itemId,
				supplierProductId: line.supplierProductId,
				packs: line.packs,
				suggestedPacksMilli:
					line.suggestedPacks != null
						? packsToMilli(line.suggestedPacks)
						: null,
				suggestionExplanationJson: line.explanation
					? JSON.stringify(
							maskExplanationForCost(line.explanation, caller.cost),
						)
					: null,
			}))
			if (body.fromSuggestion) {
				const suggestion = await buildSuggestedOrders(tx, {
					locationId: body.locationId,
					cost: true,
					now: ctx.now,
				})
				const card = suggestion.suppliers.find(
					(entry) => entry.supplierId === supplier.id,
				)
				typed = (card?.lines ?? []).map((line) => ({
					itemId: line.itemId,
					supplierProductId: line.supplierProductId,
					packs: line.packs,
					suggestedPacksMilli: packsToMilli(line.packs),
					suggestionExplanationJson: line.explanation
						? JSON.stringify(line.explanation)
						: null,
				}))
			}
			const resolved = await resolveLines(tx, supplier.id, typed)

			let expectedDate: string | null
			if (body.expectedDate !== undefined) {
				expectedDate = body.expectedDate
			} else {
				const clock = await locationClock(tx, body.locationId, ctx.now)
				expectedDate =
					nextOrderableDelivery(supplierSchedule(supplier), clock.local)
						?.expectedDate ?? null
			}
			const id = newId()
			const number = await takeOrderNumber(tx, caller.region, ctx.now)
			await tx.insert(invOrders).values({
				id,
				number,
				clientId: body.clientId,
				locationId: body.locationId,
				supplierId: supplier.id,
				status: 'draft',
				expectedDate,
				note: body.note?.length ? body.note : null,
				currency: supplier.currency,
				createdByKind: caller.actor.kind,
				createdById: caller.actor.id,
				createdAt: ctx.now,
				updatedAt: ctx.now,
			})
			await insertLines(tx, id, resolved, ctx.now)
			await recordInventoryAudit(tx, {
				actorKind: caller.actor.kind,
				actorId: caller.actor.id,
				action: 'order.create',
				resourceType: 'order',
				resourceId: id,
				locationId: body.locationId,
				detail: {
					number,
					lines: resolved.length,
					fromSuggestion: body.fromSuggestion === true,
				},
				at: ctx.now,
			})
			return toDetail(
				tx,
				await loadOrderRow(tx, id, caller),
				caller.cost,
				ctx.now,
			)
		},
	)
}

export async function updateOrder(
	caller: InventoryCaller,
	input: { id: string; body: UpdateOrderInput },
): Promise<OrderDetail> {
	const { body } = input
	return withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const row = await loadOrderRow(tx, input.id, caller)
		assertVersion(row.version, body.expectedVersion)
		if (row.status === 'received' || row.status === 'cancelled') {
			throw new InventoryError('order_not_editable', 409)
		}
		if (row.approvalStatus === 'waiting_approval') {
			throw new InventoryError('order_not_editable', 409)
		}
		if (body.lines !== undefined && row.status !== 'draft') {
			throw new InventoryError('order_not_editable', 409)
		}
		const set: Partial<typeof invOrders.$inferInsert> = {
			version: row.version + 1,
			updatedAt: ctx.now,
		}
		if (body.expectedDate !== undefined) set.expectedDate = body.expectedDate
		if (body.note !== undefined) set.note = body.note?.length ? body.note : null
		let lineCount: number | null = null
		if (body.lines !== undefined) {
			const old = await tx
				.select()
				.from(invOrderLines)
				.where(eq(invOrderLines.orderId, row.id))
			const oldByKey = new Map(
				old.map((line) => [`${line.itemId}:${line.supplierProductId}`, line]),
			)
			const resolved = await resolveLines(
				tx,
				row.supplierId,
				body.lines.map((line) => {
					const prev = oldByKey.get(`${line.itemId}:${line.supplierProductId}`)
					return {
						...line,
						suggestedPacksMilli:
							prev?.suggestedPacks ??
							(line.suggestedPacks != null
								? packsToMilli(line.suggestedPacks)
								: null),
						suggestionExplanationJson:
							prev?.suggestionExplanationJson ??
							(line.explanation
								? JSON.stringify(
										maskExplanationForCost(line.explanation, caller.cost),
									)
								: null),
					}
				}),
			)
			await tx.delete(invOrderLines).where(eq(invOrderLines.orderId, row.id))
			await insertLines(tx, row.id, resolved, ctx.now)
			lineCount = resolved.length
		}
		await tx.update(invOrders).set(set).where(eq(invOrders.id, row.id))
		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: 'order.update',
			resourceType: 'order',
			resourceId: row.id,
			locationId: row.locationId,
			detail: { lines: lineCount },
			at: ctx.now,
		})
		return toDetail(
			tx,
			await loadOrderRow(tx, row.id, caller),
			caller.cost,
			ctx.now,
		)
	})
}

export async function cancelOrder(
	caller: InventoryCaller,
	input: { id: string; expectedVersion: number; note?: string },
): Promise<OrderDetail> {
	return withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const row = await loadOrderRow(tx, input.id, caller)
		assertVersion(row.version, input.expectedVersion)
		if (row.status === 'received' || row.status === 'cancelled') {
			throw new InventoryError('order_closed', 409)
		}
		await tx
			.update(invOrders)
			.set({
				status: 'cancelled',
				closedAt: ctx.now,
				note: input.note?.length ? input.note : row.note,
				version: row.version + 1,
				updatedAt: ctx.now,
			})
			.where(eq(invOrders.id, row.id))
		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: 'order.cancel',
			resourceType: 'order',
			resourceId: row.id,
			locationId: row.locationId,
			detail: { from: row.status },
			at: ctx.now,
		})
		return toDetail(tx, await loadOrderRow(tx, row.id, caller), caller.cost)
	})
}

// ── Text and sending ────────────────────────────────────────────────────────

async function renderFor(
	db: InventoryReader,
	row: OrderRow,
	locale: OrderTextLocale,
	region: 'us' | 'ksa',
): Promise<{
	text: OrderText
	supplier: SupplierRow
	html: string
}> {
	const context = await loadOrderContext(db, [row])
	const supplier = context.suppliers.get(row.supplierId)!
	const lines = context.lines.get(row.id) ?? []
	const items = await queryInChunks(
		[...new Set(lines.map((line) => line.itemId))],
		(chunk) =>
			db
				.select({
					id: invItems.id,
					name: invItems.name,
					baseUnit: invItems.baseUnit,
				})
				.from(invItems)
				.where(inArray(invItems.id, chunk)),
	)
	const itemById = new Map(items.map((item) => [item.id, item]))
	const settings = await getInventorySettings(db, region)
	const rendered = renderOrderText({
		locale,
		number: row.number,
		supplierName: supplier.name,
		contactName: supplier.contactName,
		expectedDate: row.expectedDate,
		note: row.note,
		unitSystem: settings.unitSystem,
		lines: lines.map((line) => ({
			itemName: itemById.get(line.itemId)?.name ?? '',
			packName: line.packName,
			packs: milliToPacks(line.packs),
			quantity: line.quantity,
			baseUnit: (itemById.get(line.itemId)?.baseUnit ??
				'piece') as InventoryBaseUnit,
		})),
	})
	return {
		supplier,
		html: orderTextToHtml(rendered.text, locale),
		text: {
			locale,
			subject: rendered.subject,
			text: rendered.text,
			waLink: buildWhatsAppLink(supplier.phone, rendered.text),
			mailto: buildMailtoLink(supplier.email, rendered.subject, rendered.text),
		},
	}
}

/** `GET /orders/:id/text`: the text exactly as send would produce it. */
export async function getOrderText(
	db: InventoryReader,
	input: { id: string; locale?: OrderTextLocale; caller: InventoryCaller },
): Promise<OrderText> {
	const row = await loadOrderRow(db, input.id, input.caller)
	return (await renderFor(db, row, input.locale ?? 'en', input.caller.region))
		.text
}

/** How long a send in flight blocks another one (the email call may take a while). */
export const ORDER_SEND_CLAIM_TTL_MS = 2 * 60 * 1000

function monthKeyInZone(ms: number, timeZone: string): string {
	const parts = localParts(ms, timeZone)
	return `${parts.year}-${String(parts.month).padStart(2, '0')}`
}

/**
 * Total spent at `locationId` in the current calendar month (in the location's
 * IANA time zone), counting `sent`, `partly_received`, and `received` orders
 * whose `sentAt` falls in that calendar month.
 */
export async function monthlySpentMinor(
	db: InventoryReader,
	locationId: string,
	now: number,
): Promise<number> {
	const clock = await locationClock(db, locationId, now)
	const currentMonth = monthKeyInZone(now, clock.timeZone)
	const earliestLookback = now - 40 * 86_400_000
	const orders = await db
		.select({ id: invOrders.id, sentAt: invOrders.sentAt })
		.from(invOrders)
		.where(
			and(
				eq(invOrders.locationId, locationId),
				inArray(invOrders.status, ['sent', 'partly_received', 'received']),
				isNotNull(invOrders.sentAt),
				gte(invOrders.sentAt, earliestLookback),
			),
		)
	const matchingIds = orders
		.filter(
			(entry) =>
				entry.sentAt !== null &&
				monthKeyInZone(entry.sentAt, clock.timeZone) === currentMonth,
		)
		.map((entry) => entry.id)
	if (matchingIds.length === 0) return 0
	const linesByOrder = await loadOrderLines(db, matchingIds)
	let total = 0
	for (const orderId of matchingIds) {
		const lines = linesByOrder.get(orderId) ?? []
		total += orderTotalMinor(
			lines.map((line) => ({
				packs: milliToPacks(line.packs),
				packPriceMinor: line.priceMinor,
			})),
		).totalMinor
	}
	return total
}

export function orderApprovalEventId(input: {
	orgId: string
	locationId: string
	orderId: string
	requestedAt: number
}): string {
	return createHash('sha256')
		.update(
			inventoryNotifyDedupeKey({
				orgId: input.orgId,
				kind: 'inventory_order_approval',
				locationId: input.locationId,
				key: `${input.orderId}:${input.requestedAt}`,
			}),
		)
		.digest('hex')
}

export async function deliverOrderApprovalAlert(
	db: TenantDatabase,
	input: {
		orgId: string
		order: Pick<
			OrderRow,
			| 'id'
			| 'number'
			| 'locationId'
			| 'approvalRequestedAt'
			| 'approvalBreachedOrderLimit'
			| 'approvalBreachedMonthlyLimit'
			| 'approvalAlertAttempts'
		>
		now: number
		post?: (event: InventoryNotifyEvent) => Promise<InventoryNotifyOutcome>
	},
): Promise<InventoryNotifyOutcome> {
	const post = input.post ?? postInventoryNotify
	const { order } = input
	const outcome = await post({
		orgId: input.orgId,
		eventId: orderApprovalEventId({
			orgId: input.orgId,
			locationId: order.locationId,
			orderId: order.id,
			requestedAt: order.approvalRequestedAt ?? input.now,
		}),
		kind: 'inventory_order_approval',
		locationId: order.locationId,
		count: 1,
		orderApproval: {
			orderId: order.id,
			orderNumber: order.number,
			breachedOrderLimit: order.approvalBreachedOrderLimit,
			breachedMonthlyLimit: order.approvalBreachedMonthlyLimit,
		},
	})
	const nextAttempts = order.approvalAlertAttempts + 1
	if (outcome.status === 'delivered' || outcome.status === 'rejected') {
		await db
			.update(invOrders)
			.set({
				approvalAlertStatus: 'sent',
				approvalAlertAttempts: nextAttempts,
				updatedAt: input.now,
			})
			.where(
				and(
					eq(invOrders.id, order.id),
					eq(invOrders.approvalStatus, 'waiting_approval'),
					eq(invOrders.approvalAlertStatus, 'pending'),
				),
			)
	} else {
		await db
			.update(invOrders)
			.set({
				approvalAlertAttempts: nextAttempts,
				updatedAt: input.now,
			})
			.where(
				and(
					eq(invOrders.id, order.id),
					eq(invOrders.approvalStatus, 'waiting_approval'),
					eq(invOrders.approvalAlertStatus, 'pending'),
				),
			)
	}
	return outcome
}

function isSelfApprovalForbidden(
	row: Pick<OrderRow, 'createdById' | 'approvalRequestedById'>,
	caller: Pick<InventoryCaller, 'actor' | 'isOwner'>,
): boolean {
	if (caller.isOwner) return false
	if (caller.actor.id === null) return false
	return (
		row.createdById === caller.actor.id ||
		row.approvalRequestedById === caller.actor.id
	)
}

function assertCanApproveOrders(caller: InventoryCaller): void {
	if (!caller.purchasing || !caller.canManageSettings) {
		throw new InventoryError('forbidden', 403, { reason: 'grant' })
	}
}

/**
 * Executes the actual order delivery (email / WhatsApp / copy / PDF) and
 * marks a draft order sent. Shared by `sendOrder` (when within limits or
 * resending) and `approveOrder` (when approving an order waiting for approval).
 */
async function executeOrderSend(
	caller: InventoryCaller,
	input: {
		row: OrderRow
		rendered: Awaited<ReturnType<typeof renderFor>>
		channel: OrderSendChannel
		locale: OrderTextLocale
		expectedVersion: number
		approve: boolean
	},
): Promise<SendOrderResult> {
	const { row, rendered, channel, locale } = input
	const { supplier } = rendered

	const willEmail =
		channel === 'email' && !!supplier.email && canSendTenantEmail()
	let emailSent = false
	let emailSkipped: SendOrderResult['emailSkipped'] = null
	if (channel === 'email' && !willEmail) {
		emailSkipped = !supplier.email ? 'no_supplier_email' : 'not_configured'
	}

	const assertSendableState = (current: OrderRow) => {
		if (input.approve) {
			if (
				current.status !== 'draft' ||
				current.approvalStatus !== 'waiting_approval'
			) {
				throw stateConflict('not_waiting_approval')
			}
			if (isSelfApprovalForbidden(current, caller)) {
				throw new InventoryError('self_approval_forbidden', 403)
			}
			return
		}
		if (current.status === 'received' || current.status === 'cancelled') {
			throw new InventoryError('order_closed', 409)
		}
		if (
			current.status === 'draft' &&
			current.approvalStatus === 'waiting_approval'
		) {
			throw new InventoryError('order_not_editable', 409)
		}
	}

	if (willEmail) {
		// Claim the send under the lock, before anything goes out.
		await withInventoryWrite(
			{ orgId: caller.orgId, skipAutoSoldOut: true },
			async (tx, ctx) => {
				const current = await loadOrderRow(tx, row.id, caller)
				assertVersion(current.version, input.expectedVersion)
				assertSendableState(current)
				if (
					current.sendClaimAt !== null &&
					ctx.now - current.sendClaimAt < ORDER_SEND_CLAIM_TTL_MS
				) {
					throw new InventoryError('send_in_progress', 409)
				}
				await tx
					.update(invOrders)
					.set({ sendClaimAt: ctx.now })
					.where(eq(invOrders.id, current.id))
			},
		)
		const releaseClaim = () =>
			withInventoryWrite(
				{ orgId: caller.orgId, skipAutoSoldOut: true },
				async (tx) => {
					await tx
						.update(invOrders)
						.set({ sendClaimAt: null })
						.where(eq(invOrders.id, row.id))
				},
			).catch((error: unknown) => {
				console.error('Inventory order send claim not released', {
					orgId: caller.orgId,
					orderId: row.id,
					reason: error instanceof Error ? error.name : 'unknown',
				})
			})
		let failedStatus: number | null = null
		try {
			const result = await sendTenantEmail({
				to: supplier.email!,
				toName: supplier.contactName || supplier.name,
				subject: rendered.text.subject,
				text: rendered.text.text,
				html: rendered.html,
				capture: {
					orgId: caller.orgId,
					messageKind: 'inventory_order',
					messageId: row.id,
				},
			})
			if (result.status === 'error') {
				failedStatus = result.error.statusCode ?? 0
			} else {
				emailSent = true
			}
		} catch (error) {
			failedStatus = 0
			console.error('Inventory order email threw', {
				orgId: caller.orgId,
				orderId: row.id,
				reason: error instanceof Error ? error.name : 'unknown',
			})
		}
		if (!emailSent) {
			console.error('Inventory order email failed', {
				orgId: caller.orgId,
				orderId: row.id,
				statusCode: failedStatus || null,
			})
			await releaseClaim()
			throw new InventoryError('email_failed', 502)
		}
	}

	const markSent = () =>
		withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
			const current = await loadOrderRow(tx, row.id, caller)
			// With an email out, the claim above is this send's own.
			if (!willEmail) assertVersion(current.version, input.expectedVersion)
			assertSendableState(current)
			if (
				!willEmail &&
				current.sendClaimAt !== null &&
				ctx.now - current.sendClaimAt < ORDER_SEND_CLAIM_TTL_MS
			) {
				throw new InventoryError('send_in_progress', 409)
			}
			if (current.status === 'draft') {
				await tx
					.update(invOrders)
					.set({
						status: 'sent',
						sentAt: ctx.now,
						sentVia: channel,
						sendClaimAt: null,
						...(input.approve
							? {
									approvalStatus: 'approved' as const,
									approvedAt: ctx.now,
									approvedByKind: caller.actor.kind,
									approvedById: caller.actor.id,
									approvalAlertStatus: 'sent' as const,
								}
							: {}),
						version: current.version + 1,
						updatedAt: ctx.now,
					})
					.where(eq(invOrders.id, current.id))
			} else if (current.sendClaimAt !== null) {
				await tx
					.update(invOrders)
					.set({ sendClaimAt: null })
					.where(eq(invOrders.id, current.id))
			}
			await recordInventoryAudit(tx, {
				actorKind: caller.actor.kind,
				actorId: caller.actor.id,
				action: input.approve
					? 'order.approve'
					: current.status === 'draft'
						? 'order.send'
						: 'order.resend',
				resourceType: 'order',
				resourceId: current.id,
				locationId: current.locationId,
				detail: { channel, emailSent, locale },
				at: ctx.now,
			})
			return toDetail(
				tx,
				await loadOrderRow(tx, current.id, caller),
				caller.cost,
				ctx.now,
			)
		})
	let order: Awaited<ReturnType<typeof markSent>>
	try {
		order = await markSent()
	} catch (error) {
		if (!emailSent) throw error
		// The supplier has the order but the write failed: try once more, then
		// leave it for the retry (the claim expires and the same message id is sent).
		try {
			order = await markSent()
		} catch (again) {
			console.error('Inventory order emailed but not marked sent', {
				orgId: caller.orgId,
				orderId: row.id,
				reason: again instanceof Error ? again.name : 'unknown',
			})
			throw again
		}
	}
	return {
		...rendered.text,
		waLink: channel === 'whatsapp' ? rendered.text.waLink : null,
		mailto: channel === 'email' && !emailSent ? rendered.text.mailto : null,
		order,
		channel,
		emailSent,
		emailSkipped,
	}
}

/**
 * Sends an order. When a draft exceeds the location's per-order or monthly
 * spending limit, it moves to `waiting_for_approval` without sending anything
 * and notifies managers who can approve it. Otherwise it delegates to
 * `executeOrderSend`.
 */
export async function sendOrder(
	caller: InventoryCaller,
	input: {
		id: string
		body: SendOrderInput
		options?: {
			notify?: (event: InventoryNotifyEvent) => Promise<InventoryNotifyOutcome>
		}
	},
): Promise<SendOrderResult> {
	const { body } = input
	const locale = body.locale ?? 'en'
	const db = await getTenantDb(caller.orgId)
	const row = await loadOrderRow(db, input.id, caller)
	assertVersion(row.version, body.expectedVersion)
	if (row.status === 'received' || row.status === 'cancelled') {
		throw new InventoryError('order_closed', 409)
	}
	if (row.status === 'draft' && row.approvalStatus === 'waiting_approval') {
		throw new InventoryError('order_not_editable', 409)
	}
	const context = await loadOrderContext(db, [row])
	if ((context.lines.get(row.id) ?? []).length === 0) {
		throw new InventoryError('order_empty', 409)
	}
	const rendered = await renderFor(db, row, locale, caller.region)

	if (row.status === 'draft') {
		const approvalHold = await withInventoryWrite(
			{ orgId: caller.orgId },
			async (tx, ctx) => {
				const current = await loadOrderRow(tx, row.id, caller)
				assertVersion(current.version, body.expectedVersion)
				if (current.status !== 'draft') return null
				if (current.approvalStatus === 'waiting_approval') {
					throw new InventoryError('order_not_editable', 409)
				}
				const locRow = await tx
					.select({
						orderLimitMinor: invLocationSettings.orderLimitMinor,
						monthlyLimitMinor: invLocationSettings.monthlyLimitMinor,
					})
					.from(invLocationSettings)
					.where(eq(invLocationSettings.locationId, current.locationId))
					.get()
				const orderLimitMinor = locRow?.orderLimitMinor ?? null
				const monthlyLimitMinor = locRow?.monthlyLimitMinor ?? null
				if (orderLimitMinor === null && monthlyLimitMinor === null) {
					return null
				}
				const lines =
					(await loadOrderLines(tx, [current.id])).get(current.id) ?? []
				if (lines.length === 0) throw new InventoryError('order_empty', 409)
				const orderTotal = orderTotalMinor(
					lines.map((line) => ({
						packs: milliToPacks(line.packs),
						packPriceMinor: line.priceMinor,
					})),
				).totalMinor
				const spent =
					monthlyLimitMinor !== null
						? await monthlySpentMinor(tx, current.locationId, ctx.now)
						: 0
				const breachedOrder =
					orderLimitMinor !== null && orderTotal > orderLimitMinor
				const breachedMonthly =
					monthlyLimitMinor !== null && spent + orderTotal > monthlyLimitMinor
				if (!breachedOrder && !breachedMonthly) {
					return null
				}
				await tx
					.update(invOrders)
					.set({
						approvalStatus: 'waiting_approval',
						requestedSendChannel: body.channel,
						requestedSendLocale: locale,
						approvalRequestedAt: ctx.now,
						approvalRequestedByKind: caller.actor.kind,
						approvalRequestedById: caller.actor.id,
						approvalBreachedOrderLimit: breachedOrder,
						approvalBreachedMonthlyLimit: breachedMonthly,
						rejectedAt: null,
						rejectedByKind: null,
						rejectedById: null,
						rejectionReason: null,
						approvalAlertStatus: 'pending',
						approvalAlertAttempts: 0,
						version: current.version + 1,
						updatedAt: ctx.now,
					})
					.where(eq(invOrders.id, current.id))
				await recordInventoryAudit(tx, {
					actorKind: caller.actor.kind,
					actorId: caller.actor.id,
					action: 'order.approval_requested',
					resourceType: 'order',
					resourceId: current.id,
					locationId: current.locationId,
					detail: {
						channel: body.channel,
						breachedOrderLimit: breachedOrder,
						breachedMonthlyLimit: breachedMonthly,
					},
					at: ctx.now,
				})
				const updated = await loadOrderRow(tx, current.id, caller)
				const detail = await toDetail(tx, updated, caller.cost, ctx.now)
				return {
					updated,
					detail,
					orderLimitMinor,
					monthlyLimitMinor,
					spent,
					now: ctx.now,
				}
			},
		)
		if (approvalHold) {
			await deliverOrderApprovalAlert(await getTenantDb(caller.orgId), {
				orgId: caller.orgId,
				order: approvalHold.updated,
				now: approvalHold.now,
				post: input.options?.notify,
			}).catch((error: unknown) => {
				console.error('Inventory order approval alert failed', {
					orgId: caller.orgId,
					orderId: approvalHold.updated.id,
					reason: error instanceof Error ? error.name : 'unknown',
				})
			})
			return {
				...rendered.text,
				waLink: null,
				mailto: null,
				order: approvalHold.detail,
				channel: body.channel,
				emailSent: false,
				emailSkipped: null,
				waitingForApproval: true,
				...(caller.cost
					? {
							...(approvalHold.orderLimitMinor !== null
								? { orderLimitMinor: approvalHold.orderLimitMinor }
								: {}),
							...(approvalHold.monthlyLimitMinor !== null
								? { monthlyLimitMinor: approvalHold.monthlyLimitMinor }
								: {}),
							monthlySpentMinor: approvalHold.spent,
						}
					: {}),
			}
		}
	}

	return executeOrderSend(caller, {
		row,
		rendered,
		channel: body.channel,
		locale,
		expectedVersion: body.expectedVersion,
		approve: false,
	})
}

/**
 * Approves an order waiting for spending-limit approval and immediately sends
 * it using the requested (or overridden) channel.
 */
export async function approveOrder(
	caller: InventoryCaller,
	input: { id: string; body: ApproveOrderInput },
): Promise<SendOrderResult> {
	assertCanApproveOrders(caller)
	const db = await getTenantDb(caller.orgId)
	const row = await loadOrderRow(db, input.id, caller)
	assertVersion(row.version, input.body.expectedVersion)
	if (row.status !== 'draft' || row.approvalStatus !== 'waiting_approval') {
		throw stateConflict('not_waiting_approval')
	}
	if (isSelfApprovalForbidden(row, caller)) {
		throw new InventoryError('self_approval_forbidden', 403)
	}
	const context = await loadOrderContext(db, [row])
	if ((context.lines.get(row.id) ?? []).length === 0) {
		throw new InventoryError('order_empty', 409)
	}
	const channel = input.body.channel ?? row.requestedSendChannel ?? 'copy'
	const locale =
		input.body.locale ?? (row.requestedSendLocale === 'ar' ? 'ar' : 'en')
	const rendered = await renderFor(db, row, locale, caller.region)
	return executeOrderSend(caller, {
		row,
		rendered,
		channel,
		locale,
		expectedVersion: input.body.expectedVersion,
		approve: true,
	})
}

/**
 * Rejects an order waiting for spending-limit approval and returns it to an
 * editable draft with the required reason.
 */
export async function rejectOrder(
	caller: InventoryCaller,
	input: { id: string; body: RejectOrderInput },
): Promise<OrderDetail> {
	assertCanApproveOrders(caller)
	return withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const row = await loadOrderRow(tx, input.id, caller)
		assertVersion(row.version, input.body.expectedVersion)
		if (row.status !== 'draft' || row.approvalStatus !== 'waiting_approval') {
			throw stateConflict('not_waiting_approval')
		}
		await tx
			.update(invOrders)
			.set({
				approvalStatus: 'rejected',
				rejectedAt: ctx.now,
				rejectedByKind: caller.actor.kind,
				rejectedById: caller.actor.id,
				rejectionReason: input.body.reason,
				approvalAlertStatus: null,
				version: row.version + 1,
				updatedAt: ctx.now,
			})
			.where(eq(invOrders.id, row.id))
		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: 'order.reject',
			resourceType: 'order',
			resourceId: row.id,
			locationId: row.locationId,
			detail: { reason: input.body.reason },
			at: ctx.now,
		})
		return toDetail(
			tx,
			await loadOrderRow(tx, row.id, caller),
			caller.cost,
			ctx.now,
		)
	})
}

// ── Receiving: the prefill ──────────────────────────────────────────────────

export async function getReceivePrefill(
	db: InventoryReader,
	input: { id: string; caller: InventoryCaller },
): Promise<ReceivePrefill> {
	const { caller } = input
	const row = await loadOrderRow(db, input.id, caller)
	if (row.status === 'received' || row.status === 'cancelled') {
		throw new InventoryError('order_closed', 409)
	}
	const context = await loadOrderContext(db, [row])
	const supplier = context.suppliers.get(row.supplierId)!
	const lines = context.lines.get(row.id) ?? []
	const itemIds = [...new Set(lines.map((line) => line.itemId))]
	const productIds = [
		...new Set(
			lines
				.map((line) => line.supplierProductId)
				.filter((id): id is string => !!id),
		),
	]
	const [items, places, products] = await Promise.all([
		queryInChunks(itemIds, (chunk) =>
			db.select().from(invItems).where(inArray(invItems.id, chunk)),
		),
		queryInChunks(itemIds, (chunk) =>
			db
				.select()
				.from(invItemPlaces)
				.where(
					and(
						eq(invItemPlaces.locationId, row.locationId),
						// bounded: its own statement, one chunk of at most 90 ids
						inArray(invItemPlaces.itemId, chunk),
					),
				),
		),
		queryInChunks(productIds, (chunk) =>
			db
				.select()
				.from(invSupplierProducts)
				.where(inArray(invSupplierProducts.id, chunk)),
		),
	])
	const itemById = new Map(items.map((item) => [item.id, item]))
	const placeById = new Map(places.map((place) => [place.itemId, place]))
	const productById = new Map(products.map((product) => [product.id, product]))
	const prefill: ReceivePrefill = {
		orderId: row.id,
		number: row.number,
		locationId: row.locationId,
		supplierId: row.supplierId,
		supplierName: supplier.name,
		status: row.status,
		expectedDate: row.expectedDate,
		lines: lines.map((line) => {
			const item = itemById.get(line.itemId)
			const place = placeById.get(line.itemId)
			const received = context.received.get(line.id) ?? 0
			const outstanding = outstandingQuantity(line.quantity, received)
			const outstandingMilli = Math.round(
				(outstanding * PACK_SCALE) / line.packBaseQuantity,
			)
			const out: ReceivePrefill['lines'][number] = {
				orderLineId: line.id,
				itemId: line.itemId,
				itemName: item?.name ?? '',
				baseUnit: (item?.baseUnit ?? 'piece') as InventoryBaseUnit,
				countUnit: place?.countUnit ? wireUnit(place.countUnit) : null,
				supplierProductId: line.supplierProductId,
				packName: line.packName,
				packBaseQuantity: line.packBaseQuantity,
				pricedByWeight: line.pricedByWeight,
				orderedPacks: milliToPacks(line.packs),
				orderedQuantity: line.quantity,
				receivedQuantity: received,
				outstandingQuantity: outstanding,
				outstandingPacks: milliToPacks(outstandingMilli),
			}
			// Use-by dates (#479): the receiving screen asks for a date on tracked items.
			if (caller.features?.useBy && item) {
				out.trackByDate = item.trackByDate === true
				out.shelfLifeHours = item.shelfLifeHours ?? null
			}
			const price = line.supplierProductId
				? (productById.get(line.supplierProductId)?.priceMinor ?? null)
				: null
			if (caller.cost && price !== null) {
				out.packPriceMinor = price
				out.lineTotalMinor = orderLineTotalMinor({
					packsMilli: outstandingMilli,
					packPriceMinor: price,
				})
			}
			return out
		}),
	}
	if (caller.cost) {
		const currency = row.currency ?? supplier.currency
		if (currency) prefill.currency = currency
	}
	return prefill
}

// ── For Today and the tick ──────────────────────────────────────────────────

/** Open (sent or partly received) orders expected on or before `date` at a location, oldest expected date first. */
export async function listDueOrders(
	db: InventoryReader,
	input: { locationId: string; date: string },
): Promise<Array<{ order: OrderRow; supplierName: string }>> {
	const rows = await db
		.select({ order: invOrders, supplierName: invSuppliers.name })
		.from(invOrders)
		.innerJoin(invSuppliers, eq(invSuppliers.id, invOrders.supplierId))
		.where(
			and(
				eq(invOrders.locationId, input.locationId),
				inArray(invOrders.status, [...SUGGESTION_STATUSES]),
				sql`${invOrders.expectedDate} is not null`,
				sql`${invOrders.expectedDate} <= ${input.date}`,
			),
		)
		.orderBy(invOrders.expectedDate, invOrders.number)
	return rows
}

/** Open (sent or partly received) orders unconfirmed on `expectedDate` (day before delivery, #502). */
export async function listUnconfirmedOrdersForDate(
	db: InventoryReader,
	input: { locationId: string; expectedDate: string },
): Promise<Array<{ order: OrderRow; supplierName: string }>> {
	return db
		.select({ order: invOrders, supplierName: invSuppliers.name })
		.from(invOrders)
		.innerJoin(invSuppliers, eq(invSuppliers.id, invOrders.supplierId))
		.where(
			and(
				eq(invOrders.locationId, input.locationId),
				inArray(invOrders.status, [...SUGGESTION_STATUSES]),
				isNull(invOrders.confirmedAt),
				eq(invOrders.expectedDate, input.expectedDate),
			),
		)
		.orderBy(invOrders.number)
}

/** Toggles manual supplier confirmation on a sent or partly-received order (#502). */
export async function confirmOrder(
	caller: InventoryCaller,
	input: { id: string; expectedVersion: number; confirmed: boolean },
): Promise<OrderDetail> {
	return withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const row = await loadOrderRow(tx, input.id, caller)
		assertVersion(row.version, input.expectedVersion)
		if (row.status === 'received' || row.status === 'cancelled') {
			throw new InventoryError('order_closed', 409)
		}
		if (row.status === 'draft') {
			throw new InventoryError('order_not_editable', 409)
		}
		await tx
			.update(invOrders)
			.set({
				confirmedAt: input.confirmed ? ctx.now : null,
				confirmedByKind: input.confirmed ? caller.actor.kind : null,
				confirmedById: input.confirmed ? caller.actor.id : null,
				version: row.version + 1,
				updatedAt: ctx.now,
			})
			.where(eq(invOrders.id, row.id))
		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: input.confirmed ? 'order.confirm' : 'order.unconfirm',
			resourceType: 'order',
			resourceId: row.id,
			locationId: row.locationId,
			detail: { confirmed: input.confirmed },
			at: ctx.now,
		})
		return toDetail(tx, await loadOrderRow(tx, row.id, caller), caller.cost)
	})
}

/** Updates `expectedDate` on an open sent or partly-received order ("Not yet", #501). */
export async function rescheduleOrder(
	caller: InventoryCaller,
	input: { id: string; expectedVersion: number; expectedDate: string },
): Promise<OrderDetail> {
	return withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const row = await loadOrderRow(tx, input.id, caller)
		assertVersion(row.version, input.expectedVersion)
		if (row.status === 'received' || row.status === 'cancelled') {
			throw new InventoryError('order_closed', 409)
		}
		if (row.status === 'draft') {
			throw new InventoryError('order_not_editable', 409)
		}
		await tx
			.update(invOrders)
			.set({
				expectedDate: input.expectedDate,
				version: row.version + 1,
				updatedAt: ctx.now,
			})
			.where(eq(invOrders.id, row.id))
		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: 'order.reschedule',
			resourceType: 'order',
			resourceId: row.id,
			locationId: row.locationId,
			detail: { expectedDate: input.expectedDate },
			at: ctx.now,
		})
		return toDetail(tx, await loadOrderRow(tx, row.id, caller), caller.cost)
	})
}

/**
 * 1-tap "Yes, as ordered" receive (#501): receives all remaining outstanding
 * quantities on a sent or partly-received order through `recordDelivery`,
 * setting `asOrdered: true` and a 24h `undoUntil` window.
 */
export async function receiveOrderAsOrdered(
	caller: InventoryCaller,
	input: {
		orderId: string
		expectedVersion: number
		clientId: string
		idempotency: InventoryIdempotency
		options?: RecordDeliveryOptions
	},
): Promise<RecordDeliveryResult> {
	return withInventoryWrite(
		{
			orgId: caller.orgId,
			idempotency: input.idempotency,
			onReplay: input.options?.onReplay,
		},
		async (tx, ctx) => {
			const order = await loadOrderRow(tx, input.orderId, caller)
			const earlier = await tx
				.select()
				.from(invDeliveries)
				.where(
					and(
						eq(invDeliveries.locationId, order.locationId),
						eq(invDeliveries.clientId, input.clientId),
					),
				)
				.get()
			if (earlier) {
				input.options?.onReplay?.()
				return replayDeliveryResult(tx, earlier, caller)
			}
			assertVersion(order.version, input.expectedVersion)
			if (order.status === 'received' || order.status === 'cancelled') {
				throw new InventoryError('order_closed', 409)
			}
			if (order.status === 'draft') {
				throw new InventoryError('order_not_editable', 409)
			}
			const orderLines = await tx
				.select()
				.from(invOrderLines)
				.where(eq(invOrderLines.orderId, order.id))
				.orderBy(invOrderLines.sortOrder, invOrderLines.id)
			if (orderLines.length === 0) {
				throw new InventoryError('order_empty', 409)
			}
			const received = await receivedByOrderLine(
				tx,
				orderLines.map((line) => line.id),
			)
			const outstandingLines = orderLines
				.map((line) => ({
					line,
					outstanding: outstandingQuantity(
						line.quantity,
						received.get(line.id) ?? 0,
					),
				}))
				.filter((entry) => entry.outstanding > 0)
			if (outstandingLines.length === 0) {
				throw stateConflict('nothing_outstanding')
			}
			const supplier = await loadSupplierRow(tx, order.supplierId)
			const hasUnpriced = outstandingLines.some(
				(entry) => entry.line.priceMinor === null,
			)
			const currency =
				order.currency ??
				supplier.currency ??
				(await getLocationCurrency(tx, order.locationId))
			const quantityOnly = hasUnpriced || !caller.cost || !currency
			const lines: RecordDelivery['lines'] = outstandingLines.map(
				({ line, outstanding }) => {
					const outstandingMilli = Math.round(
						(outstanding * PACK_SCALE) / line.packBaseQuantity,
					)
					const packs = milliToPacks(outstandingMilli)
					if (quantityOnly) {
						return {
							itemId: line.itemId,
							supplierProductId: line.supplierProductId,
							quantity: outstanding,
							packs: packs > 0 ? packs : null,
							packName: line.packName,
							packBaseQuantity: line.packBaseQuantity,
							orderLineId: line.id,
							orderedQuantity: line.quantity,
						}
					}
					const lineTotalMinor = orderLineTotalMinor({
						packsMilli: outstandingMilli,
						packPriceMinor: line.priceMinor!,
					})
					return {
						itemId: line.itemId,
						supplierProductId: line.supplierProductId,
						quantity: outstanding,
						packs: packs > 0 ? packs : null,
						packName: line.packName,
						packBaseQuantity: line.packBaseQuantity,
						packPriceMinor: line.priceMinor!,
						lineTotalMinor,
						orderLineId: line.id,
						orderedQuantity: line.quantity,
					}
				},
			)
			const body: RecordDelivery = {
				clientId: input.clientId,
				locationId: order.locationId,
				supplierId: order.supplierId,
				orderId: order.id,
				paid: false,
				...(quantityOnly
					? { quantityOnly: true }
					: { currency: currency!, quantityOnly: false }),
				lines,
			}
			return recordDelivery(caller, {
				body,
				idempotency: null,
				options: {
					...input.options,
					asOrdered: true,
					undoUntil: ctx.now + 24 * 60 * 60 * 1000,
				},
			})
		},
	)
}

/** Open orders at a location, by supplier and expected date (the Today week strip). */
export async function listOpenOrdersForWeek(
	db: InventoryReader,
	locationId: string,
): Promise<OrderRow[]> {
	return db
		.select()
		.from(invOrders)
		.where(
			and(
				eq(invOrders.locationId, locationId),
				inArray(invOrders.status, [...SUGGESTION_STATUSES]),
				sql`${invOrders.expectedDate} is not null`,
			),
		)
		.orderBy(invOrders.expectedDate, invOrders.number)
}

export function orderIsOpen(status: OrderStatus): boolean {
	return (OPEN_ORDER_STATUSES as readonly string[]).includes(status)
}
