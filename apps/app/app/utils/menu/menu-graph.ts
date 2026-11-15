import {
	parseLocalizedString,
	pickLocalized,
	type SiteContentLocale,
} from '@repo/common/site-locales'

/**
 * The whole organization's menu as plain data, for the review cards: the
 * detectors and plans are pure functions of a `MenuGraph`, so they can be
 * tested with hand-built menus (`makeMenuGraph`). Built on the server by
 * `loadMenuGraph` (`menu-graph.server.ts`) from the same rows a menu
 * snapshot captures. Dates are ISO strings.
 */

export type GraphItem = {
	id: string
	/** Localized JSON or plain text, as stored. */
	displayName: string
	description: string | null
	price: number
	/** `MenuVariations` JSON, as stored. */
	variations: string
	imageUrl: string | null
	availabilityStatus: string
	position: number
	updatedAt: string
}

export type GraphCategory = {
	id: string
	displayName: string
	parentId: string | null
	availabilityStatus: string
	position: number
	updatedAt: string
}

export type GraphGroup = {
	id: string
	name: string
	selectionType: string
	minSelections: number
	maxSelections: number | null
	availabilityStatus: string
	position: number
	updatedAt: string
}

export type GraphOption = {
	id: string
	displayName: string
	price: number
	priceWhole: number | null
	priceLeft: number | null
	priceRight: number | null
	isTopping: boolean
	availabilityStatus: string
	position: number
	updatedAt: string
}

export type GraphMenu = {
	id: string
	displayName: string
	updatedAt: string
}

export type GraphMenuCategory = {
	menuId: string
	categoryId: string
	position: number
}
export type GraphItemCategory = {
	categoryId: string
	itemId: string
	position: number
}
export type GraphItemGroup = {
	itemId: string
	modifierGroupId: string
	position: number
}
export type GraphGroupOption = {
	modifierGroupId: string
	optionId: string
	position: number
	priceOverride: number | null
	priceWholeOverride: number | null
	priceLeftOverride: number | null
	priceRightOverride: number | null
	isDefault: boolean
}

export type GraphPosLink = {
	entityType: string
	localId: string
}

export type MenuGraph = {
	defaultLocale: SiteContentLocale
	locales: SiteContentLocale[]
	menus: GraphMenu[]
	categories: GraphCategory[]
	items: GraphItem[]
	groups: GraphGroup[]
	options: GraphOption[]
	menuCategories: GraphMenuCategory[]
	itemCategories: GraphItemCategory[]
	itemGroups: GraphItemGroup[]
	groupOptions: GraphGroupOption[]
	/** Nested groups opened by an option (read only: no card writes them). */
	optionGroups: Array<{ optionId: string; modifierGroupId: string }>
	posLinks: GraphPosLink[]
}

export function isVisible(record: { availabilityStatus: string }): boolean {
	return record.availabilityStatus !== 'hidden'
}

/** The text in the menu's own language (falls back like the menu pages). */
export function sourceText(
	graph: Pick<MenuGraph, 'defaultLocale'>,
	raw: string | null | undefined,
): string {
	return pickLocalized(raw ?? '', graph.defaultLocale, graph.defaultLocale).trim()
}

/** Every locale's value of a localized field. */
export function localizedValues(
	graph: Pick<MenuGraph, 'defaultLocale'>,
	raw: string | null | undefined,
): Record<string, string> {
	const parsed = parseLocalizedString(raw ?? null, graph.defaultLocale)
	const out: Record<string, string> = {}
	for (const [locale, value] of Object.entries(parsed)) {
		if (typeof value === 'string' && value.trim()) out[locale] = value
	}
	return out
}

function groupBy<T, K>(rows: readonly T[], key: (row: T) => K): Map<K, T[]> {
	const map = new Map<K, T[]>()
	for (const row of rows) {
		const k = key(row)
		const list = map.get(k)
		if (list) list.push(row)
		else map.set(k, [row])
	}
	return map
}

