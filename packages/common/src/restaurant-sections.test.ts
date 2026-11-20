import { describe, expect, it } from 'vitest'
import {
	containsLoginCta,
	describeOpenNow,
	dishPriceAtLocation,
	highlightShowsFromPrice,
	locationOffersOrdering,
	locationsForSection,
	orderingIsPaused,
	resolveMenuHighlights,
	visibleHeroLinks,
	type CatalogDish,
} from './restaurant-sections.ts'

const week = (slots: { start: string; end: string }[], closed: string[] = []) =>
	[
		'sunday',
		'monday',
		'tuesday',
		'wednesday',
		'thursday',
		'friday',
		'saturday',
	].map((day) => ({
		day,
		isOpen: !closed.includes(day),
		slots: closed.includes(day) ? [] : slots,
	}))

function dish(partial: Partial<CatalogDish> & { id: string }): CatalogDish {
	return {
		name: partial.id,
		description: '',
		price: 12,
		currency: 'SAR',
		imageUrl: null,
		categoryIds: [],
		isPopular: false,
		availability: 'available',
		hasOptions: false,
		...partial,
	}
}

describe('menu highlights (#86)', () => {
	const menu = [
		dish({ id: 'soup', isPopular: true, price: 18 }),
		dish({ id: 'gone', availability: 'hidden', isPopular: true }),
		dish({ id: 'off', availability: 'unavailable', isPopular: true }),
		dish({ id: 'grill', categoryIds: ['mains'], price: 40, hasOptions: true }),
		dish({ id: 'salad', categoryIds: ['mains'], price: 22 }),
	]

	it('uses popular dishes and skips hidden or unavailable ones', () => {
		expect(
			resolveMenuHighlights({ source: 'popular' }, menu).map((d) => d.id),
		).toEqual(['soup'])
	})

	it('hides the section when nothing is left', () => {
		expect(
			resolveMenuHighlights({ source: 'popular' }, [
				dish({ id: 'gone', availability: 'hidden', isPopular: true }),
			]),
		).toEqual([])
	})

	it('keeps a hand-picked order and drops dishes that are gone', () => {
		expect(
			resolveMenuHighlights(
				{ source: 'picked', itemIds: ['salad', 'missing', 'grill', 'gone'] },
				menu,
			).map((d) => d.id),
		).toEqual(['salad', 'grill'])
	})

	it('shows a chosen category', () => {
		expect(
			resolveMenuHighlights(
				{ source: 'category', categoryId: 'mains' },
				menu,
			).map((d) => d.id),
		).toEqual(['grill', 'salad'])
	})

	it('uses the default location price and marks options as from', () => {
		expect(dishPriceAtLocation(18, 21)).toBe(21)
		expect(dishPriceAtLocation(18, null)).toBe(18)
		expect(
			highlightShowsFromPrice(dish({ id: 'grill', hasOptions: true })),
		).toBe(true)
		expect(highlightShowsFromPrice(dish({ id: 'soup' }))).toBe(false)
	})
})

describe('open now (#86)', () => {
	const riyadh = 'Asia/Riyadh'

	it('stays open after midnight for an overnight slot, in the location zone', () => {
		// Saturday 01:00 in Riyadh (UTC+3) is Friday 22:00 UTC. Only Friday is open.
		const now = new Date('2026-07-17T22:00:00.000Z')
		const status = describeOpenNow(
			{
				timeZone: riyadh,
				storeHours: week(
					[{ start: '18:00', end: '02:00' }],
					['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'saturday'],
				),
				specialHours: [],
			},
			now,
			'en',
		)
		expect(status.open).toBe(true)
		expect(status.closesAt).toMatch(/2:00/)
	})

	it('is closed on a special-hours day even when the week says open', () => {
		// Thursday 2026-07-16 15:00 Riyadh = 12:00 UTC.
		const now = new Date('2026-07-16T12:00:00.000Z')
		const status = describeOpenNow(
			{
				timeZone: riyadh,
				storeHours: week([{ start: '11:00', end: '22:00' }]),
				specialHours: [{ date: '2026-07-16', isOpen: false, slots: [] }],
			},
			now,
		)
		expect(status.open).toBe(false)
	})

	it('uses the location time zone across daylight saving', () => {
		const hours = {
			timeZone: 'America/New_York',
			storeHours: week([{ start: '09:00', end: '17:00' }]),
			specialHours: [],
		}
		// 14:00 UTC is 10:00 EDT in July and 09:00 EST in January.
		expect(
			describeOpenNow(hours, new Date('2026-07-15T14:00:00.000Z')).open,
		).toBe(true)
		expect(
			describeOpenNow(hours, new Date('2026-01-15T14:00:00.000Z')).open,
		).toBe(true)
		// 02:00 UTC in July is 22:00 the previous evening in New York.
		expect(
			describeOpenNow(hours, new Date('2026-07-15T02:00:00.000Z')).open,
		).toBe(false)
	})
})

describe('order and reserve gating (#86)', () => {
	it('offers ordering only for pickup or delivery', () => {
		expect(locationOffersOrdering({ pickup: true })).toBe(true)
		expect(locationOffersOrdering({ delivery: true })).toBe(true)
		expect(locationOffersOrdering({ dineIn: true })).toBe(false)
		expect(locationOffersOrdering(null)).toBe(false)
	})

	it('shows hero buttons only for the features that are on', () => {
		const links = [
			{
				url: '/menu',
				link: { label: 'Order online' },
				when: 'ordering' as const,
			},
			{
				url: '/reserve',
				link: { label: 'Book a table' },
				when: 'reservations' as const,
			},
			{ url: '/about', link: { label: 'Our story' } },
		]
		expect(
			visibleHeroLinks(links, { ordering: false, reservations: true }).map(
				(link) => link.url,
			),
		).toEqual(['/reserve', '/about'])
		expect(
			visibleHeroLinks(links, { ordering: true, reservations: false }).map(
				(link) => link.url,
			),
		).toEqual(['/menu', '/about'])
	})

	it('treats a pause with no end as still paused', () => {
		expect(orderingIsPaused({ until: null })).toBe(true)
		expect(
			orderingIsPaused(
				{ until: '2026-07-16T18:00:00.000Z' },
				new Date('2026-07-16T17:00:00.000Z'),
			),
		).toBe(true)
		expect(
			orderingIsPaused(
				{ until: '2026-07-16T18:00:00.000Z' },
				new Date('2026-07-16T19:00:00.000Z'),
			),
		).toBe(false)
	})

	it('filters locations and finds a login link', () => {
		expect(
			locationsForSection([{ id: 'a' }, { id: 'b' }], ['b']).map((l) => l.id),
		).toEqual(['b'])
		expect(locationsForSection([{ id: 'a' }], [])).toHaveLength(1)
		expect(containsLoginCta({ links: [{ url: '/login' }] })).toBe(true)
		expect(containsLoginCta({ links: [{ url: '/menu' }] })).toBe(false)
	})
})
