import { MAX_ENTRY_QUANTITY } from '../units.ts'
import {
	fadd,
	fcmp,
	fmin,
	fmul,
	frac,
	fsubFloor,
	isZero,
	ONE,
	roundHalfUp,
	toSafeInteger,
	ZERO,
	type Fraction,
} from './fraction.ts'
import { recipeInForce, type RecipeStore } from './store.ts'
import {
	type ExpandError,
	type ExpandErrorCode,
	type ExpandFlag,
	type ExpandFlagKind,
	type ExpandResult,
	type RecipeLineSpec,
	type SaleLine,
	type SaleOption,
	type UnrecipedLine,
	type UsageLine,
} from './types.ts'

/**
 * Made items inside made items, at most. A made item entered at a depth past
 * this is `recipe_too_deep`.
 */
export const MAX_RECIPE_DEPTH = 8

const BP = 10_000

/** Raw quantity of an ingredient for what ends up in the dish: `quantity / usable`. */
function rawQuantity(line: RecipeLineSpec): Fraction {
	return frac(BigInt(line.quantity) * BigInt(BP), line.usableBp)
}

function addTo(map: Map<string, Fraction>, itemId: string, amount: Fraction) {
	if (isZero(amount)) return
	map.set(itemId, fadd(map.get(itemId) ?? ZERO, amount))
}

function assertPositiveInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new RangeError(`${name} must be a positive safe integer`)
	}
}

export type TypedPart = { minor: number; currency: string; factor: Fraction }

export type DishState = 'recipe' | 'typed' | 'none'

type ResolvedDish = {
	state: DishState
	lines: { spec: RecipeLineSpec; factor: Fraction }[]
	typed: TypedPart | null
	flags: ExpandFlagKind[]
}

/**
 * The recipe of a dish at a time, with the size applied. A size that is a
 * multiple scales its item's recipe (and typed cost, unless the size has one
 * of its own); a size with its own recipe replaces the item's; a size with no
 * recipe in force uses the item's as it is.
 */
export function resolveDish(
	store: RecipeStore,
	itemId: string,
	variantId: string | null | undefined,
	at: number,
): ResolvedDish {
	const item = recipeInForce(store, 'menu_item', itemId, at)
	const variant = variantId
		? recipeInForce(store, 'variant', variantId, at)
		: null
	const flags: ExpandFlagKind[] = []
	let source = item
	let factor: Fraction = ONE
	let typed = item?.typedCost ?? null
	let ownTyped = false
	if (variant) {
		if (variant.multiplierBp !== null) {
			factor = frac(variant.multiplierBp, BP)
			if (!item) flags.push('multiplier_without_base')
			// A size that carries its own typed cost does not scale the item's.
			if (variant.typedCost) {
				typed = variant.typedCost
				ownTyped = true
			}
		} else {
			source = variant
			typed = variant.typedCost
			ownTyped = true
		}
	}
	const lines = (source?.lines ?? []).map((spec) => ({ spec, factor }))
	const typedPart: TypedPart | null = typed
		? {
				minor: typed.minor,
				currency: typed.currency,
				factor: ownTyped ? ONE : factor,
			}
		: null
	const state: DishState =
		lines.length > 0 ? 'recipe' : typedPart ? 'typed' : 'none'
	return { state, lines, typed: typedPart, flags }
}

function optionFactor(selection: SaleOption): Fraction {
	const quantity = selection.quantity ?? 1
	assertPositiveInteger(quantity, 'option quantity')
	const half = selection.half === 'left' || selection.half === 'right' ? 2 : 1
	return frac(quantity, half)
}

export type DishExpansion =
	| {
			ok: true
			/** Raw leaf quantity for ONE dish. */
			usage: Map<string, Fraction>
			state: DishState
			/** The dish's typed cost and those of its options (each with its factor). */
			typed: { dish: TypedPart | null; options: TypedPart[] }
			flags: Omit<ExpandFlag, 'lineIndex'>[]
	  }
	| { ok: false; error: { code: ExpandErrorCode; path: string[] } }

class ExpansionFailure extends Error {
	constructor(
		readonly code: ExpandErrorCode,
		readonly path: string[],
	) {
		super(code)
	}
}

/**
 * Spends `amount` of `itemId` into `out`: a made item that is not counted in
 * batches and has a recipe in force expands into its ingredients (by batches
 * of what it makes), recursively; anything else is a leaf.
 */
