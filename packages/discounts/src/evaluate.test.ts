import { describe, expect, it } from 'vitest'
import { discountDefinitionSchema } from './definition.ts'
import { evaluateDiscounts, quoteManualDiscount } from './evaluate.ts'
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
				discounts: [
					makeDiscount({
						percentBp: 5000,
						maxDiscountMinor: 1000,
						currency: 'USD',
					}),
				],
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
		expect(at('2026-10-30T13:59', dates)).toBe(100)
		// The end is exclusive, like the end of a weekly window.
		expect(at('2026-10-30T14:00', dates)).toBe(0)
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
		expect(
			at('2026-10-30T12:00', { minSubtotalMinor: 1001, currency: 'USD' }),
		).toBe(0)
		expect(
			at('2026-10-30T12:00', { minSubtotalMinor: 1000, currency: 'USD' }),
		).toBe(100)
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
					discounts: [coupon({ minSubtotalMinor: 5000, currency: 'USD' })],
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

	it('lets a combinable code stack on top of combinable automatic discounts', () => {
		const result = evaluateDiscounts(
			makeInput({
				discounts: [
					makeDiscount({
						id: 'a2',
						percentBp: 1000,
						priority: 1,
						combinable: true,
					}),
					coupon({ combinable: true }),
				],
				codes: [codeRecord],
				code: 'save10',
			}),
		)
		expect(result.applied.map((d) => d.discountId)).toEqual(['a2', 'c1'])
		expect(result.totalDiscountMinor).toBe(190)
	})

	it('picks the better of a non-combinable automatic and a combinable stack with a code', () => {
		const betterStack = evaluateDiscounts(
			makeInput({
				lines: [makeLine({ unitMinor: 1000 })],
				discounts: [
					makeDiscount({ id: 'big', percentBp: 3000 }),
					makeDiscount({ id: 'mid', percentBp: 2000, combinable: true }),
					coupon({ combinable: true, percentBp: 1500 }),
				],
				codes: [codeRecord],
				code: 'save10',
			}),
		)
		// 20% of 1000, then 15% of the remaining 800, beats 30% alone.
		expect(betterStack.totalDiscountMinor).toBe(320)
		expect(betterStack.applied.map((d) => d.discountId)).toEqual(['mid', 'c1'])

		const betterAlone = evaluateDiscounts(
			makeInput({
				lines: [makeLine({ unitMinor: 1000 })],
				discounts: [
					makeDiscount({ id: 'big', percentBp: 3000 }),
					makeDiscount({ id: 'mid', percentBp: 2000, combinable: true }),
					coupon({ combinable: true, percentBp: 500 }),
				],
				codes: [codeRecord],
				code: 'save10',
			}),
		)
		expect(betterAlone.code).toEqual({
			status: 'replaced',
			reason: 'replaced_by_better_discount',
			discountId: 'c1',
		})
		expect(betterAlone.applied.map((d) => d.discountId)).toEqual(['big'])
		expect(betterAlone.totalDiscountMinor).toBe(300)
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

describe('caps and minimums are tied to a currency', () => {
	it('refuses a cap in another currency instead of reading its units', () => {
		const result = evaluateDiscounts(
			makeInput({
				currency: 'KWD',
				lines: [makeLine({ unitMinor: 20_000 })],
				discounts: [
					makeDiscount({
						percentBp: 5000,
						maxDiscountMinor: 500,
						currency: 'USD',
					}),
				],
			}),
		)
		expect(result.totalDiscountMinor).toBe(0)
	})

	it('needs a currency on the definition when a cap or minimum is set', () => {
		const {
			id: ignoredId,
			version: ignoredVersion,
			createdAt: ignoredCreatedAt,
			...definition
		} = makeDiscount({ percentBp: 1000, maxDiscountMinor: 500, currency: null })
		expect(discountDefinitionSchema.safeParse(definition).success).toBe(false)
	})
})

describe('definition validation', () => {
	const parse = (overrides: Record<string, unknown>) => {
		const {
			id: ignoredId,
			version: ignoredVersion,
			createdAt: ignoredCreatedAt,
			...definition
		} = makeDiscount(overrides)
		return discountDefinitionSchema.safeParse(definition).success
	}
	it('rejects impossible dates, empty lists and a zero-length window', () => {
		expect(parse({ startsAt: '2026-02-31T10:00' })).toBe(false)
		expect(parse({ endsAt: '2026-10-30T25:99' })).toBe(false)
		expect(parse({ schedule: [] })).toBe(false)
		expect(parse({ locationIds: [] })).toBe(false)
		expect(
			parse({ startsAt: '2026-10-30T10:00', endsAt: '2026-10-30T10:00' }),
		).toBe(false)
		expect(
			parse({ startsAt: '2026-10-30T10:00', endsAt: '2026-10-31T10:00' }),
		).toBe(true)
	})
})

describe('competing automatic discounts are capped', () => {
	it('lets only the 12 first by priority compete, however many are configured', () => {
		const discounts = Array.from({ length: 16 }, (_, index) =>
			makeDiscount({
				id: `d${String(index).padStart(2, '0')}`,
				name: `Discount ${index}`,
				priority: index,
				// Each one is better than the one before, so the best of all 16 is
				// the last one, which is past the cap.
				percentBp: 500 + index * 100,
			}),
		)
		const result = evaluateDiscounts(
			makeInput({ lines: [makeLine({ unitMinor: 10_000 })], discounts }),
		)
		// The 12th (index 11) is the best that competed: 16% off 100.00.
		expect(result.applied.map((entry) => entry.discountId)).toEqual(['d11'])
		expect(result.totalDiscountMinor).toBe(1600)
	})
})

const burgers = {
	scope: 'items' as const,
	itemIds: ['burger'],
	categoryIds: [],
	excludeItemIds: [],
	excludeCategoryIds: [],
}

describe('what each unit has left', () => {
	it('keeps the other units whole after a discount took one unit', () => {
		// 3 burgers at 10.00. A sets the first to 2.00 (8.00 off one unit); B
		// then takes 9.00 off each unit, which is 2.00 + 9.00 + 9.00, not 9.00
		// off an average of 7.33 left on each.
		const setPrice = makeDiscount({
			id: 'a',
			priority: 0,
			combinable: true,
			valueType: 'fixed_price',
			percentBp: null,
			amountMinor: 200,
			currency: 'USD',
			maxDiscountedUnits: 1,
			target: burgers,
		})
		const nineOff = makeDiscount({
			id: 'b',
			priority: 1,
			combinable: true,
			valueType: 'fixed',
			percentBp: null,
			amountMinor: 900,
			currency: 'USD',
			target: burgers,
		})
		const result = evaluateDiscounts(
			makeInput({
				lines: [makeLine({ unitMinor: 1000, quantity: 3 })],
				discounts: [setPrice, nineOff],
			}),
		)
		expect(result.applied.map((a) => [a.discountId, a.amountMinor])).toEqual([
			['a', 800],
			['b', 2000],
		])
		expect(result.totalDiscountMinor).toBe(2800)
	})

	it('gives the same discount whatever order the lines are in', () => {
		const firstHalf = makeDiscount({
			id: 'half',
			priority: 0,
			combinable: true,
			percentBp: 5000,
			maxDiscountedUnits: 1,
			target: { ...burgers, itemIds: ['burger', 'fries'] },
		})
		const fixed = makeDiscount({
			id: 'fixed',
			priority: 1,
			combinable: true,
			valueType: 'fixed',
			percentBp: null,
			amountMinor: 900,
			currency: 'USD',
			target: burgers,
		})
		const a = makeLine({ lineId: 'a', itemId: 'burger', unitMinor: 1000 })
		const b = makeLine({
			lineId: 'b',
			itemId: 'fries',
			unitMinor: 1000,
			quantity: 3,
		})
		const one = evaluateDiscounts(
			makeInput({ lines: [a, b], discounts: [firstHalf, fixed] }),
		)
		const other = evaluateDiscounts(
			makeInput({ lines: [b, a], discounts: [firstHalf, fixed] }),
		)
		expect(other.totalDiscountMinor).toBe(one.totalDiscountMinor)
		expect(other.lineDiscounts).toEqual(one.lineDiscounts)
	})
})

describe('buy one get one counts complete groups only', () => {
	it('buy 1 get 2 with five items discounts one group of two', () => {
		const result = evaluateDiscounts(
			makeInput({
				lines: [makeLine({ unitMinor: 1000, quantity: 5 })],
				discounts: [
					makeDiscount({
						percentBp: 10_000,
						target: burgers,
						quantityRule: { kind: 'bogo', buyQuantity: 1, getQuantity: 2 },
					}),
				],
			}),
		)
		// [buy, free, free] [buy, -]: the last burger is bought, not free.
		expect(result.totalDiscountMinor).toBe(2000)
	})

	it('an incomplete group alone gives nothing', () => {
		const result = evaluateDiscounts(
			makeInput({
				lines: [makeLine({ unitMinor: 1000, quantity: 2 })],
				discounts: [
					makeDiscount({
						percentBp: 10_000,
						target: burgers,
						quantityRule: { kind: 'bogo', buyQuantity: 1, getQuantity: 2 },
					}),
				],
			}),
		)
		expect(result.totalDiscountMinor).toBe(0)
	})
})

describe('a fixed amount for the whole selection', () => {
	it('an amount ladder step is one amount, not one per item', () => {
		// "Spend 30.00 on burgers, get 5.00": four burgers get 5.00 in all.
		const ladder = makeDiscount({
			valueType: 'fixed',
			percentBp: null,
			currency: 'USD',
			target: burgers,
			tiers: {
				basis: 'spend',
				steps: [{ at: 3000, percentBp: null, amountMinor: 500 }],
			},
		})
		const result = evaluateDiscounts(
			makeInput({
				lines: [makeLine({ unitMinor: 1000, quantity: 4 })],
				discounts: [ladder],
			}),
		)
		expect(result.totalDiscountMinor).toBe(500)
	})

	it('an amount the cashier types is for the whole selection', () => {
		const manual = makeDiscount({
			application: 'manual',
			valueType: 'variable_amount',
			percentBp: null,
			currency: 'USD',
			target: burgers,
		})
		const quote = quoteManualDiscount({
			discount: manual,
			lines: [
				makeLine({ lineId: 'a', unitMinor: 1000, quantity: 4 }),
				makeLine({ lineId: 'b', itemId: 'fries', unitMinor: 300 }),
			],
			amountMinor: 500,
		})
		expect(quote).toEqual({ ok: true, amountMinor: 500 })
	})

	it('a fixed manual discount from the definition stays per item', () => {
		const manual = makeDiscount({
			application: 'manual',
			valueType: 'fixed',
			percentBp: null,
			amountMinor: 100,
			currency: 'USD',
			target: burgers,
		})
		const quote = quoteManualDiscount({
			discount: manual,
			lines: [makeLine({ unitMinor: 1000, quantity: 4 })],
		})
		expect(quote).toEqual({ ok: true, amountMinor: 400 })
	})
})

describe('currency of a buy-side spend', () => {
	it('refuses "spend 30 on burgers" stored in another currency', () => {
		const deal = makeDiscount({
			percentBp: 10_000,
			currency: 'SAR',
			quantityRule: {
				kind: 'buy_get',
				buy: { spendMinor: 3000, itemIds: ['burger'], categoryIds: [] },
				get: { quantity: 1, itemIds: ['fries'], categoryIds: [] },
			},
		})
		const result = evaluateDiscounts(
			makeInput({
				currency: 'USD',
				lines: [
					makeLine({ lineId: 'a', unitMinor: 5000 }),
					makeLine({ lineId: 'b', itemId: 'fries', unitMinor: 300 }),
				],
				discounts: [deal],
			}),
		)
		expect(result.totalDiscountMinor).toBe(0)
		expect(
			evaluateDiscounts(
				makeInput({
					currency: 'SAR',
					lines: [
						makeLine({ lineId: 'a', unitMinor: 5000 }),
						makeLine({ lineId: 'b', itemId: 'fries', unitMinor: 300 }),
					],
					discounts: [deal],
				}),
			).totalDiscountMinor,
		).toBe(300)
	})
})

describe('input guards', () => {
	const run = (line: Partial<Parameters<typeof makeLine>[0]>) => () =>
		evaluateDiscounts(
			makeInput({
				lines: [makeLine(line)],
				discounts: [makeDiscount()],
			}),
		)

	it('refuses quantities and prices no order can carry', () => {
		expect(run({ quantity: 1_000_000_000 })).toThrow(RangeError)
		expect(run({ quantity: 51 })).toThrow(RangeError)
		expect(run({ quantity: 0 })).toThrow(RangeError)
		expect(run({ quantity: 1.5 })).toThrow(RangeError)
		expect(run({ quantity: Number.NaN })).toThrow(RangeError)
		expect(run({ unitMinor: -100 })).toThrow(RangeError)
		expect(run({ unitMinor: 10.5 })).toThrow(RangeError)
		expect(run({ quantity: 50 })).not.toThrow()
	})

	it('caps the units in one evaluation', () => {
		const lines = Array.from({ length: 101 }, (_, index) =>
			makeLine({ lineId: String(index), quantity: 50 }),
		)
		expect(() =>
			evaluateDiscounts(makeInput({ lines, discounts: [makeDiscount()] })),
		).toThrow(RangeError)
	})
})

describe('a wall clock that cannot be read', () => {
	it('applies no dated or scheduled discount, but undated ones still do', () => {
		const dated = makeDiscount({
			id: 'dated',
			combinable: true,
			endsAt: '2026-12-31T00:00',
		})
		const scheduled = makeDiscount({
			id: 'scheduled',
			combinable: true,
			schedule: [{ day: 5, start: '00:00', end: '23:59' }],
		})
		const plain = makeDiscount({ id: 'plain', combinable: true })
		for (const localNow of ['', 'not a time', '2026-02-31T12:00']) {
			const result = evaluateDiscounts(
				makeInput({
					context: makeContext({ localNow }),
					discounts: [dated, scheduled, plain],
				}),
			)
			expect(result.applied.map((a) => a.discountId)).toEqual(['plain'])
		}
	})
})

describe('ties between equal priorities', () => {
	it('go to the older discount by instant, not by text', () => {
		// The same day: 09:00 at +03:00 is 06:00Z, before 08:00Z, although its
		// text sorts after.
		const older = makeDiscount({
			id: 'z-older',
			percentBp: 1000,
			createdAt: '2026-01-01T09:00:00+03:00',
		})
		const newer = makeDiscount({
			id: 'a-newer',
			percentBp: 1000,
			createdAt: '2026-01-01T08:00:00.000Z',
		})
		const result = evaluateDiscounts(makeInput({ discounts: [newer, older] }))
		expect(result.applied.map((a) => a.discountId)).toEqual(['z-older'])
	})
})
