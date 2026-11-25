import { z } from 'zod'
import { INVENTORY_LIMITS } from './errors.ts'
import {
	dishFoodCostBp,
	netMenuPriceMinor,
	priceForTargetMinor,
	type MenuPriceTax,
} from './engine/plate-cost.ts'

/**
 * Dish profitability (#519): which dishes make money, not only which sell.
 * Each dish with a whole cost is placed on the classic menu matrix by how
 * popular it is and how much it earns, compared with the other dishes in its
 * own menu category, and given a label in plain words. This is a reading of
 * the plate cost the menu list already shows (`plateCost`, `recipeCosts`), not
 * a second cost engine. Pure: no I/O. Money is in minor units of one currency.
 *
 *   popular and earns well      Keep      (stars)
 *   popular, earns little       Re-price  (workhorses)
 *   not popular, earns well     Promote   (puzzles)
 *   neither                     Rethink   (dogs)
 */

export const MENU_ENGINEERING_GROUPS = [
	'keep',
	'reprice',
	'promote',
	'rethink',
] as const
export type MenuEngineeringGroup = (typeof MENU_ENGINEERING_GROUPS)[number]

/** The labels owners read. */
export const MENU_ENGINEERING_LABELS: Record<MenuEngineeringGroup, string> = {
	keep: 'Keep',
	reprice: 'Re-price',
	promote: 'Promote',
	rethink: 'Rethink',
}

/**
 * A dish is popular when it sells at least this share of what an even split of
 * its category would sell (the usual 70% rule).
 */
export const POPULARITY_RULE_PERCENT = 70

export const MAX_PROFITABILITY_DISHES = INVENTORY_LIMITS.costRefsPerRequest * 5

export const dishProfitabilityRequestSchema = z
	.object({
		locationId: z.string().min(1).max(64),
		/** First and last business date, inclusive (`YYYY-MM-DD`). */
		fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
		toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
		/** The dishes the browser knows by id and the menu price it shows. */
		dishes: z
			.array(
				z
					.object({
						itemId: z.string().min(1).max(100),
						priceMinor: z.number().int().min(0).max(100_000_000),
						/** The menu category the dish is compared within. */
						categoryKey: z.string().max(100).default(''),
					})
					.strict(),
			)
			.min(1)
			.max(MAX_PROFITABILITY_DISHES),
		/** The currency the prices are in. */
		currency: z.string().length(3),
		pricesIncludeTax: z.boolean().optional(),
		taxRateBp: z.number().int().min(0).max(100_000).nullable().optional(),
	})
	.strict()
export type DishProfitabilityRequest = z.infer<typeof dishProfitabilityRequestSchema>

export type EngineeringInput = {
	itemId: string
	categoryKey: string
	/** Units sold in the period (all channels the reader counts). */
	quantity: number
	/** Net sales realised in the period, minor units. */
	salesMinor: number
	/** Menu price, minor units. */
	priceMinor: number
	/** Whole plate cost, minor units; null when the dish has no usable cost. */
	costMinor: number | null
	/** How the cost stands (only `complete` and `typed` are whole). */
	costState: 'none' | 'unknown' | 'partial' | 'complete' | 'typed' | 'invalid'
}

export type EngineeringSuggestion = {
	/** Food cost over the net menu price, basis points. */
	foodCostBp: number | null
	targetBp: number
	/** The menu price that would hit the target, minor units. */
	priceForTargetMinor: number | null
	/** The dish runs above the target food cost. */
	overTarget: boolean
}

export type EngineeredDish = {
	itemId: string
	categoryKey: string
	quantity: number
	salesMinor: number
	priceMinor: number
	costMinor: number
	/** Menu price without tax minus the plate cost, per dish. */
	unitMarginMinor: number
	/** Unit margin times the units sold in the period. */
	marginMinor: number
	/** Share of its category's units, 0 to 100. */
	popularityPercent: number
	popular: boolean
	/** Earns at least what its category earns per dish on average. */
	earnsWell: boolean
	group: MenuEngineeringGroup
	suggestion: EngineeringSuggestion
}

export type UnlistedReason = 'no_recipe' | 'cost_incomplete' | 'no_price'

export type EngineeringResult = {
	dishes: EngineeredDish[]
	/** Dishes with no recipe or typed cost, or a cost that is only a floor. */
	unlisted: Array<{
		itemId: string
		quantity: number
		salesMinor: number
		reason: UnlistedReason
	}>
	totals: { quantity: number; salesMinor: number; marginMinor: number }
}

/**
 * Places each dish with a whole cost on the matrix, within its category.
 *
 * - Popularity: the dish's share of its category's units against
 *   `POPULARITY_RULE_PERCENT` of an even split among the dishes ranked there.
 * - Earning: its unit margin against the category's average unit margin per
 *   dish sold (weighted by units); with nothing sold in the category, against
 *   the plain average of the unit margins.
 * - A dish with no recipe or typed cost, or a cost that is only a floor (a
 *   partial cost would flatter it), is listed apart and never labelled.
 */
