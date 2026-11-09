import {
	costMicroFromPackPriceClamped,
	INVENTORY_LIMITS,
	orderStatusAfterReceipt,
	priceChangeBp,
	weightedAverageCostMicro,
	type DeliveryDetail,
	type DeliverySummary,
	type OrderSummary,
	type RecordDeliveryResult,
	type Supplier,
	type SupplierProduct,
} from '@repo/inventory'
import {
	invCostEvents,
	invDeliveries,
	invDeliveryLines,
	invItemCosts,
	invItems,
	invMovements,
	invOrderLines,
	invOrders,
	invSupplierProducts,
	invSuppliers,
} from '@repo/tenant-db'
import { and, count, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm'
import { inJsonList, queryInChunks } from '../lib/chunked-in.ts'
import { InventoryError } from '../lib/inventory-http.ts'
import {
	type InventoryIdempotency,
	type InventoryReader,
	type InventoryTx,
	withInventoryWrite,
} from '../lib/inventory-write.ts'
import { recordInventoryAudit } from './inventory-audit.ts'
import {
	assertLocationAllowed,
	assertVersion,
	badRequest,
	costMicroForWrite,
	decodeCursor,
	encodeCursor,
	locationBusinessDate,
	type LocationScope,
	newId,
	notFound,
	onHandTotal,
	stateConflict,
} from './inventory-common.ts'
import {
	type ConfirmDeliveryPricesInput,
	type CreateSupplierInput,
	type ListDeliveriesQuery,
	type RecordDeliveryInput,
	type SupplierProductInput,
	type UpdateSupplierInput,
	type UpdateSupplierProductInput,
} from './inventory-contract-types.ts'
import { type InventoryCaller } from './inventory-items-service.ts'
import {
	assertLocationCurrency,
	getLocationCurrency,
	requireLocationCurrency,
} from './inventory-location-settings.ts'
import {
	orderSummaries,
	receivedByOrderLine,
} from './inventory-orders-service.ts'
import { presignObjectRead } from '../lib/recording-storage.ts'

type SupplierRow = typeof invSuppliers.$inferSelect
type ProductRow = typeof invSupplierProducts.$inferSelect
type DeliveryRow = typeof invDeliveries.$inferSelect

// ── Suppliers ───────────────────────────────────────────────────────────────

/** Deliveries the token may see, as a filter on `location_id`. */
function deliveryScope(scope: LocationScope) {
	return scope === null
		? undefined
		: inJsonList(invDeliveries.locationId, scope)
}

type DeliveryMoney = { linesTotal: number; lineCount: number }

async function lineTotals(
	db: InventoryReader,
	deliveryIds: readonly string[],
): Promise<Map<string, DeliveryMoney>> {
	const rows = await queryInChunks(deliveryIds, (chunk) =>
		db
			.select({
				deliveryId: invDeliveryLines.deliveryId,
				total: sql<number>`coalesce(sum(${invDeliveryLines.lineTotalMinor}), 0)`,
				n: count(),
			})
			.from(invDeliveryLines)
			.where(inArray(invDeliveryLines.deliveryId, chunk))
			.groupBy(invDeliveryLines.deliveryId),
	)
	return new Map(
		rows.map((row) => [
			row.deliveryId,
			{ linesTotal: Number(row.total), lineCount: Number(row.n) },
		]),
	)
}

/** What a delivery's invoice comes to: the printed total, else lines plus VAT. */
function invoiceAmount(row: DeliveryRow, money: DeliveryMoney | undefined) {
	return row.totalMinor ?? (money?.linesTotal ?? 0) + (row.vatMinor ?? 0)
}

type SupplierStats = {
	products: Map<string, number>
	unpaidCount: Map<string, number>
	unpaidMinor: Map<string, number>
	unpaidTotal: number
	currency: string | undefined
}

async function supplierStats(
	db: InventoryReader,
	scope: LocationScope,
): Promise<SupplierStats> {
	const [products, unpaid] = await Promise.all([
		db
			.select({ supplierId: invSupplierProducts.supplierId, n: count() })
			.from(invSupplierProducts)
			.where(isNull(invSupplierProducts.archivedAt))
			.groupBy(invSupplierProducts.supplierId),
		db
			.select()
			.from(invDeliveries)
			.where(
				and(
					eq(invDeliveries.status, 'received'),
					isNull(invDeliveries.paidAt),
					sql`${invDeliveries.supplierId} is not null`,
					deliveryScope(scope),
				),
			),
	])
	const totals = await lineTotals(
		db,
		unpaid.map((row) => row.id),
	)
	const stats: SupplierStats = {
		products: new Map(products.map((row) => [row.supplierId, Number(row.n)])),
		unpaidCount: new Map(),
		unpaidMinor: new Map(),
		unpaidTotal: 0,
		currency: undefined,
	}
	for (const row of unpaid) {
		const supplierId = row.supplierId!
		const amount = invoiceAmount(row, totals.get(row.id))
		stats.unpaidCount.set(
			supplierId,
			(stats.unpaidCount.get(supplierId) ?? 0) + 1,
		)
		stats.unpaidMinor.set(
			supplierId,
			(stats.unpaidMinor.get(supplierId) ?? 0) + amount,
		)
		stats.unpaidTotal += amount
		stats.currency ??= row.currency
	}
	return stats
}

function toSupplier(
	row: SupplierRow,
	stats: SupplierStats,
	cost: boolean,
): Supplier {
	const supplier: Supplier = {
		id: row.id,
		name: row.name,
		contactName: row.contactName,
		phone: row.phone,
		email: row.email,
		orderChannel: row.orderChannel,
		deliveryDays: row.deliveryDays,
		cutoffTime: row.cutoffTime,
		cutoffDaysBefore: row.cutoffTime ? row.cutoffDaysBefore : null,
		currency: row.currency ?? '',
		paymentTerms: row.paymentTerms,
		vatNumber: row.vatNumber,
		notes: row.notes,
		archived: row.archivedAt !== null,
		version: row.version,
		productCount: stats.products.get(row.id) ?? 0,
		unpaidCount: stats.unpaidCount.get(row.id) ?? 0,
	}
	if (cost) {
		supplier.minimumOrderMinor = row.minimumOrderMinor
		supplier.unpaidMinor = stats.unpaidMinor.get(row.id) ?? 0
	}
	return supplier
}

export async function listSuppliers(
	db: InventoryReader,
	input: {
		includeArchived: boolean
		caller: Pick<InventoryCaller, 'cost' | 'locationIds'>
	},
) {
	const [rows, stats] = await Promise.all([
		input.includeArchived
			? db.select().from(invSuppliers)
			: db.select().from(invSuppliers).where(isNull(invSuppliers.archivedAt)),
		supplierStats(db, input.caller.locationIds),
	])
	rows.sort(
		(a, b) =>
			a.name.toLowerCase().localeCompare(b.name.toLowerCase()) ||
			(a.id < b.id ? -1 : 1),
	)
	const result: {
		suppliers: Supplier[]
		unpaidMinor?: number
		currency?: string
	} = {
		suppliers: rows.map((row) => toSupplier(row, stats, input.caller.cost)),
	}
	if (input.caller.cost) {
		result.unpaidMinor = stats.unpaidTotal
		if (stats.currency) result.currency = stats.currency
	}
	return result
}

async function loadSupplier(
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

function toProduct(
	row: ProductRow,
	itemName: string,
	cost: boolean,
): SupplierProduct {
	const product: SupplierProduct = {
		id: row.id,
		supplierId: row.supplierId,
		itemId: row.itemId,
		itemName,
		packName: row.packName,
		packBaseQuantity: row.packBaseQuantity,
		pricedByWeight: row.pricedByWeight,
		sku: row.sku,
		preferred: row.preferred,
		version: row.version,
	}
	if (cost && row.priceMinor !== null) {
		product.priceMinor = row.priceMinor
		if (row.currency) product.currency = row.currency
	}
	return product
}

export async function getSupplier(
	db: InventoryReader,
	input: { id: string; caller: Pick<InventoryCaller, 'cost' | 'locationIds'> },
) {
	const row = await loadSupplier(db, input.id, { archived: true })
	const [stats, products] = await Promise.all([
		supplierStats(db, input.caller.locationIds),
		db
			.select({ product: invSupplierProducts, itemName: invItems.name })
			.from(invSupplierProducts)
			.innerJoin(invItems, eq(invItems.id, invSupplierProducts.itemId))
			.where(
				and(
					eq(invSupplierProducts.supplierId, row.id),
					isNull(invSupplierProducts.archivedAt),
				),
			)
			.orderBy(invItems.name, invSupplierProducts.id),
	])
	return {
		...toSupplier(row, stats, input.caller.cost),
		products: products.map((entry) =>
			toProduct(entry.product, entry.itemName, input.caller.cost),
		),
	}
}

async function supplierResult(
	db: InventoryReader,
	row: SupplierRow,
	caller: Pick<InventoryCaller, 'cost' | 'locationIds'>,
): Promise<Supplier> {
	return toSupplier(
		row,
		await supplierStats(db, caller.locationIds),
		caller.cost,
	)
}

function supplierValues(body: CreateSupplierInput | UpdateSupplierInput) {
	const values: Partial<typeof invSuppliers.$inferInsert> = {}
	if (body.name !== undefined) values.name = body.name
	if (body.contactName !== undefined)
		values.contactName = body.contactName || null
	if (body.phone !== undefined) values.phone = body.phone || null
	if (body.email !== undefined) values.email = body.email || null
	if (body.orderChannel !== undefined) values.orderChannel = body.orderChannel
	if (body.deliveryDays !== undefined) {
		values.deliveryDays = [...new Set(body.deliveryDays)].sort((a, b) => a - b)
	}
	if (body.cutoffTime !== undefined) values.cutoffTime = body.cutoffTime
	if (body.cutoffDaysBefore !== undefined) {
		values.cutoffDaysBefore = body.cutoffDaysBefore ?? 1
	}
	if (body.minimumOrderMinor !== undefined) {
		values.minimumOrderMinor = body.minimumOrderMinor
	}
	if (body.currency !== undefined) values.currency = body.currency
	if (body.paymentTerms !== undefined)
		values.paymentTerms = body.paymentTerms || null
	if (body.vatNumber !== undefined) values.vatNumber = body.vatNumber || null
	if (body.notes !== undefined) values.notes = body.notes || null
	return values
}

export async function createSupplier(
	caller: InventoryCaller,
	input: { body: CreateSupplierInput; idempotency: InventoryIdempotency },
): Promise<Supplier> {
	return withInventoryWrite(
		{ orgId: caller.orgId, idempotency: input.idempotency },
		async (tx, ctx) => {
			const existing = await tx
				.select({ n: count() })
				.from(invSuppliers)
				.where(isNull(invSuppliers.archivedAt))
				.get()
			if (Number(existing?.n ?? 0) >= INVENTORY_LIMITS.suppliers) {
				throw new InventoryError('limit_reached', 409)
			}
			const id = newId()
			await tx.insert(invSuppliers).values({
				...supplierValues(input.body),
				id,
				name: input.body.name,
				createdAt: ctx.now,
				updatedAt: ctx.now,
			})
			await recordInventoryAudit(tx, {
				actorKind: caller.actor.kind,
				actorId: caller.actor.id,
				action: 'supplier.create',
				resourceType: 'supplier',
				resourceId: id,
				at: ctx.now,
			})
			return supplierResult(tx, await loadSupplier(tx, id), caller)
		},
	)
}

export async function updateSupplier(
	caller: InventoryCaller,
	input: { id: string; body: UpdateSupplierInput },
): Promise<Supplier> {
	return withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const row = await loadSupplier(tx, input.id)
		assertVersion(row.version, input.body.expectedVersion)
		const values = supplierValues(input.body)
		const merged = { ...row, ...values }
		if (merged.minimumOrderMinor !== null && !merged.currency) {
			throw badRequest('currency')
		}
		await tx
			.update(invSuppliers)
			.set({ ...values, version: row.version + 1, updatedAt: ctx.now })
			.where(eq(invSuppliers.id, row.id))
		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: 'supplier.update',
			resourceType: 'supplier',
			resourceId: row.id,
			detail: { fields: Object.keys(values).join(',') },
			at: ctx.now,
		})
		return supplierResult(tx, await loadSupplier(tx, row.id), caller)
	})
}

