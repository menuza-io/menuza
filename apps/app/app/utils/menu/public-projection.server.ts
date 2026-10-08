import {
	isUnavailableUntilExpired,
	parseMenuItemImageKeys,
	parseMenuVariations,
} from '@repo/common/menu-types'
import {
	and,
	asc,
	db,
	eq,
	inArray,
	ne,
	or,
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
	OrganizationMenuPublished,
} from '@repo/database'

/* ------------------------------------------------------------------ */
/* Public payload types (served by /resources/sites.menu)              */
/* ------------------------------------------------------------------ */

export interface PublicMenuOptionData {
	id: string
	displayName: string
	internalName: string | null
	description: string | null
	imageKey: string | null
	imageUrl: string | null
	price: number
	priceWhole: number | null
	priceLeft: number | null
	priceRight: number | null
	calories: number | null
	minSelections: number
	maxSelections: number | null
	isAlcohol: boolean
	isGlutenFree: boolean
	isVegetarian: boolean
	isTopping: boolean
	isDefault: boolean
	allergens: string[]
	applySalesTax: boolean
	availabilityStatus: string
	position: number
	nestedModifierGroupIds?: string[]
	nestedModifierGroups?: PublicModifierGroupData[]
}

export interface PublicModifierGroupData {
	id: string
	name: string
	internalName: string | null
	selectionType: 'single' | 'multiple' | 'quantity' | 'pizza'
	minSelections: number
	maxSelections: number | null
	availabilityStatus: string
	position: number
	options: PublicMenuOptionData[]
}

export interface PublicMenuItemData {
	id: string
	displayName: string
	internalName: string | null
	description: string | null
	price: number
	imageKey: string | null
	imageUrl: string | null
	imageKeys: string[]
	imageUrls: string[]
	variations: {
		groups: Array<{
			id: string
			name: string
			values: Array<{ id: string; name: string }>
		}>
		variants: Array<{
			id: string
			valueIds: string[]
			price: number
			availabilityStatus: 'available' | 'unavailable'
			imageUrl?: string | null
		}>
	}
	isAlcohol: boolean
	isGlutenFree: boolean
	isVegetarian: boolean
	allergens: string[]
	calorieMin: number | null
	calorieMax: number | null
	isPopular: boolean
	isUpsell: boolean
	availabilityStatus: string
	position: number
	modifierGroups: PublicModifierGroupData[]
}

export interface PublicMenuCategoryData {
	id: string
	displayName: string
	internalName: string | null
	description: string | null
	parentId?: string | null
	subcategories?: PublicMenuCategoryData[]
	upsellCategoryIds: string[]
	availabilityStatus: string
	position: number
	items: PublicMenuItemData[]
}

export interface PublicMenuData {
	id: string
	displayName: string
	internalName: string | null
	menuType: string
	nutritionalInfo: boolean
	specialInstructions: boolean
	availabilityStatus: string
	position: number
	categories: PublicMenuCategoryData[]
}

export type PublicLocationOverridesMap = Record<
	string,
	Array<{
		entityType: string
		entityId: string
		isEnabled?: boolean | null
		price?: number | null
		availabilityStatus?: string | null
	}>
>

/* ------------------------------------------------------------------ */
/* Snapshot DTOs                                                      */
/*                                                                    */
/* The published snapshot stores a menu's raw rows as JSON-serializable */
/* DTOs. The storefront assembles the public tree from these DTOs at    */
/* serve time, so both the live path and the snapshot path run through  */
/* the exact same builder and produce byte-identical payloads.          */
/* ------------------------------------------------------------------ */

export const MENU_SNAPSHOT_VERSION = 1

export interface MenuSnapshotMenu {
	id: string
	displayName: string
	internalName: string | null
	menuType: string
	nutritionalInfo: boolean
	specialInstructions: boolean
	availabilityStatus: string
	unavailableUntil: string | null
	position: number
}

export interface MenuSnapshotCategory {
	id: string
	displayName: string
	internalName: string | null
	description: string | null
	parentId: string | null
	upsellCategoryIds: string[]
	availabilityStatus: string
	unavailableUntil: string | null
	position: number
}

export interface MenuSnapshotItem {
	id: string
	displayName: string
	internalName: string | null
	description: string | null
	price: number
	imageKeys: string[]
	variations: string
	isAlcohol: boolean
	isGlutenFree: boolean
	isVegetarian: boolean
	allergens: string[]
	calorieMin: number | null
	calorieMax: number | null
	isPopular: boolean
	isUpsell: boolean
	availabilityStatus: string
	unavailableUntil: string | null
	position: number
}

export interface MenuSnapshotModifierGroup {
	id: string
	name: string
	internalName: string | null
	selectionType: string
	minSelections: number
	maxSelections: number | null
	availabilityStatus: string
	unavailableUntil: string | null
	position: number
}

