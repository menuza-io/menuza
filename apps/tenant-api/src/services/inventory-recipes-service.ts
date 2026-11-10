import {
	checkMadeRecipeGraph,
	createRecipeStore,
	dishFoodCostBp,
	foodCostStatus,
	INVENTORY_PERMISSIONS,
	isEmptyRecipe,
	plateCost,
	priceForTargetMinor,
	rankDishesWithoutRecipe,
	STATION_LATE_SYNC_MS,
	type FoodCostStatus,
	type MenuPriceTax,
	type PlateCostState,
	type RecipeItemFacts,
	type RecipeOwnerKind,
	type RecipeVersion,
	type SaleOption,
} from '@repo/inventory'
import { addDays } from '@repo/reservations'
import {
	invItems,
	invLocationSettings,
	invRecipeLines,
	invRecipes,
} from '@repo/tenant-db'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { chunkIds, queryInChunks } from '../lib/chunked-in.ts'
import { InventoryError } from '../lib/inventory-http.ts'
import {
	type InventoryIdempotency,
	type InventoryReader,
	type InventoryTx,
	withInventoryWrite,
} from '../lib/inventory-write.ts'
import { recordInventoryAudit } from './inventory-audit.ts'
import {
	assertVersion,
	badRequest,
	loadItemUnits,
	locationBusinessDate,
	markUnitsUsed,
	newId,
	notFound,
	stateConflict,
	typedToBase,
	type ItemUnitRow,
} from './inventory-common.ts'
import {
	type ClearRecipeInput,
	type PutRecipeInput,
	type RecipeCostsInput,
	type RecipeOwnerInput,
} from './inventory-contract-types.ts'
import { type InventoryCaller } from './inventory-items-service.ts'
import { getInventorySettings } from './inventory-settings-service.ts'
import {
	buildRecipeStore,
	FAR_FUTURE,
	loadItemCosts,
	loadRecipeLines,
	toRecipeVersion,
	typedCostCurrency,
	type ItemCosts,
	type RecipeLineRow,
	type RecipeRow,
} from './inventory-recipe-store.ts'
import { readItemSales } from './item-sales.ts'

/**
 * Recipes: what is in a dish, a size, an option or a made-in-house item.
 *
 * - A recipe is never edited in place. Each change is a NEW version
 *   (`inv_recipes.version`, `effective_from`); the old row is only stamped
 *   `superseded_at` (first, in the same transaction, because the unique
 *   "current" index allows one open row per owner). A sale is costed and
 *   deducted with the version in force when it happened.
 * - Clearing writes an empty version (no lines, no typed cost, no multiplier):
 *   from then on the owner has no recipe, and the history stays.
 * - Owners are opaque ids for menu items, sizes and options (the control plane
 *   owns those; nothing here checks them) and inventory item ids for made items.
 * - Money (plate cost, typed cost, per-line cost, food cost) is built only for
 *   a caller with the cost grant. The router strips the same fields again.
 */

/** Stand-in owner ids for costing a single line, a made item's batch or a size on its own. */
const SYNTHETIC_DISH = '__recipe__'
const NO_MENU_ITEM = '__no_menu_item__'

export type RecipeCaller = Pick<
	InventoryCaller,
	'orgId' | 'region' | 'actor' | 'cost'
>

type PlateOut = {
	state: PlateCostState
	missingItemIds: string[]
	costMinor?: number
	currency?: string
	typedCostMinor?: number
}

type RecipeLineOut = {
	id: string
	itemId: string
	itemName: string
	baseUnit: 'g' | 'ml' | 'piece'
	quantity: number
	usableBp: number
	mode: 'add' | 'replace'
	replacesItemId: string | null
	replacesItemName: string | null
	sortOrder: number
	costMinor?: number
	priced: boolean
}

export type RecipeOut = {
	id: string
	ownerKind: RecipeOwnerKind
	ownerId: string
	version: number
	makesQuantity: number | null
	multiplierBp: number | null
	typedCostMinor?: number
	typedCostCurrency?: string
	method: string | null
	effectiveFrom: number
	createdAt: number
	lines: RecipeLineOut[]
	plate?: PlateOut
}

