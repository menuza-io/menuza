import { z } from 'zod'
import { inventoryCurrencySchema, inventoryMinorSchema } from '../money.ts'
import { recipeLineModeSchema, recipeOwnerKindSchema } from '../records.ts'
import { INVENTORY_LIMITS } from '../errors.ts'
import { inventoryLocationIdSchema } from '../token.ts'
import { inventoryBaseUnitSchema } from '../units.ts'
import {
	clientIdSchema,
	currencyOut,
	expectedVersionSchema,
	inventoryIdSchema,
	inventoryNoteSchema,
	minorOut,
	typedAmountSchema,
	unitRefSchema,
} from './common.ts'

/**
 * Recipes: what is in a dish, an option, a size or a made-in-house item.
 *
 * Owners are opaque ids: a menu item, variant or option id from the control
 * plane, or an inventory item id for a made item. The region never stores or
 * returns menu NAMES (the App joins them) and never receives them: every
 * request here carries ids and numbers only.
 *
 * Permissions: reads need `read:inventory:any`; writes need
 * `update:inventory_recipe:any`; anything in money (plate cost, typed cost,
 * food cost) needs `read:inventory_cost:any` and is OMITTED without it. A
 * typed cost can only be entered with the cost grant.
 *
 * Versioning: a recipe is never edited in place. `PUT /recipes` writes the
 * next version (it starts at `effectiveFrom`, default now) and the old
 * versions are kept, so a past sale is costed and deducted with the recipe in
 * force when it happened. `expectedVersion` is the version the editor loaded
 * (0 when the owner had no recipe): a different current version answers 409
 * `stale_version`.
 *
 * A variant (size) recipe is EITHER a multiple of its menu item's recipe
 * (`multiplierBp`, 10000 is 1x, no lines) OR its own complete recipe (lines
 * or a typed cost). Never both.
 */

export const MAX_RECIPE_LINES = INVENTORY_LIMITS.linesPerRecipe
export const MAX_RECIPE_COST_REFS = INVENTORY_LIMITS.costRefsPerRequest

/** Lowest and highest size multiplier: 0.01x to 100x of the item's recipe. */
export const MIN_MULTIPLIER_BP = 100
export const MAX_MULTIPLIER_BP = 1_000_000

export const recipeOwnerSchema = z
	.object({
		ownerKind: recipeOwnerKindSchema,
		ownerId: inventoryIdSchema,
	})
	.strict()

/** Usable yield in basis points: 8500 is "usable 85%". */
export const usableBpSchema = z.number().int().min(1).max(10_000)

/**
 * One ingredient as a person typed it: an amount in a unit, converted by the
 * region to base thousandths of the ingredient (`unit_mismatch` when the unit
 * cannot measure the item). `replace` is for option recipes and names the
 * ingredient of the dish it swaps out.
 */
export const recipeLineInputSchema = z
	.object({
		itemId: inventoryIdSchema,
		amount: typedAmountSchema.refine((a) => a > 0, 'Must be above zero'),
		unit: unitRefSchema,
		usableBp: usableBpSchema.default(10_000),
		mode: recipeLineModeSchema.default('add'),
		replacesItemId: inventoryIdSchema.optional(),
	})
	.strict()
	.superRefine((line, ctx) => {
		if (line.mode === 'replace' && !line.replacesItemId) {
			ctx.addIssue({
				code: 'custom',
				path: ['replacesItemId'],
				message: 'Name the ingredient it replaces',
			})
		}
		if (line.mode === 'add' && line.replacesItemId) {
			ctx.addIssue({
				code: 'custom',
				path: ['replacesItemId'],
				message: 'Only a replace line names what it replaces',
			})
		}
		if (line.mode === 'replace' && line.replacesItemId === line.itemId) {
			ctx.addIssue({
				code: 'custom',
				path: ['replacesItemId'],
				message: 'An ingredient cannot replace itself',
			})
		}
	})
export type RecipeLineInput = z.infer<typeof recipeLineInputSchema>

