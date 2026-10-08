import {
	and,
	db,
	eq,
	inArray,
	OrganizationMenu,
	OrganizationMenuCategory,
	OrganizationMenuCategoryAssignment,
	OrganizationMenuItemCategoryAssignment,
	OrganizationMenuItemModifierGroupAssignment,
	OrganizationMenuModifierGroupOptionAssignment,
	OrganizationMenuOption,
	OrganizationMenuPublished,
} from '@repo/database'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'

/**
 * Master-menu change tracking. Every menu mutation routes through these
 * helpers instead of purging the site cache directly:
 *
 * - Menus with a published snapshot get `hasUnpublishedChanges` set, so the
 *   operator sees "changes pending publish" and the storefront keeps serving
 *   the published version until the next publish.
 * - Menus never published keep today's live behavior: their edits still purge
 *   the site KV cache.
 */

/** Applies dirty flags. Returns the resolved menu ids for convenience. */
async function applyDirtyFlags(
	organizationId: string,
	organizationSlug: string,
	menuIds: Iterable<string>,
): Promise<Set<string>> {
	const resolved = new Set(
		[...menuIds].filter((id): id is string => typeof id === 'string' && !!id),
	)
	if (resolved.size === 0) return resolved

	const publishedRows = await db
		.select({ menuId: OrganizationMenuPublished.menuId })
		.from(OrganizationMenuPublished)
		.where(
			and(
				eq(OrganizationMenuPublished.organizationId, organizationId),
				inArray(OrganizationMenuPublished.menuId, [...resolved]),
			),
		)
	const publishedIds = new Set(publishedRows.map((row) => row.menuId))

	// Legacy menus (never published) keep the live behavior.
	if (resolved.size > publishedIds.size) {
		await purgeOrganizationSiteCache(organizationId, organizationSlug)
	}

	if (publishedIds.size > 0) {
		await db
			.update(OrganizationMenu)
			.set({ hasUnpublishedChanges: true })
			.where(
				and(
					eq(OrganizationMenu.organizationId, organizationId),
					inArray(OrganizationMenu.id, [...publishedIds]),
				),
			)
	}

	return resolved
}

/** Marks specific menus dirty (menu-level edits). */
export async function markMenusDirty(
	organizationId: string,
	organizationSlug: string,
	menuIds: Iterable<string>,
): Promise<Set<string>> {
	return applyDirtyFlags(organizationId, organizationSlug, menuIds)
}

/** Menus containing any of the given categories, including ancestor menus. */
export async function markMenusDirtyForCategories(
	organizationId: string,
	organizationSlug: string,
	categoryIds: Iterable<string>,
): Promise<Set<string>> {
	const ids = [...new Set(categoryIds)].filter(Boolean)
	if (ids.length === 0) return new Set()

	const [menuAssignments, orgCategories] = await Promise.all([
		db
			.select({
				menuId: OrganizationMenuCategoryAssignment.menuId,
				categoryId: OrganizationMenuCategoryAssignment.categoryId,
			})
			.from(OrganizationMenuCategoryAssignment)
			.where(inArray(OrganizationMenuCategoryAssignment.categoryId, ids)),
		db
			.select({
				id: OrganizationMenuCategory.id,
				parentId: OrganizationMenuCategory.parentId,
			})
			.from(OrganizationMenuCategory)
			.where(eq(OrganizationMenuCategory.organizationId, organizationId)),
	])

	// Walk up the parent chain so reparented subcategories dirty the menus of
	// every ancestor that (transitively) contains them.
	const parentById = new Map(orgCategories.map((row) => [row.id, row.parentId]))
	const affectedCategoryIds = new Set(ids)
	for (const id of ids) {
		let current = parentById.get(id) ?? null
		let depth = 0
		while (current && !affectedCategoryIds.has(current) && depth < 20) {
			affectedCategoryIds.add(current)
			current = parentById.get(current) ?? null
			depth++
		}
	}

	const ancestorAssignments = await db
		.select({
			menuId: OrganizationMenuCategoryAssignment.menuId,
		})
		.from(OrganizationMenuCategoryAssignment)
		.where(
			inArray(OrganizationMenuCategoryAssignment.categoryId, [
				...affectedCategoryIds,
			]),
		)

	const menuIds = new Set<string>()
	for (const row of menuAssignments) menuIds.add(row.menuId)
	for (const row of ancestorAssignments) menuIds.add(row.menuId)

	return applyDirtyFlags(organizationId, organizationSlug, menuIds)
}