export interface MenuSnapshotOption {
	id: string
	displayName: string
	internalName: string | null
	description: string | null
	imageKey: string | null
	price: number
	priceWhole: number | null
	priceLeft: number | null
	priceRight: number | null
	calories: number | null
	minSelections: number
	maxSelections: number | null
	isAlcohol: boolean
	isGlutenFree: boolean
	isVegetarian: boolean
	isTopping: boolean
	nestedModifierGroupIds: string[]
	allergens: string[]
	applySalesTax: boolean
	availabilityStatus: string
	unavailableUntil: string | null
	position: number
}

export interface MenuSnapshotContent {
	version: number
	menu: MenuSnapshotMenu
	categories: MenuSnapshotCategory[]
	items: MenuSnapshotItem[]
	modifierGroups: MenuSnapshotModifierGroup[]
	options: MenuSnapshotOption[]
	categoryAssignments: Array<{ categoryId: string; position: number }>
	itemAssignments: Array<{
		categoryId: string
		itemId: string
		position: number
	}>
	itemModifierAssignments: Array<{
		itemId: string
		modifierGroupId: string
		position: number
	}>
	groupOptionAssignments: Array<{
		modifierGroupId: string
		optionId: string
		position: number
		priceOverride: number | null
		priceWholeOverride: number | null
		priceLeftOverride: number | null
		priceRightOverride: number | null
		isDefault: boolean
	}>
}

/** Entities a customer can see right now (available, or a temporary hold that expired). */
function isAvailable(
	status: string,
	unavailableUntil: string | null,
	now: Date,
): boolean {
	return isUnavailableUntilExpired(status, unavailableUntil, now)
}

function effectiveStatus(
	status: string,
	unavailableUntil: string | null,
	now: Date,
): string {
	return isUnavailableUntilExpired(status, unavailableUntil, now)
		? 'available'
		: status
}

function parseStringArray(value: string | null | undefined): string[] {
	if (!value) return []
	try {
		const parsed = JSON.parse(value)
		return Array.isArray(parsed)
			? parsed.filter((entry): entry is string => typeof entry === 'string')
			: []
	} catch {
		return []
	}
}

const toIso = (value: Date | null): string | null =>
	value ? value.toISOString() : null

/* ------------------------------------------------------------------ */
/* Live content loading (DB rows -> snapshot DTOs)                    */
/* ------------------------------------------------------------------ */

type MenuRow = typeof OrganizationMenu.$inferSelect
type CategoryRow = typeof OrganizationMenuCategory.$inferSelect
type ItemRow = typeof OrganizationMenuItem.$inferSelect
type GroupRow = typeof OrganizationMenuModifierGroup.$inferSelect
type OptionRow = typeof OrganizationMenuOption.$inferSelect

function toMenuSnapshotMenu(row: MenuRow): MenuSnapshotMenu {
	return {
		id: row.id,
		displayName: row.displayName,
		internalName: row.internalName,
		menuType: row.menuType,
		nutritionalInfo: Boolean(row.nutritionalInfo),
		specialInstructions: Boolean(row.specialInstructions),
		availabilityStatus: row.availabilityStatus,
		unavailableUntil: toIso(row.unavailableUntil),
		position: row.position,
	}
}

function toMenuSnapshotCategory(row: CategoryRow): MenuSnapshotCategory {
	return {
		id: row.id,
		displayName: row.displayName,
		internalName: row.internalName,
		description: row.description,
		parentId: row.parentId ?? null,
		upsellCategoryIds: parseStringArray(row.upsellCategoryIds),
		availabilityStatus: row.availabilityStatus,
		unavailableUntil: toIso(row.unavailableUntil),
		position: row.position,
	}
}

function toMenuSnapshotItem(row: ItemRow): MenuSnapshotItem {
	return {
		id: row.id,
		displayName: row.displayName,
		internalName: row.internalName,
		description: row.description,
		price: row.price,
		imageKeys: parseMenuItemImageKeys(row.imageKeys, row.imageKey),
		variations: row.variations,
		isAlcohol: Boolean(row.isAlcohol),
		isGlutenFree: Boolean(row.isGlutenFree),
		isVegetarian: Boolean(row.isVegetarian),
		allergens: parseStringArray(row.allergens),
		calorieMin: row.calorieMin,
		calorieMax: row.calorieMax,
		isPopular: Boolean(row.isPopular),
		isUpsell: Boolean(row.isUpsell),
		availabilityStatus: row.availabilityStatus,
		unavailableUntil: toIso(row.unavailableUntil),
		position: row.position,
	}
}

