import { describe, expect, it } from 'vitest'
import { LOYALTY_MAX_POINTS } from './money.ts'
import { LOYALTY_MULTIPLIER_ONE_BP } from './promotions.ts'
import {
	addCalendarMonths,
	applyTierMultiplier,
	evaluateMemberTier,
	LOYALTY_MAX_TIERS,
	loyaltyTiersConfigSchema,
	memberMeetsTier,
	resolveTierByMetric,
	type LoyaltyTiersConfig,
} from './tiers.ts'

const CONFIG: LoyaltyTiersConfig = {
	enabled: true,
	metric: 'qualifying_points',
	periodMonths: 12,
	graceDays: 30,
	tiers: [
		{ id: 'silver', name: 'Silver', threshold: 200, multiplierBp: 12_500 },
		{ id: 'gold', name: 'Gold', threshold: 500, multiplierBp: 15_000 },
		{ id: 'vip', name: 'VIP', threshold: 1000, multiplierBp: 20_000 },
	],
}

describe('loyaltyTiersConfigSchema', () => {
	it('accepts up to four strictly ascending tiers and validates duplicates and empty enabled configs', () => {
		expect(loyaltyTiersConfigSchema.safeParse(CONFIG).success).toBe(true)

		expect(
			loyaltyTiersConfigSchema.safeParse({ ...CONFIG, tiers: [] }).success,
		).toBe(false)

		const tooMany = Array.from({ length: LOYALTY_MAX_TIERS + 1 }, (_, i) => ({
			id: `t${i}`,
			name: `Tier ${i}`,
			threshold: (i + 1) * 100,
			multiplierBp: LOYALTY_MULTIPLIER_ONE_BP,
		}))
		expect(
			loyaltyTiersConfigSchema.safeParse({ ...CONFIG, tiers: tooMany }).success,
		).toBe(false)

		expect(
			loyaltyTiersConfigSchema.safeParse({
				...CONFIG,
				tiers: [
					{
						id: 'silver',
						name: 'Silver',
						threshold: 200,
						multiplierBp: 12_500,
					},
					{
						id: 'silver2',
						name: 'silver',
						threshold: 300,
						multiplierBp: 15_000,
					},
				],
			}).success,
		).toBe(false)

		expect(
			loyaltyTiersConfigSchema.safeParse({
				...CONFIG,
				tiers: [
					{
						id: 'silver',
						name: 'Silver',
						threshold: 500,
						multiplierBp: 12_500,
					},
					{ id: 'gold', name: 'Gold', threshold: 500, multiplierBp: 15_000 },
				],
			}).success,
		).toBe(false)
	})
})

