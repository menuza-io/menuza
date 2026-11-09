import {
	type AdjustStockInput,
	type BulkCreateItemsInput,
	type CreateItemInput,
	type ItemUnitInput,
	type ListItemsQuery,
	type PutItemPlaceInput,
	type UpdateItemInput,
} from './inventory-contract-types.ts'
import {
	costMicroFromPackPrice,
	INVENTORY_LIMITS,
	inventoryValueMinor,
	STANDARD_UNIT_SPECS,
	stockStatus,
	type InventoryBaseUnit,
	type ItemDetail,
	type StockItem,
	type StockStatus,
	type UnitSystem,
} from '@repo/inventory'
import {
	invCounts,
	invCountEntries,
	invItemCosts,
	invItemPlaceAreas,
	invItemPlaces,
	invItems,
	invItemUnits,
	invMovements,
	invStorageAreas,
	invSupplierProducts,
	invSuppliers,
	invDeliveries,
	invDeliveryLines,
} from '@repo/tenant-db'
import { and, count, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { forEachInChunks, queryInChunks } from '../lib/chunked-in.ts'
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
	decodeOffsetCursor,
	defaultCountUnit,
	encodeCursor,
	groupUnits,
	type InventoryActor,
	type ItemUnitRow,
	loadItemUnits,
	locationBusinessDate,
	locationVisible,
	type LocationScope,
	newId,
	notFound,
	onHandByItem,
	onHandByLocation,
	resolveQuantityUnit,
	stateConflict,
	storedUnit,
	wireUnit,
} from './inventory-common.ts'
import { getInventorySettings } from './inventory-settings-service.ts'

type ItemRow = typeof invItems.$inferSelect
type PlaceRow = typeof invItemPlaces.$inferSelect
type CostRow = typeof invItemCosts.$inferSelect

/** What a service needs to know about the caller. */
export type InventoryCaller = {
	orgId: string
	region: 'us' | 'ksa'
	actor: InventoryActor
	locationIds: LocationScope
	/** The token holds `read:inventory_cost:any`. */
	cost: boolean
	/** The token holds `update:inventory_purchasing:any`. */
	purchasing: boolean
}

// ── Stock rows (one item at one location) ───────────────────────────────────

export type StockRow = {
	item: ItemRow
	place: PlaceRow | null
	areaIds: string[]
	/** Shelf position of the item in each of its areas. */
	areaSort: Map<string, number>
	units: ItemUnitRow[]
	onHand: number
	cost: CostRow | null
	status: StockStatus
	lastCountedAt: number | null
}

/** Out at or below zero; an item this location does not keep yet is fine. */
export function itemStatus(
	onHand: number,
	place: PlaceRow | null,
): StockStatus {
	if (!place && onHand === 0) return 'ok'
	return stockStatus(onHand, place?.orderBelowQuantity ?? null)
}

/** Stock value of an item at its weighted average cost (nothing for stock below zero). */
export function stockValueMinor(
	onHand: number,
	cost: CostRow | null,
): number | null {
	if (!cost || cost.avgCostMicro === null) return null
	return inventoryValueMinor(Math.max(0, onHand), cost.avgCostMicro)
}

/**
 * Every item at one location with on hand, cost, levels, areas and units, in
 * a handful of unfiltered queries (no `IN` lists, so no chunking needed).
 */
export async function loadLocationStock(
	db: InventoryReader,
	locationId: string,
	options: { includeArchived?: boolean } = {},
): Promise<StockRow[]> {
	const [items, places, placeAreas, units, costs, onHand, counted] =
		await Promise.all([
			options.includeArchived
				? db.select().from(invItems)
				: db.select().from(invItems).where(isNull(invItems.archivedAt)),
			db
				.select()
				.from(invItemPlaces)
				.where(eq(invItemPlaces.locationId, locationId)),
			db
				.select({
					itemId: invItemPlaceAreas.itemId,
					areaId: invItemPlaceAreas.areaId,
					sortOrder: invItemPlaceAreas.sortOrder,
				})
				.from(invItemPlaceAreas)
				.where(eq(invItemPlaceAreas.locationId, locationId))
				.orderBy(invItemPlaceAreas.sortOrder),
			db
				.select()
				.from(invItemUnits)
				.orderBy(invItemUnits.createdAt, sql`rowid`),
			db.select().from(invItemCosts),
			onHandByItem(db, locationId),
			lastCountedMap(db, locationId),
		])
	const placeByItem = new Map(places.map((row) => [row.itemId, row]))
	const areasByItem = new Map<string, string[]>()
	const sortByItem = new Map<string, Map<string, number>>()
	for (const row of placeAreas) {
		const list = areasByItem.get(row.itemId)
		if (list) list.push(row.areaId)
		else areasByItem.set(row.itemId, [row.areaId])
		const sorts = sortByItem.get(row.itemId)
		if (sorts) sorts.set(row.areaId, row.sortOrder)
		else sortByItem.set(row.itemId, new Map([[row.areaId, row.sortOrder]]))
	}
	const unitsByItem = groupUnits(units)
	const costByItem = new Map(costs.map((row) => [row.itemId, row]))
	return items.map((item) => {
		const place = placeByItem.get(item.id) ?? null
		const stock = onHand.get(item.id) ?? 0
		return {
			item,
			place,
			areaIds: areasByItem.get(item.id) ?? [],
			areaSort: sortByItem.get(item.id) ?? new Map(),
			units: unitsByItem.get(item.id) ?? [],
			onHand: stock,
			cost: costByItem.get(item.id) ?? null,
			status: itemStatus(stock, place),
			lastCountedAt: counted.get(item.id) ?? null,
		}
	})
}