function spend(
	store: RecipeStore,
	itemId: string,
	amount: Fraction,
	path: readonly string[],
	at: number,
	out: Map<string, Fraction>,
	flags: Omit<ExpandFlag, 'lineIndex'>[],
): void {
	const facts = store.items.get(itemId)
	if (facts?.kind === 'made' && !facts.batchCounted) {
		const recipe = recipeInForce(store, 'made_item', itemId, at)
		if (recipe && recipe.lines.length > 0 && (recipe.makesQuantity ?? 0) > 0) {
			const loop = path.indexOf(itemId)
			if (loop !== -1) {
				throw new ExpansionFailure('recipe_cycle', [
					...path.slice(loop),
					itemId,
				])
			}
			if (path.length >= MAX_RECIPE_DEPTH) {
				throw new ExpansionFailure('recipe_too_deep', [...path, itemId])
			}
			const batches = fmul(amount, frac(1, recipe.makesQuantity!))
			for (const line of recipe.lines) {
				spend(
					store,
					line.itemId,
					fmul(batches, rawQuantity(line)),
					[...path, itemId],
					at,
					out,
					flags,
				)
			}
			return
		}
		flags.push({ kind: 'made_item_without_recipe', itemId })
	}
	addTo(out, itemId, amount)
}

/**
 * Raw ingredient quantities for ONE dish (exact fractions of the base unit
 * thousandths), with its options applied.
 *
 * - The dish's recipe is resolved with its size (see `resolveDish`).
 * - An option `add` line adds `quantity / usable` times the option's count; a
 *   `left` or `right` half counts half of it. The option quantity multiplies.
 * - An option `replace` line adds its ingredient and takes out of the dish
 *   the named ingredient of the dish's own recipe, by the same share (a whole
 *   option takes out all of it; never more than the dish had, so nothing goes
 *   negative and the replaced ingredient never stays beside its replacement).
 *   When the dish has no such ingredient it is just an add, and flagged.
 *   Several replacers of one ingredient take out at most what there was.
 * - Made items expand into their ingredients unless counted in batches.
 *
 * The result does not depend on the order of the options.
 */
export function expandDish(
	store: RecipeStore,
	line: Pick<SaleLine, 'itemId' | 'variantId' | 'options'>,
	at: number,
): DishExpansion {
	const dish = resolveDish(store, line.itemId, line.variantId, at)
	const flags: Omit<ExpandFlag, 'lineIndex'>[] = dish.flags.map((kind) => ({
		kind,
		itemId: line.itemId,
	}))
	const optionTyped: TypedPart[] = []

	const base = new Map<string, Fraction>()
	for (const { spec, factor } of dish.lines) {
		addTo(base, spec.itemId, fmul(rawQuantity(spec), factor))
	}
	const direct = new Map(base)
	const removals = new Map<string, Fraction>()

	for (const selection of line.options ?? []) {
		const recipe = recipeInForce(store, 'option', selection.optionId, at)
		if (!recipe) continue
		const factor = optionFactor(selection)
		if (recipe.typedCost) {
			optionTyped.push({
				minor: recipe.typedCost.minor,
				currency: recipe.typedCost.currency,
				factor,
			})
		}
		for (const spec of recipe.lines) {
			if (spec.mode === 'replace' && spec.replacesItemId) {
				const had = base.get(spec.replacesItemId) ?? ZERO
				if (isZero(had)) {
					flags.push({
						kind: 'replace_base_missing',
						itemId: spec.replacesItemId,
						optionId: selection.optionId,
					})
				} else {
					addTo(removals, spec.replacesItemId, fmul(had, fmin(factor, ONE)))
				}
			}
			addTo(direct, spec.itemId, fmul(rawQuantity(spec), factor))
		}
	}
	for (const [itemId, removed] of removals) {
		const cap = fmin(base.get(itemId) ?? ZERO, removed)
		direct.set(itemId, fsubFloor(direct.get(itemId) ?? ZERO, cap))
	}

	const usage = new Map<string, Fraction>()
	try {
		for (const [itemId, amount] of direct) {
			spend(store, itemId, amount, [], at, usage, flags)
		}
	} catch (error) {
		if (error instanceof ExpansionFailure) {
			return { ok: false, error: { code: error.code, path: error.path } }
		}
		throw error
	}
	const limit = frac(MAX_ENTRY_QUANTITY)
	for (const amount of usage.values()) {
		if (fcmp(amount, limit) > 0) {
			return { ok: false, error: { code: 'usage_out_of_range', path: [] } }
		}
	}
	return {
		ok: true,
		usage,
		state: dish.state,
		typed: { dish: dish.typed, options: optionTyped },
		flags,
	}
}

