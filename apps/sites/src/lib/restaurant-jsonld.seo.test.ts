import { describe, expect, it } from 'vitest'
import {
	buildLocationRestaurantJsonLd,
	buildMenuItemJsonLd,
	buildRestaurantJsonLd,
	type RestaurantJsonLdInput,
	type RestaurantJsonLdLocation,
} from './restaurant-jsonld'

const location = (overrides: Partial<RestaurantJsonLdLocation> = {}) => ({
	id: 'loc_1',
	name: 'Olaya',
	phone: '+966 11 555 0100',
	address: { city: 'Riyadh', streetName: 'Olaya St', lat: 24.7, lng: 46.68 },
	storeHours: [
		{ day: 'monday', isOpen: true, slots: [{ start: '09:00', end: '23:00' }] },
	],
	...overrides,
})

const input = (
	overrides: Partial<RestaurantJsonLdInput> = {},
): RestaurantJsonLdInput => ({
	origin: 'https://albait.example',
	name: 'Al Bait',
	locale: 'en',
	locales: { locales: ['en', 'ar'], defaultLocale: 'en' },
	locations: [location()],
	hasMenu: true,
	reservationsOnline: false,
	...overrides,
})

describe('cuisine and price range (#182)', () => {
	it('adds servesCuisine and priceRange when set', () => {
		const data = buildRestaurantJsonLd(
			input({ cuisines: ['lebanese', 'shawarma'], priceRange: '﷼﷼' }),
		)
		expect(data.servesCuisine).toEqual(['Lebanese', 'Shawarma'])
		expect(data.priceRange).toBe('﷼﷼')
	})

	it('leaves them out when empty and ignores unknown keys', () => {
		const data = buildRestaurantJsonLd(
			input({ cuisines: ['retired'], priceRange: '' }),
		)
		expect(data).not.toHaveProperty('servesCuisine')
		expect(data).not.toHaveProperty('priceRange')
	})

	it("uses a location's own cuisine and price over the organization's", () => {
		const data = buildRestaurantJsonLd(
			input({
				cuisines: ['lebanese'],
				priceRange: '$$',
				locations: [
					location({ cuisines: ['sushi'], priceRange: '$$$$' }),
					location({ id: 'loc_2', name: 'Malqa' }),
				],
			}),
		)
		const [, first, second] = data['@graph'] as Array<Record<string, unknown>>
		expect(first).toMatchObject({ servesCuisine: 'Sushi', priceRange: '$$$$' })
		expect(second).toMatchObject({
			servesCuisine: 'Lebanese',
			priceRange: '$$',
		})
	})

	it('links each branch to its own page when it has one (#137)', () => {
		const data = buildRestaurantJsonLd(
			input({
				locations: [location(), location({ id: 'loc_2', name: 'Malqa' })],
				locationPageUrls: { loc_2: 'https://albait.example/locations/malqa' },
			}),
		)
		const [, first, second] = data['@graph'] as Array<Record<string, unknown>>
		expect(first!.url).toBe('https://albait.example/')
		expect(second!.url).toBe('https://albait.example/locations/malqa')
	})
})

describe('location page structured data (#137)', () => {
	it('is one Restaurant for the branch, with its page as url and the brand as parent', () => {
		const data = buildLocationRestaurantJsonLd({
			...input({ cuisines: ['lebanese'], priceRange: '$$' }),
			location: location(),
			pageUrl: 'https://albait.example/locations/olaya',
			multiLocation: true,
		})
		expect(data).toMatchObject({
			'@context': 'https://schema.org',
			'@type': 'Restaurant',
			'@id': 'https://albait.example/locations/olaya#restaurant',
			name: 'Al Bait - Olaya',
			url: 'https://albait.example/locations/olaya',
			telephone: '+966 11 555 0100',
			servesCuisine: 'Lebanese',
			priceRange: '$$',
			hasMenu: 'https://albait.example/menu',
			parentOrganization: {
				'@type': 'Organization',
				'@id': 'https://albait.example/#organization',
				name: 'Al Bait',
			},
		})
		expect(data.geo).toEqual({
			'@type': 'GeoCoordinates',
			latitude: 24.7,
			longitude: 46.68,
		})
		expect(data.openingHoursSpecification).toBeTruthy()
	})

	it('names a single location after the brand only', () => {
		const data = buildLocationRestaurantJsonLd({
			...input(),
			location: location(),
			pageUrl: 'https://albait.example/ar/locations/olaya',
			multiLocation: false,
			locale: 'ar',
		})
		expect(data.name).toBe('Al Bait')
		expect(data).not.toHaveProperty('parentOrganization')
		expect(data.hasMenu).toBe('https://albait.example/ar/menu')
	})
})

describe('dish page structured data (#137)', () => {
	it('is a MenuItem with an Offer and diets', () => {
		expect(
			buildMenuItemJsonLd({
				url: 'https://albait.example/menu/falafel-wrap',
				name: 'Falafel wrap',
				description: ' Crispy ',
				imageUrl: 'https://cdn.example/f.jpg',
				price: 18,
				currency: 'SAR',
				restaurantName: 'Al Bait',
				restaurantUrl: 'https://albait.example/menu',
				vegetarian: true,
				vegan: true,
			}),
		).toEqual({
			'@context': 'https://schema.org',
			'@type': 'MenuItem',
			'@id': 'https://albait.example/menu/falafel-wrap#dish',
			name: 'Falafel wrap',
			url: 'https://albait.example/menu/falafel-wrap',
			description: 'Crispy',
			image: 'https://cdn.example/f.jpg',
			offers: {
				'@type': 'Offer',
				price: '18.00',
				priceCurrency: 'SAR',
				availability: 'https://schema.org/InStock',
				url: 'https://albait.example/menu/falafel-wrap',
			},
			suitableForDiet: [
				'https://schema.org/VeganDiet',
				'https://schema.org/VegetarianDiet',
			],
			isPartOf: {
				'@type': 'Menu',
				url: 'https://albait.example/menu',
				provider: { '@type': 'Restaurant', name: 'Al Bait' },
			},
		})
	})
})
