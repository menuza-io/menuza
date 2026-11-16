import type { OrderLimitExempt } from './slot-usage.ts'

export type OrderLimitCatalogEntry = {
	item: { id: string; excludeFromOrderLimits?: boolean }
	categoryIds: readonly string[]
}

/**
 * Exempt item and category ids for slot counting, from the resolved catalog
 * built during pricing (#256).
 */
export function orderLimitExemptFromCatalog(
	catalog: ReadonlyMap<string, OrderLimitCatalogEntry>,
	categoryExempt: ReadonlySet<string>,
): OrderLimitExempt {
	const itemIds = new Set<string>()
	for (const entry of catalog.values()) {
		if (entry.item.excludeFromOrderLimits === true) {
			itemIds.add(entry.item.id)
		}
	}
	return {
		itemIds,
		categoryIds: new Set(categoryExempt),
	}
}
