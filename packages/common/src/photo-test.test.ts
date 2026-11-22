import { describe, expect, it } from 'vitest'
import {
	assignPhotoVariant,
	evaluatePhotoTest,
	hashString,
	isCrawlerUserAgent,
	orderCountsAsPhotoTestWin,
	PHOTO_TEST_MIN_VIEWS,
	photoTestDayKey,
} from './photo-test.ts'

const BROWSER =
	'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1'

describe('assignPhotoVariant', () => {
	it('is stable for one visitor', () => {
		const first = assignPhotoVariant({
			testId: 't1',
			clientId: 'visitor-1',
			userAgent: BROWSER,
		})
		for (let i = 0; i < 20; i += 1) {
			expect(
				assignPhotoVariant({
					testId: 't1',
					clientId: 'visitor-1',
					userAgent: BROWSER,
				}),
			).toBe(first)
		}
	})

	it('splits visitors about half and half', () => {
		let b = 0
		const total = 4000
		for (let i = 0; i < total; i += 1) {
			if (
				assignPhotoVariant({
					testId: 'test-abc',
					clientId: `client-${i}-${i * 7919}`,
					userAgent: BROWSER,
				}) === 'B'
			)
				b += 1
		}
		expect(b / total).toBeGreaterThan(0.46)
		expect(b / total).toBeLessThan(0.54)
	})

	it('assigns the same visitor independently per test', () => {
		const variants = new Set<string>()
		for (let i = 0; i < 40; i += 1) {
			variants.add(
				assignPhotoVariant({
					testId: `t${i}`,
					clientId: 'one-visitor',
					userAgent: BROWSER,
				}),
			)
		}
		expect(variants.size).toBe(2)
	})

	it('gives search engines, previews and id-less clients photo A', () => {
		const crawlers = [
			'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
			'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
			'Mozilla/5.0 (compatible; Yahoo! Slurp)',
			'facebookexternalhit/1.1',
			'Lighthouse',
			'',
			null,
		]
		for (const userAgent of crawlers) {
			expect(isCrawlerUserAgent(userAgent)).toBe(true)
			for (let i = 0; i < 30; i += 1) {
				expect(
					assignPhotoVariant({ testId: 't', clientId: `c${i}`, userAgent }),
				).toBe('A')
			}
		}
		expect(
			assignPhotoVariant({ testId: 't', clientId: '', userAgent: BROWSER }),
		).toBe('A')
		expect(isCrawlerUserAgent(BROWSER)).toBe(false)
	})

	it('gives the customer app and delivery menus photo A', () => {
		for (let i = 0; i < 30; i += 1) {
			expect(
				assignPhotoVariant({
					testId: 't',
					clientId: `c${i}`,
					userAgent: BROWSER,
					alwaysA: true,
				}),
			).toBe('A')
		}
	})
})

describe('hashString', () => {
	it('is deterministic and spreads', () => {
		expect(hashString('a')).toBe(hashString('a'))
		expect(hashString('a')).not.toBe(hashString('b'))
	})
})

describe('evaluatePhotoTest', () => {
	const startedAt = new Date('2026-01-01T00:00:00Z')
	const enough = { views: PHOTO_TEST_MIN_VIEWS, adds: 50, orders: 10 }

	it('needs 200 views of each photo', () => {
		const outcome = evaluatePhotoTest({
			startedAt,
			now: new Date('2026-02-01T00:00:00Z'),
			a: enough,
			b: { ...enough, views: PHOTO_TEST_MIN_VIEWS - 1, orders: 90 },
		})
		expect(outcome).toEqual({ status: 'not_enough_data', reason: 'views' })
	})

	it('needs 7 days', () => {
		const outcome = evaluatePhotoTest({
			startedAt,
			now: new Date('2026-01-07T23:59:00Z'),
			a: enough,
			b: { ...enough, orders: 30 },
		})
		expect(outcome).toEqual({ status: 'not_enough_data', reason: 'days' })
		expect(
			evaluatePhotoTest({
				startedAt,
				now: new Date('2026-01-02T00:00:00Z'),
				a: { views: 1, adds: 0, orders: 0 },
				b: { views: 1, adds: 0, orders: 0 },
			}),
		).toEqual({ status: 'not_enough_data', reason: 'both' })
	})

	it('names the winner by orders per view, with the lift', () => {
		const outcome = evaluatePhotoTest({
			startedAt,
			now: new Date('2026-01-08T00:00:00Z'),
			a: { views: 400, adds: 100, orders: 20 },
			b: { views: 400, adds: 10, orders: 23.6 },
		})
		expect(outcome).toEqual({ status: 'winner', winner: 'B', liftPercent: 18 })
	})

	it('ignores adds to cart when picking', () => {
		const outcome = evaluatePhotoTest({
			startedAt,
			now: new Date('2026-01-10T00:00:00Z'),
			a: { views: 300, adds: 500, orders: 10 },
			b: { views: 300, adds: 1, orders: 12 },
		})
		expect(outcome).toMatchObject({ status: 'winner', winner: 'B' })
	})

	it('calls equal rates a tie', () => {
		expect(
			evaluatePhotoTest({
				startedAt,
				now: new Date('2026-01-10T00:00:00Z'),
				a: { views: 300, adds: 0, orders: 10 },
				b: { views: 300, adds: 0, orders: 10 },
			}),
		).toEqual({ status: 'tie' })
	})
})

