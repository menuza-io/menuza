// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
	ReservationsHeaderControls,
	reservationsHeaderShowsDate,
} from '#app/components/reservations/header-controls.tsx'
import { renderStaff } from '#tests/staff-render.tsx'

const locations = [
	{ id: 'loc-1', name: 'Downtown' },
	{ id: 'loc-2', name: 'Harbor' },
]

describe('reservationsHeaderShowsDate', () => {
	it.each([
		['/acme/reservations/today', true],
		['/acme/reservations/book', true],
		['/acme/reservations/timeline', true],
		['/acme/reservations/floor', true],
		['/acme/reservations/calendar', true],
		['/acme/reservations/overview', true],
		['/acme/reservations/waitlist', false],
		['/acme/reservations/guests', false],
		['/acme/reservations/guests/g-1', false],
		['/acme/reservations/experiences', false],
		['/acme/reservations/experiences/exp-1', false],
		['/acme/reservations/settings/policies', false],
	])('%s -> %s', (pathname, expected) => {
		expect(reservationsHeaderShowsDate(pathname, 'acme')).toBe(expected)
	})
})

describe('ReservationsHeaderControls', () => {
	it('renders nothing for a single location', () => {
		const { container } = renderStaff(
			<ReservationsHeaderControls
				locations={locations.slice(0, 1)}
				selectedLocationId="loc-1"
				onChange={vi.fn()}
			/>,
		)
		expect(container.textContent).toBe('')
	})

	it('shows the Location picker for several locations and never a date or service', () => {
		renderStaff(
			<ReservationsHeaderControls
				locations={locations}
				selectedLocationId="loc-1"
				onChange={vi.fn()}
			/>,
		)
		expect(screen.getByLabelText('Location')).toBeTruthy()
		expect(screen.queryByLabelText('Date')).toBeNull()
		expect(screen.queryByLabelText('Service')).toBeNull()
	})

	it('has no made-up service id in the layout', () => {
		const layout = readFileSync(
			path.resolve(
				import.meta.dirname,
				'../../routes/_app+/$orgSlug_+/reservations+/_layout.tsx',
			),
			'utf8',
		)
		expect(layout).not.toMatch(/lunch|brunch|reservations-service-select/)
	})
})
