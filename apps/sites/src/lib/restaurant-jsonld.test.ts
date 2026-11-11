import { describe, expect, it } from 'vitest'
import {
	buildRestaurantJsonLd,
	openingHoursSpecification,
	postalAddress,
	restaurantStructuredData,
	type RestaurantJsonLdInput,
	type RestaurantJsonLdLocation,
} from './restaurant-jsonld'

const ADDRESS = {
	formattedAddress: '12 King St, Toronto, ON M5H 1A1, Canada',
	streetNumber: '12',
	streetName: 'King St',
	city: 'Toronto',
	state: 'ON',
	postalCode: 'M5H 1A1',
	country: 'CA',
	lat: 43.65,
	lng: -79.38,
}

const open = (start: string, end: string) => ({ start, end })

function location(
	overrides: Partial<RestaurantJsonLdLocation> = {},
): RestaurantJsonLdLocation {
	return {
		id: 'loc_1',
		name: 'Downtown',
		phone: '+1 416 555 0100',
		address: ADDRESS,
		storeHours: [
			{ day: 'monday', isOpen: true, slots: [open('09:00', '21:00')] },
			{ day: 'tuesday', isOpen: true, slots: [open('09:00', '21:00')] },
		],
		fulfillmentOptions: { pickup: true, delivery: false },
		...overrides,
	}
}

function input(
	overrides: Partial<RestaurantJsonLdInput> = {},
): RestaurantJsonLdInput {
	return {
		origin: 'https://example.com',
		name: 'Cedar Grill',
		locale: 'en',
		locales: { locales: ['en'], defaultLocale: 'en' },
		logoUrl: null,
		locations: [location()],
		hasMenu: false,
		reservationsOnline: false,
		...overrides,
	}
}

describe('openingHoursSpecification', () => {
	it('groups days with the same hours and marks closed days 00:00-00:00', () => {
		const hours = openingHoursSpecification([
			{ day: 'monday', isOpen: true, slots: [open('09:00', '21:00')] },
			{ day: 'tuesday', isOpen: true, slots: [open('09:00', '21:00')] },
			{ day: 'wednesday', isOpen: false, slots: [open('09:00', '21:00')] },
			{ day: 'thursday', isOpen: true, slots: [] },
			{
				day: 'friday',
				isOpen: true,
				slots: [open('17:00', '22:00'), open('11:00', '14:00')],
			},
		])
		expect(hours).toEqual([
			{
				'@type': 'OpeningHoursSpecification',
				dayOfWeek: ['Monday', 'Tuesday'],
				opens: '09:00',
				closes: '21:00',
			},
			{
				'@type': 'OpeningHoursSpecification',
				dayOfWeek: ['Wednesday', 'Thursday'],
				opens: '00:00',
				closes: '00:00',
			},
			{
				'@type': 'OpeningHoursSpecification',
				dayOfWeek: 'Friday',
				opens: '11:00',
				closes: '14:00',
			},
			{
				'@type': 'OpeningHoursSpecification',
				dayOfWeek: 'Friday',
				opens: '17:00',
				closes: '22:00',
			},
		])
	})

	it('joins overnight hours split at midnight back into one span', () => {
		const hours = openingHoursSpecification([
			{ day: 'friday', isOpen: true, slots: [open('18:00', '23:59')] },
			{
				day: 'saturday',
				isOpen: true,
				slots: [open('00:00', '02:00'), open('18:00', '23:59')],
			},
			{ day: 'sunday', isOpen: true, slots: [open('00:00', '02:00')] },
		])
		expect(hours).toEqual([
			{
				'@type': 'OpeningHoursSpecification',
				dayOfWeek: ['Friday', 'Saturday'],
				opens: '18:00',
				closes: '02:00',
			},
		])
	})

	it('wraps Sunday night into Monday morning', () => {
		expect(
			openingHoursSpecification([
				{
					day: 'monday',
					isOpen: true,
					slots: [open('00:00', '01:00'), open('12:00', '22:00')],
				},
				{ day: 'sunday', isOpen: true, slots: [open('20:00', '23:59')] },
			]),
		).toEqual([
			{
				'@type': 'OpeningHoursSpecification',
				dayOfWeek: 'Monday',
				opens: '12:00',
				closes: '22:00',
			},
			{
				'@type': 'OpeningHoursSpecification',
				dayOfWeek: 'Sunday',
				opens: '20:00',
				closes: '01:00',
			},
		])
	})

	it('keeps a day open around the clock as its own entry', () => {
		const hours = openingHoursSpecification([
			{ day: 'monday', isOpen: true, slots: [open('00:00', '23:59')] },
			{ day: 'tuesday', isOpen: true, slots: [open('00:00', '23:59')] },
		])
		expect(hours).toEqual([
			{
				'@type': 'OpeningHoursSpecification',
				dayOfWeek: ['Monday', 'Tuesday'],
				opens: '00:00',
				closes: '23:59',
			},
		])
	})

	it('reads a JSON string and ignores unreadable schedules and slots', () => {
		expect(
			openingHoursSpecification(
				JSON.stringify([
					{ day: 'monday', isOpen: true, slots: [open('9:00', '17:30')] },
					{ day: 'funday', isOpen: true, slots: [open('09:00', '17:00')] },
					{ day: 'tuesday', isOpen: true, slots: [open('25:00', '26:00')] },
				]),
			),
		).toEqual([
			{
				'@type': 'OpeningHoursSpecification',
				dayOfWeek: 'Monday',
				opens: '09:00',
				closes: '17:30',
			},
			{
				'@type': 'OpeningHoursSpecification',
				dayOfWeek: 'Tuesday',
				opens: '00:00',
				closes: '00:00',
			},
		])
		expect(openingHoursSpecification(null)).toEqual([])
		expect(openingHoursSpecification('not json')).toEqual([])
		expect(openingHoursSpecification([])).toEqual([])
	})
})

