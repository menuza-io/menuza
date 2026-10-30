import { describe, expect, it } from 'vitest'
import { evaluateDiscounts } from './evaluate.ts'
import {
	makeContext,
	makeDiscount,
	makeInput,
	makeLine,
} from './test-fixtures.ts'

const coupon = (overrides = {}) =>
	makeDiscount({ id: 'c1', application: 'code', ...overrides })
const codeRecord = {
	id: 'code1',
	discountId: 'c1',
	normalizedCode: 'SAVE10',
	maxUses: null,
}

describe('percent and fixed discounts', () => {
	it('takes a percentage off the order', () => {
		const result = evaluateDiscounts(
			makeInput({
				lines: [makeLine({ unitMinor: 1000, quantity: 2 })],
				discounts: [makeDiscount({ percentBp: 1500 })],
			}),
		)
		expect(result.totalDiscountMinor).toBe(300)
		expect(result.lineDiscounts).toEqual({ '0': 300 })
	})

	it('rounds a percentage down', () => {
		const result = evaluateDiscounts(
			makeInput({
				lines: [makeLine({ unitMinor: 333 })],
				discounts: [makeDiscount({ percentBp: 1000 })],
			}),
		)
		expect(result.totalDiscountMinor).toBe(33)
	})

	it('caps a percentage at the maximum value', () => {
		const result = evaluateDiscounts(
			makeInput({
				lines: [makeLine({ unitMinor: 10_000 })],
				discounts: [makeDiscount({ percentBp: 5000, maxDiscountMinor: 1000 })],
			}),
		)
		expect(result.totalDiscountMinor).toBe(1000)
	})

	it('takes a fixed amount off the order once, split across lines', () => {
		const result = evaluateDiscounts(
			makeInput({
				lines: [
					makeLine({ lineId: 'a', unitMinor: 1000 }),
					makeLine({ lineId: 'b', unitMinor: 3000 }),
				],
				discounts: [
					makeDiscount({
						valueType: 'fixed',
						percentBp: null,
						amountMinor: 400,
						currency: 'USD',
					}),
				],
			}),
		)
		expect(result.lineDiscounts).toEqual({ a: 100, b: 300 })
	})

	it('never discounts more than the order is worth', () => {
		const result = evaluateDiscounts(
			makeInput({
				lines: [makeLine({ unitMinor: 500 })],
				discounts: [
					makeDiscount({
						valueType: 'fixed',
						percentBp: null,
						amountMinor: 5000,
						currency: 'USD',
					}),
				],
			}),
		)
		expect(result.totalDiscountMinor).toBe(500)
	})

	it('takes a fixed amount off each item when targeting items', () => {
		const result = evaluateDiscounts(
			makeInput({
				lines: [
					makeLine({
						lineId: 'a',
						itemId: 'fries',
						unitMinor: 300,
						quantity: 2,
					}),
					makeLine({ lineId: 'b', itemId: 'burger', unitMinor: 1000 }),
				],
				discounts: [
					makeDiscount({
						valueType: 'fixed',
						percentBp: null,
						amountMinor: 100,
						currency: 'USD',
						target: {
							scope: 'items',
							itemIds: ['fries'],
							categoryIds: [],
							excludeItemIds: [],
							excludeCategoryIds: [],
						},
					}),
				],
			}),
		)
		expect(result.lineDiscounts).toEqual({ a: 200 })
	})

	it('skips a fixed discount in another currency', () => {
		const result = evaluateDiscounts(
			makeInput({
				currency: 'SAR',
				discounts: [
					makeDiscount({
						valueType: 'fixed',
						percentBp: null,
						amountMinor: 100,
						currency: 'USD',
					}),
				],
			}),
		)
		expect(result.totalDiscountMinor).toBe(0)
	})
})

