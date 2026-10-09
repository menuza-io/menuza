import { describe, expect, it, vi } from 'vitest'

import { resolveZoneForPoint } from './coverage.ts'
import { createDevGeocoder, DEV_GEOCODER_FIXTURES } from './dev.ts'
import { createGoogleGeocoder } from './google.ts'
import { selectGeocoder } from './index.ts'
import { GeocoderError } from './types.ts'

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

function mockFetch(response: Response | (() => Response)) {
	return vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
		typeof response === 'function' ? response() : response,
	)
}

describe('createGoogleGeocoder', () => {
	it('calls Places autocomplete with key, session, bias and region', async () => {
		const fetch = mockFetch(
			jsonResponse({
				suggestions: [
					{
						placePrediction: {
							placeId: 'ChIJ_willis',
							text: { text: '233 S Wacker Dr, Chicago, IL, USA' },
							structuredFormat: {
								mainText: { text: '233 S Wacker Dr' },
								secondaryText: { text: 'Chicago, IL, USA' },
							},
						},
					},
					{
						placePrediction: {
							placeId: 'ChIJ_plain',
							text: { text: '600 E Grand Ave, Chicago, IL, USA' },
						},
					},
					{ queryPrediction: { text: { text: 'ignored' } } },
				],
			}),
		)
		const geocoder = createGoogleGeocoder({ apiKey: 'test-key', fetch })
		const predictions = await geocoder.autocomplete('233 wacker', {
			sessionToken: 'session-1',
			bias: { lat: 41.8853, lng: -87.6229 },
			country: 'US',
			language: 'en',
		})
		expect(predictions).toEqual([
			{
				placeId: 'ChIJ_willis',
				mainText: '233 S Wacker Dr',
				secondaryText: 'Chicago, IL, USA',
			},
			{
				placeId: 'ChIJ_plain',
				mainText: '600 E Grand Ave',
				secondaryText: 'Chicago, IL, USA',
			},
		])
		const [url, init] = fetch.mock.calls[0]!
		expect(String(url)).toBe(
			'https://places.googleapis.com/v1/places:autocomplete',
		)
		expect(init?.method).toBe('POST')
		const headers = init?.headers as Record<string, string>
		expect(headers['X-Goog-Api-Key']).toBe('test-key')
		const body = JSON.parse(String(init?.body))
		expect(body).toMatchObject({
			input: '233 wacker',
			sessionToken: 'session-1',
			languageCode: 'en',
			includedRegionCodes: ['us'],
			locationBias: {
				circle: { center: { latitude: 41.8853, longitude: -87.6229 } },
			},
		})
	})

	it('skips the network for short queries', async () => {
		const fetch = mockFetch(jsonResponse({}))
		const geocoder = createGoogleGeocoder({ apiKey: 'k', fetch })
		expect(await geocoder.autocomplete('ab', { language: 'en' })).toEqual([])
		expect(fetch).not.toHaveBeenCalled()
	})

	it('throws GeocoderError on HTTP failures', async () => {
		const geocoder = createGoogleGeocoder({
			apiKey: 'k',
			fetch: mockFetch(() => jsonResponse({ error: {} }, 403)),
		})
		await expect(
			geocoder.autocomplete('123 main', { language: 'en' }),
		).rejects.toBeInstanceOf(GeocoderError)
		const network = createGoogleGeocoder({
			apiKey: 'k',
			fetch: vi.fn(async () => {
				throw new TypeError('fetch failed')
			}),
		})
		await expect(
			network.geocode('123 main street', { language: 'en' }),
		).rejects.toBeInstanceOf(GeocoderError)
	})

	it('normalizes Places (New) details into a GeoAddress', async () => {
		const fetch = mockFetch(
			jsonResponse({
				id: 'ChIJ_willis',
				formattedAddress: '233 S Wacker Dr, Chicago, IL 60606, USA',
				location: { latitude: 41.8789, longitude: -87.6359 },
				addressComponents: [
					{ longText: '233', shortText: '233', types: ['street_number'] },
					{
						longText: 'South Wacker Drive',
						shortText: 'S Wacker Dr',
						types: ['route'],
					},
					{
						longText: 'Chicago',
						shortText: 'Chicago',
						types: ['locality', 'political'],
					},
					{
						longText: 'Illinois',
						shortText: 'IL',
						types: ['administrative_area_level_1', 'political'],
					},
					{
						longText: 'United States',
						shortText: 'US',
						types: ['country', 'political'],
					},
					{ longText: '60606', shortText: '60606', types: ['postal_code'] },
				],
			}),
		)
		const geocoder = createGoogleGeocoder({ apiKey: 'k', fetch })
		const place = await geocoder.placeDetails('ChIJ_willis', {
			sessionToken: 'session-1',
			language: 'en',
		})
		expect(place).toEqual({
			formatted: '233 S Wacker Dr, Chicago, IL 60606, USA',
			line1: '233 South Wacker Drive',
			city: 'Chicago',
			state: 'IL',
			postalCode: '60606',
			country: 'US',
			lat: 41.8789,
			lng: -87.6359,
			placeId: 'ChIJ_willis',
			streetNumber: '233',
			route: 'South Wacker Drive',
		})
		const [url, init] = fetch.mock.calls[0]!
		expect(String(url)).toBe(
			'https://places.googleapis.com/v1/places/ChIJ_willis?languageCode=en&sessionToken=session-1',
		)
		expect(
			(init?.headers as Record<string, string>)['X-Goog-FieldMask'],
		).toContain('location')
	})

	it('rejects unsafe place ids without calling Google and maps 404 to null', async () => {
		const fetch = mockFetch(jsonResponse({}, 404))
		const geocoder = createGoogleGeocoder({ apiKey: 'k', fetch })
		expect(
			await geocoder.placeDetails('../../evil', { language: 'en' }),
		).toBeNull()
		expect(fetch).not.toHaveBeenCalled()
		expect(
			await geocoder.placeDetails('ChIJ_gone', { language: 'en' }),
		).toBeNull()
	})

	it('parses Geocoding API results, including Saudi addresses', async () => {
		const fetch = mockFetch(
			jsonResponse({
				status: 'OK',
				results: [
					{
						place_id: 'ChIJ_kingdom',
						formatted_address:
							'King Fahd Rd, Al Olaya, Riyadh 12214, Saudi Arabia',
						geometry: { location: { lat: 24.7113, lng: 46.6744 } },
						address_components: [
							{
								long_name: 'King Fahd Road',
								short_name: 'King Fahd Rd',
								types: ['route'],
							},
							{
								long_name: 'Al Olaya',
								short_name: 'Al Olaya',
								types: ['sublocality_level_1', 'sublocality'],
							},
							{
								long_name: 'Riyadh',
								short_name: 'Riyadh',
								types: ['locality'],
							},
							{
								long_name: 'Riyadh Province',
								short_name: 'Riyadh Province',
								types: ['administrative_area_level_1'],
							},
							{
								long_name: 'Saudi Arabia',
								short_name: 'SA',
								types: ['country'],
							},
							{
								long_name: '12214',
								short_name: '12214',
								types: ['postal_code'],
							},
						],
					},
				],
			}),
		)
		const geocoder = createGoogleGeocoder({ apiKey: 'secret-key', fetch })
		const result = await geocoder.geocode('Kingdom Centre Riyadh', {
			country: 'sa',
			language: 'ar',
		})
		expect(result).toMatchObject({
			line1: 'King Fahd Road',
			city: 'Riyadh',
			postalCode: '12214',
			country: 'SA',
			lat: 24.7113,
			lng: 46.6744,
		})
		const url = new URL(String(fetch.mock.calls[0]![0]))
		expect(url.origin + url.pathname).toBe(
			'https://maps.googleapis.com/maps/api/geocode/json',
		)
		expect(url.searchParams.get('key')).toBe('secret-key')
		expect(url.searchParams.get('components')).toBe('country:SA')
		expect(url.searchParams.get('language')).toBe('ar')
	})

	it('maps ZERO_RESULTS to null and other statuses to GeocoderError', async () => {
		const zero = createGoogleGeocoder({
			apiKey: 'k',
			fetch: mockFetch(() =>
				jsonResponse({ status: 'ZERO_RESULTS', results: [] }),
			),
		})
		expect(await zero.geocode('nowhere at all', { language: 'en' })).toBeNull()
		const denied = createGoogleGeocoder({
			apiKey: 'k',
			fetch: mockFetch(() =>
				jsonResponse({ status: 'REQUEST_DENIED', results: [] }),
			),
		})
		await expect(
			denied.geocode('123 main street', { language: 'en' }),
		).rejects.toBeInstanceOf(GeocoderError)
	})
})

