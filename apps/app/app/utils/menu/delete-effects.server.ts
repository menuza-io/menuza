import {
	getLocalizedMenuValue,
	parseMenuVariations,
} from '@repo/common/menu-types'
import {
	and,
	count,
	db,
	desc,
	Discount,
	eq,
	inArray,
	ne,
	or,
	OrganizationDrop,
	OrganizationDropInventory,
	OrganizationMenu,
	OrganizationMenuCategory,
	OrganizationMenuCategoryAssignment,
	OrganizationMenuItem,
	OrganizationMenuItemCategoryAssignment,
	OrganizationMenuItemModifierGroupAssignment,
	OrganizationMenuModifierGroup,
	OrganizationMenuModifierGroupOptionAssignment,
	OrganizationMenuOption,
	OrganizationMenuOptionNestedModifierGroupAssignment,
	OrganizationMenuPosLink,
	PrintDesign,
	sql,
} from '@repo/database'
import { type DiscountDefinition } from '@repo/discounts'
import { definitionFromRow } from '#app/utils/discounts/discounts.server.ts'
import { type MenuEntityType } from './cleanup.server.ts'

/**
 * "What will this delete affect?" for the menu delete dialogs and the Used in
 * cards. Read-only and control plane only: record names, ids and counts of
 * menus, categories, dishes, modifier groups, options, discounts, drops, print
 * designs and POS links that name the record. Never guest data. Recipes live
 * in the regional tenant DB: this only says which recipe owners the browser
 * may ask the region about (`recipeOwners`); the browser asks it directly.
 */

export const DELETE_EFFECT_ENTITY_TYPES = [
	'menu',
	'category',
	'item',
	'modifier_group',
	'modifier_option',
] as const satisfies readonly MenuEntityType[]

/** The most rows one group lists; `total` still counts every one. */
export const DELETE_EFFECTS_ROW_LIMIT = 50

/** Item variants whose recipes the browser may check (one request each). */
const MAX_VARIANT_RECIPE_OWNERS = 10

export type DeleteEffectKind =
	/** Menus the record sits in (a category directly, a dish through its categories). */
	| 'in_menus'
	/** Categories a dish sits in. */
	| 'in_categories'
	/** Modifier groups an option sits in. */
	| 'in_modifier_groups'
	/** Categories on a menu (they stay, only unassigned). */
	| 'contains_categories'
	/** Dishes in a category (they stay, only unassigned). */
	| 'contains_items'
	/** Options in a modifier group (they stay, only unassigned). */
	| 'contains_options'
	/** Dishes offering the modifier group or option. */
	| 'used_by_items'
	/** Options that open the modifier group as a nested choice. */
	| 'nested_in_options'
	| 'discounts'
	| 'drops'
	| 'print_designs'
	| 'pos_links'

export type DeleteEffectRow = {
	id: string
	name: string
	/** POS links: links to this provider. */
	count?: number
	/**
	 * `loses_all_targets`: a discount that names nothing else, so it will no
	 * longer apply to anything. `blocks_delete`: a drop that uses the menu (the
	 * menu delete is refused while it exists).
	 */
	note?: 'loses_all_targets' | 'blocks_delete'
	/** Discounts and drops: their status (`active`, `paused`, `live`, ...). */
	status?: string
}

export type DeleteEffectGroup = {
	kind: DeleteEffectKind
	total: number
	rows: DeleteEffectRow[]
}

export type RecipeOwner = {
	ownerKind: 'menu_item' | 'variant' | 'option'
	ownerId: string
}

export type DeleteEffects = {
	entityType: MenuEntityType
	entityId: string
	name: string
	/** Only groups with at least one row, in display order. */
	groups: DeleteEffectGroup[]
	/** Dish, its variants, or option: what may own a regional recipe. */
	recipeOwners: RecipeOwner[]
}

type Named = { id: string; name: string }

function notFound(): never {
	throw new Response('Not found', { status: 404 })
}

function group(
	kind: DeleteEffectKind,
	total: number,
	rows: DeleteEffectRow[],
): DeleteEffectGroup {
	return { kind, total, rows: rows.slice(0, DELETE_EFFECTS_ROW_LIMIT) }
}

function totalOf(rows: Array<{ n: number | string | null }>): number {
	return Number(rows[0]?.n ?? 0)
}

