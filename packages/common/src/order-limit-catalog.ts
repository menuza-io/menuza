import type {
	PublicMenuCategoryContext,
	RestaurantOrderContext,
} from './restaurant-orders.ts'
import {
	type OrderLimitCatalogEntry,
	orderLimitExemptFromCatalog,
} from './order-limit-exempt.ts'
import { parseSlotLimitSettings } from './location-settings.ts'
import { slotUsageUnits, type SlotUsageLine } from './slot-usage.ts'

function collectMenuCategories(
	categories: PublicMenuCategoryContext[],
	visit: (category: PublicMenuCategoryContext) => void,
): void {
	for (const category of categories) {
		if (category.availabilityStatus !== 'available') continue
		visit(category)
		if (category.subcategories?.length) {
			collectMenuCategories(category.subcategories, visit)
		}
	}
}

export function buildOrderLimitCatalog(context: RestaurantOrderContext): {
	catalog: Map<string, OrderLimitCatalogEntry>
	categoryExempt: Set<string>
} {
	const catalog = new Map<string, OrderLimitCatalogEntry>()
	const categoryExempt = new Set<string>()
	for (const menu of context.menu.menus) {
		if (menu.menuType === 'drop' || menu.availabilityStatus !== 'available') {
			continue
		}
		collectMenuCategories(menu.categories ?? [], (category) => {
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