/** When each item was last part of an approved count at a location. */
async function lastCountedMap(
	db: InventoryReader,
	locationId: string,
): Promise<Map<string, number>> {
	const rows = await db
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
			),
		)
		.groupBy(invCountEntries.itemId)
	return new Map(rows.map((row) => [row.itemId, Number(row.at)]))
}

export function toItemUnit(unit: ItemUnitRow) {
	return {
		id: unit.id,
		name: unit.name,
		baseQuantity: unit.baseQuantity,
		used: unit.usedAt !== null,
		archived: unit.archivedAt !== null,
	}
}

export function toStockItem(row: StockRow, cost: boolean): StockItem {
	const value = stockValueMinor(row.onHand, row.cost)
	const base: StockItem = {
		id: row.item.id,
		name: row.item.name,
		category: row.item.category,
		kind: row.item.kind,
		baseUnit: row.item.baseUnit,
		archived: row.item.archivedAt !== null,
		version: row.item.version,
		onHand: row.onHand,
		countUnit: row.place?.countUnit ? wireUnit(row.place.countUnit) : null,
		units: row.units.map(toItemUnit),
		areaIds: row.areaIds,
		orderBelowQuantity: row.place?.orderBelowQuantity ?? null,
		fillUpToQuantity: row.place?.fillUpToQuantity ?? null,
		status: row.status,
		lastCountedAt: row.lastCountedAt,
	}
	if (!cost) return base
	base.costMicro = row.cost?.avgCostMicro ?? null
	if (value !== null) base.valueMinor = value
	if (row.cost) base.currency = row.cost.currency
	return base
}

// ── List ────────────────────────────────────────────────────────────────────

export async function listItems(
	db: InventoryReader,
	input: { query: ListItemsQuery; cost: boolean },
) {
	const { query } = input
	const rows = await loadLocationStock(db, query.locationId, {
		includeArchived: query.includeArchived,
	})
	const needle = query.q?.toLowerCase()
	const filtered = rows
		.filter((row) => {
			if (needle && !row.item.name.toLowerCase().includes(needle)) return false
			if (query.category && row.item.category !== query.category) return false
			if (query.areaId && !row.areaIds.includes(query.areaId)) return false
			if (query.status === 'low') return row.status === 'low'
			if (query.status === 'out') return row.status === 'out'
			if (query.status === 'attention') return row.status !== 'ok'
			return true
		})
		.sort(
			(a, b) =>
				a.item.name.toLowerCase().localeCompare(b.item.name.toLowerCase()) ||
				(a.item.id < b.item.id ? -1 : 1),
		)
	const offset = decodeOffsetCursor(query.cursor)
	const page = filtered.slice(offset, offset + query.limit)
	const next = offset + query.limit
	const result: {
		items: StockItem[]
		total: number
		nextCursor: string | null
		totalValueMinor?: number
		currency?: string
	} = {
		items: page.map((row) => toStockItem(row, input.cost)),
		total: filtered.length,
		nextCursor: next < filtered.length ? String(next) : null,
	}
	if (input.cost) {
		let total = 0
		let currency: string | undefined
		for (const row of filtered) {
			total += stockValueMinor(row.onHand, row.cost) ?? 0
			currency ??= row.cost?.currency
		}
		result.totalValueMinor = total
		if (currency) result.currency = currency
	}
	return result
}

// ── Detail ──────────────────────────────────────────────────────────────────

/**
 * One item with places, per-location stock, suppliers and cost. `locationId`
 * picks the location of the stock fields; without it `onHand` is the sum over
 * the locations the token may see.
 */