function flagKey(flag: ExpandFlag): string {
	return JSON.stringify([
		flag.lineIndex,
		flag.kind,
		flag.itemId ?? '',
		flag.optionId ?? '',
	])
}

/** Rounds exact usage to whole thousandths (halves up), drops zeros, sorts by item id. */
export function roundUsage(usage: ReadonlyMap<string, Fraction>): UsageLine[] {
	const lines: UsageLine[] = []
	for (const [itemId, amount] of usage) {
		const quantity = toSafeInteger(roundHalfUp(amount), 'usage')
		if (quantity > 0) lines.push({ itemId, quantity })
	}
	return lines.sort((a, b) =>
		a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0,
	)
}

/**
 * Raw quantities for a list of sold lines at a time. Exact fractions are
 * summed over every line and rounded once per item, so the result does not
 * depend on the order of the lines, and a line's rounding never loses more
 * than half a thousandth. A line whose recipes loop or nest too deep is left
 * out and reported in `errors`; a line with no recipe and no typed cost adds
 * nothing and is listed in `unrecipedLines`.
 */
export function expandLines(
	store: RecipeStore,
	lines: readonly SaleLine[],
	at: number,
): ExpandResult {
	const total = new Map<string, Fraction>()
	const unrecipedLines: UnrecipedLine[] = []
	const flags = new Map<string, ExpandFlag>()
	const errors: ExpandError[] = []
	lines.forEach((line, index) => {
		assertPositiveInteger(line.quantity, 'line quantity')
		const dish = expandDish(store, line, at)
		if (!dish.ok) {
			errors.push({ lineIndex: index, ...dish.error })
			return
		}
		for (const flag of dish.flags) {
			const full = { ...flag, lineIndex: index }
			flags.set(flagKey(full), full)
		}
		if (dish.state === 'none') {
			unrecipedLines.push({
				index,
				itemId: line.itemId,
				variantId: line.variantId ?? null,
				quantity: line.quantity,
			})
		}
		const quantity = frac(line.quantity)
		const limit = frac(MAX_ENTRY_QUANTITY)
		const scaled = [...dish.usage].map(
			([itemId, amount]) => [itemId, fmul(amount, quantity)] as const,
		)
		if (scaled.some(([, amount]) => fcmp(amount, limit) > 0)) {
			errors.push({ lineIndex: index, code: 'usage_out_of_range', path: [] })
			return
		}
		for (const [itemId, amount] of scaled) addTo(total, itemId, amount)
	})
	return {
		usage: roundUsage(total),
		unrecipedLines,
		flags: [...flags.values()].sort((a, b) =>
			flagKey(a) < flagKey(b) ? -1 : flagKey(a) > flagKey(b) ? 1 : 0,
		),
		errors,
	}
}

/** The raw quantities for one sold line (see `expandLines`). */
export function expandRecipe(
	store: RecipeStore,
	line: SaleLine,
	at: number,
): ExpandResult {
	return expandLines(store, [line], at)
}

/**
 * Whether adding or changing the recipe of made item `ownerItemId` so that it
 * lists `ingredientItemIds` would make an ingredient loop (the made item inside
 * itself, directly or through other made items) or nest too deep. Follows every
 * made item's recipe in force at `at`, whether or not it is counted in batches
 * (recording a batch expands it either way). The caller checks this before it
 * writes; the sale path expands defensively as well.
 */
export function checkMadeRecipeGraph(
	store: RecipeStore,
	ownerItemId: string,
	ingredientItemIds: readonly string[],
	at: number,
): { code: ExpandErrorCode; path: string[] } | null {
	const visit = (
		itemId: string,
		path: readonly string[],
	): { code: ExpandErrorCode; path: string[] } | null => {
		if (itemId === ownerItemId) {
			return { code: 'recipe_cycle', path: [...path, ownerItemId] }
		}
		if (store.items.get(itemId)?.kind !== 'made') return null
		const recipe = recipeInForce(store, 'made_item', itemId, at)
		if (!recipe) return null
		if (path.includes(itemId)) {
			return {
				code: 'recipe_cycle',
				path: [...path.slice(path.indexOf(itemId)), itemId],
			}
		}
		if (path.length >= MAX_RECIPE_DEPTH) {
			return { code: 'recipe_too_deep', path: [...path, itemId] }
		}
		for (const line of recipe.lines) {
			const found = visit(line.itemId, [...path, itemId])
			if (found) return found
		}
		return null
	}
	for (const itemId of [...ingredientItemIds].sort()) {
		// The owner is the first made item on the path.
		const found = visit(itemId, [ownerItemId])
		if (found) return found
	}
	return null
}
