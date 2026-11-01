import { describe, expect, it } from 'vitest'
import { discountDefinitionSchema } from './definition.ts'
import { evaluateDiscounts } from './evaluate.ts'
import { makeDiscount, makeInput, makeLine } from './test-fixtures.ts'

const items = (...itemIds: string[]) => ({
	itemIds,
	categoryIds: [] as string[],
})
const categories = (...categoryIds: string[]) => ({
	itemIds: [] as string[],
	categoryIds,
})

const line = (
	lineId: string,
	itemId: string,
	unitMinor: number,
	quantity = 1,
	categoryIds: string[] = [],
) => makeLine({ lineId, itemId, unitMinor, quantity, categoryIds })

/** Buy `buy`, get `get` free. */
const buyGet = (
	buy: ReturnType<typeof items>,
	get: ReturnType<typeof items>,
	overrides = {},
	quantities: { buy?: number; get?: number } = {},
) =>
	makeDiscount({
		percentBp: 10_000,
		quantityRule: {
			kind: 'buy_get',
			buy: { quantity: quantities.buy ?? 1, ...buy },
			get: { quantity: quantities.get ?? 1, ...get },
		},
		...overrides,
	})

const evaluate = (
	lines: ReturnType<typeof line>[],
	discount: ReturnType<typeof makeDiscount>,
) => evaluateDiscounts(makeInput({ lines, discounts: [discount] }))

