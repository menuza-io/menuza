// @vitest-environment jsdom

import { Sheet, SheetContent } from '@repo/ui/sheet'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { Outlet, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StaffClientProvider } from '#app/components/staff/staff-client-provider.tsx'
import { card, HOUR, NINE_AM } from '#app/utils/staffing/timesheet-fixtures.ts'
import { renderStaff } from '#tests/staff-render.tsx'
import { EditCardSheet, NewCardSheet } from './card-sheet.tsx'
import { type TimesheetsContext } from './timesheets-context.ts'

afterEach(() => {
	// Requests that finish after a test ends (a token for a second scope, a
	// poll) must not reach the real network: swallow them.
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => Response.json({})),
	)
})

// The person search is a command list, which measures itself.
class ResizeObserverStub {
	observe() {}
	unobserve() {}
	disconnect() {}
}
beforeEach(() => {
	vi.stubGlobal('ResizeObserver', ResizeObserverStub)
})

type Call = { method: string; url: string; body: unknown }

const PERSON = {
	staffId: 's1',
	firstName: 'Rana',
	lastName: 'Khalid',
	firstNameAr: null,
	lastNameAr: null,
	employeeNumber: null,
	terminated: false,
}

const edit = (overrides: Record<string, unknown> = {}) => ({
	id: 'e1',
	entryId: 'c1',
	editorId: 'u1',
	via: 'manager',
	action: 'update',
	reason: 'Forgot to clock out',
	before: { clockOutAt: NINE_AM + 7 * HOUR },
	after: { clockOutAt: NINE_AM + 8 * HOUR },
	hoursDeltaMinutes: 60,
	createdAt: NINE_AM + 20 * HOUR,
	...overrides,
})

function detail(
	cardOverrides: Parameters<typeof card>[0] = {},
	extra: Record<string, unknown> = {},
) {
	return {
		serverNow: NINE_AM + 10 * HOUR,
		person: PERSON,
		card: card(cardOverrides),
		edits: [edit()],
		punches: [
			{
				id: 'p1',
				kind: 'clock_in',
				effectiveAt: null,
				serverAt: NINE_AM,
				source: 'kiosk',
				flags: [],
			},
		],
		...extra,
	}
}

function stubApi(
	body: unknown,
	options: {
		respond?: (call: Call) => Response | undefined
		grants?: string[]
	} = {},
) {
	const calls: Call[] = []
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input)
			if (url.includes('/staff/token')) {
				return Response.json({
					jwt: 'jwt',
					tenantApiUrl: 'https://us.tenant.test',
					scope: url.includes('scope=staff') ? 'staff' : 'timeclock',
					grants: options.grants ?? [
						'read:timesheet:any',
						'read:staff:any',
						'update:timesheet:any',
						'approve:timesheet:any',
					],
					expiresAt: Date.now() + 600_000,
				})
			}
			const call: Call = {
				method: init?.method ?? 'GET',
				url,
				body: init?.body ? JSON.parse(String(init.body)) : null,
			}
			calls.push(call)
			return options.respond?.(call) ?? Response.json(body)
		}),
	)
	return calls
}

function context(overrides: Partial<TimesheetsContext> = {}) {
	const ctx: TimesheetsContext = {
		orgSlug: 'acme',
		basePath: '/acme/staff/timeclock/timesheets',
		search: '',
		scopes: [{ id: 'loc-1', name: 'Downtown', timeZone: 'America/Chicago' }],
		positions: [],
		can: { update: true, approve: true, money: false },
		approvalMode: () => 'approve_lock',
		defaultScopeId: 'loc-1',
		defaultDate: '2026-03-02',
		now: () => NINE_AM + 10 * HOUR,
		reload: vi.fn(),
		close: vi.fn(),
		...overrides,
	}
	return ctx
}

function sheet(ui: React.ReactNode, ctx: TimesheetsContext) {
	return renderStaff(
		<StaffClientProvider orgSlug="acme">
			<Routes>
				<Route element={<Outlet context={ctx} />}>
					<Route
						path="*"
						element={
							<Sheet open>
								<SheetContent>{ui}</SheetContent>
							</Sheet>
						}
					/>
				</Route>
			</Routes>
		</StaffClientProvider>,
	)
}

const writeResult = {
	card: null,
	edit: edit(),
	reducedHours: false,
}

