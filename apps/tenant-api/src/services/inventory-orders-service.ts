import {
	costMicroFromPackPrice,
	INVENTORY_LIMITS,
	MAX_ENTRY_QUANTITY,
	milliToPacks,
	needsOrder,
	nextOrderableDelivery,
	OPEN_ORDER_STATUSES,
	orderCutoffFor,
	orderLineComplete,
	orderLineTotalMinor,
	orderTotalMinor,
	outstandingQuantity,
	PACK_SCALE,
	packsQuantity,
	packsToMilli,
	PRICED_BY_WEIGHT_PACK_STEP_MILLI,
	shortOfMinimumMinor,
	suggestOrderQuantity,
	type InventoryBaseUnit,
	type OrderDetail,
	type OrderLine,
	type OrderStatus,
	type OrderSummary,
	type OrderText,
	type OrderTextLocale,
	type ReceivePrefill,
	type SendOrderResult,
	type SuggestedOrderLine,
	type SuggestedOrders,
	type SuggestedSupplierOrder,
	type SupplierSchedule,
} from '@repo/inventory'
import {
	getTenantDb,
	invDeliveries,
	invDeliveryLines,
	invItemPlaces,
	invItems,
	invOrderLines,
	invOrders,
	invSettings,
	invSupplierProducts,
	invSuppliers,
} from '@repo/tenant-db'
import { and, count, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { queryInChunks, insertRowsInChunks } from '../lib/chunked-in.ts'
import { InventoryError } from '../lib/inventory-http.ts'
import {
	type InventoryIdempotency,
	type InventoryReader,
	type InventoryTx,
	withInventoryWrite,
} from '../lib/inventory-write.ts'
import { canSendTenantEmail, sendTenantEmail } from '../lib/tenant-email.ts'
import { recordInventoryAudit } from './inventory-audit.ts'
import {
	assertLocationAllowed,
	assertVersion,
	badRequest,
	decodeCursor,
	encodeCursor,
	locationClock,
	newId,
	notFound,
	onHandByItem,
	wireUnit,
} from './inventory-common.ts'
import {
	type CreateOrderInput,
	type ListOrdersQuery,
	type SendOrderInput,
	type UpdateOrderInput,
} from './inventory-contract-types.ts'
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
		status: row.status,
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

async function toDetail(
	db: InventoryReader,
	row: OrderRow,
	cost: boolean,
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
			return out
		}),
		deliveries,
		supplierOrderChannel: supplier.orderChannel,
		supplierEmail: supplier.email,
		supplierPhone: supplier.phone,
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
	const statuses: readonly OrderStatus[] | null =
		query.status === 'all'
			? null
			: query.status === 'open'
				? OPEN_ORDER_STATUSES
				: query.status === 'closed'
					? ['received', 'cancelled']
					: [query.status]
	const rows = await db
		.select()
		.from(invOrders)
		.where(
			and(
				eq(invOrders.locationId, query.locationId),
				// bounded: at most five order statuses
				statuses ? inArray(invOrders.status, [...statuses]) : undefined,
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
		: costMicroFromPackPrice(product.priceMinor, product.packBaseQuantity)
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

/** Still to arrive on sent and partly received orders at a location, by item. */
export async function onOrderByItem(
	db: InventoryReader,
	locationId: string,
): Promise<Map<string, number>> {
	const lines = await db
		.select({ line: invOrderLines })
		.from(invOrderLines)
		.innerJoin(invOrders, eq(invOrders.id, invOrderLines.orderId))
		.where(
			and(
				eq(invOrders.locationId, locationId),
				inArray(invOrders.status, [...SUGGESTION_STATUSES]),
			),
		)
	const received = await receivedByOrderLine(
		db,
		lines.map((entry) => entry.line.id),
	)
	const map = new Map<string, number>()
	for (const { line } of lines) {
		const outstanding = outstandingQuantity(
			line.quantity,
			received.get(line.id) ?? 0,
		)
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
			and(eq(invOrders.locationId, locationId), eq(invOrders.status, 'draft')),
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
	input: { locationId: string; cost: boolean; now: number },
): Promise<SuggestedOrders> {
	const { locationId, cost } = input
	const [stock, choices, onOrder, drafts, clock] = await Promise.all([
		loadLocationStock(db, locationId),
		loadProductChoices(db),
		onOrderByItem(db, locationId),
		draftBySupplier(db, locationId),
		locationClock(db, locationId, input.now),
	])
	const cards = new Map<string, SuggestedSupplierOrder>()
	const supplierById = new Map<string, SupplierRow>()
	const unsourced: SuggestedOrders['unsourced'] = []
	for (const row of stock) {
		const place = row.place
		if (!place) continue
		const orderBelow = place.orderBelowQuantity
		const fillUpTo = place.fillUpToQuantity
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
		const countUnit = place.countUnit ? wireUnit(place.countUnit) : null
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
		}
		if (cost && product.priceMinor !== null) {
			line.packPriceMinor = product.priceMinor
			line.lineTotalMinor = orderLineTotalMinor({
				packsMilli: suggestion.packsMilli,
				packPriceMinor: product.priceMinor,
			})
		}
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
		card.lines.push(line)
		card.lineCount += 1
	}
	const suppliers = [...cards.values()]
	for (const card of suppliers) {
		if (!cost) continue
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
	}
}

// ── Create and edit ─────────────────────────────────────────────────────────

type ResolvedLine = {
	itemId: string
	product: ProductRow
	packsMilli: number
	suggestedPacksMilli: number | null
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
			}> = body.lines ?? []
			if (body.fromSuggestion) {
				const suggestion = await buildSuggestedOrders(tx, {
					locationId: body.locationId,
					cost: false,
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
			return toDetail(tx, await loadOrderRow(tx, id, caller), caller.cost)
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
			const suggested = new Map(
				old.map((line) => [
					`${line.itemId}:${line.supplierProductId}`,
					line.suggestedPacks,
				]),
			)
			const resolved = await resolveLines(
				tx,
				row.supplierId,
				body.lines.map((line) => ({
					...line,
					suggestedPacksMilli:
						suggested.get(`${line.itemId}:${line.supplierProductId}`) ?? null,
				})),
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
		return toDetail(tx, await loadOrderRow(tx, row.id, caller), caller.cost)
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

/**
 * Sends an order. The text is rendered first; an email is delivered before
 * the order is marked sent, so a provider failure (502 `email_failed`) leaves
 * the order as it was. `whatsapp`, `copy` and `pdf` are person-driven: the
 * order is marked sent and the answer carries what the App needs.
 */
export async function sendOrder(
	caller: InventoryCaller,
	input: { id: string; body: SendOrderInput },
): Promise<SendOrderResult> {
	const { body } = input
	const locale = body.locale ?? 'en'
	const db = await getTenantDb(caller.orgId)
	const row = await loadOrderRow(db, input.id, caller)
	assertVersion(row.version, body.expectedVersion)
	if (row.status === 'received' || row.status === 'cancelled') {
		throw new InventoryError('order_closed', 409)
	}
	const context = await loadOrderContext(db, [row])
	if ((context.lines.get(row.id) ?? []).length === 0) {
		throw new InventoryError('order_empty', 409)
	}
	const rendered = await renderFor(db, row, locale, caller.region)
	const { supplier } = rendered

	let emailSent = false
	let emailSkipped: SendOrderResult['emailSkipped'] = null
	if (body.channel === 'email') {
		if (!supplier.email) emailSkipped = 'no_supplier_email'
		else if (!canSendTenantEmail()) emailSkipped = 'not_configured'
		else {
			const result = await sendTenantEmail({
				to: supplier.email,
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
				console.error('Inventory order email failed', {
					orgId: caller.orgId,
					orderId: row.id,
					statusCode: result.error.statusCode ?? null,
				})
				throw new InventoryError('email_failed', 502)
			}
			emailSent = true
		}
	}

	const order = await withInventoryWrite(
		{ orgId: caller.orgId },
		async (tx, ctx) => {
			const current = await loadOrderRow(tx, row.id, caller)
			assertVersion(current.version, body.expectedVersion)
			if (current.status === 'received' || current.status === 'cancelled') {
				throw new InventoryError('order_closed', 409)
			}
			if (current.status === 'draft') {
				await tx
					.update(invOrders)
					.set({
						status: 'sent',
						sentAt: ctx.now,
						sentVia: body.channel,
						version: current.version + 1,
						updatedAt: ctx.now,
					})
					.where(eq(invOrders.id, current.id))
			}
			await recordInventoryAudit(tx, {
				actorKind: caller.actor.kind,
				actorId: caller.actor.id,
				action: current.status === 'draft' ? 'order.send' : 'order.resend',
				resourceType: 'order',
				resourceId: current.id,
				locationId: current.locationId,
				detail: { channel: body.channel, emailSent, locale },
				at: ctx.now,
			})
			return toDetail(
				tx,
				await loadOrderRow(tx, current.id, caller),
				caller.cost,
			)
		},
	)
	return {
		...rendered.text,
		waLink: body.channel === 'whatsapp' ? rendered.text.waLink : null,
		mailto:
			body.channel === 'email' && !emailSent ? rendered.text.mailto : null,
		order,
		channel: body.channel,
		emailSent,
		emailSkipped,
	}
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