export type RecipeResult = { recipe: RecipeOut | null; version: number }

// ── Reading one recipe ──────────────────────────────────────────────────────

async function currentRow(
	db: InventoryReader,
	owner: RecipeOwnerInput,
): Promise<RecipeRow | null> {
	const row = await db
		.select()
		.from(invRecipes)
		.where(
			and(
				eq(invRecipes.ownerKind, owner.ownerKind),
				eq(invRecipes.ownerId, owner.ownerId),
				isNull(invRecipes.supersededAt),
			),
		)
		.get()
	return row ?? null
}

type ItemInfo = {
	name: string
	baseUnit: 'g' | 'ml' | 'piece'
	kind: 'bought' | 'made'
	archived: boolean
}

async function loadItemInfo(
	db: InventoryReader,
	itemIds: readonly string[],
): Promise<Map<string, ItemInfo>> {
	const rows = await queryInChunks([...new Set(itemIds)], (chunk) =>
		db
			.select({
				id: invItems.id,
				name: invItems.name,
				baseUnit: invItems.baseUnit,
				kind: invItems.kind,
				archivedAt: invItems.archivedAt,
			})
			.from(invItems)
			.where(inArray(invItems.id, chunk)),
	)
	return new Map(
		rows.map((row) => [
			row.id,
			{
				name: row.name,
				baseUnit: row.baseUnit,
				kind: row.kind,
				archived: row.archivedAt !== null,
			},
		]),
	)
}

/**
 * What one version costs at the last delivered prices, using the engine's
 * `plateCost` through a stand-in dish so expansion, usable yield, made items
 * and typed costs behave exactly as they do for a sale.
 */
function plateOf(input: {
	version: RecipeVersion
	madeVersions: readonly RecipeVersion[]
	facts: readonly RecipeItemFacts[]
	costs: ItemCosts
	currency: string
}): ReturnType<typeof plateCost> | null {
	const { version } = input
	let dish: { itemId: string; variantId?: string }
	let recipes: RecipeVersion[]
	if (version.ownerKind === 'menu_item') {
		dish = { itemId: version.ownerId }
		recipes = [...input.madeVersions, version]
	} else if (version.ownerKind === 'variant') {
		// A multiple has no cost without its item's recipe: ask /recipes/costs.
		if (version.multiplierBp !== null) return null
		dish = { itemId: NO_MENU_ITEM, variantId: version.ownerId }
		recipes = [...input.madeVersions, version]
	} else if (version.ownerKind === 'made_item') {
		// The cost of one batch (what the recipe lists), not of one unit.
		dish = { itemId: SYNTHETIC_DISH }
		recipes = [
			...input.madeVersions,
			{
				...version,
				ownerKind: 'menu_item',
				ownerId: SYNTHETIC_DISH,
				makesQuantity: null,
			},
		]
	} else {
		return null
	}
	return plateCost({
		store: createRecipeStore({ recipes, items: input.facts }),
		dish,
		at: FAR_FUTURE,
		currency: input.currency,
		lastCostMicro: input.costs.last,
	})
}

function lineCostOf(input: {
	spec: RecipeVersion['lines'][number]
	madeVersions: readonly RecipeVersion[]
	facts: readonly RecipeItemFacts[]
	costs: ItemCosts
	currency: string
}): { costMinor: number | null; priced: boolean } {
	const synthetic: RecipeVersion = {
		ownerKind: 'menu_item',
		ownerId: SYNTHETIC_DISH,
		version: 1,
		effectiveFrom: 0,
		makesQuantity: null,
		multiplierBp: null,
		typedCost: null,
		lines: [{ ...input.spec, mode: 'add', replacesItemId: null }],
	}
	const result = plateCost({
		store: createRecipeStore({
			recipes: [...input.madeVersions, synthetic],
			items: input.facts,
		}),
		dish: { itemId: SYNTHETIC_DISH },
		at: FAR_FUTURE,
		currency: input.currency,
		lastCostMicro: input.costs.last,
	})
	return {
		costMinor: result.costMinor,
		priced: result.state === 'complete',
	}
}

