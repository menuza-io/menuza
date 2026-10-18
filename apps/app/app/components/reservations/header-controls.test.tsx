// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fireEvent, screen } from '@testing-library/react'
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
		['/acme/reservations/waitlist', true],
		['/acme/reservations/guests', false],
		['/acme/reservations/guests/g-1', false],
		['/acme/reservations/reports', false],
		['/acme/reservations/experiences', false],
		['/acme/reservations/experiences/exp-1', false],
		['/acme/reservations/settings/policies', false],
	])('%s -> %s', (pathname, expected) => {
		expect(reservationsHeaderShowsDate(pathname, 'acme')).toBe(expected)
	})
})

describe('ReservationsHeaderControls', () => {
	it('keeps Location and hides Date on the guests and reports routes', () => {
		renderStaff(
			<ReservationsHeaderControls
				locations={locations}
				selectedLocationId="loc-1"
				selectedDate="2026-10-20"
				showDate={reservationsHeaderShowsDate(
					'/acme/reservations/guests',
					'acme',
				)}
				onChange={vi.fn()}
			/>,
		)
		expect(screen.getByLabelText('Location')).toBeTruthy()
		expect(screen.queryByLabelText('Date')).toBeNull()
	})

	it('shows Date on a host view and reports changes', () => {
		const onChange = vi.fn()
		renderStaff(
			<ReservationsHeaderControls
				locations={locations}
				selectedLocationId="loc-1"
				selectedDate="2026-10-20"
				showDate
				onChange={onChange}
			/>,
		)
		fireEvent.change(screen.getByLabelText('Date'), {
			target: { value: '2026-10-21' },
		})
		expect(onChange).toHaveBeenCalledWith('date', '2026-10-21')
		fireEvent.change(screen.getByLabelText('Location'), {
			target: { value: 'loc-2' },
		})
		expect(onChange).toHaveBeenCalledWith('locationId', 'loc-2')
	})

	it('has no Service control: the header never writes a made-up service id', () => {
		renderStaff(
			<ReservationsHeaderControls
				locations={locations}
				selectedLocationId="loc-1"
				selectedDate="2026-10-20"
				showDate
				onChange={vi.fn()}
			/>,
		)
		expect(screen.queryByLabelText('Service')).toBeNull()
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