describe('targets', () => {
	const target = (overrides = {}) => ({
		scope: 'categories' as const,
		itemIds: [],
		categoryIds: ['drinks'],
		excludeItemIds: [],
		excludeCategoryIds: [],
		...overrides,
	})
	const lines = [
		makeLine({
			lineId: 'a',
			itemId: 'cola',
			categoryIds: ['drinks'],
			unitMinor: 400,
		}),
		makeLine({ lineId: 'b', itemId: 'burger', unitMinor: 1000 }),
	]

	it('discounts only the matching category', () => {
		const result = evaluateDiscounts(
			makeInput({ lines, discounts: [makeDiscount({ target: target() })] }),
		)
		expect(result.lineDiscounts).toEqual({ a: 40 })
	})

	it('honours excluded items and categories', () => {
		const result = evaluateDiscounts(
			makeInput({
				lines,
				discounts: [
					makeDiscount({
						target: target({ scope: 'order', excludeItemIds: ['cola'] }),
					}),
				],
			}),
		)
		expect(result.lineDiscounts).toEqual({ b: 100 })
	})

	it('never discounts lines flagged as excluded', () => {
		const result = evaluateDiscounts(
			makeInput({
				lines: [makeLine({ lineId: 'g', itemId: 'gift', excluded: true })],
				discounts: [makeDiscount()],
			}),
		)
		expect(result.totalDiscountMinor).toBe(0)
	})

	it('needs the required items in the cart', () => {
		const discount = makeDiscount({
			requirement: { quantity: 2, itemIds: ['burger'], categoryIds: [] },
		})
		expect(
			evaluateDiscounts(makeInput({ lines, discounts: [discount] }))
				.totalDiscountMinor,
		).toBe(0)
		expect(
			evaluateDiscounts(
				makeInput({
					lines: [makeLine({ quantity: 2 })],
					discounts: [discount],
				}),
			).totalDiscountMinor,
		).toBe(200)
	})
})

describe('quantity rules', () => {
	const items = {
		scope: 'items' as const,
		itemIds: ['burger'],
		categoryIds: [],
		excludeItemIds: [],
		excludeCategoryIds: [],
	}

	it('buy one get one free discounts the cheaper unit', () => {
		const result = evaluateDiscounts(
			makeInput({
				lines: [
					makeLine({ lineId: 'a', unitMinor: 1200 }),
					makeLine({ lineId: 'b', unitMinor: 800 }),
				],
				discounts: [
					makeDiscount({
						percentBp: 10_000,
						target: { ...items, itemIds: ['burger'] },
						quantityRule: { kind: 'bogo', buyQuantity: 1, getQuantity: 1 },
					}),
				],
			}),
		)
		expect(result.lineDiscounts).toEqual({ b: 800 })
	})

	it('BOGO leaves an odd unit at full price', () => {
		const result = evaluateDiscounts(
			makeInput({
				lines: [makeLine({ unitMinor: 1000, quantity: 3 })],
				discounts: [
					makeDiscount({
						percentBp: 10_000,
						target: items,
						quantityRule: { kind: 'bogo', buyQuantity: 1, getQuantity: 1 },
					}),
				],
			}),
		)
		expect(result.totalDiscountMinor).toBe(1000)
	})

	it('minimum quantity discounts every unit once reached', () => {
		const discount = makeDiscount({
			target: items,
			quantityRule: { kind: 'minimum', quantity: 3 },
		})
		const lines = (quantity: number) => [makeLine({ quantity })]
		expect(
			evaluateDiscounts(makeInput({ lines: lines(2), discounts: [discount] }))
				.totalDiscountMinor,
		).toBe(0)
		expect(
			evaluateDiscounts(makeInput({ lines: lines(3), discounts: [discount] }))
				.totalDiscountMinor,
		).toBe(300)
	})

	it('exact quantity discounts whole multiples only', () => {
		const result = evaluateDiscounts(
			makeInput({
				lines: [makeLine({ quantity: 5 })],
				discounts: [
					makeDiscount({
						target: items,
						quantityRule: { kind: 'exact', quantity: 2 },
					}),
				],
			}),
		)
		expect(result.totalDiscountMinor).toBe(400)
	})

	it('caps the discounted units, keeping the dearest', () => {
		const result = evaluateDiscounts(
			makeInput({
				lines: [
					makeLine({ lineId: 'a', unitMinor: 500 }),
					makeLine({ lineId: 'b', unitMinor: 900 }),
				],
				discounts: [
					makeDiscount({
						percentBp: 10_000,
						target: { ...items },
						maxDiscountedUnits: 1,
					}),
				],
			}),
		)
		expect(result.lineDiscounts).toEqual({ b: 900 })
	})
})

