import { type RecipeOwnerKind } from '../records.ts'
import { type RecipeItemFacts, type RecipeVersion } from './types.ts'

/**
 * Every recipe version and the facts about items the engine reads, as plain
 * maps. The region loads what a sale touches into one of these and the engine
 * never does I/O.
 */
export type RecipeStore = {
	/** Versions by owner (`recipeKey`), oldest `effectiveFrom` first. */
	readonly versions: ReadonlyMap<string, readonly RecipeVersion[]>
	readonly items: ReadonlyMap<string, RecipeItemFacts>
}

export function recipeKey(kind: RecipeOwnerKind, id: string): string {
	return `${kind}:${id}`
}

export function createRecipeStore(input: {
	recipes: Iterable<RecipeVersion>
	items?: Iterable<RecipeItemFacts>
}): RecipeStore {
	const grouped = new Map<string, RecipeVersion[]>()
	for (const recipe of input.recipes) {
		const key = recipeKey(recipe.ownerKind, recipe.ownerId)
		const list = grouped.get(key)
		if (list) list.push(recipe)
		else grouped.set(key, [recipe])
	}
	for (const list of grouped.values()) {
		list.sort(
			(a, b) => a.effectiveFrom - b.effectiveFrom || a.version - b.version,
		)
	}
	const items = new Map<string, RecipeItemFacts>()
	for (const item of input.items ?? []) items.set(item.id, item)
	return { versions: grouped, items }
}

/** A version with nothing in it is a cleared recipe: the owner has none. */
export function isEmptyRecipe(recipe: RecipeVersion): boolean {
	return (
		recipe.lines.length === 0 &&
		recipe.typedCost === null &&
		recipe.multiplierBp === null
	)
}

/**
 * The recipe in force for an owner at `at` (epoch ms): the newest version
 * whose `effectiveFrom` is at or before it. `null` when there is none yet or
 * the newest version in force was cleared. A sale before the first version
 * starts is never costed with a recipe written later.
 */
export function recipeInForce(
	store: RecipeStore,
	kind: RecipeOwnerKind,
	id: string,
	at: number,
): RecipeVersion | null {
	const list = store.versions.get(recipeKey(kind, id))
	if (!list) return null
	let found: RecipeVersion | null = null
	for (const recipe of list) {
		if (recipe.effectiveFrom <= at) found = recipe
		else break
	}
	if (!found || isEmptyRecipe(found)) return null
	return found
}
