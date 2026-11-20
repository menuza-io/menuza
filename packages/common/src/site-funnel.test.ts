import { describe, expect, it } from 'vitest'
import {
	armFromVariant,
	assignArm,
	buildFunnel,
	changeInPoints,
	classifyDevice,
	classifyEntry,
	experimentResult,
	experimentShouldEnd,
	previousPeriod,
	readStoredArm,
	siteEventBodySchema,
} from './site-funnel'

describe('beacon body (#179)', () => {
	const ok = { event: 'visit', device: 'phone', entry: 'direct' }
	it('takes only counts: no visitor id, address or agent', () => {
		expect(siteEventBodySchema.safeParse(ok).success).toBe(true)
		for (const extra of [
			{ visitorId: 'x' },
			{ ip: '1.2.3.4' },
			{ userAgent: 'Mozilla' },
			{ referrer: 'https://x' },
		]) {
			expect(siteEventBodySchema.safeParse({ ...ok, ...extra }).success).toBe(
				false,
			)
		}
		expect(
			siteEventBodySchema.safeParse({ ...ok, event: 'purchase' }).success,
		).toBe(false)
		expect(
			siteEventBodySchema.safeParse({ ...ok, variant: 'exp1:b' }).success,
		).toBe(true)
		expect(
			siteEventBodySchema.safeParse({ ...ok, variant: 'anything' }).success,
		).toBe(false)
	})
	it('classifies the device by width', () => {
		expect(classifyDevice(375)).toBe('phone')
		expect(classifyDevice(768)).toBe('tablet')
		expect(classifyDevice(1440)).toBe('desktop')
	})
	it('classifies how a visit started from its own address', () => {
		expect(classifyEntry('?src=qr_table')).toBe('qr_table')
		expect(classifyEntry('?src=qr_poster')).toBe('qr_poster')
		expect(classifyEntry('?utm_source=news')).toBe('marketing')
		expect(classifyEntry('?coupon=WELCOME')).toBe('marketing')
		expect(classifyEntry('?src=email')).toBe('marketing')
		expect(classifyEntry('')).toBe('direct')
		expect(classifyEntry('?foo=1')).toBe('direct')
	})
})

describe('funnel (#179)', () => {
	it('counts each step once and gives step rates', () => {
		const steps = buildFunnel([
			{ event: 'visit', count: 100 },
			{ event: 'visit', count: 100 },
			{ event: 'menu_view', count: 100 },
			{ event: 'add_to_cart', count: 50 },
			{ event: 'checkout', count: 25 },
			{ event: 'order', count: 20 },
		])
		expect(steps.map((s) => s.count)).toEqual([200, 100, 50, 25, 20])
		expect(steps[0]!.rateFromPrevious).toBeNull()
		expect(steps[1]!.rateFromPrevious).toBe(0.5)
		expect(steps[4]!.rateFromStart).toBe(0.1)
	})
	it('has no rates with no visits', () => {
		const steps = buildFunnel([])
		expect(steps.every((s) => s.count === 0 && s.rateFromStart === null)).toBe(
			true,
		)
	})
	it('shows the change against the previous period in points', () => {
		expect(changeInPoints(0.12, 0.1)).toBe(2)
		expect(changeInPoints(0.08, 0.1)).toBe(-2)
		expect(changeInPoints(null, 0.1)).toBeNull()
	})
	it('the previous period is the same length right before', () => {
		expect(previousPeriod({ from: '2026-11-08', to: '2026-11-14' })).toEqual({
			from: '2026-11-01',
			to: '2026-11-07',
		})
		expect(previousPeriod({ from: '2026-11-14', to: '2026-11-14' })).toEqual({
			from: '2026-11-13',
			to: '2026-11-13',
		})
	})
})

describe('A/B arms (#338)', () => {
	it('splits visitors about evenly', () => {
		let state = 12345
		const random = () => {
			state = (state * 1664525 + 1013904223) % 4294967296
			return state / 4294967296
		}
		const arms = Array.from({ length: 10_000 }, () => assignArm(random))
		const b = arms.filter((arm) => arm === 'b').length
		expect(b).toBeGreaterThan(4800)
		expect(b).toBeLessThan(5200)
		expect(assignArm(() => 0.49)).toBe('a')
		expect(assignArm(() => 0.5)).toBe('b')
	})
	it('keeps the stored arm and ignores junk', () => {
		expect(readStoredArm('b')).toBe('b')
		expect(readStoredArm('c')).toBeNull()
		expect(readStoredArm(null)).toBeNull()
		expect(armFromVariant('exp1:a')).toBe('a')
		expect(armFromVariant('')).toBeNull()
	})
	it('says "not enough data" under the minimum', () => {
		expect(
			experimentResult({ visits: 99, orders: 10 }, { visits: 500, orders: 200 })
				.status,
		).toBe('not_enough_data')
	})
	it('names a winner only when the difference is clear', () => {
		expect(
			experimentResult(
				{ visits: 1000, orders: 100 },
				{ visits: 1000, orders: 160 },
			).status,
		).toBe('b_wins')
		expect(
			experimentResult(
				{ visits: 1000, orders: 160 },
				{ visits: 1000, orders: 100 },
			).status,
		).toBe('a_wins')
		expect(
			experimentResult(
				{ visits: 1000, orders: 100 },
				{ visits: 1000, orders: 108 },
			).status,
		).toBe('no_clear_winner')
		const lifted = experimentResult(
			{ visits: 1000, orders: 100 },
			{ visits: 1000, orders: 150 },
		)
		expect(lifted.lift).toBeCloseTo(0.5)
	})
	it('ends after 60 days or at the visitor cap', () => {
		const expiresAt = Date.UTC(2026, 11, 1)
		expect(
			experimentShouldEnd({ expiresAt, totalVisits: 10, now: expiresAt - 1 }),
		).toBeNull()
		expect(
			experimentShouldEnd({ expiresAt, totalVisits: 10, now: expiresAt }),
		).toBe('expired')
		expect(
			experimentShouldEnd({ expiresAt, totalVisits: 50_000, now: 0 }),
		).toBe('visitor_cap')
	})
})
