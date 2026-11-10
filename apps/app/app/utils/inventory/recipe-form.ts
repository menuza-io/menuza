import {
	displayUnitFor,
	dishFoodCostBp,
	type FoodCostStatus,
	foodCostStatus,
	type InventoryBaseUnit,
	MAX_MULTIPLIER_BP,
	MAX_RECIPE_LINES,
	MIN_MULTIPLIER_BP,
	type PlateCost,
	type PutRecipe,
	priceForTargetMinor,
	type Recipe,
	type RecipeOwnerKind,
	roundForDisplay,
	type UnitRef,
	type UnitSystem,
} from '@repo/inventory'
import { currencyExponent, parseMoneyToMinor } from '#app/utils/money-input.ts'
import { type ItemUnitLike, thousandthsInUnit } from './format.ts'

/**
 * The editable state of one recipe, and the pure rules around it. The panels
 * keep a draft, compare it with the recipe as loaded, validate it and turn it
 * into the `PUT /recipes` body. Nothing here fetches or renders.
 */

export type RecipeMode = 'lines' | 'typed' | 'multiplier'

export type RecipeLineDraft = {
	/** A local key for React lists; never sent. */
	key: string
	itemId: string | null
	itemName: string
	baseUnit: InventoryBaseUnit | null
	/** The ingredient's named units ("Box"), when known. */
	units: ItemUnitLike[]
	amount: number | null
	unit: UnitRef | null
	/** "Usable %" as a person types it, 1 to 100 (null while empty). */
	usablePercent: number | null
	mode: 'add' | 'replace'
	/** Option recipes only: the ingredient of the dish this line swaps out. */
	replacesItemId: string | null
	replacesItemName: string
}

export type RecipeDraft = {
	mode: RecipeMode
	lines: RecipeLineDraft[]
	/** Typed cost per dish, as typed ("6.50"). */
	typedCostText: string
	/** Size multiplier as typed: 1 is "same recipe", 2 is double. */
	multiplier: number | null
	/** Made items: how much one batch makes. */
	makesAmount: number | null
	makesUnit: UnitRef | null
}

let lineCounter = 0
export function newLineKey(): string {
	lineCounter += 1
	return `line-${lineCounter}`
}

export function emptyLine(
	mode: 'add' | 'replace' = 'add',
	overrides: Partial<RecipeLineDraft> = {},
): RecipeLineDraft {
	return {
		key: newLineKey(),
		itemId: null,
		itemName: '',
		baseUnit: null,
		units: [],
		amount: null,
		unit: null,
		usablePercent: 100,
		mode,
		replacesItemId: null,
		replacesItemName: '',
		...overrides,
	}
}

export function emptyDraft(ownerKind: RecipeOwnerKind): RecipeDraft {
	return {
		mode: ownerKind === 'variant' ? 'multiplier' : 'lines',
		lines: [],
		typedCostText: '',
		multiplier: ownerKind === 'variant' ? 1 : null,
		makesAmount: null,
		makesUnit: null,
	}
}

/** The unit an ingredient amount is first offered in: grams, millilitres, pieces (ounces in US units). */
export function recipeEntryUnit(
	baseUnit: InventoryBaseUnit,
	system: UnitSystem,
): UnitRef {
	if (baseUnit === 'piece') return 'piece'
	if (system === 'us') return baseUnit === 'g' ? 'oz' : 'fl_oz'
	return baseUnit
}

// ── Money and basis points ──────────────────────────────────────────────────

/** A menu price in major units (the control plane keeps REAL majors) as minor units. */
export function majorToMinor(major: number, currency: string): number {
	return Math.round(major * 10 ** currencyExponent(currency))
}

export function percentToBp(percent: number): number {
	return Math.round(percent * 100)
}

export function bpToPercent(bp: number): number {
	return Math.round(bp) / 100
}

/** 29.8% from 2980 basis points. */
export function formatPercentBp(bp: number, locale: string): string {
	return new Intl.NumberFormat(locale, {
		style: 'percent',
		maximumFractionDigits: 1,
	}).format(bp / 10_000)
}

/** The region's inventory currency for a data region (as the order context does). */
export function regionCurrency(dataRegion: string | null | undefined): string {
	return dataRegion === 'ksa' ? 'SAR' : 'USD'
}

// ── From the loaded recipe to a draft ───────────────────────────────────────

export type KnownItem = {
	id: string
	name: string
	baseUnit: InventoryBaseUnit
	units: ItemUnitLike[]
}