describe('buy_get: buy from one group, get from another', () => {
	it('gives free fries with a burger', () => {
		const result = evaluate(
			[line('b', 'burger', 1000), line('f', 'fries', 400)],
			buyGet(items('burger'), items('fries')),
		)
		expect(result.totalDiscountMinor).toBe(400)
		expect(result.lineDiscounts).toEqual({ f: 400 })
	})

	it('uses the burger up: two burgers earn two fries, not one', () => {
		const oneBurger = evaluate(
			[line('b', 'burger', 1000), line('f', 'fries', 400, 2)],
			buyGet(items('burger'), items('fries')),
		)
		expect(oneBurger.totalDiscountMinor).toBe(400)
		const twoBurgers = evaluate(
			[line('b', 'burger', 1000, 2), line('f', 'fries', 400, 2)],
			buyGet(items('burger'), items('fries')),
		)
		expect(twoBurgers.totalDiscountMinor).toBe(800)
	})

	it('discounts the cheapest of the get units', () => {
		const result = evaluate(
			[
				line('b', 'burger', 1000, 2),
				line('small', 'fries', 300),
				line('large', 'fries', 500, 2),
			],
			buyGet(items('burger'), items('fries')),
		)
		// Two pairs: the 300 and one 500 are free.
		expect(result.totalDiscountMinor).toBe(800)
		expect(result.lineDiscounts).toEqual({ small: 300, large: 500 })
	})

	it('gives nothing without the bought item', () => {
		const result = evaluate(
			[line('f', 'fries', 400)],
			buyGet(items('burger'), items('fries')),
		)
		expect(result.totalDiscountMinor).toBe(0)
	})

	it('gives nothing without the get item', () => {
		const result = evaluate(
			[line('b', 'burger', 1000)],
			buyGet(items('burger'), items('fries')),
		)
		expect(result.totalDiscountMinor).toBe(0)
	})

	it('buy 2 get 1: pairs need the full buy quantity', () => {
		const rule = buyGet(items('burger'), items('fries'), {}, { buy: 2 })
		expect(
			evaluate([line('b', 'burger', 1000), line('f', 'fries', 400)], rule)
				.totalDiscountMinor,
		).toBe(0)
		expect(
			evaluate([line('b', 'burger', 1000, 3), line('f', 'fries', 400, 2)], rule)
				.totalDiscountMinor,
		).toBe(400)
	})

	it('works from categories on either side', () => {
		const result = evaluate(
			[
				line('b', 'classic', 1000, 1, ['burgers']),
				line('d', 'cola', 300, 1, ['drinks']),
			],
			buyGet(categories('burgers'), categories('drinks')),
		)
		expect(result.totalDiscountMinor).toBe(300)
	})

	it('a unit in both groups serves one side only', () => {
		// Buy a pizza, get a pizza: three pizzas make one pair, and the
		// cheapest is free.
		const pizzas = categories('pizza')
		const result = evaluate(
			[
				line('a', 'p1', 1500, 1, ['pizza']),
				line('b', 'p2', 1200, 1, ['pizza']),
				line('c', 'p3', 1000, 1, ['pizza']),
			],
			buyGet(pizzas, pizzas),
		)
		expect(result.lineDiscounts).toEqual({ c: 1000 })
	})

	it('a lone pizza in both groups earns nothing', () => {
		const pizzas = categories('pizza')
		const result = evaluate(
			[line('a', 'p1', 1500, 1, ['pizza'])],
			buyGet(pizzas, pizzas),
		)
		expect(result.totalDiscountMinor).toBe(0)
	})

	it('caps the discounted units per order', () => {
		const result = evaluate(
			[line('b', 'burger', 1000, 4), line('f', 'fries', 400, 4)],
			buyGet(items('burger'), items('fries'), { maxDiscountedUnits: 2 }),
		)
		expect(result.totalDiscountMinor).toBe(800)
	})

	it('takes a percentage off the get units', () => {
		const result = evaluate(
			[line('b', 'burger', 1000), line('f', 'fries', 400)],
			buyGet(items('burger'), items('fries'), { percentBp: 5000 }),
		)
		expect(result.totalDiscountMinor).toBe(200)
	})

	it('takes an amount off each get unit, never below zero', () => {
		const result = evaluate(
			[line('b', 'burger', 1000, 2), line('f', 'fries', 150, 2)],
			buyGet(items('burger'), items('fries'), {
				valueType: 'fixed',
				percentBp: null,
				amountMinor: 200,
				currency: 'USD',
			}),
		)
		expect(result.totalDiscountMinor).toBe(300)
	})

	it('sets the price of the get units', () => {
		const result = evaluate(
			[line('b', 'burger', 1000), line('f', 'fries', 400)],
			buyGet(items('burger'), items('fries'), {
				valueType: 'fixed_price',
				percentBp: null,
				amountMinor: 100,
				currency: 'USD',
			}),
		)
		expect(result.totalDiscountMinor).toBe(300)
	})

	it('respects excluded lines on the get side', () => {
		const result = evaluate(
			[
				line('b', 'burger', 1000),
				makeLine({
					lineId: 'f',
					itemId: 'fries',
					unitMinor: 400,
					excluded: true,
				}),
			],
			buyGet(items('burger'), items('fries')),
		)
		expect(result.totalDiscountMinor).toBe(0)
	})
})

const bundle = (
	slots: { quantity: number; itemIds: string[]; categoryIds: string[] }[],
	overrides = {},
) =>
	makeDiscount({
		valueType: 'fixed_price',
		percentBp: null,
		amountMinor: 2000,
		currency: 'USD',
		quantityRule: { kind: 'bundle', slots },
		...overrides,
	})

const anyTwoPizzas = bundle([{ quantity: 2, ...categories('pizza') }])