export async function getItemDetail(
	db: InventoryReader,
	input: {
		itemId: string
		locationId: string | null
		caller: Pick<InventoryCaller, 'locationIds' | 'cost'>
	},
): Promise<ItemDetail> {
	const { itemId, locationId, caller } = input
	const item = await db
		.select()
		.from(invItems)
		.where(eq(invItems.id, itemId))
		.get()
	if (!item) throw notFound()

	const [units, places, placeAreas, costRow, byLocation, counted, products] =
		await Promise.all([
			loadItemUnits(db, [itemId]),
			db.select().from(invItemPlaces).where(eq(invItemPlaces.itemId, itemId)),
			db
				.select()
				.from(invItemPlaceAreas)
				.where(eq(invItemPlaceAreas.itemId, itemId))
				.orderBy(invItemPlaceAreas.sortOrder),
			db
				.select()
				.from(invItemCosts)
				.where(eq(invItemCosts.itemId, itemId))
				.get(),
			onHandByLocation(db, itemId),
			locationId ? lastCountedMap(db, locationId) : Promise.resolve(null),
			db
				.select({
					product: invSupplierProducts,
					supplierName: invSuppliers.name,
				})
				.from(invSupplierProducts)
				.innerJoin(
					invSuppliers,
					eq(invSuppliers.id, invSupplierProducts.supplierId),
				)
				.where(
					and(
						eq(invSupplierProducts.itemId, itemId),
						isNull(invSupplierProducts.archivedAt),
						isNull(invSuppliers.archivedAt),
					),
				),
		])
	const visiblePlaces = places.filter((place) =>
		locationVisible(caller.locationIds, place.locationId),
	)
	const place = locationId
		? (visiblePlaces.find((row) => row.locationId === locationId) ?? null)
		: null
	const visibleStock = [...byLocation.entries()].filter(([id]) =>
		locationVisible(caller.locationIds, id),
	)
	const onHand = locationId
		? (byLocation.get(locationId) ?? 0)
		: visibleStock.reduce((sum, [, qty]) => sum + qty, 0)
	const itemUnits = units.get(itemId) ?? []
	const row: StockRow = {
		item,
		place,
		areaIds: locationId
			? placeAreas
					.filter((entry) => entry.locationId === locationId)
					.map((entry) => entry.areaId)
			: [],
		areaSort: new Map(
			placeAreas
				.filter((entry) => entry.locationId === locationId)
				.map((entry) => [entry.areaId, entry.sortOrder]),
		),
		units: itemUnits,
		onHand,
		cost: costRow ?? null,
		status: itemStatus(onHand, place),
		lastCountedAt: counted?.get(itemId) ?? null,
	}
	const detail: ItemDetail = {
		...toStockItem(row, caller.cost),
		notes: item.notes,
		places: visiblePlaces.map((entry) => ({
			locationId: entry.locationId,
			countUnit: wireUnit(
				entry.countUnit ?? defaultCountUnitFor(item.baseUnit, 'metric'),
			),
			areaIds: placeAreas
				.filter((area) => area.locationId === entry.locationId)
				.map((area) => area.areaId),
			orderBelowQuantity: entry.orderBelowQuantity,
			fillUpToQuantity: entry.fillUpToQuantity,
			version: entry.version,
		})),
		onHandByLocation: [
			...new Set([
				...visibleStock.map(([id]) => id),
				...visiblePlaces.map((entry) => entry.locationId),
			]),
		]
			.sort()
			.map((id) => ({ locationId: id, onHand: byLocation.get(id) ?? 0 })),
		suppliers: products
			.sort(
				(a, b) =>
					Number(b.product.preferred) - Number(a.product.preferred) ||
					a.supplierName.localeCompare(b.supplierName),
			)
			.map(({ product, supplierName }) => {
				const out: ItemDetail['suppliers'][number] = {
					id: product.id,
					supplierId: product.supplierId,
					supplierName,
					packName: product.packName,
					packBaseQuantity: product.packBaseQuantity,
					pricedByWeight: product.pricedByWeight,
					preferred: product.preferred,
				}
				if (caller.cost && product.priceMinor !== null) {
					out.priceMinor = product.priceMinor
					if (product.currency) out.currency = product.currency
				}
				return out
			}),
		hasMovements: byLocation.size > 0,
	}
	if (caller.cost) {
		detail.cost = costRow
			? {
					lastCostMicro: costRow.lastCostMicro,
					lastPricedAt: costRow.lastPricedAt,
					avgCostMicro: costRow.avgCostMicro,
					currency: costRow.currency,
					history: await costHistory(db, itemId),
				}
			: null
	}
	return detail
}

function defaultCountUnitFor(base: InventoryBaseUnit, system: UnitSystem) {
	return defaultCountUnit(base, system)
}

/** Delivered cost per base unit over time, newest last (max 24). */
async function costHistory(db: InventoryReader, itemId: string) {
	const rows = await db
		.select({
			at: invDeliveries.receivedAt,
			createdAt: invDeliveryLines.createdAt,
			quantity: invDeliveryLines.quantity,
			total: invDeliveryLines.lineTotalMinor,
		})
		.from(invDeliveryLines)
		.innerJoin(invDeliveries, eq(invDeliveries.id, invDeliveryLines.deliveryId))
		.where(
			and(
				eq(invDeliveryLines.itemId, itemId),
				eq(invDeliveries.status, 'received'),
			),
		)
		.orderBy(desc(invDeliveryLines.createdAt), desc(invDeliveryLines.id))
		.limit(24)
	return rows
		.filter((row) => row.quantity > 0)
		.map((row) => ({
			at: row.at ?? row.createdAt,
			costMicro: costMicroFromPackPrice(row.total, row.quantity),
		}))
		.reverse()
}