async function recipeOutput(
	db: InventoryReader,
	caller: RecipeCaller,
	row: RecipeRow,
	lineRows: readonly RecipeLineRow[],
): Promise<RecipeOut> {
	const version = toRecipeVersion(row, lineRows)
	const ordered = [...lineRows].sort(
		(a, b) => a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : 1),
	)
	const itemIds = ordered.flatMap((line) =>
		line.replacesItemId ? [line.itemId, line.replacesItemId] : [line.itemId],
	)
	const [items, costs, made] = await Promise.all([
		loadItemInfo(db, itemIds),
		loadItemCosts(db),
		buildRecipeStore(db, { at: FAR_FUTURE }),
	])
	const currency = costs.currency ?? row.typedCostCurrency ?? ''
	const lines: RecipeLineOut[] = ordered.map((line) => {
		const cost = lineCostOf({
			spec: toRecipeVersion(row, [line]).lines[0]!,
			madeVersions: made.madeVersions,
			facts: made.facts,
			costs,
			currency,
		})
		const out: RecipeLineOut = {
			id: line.id,
			itemId: line.itemId,
			itemName: items.get(line.itemId)?.name ?? '',
			baseUnit: items.get(line.itemId)?.baseUnit ?? 'piece',
			quantity: line.quantity,
			usableBp: line.usableBp,
			mode: line.mode,
			replacesItemId: line.replacesItemId,
			replacesItemName: line.replacesItemId
				? (items.get(line.replacesItemId)?.name ?? '')
				: null,
			sortOrder: line.sortOrder,
			priced: cost.priced,
		}
		if (caller.cost && cost.costMinor !== null) out.costMinor = cost.costMinor
		return out
	})
	const recipe: RecipeOut = {
		id: row.id,
		ownerKind: row.ownerKind,
		ownerId: row.ownerId,
		version: row.version,
		makesQuantity: row.makesQuantity,
		multiplierBp: row.multiplierBp,
		method: row.method,
		effectiveFrom: row.effectiveFrom,
		createdAt: row.createdAt,
		lines,
	}
	if (!caller.cost) return recipe
	if (row.typedCostMinor !== null) {
		recipe.typedCostMinor = row.typedCostMinor
		if (row.typedCostCurrency) recipe.typedCostCurrency = row.typedCostCurrency
	}
	const plate = plateOf({
		version,
		madeVersions: made.madeVersions,
		facts: made.facts,
		costs,
		currency,
	})
	if (plate) {
		const out: PlateOut = {
			state: plate.state,
			missingItemIds: plate.missingItemIds,
		}
		if (plate.costMinor !== null) {
			out.costMinor = plate.costMinor
			if (currency) out.currency = currency
		}
		if (plate.typedCostMinor !== null) out.typedCostMinor = plate.typedCostMinor
		recipe.plate = out
	}
	return recipe
}

/**
 * The current recipe of an owner. An owner that never had one answers
 * `{ recipe: null, version: 0 }`; a cleared owner answers `recipe: null` with
 * the version of the clearing (the editor sends it as `expectedVersion`).
 */
export async function getRecipe(
	db: InventoryReader,
	caller: RecipeCaller,
	owner: RecipeOwnerInput,
): Promise<RecipeResult> {
	const row = await currentRow(db, owner)
	if (!row) return { recipe: null, version: 0 }
	const lineRows = [
		...((await loadRecipeLines(db, [row.id])).get(row.id) ?? []),
	]
	if (isEmptyRecipe(toRecipeVersion(row, lineRows))) {
		return { recipe: null, version: row.version }
	}
	return {
		recipe: await recipeOutput(db, caller, row, lineRows),
		version: row.version,
	}
}

// ── Writing ─────────────────────────────────────────────────────────────────

/** Each insert stays under 100 bound parameters (eight columns a line). */
const LINES_PER_INSERT = 10

