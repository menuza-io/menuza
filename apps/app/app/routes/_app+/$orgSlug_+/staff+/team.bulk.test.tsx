// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { Sheet, SheetContent } from '@repo/ui/sheet'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { type StaffTeamContext } from '#app/components/staff/team-context.ts'
import { StaffClientContext } from '#app/hooks/use-staff-client.ts'
import { type StaffClient } from '#app/utils/staffing/staff-client.ts'
import BulkAddRoute from './team.bulk.tsx'

function setup(
	request = vi.fn().mockResolvedValue({
		results: [{ index: 0, status: 'created', staffId: 'new1' }],
		summary: { created: 1, existing: 0, invalid: 0, conflict: 0 },
	}),
) {
	const reloadRoster = vi.fn()
	const close = vi.fn()
	const client = {
		scope: 'staff',
		credentials: vi.fn(),
		grants: vi.fn().mockResolvedValue(new Set(['update:staff:any'])),
		request,
		forget: vi.fn(),
	} as unknown as StaffClient
	const pool = { orgSlug: 'acme', get: () => client, forgetAll: vi.fn() }
	const context: StaffTeamContext = {
		orgSlug: 'acme',
		basePath: '/acme/staff/team',
		dataRegion: 'us',
		scopes: [{ id: 'loc1', name: 'Downtown', currency: 'USD' }],
		positions: [],
		reloadRoster,
		reloadPositions: vi.fn(),
		reloadOnboarding: vi.fn(),
		close,
	}
	const router = createMemoryRouter(
		[
			{
				path: '/',
				element: (
					<Sheet open>
						<SheetContent>
							<Outlet context={context} />
						</SheetContent>
					</Sheet>
				),
				children: [{ index: true, element: <BulkAddRoute /> }],
			},
		],
		{ initialEntries: ['/'] },
	)
	i18n.load('en', {})
	i18n.activate('en')
	render(
		<I18nProvider i18n={i18n}>
			<StaffClientContext.Provider value={pool}>
				<RouterProvider router={router} />
			</StaffClientContext.Provider>
		</I18nProvider>,
	)
	return { request, reloadRoster, close }
}

function paste(text: string) {
	fireEvent.change(screen.getByLabelText(/People/), { target: { value: text } })
	fireEvent.click(screen.getByRole('button', { name: 'Review list' }))
}

describe('bulk add', () => {
	it('asks for at least one person before reviewing', () => {
		const { request } = setup()
		fireEvent.click(screen.getByRole('button', { name: 'Review list' }))
		expect(
			screen.getByText('Add at least one person to continue.'),
		).toBeTruthy()
		expect(request).not.toHaveBeenCalled()
	})

	it('saves nothing at the review step and posts only valid rows on confirm', async () => {
		const { request, reloadRoster } = setup()
		paste('Dana Lee, +14155550123\nCher\nSam Cook, sam@example.com')

		// Review step: nothing has been sent.
		expect(screen.getByText(/2 ready, 1 need a fix/)).toBeTruthy()
		expect(request).not.toHaveBeenCalled()

		fireEvent.click(screen.getByRole('button', { name: 'Add 2 people' }))
		await waitFor(() => expect(request).toHaveBeenCalledTimes(1))
		const [path, init] = request.mock.calls[0]!
		expect(path).toBe('/bulk')
		expect(init.method).toBe('POST')
		expect(init.json.members).toEqual([
			{
				firstName: 'Dana',
				lastName: 'Lee',
				phone: '+14155550123',
				assignments: [{ scopeId: 'loc1', isPrimary: true }],
			},
			{
				firstName: 'Sam',
				lastName: 'Cook',
				email: 'sam@example.com',
				assignments: [{ scopeId: 'loc1', isPrimary: true }],
			},
		])
		await waitFor(() => expect(reloadRoster).toHaveBeenCalled())
		expect(screen.getByText(/Bulk add finished/)).toBeTruthy()
	})

	it('lets the manager fix a row in place and the count updates', () => {
		setup()
		paste('Cher, +14155550123')
		expect(screen.getByText(/0 ready, 1 need a fix/)).toBeTruthy()
		expect(screen.getByRole('button', { name: /^Add/ })).toBeDisabled()
		fireEvent.change(screen.getByLabelText('Row 1: Last name'), {
			target: { value: 'Smith' },
		})
		expect(screen.getByText(/1 ready, 0 need a fix/)).toBeTruthy()
		expect(screen.getByRole('button', { name: 'Add 1 person' })).toBeEnabled()
	})

	it('goes back to the paste step with the text intact', () => {
		setup()
		paste('Dana Lee, +14155550123')
		fireEvent.click(screen.getByRole('button', { name: 'Back' }))
		expect((screen.getByLabelText(/People/) as HTMLTextAreaElement).value).toBe(
			'Dana Lee, +14155550123',
		)
	})

	it('reports rows the service rejected by name', async () => {
		const request = vi.fn().mockResolvedValue({
			results: [
				{ index: 0, status: 'invalid', error: 'phone: invalid_format' },
			],
			summary: { created: 0, existing: 0, invalid: 1, conflict: 0 },
		})
		setup(request)
		paste('Dana Lee, +14155550123')
		fireEvent.click(screen.getByRole('button', { name: 'Add 1 person' }))
		expect(
			await screen.findByText(
				/Dana Lee: The service could not accept this row/,
			),
		).toBeTruthy()
	})
})