function toMenuSnapshotGroup(row: GroupRow): MenuSnapshotModifierGroup {
	return {
		id: row.id,
		name: row.name,
		internalName: row.internalName,
		selectionType: row.selectionType,
		minSelections: row.minSelections,
		maxSelections: row.maxSelections,
		availabilityStatus: row.availabilityStatus,
		unavailableUntil: toIso(row.unavailableUntil),
		position: row.position,
	}
}

function toMenuSnapshotOption(row: OptionRow): MenuSnapshotOption {
	return {
		id: row.id,
		displayName: row.displayName,
		internalName: row.internalName,
		description: row.description,
		imageKey: row.imageKey,
		price: row.price,
		priceWhole: row.priceWhole,
		priceLeft: row.priceLeft,
		priceRight: row.priceRight,
		calories: row.calories,
		minSelections: row.minSelections,
		maxSelections: row.maxSelections,
		isAlcohol: Boolean(row.isAlcohol),
		isGlutenFree: Boolean(row.isGlutenFree),
		isVegetarian: Boolean(row.isVegetarian),
		isTopping: Boolean(row.isTopping),
		nestedModifierGroupIds: parseStringArray(row.nestedModifierGroupIds),
		allergens: parseStringArray(row.allergens),
		applySalesTax: Boolean(row.applySalesTax),
		availabilityStatus: row.availabilityStatus,
		unavailableUntil: toIso(row.unavailableUntil),
		position: row.position,
	}
}

/** Map of org-wide rows used to build per-menu content closures. */
type OrgMenuMaps = {
	menuRows: MenuRow[]
	categoryRows: CategoryRow[]
	itemRows: ItemRow[]
	groupRows: GroupRow[]
	optionRows: OptionRow[]
	categoryAssignments: Map<
		string,
		Array<{ categoryId: string; position: number }>
	>
	itemAssignments: Map<string, Array<{ itemId: string; position: number }>>
	itemModifierAssignments: Map<
		string,
		Array<{ modifierGroupId: string; position: number }>
	>
	groupOptionAssignments: Map<
		string,
		Array<{
			optionId: string
			position: number
			priceOverride: number | null
			priceWholeOverride: number | null
			priceLeftOverride: number | null
			priceRightOverride: number | null
			isDefault: boolean
		}>
	>
}

/**
 * Loads every org-wide menu row needed to build contents for the org's
 * non-drop menus. One batch of queries, mirroring the previous storefront
 * loader's query profile.
 */
async function loadOrgMenuMaps(organizationId: string): Promise<OrgMenuMaps> {
	const menuRows = await db
		.select()
		.from(OrganizationMenu)
		.where(
			and(
				eq(OrganizationMenu.organizationId, organizationId),
				ne(OrganizationMenu.menuType, 'drop'),
			),
		)
		.orderBy(asc(OrganizationMenu.position))
	const menuIds = menuRows.map((menu) => menu.id)

	const [
		categoryRows,
		itemRows,
		groupRows,
		optionRows,
		catAssign,
		itemCatAssign,
		itemGroupAssign,
		groupOptionAssign,
	] = await Promise.all([
		db
			.select()
			.from(OrganizationMenuCategory)
			.where(eq(OrganizationMenuCategory.organizationId, organizationId))
			.orderBy(asc(OrganizationMenuCategory.position)),
		db
			.select()
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.organizationId, organizationId))
			.orderBy(asc(OrganizationMenuItem.position)),
		db
			.select()
			.from(OrganizationMenuModifierGroup)
			.where(eq(OrganizationMenuModifierGroup.organizationId, organizationId))
			.orderBy(asc(OrganizationMenuModifierGroup.position)),
		db
			.select()
			.from(OrganizationMenuOption)
			.where(eq(OrganizationMenuOption.organizationId, organizationId))
			.orderBy(asc(OrganizationMenuOption.position)),
		menuIds.length
			? db
					.select()
					.from(OrganizationMenuCategoryAssignment)
					.where(inArray(OrganizationMenuCategoryAssignment.menuId, menuIds))
					.orderBy(asc(OrganizationMenuCategoryAssignment.position))
			: Promise.resolve(
					[] as Array<typeof OrganizationMenuCategoryAssignment.$inferSelect>,
				),
		db
			.select()
			.from(OrganizationMenuItemCategoryAssignment)
			.orderBy(asc(OrganizationMenuItemCategoryAssignment.position)),
		db
			.select()
			.from(OrganizationMenuItemModifierGroupAssignment)
			.orderBy(asc(OrganizationMenuItemModifierGroupAssignment.position)),
		db
			.select()
			.from(OrganizationMenuModifierGroupOptionAssignment)
			.orderBy(asc(OrganizationMenuModifierGroupOptionAssignment.position)),
	])

	const categoryAssignments = new Map<
		string,
		Array<{ categoryId: string; position: number }>
	>()
	for (const row of catAssign) {
		const list = categoryAssignments.get(row.menuId) ?? []
		list.push({ categoryId: row.categoryId, position: row.position })
		categoryAssignments.set(row.menuId, list)
	}

	const itemAssignments = new Map<
		string,
		Array<{ itemId: string; position: number }>
	>()
	for (const row of itemCatAssign) {
		const list = itemAssignments.get(row.categoryId) ?? []
		list.push({ itemId: row.itemId, position: row.position })
		itemAssignments.set(row.categoryId, list)
	}

	const itemModifierAssignments = new Map<
		string,
		Array<{ modifierGroupId: string; position: number }>
	>()
	for (const row of itemGroupAssign) {
		const list = itemModifierAssignments.get(row.itemId) ?? []
		list.push({ modifierGroupId: row.modifierGroupId, position: row.position })
		itemModifierAssignments.set(row.itemId, list)
	}

	const groupOptionAssignments = new Map<
		string,
		Array<{
			optionId: string
			position: number
			priceOverride: number | null
			priceWholeOverride: number | null
			priceLeftOverride: number | null
			priceRightOverride: number | null
			isDefault: boolean
		}>
	>()
	for (const row of groupOptionAssign) {
		const list = groupOptionAssignments.get(row.modifierGroupId) ?? []
		list.push({
			optionId: row.optionId,
			position: row.position,
			priceOverride: row.priceOverride,
			priceWholeOverride: row.priceWholeOverride,
			priceLeftOverride: row.priceLeftOverride,
			priceRightOverride: row.priceRightOverride,
			isDefault: Boolean(row.isDefault),
		})
		groupOptionAssignments.set(row.modifierGroupId, list)
	}

	return {
		menuRows,
		categoryRows,
		itemRows,
		groupRows,
		optionRows,
		categoryAssignments,
		itemAssignments,
		itemModifierAssignments,
		groupOptionAssignments,
	}
}

