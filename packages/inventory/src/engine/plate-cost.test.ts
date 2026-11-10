import { describe, expect, test } from 'vitest'
import {
	dishFoodCostBp,
	FOOD_COST_WATCH_MARGIN_BP,
	foodCostStatus,
	plateCost,
	priceForTargetMinor,
} from './plate-cost.ts'
import { item, line, recipe, replaceLine, store } from './fixtures.ts'

const AT = 10_000

// SAR: chicken SAR 28/kg = 2.8 halalas per g = 2_800_000 micro; pita SAR 0.40 each.
const COSTS = new Map<string, number | null>([
	['chicken', 2_800_000],
	['pita', 400_000_000],
	['sauce_item', 5_000_000],
	['garlic', 1_000_000],
	['oil', 3_000_000],
	['oat_milk', 2_000_000],
	['milk', 1_000_000],
	['unpriced', null],
])

const input = (
	s: ReturnType<typeof store>,
	dish: {
		itemId: string
		variantId?: string
		options?: { optionId: string; half?: 'left' | 'right' }[]
	},
) => ({ store: s, dish, at: AT, currency: 'SAR', lastCostMicro: COSTS })

describe('plate cost', () => {
	const menu = store([
		recipe('menu_item', 'shawarma', [
			['chicken', 180_000, 8500],
			['pita', 1000],
		]),
		recipe('variant', 'large', [], { multiplierBp: 15_000 }),
	])

	test('prices the raw quantity at the last delivered cost', () => {
		const result = plateCost(input(menu, { itemId: 'shawarma' }))
		// 211.765 g x 2.8 = 592.94 halalas + 1 pita 40 SAR cents... pita micro 400_000_000
		// = 400 minor per piece => 211.7647 x 2.8 = 592.94; 1 x 400 = 400.
		expect(result).toMatchObject({
			state: 'complete',
			costMinor: 993,
			currency: 'SAR',
			missingItemIds: [],
		})
		expect(result.lines).toEqual([
			{ itemId: 'chicken', quantity: 211_765, costMinor: 593 },
			{ itemId: 'pita', quantity: 1000, costMinor: 400 },
		])
	})

	test('a size multiplies the cost', () => {
		const result = plateCost(
			input(menu, { itemId: 'shawarma', variantId: 'large' }),
		)
		// 1.5 x 992.94 = 1489.4
		expect(result.costMinor).toBe(1489)
	})

	test('an unpriced ingredient makes the cost a floor and is named', () => {
		const s = store([
			recipe('menu_item', 'd', [
				['chicken', 100_000],
				['unpriced', 1000],
			]),
		])
		const result = plateCost(input(s, { itemId: 'd' }))
		expect(result).toMatchObject({
			state: 'partial',
			costMinor: 280,
			missingItemIds: ['unpriced'],
		})
		expect(
			result.lines.find((l) => l.itemId === 'unpriced')?.costMinor,
		).toBeNull()
	})

	test('no ingredient priced is unknown, with no number', () => {
		const s = store([
			recipe('menu_item', 'd', [
				['unpriced', 1000],
				['ghost', 5],
			]),
		])
		const result = plateCost(input(s, { itemId: 'd' }))
		expect(result).toMatchObject({
			state: 'unknown',
			costMinor: null,
			missingItemIds: ['ghost', 'unpriced'],
		})
	})

	test('a dish with no recipe has no cost', () => {
		expect(plateCost(input(menu, { itemId: 'mystery' }))).toMatchObject({
			state: 'none',
			costMinor: null,
		})
	})

	test('a typed cost is the cost, scaled by a size multiplier', () => {
		const s = store([
			recipe('menu_item', 'cola', [], {
				typedCost: { minor: 150, currency: 'SAR' },
			}),
			recipe('variant', 'big', [], { multiplierBp: 20_000 }),
			recipe('variant', 'can', [], {
				typedCost: { minor: 99, currency: 'SAR' },
			}),
		])
		expect(plateCost(input(s, { itemId: 'cola' }))).toMatchObject({
			state: 'typed',
			costMinor: 150,
			typedCostMinor: 150,
		})
		expect(
			plateCost(input(s, { itemId: 'cola', variantId: 'big' })),
		).toMatchObject({
			state: 'typed',
			costMinor: 300,
			typedCostMinor: 300,
		})
		// A size with its own typed cost is that cost, unscaled.
		expect(
			plateCost(input(s, { itemId: 'cola', variantId: 'can' })),
		).toMatchObject({
			state: 'typed',
			costMinor: 99,
		})
	})

	test('a typed cost in another currency is not used', () => {
		const s = store([
			recipe('menu_item', 'x', [], {
				typedCost: { minor: 150, currency: 'USD' },
			}),
		])
		expect(plateCost(input(s, { itemId: 'x' }))).toMatchObject({
			state: 'unknown',
			costMinor: null,
		})
	})

	test('options add their cost; oat milk replaces milk', () => {
		const s = store([
			recipe('menu_item', 'latte', [['milk', 200_000]]),
			recipe('option', 'oat', [replaceLine('oat_milk', 200_000, 'milk')]),
			recipe('option', 'syrup', [], {
				typedCost: { minor: 50, currency: 'SAR' },
			}),
		])
		expect(plateCost(input(s, { itemId: 'latte' })).costMinor).toBe(200)
		const oat = plateCost(
			input(s, {
				itemId: 'latte',
				options: [{ optionId: 'oat' }, { optionId: 'syrup' }],
			}),
		)
		expect(oat.costMinor).toBe(400 + 50)
		expect(oat.lines.map((l) => l.itemId)).toEqual(['oat_milk'])
	})

	test('half an option costs half', () => {
		const s = store([
			recipe('menu_item', 'pizza', [['chicken', 100_000]]),
			recipe('option', 'extra', [['chicken', 100_000]]),
		])
		const half = plateCost(
			input(s, {
				itemId: 'pizza',
				options: [{ optionId: 'extra', half: 'left' }],
			}),
		)
		expect(half.costMinor).toBe(280 + 140)
	})

	test('costs a made item through its ingredients, or itself when counted in batches', () => {
		const recipes = [
			recipe('menu_item', 'wrap', [['sauce_item', 40_000]]),
			recipe(
				'made_item',
				'sauce_item',
				[
					['garlic', 500_000],
					['oil', 1_000_000],
				],
				{
					makesQuantity: 4_000_000,
				},
			),
		]
		const through = plateCost(
			input(store(recipes, [item('sauce_item', 'made')]), { itemId: 'wrap' }),
		)
		// 1% of a batch: 5 g garlic (5 micro-halala... 5000 x 1_000_000) + 10 ml oil.
		expect(through.lines.map((l) => l.itemId)).toEqual(['garlic', 'oil'])
		expect(through.costMinor).toBe(
			Math.round((5000 * 1_000_000 + 10_000 * 3_000_000) / 1e9),
		)
		const counted = plateCost(
			input(store(recipes, [item('sauce_item', 'made', true)]), {
				itemId: 'wrap',
			}),
		)
		expect(counted.lines.map((l) => l.itemId)).toEqual(['sauce_item'])
		expect(counted.costMinor).toBe(Math.round((40_000 * 5_000_000) / 1e9))
	})

	test('a recipe loop is invalid, not a number', () => {
		const s = store(
			[
				recipe('menu_item', 'd', [['a', 1000]]),
				recipe('made_item', 'a', [['a', 1000]]),
			],
			[item('a', 'made')],
		)
		expect(plateCost(input(s, { itemId: 'd' }))).toMatchObject({
			state: 'invalid',
			costMinor: null,
			error: { code: 'recipe_cycle', path: ['a', 'a'] },
		})
	})

	test('uses the recipe in force at the time', () => {
		const s = store([
			recipe('menu_item', 'd', [['chicken', 100_000]], {
				version: 1,
				effectiveFrom: 0,
			}),
			recipe('menu_item', 'd', [['chicken', 200_000]], {
				version: 2,
				effectiveFrom: 20_000,
			}),
		])
		expect(plateCost(input(s, { itemId: 'd' })).costMinor).toBe(280)
		expect(
			plateCost({ ...input(s, { itemId: 'd' }), at: 20_000 }).costMinor,
		).toBe(560)
	})

	test('rejects a negative cost', () => {
		const s = store([recipe('menu_item', 'd', [['x', 1000]])])
		expect(() =>
			plateCost({
				...input(s, { itemId: 'd' }),
				lastCostMicro: new Map([['x', -1]]),
			}),
		).toThrow(RangeError)
	})
})

