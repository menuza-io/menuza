import { describe, expect, it } from 'vitest'
import {
	type DiscountCartOption,
	discountDefinitionSchema,
	evaluateDiscounts,
} from './index.ts'
import { makeDiscount, makeInput, makeLine } from './test-fixtures.ts'

const option = (
	optionId: string,
	totalMinor: number,
	groupId = 'toppings',
	quantity = 1,
): DiscountCartOption => ({ groupId, optionId, quantity, totalMinor })

/** A pizza with its modifiers priced in: unit = base + the choices. */
const pizza = (
	lineId: string,
	options: DiscountCartOption[],
	{ base = 1200, quantity = 1, itemId = 'pizza' } = {},
) =>
	makeLine({
		lineId,
		itemId,
		categoryIds: ['pizzas'],
		quantity,
		baseUnitMinor: base,
		unitMinor: base + options.reduce((sum, row) => sum + row.totalMinor, 0),
		options,
	})

const target = (overrides = {}) => ({
	scope: 'modifiers' as const,
	itemIds: [],
	categoryIds: [],
	excludeItemIds: [],
	excludeCategoryIds: [],
	modifierGroupIds: ['toppings'],
	modifierOptionIds: [],
	...overrides,
})

const toppingsFree = (overrides = {}) =>
	makeDiscount({
		percentBp: 10_000,
		target: target(),
		quantityRule: { kind: 'per_item', quantity: 2 },
		...overrides,
	})

const evaluate = (
	lines: ReturnType<typeof makeLine>[],
	discount: ReturnType<typeof makeDiscount>,
) => evaluateDiscounts(makeInput({ lines, discounts: [discount] }))

const THREE_TOPPINGS = [
	option('pepperoni', 150),
	option('mushroom', 100),
	option('olives', 80),
]

describe('modifier discounts', () => {
	it('2 toppings free: the two dearest on the pizza', () => {
		const result = evaluate([pizza('p', THREE_TOPPINGS)], toppingsFree())
		expect(result.totalDiscountMinor).toBe(250)
		expect(result.lineDiscounts).toEqual({ p: 250 })
	})

	it('counts per pizza, not per order', () => {
		const result = evaluate(
			[pizza('p', THREE_TOPPINGS, { quantity: 2 })],
			toppingsFree(),
		)
		expect(result.totalDiscountMinor).toBe(500)
	})

	it('two pizza lines each get their own two', () => {
		const result = evaluate(
			[pizza('a', THREE_TOPPINGS), pizza('b', THREE_TOPPINGS)],
			toppingsFree(),
		)
		expect(result.lineDiscounts).toEqual({ a: 250, b: 250 })
	})

	it('a pizza with fewer choices than the allowance gets them all free', () => {
		const result = evaluate(
			[pizza('p', [option('pepperoni', 150)])],
			toppingsFree(),
		)
		expect(result.totalDiscountMinor).toBe(150)
	})

	it('without a per-item rule every matching choice is discounted', () => {
		const result = evaluate(
			[pizza('p', THREE_TOPPINGS)],
			toppingsFree({ quantityRule: { kind: 'none' }, percentBp: 5000 }),
		)
		// Half of 330.
		expect(result.totalDiscountMinor).toBe(165)
	})

	it('leaves the item itself and other groups at full price', () => {
		const result = evaluate(
			[pizza('p', [...THREE_TOPPINGS, option('ranch', 75, 'sauces')])],
			toppingsFree({ quantityRule: { kind: 'none' } }),
		)
		expect(result.totalDiscountMinor).toBe(330)
	})

	it('targets single options whichever group they are in', () => {
		const result = evaluate(
			[pizza('p', [option('pepperoni', 150), option('ranch', 75, 'sauces')])],
			toppingsFree({
				quantityRule: { kind: 'none' },
				target: target({
					modifierGroupIds: [],
					modifierOptionIds: ['pepperoni', 'ranch'],
				}),
			}),
		)
		expect(result.totalDiscountMinor).toBe(225)
	})

	it('only the chosen items count when an item filter is set', () => {
		const burger = makeLine({
			lineId: 'b',
			itemId: 'burger',
			categoryIds: ['burgers'],
			baseUnitMinor: 1000,
			unitMinor: 1100,
			options: [option('bacon', 100)],
		})
		const discount = toppingsFree({
			target: target({ categoryIds: ['pizzas'] }),
		})
		expect(
			evaluate([burger, pizza('p', [option('pepperoni', 150)])], discount)
				.lineDiscounts,
		).toEqual({ p: 150 })
	})

	it('takes an amount off each choice, never below zero', () => {
		const result = evaluate(
			[pizza('p', THREE_TOPPINGS)],
			toppingsFree({
				valueType: 'fixed',
				percentBp: null,
				amountMinor: 90,
				currency: 'USD',
				quantityRule: { kind: 'none' },
			}),
		)
		// 90 + 90 + 80.
		expect(result.totalDiscountMinor).toBe(260)
	})

	it('sets what each choice costs', () => {
		const result = evaluate(
			[pizza('p', THREE_TOPPINGS)],
			toppingsFree({
				valueType: 'fixed_price',
				percentBp: null,
				amountMinor: 100,
				currency: 'USD',
				quantityRule: { kind: 'none' },
			}),
		)
		// 150 becomes 100; the 100 and the 80 are already at or under it.
		expect(result.totalDiscountMinor).toBe(50)
	})

	it('caps the choices discounted across the order, dearest first', () => {
		const result = evaluate(
			[pizza('a', THREE_TOPPINGS), pizza('b', THREE_TOPPINGS)],
			toppingsFree({
				quantityRule: { kind: 'none' },
				maxDiscountedUnits: 2,
			}),
		)
		// The two 150s.
		expect(result.totalDiscountMinor).toBe(300)
	})

	it('splits a quantity choice into its pieces', () => {
		// Extra cheese x3 for 300, 1 free per pizza: 100 off, not 300.
		const result = evaluate(
			[pizza('p', [option('cheese', 300, 'extras', 3)])],
			toppingsFree({
				target: target({ modifierGroupIds: ['extras'] }),
				quantityRule: { kind: 'per_item', quantity: 1 },
			}),
		)
		expect(result.totalDiscountMinor).toBe(100)
	})

	it('does nothing for a line with no modifier detail or no match', () => {
		expect(
			evaluate([makeLine({ unitMinor: 1500 })], toppingsFree())
				.totalDiscountMinor,
		).toBe(0)
		expect(
			evaluate([pizza('p', [option('ranch', 75, 'sauces')])], toppingsFree())
				.totalDiscountMinor,
		).toBe(0)
	})

	it('skips lines excluded from discounts', () => {
		const line = { ...pizza('p', THREE_TOPPINGS), excluded: true }
		expect(evaluate([line], toppingsFree()).totalDiscountMinor).toBe(0)
	})

	it('stacks on what an earlier discount left without going below zero', () => {
		const result = evaluateDiscounts(
			makeInput({
				lines: [pizza('p', THREE_TOPPINGS)],
				discounts: [
					makeDiscount({
						id: 'half',
						percentBp: 5000,
						combinable: true,
						priority: 0,
					}),
					{ ...toppingsFree(), id: 'free', combinable: true, priority: 1 },
				],
			}),
		)
		const line = 1200 + 330
		expect(result.lineDiscounts.p).toBeLessThanOrEqual(line)
		// Half off the line first (765), then the toppings' remaining half free.
		expect(result.lineDiscounts.p).toBe(765 + 125)
	})
})