describe('when a discount is available', () => {
	const at = (localNow: string, overrides = {}) =>
		evaluateDiscounts(
			makeInput({
				context: makeContext({ localNow }),
				discounts: [makeDiscount(overrides)],
			}),
		).totalDiscountMinor

	it('respects start and end', () => {
		const dates = { startsAt: '2026-10-30T10:00', endsAt: '2026-10-30T14:00' }
		expect(at('2026-10-30T09:59', dates)).toBe(0)
		expect(at('2026-10-30T10:00', dates)).toBe(100)
		expect(at('2026-10-30T14:00', dates)).toBe(100)
		expect(at('2026-10-30T14:01', dates)).toBe(0)
	})

	it('respects a weekly schedule', () => {
		// 2026-10-30 is a Friday (5).
		const happyHour = { schedule: [{ day: 5, start: '16:00', end: '18:00' }] }
		expect(at('2026-10-30T15:59', happyHour)).toBe(0)
		expect(at('2026-10-30T16:00', happyHour)).toBe(100)
		expect(at('2026-10-30T18:00', happyHour)).toBe(0)
		expect(at('2026-10-31T17:00', happyHour)).toBe(0)
	})

	it('runs a late window past midnight', () => {
		const lateNight = { schedule: [{ day: 5, start: '22:00', end: '02:00' }] }
		expect(at('2026-10-30T23:00', lateNight)).toBe(100)
		expect(at('2026-10-31T01:30', lateNight)).toBe(100)
		expect(at('2026-10-31T02:00', lateNight)).toBe(0)
		expect(at('2026-10-30T01:30', lateNight)).toBe(0)
	})

	it('filters by location, channel, order type and drops', () => {
		const run = (context = {}, overrides = {}) =>
			evaluateDiscounts(
				makeInput({
					context: makeContext(context),
					discounts: [makeDiscount(overrides)],
				}),
			).totalDiscountMinor
		expect(run({}, { locationIds: ['other'] })).toBe(0)
		expect(run({}, { locationIds: ['loc1'] })).toBe(100)
		expect(run({ channel: 'qr' }, { channels: ['web'] })).toBe(0)
		expect(run({ fulfillment: 'delivery' }, { fulfillments: ['pickup'] })).toBe(
			0,
		)
		expect(run({ isDrop: true })).toBe(0)
		expect(run({ isDrop: true }, { includeDrops: true })).toBe(100)
	})

	it('needs the minimum spend before discounts', () => {
		expect(at('2026-10-30T12:00', { minSubtotalMinor: 1001 })).toBe(0)
		expect(at('2026-10-30T12:00', { minSubtotalMinor: 1000 })).toBe(100)
	})

	it('ignores paused and archived discounts', () => {
		expect(at('2026-10-30T12:00', { status: 'paused' })).toBe(0)
		expect(at('2026-10-30T12:00', { status: 'archived' })).toBe(0)
	})
})

