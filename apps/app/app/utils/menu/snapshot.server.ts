import { createId } from '@paralleldrive/cuid2'
import { auditService, AuditAction } from '@repo/audit'
import {
	and,
	db,
	desc,
	eq,
	inArray,
	MenuSnapshot,
	OrganizationMediaAsset,
	OrganizationMenu,
	OrganizationMenuCategory,
	OrganizationMenuCategoryAssignment,
	OrganizationMenuItem,
	OrganizationMenuItemCategoryAssignment,
	OrganizationMenuItemModifierGroupAssignment,
	OrganizationMenuLocationOverride,
	OrganizationMenuModifierGroup,
	OrganizationMenuModifierGroupOptionAssignment,
	OrganizationMenuOption,
	OrganizationMenuOptionNestedModifierGroupAssignment,
	OrganizationMenuPosLink,
	type MenuSnapshotReason,
	ConfigFlag,
} from '@repo/database'
import {
	deleteMenuSnapshotJson,
	readMenuSnapshotJson,
	uploadMenuSnapshotJson,
} from '#app/utils/storage.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'
import {
	MENU_SNAPSHOT_VERSION,
	type MenuSnapshotContent,
} from './snapshot-types.ts'

const RESTORE_LOCK_KEY = 'menu.restore_in_progress'
const SNAPSHOT_RETENTION_COUNT = 50
const SNAPSHOT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000

type DbClient = Pick<typeof db, 'select' | 'insert' | 'update' | 'delete'>

function reviveDates<T extends Record<string, unknown>>(row: T): T {
	const out = { ...row }
	for (const key of ['createdAt', 'updatedAt', 'unavailableUntil'] as const) {
		const value = out[key]
		if (typeof value === 'string') {
			out[key] = new Date(value) as T[typeof key]
		}
	}
	return out
}

async function sha256Hex(payload: string) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(payload),
	)
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
}

export async function captureMenuSnapshotContent(
	organizationId: string,
	client: DbClient = db,
): Promise<MenuSnapshotContent> {
	const [
		menus,
		categories,
		menuCategoryAssignments,
		items,
		itemCategoryAssignments,
		modifierGroups,
		itemModifierGroupAssignments,
		options,
		modifierGroupOptionAssignments,
		optionNestedModifierGroupAssignments,
		locationOverrides,
		posLinks,
	] = await Promise.all([
		client
			.select()
			.from(OrganizationMenu)
			.where(eq(OrganizationMenu.organizationId, organizationId)),
		client
			.select()
			.from(OrganizationMenuCategory)
			.where(eq(OrganizationMenuCategory.organizationId, organizationId)),
		client
			.select({
				row: OrganizationMenuCategoryAssignment,
			})
			.from(OrganizationMenuCategoryAssignment)
			.innerJoin(
				OrganizationMenu,
				eq(OrganizationMenuCategoryAssignment.menuId, OrganizationMenu.id),
			)
			.where(eq(OrganizationMenu.organizationId, organizationId))
			.then((rows) => rows.map((entry) => entry.row)),
		client
			.select()
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.organizationId, organizationId)),
		client
			.select({ row: OrganizationMenuItemCategoryAssignment })
			.from(OrganizationMenuItemCategoryAssignment)
			.innerJoin(
				OrganizationMenuItem,
				eq(OrganizationMenuItemCategoryAssignment.itemId, OrganizationMenuItem.id),
			)
			.where(eq(OrganizationMenuItem.organizationId, organizationId))
			.then((rows) => rows.map((entry) => entry.row)),
		client
			.select()
			.from(OrganizationMenuModifierGroup)
			.where(eq(OrganizationMenuModifierGroup.organizationId, organizationId)),
		client
			.select({ row: OrganizationMenuItemModifierGroupAssignment })
			.from(OrganizationMenuItemModifierGroupAssignment)
			.innerJoin(
				OrganizationMenuItem,
				eq(
					OrganizationMenuItemModifierGroupAssignment.itemId,
					OrganizationMenuItem.id,
				),
			)
			.where(eq(OrganizationMenuItem.organizationId, organizationId))
			.then((rows) => rows.map((entry) => entry.row)),
		client
			.select()
			.from(OrganizationMenuOption)
			.where(eq(OrganizationMenuOption.organizationId, organizationId)),
		client
			.select({ row: OrganizationMenuModifierGroupOptionAssignment })
			.from(OrganizationMenuModifierGroupOptionAssignment)
			.innerJoin(
				OrganizationMenuModifierGroup,
				eq(
					OrganizationMenuModifierGroupOptionAssignment.modifierGroupId,
					OrganizationMenuModifierGroup.id,
				),
			)
			.where(eq(OrganizationMenuModifierGroup.organizationId, organizationId))
			.then((rows) => rows.map((entry) => entry.row)),
		client
			.select({ row: OrganizationMenuOptionNestedModifierGroupAssignment })
			.from(OrganizationMenuOptionNestedModifierGroupAssignment)
			.innerJoin(
				OrganizationMenuOption,
				eq(
					OrganizationMenuOptionNestedModifierGroupAssignment.optionId,
					OrganizationMenuOption.id,
				),
			)
			.where(eq(OrganizationMenuOption.organizationId, organizationId))
			.then((rows) => rows.map((entry) => entry.row)),
		client
			.select()
			.from(OrganizationMenuLocationOverride)
			.where(eq(OrganizationMenuLocationOverride.organizationId, organizationId)),
		client
			.select()
			.from(OrganizationMenuPosLink)
			.where(eq(OrganizationMenuPosLink.organizationId, organizationId)),
	])

	return {
		version: MENU_SNAPSHOT_VERSION,
		menus,
		categories,
		menuCategoryAssignments,
		items,
		itemCategoryAssignments,
		modifierGroups,
		itemModifierGroupAssignments,
		options,
		modifierGroupOptionAssignments,
		optionNestedModifierGroupAssignments,
		locationOverrides,
		posLinks,
	}
}