describe('postalAddress', () => {
	it('maps a LocationAddress', () => {
		expect(postalAddress({ ...ADDRESS, unit: 'Suite 4' })).toEqual({
			'@type': 'PostalAddress',
			streetAddress: '12 King St, Suite 4',
			addressLocality: 'Toronto',
			addressRegion: 'ON',
			postalCode: 'M5H 1A1',
			addressCountry: 'CA',
		})
	})

	it('falls back to the first part of the one-line address for the street', () => {
		expect(
			postalAddress({
				formattedAddress: 'King Fahd Rd, Riyadh, Saudi Arabia',
				city: 'Riyadh',
				country: 'Saudi Arabia',
			}),
		).toEqual({
			'@type': 'PostalAddress',
			streetAddress: 'King Fahd Rd',
			addressLocality: 'Riyadh',
			addressCountry: 'Saudi Arabia',
		})
	})

	it('is null without an address', () => {
		expect(postalAddress(null)).toBeNull()
		expect(postalAddress({})).toBeNull()
		expect(postalAddress('')).toBeNull()
	})
})

describe('buildRestaurantJsonLd', () => {
	it('describes one location as a single Restaurant', () => {
		expect(
			buildRestaurantJsonLd(input({ logoUrl: 'https://cdn.test/icon.png' })),
		).toEqual({
			'@context': 'https://schema.org',
			'@type': 'Restaurant',
			name: 'Cedar Grill',
			url: 'https://example.com/',
			logo: 'https://cdn.test/icon.png',
			image: 'https://cdn.test/icon.png',
			telephone: '+1 416 555 0100',
			address: {
				'@type': 'PostalAddress',
				streetAddress: '12 King St',
				addressLocality: 'Toronto',
				addressRegion: 'ON',
				postalCode: 'M5H 1A1',
				addressCountry: 'CA',
			},
			geo: { '@type': 'GeoCoordinates', latitude: 43.65, longitude: -79.38 },
			openingHoursSpecification: [
				{
					'@type': 'OpeningHoursSpecification',
					dayOfWeek: ['Monday', 'Tuesday'],
					opens: '09:00',
					closes: '21:00',
				},
			],
		})
	})

	it('leaves out what it does not know', () => {
		const data = buildRestaurantJsonLd(
			input({
				locations: [
					location({
						phone: null,
						address: { city: '', lat: 0, lng: 0 },
						storeHours: null,
					}),
				],
			}),
		)
		expect(data).toEqual({
			'@context': 'https://schema.org',
			'@type': 'Restaurant',
			name: 'Cedar Grill',
			url: 'https://example.com/',
		})
		for (const key of ['servesCuisine', 'priceRange', 'hasMenu', 'logo']) {
			expect(data).not.toHaveProperty(key)
		}
	})

	it('still describes a restaurant with no location', () => {
		expect(
			buildRestaurantJsonLd(input({ locations: [], hasMenu: true })),
		).toEqual({
			'@context': 'https://schema.org',
			'@type': 'Restaurant',
			name: 'Cedar Grill',
			url: 'https://example.com/',
			hasMenu: 'https://example.com/menu',
		})
	})

	it('adds the menu, booking and ordering actions in the page language', () => {
		const data = buildRestaurantJsonLd(
			input({
				locale: 'ar',
				locales: { locales: ['en', 'ar'], defaultLocale: 'en' },
				hasMenu: true,
				reservationsOnline: true,
			}),
		)
		const platforms = [
			'https://schema.org/DesktopWebPlatform',
			'https://schema.org/MobileWebPlatform',
		]
		expect(data).toMatchObject({
			url: 'https://example.com/ar',
			hasMenu: 'https://example.com/ar/menu',
			acceptsReservations: true,
			potentialAction: [
				{
					'@type': 'ReserveAction',
					target: {
						'@type': 'EntryPoint',
						urlTemplate: 'https://example.com/ar/reserve',
						actionPlatform: platforms,
					},
				},
				{
					'@type': 'OrderAction',
					target: {
						'@type': 'EntryPoint',
						urlTemplate: 'https://example.com/ar/menu',
						actionPlatform: platforms,
					},
					deliveryMethod: [
						'http://purl.org/goodrelations/v1#DeliveryModePickUp',
					],
				},
			],
		})
	})

	it('lists several locations as Restaurants under one Organization', () => {
		const data = buildRestaurantJsonLd(
			input({
				logoUrl: 'https://cdn.test/icon.png',
				hasMenu: true,
				locations: [
					location({ id: 'a', name: '{"en":"Downtown","ar":"وسط المدينة"}' }),
					location({
						id: 'b',
						name: 'Cedar Grill Airport',
						phone: '+1 416 555 0199',
						storeHours: null,
					}),
				],
			}),
		)
		const graph = data['@graph'] as Array<Record<string, unknown>>
		expect(data['@context']).toBe('https://schema.org')
		expect(graph).toHaveLength(3)
		expect(graph[0]).toEqual({
			'@type': 'Organization',
			'@id': 'https://example.com/#organization',
			name: 'Cedar Grill',
			url: 'https://example.com/',
			logo: 'https://cdn.test/icon.png',
			department: [
				{ '@id': 'https://example.com/#location-a' },
				{ '@id': 'https://example.com/#location-b' },
			],
		})
		expect(graph[1]).toMatchObject({
			'@id': 'https://example.com/#location-a',
			'@type': 'Restaurant',
			name: 'Cedar Grill - Downtown',
			hasMenu: 'https://example.com/menu',
			parentOrganization: { '@id': 'https://example.com/#organization' },
		})
		expect(graph[2]).toMatchObject({
			'@type': 'Restaurant',
			// Already carries the brand: not repeated.
			name: 'Cedar Grill Airport',
			telephone: '+1 416 555 0199',
		})
		expect(graph[2]).not.toHaveProperty('openingHoursSpecification')
	})
})

describe('restaurantStructuredData', () => {
	it('cannot close the script element or break out of it', () => {
		const text = restaurantStructuredData(
			input({ name: '</script><script>alert(1)</script> \u2028 &' }),
		)
		expect(text).not.toMatch(/[<>&\u2028]/)
		expect(text).toContain('\\u003c/script\\u003e')
		expect(JSON.parse(text).name).toBe(
			'</script><script>alert(1)</script> \u2028 &',
		)
	})
})