describe('createDevGeocoder', () => {
	const geocoder = createDevGeocoder()
	const STORE = { lat: 41.8853, lng: -87.6229 }
	const location = {
		address: STORE,
		deliveryZones: [
			{
				id: 'default-radius-zone',
				name: 'Standard Delivery Area',
				restriction: 'allowed' as const,
				type: 'radius' as const,
				radius: { value: 5, unit: 'miles' as const },
				minimumOrder: 15,
				deliveryFee: 3.99,
				enabled: true,
			},
		],
	}

	it('geocodes the seeded acme store address to the Chicago Loop', async () => {
		const result = await geocoder.geocode(
			'123 Demo Street, Chicago, IL, 60601, US',
			{ country: 'US', language: 'en' },
		)
		expect(result).toMatchObject({
			lat: 41.8853,
			lng: -87.6229,
			city: 'Chicago',
		})
	})

	it('autocompletes, then resolves details for in-zone and out-of-zone fixtures', async () => {
		const near = await geocoder.autocomplete('wacker', {
			country: 'US',
			language: 'en',
		})
		expect(near[0]?.placeId).toBe('dev_chi_wacker_233')
		const nearPlace = await geocoder.placeDetails(near[0]!.placeId, {
			language: 'en',
		})
		expect(resolveZoneForPoint(location, nearPlace!).ok).toBe(true)

		const far = await geocoder.autocomplete('evanston', { language: 'en' })
		const farPlace = await geocoder.placeDetails(far[0]!.placeId, {
			language: 'en',
		})
		expect(resolveZoneForPoint(location, farPlace!)).toEqual({
			ok: false,
			reason: 'out_of_range',
		})
	})

	it('has both in-range and out-of-range fixtures for a 5-mile radius', () => {
		const statuses = DEV_GEOCODER_FIXTURES.filter(
			(fixture) => fixture.address.country === 'US',
		).map((fixture) => resolveZoneForPoint(location, fixture.address).ok)
		expect(statuses.filter(Boolean).length).toBeGreaterThanOrEqual(3)
		expect(statuses.filter((ok) => !ok).length).toBeGreaterThanOrEqual(3)
	})

	it('restricts by country and returns null for unknown text', async () => {
		expect(
			await geocoder.autocomplete('wacker', { country: 'SA', language: 'en' }),
		).toEqual([])
		const riyadh = await geocoder.autocomplete('king fahd', {
			country: 'SA',
			language: 'ar',
		})
		expect(riyadh[0]?.placeId).toBe('dev_riyadh_king_fahd_kingdom_centre')
		expect(
			await geocoder.geocode('1 Nonexistent Lane, Atlantis', {
				language: 'en',
			}),
		).toBeNull()
		expect(await geocoder.placeDetails('nope', { language: 'en' })).toBeNull()
	})
})

describe('selectGeocoder', () => {
	it('prefers Google with a key, dev fixtures outside production, nothing in production', () => {
		expect(selectGeocoder({ apiKey: 'k', isProduction: true })?.name).toBe(
			'google',
		)
		expect(selectGeocoder({ apiKey: '', isProduction: false })?.name).toBe(
			'dev',
		)
		expect(selectGeocoder({ apiKey: null, isProduction: true })).toBeNull()
	})
})