/** Menu names are JSON language maps; fall back to the internal name. */
function displayName(
	value: string | null | undefined,
	internal: string | null | undefined,
	locale: string,
): string {
	return getLocalizedMenuValue(value, locale, locale) || internal || ''
}

// ── Where the record sits and what it contains ──────────────────────────────

async function menusOfCategories(
	organizationId: string,
	categoryIds: ReturnType<typeof sql> | string[],
	locale: string,
): Promise<DeleteEffectGroup> {
	const where = and(
		eq(OrganizationMenu.organizationId, organizationId),
		Array.isArray(categoryIds)
			? inArray(OrganizationMenuCategoryAssignment.categoryId, categoryIds)
			: sql`${OrganizationMenuCategoryAssignment.categoryId} in ${categoryIds}`,
	)
	const [rows, totals] = await Promise.all([
		db
			.selectDistinct({
				id: OrganizationMenu.id,
				name: OrganizationMenu.displayName,
				internalName: OrganizationMenu.internalName,
			})
			.from(OrganizationMenuCategoryAssignment)
			.innerJoin(
				OrganizationMenu,
				eq(OrganizationMenu.id, OrganizationMenuCategoryAssignment.menuId),
			)
			.where(where)
			.limit(DELETE_EFFECTS_ROW_LIMIT),
		db
			.select({
				n: sql<number>`count(distinct ${OrganizationMenu.id})`,
			})
			.from(OrganizationMenuCategoryAssignment)
			.innerJoin(
				OrganizationMenu,
				eq(OrganizationMenu.id, OrganizationMenuCategoryAssignment.menuId),
			)
			.where(where),
	])
	return group(
		'in_menus',
		totalOf(totals),
		rows.map((row) => ({
			id: row.id,
			name: displayName(row.name, row.internalName, locale),
		})),
	)
}

/** The categories a dish sits in, as a subquery of ids. */
function categoryIdsOfItem(itemId: string) {
	return sql`(select ${OrganizationMenuItemCategoryAssignment.categoryId} from ${OrganizationMenuItemCategoryAssignment} where ${OrganizationMenuItemCategoryAssignment.itemId} = ${itemId})`
}

/** The modifier groups an option sits in, as a subquery of ids. */
function groupIdsOfOption(optionId: string) {
	return sql`(select ${OrganizationMenuModifierGroupOptionAssignment.modifierGroupId} from ${OrganizationMenuModifierGroupOptionAssignment} where ${OrganizationMenuModifierGroupOptionAssignment.optionId} = ${optionId})`
}

async function itemCategories(
	organizationId: string,
	itemId: string,
	locale: string,
): Promise<DeleteEffectGroup> {
	const where = and(
		eq(OrganizationMenuItemCategoryAssignment.itemId, itemId),
		eq(OrganizationMenuCategory.organizationId, organizationId),
	)
	const from = () =>
		db
			.select({
				id: OrganizationMenuCategory.id,
				name: OrganizationMenuCategory.displayName,
				internalName: OrganizationMenuCategory.internalName,
			})
			.from(OrganizationMenuItemCategoryAssignment)
			.innerJoin(
				OrganizationMenuCategory,
				eq(
					OrganizationMenuCategory.id,
					OrganizationMenuItemCategoryAssignment.categoryId,
				),
			)
	const [rows, totals] = await Promise.all([
		from().where(where).limit(DELETE_EFFECTS_ROW_LIMIT),
		db
			.select({ n: count() })
			.from(OrganizationMenuItemCategoryAssignment)
			.innerJoin(
				OrganizationMenuCategory,
				eq(
					OrganizationMenuCategory.id,
					OrganizationMenuItemCategoryAssignment.categoryId,
				),
			)
			.where(where),
	])
	return group(
		'in_categories',
		totalOf(totals),
		rows.map((row) => ({
			id: row.id,
			name: displayName(row.name, row.internalName, locale),
		})),
	)
}