/** Menus containing any of the given items. */
export async function markMenusDirtyForItems(
	organizationId: string,
	organizationSlug: string,
	itemIds: Iterable<string>,
): Promise<Set<string>> {
	const ids = [...new Set(itemIds)].filter(Boolean)
	if (ids.length === 0) return new Set()

	const categoryAssignments = await db
		.select({
			categoryId: OrganizationMenuItemCategoryAssignment.categoryId,
		})
		.from(OrganizationMenuItemCategoryAssignment)
		.where(inArray(OrganizationMenuItemCategoryAssignment.itemId, ids))

	const categoryIds = [
		...new Set(categoryAssignments.map((row) => row.categoryId)),
	]
	if (categoryIds.length === 0) return new Set()

	const menuAssignments = await db
		.select({
			menuId: OrganizationMenuCategoryAssignment.menuId,
		})
		.from(OrganizationMenuCategoryAssignment)
		.where(inArray(OrganizationMenuCategoryAssignment.categoryId, categoryIds))

	const menuIds = new Set(menuAssignments.map((row) => row.menuId))
	return applyDirtyFlags(organizationId, organizationSlug, menuIds)
}

/**
 * Menus containing any of the given modifier groups, including menus whose
 * items reach a group only through nested modifier groups.
 */
export async function markMenusDirtyForModifierGroups(
	organizationId: string,
	organizationSlug: string,
	modifierGroupIds: Iterable<string>,
): Promise<Set<string>> {
	const seedGroupIds = [...new Set(modifierGroupIds)].filter(Boolean)
	if (seedGroupIds.length === 0) return new Set()

	const menuIds = await collectMenuIdsFromGroups(
		organizationId,
		new Set(seedGroupIds),
	)
	return applyDirtyFlags(organizationId, organizationSlug, menuIds)
}

/** Menus containing any of the given options (including via nested groups). */
export async function markMenusDirtyForOptions(
	organizationId: string,
	organizationSlug: string,
	optionIds: Iterable<string>,
): Promise<Set<string>> {
	const seedOptionIds = [...new Set(optionIds)].filter(Boolean)
	if (seedOptionIds.length === 0) return new Set()

	const menuIds = await collectMenuIdsFromOptions(
		organizationId,
		new Set(seedOptionIds),
	)
	return applyDirtyFlags(organizationId, organizationSlug, menuIds)
}

/* ------------------------------------------------------------------ */
/* Resolution helpers (shared by the modifier/option walkers)          */
/* ------------------------------------------------------------------ */

async function menusContainingItems(
	itemIds: Set<string>,
): Promise<Set<string>> {
	if (itemIds.size === 0) return new Set()

	const categoryAssignments = await db
		.select({
			categoryId: OrganizationMenuItemCategoryAssignment.categoryId,
		})
		.from(OrganizationMenuItemCategoryAssignment)
		.where(inArray(OrganizationMenuItemCategoryAssignment.itemId, [...itemIds]))

	const categoryIds = [
		...new Set(categoryAssignments.map((row) => row.categoryId)),
	]
	if (categoryIds.length === 0) return new Set()

	const menuAssignments = await db
		.select({
			menuId: OrganizationMenuCategoryAssignment.menuId,
		})
		.from(OrganizationMenuCategoryAssignment)
		.where(inArray(OrganizationMenuCategoryAssignment.categoryId, categoryIds))

	return new Set(menuAssignments.map((row) => row.menuId))
}