/** A typed cost per dish ("Type a cost instead"), in minor units. */
export const typedCostInputSchema = z
	.object({
		minor: inventoryMinorSchema,
		currency: inventoryCurrencySchema,
	})
	.strict()

/** How much one batch of a made item makes, typed ("makes 4 L"). */
export const makesInputSchema = z
	.object({
		amount: typedAmountSchema.refine((a) => a > 0, 'Must be above zero'),
		unit: unitRefSchema,
	})
	.strict()

/**
 * `PUT /recipes`: the next version of the recipe of one owner.
 *
 * - `made_item`: needs `makes` and at least one line; no typed cost, no
 *   multiplier. The made item must be of kind `made` (`not_a_made_item`);
 *   an ingredient cycle is `recipe_cycle`, too deep `recipe_too_deep`.
 * - `menu_item`, `option`: lines, or a typed cost (no lines).
 * - `variant`: `multiplierBp` alone, or its own lines or typed cost.
 * - A recipe with nothing in it is refused (`recipe_empty`); clear one with
 *   `POST /recipes/clear`.
 */
export const putRecipeSchema = z
	.object({
		ownerKind: recipeOwnerKindSchema,
		ownerId: inventoryIdSchema,
		expectedVersion: expectedVersionSchema,
		lines: z.array(recipeLineInputSchema).max(MAX_RECIPE_LINES).default([]),
		makes: makesInputSchema.optional(),
		multiplierBp: z
			.number()
			.int()
			.min(MIN_MULTIPLIER_BP)
			.max(MAX_MULTIPLIER_BP)
			.optional(),
		typedCost: typedCostInputSchema.optional(),
		method: inventoryNoteSchema.optional(),
		/** Epoch ms the version starts to apply to sales (default: now). */
		effectiveFrom: z.number().int().min(0).optional(),
	})
	.strict()
	.superRefine((recipe, ctx) => {
		const issue = (path: string, message: string) =>
			ctx.addIssue({ code: 'custom', path: [path], message })
		const ids = recipe.lines.map((line) => line.itemId)
		if (new Set(ids).size !== ids.length) {
			issue('lines', 'An ingredient can be listed once')
		}
		if (recipe.ownerKind === 'made_item') {
			if (!recipe.makes) issue('makes', 'Say how much a batch makes')
			if (recipe.typedCost) issue('typedCost', 'A made item has no typed cost')
			if (recipe.multiplierBp !== undefined) {
				issue('multiplierBp', 'Only a size can be a multiple')
			}
			if (recipe.lines.some((line) => line.mode === 'replace')) {
				issue('lines', 'Only an option can replace an ingredient')
			}
			return
		}
		if (recipe.makes) issue('makes', 'Only a made item makes a batch')
		if (recipe.multiplierBp !== undefined && recipe.ownerKind !== 'variant') {
			issue('multiplierBp', 'Only a size can be a multiple')
		}
		if (recipe.multiplierBp !== undefined) {
			if (recipe.lines.length > 0 || recipe.typedCost) {
				issue('multiplierBp', 'A multiple has no ingredients of its own')
			}
		}
		if (recipe.typedCost && recipe.lines.length > 0) {
			issue('typedCost', 'Ingredients and a typed cost cannot be mixed')
		}
		if (
			recipe.ownerKind !== 'option' &&
			recipe.lines.some((line) => line.mode === 'replace')
		) {
			issue('lines', 'Only an option can replace an ingredient')
		}
	})
export type PutRecipe = z.infer<typeof putRecipeSchema>

/** `POST /recipes/clear`: the owner has no recipe from now on (history kept). */
export const clearRecipeSchema = z
	.object({
		ownerKind: recipeOwnerKindSchema,
		ownerId: inventoryIdSchema,
		expectedVersion: expectedVersionSchema,
	})
	.strict()

/** `GET /recipes?ownerKind=&ownerId=` */
export const getRecipeQuerySchema = recipeOwnerSchema

// ── Plate cost ──────────────────────────────────────────────────────────────