// ── Create and edit ─────────────────────────────────────────────────────────

async function assertItemLimit(tx: InventoryTx, extra: number): Promise<void> {
	const row = await tx
		.select({ n: count() })
		.from(invItems)
		.where(isNull(invItems.archivedAt))
		.get()
	if (Number(row?.n ?? 0) + extra > INVENTORY_LIMITS.items) {
		throw new InventoryError('limit_reached', 409)
	}
}

async function loadActiveItem(
	db: InventoryReader,
	itemId: string,
	options: { archived?: boolean } = {},
): Promise<ItemRow> {
	const item = await db
		.select()
		.from(invItems)
		.where(eq(invItems.id, itemId))
		.get()
	if (!item) throw notFound()
	if (!options.archived && item.archivedAt !== null) throw notFound()
	return item
}

/** Active storage areas of a location out of `areaIds`; any other id is a 404. */
async function assertAreasAtLocation(
	db: InventoryReader,
	locationId: string,
	areaIds: readonly string[],
): Promise<void> {
	const unique = [...new Set(areaIds)]
	if (unique.length === 0) return
	const rows = await queryInChunks(unique, (chunk) =>
		db
			.select({ id: invStorageAreas.id })
			.from(invStorageAreas)
			.where(
				and(
					inArray(invStorageAreas.id, chunk),
					eq(invStorageAreas.locationId, locationId),
					isNull(invStorageAreas.archivedAt),
				),
			),
	)
	if (rows.length !== unique.length) throw notFound()
}

function assertLevels(
	orderBelow: number | null,
	fillUpTo: number | null,
): void {
	if (orderBelow !== null && fillUpTo !== null && fillUpTo < orderBelow) {
		throw badRequest('levels')
	}
}

/** Writes the place row and its areas (kept in the order given, after any it already had). */
async function writePlace(
	tx: InventoryTx,
	input: {
		itemId: string
		locationId: string
		countUnit: string
		areaIds: readonly string[]
		orderBelowQuantity: number | null
		fillUpToQuantity: number | null
		existing: PlaceRow | null
		now: number
	},
): Promise<PlaceRow> {
	const areaIds = [...new Set(input.areaIds)]
	const version = (input.existing?.version ?? 0) + 1
	const values = {
		countUnit: input.countUnit,
		orderBelowQuantity: input.orderBelowQuantity,
		fillUpToQuantity: input.fillUpToQuantity,
		version,
		updatedAt: input.now,
	}
	if (input.existing) {
		await tx
			.update(invItemPlaces)
			.set(values)
			.where(
				and(
					eq(invItemPlaces.itemId, input.itemId),
					eq(invItemPlaces.locationId, input.locationId),
				),
			)
	} else {
		await tx.insert(invItemPlaces).values({
			itemId: input.itemId,
			locationId: input.locationId,
			createdAt: input.now,
			...values,
		})
	}
	const current = await tx
		.select()
		.from(invItemPlaceAreas)
		.where(
			and(
				eq(invItemPlaceAreas.itemId, input.itemId),
				eq(invItemPlaceAreas.locationId, input.locationId),
			),
		)
	const keep = new Set(areaIds)
	const drop = current.filter((row) => !keep.has(row.areaId))
	await forEachInChunks(
		drop.map((row) => row.areaId),
		(chunk) =>
			tx
				.delete(invItemPlaceAreas)
				.where(
					and(
						eq(invItemPlaceAreas.itemId, input.itemId),
						eq(invItemPlaceAreas.locationId, input.locationId),
						inArray(invItemPlaceAreas.areaId, chunk),
					),
				),
	)
	const have = new Set(current.map((row) => row.areaId))
	for (const areaId of areaIds) {
		if (have.has(areaId)) continue
		const last = await tx
			.select({
				max: sql<number>`coalesce(max(${invItemPlaceAreas.sortOrder}), -1)`,
			})
			.from(invItemPlaceAreas)
			.where(
				and(
					eq(invItemPlaceAreas.locationId, input.locationId),
					eq(invItemPlaceAreas.areaId, areaId),
				),
			)
			.get()
		await tx.insert(invItemPlaceAreas).values({
			itemId: input.itemId,
			locationId: input.locationId,
			areaId,
			sortOrder: Number(last?.max ?? -1) + 1,
		})
	}
	return {
		itemId: input.itemId,
		locationId: input.locationId,
		countUnit: input.countUnit,
		orderBelowQuantity: input.orderBelowQuantity,
		fillUpToQuantity: input.fillUpToQuantity,
		version,
		createdAt: input.existing?.createdAt ?? input.now,
		updatedAt: input.now,
	}
}