export async function archiveSupplier(
	caller: InventoryCaller,
	input: { id: string; expectedVersion: number },
): Promise<Supplier> {
	return withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const row = await loadSupplier(tx, input.id)
		assertVersion(row.version, input.expectedVersion)
		await tx
			.update(invSuppliers)
			.set({
				archivedAt: ctx.now,
				version: row.version + 1,
				updatedAt: ctx.now,
			})
			.where(eq(invSuppliers.id, row.id))
		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: 'supplier.archive',
			resourceType: 'supplier',
			resourceId: row.id,
			at: ctx.now,
		})
		return supplierResult(
			tx,
			await loadSupplier(tx, row.id, { archived: true }),
			caller,
		)
	})
}

// ── Supplier products ───────────────────────────────────────────────────────

/** An item has at most one preferred way to buy it. */
async function clearPreferred(
	tx: InventoryTx,
	itemId: string,
	exceptId: string,
	now: number,
) {
	const others = await tx
		.select({
			id: invSupplierProducts.id,
			version: invSupplierProducts.version,
		})
		.from(invSupplierProducts)
		.where(
			and(
				eq(invSupplierProducts.itemId, itemId),
				eq(invSupplierProducts.preferred, true),
				isNull(invSupplierProducts.archivedAt),
				ne(invSupplierProducts.id, exceptId),
			),
		)
	for (const other of others) {
		await tx
			.update(invSupplierProducts)
			.set({ preferred: false, version: other.version + 1, updatedAt: now })
			.where(eq(invSupplierProducts.id, other.id))
	}
}

async function productResult(
	db: InventoryReader,
	id: string,
	cost: boolean,
): Promise<SupplierProduct> {
	const row = await db
		.select({ product: invSupplierProducts, itemName: invItems.name })
		.from(invSupplierProducts)
		.innerJoin(invItems, eq(invItems.id, invSupplierProducts.itemId))
		.where(eq(invSupplierProducts.id, id))
		.get()
	if (!row) throw notFound()
	return toProduct(row.product, row.itemName, cost)
}

export async function createSupplierProduct(
	caller: InventoryCaller,
	input: { supplierId: string; body: SupplierProductInput },
): Promise<SupplierProduct> {
	return withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const supplier = await loadSupplier(tx, input.supplierId)
		const item = await tx
			.select()
			.from(invItems)
			.where(eq(invItems.id, input.body.itemId))
			.get()
		if (!item || item.archivedAt !== null) throw notFound()
		const id = newId()
		await tx.insert(invSupplierProducts).values({
			id,
			supplierId: supplier.id,
			itemId: item.id,
			packName: input.body.packName,
			packBaseQuantity: input.body.packBaseQuantity,
			priceMinor: input.body.priceMinor,
			currency: supplierCurrencyOrRefuse(supplier),
			pricedByWeight: input.body.pricedByWeight,
			sku: input.body.sku || null,
			preferred: false,
			createdAt: ctx.now,
			updatedAt: ctx.now,
		})
		if (input.body.preferred) {
			await clearPreferred(tx, item.id, id, ctx.now)
			await tx
				.update(invSupplierProducts)
				.set({ preferred: true })
				.where(eq(invSupplierProducts.id, id))
		}
		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: 'supplier_product.create',
			resourceType: 'supplier_product',
			resourceId: id,
			detail: { supplierId: supplier.id, itemId: item.id },
			at: ctx.now,
		})
		return productResult(tx, id, caller.cost)
	})
}