describe('a set price covers the item, not its paid modifiers', () => {
	const largeForTen = makeDiscount({
		valueType: 'fixed_price',
		percentBp: null,
		amountMinor: 1000,
		currency: 'USD',
		target: {
			scope: 'items',
			itemIds: ['pizza'],
			categoryIds: [],
			excludeItemIds: [],
			excludeCategoryIds: [],
		},
	})

	it('discounts the base price only', () => {
		const line = pizza('p', [option('pepperoni', 150)], { base: 1400 })
		// 14.00 base becomes 10.00; the 1.50 topping is still charged.
		expect(evaluate([line], largeForTen).totalDiscountMinor).toBe(400)
	})

	it('a base already under the price gets nothing, whatever the toppings', () => {
		const line = pizza('p', [option('pepperoni', 500)], { base: 900 })
		expect(evaluate([line], largeForTen).totalDiscountMinor).toBe(0)
	})

	it('a bundle price covers the base prices', () => {
		const deal = makeDiscount({
			valueType: 'fixed_price',
			percentBp: null,
			amountMinor: 1500,
			currency: 'USD',
			quantityRule: {
				kind: 'bundle',
				slots: [
					{ quantity: 1, itemIds: ['pizza'], categoryIds: [] },
					{ quantity: 1, itemIds: ['cola'], categoryIds: [] },
				],
			},
		})
		const cola = makeLine({
			lineId: 'c',
			itemId: 'cola',
			baseUnitMinor: 400,
			unitMinor: 400,
		})
		// Bases 12.00 + 4.00 = 16.00 become 15.00. The 3.30 of toppings stays.
		const result = evaluate([pizza('p', THREE_TOPPINGS), cola], deal)
		expect(result.totalDiscountMinor).toBe(100)
	})

	it('without modifier detail the whole unit is the basis', () => {
		const line = makeLine({ lineId: 'p', itemId: 'pizza', unitMinor: 1400 })
		expect(evaluate([line], largeForTen).totalDiscountMinor).toBe(400)
	})
})

