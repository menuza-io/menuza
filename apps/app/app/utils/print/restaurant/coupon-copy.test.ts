import { describe, expect, it } from 'vitest'
import {
	couponCopy,
	isPrintableOffer,
	type CouponOffer,
} from './coupon-copy.ts'

const NOW = Date.UTC(2026, 10, 1, 12, 0) // 1 November 2026, noon UTC

const base: CouponOffer = {
	name: 'Welcome offer',
	application: 'code',
	valueType: 'percent',
	percentBp: 1000,
	amountMinor: null,
	hasTiers: false,
	minSubtotalMinor: null,
	startsAt: null,
	endsAt: null,
	eligibility: 'everyone',
	perCustomerLimit: null,
	fulfillments: ['pickup', 'delivery', 'dine_in'],
	channels: ['web', 'qr'],
	currency: 'USD',
	onlyLocationName: null,
}

const copy = (offer: Partial<CouponOffer>, locale = 'en') =>
	couponCopy({ ...base, ...offer }, locale, NOW)

describe('coupon headline', () => {
	it('names a percentage or an amount off', () => {
		expect(copy({}).headline).toBe('10% off')
		expect(copy({ percentBp: 1250 }).headline).toBe('12.5% off')
		expect(
			copy({ valueType: 'fixed', percentBp: null, amountMinor: 500 }).headline,
		).toBe('$5 off')
		expect(
			copy(
				{
					valueType: 'fixed',
					percentBp: null,
					amountMinor: 500,
					currency: 'SAR',
				},
				'de',
			).headline,
		).toMatch(/5.*Rabatt/)
	})

	it('says free delivery, and falls back to the name for deals and ladders', () => {
		expect(
			copy({ valueType: 'free_delivery', percentBp: null }, 'fr').headline,
		).toBe('Livraison gratuite')
		expect(copy({ hasTiers: true }).headline).toBe('Welcome offer')
		expect(copy({ valueType: 'fixed_price', percentBp: null }).headline).toBe(
			'Welcome offer',
		)
	})
})

describe('coupon terms', () => {
	it('states only that a code works online when nothing else limits it', () => {
		expect(copy({}).body).toBe('Online orders only.')
	})

	it('lists every term a customer could be turned away for', () => {
		expect(
			copy({
				endsAt: '2027-01-01T00:00',
				eligibility: 'new_customer',
				fulfillments: ['pickup'],
				onlyLocationName: 'Downtown',
				minSubtotalMinor: 2000,
			}).body,
		).toBe(
			// A midnight end is exclusive: the last day is the one before.
			'Valid until December 31, 2026. First order only. Pickup orders only. At Downtown only. Online orders only. Minimum order $20.',
		)
	})

	it('gives a future start, and drops a start already passed', () => {
		expect(
			copy({ startsAt: '2026-12-01T00:00', endsAt: '2026-12-15T17:00' }).body,
		).toMatch(/^Valid December 1, 2026 to December 15, 2026\./)
		expect(copy({ startsAt: '2026-10-01T00:00' }).body).toBe(
			'Online orders only.',
		)
	})

	it('says one per customer for a single lifetime use', () => {
		expect(
			copy({ perCustomerLimit: { count: 1, period: 'lifetime' } }).body,
		).toContain('One per customer.')
		expect(
			copy({ perCustomerLimit: { count: 1, period: 'day' } }).body,
		).not.toContain('One per customer.')
	})

	it('lets an automatic offer the till also applies work in person', () => {
		const automatic = { application: 'automatic', channels: ['web', 'pos'] }
		expect(copy(automatic).body).toBe('')
		expect(copy(automatic).callToAction).toBe(
			'Scan to order. The offer applies by itself.',
		)
		expect(copy({}).callToAction).toBe(
			'Scan to order. Your code is added for you.',
		)
	})

	it('fits every locale in the call-to-action limit', () => {
		for (const locale of ['en', 'ar', 'es', 'fr', 'de', 'zh']) {
			for (const application of ['code', 'automatic']) {
				const words = couponCopy({ ...base, application }, locale, NOW)
				expect(words.callToAction.length).toBeLessThanOrEqual(60)
				expect(words.callToAction).toMatch(/[.。]$/)
			}
		}
	})
})

describe('isPrintableOffer', () => {
	it('needs the web channel and no till-only manual discount', () => {
		expect(isPrintableOffer(base, NOW)).toBe(true)
		expect(isPrintableOffer({ ...base, channels: ['pos'] }, NOW)).toBe(false)
		expect(isPrintableOffer({ ...base, application: 'manual' }, NOW)).toBe(
			false,
		)
	})

	it('refuses an offer only once it has ended in every time zone', () => {
		expect(isPrintableOffer({ ...base, endsAt: '2026-10-31T00:00' }, NOW)).toBe(
			false,
		)
		// Ended at 08:00 local: still running somewhere west of UTC−4.
		expect(isPrintableOffer({ ...base, endsAt: '2026-11-01T08:00' }, NOW)).toBe(
			true,
		)
	})
})