async function writeVersion(
	tx: InventoryTx,
	input: {
		previous: RecipeRow | null
		owner: RecipeOwnerInput
		now: number
		effectiveFrom: number
		caller: RecipeCaller
		values: Partial<typeof invRecipes.$inferInsert>
		lines: (typeof invRecipeLines.$inferInsert)[]
	},
): Promise<RecipeRow> {
	// Order matters: the unique "current" index allows one open version per
	// owner, so the old one is stamped before its successor exists.
	if (input.previous) {
		await tx
			.update(invRecipes)
			.set({ supersededAt: input.now })
			.where(eq(invRecipes.id, input.previous.id))
	}
	const id = newId()
	await tx.insert(invRecipes).values({
		id,
		ownerKind: input.owner.ownerKind,
		ownerId: input.owner.ownerId,
		version: (input.previous?.version ?? 0) + 1,
		effectiveFrom: input.effectiveFrom,
		createdByKind: input.caller.actor.kind,
		createdById: input.caller.actor.id,
		createdAt: input.now,
		...input.values,
	})
	for (const chunk of chunkIds(input.lines, LINES_PER_INSERT)) {
		await tx
			.insert(invRecipeLines)
			.values(chunk.map((line) => ({ ...line, recipeId: id })))
	}
	return (await tx
		.select()
		.from(invRecipes)
		.where(eq(invRecipes.id, id))
		.get())!
}

function checkedQuantity(quantity: number): number {
	if (quantity < 1) throw badRequest('amount_too_small')
	return quantity
}

/**
 * Writes the next version of an owner's recipe. `expectedVersion` is the
 * version the editor loaded (0 for none). Every ingredient must exist and be
 * active; each amount is converted from the unit the person typed to base
 * thousandths; a made item's recipe must not loop or nest too deep
 * (`recipe_cycle`, `recipe_too_deep`, nothing written).
 */