/** A supplier's price needs its currency; one is never guessed. */
function supplierCurrencyOrRefuse(supplier: {
	currency: string | null
}): string {
	if (!supplier.currency) throw badRequest('supplier_currency_required')
	return supplier.currency
}

async function loadProduct(
	db: InventoryReader,
	id: string,
): Promise<ProductRow> {
	const row = await db
		.select()
		.from(invSupplierProducts)
		.where(eq(invSupplierProducts.id, id))
		.get()
	if (!row || row.archivedAt !== null) throw notFound()
	return row
}

export async function updateSupplierProduct(
	caller: InventoryCaller,
	input: { id: string; body: UpdateSupplierProductInput },
): Promise<SupplierProduct> {
	return withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const row = await loadProduct(tx, input.id)
		assertVersion(row.version, input.body.expectedVersion)
		const { body } = input
		const set: Partial<typeof invSupplierProducts.$inferInsert> = {
			version: row.version + 1,
			updatedAt: ctx.now,
		}
		if (body.packName !== undefined) set.packName = body.packName
		if (body.packBaseQuantity !== undefined) {
			set.packBaseQuantity = body.packBaseQuantity
		}
		if (body.priceMinor !== undefined) {
			set.priceMinor = body.priceMinor
			if (!row.currency) {
				const supplier = await loadSupplier(tx, row.supplierId, {
					archived: true,
				})
				set.currency = supplierCurrencyOrRefuse(supplier)
			}
		}
		if (body.pricedByWeight !== undefined)
			set.pricedByWeight = body.pricedByWeight
		if (body.sku !== undefined) set.sku = body.sku || null
		if (body.preferred !== undefined) {
			if (body.preferred) await clearPreferred(tx, row.itemId, row.id, ctx.now)
			set.preferred = body.preferred
		}
		await tx
			.update(invSupplierProducts)
			.set(set)
			.where(eq(invSupplierProducts.id, row.id))
		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: 'supplier_product.update',
			resourceType: 'supplier_product',
			resourceId: row.id,
			at: ctx.now,
		})
		return productResult(tx, row.id, caller.cost)
	})
}

export async function archiveSupplierProduct(
	caller: InventoryCaller,
	input: { id: string; expectedVersion: number },
): Promise<SupplierProduct> {
	return withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const row = await loadProduct(tx, input.id)
		assertVersion(row.version, input.expectedVersion)
		await tx
			.update(invSupplierProducts)
			.set({
				archivedAt: ctx.now,
				preferred: false,
				version: row.version + 1,
				updatedAt: ctx.now,
			})
			.where(eq(invSupplierProducts.id, row.id))
		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: 'supplier_product.archive',
			resourceType: 'supplier_product',
			resourceId: row.id,
			at: ctx.now,
		})
		return productResult(tx, row.id, caller.cost)
	})
}

// ── Deliveries ──────────────────────────────────────────────────────────────

type OrderRow = typeof invOrders.$inferSelect

async function toSummaries(
	db: InventoryReader,
	rows: readonly DeliveryRow[],
	cost: boolean,
): Promise<DeliverySummary[]> {
	const supplierIds = [
		...new Set(
			rows.map((row) => row.supplierId).filter((id): id is string => !!id),
		),
	]
	const orderIds = [
		...new Set(
			rows.map((row) => row.orderId).filter((id): id is string => !!id),
		),
	]
	const [suppliers, totals, orders] = await Promise.all([
		queryInChunks(supplierIds, (chunk) =>
			db
				.select({ id: invSuppliers.id, name: invSuppliers.name })
				.from(invSuppliers)
				.where(inArray(invSuppliers.id, chunk)),
		),
		lineTotals(
			db,
			rows.map((row) => row.id),
		),
		queryInChunks(orderIds, (chunk) =>
			db
				.select({ id: invOrders.id, number: invOrders.number })
				.from(invOrders)
				// bounded: its own statement, one chunk of at most 90 ids
				.where(inArray(invOrders.id, chunk)),
		),
	])
	const names = new Map(suppliers.map((row) => [row.id, row.name]))
	const numbers = new Map(orders.map((row) => [row.id, row.number]))
	return rows.map((row) => {
		const money = totals.get(row.id)
		const summary: DeliverySummary = {
			id: row.id,
			locationId: row.locationId,
			supplierId: row.supplierId,
			supplierName: row.supplierId ? (names.get(row.supplierId) ?? null) : null,
			status: row.status,
			invoiceNumber: row.invoiceNumber,
			invoiceDate: row.invoiceDate,
			businessDate: row.businessDate,
			source: row.source,
			receivedAt: row.receivedAt,
			receivedBy: { kind: row.receivedByKind, id: row.receivedById },
			lineCount: money?.lineCount ?? 0,
			paid: row.paidAt !== null,
			paidAt: row.paidAt,
			version: row.version,
			pricesPending: row.quantityOnly && row.pricesConfirmedAt === null,
			orderId: row.orderId,
			orderNumber: row.orderId ? (numbers.get(row.orderId) ?? null) : null,
			hasPhoto: row.photoKey !== null,
			lateSync: row.lateSync,
		}
		if (cost) {
			summary.linesTotalMinor = money?.linesTotal ?? 0
			if (row.vatMinor !== null) summary.vatMinor = row.vatMinor
			if (row.totalMinor !== null) summary.totalMinor = row.totalMinor
			summary.currency = row.currency
		}
		return summary
	})
}

export async function listDeliveries(
	db: InventoryReader,
	input: { query: ListDeliveriesQuery; cost: boolean },
) {
	const { query } = input
	const cursor = decodeCursor(query.cursor)
	const rows = await db
		.select()
		.from(invDeliveries)
		.where(
			and(
				eq(invDeliveries.locationId, query.locationId),
				query.supplierId
					? eq(invDeliveries.supplierId, query.supplierId)
					: undefined,
				query.unpaid
					? and(
							eq(invDeliveries.status, 'received'),
							isNull(invDeliveries.paidAt),
						)
					: undefined,
				cursor
					? or(
							sql`${invDeliveries.createdAt} < ${cursor.sort}`,
							and(
								eq(invDeliveries.createdAt, cursor.sort),
								sql`${invDeliveries.id} < ${cursor.id}`,
							),
						)
					: undefined,
			),
		)
		.orderBy(desc(invDeliveries.createdAt), desc(invDeliveries.id))
		.limit(query.limit + 1)
	const page = rows.slice(0, query.limit)
	const last = page.at(-1)
	return {
		deliveries: await toSummaries(db, page, input.cost),
		nextCursor:
			rows.length > query.limit && last
				? encodeCursor(last.createdAt, last.id)
				: null,
	}
}

type LineRow = typeof invDeliveryLines.$inferSelect

/**
 * Cost per base unit of each item's latest earlier PRICED delivered line
 * (other deliveries). A quantity-only line waiting for its price has no cost.
 */
