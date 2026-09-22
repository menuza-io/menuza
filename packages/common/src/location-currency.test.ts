import { describe, expect, it } from 'vitest'
import {
	formatLocationPrice,
	getLocationCurrency,
} from './location-currency.ts'

describe('getLocationCurrency', () => {
	it('resolves USD for US address objects and stringified JSON', () => {
		expect(
			getLocationCurrency({
				formattedAddress: '123 Market St, San Francisco, CA 94105, USA',
				city: 'San Francisco',
				state: 'CA',
				postalCode: '94105',
				country: 'US',
				lat: 37.79,
				lng: -122.4,
			}),
		).toBe('USD')

		expect(
			getLocationCurrency(
				JSON.stringify({
					city: 'New York',
					state: 'NY',
					postalCode: '10001',
					country: 'United States',
				}),
			),
		).toBe('USD')
	})

	it('resolves CAD for Canadian addresses with country variants', () => {
		expect(
			getLocationCurrency({
				formattedAddress: '490 Bloor St W, Toronto, ON M5S 1X8, Canada',
				city: 'Toronto',
				state: 'ON',
				postalCode: 'M5S 1X8',
				country: 'CA',
				lat: 43.66,
				lng: -79.4,
			}),
		).toBe('CAD')

		expect(
			getLocationCurrency({
				formattedAddress: 'Vancouver, BC',
				city: 'Vancouver',
				state: 'BC',
				postalCode: 'V6B 1A1',
				country: 'Canada',
				lat: 49.28,
				lng: -123.12,
			}),
		).toBe('CAD')

		expect(
			getLocationCurrency(
				JSON.stringify({
					city: 'Montreal',
					state: 'QC',
					country: 'CAN',
				}),
			),
		).toBe('CAD')
	})

	it('resolves CAD when country is omitted but Canadian postal code or province is present', () => {
		expect(
			getLocationCurrency({
				formattedAddress: 'Bloor St W',
				city: 'Toronto',
				state: 'Ontario',
				postalCode: 'M5S 1X8',
				country: '',
				lat: 0,
				lng: 0,
			}),
		).toBe('CAD')

		expect(
			getLocationCurrency({
				formattedAddress: 'Robson St',
				city: 'Vancouver',
				state: 'BC',
				postalCode: '99999',
				country: '',
				lat: 0,
				lng: 0,
			}),
		).toBe('CAD')
	})

	it('falls back to USD for null, undefined, or empty address', () => {
		expect(getLocationCurrency(null)).toBe('USD')
		expect(getLocationCurrency(undefined)).toBe('USD')
		expect(getLocationCurrency('')).toBe('USD')
		expect(getLocationCurrency('invalid json')).toBe('USD')
	})
})

describe('formatLocationPrice', () => {
	it('formats prices with standard $ prefix across locales', () => {
		expect(formatLocationPrice(18, 'USD', 'en')).toBe('$18.00')
		expect(formatLocationPrice(18, 'USD', 'ar')).toBe('$18.00')
		expect(formatLocationPrice(22.5, 'CAD', 'en')).toBe('$22.50')
		expect(formatLocationPrice(22.5, 'CAD', 'ar')).toBe('$22.50')
		expect(formatLocationPrice(3.5, 'USD', 'ar')).toBe('$3.50')
		expect(formatLocationPrice(0, 'USD', 'ar')).toBe('$0.00')
	})

	it('handles negative numbers safely', () => {
		expect(formatLocationPrice(-5.25, 'USD', 'en')).toBe('-$5.25')
	})
})
