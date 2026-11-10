import { describe, expect, test } from 'vitest'
import {
	checkMadeRecipeGraph,
	expandLines,
	expandRecipe,
	MAX_RECIPE_DEPTH,
} from './expand.ts'
import { item, line, recipe, replaceLine, store, usageOf } from './fixtures.ts'
import { parseSaleLines } from './sale-lines.ts'

const AT = 10_000

describe('a plain dish', () => {
	const shawarma = store([
		recipe('menu_item', 'shawarma', [
			['chicken', 180_000, 8500],
			['pita', 1000],
		]),
	])

	test('usable yield divides: 180 g at 85% needs 211.765 g raw', () => {
		const result = expandRecipe(
			shawarma,
			{ itemId: 'shawarma', quantity: 1 },
			AT,
		)
		expect(usageOf(result)).toEqual({ chicken: 211_765, pita: 1000 })
		expect(result.unrecipedLines).toEqual([])
		expect(result.errors).toEqual([])
	})

	test('rounds once for the whole line, not per dish', () => {
		// 3 x 211_764.705… = 635_294.1…; rounding each dish first would give 635_295.
		const result = expandRecipe(
			shawarma,
			{ itemId: 'shawarma', quantity: 3 },
			AT,
		)
		expect(usageOf(result).chicken).toBe(635_294)
	})

	test('sums the lines of a sale and rounds once per item', () => {
		const result = expandLines(
			shawarma,
			[
				{ itemId: 'shawarma', quantity: 1 },
				{ itemId: 'shawarma', quantity: 1 },
				{ itemId: 'shawarma', quantity: 1 },
			],
			AT,
		)
		expect(usageOf(result).chicken).toBe(635_294)
	})

	test.each([
		[1000, 3333, 3000],
		[1000, 3334, 2999],
		[1, 10_000, 1],
		[1, 3, 3333],
		[7, 6667, 10],
	])(
		'quantity %i at usable %i bp needs %i thousandths',
		(quantity, bp, raw) => {
			const s = store([recipe('menu_item', 'd', [['x', quantity, bp]])])
			expect(usageOf(expandRecipe(s, { itemId: 'd', quantity: 1 }, AT)).x).toBe(
				raw,
			)
		},
	)
})

describe('dishes without a recipe', () => {
	test('add nothing and are listed with their position', () => {
		const s = store([recipe('menu_item', 'known', [['x', 1000]])])
		const result = expandLines(
			s,
			[
				{ itemId: 'known', quantity: 2 },
				{ itemId: 'mystery', variantId: 'v1', quantity: 4 },
			],
			AT,
		)
		expect(usageOf(result)).toEqual({ x: 2000 })
		expect(result.unrecipedLines).toEqual([
			{ index: 1, itemId: 'mystery', variantId: 'v1', quantity: 4 },
		])
	})

	test('a typed cost dish is covered: no stock, not without a recipe', () => {
		const s = store([
			recipe('menu_item', 'cola', [], {
				typedCost: { minor: 150, currency: 'SAR' },
			}),
		])
		const result = expandRecipe(s, { itemId: 'cola', quantity: 5 }, AT)
		expect(result.usage).toEqual([])
		expect(result.unrecipedLines).toEqual([])
	})

	test('rejects bad quantities', () => {
		const s = store([])
		expect(() => expandLines(s, [{ itemId: 'a', quantity: 0 }], AT)).toThrow(
			RangeError,
		)
		expect(() => expandLines(s, [{ itemId: 'a', quantity: 1.5 }], AT)).toThrow(
			RangeError,
		)
	})
})

describe('absurd amounts', () => {
	test('a line that would use more than the maximum of an ingredient is left out and reported', () => {
		const s = store([
			recipe('menu_item', 'big', [['x', 5_000_000, 100]]),
			recipe('menu_item', 'ok', [['y', 1000]]),
		])
		const result = expandLines(
			s,
			[
				{ itemId: 'big', quantity: 1 },
				{ itemId: 'ok', quantity: 1 },
			],
			AT,
		)
		// 5_000 g at 1% usable is 500 kg per dish: fine alone, too much by the dozen.
		expect(result.errors).toEqual([])
		const many = expandLines(s, [{ itemId: 'big', quantity: 50 }], AT)
		expect(many.errors).toEqual([
			{ lineIndex: 0, code: 'usage_out_of_range', path: [] },
		])
		expect(many.usage).toEqual([])
	})
})