/**
 * Walks the modifier-group graph: groups -> items (direct) and groups ->
 * parent options (nested) -> their groups, collecting every affected menu.
 * Handles cycles defensively with visited sets.
 */
async function collectMenuIdsFromGroups(
	organizationId: string,
	seedGroupIds: Set<string>,
): Promise<Set<string>> {
	const menuIds = new Set<string>()
	const seenGroupIds = new Set<string>()
	const seenOptionIds = new Set<string>()
	const itemIds = new Set<string>()
	const groupQueue = [...seedGroupIds]

	// Options of this org, for finding which options nest a given group.
	const orgOptions = await db
		.select({
			id: OrganizationMenuOption.id,
			nestedModifierGroupIds: OrganizationMenuOption.nestedModifierGroupIds,
		})
		.from(OrganizationMenuOption)
		.where(eq(OrganizationMenuOption.organizationId, organizationId))

	const parseIds = (raw: string | null): string[] => {
		if (!raw) return []
		try {
			const parsed = JSON.parse(raw)
			return Array.isArray(parsed)
				? parsed.filter((entry): entry is string => typeof entry === 'string')
				: []
		} catch {
			return []
		}
	}

	const optionIdsByNestedGroup = new Map<string, string[]>()
	for (const option of orgOptions) {
		for (const groupId of parseIds(option.nestedModifierGroupIds)) {
			const list = optionIdsByNestedGroup.get(groupId) ?? []
			list.push(option.id)
			optionIdsByNestedGroup.set(groupId, list)
		}
	}

	while (groupQueue.length > 0) {
		const groupId = groupQueue.shift()
		if (!groupId || seenGroupIds.has(groupId)) continue
		seenGroupIds.add(groupId)

		// Items directly assigned this group.
		const itemAssignments = await db
			.select({
				itemId: OrganizationMenuItemModifierGroupAssignment.itemId,
			})
			.from(OrganizationMenuItemModifierGroupAssignment)
			.where(
				eq(
					OrganizationMenuItemModifierGroupAssignment.modifierGroupId,
					groupId,
				),
			)
		for (const row of itemAssignments) itemIds.add(row.itemId)

		// Options that nest this group: walk up to their containing groups.
		for (const parentOptionId of optionIdsByNestedGroup.get(groupId) ?? []) {
			if (seenOptionIds.has(parentOptionId)) continue
			seenOptionIds.add(parentOptionId)
			const parentGroupAssignments = await db
				.select({
					modifierGroupId:
						OrganizationMenuModifierGroupOptionAssignment.modifierGroupId,
				})
				.from(OrganizationMenuModifierGroupOptionAssignment)
				.where(
					eq(
						OrganizationMenuModifierGroupOptionAssignment.optionId,
						parentOptionId,
					),
				)
			for (const row of parentGroupAssignments) {
				if (!seenGroupIds.has(row.modifierGroupId)) {
					groupQueue.push(row.modifierGroupId)
				}
			}
		}
	}

	for (const menuId of await menusContainingItems(itemIds)) {
		menuIds.add(menuId)
	}
	return menuIds
}

async function collectMenuIdsFromOptions(
	organizationId: string,
	seedOptionIds: Set<string>,
): Promise<Set<string>> {
	const groupIds = new Set<string>()
	const optionQueue = [...seedOptionIds]

	while (optionQueue.length > 0) {
		const optionId = optionQueue.shift()
		if (!optionId) continue
		const groupAssignments = await db
			.select({
				modifierGroupId:
					OrganizationMenuModifierGroupOptionAssignment.modifierGroupId,
			})
			.from(OrganizationMenuModifierGroupOptionAssignment)
			.where(
				eq(OrganizationMenuModifierGroupOptionAssignment.optionId, optionId),
			)
		for (const row of groupAssignments) groupIds.add(row.modifierGroupId)
	}

	return collectMenuIdsFromGroups(organizationId, groupIds)
}