/**
 * Builds one menu's snapshot content from the org-wide maps, walking the full
 * entity closure: assigned categories (plus subcategories) -> items -> their
 * modifier groups -> options -> nested modifier groups (recursively).
 */
export function buildContentFromMaps(
	menuRow: MenuRow,
	maps: OrgMenuMaps,
): MenuSnapshotContent {
	const categoryById = new Map(maps.categoryRows.map((c) => [c.id, c]))
	const itemById = new Map(maps.itemRows.map((i) => [i.id, i]))
	const groupById = new Map(maps.groupRows.map((g) => [g.id, g]))
	const optionById = new Map(maps.optionRows.map((o) => [o.id, o]))

	// Children by parent for the subcategory closure.
	const childrenByParent = new Map<string, CategoryRow[]>()
	for (const category of maps.categoryRows) {
		if (!category.parentId) continue
		const list = childrenByParent.get(category.parentId) ?? []
		list.push(category)
		childrenByParent.set(category.parentId, list)
	}

	const assigned = maps.categoryAssignments.get(menuRow.id) ?? []
	const closedCategoryIds = new Set<string>()
	const queue = assigned.map((entry) => entry.categoryId)
	while (queue.length) {
		const categoryId = queue.shift()
		if (!categoryId || closedCategoryIds.has(categoryId)) continue
		closedCategoryIds.add(categoryId)
		for (const child of childrenByParent.get(categoryId) ?? []) {
			if (!closedCategoryIds.has(child.id)) queue.push(child.id)
		}
	}

	// Categories and assignments.
	const categories: MenuSnapshotCategory[] = []
	const categoryAssignments: MenuSnapshotContent['categoryAssignments'] = []
	for (const entry of assigned) {
		if (!closedCategoryIds.has(entry.categoryId)) continue
		const row = categoryById.get(entry.categoryId)
		if (!row) continue
		categoryAssignments.push({
			categoryId: entry.categoryId,
			position: entry.position,
		})
	}
	for (const categoryId of closedCategoryIds) {
		const row = categoryById.get(categoryId)
		if (row) categories.push(toMenuSnapshotCategory(row))
	}

	// Items via category assignments.
	const closedItemIds = new Set<string>()
	const itemAssignments: MenuSnapshotContent['itemAssignments'] = []
	for (const categoryId of closedCategoryIds) {
		for (const entry of maps.itemAssignments.get(categoryId) ?? []) {
			if (!closedItemIds.has(entry.itemId)) closedItemIds.add(entry.itemId)
			itemAssignments.push({
				categoryId,
				itemId: entry.itemId,
				position: entry.position,
			})
		}
	}
	const items: MenuSnapshotItem[] = []
	for (const itemId of closedItemIds) {
		const row = itemById.get(itemId)
		if (row) items.push(toMenuSnapshotItem(row))
	}

	// Modifier groups via items, then options, then nested groups (closure).
	const closedGroupIds = new Set<string>()
	const itemModifierAssignments: MenuSnapshotContent['itemModifierAssignments'] =
		[]
	const pendingGroupIds = new Set<string>()
	for (const itemId of closedItemIds) {
		for (const entry of maps.itemModifierAssignments.get(itemId) ?? []) {
			itemModifierAssignments.push({
				itemId,
				modifierGroupId: entry.modifierGroupId,
				position: entry.position,
			})
			pendingGroupIds.add(entry.modifierGroupId)
		}
	}

	const closedOptionIds = new Set<string>()
	const groupOptionAssignments: MenuSnapshotContent['groupOptionAssignments'] =
		[]
	const pendingOptionIds = new Set<string>()

	while (pendingGroupIds.size || pendingOptionIds.size) {
		for (const groupId of [...pendingGroupIds]) {
			pendingGroupIds.delete(groupId)
			if (closedGroupIds.has(groupId)) continue
			closedGroupIds.add(groupId)
			for (const entry of maps.groupOptionAssignments.get(groupId) ?? []) {
				groupOptionAssignments.push({
					modifierGroupId: groupId,
					optionId: entry.optionId,
					position: entry.position,
					priceOverride: entry.priceOverride,
					priceWholeOverride: entry.priceWholeOverride,
					priceLeftOverride: entry.priceLeftOverride,
					priceRightOverride: entry.priceRightOverride,
					isDefault: entry.isDefault,
				})
				pendingOptionIds.add(entry.optionId)
			}
		}
		for (const optionId of [...pendingOptionIds]) {
			pendingOptionIds.delete(optionId)
			if (closedOptionIds.has(optionId)) continue
			closedOptionIds.add(optionId)
			const option = optionById.get(optionId)
			if (!option) continue
			for (const nestedGroupId of parseStringArray(
				option.nestedModifierGroupIds,
			)) {
				if (!closedGroupIds.has(nestedGroupId))
					pendingGroupIds.add(nestedGroupId)
			}
		}
	}

	const modifierGroups: MenuSnapshotModifierGroup[] = []
	for (const groupId of closedGroupIds) {
		const row = groupById.get(groupId)
		if (row) modifierGroups.push(toMenuSnapshotGroup(row))
	}
	const options: MenuSnapshotOption[] = []
	for (const optionId of closedOptionIds) {
		const row = optionById.get(optionId)
		if (row) options.push(toMenuSnapshotOption(row))
	}

	return {
		version: MENU_SNAPSHOT_VERSION,
		menu: toMenuSnapshotMenu(menuRow),
		categories,
		items,
		modifierGroups,
		options,
		categoryAssignments,
		itemAssignments,
		itemModifierAssignments,
		groupOptionAssignments,
	}
}

