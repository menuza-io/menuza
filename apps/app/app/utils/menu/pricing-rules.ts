import {
	type MenuPricingRule,
	type PricingRounding,
} from '@repo/common/menu-pricing'

/**
 * Pricing rules (#388), the App side. A stored rule names menus and categories;
 * the published rule names categories only (menus expanded, every category
 * with its subcategories), so the shared resolver in `@repo/common/menu-pricing`
 * needs nothing but a dish's category ids. Dishes added to a covered category
 * later are covered because the rule never lists dishes.
 */

export type PricingRuleRow = {
	id: string
	name: string
	percentBp: number
	menuIds: string
	categoryIds: string
	locationIds: string
	roundingMode: string
	roundingValue: number
	excludeMinPrice: number | null
	excludeMaxPrice: number | null
	startsAt: Date | null
	endedAt: Date | null
	createdAt: Date
}

export type MenuStructure = {
	/** Menu id to the category ids assigned to it. */
	menuCategoryIds: ReadonlyMap<string, readonly string[]>
	/** Category id to its direct subcategory ids. */
	childCategoryIds: ReadonlyMap<string, readonly string[]>
}

export function parseIdList(raw: string | null | undefined): string[] {
	if (!raw) return []
	try {
		const value: unknown = JSON.parse(raw)
		return Array.isArray(value)
			? value.filter((id): id is string => typeof id === 'string' && !!id)
			: []
	} catch {
		return []
	}
}

export function roundingOf(row: {
	roundingMode: string
	roundingValue: number
}): PricingRounding {
	if (row.roundingMode === 'decimals')
		return { mode: 'decimals', decimals: row.roundingValue === 1 ? 1 : 0 }
	if (row.roundingMode === 'amount' && row.roundingValue >= 1)
		return { mode: 'amount', amountMinor: Math.round(row.roundingValue) }
	return { mode: 'none' }
}

/** Every category a rule covers: chosen categories, menus' categories, and all their subcategories. */
export function expandRuleCategories(
	menuIds: readonly string[],
	categoryIds: readonly string[],
	structure: MenuStructure,
): string[] {
	const out = new Set<string>()
	const queue: string[] = [...categoryIds]
	for (const menuId of menuIds) {
		queue.push(...(structure.menuCategoryIds.get(menuId) ?? []))
	}
	while (queue.length > 0) {
		const id = queue.pop()!
		if (out.has(id)) continue
		out.add(id)
		queue.push(...(structure.childCategoryIds.get(id) ?? []))
	}
	return [...out].sort()
}

function specificity(row: PricingRuleRow): number {
	if (parseIdList(row.categoryIds).length > 0) return 0
	if (parseIdList(row.menuIds).length > 0) return 1
	return 2
}

/** Whether a stored rule is in force (or scheduled) at `now`. */
export function isRuleLive(row: Pick<PricingRuleRow, 'endedAt'>, now: Date) {
	return !row.endedAt || row.endedAt.getTime() > now.getTime()
}

/**
 * Rules as the menu payload publishes them, in priority order: category rules,
 * then menu rules, then "every dish" rules; newest first within each. The
 * resolver applies the first that covers a dish, so rules never stack.
 */
export function publishPricingRules(
	rows: readonly PricingRuleRow[],
	structure: MenuStructure,
	now: Date,
): MenuPricingRule[] {
	return rows
		.filter((row) => isRuleLive(row, now))
		.slice()
		.sort(
			(a, b) =>
				specificity(a) - specificity(b) ||
				b.createdAt.getTime() - a.createdAt.getTime() ||
				a.id.localeCompare(b.id),
		)
		.map((row) => {
			const menuIds = parseIdList(row.menuIds)
			const categoryIds = parseIdList(row.categoryIds)
			const allDishes = menuIds.length === 0 && categoryIds.length === 0
			return {
				id: row.id,
				percentBp: row.percentBp,
				allDishes,
				categoryIds: allDishes
					? []
					: expandRuleCategories(menuIds, categoryIds, structure),
				locationIds: parseIdList(row.locationIds),
				rounding: roundingOf(row),
				excludeMinPrice: row.excludeMinPrice,
				excludeMaxPrice: row.excludeMaxPrice,
				startsAt: row.startsAt ? row.startsAt.toISOString() : null,
				endsAt: row.endedAt ? row.endedAt.toISOString() : null,
			}
		})
}

/** Seconds until the next rule starts or ends (for cache lifetimes), or null. */
export function secondsUntilNextRuleChange(
	rules: readonly MenuPricingRule[],
	now: Date,
): number | null {
	let next: number | null = null
	for (const rule of rules) {
		for (const at of [rule.startsAt, rule.endsAt]) {
			if (!at) continue
			const time = Date.parse(at)
			if (Number.isFinite(time) && time > now.getTime())
				next = Math.min(next ?? time, time)
		}
	}
	return next === null
		? null
		: Math.max(1, Math.ceil((next - now.getTime()) / 1000))
}