describe('sizes', () => {
	const pizza = store([
		recipe('menu_item', 'margherita', [
			['dough', 250_000],
			['cheese', 120_000],
		]),
		recipe('variant', 'large', [], { multiplierBp: 15_000 }),
		recipe('variant', 'small', [], { multiplierBp: 7_000 }),
		recipe('variant', 'xl', [
			['dough', 500_000],
			['cheese', 300_000],
		]),
	])

	test('a multiplier scales the item recipe', () => {
		expect(
			usageOf(
				expandRecipe(
					pizza,
					{ itemId: 'margherita', variantId: 'large', quantity: 1 },
					AT,
				),
			),
		).toEqual({ dough: 375_000, cheese: 180_000 })
		expect(
			usageOf(
				expandRecipe(
					pizza,
					{ itemId: 'margherita', variantId: 'small', quantity: 2 },
					AT,
				),
			),
		).toEqual({ dough: 350_000, cheese: 168_000 })
	})

	test('an own recipe replaces the item recipe', () => {
		expect(
			usageOf(
				expandRecipe(
					pizza,
					{ itemId: 'margherita', variantId: 'xl', quantity: 1 },
					AT,
				),
			),
		).toEqual({ dough: 500_000, cheese: 300_000 })
	})

	test('a size without a recipe uses the item recipe as it is', () => {
		expect(
			usageOf(
				expandRecipe(
					pizza,
					{ itemId: 'margherita', variantId: 'unknown', quantity: 1 },
					AT,
				),
			),
		).toEqual({ dough: 250_000, cheese: 120_000 })
	})

	test('a multiplier with no item recipe is flagged and without a recipe', () => {
		const result = expandRecipe(
			store([recipe('variant', 'large', [], { multiplierBp: 15_000 })]),
			{ itemId: 'ghost', variantId: 'large', quantity: 1 },
			AT,
		)
		expect(result.usage).toEqual([])
		expect(result.unrecipedLines).toHaveLength(1)
		expect(result.flags).toEqual([
			{ kind: 'multiplier_without_base', lineIndex: 0, itemId: 'ghost' },
		])
	})

	test('a multiplier rounds once with the rest', () => {
		const s = store([
			recipe('menu_item', 'd', [['x', 1001]]),
			recipe('variant', 'v', [], { multiplierBp: 5000 }),
		])
		// 1001 x 0.5 = 500.5 -> 501 (halves up)
		expect(
			usageOf(expandRecipe(s, { itemId: 'd', variantId: 'v', quantity: 1 }, AT))
				.x,
		).toBe(501)
	})
})

describe('options', () => {
	const pizza = store([
		recipe('menu_item', 'pizza', [
			['dough', 250_000],
			['cheese', 100_000],
		]),
		recipe('option', 'pepperoni', [['pepperoni', 60_000]]),
		recipe('option', 'extra_cheese', [['cheese', 30_000]]),
	])

	test('an option adds its ingredients', () => {
		const result = expandRecipe(
			pizza,
			{ itemId: 'pizza', quantity: 1, options: [{ optionId: 'extra_cheese' }] },
			AT,
		)
		expect(usageOf(result)).toEqual({
			dough: 250_000,
			cheese: 130_000,
		})
	})

	test('the option quantity is per dish and the line quantity multiplies it', () => {
		const result = expandRecipe(
			pizza,
			{
				itemId: 'pizza',
				quantity: 3,
				options: [{ optionId: 'extra_cheese', quantity: 2 }],
			},
			AT,
		)
		// per dish: 100_000 + 2 x 30_000 = 160_000, three dishes.
		expect(usageOf(result).cheese).toBe(480_000)
	})

	test('pizza halves take half of the option recipe each', () => {
		const result = expandRecipe(
			pizza,
			{
				itemId: 'pizza',
				quantity: 1,
				options: [
					{ optionId: 'pepperoni', half: 'left' },
					{ optionId: 'extra_cheese', half: 'right' },
				],
			},
			AT,
		)
		expect(usageOf(result)).toEqual({
			dough: 250_000,
			cheese: 115_000,
			pepperoni: 30_000,
		})
	})

	test('a left and a right half of one option equal one whole', () => {
		const halves = expandRecipe(
			pizza,
			{
				itemId: 'pizza',
				quantity: 1,
				options: [
					{ optionId: 'pepperoni', half: 'left' },
					{ optionId: 'pepperoni', half: 'right' },
				],
			},
			AT,
		)
		const whole = expandRecipe(
			pizza,
			{
				itemId: 'pizza',
				quantity: 1,
				options: [{ optionId: 'pepperoni', half: 'whole' }],
			},
			AT,
		)
		expect(usageOf(halves)).toEqual(usageOf(whole))
	})

	test('an option with no recipe adds nothing', () => {
		const result = expandRecipe(
			pizza,
			{ itemId: 'pizza', quantity: 1, options: [{ optionId: 'no_onion' }] },
			AT,
		)
		expect(usageOf(result)).toEqual({ dough: 250_000, cheese: 100_000 })
	})

	test('an unknown half value is treated as whole', () => {
		const result = expandRecipe(
			pizza,
			{
				itemId: 'pizza',
				quantity: 1,
				options: [{ optionId: 'pepperoni', half: null }],
			},
			AT,
		)
		expect(usageOf(result).pepperoni).toBe(60_000)
	})
})

