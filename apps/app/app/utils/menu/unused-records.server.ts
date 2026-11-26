import {
	and,
	db,
	eq,
	inArray,
	OrganizationDropInventory,
	OrganizationMenuItem,
	OrganizationMenuItemCategoryAssignment,
	OrganizationMenuItemModifierGroupAssignment,
	OrganizationMenuLocationOverride,
	OrganizationMenuModifierGroup,
	OrganizationMenuModifierGroupOptionAssignment,
	OrganizationMenuOption,
	OrganizationMenuOptionNestedModifierGroupAssignment,
	OrganizationMenuPosLink,
} from '@repo/database'
import { deleteMenuEntityReferences } from './cleanup.server.ts'
import { createMenuSnapshot } from './snapshot.server.ts'
import {
	exclusiveModifierCleanup,
	tidyRecords,
	unusedRecordsCsv,
	type MenuUsageGraph,
	type TidyRecord,
} from './unused-records.ts'

export async function loadMenuUsageGraph(
	organizationId: string,
): Promise<MenuUsageGraph> {
	const [
		items,
		groups,
		options,
		categoryItems,
		itemGroups,
		groupOptions,
		nested,
		drops,
		overrides,
		links,
	] = await Promise.all([
		db
			.select({ id: OrganizationMenuItem.id })
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.organizationId, organizationId)),
		db
			.select({ id: OrganizationMenuModifierGroup.id })
			.from(OrganizationMenuModifierGroup)
			.where(eq(OrganizationMenuModifierGroup.organizationId, organizationId)),
		db
			.select({ id: OrganizationMenuOption.id })
			.from(OrganizationMenuOption)
			.where(eq(OrganizationMenuOption.organizationId, organizationId)),
		db
			.select({
				itemId: OrganizationMenuItemCategoryAssignment.itemId,
			})
			.from(OrganizationMenuItemCategoryAssignment)
			.innerJoin(
				OrganizationMenuItem,
				eq(
					OrganizationMenuItem.id,
					OrganizationMenuItemCategoryAssignment.itemId,
				),
			)
			.where(eq(OrganizationMenuItem.organizationId, organizationId)),
		db
			.select({
				itemId: OrganizationMenuItemModifierGroupAssignment.itemId,
				modifierGroupId:
					OrganizationMenuItemModifierGroupAssignment.modifierGroupId,
			})
			.from(OrganizationMenuItemModifierGroupAssignment)
			.innerJoin(
				OrganizationMenuItem,
				eq(
					OrganizationMenuItem.id,
					OrganizationMenuItemModifierGroupAssignment.itemId,
				),
			)
			.where(eq(OrganizationMenuItem.organizationId, organizationId)),
		db
			.select({
				modifierGroupId:
					OrganizationMenuModifierGroupOptionAssignment.modifierGroupId,
				optionId: OrganizationMenuModifierGroupOptionAssignment.optionId,
			})
			.from(OrganizationMenuModifierGroupOptionAssignment)
			.innerJoin(
				OrganizationMenuOption,
				eq(
					OrganizationMenuOption.id,
					OrganizationMenuModifierGroupOptionAssignment.optionId,
				),
			)
			.where(eq(OrganizationMenuOption.organizationId, organizationId)),
		db
			.select({
				modifierGroupId:
					OrganizationMenuOptionNestedModifierGroupAssignment.modifierGroupId,
			})
			.from(OrganizationMenuOptionNestedModifierGroupAssignment)
			.innerJoin(
				OrganizationMenuOption,
				eq(
					OrganizationMenuOption.id,
					OrganizationMenuOptionNestedModifierGroupAssignment.optionId,
				),
			)
			.where(eq(OrganizationMenuOption.organizationId, organizationId)),
		db
			.select({ entityId: OrganizationDropInventory.entityId })
			.from(OrganizationDropInventory)
			.innerJoin(
				OrganizationMenuItem,
				eq(OrganizationMenuItem.id, OrganizationDropInventory.entityId),
			)
			.where(eq(OrganizationMenuItem.organizationId, organizationId)),
		db
			.select({ entityId: OrganizationMenuLocationOverride.entityId })
			.from(OrganizationMenuLocationOverride)
			.where(
				eq(OrganizationMenuLocationOverride.organizationId, organizationId),
			),
		db
			.select({ localId: OrganizationMenuPosLink.localId })
			.from(OrganizationMenuPosLink)
			.where(eq(OrganizationMenuPosLink.organizationId, organizationId)),
	])

	const itemGroupIds = new Map<string, string[]>()
	const groupItemIds = new Map<string, string[]>()
	for (const row of itemGroups) {
		push(itemGroupIds, row.itemId, row.modifierGroupId)
		push(groupItemIds, row.modifierGroupId, row.itemId)
	}
	const groupOptionIds = new Map<string, string[]>()
	const optionGroupIds = new Map<string, string[]>()
	for (const row of groupOptions) {
		push(groupOptionIds, row.modifierGroupId, row.optionId)
		push(optionGroupIds, row.optionId, row.modifierGroupId)
	}
	return {
		itemIds: items.map((row) => row.id),
		groupIds: groups.map((row) => row.id),
		optionIds: options.map((row) => row.id),
		categoryItemIds: new Set(categoryItems.map((row) => row.itemId)),
		itemGroupIds,
		groupItemIds,
		groupOptionIds,
		optionGroupIds,
		nestedGroupIds: new Set(nested.map((row) => row.modifierGroupId)),
		dropIds: new Set(drops.map((row) => row.entityId)),
		overrideIds: new Set(overrides.map((row) => row.entityId)),
		posLinkedIds: new Set(links.map((row) => row.localId)),
	}
}