describe('bundle: a set price for a group of items', () => {
	it('any 2 pizzas for the set price', () => {
		const result = evaluate(
			[
				line('a', 'p1', 1500, 1, ['pizza']),
				line('b', 'p2', 1200, 1, ['pizza']),
			],
			anyTwoPizzas,
		)
		// 27.00 becomes 20.00.
		expect(result.totalDiscountMinor).toBe(700)
	})

	it('with three pizzas the two dearest make the deal', () => {
		const result = evaluate(
			[
				line('a', 'p1', 1500, 1, ['pizza']),
				line('b', 'p2', 1200, 1, ['pizza']),
				line('c', 'p3', 1000, 1, ['pizza']),
			],
			anyTwoPizzas,
		)
		expect(result.totalDiscountMinor).toBe(700)
		expect(result.lineDiscounts.c).toBeUndefined()
	})

	it('repeats for every full bundle', () => {
		const result = evaluate([line('a', 'p1', 1500, 4, ['pizza'])], anyTwoPizzas)
		expect(result.totalDiscountMinor).toBe(2 * (3000 - 2000))
	})

	it('one pizza is not a bundle', () => {
		const result = evaluate([line('a', 'p1', 1500, 1, ['pizza'])], anyTwoPizzas)
		expect(result.totalDiscountMinor).toBe(0)
	})

	it('gives nothing when the set price is above what the items cost', () => {
		const result = evaluate([line('a', 'p1', 900, 2, ['pizza'])], anyTwoPizzas)
		expect(result.totalDiscountMinor).toBe(0)
	})

	it('prices each bundle on its own, never topping a cheap one up', () => {
		// Four pizzas: 25 + 25 and 5 + 5. The second bundle costs 10, below the
		// set price of 20, so only the first is discounted.
		const result = evaluate(
			[
				line('hi', 'big', 2500, 2, ['pizza']),
				line('lo', 'small', 500, 2, ['pizza']),
			],
			anyTwoPizzas,
		)
		expect(result.totalDiscountMinor).toBe(5000 - 2000)
	})

	it('a meal deal needs every slot', () => {
		const meal = bundle(
			[
				{ quantity: 1, ...categories('pizza') },
				{ quantity: 1, ...categories('sides') },
				{ quantity: 1, ...categories('drinks') },
			],
			{ amountMinor: 1500 },
		)
		const pizza = line('p', 'margherita', 1200, 1, ['pizza'])
		const side = line('s', 'wings', 500, 1, ['sides'])
		const drink = line('d', 'cola', 300, 1, ['drinks'])
		expect(evaluate([pizza, side], meal).totalDiscountMinor).toBe(0)
		// 12.00 + 5.00 + 3.00 = 20.00 becomes 15.00.
		expect(evaluate([pizza, side, drink], meal).totalDiscountMinor).toBe(500)
	})

	it('two meal deals when the cart holds two of each', () => {
		const meal = bundle(
			[
				{ quantity: 1, ...categories('pizza') },
				{ quantity: 1, ...categories('drinks') },
			],
			{ amountMinor: 1200 },
		)
		const result = evaluate(
			[
				line('p', 'margherita', 1200, 2, ['pizza']),
				line('d', 'cola', 300, 2, ['drinks']),
			],
			meal,
		)
		expect(result.totalDiscountMinor).toBe(2 * 300)
	})

	it('leaves the rest of the cart at full price', () => {
		const result = evaluate(
			[
				line('a', 'p1', 1500, 2, ['pizza']),
				line('x', 'salad', 800, 1, ['sides']),
			],
			anyTwoPizzas,
		)
		expect(result.lineDiscounts).toEqual({ a: 1000 })
	})

	it('takes a percentage off the bundle', () => {
		const combo = bundle(
			[
				{ quantity: 1, ...categories('pizza') },
				{ quantity: 1, ...categories('drinks') },
			],
			{
				valueType: 'percent',
				percentBp: 2000,
				amountMinor: null,
				currency: null,
			},
		)
		const result = evaluate(
			[
				line('p', 'margherita', 1200, 1, ['pizza']),
				line('d', 'cola', 300, 1, ['drinks']),
			],
			combo,
		)
		expect(result.totalDiscountMinor).toBe(300)
	})

	it('takes an amount off each bundle', () => {
		const combo = bundle([{ quantity: 2, ...categories('pizza') }], {
			valueType: 'fixed',
			percentBp: null,
			amountMinor: 400,
			currency: 'USD',
		})
		const result = evaluate([line('a', 'p1', 1500, 4, ['pizza'])], combo)
		expect(result.totalDiscountMinor).toBe(800)
	})

	it('caps how many items are covered per order', () => {
		const result = evaluate(
			[line('a', 'p1', 1500, 6, ['pizza'])],
			bundle([{ quantity: 2, ...categories('pizza') }], {
				maxDiscountedUnits: 4,
			}),
		)
		expect(result.totalDiscountMinor).toBe(2 * 1000)
	})

	it('splits the discount over lines without going below zero', () => {
		const result = evaluate(
			[
				line('a', 'p1', 1100, 1, ['pizza']),
				line('b', 'p2', 1900, 1, ['pizza']),
			],
			bundle([{ quantity: 2, ...categories('pizza') }], { amountMinor: 100 }),
		)
		const lines = Object.values(result.lineDiscounts)
		expect(lines.reduce((sum, amount) => sum + amount, 0)).toBe(2900)
		expect(result.lineDiscounts.a).toBeLessThanOrEqual(1100)
		expect(result.lineDiscounts.b).toBeLessThanOrEqual(1900)
	})

	it('fills a scarce slot before an overlapping one', () => {
		// Slot one takes any pizza or the special; slot two takes only the
		// special. With one special and one plain pizza, both slots can fill.
		const deal = bundle(
			[
				{ quantity: 1, itemIds: ['special'], categoryIds: ['pizza'] },
				{ quantity: 1, ...items('special') },
			],
			{ amountMinor: 1000 },
		)
		const result = evaluate(
			[
				line('s', 'special', 2000, 1, ['pizza']),
				line('p', 'plain', 1200, 1, ['pizza']),
			],
			deal,
		)
		expect(result.totalDiscountMinor).toBe(3200 - 1000)
	})
})

