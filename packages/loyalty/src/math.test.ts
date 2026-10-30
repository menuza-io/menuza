import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { loyaltyCartSchema, type LoyaltyCart } from './cart.ts'
import { computeRewardDiscount, totalsWithDiscount } from './discount.ts'
import {
	computeEarning,
	computeRefundReversal,
	type LoyaltyPurchaseSnapshot,
	visitDateOf,
} from './earning.ts'
import {
	allocateProportionally,
	inclusiveTaxMinor,
	LOYALTY_MAX_POINTS,
	mulDiv,
} from './money.ts'
import {
	loyaltyProgramConfigSchema,
	type LoyaltyEarningRule,
} from './program.ts'
import { type LoyaltyRewardDefinition } from './rewards.ts'

describe('mulDiv', () => {
	it('rounds in the direction asked', () => {
		expect(mulDiv(10, 1, 3)).toBe(3)
		expect(mulDiv(10, 1, 3, 'ceil')).toBe(4)
		expect(mulDiv(10, 1, 4, 'half_up')).toBe(3)
		expect(mulDiv(10, 1, 3, 'half_up')).toBe(3)
		expect(mulDiv(9, 1, 6, 'half_up')).toBe(2)
	})

	it('stays exact past 2^53 intermediate products', () => {
		expect(mulDiv(900_000_000_000, 9_999, 10_000)).toBe(899_910_000_000)
	})

	it('refuses negative or fractional input', () => {
		expect(() => mulDiv(-1, 1, 1)).toThrow(RangeError)
		expect(() => mulDiv(1.5, 1, 1)).toThrow(RangeError)
		expect(() => mulDiv(1, 1, 0)).toThrow(RangeError)
	})
})

describe('allocateProportionally', () => {
	it('gives the extra cent to the earliest largest remainder', () => {
		expect(allocateProportionally(100, [100, 100, 100])).toEqual([34, 33, 33])
		expect(allocateProportionally(2, [1, 1, 1])).toEqual([1, 1, 0])
		expect(allocateProportionally(5, [0, 0])).toEqual([5, 0])
	})

	it('always sums to the total and never exceeds a weight', () => {
		fc.assert(
			fc.property(
				fc.array(fc.integer({ min: 0, max: 1_000_000 }), {
					minLength: 1,
					maxLength: 30,
				}),
				fc.double({ min: 0, max: 1, noNaN: true }),
				(weights, fraction) => {
					const sum = weights.reduce((a, b) => a + b, 0)
					const total = Math.floor(sum * fraction)
					const shares = allocateProportionally(total, weights)
					expect(shares.reduce((a, b) => a + b, 0)).toBe(total)
					if (sum > 0) {
						shares.forEach((share, index) =>
							expect(share).toBeLessThanOrEqual(weights[index]!),
						)
					}
				},
			),
		)
	})
})

const arbitraryCart = fc
	.array(
		fc.record({
			unitBaseMinor: fc.integer({ min: 0, max: 50_000 }),
			modifiersMinor: fc.integer({ min: 0, max: 5_000 }),
			quantity: fc.integer({ min: 1, max: 20 }),
			itemId: fc.constantFrom('a', 'b', 'c', 'd'),
			categoryIds: fc.subarray(['x', 'y', 'z']),
		}),
		{ minLength: 1, maxLength: 12 },
	)
	.map((lines): LoyaltyCart =>
		loyaltyCartSchema.parse({
			currency: 'USD',
			otherDiscountMinor: 0,
			lines: lines.map((line, index) => ({
				lineId: `l${index}`,
				itemId: line.itemId,
				variantId: null,
				categoryIds: line.categoryIds,
				quantity: line.quantity,
				unitBaseMinor: line.unitBaseMinor,
				unitMinor: line.unitBaseMinor + line.modifiersMinor,
			})),
		}),
	)