async function menuCategories(
	organizationId: string,
	menuId: string,
	locale: string,
): Promise<DeleteEffectGroup> {
	const where = and(
		eq(OrganizationMenuCategoryAssignment.menuId, menuId),
		eq(OrganizationMenuCategory.organizationId, organizationId),
	)
	const join = eq(
		OrganizationMenuCategory.id,
		OrganizationMenuCategoryAssignment.categoryId,
	)
	const [rows, totals] = await Promise.all([
		db
			.select({
				id: OrganizationMenuCategory.id,
				name: OrganizationMenuCategory.displayName,
				internalName: OrganizationMenuCategory.internalName,
			})
			.from(OrganizationMenuCategoryAssignment)
			.innerJoin(OrganizationMenuCategory, join)
			.where(where)
			.orderBy(OrganizationMenuCategoryAssignment.position)
			.limit(DELETE_EFFECTS_ROW_LIMIT),
		db
			.select({ n: count() })
			.from(OrganizationMenuCategoryAssignment)
			.innerJoin(OrganizationMenuCategory, join)
			.where(where),
	])
	return group(
		'contains_categories',
		totalOf(totals),
		rows.map((row) => ({
			id: row.id,
			name: displayName(row.name, row.internalName, locale),
		})),
	)
}

async function categoryItems(
	organizationId: string,
	categoryId: string,
	locale: string,
): Promise<DeleteEffectGroup> {
	const where = and(
		eq(OrganizationMenuItemCategoryAssignment.categoryId, categoryId),
		eq(OrganizationMenuItem.organizationId, organizationId),
	)
	const join = eq(
		OrganizationMenuItem.id,
		OrganizationMenuItemCategoryAssignment.itemId,
	)
	const [rows, totals] = await Promise.all([
		db
			.select({
				id: OrganizationMenuItem.id,
				name: OrganizationMenuItem.displayName,
				internalName: OrganizationMenuItem.internalName,
			})
			.from(OrganizationMenuItemCategoryAssignment)
			.innerJoin(OrganizationMenuItem, join)
			.where(where)
			.orderBy(OrganizationMenuItemCategoryAssignment.position)
			.limit(DELETE_EFFECTS_ROW_LIMIT),
		db
			.select({ n: count() })
			.from(OrganizationMenuItemCategoryAssignment)
			.innerJoin(OrganizationMenuItem, join)
			.where(where),
	])
	return group(
		'contains_items',
		totalOf(totals),
		rows.map((row) => ({
			id: row.id,
			name: displayName(row.name, row.internalName, locale),
		})),
	)
}

/** Dishes offering any of these modifier groups (a subquery or a list). */
async function itemsUsingGroups(
	organizationId: string,
	groupIds: ReturnType<typeof sql>,
	locale: string,
): Promise<DeleteEffectGroup> {
	const where = and(
		eq(OrganizationMenuItem.organizationId, organizationId),
		sql`${OrganizationMenuItemModifierGroupAssignment.modifierGroupId} in ${groupIds}`,
	)
	const join = eq(
		OrganizationMenuItem.id,
		OrganizationMenuItemModifierGroupAssignment.itemId,
	)
	const [rows, totals] = await Promise.all([
		db
			.selectDistinct({
				id: OrganizationMenuItem.id,
				name: OrganizationMenuItem.displayName,
				internalName: OrganizationMenuItem.internalName,
			})
			.from(OrganizationMenuItemModifierGroupAssignment)
			.innerJoin(OrganizationMenuItem, join)
			.where(where)
			.limit(DELETE_EFFECTS_ROW_LIMIT),
		db
			.select({ n: sql<number>`count(distinct ${OrganizationMenuItem.id})` })
			.from(OrganizationMenuItemModifierGroupAssignment)
			.innerJoin(OrganizationMenuItem, join)
			.where(where),
	])
	return group(
		'used_by_items',
		totalOf(totals),
		rows.map((row) => ({
			id: row.id,
			name: displayName(row.name, row.internalName, locale),
		})),
	)
}