export async function putRecipe(
	caller: InventoryCaller,
	input: { body: PutRecipeInput; idempotency: InventoryIdempotency | null },
): Promise<RecipeResult> {
	const { body } = input
	const owner = { ownerKind: body.ownerKind, ownerId: body.ownerId }
	if (body.typedCost && !caller.cost) {
		// A typed cost is money: only a caller who may see money can enter one.
		throw new InventoryError('forbidden', 403, {
			reason: 'grant',
			required: INVENTORY_PERMISSIONS.READ_INVENTORY_COST,
		})
	}
	return withInventoryWrite(
		{ orgId: caller.orgId, idempotency: input.idempotency },
		async (tx, ctx) => {
			const previous = await currentRow(tx, owner)
			assertVersion(previous?.version ?? 0, body.expectedVersion)
			if (
				body.lines.length === 0 &&
				!body.typedCost &&
				body.multiplierBp === undefined
			) {
				throw new InventoryError('recipe_empty', 400)
			}

			// A made item's recipe belongs to an active made item.
			let ownerItem: { id: string; baseUnit: 'g' | 'ml' | 'piece' } | null =
				null
			if (body.ownerKind === 'made_item') {
				const item = (await loadItemInfo(tx, [body.ownerId])).get(body.ownerId)
				if (!item) throw notFound()
				if (item.kind !== 'made')
					throw new InventoryError('not_a_made_item', 400)
				if (item.archived) throw notFound()
				ownerItem = { id: body.ownerId, baseUnit: item.baseUnit }
			}

			// Ingredients exist and are active (a replaced one only has to exist).
			const referenced = [
				...body.lines.map((line) => line.itemId),
				...body.lines.flatMap((line) =>
					line.replacesItemId ? [line.replacesItemId] : [],
				),
			]
			const infos = await loadItemInfo(tx, referenced)
			for (const line of body.lines) {
				const info = infos.get(line.itemId)
				if (!info)
					throw new InventoryError('not_found', 404, { reason: 'ingredient' })
				if (info.archived) throw stateConflict('ingredient_archived')
				if (line.replacesItemId && !infos.has(line.replacesItemId)) {
					throw new InventoryError('not_found', 404, { reason: 'ingredient' })
				}
			}

			// Typed amounts to base thousandths (a named unit must be the item's).
			const units = await loadItemUnits(tx, [
				...new Set([
					...body.lines.map((line) => line.itemId),
					...(ownerItem ? [ownerItem.id] : []),
				]),
			])
			const unitsOf = (itemId: string): ItemUnitRow[] => units.get(itemId) ?? []
			const usedUnits: string[] = []
			const lineRows = body.lines.map((line, index) => {
				const info = infos.get(line.itemId)!
				const converted = typedToBase(
					line.amount,
					line.unit,
					info.baseUnit,
					unitsOf(line.itemId),
				)
				if (converted.named) usedUnits.push(converted.named.id)
				return {
					id: newId(),
					itemId: line.itemId,
					quantity: checkedQuantity(converted.quantity),
					usableBp: line.usableBp,
					mode: line.mode,
					replacesItemId: line.mode === 'replace' ? line.replacesItemId! : null,
					sortOrder: index,
				}
			}) as (typeof invRecipeLines.$inferInsert)[]
			let makesQuantity: number | null = null
			if (ownerItem && body.makes) {
				const converted = typedToBase(
					body.makes.amount,
					body.makes.unit,
					ownerItem.baseUnit,
					unitsOf(ownerItem.id),
				)
				if (converted.named) usedUnits.push(converted.named.id)
				makesQuantity = checkedQuantity(converted.quantity)
			}

			if (ownerItem) {
				// Every made item's newest recipe counts, scheduled ones included.
				const { store } = await buildRecipeStore(tx, { at: FAR_FUTURE })
				const found = checkMadeRecipeGraph(
					store,
					ownerItem.id,
					body.lines.map((line) => line.itemId),
					FAR_FUTURE,
				)
				if (found) {
					throw new InventoryError(
						found.code === 'recipe_too_deep'
							? 'recipe_too_deep'
							: 'recipe_cycle',
						409,
						{ path: found.path },
					)
				}
			}

			// A version may start a little in the past (a tablet's late-synced
			// sales are accepted up to this old) but never at 0 or last month:
			// once sales settle against recipes, an old revised sale must not
			// start deducting with a recipe backdated far beyond any sale that
			// could still arrive.
			if (
				body.effectiveFrom !== undefined &&
				body.effectiveFrom < ctx.now - STATION_LATE_SYNC_MS
			) {
				throw badRequest('effective_from_too_old')
			}

			const previousFrom = previous?.effectiveFrom ?? 0
			if (
				body.effectiveFrom !== undefined &&
				body.effectiveFrom < previousFrom
			) {
				throw badRequest('effective_from_before_previous')
			}
			// The first version starts now, never at 0: a replayed old sale
			// must not start deducting with a recipe written later.
			const effectiveFrom =
				body.effectiveFrom ?? Math.max(ctx.now, previousFrom)

			await markUnitsUsed(tx, usedUnits, ctx.now)
			const row = await writeVersion(tx, {
				previous,
				owner,
				now: ctx.now,
				effectiveFrom,
				caller,
				values: {
					makesQuantity,
					multiplierBp: body.multiplierBp ?? null,
					typedCostMinor: body.typedCost?.minor ?? null,
					typedCostCurrency: body.typedCost?.currency ?? null,
					method: body.method?.length ? body.method : null,
				},
				lines: lineRows,
			})
			await recordInventoryAudit(tx, {
				actorKind: caller.actor.kind,
				actorId: caller.actor.id,
				action: 'recipe.put',
				resourceType: 'recipe',
				resourceId: row.id,
				detail: {
					ownerKind: row.ownerKind,
					ownerId: row.ownerId,
					version: row.version,
					lines: lineRows.length,
					typedCost: body.typedCost !== undefined,
					multiplier: body.multiplierBp !== undefined,
				},
				at: ctx.now,
			})
			return getRecipe(tx, caller, owner)
		},
	)
}

