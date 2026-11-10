import {
	INVENTORY_LIMITS,
	type CountList,
	type StorageArea,
} from '@repo/inventory'
import {
	invCountListItems,
	invCountLists,
	invItemPlaceAreas,
	invItems,
	invStorageAreas,
} from '@repo/tenant-db'
import { and, asc, count, eq, inArray, isNull } from 'drizzle-orm'
import { insertRowsInChunks, queryInChunks } from '../lib/chunked-in.ts'
import { InventoryError } from '../lib/inventory-http.ts'
import {
	type InventoryReader,
	type InventoryTx,
	withInventoryWrite,
} from '../lib/inventory-write.ts'
import {
	type CreateCountListInput,
	type CreateStorageAreaInput,
	type UpdateCountListInput,
} from './inventory-contract-types.ts'
import { recordInventoryAudit } from './inventory-audit.ts'
import {
	assertLocationAllowed,
	assertVersion,
	badRequest,
	newId,
	notFound,
} from './inventory-common.ts'
import { type InventoryCaller } from './inventory-items-service.ts'

type AreaRow = typeof invStorageAreas.$inferSelect

function toArea(row: AreaRow, itemCount: number): StorageArea {
	return {
		id: row.id,
		locationId: row.locationId,
		name: row.name,
		sortOrder: row.sortOrder,
		itemCount,
		version: row.version,
	}
}

async function areaItemCounts(
	db: InventoryReader,
	locationId: string,
): Promise<Map<string, number>> {
	const rows = await db
		.select({ areaId: invItemPlaceAreas.areaId, n: count() })
		.from(invItemPlaceAreas)
		.innerJoin(invItems, eq(invItems.id, invItemPlaceAreas.itemId))
		.where(
			and(
				eq(invItemPlaceAreas.locationId, locationId),
				isNull(invItems.archivedAt),
			),
		)
		.groupBy(invItemPlaceAreas.areaId)
	return new Map(rows.map((row) => [row.areaId, Number(row.n)]))
}

async function loadArea(db: InventoryReader, id: string): Promise<AreaRow> {
	const row = await db
		.select()
		.from(invStorageAreas)
		.where(eq(invStorageAreas.id, id))
		.get()
	if (!row || row.archivedAt !== null) throw notFound()
	return row
}

export async function listStorageAreas(
	db: InventoryReader,
	locationId: string,
) {
	const [rows, counts] = await Promise.all([
		db
			.select()
			.from(invStorageAreas)
			.where(
				and(
					eq(invStorageAreas.locationId, locationId),
					isNull(invStorageAreas.archivedAt),
				),
			)
			.orderBy(asc(invStorageAreas.sortOrder), asc(invStorageAreas.id)),
		areaItemCounts(db, locationId),
	])
	return { areas: rows.map((row) => toArea(row, counts.get(row.id) ?? 0)) }
}

export async function createStorageArea(
	caller: InventoryCaller,
	body: CreateStorageAreaInput,
): Promise<StorageArea> {
	assertLocationAllowed(caller.locationIds, body.locationId)
	return withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const rows = await tx
			.select({ sortOrder: invStorageAreas.sortOrder })
			.from(invStorageAreas)
			.where(
				and(
					eq(invStorageAreas.locationId, body.locationId),
					isNull(invStorageAreas.archivedAt),
				),
			)
		if (rows.length >= INVENTORY_LIMITS.storageAreasPerLocation) {
			throw new InventoryError('limit_reached', 409)
		}
		const id = newId()
		const sortOrder =
			rows.reduce((max, row) => Math.max(max, row.sortOrder), -1) + 1
		await tx.insert(invStorageAreas).values({
			id,
			locationId: body.locationId,
			name: body.name,
			sortOrder,
			createdAt: ctx.now,
			updatedAt: ctx.now,
		})
		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: 'area.create',
			resourceType: 'storage_area',
			resourceId: id,
			locationId: body.locationId,
			at: ctx.now,
		})
		return toArea(
			{
				id,
				locationId: body.locationId,
				name: body.name,
				sortOrder,
				archivedAt: null,
				version: 1,
				createdAt: ctx.now,
				updatedAt: ctx.now,
			},
			0,
		)
	})
}

export async function renameStorageArea(
	caller: InventoryCaller,
	input: { id: string; expectedVersion: number; name: string },
): Promise<StorageArea> {
	return withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const row = await loadArea(tx, input.id)
		assertLocationAllowed(caller.locationIds, row.locationId)
		assertVersion(row.version, input.expectedVersion)
		await tx
			.update(invStorageAreas)
			.set({ name: input.name, version: row.version + 1, updatedAt: ctx.now })
			.where(eq(invStorageAreas.id, row.id))
		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: 'area.rename',
			resourceType: 'storage_area',
			resourceId: row.id,
			locationId: row.locationId,
			at: ctx.now,
		})
		const counts = await areaItemCounts(tx, row.locationId)
		return toArea(
			{
				...row,
				name: input.name,
				version: row.version + 1,
				updatedAt: ctx.now,
			},
			counts.get(row.id) ?? 0,
		)
	})
}