const arbitraryReward: fc.Arbitrary<LoyaltyRewardDefinition> = fc
	.oneof(
		fc.record({
			kind: fc.constant('order' as const),
			discount: fc.oneof(
				fc.record({
					type: fc.constant('fixed' as const),
					amountMinor: fc.integer({ min: 1, max: 100_000 }),
				}),
				fc.record({
					type: fc.constant('percent' as const),
					percentBp: fc.integer({ min: 1, max: 10_000 }),
					maxDiscountMinor: fc.option(fc.integer({ min: 1, max: 100_000 })),
				}),
			),
		}),
		fc.record({
			kind: fc.constant('categories' as const),
			categoryIds: fc.subarray(['x', 'y', 'z'], { minLength: 1 }),
			discount: fc.record({
				type: fc.constant('percent' as const),
				percentBp: fc.integer({ min: 1, max: 10_000 }),
				maxDiscountMinor: fc.option(fc.integer({ min: 1, max: 100_000 })),
			}),
		}),
		fc.record({
			kind: fc.constant('items' as const),
			itemIds: fc.subarray(['a', 'b', 'c', 'd'], { minLength: 1 }),
			discount: fc.record({
				type: fc.constant('fixed' as const),
				amountMinor: fc.integer({ min: 1, max: 100_000 }),
			}),
		}),
		fc.record({
			kind: fc.constant('free_item' as const),
			itemId: fc.constantFrom('a', 'b', 'c', 'd'),
		}),
	)
	.map(
		(partial) =>
			({
				name: 'Reward',
				description: null,
				pointsCost: 100,
				labels: { items: {}, categories: {} },
				...partial,
			}) as LoyaltyRewardDefinition,
	)

describe('computeRewardDiscount properties', () => {
	it('never exceeds eligible merchandise and always allocates exactly', () => {
		fc.assert(
			fc.property(arbitraryCart, arbitraryReward, (cart, definition) => {
				const result = computeRewardDiscount(
					{ currency: 'USD', definition },
					cart,
				)
				if (!result.ok) {
					expect(['reward_not_applicable', 'zero_value']).toContain(result.code)
					return
				}
				expect(result.discountMinor).toBeGreaterThan(0)
				expect(result.discountMinor).toBeLessThanOrEqual(result.eligibleMinor)
				const allocated = result.lines.reduce(
					(sum, line) => sum + line.discountMinor,
					0,
				)
				expect(allocated).toBe(result.discountMinor)
				for (const share of result.lines) {
					const line = cart.lines.find((l) => l.lineId === share.lineId)!
					expect(share.discountMinor).toBeLessThanOrEqual(
						line.unitMinor * line.quantity,
					)
				}
				if (
					'discount' in definition &&
					definition.discount.type === 'percent'
				) {
					const cap = definition.discount.maxDiscountMinor
					if (cap !== null)
						expect(result.discountMinor).toBeLessThanOrEqual(cap)
				}
			}),
		)
	})
})

describe('totalsWithDiscount', () => {
	it('shrinks the exclusive tax base in proportion and tips on the discounted subtotal', () => {
		expect(
			totalsWithDiscount({
				subtotalMinor: 2000,
				taxableMinor: 2000,
				taxRatePercent: 8.875,
				taxInclusive: false,
				discountMinor: 500,
				tipPercent: 15,
			}),
		).toEqual({
			subtotalMinor: 2000,
			discountMinor: 500,
			taxMinor: 133,
			tipMinor: 225,
			feesMinor: 0,
			totalMinor: 1858,
		})
	})

	it('reports inclusive tax without adding it', () => {
		const totals = totalsWithDiscount({
			subtotalMinor: 2300,
			taxableMinor: 2300,
			taxRatePercent: 15,
			taxInclusive: true,
			discountMinor: 230,
			tipMinor: 0,
		})
		expect(totals.taxMinor).toBe(270)
		expect(totals.totalMinor).toBe(2070)
		expect(inclusiveTaxMinor(2070, 15)).toBe(270)
	})

	it('never takes off more than the subtotal', () => {
		expect(
			totalsWithDiscount({
				subtotalMinor: 300,
				taxableMinor: 300,
				taxRatePercent: 10,
				taxInclusive: false,
				discountMinor: 1000,
				feesMinor: 499,
			}).totalMinor,
		).toBe(499)
	})
})