export async function createItem(
	caller: InventoryCaller,
	input: {
		body: CreateItemInput
		idempotency: InventoryIdempotency
		/** Location for the response's stock fields. */
		locationId: string | null
	},
): Promise<ItemDetail> {
	const { body } = input
	return withInventoryWrite(
		{ orgId: caller.orgId, idempotency: input.idempotency },
		async (tx, ctx) => {
			await assertItemLimit(tx, 1)
			const itemId = newId()
			await tx.insert(invItems).values({
				id: itemId,
				name: body.name,
				category: body.category,
				kind: body.kind,
				baseUnit: body.baseUnit,
				notes: body.notes?.length ? body.notes : null,
				createdAt: ctx.now,
				updatedAt: ctx.now,
			})
			const newUnitIds: string[] = []
			for (const unit of body.units ?? []) {
				const unitId = newId()
				newUnitIds.push(unitId)
				await tx.insert(invItemUnits).values({
					id: unitId,
					itemId,
					name: unit.name,
					baseQuantity: unit.baseQuantity,
					createdAt: ctx.now,
				})
			}
			if (body.place) {
				assertLocationAllowed(caller.locationIds, body.place.locationId)
				assertLevels(body.place.orderBelowQuantity, body.place.fillUpToQuantity)
				await assertAreasAtLocation(
					tx,
					body.place.locationId,
					body.place.areaIds,
				)
				const ref = body.place.countUnit.startsWith('new:')
					? newUnitRef(body.place.countUnit, newUnitIds)
					: body.place.countUnit
				const units = (await loadItemUnits(tx, [itemId])).get(itemId) ?? []
				resolveQuantityUnit(ref, body.baseUnit, units)
				await writePlace(tx, {
					itemId,
					locationId: body.place.locationId,
					countUnit: storedUnit(ref),
					areaIds: body.place.areaIds,
					orderBelowQuantity: body.place.orderBelowQuantity,
					fillUpToQuantity: body.place.fillUpToQuantity,
					existing: null,
					now: ctx.now,
				})
			}
			if (body.supplierProduct) {
				if (!caller.purchasing) {
					throw new InventoryError('forbidden', 403, {
						reason: 'grant',
						required: 'update:inventory_purchasing:any',
					})
				}
				const supplier = await tx
					.select()
					.from(invSuppliers)
					.where(eq(invSuppliers.id, body.supplierProduct.supplierId))
					.get()
				if (!supplier || supplier.archivedAt !== null) throw notFound()
				await tx.insert(invSupplierProducts).values({
					supplierId: supplier.id,
					itemId,
					packName: body.supplierProduct.packName,
					packBaseQuantity: body.supplierProduct.packBaseQuantity,
					priceMinor: body.supplierProduct.priceMinor,
					currency: body.supplierProduct.currency,
					pricedByWeight: body.supplierProduct.pricedByWeight,
					preferred: true,
					createdAt: ctx.now,
					updatedAt: ctx.now,
				})
			}
			await recordInventoryAudit(tx, {
				actorKind: caller.actor.kind,
				actorId: caller.actor.id,
				action: 'item.create',
				resourceType: 'item',
				resourceId: itemId,
				locationId: body.place?.locationId ?? null,
				detail: { baseUnit: body.baseUnit, kind: body.kind },
				at: ctx.now,
			})
			return getItemDetail(tx, {
				itemId,
				locationId: input.locationId ?? body.place?.locationId ?? null,
				caller,
			})
		},
	)
}

function newUnitRef(ref: string, ids: readonly string[]): string {
	const index = Number(ref.slice(4))
	const id = ids[index]
	if (!id) throw badRequest('unit')
	return `unit:${id}`
}