/**
 * Collects the live snapshot content for a single menu (used at publish time).
 * Returns null when the menu does not exist in the organization.
 */
export async function collectLiveMenuContent(
	organizationId: string,
	menuId: string,
): Promise<MenuSnapshotContent | null> {
	const maps = await loadOrgMenuMaps(organizationId)
	const menuRow = maps.menuRows.find((menu) => menu.id === menuId)
	if (!menuRow) return null
	return buildContentFromMaps(menuRow, maps)
}

/* ------------------------------------------------------------------ */
/* Snapshot encode / decode                                           */
/* ------------------------------------------------------------------ */

export function encodeMenuSnapshot(content: MenuSnapshotContent): string {
	return JSON.stringify(content)
}

/**
 * Best-effort decode of a published snapshot. Returns null when the payload is
 * malformed or from an unknown version, so the storefront can fall back to the
 * live menu instead of serving a broken payload.
 */
export function decodeMenuSnapshot(
	raw: string | null,
): MenuSnapshotContent | null {
	if (!raw) return null
	try {
		const parsed = JSON.parse(raw) as MenuSnapshotContent
		if (
			parsed?.version !== MENU_SNAPSHOT_VERSION ||
			!parsed?.menu?.id ||
			!Array.isArray(parsed.categories) ||
			!Array.isArray(parsed.items) ||
			!Array.isArray(parsed.modifierGroups) ||
			!Array.isArray(parsed.options) ||
			!Array.isArray(parsed.categoryAssignments) ||
			!Array.isArray(parsed.itemAssignments) ||
			!Array.isArray(parsed.itemModifierAssignments) ||
			!Array.isArray(parsed.groupOptionAssignments)
		) {
			return null
		}
		return parsed
	} catch {
		return null
	}
}

/* ------------------------------------------------------------------ */
/* Assembly (snapshot DTOs -> public menu tree)                       */
/* ------------------------------------------------------------------ */

