// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { SaveBar } from '#app/components/save-bar.tsx'
import { type StaffClient } from '#app/utils/staffing/staff-client.ts'
import { LaborSettingsForm } from './labor/labor-settings.tsx'
import { TimeZoneCard } from './time-zone-card.tsx'

// One screen, two independent forms: the global bar acts on both at once.

const positions = [{ id: 'cook', name: 'Cook', nameAr: null }]

function setup({ failTimeZone = false } = {}) {
	i18n.load('en', {})
	i18n.activate('en')
	const zoneSaves: string[] = []
	const laborSaves: unknown[] = []
	let setZone: (zone: string) => void = () => {}

	function Screen() {
		const [zone, setZoneState] = useState('America/New_York')
		const [orders, setOrders] = useState<Record<string, number>>({})
		setZone = setZoneState
		const client = {
			request: vi.fn(async (_path: string, init: { json: any }) => {
				laborSaves.push(init.json)
				setOrders(init.json.ordersPerLaborHour)
				return {
					scopeId: 'loc-1',
					salesSource: 'online_orders',
					ordersPerLaborHour: init.json.ordersPerLaborHour,
					demandPerLaborHour: {
						orders: init.json.ordersPerLaborHour,
						visits: {},
					},
					configured: true,
					updatedAt: 1,
				}
			}),
		} as unknown as StaffClient
		return (
			<>
				<TimeZoneCard orgSlug="acme" timeZone={zone} canEdit />
				<LaborSettingsForm
					client={client}
					settings={{
						scopeId: 'loc-1',
						salesSource: 'online_orders',
						ordersPerLaborHour: orders,
						demandPerLaborHour: { orders, visits: {} },
						configured: true,
						updatedAt: null,
					}}
					positions={positions}
					canEdit
					onSaved={() => {}}
				/>
			</>
		)
	}

	const router = createMemoryRouter(
		[
			{
				path: '*',
				element: <Screen />,
				action: async ({ request }) => {
					const zone = String((await request.formData()).get('timeZone'))
					zoneSaves.push(zone)
					if (failTimeZone) return { error: 'failed' }
					setZone(zone)
					return { ok: true }
				},
			},
		],
		{ initialEntries: ['/acme/staff/timeclock/rules'] },
	)
	render(
		<I18nProvider i18n={i18n}>
			<RouterProvider router={router} />
			<SaveBar />
		</I18nProvider>,
	)
	return { zoneSaves, laborSaves }
}

async function chooseCentral() {
	const user = userEvent.setup()
	await user.click(await screen.findByRole('combobox', { name: 'Time zone' }))
	await user.click(
		await screen.findByRole('option', { name: 'Central Time (US & Canada)' }),
	)
}

async function editBoth() {
	await chooseCentral()
	fireEvent.change(screen.getByLabelText('Cook'), { target: { value: '12' } })
	expect(await screen.findByText('Unsaved changes')).toBeTruthy()
}

const gone = () =>
	waitFor(() => expect(screen.queryByText('Unsaved changes')).toBeNull())

describe('a screen with two forms', () => {
	it('saves every edited form from one Save', async () => {
		const { zoneSaves, laborSaves } = setup()
		await editBoth()
		fireEvent.click(screen.getByRole('button', { name: 'Save' }))
		await waitFor(() => expect(zoneSaves).toEqual(['America/Chicago']))
		await waitFor(() => expect(laborSaves).toHaveLength(1))
		expect(laborSaves[0]).toMatchObject({ ordersPerLaborHour: { cook: 12 } })
		await gone()
	})

	it('discards every edited form from one Discard', async () => {
		const { zoneSaves, laborSaves } = setup()
		await editBoth()
		fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
		await gone()
		expect((screen.getByLabelText('Cook') as HTMLInputElement).value).toBe('')
		expect(
			screen.getByRole('combobox', { name: 'Time zone' }).textContent,
		).toContain('Eastern')
		expect(zoneSaves).toEqual([])
		expect(laborSaves).toEqual([])
	})

	it('keeps a form that failed dirty and still saves the other', async () => {
		const { zoneSaves, laborSaves } = setup({ failTimeZone: true })
		await editBoth()
		fireEvent.click(screen.getByRole('button', { name: 'Save' }))
		await waitFor(() => expect(zoneSaves).toHaveLength(1))
		await waitFor(() => expect(laborSaves).toHaveLength(1))
		// The labor form saved and settled; the time zone is still unsaved.
		expect(
			await screen.findByText(/could not save the time zone/i),
		).toBeTruthy()
		expect(screen.getByText('Unsaved changes')).toBeTruthy()
		expect(
			screen.getByRole('combobox', { name: 'Time zone' }).textContent,
		).toContain('Central')
	})

	it('does not let a form that fails validation block the other', async () => {
		const { zoneSaves, laborSaves } = setup()
		await chooseCentral()
		fireEvent.change(screen.getByLabelText('Cook'), {
			target: { value: 'abc' },
		})
		fireEvent.click(await screen.findByRole('button', { name: 'Save' }))
		await waitFor(() => expect(zoneSaves).toEqual(['America/Chicago']))
		expect(
			await screen.findByText(/Enter orders per hour from 0.5 to 200/),
		).toBeTruthy()
		expect(laborSaves).toEqual([])
		// The invalid form is still dirty, so the bar stays.
		expect(screen.getByText('Unsaved changes')).toBeTruthy()
	})
})