/** Writes a cleared version: no recipe from now on, history kept. */
export async function clearRecipe(
	caller: InventoryCaller,
	input: { body: ClearRecipeInput; idempotency: InventoryIdempotency | null },
): Promise<RecipeResult> {
	const { body } = input
	const owner = { ownerKind: body.ownerKind, ownerId: body.ownerId }
	return withInventoryWrite(
		{ orgId: caller.orgId, idempotency: input.idempotency },
		async (tx, ctx) => {
			const previous = await currentRow(tx, owner)
			assertVersion(previous?.version ?? 0, body.expectedVersion)
			if (!previous) throw stateConflict('no_recipe')
			const lines = (await loadRecipeLines(tx, [previous.id])).get(previous.id)
			if (isEmptyRecipe(toRecipeVersion(previous, lines ?? []))) {
				throw stateConflict('no_recipe')
			}
			const row = await writeVersion(tx, {
				previous,
				owner,
				now: ctx.now,
				effectiveFrom: Math.max(ctx.now, previous.effectiveFrom),
				caller,
				// A made item's row keeps what a batch makes (the table requires it).
				values: { makesQuantity: previous.makesQuantity },
				lines: [],
			})
			await recordInventoryAudit(tx, {
				actorKind: caller.actor.kind,
				actorId: caller.actor.id,
				action: 'recipe.clear',
				resourceType: 'recipe',
				resourceId: row.id,
				detail: {
					ownerKind: row.ownerKind,
					ownerId: row.ownerId,
					version: row.version,
				},
				at: ctx.now,
			})
			return getRecipe(tx, caller, owner)
		},
	)
}

// ── Costs for the menu list ─────────────────────────────────────────────────

type CostRowOut = {
	key: string
	hasRecipe: boolean
	state: PlateCostState
	costMinor?: number
	currency?: string
	foodCostBp?: number
	status?: FoodCostStatus
	priceForTargetMinor?: number
}

/**
 * Plate cost and food cost % for up to 200 dishes the browser knows by id and
 * price, at the LAST delivered prices. The answer is keyed by the caller's own
 * `key`, so no name travels. Without the cost grant a row says only whether
 * the dish has a recipe and the state of its cost (no money, no percentage).
 * A food cost percentage is given only when the cost is whole (`complete` or
 * `typed`): a partial cost is a floor and would flatter the dish.
 */
export async function recipeCosts(
	db: InventoryReader,
	caller: RecipeCaller,
	body: RecipeCostsInput,
): Promise<{ rows: CostRowOut[]; targetBp: number }> {
	const at = body.at ?? Date.now()
	const optionIds = body.refs.flatMap((ref) => ref.optionIds ?? [])
	const [{ store }, costs, settings, locationRows] = await Promise.all([
		buildRecipeStore(db, {
			at,
			owners: {
				menu_item: body.refs.map((ref) => ref.itemId),
				variant: body.refs.flatMap((ref) =>
					ref.variantId ? [ref.variantId] : [],
				),
				option: optionIds,
			},
		}),
		loadItemCosts(db),
		getInventorySettings(db, caller.region),
		db
			.select({
				locationId: invLocationSettings.locationId,
				pricesIncludeTax: invLocationSettings.pricesIncludeTax,
				taxRateBp: invLocationSettings.taxRateBp,
			})
			.from(invLocationSettings),
	])
	const storedLoc =
		(body.locationId
			? locationRows.find((r) => r.locationId === body.locationId)
			: undefined) ??
		locationRows.find(
			(r) =>
				r.locationId !== '*' && r.pricesIncludeTax && (r.taxRateBp ?? 0) > 0,
		) ??
		locationRows.find((r) => r.locationId === '*') ??
		locationRows[0]
	const tax: MenuPriceTax = {
		pricesIncludeTax:
			body.pricesIncludeTax ?? storedLoc?.pricesIncludeTax ?? false,
		taxRateBp:
			body.taxRateBp !== undefined
				? body.taxRateBp
				: (storedLoc?.taxRateBp ?? null),
	}
	const currency =
		costs.currency ?? body.currency ?? typedCostCurrency(store) ?? ''
	const rows = body.refs.map((ref): CostRowOut => {
		const options: SaleOption[] = (ref.optionIds ?? []).map((optionId) => ({
			optionId,
			quantity: 1,
		}))
		const result = plateCost({
			store,
			dish: { itemId: ref.itemId, variantId: ref.variantId ?? null, options },
			at,
			currency,
			lastCostMicro: costs.last,
		})
		const row: CostRowOut = {
			key: ref.key,
			hasRecipe: result.state !== 'none',
			state: result.state,
		}
		if (!caller.cost || result.costMinor === null) return row
		row.costMinor = result.costMinor
		if (currency) row.currency = currency
		if (result.state !== 'complete' && result.state !== 'typed') return row
		const target = priceForTargetMinor(
			result.costMinor,
			settings.targetFoodCostBp,
			tax,
		)
		if (target !== null) row.priceForTargetMinor = target
		if (
			ref.priceMinor !== undefined &&
			(!body.currency || body.currency === currency)
		) {
			const bp = dishFoodCostBp(ref.priceMinor, result.costMinor, tax)
			if (bp !== null) {
				row.foodCostBp = bp
				row.status = foodCostStatus(bp, settings.targetFoodCostBp)
			}
		}
		return row
	})
	return { rows, targetBp: settings.targetFoodCostBp }
}