/**
 * What the cost of a dish is made of:
 * - `none`: no recipe (nothing to cost).
 * - `typed`: the owner typed a cost.
 * - `complete`: every ingredient has a delivered price.
 * - `partial`: some ingredients have no price yet; the cost is a floor.
 * - `unknown`: no ingredient has a price yet.
 * - `invalid`: the recipes loop or nest too deep (a data problem).
 */
export const PLATE_COST_STATES = [
	'none',
	'typed',
	'complete',
	'partial',
	'unknown',
	'invalid',
] as const
export type PlateCostState = (typeof PLATE_COST_STATES)[number]
export const plateCostStateSchema = z.enum(PLATE_COST_STATES)

/** Status dot beside a food cost percentage, against the target. */
export const FOOD_COST_STATUSES = ['good', 'watch', 'high'] as const
export type FoodCostStatus = (typeof FOOD_COST_STATUSES)[number]
export const foodCostStatusSchema = z.enum(FOOD_COST_STATUSES)

/** Cost of one dish at the LAST delivered prices. Money is omitted without the cost grant. */
export const plateCostSchema = z.object({
	state: plateCostStateSchema,
	costMinor: minorOut,
	currency: currencyOut,
	/** Ingredients without a delivered price yet (so the editor can say which). */
	missingItemIds: z.array(z.string()),
	/** The typed cost, when the dish uses one (shown as typed). */
	typedCostMinor: minorOut,
})
export type PlateCost = z.infer<typeof plateCostSchema>

export const recipeLineSchema = z.object({
	id: z.string(),
	itemId: z.string(),
	/** The ingredient's current name (an inventory name, not a menu name). */
	itemName: z.string(),
	baseUnit: inventoryBaseUnitSchema,
	/** What ends up in the dish, base thousandths. */
	quantity: z.number().int(),
	usableBp: z.number().int(),
	mode: recipeLineModeSchema,
	replacesItemId: z.string().nullable(),
	replacesItemName: z.string().nullable(),
	sortOrder: z.number().int(),
	/** This line's cost per dish (omitted without the cost grant). */
	costMinor: minorOut,
	/** False when the ingredient has no delivered price yet. */
	priced: z.boolean(),
})

export const recipeSchema = z.object({
	id: z.string(),
	ownerKind: recipeOwnerKindSchema,
	ownerId: z.string(),
	version: z.number().int(),
	makesQuantity: z.number().int().nullable(),
	multiplierBp: z.number().int().nullable(),
	typedCostMinor: minorOut,
	typedCostCurrency: currencyOut,
	method: z.string().nullable(),
	effectiveFrom: z.number().int(),
	createdAt: z.number().int(),
	lines: z.array(recipeLineSchema),
	plate: plateCostSchema.optional(),
})
export type Recipe = z.infer<typeof recipeSchema>

/**
 * `GET /recipes` and the answer of `PUT /recipes` and `POST /recipes/clear`:
 * the current recipe, or `null` with `version: 0` when the owner has none.
 */
export const recipeResultSchema = z.object({
	recipe: recipeSchema.nullable(),
	version: z.number().int(),
})

// ── Costs for the menu list ─────────────────────────────────────────────────

/**
 * One dish the browser asks about, as it knows it from the menu: ids and the
 * price it shows. The region answers by `key`, so no name travels. `variantId`
 * costs a size.
 */
export const recipeCostRefSchema = z
	.object({
		/** The caller's own key for this row, echoed back (a row id, say). */
		key: z.string().min(1).max(64),
		itemId: inventoryIdSchema,
		variantId: inventoryIdSchema.nullish(),
		/** Selling price in minor units, as the menu shows it. */
		priceMinor: inventoryMinorSchema.optional(),
		/** Option ids to include in the cost (the usual choices), optional. */
		optionIds: z.array(inventoryIdSchema).max(20).optional(),
	})
	.strict()

