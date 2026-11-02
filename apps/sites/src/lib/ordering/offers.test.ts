import { describe, expect, it } from 'vitest'
import {
	bannerOffers,
	type OfferPromotion,
	isPromotionLive,
	localStamp,
	localizePromotion,
	offersForItem,
	promotionsForLocation,
	worksForMode,
} from './offers.ts'

type Promo = OfferPromotion & { id: string }

const promo = (overrides: Partial<Promo> = {}): Promo => ({
	id: 'p1',
	scope: 'items',
	itemIds: [],
	categoryIds: [],
	...overrides,
})

describe('localStamp', () => {
	it('reads the clock of the location, not UTC', () => {
		const now = new Date('2026-11-01T23:30:00Z')
		expect(localStamp('UTC', now)).toBe('2026-11-01T23:30')
		expect(localStamp('Asia/Riyadh', now)).toBe('2026-11-02T02:30')
		expect(localStamp('America/Los_Angeles', now)).toBe('2026-11-01T15:30')
	})

	it('never shows hour 24 at midnight', () => {
		expect(localStamp('UTC', new Date('2026-11-02T00:05:00Z'))).toBe(
			'2026-11-02T00:05',
		)
	})

	it('falls back to UTC for an unknown zone', () => {
		expect(localStamp('Not/AZone', new Date('2026-11-01T10:00:00Z'))).toBe(
			'2026-11-01T10:00',
		)
	})
})

describe('promotionsForLocation', () => {
	const now = new Date('2026-11-01T23:30:00Z')
	const options = {
		locationId: 'loc_1',
		timeZone: 'Asia/Riyadh',
		modes: ['pickup', 'dine_in'] as Array<'pickup' | 'delivery' | 'dine_in'>,
		now,
	}

	it("keeps an offer for every location, and drops another location's", () => {
		const result = promotionsForLocation(
			[
				promo({ id: 'all' }),
				promo({ id: 'here', locationIds: ['loc_1', 'loc_2'] }),
				promo({ id: 'there', locationIds: ['loc_2'] }),
			],
			options,
		)
		expect(result.map((p) => p.id)).toEqual(['all', 'here'])
	})

	it('checks the start and end in the location time zone', () => {
		// 02:30 on Nov 2 in Riyadh: a 02:00 start has begun, a 03:00 start has not.
		const result = promotionsForLocation(
			[
				promo({ id: 'begun', startsAt: '2026-11-02T02:00' }),
				promo({ id: 'later', startsAt: '2026-11-02T03:00' }),
				promo({ id: 'over', endsAt: '2026-11-02T02:00' }),
				promo({ id: 'open', endsAt: '2026-11-02T02:30' }),
			],
			options,
		)
		// `endsAt` is exclusive: at 02:30, a promo ending at 02:30 is already gone.
		expect(result.map((p) => p.id)).toEqual(['begun'])
		expect(isPromotionLive({ startsAt: null, endsAt: null }, 'x')).toBe(true)
	})

	it('respects weekly hours in the location time zone', () => {
		const result = promotionsForLocation(
			[
				promo({
					id: 'lunch',
					schedule: [{ day: 1, start: '11:00', end: '14:00' }],
				}),
			],
			options,
		)
		expect(result.map((p) => p.id)).toEqual([])
		const midday = promotionsForLocation(
			[
				promo({
					id: 'lunch',
					schedule: [{ day: 1, start: '11:00', end: '14:00' }],
				}),
			],
			{ ...options, now: new Date('2026-11-02T09:30:00Z') },
		)
		expect(midday.map((p) => p.id)).toEqual(['lunch'])
	})

	it('drops an offer for order types this page cannot place', () => {
		const result = promotionsForLocation(
			[
				promo({ id: 'delivery', fulfillments: ['delivery'] }),
				promo({ id: 'pickup', fulfillments: ['pickup'] }),
				promo({ id: 'table', fulfillments: ['dine_in'] }),
				promo({ id: 'any' }),
			],
			options,
		)
		expect(result.map((p) => p.id)).toEqual(['pickup', 'table', 'any'])
	})
})

