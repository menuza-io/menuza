// @vitest-environment jsdom

import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { renderStaff } from '#tests/staff-render.tsx'
import StaffPositionsRoute from './positions.tsx'

const mocks = vi.hoisted(() => ({ request: vi.fn() }))

vi.mock('react-router', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	useLoaderData: () => ({ orgSlug: 'acme', currencies: ['USD'] }),
}))

vi.mock('#app/hooks/use-staff-client.ts', () => ({
	useStaffClient: () => ({
		client: { request: mocks.request },
		can: () => true,
		ready: true,
	}),
	useStaffQuery: () => ({
		data: { positions: [] },
		loading: false,
		reload: vi.fn(),
	}),
}))

describe('position dialog validation', () => {
	it('focuses the first invalid field on every submit', async () => {
		const user = userEvent.setup()
		renderStaff(<StaffPositionsRoute />)
		await user.click(
			screen.getAllByRole('button', { name: 'Add position' })[0]!,
		)
		const dialog = await screen.findByRole('dialog')
		const name = within(dialog).getByRole('textbox', { name: 'Name' })
		const rate = within(dialog).getByRole('textbox', {
			name: /Default hourly rate/,
		})
		await user.type(rate, 'abc')
		await user.click(within(dialog).getByRole('button', { name: 'Save' }))

		await waitFor(() => expect(name).toHaveFocus())
		expect(rate).toHaveAttribute('aria-invalid', 'true')

		await user.type(name, 'Support')
		await user.click(within(dialog).getByRole('button', { name: 'Save' }))

		await waitFor(() => expect(rate).toHaveFocus())
		expect(name).not.toHaveAttribute('aria-invalid')
		expect(mocks.request).not.toHaveBeenCalled()
	})
})
