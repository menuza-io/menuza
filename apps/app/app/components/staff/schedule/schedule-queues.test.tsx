// @vitest-environment jsdom

import {
	cleanup,
	fireEvent,
	screen,
	waitFor,
	within,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StaffClientProvider } from '#app/components/staff/staff-client-provider.tsx'
import {
	demand,
	person,
	shift,
	week,
} from '#app/utils/staffing/schedule-fixtures.ts'
import {
	type AvailabilityRow,
	type TimeOffRow,
} from '#app/utils/staffing/schedule-types.ts'
import { createStaffClient } from '#app/utils/staffing/staff-client.ts'
import { renderStaff } from '#tests/staff-render.tsx'
import { AvailabilityPage } from './availability-page.tsx'
import { CopyWeekDialog } from './copy-week-dialog.tsx'
import { TimeOffPage } from './time-off-page.tsx'

afterEach(async () => {
	// Let a reload started by the last action finish while the stub is still in place.
	await new Promise((resolve) => setTimeout(resolve, 30))
	cleanup()
	vi.unstubAllGlobals()
})

type Call = { method: string; url: string; body?: unknown }

const roster = {
	staff: [
		{
			id: 's1',
			status: 'active',
			workerType: 'employee',
			firstName: 'Rana',
			lastName: 'Khalid',
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
			primaryScopeId: null,
			createdAt: 0,
			updatedAt: 0,
			assignments: [],
			positionIds: [],
		},
		{
			id: 's2',
			status: 'active',
			workerType: 'employee',
			firstName: 'Omar',
			lastName: 'Saleh',
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
			primaryScopeId: null,
			createdAt: 0,
			updatedAt: 0,
			assignments: [],
			positionIds: [],
		},
	],
	total: 2,
	limit: 200,
	offset: 0,
}

const timeOff = (extra: Partial<TimeOffRow> = {}): TimeOffRow => ({
	id: 't1',
	staffId: 's1',
	category: 'pto',
	startDate: '2026-03-09',
	endDate: '2026-03-11',
	allDay: true,
	startMinute: null,
	endMinute: null,
	note: 'Family trip',
	status: 'pending',
	source: 'staff',
	decidedBy: null,
	decidedAt: null,
	decisionNote: null,
	createdAt: 0,
	warnings: [{ code: 'short_notice' }],
	...extra,
})

const availability = (
	extra: Partial<AvailabilityRow> = {},
): AvailabilityRow => ({
	id: 'a1',
	staffId: 's2',
	kind: 'weekly',
	weekday: 1,
	date: null,
	availability: 'unavailable',
	allDay: true,
	startMinute: null,
	endMinute: null,
	effectiveFrom: null,
	effectiveTo: null,
	note: null,
	status: 'pending',
	source: 'staff',
	decidedBy: null,
	decidedAt: null,
	decisionNote: null,
	createdAt: 0,
	...extra,
})

function stub(routes: {
	timeOff?: TimeOffRow[]
	availability?: AvailabilityRow[]
	requests?: unknown[]
	onWrite?: (c: Call) => unknown
	grants?: string[]
}) {
	const calls: Call[] = []
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input)
			const scope = url.includes('scope=staff') ? 'staff' : 'schedule'
			if (url.includes('/staff/token')) {
				return Response.json({
					jwt: 'j',
					tenantApiUrl: 'https://us.tenant.test',
					scope,
					grants: routes.grants ?? [
						'read:schedule:any',
						'update:schedule:any',
						'read:staff:any',
					],
					expiresAt: Date.now() + 600_000,
				})
			}
			const call = {
				method: init?.method ?? 'GET',
				url,
				body: init?.body ? JSON.parse(String(init.body)) : undefined,
			}
			calls.push(call)
			if (url.includes('/operator/staff')) return Response.json(roster)
			if (call.method !== 'GET')
				return Response.json(routes.onWrite ? routes.onWrite(call) : {})
			if (url.includes('/time-off')) return Response.json(routes.timeOff ?? [])
			if (url.includes('/availability'))
				return Response.json(routes.availability ?? [])
			if (url.includes('/requests')) return Response.json(routes.requests ?? [])
			return Response.json({})
		}),
	)
	return calls
}

const scopes = [{ id: 'loc-1', name: 'Downtown' }]