describe('who can use it', () => {
	const run = (customer = {}, overrides = {}, usage = {}) =>
		evaluateDiscounts(
			makeInput({
				context: makeContext({
					customer: {
						signedIn: true,
						isNewCustomer: false,
						isLoyaltyMember: false,
						...customer,
					},
				}),
				discounts: [makeDiscount({ id: 'd1', ...overrides })],
				usage,
			}),
		).totalDiscountMinor

	it('limits to signed-in, new and loyalty customers', () => {
		expect(run({ signedIn: false }, { eligibility: 'signed_in' })).toBe(0)
		expect(run({}, { eligibility: 'signed_in' })).toBe(100)
		expect(run({}, { eligibility: 'new_customer' })).toBe(0)
		expect(run({ isNewCustomer: true }, { eligibility: 'new_customer' })).toBe(
			100,
		)
		expect(run({}, { eligibility: 'loyalty_member' })).toBe(0)
		expect(
			run({ isLoyaltyMember: true }, { eligibility: 'loyalty_member' }),
		).toBe(100)
	})

	it('stops at the total limit', () => {
		const usage = {
			d1: { total: 10, customerLifetime: 0, customerDay: 0, customerWeek: 0 },
		}
		expect(run({}, { totalLimit: 10 }, usage)).toBe(0)
		expect(run({}, { totalLimit: 11 }, usage)).toBe(100)
	})

	it('stops at the per-customer limit and needs sign-in for it', () => {
		const limit = { count: 1, period: 'day' as const }
		const usage = {
			d1: { total: 0, customerLifetime: 5, customerDay: 1, customerWeek: 1 },
		}
		expect(run({}, { perCustomerLimit: limit }, usage)).toBe(0)
		expect(
			run({}, { perCustomerLimit: { count: 2, period: 'day' } }, usage),
		).toBe(100)
		expect(run({ signedIn: false }, { perCustomerLimit: limit }, {})).toBe(0)
	})
})

describe('coupon codes', () => {
	const typed = (code: string, extra = {}) =>
		evaluateDiscounts(
			makeInput({
				discounts: [coupon()],
				codes: [codeRecord],
				code,
				...extra,
			}),
		)

	it('applies a code however it is typed', () => {
		for (const text of ['save10', ' SAVE-10 ', 'Save 10']) {
			const result = typed(text)
			expect(result.code).toEqual({ status: 'applied', discountId: 'c1' })
			expect(result.totalDiscountMinor).toBe(100)
			expect(result.applied[0]).toMatchObject({
				codeId: 'code1',
				normalizedCode: 'SAVE10',
			})
		}
	})

	it('treats unknown, paused and automatic-only codes alike', () => {
		expect(typed('nope').code).toEqual({
			status: 'refused',
			reason: 'not_found',
		})
		expect(
			evaluateDiscounts(
				makeInput({
					discounts: [coupon({ status: 'paused' })],
					codes: [codeRecord],
					code: 'save10',
				}),
			).code,
		).toEqual({ status: 'refused', reason: 'not_found' })
		expect(
			evaluateDiscounts(
				makeInput({
					discounts: [coupon({ application: 'automatic' })],
					codes: [codeRecord],
					code: 'save10',
				}),
			).code,
		).toEqual({ status: 'refused', reason: 'not_found' })
	})

	it('says why a real code does not apply', () => {
		expect(
			evaluateDiscounts(
				makeInput({
					discounts: [coupon({ endsAt: '2026-01-01T00:00' })],
					codes: [codeRecord],
					code: 'save10',
				}),
			).code,
		).toEqual({ status: 'refused', reason: 'expired' })
		expect(
			evaluateDiscounts(
				makeInput({
					discounts: [coupon({ minSubtotalMinor: 5000 })],
					codes: [codeRecord],
					code: 'save10',
				}),
			).code,
		).toEqual({ status: 'refused', reason: 'minimum_not_met' })
	})

	it('stops at the code use limit', () => {
		const result = evaluateDiscounts(
			makeInput({
				discounts: [coupon()],
				codes: [{ ...codeRecord, maxUses: 3 }],
				codeUsage: { code1: 3 },
				code: 'save10',
			}),
		)
		expect(result.code).toEqual({ status: 'refused', reason: 'limit_reached' })
	})

	it('reports nothing when no code was typed', () => {
		expect(typed('').code).toBeNull()
	})
})

