import { describe, expect, test } from 'vitest'
import { INVENTORY_ERROR_CODES } from '../errors.ts'
import {
	clearRecipeSchema,
	dishesWithoutRecipeQuerySchema,
	dishesWithoutRecipeResultSchema,
	plateCostSchema,
	putRecipeSchema,
	recipeCostsRequestSchema,
	recipeCostsResultSchema,
	recipeResultSchema,
	recordBatchResultSchema,
	recordBatchSchema,
	recipeLineInputSchema,
	stockItemSchema,
	updateItemSchema,
} from './index.ts'

const chicken = { itemId: 'it_chicken', amount: 180, unit: 'g', usableBp: 8500 }
const pita = { itemId: 'it_pita', amount: 1, unit: 'piece' }

const dish = {
	ownerKind: 'menu_item',
	ownerId: 'menu_shawarma',
	expectedVersion: 0,
	lines: [chicken, pita],
}

describe('put recipe', () => {
	test('a dish with ingredients parses, with defaults', () => {
		const parsed = putRecipeSchema.parse(dish)
		expect(parsed.lines[1]).toMatchObject({ usableBp: 10_000, mode: 'add' })
		expect(parsed.typedCost).toBeUndefined()
	})

	test('requests are strict: unknown fields are refused, and so is a menu name', () => {
		expect(
			putRecipeSchema.safeParse({ ...dish, name: 'Shawarma' }).success,
		).toBe(false)
		expect(
			putRecipeSchema.safeParse({
				...dish,
				lines: [{ ...chicken, itemName: 'Chicken' }],
			}).success,
		).toBe(false)
	})

	test.each([
		['an unknown owner kind', { ownerKind: 'category' }],
		['an id with spaces', { ownerId: 'a b' }],
		['a negative version', { expectedVersion: -1 }],
		[
			'too many lines',
			{
				lines: Array.from({ length: 61 }, (_, i) => ({
					...pita,
					itemId: `i${i}`,
				})),
			},
		],
		['a duplicate ingredient', { lines: [pita, { ...pita, amount: 2 }] }],
		['a zero amount', { lines: [{ ...pita, amount: 0 }] }],
		['usable above 100%', { lines: [{ ...pita, usableBp: 10_001 }] }],
		['usable of zero', { lines: [{ ...pita, usableBp: 0 }] }],
		[
			'a unit that is neither standard nor a named unit',
			{ lines: [{ ...pita, unit: 'cup' }] },
		],
		[
			'a replace on a dish',
			{ lines: [{ ...pita, mode: 'replace', replacesItemId: 'it_x' }] },
		],
		['a makes quantity on a dish', { makes: { amount: 4, unit: 'l' } }],
		['a multiplier on a dish', { multiplierBp: 15_000 }],
		[
			'ingredients beside a typed cost',
			{ typedCost: { minor: 650, currency: 'SAR' } },
		],
		['an effective time below zero', { effectiveFrom: -1 }],
	])('refuses %s', (_name, patch) => {
		expect(putRecipeSchema.safeParse({ ...dish, ...patch }).success).toBe(false)
	})

	test('a typed cost dish has no lines', () => {
		const parsed = putRecipeSchema.parse({
			...dish,
			lines: [],
			typedCost: { minor: 150, currency: 'SAR' },
		})
		expect(parsed.typedCost).toEqual({ minor: 150, currency: 'SAR' })
		expect(
			putRecipeSchema.safeParse({
				...dish,
				lines: [],
				typedCost: { minor: 150, currency: 'sar' },
			}).success,
		).toBe(false)
	})

	test('a size is a multiple, or its own ingredients, not both', () => {
		const size = {
			ownerKind: 'variant',
			ownerId: 'var_large',
			expectedVersion: 0,
		}
		expect(
			putRecipeSchema.safeParse({ ...size, multiplierBp: 15_000 }).success,
		).toBe(true)
		expect(
			putRecipeSchema.safeParse({ ...size, lines: [chicken] }).success,
		).toBe(true)
		expect(
			putRecipeSchema.safeParse({
				...size,
				multiplierBp: 15_000,
				lines: [chicken],
			}).success,
		).toBe(false)
		expect(
			putRecipeSchema.safeParse({
				...size,
				multiplierBp: 15_000,
				typedCost: { minor: 1, currency: 'SAR' },
			}).success,
		).toBe(false)
		expect(
			putRecipeSchema.safeParse({ ...size, multiplierBp: 50 }).success,
		).toBe(false)
		expect(
			putRecipeSchema.safeParse({ ...size, multiplierBp: 1_000_001 }).success,
		).toBe(false)
	})

	test('an option can swap an ingredient and must name it', () => {
		const option = {
			ownerKind: 'option',
			ownerId: 'opt_oat',
			expectedVersion: 2,
		}
		const oat = {
			itemId: 'it_oat',
			amount: 200,
			unit: 'ml',
			mode: 'replace',
			replacesItemId: 'it_milk',
		}
		expect(putRecipeSchema.safeParse({ ...option, lines: [oat] }).success).toBe(
			true,
		)
		expect(
			putRecipeSchema.safeParse({
				...option,
				lines: [{ ...oat, replacesItemId: undefined }],
			}).success,
		).toBe(false)
		expect(
			putRecipeSchema.safeParse({
				...option,
				lines: [{ ...oat, replacesItemId: 'it_oat' }],
			}).success,
		).toBe(false)
		expect(
			recipeLineInputSchema.safeParse({ ...pita, replacesItemId: 'it_x' })
				.success,
		).toBe(false)
	})

	test('a made item says what a batch makes, and has no typed cost or multiplier', () => {
		const made = {
			ownerKind: 'made_item',
			ownerId: 'it_sauce',
			expectedVersion: 0,
			makes: { amount: 4, unit: 'l' },
			lines: [
				{ itemId: 'it_garlic', amount: 500, unit: 'g' },
				{ itemId: 'it_oil', amount: 1, unit: 'l' },
			],
		}
		expect(putRecipeSchema.safeParse(made).success).toBe(true)
		expect(
			putRecipeSchema.safeParse({ ...made, makes: undefined }).success,
		).toBe(false)
		expect(
			putRecipeSchema.safeParse({
				...made,
				typedCost: { minor: 1, currency: 'SAR' },
			}).success,
		).toBe(false)
		expect(
			putRecipeSchema.safeParse({ ...made, multiplierBp: 10_000 }).success,
		).toBe(false)
		expect(
			putRecipeSchema.safeParse({
				...made,
				lines: [
					{ ...made.lines[0], mode: 'replace', replacesItemId: 'it_oil' },
				],
			}).success,
		).toBe(false)
	})

	test('clearing names the owner and the version', () => {
		expect(
			clearRecipeSchema.safeParse({
				ownerKind: 'menu_item',
				ownerId: 'm',
				expectedVersion: 3,
			}).success,
		).toBe(true)
		expect(
			clearRecipeSchema.safeParse({ ownerKind: 'menu_item', ownerId: 'm' })
				.success,
		).toBe(false)
	})

	test('validation messages never echo the rejected value', () => {
		const result = putRecipeSchema.safeParse({
			...dish,
			ownerId: 'secret value!',
		})
		expect(JSON.stringify(result.error?.issues)).not.toContain('secret value')
	})
})