/** The full walking order of a location's areas. */
export async function reorderStorageAreas(
	caller: InventoryCaller,
	input: { locationId: string; areaIds: string[] },
) {
	assertLocationAllowed(caller.locationIds, input.locationId)
	return withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const rows = await tx
			.select({ id: invStorageAreas.id })
			.from(invStorageAreas)
			.where(
				and(
					eq(invStorageAreas.locationId, input.locationId),
					isNull(invStorageAreas.archivedAt),
				),
			)
		const unique = new Set(input.areaIds)
		if (
			unique.size !== input.areaIds.length ||
			rows.length !== unique.size ||
			rows.some((row) => !unique.has(row.id))
		) {
			throw badRequest('areas')
		}
		for (const [index, id] of input.areaIds.entries()) {
			await tx
				.update(invStorageAreas)
				.set({ sortOrder: index, updatedAt: ctx.now })
				.where(eq(invStorageAreas.id, id))
		}
		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: 'area.reorder',
			resourceType: 'storage_area',
			resourceId: input.locationId,
			locationId: input.locationId,
			detail: { areas: input.areaIds.length },
			at: ctx.now,
		})
		return listStorageAreas(tx, input.locationId)
	})
}

/**
 * Sets the shelf order of the items kept in an area. Every id must be an
 * item already kept there; items left out follow, in their current order.
 */
export async function setAreaItemOrder(
	caller: InventoryCaller,
	input: { id: string; itemIds: string[] },
): Promise<StorageArea> {
	return withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const area = await loadArea(tx, input.id)
		assertLocationAllowed(caller.locationIds, area.locationId)
		const kept = await tx
			.select({
				itemId: invItemPlaceAreas.itemId,
				sortOrder: invItemPlaceAreas.sortOrder,
			})
			.from(invItemPlaceAreas)
			.where(
				and(
					eq(invItemPlaceAreas.locationId, area.locationId),
					eq(invItemPlaceAreas.areaId, area.id),
				),
			)
			.orderBy(asc(invItemPlaceAreas.sortOrder))
		const unique = new Set(input.itemIds)
		const keptIds = new Set(kept.map((row) => row.itemId))
		if (
			unique.size !== input.itemIds.length ||
			input.itemIds.some((id) => !keptIds.has(id))
		) {
			throw badRequest('items')
		}
		const order = [
			...input.itemIds,
			...kept.map((row) => row.itemId).filter((id) => !unique.has(id)),
		]
		for (const [index, itemId] of order.entries()) {
			await tx
				.update(invItemPlaceAreas)
				.set({ sortOrder: index })
				.where(
					and(
						eq(invItemPlaceAreas.locationId, area.locationId),
						eq(invItemPlaceAreas.areaId, area.id),
						eq(invItemPlaceAreas.itemId, itemId),
					),
				)
		}
		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: 'area.item_order',
			resourceType: 'storage_area',
			resourceId: area.id,
			locationId: area.locationId,
			detail: { items: order.length },
			at: ctx.now,
		})
		const counts = await areaItemCounts(tx, area.locationId)
		return toArea(area, counts.get(area.id) ?? 0)
	})
}

/** Archives an area; items kept only there move to "Not in an area". */
export async function archiveStorageArea(
	caller: InventoryCaller,
	input: { id: string; expectedVersion: number },
): Promise<StorageArea> {
	return withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const row = await loadArea(tx, input.id)
		assertLocationAllowed(caller.locationIds, row.locationId)
		assertVersion(row.version, input.expectedVersion)
		await tx
			.delete(invItemPlaceAreas)
			.where(
				and(
					eq(invItemPlaceAreas.locationId, row.locationId),
					eq(invItemPlaceAreas.areaId, row.id),
				),
			)
		await tx
			.update(invStorageAreas)
			.set({
				archivedAt: ctx.now,
				version: row.version + 1,
				updatedAt: ctx.now,
			})
			.where(eq(invStorageAreas.id, row.id))
		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: 'area.archive',
			resourceType: 'storage_area',
			resourceId: row.id,
			locationId: row.locationId,
			at: ctx.now,
		})
		return toArea(
			{
				...row,
				archivedAt: ctx.now,
				version: row.version + 1,
				updatedAt: ctx.now,
			},
			0,
		)
	})
}

// ── Count lists ─────────────────────────────────────────────────────────────

type ListRow = typeof invCountLists.$inferSelect

async function listItemIds(
	db: InventoryReader,
	listIds: readonly string[],
): Promise<Map<string, string[]>> {
	const rows = await queryInChunks(listIds, (chunk) =>
		db
			.select()
			.from(invCountListItems)
			.where(inArray(invCountListItems.listId, chunk))
			.orderBy(asc(invCountListItems.sortOrder)),
	)
	const map = new Map<string, string[]>()
	for (const row of rows) {
		const list = map.get(row.listId)
		if (list) list.push(row.itemId)
		else map.set(row.listId, [row.itemId])
	}
	return map
}