/**
 * The draft for a recipe as the region returns it. Stored quantities are base
 * thousandths, so each line is shown in the unit that reads best for its
 * quantity (`known` supplies named units when the ingredient was looked up).
 */
export function draftFromRecipe(
	recipe: Recipe | null,
	ownerKind: RecipeOwnerKind,
	options: {
		system: UnitSystem
		currency: string
		known?: ReadonlyMap<string, KnownItem>
	},
): RecipeDraft {
	const draft = emptyDraft(ownerKind)
	if (!recipe) return draft
	if (recipe.multiplierBp !== null && ownerKind === 'variant') {
		return {
			...draft,
			mode: 'multiplier',
			multiplier: recipe.multiplierBp / 10_000,
		}
	}
	const lines = recipe.lines.map((line): RecipeLineDraft => {
		const unit = displayUnitFor(line.quantity, line.baseUnit, options.system)
		const per = thousandthsInUnit(unit, line.baseUnit) ?? 1000
		return {
			key: newLineKey(),
			itemId: line.itemId,
			itemName: line.itemName,
			baseUnit: line.baseUnit,
			units: options.known?.get(line.itemId)?.units ?? [],
			amount: roundForDisplay(line.quantity / per),
			unit,
			usablePercent: bpToPercent(line.usableBp),
			mode: line.mode,
			replacesItemId: line.replacesItemId,
			replacesItemName: line.replacesItemName ?? '',
		}
	})
	const makes: Pick<RecipeDraft, 'makesAmount' | 'makesUnit'> =
		ownerKind === 'made_item' && recipe.makesQuantity !== null
			? (() => {
					// The made item's own base unit is the ingredient base unit of
					// the recipe's owner; the caller supplies it through `known`.
					const owner = options.known?.get(recipe.ownerId)
					if (!owner) return { makesAmount: null, makesUnit: null }
					const unit = displayUnitFor(
						recipe.makesQuantity!,
						owner.baseUnit,
						options.system,
					)
					const per = thousandthsInUnit(unit, owner.baseUnit) ?? 1000
					return {
						makesAmount: roundForDisplay(recipe.makesQuantity! / per),
						makesUnit: unit,
					}
				})()
			: { makesAmount: null, makesUnit: null }
	// A recipe with no ingredients and no multiplier can only be a typed cost
	// (an empty one is refused). The amount is absent without the cost grant.
	if (lines.length === 0 && ownerKind !== 'made_item') {
		const exponent = currencyExponent(
			recipe.typedCostCurrency ?? options.currency,
		)
		return {
			...draft,
			mode: 'typed',
			typedCostText:
				recipe.typedCostMinor === undefined
					? ''
					: (recipe.typedCostMinor / 10 ** exponent).toFixed(exponent),
			...makes,
		}
	}
	return { ...draft, mode: 'lines', lines, ...makes }
}

// ── Editing ─────────────────────────────────────────────────────────────────

export function addLine(
	draft: RecipeDraft,
	line: RecipeLineDraft = emptyLine(),
): RecipeDraft {
	if (draft.lines.length >= MAX_RECIPE_LINES) return draft
	return { ...draft, mode: 'lines', lines: [...draft.lines, line] }
}

export function removeLine(draft: RecipeDraft, key: string): RecipeDraft {
	return { ...draft, lines: draft.lines.filter((line) => line.key !== key) }
}

export function updateLine(
	draft: RecipeDraft,
	key: string,
	patch: Partial<RecipeLineDraft>,
): RecipeDraft {
	return {
		...draft,
		lines: draft.lines.map((line) =>
			line.key === key ? { ...line, ...patch } : line,
		),
	}
}

/**
 * Pick an ingredient for a line. Its unit follows the ingredient: kept when the
 * ingredient can be measured in it, else the ingredient's best entry unit.
 */
export function chooseLineItem(
	draft: RecipeDraft,
	key: string,
	item: KnownItem,
	defaultUnit: UnitRef,
): RecipeDraft {
	return updateLine(draft, key, {
		itemId: item.id,
		itemName: item.name,
		baseUnit: item.baseUnit,
		units: item.units,
		unit: defaultUnit,
	})
}

/**
 * Change the unit of a line and convert the typed amount so the quantity
 * stays the same ("0.18 kg" becomes "180 g"). An amount that cannot be
 * converted is left as typed.
 */