async function previousCosts(
	db: InventoryReader,
	delivery: DeliveryRow,
	itemIds: readonly string[],
): Promise<Map<string, number>> {
	const rows = await queryInChunks(itemIds, (chunk) =>
		db
			.select({
				itemId: invDeliveryLines.itemId,
				quantity: invDeliveryLines.quantity,
				total: invDeliveryLines.lineTotalMinor,
			})
			.from(invDeliveryLines)
			.innerJoin(
				invDeliveries,
				eq(invDeliveries.id, invDeliveryLines.deliveryId),
			)
			.where(
				and(
					inArray(invDeliveryLines.itemId, chunk),
					eq(invDeliveries.status, 'received'),
					ne(invDeliveries.id, delivery.id),
					sql`${invDeliveryLines.pricedAt} is not null`,
					sql`${invDeliveryLines.createdAt} <= ${delivery.createdAt}`,
				),
			)
			.orderBy(invDeliveryLines.createdAt, invDeliveryLines.id),
	)
	const map = new Map<string, number>()
	for (const row of rows) {
		if (row.quantity > 0) {
			map.set(
				row.itemId,
				costMicroFromPackPriceClamped(row.total, row.quantity),
			)
		}
	}
	return map
}

export async function getDelivery(
	db: InventoryReader,
	input: {
		id: string
		caller: Pick<InventoryCaller, 'cost' | 'locationIds'>
	},
): Promise<DeliveryDetail> {
	const row = await db
		.select()
		.from(invDeliveries)
		.where(eq(invDeliveries.id, input.id))
		.get()
	if (!row) throw notFound()
	assertLocationAllowed(input.caller.locationIds, row.locationId)
	return deliveryDetail(db, row, input.caller.cost, { photo: true })
}

/**
 * A delivery with its lines. `photo` adds the five-minute read link to the
 * invoice photo (`GET /deliveries/:id` and the photo confirm answer only).
 */
export async function deliveryDetail(
	db: InventoryReader,
	row: DeliveryRow,
	cost: boolean,
	options: { photo?: boolean } = {},
): Promise<DeliveryDetail> {
	const lines = await db
		.select({ line: invDeliveryLines, itemName: invItems.name })
		.from(invDeliveryLines)
		.innerJoin(invItems, eq(invItems.id, invDeliveryLines.itemId))
		.where(eq(invDeliveryLines.deliveryId, row.id))
		.orderBy(invDeliveryLines.createdAt, invDeliveryLines.id)
	const previous = cost
		? await previousCosts(db, row, [
				...new Set(lines.map((entry) => entry.line.itemId)),
			])
		: new Map<string, number>()
	const orderLineIds = lines
		.map((entry) => entry.line.orderLineId)
		.filter((id): id is string => !!id)
	const orderedById = new Map(
		(
			await queryInChunks(orderLineIds, (chunk) =>
				db
					.select({ id: invOrderLines.id, quantity: invOrderLines.quantity })
					.from(invOrderLines)
					.where(inArray(invOrderLines.id, chunk)),
			)
		).map((line) => [line.id, line.quantity]),
	)
	const [summary] = await toSummaries(db, [row], cost)
	const detail: DeliveryDetail = {
		...summary!,
		zatcaReference: row.zatcaReference,
		lines: lines.map(({ line, itemName }) => {
			const priced = line.pricedAt !== null
			const out: DeliveryDetail['lines'][number] = {
				id: line.id,
				itemId: line.itemId,
				itemName,
				quantity: line.quantity,
				packs: line.packs === null ? null : line.packs / 1000,
				packName: line.packName,
				realWeightQuantity: line.realWeightQuantity,
				priced,
			}
			if (line.orderLineId) {
				out.orderLineId = line.orderLineId
				out.orderedQuantity = orderedById.get(line.orderLineId) ?? null
			}
			// A line still waiting for its price has no money (never a zero).
			if (cost && priced) {
				out.lineTotalMinor = line.lineTotalMinor
				if (line.priceMinor !== null) out.packPriceMinor = line.priceMinor
				out.priceChangeBp =
					line.quantity > 0
						? priceChangeBp(
								previous.get(line.itemId) ?? null,
								costMicroFromPackPriceClamped(
									line.lineTotalMinor,
									line.quantity,
								),
							)
						: null
			}
			return out
		}),
	}
	// The scanned invoice shows every price, so its read link follows the same
	// rule as money: only a token with the cost grant gets it (`hasPhoto` stays
	// on the summary for everyone).
	if (options.photo && cost) {
		const link =
			row.photoKey && row.photoContentType
				? presignObjectRead(row.photoKey, {
						contentType: row.photoContentType,
					})
				: null
		detail.photo = link
			? {
					url: link.url,
					expiresAt: link.expiresAt,
					contentType: row.photoContentType!,
				}
			: null
	}
	return detail
}

/**
 * The currency of a quantity-only delivery (one that carries no money): the
 * location's currency, else the order's or supplier's, else the organization
 * hint the App sent. 409 `currency_unknown` when none is known: a currency is
 * never guessed (it used to fall back to USD).
 */
export async function resolveInventoryCurrency(
	db: InventoryReader,
	input: {
		locationId: string
		order?: { currency: string | null } | null
		supplier?: { currency: string | null } | null
	},
): Promise<string> {
	const own = await getLocationCurrency(db, input.locationId)
	if (own) return own
	if (input.order?.currency) return input.order.currency
	if (input.supplier?.currency) return input.supplier.currency
	return requireLocationCurrency(db, input.locationId)
}

export type RecordDeliveryOptions = {
	/** Where it was recorded (default the App). */
	source?: 'operator' | 'station'
	/** Flagged for a manager: made on a tablet long before it arrived. */
	lateSync?: boolean
	/** When it happened (a tablet's clock), never later than now. Sets `receivedAt` and the business date. */
	madeAt?: number
	/**
	 * Station: the goods arrived, so an order that is closed, unknown or for
	 * another supplier does not refuse the delivery; it is recorded unlinked
	 * and `orderLinkIgnored` says why.
	 */
	lenientOrder?: boolean
	/** Called when the `clientId` was already stored and the first result is returned. */
	onReplay?: () => void
}

type OrderLinkIgnored = NonNullable<RecordDeliveryResult['orderLinkIgnored']>

/**
 * Records a received delivery: stock in, and (priced) last and average cost
 * and remembered pack prices.
 *
 * - `quantityOnly` stores the received quantities with no money: lines carry a
 *   zero total and no `priced_at`, costs and supplier prices are NOT touched,
 *   and the delivery is `pricesPending` until `confirmDeliveryPrices`.
 * - `orderId` receives against an order: the order moves to `partly_received`
 *   or `received` (`orderStatusAfterReceipt`), or to `received` with
 *   `closeOrder`. The operator route refuses a closed order (`order_closed`),
 *   a supplier that is not the order's (`supplier_mismatch`) and an unknown
 *   order (404); `lenientOrder` (Station) records the goods unlinked instead.
 * - A replayed `clientId` answers the first result.
 */