export async function updateItem(
	caller: InventoryCaller,
	input: { itemId: string; body: UpdateItemInput; locationId: string | null },
): Promise<ItemDetail> {
	return withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const item = await loadActiveItem(tx, input.itemId)
		assertVersion(item.version, input.body.expectedVersion)
		const { body } = input
		const changed: string[] = []
		const set: Partial<typeof invItems.$inferInsert> = {
			version: item.version + 1,
			updatedAt: ctx.now,
		}
		if (body.name !== undefined && body.name !== item.name) {
			set.name = body.name
			changed.push('name')
		}
		if (body.category !== undefined && body.category !== item.category) {
			set.category = body.category
			changed.push('category')
		}
		if (body.notes !== undefined) {
			set.notes = body.notes?.length ? body.notes : null
			changed.push('notes')
		}
		if (body.baseUnit !== undefined && body.baseUnit !== item.baseUnit) {
			const used = await tx
				.select({ id: invMovements.id })
				.from(invMovements)
				.where(eq(invMovements.itemId, item.id))
				.limit(1)
				.get()
			if (used) throw new InventoryError('unit_in_use', 409)
			const places = await tx
				.select({ countUnit: invItemPlaces.countUnit })
				.from(invItemPlaces)
				.where(eq(invItemPlaces.itemId, item.id))
			for (const place of places) {
				if (
					place.countUnit &&
					place.countUnit in STANDARD_UNIT_SPECS &&
					STANDARD_UNIT_SPECS[
						place.countUnit as keyof typeof STANDARD_UNIT_SPECS
					].base !== body.baseUnit
				) {
					throw new InventoryError('unit_mismatch', 400)
				}
			}
			set.baseUnit = body.baseUnit
			changed.push('baseUnit')
		}
		await tx.update(invItems).set(set).where(eq(invItems.id, item.id))
		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: 'item.update',
			resourceType: 'item',
			resourceId: item.id,
			detail: { fields: changed.join(',') },
			at: ctx.now,
		})
		return getItemDetail(tx, {
			itemId: item.id,
			locationId: input.locationId,
			caller,
		})
	})
}

export async function setItemArchived(
	caller: InventoryCaller,
	input: {
		itemId: string
		expectedVersion: number
		archived: boolean
		locationId: string | null
	},
): Promise<ItemDetail> {
	return withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const item = await loadActiveItem(tx, input.itemId, { archived: true })
		assertVersion(item.version, input.expectedVersion)
		if ((item.archivedAt !== null) === input.archived) {
			throw stateConflict(input.archived ? 'already_archived' : 'not_archived')
		}
		await tx
			.update(invItems)
			.set({
				archivedAt: input.archived ? ctx.now : null,
				version: item.version + 1,
				updatedAt: ctx.now,
			})
			.where(eq(invItems.id, item.id))
		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: input.archived ? 'item.archive' : 'item.restore',
			resourceType: 'item',
			resourceId: item.id,
			at: ctx.now,
		})
		return getItemDetail(tx, {
			itemId: item.id,
			locationId: input.locationId,
			caller,
		})
	})
}

export async function addItemUnit(
	caller: InventoryCaller,
	input: { itemId: string; body: ItemUnitInput; locationId: string | null },
): Promise<ItemDetail> {
	return withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const item = await loadActiveItem(tx, input.itemId)
		const active = await tx
			.select({ n: count() })
			.from(invItemUnits)
			.where(
				and(eq(invItemUnits.itemId, item.id), isNull(invItemUnits.archivedAt)),
			)
			.get()
		if (Number(active?.n ?? 0) >= INVENTORY_LIMITS.unitsPerItem) {
			throw new InventoryError('limit_reached', 409)
		}
		const unitId = newId()
		await tx.insert(invItemUnits).values({
			id: unitId,
			itemId: item.id,
			name: input.body.name,
			baseQuantity: input.body.baseQuantity,
			createdAt: ctx.now,
		})
		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: 'item.unit_add',
			resourceType: 'item',
			resourceId: item.id,
			detail: { unitId, baseQuantity: input.body.baseQuantity },
			at: ctx.now,
		})
		return getItemDetail(tx, {
			itemId: item.id,
			locationId: input.locationId,
			caller,
		})
	})
}

export async function putItemPlace(
	caller: InventoryCaller,
	input: { itemId: string; locationId: string; body: PutItemPlaceInput },
) {
	assertLocationAllowed(caller.locationIds, input.locationId)
	return withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const item = await loadActiveItem(tx, input.itemId)
		const existing =
			(await tx
				.select()
				.from(invItemPlaces)
				.where(
					and(
						eq(invItemPlaces.itemId, item.id),
						eq(invItemPlaces.locationId, input.locationId),
					),
				)
				.get()) ?? null
		assertVersion(existing?.version ?? 0, input.body.expectedVersion)
		assertLevels(input.body.orderBelowQuantity, input.body.fillUpToQuantity)
		await assertAreasAtLocation(tx, input.locationId, input.body.areaIds)
		const units = (await loadItemUnits(tx, [item.id])).get(item.id) ?? []
		resolveQuantityUnit(input.body.countUnit, item.baseUnit, units)
		const place = await writePlace(tx, {
			itemId: item.id,
			locationId: input.locationId,
			countUnit: storedUnit(input.body.countUnit),
			areaIds: input.body.areaIds,
			orderBelowQuantity: input.body.orderBelowQuantity,
			fillUpToQuantity: input.body.fillUpToQuantity,
			existing,
			now: ctx.now,
		})
		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: 'item.place',
			resourceType: 'item',
			resourceId: item.id,
			locationId: input.locationId,
			detail: {
				orderBelowQuantity: place.orderBelowQuantity,
				fillUpToQuantity: place.fillUpToQuantity,
				version: place.version,
			},
			at: ctx.now,
		})
		const areas = await tx
			.select({ areaId: invItemPlaceAreas.areaId })
			.from(invItemPlaceAreas)
			.where(
				and(
					eq(invItemPlaceAreas.itemId, item.id),
					eq(invItemPlaceAreas.locationId, input.locationId),
				),
			)
			.orderBy(invItemPlaceAreas.sortOrder)
		return {
			locationId: input.locationId,
			countUnit: wireUnit(place.countUnit ?? input.body.countUnit),
			areaIds: areas.map((row) => row.areaId),
			orderBelowQuantity: place.orderBelowQuantity,
			fillUpToQuantity: place.fillUpToQuantity,
			version: place.version,
		}
	})
}