export type AssembledMenu = {
	menu: PublicMenuData
	nextVariationExpiry: number | null
}

/**
 * Assembles the public menu tree from snapshot content. Pure: the same
 * content always yields the same tree for a given `now`. Availability holds
 * that have expired resolve to available at serve time, so temporary
 * unavailability windows recover without a republish.
 */
export function assemblePublicMenuData(
	content: MenuSnapshotContent,
	now: Date,
	mediaMap: Map<string, string>,
): AssembledMenu {
	const optionsMap = new Map<string, PublicMenuOptionData>()
	for (const opt of content.options) {
		if (!isAvailable(opt.availabilityStatus, opt.unavailableUntil, now)) {
			continue
		}
		optionsMap.set(opt.id, {
			id: opt.id,
			displayName: opt.displayName,
			internalName: opt.internalName,
			description: opt.description,
			imageKey: opt.imageKey,
			imageUrl: opt.imageKey ? (mediaMap.get(opt.imageKey) ?? null) : null,
			price: opt.price,
			priceWhole: opt.priceWhole,
			priceLeft: opt.priceLeft,
			priceRight: opt.priceRight,
			calories: opt.calories,
			minSelections: opt.minSelections,
			maxSelections: opt.maxSelections,
			isAlcohol: opt.isAlcohol,
			isGlutenFree: opt.isGlutenFree,
			isVegetarian: opt.isVegetarian,
			isTopping: opt.isTopping,
			isDefault: false,
			nestedModifierGroupIds: opt.nestedModifierGroupIds,
			allergens: opt.allergens,
			applySalesTax: opt.applySalesTax,
			availabilityStatus: effectiveStatus(
				opt.availabilityStatus,
				opt.unavailableUntil,
				now,
			),
			position: opt.position,
		})
	}

	const optionsByGroupId = new Map<string, PublicMenuOptionData[]>()
	for (const asgn of content.groupOptionAssignments) {
		const opt = optionsMap.get(asgn.optionId)
		if (!opt) continue
		const effectiveOpt = {
			...opt,
			price: asgn.priceOverride ?? opt.price,
			priceWhole: asgn.priceWholeOverride ?? opt.priceWhole,
			priceLeft: asgn.priceLeftOverride ?? opt.priceLeft,
			priceRight: asgn.priceRightOverride ?? opt.priceRight,
			isDefault: Boolean(asgn.isDefault),
		}
		const list = optionsByGroupId.get(asgn.modifierGroupId) ?? []
		list.push(effectiveOpt)
		optionsByGroupId.set(asgn.modifierGroupId, list)
	}

	const groupsMap = new Map<string, PublicModifierGroupData>()
	for (const group of content.modifierGroups) {
		if (!isAvailable(group.availabilityStatus, group.unavailableUntil, now)) {
			continue
		}
		groupsMap.set(group.id, {
			id: group.id,
			name: group.name,
			internalName: group.internalName,
			selectionType: group.selectionType as
				'single' | 'multiple' | 'quantity' | 'pizza',
			minSelections: group.minSelections,
			maxSelections: group.maxSelections,
			availabilityStatus: effectiveStatus(
				group.availabilityStatus,
				group.unavailableUntil,
				now,
			),
			position: group.position,
			options: optionsByGroupId.get(group.id) ?? [],
		})
	}

	// Attach nested modifier groups to each option.
	for (const group of groupsMap.values()) {
		for (const opt of group.options) {
			if (opt.nestedModifierGroupIds && opt.nestedModifierGroupIds.length > 0) {
				opt.nestedModifierGroups = opt.nestedModifierGroupIds
					.map((gId) => groupsMap.get(gId))
					.filter(Boolean) as PublicModifierGroupData[]
			}
		}
	}

	const groupsByItemId = new Map<string, PublicModifierGroupData[]>()
	for (const asgn of content.itemModifierAssignments) {
		const group = groupsMap.get(asgn.modifierGroupId)
		if (!group) continue
		const list = groupsByItemId.get(asgn.itemId) ?? []
		list.push(group)
		groupsByItemId.set(asgn.itemId, list)
	}

	let nextVariationExpiry: number | null = null
	const itemsMap = new Map<string, PublicMenuItemData>()
	for (const item of content.items) {
		if (!isAvailable(item.availabilityStatus, item.unavailableUntil, now)) {
			continue
		}
		const imageKeys = item.imageKeys
		const variations = parseMenuVariations(item.variations)
		for (const variant of variations.variants) {
			if (
				variant.availabilityStatus !== 'unavailable_until' ||
				!variant.unavailableUntil
			) {
				continue
			}
			const expiresAt = new Date(variant.unavailableUntil).getTime()
			if (isNaN(expiresAt)) continue
			if (expiresAt > now.getTime()) {
				nextVariationExpiry = Math.min(
					nextVariationExpiry ?? expiresAt,
					expiresAt,
				)
			}
		}
		const effectiveVariants = variations.variants.map((variant) => ({
			...variant,
			availabilityStatus: isUnavailableUntilExpired(
				variant.availabilityStatus,
				variant.unavailableUntil,
				now,
			)
				? ('available' as const)
				: ('unavailable' as const),
		}))
		const availableVariants = effectiveVariants.filter(
			(variant) => variant.availabilityStatus === 'available',
		)
		const imageUrls = imageKeys.flatMap((imageKey) => {
			const imageUrl = mediaMap.get(imageKey)
			return imageUrl ? [imageUrl] : []
		})

		itemsMap.set(item.id, {
			id: item.id,
			displayName: item.displayName,
			internalName: item.internalName,
			description: item.description,
			price: availableVariants.length
				? Math.min(...availableVariants.map((variant) => variant.price))
				: item.price,
			imageKey: imageKeys[0] ?? null,
			imageUrl: imageUrls[0] ?? null,
			imageKeys,
			imageUrls,
			variations: {
				groups: variations.groups,
				variants: effectiveVariants.map((variant) => ({
					id: variant.id,
					valueIds: variant.valueIds,
					price: variant.price,
					availabilityStatus: variant.availabilityStatus,
					imageUrl: variant.imageKey
						? (mediaMap.get(variant.imageKey) ?? null)
						: null,
				})),
			},
			isAlcohol: item.isAlcohol,
			isGlutenFree: item.isGlutenFree,
			isVegetarian: item.isVegetarian,
			allergens: item.allergens,
			calorieMin: item.calorieMin,
			calorieMax: item.calorieMax,
			isPopular: item.isPopular,
			isUpsell: item.isUpsell,
			availabilityStatus: effectiveStatus(
				item.availabilityStatus,
				item.unavailableUntil,
				now,
			),
			position: item.position,
			modifierGroups: groupsByItemId.get(item.id) ?? [],
		})
	}

	const itemsByCategoryId = new Map<string, PublicMenuItemData[]>()
	for (const asgn of content.itemAssignments) {
		const item = itemsMap.get(asgn.itemId)
		if (!item) continue
		const list = itemsByCategoryId.get(asgn.categoryId) ?? []
		if (!list.some((entry) => entry.id === item.id)) list.push(item)
		itemsByCategoryId.set(asgn.categoryId, list)
	}

	const categoriesMap = new Map<string, PublicMenuCategoryData>()
	for (const cat of content.categories) {
		if (!isAvailable(cat.availabilityStatus, cat.unavailableUntil, now)) {
			continue
		}
		categoriesMap.set(cat.id, {
			id: cat.id,
			displayName: cat.displayName,
			internalName: cat.internalName,
			description: cat.description,
			parentId: cat.parentId,
			subcategories: [],
			upsellCategoryIds: cat.upsellCategoryIds,
			availabilityStatus: effectiveStatus(
				cat.availabilityStatus,
				cat.unavailableUntil,
				now,
			),
			position: cat.position,
			items: itemsByCategoryId.get(cat.id) ?? [],
		})
	}

	for (const cat of categoriesMap.values()) {
		if (!cat.parentId) continue
		const parent = categoriesMap.get(cat.parentId)
		if (!parent) continue
		parent.subcategories = parent.subcategories ?? []
		parent.subcategories.push(cat)
	}

	const categoriesByMenuId = new Map<string, PublicMenuCategoryData[]>()
	for (const asgn of content.categoryAssignments) {
		const cat = categoriesMap.get(asgn.categoryId)
		if (!cat) continue
		const list = categoriesByMenuId.get(content.menu.id) ?? []
		if (!list.some((entry) => entry.id === cat.id)) list.push(cat)
		categoriesByMenuId.set(content.menu.id, list)
	}

	return {
		menu: {
			id: content.menu.id,
			displayName: content.menu.displayName,
			internalName: content.menu.internalName,
			menuType: content.menu.menuType,
			nutritionalInfo: content.menu.nutritionalInfo,
			specialInstructions: content.menu.specialInstructions,
			availabilityStatus: effectiveStatus(
				content.menu.availabilityStatus,
				content.menu.unavailableUntil,
				now,
			),
			position: content.menu.position,
			categories: categoriesByMenuId.get(content.menu.id) ?? [],
		},
		nextVariationExpiry,
	}
}

