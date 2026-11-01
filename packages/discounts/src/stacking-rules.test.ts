import { describe, expect, it } from 'vitest'
import { evaluateDiscounts, quoteManualDiscount } from './evaluate.ts'
import { makeDiscount, makeInput, makeLine } from './test-fixtures.ts'

const line = (
	lineId: string,
	itemId: string,
	unitMinor: number,
	extra: Partial<Parameters<typeof makeLine>[0]> = {},
) => makeLine({ lineId, itemId, unitMinor, ...extra })

describe('quantity rules on a cart another discount already touched', () => {
	// Burger $10, dessert $1, side $5.
	const lines = () => [
		line('burger', 'burger', 1000),
		line('dessert', 'dessert', 100),
		line('side', 'side', 500),
	]
	const freeDessert = makeDiscount({
		id: 'free-dessert',
		priority: 0,
		combinable: true,
		percentBp: 10_000,
		quantityRule: {
			kind: 'buy_get',
			buy: { quantity: 1, itemIds: ['burger'], categoryIds: [] },
			get: { quantity: 1, itemIds: ['dessert'], categoryIds: [] },
		},
	})
	const threeItems = makeDiscount({
		id: 'three-items',
		priority: 1,
		combinable: true,
		percentBp: 2000,
		quantityRule: { kind: 'minimum', quantity: 3 },
	})

	it('does not count a free item towards "3 or more items", and the guest gets the better one', () => {
		const stacked = evaluateDiscounts(
			makeInput({ lines: lines(), discounts: [freeDessert, threeItems] }),
		)
		const alone = evaluateDiscounts(
			makeInput({ lines: lines(), discounts: [threeItems] }),
		)
		expect(alone.totalDiscountMinor).toBe(320)
		// Stacked, the free dessert leaves two paying items, so "3 or more" no
		// longer applies (100 in all). On its own it gives 320, which wins.
		expect(stacked.applied.map((a) => a.discountId)).toEqual(['three-items'])
		expect(stacked.totalDiscountMinor).toBe(320)
	})

	it('a buy-one-get-one does not count a unit another discount made free', () => {
		// 3 burgers; the first is free from an earlier deal, so buy 1 get 1 has
		// two paying burgers: one group, one free.
		const firstFree = makeDiscount({
			id: 'first-free',
			priority: 0,
			combinable: true,
			percentBp: 10_000,
			maxDiscountedUnits: 1,
			target: {
				scope: 'items',
				itemIds: ['burger'],
				categoryIds: [],
				excludeItemIds: [],
				excludeCategoryIds: [],
			},
		})
		const bogo = makeDiscount({
			id: 'bogo',
			priority: 1,
			combinable: true,
			percentBp: 10_000,
			target: {
				scope: 'items',
				itemIds: ['burger'],
				categoryIds: [],
				excludeItemIds: [],
				excludeCategoryIds: [],
			},
			quantityRule: { kind: 'bogo', buyQuantity: 1, getQuantity: 1 },
		})
		const result = evaluateDiscounts(
			makeInput({
				lines: [line('burger', 'burger', 1000, { quantity: 3 })],
				discounts: [firstFree, bogo],
			}),
		)
		expect(result.applied.map((a) => [a.discountId, a.amountMinor])).toEqual([
			['first-free', 1000],
			['bogo', 1000],
		])
	})
})

describe('minimum spend', () => {
	it('does not count an excluded line towards the minimum', () => {
		const discount = makeDiscount({
			percentBp: 5000,
			minSubtotalMinor: 3000,
			currency: 'USD',
		})
		const result = evaluateDiscounts(
			makeInput({
				lines: [
					line('gift', 'gift', 5000, { excluded: true }),
					line('burger', 'burger', 500),
				],
				discounts: [discount],
			}),
		)
		expect(result.totalDiscountMinor).toBe(0)
	})

	it("does not count the discount's own excluded items either", () => {
		const discount = makeDiscount({
			percentBp: 5000,
			minSubtotalMinor: 3000,
			currency: 'USD',
			target: {
				scope: 'order',
				itemIds: [],
				categoryIds: [],
				excludeItemIds: ['wine'],
				excludeCategoryIds: [],
			},
		})
		const result = evaluateDiscounts(
			makeInput({
				lines: [line('wine', 'wine', 5000), line('burger', 'burger', 500)],
				discounts: [discount],
			}),
		)
		expect(result.totalDiscountMinor).toBe(0)
	})

	it('still unlocks when the qualifying lines reach the minimum', () => {
		const discount = makeDiscount({
			percentBp: 1000,
			minSubtotalMinor: 3000,
			currency: 'USD',
		})
		const result = evaluateDiscounts(
			makeInput({
				lines: [line('a', 'a', 2000), line('b', 'b', 1500)],
				discounts: [discount],
			}),
		)
		expect(result.totalDiscountMinor).toBe(350)
	})

	it('applies the same rule to a manual discount', () => {
		const manual = makeDiscount({
			application: 'manual',
			valueType: 'variable_percent',
			percentBp: null,
			minSubtotalMinor: 3000,
			currency: 'USD',
		})
		const quote = quoteManualDiscount({
			discount: manual,
			lines: [
				line('gift', 'gift', 5000, { excluded: true }),
				line('burger', 'burger', 500),
			],
			percentBp: 1000,
			currency: 'USD',
			context: makeInput({ lines: [] }).context,
		})
		expect(quote).toEqual({ ok: false, reason: 'minimum_not_met' })
	})
})

describe('tiers read the cart, not what is left to pay', () => {
	const ladder = makeDiscount({
		id: 'ladder',
		combinable: true,
		percentBp: null,
		currency: 'USD',
		tiers: {
			basis: 'spend',
			steps: [
				{ at: 4000, percentBp: 500, amountMinor: null },
				{ at: 5000, percentBp: 1000, amountMinor: null },
			],
		},
	})
	const freeBrownie = makeDiscount({
		id: 'free-brownie',
		priority: 0,
		combinable: true,
		percentBp: 10_000,
		target: {
			scope: 'items',
			itemIds: ['brownie'],
			categoryIds: [],
			excludeItemIds: [],
			excludeCategoryIds: [],
		},
	})

	it('counts a fully discounted line towards the spend tier', () => {
		const lines = [
			line('burgers', 'burger', 1500, { quantity: 3 }),
			line('brownie', 'brownie', 600),
		]
		const result = evaluateDiscounts(
			makeInput({ lines, discounts: [freeBrownie, ladder] }),
		)
		// 5100 in the cart reaches the 10% step, taken off what is left of it.
		const tier = result.applied.find((entry) => entry.discountId === 'ladder')
		expect(tier?.amountMinor).toBe(450)
	})

	it('gives the same total whatever order the lines were added in', () => {
		const a = [line('a', 'a', 2200), line('b', 'b', 1600)]
		const same = (order: typeof a) =>
			evaluateDiscounts(
				makeInput({
					lines: order,
					discounts: [
						makeDiscount({
							percentBp: null,
							valueType: 'fixed_price',
							amountMinor: 1000,
							currency: 'USD',
						}),
					],
				}),
			).totalDiscountMinor
		expect(same(a)).toBe(same([...a].reverse()))
	})
})
