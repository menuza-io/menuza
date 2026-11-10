import { createRecipeStore, type RecipeStore } from './store.ts'
import {
	type RecipeItemFacts,
	type RecipeLineSpec,
	type RecipeVersion,
} from './types.ts'
import { type RecipeOwnerKind } from '../records.ts'

/** Test helpers: terse recipe and store builders (not exported from the package). */

export type LineTuple = [itemId: string, quantity: number, usableBp?: number]

export function line(
	itemId: string,
	quantity: number,
	usableBp = 10_000,
): RecipeLineSpec {
	return { itemId, quantity, usableBp, mode: 'add', replacesItemId: null }
}

export function replaceLine(
	itemId: string,
	quantity: number,
	replacesItemId: string,
	usableBp = 10_000,
): RecipeLineSpec {
	return { itemId, quantity, usableBp, mode: 'replace', replacesItemId }
}

export function recipe(
	ownerKind: RecipeOwnerKind,
	ownerId: string,
	lines: readonly (RecipeLineSpec | LineTuple)[],
	overrides: Partial<
		Omit<RecipeVersion, 'ownerKind' | 'ownerId' | 'lines'>
	> = {},
): RecipeVersion {
	return {
		ownerKind,
		ownerId,
		version: 1,
		effectiveFrom: 0,
		makesQuantity: ownerKind === 'made_item' ? 1_000_000 : null,
		multiplierBp: null,
		typedCost: null,
		lines: lines.map((entry) =>
			Array.isArray(entry) ? line(entry[0], entry[1], entry[2]) : entry,
		),
		...overrides,
	}
}

export function item(
	id: string,
	kind: RecipeItemFacts['kind'] = 'bought',
	batchCounted = false,
): RecipeItemFacts {
	return { id, kind, batchCounted }
}

export function store(
	recipes: RecipeVersion[],
	items: RecipeItemFacts[] = [],
): RecipeStore {
	return createRecipeStore({ recipes, items })
}

export function usageOf(result: {
	usage: { itemId: string; quantity: number }[]
}): Record<string, number> {
	return Object.fromEntries(result.usage.map((u) => [u.itemId, u.quantity]))
}