describe('earning', () => {
	const snapshot = (lines: LoyaltyPurchaseSnapshot['lines']) => ({
		currency: 'USD',
		totalPaidMinor: lines.reduce((sum, line) => sum + line.netMinor, 0),
		lines,
	})

	it('spend earns nothing below one point', () => {
		const result = computeEarning({
			rule: { method: 'spend', points: 1, perMinor: 100 },
			minimumSpendMinor: 0,
			snapshot: snapshot([
				{
					lineId: 'l1',
					itemId: 'a',
					categoryIds: [],
					quantity: 1,
					netMinor: 99,
					rewardUnits: 0,
				},
			]),
		})
		expect(result.points).toBe(0)
		expect(result.reason).toBe('below_minimum')
	})

	it('spreads spend points over lines for reporting without changing the total', () => {
		const result = computeEarning({
			rule: { method: 'spend', points: 1, perMinor: 100 },
			minimumSpendMinor: 0,
			snapshot: snapshot([
				{
					lineId: 'l1',
					itemId: 'a',
					categoryIds: [],
					quantity: 1,
					netMinor: 550,
					rewardUnits: 0,
				},
				{
					lineId: 'l2',
					itemId: 'b',
					categoryIds: [],
					quantity: 1,
					netMinor: 550,
					rewardUnits: 0,
				},
			]),
		})
		expect(result.points).toBe(11)
		expect(result.lines.map((line) => line.points)).toEqual([6, 5])
	})

	it('caps a spend award at one ledger entry instead of overrunning it', () => {
		const result = computeEarning({
			rule: { method: 'spend', points: 100_000, perMinor: 1 },
			minimumSpendMinor: 0,
			snapshot: snapshot([
				{
					lineId: 'l1',
					itemId: 'a',
					categoryIds: [],
					quantity: 1,
					netMinor: 1001,
					rewardUnits: 0,
				},
			]),
		})
		expect(result.points).toBe(LOYALTY_MAX_POINTS)
		expect(result.lines).toEqual([
			{ lineId: 'l1', units: 1, points: LOYALTY_MAX_POINTS },
		])
	})

	it('caps item awards at one ledger entry across matching lines', () => {
		const result = computeEarning({
			rule: { method: 'items', points: 100_000, itemIds: ['a'] },
			minimumSpendMinor: 0,
			snapshot: snapshot([
				{
					lineId: 'l1',
					itemId: 'a',
					categoryIds: [],
					quantity: 1000,
					netMinor: 1000,
					rewardUnits: 0,
				},
				{
					lineId: 'l2',
					itemId: 'a',
					categoryIds: [],
					quantity: 1000,
					netMinor: 1000,
					rewardUnits: 0,
				},
			]),
		})
		expect(result.points).toBe(LOYALTY_MAX_POINTS)
		expect(result.lines.reduce((sum, line) => sum + line.points, 0)).toBe(
			LOYALTY_MAX_POINTS,
		)
	})

	it('refuses a spend rule whose points outrun its unit', () => {
		const config = {
			name: 'Program',
			unitLabel: 'points',
			currency: 'USD',
			timeZone: 'UTC',
			minimumSpendMinor: 0,
			earning: { method: 'spend', points: 5, perMinor: 1 },
			terms: 'Terms',
		}
		const refused = loyaltyProgramConfigSchema.safeParse(config)
		expect(refused.success).toBe(false)
		expect(
			!refused.success &&
				refused.error.issues.some(
					(issue) => issue.path.join('.') === 'earning.points',
				),
		).toBe(true)
		expect(
			loyaltyProgramConfigSchema.safeParse({
				...config,
				earning: { method: 'spend', points: 100, perMinor: 100 },
			}).success,
		).toBe(true)
	})

	it('uses the organization-local calendar day for visits', () => {
		const zone = 'America/New_York'
		expect(visitDateOf(Date.parse('2025-03-01T04:30:00Z'), zone)).toBe(
			'2025-02-28',
		)
		expect(visitDateOf(Date.parse('2025-03-01T05:30:00Z'), zone)).toBe(
			'2025-03-01',
		)
		expect(visitDateOf(Date.parse('2025-03-01T20:59:00Z'), 'Asia/Riyadh')).toBe(
			'2025-03-01',
		)
		expect(visitDateOf(Date.parse('2025-03-01T21:00:00Z'), 'Asia/Riyadh')).toBe(
			'2025-03-02',
		)
	})
})