describe('modifier discount validation', () => {
	const parse = (overrides: Record<string, unknown>) => {
		const {
			id: ignoredId,
			version: ignoredVersion,
			createdAt: ignoredCreatedAt,
			...definition
		} = makeDiscount(overrides)
		return discountDefinitionSchema.safeParse(definition).success
	}
	const free = { percentBp: 10_000 }

	it('accepts a per-item modifier discount', () => {
		expect(
			parse({
				...free,
				target: target(),
				quantityRule: { kind: 'per_item', quantity: 2 },
			}),
		).toBe(true)
	})

	it('needs a group or an option', () => {
		expect(
			parse({
				...free,
				target: target({ modifierGroupIds: [], modifierOptionIds: [] }),
			}),
		).toBe(false)
	})

	it('allows only none or per-item rules on modifiers', () => {
		for (const quantityRule of [
			{ kind: 'exact', quantity: 2 },
			{ kind: 'minimum', quantity: 2 },
			{ kind: 'bogo', buyQuantity: 1, getQuantity: 1 },
		]) {
			expect(parse({ ...free, target: target(), quantityRule })).toBe(false)
		}
	})

	it('per-item and modifier ids need a modifier target', () => {
		expect(
			parse({ ...free, quantityRule: { kind: 'per_item', quantity: 2 } }),
		).toBe(false)
		expect(
			parse({
				...free,
				target: {
					scope: 'items',
					itemIds: ['a'],
					categoryIds: [],
					excludeItemIds: [],
					excludeCategoryIds: [],
					modifierGroupIds: ['toppings'],
				},
			}),
		).toBe(false)
	})

	it('allows a set price per choice and an item filter', () => {
		expect(
			parse({
				valueType: 'fixed_price',
				percentBp: null,
				amountMinor: 100,
				currency: 'USD',
				target: target({ itemIds: ['pizza'] }),
				quantityRule: { kind: 'per_item', quantity: 1 },
			}),
		).toBe(true)
	})

	it('still reads a stored target that has no modifier lists', () => {
		expect(
			parse({
				target: {
					scope: 'items',
					itemIds: ['a'],
					categoryIds: [],
					excludeItemIds: [],
					excludeCategoryIds: [],
				},
			}),
		).toBe(true)
	})
})

describe('a set price and a modifier discount on the same pizza', () => {
	// The storefront scenario: a large pizza for a set price, and two toppings
	// free. The set price comes off the base only, so it must not shrink what
	// the toppings are worth, in either order.
	const setPrice = (priority: number) =>
		makeDiscount({
			id: 'price',
			priority,
			combinesWith: ['item'],
			valueType: 'fixed_price',
			percentBp: null,
			amountMinor: 1500,
			currency: 'USD',
			target: {
				scope: 'items',
				itemIds: ['pizza'],
				categoryIds: [],
				excludeItemIds: [],
				excludeCategoryIds: [],
			},
		})
	const twoFree = (priority: number) =>
		toppingsFree({ id: 'free', priority, combinesWith: ['item'] })
	const toppings = [
		option('pepperoni', 250),
		option('mushroom', 200),
		option('olives', 200),
	]
	const stack = (discounts: ReturnType<typeof makeDiscount>[]) =>
		evaluateDiscounts(
			makeInput({
				lines: [pizza('p', toppings, { base: 2000 })],
				discounts,
			}),
		)

	it('set price first: the two dearest toppings are still free in full', () => {
		const result = stack([setPrice(0), twoFree(1)])
		// 5.00 off the base, then 2.50 + 2.00 off the toppings.
		expect(result.applied.map((entry) => entry.discountId)).toEqual([
			'price',
			'free',
		])
		expect(result.totalDiscountMinor).toBe(500 + 450)
	})

	it('toppings first: the set price still replaces the whole base', () => {
		const result = stack([twoFree(0), setPrice(1)])
		expect(result.totalDiscountMinor).toBe(450 + 500)
	})

	it('after a general discount the base is worth its share, not all of it', () => {
		// Half off the whole pizza first: the base is now worth 10.00, already
		// under the 15.00 set price, so the set price adds nothing.
		const half = makeDiscount({
			id: 'half',
			priority: 0,
			combinesWith: ['item'],
			percentBp: 5000,
			target: {
				scope: 'items',
				itemIds: ['pizza'],
				categoryIds: [],
				excludeItemIds: [],
				excludeCategoryIds: [],
			},
		})
		const result = stack([half, setPrice(1)])
		expect(result.applied.map((entry) => entry.discountId)).toEqual(['half'])
		expect(result.totalDiscountMinor).toBe(Math.floor((2000 + 650) / 2))
	})

	it('never takes more than the pizza costs', () => {
		const result = stack([setPrice(0), twoFree(1)])
		expect(result.lineDiscounts.p).toBeLessThanOrEqual(2000 + 650)
	})
})
