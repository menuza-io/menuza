import { describe, expect, test } from 'vitest'
import { item, recipe, store } from './fixtures.ts'
import { rankDishesWithoutRecipe } from './ranking.ts'
import {
	applyUsageDeltas,
	desiredUsage,
	diffUsage,
	type SaleSource,
	type UsageEntry,
} from './usage.ts'

const AT = 10_000
const menu = store(
	[
		recipe('menu_item', 'burger', [
			['beef', 150_000],
			['bun', 1000],
		]),
		recipe('menu_item', 'fries', [['potato', 200_000]]),
	],
	[],
)

const burgers = (quantity: number) => [{ itemId: 'burger', quantity }]
const desired = (source: SaleSource, at = AT) =>
	desiredUsage({ store: menu, locationId: 'main', at, source })

describe('web and QR orders', () => {
	test('a counted order uses stock', () => {
		const result = desired({
			kind: 'restaurant_order',
			state: 'counted',
			lines: burgers(2),
		})
		expect(result.sale).toEqual([
			{ itemId: 'beef', locationId: 'main', quantity: 300_000 },
			{ itemId: 'bun', locationId: 'main', quantity: 2000 },
		])
	})

	test.each(['awaiting_payment', 'cancelled', 'expired'] as const)(
		'an order that is %s uses none',
		(state) => {
			const result = desired({
				kind: 'restaurant_order',
				state,
				lines: burgers(2),
			})
			expect(result.sale).toEqual([])
			expect(result.unrecipedLines).toEqual([])
		},
	)

	test('lists the dishes that have no recipe', () => {
		const result = desired({
			kind: 'restaurant_order',
			state: 'counted',
			lines: [...burgers(1), { itemId: 'special', quantity: 3 }],
		})
		expect(result.unrecipedLines).toEqual([
			{ index: 1, itemId: 'special', variantId: null, quantity: 3 },
		])
	})
})

describe('Station sales', () => {
	test.each([
		['paid', true],
		['refunded', true],
		['open', false],
		['void', false],
	] as const)('a %s sale uses stock: %s', (status, uses) => {
		const result = desired({ kind: 'pos_order', status, lines: burgers(1) })
		expect(result.sale.length > 0).toBe(uses)
	})

	test('a refund does not return stock', () => {
		const paid = desired({
			kind: 'pos_order',
			status: 'paid',
			lines: burgers(1),
		})
		const refunded = desired({
			kind: 'pos_order',
			status: 'refunded',
			lines: burgers(1),
		})
		expect(refunded.sale).toEqual(paid.sale)
	})

	test('voided lines are already out of the current lines and are not taken off again', () => {
		const result = desired({
			kind: 'pos_order',
			status: 'paid',
			lines: burgers(1),
			lineVoids: [
				{ id: 'v1', itemId: 'burger', quantity: 1, reason: 'mistake' },
			],
		})
		expect(result.sale.find((u) => u.itemId === 'bun')?.quantity).toBe(1000)
		expect(result.wasteVoids).toEqual([])
		expect(result.signals).toEqual([])
	})

	test('a quality void is waste of the dish, in its own source', () => {
		const result = desired({
			kind: 'pos_order',
			status: 'open',
			lines: [],
			lineVoids: [
				{ id: 'v2', itemId: 'burger', quantity: 2, reason: 'quality' },
				{ id: 'v1', itemId: 'fries', quantity: 1, reason: 'quality' },
			],
		})
		expect(result.sale).toEqual([])
		expect(result.wasteVoids).toEqual([
			{
				voidId: 'v1',
				itemId: 'fries',
				quantity: 1,
				usage: [{ itemId: 'potato', locationId: 'main', quantity: 200_000 }],
			},
			{
				voidId: 'v2',
				itemId: 'burger',
				quantity: 2,
				usage: [
					{ itemId: 'beef', locationId: 'main', quantity: 300_000 },
					{ itemId: 'bun', locationId: 'main', quantity: 2000 },
				],
			},
		])
	})

	test('an out of stock void is a signal only', () => {
		const result = desired({
			kind: 'pos_order',
			status: 'paid',
			lines: [],
			lineVoids: [
				{ id: 'v1', itemId: 'burger', quantity: 1, reason: 'out_of_stock' },
			],
		})
		expect(result.signals).toEqual([
			{ kind: 'out_of_stock', voidId: 'v1', itemId: 'burger', quantity: 1 },
		])
		expect(result.wasteVoids).toEqual([])
		expect(result.sale).toEqual([])
	})

	test('a quality void of a dish whose recipes loop is reported, not thrown', () => {
		const loop = store(
			[
				recipe('menu_item', 'dish', [['a', 1000]]),
				recipe('made_item', 'a', [['a', 1000]]),
			],
			[item('a', 'made')],
		)
		const result = desiredUsage({
			store: loop,
			locationId: 'main',
			at: AT,
			source: {
				kind: 'pos_order',
				status: 'paid',
				lines: [{ itemId: 'dish', quantity: 1 }],
				lineVoids: [
					{ id: 'v1', itemId: 'dish', quantity: 1, reason: 'quality' },
				],
			},
		})
		expect(result.errors).toEqual([
			{ lineIndex: 0, code: 'recipe_cycle', path: ['a', 'a'] },
			{ lineIndex: null, voidId: 'v1', code: 'recipe_cycle', path: ['a', 'a'] },
		])
		expect(result.sale).toEqual([])
	})
})

