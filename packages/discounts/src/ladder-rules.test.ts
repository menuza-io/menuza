import { describe, expect, it } from 'vitest'
import {
	combinesWithOf,
	discountClassOf,
	discountDefinitionSchema,
	evaluateDiscounts,
} from './index.ts'
import {
	makeContext,
	makeDiscount,
	makeInput,
	makeLine,
} from './test-fixtures.ts'

const target = (overrides = {}) => ({
	scope: 'items' as const,
	itemIds: ['pizza'],
	categoryIds: [],
	excludeItemIds: [],
	excludeCategoryIds: [],
	...overrides,
})
const orderTarget = target({ scope: 'order', itemIds: [] })

const line = (
	lineId: string,
	itemId: string,
	unitMinor: number,
	quantity = 1,
	extra: Record<string, unknown> = {},
) => makeLine({ lineId, itemId, unitMinor, quantity, ...extra })

const evaluate = (
	lines: ReturnType<typeof line>[],
	discounts: ReturnType<typeof makeDiscount>[],
	extra: Record<string, unknown> = {},
) => evaluateDiscounts(makeInput({ lines, discounts, ...extra }))

describe('sizes: a variant name narrows what is discounted', () => {
	const largeForTen = makeDiscount({
		valueType: 'fixed_price',
		percentBp: null,
		amountMinor: 1000,
		currency: 'USD',
		target: target({
			scope: 'categories',
			itemIds: [],
			categoryIds: ['pizzas'],
			variantNames: ['Large'],
		}),
	})
	const pizza = (id: string, size: string[] | undefined, price = 1400) =>
		line(id, `pizza-${id}`, price, 1, {
			categoryIds: ['pizzas'],
			variantNames: size,
		})

	it('discounts the large pizzas and not the small ones', () => {
		const result = evaluate(
			[
				pizza('a', ['Large']),
				pizza('b', ['Small'], 900),
				pizza('c', ['Large']),
			],
			[largeForTen],
		)
		expect(result.lineDiscounts).toEqual({ a: 400, c: 400 })
	})

	it('matches ignoring case and spaces', () => {
		expect(
			evaluate([pizza('a', [' large '])], [largeForTen]).totalDiscountMinor,
		).toBe(400)
	})

	it('a line with no variant detail matches no size', () => {
		expect(
			evaluate([pizza('a', undefined)], [largeForTen]).totalDiscountMinor,
		).toBe(0)
		expect(evaluate([pizza('a', [])], [largeForTen]).totalDiscountMinor).toBe(0)
	})

	it('a variant with several values matches on any of them', () => {
		expect(
			evaluate([pizza('a', ['Large', 'Thin'])], [largeForTen])
				.totalDiscountMinor,
		).toBe(400)
	})

	it('narrows a meal deal slot: any 2 large pizzas for a set price', () => {
		const deal = makeDiscount({
			valueType: 'fixed_price',
			percentBp: null,
			amountMinor: 2000,
			currency: 'USD',
			quantityRule: {
				kind: 'bundle',
				slots: [
					{
						quantity: 2,
						itemIds: [],
						categoryIds: ['pizzas'],
						variantNames: ['Large'],
					},
				],
			},
		})
		const result = evaluate(
			[
				pizza('a', ['Large'], 1500),
				pizza('b', ['Small'], 900),
				pizza('c', ['Large'], 1500),
			],
			[deal],
		)
		// The two larges, 30.00 for 20.00; the small is left alone.
		expect(result.lineDiscounts).toEqual({ a: 500, c: 500 })
	})

	it('narrows the get side of a buy-get', () => {
		const rule = makeDiscount({
			percentBp: 10_000,
			quantityRule: {
				kind: 'buy_get',
				buy: { quantity: 1, itemIds: ['burger'], categoryIds: [] },
				get: {
					quantity: 1,
					itemIds: ['fries'],
					categoryIds: [],
					variantNames: ['Large'],
				},
			},
		})
		const result = evaluate(
			[
				line('b', 'burger', 1000),
				line('s', 'fries', 300, 1, { variantNames: ['Small'] }),
				line('l', 'fries', 500, 1, { variantNames: ['Large'] }),
			],
			[rule],
		)
		expect(result.lineDiscounts).toEqual({ l: 500 })
	})

	it('narrows the pizza a topping discount covers', () => {
		const toppings = makeDiscount({
			percentBp: 10_000,
			target: {
				scope: 'modifiers' as const,
				itemIds: [],
				categoryIds: [],
				excludeItemIds: [],
				excludeCategoryIds: [],
				modifierGroupIds: ['toppings'],
				variantNames: ['Large'],
			},
		})
		const withTopping = (id: string, size: string) =>
			line(id, 'pizza', 1350, 1, {
				baseUnitMinor: 1200,
				variantNames: [size],
				options: [
					{
						groupId: 'toppings',
						optionId: 'pep',
						quantity: 1,
						totalMinor: 150,
					},
				],
			})
		const result = evaluate(
			[withTopping('l', 'Large'), withTopping('s', 'Small')],
			[toppings],
		)
		expect(result.lineDiscounts).toEqual({ l: 150 })
	})

	it('is refused on the whole order, where it would be ignored', () => {
		const {
			id: ignoredId,
			version: ignoredVersion,
			createdAt: ignoredCreatedAt,
			...definition
		} = makeDiscount({ target: orderTarget })
		expect(
			discountDefinitionSchema.safeParse({
				...definition,
				target: { ...orderTarget, variantNames: ['Large'] },
			}).success,
		).toBe(false)
	})
})