function toList(row: ListRow, itemIds: string[]): CountList {
	return {
		id: row.id,
		locationId: row.locationId,
		name: row.name,
		itemIds,
		version: row.version,
	}
}

export async function listCountLists(db: InventoryReader, locationId: string) {
	const rows = await db
		.select()
		.from(invCountLists)
		.where(
			and(
				eq(invCountLists.locationId, locationId),
				isNull(invCountLists.archivedAt),
			),
		)
		.orderBy(asc(invCountLists.name), asc(invCountLists.id))
	const items = await listItemIds(
		db,
		rows.map((row) => row.id),
	)
	return { lists: rows.map((row) => toList(row, items.get(row.id) ?? [])) }
}

async function assertActiveItems(
	db: InventoryReader,
	itemIds: readonly string[],
): Promise<void> {
	const unique = new Set(itemIds)
	if (unique.size !== itemIds.length) throw badRequest('items')
	const rows = await queryInChunks([...unique], (chunk) =>
		db
			.select({ id: invItems.id })
			.from(invItems)
			.where(and(inArray(invItems.id, chunk), isNull(invItems.archivedAt))),
	)
	if (rows.length !== unique.size) throw notFound()
}

async function writeListItems(
	tx: InventoryTx,
	listId: string,
	itemIds: readonly string[],
): Promise<void> {
	await tx.delete(invCountListItems).where(eq(invCountListItems.listId, listId))
	await insertRowsInChunks(
		invCountListItems,
		itemIds.map((itemId, index) => ({ listId, itemId, sortOrder: index })),
		(chunk) => tx.insert(invCountListItems).values(chunk),
	)
}

export async function createCountList(
	caller: InventoryCaller,
	body: CreateCountListInput,
): Promise<CountList> {
	assertLocationAllowed(caller.locationIds, body.locationId)
	return withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const existing = await tx
			.select({ n: count() })
			.from(invCountLists)
			.where(
				and(
					eq(invCountLists.locationId, body.locationId),
					isNull(invCountLists.archivedAt),
				),
			)
			.get()
		if (Number(existing?.n ?? 0) >= INVENTORY_LIMITS.countListsPerLocation) {
			throw new InventoryError('limit_reached', 409)
		}
		await assertActiveItems(tx, body.itemIds)
		const id = newId()
		await tx.insert(invCountLists).values({
			id,
			locationId: body.locationId,
			name: body.name,
			createdAt: ctx.now,
			updatedAt: ctx.now,
		})
		await writeListItems(tx, id, body.itemIds)
		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: 'count_list.create',
			resourceType: 'count_list',
			resourceId: id,
			locationId: body.locationId,
			detail: { items: body.itemIds.length },
			at: ctx.now,
		})
		return toList(
			{
				id,
				locationId: body.locationId,
				name: body.name,
				archivedAt: null,
				version: 1,
				createdAt: ctx.now,
				updatedAt: ctx.now,
			},
			[...body.itemIds],
		)
	})
}

async function loadList(db: InventoryReader, id: string): Promise<ListRow> {
	const row = await db
		.select()
		.from(invCountLists)
		.where(eq(invCountLists.id, id))
		.get()
	if (!row || row.archivedAt !== null) throw notFound()
	return row
}

export async function updateCountList(
	caller: InventoryCaller,
	input: { id: string; body: UpdateCountListInput },
): Promise<CountList> {
	return withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const row = await loadList(tx, input.id)
		assertLocationAllowed(caller.locationIds, row.locationId)
		assertVersion(row.version, input.body.expectedVersion)
		const name = input.body.name ?? row.name
		await tx
			.update(invCountLists)
			.set({ name, version: row.version + 1, updatedAt: ctx.now })
			.where(eq(invCountLists.id, row.id))
		if (input.body.itemIds) {
			await assertActiveItems(tx, input.body.itemIds)
			await writeListItems(tx, row.id, input.body.itemIds)
		}
		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: 'count_list.update',
			resourceType: 'count_list',
			resourceId: row.id,
			locationId: row.locationId,
			at: ctx.now,
		})
		const items = await listItemIds(tx, [row.id])
		return toList(
			{ ...row, name, version: row.version + 1, updatedAt: ctx.now },
			items.get(row.id) ?? [],
		)
	})
}

export async function archiveCountList(
	caller: InventoryCaller,
	input: { id: string; expectedVersion: number },
): Promise<CountList> {
	return withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const row = await loadList(tx, input.id)
		assertLocationAllowed(caller.locationIds, row.locationId)
		assertVersion(row.version, input.expectedVersion)
		await tx
			.update(invCountLists)
			.set({
				archivedAt: ctx.now,
				version: row.version + 1,
				updatedAt: ctx.now,
			})
			.where(eq(invCountLists.id, row.id))
		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: 'count_list.archive',
			resourceType: 'count_list',
			resourceId: row.id,
			locationId: row.locationId,
			at: ctx.now,
		})
		const items = await listItemIds(tx, [row.id])
		return toList(
			{
				...row,
				archivedAt: ctx.now,
				version: row.version + 1,
				updatedAt: ctx.now,
			},
			items.get(row.id) ?? [],
		)
	})
}
