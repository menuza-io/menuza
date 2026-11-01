import {
	bannerOffers,
	localStamp,
	type OfferPromotion,
	offersForItem,
	promotionsForScope,
} from './offers'

function promotion(overrides: Partial<OfferPromotion> = {}): OfferPromotion {
	return {
		scope: 'order',
		itemIds: [],
		categoryIds: [],
		itemBadges: true,
		locationIds: null,
		fulfillments: null,
		startsAt: null,
		endsAt: null,
		...overrides,
	}
}

const scope = {
	locationId: 'loc_1',
	timeZone: 'America/New_York',
	modes: ['pickup', 'delivery'] as const,
}

describe('localStamp', () => {
	it('reads the clock of the zone', () => {
		expect(
			localStamp('America/New_York', new Date('2026-11-01T14:30:00Z')),
		).toBe('2026-11-01T09:30')
		expect(localStamp('Asia/Riyadh', new Date('2026-11-01T22:30:00Z'))).toBe(
			'2026-11-02T01:30',
		)
	})

	it('falls back to UTC for an unknown zone', () => {
		expect(localStamp('Nowhere/Land', new Date('2026-11-01T14:30:00Z'))).toBe(
			'2026-11-01T14:30',
		)
	})
})

describe('promotionsForScope', () => {
	const now = new Date('2026-11-01T14:30:00Z') // 09:30 in New York

	it('keeps offers for every location and every order type', () => {
		const offer = promotion()
		expect(promotionsForScope([offer], scope, now)).toEqual([offer])
	})

	it('drops offers for other locations, or any when the location is unknown', () => {
		const here = promotion({ locationIds: ['loc_1'] })
		const there = promotion({ locationIds: ['loc_2'] })
		expect(promotionsForScope([here, there], scope, now)).toEqual([here])
		expect(
			promotionsForScope([here], { ...scope, locationId: null }, now),
		).toEqual([])
	})

	it('checks the time window in the location zone', () => {
		const notYet = promotion({ startsAt: '2026-11-01T10:00' })
		const over = promotion({ endsAt: '2026-11-01T09:00' })
		const open = promotion({
			startsAt: '2026-11-01T09:00',
			endsAt: '2026-11-01T10:00',
		})
		expect(promotionsForScope([notYet, over, open], scope, now)).toEqual([open])
	})

	it('drops offers for order types this app cannot start', () => {
		const dineIn = promotion({ fulfillments: ['dine_in'] })
		const delivery = promotion({ fulfillments: ['delivery', 'dine_in'] })
		expect(promotionsForScope([dineIn, delivery], scope, now)).toEqual([
			delivery,
		])
	})
})

describe('offersForItem', () => {
	it('matches an item, its direct category, or the whole order', () => {
		const order = promotion()
		const item = promotion({ scope: 'items', itemIds: ['item_1'] })
		const category = promotion({ scope: 'categories', categoryIds: ['cat_2'] })
		const other = promotion({ scope: 'items', itemIds: ['item_9'] })
		expect(offersForItem([item], 'item_1', ['cat_1'])).toEqual([item])
		expect(offersForItem([category], 'x', ['cat_2'])).toEqual([category])
		expect(offersForItem([category], 'x', ['cat_1'])).toEqual([])
		expect(offersForItem([order, other], 'item_1', [])).toEqual([order])
	})

	it('skips offers without item badges and stops at two', () => {
		const quiet = promotion({ itemBadges: false })
		const a = promotion()
		const b = promotion()
		const c = promotion()
		expect(offersForItem([quiet, a, b, c], 'item_1', [])).toEqual([a, b])
	})
})

describe('bannerOffers', () => {
	it('shows three and counts the rest', () => {
		expect(bannerOffers([1, 2, 3, 4, 5])).toEqual({
			shown: [1, 2, 3],
			more: 2,
		})
		expect(bannerOffers([1])).toEqual({ shown: [1], more: 0 })
	})
})