async function groupOptions(
	organizationId: string,
	groupId: string,
	kind: 'contains_options' | 'nested_in_options',
	locale: string,
): Promise<DeleteEffectGroup> {
	const table =
		kind === 'contains_options'
			? OrganizationMenuModifierGroupOptionAssignment
			: OrganizationMenuOptionNestedModifierGroupAssignment
	const where = and(
		eq(table.modifierGroupId, groupId),
		eq(OrganizationMenuOption.organizationId, organizationId),
	)
	const join = eq(OrganizationMenuOption.id, table.optionId)
	const [rows, totals] = await Promise.all([
		db
			.select({
				id: OrganizationMenuOption.id,
				name: OrganizationMenuOption.displayName,
				internalName: OrganizationMenuOption.internalName,
			})
			.from(table)
			.innerJoin(OrganizationMenuOption, join)
			.where(where)
			.orderBy(table.position)
			.limit(DELETE_EFFECTS_ROW_LIMIT),
		db
			.select({ n: count() })
			.from(table)
			.innerJoin(OrganizationMenuOption, join)
			.where(where),
	])
	return group(
		kind,
		totalOf(totals),
		rows.map((row) => ({
			id: row.id,
			name: displayName(row.name, row.internalName, locale),
		})),
	)
}

async function optionGroups(
	organizationId: string,
	optionId: string,
	locale: string,
): Promise<DeleteEffectGroup> {
	const where = and(
		eq(OrganizationMenuModifierGroupOptionAssignment.optionId, optionId),
		eq(OrganizationMenuModifierGroup.organizationId, organizationId),
	)
	const join = eq(
		OrganizationMenuModifierGroup.id,
		OrganizationMenuModifierGroupOptionAssignment.modifierGroupId,
	)
	const [rows, totals] = await Promise.all([
		db
			.select({
				id: OrganizationMenuModifierGroup.id,
				name: OrganizationMenuModifierGroup.name,
				internalName: OrganizationMenuModifierGroup.internalName,
			})
			.from(OrganizationMenuModifierGroupOptionAssignment)
			.innerJoin(OrganizationMenuModifierGroup, join)
			.where(where)
			.limit(DELETE_EFFECTS_ROW_LIMIT),
		db
			.select({ n: count() })
			.from(OrganizationMenuModifierGroupOptionAssignment)
			.innerJoin(OrganizationMenuModifierGroup, join)
			.where(where),
	])
	return group(
		'in_modifier_groups',
		totalOf(totals),
		rows.map((row) => ({
			id: row.id,
			name: displayName(row.name, row.internalName, locale),
		})),
	)
}

// ── Discounts ───────────────────────────────────────────────────────────────

type TargetKind = 'item' | 'category' | 'modifier_group' | 'modifier_option'

type IdSet = {
	itemIds?: readonly string[]
	categoryIds?: readonly string[]
	modifierGroupIds?: readonly string[]
	modifierOptionIds?: readonly string[]
}

const LIST_FOR: Record<TargetKind, keyof IdSet> = {
	item: 'itemIds',
	category: 'categoryIds',
	modifier_group: 'modifierGroupIds',
	modifier_option: 'modifierOptionIds',
}

function idsIn(set: IdSet): string[] {
	return [
		...(set.itemIds ?? []),
		...(set.categoryIds ?? []),
		...(set.modifierGroupIds ?? []),
		...(set.modifierOptionIds ?? []),
	]
}

/**
 * Every group of ids the discount needs at least one match in: what it
 * discounts, what must be in the cart, the buy and get sides, each bundle
 * slot. Exclusions are not here (losing one widens nothing).
 */
function requiredSets(definition: DiscountDefinition): IdSet[] {
	const sets: IdSet[] = []
	const { target, requirement, quantityRule } = definition
	if (target.scope === 'modifiers') {
		sets.push({
			modifierGroupIds: target.modifierGroupIds,
			modifierOptionIds: target.modifierOptionIds,
		})
		// Items and categories narrow whose choices count; both empty means any.
		if (target.itemIds.length > 0 || target.categoryIds.length > 0) {
			sets.push({ itemIds: target.itemIds, categoryIds: target.categoryIds })
		}
	} else if (target.scope !== 'order') {
		sets.push({ itemIds: target.itemIds, categoryIds: target.categoryIds })
	}
	if (requirement) {
		sets.push({
			itemIds: requirement.itemIds,
			categoryIds: requirement.categoryIds,
		})
	}
	if (quantityRule.kind === 'buy_get') {
		sets.push(quantityRule.buy, quantityRule.get)
	} else if (quantityRule.kind === 'bundle') {
		sets.push(...quantityRule.slots)
	}
	return sets
}