/* ------------------------------------------------------------------ */
/* Storefront loader                                                  */
/* ------------------------------------------------------------------ */

export type PublicMenusBuild = {
	menus: PublicMenuData[]
	nextVariationExpiry: number | null
}

/**
 * Builds the public menus for an organization. Menus with a published
 * snapshot serve the snapshot (the master-menu publish gate); menus never
 * published fall back to their live content, preserving pre-publish
 * behavior for existing organizations.
 */
export async function buildPublicMenusForOrganization(
	organizationId: string,
): Promise<PublicMenusBuild> {
	const now = new Date()
	const [maps, publishedRows] = await Promise.all([
		loadOrgMenuMaps(organizationId),
		db
			.select({
				menuId: OrganizationMenuPublished.menuId,
				content: OrganizationMenuPublished.content,
			})
			.from(OrganizationMenuPublished)
			.where(eq(OrganizationMenuPublished.organizationId, organizationId)),
	])

	const snapshotByMenuId = new Map<string, MenuSnapshotContent>()
	for (const row of publishedRows) {
		const decoded = decodeMenuSnapshot(row.content)
		if (decoded) snapshotByMenuId.set(row.menuId, decoded)
	}

	const contents: MenuSnapshotContent[] = []
	for (const menuRow of maps.menuRows) {
		contents.push(
			snapshotByMenuId.get(menuRow.id) ?? buildContentFromMaps(menuRow, maps),
		)
	}

	// Media URLs stay live (they embed the asset's current updatedAt as a
	// cache buster), so resolve them across live and published content.
	const allImageKeys = new Set<string>()
	for (const content of contents) {
		for (const item of content.items) {
			for (const imageKey of item.imageKeys) allImageKeys.add(imageKey)
			for (const variant of parseMenuVariations(item.variations).variants) {
				if (variant.imageKey) allImageKeys.add(variant.imageKey)
			}
		}
		for (const option of content.options) {
			if (option.imageKey) allImageKeys.add(option.imageKey)
		}
	}
	const mediaMap = await loadMediaMap(organizationId, allImageKeys)

	const menus: PublicMenuData[] = []
	let nextVariationExpiry: number | null = null
	for (const content of contents) {
		const assembled = assemblePublicMenuData(content, now, mediaMap)
		if (
			!isAvailable(
				content.menu.availabilityStatus,
				content.menu.unavailableUntil,
				now,
			)
		) {
			continue
		}
		menus.push(assembled.menu)
		nextVariationExpiry = assembled.nextVariationExpiry
			? Math.min(
					nextVariationExpiry ?? assembled.nextVariationExpiry,
					assembled.nextVariationExpiry,
				)
			: nextVariationExpiry
	}

	menus.sort((a, b) => a.position - b.position)

	return { menus, nextVariationExpiry }
}