describe('buy-get by spend: "spend $30, get a free dessert"', () => {
	const spendThirty = (overrides = {}) =>
		makeDiscount({
			percentBp: 10_000,
			currency: 'USD',
			quantityRule: {
				kind: 'buy_get',
				buy: { spendMinor: 3000, itemIds: ['burger'], categoryIds: [] },
				get: { quantity: 1, itemIds: ['dessert'], categoryIds: [] },
			},
			...overrides,
		})

	it('gives the dessert once enough is spent on burgers', () => {
		const result = evaluate(
			[line('b', 'burger', 1800, 2), line('d', 'dessert', 700)],
			[spendThirty()],
		)
		expect(result.lineDiscounts).toEqual({ d: 700 })
	})

	it('gives nothing below the threshold', () => {
		const result = evaluate(
			[line('b', 'burger', 1800), line('d', 'dessert', 700)],
			[spendThirty()],
		)
		expect(result.totalDiscountMinor).toBe(0)
	})

	it('spend on other items does not count', () => {
		const result = evaluate(
			[
				line('s', 'salad', 5000),
				line('b', 'burger', 1000),
				line('d', 'dessert', 700),
			],
			[spendThirty()],
		)
		expect(result.totalDiscountMinor).toBe(0)
	})

	it('earns one dessert for each threshold spent', () => {
		const lines = [line('b', 'burger', 3000, 2), line('d', 'dessert', 700, 2)]
		expect(evaluate(lines, [spendThirty()]).totalDiscountMinor).toBe(1400)
		// Capped to once per order.
		expect(
			evaluate(lines, [spendThirty({ maxDiscountedUnits: 1 })])
				.totalDiscountMinor,
		).toBe(700)
	})

	it('a discounted unit does not also count towards the spend', () => {
		// Buy group and get group are both burgers: 2 x 20.00 is not 40.00 of
		// spend once one is free.
		const rule = makeDiscount({
			percentBp: 10_000,
			currency: 'USD',
			quantityRule: {
				kind: 'buy_get',
				buy: { spendMinor: 3000, itemIds: ['burger'], categoryIds: [] },
				get: { quantity: 1, itemIds: ['burger'], categoryIds: [] },
			},
		})
		expect(
			evaluate([line('b', 'burger', 2000, 2)], [rule]).totalDiscountMinor,
		).toBe(0)
		expect(
			evaluate([line('b', 'burger', 2000, 3)], [rule]).totalDiscountMinor,
		).toBe(2000)
	})

	it('needs a currency and exactly one of quantity or spend', () => {
		const parse = (overrides: Record<string, unknown>) => {
			const {
				id: a,
				version: b,
				createdAt: c,
				...definition
			} = makeDiscount(overrides)
			void a
			void b
			void c
			return discountDefinitionSchema.safeParse(definition).success
		}
		const get = { quantity: 1, itemIds: ['dessert'], categoryIds: [] }
		const ok = {
			percentBp: 10_000,
			currency: 'USD',
			quantityRule: {
				kind: 'buy_get',
				buy: { spendMinor: 3000, itemIds: ['burger'], categoryIds: [] },
				get,
			},
		}
		expect(parse(ok)).toBe(true)
		expect(parse({ ...ok, currency: null })).toBe(false)
		expect(
			parse({
				...ok,
				quantityRule: {
					kind: 'buy_get',
					buy: {
						quantity: 1,
						spendMinor: 3000,
						itemIds: ['burger'],
						categoryIds: [],
					},
					get,
				},
			}),
		).toBe(false)
		expect(
			parse({
				...ok,
				quantityRule: {
					kind: 'buy_get',
					buy: { itemIds: ['burger'], categoryIds: [] },
					get,
				},
			}),
		).toBe(false)
	})
})