describe('recipe responses', () => {
	const recipe = {
		id: 'r1',
		ownerKind: 'menu_item',
		ownerId: 'menu_shawarma',
		version: 3,
		makesQuantity: null,
		multiplierBp: null,
		method: null,
		effectiveFrom: 1_700_000_000_000,
		createdAt: 1_700_000_000_000,
		lines: [
			{
				id: 'l1',
				itemId: 'it_chicken',
				itemName: 'Chicken thighs',
				baseUnit: 'g',
				quantity: 180_000,
				usableBp: 8500,
				mode: 'add',
				replacesItemId: null,
				replacesItemName: null,
				sortOrder: 0,
				priced: true,
			},
		],
	}

	test('money is optional: a response without the cost grant parses', () => {
		const parsed = recipeResultSchema.parse({
			recipe: { ...recipe, plate: { state: 'complete', missingItemIds: [] } },
			version: 3,
		})
		expect(parsed.recipe?.lines[0]?.costMinor).toBeUndefined()
		expect(parsed.recipe?.plate?.costMinor).toBeUndefined()
	})

	test('with the cost grant it carries the numbers; unknown extra fields are tolerated', () => {
		const parsed = recipeResultSchema.parse({
			recipe: {
				...recipe,
				future: true,
				plate: {
					state: 'partial',
					costMinor: 655,
					currency: 'SAR',
					missingItemIds: ['it_x'],
				},
			},
			version: 3,
		})
		expect(parsed.recipe?.plate?.costMinor).toBe(655)
	})

	test('no recipe is null with version 0', () => {
		expect(
			recipeResultSchema.parse({ recipe: null, version: 0 }).recipe,
		).toBeNull()
	})

	test('refuses an unknown plate cost state', () => {
		expect(
			plateCostSchema.safeParse({ state: 'guess', missingItemIds: [] }).success,
		).toBe(false)
	})
})