describe('time off queue', () => {
	it('lists what is waiting with names, dates, notes and warnings', async () => {
		stub({ timeOff: [timeOff()] })
		renderStaff(
			<StaffClientProvider orgSlug="acme">
				<TimeOffPage scopes={scopes} />
			</StaffClientProvider>,
		)
		await screen.findByText('Rana Khalid')
		expect(screen.getByText('Paid time off')).toBeTruthy()
		expect(screen.getByText(/Mar 9\s*\S\s*11, 2026/)).toBeTruthy()
		expect(screen.getByText('3 days', { exact: false })).toBeTruthy()
		expect(screen.getByText('Family trip')).toBeTruthy()
		expect(screen.getByText('Short notice.')).toBeTruthy()
	})

	it('approves in one click and declines with an optional note', async () => {
		const calls = stub({
			timeOff: [timeOff()],
			onWrite: () => timeOff({ status: 'approved' }),
		})
		renderStaff(
			<StaffClientProvider orgSlug="acme">
				<TimeOffPage scopes={scopes} />
			</StaffClientProvider>,
		)
		fireEvent.click(await screen.findByRole('button', { name: /Approve/ }))
		await waitFor(() =>
			expect(calls.some((c) => c.method === 'POST')).toBe(true),
		)
		let post = calls.find((c) => c.method === 'POST')!
		expect(post.url).toContain('/operator/schedule/time-off/t1/decision')
		expect(post.body).toEqual({ decision: 'approve' })

		fireEvent.click(await screen.findByRole('button', { name: 'Decline' }))
		const dialog = await screen.findByRole('dialog')
		fireEvent.change(within(dialog).getByLabelText(/Note/), {
			target: { value: 'Busy week' },
		})
		fireEvent.click(within(dialog).getByRole('button', { name: 'Decline' }))
		await waitFor(() =>
			expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2),
		)
		post = calls.filter((c) => c.method === 'POST')[1]!
		expect(post.body).toEqual({ decision: 'reject', note: 'Busy week' })
	})

	it('hides the decision buttons without the write grant', async () => {
		stub({
			timeOff: [timeOff()],
			grants: ['read:schedule:any', 'read:staff:any'],
		})
		renderStaff(
			<StaffClientProvider orgSlug="acme">
				<TimeOffPage scopes={scopes} />
			</StaffClientProvider>,
		)
		await screen.findByText('Rana Khalid')
		expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull()
		expect(screen.queryByRole('button', { name: /Add time off/ })).toBeNull()
	})

	it('says nothing is waiting when the queue is empty', async () => {
		stub({ timeOff: [] })
		renderStaff(
			<StaffClientProvider orgSlug="acme">
				<TimeOffPage scopes={scopes} />
			</StaffClientProvider>,
		)
		await screen.findByText('Nothing is waiting')
	})

	it('records time off as manager-entered, refusing a missing person or date first', async () => {
		const calls = stub({
			timeOff: [],
			onWrite: () => timeOff({ status: 'approved', warnings: [] }),
		})
		renderStaff(
			<StaffClientProvider orgSlug="acme">
				<TimeOffPage scopes={scopes} />
			</StaffClientProvider>,
		)
		fireEvent.click(await screen.findByRole('button', { name: /Add time off/ }))
		const sheet = await screen.findByRole('dialog')
		fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }))
		await within(sheet).findByText('Choose who this is for.')
		expect(within(sheet).getByText('Choose the day or days.')).toBeTruthy()
		expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
	})
})