describe('tiers: the more spent or bought, the bigger the discount', () => {
	const spendLadder = makeDiscount({
		percentBp: null,
		currency: 'USD',
		target: orderTarget,
		tiers: {
			basis: 'spend',
			steps: [
				{ at: 3000, percentBp: 500, amountMinor: null },
				{ at: 5000, percentBp: 1500, amountMinor: null },
			],
		},
	})

	it('gives nothing below the first step', () => {
		expect(
			evaluate([line('a', 'x', 2500)], [spendLadder]).totalDiscountMinor,
		).toBe(0)
	})

	it('gives the highest step reached', () => {
		expect(
			evaluate([line('a', 'x', 3500)], [spendLadder]).totalDiscountMinor,
		).toBe(175)
		expect(
			evaluate([line('a', 'x', 5000)], [spendLadder]).totalDiscountMinor,
		).toBe(750)
		expect(
			evaluate([line('a', 'x', 6000)], [spendLadder]).totalDiscountMinor,
		).toBe(900)
	})

	it('steps given out of order still pick the highest reached', () => {
		const shuffled = makeDiscount({
			...spendLadder,
			tiers: {
				basis: 'spend',
				steps: [
					{ at: 5000, percentBp: 1500, amountMinor: null },
					{ at: 3000, percentBp: 500, amountMinor: null },
				],
			},
		})
		expect(
			evaluate([line('a', 'x', 4000)], [shuffled]).totalDiscountMinor,
		).toBe(200)
	})

	it('"spend $30 get $5, spend $50 get $12" with amounts', () => {
		const amounts = makeDiscount({
			valueType: 'fixed',
			percentBp: null,
			amountMinor: null,
			currency: 'USD',
			target: orderTarget,
			tiers: {
				basis: 'spend',
				steps: [
					{ at: 3000, percentBp: null, amountMinor: 500 },
					{ at: 5000, percentBp: null, amountMinor: 1200 },
				],
			},
		})
		expect(evaluate([line('a', 'x', 3200)], [amounts]).totalDiscountMinor).toBe(
			500,
		)
		expect(evaluate([line('a', 'x', 5200)], [amounts]).totalDiscountMinor).toBe(
			1200,
		)
	})

	it('a quantity ladder counts items', () => {
		const ladder = makeDiscount({
			percentBp: null,
			target: orderTarget,
			tiers: {
				basis: 'quantity',
				steps: [
					{ at: 2, percentBp: 1000, amountMinor: null },
					{ at: 4, percentBp: 2000, amountMinor: null },
				],
			},
		})
		expect(evaluate([line('a', 'x', 1000)], [ladder]).totalDiscountMinor).toBe(
			0,
		)
		expect(
			evaluate([line('a', 'x', 1000, 2)], [ladder]).totalDiscountMinor,
		).toBe(200)
		expect(
			evaluate([line('a', 'x', 1000, 4)], [ladder]).totalDiscountMinor,
		).toBe(800)
	})

	it('counts only the lines it targets', () => {
		const pizzas = makeDiscount({
			percentBp: null,
			target: target(),
			tiers: {
				basis: 'quantity',
				steps: [{ at: 3, percentBp: 5000, amountMinor: null }],
			},
		})
		// Two pizzas and three salads: only the pizzas count, so no tier.
		expect(
			evaluate(
				[line('p', 'pizza', 1000, 2), line('s', 'salad', 500, 3)],
				[pizzas],
			).totalDiscountMinor,
		).toBe(0)
		expect(
			evaluate([line('p', 'pizza', 1000, 3), line('s', 'salad', 500)], [pizzas])
				.lineDiscounts,
		).toEqual({ p: 1500 })
	})

	it('a coupon with a ladder says which step is missing', () => {
		const code = { ...spendLadder, id: 'c1', application: 'code' as const }
		const result = evaluate([line('a', 'x', 1000)], [code], {
			codes: [
				{
					id: 'code1',
					discountId: 'c1',
					normalizedCode: 'LADDER',
					maxUses: null,
				},
			],
			code: 'ladder',
		})
		expect(result.code).toEqual({
			status: 'refused',
			reason: 'minimum_not_met',
		})
	})

	it('is skipped in another currency', () => {
		expect(
			evaluate([line('a', 'x', 6000)], [spendLadder], { currency: 'SAR' })
				.totalDiscountMinor,
		).toBe(0)
	})

	describe('validation', () => {
		const parse = (overrides: Record<string, unknown>) => {
			const {
				id: a,
				version: b,
				createdAt: c,
				...definition
			} = makeDiscount(overrides)
			void a
			void b
			void c
			return discountDefinitionSchema.safeParse(definition).success
		}
		const base = {
			percentBp: null,
			currency: 'USD',
			target: orderTarget,
		}
		const steps = [
			{ at: 3000, percentBp: 500, amountMinor: null },
			{ at: 5000, percentBp: 1500, amountMinor: null },
		]

		it('accepts a ladder', () => {
			expect(parse({ ...base, tiers: { basis: 'spend', steps } })).toBe(true)
		})

		it('steps must go up', () => {
			expect(
				parse({
					...base,
					tiers: { basis: 'spend', steps: [steps[1], steps[0]] },
				}),
			).toBe(false)
			expect(
				parse({
					...base,
					tiers: { basis: 'spend', steps: [steps[0], steps[0]] },
				}),
			).toBe(false)
		})

		it('each step carries the kind of value the discount has', () => {
			expect(
				parse({
					...base,
					tiers: {
						basis: 'spend',
						steps: [{ at: 3000, percentBp: null, amountMinor: 500 }],
					},
				}),
			).toBe(false)
		})

		it('the discount itself then has no value of its own', () => {
			expect(
				parse({ ...base, percentBp: 1000, tiers: { basis: 'spend', steps } }),
			).toBe(false)
		})

		it('needs a currency to spend, but not to count items', () => {
			expect(
				parse({ ...base, currency: null, tiers: { basis: 'spend', steps } }),
			).toBe(false)
			expect(
				parse({
					...base,
					currency: null,
					tiers: {
						basis: 'quantity',
						steps: [{ at: 2, percentBp: 500, amountMinor: null }],
					},
				}),
			).toBe(true)
		})

		it('does not go with counted rules, deals or modifiers', () => {
			expect(
				parse({
					...base,
					target: target(),
					quantityRule: { kind: 'minimum', quantity: 2 },
					tiers: { basis: 'spend', steps },
				}),
			).toBe(false)
		})
	})
})

