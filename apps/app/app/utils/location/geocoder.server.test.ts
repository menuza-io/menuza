import { createDevGeocoder, type Geocoder } from '@repo/geo'
import { describe, expect, it, vi } from 'vitest'
import { ensureLocationCoordinates } from './geocoder.server.ts'

vi.mock('varlock/env', () => ({ ENV: { GOOGLE_MAPS_API_KEY: '' } }))

const DEMO_ADDRESS = {
	formattedAddress: '123 Demo Street, Chicago, IL, 60601, US',
	city: 'Chicago',
	state: 'IL',
	postalCode: '60601',
	country: 'US',
	lat: 0,
	lng: 0,
}

describe('ensureLocationCoordinates', () => {
	it('geocodes 0,0 store addresses and keeps every other field', async () => {
		const result = await ensureLocationCoordinates(
			JSON.stringify(DEMO_ADDRESS),
			createDevGeocoder(),
		)
		expect(result.status).toBe('geocoded')
		expect(JSON.parse(result.address!)).toEqual({
			...DEMO_ADDRESS,
			lat: 41.8853,
			lng: -87.6229,
		})
	})

	it('leaves real coordinates, empty and malformed input untouched', async () => {
		const geocode = vi.fn()
		const geocoder = { geocode } as unknown as Geocoder
		const real = JSON.stringify({ ...DEMO_ADDRESS, lat: 41.9, lng: -87.6 })
		expect(await ensureLocationCoordinates(real, geocoder)).toEqual({
			address: real,
			status: 'unchanged',
		})
		expect((await ensureLocationCoordinates(null, geocoder)).status).toBe(
			'unchanged',
		)
		expect((await ensureLocationCoordinates('{oops', geocoder)).address).toBe(
			'{oops',
		)
		expect(geocode).not.toHaveBeenCalled()
	})

	it('never fails the save when the geocoder errors or finds nothing', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const original = JSON.stringify(DEMO_ADDRESS)
		const failing = {
			geocode: vi.fn(async () => {
				throw new Error('quota')
			}),
		} as unknown as Geocoder
		expect(await ensureLocationCoordinates(original, failing)).toEqual({
			address: original,
			status: 'error',
		})
		expect(warn).toHaveBeenCalledTimes(1)
		const empty = { geocode: vi.fn(async () => null) } as unknown as Geocoder
		expect((await ensureLocationCoordinates(original, empty)).status).toBe(
			'not_found',
		)
		expect((await ensureLocationCoordinates(original, null)).status).toBe(
			'unavailable',
		)
	})
})