describe('food cost helpers', () => {
	test('cost over price in basis points: 6.55 on 22.00 is 29.8%', () => {
		expect(dishFoodCostBp(2200, 655)).toBe(2977)
		expect(dishFoodCostBp(2200, 0)).toBe(0)
		expect(dishFoodCostBp(0, 655)).toBeNull()
		expect(dishFoodCostBp(-5, 655)).toBeNull()
	})

	test('price for target: 6.55 at 30% is 21.83', () => {
		expect(priceForTargetMinor(655, 3000)).toBe(2183)
		expect(priceForTargetMinor(0, 3000)).toBeNull()
		expect(priceForTargetMinor(655, 0)).toBeNull()
	})

	test('strips tax from tax-inclusive menu prices and grosses up target price', () => {
		// 23.00 SAR with 15% VAT -> net 20.00 SAR (2000 halalas). Cost 600 -> 30.00% (3000 bp).
		expect(
			dishFoodCostBp(2300, 600, { pricesIncludeTax: true, taxRateBp: 1500 }),
		).toBe(3000)
		// Cost 600 at 30% net target = 2000; grossed up by 15% VAT = 2300.
		expect(
			priceForTargetMinor(600, 3000, {
				pricesIncludeTax: true,
				taxRateBp: 1500,
			}),
		).toBe(2300)
	})

	test('price for target brings the dish to the target', () => {
		for (const cost of [1, 99, 655, 12_345]) {
			const price = priceForTargetMinor(cost, 3000)!
			const bp = dishFoodCostBp(price, cost)!
			expect(Math.abs(bp - 3000)).toBeLessThanOrEqual(Math.ceil(10_000 / price))
		}
	})

	test('status dot: good at or under target, watch within five points, then high', () => {
		expect(foodCostStatus(3000, 3000)).toBe('good')
		expect(foodCostStatus(3001, 3000)).toBe('watch')
		expect(foodCostStatus(3000 + FOOD_COST_WATCH_MARGIN_BP, 3000)).toBe('watch')
		expect(foodCostStatus(3501, 3000)).toBe('high')
	})
})
