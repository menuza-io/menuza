import { describe, expect, it } from 'vitest'
import { reservationsReportsHref } from './reports-link.ts'

describe('reservationsReportsHref', () => {
	it('opens Reports on the Reservations category', () => {
		expect(reservationsReportsHref('acme')).toBe(
			'/acme/reports?category=Reservations',
		)
	})

	it('keeps the active location and the language', () => {
		expect(
			reservationsReportsHref('acme', { locationId: 'loc_1', lng: 'ar' }),
		).toBe('/acme/reports?category=Reservations&location=loc_1&lng=ar')
	})

	it('encodes what it is given', () => {
		expect(reservationsReportsHref('acme', { locationId: 'a b&c' })).toBe(
			'/acme/reports?category=Reservations&location=a+b%26c',
		)
	})
})