export async function createMenuSnapshot({
	organizationId,
	reason,
	userId,
	label,
	client = db,
}: {
	organizationId: string
	reason: MenuSnapshotReason | string
	userId: string | null
	label?: string | null
	client?: DbClient
}) {
	const content = await captureMenuSnapshotContent(organizationId, client)
	const json = JSON.stringify(content)
	const contentHash = await sha256Hex(json)
	const snapshotId = createId()
	const contentKey = await uploadMenuSnapshotJson(
		organizationId,
		snapshotId,
		json,
	)
	const [row] = await client
		.insert(MenuSnapshot)
		.values({
			id: snapshotId,
			organizationId,
			reason,
			label: label ?? null,
			createdById: userId,
			itemCount: content.items.length,
			contentKey,
			contentHash,
		})
		.returning({ id: MenuSnapshot.id })
	return row?.id ?? snapshotId
}

export class MenuSnapshotError extends Error {
	constructor(
		readonly code:
			| 'not_found'
			| 'restore_in_progress'
			| 'content_missing'
			| 'invalid_content',
	) {
		super(code)
		this.name = 'MenuSnapshotError'
	}
}

export async function loadMenuSnapshotContent(
	snapshotId: string,
	organizationId: string,
) {
	const [row] = await db
		.select()
		.from(MenuSnapshot)
		.where(
			and(
				eq(MenuSnapshot.id, snapshotId),
				eq(MenuSnapshot.organizationId, organizationId),
			),
		)
		.limit(1)
	if (!row) throw new MenuSnapshotError('not_found')
	const json = await readMenuSnapshotJson(row.contentKey)
	if (!json) throw new MenuSnapshotError('content_missing')
	let parsed: unknown
	try {
		parsed = JSON.parse(json)
	} catch {
		throw new MenuSnapshotError('invalid_content')
	}
	return {
		meta: row,
		content: parsed as MenuSnapshotContent,
	}
}

