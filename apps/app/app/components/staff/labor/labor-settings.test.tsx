// @vitest-environment jsdom

import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ScopeWordingProvider } from '#app/components/staff/scope-wording-provider.tsx'
import { type LaborSettings } from '#app/utils/staffing/labor-types.ts'
import { type StaffClient } from '#app/utils/staffing/staff-client.ts'
import { renderStaff } from '#tests/staff-render.tsx'
import { LaborSettingsForm } from './labor-settings.tsx'

const saveSettings = vi.hoisted(() => vi.fn())
vi.mock('#app/utils/staffing/labor-api.ts', () => ({ saveSettings }))

const POSITIONS = [
	{ id: 'cook', name: 'Cook', nameAr: null },
	{ id: 'server', name: 'Server', nameAr: null },
]

const SETTINGS: LaborSettings = {
	scopeId: 'loc-1',
	salesSource: 'manual',
	ordersPerLaborHour: { cook: 12.5 },
	demandPerLaborHour: { orders: { cook: 12.5 }, visits: { server: 8 } },
	configured: true,
	updatedAt: 1,
}

function view(wording: 'location' | 'workplace', canEdit = true) {
	const onSaved = vi.fn()
	renderStaff(
		<ScopeWordingProvider wording={wording}>
			<LaborSettingsForm
				client={{} as StaffClient}
				settings={SETTINGS}
				positions={POSITIONS}
				canEdit={canEdit}
				onSaved={onSaved}
			/>
		</ScopeWordingProvider>,
	)
	return { onSaved }
}

const group = (name: RegExp) =>
	screen.getByRole('group', { name }) as HTMLElement

beforeEach(() => {
	saveSettings.mockReset()
	saveSettings.mockImplementation(async (_client, body) => ({
		...SETTINGS,
		...body,
	}))
})

describe('LaborSettingsForm standards per demand unit', () => {
	it('offers an orders input and a covers input per position for a restaurant, filled from the saved standards', () => {
		view('location')
		const orders = within(group(/Orders one person handles/))
		const covers = within(group(/Covers one person handles/))
		expect((orders.getByLabelText('Cook') as HTMLInputElement).value).toBe(
			'12.5',
		)
		expect((orders.getByLabelText('Server') as HTMLInputElement).value).toBe('')
		expect((covers.getByLabelText('Cook') as HTMLInputElement).value).toBe('')
		expect((covers.getByLabelText('Server') as HTMLInputElement).value).toBe(
			'8',
		)
		expect(screen.getAllByText('covers/h')).toHaveLength(POSITIONS.length)
	})

	it('saves the covers standard under the visits unit next to the orders standards', async () => {
		view('location')
		fireEvent.change(
			within(group(/Covers one person handles/)).getByLabelText('Cook'),
			{ target: { value: '6.5' } },
		)
		fireEvent.change(
			within(group(/Orders one person handles/)).getByLabelText('Server'),
			{ target: { value: '20' } },
		)
		fireEvent.click(screen.getByRole('button', { name: 'Save' }))
		await waitFor(() => expect(saveSettings).toHaveBeenCalled())
		expect(saveSettings.mock.calls[0]![1]).toEqual({
			scopeId: 'loc-1',
			salesSource: 'manual',
			ordersPerLaborHour: { cook: 12.5, server: 20 },
			demandPerLaborHour: { visits: { cook: 6.5, server: 8 } },
		})
	})

	it('clears a covers standard that is emptied', async () => {
		view('location')
		fireEvent.change(
			within(group(/Covers one person handles/)).getByLabelText('Server'),
			{ target: { value: '' } },
		)
		fireEvent.click(screen.getByRole('button', { name: 'Save' }))
		await waitFor(() => expect(saveSettings).toHaveBeenCalled())
		expect(saveSettings.mock.calls[0]![1].demandPerLaborHour).toEqual({
			visits: {},
		})
	})

	it('refuses a covers figure out of range and saves nothing', async () => {
		view('location')
		fireEvent.change(
			within(group(/Covers one person handles/)).getByLabelText('Cook'),
			{ target: { value: '999' } },
		)
		fireEvent.click(screen.getByRole('button', { name: 'Save' }))
		expect(await screen.findByText(/Enter covers per hour/)).toBeTruthy()
		expect(saveSettings).not.toHaveBeenCalled()
	})

	it('leaves covers out for a business that is not a restaurant and keeps what is saved', async () => {
		view('workplace')
		expect(screen.queryByText(/Covers one person handles/)).toBeNull()
		fireEvent.change(
			within(group(/Orders one person handles/)).getByLabelText('Server'),
			{ target: { value: '20' } },
		)
		fireEvent.click(screen.getByRole('button', { name: 'Save' }))
		await waitFor(() => expect(saveSettings).toHaveBeenCalled())
		expect(saveSettings.mock.calls[0]![1]).toEqual({
			scopeId: 'loc-1',
			salesSource: 'manual',
			ordersPerLaborHour: { cook: 12.5, server: 20 },
		})
	})

	it('cannot be changed without the policy grant', () => {
		view('location', false)
		expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
	})
})