function push(map: Map<string, string[]>, key: string, value: string) {
	const list = map.get(key)
	if (list) list.push(value)
	else map.set(key, [value])
}

export async function loadTidyRecords(
	organizationId: string,
): Promise<{ records: TidyRecord[]; csv: string }> {
	const graph = await loadMenuUsageGraph(organizationId)
	const [items, groups, options] = await Promise.all([
		db
			.select({
				id: OrganizationMenuItem.id,
				name: OrganizationMenuItem.displayName,
				updatedAt: OrganizationMenuItem.updatedAt,
			})
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.organizationId, organizationId)),
		db
			.select({
				id: OrganizationMenuModifierGroup.id,
				name: OrganizationMenuModifierGroup.name,
				updatedAt: OrganizationMenuModifierGroup.updatedAt,
			})
			.from(OrganizationMenuModifierGroup)
			.where(eq(OrganizationMenuModifierGroup.organizationId, organizationId)),
		db
			.select({
				id: OrganizationMenuOption.id,
				name: OrganizationMenuOption.displayName,
				updatedAt: OrganizationMenuOption.updatedAt,
			})
			.from(OrganizationMenuOption)
			.where(eq(OrganizationMenuOption.organizationId, organizationId)),
	])
	const records = tidyRecords(graph, [
		...items.map((row) => ({
			entityType: 'item' as const,
			id: row.id,
			name: row.name,
			updatedAt: row.updatedAt.toISOString(),
		})),
		...groups.map((row) => ({
			entityType: 'modifier_group' as const,
			id: row.id,
			name: row.name,
			updatedAt: row.updatedAt.toISOString(),
		})),
		...options.map((row) => ({
			entityType: 'modifier_option' as const,
			id: row.id,
			name: row.name,
			updatedAt: row.updatedAt.toISOString(),
		})),
	])
	return { records, csv: unusedRecordsCsv(records) }
}

/** Deletes groups and options that only the removed dishes used. POS links stay. */
export async function deleteExclusiveModifiers(input: {
	organizationId: string
	userId: string
	removedItemIds: readonly string[]
}) {
	if (input.removedItemIds.length === 0) return { groupIds: [], optionIds: [] }
	const graph = await loadMenuUsageGraph(input.organizationId)
	const cleanup = exclusiveModifierCleanup(graph, input.removedItemIds)
	if (cleanup.groupIds.length === 0 && cleanup.optionIds.length === 0) {
		return cleanup
	}
	await createMenuSnapshot({
		organizationId: input.organizationId,
		reason: 'before_bulk_edit',
		userId: input.userId,
		label: 'Before deleting unused options',
	})
	await db.transaction(async (tx) => {
		if (cleanup.optionIds.length) {
			await tx
				.delete(OrganizationMenuOption)
				.where(
					and(
						eq(OrganizationMenuOption.organizationId, input.organizationId),
						inArray(OrganizationMenuOption.id, cleanup.optionIds),
					),
				)
			for (const optionId of cleanup.optionIds) {
				await deleteMenuEntityReferences(
					input.organizationId,
					'modifier_option',
					optionId,
					tx,
				)
			}
		}
		if (cleanup.groupIds.length) {
			await tx
				.delete(OrganizationMenuModifierGroup)
				.where(
					and(
						eq(
							OrganizationMenuModifierGroup.organizationId,
							input.organizationId,
						),
						inArray(OrganizationMenuModifierGroup.id, cleanup.groupIds),
					),
				)
			for (const groupId of cleanup.groupIds) {
				await deleteMenuEntityReferences(
					input.organizationId,
					'modifier_group',
					groupId,
					tx,
				)
			}
		}
	})
	return cleanup
}