export async function recordDelivery(
	caller: InventoryCaller,
	input: {
		body: RecordDeliveryInput
		idempotency: InventoryIdempotency
		options?: RecordDeliveryOptions
	},
): Promise<RecordDeliveryResult> {
	const { body } = input
	const options = input.options ?? {}
	assertLocationAllowed(caller.locationIds, body.locationId)
	const quantityOnly = body.quantityOnly === true
	// Marking a delivery paid is a purchasing decision.
	if (body.paid && !caller.purchasing) {
		throw new InventoryError('purchasing_required', 403)
	}
	if (quantityOnly && body.paid) throw badRequest('quantity_only_unpaid')
	if (!quantityOnly && body.currency === undefined) {
		throw badRequest('priced_delivery_required')
	}
	for (const line of body.lines) {
		if (quantityOnly && line.lineTotalMinor !== undefined) {
			throw badRequest('quantity_only_no_money')
		}
		if (!quantityOnly && line.lineTotalMinor === undefined) {
			throw badRequest('priced_delivery_required')
		}
	}
	return withInventoryWrite(
		{
			orgId: caller.orgId,
			idempotency: input.idempotency,
			onReplay: options.onReplay,
		},
		async (tx, ctx) => {
			// ── A replay of the same request, however long ago ──────────────────
			// The durable idempotency record lives 48 hours; the delivery keeps
			// its `client_id` for good, so a Station queue that retries later
			// still gets the first result instead of a second delivery.
			const earlier = await tx
				.select()
				.from(invDeliveries)
				.where(
					and(
						eq(invDeliveries.locationId, body.locationId),
						eq(invDeliveries.clientId, body.clientId),
					),
				)
				.get()
			if (earlier) {
				options.onReplay?.()
				return replayDeliveryResult(tx, earlier, caller)
			}

			// ── The order this delivery is against ──────────────────────────────
			let order: OrderRow | null = null
			let orderLinkIgnored: OrderLinkIgnored | null = null
			if (body.orderId) {
				const found = await tx
					.select()
					.from(invOrders)
					.where(eq(invOrders.id, body.orderId))
					.get()
				if (!found || found.locationId !== body.locationId) {
					if (!options.lenientOrder) throw notFound()
					orderLinkIgnored = 'not_found'
				} else if (
					found.status === 'received' ||
					found.status === 'cancelled'
				) {
					if (!options.lenientOrder) {
						throw new InventoryError('order_closed', 409)
					}
					orderLinkIgnored = 'closed'
				} else if (
					body.supplierId !== null &&
					body.supplierId !== found.supplierId
				) {
					if (!options.lenientOrder) {
						throw new InventoryError('supplier_mismatch', 409)
					}
					orderLinkIgnored = 'wrong_supplier'
				} else {
					order = found
				}
			}
			const supplierId = body.supplierId ?? order?.supplierId ?? null
			const supplier = supplierId ? await loadSupplier(tx, supplierId) : null
			const orderLines = order
				? await tx
						.select()
						.from(invOrderLines)
						.where(eq(invOrderLines.orderId, order.id))
				: []
			const orderLineById = new Map(orderLines.map((line) => [line.id, line]))
			// A line's `orderLineId` must be a line of the linked order for the same item.
			const lines = body.lines.map((line) => {
				if (!line.orderLineId) return { ...line, orderLineId: null }
				const target = orderLineById.get(line.orderLineId)
				if (target && target.itemId === line.itemId) {
					return { ...line, orderLineId: target.id }
				}
				if (!options.lenientOrder) throw badRequest('order_line')
				return { ...line, orderLineId: null }
			})

			const itemIds = [...new Set(lines.map((line) => line.itemId))]
			const [items, costs] = await Promise.all([
				queryInChunks(itemIds, (chunk) =>
					tx.select().from(invItems).where(inArray(invItems.id, chunk)),
				),
				queryInChunks(itemIds, (costChunk) =>
					tx
						.select()
						.from(invItemCosts)
						.where(inArray(invItemCosts.itemId, costChunk)),
				),
			])
			const itemById = new Map(items.map((item) => [item.id, item]))
			if (
				itemIds.some((id) => !itemById.has(id) || itemById.get(id)!.archivedAt)
			) {
				throw notFound()
			}
			const costById = new Map(costs.map((row) => [row.itemId, row]))
			const currency = quantityOnly
				? await resolveInventoryCurrency(tx, {
						locationId: body.locationId,
						order,
						supplier,
					})
				: body.currency!
			if (!quantityOnly) {
				// One currency per location: a priced delivery states it, the
				// location's own wins (400 on a difference) and a location with none
				// takes it. An item already priced in another currency is refused too.
				await assertLocationCurrency(tx, {
					locationId: body.locationId,
					currency,
					now: ctx.now,
				})
				for (const cost of costs) {
					if (cost.currency !== currency) throw currencyMismatch()
				}
			}
			const productIds = [
				...new Set(
					lines
						.map((line) => line.supplierProductId)
						.filter((id): id is string => !!id),
				),
			]
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
			for (const line of lines) {
				if (!line.supplierProductId) continue
				const product = productById.get(line.supplierProductId)
				if (!product || product.itemId !== line.itemId) throw notFound()
			}

			const deliveryId = newId()
			const receivedAt = Math.min(options.madeAt ?? ctx.now, ctx.now)
			const businessDate = await locationBusinessDate(
				tx,
				body.locationId,
				receivedAt,
			)
			await tx.insert(invDeliveries).values({
				id: deliveryId,
				locationId: body.locationId,
				supplierId,
				status: 'received',
				invoiceNumber: body.invoiceNumber || null,
				invoiceDate: body.invoiceDate ?? null,
				vatMinor: body.vatMinor ?? null,
				totalMinor: body.totalMinor ?? null,
				currency,
				zatcaReference: body.zatcaReference || null,
				orderId: order?.id ?? null,
				quantityOnly,
				lateSync: options.lateSync === true,
				paidAt: body.paid ? ctx.now : null,
				receivedByKind: caller.actor.kind,
				receivedById: caller.actor.id,
				receivedAt,
				businessDate,
				clientId: body.clientId,
				source: options.source ?? 'operator',
				createdAt: ctx.now,
				updatedAt: ctx.now,
			})

			const rises = new Map<
				string,
				{
					itemName: string
					previous: number
					costMicro: number
					changeBp: number
				}
			>()
			for (const line of lines) {
				const item = itemById.get(line.itemId)!
				const lineId = newId()
				if (quantityOnly) {
					// Stock in only: no cost, no price, no value.
					await tx.insert(invDeliveryLines).values({
						id: lineId,
						deliveryId,
						itemId: item.id,
						supplierProductId: line.supplierProductId ?? null,
						quantity: line.quantity,
						packName: line.packName ?? null,
						packBaseQuantity: line.packBaseQuantity ?? null,
						packs: line.packs == null ? null : Math.round(line.packs * 1000),
						priceMinor: null,
						lineTotalMinor: 0,
						realWeightQuantity: line.realWeightQuantity ?? null,
						orderLineId: line.orderLineId,
						pricedAt: null,
						createdAt: ctx.now,
					})
					await tx.insert(invMovements).values({
						locationId: body.locationId,
						itemId: item.id,
						quantity: line.quantity,
						valueMinor: null,
						currency: null,
						kind: 'delivery',
						sourceType: 'delivery',
						sourceId: deliveryId,
						eventKey: `delivery:${lineId}`,
						businessDate,
						actorKind: caller.actor.kind,
						actorId: caller.actor.id,
						createdAt: receivedAt,
					})
					continue
				}
				const lineTotalMinor = line.lineTotalMinor!
				const costMicro = costMicroForWrite(lineTotalMinor, line.quantity)
				const existing = costById.get(item.id) ?? null
				const onHand = await onHandTotal(tx, item.id)
				const average = weightedAverageCostMicro({
					onHandQuantity: onHand,
					averageCostMicro: existing?.avgCostMicro ?? null,
					receivedQuantity: line.quantity,
					receivedCostMicro: costMicro,
				})
				const change = priceChangeBp(existing?.lastCostMicro ?? null, costMicro)
				if (change !== null && change > 0 && existing?.lastCostMicro != null) {
					rises.set(item.id, {
						itemName: item.name,
						previous: existing.lastCostMicro,
						costMicro,
						changeBp: change,
					})
				}
				const next = {
					currency,
					lastCostMicro: costMicro,
					lastPricedAt: ctx.now,
					avgCostMicro: average,
					version: (existing?.version ?? 0) + 1,
					updatedAt: ctx.now,
				}
				await tx
					.insert(invItemCosts)
					.values({ itemId: item.id, ...next })
					.onConflictDoUpdate({ target: invItemCosts.itemId, set: next })
				costById.set(item.id, {
					itemId: item.id,
					...next,
				})

				await tx.insert(invDeliveryLines).values({
					id: lineId,
					deliveryId,
					itemId: item.id,
					supplierProductId: line.supplierProductId ?? null,
					quantity: line.quantity,
					packName: line.packName ?? null,
					packBaseQuantity: line.packBaseQuantity ?? null,
					packs: line.packs == null ? null : Math.round(line.packs * 1000),
					priceMinor: line.packPriceMinor ?? null,
					lineTotalMinor,
					realWeightQuantity: line.realWeightQuantity ?? null,
					orderLineId: line.orderLineId,
					pricedAt: ctx.now,
					createdAt: ctx.now,
				})
				// The step of the average, so a cancel can rewind it exactly.
				await tx.insert(invCostEvents).values({
					itemId: item.id,
					kind: 'delivery',
					deliveryLineId: lineId,
					locationId: body.locationId,
					quantity: line.quantity,
					costMicro,
					onHandBefore: onHand,
					avgBeforeMicro: existing?.avgCostMicro ?? null,
					avgAfterMicro: average,
					createdAt: receivedAt,
				})
				await tx.insert(invMovements).values({
					locationId: body.locationId,
					itemId: item.id,
					quantity: line.quantity,
					valueMinor: lineTotalMinor,
					currency,
					kind: 'delivery',
					sourceType: 'delivery',
					sourceId: deliveryId,
					eventKey: `delivery:${lineId}`,
					businessDate,
					actorKind: caller.actor.kind,
					actorId: caller.actor.id,
					createdAt: receivedAt,
				})
				// A remembered pack price is a purchasing decision.
				const product = line.supplierProductId
					? productById.get(line.supplierProductId)
					: undefined
				if (
					product &&
					caller.purchasing &&
					line.packPriceMinor != null &&
					line.packPriceMinor !== product.priceMinor
				) {
					await tx
						.update(invSupplierProducts)
						.set({
							priceMinor: line.packPriceMinor,
							currency,
							version: product.version + 1,
							updatedAt: ctx.now,
						})
						.where(eq(invSupplierProducts.id, product.id))
					productById.set(product.id, {
						...product,
						priceMinor: line.packPriceMinor,
						version: product.version + 1,
					})
				}
			}

			// ── The order after this delivery ──────────────────────────────────
			let orderSummary: OrderSummary | undefined
			if (order) {
				const received = await receivedByOrderLine(
					tx,
					orderLines.map((line) => line.id),
				)
				const status = orderStatusAfterReceipt({
					status: order.status,
					closeOrder: body.closeOrder === true,
					lines: orderLines.map((line) => ({
						orderedQuantity: line.quantity,
						receivedQuantity: received.get(line.id) ?? 0,
						pricedByWeight: line.pricedByWeight,
					})),
				})
				if (status !== order.status) {
					await tx
						.update(invOrders)
						.set({
							status,
							closedAt: status === 'received' ? ctx.now : null,
							version: order.version + 1,
							updatedAt: ctx.now,
						})
						.where(eq(invOrders.id, order.id))
				}
				const nextOrder = await tx
					.select()
					.from(invOrders)
					.where(eq(invOrders.id, order.id))
					.get()
				;[orderSummary] = await orderSummaries(tx, [nextOrder!], caller.cost)
			}
			await recordInventoryAudit(tx, {
				actorKind: caller.actor.kind,
				actorId: caller.actor.id,
				action: 'delivery.record',
				resourceType: 'delivery',
				resourceId: deliveryId,
				locationId: body.locationId,
				detail: {
					lines: lines.length,
					paid: body.paid,
					quantityOnly,
					orderId: order?.id ?? null,
					orderLinkIgnored,
					source: options.source ?? 'operator',
					lateSync: options.lateSync === true,
				},
				at: ctx.now,
			})
			const row = await tx
				.select()
				.from(invDeliveries)
				.where(eq(invDeliveries.id, deliveryId))
				.get()
			const result: RecordDeliveryResult = {
				delivery: await deliveryDetail(tx, row!, caller.cost),
			}
			if (caller.cost && !quantityOnly) {
				result.priceChanges = priceChangeList(rises)
			}
			if (orderSummary) result.order = orderSummary
			if (body.orderId) result.orderLinkIgnored = orderLinkIgnored
			return result
		},
	)
}