describe('EditCardSheet', () => {
	it('shows the card in its own zone with its history and punches', async () => {
		stubApi(detail({ status: 'needs_review', issues: ['missed_break'] }))
		sheet(<EditCardSheet entryId="c1" />, context())
		expect(
			await screen.findByRole('heading', { name: 'Rana Khalid' }),
		).toBeTruthy()
		expect((screen.getByLabelText('Clock in') as HTMLInputElement).value).toBe(
			'09:00',
		)
		expect((screen.getByLabelText('Clock out') as HTMLInputElement).value).toBe(
			'17:00',
		)
		expect(screen.getByText(/America\/Chicago/)).toBeTruthy()
		// What was wrong, in words.
		expect(screen.getByText(/A required break was not taken/)).toBeTruthy()
		// History: who, what, why and what it did to the hours.
		expect(screen.getByText('“Forgot to clock out”')).toBeTruthy()
		expect(screen.getByText('Paid hours +1.00')).toBeTruthy()
		expect(screen.getByText(/Clock out: 4:00 PM to 5:00 PM/)).toBeTruthy()
		expect(screen.getByText('As punched')).toBeTruthy()
	})

	it('will not save without a reason, and says so at the field', async () => {
		const calls = stubApi(detail())
		sheet(<EditCardSheet entryId="c1" />, context())
		const out = await screen.findByLabelText('Clock out')
		fireEvent.change(out, { target: { value: '17:30' } })
		fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
		expect(await screen.findByText(/Say what changed and why/)).toBeTruthy()
		expect(calls.some((c) => c.method === 'PATCH')).toBe(false)
	})

	it('will not save when nothing changed', async () => {
		const calls = stubApi(detail())
		sheet(<EditCardSheet entryId="c1" />, context())
		fireEvent.change(
			await screen.findByLabelText(/Why are you changing this/),
			{
				target: { value: 'Checked it' },
			},
		)
		fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
		expect(
			await screen.findByText(/Nothing about this card has changed/),
		).toBeTruthy()
		expect(calls.some((c) => c.method === 'PATCH')).toBe(false)
	})

	it('saves only the change, with the version and the reason, then closes', async () => {
		const ctx = context()
		const calls = stubApi(detail({ version: 6 }), {
			respond: (call) =>
				call.method === 'PATCH' ? Response.json(writeResult) : undefined,
		})
		sheet(<EditCardSheet entryId="c1" />, ctx)
		fireEvent.change(await screen.findByLabelText('Clock out'), {
			target: { value: '17:30' },
		})
		fireEvent.click(screen.getByRole('button', { name: 'Forgot to clock out' }))
		fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
		await waitFor(() => expect(ctx.close).toHaveBeenCalled())
		const patch = calls.find((c) => c.method === 'PATCH')!
		expect(patch.url).toBe(
			'https://us.tenant.test/operator/timeclock/timesheets/entries/c1',
		)
		expect(patch.body).toEqual({
			expectedVersion: 6,
			reason: 'Forgot to clock out',
			clockOutAt: NINE_AM + 8.5 * HOUR,
		})
		expect(ctx.reload).toHaveBeenCalled()
	})

	it('explains a stale version in plain words and keeps the form', async () => {
		const ctx = context()
		stubApi(detail(), {
			respond: (call) =>
				call.method === 'PATCH'
					? Response.json({ error: 'stale_version' }, { status: 409 })
					: undefined,
		})
		sheet(<EditCardSheet entryId="c1" />, ctx)
		fireEvent.change(await screen.findByLabelText('Clock out'), {
			target: { value: '17:30' },
		})
		fireEvent.change(screen.getByLabelText(/Why are you changing this/), {
			target: { value: 'Late' },
		})
		fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
		expect(
			await screen.findByText(/Someone else changed this time card/),
		).toBeTruthy()
		expect(ctx.close).not.toHaveBeenCalled()
		expect((screen.getByLabelText('Clock out') as HTMLInputElement).value).toBe(
			'17:30',
		)
	})

	it('catches a break outside the shift before it reaches the node', async () => {
		const calls = stubApi(detail())
		sheet(<EditCardSheet entryId="c1" />, context())
		fireEvent.click(await screen.findByRole('button', { name: 'Add a break' }))
		const starts = screen.getAllByLabelText('Start')
		const ends = screen.getAllByLabelText('End')
		fireEvent.change(starts[0]!, { target: { value: '18:00' } })
		fireEvent.change(ends[0]!, { target: { value: '18:30' } })
		fireEvent.change(screen.getByLabelText(/Why are you changing this/), {
			target: { value: 'Break' },
		})
		fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
		expect(
			await screen.findByText('The break has to fall inside the shift.'),
		).toBeTruthy()
		expect(calls.some((c) => c.method === 'PATCH')).toBe(false)
	})

	it('does not let an approved card be edited, and reopens it with a reason', async () => {
		const ctx = context()
		const calls = stubApi(detail({ status: 'approved', version: 4 }), {
			respond: (call) =>
				call.url.endsWith('/reopen')
					? Response.json({
							results: [
								{ id: 'c1', ok: true, status: 'needs_review', version: 5 },
							],
							changed: 1,
							skipped: 0,
						})
					: undefined,
		})
		sheet(<EditCardSheet entryId="c1" />, ctx)
		expect(await screen.findByText(/This card is approved/)).toBeTruthy()
		expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull()
		expect(
			(screen.getByLabelText('Clock out') as HTMLInputElement).closest(
				'fieldset',
			)!.disabled,
		).toBe(true)
		fireEvent.click(screen.getByRole('button', { name: 'Reopen card' }))
		const dialog = await screen.findByRole('dialog', {
			name: /Reopen this card/,
		})
		// Empty reason: refused.
		fireEvent.click(within(dialog).getByRole('button', { name: 'Reopen' }))
		expect(await within(dialog).findByText(/Say why/)).toBeTruthy()
		expect(calls.some((c) => c.url.endsWith('/reopen'))).toBe(false)
		fireEvent.change(within(dialog).getByRole('textbox'), {
			target: { value: 'Tip was wrong' },
		})
		fireEvent.click(within(dialog).getByRole('button', { name: 'Reopen' }))
		await waitFor(() =>
			expect(calls.some((c) => c.url.endsWith('/reopen'))).toBe(true),
		)
		expect(calls.find((c) => c.url.endsWith('/reopen'))!.body).toEqual({
			entries: [{ id: 'c1', version: 4 }],
			reason: 'Tip was wrong',
		})
		await waitFor(() => expect(ctx.reload).toHaveBeenCalled())
	})

	it('a locked card offers unlock, never edit', async () => {
		stubApi(detail({ status: 'locked' }))
		sheet(<EditCardSheet entryId="c1" />, context())
		expect(
			await screen.findByRole('button', { name: 'Unlock card' }),
		).toBeTruthy()
		expect(screen.queryByRole('button', { name: 'Delete card' })).toBeNull()
		expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull()
	})

	it('without the approve grant an approved card says who to ask', async () => {
		stubApi(detail({ status: 'approved' }))
		sheet(
			<EditCardSheet entryId="c1" />,
			context({ can: { update: true, approve: false, money: false } }),
		)
		expect(await screen.findByText(/Ask someone who can approve/)).toBeTruthy()
		expect(screen.queryByRole('button', { name: 'Reopen card' })).toBeNull()
	})

	it('without the update grant the card is read-only', async () => {
		stubApi(detail())
		sheet(
			<EditCardSheet entryId="c1" />,
			context({ can: { update: false, approve: false, money: false } }),
		)
		expect(
			await screen.findByText(/You can look at this card but not change it/),
		).toBeTruthy()
		expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull()
		expect(
			screen.getAllByRole('button', { name: 'Close' }).length,
		).toBeGreaterThan(0)
	})

	it('deletes with a required reason sent in the body', async () => {
		const ctx = context()
		const calls = stubApi(detail({ version: 3 }), {
			respond: (call) =>
				call.method === 'DELETE' ? Response.json(writeResult) : undefined,
		})
		sheet(<EditCardSheet entryId="c1" />, ctx)
		fireEvent.click(await screen.findByRole('button', { name: 'Delete card' }))
		const dialog = await screen.findByRole('dialog', {
			name: /Delete this time card/,
		})
		fireEvent.change(within(dialog).getByRole('textbox'), {
			target: { value: 'Entered twice' },
		})
		fireEvent.click(within(dialog).getByRole('button', { name: 'Delete card' }))
		await waitFor(() => expect(ctx.close).toHaveBeenCalled())
		const del = calls.find((c) => c.method === 'DELETE')!
		expect(del.body).toEqual({ expectedVersion: 3, reason: 'Entered twice' })
	})

	it('approves a closed card from the sheet', async () => {
		const calls = stubApi(detail({ version: 2 }), {
			respond: (call) =>
				call.url.endsWith('/approve')
					? Response.json({
							results: [{ id: 'c1', ok: true, status: 'approved', version: 3 }],
							changed: 1,
							skipped: 0,
						})
					: undefined,
		})
		sheet(<EditCardSheet entryId="c1" />, context())
		fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
		await waitFor(() =>
			expect(calls.some((c) => c.url.endsWith('/approve'))).toBe(true),
		)
		expect(calls.find((c) => c.url.endsWith('/approve'))!.body).toEqual({
			entries: [{ id: 'c1', version: 2 }],
		})
	})

	it('shows a missing card as a plain message with a way back', async () => {
		const ctx = context()
		stubApi(null, {
			respond: () => Response.json({ error: 'not_found' }, { status: 404 }),
		})
		sheet(<EditCardSheet entryId="gone" />, ctx)
		expect(await screen.findByText(/We could not find that/)).toBeTruthy()
		fireEvent.click(screen.getByRole('button', { name: 'Back to the list' }))
		expect(ctx.close).toHaveBeenCalled()
	})

	it('shows tips only to someone with the pay grant', async () => {
		stubApi(
			detail({
				money: {
					estimate: true,
					currency: 'USD',
					rateMinor: 2000,
					payMinor: 16000,
					cashTipsMinor: 1250,
					creditTipsMinor: 0,
				},
			}),
		)
		sheet(
			<EditCardSheet entryId="c1" />,
			context({ can: { update: true, approve: true, money: true } }),
		)
		expect(
			((await screen.findByLabelText('Cash tips')) as HTMLInputElement).value,
		).toBe('12.50')
	})
})

