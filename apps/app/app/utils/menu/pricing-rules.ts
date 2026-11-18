import {
	fixedOverridePrice,
	priceExcludedByRule,
	resolveMenuItemPrice,
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

// ---------------------------------------------------------------------------
// Preview (#388): what a draft rule does to each dish, before it is saved.
// ---------------------------------------------------------------------------

export type PricingRuleDraft = {
	percentBp: number
	menuIds: string[]
	categoryIds: string[]
	locationIds: string[]
	rounding: PricingRounding
	excludeMinPrice: number | null
	excludeMaxPrice: number | null
}

export type PreviewDish = {
	id: string
	name: string
	price: number
	orderTypePrices?: unknown
	/** Every category the dish is listed under. */
	categoryIds: string[]
	/** Variation prices; the rule applies to each. */
	variantPrices?: number[]
}

export type PreviewRow = {
	itemId: string
	name: string
	locationId: string
	before: number
	after: number
	/** Why the price stays: a fixed location price or the excluded range. */
	unchanged?: 'fixed_price' | 'excluded_range'
}

/**
 * The pickup price of every covered dish at every chosen location, before and
 * after the draft rule, with the same resolver every channel prices with.
 * Dishes with a fixed location price stay as they are.
 */
export function previewPricingRule(
	draft: PricingRuleDraft,
	input: {
		dishes: readonly PreviewDish[]
		locationIds: readonly string[]
		structure: MenuStructure
		/** Location id to its fixed prices by dish id. */
		overrides: ReadonlyMap<string, ReadonlyMap<string, number>>
	},
): PreviewRow[] {
	const allDishes = draft.menuIds.length === 0 && draft.categoryIds.length === 0
	const covered = new Set(
		allDishes
			? []
			: expandRuleCategories(draft.menuIds, draft.categoryIds, input.structure),
	)
	const rule: MenuPricingRule = {
		id: 'preview',
		percentBp: draft.percentBp,
		allDishes,
		categoryIds: [...covered],
		locationIds: draft.locationIds,
		rounding: draft.rounding,
		excludeMinPrice: draft.excludeMinPrice,
		excludeMaxPrice: draft.excludeMaxPrice,
	}
	const locations = draft.locationIds.length
		? draft.locationIds
		: input.locationIds
	const rows: PreviewRow[] = []
	for (const locationId of locations) {
		for (const dish of input.dishes) {
			if (!allDishes && !dish.categoryIds.some((id) => covered.has(id)))
				continue
			const fixed = fixedOverridePrice(
				input.overrides.get(locationId)?.get(dish.id),
			)
			const context = { orderType: 'pickup' as const, locationId }
			const before = resolveMenuItemPrice(dish, context, {
				overridePrice: fixed,
			})
			const after = resolveMenuItemPrice(
				dish,
				{ ...context, rules: [rule] },
				{ overridePrice: fixed },
			)
			const variantNote =
				dish.variantPrices && dish.variantPrices.length > 0
					? {
							before: Math.min(...dish.variantPrices),
							after: Math.min(
								...dish.variantPrices.map((price) =>
									resolveMenuItemPrice(
										dish,
										{ ...context, rules: [rule] },
										{ variantPrice: price, overridePrice: fixed },
									),
								),
							),
						}
					: null
			const unchanged =
				fixed !== null
					? ('fixed_price' as const)
					: priceExcludedByRule(variantNote?.before ?? before, rule)
						? ('excluded_range' as const)
						: undefined
			rows.push({
				itemId: dish.id,
				name: dish.name,
				locationId,
				before: variantNote?.before ?? before,
				after: variantNote?.after ?? after,
				...(unchanged ? { unchanged } : {}),
			})
		}
	}
	return rows
}
