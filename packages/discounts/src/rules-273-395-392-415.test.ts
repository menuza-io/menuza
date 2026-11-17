import { describe, expect, it } from 'vitest'
import { discountDefinitionSchema } from './definition.ts'
import { evaluateDiscounts } from './evaluate.ts'
import {
	makeContext,
	makeDiscount,
	makeInput,
	makeLine,
} from './test-fixtures.ts'

const pizzas = {
	scope: 'items' as const,
	itemIds: ['pizza'],
	categoryIds: [],
	excludeItemIds: [],
	excludeCategoryIds: [],
}

const line = (lineId: string, unitMinor: number, quantity = 1) =>
	makeLine({ lineId, itemId: 'pizza', unitMinor, quantity })

function parse(overrides: Record<string, unknown>) {
	const {
		id: ignoredId,
		version: ignoredVersion,
		createdAt: ignoredCreatedAt,
		...definition
	} = makeDiscount(overrides)
	return discountDefinitionSchema.safeParse(definition)
}

describe('a percentage capped at an amount (#273)', () => {
	const capped = makeDiscount({
		percentBp: 2000,
		maxDiscountMinor: 1500,
		currency: 'USD',
	})

	it('takes exactly the cap off a 200.00 order', () => {
		const result = evaluateDiscounts(
			makeInput({
				lines: [makeLine({ unitMinor: 20_000 })],
				discounts: [capped],
			}),
		)
		expect(result.totalDiscountMinor).toBe(1500)
	})

	it('takes the plain percentage when it is under the cap', () => {
		const result = evaluateDiscounts(
			makeInput({
				lines: [makeLine({ unitMinor: 5000 })],
				discounts: [capped],
			}),
		)
		expect(result.totalDiscountMinor).toBe(1000)
	})

	it('spreads the capped amount over the lines in proportion, so a refund returns the right share', () => {
		const result = evaluateDiscounts(
			makeInput({
				lines: [
					makeLine({ lineId: 'a', unitMinor: 12_000 }),
					makeLine({ lineId: 'b', unitMinor: 8000 }),
				],
				discounts: [capped],
			}),
		)
		expect(result.lineDiscounts).toEqual({ a: 900, b: 600 })
		expect(result.applied[0]!.lines.map((l) => l.amountMinor)).toEqual([
			900, 600,
		])
	})

	it('applies to that discount only: a stacked one is not capped by it', () => {
		const delivery = makeDiscount({
			id: 'free',
			valueType: 'free_delivery',
			percentBp: null,
			combinable: true,
			fulfillments: ['delivery'],
		})
		const result = evaluateDiscounts(
			makeInput({
				lines: [makeLine({ unitMinor: 20_000 })],
				context: makeContext({
					fulfillment: 'delivery',
					deliveryFeeMinor: 500,
				}),
				discounts: [{ ...capped, combinable: true }, delivery],
			}),
		)
		expect(result.totalDiscountMinor).toBe(1500 + 500)
	})
})

describe('an item limit covers only that many items (#273)', () => {
	it('discounts only two of three eligible items', () => {
		const result = evaluateDiscounts(
			makeInput({
				lines: [line('a', 1000), line('b', 2000), line('c', 3000)],
				discounts: [
					makeDiscount({
						percentBp: 5000,
						target: pizzas,
						maxDiscountedUnits: 2,
					}),
				],
			}),
		)
		expect(Object.keys(result.lineDiscounts).sort()).toEqual(['b', 'c'])
		expect(result.totalDiscountMinor).toBe(2500)
	})

	it('counts units across a quantity, not lines', () => {
		const result = evaluateDiscounts(
			makeInput({
				lines: [line('a', 1000, 5)],
				discounts: [
					makeDiscount({
						percentBp: 10_000,
						target: pizzas,
						maxDiscountedUnits: 2,
					}),
				],
			}),
		)
		expect(result.totalDiscountMinor).toBe(2000)
		expect(result.applied[0]!.lines[0]!.units).toBe(2)
	})

	it('takes the cap and the item limit together', () => {
		const result = evaluateDiscounts(
			makeInput({
				lines: [line('a', 4000), line('b', 4000), line('c', 4000)],
				discounts: [
					makeDiscount({
						percentBp: 5000,
						target: pizzas,
						maxDiscountedUnits: 2,
						maxDiscountMinor: 1000,
						currency: 'USD',
					}),
				],
			}),
		)
		// 50% of two 40.00 pizzas is 40.00, held to the 10.00 cap.
		expect(result.totalDiscountMinor).toBe(1000)
	})
})

