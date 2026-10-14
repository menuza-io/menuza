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
	showStaffingAlerts?: boolean,
	preferences: unknown[] = [],
	showScheduleAlerts?: boolean,
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
						showStaffingAlerts={showStaffingAlerts}
						showScheduleAlerts={showScheduleAlerts}
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

const ATTENDANCE =
	'Time clock: someone has not clocked in or forgot to clock out'
const OVERTIME = 'Time clock: someone is close to overtime or has reached it'

describe('NotificationPreferencesCard time clock alerts', () => {
	it('shows the two time clock alerts, each with email and in-app, when offered', async () => {
		renderCard(true)
		expect(await screen.findByText(ATTENDANCE)).toBeTruthy()
		expect(screen.getByText(OVERTIME)).toBeTruthy()
		// Two existing workflows + two time clock ones, two switches each.
		await waitFor(() => expect(screen.getAllByRole('switch')).toHaveLength(8))
	})

	it('shows nothing about the time clock when it is not offered', async () => {
		renderCard(false)
		await screen.findByText('Notifications when you are mentioned in a comment')
		expect(screen.queryByText(ATTENDANCE)).toBeNull()
		expect(screen.queryByText(OVERTIME)).toBeNull()
		expect(screen.getAllByRole('switch')).toHaveLength(4)
	})

	it('shows nothing about the time clock by default', async () => {
		renderCard()
		await screen.findByText('Notifications when you are mentioned in a comment')
		expect(screen.queryByText(ATTENDANCE)).toBeNull()
	})

	it('defaults a time clock alert to on, and follows a saved choice', async () => {
		renderCard(true, [
			{ workflow: 'staffing-overtime-workflow', email: false, inApp: true },
		])
		await screen.findByText(OVERTIME)
		await waitFor(() => {
			const switches = screen.getAllByRole('switch')
			const states = switches.map((s) => s.getAttribute('aria-checked'))
			// Attendance: email on, in-app on; overtime: email off, in-app on.
			expect(states.slice(4)).toEqual(['true', 'true', 'false', 'true'])
		})
	})
})

describe('NotificationPreferencesCard schedule alerts', () => {
	const PUBLISHED = 'Schedule: a week was published'

	it('offers the published-week alert on its own, with email and in-app', async () => {
		renderCard(false, [], true)
		expect(await screen.findByText(PUBLISHED)).toBeTruthy()
		expect(screen.queryByText(ATTENDANCE)).toBeNull()
		await waitFor(() => expect(screen.getAllByRole('switch')).toHaveLength(6))
	})

	it('does not offer it unless asked', async () => {
		renderCard(true)
		await screen.findByText(ATTENDANCE)
		expect(screen.queryByText(PUBLISHED)).toBeNull()
	})
})