/** Every id list of the definition, exclusions included. */
function allSets(definition: DiscountDefinition): IdSet[] {
	return [
		...requiredSets(definition),
		{
			itemIds: definition.target.excludeItemIds,
			categoryIds: definition.target.excludeCategoryIds,
		},
	]
}

export function discountReferences(
	definition: DiscountDefinition,
	kind: TargetKind,
	id: string,
): { references: boolean; losesAllTargets: boolean } {
	const list = LIST_FOR[kind]
	const references = allSets(definition).some((set) =>
		(set[list] ?? []).includes(id),
	)
	if (!references) return { references, losesAllTargets: false }
	// A required group whose only id is this record matches nothing afterwards.
	const losesAllTargets = requiredSets(definition).some(
		(set) =>
			(set[list] ?? []).includes(id) &&
			idsIn(set).every((value) => value === id),
	)
	return { references, losesAllTargets }
}

async function discountsNaming(
	organizationId: string,
	kind: TargetKind,
	id: string,
): Promise<DeleteEffectGroup> {
	// A cheap text match first; parsing decides. Ids are quoted JSON strings.
	const needle = JSON.stringify(id)
	const candidates = await db
		.select()
		.from(Discount)
		.where(
			and(
				eq(Discount.organizationId, organizationId),
				ne(Discount.status, 'archived'),
				or(
					sql`instr(${Discount.target}, ${needle}) > 0`,
					sql`instr(coalesce(${Discount.requirement}, ''), ${needle}) > 0`,
					sql`instr(${Discount.quantityRule}, ${needle}) > 0`,
				),
			),
		)
		.orderBy(desc(Discount.updatedAt))
	const rows: DeleteEffectRow[] = []
	for (const row of candidates) {
		const definition = definitionFromRow(row)
		if (!definition) continue
		const match = discountReferences(definition, kind, id)
		if (!match.references) continue
		rows.push({
			id: row.id,
			name: row.internalName || row.name,
			status: row.status,
			...(match.losesAllTargets ? { note: 'loses_all_targets' as const } : {}),
		})
	}
	// Discounts that stop applying come first, so a capped list keeps them.
	rows.sort(
		(a, b) =>
			Number(b.note === 'loses_all_targets') -
			Number(a.note === 'loses_all_targets'),
	)
	return group('discounts', rows.length, rows)
}

// ── Drops, print designs, POS links ─────────────────────────────────────────

/** Drops that still sell (closed and completed ones are history). */
const OPEN_DROP_STATUSES = ['draft', 'scheduled', 'live']

async function dropsSelling(
	organizationId: string,
	entity: { type: 'item' | 'category'; id: string },
	menuIds: ReturnType<typeof sql>,
): Promise<DeleteEffectGroup> {
	const where = and(
		eq(OrganizationDrop.organizationId, organizationId),
		inArray(OrganizationDrop.status, OPEN_DROP_STATUSES),
		or(
			sql`${OrganizationDrop.id} in (select ${OrganizationDropInventory.dropId} from ${OrganizationDropInventory} where ${OrganizationDropInventory.entityType} = ${entity.type} and ${OrganizationDropInventory.entityId} = ${entity.id})`,
			sql`${OrganizationDrop.menuId} in ${menuIds}`,
		),
	)
	const [rows, totals] = await Promise.all([
		db
			.select({
				id: OrganizationDrop.id,
				name: OrganizationDrop.title,
				status: OrganizationDrop.status,
			})
			.from(OrganizationDrop)
			.where(where)
			.orderBy(desc(OrganizationDrop.updatedAt))
			.limit(DELETE_EFFECTS_ROW_LIMIT),
		db.select({ n: count() }).from(OrganizationDrop).where(where),
	])
	return group('drops', totalOf(totals), rows)
}

async function dropsOnMenu(
	organizationId: string,
	menuId: string,
): Promise<DeleteEffectGroup> {
	const where = and(
		eq(OrganizationDrop.organizationId, organizationId),
		eq(OrganizationDrop.menuId, menuId),
	)
	const [rows, totals] = await Promise.all([
		db
			.select({
				id: OrganizationDrop.id,
				name: OrganizationDrop.title,
				status: OrganizationDrop.status,
			})
			.from(OrganizationDrop)
			.where(where)
			.orderBy(desc(OrganizationDrop.updatedAt))
			.limit(DELETE_EFFECTS_ROW_LIMIT),
		db.select({ n: count() }).from(OrganizationDrop).where(where),
	])
	return group(
		'drops',
		totalOf(totals),
		rows.map((row) => ({ ...row, note: 'blocks_delete' as const })),
	)
}

