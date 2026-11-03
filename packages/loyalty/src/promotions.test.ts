import { describe, expect, it } from 'vitest'
import {
	computeEarning,
	computeRefundReversal,
	loyaltyPurchaseSnapshotSchema,
} from './earning.ts'
import { LOYALTY_MAX_POINTS } from './money.ts'
import { loyaltyProgramConfigSchema } from './program.ts'
import {
	computePromotionBonus,
	loyaltyPromotionSchema,
	promotionIsLive,
} from './promotions.ts'

const base = {
	id: 'p1',
	name: 'Double',
	kind: 'multiplier' as const,
	value: 20_000,
}

describe('promotion schema', () => {
	it('fills defaults: enabled, whole order, no window, every location', () => {
		const parsed = loyaltyPromotionSchema.parse(base)
		expect(parsed).toMatchObject({
			enabled: true,
			scope: { type: 'order' },
			startsAt: null,
			endsAt: null,
			recurring: null,
			locationIds: null,
			maxPointsPerPurchase: null,
		})
	})

	it.each([
		['a multiplier of 1x', { ...base, value: 10_000 }],
		['a multiplier below 1x', { ...base, value: 5_000 }],
		['a multiplier above 10x', { ...base, value: 100_001 }],
		['a flat bonus of zero', { ...base, kind: 'bonus', value: 0 }],
		['too many flat points', { ...base, kind: 'bonus', value: 100_001 }],
		['an end before the start', { ...base, startsAt: 2000, endsAt: 1000 }],
		['an end equal to the start', { ...base, startsAt: 1000, endsAt: 1000 }],
		[
			'a window that ends before it starts',
			{ ...base, recurring: { weekdays: [1], fromMinute: 600, toMinute: 600 } },
		],
		[
			'a weekday of 7',
			{ ...base, recurring: { weekdays: [7], fromMinute: 0, toMinute: 60 } },
		],
		[
			'duplicate weekdays',
			{ ...base, recurring: { weekdays: [1, 1], fromMinute: 0, toMinute: 60 } },
		],
		['an empty name', { ...base, name: '  ' }],
		['an unknown field', { ...base, extra: true }],
		[
			'a label for an item that is not chosen',
			{
				...base,
				scope: { type: 'items', itemIds: ['a'] },
				labels: { items: { b: 'Latte' }, categories: {} },
			},
		],
		['an empty location list', { ...base, locationIds: [] }],
	])('refuses %s', (_label, value) => {
		expect(loyaltyPromotionSchema.safeParse(value).success).toBe(false)
	})

	it('a program config carries promotions and a stacking rule, with defaults for an old one', () => {
		const config = {
			name: 'Club',
			unitLabel: 'points',
			currency: 'USD',
			timeZone: 'America/New_York',
			minimumSpendMinor: 0,
			earning: { method: 'spend', points: 1, perMinor: 100 },
		}
		const old = loyaltyProgramConfigSchema.parse(config)
		expect(old.promotions).toEqual([])
		expect(old.promotionStacking).toBe('best')
		const withPromotions = loyaltyProgramConfigSchema.parse({
			...config,
			promotions: [base],
			promotionStacking: 'add',
		})
		expect(withPromotions.promotions).toHaveLength(1)
		expect(
			loyaltyProgramConfigSchema.safeParse({
				...config,
				promotions: [base, base],
			}).success,
		).toBe(false)
	})
})

describe('promotionIsLive', () => {
	const at = {
		occurredAt: Date.UTC(2026, 0, 13, 20, 0),
		timeZone: 'America/New_York',
		locationId: null,
	}
	const promotion = (extra: object) =>
		loyaltyPromotionSchema.parse({ ...base, ...extra })

	it('reads the date window as [startsAt, endsAt)', () => {
		const p = promotion({ startsAt: at.occurredAt, endsAt: at.occurredAt + 1 })
		expect(promotionIsLive(p, at)).toBe(true)
		expect(promotionIsLive(p, { ...at, occurredAt: at.occurredAt - 1 })).toBe(
			false,
		)
		expect(promotionIsLive(p, { ...at, occurredAt: at.occurredAt + 1 })).toBe(
			false,
		)
	})

	it('reads weekdays and minutes in the program time zone, not UTC', () => {
		// 2026-01-14 02:00 UTC is Tuesday 21:00 in New York.
		const lateTuesday = {
			...at,
			occurredAt: Date.UTC(2026, 0, 14, 2, 0),
		}
		const tuesdayNight = promotion({
			recurring: { weekdays: [2], fromMinute: 20 * 60, toMinute: 22 * 60 },
		})
		expect(promotionIsLive(tuesdayNight, lateTuesday)).toBe(true)
		const wednesday = promotion({
			recurring: { weekdays: [3], fromMinute: 0, toMinute: 1440 },
		})
		expect(promotionIsLive(wednesday, lateTuesday)).toBe(false)
	})

	it('follows daylight saving: 15:00 local is 15:00 in July as in January', () => {
		const p = promotion({
			recurring: { weekdays: [2], fromMinute: 15 * 60, toMinute: 16 * 60 },
		})
		// Tuesday 2026-07-14 15:00 EDT (UTC-4) is 19:00 UTC.
		expect(
			promotionIsLive(p, { ...at, occurredAt: Date.UTC(2026, 6, 14, 19, 0) }),
		).toBe(true)
		expect(
			promotionIsLive(p, { ...at, occurredAt: Date.UTC(2026, 6, 14, 20, 0) }),
		).toBe(false)
	})

	it('a location list never matches a sale with no location', () => {
		const p = promotion({ locationIds: ['loc_1'] })
		expect(promotionIsLive(p, { ...at, locationId: 'loc_1' })).toBe(true)
		expect(promotionIsLive(p, { ...at, locationId: 'loc_2' })).toBe(false)
		expect(promotionIsLive(p, { ...at, locationId: null })).toBe(false)
	})
})

