import {
	buildOrderLimitCatalogFromMenus,
	type OrderLimitMenu,
} from '@repo/common/order-limit-catalog'
import { orderLimitExemptFromCatalog } from '@repo/common/order-limit-exempt'
import { orderDishUnits } from '@repo/common/slot-usage'

/**
 * Which dishes count toward a cart's item count (#256): the large-order extra
 * time (#355) and a per-item packaging fee (#408) both count only the dishes
 * that do. The region reads the same catalog from its order context; the page
 * reads it from the public menu it already loads, through the same function,
 * so the cart's count is the same on both sides.
 *
 * `checkout.astro` builds this once on the server and ships it to the browser
 * as JSON: ids only, no names.
 */
export type OrderLimitMeta = {
	/** Every menu category each dish is in. */
	itemCategoryIds: Record<string, string[]>
	/** Dishes marked "Don't count toward order limits". */
	exemptItemIds: string[]
	/** Categories marked the same way. */
	exemptCategoryIds: string[]
}

export function orderLimitMetaFromMenus(
	menus: readonly OrderLimitMenu[],
): OrderLimitMeta {
	const { catalog, categoryExempt } = buildOrderLimitCatalogFromMenus(menus)
	const exempt = orderLimitExemptFromCatalog(catalog, categoryExempt)
	const itemCategoryIds: Record<string, string[]> = {}
	for (const [id, entry] of catalog)
		itemCategoryIds[id] = [...entry.categoryIds]
	return {
		itemCategoryIds,
		exemptItemIds: [...exempt.itemIds],
		exemptCategoryIds: [...exempt.categoryIds],
	}
}

/**
 * The dish units of a cart that count toward order limits. Without the
 * catalog (an older page, or a menu that could not be read) every unit
 * counts, which is what the page did before.
 */
export function countedDishUnits(
	cart: ReadonlyArray<{ itemId: string; quantity: number }>,
	meta: OrderLimitMeta | null | undefined,
): number {
	if (!meta) return cart.reduce((sum, line) => sum + line.quantity, 0)
	return orderDishUnits(
		cart.map((line) => ({
			itemId: line.itemId,
			quantity: line.quantity,
			categoryIds: meta.itemCategoryIds[line.itemId] ?? [],
		})),
		{
			itemIds: new Set(meta.exemptItemIds),
			categoryIds: new Set(meta.exemptCategoryIds),
		},
	)
}