/** `POST /recipes/costs`: up to 200 dishes (`read:inventory_cost:any` for money). */
export const recipeCostsRequestSchema = z
	.object({
		refs: z.array(recipeCostRefSchema).min(1).max(MAX_RECIPE_COST_REFS),
		/** Currency of every `priceMinor`; required when any price is sent. */
		currency: inventoryCurrencySchema.optional(),
		/** Organization time to cost at (epoch ms); default now. */
		at: z.number().int().min(0).optional(),
	})
	.strict()
	.superRefine((request, ctx) => {
		const keys = request.refs.map((ref) => ref.key)
		if (new Set(keys).size !== keys.length) {
			ctx.addIssue({
				code: 'custom',
				path: ['refs'],
				message: 'Keys must be unique',
			})
		}
		if (request.refs.some((ref) => ref.priceMinor !== undefined)) {
			if (!request.currency) {
				ctx.addIssue({
					code: 'custom',
					path: ['currency'],
					message: 'Say which currency the prices are in',
				})
			}
		}
	})
export type RecipeCostsRequest = z.infer<typeof recipeCostsRequestSchema>

export const recipeCostRowSchema = z.object({
	key: z.string(),
	/** Whether the dish has a recipe or typed cost (works without the cost grant). */
	hasRecipe: z.boolean(),
	state: plateCostStateSchema,
	costMinor: minorOut,
	currency: currencyOut,
	/** Cost over the price sent, basis points; omitted without a price or cost. */
	foodCostBp: z.number().int().optional(),
	status: foodCostStatusSchema.optional(),
	/** Price that would hit the target food cost, minor units. */
	priceForTargetMinor: minorOut,
})

export const recipeCostsResultSchema = z.object({
	rows: z.array(recipeCostRowSchema),
	/** The organization's target food cost, basis points. */
	targetBp: z.number().int(),
})

// ── Dishes without a recipe ─────────────────────────────────────────────────

/**
 * `GET /recipes/missing?locationId=&days=&limit=`: the dishes that sold most in
 * the last `days` and have no recipe, so the owner sets up the top ones first.
 * Ids and numbers only: the App joins the names.
 */
export const dishesWithoutRecipeQuerySchema = z
	.object({
		locationId: inventoryLocationIdSchema,
		days: z.coerce.number().int().min(1).max(90).default(30),
		limit: z.coerce.number().int().min(1).max(50).default(10),
	})
	.strict()

export const dishWithoutRecipeSchema = z.object({
	itemId: z.string(),
	/** Units sold in the period, across sizes. */
	quantity: z.number().int(),
	netSalesMinor: minorOut,
	currency: currencyOut,
})

export const dishesWithoutRecipeResultSchema = z.object({
	days: z.number().int(),
	dishes: z.array(dishWithoutRecipeSchema),
	/** How many sold dishes have no recipe in all (for "and 14 more"). */
	total: z.number().int(),
	/** True when the sales read hit its cap and the ranking is partial. */
	truncated: z.boolean(),
})

// ── Recording a batch of a made item ───────────────────────────────────────

/**
 * `POST /items/:id/batch` (`update:inventory:any` and
 * `update:inventory_recipe:any`): record that a made item was made. It adds the
 * made item to stock and takes its ingredients out, as one idempotent write.
 * Either a number of recipe batches or the amount that came out, typed.
 */
export const recordBatchSchema = z
	.object({
		clientId: clientIdSchema,
		locationId: inventoryLocationIdSchema,
		made: z.discriminatedUnion('kind', [
			z
				.object({
					kind: z.literal('batches'),
					count: z.number().finite().positive().max(1000),
				})
				.strict(),
			z
				.object({
					kind: z.literal('amount'),
					amount: typedAmountSchema.refine((a) => a > 0, 'Must be above zero'),
					unit: unitRefSchema,
				})
				.strict(),
		]),
		note: inventoryNoteSchema.optional(),
	})
	.strict()
export type RecordBatch = z.infer<typeof recordBatchSchema>

export const recordBatchResultSchema = z.object({
	/** The made item's batch movement (a replayed `clientId` answers the first). */
	id: z.string(),
	/** What was added to stock, base thousandths of the made item. */
	madeQuantity: z.number().int(),
	used: z.array(
		z.object({
			itemId: z.string(),
			/** Raw quantity taken out, base thousandths (after usable yield). */
			quantity: z.number().int(),
			valueMinor: minorOut,
		}),
	),
	valueMinor: minorOut,
	currency: currencyOut,
})
