import { describe, expect, it } from 'vitest'
import {
	directionsUrl,
	isDishVisible,
	locationTitleParts,
	resolveAreaPage,
	resolveDishPage,
	resolveEventPage,
	resolveLocationPage,
	visibleDishPages,
	weeklyHoursRows,
} from './landing-pages'
// Type-only: a value import would load the Workers runtime (verbatimModuleSyntax).
// eslint-disable-next-line import/consistent-type-specifier-style
import type {
	PublicLandingPayload,
	PublicSiteEvent,
	PublicSiteMenuPayload,
} from './org'

const loc = (id: string, slug: string) => ({
	id,
	slug,
	name: `{"en":"${slug}","ar":"فرع"}`,
	phone: null,
	address: { city: 'Riyadh', lat: 24.7, lng: 46.68 },
	storeHours: [
		{ day: 'monday', isOpen: true, slots: [{ start: '09:00', end: '21:00' }] },
		{ day: 'tuesday', isOpen: false, slots: [] },
	],
	specialHours: [],
	timezone: 'Asia/Riyadh',
	fulfillmentOptions: null,
	isDefault: id === 'l1',
	intro: null,
	seoTitle: null,
	seoDescription: null,
	cuisines: ['lebanese'],
	priceRange: 2,
	updatedAt: '2026-11-01T00:00:00.000Z',
})

const landing = (
	overrides: Partial<PublicLandingPayload> = {},
): PublicLandingPayload => ({
	features: {
		locationPages: true,
		dishPages: true,
		areaPages: true,
		events: true,
	},
	locations: [loc('l1', 'olaya'), loc('l2', 'malqa')],
	goneLocationSlugs: ['closed-branch'],
	dishes: [
		{ id: 'i1', slug: 'falafel-wrap' },
		{ id: 'i2', slug: 'hidden-dish' },
	],
	areas: [],
	...overrides,
})

const item = (id: string, availabilityStatus = 'available') =>
	({ id, displayName: id, availabilityStatus, price: 10 }) as never

const menu = (overrides: Partial<PublicSiteMenuPayload> = {}) =>
	({
		organization: {
			id: 'o',
			name: 'Al Bait',
			slug: 'albait',
			currency: 'SAR',
			defaultLocale: 'en',
			locales: ['en'],
		},
		locations: [{ id: 'l1' }, { id: 'l2' }],
		menus: [
			{
				id: 'm',
				categories: [
					{
						id: 'c',
						displayName: 'Wraps',
						items: [item('i1'), item('i2', 'hidden'), item('i3')],
					},
				],
			},
		],
		...overrides,
	}) as unknown as PublicSiteMenuPayload

describe('location pages', () => {
	it('serves an active location, 410 for a deactivated one, 404 otherwise', () => {
		expect(resolveLocationPage(landing(), 'olaya')).toMatchObject({
			kind: 'page',
		})
		expect(resolveLocationPage(landing(), 'closed-branch')).toEqual({
			kind: 'gone',
		})
		expect(resolveLocationPage(landing(), 'nowhere')).toEqual({
			kind: 'not_found',
		})
		expect(
			resolveLocationPage(
				landing({
					features: {
						locationPages: false,
						dishPages: false,
						areaPages: false,
						events: false,
					},
				}),
				'olaya',
			),
		).toEqual({ kind: 'not_found' })
	})

	it('shows the week in the reader language with today marked', () => {
		const monday = new Date('2026-11-16T10:00:00Z')
		const rows = weeklyHoursRows(loc('l1', 'olaya'), 'en', 'Closed', monday)
		expect(rows[0]).toEqual({
			day: 'Monday',
			text: '9:00 AM–9:00 PM',
			today: true,
		})
		expect(rows[1]).toEqual({ day: 'Tuesday', text: 'Closed', today: false })
		const ar = weeklyHoursRows(loc('l1', 'olaya'), 'ar', 'مغلق', monday)
		expect(ar[0]!.day).toBe('الاثنين')
		expect(ar[1]!.text).toBe('مغلق')
	})

	it('uses special hours for today', () => {
		const rows = weeklyHoursRows(
			{
				...loc('l1', 'olaya'),
				specialHours: [{ date: '2026-11-16', isOpen: false, slots: [] }],
			},
			'en',
			'Closed',
			new Date('2026-11-16T10:00:00Z'),
		)
		expect(rows[0]).toMatchObject({ text: 'Closed', today: true })
	})

	it('links directions to the map position', () => {
		expect(directionsUrl({ lat: 24.7, lng: 46.68 })).toBe(
			'https://www.google.com/maps/dir/?api=1&destination=24.7,46.68',
		)
		expect(directionsUrl({ formattedAddress: '1 King St, Riyadh' })).toBe(
			'https://www.google.com/maps/dir/?api=1&destination=1%20King%20St%2C%20Riyadh',
		)
		expect(directionsUrl(null)).toBeNull()
	})

	it('builds the default title parts in the reader language', () => {
		expect(
			locationTitleParts({
				brand: 'Al Bait',
				location: loc('l1', 'olaya'),
				locale: 'en',
				defaultLocale: 'en',
			}),
		).toEqual({ name: 'Al Bait olaya', cuisine: 'Lebanese', city: 'Riyadh' })
		expect(
			locationTitleParts({
				brand: 'Al Bait',
				location: loc('l1', 'olaya'),
				locale: 'ar',
				defaultLocale: 'en',
			}).cuisine,
		).toBe('لبناني')
	})
})