// ── Dishes without a recipe ─────────────────────────────────────────────────

/**
 * The dishes that sold most in the last `days` business days at a location and
 * have no recipe (no own recipe and none on their item), so the owner sets up
 * the top few first. Sales come from the one items-sold reader (web, QR and
 * Station); the ranking is the engine's. Only per-line item and size counts
 * are used (the reader's option quantities, which it multiplies by the line
 * quantity, are not read). Net sales and currency need the cost grant.
 */
export async function dishesWithoutRecipe(
	db: InventoryReader,
	caller: RecipeCaller,
	input: { locationId: string; days: number; limit: number },
): Promise<{
	days: number
	dishes: {
		itemId: string
		quantity: number
		netSalesMinor?: number
		currency?: string
	}[]
	total: number
	truncated: boolean
}> {
	const now = Date.now()
	const today = await locationBusinessDate(db, input.locationId, now)
	const sales = await readItemSales(db, {
		locationId: input.locationId,
		fromDate: addDays(today, -(input.days - 1)),
		toDate: today,
	})
	// Money is kept per currency; an organization has one, so rank on the
	// busiest one and count units across all of them.
	const netByCurrency = new Map<string, number>()
	for (const row of sales.items) {
		netByCurrency.set(
			row.currency,
			(netByCurrency.get(row.currency) ?? 0) + row.netSalesMinor,
		)
	}
	const currency =
		[...netByCurrency.entries()].sort(
			(a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
		)[0]?.[0] ?? null
	const itemIds = [...new Set(sales.items.map((row) => row.itemId))]
	const variantIds = [
		...new Set(
			sales.items.flatMap((row) => (row.variantId ? [row.variantId] : [])),
		),
	]
	const { store } = await buildRecipeStore(db, {
		at: now,
		owners: { menu_item: itemIds, variant: variantIds },
	})
	const ranked = rankDishesWithoutRecipe({
		store,
		at: now,
		limit: input.limit,
		rows: sales.items.map((row) => ({
			itemId: row.itemId,
			variantId: row.variantId,
			quantity: row.quantity,
			...(row.currency === currency
				? { netSalesMinor: row.netSalesMinor }
				: {}),
		})),
	})
	return {
		days: input.days,
		dishes: ranked.dishes.map((dish) => {
			const out: {
				itemId: string
				quantity: number
				netSalesMinor?: number
				currency?: string
			} = { itemId: dish.itemId, quantity: dish.quantity }
			if (caller.cost && dish.netSalesMinor !== null && currency) {
				out.netSalesMinor = dish.netSalesMinor
				out.currency = currency
			}
			return out
		}),
		total: ranked.total,
		truncated: sales.truncated,
	}
}
