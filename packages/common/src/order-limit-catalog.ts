import type { RestaurantOrderContext } from './restaurant-orders.ts'
import {
	type OrderLimitCatalogEntry,
	orderLimitExemptFromCatalog,
} from './order-limit-exempt.ts'
import { parseSlotLimitSettings } from './location-settings.ts'
import { slotUsageUnits, type SlotUsageLine } from './slot-usage.ts'

/** The part of a menu the exemption rules read: Sites' public menu has it too. */
export type OrderLimitMenu = {
	menuType?: string
	availabilityStatus?: string
	categories?: OrderLimitCategory[]
}
export type OrderLimitCategory = {
	id: string
	availabilityStatus?: string
	excludeFromOrderLimits?: boolean
	items?: Array<{
		id: string
		availabilityStatus?: string
		excludeFromOrderLimits?: boolean
	}>
	subcategories?: OrderLimitCategory[]
}

function collectLimitCategories(
	categories: readonly OrderLimitCategory[],
	visit: (category: OrderLimitCategory) => void,
): void {
	for (const category of categories) {
		if (category.availabilityStatus !== 'available') continue
		visit(category)
		if (category.subcategories?.length) {
			collectLimitCategories(category.subcategories, visit)
		}
	}
}

/**
 * Which dishes and categories are left out of order limits (#256), from any
 * menu payload: the region's order context and the public menu Sites reads
 * both pass. The one reading, so a cart's item count is the same everywhere
 * (slot limits, packaging per item, the large-order extra time).
 */
export function buildOrderLimitCatalogFromMenus(
	menus: readonly OrderLimitMenu[],
): {
	catalog: Map<string, OrderLimitCatalogEntry>
	categoryExempt: Set<string>
} {
	const catalog = new Map<string, OrderLimitCatalogEntry>()
	const categoryExempt = new Set<string>()
	for (const menu of menus) {
		if (menu.menuType === 'drop' || menu.availabilityStatus !== 'available') {
			continue
		}
		collectLimitCategories(menu.categories ?? [], (category) => {
			if (category.excludeFromOrderLimits === true) {
				categoryExempt.add(category.id)
			}
			for (const item of category.items ?? []) {
				if (item.availabilityStatus !== 'available') continue
				const existing = catalog.get(item.id)
				const categoryIds = new Set(existing?.categoryIds ?? [])
				categoryIds.add(category.id)
				catalog.set(item.id, {
					item: {
						id: item.id,
						excludeFromOrderLimits: item.excludeFromOrderLimits,
					},
					categoryIds: [...categoryIds],
				})
			}
		})
	}
	return { catalog, categoryExempt }
}

export function buildOrderLimitCatalog(context: RestaurantOrderContext): {
	catalog: Map<string, OrderLimitCatalogEntry>
	categoryExempt: Set<string>
} {
	return buildOrderLimitCatalogFromMenus(
		context.menu.menus as unknown as OrderLimitMenu[],
	)
}

export function slotUsageLinesFromStored(
	lines: unknown,
): SlotUsageLine[] | null {
	if (!Array.isArray(lines)) return null
	const out: SlotUsageLine[] = []
	for (const raw of lines) {
		if (!raw || typeof raw !== 'object') continue
		const line = raw as {
			itemId?: string
			quantity?: number
			categoryIds?: unknown
		}
		if (typeof line.itemId !== 'string' || typeof line.quantity !== 'number') {
			continue
		}
		out.push({
			itemId: line.itemId,
			quantity: line.quantity,
			categoryIds: Array.isArray(line.categoryIds)
				? line.categoryIds.filter((id): id is string => typeof id === 'string')
				: [],
		})
	}
	return out
}

export function readySlotUnitsForOrder(input: {
	context: RestaurantOrderContext
	locationId: string
	fulfillment: string
	lines: unknown
}): number {
	const location = input.context.menu.locations.find(
		(l) => l.id === input.locationId,
	)
	if (!location || input.context.slotLimits?.enabled !== true) return 0
	const settings = parseSlotLimitSettings(location.slotLimitSettings)
	if (!settings?.enabled) return 0
	const usageLines = slotUsageLinesFromStored(input.lines)
	if (!usageLines) return 0
	const { catalog, categoryExempt } = buildOrderLimitCatalog(input.context)
	const exempt = orderLimitExemptFromCatalog(catalog, categoryExempt)
	return slotUsageUnits({ settings, lines: usageLines, exempt })
}
