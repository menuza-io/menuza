/**
 * Roll allergens from stock items up to a dish (#496).
 *
 * The keys are the menu's allergen list (`ALLERGENS` in menu-types). Milk is
 * `dairy` ("Dairy" in English). Inventory names are never translated.
 * Unconfirmed name suggestions do not roll up. Nothing here writes the menu.
 */

import { ALLERGENS, type Allergen } from './menu-types.ts'

export function isAllergen(value: unknown): value is Allergen {
	return (
		typeof value === 'string' &&
		(ALLERGENS as readonly string[]).includes(value)
	)
}

export function parseAllergenList(value: unknown): Allergen[] {
	const raw = Array.isArray(value)
		? value
		: typeof value === 'string'
			? safeJson(value)
			: []
	const found = new Set<Allergen>()
	for (const entry of raw) {
		if (isAllergen(entry)) found.add(entry)
	}
	return ALLERGENS.filter((allergen) => found.has(allergen))
}

function safeJson(value: string): unknown[] {
	try {
		const parsed = JSON.parse(value) as unknown
		return Array.isArray(parsed) ? parsed : []
	} catch {
		return []
	}
}

/**
 * Words in a stock-item name that suggest an allergen. The operator must
 * confirm before it is stored as the item's allergens.
 */
const NAME_HINTS: ReadonlyArray<{ allergen: Allergen; pattern: RegExp }> = [
	{
		allergen: 'dairy',
		pattern: /\b(milk|dairy|cheese|butter|cream|yogurt|yoghurt|whey|ghee)\b/i,
	},
	{ allergen: 'eggs', pattern: /\b(egg|eggs)\b/i },
	{ allergen: 'fish', pattern: /\b(fish|salmon|tuna|cod|anchovy)\b/i },
	{ allergen: 'gluten', pattern: /\b(wheat|gluten|flour|barley|rye|bread)\b/i },
	{ allergen: 'peanuts', pattern: /\b(peanut|peanuts)\b/i },
	{ allergen: 'sesame', pattern: /\b(sesame|tahini)\b/i },
	{
		allergen: 'shellfish',
		pattern: /\b(shrimp|prawn|crab|lobster|shellfish)\b/i,
	},
	{ allergen: 'soy', pattern: /\b(soy|soya|tofu|edamame)\b/i },
	{
		allergen: 'tree_nuts',
		pattern: /\b(almond|cashew|walnut|pistachio|hazelnut|pecan|nut)\b/i,
	},
	{ allergen: 'mango', pattern: /\bmango\b/i },
]

export type AllergenSuggestion = {
	allergens: Allergen[]
	/** Always true for a name guess: the label must be checked. */
	suggested: true
}

export function suggestAllergensFromName(
	name: string,
): AllergenSuggestion | null {
	const found = new Set<Allergen>()
	for (const hint of NAME_HINTS) {
		if (hint.pattern.test(name)) found.add(hint.allergen)
	}
	if (found.size === 0) return null
	return {
		allergens: ALLERGENS.filter((allergen) => found.has(allergen)),
		suggested: true,
	}
}

export type RecipeAllergenItem = {
	id: string
	name: string
	/** Confirmed allergens only. A suggestion the operator has not checked is empty here. */
	allergens: readonly Allergen[]
	/** Nested made-item ingredients, already loaded. */
	ingredients?: readonly RecipeAllergenItem[]
}

export type RecipeAllergenRollup = {
	allergens: Allergen[]
	/** Ingredient names that contributed, in first-seen order. Not translated. */
	sources: string[]
}

function addItem(
	item: RecipeAllergenItem,
	found: Set<Allergen>,
	sources: string[],
	seen: Set<string>,
	depth: number,
) {
	if (seen.has(item.id) || depth > 8) return
	seen.add(item.id)
	const before = found.size
	for (const allergen of item.allergens) {
		if (isAllergen(allergen)) found.add(allergen)
	}
	if (item.ingredients) {
		for (const child of item.ingredients) {
			addItem(child, found, sources, seen, depth + 1)
		}
	}
	if (
		found.size > before ||
		(item.ingredients && item.ingredients.length > 0)
	) {
		if (!sources.includes(item.name)) sources.push(item.name)
	} else if (item.allergens.length > 0 && !sources.includes(item.name)) {
		sources.push(item.name)
	}
}

/** Confirmed allergens of the ingredients and made items, plus option lines. */
export function rollUpRecipeAllergens(
	ingredients: readonly RecipeAllergenItem[],
	optionIngredients: readonly RecipeAllergenItem[] = [],
): RecipeAllergenRollup {
	const found = new Set<Allergen>()
	const sources: string[] = []
	const seen = new Set<string>()
	for (const item of [...ingredients, ...optionIngredients]) {
		addItem(item, found, sources, seen, 0)
	}
	return {
		allergens: ALLERGENS.filter((allergen) => found.has(allergen)),
		sources,
	}
}

export function allergenListsDiffer(
	menuAllergens: readonly string[],
	recipeAllergens: readonly Allergen[],
): boolean {
	const menu = new Set(parseAllergenList([...menuAllergens]))
	if (menu.size !== recipeAllergens.length) return true
	return recipeAllergens.some((allergen) => !menu.has(allergen))
}

/** The one-click apply: the menu's typed list becomes the recipe rollup. */
export function applyRecipeAllergens(
	recipeAllergens: readonly Allergen[],
): Allergen[] {
	return parseAllergenList([...recipeAllergens])
}