describe('fixed_price on items, with no quantity rule', () => {
	const largeForTen = (overrides = {}) =>
		makeDiscount({
			valueType: 'fixed_price',
			percentBp: null,
			amountMinor: 1000,
			currency: 'USD',
			target: {
				scope: 'items',
				itemIds: ['large-pizza'],
				categoryIds: [],
				excludeItemIds: [],
				excludeCategoryIds: [],
			},
			...overrides,
		})

	it('prices every matching unit', () => {
		const result = evaluate([line('a', 'large-pizza', 1400, 2)], largeForTen())
		expect(result.totalDiscountMinor).toBe(800)
	})

	it('leaves an item that already costs less', () => {
		const result = evaluate([line('a', 'large-pizza', 800, 2)], largeForTen())
		expect(result.totalDiscountMinor).toBe(0)
	})

	it('is skipped in another currency', () => {
		const result = evaluateDiscounts(
			makeInput({
				currency: 'SAR',
				lines: [line('a', 'large-pizza', 1400)],
				discounts: [largeForTen()],
			}),
		)
		expect(result.totalDiscountMinor).toBe(0)
	})
})

describe('set rules combine and cap like any other discount', () => {
	it('the better of two non-combinable deals wins', () => {
		const result = evaluateDiscounts(
			makeInput({
				lines: [line('a', 'p1', 1500, 2, ['pizza'])],
				discounts: [
					makeDiscount({ id: 'tenOff', percentBp: 1000 }),
					{ ...anyTwoPizzas, id: 'deal' },
				],
			}),
		)
		// The deal saves 10.00, the 10% saves 3.00.
		expect(result.applied.map((entry) => entry.discountId)).toEqual(['deal'])
		expect(result.totalDiscountMinor).toBe(1000)
	})

	it('applies by code', () => {
		const deal = { ...anyTwoPizzas, id: 'c1', application: 'code' as const }
		const result = evaluateDiscounts(
			makeInput({
				lines: [line('a', 'p1', 1500, 2, ['pizza'])],
				discounts: [deal],
				codes: [
					{
						id: 'code1',
						discountId: 'c1',
						normalizedCode: 'PIZZA2',
						maxUses: null,
					},
				],
				code: 'pizza-2',
			}),
		)
		expect(result.code).toEqual({ status: 'applied', discountId: 'c1' })
		expect(result.totalDiscountMinor).toBe(1000)
	})

	it('a combinable deal stacks on the value the first left', () => {
		const result = evaluateDiscounts(
			makeInput({
				lines: [line('a', 'p1', 1500, 2, ['pizza'])],
				discounts: [
					{ ...anyTwoPizzas, id: 'deal', combinable: true, priority: 0 },
					makeDiscount({
						id: 'tenOff',
						percentBp: 1000,
						combinable: true,
						priority: 1,
					}),
				],
			}),
		)
		// 30.00 - 10.00 = 20.00, then 10% of the 20.00 left.
		expect(result.totalDiscountMinor).toBe(1000 + 2000 * 0.1)
	})
})