describe('which eligible item the limit covers (#395)', () => {
	const lines = () => [line('a', 1000), line('b', 3000), line('c', 2000)]
	const limited = (overrides = {}) =>
		makeDiscount({
			percentBp: 10_000,
			target: pizzas,
			maxDiscountedUnits: 1,
			...overrides,
		})

	it('keeps today’s behaviour, the dearest item, when nothing is chosen', () => {
		const result = evaluateDiscounts(
			makeInput({ lines: lines(), discounts: [limited()] }),
		)
		expect(result.lineDiscounts).toEqual({ b: 3000 })
	})

	it('discounts the dearest item when asked', () => {
		const result = evaluateDiscounts(
			makeInput({
				lines: lines(),
				discounts: [limited({ itemChoice: 'dearest' })],
			}),
		)
		expect(result.lineDiscounts).toEqual({ b: 3000 })
	})

	it('discounts the cheapest item when asked', () => {
		const result = evaluateDiscounts(
			makeInput({
				lines: lines(),
				discounts: [limited({ itemChoice: 'cheapest' })],
			}),
		)
		expect(result.lineDiscounts).toEqual({ a: 1000 })
	})

	it('takes the cheapest two of three', () => {
		const result = evaluateDiscounts(
			makeInput({
				lines: lines(),
				discounts: [limited({ itemChoice: 'cheapest', maxDiscountedUnits: 2 })],
			}),
		)
		expect(result.lineDiscounts).toEqual({ a: 1000, c: 2000 })
	})

	it('breaks a tie the same way whatever order the lines are in', () => {
		const tied = [line('a', 1000), line('b', 1000), line('c', 1000)]
		for (const itemChoice of ['cheapest', 'dearest'] as const) {
			const one = evaluateDiscounts(
				makeInput({
					lines: tied,
					discounts: [limited({ itemChoice })],
				}),
			)
			const other = evaluateDiscounts(
				makeInput({
					lines: [...tied].reverse(),
					discounts: [limited({ itemChoice })],
				}),
			)
			expect(other.lineDiscounts).toEqual(one.lineDiscounts)
			expect(Object.keys(one.lineDiscounts)).toEqual(['a'])
		}
	})

	it('picks from one line’s units when the item is ordered more than once', () => {
		const result = evaluateDiscounts(
			makeInput({
				lines: [line('a', 1000, 2), line('b', 500)],
				discounts: [limited({ itemChoice: 'cheapest' })],
			}),
		)
		expect(result.lineDiscounts).toEqual({ b: 500 })
	})

	it('orders a set price by the item’s base the same way', () => {
		const result = evaluateDiscounts(
			makeInput({
				lines: [line('a', 1000), line('b', 3000)],
				discounts: [
					limited({
						valueType: 'fixed_price',
						percentBp: null,
						amountMinor: 200,
						currency: 'USD',
						itemChoice: 'cheapest',
					}),
				],
			}),
		)
		expect(result.lineDiscounts).toEqual({ a: 800 })
	})

	it('needs an item limit, and an item or category target without a deal rule', () => {
		expect(parse({ itemChoice: 'cheapest' }).success).toBe(false)
		expect(
			parse({
				itemChoice: 'cheapest',
				target: pizzas,
				maxDiscountedUnits: 1,
			}).success,
		).toBe(true)
		expect(
			parse({
				itemChoice: 'cheapest',
				target: pizzas,
				maxDiscountedUnits: 1,
				quantityRule: { kind: 'bogo', buyQuantity: 1, getQuantity: 1 },
			}).success,
		).toBe(false)
		expect(
			parse({
				itemChoice: 'cheapest',
				maxDiscountedUnits: 1,
			}).success,
		).toBe(false)
	})

	it('still parses a stored definition that has no choice at all', () => {
		expect(parse({ target: pizzas, maxDiscountedUnits: 1 }).success).toBe(true)
	})
})

