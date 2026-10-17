// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NotificationPreferencesCard } from './notification-preferences-card.tsx'

afterEach(() => {
	cleanup()
	vi.unstubAllGlobals()
})

function renderCard(
	showReservationsAlerts?: boolean,
	preferences: unknown[] = [],
) {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => Response.json({ preferences })),
	)
	i18n.load('en', {})
	i18n.activate('en')
	const router = createMemoryRouter(
		[
			{
				path: '/',
				element: (
					<NotificationPreferencesCard
						organizationId="org_1"
						showReservationsAlerts={showReservationsAlerts}
					/>
				),
			},
			{
				path: '/api/notifications/preferences',
				loader: () => Response.json({ preferences }),
			},
		],
		{ initialEntries: ['/'] },
	)
	return render(
		<I18nProvider i18n={i18n}>
			<RouterProvider router={router} />
		</I18nProvider>,
	)
}

const LARGE_PARTY = 'Reservations: a large-party request is waiting'
const LABELS = [
	LARGE_PARTY,
	'Reservations: a guest joined the waitlist remotely',
	'Reservations: a booking no longer has a table',
	'Reservations: a payment failed',
	'Reservations: a payment needs a review',
	'Reservations: a payment dispute was opened',
	'Reservations: guest messages could not be delivered',
]

describe('NotificationPreferencesCard reservations alerts', () => {
	it('offers the seven alerts, each with email and in-app, when offered', async () => {
		renderCard(true)
		for (const label of LABELS) {
			expect(await screen.findByText(label)).toBeTruthy()
		}
		// Two existing workflows + seven reservations ones, two switches each.
		await waitFor(() => expect(screen.getAllByRole('switch')).toHaveLength(18))
	})

	it('shows nothing about reservations unless asked', async () => {
		renderCard()
		await screen.findByText('Notifications when you are mentioned in a comment')
		expect(screen.queryByText(LARGE_PARTY)).toBeNull()
		expect(screen.getAllByRole('switch')).toHaveLength(4)
	})

	it('defaults an alert to on, and follows a saved choice', async () => {
		renderCard(true, [
			{
				workflow: 'reservations.large_party_request',
				email: false,
				inApp: true,
			},
		])
		await screen.findByText(LARGE_PARTY)
		await waitFor(() => {
			const states = screen
				.getAllByRole('switch')
				.map((s) => s.getAttribute('aria-checked'))
			expect(states.slice(4, 6)).toEqual(['false', 'true'])
			expect(states.slice(6, 8)).toEqual(['true', 'true'])
		})
	})
})