describe('availability queue', () => {
	it("groups a person's waiting changes and approves them together", async () => {
		const calls = stub({
			availability: [
				availability({ id: 'a1' }),
				availability({
					id: 'a2',
					weekday: 2,
					allDay: false,
					startMinute: 600,
					endMinute: 900,
					availability: 'available',
				}),
			],
			onWrite: () => [availability({ status: 'approved' })],
		})
		renderStaff(
			<StaffClientProvider orgSlug="acme">
				<AvailabilityPage scopes={scopes} />
			</StaffClientProvider>,
		)
		await screen.findByText('Omar Saleh')
		expect(screen.getByText(/Every Monday/)).toBeTruthy()
		expect(screen.getByText(/Every Tuesday/)).toBeTruthy()
		expect(screen.getAllByRole('listitem').length).toBeGreaterThan(2)
		fireEvent.click(screen.getByRole('button', { name: /Approve all/ }))
		await waitFor(() =>
			expect(calls.some((c) => c.method === 'POST')).toBe(true),
		)
		const post = calls.find((c) => c.method === 'POST')!
		expect(post.url).toContain('/operator/schedule/availability/decision')
		expect(post.body).toEqual({ ids: ['a1', 'a2'], decision: 'approve' })
	})

	it('refuses to save availability with nobody chosen and no day set', async () => {
		stub({
			availability: [],
			onWrite: () => [availability({ status: 'approved' })],
		})
		renderStaff(
			<StaffClientProvider orgSlug="acme">
				<AvailabilityPage scopes={scopes} />
			</StaffClientProvider>,
		)
		fireEvent.click(
			await screen.findByRole('button', { name: /Add availability/ }),
		)
		const sheet = await screen.findByRole('dialog')
		fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }))
		await within(sheet).findByText('Choose who this is for.')
		expect(within(sheet).getByText('Set at least one day.')).toBeTruthy()
	})
})

describe('copy a week', () => {
	function mount(onDone = vi.fn()) {
		const calls: Call[] = []
		const fetchImpl = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input)
				if (url.includes('/staff/token')) {
					return Response.json({
						jwt: 'j',
						tenantApiUrl: 'https://x.test',
						scope: 'schedule',
						grants: [],
						expiresAt: Date.now() + 600_000,
					})
				}
				calls.push({
					method: init?.method ?? 'GET',
					url,
					body: init?.body ? JSON.parse(String(init.body)) : undefined,
				})
				return Response.json({
					weekStart: '2026-03-02',
					created: 12,
					skippedDuplicates: 2,
					skippedUnplaceable: 0,
					openedForInactive: 1,
				})
			},
		)
		const client = createStaffClient({
			orgSlug: 'acme',
			scope: 'schedule',
			fetchImpl: fetchImpl as unknown as typeof fetch,
		})
		renderStaff(
			<CopyWeekDialog
				open
				onClose={vi.fn()}
				client={client}
				scopeId="loc-1"
				week={week({ people: [person()], shifts: [shift()] })}
				locale="en"
				onDone={onDone}
			/>,
		)
		return { calls, onDone }
	}

	it('copies last week into this one, everything, with open shifts', async () => {
		const { calls, onDone } = mount()
		const dialog = await screen.findByRole('dialog')
		fireEvent.click(within(dialog).getByRole('button', { name: 'Copy shifts' }))
		await waitFor(() => expect(onDone).toHaveBeenCalledWith('2026-03-02'))
		expect(calls[0]!.url).toContain('/operator/schedule/copy')
		expect(calls[0]!.body).toEqual({
			scopeId: 'loc-1',
			fromWeekStart: '2026-02-23',
			toWeekStart: '2026-03-02',
			scope: { mode: 'all' },
			includeOpenShifts: true,
		})
	})

	it('needs a choice before copying only some positions', async () => {
		const { calls } = mount()
		const dialog = await screen.findByRole('dialog')
		fireEvent.click(
			within(dialog).getByRole('radio', { name: 'Some positions' }),
		)
		fireEvent.click(within(dialog).getByRole('button', { name: 'Copy shifts' }))
		await within(dialog).findByText('Choose at least one to copy.')
		expect(calls).toHaveLength(0)
		fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Cook' }))
		fireEvent.click(within(dialog).getByRole('button', { name: 'Copy shifts' }))
		await waitFor(() => expect(calls).toHaveLength(1))
		expect(calls[0]!.body).toMatchObject({
			scope: { mode: 'positions', positionIds: ['p2'] },
		})
	})

	it('can copy this week elsewhere', async () => {
		const { calls } = mount()
		const dialog = await screen.findByRole('dialog')
		fireEvent.click(
			within(dialog).getByRole('button', { name: /Copy this week elsewhere/ }),
		)
		fireEvent.click(within(dialog).getByRole('button', { name: 'Copy shifts' }))
		await waitFor(() => expect(calls).toHaveLength(1))
		expect(calls[0]!.body).toMatchObject({
			fromWeekStart: '2026-03-02',
			toWeekStart: '2026-02-23',
		})
	})
})

// Keep the demand helper referenced so a fixture rename fails here too.
void demand