describe('the recipe is the one in force at the sale time', () => {
	const versions = store([
		recipe('menu_item', 'burger', [['beef', 100_000]], {
			version: 1,
			effectiveFrom: 0,
		}),
		recipe('menu_item', 'burger', [['beef', 150_000]], {
			version: 2,
			effectiveFrom: 50_000,
		}),
	])
	test('an edit does not move the usage of earlier sales', () => {
		const source: SaleSource = {
			kind: 'restaurant_order',
			state: 'counted',
			lines: burgers(1),
		}
		const before = desiredUsage({
			store: versions,
			locationId: 'main',
			at: 49_999,
			source,
		})
		const after = desiredUsage({
			store: versions,
			locationId: 'main',
			at: 50_000,
			source,
		})
		expect(before.sale[0]!.quantity).toBe(100_000)
		expect(after.sale[0]!.quantity).toBe(150_000)
	})
})

describe('diffing against what is applied', () => {
	const usage = (
		itemId: string,
		quantity: number,
		locationId = 'main',
	): UsageEntry => ({
		itemId,
		locationId,
		quantity,
	})

	test('posts only the difference, as negative stock movements for more use', () => {
		const deltas = diffUsage(
			[usage('beef', 150_000), usage('bun', 1000)],
			[usage('beef', 300_000), usage('cheese', 20_000)],
		)
		expect(deltas).toEqual([
			{
				itemId: 'beef',
				locationId: 'main',
				usageDelta: 150_000,
				movementQuantity: -150_000,
			},
			{
				itemId: 'bun',
				locationId: 'main',
				usageDelta: -1000,
				movementQuantity: 1000,
			},
			{
				itemId: 'cheese',
				locationId: 'main',
				usageDelta: 20_000,
				movementQuantity: -20_000,
			},
		])
	})

	test('a first settle posts everything and a replay posts nothing', () => {
		const want = desired({
			kind: 'restaurant_order',
			state: 'counted',
			lines: burgers(1),
		}).sale
		const first = diffUsage([], want)
		expect(first.map((d) => d.movementQuantity)).toEqual([-150_000, -1000])
		const applied = applyUsageDeltas([], first)
		expect(diffUsage(applied, want)).toEqual([])
	})

	test('a cancel returns everything', () => {
		const applied = [usage('beef', 150_000), usage('bun', 1000)]
		const cancelled = desired({
			kind: 'restaurant_order',
			state: 'cancelled',
			lines: burgers(1),
		})
		const deltas = diffUsage(applied, cancelled.sale)
		expect(deltas.map((d) => d.movementQuantity)).toEqual([150_000, 1000])
		expect(applyUsageDeltas(applied, deltas)).toEqual([])
	})

	test('a move between locations returns at one and uses at the other', () => {
		const deltas = diffUsage(
			[usage('beef', 100, 'a')],
			[usage('beef', 100, 'b')],
		)
		expect(deltas).toEqual([
			{
				itemId: 'beef',
				locationId: 'a',
				usageDelta: -100,
				movementQuantity: 100,
			},
			{
				itemId: 'beef',
				locationId: 'b',
				usageDelta: 100,
				movementQuantity: -100,
			},
		])
	})

	test('rows with the same key are added together', () => {
		expect(diffUsage([usage('x', 5), usage('x', 5)], [usage('x', 10)])).toEqual(
			[],
		)
	})

	test('refuses negative or fractional usage and a result below zero', () => {
		expect(() => diffUsage([usage('x', -1)], [])).toThrow(RangeError)
		expect(() => diffUsage([], [usage('x', 1.5)])).toThrow(RangeError)
		expect(() =>
			applyUsageDeltas(
				[],
				[
					{
						itemId: 'x',
						locationId: 'main',
						usageDelta: -1,
						movementQuantity: 1,
					},
				],
			),
		).toThrow(RangeError)
	})

	test('an edited tab converges over revisions', () => {
		let applied: UsageEntry[] = []
		const posted: number[] = []
		for (const quantity of [1, 3, 3, 2, 0]) {
			const want = desired({
				kind: 'pos_order',
				status: 'paid',
				lines: quantity > 0 ? burgers(quantity) : [],
			}).sale
			const deltas = diffUsage(applied, want)
			posted.push(
				...deltas
					.filter((d) => d.itemId === 'beef')
					.map((d) => d.movementQuantity),
			)
			applied = applyUsageDeltas(applied, deltas)
		}
		// 1 -> 3 -> (replay) -> 2 -> 0: net movement of beef sums to zero.
		expect(posted).toEqual([-150_000, -300_000, 150_000, 300_000])
		expect(posted.reduce((a, b) => a + b, 0)).toBe(0)
		expect(applied).toEqual([])
	})
})

