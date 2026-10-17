// @vitest-environment jsdom

import {
	cleanup,
	fireEvent,
	screen,
	waitFor,
	within,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { todayLocalDate } from '#app/utils/staffing/staff-format.ts'
import { type StaffDetail } from '#app/utils/staffing/staff-types.ts'
import { renderStaff } from '#tests/staff-render.tsx'
import { PositionsTab } from './positions-tab.tsx'
import { StaffClientProvider } from './staff-client-provider.tsx'
import { StaffTeamContextProvider } from './team-context.ts'

afterEach(() => {
	cleanup()
	vi.unstubAllGlobals()
})

type Call = { url: string; method: string; body: any }

const GRANTS = [
	'read:staff:any',
	'update:staff:any',
	'read:staff_pay:any',
	'update:staff_pay:any',
]

const JOB = {
	id: 'j1',
	staffId: 's1',
	scopeId: 'main',
	positionId: 'p1',
	isPrimary: true,
	effectiveFrom: '2020-01-01',
	effectiveTo: null,
	payType: 'hourly' as const,
	rateMinor: 1500,
	annualSalaryMinor: null,
	currency: 'USD' as const,
}

const DETAIL: StaffDetail = {
	staff: {
		id: 's1',
		status: 'active',
		workerType: 'employee',
		firstName: 'Ada',
		lastName: 'Lovelace',
		firstNameAr: null,
		lastNameAr: null,
		email: null,
		phone: null,
		userId: null,
		employeeNumber: null,
		locale: 'en',
		hiredDate: null,
		terminatedAt: null,
		terminationReason: null,
		eligibleForRehire: null,
		primaryScopeId: 'main',
		createdAt: 1,
		updatedAt: 1,
	},
	assignments: [
		{
			id: 'a1',
			staffId: 's1',
			scopeId: 'main',
			isPrimary: true,
			showInSchedule: true,
			eligibleOpenShifts: true,
			includeInClockErrors: true,
			canWaiveBreaks: false,
			active: true,
			hasPin: false,
			pinSetAt: null,
		},
	],
	jobs: [JOB],
}

function stubApi() {
	const calls: Call[] = []
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input)
			if (url.includes('/staff/token')) {
				return Response.json({
					jwt: 'jwt',
					tenantApiUrl: 'https://us.tenant.test',
					scope: 'staff',
					grants: GRANTS,
					expiresAt: Date.now() + 600_000,
				})
			}
			const call: Call = {
				url,
				method: init?.method ?? 'GET',
				body: init?.body ? JSON.parse(String(init.body)) : null,
			}
			calls.push(call)
			if (url.includes('include=pay')) return Response.json(DETAIL)
			return Response.json({ job: JOB }, { status: 201 })
		}),
	)
	return calls
}

function show() {
	return renderStaff(
		<StaffClientProvider orgSlug="acme">
			<StaffTeamContextProvider
				value={{
					orgSlug: 'acme',
					basePath: '/acme/staff/team',
					dataRegion: 'us',
					scopes: [{ id: 'main', name: 'Main', currency: 'USD' }],
					positions: [
						{
							id: 'p1',
							name: 'Server',
							nameAr: null,
							area: null,
							colorKey: 'neutral',
							tipEligible: false,
							archivedAt: null,
						},
						{
							id: 'p2',
							name: 'Cook',
							nameAr: null,
							area: null,
							colorKey: 'neutral',
							tipEligible: false,
							archivedAt: null,
						},
					],
					reloadRoster: () => {},
					reloadOnboarding: () => {},
					reloadPositions: () => {},
					close: () => {},
				}}
			>
				<PositionsTab detail={DETAIL} onChanged={() => {}} />
			</StaffTeamContextProvider>
		</StaffClientProvider>,
	)
}

function expectFieldError(field: HTMLElement, message: string) {
	expect(field.getAttribute('aria-invalid')).toBe('true')
	const describedBy = field.getAttribute('aria-describedby') ?? ''
	const error = describedBy
		.split(' ')
		.map((id) => document.getElementById(id))
		.find((node) => node?.textContent === message)
	expect(error).toBeTruthy()
}

describe('PositionsTab', () => {
	it('flags every bad field of Add a position under that field', async () => {
		const calls = stubApi()
		show()
		fireEvent.click(
			await screen.findByRole('button', { name: 'Add a position' }),
		)
		const form = await screen.findByRole('form', { name: 'Add a position' })
		const rate = within(form).getByLabelText(/Hourly rate/)
		fireEvent.change(rate, { target: { value: 'abc' } })
		fireEvent.click(within(form).getByRole('button', { name: 'Add position' }))

		expectFieldError(
			within(form).getByRole('combobox', { name: 'Position' }),
			'Choose a position.',
		)
		expectFieldError(rate, 'Enter an amount like 15.50.')
		await waitFor(() =>
			expect(
				within(form).getByRole('combobox', { name: 'Position' }),
			).toHaveFocus(),
		)
		expect(form.querySelector('[data-slot="alert"]')).toBeNull()

		fireEvent.change(rate, { target: { value: '16.00' } })
		expect(rate.getAttribute('aria-invalid')).toBeNull()
		expect(within(form).queryByText('Enter an amount like 15.50.')).toBeNull()
		expect(calls.some((c) => c.method === 'POST')).toBe(false)
	})

	it('flags the rate and the reason of Change rate under each field', async () => {
		const calls = stubApi()
		show()
		fireEvent.click(await screen.findByRole('button', { name: 'Show' }))
		fireEvent.click(await screen.findByRole('button', { name: 'Change rate' }))
		const form = await screen.findByRole('form', { name: 'Change rate' })
		const amount = within(form).getByLabelText('New hourly rate')
		fireEvent.change(amount, { target: { value: '' } })
		fireEvent.click(within(form).getByRole('button', { name: 'Save rate' }))

		expectFieldError(amount, 'Enter an amount like 15.50.')
		const reason = within(form).getByLabelText('Reason')
		expectFieldError(reason, 'Add a reason for the change.')
		await waitFor(() => expect(amount).toHaveFocus())
		expect(form.querySelector('[data-slot="alert"]')).toBeNull()

		fireEvent.change(amount, { target: { value: '16.00' } })
		fireEvent.click(within(form).getByRole('button', { name: 'Save rate' }))
		await waitFor(() => expect(reason).toHaveFocus())
		fireEvent.change(reason, { target: { value: 'Annual raise' } })
		expect(amount.getAttribute('aria-invalid')).toBeNull()
		expect(reason.getAttribute('aria-invalid')).toBeNull()
		fireEvent.click(within(form).getByRole('button', { name: 'Save rate' }))
		await waitFor(() =>
			expect(calls.find((c) => c.method === 'POST')).toMatchObject({
				body: {
					effectiveFrom: todayLocalDate(),
					reason: 'Annual raise',
					rateMinor: 1600,
				},
			}),
		)
	})
})