export function convertLineUnit(
	line: RecipeLineDraft,
	next: UnitRef,
): RecipeLineDraft {
	if (!line.unit || line.amount === null || !line.baseUnit) {
		return { ...line, unit: next }
	}
	const from = thousandthsInUnit(line.unit, line.baseUnit, line.units)
	const to = thousandthsInUnit(next, line.baseUnit, line.units)
	if (from === null || to === null) return { ...line, unit: next }
	return {
		...line,
		unit: next,
		amount: Math.round(((line.amount * from) / to) * 1000) / 1000,
	}
}

export function setMode(draft: RecipeDraft, mode: RecipeMode): RecipeDraft {
	if (mode === draft.mode) return draft
	if (mode === 'multiplier') {
		return { ...draft, mode, multiplier: draft.multiplier ?? 1 }
	}
	return { ...draft, mode }
}

// ── Validation ──────────────────────────────────────────────────────────────

export type RecipeProblem =
	| 'empty'
	| 'typed_cost'
	| 'multiplier'
	| 'makes'
	| 'duplicate'
	| { line: string; field: 'item' | 'amount' | 'unit' | 'usable' | 'replaces' }

export type RecipeProblemList = readonly RecipeProblem[]

export function hasProblem(
	problems: RecipeProblemList,
	problem: Exclude<RecipeProblem, { line: string }>,
): boolean {
	return problems.includes(problem)
}

export function lineProblems(
	problems: RecipeProblemList,
	key: string,
): Set<'item' | 'amount' | 'unit' | 'usable' | 'replaces'> {
	const found = new Set<'item' | 'amount' | 'unit' | 'usable' | 'replaces'>()
	for (const problem of problems) {
		if (typeof problem === 'object' && problem.line === key) {
			found.add(problem.field)
		}
	}
	return found
}

export type RecipeRules = {
	ownerKind: RecipeOwnerKind
	currency: string
}

/** What is wrong with the draft, in the order a person would fix it. */
export function recipeProblems(
	draft: RecipeDraft,
	rules: RecipeRules,
): RecipeProblem[] {
	const problems: RecipeProblem[] = []
	if (draft.mode === 'multiplier') {
		const bp =
			draft.multiplier === null ? null : Math.round(draft.multiplier * 10_000)
		if (bp === null || bp < MIN_MULTIPLIER_BP || bp > MAX_MULTIPLIER_BP) {
			problems.push('multiplier')
		}
		return problems
	}
	if (draft.mode === 'typed') {
		if (
			parseMoneyToMinor(draft.typedCostText, {
				currency: rules.currency,
				min: 0,
			}) === null
		) {
			problems.push('typed_cost')
		}
		return problems
	}
	if (rules.ownerKind === 'made_item') {
		if (
			draft.makesAmount === null ||
			draft.makesAmount <= 0 ||
			draft.makesUnit === null
		) {
			problems.push('makes')
		}
	}
	if (draft.lines.length === 0) problems.push('empty')
	const seen = new Set<string>()
	let duplicate = false
	for (const line of draft.lines) {
		if (!line.itemId) problems.push({ line: line.key, field: 'item' })
		else if (seen.has(line.itemId)) duplicate = true
		else seen.add(line.itemId)
		if (line.amount === null || !(line.amount > 0)) {
			problems.push({ line: line.key, field: 'amount' })
		}
		if (line.unit === null) problems.push({ line: line.key, field: 'unit' })
		if (
			line.usablePercent === null ||
			line.usablePercent < 1 ||
			line.usablePercent > 100
		) {
			problems.push({ line: line.key, field: 'usable' })
		}
		if (line.mode === 'replace') {
			if (!line.replacesItemId || line.replacesItemId === line.itemId) {
				problems.push({ line: line.key, field: 'replaces' })
			}
		}
	}
	if (duplicate) problems.push('duplicate')
	return problems
}

// ── To the wire ─────────────────────────────────────────────────────────────

/**
 * The `PUT /recipes` body for a valid draft, or null while there are problems.
 * Only ids and numbers leave the browser: never an ingredient or dish name.
 */