const byPosition = (a: { position: number }, b: { position: number }) =>
	a.position - b.position

/** Lookups over a graph, built once per graph. */
export type MenuGraphIndex = {
	item: Map<string, GraphItem>
	category: Map<string, GraphCategory>
	group: Map<string, GraphGroup>
	option: Map<string, GraphOption>
	menu: Map<string, GraphMenu>
	/** Group links of a dish, by position. */
	groupsOfItem: (itemId: string) => GraphItemGroup[]
	/** Dishes that offer a group. */
	itemsOfGroup: (groupId: string) => GraphItemGroup[]
	/** Option links of a group, by position. */
	optionsOfGroup: (groupId: string) => GraphGroupOption[]
	/** Groups an option sits in. */
	groupsOfOption: (optionId: string) => GraphGroupOption[]
	/** Category links of a dish. */
	categoriesOfItem: (itemId: string) => GraphItemCategory[]
	/** Dish links of a category, by position. */
	itemsOfCategory: (categoryId: string) => GraphItemCategory[]
	/** Category links of a menu, by position. */
	categoriesOfMenu: (menuId: string) => GraphMenuCategory[]
	menusOfCategory: (categoryId: string) => GraphMenuCategory[]
	/** Records a POS import created or links (`item`, `category`, `modifier_group`). */
	posLinked: (type: string, id: string) => boolean
}

const indexCache = new WeakMap<MenuGraph, MenuGraphIndex>()

export function indexMenuGraph(graph: MenuGraph): MenuGraphIndex {
	const cached = indexCache.get(graph)
	if (cached) return cached
	const groupsOfItem = groupBy(graph.itemGroups, (row) => row.itemId)
	const itemsOfGroup = groupBy(graph.itemGroups, (row) => row.modifierGroupId)
	const optionsOfGroup = groupBy(
		graph.groupOptions,
		(row) => row.modifierGroupId,
	)
	const groupsOfOption = groupBy(graph.groupOptions, (row) => row.optionId)
	const categoriesOfItem = groupBy(graph.itemCategories, (row) => row.itemId)
	const itemsOfCategory = groupBy(graph.itemCategories, (row) => row.categoryId)
	const categoriesOfMenu = groupBy(graph.menuCategories, (row) => row.menuId)
	const menusOfCategory = groupBy(graph.menuCategories, (row) => row.categoryId)
	for (const map of [
		groupsOfItem,
		optionsOfGroup,
		itemsOfCategory,
		categoriesOfMenu,
	] as Array<Map<string, Array<{ position: number }>>>) {
		for (const list of map.values()) list.sort(byPosition)
	}
	const pos = new Set(graph.posLinks.map((row) => `${row.entityType}:${row.localId}`))
	const index: MenuGraphIndex = {
		item: new Map(graph.items.map((row) => [row.id, row])),
		category: new Map(graph.categories.map((row) => [row.id, row])),
		group: new Map(graph.groups.map((row) => [row.id, row])),
		option: new Map(graph.options.map((row) => [row.id, row])),
		menu: new Map(graph.menus.map((row) => [row.id, row])),
		groupsOfItem: (id) => groupsOfItem.get(id) ?? [],
		itemsOfGroup: (id) => itemsOfGroup.get(id) ?? [],
		optionsOfGroup: (id) => optionsOfGroup.get(id) ?? [],
		groupsOfOption: (id) => groupsOfOption.get(id) ?? [],
		categoriesOfItem: (id) => categoriesOfItem.get(id) ?? [],
		itemsOfCategory: (id) => itemsOfCategory.get(id) ?? [],
		categoriesOfMenu: (id) => categoriesOfMenu.get(id) ?? [],
		menusOfCategory: (id) => menusOfCategory.get(id) ?? [],
		posLinked: (type, id) => pos.has(`${type}:${id}`),
	}
	indexCache.set(graph, index)
	return index
}