describe('promotion bonus bounds', () => {
	it('never takes a purchase past one ledger entry', () => {
		const snapshot = loyaltyPurchaseSnapshotSchema.parse({
			currency: 'USD',
			totalPaidMinor: 100,
			lines: [
				{
					lineId: 'l1',
					itemId: 'a',
					categoryIds: [],
					quantity: 1,
					netMinor: 100,
				},
			],
		})
		const earning = {
			points: LOYALTY_MAX_POINTS - 5,
			eligibleMinor: 100,
			reason: null,
			lines: [],
		}
		const bonus = computePromotionBonus({
			promotions: [
				loyaltyPromotionSchema.parse({ ...base, kind: 'bonus', value: 100 }),
			],
			stacking: 'best',
			earning,
			snapshot,
			occurredAt: 0,
			timeZone: 'UTC',
			locationId: null,
		})
		expect(bonus.points).toBe(5)
	})

	it('a best-stacking tie goes to the promotion listed first', () => {
		const snapshot = loyaltyPurchaseSnapshotSchema.parse({
			currency: 'USD',
			totalPaidMinor: 1000,
			lines: [
				{
					lineId: 'l1',
					itemId: 'a',
					categoryIds: [],
					quantity: 1,
					netMinor: 1000,
				},
			],
		})
		const earning = computeEarning({
			rule: { method: 'spend', points: 1, perMinor: 100 },
			minimumSpendMinor: 0,
			snapshot,
		})
		const bonus = computePromotionBonus({
			promotions: [
				loyaltyPromotionSchema.parse({
					...base,
					id: 'a',
					kind: 'bonus',
					value: 7,
				}),
				loyaltyPromotionSchema.parse({
					...base,
					id: 'b',
					kind: 'bonus',
					value: 7,
				}),
			],
			stacking: 'best',
			earning,
			snapshot,
			occurredAt: 0,
			timeZone: 'UTC',
			locationId: null,
		})
		expect(bonus.applied.map((entry) => entry.id)).toEqual(['a'])
	})
})

describe('refund reversal with a promotion bonus', () => {
	// $40.00 of merchandise, $45.00 paid. 1 point per $1 earns 40; a 2x
	// promotion adds 40, so the purchase holds 80.
	const snapshot = loyaltyPurchaseSnapshotSchema.parse({
		currency: 'USD',
		totalPaidMinor: 4500,
		lines: [
			{
				lineId: 'l1',
				itemId: 'a',
				categoryIds: [],
				quantity: 1,
				netMinor: 4000,
			},
		],
	})
	const rule = { method: 'spend', points: 1, perMinor: 100 } as const

	it('takes the bonus back in proportion, together with the base points', () => {
		let reversed = 0
		const steps: number[] = []
		for (const refundedMinor of [900, 1800, 2700, 3600, 4500]) {
			const result = computeRefundReversal({
				rule,
				minimumSpendMinor: 0,
				snapshot,
				awardedPoints: 80,
				bonusPoints: 40,
				previouslyReversedPoints: reversed,
				cumulativeRefundedMinor: refundedMinor,
			})
			steps.push(result.reversePoints)
			reversed += result.reversePoints
		}
		// Each $9 refund covers $8 of merchandise: 8 base + 8 bonus.
		expect(steps.slice(0, 4)).toEqual([16, 16, 16, 16])
		// The final full refund takes whatever is left, so nothing stays.
		expect(reversed).toBe(80)
	})

	it('is idempotent: the same cumulative refund takes back nothing more', () => {
		const first = computeRefundReversal({
			rule,
			minimumSpendMinor: 0,
			snapshot,
			awardedPoints: 80,
			bonusPoints: 40,
			previouslyReversedPoints: 0,
			cumulativeRefundedMinor: 900,
		})
		const again = computeRefundReversal({
			rule,
			minimumSpendMinor: 0,
			snapshot,
			awardedPoints: 80,
			bonusPoints: 40,
			previouslyReversedPoints: first.reversePoints,
			cumulativeRefundedMinor: 900,
		})
		expect(again.reversePoints).toBe(0)
	})

	it('with no bonus it behaves exactly as before', () => {
		const args = {
			rule,
			minimumSpendMinor: 0,
			snapshot,
			awardedPoints: 40,
			previouslyReversedPoints: 0,
			cumulativeRefundedMinor: 900,
		}
		expect(computeRefundReversal({ ...args, bonusPoints: 0 })).toEqual(
			computeRefundReversal(args),
		)
		expect(computeRefundReversal(args).reversePoints).toBe(8)
	})

	it('a refund that leaves less than the minimum takes the bonus too', () => {
		const result = computeRefundReversal({
			rule,
			minimumSpendMinor: 1000,
			snapshot,
			awardedPoints: 80,
			bonusPoints: 40,
			previouslyReversedPoints: 0,
			cumulativeRefundedMinor: 4100,
		})
		expect(result.pointsAfter).toBe(0)
		expect(result.reversePoints).toBe(80)
	})
})
