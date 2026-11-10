import { createHash } from 'node:crypto'
import {
	INVENTORY_LIMITS,
	PICKABLE_WASTE_REASONS,
	STATION_PHOTO_MAX_BYTES,
	STATION_RECENT_WASTE_ITEMS,
	INVENTORY_POS_CONTRACT_VERSION,
	stationCatalogSchema,
	stationCountSummarySchema,
	stationExpectedDeliverySchema,
	type StationCatalog,
} from '@repo/inventory'
import {
	invOrders,
	invSupplierProducts,
	invSuppliers,
	invWaste,
	staffMembers,
	staffScopeAssignments,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { queryInChunks } from '../lib/chunked-in.ts'
import {
	type InventoryActor,
	defaultCountUnit,
	wireUnit,
} from './inventory-common.ts'
import { listCounts } from './inventory-counts-service.ts'
import {
	type InventoryCaller,
	loadLocationStock,
	toItemUnit,
} from './inventory-items-service.ts'
import { getReceivePrefill } from './inventory-orders-service.ts'
import { listCountLists, listStorageAreas } from './inventory-places-service.ts'
import { getInventorySettings } from './inventory-settings-service.ts'

/**
 * What the Station Stock app needs from the region that is not a plain call
 * into an operator service: the offline catalogue of one location, and the
 * roster rule that decides whose name an item made earlier may carry.
 */

/** The people who may be named by `madeBy`: active, assigned to the terminal's workplace. */
export async function activeRosterIds(
	db: TenantDatabase,
	scopeId: string,
	staffIds: readonly string[],
): Promise<Set<string>> {
	const rows = await queryInChunks([...new Set(staffIds)], (chunk) =>
		db
			.select({ id: staffMembers.id })
			.from(staffScopeAssignments)
			.innerJoin(
				staffMembers,
				eq(staffMembers.id, staffScopeAssignments.staffId),
			)
			.where(
				and(
					inArray(staffScopeAssignments.staffId, chunk),
					eq(staffScopeAssignments.scopeId, scopeId),
					eq(staffScopeAssignments.active, true),
					eq(staffMembers.status, 'active'),
				),
			),
	)
	return new Set(rows.map((row) => row.id))
}

/**
 * Who an item is attributed to. The tablet may name another person
 * (`madeBy`), accepted only while that person is still on the roster; anyone
 * else, or nobody, is the signed-in person of the session.
 */
export function makeActorResolver(input: {
	sessionStaffId: string
	roster: ReadonlySet<string>
}): (madeBy: string | undefined) => InventoryActor {
	return (madeBy) => ({
		kind: 'staff',
		id:
			madeBy && (madeBy === input.sessionStaffId || input.roster.has(madeBy))
				? madeBy
				: input.sessionStaffId,
	})
}

const OPEN_ORDER_STATUSES_FOR_STATION = ['sent', 'partly_received'] as const

/** Waste kept for the recent-items chips: a few more than shown, since some are undone or gone. */
const RECENT_WASTE_SCAN = 60

export type CatalogInput = {
	orgId: string
	region: 'us' | 'ksa'
	locationId: string
	deviceId: string
	/** The organization's `inventory.purchasing` flag. */
	ordersEnabled: boolean
	anyStaffCanReceive: boolean
	now: number
}

function versionOf(body: Omit<StationCatalog, 'version' | 'generatedAt'>) {
	return `cat-${createHash('sha256')
		.update(JSON.stringify(body))
		.digest('hex')
		.slice(0, 20)}`
}

/**
 * The catalogue of one location (`GET /pos/inventory/catalog`): items the
 * location keeps (or lists for counting, or buys from a supplier), areas in
 * walking order, count lists, counts in progress, suppliers and what they
 * sell (pack sizes, never prices), and the open orders a delivery can
 * receive. No money, no on-hand or counted figures, no supplier contacts: the
 * answer is parsed with the contract's schema, which has no such field.
 */
export async function buildStationCatalog(
	db: TenantDatabase,
	input: CatalogInput,
): Promise<StationCatalog> {
	const { locationId } = input
	const caller: InventoryCaller = {
		orgId: input.orgId,
		region: input.region,
		actor: { kind: 'system', id: null },
		locationIds: [locationId],
		cost: false,
		purchasing: false,
	}
	const [stock, settings, areaList, lists, open, suppliers, products, orders] =
		await Promise.all([
			loadLocationStock(db, locationId),
			getInventorySettings(db, input.region),
			listStorageAreas(db, locationId),
			listCountLists(db, locationId),
			listCounts(db, {
				query: { locationId, status: 'open', limit: 200 },
				caller,
			}),
			db
				.select({ id: invSuppliers.id, name: invSuppliers.name })
				.from(invSuppliers)
				.where(isNull(invSuppliers.archivedAt)),
			db
				.select({
					id: invSupplierProducts.id,
					supplierId: invSupplierProducts.supplierId,
					itemId: invSupplierProducts.itemId,
					packName: invSupplierProducts.packName,
					packBaseQuantity: invSupplierProducts.packBaseQuantity,
					pricedByWeight: invSupplierProducts.pricedByWeight,
				})
				.from(invSupplierProducts)
				.where(isNull(invSupplierProducts.archivedAt))
				.orderBy(
					asc(invSupplierProducts.packName),
					asc(invSupplierProducts.id),
				),
			input.ordersEnabled
				? db
						.select({ id: invOrders.id })
						.from(invOrders)
						.where(
							and(
								eq(invOrders.locationId, locationId),
								inArray(invOrders.status, [...OPEN_ORDER_STATUSES_FOR_STATION]),
							),
						)
						.orderBy(
							sql`${invOrders.expectedDate} is null`,
							asc(invOrders.expectedDate),
							asc(invOrders.number),
						)
						.limit(INVENTORY_LIMITS.openOrdersPerLocation)
				: Promise.resolve([] as Array<{ id: string }>),
		])

	const activeAreas = new Set(areaList.areas.map((area) => area.id))
	const stockById = new Map(stock.map((row) => [row.item.id, row]))

	const expected: StationCatalog['expectedDeliveries'] = []
	for (const order of orders) {
		const prefill = await getReceivePrefill(db, { id: order.id, caller })
		expected.push(
			stationExpectedDeliverySchema.parse({
				orderId: prefill.orderId,
				number: prefill.number,
				supplierId: prefill.supplierId,
				supplierName: prefill.supplierName,
				status: prefill.status,
				expectedDate: prefill.expectedDate,
				lines: prefill.lines,
			}),
		)
	}

	// An item is in the catalogue when this location keeps it, lists it for
	// counting, buys it from a supplier or is waiting on an order.
	const wanted = new Set<string>()
	for (const row of stock) if (row.place) wanted.add(row.item.id)
	for (const list of lists.lists) {
		for (const id of list.itemIds) wanted.add(id)
	}
	for (const product of products) wanted.add(product.itemId)
	for (const delivery of expected) {
		for (const line of delivery.lines) wanted.add(line.itemId)
	}
	const rows = stock
		.filter((row) => wanted.has(row.item.id))
		.sort(
			(a, b) =>
				a.item.name.toLowerCase().localeCompare(b.item.name.toLowerCase()) ||
				(a.item.id < b.item.id ? -1 : 1),
		)
	const inCatalog = new Set(rows.map((row) => row.item.id))

	const items = rows.map((row) => ({
		id: row.item.id,
		name: row.item.name,
		category: row.item.category,
		kind: row.item.kind,
		baseUnit: row.item.baseUnit,
		countUnit: row.place?.countUnit
			? wireUnit(row.place.countUnit)
			: defaultCountUnit(row.item.baseUnit, settings.unitSystem),
		units: row.units.filter((unit) => unit.archivedAt === null).map(toItemUnit),
		areaIds: row.areaIds.filter((id) => activeAreas.has(id)),
	}))

	const areas = areaList.areas.map((area) => ({
		id: area.id,
		name: area.name,
		sortOrder: area.sortOrder,
		itemIds: rows
			.filter((row) => row.areaIds.includes(area.id))
			.sort(
				(a, b) =>
					(a.areaSort.get(area.id) ?? 0) - (b.areaSort.get(area.id) ?? 0) ||
					a.item.name.toLowerCase().localeCompare(b.item.name.toLowerCase()),
			)
			.map((row) => row.item.id),
	}))

	const countLists = lists.lists.map((list) => ({
		id: list.id,
		name: list.name,
		itemIds: list.itemIds.filter((id) => inCatalog.has(id)),
	}))

	const counts = open.counts
		.filter((count) => count.status === 'counting')
		.map((count) => stationCountSummarySchema.parse(count))

	const productsBySupplier = new Map<string, typeof products>()
	for (const product of products) {
		if (!stockById.has(product.itemId)) continue
		const list = productsBySupplier.get(product.supplierId)
		if (list) list.push(product)
		else productsBySupplier.set(product.supplierId, [product])
	}
	const supplierList = [...suppliers]
		.sort(
			(a, b) =>
				a.name.toLowerCase().localeCompare(b.name.toLowerCase()) ||
				(a.id < b.id ? -1 : 1),
		)
		.map((supplier) => ({
			id: supplier.id,
			name: supplier.name,
			products: (productsBySupplier.get(supplier.id) ?? []).map((product) => ({
				id: product.id,
				itemId: product.itemId,
				packName: product.packName,
				packBaseQuantity: product.packBaseQuantity,
				pricedByWeight: product.pricedByWeight,
			})),
		}))

	const body = {
		contractVersion: INVENTORY_POS_CONTRACT_VERSION,
		locationId,
		settings: {
			receiveRequiresManager: !input.anyStaffCanReceive,
			photoMaxBytes: STATION_PHOTO_MAX_BYTES,
			ordersEnabled: input.ordersEnabled,
		},
		items,
		areas,
		countLists,
		counts,
		wasteReasons: [...PICKABLE_WASTE_REASONS],
		recentWasteItemIds: await recentWasteItemIds(db, {
			deviceId: input.deviceId,
			inCatalog,
		}),
		suppliers: supplierList,
		expectedDeliveries: expected,
	}
	return stationCatalogSchema.parse({
		...body,
		version: versionOf(body),
		generatedAt: input.now,
	})
}

/** Items most recently wasted at this terminal, newest first, leaving out what was undone or is gone. */
async function recentWasteItemIds(
	db: TenantDatabase,
	input: { deviceId: string; inCatalog: ReadonlySet<string> },
): Promise<string[]> {
	const rows = await db
		.select({ id: invWaste.id, itemId: invWaste.itemId })
		.from(invWaste)
		.where(
			and(eq(invWaste.deviceId, input.deviceId), isNull(invWaste.reversesId)),
		)
		.orderBy(desc(invWaste.createdAt), desc(invWaste.id))
		.limit(RECENT_WASTE_SCAN)
	const reversed = await queryInChunks(
		rows.map((row) => row.id),
		(chunk) =>
			db
				.select({ reversesId: invWaste.reversesId })
				.from(invWaste)
				.where(inArray(invWaste.reversesId, chunk)),
	)
	const undone = new Set(reversed.map((row) => row.reversesId))
	const recent: string[] = []
	for (const row of rows) {
		if (
			!row.itemId ||
			undone.has(row.id) ||
			!input.inCatalog.has(row.itemId) ||
			recent.includes(row.itemId)
		) {
			continue
		}
		recent.push(row.itemId)
		if (recent.length >= STATION_RECENT_WASTE_ITEMS) break
	}
	return recent
}
