import { resolveDish } from './expand.ts'
import { type RecipeStore } from './store.ts'

/** One row of the items-sold reader (`readItemSales().items`), reduced to what ranking needs. */
export type SoldDishRow = {
	itemId: string
	variantId: string | null
	/** Units sold. */
	quantity: number
	netSalesMinor?: number
}

export type DishWithoutRecipe = {
	itemId: string
	quantity: number
	netSalesMinor: number | null
}

/**
 * Sold dishes that have no recipe and no typed cost at `at` (a size counts as
 * covered when it has its own recipe or its item has one), most sold first, so
 * the owner sets up the top few and stops. Rows of one item (its sizes, its
 * days, its locations) are added together; a dish with no recipe for some of
 * its sizes ranks by the units of those sizes. Ties go to the larger net
 * sales, then the item id, so the order is stable.
 */
export function rankDishesWithoutRecipe(input: {
	store: RecipeStore
	rows: readonly SoldDishRow[]
	at: number
	limit?: number
}): { dishes: DishWithoutRecipe[]; total: number } {
	const byItem = new Map<
		string,
		{ quantity: number; netSalesMinor: number; hasNet: boolean }
	>()
	for (const row of input.rows) {
		if (!Number.isSafeInteger(row.quantity) || row.quantity <= 0) continue
		if (
			resolveDish(input.store, row.itemId, row.variantId, input.at).state !==
			'none'
		) {
			continue
		}
		const entry = byItem.get(row.itemId) ?? {
			quantity: 0,
			netSalesMinor: 0,
			hasNet: false,
		}
		entry.quantity += row.quantity
		if (row.netSalesMinor !== undefined) {
			entry.netSalesMinor += row.netSalesMinor
			entry.hasNet = true
		}
		byItem.set(row.itemId, entry)
	}
	const ranked = [...byItem.entries()]
		.map(([itemId, entry]) => ({
			itemId,
			quantity: entry.quantity,
			netSalesMinor: entry.hasNet ? entry.netSalesMinor : null,
		}))
		.sort(
			(a, b) =>
				b.quantity - a.quantity ||
				(b.netSalesMinor ?? 0) - (a.netSalesMinor ?? 0) ||
				(a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0),
		)
	return {
		dishes: ranked.slice(0, input.limit ?? ranked.length),
		total: ranked.length,
	}
}