describe('worksForMode', () => {
	it('matches the chosen order type', () => {
		expect(worksForMode(promo({ fulfillments: ['pickup'] }), 'pickup')).toBe(
			true,
		)
		expect(worksForMode(promo({ fulfillments: ['pickup'] }), 'delivery')).toBe(
			false,
		)
		expect(worksForMode(promo(), 'delivery')).toBe(true)
	})
})

describe('offersForItem', () => {
	it("matches a category offer by the item's own category only", () => {
		const pizza = promo({
			id: 'pizza',
			scope: 'categories',
			categoryIds: ['pizza'],
		})
		// An item in Pizza > Veg is passed its direct category, "veg".
		expect(offersForItem([pizza], 'margherita', ['veg'])).toEqual([])
		expect(offersForItem([pizza], 'margherita', ['pizza'])).toEqual([pizza])
	})

	it('badges an order-wide offer and a named item', () => {
		const all = promo({ id: 'all', scope: 'order' })
		const one = promo({ id: 'one', itemIds: ['burger'] })
		expect(offersForItem([all, one], 'burger', []).map((p) => p.id)).toEqual([
			'all',
			'one',
		])
		expect(offersForItem([one], 'fries', [])).toEqual([])
	})

	it('skips excluded items and items marked exclude from discounts', () => {
		const wide = promo({
			id: 'wide',
			scope: 'order',
			excludeItemIds: ['no-badge'],
		})
		expect(
			offersForItem([wide], 'no-badge', [], 2, { excludeFromDiscounts: false }),
		).toEqual([])
		expect(
			offersForItem([wide], 'ok', [], 2, { excludeFromDiscounts: true }),
		).toEqual([])
	})

	it('shows at most two badges and skips banner-only offers', () => {
		const list = [
			promo({ id: 'a', scope: 'order' }),
			promo({ id: 'banner', scope: 'order', itemBadges: false }),
			promo({ id: 'b', scope: 'order' }),
			promo({ id: 'c', scope: 'order' }),
		]
		expect(offersForItem(list, 'x', []).map((p) => p.id)).toEqual(['a', 'b'])
	})
})

describe('bannerOffers', () => {
	it('caps at three and counts the rest', () => {
		const list = ['a', 'b', 'c', 'd', 'e'].map((id) => promo({ id }))
		const { shown, more } = bannerOffers(list)
		expect(shown.map((p) => p.id)).toEqual(['a', 'b', 'c'])
		expect(more).toBe(2)
		expect(bannerOffers(list.slice(0, 2)).more).toBe(0)
	})
})

describe('localizePromotion', () => {
	const offer = {
		id: 'p1',
		name: 'Lunch deal',
		description: 'Weekdays only',
		nameI18n: { en: 'Lunch deal', ar: 'عرض الغداء', es: 'Menú del día' },
		descriptionI18n: { en: 'Weekdays only', ar: 'أيام الأسبوع فقط' },
	}

	it('picks the guest language, including a regional variant', () => {
		expect(localizePromotion(offer, 'ar')).toMatchObject({
			name: 'عرض الغداء',
			description: 'أيام الأسبوع فقط',
		})
		expect(localizePromotion(offer, 'es-MX').name).toBe('Menú del día')
	})

	it('falls back to the default language, then the canonical text', () => {
		expect(localizePromotion(offer, 'fr', 'ar').name).toBe('عرض الغداء')
		// Spanish name, no Spanish description: the default language's.
		expect(localizePromotion(offer, 'es', 'en').description).toBe(
			'Weekdays only',
		)
		expect(
			localizePromotion(
				{ id: 'p2', name: 'Happy hour', description: null },
				'ar',
				'en',
			),
		).toMatchObject({ name: 'Happy hour', description: null })
	})

	it('keeps the other fields', () => {
		expect(localizePromotion(offer, 'ar').id).toBe('p1')
	})
})