// ── Bulk create ─────────────────────────────────────────────────────────────

export async function bulkCreateItems(
	caller: InventoryCaller,
	input: { body: BulkCreateItemsInput; idempotency: InventoryIdempotency },
) {
	const { body } = input
	assertLocationAllowed(caller.locationIds, body.locationId)
	return withInventoryWrite(
		{ orgId: caller.orgId, idempotency: input.idempotency },
		async (tx, ctx) => {
			const settings = await getInventorySettings(tx, caller.region)
			const existingItems = await tx
				.select({ name: invItems.name })
				.from(invItems)
				.where(isNull(invItems.archivedAt))
			const taken = new Set(existingItems.map((row) => row.name.toLowerCase()))
			const seen = new Set<string>()
			const created: Array<{ id: string; name: string }> = []
			const skipped: Array<{ name: string; reason: 'exists' | 'duplicate' }> =
				[]
			const todo: Array<BulkCreateItemsInput['items'][number]> = []
			for (const entry of body.items) {
				const key = entry.name.toLowerCase()
				if (taken.has(key)) skipped.push({ name: entry.name, reason: 'exists' })
				else if (seen.has(key)) {
					skipped.push({ name: entry.name, reason: 'duplicate' })
				} else {
					seen.add(key)
					todo.push(entry)
				}
			}
			if (existingItems.length + todo.length > INVENTORY_LIMITS.items) {
				throw new InventoryError('limit_reached', 409)
			}

			// Storage areas by name (case-insensitive), created when missing.
			const areas = await tx
				.select()
				.from(invStorageAreas)
				.where(
					and(
						eq(invStorageAreas.locationId, body.locationId),
						isNull(invStorageAreas.archivedAt),
					),
				)
			const areaByName = new Map(
				areas.map((area) => [area.name.toLowerCase(), area.id]),
			)
			let nextSort =
				areas.reduce((max, area) => Math.max(max, area.sortOrder), -1) + 1
			let areaCount = areas.length
			let areasCreated = 0

			for (const entry of todo) {
				const itemId = newId()
				await tx.insert(invItems).values({
					id: itemId,
					name: entry.name,
					category: entry.category,
					kind: entry.kind,
					baseUnit: entry.baseUnit,
					createdAt: ctx.now,
					updatedAt: ctx.now,
				})
				const countUnit =
					entry.countUnit ??
					defaultCountUnit(entry.baseUnit, settings.unitSystem)
				resolveQuantityUnit(countUnit, entry.baseUnit, [])
				let areaIds: string[] = []
				if (entry.areaName) {
					const key = entry.areaName.toLowerCase()
					let areaId = areaByName.get(key)
					if (!areaId) {
						if (areaCount >= INVENTORY_LIMITS.storageAreasPerLocation) {
							throw new InventoryError('limit_reached', 409)
						}
						areaId = newId()
						await tx.insert(invStorageAreas).values({
							id: areaId,
							locationId: body.locationId,
							name: entry.areaName,
							sortOrder: nextSort++,
							createdAt: ctx.now,
							updatedAt: ctx.now,
						})
						areaByName.set(key, areaId)
						areaCount++
						areasCreated++
					}
					areaIds = [areaId]
				}
				await writePlace(tx, {
					itemId,
					locationId: body.locationId,
					countUnit: storedUnit(countUnit),
					areaIds,
					orderBelowQuantity: null,
					fillUpToQuantity: null,
					existing: null,
					now: ctx.now,
				})
				if (entry.costMicro !== undefined) {
					if (!entry.currency) throw badRequest('currency')
					await tx.insert(invItemCosts).values({
						itemId,
						currency: entry.currency,
						lastCostMicro: entry.costMicro,
						lastPricedAt: ctx.now,
						avgCostMicro: entry.costMicro,
						updatedAt: ctx.now,
					})
				}
				created.push({ id: itemId, name: entry.name })
			}
			await recordInventoryAudit(tx, {
				actorKind: caller.actor.kind,
				actorId: caller.actor.id,
				action: 'item.bulk_create',
				resourceType: 'item',
				resourceId: body.clientId,
				locationId: body.locationId,
				detail: {
					created: created.length,
					skipped: skipped.length,
					areasCreated,
				},
				at: ctx.now,
			})
			return { created, skipped, areasCreated }
		},
	)
}