describe('costs for the menu list', () => {
	const ref = { key: 'row1', itemId: 'menu_shawarma', priceMinor: 2200 }

	test('carries ids, keys and prices, never names', () => {
		const parsed = recipeCostsRequestSchema.parse({
			refs: [ref],
			currency: 'SAR',
		})
		expect(parsed.refs[0]).toEqual(ref)
		expect(
			recipeCostsRequestSchema.safeParse({
				refs: [{ ...ref, name: 'Shawarma' }],
				currency: 'SAR',
			}).success,
		).toBe(false)
	})

	test('takes up to 200 refs, with unique keys', () => {
		const refs = (n: number) =>
			Array.from({ length: n }, (_, i) => ({ key: `k${i}`, itemId: `m${i}` }))
		expect(
			recipeCostsRequestSchema.safeParse({ refs: refs(200) }).success,
		).toBe(true)
		expect(
			recipeCostsRequestSchema.safeParse({ refs: refs(201) }).success,
		).toBe(false)
		expect(recipeCostsRequestSchema.safeParse({ refs: [] }).success).toBe(false)
		expect(
			recipeCostsRequestSchema.safeParse({
				refs: [
					{ key: 'a', itemId: 'm1' },
					{ key: 'a', itemId: 'm2' },
				],
			}).success,
		).toBe(false)
	})

	test('a price needs its currency', () => {
		expect(recipeCostsRequestSchema.safeParse({ refs: [ref] }).success).toBe(
			false,
		)
		expect(
			recipeCostsRequestSchema.safeParse({ refs: [{ key: 'a', itemId: 'm1' }] })
				.success,
		).toBe(true)
	})

	test('a size and usual options can be costed', () => {
		expect(
			recipeCostsRequestSchema.safeParse({
				refs: [{ ...ref, variantId: 'var_large', optionIds: ['opt_oat'] }],
				currency: 'SAR',
			}).success,
		).toBe(true)
	})

	test('rows answer by key; money and percentages are optional', () => {
		const parsed = recipeCostsResultSchema.parse({
			targetBp: 3000,
			rows: [
				{
					key: 'row1',
					hasRecipe: true,
					state: 'complete',
					costMinor: 655,
					currency: 'SAR',
					foodCostBp: 2977,
					status: 'good',
					priceForTargetMinor: 2183,
				},
				{ key: 'row2', hasRecipe: false, state: 'none' },
				{ key: 'row3', hasRecipe: true, state: 'complete' },
			],
		})
		expect(parsed.rows).toHaveLength(3)
		expect(parsed.rows[2]?.costMinor).toBeUndefined()
	})
})