/** The record of a type, or undefined. */
export function graphRecord(
	graph: MenuGraph,
	type: 'item' | 'category' | 'modifier_group' | 'option' | 'menu',
	id: string,
): { id: string; updatedAt: string } | undefined {
	const index = indexMenuGraph(graph)
	switch (type) {
		case 'item':
			return index.item.get(id)
		case 'category':
			return index.category.get(id)
		case 'modifier_group':
			return index.group.get(id)
		case 'option':
			return index.option.get(id)
		case 'menu':
			return index.menu.get(id)
	}
}

// --- Test helpers ------------------------------------------------------------

const T0 = '2026-01-01T00:00:00.000Z'

type Partial1<T> = Partial<T> & { id: string }

/**
 * A graph from short records, defaults filled in (`available`, position by
 * order, one fixed `updatedAt`). For detector and plan tests.
 */
export function makeMenuGraph(input: {
	defaultLocale?: SiteContentLocale
	locales?: SiteContentLocale[]
	menus?: Array<Partial1<GraphMenu>>
	categories?: Array<Partial1<GraphCategory>>
	items?: Array<Partial1<GraphItem>>
	groups?: Array<Partial1<GraphGroup>>
	options?: Array<Partial1<GraphOption>>
	menuCategories?: Array<Partial<GraphMenuCategory> & Pick<GraphMenuCategory, 'menuId' | 'categoryId'>>
	itemCategories?: Array<Partial<GraphItemCategory> & Pick<GraphItemCategory, 'categoryId' | 'itemId'>>
	itemGroups?: Array<Partial<GraphItemGroup> & Pick<GraphItemGroup, 'itemId' | 'modifierGroupId'>>
	groupOptions?: Array<Partial<GraphGroupOption> & Pick<GraphGroupOption, 'modifierGroupId' | 'optionId'>>
	optionGroups?: MenuGraph['optionGroups']
	posLinks?: GraphPosLink[]
}): MenuGraph {
	const defaultLocale = input.defaultLocale ?? ('en' as SiteContentLocale)
	return {
		defaultLocale,
		locales: input.locales ?? [defaultLocale],
		menus: (input.menus ?? []).map((row) => ({
			displayName: row.id,
			updatedAt: T0,
			...row,
		})),
		categories: (input.categories ?? []).map((row, position) => ({
			displayName: row.id,
			parentId: null,
			availabilityStatus: 'available',
			position,
			updatedAt: T0,
			...row,
		})),
		items: (input.items ?? []).map((row, position) => ({
			displayName: row.id,
			description: null,
			price: 10,
			variations: '{"groups":[],"variants":[]}',
			imageUrl: null,
			availabilityStatus: 'available',
			position,
			updatedAt: T0,
			...row,
		})),
		groups: (input.groups ?? []).map((row, position) => ({
			name: row.id,
			selectionType: 'single',
			minSelections: 0,
			maxSelections: null,
			availabilityStatus: 'available',
			position,
			updatedAt: T0,
			...row,
		})),
		options: (input.options ?? []).map((row, position) => ({
			displayName: row.id,
			price: 0,
			priceWhole: null,
			priceLeft: null,
			priceRight: null,
			isTopping: false,
			availabilityStatus: 'available',
			position,
			updatedAt: T0,
			...row,
		})),
		menuCategories: (input.menuCategories ?? []).map((row, position) => ({
			position,
			...row,
		})),
		itemCategories: (input.itemCategories ?? []).map((row, position) => ({
			position,
			...row,
		})),
		itemGroups: (input.itemGroups ?? []).map((row, position) => ({
			position,
			...row,
		})),
		groupOptions: (input.groupOptions ?? []).map((row, position) => ({
			position,
			priceOverride: null,
			priceWholeOverride: null,
			priceLeftOverride: null,
			priceRightOverride: null,
			isDefault: false,
			...row,
		})),
		optionGroups: input.optionGroups ?? [],
		posLinks: input.posLinks ?? [],
	}
}
