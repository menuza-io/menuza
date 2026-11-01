import { describe, expect, it } from 'vitest'
import { evaluateDiscounts } from './evaluate.ts'
import { makeDiscount, makeInput, makeLine } from './test-fixtures.ts'

const line = (
	lineId: string,
	itemId: string,
	unitMinor: number,
	quantity = 1,
) => makeLine({ lineId, itemId, unitMinor, quantity })

const group = (...itemIds: string[]) => ({
	itemIds,
	categoryIds: [] as string[],
})

function bogo(
	buy: { items: string[]; quantity: number },
	get: { items: string[]; quantity: number },
	overrides: Parameters<typeof makeDiscount>[0] = {},
) {
	return makeDiscount({
		percentBp: 10_000,
		quantityRule: {
			kind: 'buy_get',
			buy: { quantity: buy.quantity, ...group(...buy.items) },
			get: { quantity: get.quantity, ...group(...get.items) },
		},
		...overrides,
	})
}

const run = (
	lines: ReturnType<typeof line>[],
	discount: ReturnType<typeof makeDiscount>,
) => evaluateDiscounts(makeInput({ lines, discounts: [discount] }))

describe('buy_get edge cases', () => {
	it('same item on both sides: 2 pizzas pay for 1, 3 pizzas still only 1 free', () => {
		const rule = bogo(
			{ items: ['pizza'], quantity: 1 },
			{ items: ['pizza'], quantity: 1 },
		)
		expect(run([line('p', 'pizza', 1000, 1)], rule).totalDiscountMinor).toBe(0)
		expect(run([line('p', 'pizza', 1000, 2)], rule).totalDiscountMinor).toBe(
			1000,
		)
		expect(run([line('p', 'pizza', 1000, 3)], rule).totalDiscountMinor).toBe(
			1000,
		)
		expect(run([line('p', 'pizza', 1000, 4)], rule).totalDiscountMinor).toBe(
			2000,
		)
	})

	it('same item, mixed prices: the cheaper unit is the free one', () => {
		const rule = bogo(
			{ items: ['pizza', 'pasta'], quantity: 1 },
			{ items: ['pizza', 'pasta'], quantity: 1 },
		)
		const result = run(
			[line('big', 'pizza', 1800), line('small', 'pasta', 900)],
			rule,
		)
		expect(result.totalDiscountMinor).toBe(900)
		expect(result.lineDiscounts).toEqual({ small: 900 })
	})

	it('never discounts more units than maxDiscountedUnits', () => {
		const rule = bogo(
			{ items: ['burger'], quantity: 1 },
			{ items: ['fries'], quantity: 1 },
			{ maxDiscountedUnits: 1 },
		)
		const result = run(
			[line('b', 'burger', 1000, 5), line('f', 'fries', 400, 5)],
			rule,
		)
		expect(result.totalDiscountMinor).toBe(400)
	})

	it('a cap below the get quantity gives nothing rather than a partial set', () => {
		const rule = bogo(
			{ items: ['burger'], quantity: 1 },
			{ items: ['fries'], quantity: 2 },
			{ maxDiscountedUnits: 1 },
		)
		const result = run(
			[line('b', 'burger', 1000, 2), line('f', 'fries', 400, 4)],
			rule,
		)
		expect(result.totalDiscountMinor).toBe(0)
	})

	it('a cap that is not a multiple of the get quantity rounds down to whole sets', () => {
		const rule = bogo(
			{ items: ['burger'], quantity: 1 },
			{ items: ['fries'], quantity: 2 },
			{ maxDiscountedUnits: 3 },
		)
		const result = run(
			[line('b', 'burger', 1000, 4), line('f', 'fries', 400, 8)],
			rule,
		)
		// One whole set of two, not three units.
		expect(result.totalDiscountMinor).toBe(800)
	})

	it('a partial discount is split over the units without losing a cent', () => {
		const rule = bogo(
			{ items: ['burger'], quantity: 1 },
			{ items: ['fries'], quantity: 1 },
			{ percentBp: 3333 },
		)
		const result = run(
			[line('b', 'burger', 1000), line('f', 'fries', 401, 3)],
			rule,
		)
		const perLine = Object.values(result.lineDiscounts).reduce(
			(sum, value) => sum + value,
			0,
		)
		expect(perLine).toBe(result.totalDiscountMinor)
		// The engine rounds a percentage down (133.65 -> 133).
		expect(result.totalDiscountMinor).toBe(Math.floor((401 * 3333) / 10_000))
	})

	it('a free unit never costs below zero with a fixed amount larger than the item', () => {
		const rule = bogo(
			{ items: ['burger'], quantity: 1 },
			{ items: ['fries'], quantity: 1 },
			{
				valueType: 'fixed',
				percentBp: null,
				amountMinor: 5000,
				currency: 'USD',
			},
		)
		const result = run(
			[line('b', 'burger', 1000), line('f', 'fries', 400)],
			rule,
		)
		expect(result.totalDiscountMinor).toBe(400)
	})
})
