import {
	createRecipeStore,
	type RecipeItemFacts,
	type RecipeLineSpec,
	type RecipeOwnerKind,
	type RecipeStore,
	type RecipeVersion,
} from '@repo/inventory'
import {
	invItemCosts,
	invItems,
	invRecipeLines,
	invRecipes,
} from '@repo/tenant-db'
import { and, desc, eq, inArray, lte, sql } from 'drizzle-orm'
import { queryInChunks } from '../lib/chunked-in.ts'
import { type InventoryReader } from '../lib/inventory-write.ts'

/**
 * Loads recipes from the regional database into the pure engine's store
 * (`createRecipeStore`). A recipe version in force at a time is the newest
 * version whose `effective_from` is at or before it (versions only move
 * forward), so a loader keeps one row per owner and reads lines for those
 * rows only. Every `IN (...)` is chunked (100 bound parameters per statement
 * on Durable Objects). Cleared versions load as empty versions so the engine
 * reads them as "no recipe".
 */

export type RecipeRow = typeof invRecipes.$inferSelect
export type RecipeLineRow = typeof invRecipeLines.$inferSelect

/** "Any time": the newest version of an owner, even one scheduled for later. */
export const FAR_FUTURE = Number.MAX_SAFE_INTEGER

export function toRecipeVersion(
	row: RecipeRow,
	lines: readonly RecipeLineRow[],
): RecipeVersion {
	const specs: RecipeLineSpec[] = [...lines]
		.sort((a, b) => a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : 1))
		.map((line) => ({
			itemId: line.itemId,
			quantity: line.quantity,
			usableBp: line.usableBp,
			mode: line.mode,
			replacesItemId: line.replacesItemId,
		}))
	return {
		ownerKind: row.ownerKind,
		ownerId: row.ownerId,
		version: row.version,
		effectiveFrom: row.effectiveFrom,
		makesQuantity: row.makesQuantity,
		multiplierBp: row.multiplierBp,
		typedCost:
			row.typedCostMinor !== null && row.typedCostCurrency
				? { minor: row.typedCostMinor, currency: row.typedCostCurrency }
				: null,
		lines: specs,
	}
}

export async function loadRecipeLines(
	db: InventoryReader,
	recipeIds: readonly string[],
): Promise<Map<string, RecipeLineRow[]>> {
	const rows = await queryInChunks(recipeIds, (chunk) =>
		db
			.select()
			.from(invRecipeLines)
			.where(inArray(invRecipeLines.recipeId, chunk)),
	)
	const byRecipe = new Map<string, RecipeLineRow[]>()
	for (const row of rows) {
		const list = byRecipe.get(row.recipeId)
		if (list) list.push(row)
		else byRecipe.set(row.recipeId, [row])
	}
	return byRecipe
}

/**
 * The version in force at `at` for each owner of `kind` (`null` owners: every
 * owner of the kind). Owners with no version at that time are absent.
 */
export async function loadVersionsAt(
	db: InventoryReader,
	kind: RecipeOwnerKind,
	ownerIds: readonly string[] | null,
	at: number,
): Promise<RecipeVersion[]> {
	if (ownerIds !== null && ownerIds.length === 0) return []
	const filter = (extra?: ReturnType<typeof inArray>) =>
		and(
			eq(invRecipes.ownerKind, kind),
			lte(invRecipes.effectiveFrom, at),
			extra,
		)
	const rows: RecipeRow[] =
		ownerIds === null
			? await db
					.select()
					.from(invRecipes)
					.where(filter())
					.orderBy(desc(invRecipes.version))
			: await queryInChunks([...new Set(ownerIds)], (chunk) =>
					db
						.select()
						.from(invRecipes)
						.where(filter(inArray(invRecipes.ownerId, chunk)))
						.orderBy(desc(invRecipes.version)),
				)
	const newest = new Map<string, RecipeRow>()
	for (const row of rows) {
		const current = newest.get(row.ownerId)
		if (!current || row.version > current.version) newest.set(row.ownerId, row)
	}
	const kept = [...newest.values()]
	const lines = await loadRecipeLines(
		db,
		kept.map((row) => row.id),
	)
	return kept.map((row) => toRecipeVersion(row, lines.get(row.id) ?? []))
}

/** Made items (archived ones too: history may still use them) as engine facts. */
export async function loadMadeItemFacts(
	db: InventoryReader,
): Promise<RecipeItemFacts[]> {
	const rows = await db
		.select({
			id: invItems.id,
			batchCounted: invItems.batchCounted,
		})
		.from(invItems)
		.where(eq(invItems.kind, 'made'))
	return rows.map((row) => ({
		id: row.id,
		kind: 'made' as const,
		batchCounted: row.batchCounted,
	}))
}

export type OwnerIds = Partial<Record<RecipeOwnerKind, readonly string[]>>

/**
 * A store with every made item's recipe and the recipes of the named owners,
 * as in force at `at`.
 */
export async function buildRecipeStore(
	db: InventoryReader,
	input: { at: number; owners?: OwnerIds; extra?: readonly RecipeVersion[] },
): Promise<{
	store: RecipeStore
	madeVersions: RecipeVersion[]
	facts: RecipeItemFacts[]
}> {
	const kinds = (['menu_item', 'variant', 'option'] as const).filter(
		(kind) => (input.owners?.[kind]?.length ?? 0) > 0,
	)
	const [madeVersions, facts, ...owned] = await Promise.all([
		loadVersionsAt(db, 'made_item', null, input.at),
		loadMadeItemFacts(db),
		...kinds.map((kind) =>
			loadVersionsAt(db, kind, input.owners?.[kind] ?? [], input.at),
		),
	])
	const store = createRecipeStore({
		recipes: [...madeVersions, ...owned.flat(), ...(input.extra ?? [])],
		items: facts,
	})
	return { store, madeVersions, facts }
}

export type ItemCosts = {
	/** Last delivered cost per base unit (micro-minor) by item id. */
	last: Map<string, number | null>
	/** Weighted average cost per base unit (micro-minor) by item id. */
	average: Map<string, number | null>
	/**
	 * The currency of the FIRST priced item. Kept for callers that label one
	 * total; value of an item is in `currencyByItem` (an item has one cost
	 * currency, and a location only prices stock in its own currency).
	 */
	currency: string | null
	/** The currency each priced item's cost is in. */
	currencyByItem: Map<string, string>
}

/** Every item's costs in one unfiltered read (no `IN` list). */
export async function loadItemCosts(db: InventoryReader): Promise<ItemCosts> {
	const rows = await db
		.select({
			itemId: invItemCosts.itemId,
			currency: invItemCosts.currency,
			last: invItemCosts.lastCostMicro,
			average: invItemCosts.avgCostMicro,
		})
		.from(invItemCosts)
		.orderBy(sql`rowid`)
	const last = new Map<string, number | null>()
	const average = new Map<string, number | null>()
	const currencyByItem = new Map<string, string>()
	for (const row of rows) {
		last.set(row.itemId, row.last)
		average.set(row.itemId, row.average)
		currencyByItem.set(row.itemId, row.currency)
	}
	return { last, average, currency: rows[0]?.currency ?? null, currencyByItem }
}

/** The first typed-cost currency among loaded versions (a fallback when nothing is priced). */
export function typedCostCurrency(store: RecipeStore): string | null {
	for (const versions of store.versions.values()) {
		for (const version of versions) {
			if (version.typedCost) return version.typedCost.currency
		}
	}
	return null
}