describe('combining', () => {
	const auto20 = makeDiscount({ id: 'a1', percentBp: 2000 })
	const auto10 = makeDiscount({ id: 'a2', percentBp: 1000, priority: 1 })

	it('picks the best of several non-combinable automatic discounts', () => {
		const result = evaluateDiscounts(makeInput({ discounts: [auto10, auto20] }))
		expect(result.applied.map((d) => d.discountId)).toEqual(['a1'])
		expect(result.totalDiscountMinor).toBe(200)
	})

	it('stacks combinable discounts on the remaining value', () => {
		const result = evaluateDiscounts(
			makeInput({
				lines: [makeLine({ unitMinor: 1000 })],
				discounts: [
					makeDiscount({ id: 'a1', percentBp: 1000, combinable: true }),
					makeDiscount({
						id: 'a2',
						percentBp: 1000,
						combinable: true,
						priority: 1,
					}),
				],
			}),
		)
		// 10% of 1000, then 10% of the remaining 900.
		expect(result.totalDiscountMinor).toBe(190)
	})

	it('lets a combinable code stack on top of automatic discounts', () => {
		const result = evaluateDiscounts(
			makeInput({
				discounts: [auto10, coupon({ combinable: true })],
				codes: [codeRecord],
				code: 'save10',
			}),
		)
		expect(result.applied.map((d) => d.discountId)).toEqual(['a2', 'c1'])
		expect(result.totalDiscountMinor).toBe(190)
	})

	it('keeps the better of a non-combinable code and the automatic discount', () => {
		const better = evaluateDiscounts(
			makeInput({
				discounts: [auto10, coupon({ percentBp: 3000 })],
				codes: [codeRecord],
				code: 'save10',
			}),
		)
		expect(better.code).toEqual({ status: 'applied', discountId: 'c1' })
		expect(better.applied.map((d) => d.discountId)).toEqual(['c1'])

		const worse = evaluateDiscounts(
			makeInput({
				discounts: [auto20, coupon({ percentBp: 1000 })],
				codes: [codeRecord],
				code: 'save10',
			}),
		)
		expect(worse.code).toEqual({
			status: 'replaced',
			reason: 'replaced_by_better_discount',
			discountId: 'c1',
		})
		expect(worse.applied.map((d) => d.discountId)).toEqual(['a1'])
	})

	it('prefers the typed code on a tie', () => {
		const result = evaluateDiscounts(
			makeInput({
				discounts: [auto10, coupon({ percentBp: 1000 })],
				codes: [codeRecord],
				code: 'save10',
			}),
		)
		expect(result.code).toEqual({ status: 'applied', discountId: 'c1' })
	})

	it('breaks ties on priority, then age', () => {
		const result = evaluateDiscounts(
			makeInput({
				discounts: [
					makeDiscount({ id: 'late', priority: 2 }),
					makeDiscount({ id: 'early', priority: 1 }),
				],
			}),
		)
		expect(result.applied.map((d) => d.discountId)).toEqual(['early'])
	})
})

describe('free delivery', () => {
	const freeDelivery = makeDiscount({
		valueType: 'free_delivery',
		percentBp: null,
		fulfillments: ['delivery'],
	})
	it('removes the delivery fee, not the items', () => {
		const result = evaluateDiscounts(
			makeInput({
				context: makeContext({
					fulfillment: 'delivery',
					deliveryFeeMinor: 499,
				}),
				discounts: [freeDelivery],
			}),
		)
		expect(result.deliveryDiscountMinor).toBe(499)
		expect(result.lineDiscounts).toEqual({})
		expect(result.totalDiscountMinor).toBe(499)
	})

	it('does nothing on pickup', () => {
		const result = evaluateDiscounts(makeInput({ discounts: [freeDelivery] }))
		expect(result.totalDiscountMinor).toBe(0)
	})
})