async function assertRestoreLockFree(organizationId: string) {
	const [row] = await db
		.select({ value: ConfigFlag.value })
		.from(ConfigFlag)
		.where(
			and(
				eq(ConfigFlag.key, RESTORE_LOCK_KEY),
				eq(ConfigFlag.level, 'organization'),
				eq(ConfigFlag.organizationId, organizationId),
			),
		)
		.limit(1)
	if (String(row?.value) === 'true') throw new MenuSnapshotError('restore_in_progress')
}

async function setRestoreLock(organizationId: string, locked: boolean) {
	if (locked) {
		await db.insert(ConfigFlag).values({
			key: RESTORE_LOCK_KEY,
			value: 'true',
			level: 'organization',
			organizationId,
		})
		return
	}
	await db
		.delete(ConfigFlag)
		.where(
			and(
				eq(ConfigFlag.key, RESTORE_LOCK_KEY),
				eq(ConfigFlag.level, 'organization'),
				eq(ConfigFlag.organizationId, organizationId),
			),
		)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function upsertTable(tx: typeof db, table: any, rows: Record<string, unknown>[]) {
	for (const row of rows) {
		const values = reviveDates(row)
		await tx
			.insert(table)
			.values(values)
			.onConflictDoUpdate({
				target: table.id,
				set: values,
			})
	}
}

async function removeAddedRecords(
	tx: typeof db,
	organizationId: string,
	content: MenuSnapshotContent,
) {
	const menuIds = new Set(content.menus.map((row) => row.id))
	const categoryIds = new Set(content.categories.map((row) => row.id))
	const itemIds = new Set(content.items.map((row) => row.id))
	const groupIds = new Set(content.modifierGroups.map((row) => row.id))
	const optionIds = new Set(content.options.map((row) => row.id))

	const assignmentFilters = async (
		table: typeof OrganizationMenuCategoryAssignment,
		snapIds: Set<string>,
		liveJoin: () => Promise<string[]>,
	) => {
		const live = await liveJoin()
		const remove = live.filter((id) => !snapIds.has(id))
		if (remove.length > 0) {
			await tx.delete(table).where(inArray(table.id, remove))
		}
	}

	const snapMenuCategory = new Set(content.menuCategoryAssignments.map((r) => r.id))
	await assignmentFilters(
		OrganizationMenuCategoryAssignment,
		snapMenuCategory,
		async () => {
			const rows = await tx
				.select({ id: OrganizationMenuCategoryAssignment.id })
				.from(OrganizationMenuCategoryAssignment)
				.innerJoin(
					OrganizationMenu,
					eq(OrganizationMenuCategoryAssignment.menuId, OrganizationMenu.id),
				)
				.where(eq(OrganizationMenu.organizationId, organizationId))
			return rows.map((r) => r.id)
		},
	)

	const snapItemCat = new Set(content.itemCategoryAssignments.map((r) => r.id))
	await assignmentFilters(
		OrganizationMenuItemCategoryAssignment,
		snapItemCat,
		async () => {
			const rows = await tx
				.select({ id: OrganizationMenuItemCategoryAssignment.id })
				.from(OrganizationMenuItemCategoryAssignment)
				.innerJoin(
					OrganizationMenuItem,
					eq(OrganizationMenuItemCategoryAssignment.itemId, OrganizationMenuItem.id),
				)
				.where(eq(OrganizationMenuItem.organizationId, organizationId))
			return rows.map((r) => r.id)
		},
	)

	const snapItemGroup = new Set(
		content.itemModifierGroupAssignments.map((r) => r.id),
	)
	await assignmentFilters(
		OrganizationMenuItemModifierGroupAssignment,
		snapItemGroup,
		async () => {
			const rows = await tx
				.select({ id: OrganizationMenuItemModifierGroupAssignment.id })
				.from(OrganizationMenuItemModifierGroupAssignment)
				.innerJoin(
					OrganizationMenuItem,
					eq(OrganizationMenuItemModifierGroupAssignment.itemId, OrganizationMenuItem.id),
				)
				.where(eq(OrganizationMenuItem.organizationId, organizationId))
			return rows.map((r) => r.id)
		},
	)

	const snapGroupOpt = new Set(
		content.modifierGroupOptionAssignments.map((r) => r.id),
	)
	await assignmentFilters(
		OrganizationMenuModifierGroupOptionAssignment,
		snapGroupOpt,
		async () => {
			const rows = await tx
				.select({ id: OrganizationMenuModifierGroupOptionAssignment.id })
				.from(OrganizationMenuModifierGroupOptionAssignment)
				.innerJoin(
					OrganizationMenuModifierGroup,
					eq(
						OrganizationMenuModifierGroupOptionAssignment.modifierGroupId,
						OrganizationMenuModifierGroup.id,
					),
				)
				.where(eq(OrganizationMenuModifierGroup.organizationId, organizationId))
			return rows.map((r) => r.id)
		},
	)

	const snapNested = new Set(
		content.optionNestedModifierGroupAssignments.map((r) => r.id),
	)
	await assignmentFilters(
		OrganizationMenuOptionNestedModifierGroupAssignment,
		snapNested,
		async () => {
			const rows = await tx
				.select({ id: OrganizationMenuOptionNestedModifierGroupAssignment.id })
				.from(OrganizationMenuOptionNestedModifierGroupAssignment)
				.innerJoin(
					OrganizationMenuOption,
					eq(
						OrganizationMenuOptionNestedModifierGroupAssignment.optionId,
						OrganizationMenuOption.id,
					),
				)
				.where(eq(OrganizationMenuOption.organizationId, organizationId))
			return rows.map((r) => r.id)
		},
	)

	const deleteOrgRows = async (
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		table: any,
		keepIds: Set<string>,
	) => {
		const rows = await tx
			.select({ id: table.id })
			.from(table)
			.where(eq(table.organizationId, organizationId))
		const remove = rows.map((r: { id: string }) => r.id).filter((id) => !keepIds.has(id))
		if (remove.length > 0) {
			await tx.delete(table).where(inArray(table.id, remove))
		}
	}

	await deleteOrgRows(OrganizationMenuOption, optionIds)
	await deleteOrgRows(OrganizationMenuModifierGroup, groupIds)
	await deleteOrgRows(OrganizationMenuItem, itemIds)
	await deleteOrgRows(OrganizationMenuCategory, categoryIds)
	await deleteOrgRows(OrganizationMenu, menuIds)

	const overrideIds = new Set(content.locationOverrides.map((r) => r.id))
	const liveOverrides = await tx
		.select({ id: OrganizationMenuLocationOverride.id })
		.from(OrganizationMenuLocationOverride)
		.where(eq(OrganizationMenuLocationOverride.organizationId, organizationId))
	const removeOverrides = liveOverrides
		.map((r) => r.id)
		.filter((id) => !overrideIds.has(id))
	if (removeOverrides.length > 0) {
		await tx
			.delete(OrganizationMenuLocationOverride)
			.where(inArray(OrganizationMenuLocationOverride.id, removeOverrides))
	}

	const linkIds = new Set(content.posLinks.map((r) => r.id))
	const liveLinks = await tx
		.select({ id: OrganizationMenuPosLink.id })
		.from(OrganizationMenuPosLink)
		.where(eq(OrganizationMenuPosLink.organizationId, organizationId))
	const removeLinks = liveLinks.map((r) => r.id).filter((id) => !linkIds.has(id))
	if (removeLinks.length > 0) {
		await tx
			.delete(OrganizationMenuPosLink)
			.where(inArray(OrganizationMenuPosLink.id, removeLinks))
	}
}

export async function restoreMenuSnapshot({
	organizationId,
	organizationSlug,
	snapshotId,
	userId,
	request,
	removeAdded,
}: {
	organizationId: string
	organizationSlug: string
	snapshotId: string
	userId: string
	request?: Request
	removeAdded: boolean
}) {
	const { content } = await loadMenuSnapshotContent(snapshotId, organizationId)
	await assertRestoreLockFree(organizationId)
	await setRestoreLock(organizationId, true)
	const beforeRestoreId = await createMenuSnapshot({
		organizationId,
		reason: 'before_restore',
		userId,
	})

	try {
		await db.transaction(async (tx) => {
			await upsertTable(tx, OrganizationMenu, content.menus)
			await upsertTable(tx, OrganizationMenuCategory, content.categories)
			await upsertTable(tx, OrganizationMenuItem, content.items)
			await upsertTable(tx, OrganizationMenuModifierGroup, content.modifierGroups)
			await upsertTable(tx, OrganizationMenuOption, content.options)
			await upsertTable(tx, OrganizationMenuCategoryAssignment, content.menuCategoryAssignments)
			await upsertTable(
				tx,
				OrganizationMenuItemCategoryAssignment,
				content.itemCategoryAssignments,
			)
			await upsertTable(
				tx,
				OrganizationMenuItemModifierGroupAssignment,
				content.itemModifierGroupAssignments,
			)
			await upsertTable(
				tx,
				OrganizationMenuModifierGroupOptionAssignment,
				content.modifierGroupOptionAssignments,
			)
			await upsertTable(
				tx,
				OrganizationMenuOptionNestedModifierGroupAssignment,
				content.optionNestedModifierGroupAssignments,
			)
			await upsertTable(tx, OrganizationMenuLocationOverride, content.locationOverrides)
			await upsertTable(tx, OrganizationMenuPosLink, content.posLinks)
			if (removeAdded) {
				await removeAddedRecords(tx, organizationId, content)
			}
		})
	} finally {
		await setRestoreLock(organizationId, false)
	}

	const missingImageKeys: string[] = []
	const keys = new Set<string>()
	for (const item of content.items) {
		if (item.imageKey) keys.add(item.imageKey)
		for (const key of JSON.parse(item.imageKeys || '[]') as string[]) {
			if (key) keys.add(key)
		}
	}
	for (const option of content.options) {
		if (option.imageKey) keys.add(option.imageKey)
	}
	if (keys.size > 0) {
		const found = await db
			.select({ objectKey: OrganizationMediaAsset.objectKey })
			.from(OrganizationMediaAsset)
			.where(
				and(
					eq(OrganizationMediaAsset.organizationId, organizationId),
					inArray(OrganizationMediaAsset.objectKey, [...keys]),
				),
			)
		const have = new Set(found.map((row) => row.objectKey))
		for (const key of keys) {
			if (!have.has(key)) missingImageKeys.push(key)
		}
	}

	await auditService.log({
		action: AuditAction.MENU_ITEM_UPDATED,
		userId,
		organizationId,
		resourceType: 'menu_snapshot',
		resourceId: snapshotId,
		details: `Restored menu from snapshot ${snapshotId}`,
		metadata: { removeAdded, beforeRestoreId, missingImageKeys },
		request,
	})
	await purgeOrganizationSiteCache(organizationId, organizationSlug)

	return { beforeRestoreId, missingImageKeys }
}

export async function pruneMenuSnapshotsForOrganization(organizationId: string) {
	const rows = await db
		.select()
		.from(MenuSnapshot)
		.where(eq(MenuSnapshot.organizationId, organizationId))
		.orderBy(desc(MenuSnapshot.createdAt))

	const cutoff = Date.now() - SNAPSHOT_RETENTION_MS
	const keep = new Set<string>()
	for (const row of rows.slice(0, SNAPSHOT_RETENTION_COUNT)) {
		keep.add(row.id)
	}
	for (const row of rows) {
		if (row.createdAt.getTime() >= cutoff) keep.add(row.id)
	}

	const prune = rows.filter((row) => !keep.has(row.id))
	for (const row of prune) {
		await deleteMenuSnapshotJson(row.contentKey)
		await db.delete(MenuSnapshot).where(eq(MenuSnapshot.id, row.id))
	}
	return prune.length
}

export async function pruneAllMenuSnapshots() {
	const orgIds = await db
		.selectDistinct({ organizationId: MenuSnapshot.organizationId })
		.from(MenuSnapshot)
	let deleted = 0
	for (const { organizationId } of orgIds) {
		deleted += await pruneMenuSnapshotsForOrganization(organizationId)
	}
	return { deleted }
}
