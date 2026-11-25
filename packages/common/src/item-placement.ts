/**
 * Where a dish sat on the menu when it was sold (#227): its menu and category,
 * as names and ids. Stamped on every sale line at placement (web and QR orders
 * in `restaurant_orders.lines`, Station sales in `pos_orders.line_catalog`) so
 * a report groups a sale under what the dish was called then. Renaming or
 * moving a category later changes no past sale. Pure: no I/O, no guest data.
 */

export type ItemPlacement = {
	categoryId: string
	/** Stored as the menu holds it (a plain name or a JSON language map). */
	categoryName: string
	menuId: string
	menuName: string
	/**
	 * The dish is flagged alcohol on the menu (#167). Present only when true, so
	 * a stamp without it reads as it did. Station sales have no other record of
	 * it: the till sends only the item id.
	 */
	alcohol?: true
}

/** What a line sold before this was recorded is grouped under. */
export const EARLIER_SALES_LABEL = 'Earlier sales'

/** Longest id or name kept on a line. */
const MAX_PLACEMENT_TEXT = 300

type PlacementItem = { id: string; isAlcohol?: boolean }
type PlacementCategory = {
	id: string
	displayName?: string
	items?: readonly PlacementItem[] | null
	subcategories?: readonly PlacementCategory[] | null
}
type PlacementMenu = {
	id: string
	displayName?: string
	menuType?: string
	categories?: readonly PlacementCategory[] | null
}

function clip(value: unknown): string {
	return typeof value === 'string' ? value.slice(0, MAX_PLACEMENT_TEXT) : ''
}

function walk(
	menu: PlacementMenu,
	categories: readonly PlacementCategory[] | null | undefined,
	index: Map<string, ItemPlacement>,
) {
	for (const category of categories ?? []) {
		for (const item of category.items ?? []) {
			if (index.has(item.id)) continue
			index.set(item.id, {
				categoryId: clip(category.id),
				categoryName: clip(category.displayName),
				menuId: clip(menu.id),
				menuName: clip(menu.displayName),
				...(item.isAlcohol === true ? { alcohol: true as const } : {}),
			})
		}
		walk(menu, category.subcategories, index)
	}
}

/**
 * The placement of every dish: the first menu (in menu order) and the first
 * category in it that lists the dish. A dish in two categories counts under
 * the first; the order does not say which one the guest browsed, so the choice
 * is deterministic instead of guessed. Drop menus are left out unless
 * `includeDrops` is set (a drop order is placed from its own menu).
 */
export function buildItemPlacementIndex(
	menus: readonly PlacementMenu[],
	options: { includeDrops?: boolean } = {},
): Map<string, ItemPlacement> {
	const index = new Map<string, ItemPlacement>()
	for (const menu of menus) {
		if (menu.menuType === 'drop' && !options.includeDrops) continue
		walk(menu, menu.categories, index)
	}
	return index
}

/** Reads the four stamped fields of a stored line; null when the line has none. */
export function readStampedPlacement(line: unknown): ItemPlacement | null {
	if (!line || typeof line !== 'object') return null
	const value = line as Record<string, unknown>
	const categoryId = clip(value.categoryId)
	const categoryName = clip(value.categoryName)
	const menuId = clip(value.menuId)
	const menuName = clip(value.menuName)
	if (!categoryId && !categoryName && !menuId && !menuName) return null
	return {
		categoryId,
		categoryName,
		menuId,
		menuName,
		...(value.alcohol === true ? { alcohol: true as const } : {}),
	}
}

/** The `{ [itemId]: placement }` map stored on a Station sale. */
export type LineCatalog = Record<string, ItemPlacement>

/** Builds the Station sale's map for just the dishes on it. */
export function lineCatalogFor(
	index: ReadonlyMap<string, ItemPlacement>,
	itemIds: Iterable<string>,
): LineCatalog | null {
	const catalog: LineCatalog = {}
	for (const id of itemIds) {
		const placement = index.get(id)
		if (placement) catalog[id] = placement
	}
	return Object.keys(catalog).length > 0 ? catalog : null
}

/** Reads a stored line catalog defensively (a bad entry is dropped). */
export function parseLineCatalog(raw: unknown): LineCatalog {
	let value = raw
	if (typeof value === 'string') {
		try {
			value = JSON.parse(value)
		} catch {
			return {}
		}
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
	const catalog: LineCatalog = {}
	for (const [itemId, entry] of Object.entries(value)) {
		const placement = readStampedPlacement(entry)
		if (placement) catalog[itemId] = placement
	}
	return catalog
}

/** Whether any dish of a Station sale is flagged alcohol (#167): its ticket says "Check ID". */
export function lineCatalogHasAlcohol(catalog: LineCatalog | null | undefined): boolean {
	return Object.values(catalog ?? {}).some((entry) => entry.alcohol === true)
}