describe('computeRefundReversal properties', () => {
	const arbitraryPurchase = fc.record({
		lines: fc.array(fc.integer({ min: 0, max: 100_000 }), {
			minLength: 1,
			maxLength: 8,
		}),
		extraMinor: fc.integer({ min: 0, max: 20_000 }),
		method: fc.constantFrom('spend', 'visit', 'items'),
		minimumSpendMinor: fc.integer({ min: 0, max: 50_000 }),
		refunds: fc.array(fc.integer({ min: 1, max: 60_000 }), { maxLength: 6 }),
	})

	it('takes back points monotonically, never more than awarded, all of it on a full refund', () => {
		fc.assert(
			fc.property(arbitraryPurchase, (input) => {
				const rule: LoyaltyEarningRule =
					input.method === 'spend'
						? { method: 'spend', points: 3, perMinor: 250 }
						: input.method === 'visit'
							? { method: 'visit', points: 40 }
							: { method: 'items', points: 7, itemIds: ['a'] }
				const lines = input.lines.map((netMinor, index) => ({
					lineId: `l${index}`,
					itemId: 'a',
					categoryIds: [],
					quantity: 2,
					netMinor,
					rewardUnits: 0,
				}))
				const totalPaidMinor =
					lines.reduce((sum, line) => sum + line.netMinor, 0) + input.extraMinor
				const snapshot = { currency: 'USD', totalPaidMinor, lines }
				const earned = computeEarning({
					rule,
					minimumSpendMinor: input.minimumSpendMinor,
					snapshot,
				})
				let reversed = 0
				let cumulative = 0
				let lastAfter = earned.points
				const steps = [...input.refunds, totalPaidMinor]
				for (const amount of steps) {
					cumulative = Math.min(totalPaidMinor, cumulative + amount)
					const result = computeRefundReversal({
						rule,
						minimumSpendMinor: input.minimumSpendMinor,
						snapshot,
						awardedPoints: earned.points,
						previouslyReversedPoints: reversed,
						cumulativeRefundedMinor: cumulative,
					})
					expect(result.reversePoints).toBeGreaterThanOrEqual(0)
					expect(result.pointsAfter).toBeLessThanOrEqual(lastAfter)
					lastAfter = result.pointsAfter
					reversed += result.reversePoints
					expect(reversed).toBeLessThanOrEqual(earned.points)
					const allocated = result.lines.reduce(
						(sum, line) => sum + line.refundedMinor,
						0,
					)
					expect(allocated).toBe(result.refundedEligibleMinor)
				}
				if (totalPaidMinor > 0) expect(reversed).toBe(earned.points)
			}),
		)
	})

	it('gives the same result for the same cumulative total in any order', () => {
		const rule = { method: 'spend', points: 1, perMinor: 100 } as const
		const snapshot = {
			currency: 'USD',
			totalPaidMinor: 10_000,
			lines: [
				{
					lineId: 'l1',
					itemId: 'a',
					categoryIds: [],
					quantity: 1,
					netMinor: 9_000,
					rewardUnits: 0,
				},
			],
		}
		const run = (amounts: number[]) => {
			let reversed = 0
			let cumulative = 0
			for (const amount of amounts) {
				cumulative += amount
				reversed += computeRefundReversal({
					rule,
					minimumSpendMinor: 0,
					snapshot,
					awardedPoints: 90,
					previouslyReversedPoints: reversed,
					cumulativeRefundedMinor: cumulative,
				}).reversePoints
			}
			return reversed
		}
		expect(run([1_000, 2_500, 333])).toBe(run([333, 2_500, 1_000]))
		expect(run([1_000, 2_500, 333])).toBe(run([3_833]))
	})
})