/**
 * Loads the public location overrides for an organization (live data:
 * overrides are operational location-level adjustments and are not gated
 * by menu publish).
 */
export async function loadLocationOverrides(
	organizationId: string,
): Promise<PublicLocationOverridesMap> {
	const now = new Date()
	const overrides = await db
		.select()
		.from(OrganizationMenuLocationOverride)
		.where(eq(OrganizationMenuLocationOverride.organizationId, organizationId))

	const locationOverridesMap: PublicLocationOverridesMap = {}
	for (const ov of overrides) {
		const effectiveStatus =
			ov.availabilityStatus &&
			isUnavailableUntilExpired(ov.availabilityStatus, ov.unavailableUntil, now)
				? 'available'
				: ov.availabilityStatus

		locationOverridesMap[ov.locationId] ??= []
		locationOverridesMap[ov.locationId]?.push({
			entityType: ov.entityType,
			entityId: ov.entityId,
			isEnabled: ov.isEnabled,
			price: ov.price,
			availabilityStatus: effectiveStatus,
		})
	}
	return locationOverridesMap
}

async function loadMediaMap(
	organizationId: string,
	imageKeys: Set<string>,
): Promise<Map<string, string>> {
	const mediaMap = new Map<string, string>()
	if (imageKeys.size === 0) return mediaMap

	const assets = await db
		.select({
			id: OrganizationMediaAsset.id,
			objectKey: OrganizationMediaAsset.objectKey,
			updatedAt: OrganizationMediaAsset.updatedAt,
		})
		.from(OrganizationMediaAsset)
		.where(
			and(
				eq(OrganizationMediaAsset.organizationId, organizationId),
				or(
					inArray(OrganizationMediaAsset.id, Array.from(imageKeys)),
					inArray(OrganizationMediaAsset.objectKey, Array.from(imageKeys)),
				),
			),
		)

	for (const asset of assets) {
		const url = `/resources/images?mediaId=${encodeURIComponent(asset.id)}&v=${asset.updatedAt.getTime()}`
		mediaMap.set(asset.id, url)
		mediaMap.set(asset.objectKey, url)
	}
	return mediaMap
}