export function engineerMenu(
	inputs: readonly EngineeringInput[],
	options: { targetBp: number; tax?: MenuPriceTax },
): EngineeringResult {
	const unlisted: EngineeringResult['unlisted'] = []
	type Ranked = EngineeringInput & {
		costMinor: number
		unitNetMinor: number
		unitMarginMinor: number
	}
	const ranked: Ranked[] = []
	for (const input of inputs) {
		const whole = input.costState === 'complete' || input.costState === 'typed'
		if (!whole || input.costMinor === null) {
			unlisted.push({
				itemId: input.itemId,
				quantity: input.quantity,
				salesMinor: input.salesMinor,
				reason:
					input.costState === 'none' ? 'no_recipe' : 'cost_incomplete',
			})
			continue
		}
		const net = netMenuPriceMinor(input.priceMinor, options.tax)
		if (net === null) {
			unlisted.push({
				itemId: input.itemId,
				quantity: input.quantity,
				salesMinor: input.salesMinor,
				reason: 'no_price',
			})
			continue
		}
		ranked.push({
			...input,
			costMinor: input.costMinor,
			unitNetMinor: net,
			unitMarginMinor: net - input.costMinor,
		})
	}

	const byCategory = new Map<string, Ranked[]>()
	for (const dish of ranked) {
		const list = byCategory.get(dish.categoryKey) ?? []
		list.push(dish)
		byCategory.set(dish.categoryKey, list)
	}

	const dishes: EngineeredDish[] = []
	for (const group of byCategory.values()) {
		const units = group.reduce((sum, dish) => sum + dish.quantity, 0)
		const totalMargin = group.reduce(
			(sum, dish) => sum + dish.unitMarginMinor * dish.quantity,
			0,
		)
		const averageMargin =
			units > 0
				? totalMargin / units
				: group.reduce((sum, dish) => sum + dish.unitMarginMinor, 0) /
					group.length
		const threshold = (POPULARITY_RULE_PERCENT / 100) * (100 / group.length)
		for (const dish of group) {
			const popularityPercent = units > 0 ? (dish.quantity / units) * 100 : 0
			const popular = units > 0 && popularityPercent >= threshold
			const earnsWell = dish.unitMarginMinor >= averageMargin
			const label: MenuEngineeringGroup = popular
				? earnsWell
					? 'keep'
					: 'reprice'
				: earnsWell
					? 'promote'
					: 'rethink'
			const foodCostBp = dishFoodCostBp(dish.priceMinor, dish.costMinor, options.tax)
			dishes.push({
				itemId: dish.itemId,
				categoryKey: dish.categoryKey,
				quantity: dish.quantity,
				salesMinor: dish.salesMinor,
				priceMinor: dish.priceMinor,
				costMinor: dish.costMinor,
				unitMarginMinor: dish.unitMarginMinor,
				marginMinor: dish.unitMarginMinor * dish.quantity,
				popularityPercent: Math.round(popularityPercent * 10) / 10,
				popular,
				earnsWell,
				group: label,
				suggestion: {
					foodCostBp,
					targetBp: options.targetBp,
					priceForTargetMinor: priceForTargetMinor(
						dish.costMinor,
						options.targetBp,
						options.tax,
					),
					overTarget: foodCostBp !== null && foodCostBp > options.targetBp,
				},
			})
		}
	}
	// Most margin in the period first; ties by units, then id, so a rerun agrees.
	dishes.sort(
		(a, b) =>
			b.marginMinor - a.marginMinor ||
			b.quantity - a.quantity ||
			(a.itemId < b.itemId ? -1 : 1),
	)
	return {
		dishes,
		unlisted: unlisted.sort((a, b) => b.quantity - a.quantity),
		totals: {
			quantity: dishes.reduce((sum, dish) => sum + dish.quantity, 0),
			salesMinor: dishes.reduce((sum, dish) => sum + dish.salesMinor, 0),
			marginMinor: dishes.reduce((sum, dish) => sum + dish.marginMinor, 0),
		},
	}
}

/** The result as the region answers it (money only with the cost grant). */
export const dishProfitabilityResultSchema = z.object({
	currency: z.string(),
	targetBp: z.number().int(),
	fromDate: z.string(),
	toDate: z.string(),
	dishes: z.array(
		z.object({
			itemId: z.string(),
			categoryKey: z.string(),
			quantity: z.number().int(),
			salesMinor: z.number().int(),
			priceMinor: z.number().int(),
			costMinor: z.number().int(),
			unitMarginMinor: z.number().int(),
			marginMinor: z.number().int(),
			popularityPercent: z.number(),
			popular: z.boolean(),
			earnsWell: z.boolean(),
			group: z.enum(MENU_ENGINEERING_GROUPS),
			suggestion: z.object({
				foodCostBp: z.number().int().nullable(),
				targetBp: z.number().int(),
				priceForTargetMinor: z.number().int().nullable(),
				overTarget: z.boolean(),
			}),
		}),
	),
	unlisted: z.array(
		z.object({
			itemId: z.string(),
			quantity: z.number().int(),
			salesMinor: z.number().int(),
			reason: z.enum(['no_recipe', 'cost_incomplete', 'no_price']),
		}),
	),
	totals: z.object({
		quantity: z.number().int(),
		salesMinor: z.number().int(),
		marginMinor: z.number().int(),
	}),
	truncated: z.boolean(),
})
export type DishProfitabilityResult = z.infer<typeof dishProfitabilityResultSchema>
