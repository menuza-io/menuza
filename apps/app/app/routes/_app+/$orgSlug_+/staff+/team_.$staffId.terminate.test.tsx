// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { type StaffProfileContext } from '#app/components/staff/profile-context.ts'
import { StaffClientContext } from '#app/hooks/use-staff-client.ts'
import {
	StaffApiError,
	type StaffClient,
} from '#app/utils/staffing/staff-client.ts'
import { type StaffMemberRow } from '#app/utils/staffing/staff-types.ts'
import TerminateStaffRoute from './team_.$staffId.terminate.tsx'

const staff: StaffMemberRow = {
	id: 's1',
	status: 'active',
	workerType: 'employee',
	firstName: 'Dana',
	lastName: 'Lee',
	firstNameAr: null,
	lastNameAr: null,
	email: null,
	phone: '+14155550123',
	userId: null,
	employeeNumber: null,
	locale: 'en',
	hiredDate: null,
	terminatedAt: null,
	terminationReason: null,
	eligibleForRehire: null,
	primaryScopeId: null,
	createdAt: 1,
	updatedAt: 1,
}

function setup(
	request = vi
		.fn()
		.mockResolvedValue({ staff: { ...staff, status: 'terminated' } }),
) {
	const onChanged = vi.fn()
	const close = vi.fn()
	const client = {
		scope: 'staff',
		credentials: vi.fn(),
		grants: vi.fn().mockResolvedValue(new Set(['update:staff:any'])),
		request,
		forget: vi.fn(),
	} as unknown as StaffClient
	const pool = { orgSlug: 'acme', get: () => client, forgetAll: vi.fn() }
	const context: StaffProfileContext = { staff, onChanged, close }
	const router = createMemoryRouter(
		[
			{
				path: '/',
				element: <Outlet context={context} />,
				children: [{ index: true, element: <TerminateStaffRoute /> }],
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
	return { request, onChanged, close }
}

describe('terminate dialog', () => {
	it('needs a reason before it moves to the confirm step', () => {
		const { request } = setup()
		fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
		expect(screen.getByText('Add a reason.')).toBeTruthy()
		expect(request).not.toHaveBeenCalled()
	})

	it('sends nothing until the final, destructive confirm', async () => {
		const { request, onChanged, close } = setup()
		fireEvent.change(screen.getByLabelText(/Reason/), {
			target: { value: 'Resigned' },
		})
		fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

		expect(screen.getByText('Terminate Dana Lee?')).toBeTruthy()
		expect(screen.getByText('Resigned')).toBeTruthy()
		expect(request).not.toHaveBeenCalled()

		fireEvent.click(screen.getByRole('button', { name: 'Terminate Dana Lee' }))
		await waitFor(() => expect(request).toHaveBeenCalledTimes(1))
		const [path, init] = request.mock.calls[0]!
		expect(path).toBe('/s1/terminate')
		expect(init.method).toBe('POST')
		expect(init.json).toMatchObject({
			reason: 'Resigned',
			eligibleForRehire: true,
		})
		expect(init.json.effectiveDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
		await waitFor(() => expect(close).toHaveBeenCalled())
		expect(onChanged).toHaveBeenCalled()
	})

	it('goes back without losing what was typed and records rehire eligibility', async () => {
		const { request } = setup()
		fireEvent.change(screen.getByLabelText(/Reason/), {
			target: { value: 'No show' },
		})
		fireEvent.click(screen.getByText('No'))
		fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
		expect(screen.getByText('Not eligible')).toBeTruthy()
		fireEvent.click(screen.getByRole('button', { name: 'Back' }))
		expect((screen.getByLabelText(/Reason/) as HTMLTextAreaElement).value).toBe(
			'No show',
		)
		fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
		fireEvent.click(screen.getByRole('button', { name: 'Terminate Dana Lee' }))
		await waitFor(() => expect(request).toHaveBeenCalled())
		expect(request.mock.calls[0]![1].json.eligibleForRehire).toBe(false)
	})

	it('stays open and says what went wrong when the service refuses', async () => {
		const request = vi
			.fn()
			.mockRejectedValue(new StaffApiError(409, 'already_terminated'))
		const { close } = setup(request)
		fireEvent.change(screen.getByLabelText(/Reason/), {
			target: { value: 'Left' },
		})
		fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
		fireEvent.click(screen.getByRole('button', { name: 'Terminate Dana Lee' }))
		await waitFor(() =>
			expect(screen.getByRole('alert').textContent).toBe(
				'This person has already left.',
			),
		)
		expect(close).not.toHaveBeenCalled()
	})
})