describe('options that replace an ingredient (oat milk)', () => {
	const cafe = store([
		recipe('menu_item', 'latte', [
			['espresso', 18_000],
			['milk', 200_000],
		]),
		recipe('variant', 'large', [], { multiplierBp: 15_000 }),
		recipe('option', 'oat', [replaceLine('oat_milk', 200_000, 'milk')]),
		recipe('option', 'almond', [replaceLine('almond_milk', 200_000, 'milk')]),
		recipe('option', 'extra_milk', [line('milk', 50_000)]),
		recipe('option', 'caramel', [replaceLine('caramel', 10_000, 'vanilla')]),
	])

	test('swaps the ingredient and never leaves both', () => {
		const result = expandRecipe(
			cafe,
			{ itemId: 'latte', quantity: 1, options: [{ optionId: 'oat' }] },
			AT,
		)
		expect(usageOf(result)).toEqual({ espresso: 18_000, oat_milk: 200_000 })
	})

	test('takes out the dish size, not just the base amount', () => {
		const result = expandRecipe(
			cafe,
			{
				itemId: 'latte',
				variantId: 'large',
				quantity: 2,
				options: [{ optionId: 'oat' }],
			},
			AT,
		)
		// Base milk at 1.5x is 300 ml per dish: all of it goes, 200 ml of oat comes in.
		expect(usageOf(result)).toEqual({ espresso: 54_000, oat_milk: 400_000 })
	})

	test('a half swaps half', () => {
		const result = expandRecipe(
			cafe,
			{
				itemId: 'latte',
				quantity: 1,
				options: [{ optionId: 'oat', half: 'left' }],
			},
			AT,
		)
		expect(usageOf(result)).toEqual({
			espresso: 18_000,
			milk: 100_000,
			oat_milk: 100_000,
		})
	})

	test('two swaps of one ingredient take out at most what there was', () => {
		const result = expandRecipe(
			cafe,
			{
				itemId: 'latte',
				quantity: 1,
				options: [{ optionId: 'oat' }, { optionId: 'almond' }],
			},
			AT,
		)
		expect(usageOf(result)).toEqual({
			espresso: 18_000,
			oat_milk: 200_000,
			almond_milk: 200_000,
		})
	})

	test('an extra of the replaced ingredient stays, only the dish amount goes', () => {
		const result = expandRecipe(
			cafe,
			{
				itemId: 'latte',
				quantity: 1,
				options: [{ optionId: 'oat' }, { optionId: 'extra_milk' }],
			},
			AT,
		)
		expect(usageOf(result)).toEqual({
			espresso: 18_000,
			milk: 50_000,
			oat_milk: 200_000,
		})
	})

	test('replacing something the dish lacks is an add, and flagged', () => {
		const result = expandRecipe(
			cafe,
			{ itemId: 'latte', quantity: 1, options: [{ optionId: 'caramel' }] },
			AT,
		)
		expect(usageOf(result)).toEqual({
			espresso: 18_000,
			milk: 200_000,
			caramel: 10_000,
		})
		expect(result.flags).toEqual([
			{
				kind: 'replace_base_missing',
				lineIndex: 0,
				itemId: 'vanilla',
				optionId: 'caramel',
			},
		])
	})
})

