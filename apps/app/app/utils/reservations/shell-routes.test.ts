import { describe, expect, it } from 'vitest'
import { isDetailRoute, reservationsRouteKey } from './shell-routes.ts'

describe('shell routes', () => {
	it('knows the section of a pathname', () => {
		expect(reservationsRouteKey('/acme/reservations/waitlist', 'acme')).toBe(
			'waitlist',
		)
		// Guests moved to Customers, so the old path is no Reservations screen.
		expect(reservationsRouteKey('/acme/reservations/guests/g1', 'acme')).toBe(
			'other',
		)
		expect(reservationsRouteKey('/other/reservations/waitlist', 'acme')).toBe(
			'other',
		)
	})

	it('treats only experience records as detail pages', () => {
		expect(isDetailRoute('/acme/reservations/guests/g1', 'acme')).toBe(false)
		expect(isDetailRoute('/acme/reservations/experiences/e1', 'acme')).toBe(
			true,
		)
		expect(isDetailRoute('/acme/reservations/experiences', 'acme')).toBe(false)
		expect(isDetailRoute('/acme/reservations/experiences/', 'acme')).toBe(false)
		expect(isDetailRoute('/acme/reservations/waitlist', 'acme')).toBe(false)
		expect(isDetailRoute('/acme/reservations/settings/tables', 'acme')).toBe(
			false,
		)
	})
})