describe('tier math and evaluation', () => {
	it('floors multiplied points and respects the ledger cap', () => {
		expect(applyTierMultiplier(100, 15_000)).toBe(150)
		expect(applyTierMultiplier(3, 15_000)).toBe(4)
		expect(applyTierMultiplier(0, 20_000)).toBe(0)
		expect(applyTierMultiplier(LOYALTY_MAX_POINTS, 20_000)).toBe(
			LOYALTY_MAX_POINTS,
		)
	})

	it('clamps calendar month additions cleanly across short months and leap years', () => {
		const jan31 = Date.UTC(2025, 0, 31, 14, 30)
		expect(new Date(addCalendarMonths(jan31, 1)).toISOString()).toBe(
			'2025-02-28T14:30:00.000Z',
		)
		const jan31Leap = Date.UTC(2024, 0, 31, 9, 0)
		expect(new Date(addCalendarMonths(jan31Leap, 1)).toISOString()).toBe(
			'2024-02-29T09:00:00.000Z',
		)
	})

	it('upgrades on earn, protects on non-refund earn, and enforces tier-only rewards', () => {
		const t0 = Date.UTC(2026, 0, 15)
		expect(resolveTierByMetric(CONFIG.tiers, 199)).toEqual({
			tier: null,
			rank: 0,
			nextTier: CONFIG.tiers[0],
		})
		const up = evaluateMemberTier({
			config: CONFIG,
			currentTierId: null,
			reviewAt: null,
			graceUntil: null,
			metricValue: 500,
			now: t0,
			reason: 'earn',
		})
		expect(up).toMatchObject({
			tierId: 'gold',
			changed: true,
			direction: 'upgraded',
			graceUntil: null,
		})
		expect(up.reviewAt).toBe(addCalendarMonths(t0, 12))

		// Tier-only reward check
		expect(memberMeetsTier(CONFIG, 'gold', null)).toBe(true)
		expect(memberMeetsTier(CONFIG, 'gold', 'gold')).toBe(true)
		expect(memberMeetsTier(CONFIG, 'gold', 'silver')).toBe(true)
		expect(memberMeetsTier(CONFIG, 'gold', 'vip')).toBe(false)
		expect(memberMeetsTier(CONFIG, null, 'silver')).toBe(false)
		expect(
			memberMeetsTier({ ...CONFIG, enabled: false }, 'gold', 'silver'),
		).toBe(false)
	})

	it('downgrades immediately on refund when qualifying points drop', () => {
		const t0 = Date.UTC(2026, 0, 15)
		const reviewAt = addCalendarMonths(t0, 12)
		const down = evaluateMemberTier({
			config: CONFIG,
			currentTierId: 'gold',
			reviewAt,
			graceUntil: null,
			metricValue: 250,
			now: t0 + 10_000,
			reason: 'refund',
		})
		expect(down).toMatchObject({
			tierId: 'silver',
			changed: true,
			direction: 'downgraded',
		})
	})

	it('warns ahead of review, grants grace at review, and downgrades when grace expires unless recovered', () => {
		const t0 = Date.UTC(2026, 0, 15)
		const reviewAt = addCalendarMonths(t0, 12)
		const dayMs = 24 * 60 * 60_000

		// 10 days before reviewAt while short: emit warning, keep tier
		const preWarn = evaluateMemberTier({
			config: CONFIG,
			currentTierId: 'gold',
			reviewAt,
			graceUntil: null,
			metricValue: 100,
			now: reviewAt - 10 * dayMs,
			reason: 'tick',
		})
		expect(preWarn).toMatchObject({
			tierId: 'gold',
			changed: false,
			warnDowngrade: true,
			pendingTierId: null,
			graceUntil: null,
		})

		// At reviewAt while short: start grace
		const graceStart = evaluateMemberTier({
			config: CONFIG,
			currentTierId: 'gold',
			reviewAt,
			graceUntil: null,
			metricValue: 220,
			now: reviewAt,
			reason: 'tick',
		})
		expect(graceStart).toMatchObject({
			tierId: 'gold',
			changed: false,
			graceStarted: true,
			warnDowngrade: true,
			pendingTierId: 'silver',
			graceUntil: reviewAt + 30 * dayMs,
		})

		// Recover during grace clears graceUntil
		const recovered = evaluateMemberTier({
			config: CONFIG,
			currentTierId: 'gold',
			reviewAt,
			graceUntil: graceStart.graceUntil,
			metricValue: 520,
			now: reviewAt + 5 * dayMs,
			reason: 'earn',
		})
		expect(recovered).toMatchObject({
			tierId: 'gold',
			graceUntil: null,
			changed: false,
		})

		// Still short after grace ends -> downgrade to silver
		const dropped = evaluateMemberTier({
			config: CONFIG,
			currentTierId: 'gold',
			reviewAt,
			graceUntil: graceStart.graceUntil,
			metricValue: 220,
			now: reviewAt + 30 * dayMs,
			reason: 'tick',
		})
		expect(dropped).toMatchObject({
			tierId: 'silver',
			changed: true,
			direction: 'downgraded',
			graceUntil: null,
		})
	})
})