describe('made items', () => {
	// Garlic sauce: one batch makes 4 L from 500 g garlic and 1 L oil.
	const sauce = (batchCounted: boolean) =>
		store(
			[
				recipe('menu_item', 'wrap', [
					['chicken', 150_000],
					['sauce', 40_000],
				]),
				recipe(
					'made_item',
					'sauce',
					[
						['garlic', 500_000],
						['oil', 1_000_000],
					],
					{ makesQuantity: 4_000_000 },
				),
			],
			[item('sauce', 'made', batchCounted)],
		)

	test('expands into its ingredients when not counted in batches', () => {
		const result = expandRecipe(
			sauce(false),
			{ itemId: 'wrap', quantity: 1 },
			AT,
		)
		// 40 ml of 4 L is 1% of a batch.
		expect(usageOf(result)).toEqual({
			chicken: 150_000,
			garlic: 5000,
			oil: 10_000,
		})
	})

	test('uses the made item itself when counted in batches', () => {
		const result = expandRecipe(
			sauce(true),
			{ itemId: 'wrap', quantity: 2 },
			AT,
		)
		expect(usageOf(result)).toEqual({ chicken: 300_000, sauce: 80_000 })
	})

	test('a made item with no recipe in force is used as itself and flagged', () => {
		const s = store(
			[recipe('menu_item', 'wrap', [['sauce', 40_000]])],
			[item('sauce', 'made')],
		)
		const result = expandRecipe(s, { itemId: 'wrap', quantity: 1 }, AT)
		expect(usageOf(result)).toEqual({ sauce: 40_000 })
		expect(result.flags).toEqual([
			{ kind: 'made_item_without_recipe', lineIndex: 0, itemId: 'sauce' },
		])
	})

	test('usable yield of the made recipe applies', () => {
		const s = store(
			[
				recipe('menu_item', 'wrap', [['marinade', 100_000]]),
				recipe('made_item', 'marinade', [['chicken', 800_000, 8000]], {
					makesQuantity: 1_000_000,
				}),
			],
			[item('marinade', 'made')],
		)
		// 100 ml of 1 L is 10%: 10% of 800 g / 0.8 = 100 g raw chicken.
		expect(
			usageOf(expandRecipe(s, { itemId: 'wrap', quantity: 1 }, AT)),
		).toEqual({
			chicken: 100_000,
		})
	})

	test('a made item inside a made item expands all the way', () => {
		const s = store(
			[
				recipe('menu_item', 'plate', [['gravy', 100_000]]),
				recipe(
					'made_item',
					'gravy',
					[
						['stock', 500_000],
						['flour', 50_000],
					],
					{
						makesQuantity: 1_000_000,
					},
				),
				recipe('made_item', 'stock', [['bones', 2_000_000]], {
					makesQuantity: 4_000_000,
				}),
			],
			[item('gravy', 'made'), item('stock', 'made')],
		)
		// 100 ml gravy = 0.1 batch: stock 50 ml = 0.0125 batch of stock = 25 g bones.
		expect(
			usageOf(expandRecipe(s, { itemId: 'plate', quantity: 1 }, AT)),
		).toEqual({
			bones: 25_000,
			flour: 5000,
		})
	})

	test('a batch-counted made item inside a made item stops there', () => {
		const s = store(
			[
				recipe('menu_item', 'plate', [['gravy', 100_000]]),
				recipe('made_item', 'gravy', [['stock', 500_000]], {
					makesQuantity: 1_000_000,
				}),
				recipe('made_item', 'stock', [['bones', 2_000_000]], {
					makesQuantity: 4_000_000,
				}),
			],
			[item('gravy', 'made'), item('stock', 'made', true)],
		)
		expect(
			usageOf(expandRecipe(s, { itemId: 'plate', quantity: 1 }, AT)),
		).toEqual({
			stock: 50_000,
		})
	})
})

