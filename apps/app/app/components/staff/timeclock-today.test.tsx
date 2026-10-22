// @vitest-environment jsdom

import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StaffClientProvider } from '#app/components/staff/staff-client-provider.tsx'
import { renderStaff } from '#tests/staff-render.tsx'
import { TimeclockToday } from './timeclock-today.tsx'

afterEach(() => {
	vi.unstubAllGlobals()
})

const NOW = Date.UTC(2026, 2, 2, 17, 0)
const HOUR = 3_600_000

function row(overrides: Record<string, unknown> = {}) {
	return {
		entryId: 'e1',
		staffId: 's1',
		firstName: 'Rana',
		lastName: 'Khalid',
		scopeId: 'loc-1',
		timeZone: 'America/Chicago',
		positionId: null,
		positionName: 'Server',
		positionNameAr: null,
		state: 'in',
		clockInAt: NOW - 2 * HOUR,
		breakStartAt: null,
		issues: [],
		late: false,
		missingClockOut: false,
		...overrides,
	}
}

function stubApi(
	today: unknown,
	grants = ['read:timesheet:any', 'read:staff:any'],
) {
	const calls: string[] = []
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input)
			calls.push(url)
			if (url.includes('/staff/token')) {
				return Response.json({
					jwt: 'jwt',
					tenantApiUrl: 'https://us.tenant.test',
					scope: 'timeclock',
					grants,
					expiresAt: Date.now() + 600_000,
				})
			}
			return Response.json(today)
		}),
	)
	return calls
}

function view(scopes = [{ id: 'loc-1', name: 'Downtown' }]) {
	return renderStaff(
		<StaffClientProvider orgSlug="acme">
			<TimeclockToday orgSlug="acme" scopes={scopes} canManageTablets />
		</StaffClientProvider>,
	)
}

describe('TimeclockToday', () => {
	it('lists who is on the clock, attention first, with plain badges', async () => {
		stubApi({
			serverNow: NOW,
			present: [
				row(),
				row({
					entryId: 'e2',
					staffId: 's2',
					firstName: 'Omar',
					lastName: 'Saleh',
					state: 'on_break',
					breakStartAt: NOW - 600_000,
				}),
				row({
					entryId: 'e3',
					staffId: 's3',
					firstName: 'Luis',
					lastName: 'Herrera',
					clockInAt: NOW - 19 * HOUR,
					missingClockOut: true,
				}),
			],
			recent: [],
		})
		view()
		await screen.findByText('Luis Herrera')
		const names = screen
			.getAllByRole('listitem')
			.map((item) => item.querySelector('div > span.truncate')?.textContent)
		expect(names).toEqual(['Luis Herrera', 'Rana Khalid', 'Omar Saleh'])
		expect(screen.getByText('Missing clock-out')).toBeTruthy()
		expect(screen.getAllByText('On break')).toHaveLength(2) // filter + badge
		expect(screen.getByText(/3 people on the clock/)).toBeTruthy()
		expect(screen.getByText(/1 on break/)).toBeTruthy()
		expect(screen.getByText(/1 needs attention/)).toBeTruthy()
	})

	it('shows each time in the workplace zone and names the day for an old shift', async () => {
		stubApi({
			serverNow: NOW,
			present: [
				row({ clockInAt: NOW - 2 * HOUR }),
				row({
					entryId: 'e3',
					staffId: 's3',
					firstName: 'Luis',
					clockInAt: NOW - 19 * HOUR,
					missingClockOut: true,
				}),
			],
			recent: [],
		})
		view()
		await screen.findByText(/Since 9:00/)
		expect(screen.getByText(/Since Sun 4:00/)).toBeTruthy()
	})

	it('filters to the people who need attention', async () => {
		stubApi({
			serverNow: NOW,
			present: [
				row(),
				row({
					entryId: 'e3',
					staffId: 's3',
					firstName: 'Luis',
					missingClockOut: true,
				}),
			],
			recent: [],
		})
		view()
		await screen.findByText('Luis Khalid')
		fireEvent.click(screen.getByRole('tab', { name: 'Needs attention' }))
		expect(screen.getAllByRole('listitem')).toHaveLength(1)
		fireEvent.click(screen.getByRole('tab', { name: 'On break' }))
		expect(screen.getByText('No one matches this view.')).toBeTruthy()
	})

	it('teaches the next step when nobody is on the clock', async () => {
		stubApi({ serverNow: NOW, present: [], recent: [] })
		view()
		await screen.findByText('No one is on the clock')
		expect(screen.getByText('Set up a tablet').closest('a')).toHaveAttribute(
			'href',
			'/acme/staff/timeclock/tablets',
		)
	})

	it('lists recent clock-outs and flags the ones that need review', async () => {
		stubApi({
			serverNow: NOW,
			present: [],
			recent: [
				{
					entryId: 'r1',
					staffId: 's9',
					firstName: 'Tomas',
					lastName: 'Lindqvist',
					scopeId: 'loc-1',
					timeZone: 'America/Chicago',
					clockInAt: NOW - 9 * HOUR,
					clockOutAt: NOW - HOUR,
					issues: ['missed_break'],
					needsReview: true,
				},
			],
		})
		view()
		await screen.findByText('Tomas Lindqvist')
		expect(screen.getByText('Needs review')).toBeTruthy()
		expect(screen.getByText('Clocked out in the last 12 hours')).toBeTruthy()
	})

	it('asks for one workplace when the manager picks it, and only sends an id from the list', async () => {
		const calls = stubApi({ serverNow: NOW, present: [], recent: [] })
		view([
			{ id: 'loc-1', name: 'Downtown' },
			{ id: 'loc-2', name: 'Airport' },
		])
		await waitFor(() =>
			expect(calls.some((url) => url.endsWith('/today'))).toBe(true),
		)
		expect(screen.getByRole('combobox', { name: 'Workplace' })).toBeTruthy()
	})

	it('explains a failure and offers another try', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) =>
				String(input).includes('/staff/token')
					? Response.json({
							jwt: 'j',
							tenantApiUrl: 'https://us.tenant.test',
							scope: 'timeclock',
							grants: ['read:timesheet:any'],
							expiresAt: Date.now() + 600_000,
						})
					: Response.json({ error: 'Internal Server Error' }, { status: 500 }),
			),
		)
		view()
		const alert = await screen.findByRole('alert')
		expect(alert.textContent).toMatch(/Something went wrong/)
		expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
	})
})