describe('photoTestDayKey', () => {
	it('is the UTC day', () => {
		expect(photoTestDayKey(new Date('2026-03-04T23:59:59Z'))).toBe('2026-03-04')
	})
})

describe('orderCountsAsPhotoTestWin', () => {
	const paid = {
		status: 'completed',
		paymentMethod: 'online',
		paymentStatus: 'paid',
		totalCents: 2000,
		refundedCents: 0,
		refundReversedCents: 0,
	}

	it('counts a paid online order and a pay-at-handoff order in a sale status', () => {
		expect(orderCountsAsPhotoTestWin(paid)).toBe(true)
		for (const status of ['accepted', 'preparing', 'ready', 'completed']) {
			expect(orderCountsAsPhotoTestWin({ ...paid, status })).toBe(true)
		}
		expect(
			orderCountsAsPhotoTestWin({
				...paid,
				status: 'accepted',
				paymentMethod: 'handoff',
				paymentStatus: 'unpaid',
			}),
		).toBe(true)
	})

	it('counts a free order (nothing to pay after discounts)', () => {
		expect(
			orderCountsAsPhotoTestWin({
				...paid,
				paymentStatus: 'not_required',
				totalCents: 0,
			}),
		).toBe(true)
	})

	it('never counts orders that are not sales', () => {
		for (const status of [
			'pending_acceptance',
			'cancelled',
			'rejected',
			'expired',
			'payment_review',
			'failed',
			'pending_payment',
		]) {
			expect(orderCountsAsPhotoTestWin({ ...paid, status })).toBe(false)
		}
	})

	it('never counts an online order that is not paid', () => {
		for (const paymentStatus of [
			'unpaid',
			'pending',
			'failed',
			'expired',
			'review',
		]) {
			expect(orderCountsAsPhotoTestWin({ ...paid, paymentStatus })).toBe(false)
		}
	})

	it('drops a fully refunded order but keeps a partly refunded one', () => {
		expect(orderCountsAsPhotoTestWin({ ...paid, refundedCents: 1999 })).toBe(
			true,
		)
		expect(orderCountsAsPhotoTestWin({ ...paid, refundedCents: 2000 })).toBe(
			false,
		)
		expect(orderCountsAsPhotoTestWin({ ...paid, refundedCents: 2500 })).toBe(
			false,
		)
	})

	it('counts a refund the provider reversed as not refunded', () => {
		expect(
			orderCountsAsPhotoTestWin({
				...paid,
				refundedCents: 2000,
				refundReversedCents: 2000,
			}),
		).toBe(true)
		expect(
			orderCountsAsPhotoTestWin({
				...paid,
				refundedCents: 2000,
				refundReversedCents: 500,
			}),
		).toBe(true)
		expect(
			orderCountsAsPhotoTestWin({
				...paid,
				refundedCents: 2000,
				refundReversedCents: 0,
			}),
		).toBe(false)
	})

	it('reads missing refund figures as zero', () => {
		expect(
			orderCountsAsPhotoTestWin({
				status: 'accepted',
				paymentMethod: 'handoff',
				paymentStatus: 'unpaid',
				totalCents: 900,
			}),
		).toBe(true)
	})
})