/** 400 `currency_mismatch`: money in a currency other than the location's (or the item's). */
function currencyMismatch(): InventoryError {
	return new InventoryError('currency_mismatch', 400, {
		reason: 'currency_mismatch',
	})
}

/** The first result of a delivery whose `clientId` was already recorded. */
async function replayDeliveryResult(
	tx: InventoryTx,
	row: DeliveryRow,
	caller: InventoryCaller,
): Promise<RecordDeliveryResult> {
	const result: RecordDeliveryResult = {
		delivery: await deliveryDetail(tx, row, caller.cost),
	}
	if (row.orderId) {
		const order = await tx
			.select()
			.from(invOrders)
			.where(eq(invOrders.id, row.orderId))
			.get()
		if (order) {
			;[result.order] = await orderSummaries(tx, [order], caller.cost)
		}
	}
	return result
}

function priceChangeList(
	rises: Map<
		string,
		{ itemName: string; previous: number; costMicro: number; changeBp: number }
	>,
) {
	return [...rises.entries()]
		.map(([itemId, rise]) => ({
			itemId,
			itemName: rise.itemName,
			previousCostMicro: rise.previous,
			costMicro: rise.costMicro,
			changeBp: rise.changeBp,
		}))
		.sort((a, b) => b.changeBp - a.changeBp || (a.itemId < b.itemId ? -1 : 1))
}

export async function loadAllowedDelivery(
	db: InventoryReader,
	id: string,
	caller: Pick<InventoryCaller, 'locationIds'>,
): Promise<DeliveryRow> {
	const row = await db
		.select()
		.from(invDeliveries)
		.where(eq(invDeliveries.id, id))
		.get()
	if (!row) throw notFound()
	assertLocationAllowed(caller.locationIds, row.locationId)
	return row
}

/**
 * Prices a quantity-only delivery (one that arrived from a Station tablet, or
 * without prices) once a person has the invoice. Every unpriced line is
 * listed exactly once. It does what `recordDelivery` does for priced lines:
 * cost per base unit from `lineTotalMinor / quantity`, last and weighted
 * average cost (on hand minus this delivery's quantity, floored at zero),
 * the supplier's pack price, and price changes; the delivery then reads
 * `pricesPending: false`. The value of the purchase enters the ledger as a
 * zero-quantity `delivery` movement now (the original movement carried no
 * value and movements are append-only).
 */
/**
 * Stock of an item (all locations, as `onHandTotal`) just before a delivery's
 * first movement for it, from the ledger: the sum of every movement recorded
 * earlier. Floored at zero (stock below zero counts as none, as the average
 * does).
 */