export function buildPutRecipe(
	draft: RecipeDraft,
	input: {
		ownerKind: RecipeOwnerKind
		ownerId: string
		expectedVersion: number
		currency: string
	},
): PutRecipe | null {
	if (
		recipeProblems(draft, {
			ownerKind: input.ownerKind,
			currency: input.currency,
		}).length > 0
	) {
		return null
	}
	const base = {
		ownerKind: input.ownerKind,
		ownerId: input.ownerId,
		expectedVersion: input.expectedVersion,
	}
	if (draft.mode === 'multiplier') {
		return {
			...base,
			lines: [],
			multiplierBp: Math.round((draft.multiplier ?? 1) * 10_000),
		}
	}
	if (draft.mode === 'typed') {
		return {
			...base,
			lines: [],
			typedCost: {
				minor: parseMoneyToMinor(draft.typedCostText, {
					currency: input.currency,
					min: 0,
				})!,
				currency: input.currency,
			},
		}
	}
	return {
		...base,
		lines: draft.lines.map((line) => ({
			itemId: line.itemId!,
			amount: line.amount!,
			unit: line.unit!,
			usableBp: percentToBp(line.usablePercent!),
			mode: line.mode,
			...(line.mode === 'replace'
				? { replacesItemId: line.replacesItemId! }
				: {}),
		})),
		...(input.ownerKind === 'made_item'
			? { makes: { amount: draft.makesAmount!, unit: draft.makesUnit! } }
			: {}),
	}
}

/** Whether the draft differs from the one the recipe loaded as. */
export function isRecipeDirty(
	draft: RecipeDraft,
	baseline: RecipeDraft,
): boolean {
	const shape = (value: RecipeDraft) =>
		JSON.stringify({
			mode: value.mode,
			lines:
				value.mode === 'lines'
					? value.lines.map(({ key: _key, ...line }) => ({
							...line,
							itemName: undefined,
							replacesItemName: undefined,
							units: undefined,
						}))
					: [],
			typed: value.mode === 'typed' ? value.typedCostText.trim() : '',
			multiplier: value.mode === 'multiplier' ? value.multiplier : null,
			makes: [value.makesAmount, value.makesUnit],
		})
	return shape(draft) !== shape(baseline)
}

// ── What the cost row shows ─────────────────────────────────────────────────

export type PlateView = {
	/** False when the region left money out (no cost grant): show none. */
	showMoney: boolean
	state: PlateCost['state']
	costMinor: number | null
	currency: string
	/** The cost is typed by the owner, not built from ingredients. */
	typed: boolean
	/** How many ingredients have no delivered price yet. */
	unpricedCount: number
	foodCostBp: number | null
	status: FoodCostStatus | null
	priceForTargetMinor: number | null
}

/**
 * What the summary row shows for a plate cost, a menu price and the target.
 * Without `costMinor` (the region leaves money out for a member without the
 * cost grant) there is nothing to show: never a zero.
 */
export function plateView(
	plate: PlateCost | undefined,
	options: {
		priceMinor: number | null
		targetBp: number | null
		currency: string
	},
): PlateView {
	const costMinor = plate?.costMinor ?? null
	const state = plate?.state ?? 'none'
	const showMoney = costMinor !== null
	const foodCostBp =
		showMoney && options.priceMinor !== null
			? dishFoodCostBp(options.priceMinor, costMinor)
			: null
	return {
		showMoney,
		state,
		costMinor,
		currency: plate?.currency ?? options.currency,
		typed: state === 'typed',
		unpricedCount: plate?.missingItemIds.length ?? 0,
		foodCostBp,
		status:
			foodCostBp !== null && options.targetBp !== null
				? foodCostStatus(foodCostBp, options.targetBp)
				: null,
		priceForTargetMinor:
			showMoney && options.targetBp !== null
				? priceForTargetMinor(costMinor, options.targetBp)
				: null,
	}
}

/** The same view for a row of `POST /recipes/costs`, joined by key. */
export function costRowView(
	row:
		| {
				hasRecipe: boolean
				state: PlateCost['state']
				costMinor?: number
				currency?: string
				foodCostBp?: number
				status?: FoodCostStatus
		  }
		| undefined,
): {
	hasRecipe: boolean
	foodCostBp: number | null
	status: FoodCostStatus | null
} {
	if (!row || !row.hasRecipe) {
		return { hasRecipe: false, foodCostBp: null, status: null }
	}
	return {
		hasRecipe: true,
		foodCostBp: row.foodCostBp ?? null,
		status: row.status ?? null,
	}
}

/** Menu items to ask about, in chunks the region accepts (200 at most). */
export function chunk<T>(rows: readonly T[], size: number): T[][] {
	const out: T[][] = []
	for (let index = 0; index < rows.length; index += size) {
		out.push(rows.slice(index, index + size))
	}
	return out
}
