import { mulDiv } from '../money.ts'
import {
	type FoodCostStatus,
	type PlateCostState,
} from '../contract/recipes.ts'
import { expandDish, roundUsage } from './expand.ts'
import {
	fadd,
	fmul,
	frac,
	roundHalfUp,
	toSafeInteger,
	ZERO,
	type Fraction,
} from './fraction.ts'
import { type RecipeStore } from './store.ts'
import {
	type ExpandErrorCode,
	type ExpandFlag,
	type SaleLine,
} from './types.ts'

/** Micro-minor units in one minor unit times thousandths in a base unit. */
const VALUE_DIVISOR = 1_000_000_000

export type PlateCostInput = {
	store: RecipeStore
	/** The dish: item, size and the usual options. */
	dish: Pick<SaleLine, 'itemId' | 'variantId' | 'options'>
	/** The recipes in force at this time (epoch ms). */
	at: number
	/** The organization's inventory currency (typed costs in another one are not used). */
	currency: string
	/**
	 * The LAST delivered cost per base unit by item id, micro-minor (the plan
	 * costs plates at the last price, not the average). `null` or missing means
	 * no delivery has priced the item yet.
	 */
	lastCostMicro: ReadonlyMap<string, number | null>
}

export type PlateCostResult = {
	state: PlateCostState
	/** Whole minor units. `null` when there is nothing to show (none, unknown, invalid). */
	costMinor: number | null
	currency: string
	/** The dish's own typed cost, scaled for its size, when it uses one. */
	typedCostMinor: number | null
	/** Ingredients (leaf items) with no delivered price yet. */
	missingItemIds: string[]
	/** Per ingredient: the raw quantity and its cost (null when unpriced). */
	lines: { itemId: string; quantity: number; costMinor: number | null }[]
	flags: Omit<ExpandFlag, 'lineIndex'>[]
	error?: { code: ExpandErrorCode; path: string[] }
}

function empty(
	state: PlateCostState,
	currency: string,
): Omit<PlateCostResult, 'state'> & { state: PlateCostState } {
	return {
		state,
		costMinor: null,
		currency,
		typedCostMinor: null,
		missingItemIds: [],
		lines: [],
		flags: [],
	}
}

/**
 * What one dish costs to make, at the last delivered prices, with the same
 * expansion a sale uses (so a made item that is not counted in batches costs
 * what its ingredients cost).
 *
 * - `typed`: the owner typed the cost (a size scales it); options add theirs.
 * - `complete` / `partial` / `unknown`: the recipe's ingredients are priced
 *   all, some or none. A partial cost counts only the priced ingredients, so
 *   it is a floor. `missingItemIds` says which are not.
 * - `none`: the dish has no recipe or typed cost. `invalid`: its recipes loop
 *   or nest too deep.
 *
 * The total is rounded once from exact amounts, so per-ingredient costs may
 * differ from it by a minor unit.
 */
export function plateCost(input: PlateCostInput): PlateCostResult {
	const { store, dish, at, currency } = input
	const expansion = expandDish(store, dish, at)
	if (!expansion.ok) {
		return { ...empty('invalid', currency), error: expansion.error }
	}
	if (expansion.state === 'none') {
		return { ...empty('none', currency), flags: expansion.flags }
	}

	let total: Fraction = ZERO
	const lines: PlateCostResult['lines'] = []
	const missing: string[] = []
	const rounded = roundUsage(expansion.usage)
	const exactByItem = expansion.usage
	for (const [itemId, amount] of exactByItem) {
		const cost = input.lastCostMicro.get(itemId) ?? null
		if (cost === null) {
			missing.push(itemId)
			continue
		}
		if (!Number.isSafeInteger(cost) || cost < 0) {
			throw new RangeError('cost must be a non-negative safe integer')
		}
		const value = fmul(amount, frac(cost, VALUE_DIVISOR))
		total = fadd(total, value)
	}
	for (const line of rounded) {
		const cost = input.lastCostMicro.get(line.itemId) ?? null
		lines.push({
			itemId: line.itemId,
			quantity: line.quantity,
			costMinor:
				cost === null
					? null
					: toSafeInteger(
							roundHalfUp(
								fmul(
									exactByItem.get(line.itemId) ?? ZERO,
									frac(cost, VALUE_DIVISOR),
								),
							),
							'cost',
						),
		})
	}
	missing.sort()

	let typedUnusable = false
	let typedCostMinor: number | null = null
	const addTyped = (part: {
		minor: number
		currency: string
		factor: Fraction
	}) => {
		if (part.currency !== currency) {
			typedUnusable = true
			return
		}
		total = fadd(total, fmul(frac(part.minor), part.factor))
	}
	if (expansion.typed.dish) {
		addTyped(expansion.typed.dish)
		if (!typedUnusable) {
			typedCostMinor = toSafeInteger(
				roundHalfUp(
					fmul(frac(expansion.typed.dish.minor), expansion.typed.dish.factor),
				),
				'typed cost',
			)
		}
	}
	for (const part of expansion.typed.options) addTyped(part)

	const leafCount = exactByItem.size
	const priced = leafCount - missing.length
	let state: PlateCostState
	if (expansion.state === 'typed') {
		state = typedUnusable ? 'unknown' : missing.length > 0 ? 'partial' : 'typed'
	} else if (missing.length === 0 && !typedUnusable) {
		state = 'complete'
	} else if (priced === 0 && total.n === 0n) {
		state = 'unknown'
	} else {
		state = 'partial'
	}
	const costMinor =
		state === 'unknown' ? null : toSafeInteger(roundHalfUp(total), 'cost')
	return {
		state,
		costMinor,
		currency,
		typedCostMinor,
		missingItemIds: missing,
		lines,
		flags: expansion.flags,
	}
}