describe('a weekly budget (#392)', () => {
	const budgeted = makeDiscount({
		percentBp: 1000,
		currency: 'USD',
		weeklyBudgetMinor: 10_000,
	})
	const withSpend = (weekGivenMinor: number | undefined) =>
		evaluateDiscounts(
			makeInput({
				lines: [makeLine({ unitMinor: 5000 })],
				discounts: [budgeted],
				usage: { [budgeted.id]: usageOf(weekGivenMinor) },
			}),
		)

	function usageOf(weekGivenMinor: number | undefined) {
		return {
			total: 0,
			customerLifetime: 0,
			customerDay: 0,
			customerWeek: 0,
			...(weekGivenMinor === undefined ? {} : { weekGivenMinor }),
		}
	}

	it('applies while the week’s spend is under the budget', () => {
		expect(withSpend(0).totalDiscountMinor).toBe(500)
		expect(withSpend(9999).totalDiscountMinor).toBe(500)
		expect(withSpend(undefined).totalDiscountMinor).toBe(500)
	})

	it('stops applying once 100.00 has been given', () => {
		expect(withSpend(10_000).totalDiscountMinor).toBe(0)
		expect(withSpend(25_000).totalDiscountMinor).toBe(0)
	})

	it('lets the order that crosses the budget keep its full discount', () => {
		expect(withSpend(9900).totalDiscountMinor).toBe(500)
	})

	it('resumes when the new week’s spend starts from nothing', () => {
		expect(withSpend(0).applied).toHaveLength(1)
	})

	it('refuses a typed code for it with limit_reached', () => {
		const coupon = makeDiscount({
			id: 'c1',
			application: 'code',
			currency: 'USD',
			weeklyBudgetMinor: 500,
		})
		const result = evaluateDiscounts(
			makeInput({
				lines: [makeLine({ unitMinor: 5000 })],
				discounts: [coupon],
				codes: [
					{
						id: 'code1',
						discountId: 'c1',
						normalizedCode: 'SAVE10',
						maxUses: null,
					},
				],
				usage: { c1: usageOf(500) },
				code: 'save10',
			}),
		)
		expect(result.code).toEqual({ status: 'refused', reason: 'limit_reached' })
	})

	it('is read in the order’s currency, so another currency does not apply it', () => {
		const result = evaluateDiscounts(
			makeInput({
				currency: 'KWD',
				lines: [makeLine({ unitMinor: 5000 })],
				discounts: [budgeted],
			}),
		)
		expect(result.totalDiscountMinor).toBe(0)
	})

	it('needs a currency and is not for a till discount', () => {
		expect(parse({ weeklyBudgetMinor: 100, currency: null }).success).toBe(
			false,
		)
		expect(parse({ weeklyBudgetMinor: 100, currency: 'USD' }).success).toBe(
			true,
		)
		expect(
			parse({
				application: 'manual',
				weeklyBudgetMinor: 100,
				currency: 'USD',
			}).success,
		).toBe(false)
	})
})

describe('a saved audience (#415)', () => {
	const audience = makeDiscount({
		eligibility: 'signed_in',
		audienceId: 'aud1',
	})
	const run = (customer: Partial<ReturnType<typeof makeContext>['customer']>) =>
		evaluateDiscounts(
			makeInput({
				lines: [makeLine({ unitMinor: 5000 })],
				context: makeContext({
					customer: {
						signedIn: true,
						isNewCustomer: false,
						isLoyaltyMember: false,
						...customer,
					},
				}),
				discounts: [audience],
			}),
		)

	it('applies to a member of the audience', () => {
		expect(run({ audienceIds: ['aud1'] }).totalDiscountMinor).toBe(500)
	})

	it('does not apply to a signed-in guest who is not a member', () => {
		expect(run({ audienceIds: ['other'] }).totalDiscountMinor).toBe(0)
		expect(run({ audienceIds: [] }).totalDiscountMinor).toBe(0)
		expect(run({}).totalDiscountMinor).toBe(0)
	})

	it('never applies to a guest with no identity, even one listed', () => {
		const result = evaluateDiscounts(
			makeInput({
				lines: [makeLine({ unitMinor: 5000 })],
				context: makeContext({
					customer: {
						signedIn: false,
						isNewCustomer: false,
						isLoyaltyMember: false,
						audienceIds: ['aud1'],
					},
				}),
				discounts: [audience],
			}),
		)
		expect(result.totalDiscountMinor).toBe(0)
	})

	it('answers a code for a non-member with not_found, revealing nothing', () => {
		const coupon = makeDiscount({
			id: 'c1',
			application: 'code',
			eligibility: 'signed_in',
			audienceId: 'aud1',
		})
		const result = evaluateDiscounts(
			makeInput({
				lines: [makeLine({ unitMinor: 5000 })],
				context: makeContext({
					customer: {
						signedIn: true,
						isNewCustomer: false,
						isLoyaltyMember: false,
						audienceIds: [],
					},
				}),
				discounts: [coupon],
				codes: [
					{
						id: 'code1',
						discountId: 'c1',
						normalizedCode: 'SAVE10',
						maxUses: null,
					},
				],
				code: 'SAVE10',
			}),
		)
		expect(result.code).toEqual({ status: 'refused', reason: 'not_found' })
	})

	it('needs a signed-in eligibility and is not for a till discount', () => {
		expect(parse({ audienceId: 'aud1' }).success).toBe(false)
		expect(
			parse({ audienceId: 'aud1', eligibility: 'signed_in' }).success,
		).toBe(true)
		expect(
			parse({
				audienceId: 'aud1',
				eligibility: 'signed_in',
				application: 'manual',
			}).success,
		).toBe(false)
	})

	it('leaves other discounts alone', () => {
		const plain = makeDiscount({ id: 'plain', percentBp: 500, combinable: true })
		const result = evaluateDiscounts(
			makeInput({
				lines: [makeLine({ unitMinor: 5000 })],
				discounts: [{ ...audience, combinable: true }, plain],
			}),
		)
		expect(result.applied.map((entry) => entry.discountId)).toEqual(['plain'])
	})
})