describe('dishes without a recipe', () => {
	test('query defaults to the last 30 days, top 10, and coerces from the URL', () => {
		expect(
			dishesWithoutRecipeQuerySchema.parse({ locationId: 'main' }),
		).toEqual({
			locationId: 'main',
			days: 30,
			limit: 10,
		})
		expect(
			dishesWithoutRecipeQuerySchema.parse({
				locationId: 'main',
				days: '7',
				limit: '5',
			}),
		).toMatchObject({ days: 7, limit: 5 })
		expect(
			dishesWithoutRecipeQuerySchema.safeParse({
				locationId: 'main',
				days: '91',
			}).success,
		).toBe(false)
		expect(
			dishesWithoutRecipeQuerySchema.safeParse({ days: '7' }).success,
		).toBe(false)
	})

	test('the ranking is ids and numbers', () => {
		const parsed = dishesWithoutRecipeResultSchema.parse({
			days: 30,
			total: 14,
			truncated: false,
			dishes: [{ itemId: 'menu_shawarma', quantity: 412 }],
		})
		expect(parsed.dishes[0]?.netSalesMinor).toBeUndefined()
	})
})

describe('record a batch', () => {
	const base = { clientId: 'client-0001', locationId: 'main' }

	test('either a number of batches or an amount', () => {
		expect(
			recordBatchSchema.safeParse({
				...base,
				made: { kind: 'batches', count: 1.5 },
			}).success,
		).toBe(true)
		expect(
			recordBatchSchema.safeParse({
				...base,
				made: { kind: 'amount', amount: 3.5, unit: 'l' },
			}).success,
		).toBe(true)
	})

	test.each([
		['zero batches', { kind: 'batches', count: 0 }],
		['too many batches', { kind: 'batches', count: 1001 }],
		['an amount without a unit', { kind: 'amount', amount: 3 }],
		['a zero amount', { kind: 'amount', amount: 0, unit: 'l' }],
		['both at once', { kind: 'amount', amount: 3, unit: 'l', count: 1 }],
		['an unknown kind', { kind: 'half' }],
	])('refuses %s', (_name, made) => {
		expect(recordBatchSchema.safeParse({ ...base, made }).success).toBe(false)
	})

	test('needs a client id for idempotency', () => {
		expect(
			recordBatchSchema.safeParse({
				locationId: 'main',
				made: { kind: 'batches', count: 1 },
			}).success,
		).toBe(false)
	})

	test('the result lists what was used, with money optional', () => {
		const parsed = recordBatchResultSchema.parse({
			id: 'mv_1',
			madeQuantity: 4_000_000,
			used: [{ itemId: 'it_garlic', quantity: 500_000 }],
		})
		expect(parsed.valueMinor).toBeUndefined()
	})
})

describe('additions to earlier contracts', () => {
	test('the new error codes exist and none was renamed', () => {
		for (const code of [
			'recipe_cycle',
			'recipe_too_deep',
			'recipe_empty',
			'not_a_made_item',
		]) {
			expect(INVENTORY_ERROR_CODES).toContain(code)
		}
		for (const code of [
			'unit_mismatch',
			'stale_version',
			'invalid_request',
			'email_failed',
		]) {
			expect(INVENTORY_ERROR_CODES).toContain(code)
		}
	})

	test('item flags are optional on update and on the stock item, so older callers keep working', () => {
		expect(updateItemSchema.safeParse({ expectedVersion: 1 }).success).toBe(
			true,
		)
		expect(
			updateItemSchema.parse({
				expectedVersion: 1,
				batchCounted: true,
				autoSoldOut: false,
			}),
		).toMatchObject({ batchCounted: true, autoSoldOut: false })
		expect(
			updateItemSchema.safeParse({ expectedVersion: 1, batchCounted: 'yes' })
				.success,
		).toBe(false)
		const item = {
			id: 'i',
			name: 'Sauce',
			category: 'sauces',
			kind: 'made',
			baseUnit: 'ml',
			archived: false,
			version: 1,
			onHand: 0,
			countUnit: null,
			units: [],
			areaIds: [],
			orderBelowQuantity: null,
			fillUpToQuantity: null,
			status: 'out',
			lastCountedAt: null,
		}
		expect(stockItemSchema.parse(item).batchCounted).toBeUndefined()
		expect(
			stockItemSchema.parse({ ...item, batchCounted: true }).batchCounted,
		).toBe(true)
	})
})
