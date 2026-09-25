import {
	DEFAULT_WEEKLY_SCHEDULE,
	DeliveryZoneSchema,
	LocationAddressSchema,
	WeeklyScheduleSchema,
} from '@repo/common/location-types'
import { describe, expect, it } from 'vitest'
import {
	getSelectedLocation,
	setSelectedLocation,
} from './location-cookie.server.ts'
import { getLocationDisplayName } from './locations.ts'

describe('Location Cookie Management', () => {
	it('returns "all" as default when no cookie is set', async () => {
		const request = new Request('https://menuza.test/dashboard')
		const selected = await getSelectedLocation(request, 'my-restaurant')
		expect(selected).toBe('all')
	})

	it('sets and retrieves selected location for an organization', async () => {
		const request = new Request('https://menuza.test/dashboard')
		const cookieHeader = await setSelectedLocation(
			request,
			'my-restaurant',
			'loc_123',
		)

		const reqWithCookie = new Request('https://menuza.test/dashboard', {
			headers: { Cookie: cookieHeader },
		})
		const selected = await getSelectedLocation(reqWithCookie, 'my-restaurant')
		expect(selected).toBe('loc_123')
	})

	it('maintains independent selected locations per restaurant slug', async () => {
		const req1 = new Request('https://menuza.test/dashboard')
		const cookieHeader1 = await setSelectedLocation(
			req1,
			'restaurant-a',
			'loc_a_1',
		)

		const req2 = new Request('https://menuza.test/dashboard', {
			headers: { Cookie: cookieHeader1 },
		})
		const cookieHeader2 = await setSelectedLocation(
			req2,
			'restaurant-b',
			'loc_b_2',
		)

		const finalReq = new Request('https://menuza.test/dashboard', {
			headers: { Cookie: cookieHeader2 },
		})

		expect(await getSelectedLocation(finalReq, 'restaurant-a')).toBe('loc_a_1')
		expect(await getSelectedLocation(finalReq, 'restaurant-b')).toBe('loc_b_2')
		expect(await getSelectedLocation(finalReq, 'restaurant-c')).toBe('all')
	})

	it('resets to "all" when locationId is empty', async () => {
		const req = new Request('https://menuza.test/dashboard')
		const cookieHeader = await setSelectedLocation(req, 'my-restaurant', '')

		const reqWithCookie = new Request('https://menuza.test/dashboard', {
			headers: { Cookie: cookieHeader },
		})
		expect(await getSelectedLocation(reqWithCookie, 'my-restaurant')).toBe(
			'all',
		)
	})
})

describe('getLocationDisplayName', () => {
	it('returns plain string name as is', () => {
		expect(getLocationDisplayName('Downtown Branch')).toBe('Downtown Branch')
	})

	it('extracts localized value from JSON object', () => {
		const localizedJson = JSON.stringify({
			en: 'Downtown Branch',
			ar: 'فرع وسط المدينة',
		})
		expect(getLocationDisplayName(localizedJson, 'en', 'en')).toBe(
			'Downtown Branch',
		)
		expect(getLocationDisplayName(localizedJson, 'ar', 'en')).toBe(
			'فرع وسط المدينة',
		)
	})

	it('falls back to defaultLocale if activeLocale is missing', () => {
		const localizedJson = JSON.stringify({
			en: 'Downtown Branch',
		})
		expect(getLocationDisplayName(localizedJson, 'fr', 'en')).toBe(
			'Downtown Branch',
		)
	})

	it('returns empty string if name is empty', () => {
		expect(getLocationDisplayName('')).toBe('')
	})
})

describe('Location Schemas & Types Validation', () => {
	it('validates default weekly schedule', () => {
		const result = WeeklyScheduleSchema.safeParse(DEFAULT_WEEKLY_SCHEDULE)
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data).toHaveLength(7)
			expect(result.data[0]?.day).toBe('monday')
		}
	})

	it('validates location address schema with coordinates', () => {
		const address = {
			formattedAddress: '123 Main St, New York, NY 10001, USA',
			streetNumber: '123',
			streetName: 'Main St',
			city: 'New York',
			state: 'NY',
			postalCode: '10001',
			country: 'United States',
			lat: 40.7128,
			lng: -74.006,
		}
		const result = LocationAddressSchema.safeParse(address)
		expect(result.success).toBe(true)
	})

	it('validates delivery zone schema for radius and polygon', () => {
		const radiusZone = {
			id: 'zone_radius_1',
			name: 'Primary Delivery Zone',
			provider: 'in_house',
			restriction: 'allowed',
			type: 'radius',
			radius: { value: 5, unit: 'miles' },
			zipCodes: [],
			polygon: [],
			minimumOrder: 15,
			deliveryFee: 3.5,
			enabled: true,
		}
		expect(DeliveryZoneSchema.safeParse(radiusZone).success).toBe(true)

		const polygonZone = {
			id: 'zone_poly_1',
			name: 'Downtown Geo-Fence',
			provider: 'in_house',
			restriction: 'allowed',
			type: 'polygon',
			radius: { value: 5, unit: 'miles' },
			zipCodes: [],
			polygon: [
				{ lat: 40.71, lng: -74.01 },
				{ lat: 40.72, lng: -74.0 },
				{ lat: 40.7, lng: -74.0 },
			],
			minimumOrder: 20,
			deliveryFee: 4,
			enabled: true,
		}
		expect(DeliveryZoneSchema.safeParse(polygonZone).success).toBe(true)
	})
})