describe('set rule validation', () => {
	const parse = (overrides: Record<string, unknown>) => {
		const {
			id: ignoredId,
			version: ignoredVersion,
			createdAt: ignoredCreatedAt,
			...definition
		} = makeDiscount(overrides)
		return discountDefinitionSchema.safeParse(definition).success
	}
	const slot = { quantity: 2, ...categories('pizza') }
	const priced = {
		valueType: 'fixed_price',
		percentBp: null,
		amountMinor: 2000,
		currency: 'USD',
	}

	it('accepts a bundle and a buy_get', () => {
		expect(
			parse({ ...priced, quantityRule: { kind: 'bundle', slots: [slot] } }),
		).toBe(true)
		expect(
			parse({
				percentBp: 10_000,
				quantityRule: {
					kind: 'buy_get',
					buy: { quantity: 1, ...items('burger') },
					get: { quantity: 1, ...items('fries') },
				},
			}),
		).toBe(true)
	})

	it('needs a price and a currency for a set price', () => {
		const rule = { kind: 'bundle', slots: [slot] }
		expect(parse({ ...priced, amountMinor: null, quantityRule: rule })).toBe(
			false,
		)
		expect(parse({ ...priced, currency: null, quantityRule: rule })).toBe(false)
	})

	it('rejects a set price with a percentage', () => {
		expect(
			parse({
				...priced,
				percentBp: 1000,
				quantityRule: { kind: 'bundle', slots: [slot] },
			}),
		).toBe(false)
	})

	it('rejects a slot with nothing chosen and a bundle with no slots', () => {
		expect(
			parse({
				...priced,
				quantityRule: {
					kind: 'bundle',
					slots: [{ quantity: 1, itemIds: [], categoryIds: [] }],
				},
			}),
		).toBe(false)
		expect(
			parse({ ...priced, quantityRule: { kind: 'bundle', slots: [] } }),
		).toBe(false)
	})

	it('rejects an oversized bundle', () => {
		expect(
			parse({
				...priced,
				quantityRule: {
					kind: 'bundle',
					slots: [
						{ quantity: 11, ...categories('a') },
						{ quantity: 10, ...categories('b') },
					],
				},
			}),
		).toBe(false)
	})

	it('a rule that names its items needs an order-wide target', () => {
		expect(
			parse({
				...priced,
				target: {
					scope: 'categories',
					itemIds: [],
					categoryIds: ['pizza'],
					excludeItemIds: [],
					excludeCategoryIds: [],
				},
				quantityRule: { kind: 'bundle', slots: [slot] },
			}),
		).toBe(false)
	})

	it('a set price alone needs items or categories', () => {
		expect(parse({ ...priced })).toBe(false)
		expect(
			parse({
				...priced,
				target: {
					scope: 'items',
					itemIds: ['large-pizza'],
					categoryIds: [],
					excludeItemIds: [],
					excludeCategoryIds: [],
				},
			}),
		).toBe(true)
	})

	it('a set price does not combine with a counted rule', () => {
		expect(
			parse({
				...priced,
				target: {
					scope: 'items',
					itemIds: ['large-pizza'],
					categoryIds: [],
					excludeItemIds: [],
					excludeCategoryIds: [],
				},
				quantityRule: { kind: 'exact', quantity: 2 },
			}),
		).toBe(false)
	})

	it('set prices and meal deals are not entered at the till', () => {
		expect(
			parse({
				...priced,
				application: 'manual',
				quantityRule: { kind: 'bundle', slots: [slot] },
			}),
		).toBe(false)
	})
})
