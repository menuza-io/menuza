import { describe, expect, it } from 'vitest'
import { isDetailRoute, reservationsRouteKey } from './shell-routes.ts'

describe('shell routes', () => {
	it('knows the section of a pathname', () => {
		expect(reservationsRouteKey('/acme/reservations/waitlist', 'acme')).toBe(
			'waitlist',
		)
		expect(reservationsRouteKey('/acme/reservations/guests/g1', 'acme')).toBe(
			'guests',
		)
		expect(reservationsRouteKey('/other/reservations/waitlist', 'acme')).toBe(
			'other',
		)
	})

	it('treats only guest and experience records as detail pages', () => {
		expect(isDetailRoute('/acme/reservations/guests/g1', 'acme')).toBe(true)
		expect(isDetailRoute('/acme/reservations/experiences/e1', 'acme')).toBe(
			true,
		)
		expect(isDetailRoute('/acme/reservations/guests', 'acme')).toBe(false)
		expect(isDetailRoute('/acme/reservations/guests/', 'acme')).toBe(false)
		expect(isDetailRoute('/acme/reservations/waitlist', 'acme')).toBe(false)
		expect(isDetailRoute('/acme/reservations/settings/tables', 'acme')).toBe(
			false,
		)
	})
})