describe('free delivery with a fee limit', () => {
	const freeDelivery = (overrides = {}) =>
		makeDiscount({
			valueType: 'free_delivery',
			percentBp: null,
			currency: 'USD',
			fulfillments: ['delivery'],
			target: orderTarget,
			...overrides,
		})
	const withFee = (feeMinor: number) => ({
		context: makeContext({
			fulfillment: 'delivery',
			deliveryFeeMinor: feeMinor,
		}),
	})

	it('waives a fee up to the limit', () => {
		const result = evaluate(
			[line('a', 'x', 2000)],
			[freeDelivery({ maxDeliveryFeeMinor: 700 })],
			withFee(500),
		)
		expect(result.deliveryDiscountMinor).toBe(500)
		expect(
			evaluate(
				[line('a', 'x', 2000)],
				[freeDelivery({ maxDeliveryFeeMinor: 500 })],
				withFee(500),
			).deliveryDiscountMinor,
		).toBe(500)
	})

	it('leaves a fee over the limit alone', () => {
		const result = evaluate(
			[line('a', 'x', 2000)],
			[freeDelivery({ maxDeliveryFeeMinor: 700 })],
			withFee(900),
		)
		expect(result.deliveryDiscountMinor).toBe(0)
	})

	it('no limit waives any fee', () => {
		expect(
			evaluate([line('a', 'x', 2000)], [freeDelivery()], withFee(2500))
				.deliveryDiscountMinor,
		).toBe(2500)
	})

	it('only free delivery has a limit, and it needs a currency', () => {
		const parse = (overrides: Record<string, unknown>) => {
			const {
				id: a,
				version: b,
				createdAt: c,
				...definition
			} = makeDiscount(overrides)
			void a
			void b
			void c
			return discountDefinitionSchema.safeParse(definition).success
		}
		expect(parse({ ...freeDelivery({ maxDeliveryFeeMinor: 700 }) })).toBe(true)
		expect(
			parse({ ...freeDelivery({ maxDeliveryFeeMinor: 700, currency: null }) }),
		).toBe(false)
		expect(parse({ maxDeliveryFeeMinor: 700, currency: 'USD' })).toBe(false)
	})
})