describe('NewCardSheet', () => {
	function people() {
		return {
			staff: [
				{
					id: 's9',
					status: 'active',
					workerType: 'employee',
					firstName: 'Omar',
					lastName: 'Aziz',
					firstNameAr: null,
					lastNameAr: null,
					email: null,
					phone: null,
					userId: null,
					employeeNumber: 'E-9',
					locale: 'en',
					hiredDate: null,
					terminatedAt: null,
					terminationReason: null,
					eligibleForRehire: null,
					primaryScopeId: 'loc-1',
					createdAt: 1,
					updatedAt: 1,
					assignments: [],
					positionIds: [],
				},
			],
			total: 1,
			limit: 20,
			offset: 0,
		}
	}

	it('adds a card for a person found by name, in local time, with a reason', async () => {
		const ctx = context()
		const calls = stubApi(null, {
			respond: (call) => {
				if (call.method === 'POST')
					return Response.json(writeResult, { status: 201 })
				if (call.url.includes('/operator/staff/s9'))
					return Response.json({
						staff: people().staff[0],
						assignments: [],
						jobs: [],
					})
				if (call.url.includes('/operator/staff')) return Response.json(people())
				return undefined
			},
		})
		sheet(<NewCardSheet />, ctx)
		fireEvent.click(await screen.findByRole('button', { name: /Who worked/ }))
		fireEvent.click(await screen.findByText('Omar Aziz'))
		fireEvent.change(screen.getByLabelText('Clock in'), {
			target: { value: '09:00' },
		})
		fireEvent.change(screen.getByLabelText('Clock out'), {
			target: { value: '17:00' },
		})
		fireEvent.click(screen.getByRole('button', { name: 'Missed punch' }))
		fireEvent.click(screen.getByRole('button', { name: 'Add time card' }))
		await waitFor(() => expect(ctx.close).toHaveBeenCalled())
		const post = calls.find((c) => c.method === 'POST')!
		expect(post.url).toBe(
			'https://us.tenant.test/operator/timeclock/timesheets/entries',
		)
		expect(post.body).toEqual({
			staffId: 's9',
			scopeId: 'loc-1',
			date: '2026-03-02',
			startTime: '09:00',
			endTime: '17:00',
			breaks: [],
			reason: 'Missed punch',
		})
	})

	it('asks who worked before anything else', async () => {
		const calls = stubApi(null)
		sheet(<NewCardSheet />, context())
		fireEvent.click(
			await screen.findByRole('button', { name: 'Add time card' }),
		)
		expect(await screen.findByText('Choose who worked.')).toBeTruthy()
		expect(calls.some((c) => c.method === 'POST')).toBe(false)
	})
})
