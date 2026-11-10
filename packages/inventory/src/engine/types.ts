import { type RecipeLineMode, type RecipeOwnerKind } from '../records.ts'

/** One ingredient of a stored recipe version (quantity in base thousandths). */
export type RecipeLineSpec = {
	itemId: string
	/** What ends up in the dish, base thousandths of the ingredient. */
	quantity: number
	/** Usable yield, 1..10000. Raw quantity needed is `quantity * 10000 / usableBp`. */
	usableBp: number
	mode: RecipeLineMode
	/** On a `replace` line: the ingredient of the dish it swaps out. */
	replacesItemId: string | null
}

/** One stored version of the recipe of an owner. */
export type RecipeVersion = {
	ownerKind: RecipeOwnerKind
	ownerId: string
	version: number
	/** Epoch ms the version starts to apply to sales. */
	effectiveFrom: number
	/** Made items: base thousandths one batch makes. */
	makesQuantity: number | null
	/** Variants: 10000 is 1x of the item's recipe; null is "its own recipe". */
	multiplierBp: number | null
	typedCost: { minor: number; currency: string } | null
	lines: readonly RecipeLineSpec[]
}

/** What the engine needs to know of an inventory item. */
export type RecipeItemFacts = {
	id: string
	kind: 'bought' | 'made'
	/** "We make this in batches and count it": sales use the item itself. */
	batchCounted: boolean
}

/** A sold option: `quantity` is per dish (a line of 3 dishes with quantity 2 is 6). */
export type SaleOption = {
	optionId: string
	quantity?: number
	/** Pizza halves: a `left` or `right` option takes half of its recipe. */
	half?: 'whole' | 'left' | 'right' | null
}

/** One sold line: a dish, maybe a size, and its options. */
export type SaleLine = {
	itemId: string
	variantId?: string | null
	quantity: number
	options?: readonly SaleOption[]
}

/** Raw quantity of one inventory item, base thousandths. */
export type UsageLine = { itemId: string; quantity: number }

export type UnrecipedLine = {
	index: number
	itemId: string
	variantId: string | null
	quantity: number
}

export const EXPAND_FLAG_KINDS = [
	/** An option replaces an ingredient the dish does not have: treated as an add. */
	'replace_base_missing',
	/** A made item has no recipe in force: the sale uses the item itself. */
	'made_item_without_recipe',
	/** A size is a multiple of an item recipe that does not exist. */
	'multiplier_without_base',
] as const
export type ExpandFlagKind = (typeof EXPAND_FLAG_KINDS)[number]

export type ExpandFlag = {
	kind: ExpandFlagKind
	lineIndex: number
	itemId?: string
	optionId?: string
}

export const EXPAND_ERROR_CODES = [
	'recipe_cycle',
	'recipe_too_deep',
	/** One line would use more than `MAX_ENTRY_QUANTITY` of an ingredient (bad data). */
	'usage_out_of_range',
] as const
export type ExpandErrorCode = (typeof EXPAND_ERROR_CODES)[number]

export type ExpandError = {
	lineIndex: number
	code: ExpandErrorCode
	/** Made item ids from the outermost to where it looped or got too deep. */
	path: string[]
}

export type ExpandResult = {
	/** Raw quantity per inventory item (leaf ingredients, or batch-counted made items), sorted by item id. */
	usage: UsageLine[]
	/** Lines that resolved to no recipe and no typed cost. */
	unrecipedLines: UnrecipedLine[]
	flags: ExpandFlag[]
	/** Lines left out because their recipes loop or nest too deep. */
	errors: ExpandError[]
}