async function onHandBeforeDelivery(
	tx: InventoryTx,
	deliveryId: string,
	itemId: string,
): Promise<number> {
	const first = await tx
		.select({
			createdAt: invMovements.createdAt,
			rowid: sql<number>`${invMovements}.rowid`,
		})
		.from(invMovements)
		.where(
			and(
				eq(invMovements.sourceType, 'delivery'),
				eq(invMovements.sourceId, deliveryId),
				eq(invMovements.itemId, itemId),
				sql`${invMovements.eventKey} like 'delivery:%'`,
			),
		)
		.orderBy(invMovements.createdAt, sql`rowid`)
		.limit(1)
		.get()
	if (!first) return Math.max(0, await onHandTotal(tx, itemId))
	const before = await tx
		.select({ total: sql<number>`coalesce(sum(${invMovements.quantity}), 0)` })
		.from(invMovements)
		.where(
			and(
				eq(invMovements.itemId, itemId),
				sql`(${invMovements.createdAt} < ${first.createdAt} or (${invMovements.createdAt} = ${first.createdAt} and ${invMovements}.rowid < ${first.rowid}))`,
			),
		)
		.get()
	return Math.max(0, Number(before?.total ?? 0))
}

export async function confirmDeliveryPrices(
	caller: InventoryCaller,
	input: { id: string; body: ConfirmDeliveryPricesInput },
): Promise<RecordDeliveryResult> {
	const { body } = input
	return withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const row = await loadAllowedDelivery(tx, input.id, caller)
		assertVersion(row.version, body.expectedVersion)
		if (row.status !== 'received') throw stateConflict('not_received')
		if (!row.quantityOnly || row.pricesConfirmedAt !== null) {
			throw new InventoryError('prices_confirmed', 409)
		}
		const lines: LineRow[] = await tx
			.select()
			.from(invDeliveryLines)
			.where(eq(invDeliveryLines.deliveryId, row.id))
			.orderBy(invDeliveryLines.createdAt, invDeliveryLines.id)
		const unpriced = lines.filter((line) => line.pricedAt === null)
		if (unpriced.length === 0) throw new InventoryError('prices_confirmed', 409)
		const sent = new Map(body.lines.map((line) => [line.lineId, line]))
		if (
			sent.size !== body.lines.length ||
			sent.size !== unpriced.length ||
			unpriced.some((line) => !sent.has(line.id))
		) {
			throw badRequest('lines')
		}
		const currency = body.currency
		// The location's currency (a location with none takes this one).
		await assertLocationCurrency(tx, {
			locationId: row.locationId,
			currency,
			now: ctx.now,
		})
		const itemIds = [...new Set(unpriced.map((line) => line.itemId))]
		const [items, costs] = await Promise.all([
			queryInChunks(itemIds, (chunk) =>
				tx.select().from(invItems).where(inArray(invItems.id, chunk)),
			),
			queryInChunks(itemIds, (chunk) =>
				tx
					.select()
					.from(invItemCosts)
					// bounded: its own statement, one chunk of at most 90 ids
					.where(inArray(invItemCosts.itemId, chunk)),
			),
		])
		const itemById = new Map(items.map((item) => [item.id, item]))
		const costById = new Map(costs.map((cost) => [cost.itemId, cost]))
		for (const cost of costs) {
			if (cost.currency !== currency) throw currencyMismatch()
		}
		const productIds = [
			...new Set(
				unpriced
					.map((line) => line.supplierProductId)
					.filter((id): id is string => !!id),
			),
		]
		const products = await queryInChunks(productIds, (chunk) =>
			tx
				.select()
				.from(invSupplierProducts)
				.where(inArray(invSupplierProducts.id, chunk)),
		)
		const productById = new Map(
			products.map((product) => [product.id, product]),
		)

		// Stock before this delivery, per item, from the ledger as it stood when
		// the goods arrived (not today's on hand, which sales since have
		// changed), so the average weighs what was on the shelf before it.
		const stockBefore = new Map<string, number>()
		for (const itemId of itemIds) {
			stockBefore.set(itemId, await onHandBeforeDelivery(tx, row.id, itemId))
		}

		const businessDate = await locationBusinessDate(tx, row.locationId, ctx.now)
		const rises = new Map<
			string,
			{
				itemName: string
				previous: number
				costMicro: number
				changeBp: number
			}
		>()
		for (const line of unpriced) {
			const item = itemById.get(line.itemId)
			if (!item) throw notFound()
			const entry = sent.get(line.id)!
			const costMicro = costMicroForWrite(entry.lineTotalMinor, line.quantity)
			const existing = costById.get(item.id) ?? null
			const before = stockBefore.get(item.id) ?? 0
			const average = weightedAverageCostMicro({
				onHandQuantity: before,
				averageCostMicro: existing?.avgCostMicro ?? null,
				receivedQuantity: line.quantity,
				receivedCostMicro: costMicro,
			})
			stockBefore.set(item.id, before + line.quantity)
			const change = priceChangeBp(existing?.lastCostMicro ?? null, costMicro)
			if (change !== null && change > 0 && existing?.lastCostMicro != null) {
				rises.set(item.id, {
					itemName: item.name,
					previous: existing.lastCostMicro,
					costMicro,
					changeBp: change,
				})
			}
			const next = {
				currency,
				lastCostMicro: costMicro,
				lastPricedAt: ctx.now,
				avgCostMicro: average,
				version: (existing?.version ?? 0) + 1,
				updatedAt: ctx.now,
			}
			await tx
				.insert(invItemCosts)
				.values({ itemId: item.id, ...next })
				.onConflictDoUpdate({ target: invItemCosts.itemId, set: next })
			costById.set(item.id, { itemId: item.id, ...next })

			await tx
				.update(invDeliveryLines)
				.set({
					priceMinor: entry.packPriceMinor ?? null,
					lineTotalMinor: entry.lineTotalMinor,
					pricedAt: ctx.now,
				})
				.where(eq(invDeliveryLines.id, line.id))
			await tx.insert(invCostEvents).values({
				itemId: item.id,
				kind: 'confirm',
				deliveryLineId: line.id,
				locationId: row.locationId,
				quantity: line.quantity,
				costMicro,
				onHandBefore: before,
				avgBeforeMicro: existing?.avgCostMicro ?? null,
				avgAfterMicro: average,
				createdAt: ctx.now,
			})
			// The money of the purchase: the first movement had no value.
			await tx.insert(invMovements).values({
				locationId: row.locationId,
				itemId: item.id,
				quantity: 0,
				valueMinor: entry.lineTotalMinor,
				currency,
				kind: 'delivery',
				sourceType: 'delivery',
				sourceId: row.id,
				eventKey: `delivery-priced:${line.id}`,
				businessDate,
				actorKind: caller.actor.kind,
				actorId: caller.actor.id,
				createdAt: ctx.now,
			})
			const product = line.supplierProductId
				? productById.get(line.supplierProductId)
				: undefined
			if (
				product &&
				product.archivedAt === null &&
				entry.packPriceMinor != null &&
				entry.packPriceMinor !== product.priceMinor
			) {
				await tx
					.update(invSupplierProducts)
					.set({
						priceMinor: entry.packPriceMinor,
						currency,
						version: product.version + 1,
						updatedAt: ctx.now,
					})
					.where(eq(invSupplierProducts.id, product.id))
				productById.set(product.id, {
					...product,
					priceMinor: entry.packPriceMinor,
					version: product.version + 1,
				})
			}
		}

		const set: Partial<typeof invDeliveries.$inferInsert> = {
			currency,
			pricesConfirmedAt: ctx.now,
			version: row.version + 1,
			updatedAt: ctx.now,
		}
		if (body.invoiceNumber !== undefined) {
			set.invoiceNumber = body.invoiceNumber || null
		}
		if (body.invoiceDate !== undefined) set.invoiceDate = body.invoiceDate
		if (body.vatMinor !== undefined) set.vatMinor = body.vatMinor
		if (body.totalMinor !== undefined) set.totalMinor = body.totalMinor
		if (body.zatcaReference !== undefined) {
			set.zatcaReference = body.zatcaReference || null
		}
		if (body.paid) set.paidAt = ctx.now
		await tx.update(invDeliveries).set(set).where(eq(invDeliveries.id, row.id))
		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: 'delivery.confirm_prices',
			resourceType: 'delivery',
			resourceId: row.id,
			locationId: row.locationId,
			detail: { lines: unpriced.length, paid: body.paid },
			at: ctx.now,
		})
		const next = await loadAllowedDelivery(tx, row.id, caller)
		const result: RecordDeliveryResult = {
			delivery: await deliveryDetail(tx, next, caller.cost),
		}
		if (caller.cost) result.priceChanges = priceChangeList(rises)
		if (next.orderId) {
			const order = await tx
				.select()
				.from(invOrders)
				.where(eq(invOrders.id, next.orderId))
				.get()
			if (order) {
				;[result.order] = await orderSummaries(tx, [order], caller.cost)
			}
		}
		return result
	})
}