/** Print designs (not archived) that feature the dish. */
async function printDesignsShowing(
	organizationId: string,
	itemId: string,
): Promise<DeleteEffectGroup> {
	const needle = JSON.stringify(itemId)
	const candidates = await db
		.select({
			id: PrintDesign.id,
			name: PrintDesign.name,
			content: PrintDesign.content,
		})
		.from(PrintDesign)
		.where(
			and(
				eq(PrintDesign.organizationId, organizationId),
				sql`${PrintDesign.archivedAt} is null`,
				sql`instr(${PrintDesign.content}, ${needle}) > 0`,
			),
		)
		.orderBy(desc(PrintDesign.updatedAt))
	const rows: Named[] = []
	for (const design of candidates) {
		const content = design.content as { featuredItemIds?: unknown } | null
		const ids = Array.isArray(content?.featuredItemIds)
			? content.featuredItemIds
			: []
		if (ids.includes(itemId)) rows.push({ id: design.id, name: design.name })
	}
	return group('print_designs', rows.length, rows)
}

/** Connected POS or delivery platforms the record is linked to, per provider. */
async function posLinks(
	organizationId: string,
	entityType: MenuEntityType,
	entityId: string,
): Promise<DeleteEffectGroup> {
	const rows = await db
		.select({
			providerName: OrganizationMenuPosLink.providerName,
			n: count(),
		})
		.from(OrganizationMenuPosLink)
		.where(
			and(
				eq(OrganizationMenuPosLink.organizationId, organizationId),
				eq(OrganizationMenuPosLink.entityType, entityType),
				eq(OrganizationMenuPosLink.localId, entityId),
			),
		)
		.groupBy(OrganizationMenuPosLink.providerName)
		.orderBy(OrganizationMenuPosLink.providerName)
	const mapped = rows.map((row) => ({
		id: row.providerName,
		name: row.providerName,
		count: Number(row.n),
	}))
	return group(
		'pos_links',
		mapped.reduce((sum, row) => sum + (row.count ?? 0), 0),
		mapped,
	)
}

// ── Entry point ─────────────────────────────────────────────────────────────

async function loadRecord(
	organizationId: string,
	entityType: MenuEntityType,
	entityId: string,
	locale: string,
): Promise<{ name: string; variations?: string } | null> {
	switch (entityType) {
		case 'menu': {
			const [row] = await db
				.select({
					name: OrganizationMenu.displayName,
					internalName: OrganizationMenu.internalName,
				})
				.from(OrganizationMenu)
				.where(
					and(
						eq(OrganizationMenu.id, entityId),
						eq(OrganizationMenu.organizationId, organizationId),
					),
				)
				.limit(1)
			return row
				? { name: displayName(row.name, row.internalName, locale) }
				: null
		}
		case 'category': {
			const [row] = await db
				.select({
					name: OrganizationMenuCategory.displayName,
					internalName: OrganizationMenuCategory.internalName,
				})
				.from(OrganizationMenuCategory)
				.where(
					and(
						eq(OrganizationMenuCategory.id, entityId),
						eq(OrganizationMenuCategory.organizationId, organizationId),
					),
				)
				.limit(1)
			return row
				? { name: displayName(row.name, row.internalName, locale) }
				: null
		}
		case 'item': {
			const [row] = await db
				.select({
					name: OrganizationMenuItem.displayName,
					internalName: OrganizationMenuItem.internalName,
					variations: OrganizationMenuItem.variations,
				})
				.from(OrganizationMenuItem)
				.where(
					and(
						eq(OrganizationMenuItem.id, entityId),
						eq(OrganizationMenuItem.organizationId, organizationId),
					),
				)
				.limit(1)
			return row
				? {
						name: displayName(row.name, row.internalName, locale),
						variations: row.variations,
					}
				: null
		}
		case 'modifier_group': {
			const [row] = await db
				.select({
					name: OrganizationMenuModifierGroup.name,
					internalName: OrganizationMenuModifierGroup.internalName,
				})
				.from(OrganizationMenuModifierGroup)
				.where(
					and(
						eq(OrganizationMenuModifierGroup.id, entityId),
						eq(OrganizationMenuModifierGroup.organizationId, organizationId),
					),
				)
				.limit(1)
			return row
				? { name: displayName(row.name, row.internalName, locale) }
				: null
		}
		case 'modifier_option': {
			const [row] = await db
				.select({
					name: OrganizationMenuOption.displayName,
					internalName: OrganizationMenuOption.internalName,
				})
				.from(OrganizationMenuOption)
				.where(
					and(
						eq(OrganizationMenuOption.id, entityId),
						eq(OrganizationMenuOption.organizationId, organizationId),
					),
				)
				.limit(1)
			return row
				? { name: displayName(row.name, row.internalName, locale) }
				: null
		}
	}
}