describe('combination classes', () => {
	const itemDiscount = (id: string, overrides = {}) =>
		makeDiscount({
			id,
			name: id,
			percentBp: 1000,
			target: target(),
			...overrides,
		})
	const orderDiscount = (id: string, overrides = {}) =>
		makeDiscount({
			id,
			name: id,
			percentBp: 1000,
			target: orderTarget,
			...overrides,
		})
	const deliveryDiscount = (id: string, overrides = {}) =>
		makeDiscount({
			id,
			name: id,
			valueType: 'free_delivery',
			percentBp: null,
			fulfillments: ['delivery'],
			target: orderTarget,
			...overrides,
		})
	const cart = [line('p', 'pizza', 2000, 2)]
	const ids = (result: ReturnType<typeof evaluate>) =>
		result.applied.map((entry) => entry.discountId).sort()

	it('knows what each discount touches', () => {
		expect(discountClassOf(itemDiscount('a'))).toBe('item')
		expect(discountClassOf(orderDiscount('a'))).toBe('order')
		expect(discountClassOf(deliveryDiscount('a'))).toBe('delivery')
		expect(
			discountClassOf(
				makeDiscount({
					target: orderTarget,
					quantityRule: {
						kind: 'bundle',
						slots: [{ quantity: 1, itemIds: ['pizza'], categoryIds: [] }],
					},
				}),
			),
		).toBe('item')
	})

	it('the old switch still means all kinds or none', () => {
		expect(combinesWithOf(makeDiscount({ combinable: true }))).toEqual([
			'item',
			'order',
			'delivery',
		])
		expect(combinesWithOf(makeDiscount({ combinable: false }))).toEqual([])
		expect(
			combinesWithOf(
				makeDiscount({ combinable: true, combinesWith: ['order'] }),
			),
		).toEqual(['order'])
	})

	it('an item and an order discount stack when each allows the other', () => {
		const result = evaluate(cart, [
			itemDiscount('item', { combinesWith: ['order'] }),
			orderDiscount('order', { combinesWith: ['item'] }),
		])
		expect(ids(result)).toEqual(['item', 'order'])
	})

	it('one side saying no keeps them apart, and the better one wins', () => {
		const result = evaluate(cart, [
			itemDiscount('item', { combinesWith: ['order'], percentBp: 2000 }),
			orderDiscount('order', { combinesWith: [] }),
		])
		expect(ids(result)).toEqual(['item'])
	})

	it('a discount that allows its own kind stacks with another of it', () => {
		const result = evaluate(cart, [
			itemDiscount('a', { combinesWith: ['item'] }),
			itemDiscount('b', { combinesWith: ['item'], priority: 1 }),
		])
		expect(ids(result)).toEqual(['a', 'b'])
	})

	it('without that, two of a kind compete and the larger wins', () => {
		const result = evaluate(cart, [
			itemDiscount('small', { combinesWith: ['order'], percentBp: 1000 }),
			itemDiscount('big', {
				combinesWith: ['order'],
				percentBp: 3000,
				priority: 1,
			}),
		])
		expect(ids(result)).toEqual(['big'])
	})

	it('picks the best group when stacking is not all or nothing', () => {
		// Item and delivery don't mix; each mixes with the order discount.
		const result = evaluateDiscounts(
			makeInput({
				lines: cart,
				context: makeContext({
					fulfillment: 'delivery',
					deliveryFeeMinor: 300,
				}),
				discounts: [
					itemDiscount('item', {
						combinesWith: ['order'],
						percentBp: 2000,
						fulfillments: ['delivery'],
					}),
					orderDiscount('order', {
						combinesWith: ['item', 'delivery'],
						percentBp: 500,
						fulfillments: ['delivery'],
					}),
					deliveryDiscount('delivery', { combinesWith: ['order'] }),
				],
			}),
		)
		// item + order = 800 + 160 = 960; order + delivery = 200 + 300 = 500.
		expect(ids(result)).toEqual(['item', 'order'])
		expect(result.deliveryDiscountMinor).toBe(0)
	})

	it('a delivery discount stacks with an item discount when both allow it', () => {
		const result = evaluateDiscounts(
			makeInput({
				lines: cart,
				context: makeContext({
					fulfillment: 'delivery',
					deliveryFeeMinor: 300,
				}),
				discounts: [
					itemDiscount('item', {
						combinesWith: ['delivery'],
						fulfillments: ['delivery'],
					}),
					deliveryDiscount('delivery', { combinesWith: ['item'] }),
				],
			}),
		)
		expect(ids(result)).toEqual(['delivery', 'item'])
		expect(result.deliveryDiscountMinor).toBe(300)
	})

	describe('with a coupon', () => {
		const code = (overrides = {}) =>
			orderDiscount('c1', { application: 'code', ...overrides })
		const withCode = (discounts: ReturnType<typeof makeDiscount>[]) =>
			evaluate(cart, discounts, {
				codes: [
					{
						id: 'code1',
						discountId: 'c1',
						normalizedCode: 'SAVE',
						maxUses: null,
					},
				],
				code: 'save',
			})

		it('stacks on a compatible automatic discount', () => {
			const result = withCode([
				itemDiscount('auto', { combinesWith: ['order'] }),
				code({ combinesWith: ['item'] }),
			])
			expect(result.code).toEqual({ status: 'applied', discountId: 'c1' })
			expect(ids(result)).toEqual(['auto', 'c1'])
		})

		it('competes with one it cannot stack with and says when it loses', () => {
			const result = withCode([
				itemDiscount('auto', { combinesWith: [], percentBp: 5000 }),
				code({ combinesWith: ['item'], percentBp: 1000 }),
			])
			expect(result.code).toEqual({
				status: 'replaced',
				reason: 'replaced_by_better_discount',
				discountId: 'c1',
			})
			expect(ids(result)).toEqual(['auto'])
		})

		it('wins when it is the larger of the two', () => {
			const result = withCode([
				itemDiscount('auto', { combinesWith: [], percentBp: 500 }),
				code({ combinesWith: [], percentBp: 3000 }),
			])
			expect(result.code).toEqual({ status: 'applied', discountId: 'c1' })
			expect(ids(result)).toEqual(['c1'])
		})
	})

	it('validates the list', () => {
		const parse = (overrides: Record<string, unknown>) => {
			const {
				id: a,
				version: b,
				createdAt: c,
				...definition
			} = makeDiscount(overrides)
			void a
			void b
			void c
			return discountDefinitionSchema.safeParse(definition).success
		}
		expect(parse({ combinesWith: ['item', 'order'] })).toBe(true)
		expect(parse({ combinesWith: [] })).toBe(true)
		expect(parse({ combinesWith: ['item', 'item'] })).toBe(false)
		expect(parse({ combinesWith: ['everything'] })).toBe(false)
	})
})