export async function markDeliveryPaid(
	caller: InventoryCaller,
	input: { id: string; expectedVersion: number; paid: boolean },
): Promise<DeliveryDetail> {
	return withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const row = await loadAllowedDelivery(tx, input.id, caller)
		assertVersion(row.version, input.expectedVersion)
		if (row.status !== 'received') throw stateConflict('not_received')
		await tx
			.update(invDeliveries)
			.set({
				paidAt: input.paid ? ctx.now : null,
				version: row.version + 1,
				updatedAt: ctx.now,
			})
			.where(eq(invDeliveries.id, row.id))
		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: input.paid ? 'delivery.paid' : 'delivery.unpaid',
			resourceType: 'delivery',
			resourceId: row.id,
			locationId: row.locationId,
			at: ctx.now,
		})
		const next = await loadAllowedDelivery(tx, row.id, caller)
		return deliveryDetail(tx, next, caller.cost)
	})
}

/**
 * The item's weighted average with the steps of cancelled deliveries taken
 * out: start from the average before the earliest cancelled step, then apply
 * every later step that still stands (each carries the stock it was weighed
 * against). A typo delivery that is cancelled leaves no trace in the average.
 * `rewound: false` when no cancelled step was recorded (a delivery from before
 * migration 0039): the average is left as it is.
 */
async function rewoundAverage(
	tx: InventoryTx,
	itemId: string,
): Promise<{ rewound: boolean; average: number | null }> {
	const events = await tx
		.select()
		.from(invCostEvents)
		.where(eq(invCostEvents.itemId, itemId))
		.orderBy(invCostEvents.createdAt, sql`rowid`)
	const cancelled = new Set(
		(
			await tx
				.select({ id: invDeliveryLines.id })
				.from(invDeliveryLines)
				.innerJoin(
					invDeliveries,
					eq(invDeliveries.id, invDeliveryLines.deliveryId),
				)
				.where(
					and(
						eq(invDeliveryLines.itemId, itemId),
						eq(invDeliveries.status, 'cancelled'),
					),
				)
		).map((line) => line.id),
	)
	const standing = (event: (typeof events)[number]) =>
		!event.deliveryLineId || !cancelled.has(event.deliveryLineId)
	const first = events.findIndex((event) => !standing(event))
	if (first < 0) return { rewound: false, average: null }
	let average = events[first]!.avgBeforeMicro
	for (let i = first + 1; i < events.length; i++) {
		const event = events[i]!
		if (!standing(event)) continue
		let cancelledQty = 0
		for (let j = 0; j < i; j++) {
			const prior = events[j]!
			if (prior.deliveryLineId && cancelled.has(prior.deliveryLineId)) {
				cancelledQty += prior.quantity
			}
		}
		average = weightedAverageCostMicro({
			onHandQuantity: event.onHandBefore - cancelledQty,
			averageCostMicro: average,
			receivedQuantity: event.quantity,
			receivedCostMicro: event.costMicro,
		})
	}
	return { rewound: true, average }
}

/**
 * Cancels a received delivery: its stock goes out again by reversing
 * movements (the lines and the original movements stay). The last cost of
 * each item goes back to the latest remaining PRICED delivery, and the
 * weighted average is rewound by replaying the recorded steps without the
 * cancelled delivery (`rewoundAverage`), so a price typo leaves no trace. An
 * order it was received against keeps its status (it only moves forward) but
 * the lines read as less received.
 */
export async function cancelDelivery(
	caller: InventoryCaller,
	input: { id: string; expectedVersion: number; note?: string },
): Promise<DeliveryDetail> {
	return withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const row = await loadAllowedDelivery(tx, input.id, caller)
		assertVersion(row.version, input.expectedVersion)
		if (row.status !== 'received') throw stateConflict('not_received')
		const lines: LineRow[] = await tx
			.select()
			.from(invDeliveryLines)
			.where(eq(invDeliveryLines.deliveryId, row.id))
			.orderBy(invDeliveryLines.createdAt, invDeliveryLines.id)
		const businessDate = await locationBusinessDate(tx, row.locationId, ctx.now)
		for (const line of lines) {
			const priced = line.pricedAt !== null
			await tx.insert(invMovements).values({
				locationId: row.locationId,
				itemId: line.itemId,
				quantity: -line.quantity,
				valueMinor: priced ? -line.lineTotalMinor : null,
				currency: priced ? row.currency : null,
				kind: 'delivery',
				sourceType: 'delivery',
				sourceId: row.id,
				eventKey: `delivery-cancel:${line.id}`,
				businessDate,
				actorKind: caller.actor.kind,
				actorId: caller.actor.id,
				note: input.note?.length ? input.note : null,
				createdAt: ctx.now,
			})
		}
		await tx
			.update(invDeliveries)
			.set({
				status: 'cancelled',
				version: row.version + 1,
				updatedAt: ctx.now,
			})
			.where(eq(invDeliveries.id, row.id))
		for (const itemId of new Set(
			lines.filter((line) => line.pricedAt !== null).map((line) => line.itemId),
		)) {
			const remaining = await tx
				.select({
					quantity: invDeliveryLines.quantity,
					total: invDeliveryLines.lineTotalMinor,
					at: invDeliveries.receivedAt,
				})
				.from(invDeliveryLines)
				.innerJoin(
					invDeliveries,
					eq(invDeliveries.id, invDeliveryLines.deliveryId),
				)
				.where(
					and(
						eq(invDeliveryLines.itemId, itemId),
						eq(invDeliveries.status, 'received'),
						sql`${invDeliveryLines.pricedAt} is not null`,
					),
				)
				.orderBy(desc(invDeliveryLines.createdAt), desc(invDeliveryLines.id))
				.limit(1)
				.get()
			const cost = await tx
				.select()
				.from(invItemCosts)
				.where(eq(invItemCosts.itemId, itemId))
				.get()
			if (!cost) continue
			const rewound = await rewoundAverage(tx, itemId)
			await tx
				.update(invItemCosts)
				.set({
					...(rewound.rewound ? { avgCostMicro: rewound.average } : {}),
					lastCostMicro:
						remaining && remaining.quantity > 0
							? costMicroFromPackPriceClamped(
									remaining.total,
									remaining.quantity,
								)
							: null,
					lastPricedAt: remaining?.at ?? null,
					version: cost.version + 1,
					updatedAt: ctx.now,
				})
				.where(eq(invItemCosts.itemId, itemId))
		}
		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: 'delivery.cancel',
			resourceType: 'delivery',
			resourceId: row.id,
			locationId: row.locationId,
			detail: { lines: lines.length },
			at: ctx.now,
		})
		const next = await loadAllowedDelivery(tx, row.id, caller)
		return deliveryDetail(tx, next, caller.cost)
	})
}
