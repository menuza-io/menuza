import { describe, expect, it } from 'vitest'
import {
	addExpiryMonths,
	computePointExpiry,
	isTimeExpiryAllowedInRegion,
	loyaltyExpiryConfigSchema,
} from './expiry.ts'

const DAY_MS = 24 * 60 * 60_000

describe('loyaltyExpiryConfigSchema and jurisdiction rules', () => {
	it('validates month bounds and defaults', () => {
		expect(loyaltyExpiryConfigSchema.parse({})).toEqual({
			mode: 'never',
			months: 12,
			enabledAt: null,
		})
		expect(
			loyaltyExpiryConfigSchema.safeParse({ mode: 'after_earn', months: 2 })
				.success,
		).toBe(false)
		expect(
			loyaltyExpiryConfigSchema.safeParse({ mode: 'after_earn', months: 61 })
				.success,
		).toBe(false)
	})

	it('blocks time-based after_earn expiry in Canada while allowing inactivity or other regions', () => {
		expect(
			isTimeExpiryAllowedInRegion({ mode: 'after_earn', country: 'CA' }),
		).toEqual({
			allowed: false,
			reason: 'ca_expiry_prohibited',
			jurisdiction: 'Canada',
		})
		expect(
			isTimeExpiryAllowedInRegion({ mode: 'after_earn', currency: 'CAD' }),
		).toMatchObject({ allowed: false })
		expect(
			isTimeExpiryAllowedInRegion({
				mode: 'after_earn',
				timeZone: 'America/Toronto',
			}),
		).toMatchObject({ allowed: false })
		expect(
			isTimeExpiryAllowedInRegion({
				mode: 'after_earn',
				addresses: ['100 Queen St W, Toronto ON M5H 2N2'],
			}),
		).toMatchObject({ allowed: false })

		expect(
			isTimeExpiryAllowedInRegion({ mode: 'after_inactivity', country: 'CA' }),
		).toEqual({ allowed: true })
		expect(
			isTimeExpiryAllowedInRegion({
				mode: 'after_earn',
				currency: 'USD',
				timeZone: 'America/New_York',
			}),
		).toEqual({ allowed: true })
	})
})

describe('computePointExpiry', () => {
	it('expires points earned 6 months ago in after_earn mode using FIFO consumption', () => {
		const jan1 = Date.UTC(2026, 0, 1, 12, 0)
		const feb1 = Date.UTC(2026, 1, 1, 12, 0)
		const jul1 = addExpiryMonths(jan1, 6)

		// Earned 100 on Jan 1, earned 80 on Feb 1, spent 40 -> 60 remain from Jan 1.
		const res = computePointExpiry({
			config: { mode: 'after_earn', months: 6, enabledAt: null },
			entries: [
				{
					id: 'e1',
					type: 'earn',
					delta: 100,
					createdAt: jan1,
					purchaseId: 'p1',
				},
				{
					id: 'e2',
					type: 'earn',
					delta: 80,
					createdAt: feb1,
					purchaseId: 'p2',
				},
				{ id: 'r1', type: 'redeem', delta: -40, createdAt: feb1 + 1000 },
			],
			currentBalance: 140,
			lastActivityAt: feb1,
			now: jul1,
		})
		expect(res.expiredDue).toBe(60)
		expect(res.nextExpiryAt).toBe(addExpiryMonths(feb1, 6))
		expect(res.nextExpiryPoints).toBe(80)
	})

	it('gives pre-existing balances a full period from enabledAt when first turned on', () => {
		const yearAgo = Date.UTC(2025, 0, 1)
		const enabledAt = Date.UTC(2026, 6, 1)
		const config = { mode: 'after_earn' as const, months: 6, enabledAt }

		// Checked 1 day after turning on expiry: nothing is due! Full 6 months left.
		const rightAfterTurnOn = computePointExpiry({
			config,
			entries: [
				{
					id: 'e1',
					type: 'earn',
					delta: 150,
					createdAt: yearAgo,
					purchaseId: 'p1',
				},
			],
			currentBalance: 150,
			lastActivityAt: yearAgo,
			now: enabledAt + DAY_MS,
		})
		expect(rightAfterTurnOn.expiredDue).toBe(0)
		expect(rightAfterTurnOn.nextExpiryAt).toBe(addExpiryMonths(enabledAt, 6))
		expect(rightAfterTurnOn.nextExpiryPoints).toBe(150)

		// Same guarantee for inactivity mode
		const inactivity = computePointExpiry({
			config: { mode: 'after_inactivity', months: 6, enabledAt },
			entries: [{ id: 'e1', type: 'earn', delta: 150, createdAt: yearAgo }],
			currentBalance: 150,
			lastActivityAt: yearAgo,
			now: enabledAt + DAY_MS,
		})
		expect(inactivity.expiredDue).toBe(0)
		expect(inactivity.nextExpiryAt).toBe(addExpiryMonths(enabledAt, 6))
	})

	it('tracks 30-day and 7-day warning buckets and inactivity expiry', () => {
		const jan1 = Date.UTC(2026, 0, 1, 12, 0)
		const exp = addExpiryMonths(jan1, 6)

		const warn25d = computePointExpiry({
			config: { mode: 'after_inactivity', months: 6, enabledAt: null },
			entries: [{ id: 'e1', type: 'earn', delta: 200, createdAt: jan1 }],
			currentBalance: 200,
			lastActivityAt: jan1,
			now: exp - 25 * DAY_MS,
		})
		expect(warn25d.expiredDue).toBe(0)
		expect(warn25d.expiringWithin30d).toBe(200)
		expect(warn25d.expiringWithin7d).toBe(0)

		const warn5d = computePointExpiry({
			config: { mode: 'after_inactivity', months: 6, enabledAt: null },
			entries: [{ id: 'e1', type: 'earn', delta: 200, createdAt: jan1 }],
			currentBalance: 200,
			lastActivityAt: jan1,
			now: exp - 5 * DAY_MS,
		})
		expect(warn5d.expiringWithin30d).toBe(200)
		expect(warn5d.expiringWithin7d).toBe(200)

		const due = computePointExpiry({
			config: { mode: 'after_inactivity', months: 6, enabledAt: null },
			entries: [{ id: 'e1', type: 'earn', delta: 200, createdAt: jan1 }],
			currentBalance: 200,
			lastActivityAt: jan1,
			now: exp,
		})
		expect(due.expiredDue).toBe(200)
	})
})