describe('cycles and depth', () => {
	test('a loop of made items is reported with its path and the line is left out', () => {
		const s = store(
			[
				recipe('menu_item', 'dish', [['a', 1000]]),
				recipe('menu_item', 'fine', [['x', 1000]]),
				recipe('made_item', 'a', [['b', 1000]]),
				recipe('made_item', 'b', [['c', 1000]]),
				recipe('made_item', 'c', [['a', 1000]]),
			],
			[item('a', 'made'), item('b', 'made'), item('c', 'made')],
		)
		const result = expandLines(
			s,
			[
				{ itemId: 'dish', quantity: 1 },
				{ itemId: 'fine', quantity: 1 },
			],
			AT,
		)
		expect(result.errors).toEqual([
			{ lineIndex: 0, code: 'recipe_cycle', path: ['a', 'b', 'c', 'a'] },
		])
		expect(usageOf(result)).toEqual({ x: 1000 })
	})

	test('a made item that lists itself is a cycle of one', () => {
		const s = store(
			[
				recipe('menu_item', 'dish', [['a', 1000]]),
				recipe('made_item', 'a', [['a', 1000]]),
			],
			[item('a', 'made')],
		)
		expect(expandRecipe(s, { itemId: 'dish', quantity: 1 }, AT).errors).toEqual(
			[{ lineIndex: 0, code: 'recipe_cycle', path: ['a', 'a'] }],
		)
	})

	test('counting one made item in batches breaks the loop', () => {
		const s = store(
			[
				recipe('menu_item', 'dish', [['a', 1000]]),
				recipe('made_item', 'a', [['b', 1000]]),
				recipe('made_item', 'b', [['a', 1000]]),
			],
			[item('a', 'made'), item('b', 'made', true)],
		)
		const result = expandRecipe(s, { itemId: 'dish', quantity: 1 }, AT)
		expect(result.errors).toEqual([])
		expect(usageOf(result)).toEqual({ b: 1 })
	})

	function chain(length: number) {
		const recipes = [recipe('menu_item', 'dish', [['m1', 1_000_000]])]
		const items = []
		for (let i = 1; i <= length; i++) {
			const next = i === length ? 'flour' : `m${i + 1}`
			recipes.push(
				recipe('made_item', `m${i}`, [[next, 1_000_000]], {
					makesQuantity: 1_000_000,
				}),
			)
			items.push(item(`m${i}`, 'made'))
		}
		return store(recipes, items)
	}

	test(`allows ${MAX_RECIPE_DEPTH} made items deep`, () => {
		const result = expandRecipe(
			chain(MAX_RECIPE_DEPTH),
			{ itemId: 'dish', quantity: 1 },
			AT,
		)
		expect(result.errors).toEqual([])
		expect(usageOf(result)).toEqual({ flour: 1_000_000 })
	})

	test('refuses one more with the path', () => {
		const result = expandRecipe(
			chain(MAX_RECIPE_DEPTH + 1),
			{ itemId: 'dish', quantity: 1 },
			AT,
		)
		expect(result.errors).toHaveLength(1)
		expect(result.errors[0]).toMatchObject({ code: 'recipe_too_deep' })
		expect(result.errors[0]!.path).toEqual(
			Array.from({ length: MAX_RECIPE_DEPTH + 1 }, (_, i) => `m${i + 1}`),
		)
		expect(result.usage).toEqual([])
	})
})

describe('the recipe in force at the sale time', () => {
	const s = store([
		recipe('menu_item', 'dish', [['old', 1000]], {
			version: 1,
			effectiveFrom: 1000,
		}),
		recipe('menu_item', 'dish', [['new', 2000]], {
			version: 2,
			effectiveFrom: 5000,
		}),
		recipe('menu_item', 'gone', [['x', 1000]], {
			version: 1,
			effectiveFrom: 1000,
		}),
		recipe('menu_item', 'gone', [], { version: 2, effectiveFrom: 3000 }),
	])
	const use = (itemId: string, at: number) =>
		usageOf(expandRecipe(s, { itemId, quantity: 1 }, at))

	test('is the newest version at or before the sale', () => {
		expect(use('dish', 999)).toEqual({})
		expect(use('dish', 1000)).toEqual({ old: 1000 })
		expect(use('dish', 4999)).toEqual({ old: 1000 })
		expect(use('dish', 5000)).toEqual({ new: 2000 })
		expect(use('dish', 9_999_999)).toEqual({ new: 2000 })
	})

	test('a sale before the first version has no recipe', () => {
		expect(
			expandRecipe(s, { itemId: 'dish', quantity: 1 }, 500).unrecipedLines,
		).toHaveLength(1)
	})

	test('a cleared recipe means none from then on, history kept', () => {
		expect(use('gone', 2999)).toEqual({ x: 1000 })
		expect(use('gone', 3000)).toEqual({})
		expect(
			expandRecipe(s, { itemId: 'gone', quantity: 1 }, 3000).unrecipedLines,
		).toHaveLength(1)
	})
})