// ── Adjust and movements ────────────────────────────────────────────────────

export async function adjustStock(
	caller: InventoryCaller,
	input: { itemId: string; body: AdjustStockInput },
) {
	const { body } = input
	assertLocationAllowed(caller.locationIds, body.locationId)
	return withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const item = await loadActiveItem(tx, input.itemId)
		const eventKey = `adjust:${body.clientId}`
		const existing = await tx
			.select()
			.from(invMovements)
			.where(eq(invMovements.eventKey, eventKey))
			.get()
		const onHandNow = async () =>
			(await onHandByItem(tx, body.locationId)).get(item.id) ?? 0
		if (existing) {
			if (
				existing.itemId !== item.id ||
				existing.locationId !== body.locationId ||
				existing.quantity !== body.quantity
			) {
				throw new InventoryError('idempotency_conflict', 409)
			}
			return adjustResult(existing, await onHandNow(), caller.cost)
		}
		const cost = await tx
			.select()
			.from(invItemCosts)
			.where(eq(invItemCosts.itemId, item.id))
			.get()
		const value =
			cost && cost.avgCostMicro !== null
				? inventoryValueMinor(body.quantity, cost.avgCostMicro)
				: null
		const id = newId()
		await tx.insert(invMovements).values({
			id,
			locationId: body.locationId,
			itemId: item.id,
			quantity: body.quantity,
			valueMinor: value,
			currency: value === null ? null : cost!.currency,
			kind: 'adjustment',
			reason: body.reason,
			sourceType: 'adjustment',
			sourceId: id,
			eventKey,
			businessDate: await locationBusinessDate(tx, body.locationId, ctx.now),
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			note: body.note?.length ? body.note : null,
			createdAt: ctx.now,
		})
		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: 'stock.adjust',
			resourceType: 'item',
			resourceId: item.id,
			locationId: body.locationId,
			detail: { quantity: body.quantity, reason: body.reason },
			at: ctx.now,
		})
		const row = {
			id,
			quantity: body.quantity,
			valueMinor: value,
			currency: value === null ? null : cost!.currency,
		}
		return adjustResult(row, await onHandNow(), caller.cost)
	})
}

function adjustResult(
	row: {
		id: string
		quantity: number
		valueMinor: number | null
		currency: string | null
	},
	onHand: number,
	cost: boolean,
) {
	const out: {
		id: string
		quantity: number
		onHand: number
		valueMinor?: number
		currency?: string
	} = { id: row.id, quantity: row.quantity, onHand }
	if (cost && row.valueMinor !== null) {
		out.valueMinor = row.valueMinor
		if (row.currency) out.currency = row.currency
	}
	return out
}

export async function listItemMovements(
	db: InventoryReader,
	input: {
		itemId: string
		locationId: string
		limit: number
		cursor?: string
		cost: boolean
	},
) {
	const item = await db
		.select({ id: invItems.id })
		.from(invItems)
		.where(eq(invItems.id, input.itemId))
		.get()
	if (!item) throw notFound()
	const cursor = decodeCursor(input.cursor)
	const rows = await db
		.select()
		.from(invMovements)
		.where(
			and(
				eq(invMovements.itemId, input.itemId),
				eq(invMovements.locationId, input.locationId),
				cursor
					? or(
							sql`${invMovements.createdAt} < ${cursor.sort}`,
							and(
								eq(invMovements.createdAt, cursor.sort),
								sql`${invMovements.id} < ${cursor.id}`,
							),
						)
					: undefined,
			),
		)
		.orderBy(desc(invMovements.createdAt), desc(invMovements.id))
		.limit(input.limit + 1)
	const page = rows.slice(0, input.limit)
	const last = page.at(-1)
	return {
		movements: page.map((row) => {
			const out: {
				id: string
				kind: typeof row.kind
				quantity: number
				reason: string | null
				note: string | null
				sourceType: string
				sourceId: string | null
				businessDate: string
				actor: { kind: typeof row.actorKind; id: string | null }
				createdAt: number
				valueMinor?: number
				currency?: string
			} = {
				id: row.id,
				kind: row.kind,
				quantity: row.quantity,
				reason: row.reason,
				note: row.note,
				sourceType: row.sourceType,
				sourceId: row.sourceId,
				businessDate: row.businessDate,
				actor: { kind: row.actorKind, id: row.actorId },
				createdAt: row.createdAt,
			}
			if (input.cost && row.valueMinor !== null) {
				out.valueMinor = row.valueMinor
				if (row.currency) out.currency = row.currency
			}
			return out
		}),
		nextCursor:
			rows.length > input.limit && last
				? encodeCursor(last.createdAt, last.id)
				: null,
	}
}