export type MenuPriceTax = {
	pricesIncludeTax?: boolean
	taxRateBp?: number | null
}

/**
 * Cost over price in basis points, rounded half up (the plan's "Food cost
 * 29.8%" is 2980). When menu prices include tax (`pricesIncludeTax: true` and
 * `taxRateBp > 0`), tax is stripped from `priceMinor` first so net ingredient
 * cost is compared against net selling price. `null` without a positive price.
 */
export function dishFoodCostBp(
	priceMinor: number,
	costMinor: number,
	tax?: MenuPriceTax,
): number | null {
	if (!Number.isSafeInteger(priceMinor) || priceMinor <= 0) return null
	if (!Number.isSafeInteger(costMinor) || costMinor < 0) return null
	const rateBp =
		tax?.pricesIncludeTax &&
		tax.taxRateBp !== null &&
		tax.taxRateBp !== undefined &&
		Number.isSafeInteger(tax.taxRateBp) &&
		tax.taxRateBp > 0
			? tax.taxRateBp
			: 0
	const netPriceMinor =
		rateBp > 0
			? mulDiv(priceMinor, 10_000, 10_000 + rateBp, 'half_up')
			: priceMinor
	if (netPriceMinor <= 0) return null
	return mulDiv(costMinor, 10_000, netPriceMinor, 'half_up')
}

/**
 * The price at which a dish costing `costMinor` runs at `targetBp` food cost:
 * `cost / target`, to the nearest minor unit (cost 6.55 at 30% is 21.83, as in
 * the menu editor). When menu prices include tax (`pricesIncludeTax: true` and
 * `taxRateBp > 0`), the net target price is grossed up by `1 + taxRateBp / 10000`.
 * `null` without a cost or a target.
 */
export function priceForTargetMinor(
	costMinor: number,
	targetBp: number,
	tax?: MenuPriceTax,
): number | null {
	if (!Number.isSafeInteger(costMinor) || costMinor <= 0) return null
	if (!Number.isSafeInteger(targetBp) || targetBp <= 0) return null
	const netTarget = mulDiv(costMinor, 10_000, targetBp, 'half_up')
	const rateBp =
		tax?.pricesIncludeTax &&
		tax.taxRateBp !== null &&
		tax.taxRateBp !== undefined &&
		Number.isSafeInteger(tax.taxRateBp) &&
		tax.taxRateBp > 0
			? tax.taxRateBp
			: 0
	return rateBp > 0
		? mulDiv(netTarget, 10_000 + rateBp, 10_000, 'half_up')
		: netTarget
}

/** A food cost this far (basis points) over the target is `watch`, beyond it `high`. */
export const FOOD_COST_WATCH_MARGIN_BP = 500

/** Status dot: at or under the target is good, within five points over it watch. */
export function foodCostStatus(bp: number, targetBp: number): FoodCostStatus {
	if (bp <= targetBp) return 'good'
	if (bp <= targetBp + FOOD_COST_WATCH_MARGIN_BP) return 'watch'
	return 'high'
}
