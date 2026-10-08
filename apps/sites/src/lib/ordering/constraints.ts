import {
	type CartLine,
	type Constraints,
	type Remaining,
	type RemainingReason,
} from './types.ts'

function isCap(value: number | null | undefined): value is number {
	return typeof value === 'number' && Number.isFinite(value)
}

/**
 * How many more units of `itemId` may be added given what is already in the
 * cart. Combines item inventory, category inventory (shared across the items
 * of that category) and per-order limits; the tightest cap wins and its
 * reason is reported so the UI can explain it.
 */
export function remainingFor(
	itemId: string,
	cartLines: CartLine[],
	constraints: Constraints | null | undefined,
): Remaining {
	if (!constraints) return { max: null, reason: null }

	const inCart = (id: string) =>
		cartLines.reduce(
			(acc, line) => (line.itemId === id ? acc + line.quantity : acc),
			0,
		)

	let max: number | null = null
	let reason: RemainingReason | null = null
	let categoryName: string | undefined
	let limit: number | undefined
	let remaining: number | undefined

	const apply = (
		cap: number,
		why: RemainingReason,
		extra: { name?: string; limit?: number } = {},
	) => {
		const value = Math.max(0, cap)
		if (max === null || value < max) {
			max = value
			reason = why
			categoryName = extra.name
			limit = extra.limit
		}
	}

	const itemRule = constraints.items?.[itemId]
	const itemInCart = inCart(itemId)
	if (itemRule) {
		if (isCap(itemRule.inventory)) {
			remaining = Math.max(0, itemRule.inventory - itemInCart)
			apply(remaining, 'inventory')
		}
		if (isCap(itemRule.maxPerOrder)) {
			apply(itemRule.maxPerOrder - itemInCart, 'limit', {
				limit: itemRule.maxPerOrder,
			})
		}
	}

	const categoryIds = constraints.itemCategoryIds?.[itemId] ?? []
	for (const categoryId of categoryIds) {
		const rule = constraints.categories?.[categoryId]
		if (!rule) continue
		const siblings = Object.entries(constraints.itemCategoryIds ?? {})
			.filter(([, ids]) => ids.includes(categoryId))
			.map(([id]) => id)
		const categoryInCart = siblings.reduce((acc, id) => acc + inCart(id), 0)
		if (isCap(rule.inventory)) {
			apply(rule.inventory - categoryInCart, 'category-inventory', {
				name: rule.name,
			})
		}
		if (isCap(rule.maxPerOrder)) {
			apply(rule.maxPerOrder - categoryInCart, 'limit', {
				name: rule.name,
				limit: rule.maxPerOrder,
			})
		}
	}

	return { max, reason, remaining, categoryName, limit }
}

/** Lines of the cart except the given line, for "how many more" math on steppers. */
export function linesExcluding(lines: CartLine[], lineId: string): CartLine[] {
	return lines.filter((line) => (line as { id?: string }).id !== lineId)
}