describe('dishes without a recipe', () => {
	const rows = [
		{ itemId: 'special', variantId: null, quantity: 40, netSalesMinor: 800 },
		{ itemId: 'burger', variantId: null, quantity: 99, netSalesMinor: 9900 },
		{ itemId: 'soup', variantId: 'big', quantity: 15, netSalesMinor: 3000 },
		{ itemId: 'soup', variantId: 'small', quantity: 15, netSalesMinor: 1500 },
		{ itemId: 'pie', variantId: null, quantity: 30, netSalesMinor: 1000 },
		{ itemId: 'tart', variantId: null, quantity: 30, netSalesMinor: 2000 },
		{ itemId: 'zero', variantId: null, quantity: 0 },
	]

	test('ranks sold dishes without a recipe by units, then net sales', () => {
		const result = rankDishesWithoutRecipe({ store: menu, rows, at: AT })
		expect(result.dishes).toEqual([
			{ itemId: 'special', quantity: 40, netSalesMinor: 800 },
			{ itemId: 'soup', quantity: 30, netSalesMinor: 4500 },
			{ itemId: 'tart', quantity: 30, netSalesMinor: 2000 },
			{ itemId: 'pie', quantity: 30, netSalesMinor: 1000 },
		])
		expect(result.total).toBe(4)
	})

	test('stops at the limit and still counts all', () => {
		const result = rankDishesWithoutRecipe({
			store: menu,
			rows,
			at: AT,
			limit: 2,
		})
		expect(result.dishes.map((d) => d.itemId)).toEqual(['special', 'soup'])
		expect(result.total).toBe(4)
	})

	test('a typed cost, or a size with its own recipe, covers a dish', () => {
		const s = store([
			recipe('menu_item', 'cola', [], {
				typedCost: { minor: 150, currency: 'SAR' },
			}),
			recipe('variant', 'big', [['x', 1000]]),
		])
		const result = rankDishesWithoutRecipe({
			store: s,
			at: AT,
			rows: [
				{ itemId: 'cola', variantId: null, quantity: 5 },
				{ itemId: 'soup', variantId: 'big', quantity: 5 },
				{ itemId: 'soup', variantId: 'small', quantity: 2 },
			],
		})
		expect(result.dishes).toEqual([
			{ itemId: 'soup', quantity: 2, netSalesMinor: null },
		])
	})
})