describe('checking a made item recipe before it is saved', () => {
	const s = store(
		[
			recipe('made_item', 'b', [['a', 1000]]),
			recipe('made_item', 'c', [['b', 1000]]),
		],
		[item('a', 'made'), item('b', 'made'), item('c', 'made')],
	)

	test('finds a direct and an indirect loop', () => {
		expect(checkMadeRecipeGraph(s, 'a', ['a'], AT)).toEqual({
			code: 'recipe_cycle',
			path: ['a', 'a'],
		})
		expect(checkMadeRecipeGraph(s, 'a', ['c'], AT)).toEqual({
			code: 'recipe_cycle',
			path: ['a', 'c', 'b', 'a'],
		})
	})

	test('follows made items even when counted in batches', () => {
		const counted = store(
			[recipe('made_item', 'b', [['a', 1000]])],
			[item('a', 'made'), item('b', 'made', true)],
		)
		expect(checkMadeRecipeGraph(counted, 'a', ['b'], AT)?.code).toBe(
			'recipe_cycle',
		)
	})

	test('accepts bought ingredients and unrelated made items', () => {
		expect(checkMadeRecipeGraph(s, 'z', ['flour', 'c'], AT)).toBeNull()
	})

	test('refuses nesting past the depth cap', () => {
		const recipes = []
		const items = [item('top', 'made')]
		for (let i = 1; i <= MAX_RECIPE_DEPTH; i++) {
			recipes.push(
				recipe('made_item', `m${i}`, [
					[i === MAX_RECIPE_DEPTH ? 'flour' : `m${i + 1}`, 1000],
				]),
			)
			items.push(item(`m${i}`, 'made'))
		}
		// top + eight more made items is nine deep.
		expect(
			checkMadeRecipeGraph(store(recipes, items), 'top', ['m1'], AT)?.code,
		).toBe('recipe_too_deep')
		// Dropping the last one fits.
		expect(
			checkMadeRecipeGraph(
				store(recipes.slice(0, MAX_RECIPE_DEPTH - 2), items),
				'top',
				['m1'],
				AT,
			),
		).toBeNull()
	})
})

describe('reading stored order lines', () => {
	test('keeps option quantities per dish and reads pizza halves', () => {
		const lines = parseSaleLines(
			[
				{
					itemId: 'pizza',
					variantId: 'large',
					quantity: 3,
					options: [
						{ optionId: 'cheese', quantity: 2, half: 'left' },
						{ optionId: 'olives', quantity: 1, half: 'whole' },
					],
				},
				{ itemId: '', quantity: 1 },
				{ itemId: 'x', quantity: 0 },
				null,
			],
			'restaurant',
		)
		expect(lines).toEqual([
			{
				itemId: 'pizza',
				variantId: 'large',
				quantity: 3,
				options: [
					{ optionId: 'cheese', quantity: 2, half: 'left' },
					{ optionId: 'olives', quantity: 1, half: null },
				],
			},
		])
	})

	test('a Station line has no halves; JSON text is accepted; junk is empty', () => {
		expect(
			parseSaleLines(
				JSON.stringify([
					{
						itemId: 'a',
						variantId: null,
						quantity: 2,
						options: [{ optionId: 'o', quantity: 1, half: 'left' }],
					},
				]),
				'pos',
			),
		).toEqual([
			{
				itemId: 'a',
				variantId: null,
				quantity: 2,
				options: [{ optionId: 'o', quantity: 1, half: null }],
			},
		])
		expect(parseSaleLines('not json', 'pos')).toEqual([])
		expect(parseSaleLines(undefined, 'restaurant')).toEqual([])
	})
})
