// @vitest-environment jsdom
import { screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { HostSubnav } from '#app/components/reservations/host-subnav.tsx'
import { ReservationsChrome } from '#app/components/reservations/reservations-chrome.tsx'
import { HIDDEN_RESERVATIONS_NAV } from '#app/utils/reservations/nav.ts'
import { renderStaff } from '#tests/staff-render.tsx'

const nav = {
	...HIDDEN_RESERVATIONS_NAV,
	visible: true,
	today: true,
	book: true,
	waitlist: true,
	guests: true,
	reports: true,
	settings: true,
}
const twoLocations = [
	{ id: 'loc-1', name: 'Downtown' },
	{ id: 'loc-2', name: 'Harbor' },
]

function renderChrome(
	route: string,
	{
		locations = twoLocations.slice(0, 1),
		children = <p>screen</p>,
	}: { locations?: typeof twoLocations; children?: React.ReactNode } = {},
) {
	return renderStaff(
		<ReservationsChrome
			orgSlug="acme"
			nav={nav}
			locations={locations}
			selectedLocationId="loc-1"
			onLocationChange={vi.fn()}
		>
			{children}
		</ReservationsChrome>,
		{ route },
	)
}

describe('ReservationsChrome', () => {
	it('renders one h1, one section tab bar, and marks the section with aria-current', () => {
		renderChrome('/acme/reservations/timeline')
		expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
		expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
			'Timeline',
		)
		const tabs = screen.getByRole('navigation', {
			name: 'Reservations sections',
		})
		const active = tabs.querySelectorAll('[aria-current="page"]')
		expect(active).toHaveLength(1)
		// Every day view sits under the Today tab.
		expect(active[0]?.textContent).toBe('Today')
		expect(
			within(tabs)
				.getAllByRole('link')
				.map((link) => link.textContent),
		).toEqual([
			'Today',
			'Calendar',
			'Guests',
			'Waitlist',
			'Reports',
			'Settings',
		])
		expect(tabs.innerHTML).not.toMatch(/bg-primary/)
	})

	it('keeps Calendar and Settings as their own section tabs', () => {
		const calendar = renderChrome('/acme/reservations/calendar')
		expect(
			screen
				.getByRole('navigation', { name: 'Reservations sections' })
				.querySelector('[aria-current="page"]')?.textContent,
		).toBe('Calendar')
		calendar.unmount()
		renderChrome('/acme/reservations/settings/tables')
		expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
			'Settings',
		)
		expect(
			screen
				.getByRole('navigation', { name: 'Reservations sections' })
				.querySelector('[aria-current="page"]')?.textContent,
		).toBe('Settings')
	})

	it('puts the day actions in the header and shows no date control off the day views', () => {
		renderChrome('/acme/reservations/today', {
			children: (
				<HostSubnav
					orgSlug="acme"
					activeView="today"
					businessDate="2026-10-20"
					onDateChange={vi.fn()}
					onOpenBookingSheet={vi.fn()}
				/>
			),
		})
		const h1 = screen.getByRole('heading', { level: 1 })
		// The primary action lives in the page header, not in the context bar.
		const header = h1.closest('div')!.parentElement!
		expect(
			within(header).getByTestId('open-booking-sheet-btn').textContent,
		).toBe('New reservation')
		expect(
			within(screen.getByTestId('host-context-bar')).queryByTestId(
				'open-booking-sheet-btn',
			),
		).toBeNull()
		expect(screen.getByTestId('host-date-input')).toBeTruthy()
	})

	it('shows the Location picker in the header on Settings when there are several locations', () => {
		renderChrome('/acme/reservations/settings', { locations: twoLocations })
		expect(screen.getByLabelText('Location')).toBeTruthy()
		expect(screen.queryByTestId('host-context-bar')).toBeNull()
	})

	it('leaves the header to screens that render their own, never two h1', () => {
		renderChrome('/acme/reservations/guests', {
			children: <h1>Guests</h1>,
		})
		expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
	})
})