describe('dish pages', () => {
	it('publishes an enabled, visible dish and 404s a hidden one', () => {
		expect(resolveDishPage(landing(), menu(), 'falafel-wrap')).toMatchObject({
			kind: 'page',
			value: { item: { id: 'i1' }, related: [{ id: 'i3' }] },
		})
		expect(resolveDishPage(landing(), menu(), 'hidden-dish')).toEqual({
			kind: 'not_found',
		})
		expect(
			resolveDishPage(landing({ dishes: [] }), menu(), 'falafel-wrap'),
		).toEqual({
			kind: 'not_found',
		})
		expect(
			resolveDishPage(
				landing({ dishes: [{ id: 'i1', slug: 'checkout' }] }),
				menu(),
				'checkout',
			),
		).toEqual({
			kind: 'not_found',
		})
		expect(visibleDishPages(landing(), menu())).toEqual([
			{ id: 'i1', slug: 'falafel-wrap' },
		])
	})

	it('a dish switched off at every location is not visible', () => {
		const overrides = {
			l1: [{ entityType: 'item', entityId: 'i1', isEnabled: false }],
			l2: [
				{ entityType: 'item', entityId: 'i1', availabilityStatus: 'hidden' },
			],
		}
		expect(
			isDishVisible(item('i1'), menu({ locationOverrides: overrides })),
		).toBe(false)
		expect(
			isDishVisible(
				item('i1'),
				menu({ locationOverrides: { l1: overrides.l1 } }),
			),
		).toBe(true)
	})

	it('a dish hidden on web at base or at every location is not visible (#220)', () => {
		expect(
			isDishVisible(
				{ ...(item('i1') as object), channels: ['pos'] } as never,
				menu(),
			),
		).toBe(false)
		expect(
			isDishVisible(
				{ ...(item('i1') as object), channels: ['web', 'pos'] } as never,
				menu({
					locationOverrides: {
						l1: [{ entityType: 'item', entityId: 'i1', channels: ['pos'] }],
						l2: [{ entityType: 'item', entityId: 'i1', channels: ['pos'] }],
					},
				}),
			),
		).toBe(false)
		expect(
			isDishVisible(
				{ ...(item('i1') as object), channels: ['web', 'pos'] } as never,
				menu({
					locationOverrides: {
						l1: [{ entityType: 'item', entityId: 'i1', channels: ['pos'] }],
					},
				}),
			),
		).toBe(true)

		expect(
			isDishVisible(
				{ ...(item('i1') as object), channels: ['web', 'pos'] } as never,
				menu({
					locationOverrides: {
						l1: [{ entityType: 'menu', entityId: 'm', channels: ['pos'] }],
						l2: [{ entityType: 'category', entityId: 'c', channels: ['pos'] }],
					},
				}),
			),
		).toBe(false)
	})
})

describe('area and event pages', () => {
	it('finds area pages only while they are on', () => {
		const area = {
			slug: 'al-malqa',
			locationId: 'l1',
			locationSlug: 'olaya',
			zoneId: 'z',
			name: 'Al Malqa',
			minimumOrder: 15,
			deliveryFee: 5,
			intro: null,
			noIndex: true,
		}
		expect(
			resolveAreaPage(landing({ areas: [area] }), 'al-malqa'),
		).toMatchObject({ kind: 'page' })
		expect(resolveAreaPage(landing({ areas: [] }), 'al-malqa')).toEqual({
			kind: 'not_found',
		})
	})

	it('answers 410 for an event over for 30 days', () => {
		const event = (phase: PublicSiteEvent['phase']) =>
			({ slug: 'trivia', phase, occurrences: [] }) as unknown as PublicSiteEvent
		expect(
			resolveEventPage({ events: [event('upcoming')] }, 'trivia'),
		).toMatchObject({ kind: 'page' })
		expect(
			resolveEventPage({ events: [event('ended')] }, 'trivia'),
		).toMatchObject({ kind: 'page' })
		expect(resolveEventPage({ events: [event('gone')] }, 'trivia')).toEqual({
			kind: 'gone',
		})
		expect(resolveEventPage(null, 'trivia')).toEqual({ kind: 'not_found' })
	})
})
