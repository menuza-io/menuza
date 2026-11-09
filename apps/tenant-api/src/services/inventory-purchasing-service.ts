import {
	costMicroFromPackPrice,
	INVENTORY_LIMITS,
	priceChangeBp,
	weightedAverageCostMicro,
	type DeliveryDetail,
	type DeliverySummary,
	type Supplier,
	type SupplierProduct,
} from '@repo/inventory'
import {
	invDeliveries,
	invDeliveryLines,
	invItemCosts,
	invItems,
	invMovements,
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
	type CreateSupplierInput,
	type ListDeliveriesQuery,
	type RecordDeliveryInput,
	type SupplierProductInput,
	type UpdateSupplierInput,
	type UpdateSupplierProductInput,
} from './inventory-contract-types.ts'
import { type InventoryCaller } from './inventory-items-service.ts'

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
			currency: supplier.currency ?? 'USD',
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
				set.currency = supplier.currency ?? 'USD'
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
	const [suppliers, totals] = await Promise.all([
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
	])
	const names = new Map(suppliers.map((row) => [row.id, row.name]))
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

/** Cost per base unit of each item's latest earlier delivered line (other deliveries). */
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
					sql`${invDeliveryLines.createdAt} <= ${delivery.createdAt}`,
				),
			)
			.orderBy(invDeliveryLines.createdAt, invDeliveryLines.id),
	)
	const map = new Map<string, number>()
	for (const row of rows) {
		if (row.quantity > 0) {
			map.set(row.itemId, costMicroFromPackPrice(row.total, row.quantity))
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
	return deliveryDetail(db, row, input.caller.cost)
}

async function deliveryDetail(
	db: InventoryReader,
	row: DeliveryRow,
	cost: boolean,
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
	const [summary] = await toSummaries(db, [row], cost)
	return {
		...summary!,
		zatcaReference: row.zatcaReference,
		lines: lines.map(({ line, itemName }) => {
			const out: DeliveryDetail['lines'][number] = {
				id: line.id,
				itemId: line.itemId,
				itemName,
				quantity: line.quantity,
				packs: line.packs === null ? null : line.packs / 1000,
				packName: line.packName,
				realWeightQuantity: line.realWeightQuantity,
			}
			if (cost) {
				out.lineTotalMinor = line.lineTotalMinor
				if (line.priceMinor !== null) out.packPriceMinor = line.priceMinor
				out.priceChangeBp =
					line.quantity > 0
						? priceChangeBp(
								previous.get(line.itemId) ?? null,
								costMicroFromPackPrice(line.lineTotalMinor, line.quantity),
							)
						: null
			}
			return out
		}),
	}
}

export async function recordDelivery(
	caller: InventoryCaller,
	input: { body: RecordDeliveryInput; idempotency: InventoryIdempotency },
) {
	const { body } = input
	assertLocationAllowed(caller.locationIds, body.locationId)
	// Marking a delivery paid is a purchasing decision.
	if (body.paid && !caller.purchasing) {
		throw new InventoryError('purchasing_required', 403)
	}
	// The wire schema made money optional for the quantity-only path (phase 2);
	// this priced path still needs it, and `quantityOnly` is not built yet.
	const currency = body.currency
	if (body.quantityOnly || currency === undefined) {
		throw badRequest('priced_delivery_required')
	}
	const lines = body.lines.map((line) => {
		if (line.lineTotalMinor === undefined) {
			throw badRequest('priced_delivery_required')
		}
		return { ...line, lineTotalMinor: line.lineTotalMinor }
	})
	return withInventoryWrite(
		{ orgId: caller.orgId, idempotency: input.idempotency },
		async (tx, ctx) => {
			if (body.supplierId) {
				await loadSupplier(tx, body.supplierId)
			}
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
			for (const cost of costs) {
				if (cost.currency !== currency) throw badRequest('currency_mismatch')
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
			const businessDate = await locationBusinessDate(
				tx,
				body.locationId,
				ctx.now,
			)
			await tx.insert(invDeliveries).values({
				id: deliveryId,
				locationId: body.locationId,
				supplierId: body.supplierId,
				status: 'received',
				invoiceNumber: body.invoiceNumber || null,
				invoiceDate: body.invoiceDate ?? null,
				vatMinor: body.vatMinor ?? null,
				totalMinor: body.totalMinor ?? null,
				currency,
				zatcaReference: body.zatcaReference || null,
				paidAt: body.paid ? ctx.now : null,
				receivedByKind: caller.actor.kind,
				receivedById: caller.actor.id,
				receivedAt: ctx.now,
				businessDate,
				source: 'operator',
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
				const costMicro = costMicroFromPackPrice(
					line.lineTotalMinor,
					line.quantity,
				)
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

				const lineId = newId()
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
					lineTotalMinor: line.lineTotalMinor,
					realWeightQuantity: line.realWeightQuantity ?? null,
					pricedAt: ctx.now,
					createdAt: ctx.now,
				})
				await tx.insert(invMovements).values({
					locationId: body.locationId,
					itemId: item.id,
					quantity: line.quantity,
					valueMinor: line.lineTotalMinor,
					currency,
					kind: 'delivery',
					sourceType: 'delivery',
					sourceId: deliveryId,
					eventKey: `delivery:${lineId}`,
					businessDate,
					actorKind: caller.actor.kind,
					actorId: caller.actor.id,
					createdAt: ctx.now,
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
			await recordInventoryAudit(tx, {
				actorKind: caller.actor.kind,
				actorId: caller.actor.id,
				action: 'delivery.record',
				resourceType: 'delivery',
				resourceId: deliveryId,
				locationId: body.locationId,
				detail: { lines: lines.length, paid: body.paid },
				at: ctx.now,
			})
			const row = await tx
				.select()
				.from(invDeliveries)
				.where(eq(invDeliveries.id, deliveryId))
				.get()
			const result: {
				delivery: DeliveryDetail
				priceChanges?: Array<{
					itemId: string
					itemName: string
					previousCostMicro: number
					costMicro: number
					changeBp: number
				}>
			} = { delivery: await deliveryDetail(tx, row!, caller.cost) }
			if (caller.cost) {
				result.priceChanges = [...rises.entries()]
					.map(([itemId, rise]) => ({
						itemId,
						itemName: rise.itemName,
						previousCostMicro: rise.previous,
						costMicro: rise.costMicro,
						changeBp: rise.changeBp,
					}))
					.sort(
						(a, b) => b.changeBp - a.changeBp || (a.itemId < b.itemId ? -1 : 1),
					)
			}
			return result
		},
	)
}

async function loadAllowedDelivery(
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
 * Cancels a received delivery: its stock goes out again by reversing
 * movements (the lines and the original movements stay). The last cost of
 * each item goes back to the latest remaining delivery; the weighted average
 * is not rewound (it is a moving figure and the next delivery rebalances it).
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
			await tx.insert(invMovements).values({
				locationId: row.locationId,
				itemId: line.itemId,
				quantity: -line.quantity,
				valueMinor: -line.lineTotalMinor,
				currency: row.currency,
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
		for (const itemId of new Set(lines.map((line) => line.itemId))) {
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
			await tx
				.update(invItemCosts)
				.set({
					lastCostMicro:
						remaining && remaining.quantity > 0
							? costMicroFromPackPrice(remaining.total, remaining.quantity)
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