/**
 * What uses a menu record, for its delete dialog. Throws a 404 Response when
 * the record is not the organization's (another organization's id included).
 */
export async function getDeleteEffects(
	organizationId: string,
	entityType: MenuEntityType,
	entityId: string,
	options: { locale?: string } = {},
): Promise<DeleteEffects> {
	const locale = options.locale ?? 'en'
	const record = await loadRecord(organizationId, entityType, entityId, locale)
	if (!record) notFound()

	let groups: DeleteEffectGroup[]
	let recipeOwners: RecipeOwner[] = []
	switch (entityType) {
		case 'menu':
			groups = await Promise.all([
				menuCategories(organizationId, entityId, locale),
				dropsOnMenu(organizationId, entityId),
				posLinks(organizationId, entityType, entityId),
			])
			break
		case 'category': {
			const menuIds = sql`(select ${OrganizationMenuCategoryAssignment.menuId} from ${OrganizationMenuCategoryAssignment} where ${OrganizationMenuCategoryAssignment.categoryId} = ${entityId})`
			groups = await Promise.all([
				menusOfCategories(organizationId, [entityId], locale),
				categoryItems(organizationId, entityId, locale),
				discountsNaming(organizationId, 'category', entityId),
				dropsSelling(
					organizationId,
					{ type: 'category', id: entityId },
					menuIds,
				),
				posLinks(organizationId, entityType, entityId),
			])
			break
		}
		case 'item': {
			const categoryIds = categoryIdsOfItem(entityId)
			const menuIds = sql`(select ${OrganizationMenuCategoryAssignment.menuId} from ${OrganizationMenuCategoryAssignment} where ${OrganizationMenuCategoryAssignment.categoryId} in ${categoryIds})`
			groups = await Promise.all([
				menusOfCategories(organizationId, categoryIds, locale),
				itemCategories(organizationId, entityId, locale),
				discountsNaming(organizationId, 'item', entityId),
				dropsSelling(organizationId, { type: 'item', id: entityId }, menuIds),
				printDesignsShowing(organizationId, entityId),
				posLinks(organizationId, entityType, entityId),
			])
			const variants = parseMenuVariations(record.variations).variants
			recipeOwners = [
				{ ownerKind: 'menu_item', ownerId: entityId },
				...variants.slice(0, MAX_VARIANT_RECIPE_OWNERS).map((variant) => ({
					ownerKind: 'variant' as const,
					ownerId: variant.id,
				})),
			]
			break
		}
		case 'modifier_group':
			groups = await Promise.all([
				itemsUsingGroups(organizationId, sql`(${entityId})`, locale),
				groupOptions(organizationId, entityId, 'contains_options', locale),
				groupOptions(organizationId, entityId, 'nested_in_options', locale),
				discountsNaming(organizationId, 'modifier_group', entityId),
				posLinks(organizationId, entityType, entityId),
			])
			break
		case 'modifier_option':
			groups = await Promise.all([
				optionGroups(organizationId, entityId, locale),
				itemsUsingGroups(organizationId, groupIdsOfOption(entityId), locale),
				discountsNaming(organizationId, 'modifier_option', entityId),
				posLinks(organizationId, entityType, entityId),
			])
			recipeOwners = [{ ownerKind: 'option', ownerId: entityId }]
			break
	}

	return {
		entityType,
		entityId,
		name: record.name,
		groups: groups.filter((entry) => entry.total > 0),
		recipeOwners,
	}
}
