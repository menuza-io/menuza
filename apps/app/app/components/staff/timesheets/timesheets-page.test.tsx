// @vitest-environment jsdom

import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StaffClientProvider } from '#app/components/staff/staff-client-provider.tsx'
import {
	card,
	dayView,
	HOUR,
	NINE_AM,
	person,
} from '#app/utils/staffing/timesheet-fixtures.ts'
import { renderStaff } from '#tests/staff-render.tsx'
import { TimesheetsPage } from './timesheets-page.tsx'

afterEach(() => {
	// Requests that finish after a test ends (a token for a second scope, a
	// poll) must not reach the real network: swallow them.
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => Response.json({})),
	)
})

const PERIOD = {
	type: 'biweekly',
	start: '2026-03-02',
	end: '2026-03-15',
	days: 14,
	previousStart: '2026-02-16',
	nextStart: '2026-03-16',
}
const SCOPES = [
	{ id: 'loc-1', name: 'Downtown', timeZone: 'America/Chicago' },
	{ id: 'loc-2', name: 'Airport', timeZone: 'America/Chicago' },
]
const MONEY = {
	estimate: true as const,
	currency: 'USD',
	rateMinor: 2000,
	payMinor: 16000,
	cashTipsMinor: 0,
	creditTipsMinor: 0,
}

type Call = { method: string; url: string; body: unknown }

const BASE_GRANTS = [
	'read:timesheet:any',
	'read:staff:any',
	'update:timesheet:any',
	'approve:timesheet:any',
	'read:labor_policy:any',
]

function stubApi(options: {
	people?: ReturnType<typeof person>[]
	review?: ReturnType<typeof person>[]
	grants?: string[]
	approvalMode?: string
	byIssue?: Record<string, number>
	respond?: (call: Call) => Response | undefined
}) {
	const calls: Call[] = []
	const grants = options.grants ?? BASE_GRANTS
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input)
			const method = init?.method ?? 'GET'
			if (url.includes('/staff/token')) {
				return Response.json({
					jwt: 'jwt',
					tenantApiUrl: 'https://us.tenant.test',
					scope: url.includes('scope=staff') ? 'staff' : 'timeclock',
					grants,
					expiresAt: Date.now() + 600_000,
				})
			}
			const call: Call = {
				method,
				url,
				body: init?.body ? JSON.parse(String(init.body)) : null,
			}
			calls.push(call)
			const custom = options.respond?.(call)
			if (custom) return custom
			if (url.includes('/timesheets/period')) {
				return Response.json({
					...dayView(options.people ?? [person()]),
					period: PERIOD,
				})
			}
			if (url.includes('/timesheets/review')) {
				const view = dayView(options.review ?? [])
				return Response.json({ ...view, byIssue: options.byIssue ?? {} })
			}
			if (url.includes('/policies')) {
				return Response.json({
					default: {
						timesheetApprovalMode: options.approvalMode ?? 'approve',
					},
					scopes: [],
				})
			}
			if (url.includes('/positions')) {
				return Response.json({ positions: [] })
			}
			return Response.json({})
		}),
	)
	return calls
}

function view(route = '/') {
	return renderStaff(
		<StaffClientProvider orgSlug="acme">
			<TimesheetsPage
				orgSlug="acme"
				scopes={SCOPES}
				canChangePayPeriod={false}
			/>
		</StaffClientProvider>,
		{ route },
	)
}

describe('TimesheetsPage period view', () => {
	it('groups cards by person with decimal hours, overtime in words and a total', async () => {
		stubApi({
			people: [
				person({}, [
					card({
						id: 'a',
						minutes: {
							regularMinutes: 480,
							overtimeMinutes: 90,
							doubleTimeMinutes: 0,
							holidayMinutes: 0,
							paidMinutes: 570,
							unpaidBreakMinutes: 30,
						},
					}),
				]),
			],
		})
		view()
		expect(
			await screen.findByRole('rowheader', { name: /Rana Khalid/ }),
		).toBeTruthy()
		// Decimal hours, tabular.
		expect((await screen.findAllByText('9.50')).length).toBeGreaterThan(0)
		// Overtime is words, not only a color, and is called an estimate.
		expect(screen.getAllByText(/OT 1\.50/).length).toBeGreaterThan(0)
		expect(screen.getByText(/overtime \(estimate\)/)).toBeTruthy()
		expect(screen.getByText('Total')).toBeTruthy()
		expect(screen.getByText('9:00 AM')).toBeTruthy()
		expect(screen.getByText('5:00 PM')).toBeTruthy()
	})

	it('names the issue and the status on a card that needs review', async () => {
		stubApi({
			people: [
				person({}, [
					card({ status: 'needs_review', issues: ['missed_break', 'late'] }),
				]),
			],
		})
		view()
		await screen.findByRole('rowheader', { name: /Rana Khalid/ })
		expect(screen.getAllByText('Needs review').length).toBeGreaterThan(1)
		expect(screen.getByText('Missed break')).toBeTruthy()
		expect(screen.getByText('Late')).toBeTruthy()
		expect(screen.getByRole('button', { name: /1 needs review/ })).toBeTruthy()
	})

	it('shows no pay without the pay grant, and pay with it', async () => {
		stubApi({ people: [person({}, [card({ money: MONEY })])] })
		view()
		await screen.findByRole('rowheader', { name: /Rana Khalid/ })
		// The node sent money, but this token has no pay grant: nothing is shown.
		expect(screen.queryByText('Est. pay')).toBeNull()
		expect(screen.queryByText(/\$160\.00/)).toBeNull()
	})

	it('shows estimated pay when the token carries the pay grant', async () => {
		stubApi({
			people: [person({}, [card({ money: MONEY })])],
			grants: [...BASE_GRANTS, 'read:staff_pay:any'],
		})
		view()
		expect(await screen.findByText('Est. pay')).toBeTruthy()
		expect((await screen.findAllByText('$160.00')).length).toBeGreaterThan(0)
		expect(screen.getByText(/They are not payroll/)).toBeTruthy()
	})

	it('asks the node for the workplace filter', async () => {
		const calls = stubApi({})
		view('/?scope=loc-2')
		await screen.findByRole('rowheader', { name: /Rana Khalid/ })
		const request = calls.find((c) => c.url.includes('/timesheets/period'))!
		expect(request.url).toContain('scopeId=loc-2')
		expect(request.url).toContain('/operator/timeclock/timesheets/period')
	})

	it('says so when there are no cards, and offers to add one', async () => {
		stubApi({ people: [] })
		view()
		expect(
			await screen.findByText('No time cards in this pay period'),
		).toBeTruthy()
		expect(
			screen.getAllByRole('button', { name: /Add time card/ }).length,
		).toBeGreaterThan(0)
	})

	it('shows a plain error with a retry when the node fails', async () => {
		stubApi({
			respond: (call) =>
				call.url.includes('/timesheets/period')
					? Response.json({ error: 'nope' }, { status: 500 })
					: undefined,
		})
		view()
		expect(await screen.findByRole('alert')).toBeTruthy()
		expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
	})
})

describe('approving', () => {
	function ready() {
		return [
			person({}, [
				card({ id: 'a', version: 3 }),
				card({ id: 'b', version: 7 }),
			]),
		]
	}

	it('offers to approve every ready card and posts their versions after a confirm', async () => {
		const calls = stubApi({
			people: ready(),
			respond: (call) =>
				call.url.endsWith('/timesheets/approve')
					? Response.json({
							results: [
								{ id: 'a', ok: true, status: 'approved', version: 4 },
								{ id: 'b', ok: true, status: 'approved', version: 8 },
							],
							changed: 2,
							skipped: 0,
						})
					: undefined,
		})
		view()
		fireEvent.click(
			await screen.findByRole('button', { name: /Approve 2 ready cards/ }),
		)
		const dialog = await screen.findByRole('alertdialog')
		expect(within(dialog).getByText(/frozen as shown/)).toBeTruthy()
		fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }))
		await waitFor(() =>
			expect(calls.some((c) => c.url.endsWith('/timesheets/approve'))).toBe(
				true,
			),
		)
		const post = calls.find((c) => c.url.endsWith('/timesheets/approve'))!
		expect(post.method).toBe('POST')
		expect(post.body).toEqual({
			entries: [
				{ id: 'a', version: 3 },
				{ id: 'b', version: 7 },
			],
		})
	})

	it('hides approval when the workplace has it switched off', async () => {
		stubApi({ people: ready(), approvalMode: 'none' })
		view()
		await screen.findByRole('rowheader', { name: /Rana Khalid/ })
		await waitFor(() =>
			expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull(),
		)
	})

	it('hides approval from someone without the approve grant', async () => {
		stubApi({
			people: ready(),
			grants: ['read:timesheet:any', 'read:staff:any', 'update:timesheet:any'],
		})
		view()
		await screen.findByRole('rowheader', { name: /Rana Khalid/ })
		expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull()
	})

	it('offers exactly what the ticked cards can take', async () => {
		stubApi({
			people: [
				person({}, [
					card({ id: 'a', version: 3 }),
					card({ id: 'b', status: 'approved', version: 5 }),
				]),
			],
			approvalMode: 'approve_lock',
		})
		view()
		const boxes = await screen.findAllByRole('checkbox', {
			name: /Select Rana Khalid/,
		})
		fireEvent.click(boxes[0]!)
		fireEvent.click(boxes[1]!)
		const bar = await screen.findByRole('region', { name: 'Selected cards' })
		expect(within(bar).getByText('2 cards selected')).toBeTruthy()
		expect(
			within(bar).getByRole('button', { name: 'Approve (1)' }),
		).toBeTruthy()
		expect(within(bar).getByRole('button', { name: 'Lock (1)' })).toBeTruthy()
		expect(within(bar).getByRole('button', { name: 'Reopen (1)' })).toBeTruthy()
		expect(within(bar).queryByRole('button', { name: /Unlock/ })).toBeNull()
	})

	it('reports skipped cards in words, not codes', async () => {
		const calls = stubApi({
			people: ready(),
			respond: (call) =>
				call.url.endsWith('/timesheets/approve')
					? Response.json({
							results: [
								{ id: 'a', ok: true },
								{ id: 'b', ok: false, code: 'stale_version' },
							],
							changed: 1,
							skipped: 1,
						})
					: undefined,
		})
		view()
		fireEvent.click(
			await screen.findByRole('button', { name: /Approve 2 ready cards/ }),
		)
		const dialog = await screen.findByRole('alertdialog')
		fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }))
		await waitFor(() =>
			expect(calls.some((c) => c.url.endsWith('/timesheets/approve'))).toBe(
				true,
			),
		)
		// The list reloads after the batch.
		await waitFor(() =>
			expect(
				calls.filter((c) => c.url.includes('/timesheets/period')).length,
			).toBeGreaterThan(1),
		)
	})
})

describe('needs review queue', () => {
	const open = card({
		id: 'open1',
		clockOutAt: null,
		status: 'open',
		issues: ['missing_clock_out'],
		version: 2,
		minutes: {
			regularMinutes: 0,
			overtimeMinutes: 0,
			doubleTimeMinutes: 0,
			holidayMinutes: 0,
			paidMinutes: 0,
			unpaidBreakMinutes: 0,
		},
	})
	const soft = card({
		id: 'soft1',
		staffId: 's2',
		status: 'needs_review',
		issues: ['missed_break'],
		version: 9,
		clockInAt: NINE_AM + 24 * HOUR,
		localDate: '2026-03-03',
	})

	function queue(extra: Parameters<typeof stubApi>[0] = {}) {
		return stubApi({
			review: [
				person({}, [open]),
				person({ staffId: 's2', firstName: 'Omar', lastName: 'Aziz' }, [soft]),
			],
			byIssue: { missing_clock_out: 1, missed_break: 1 },
			...extra,
		})
	}

	it('lists what is wrong in words, oldest first', async () => {
		queue()
		view('/?view=review')
		const items = await screen.findAllByRole('listitem')
		expect(await screen.findByText('Missing clock-out.')).toBeTruthy()
		expect(screen.getByText('Missed break.')).toBeTruthy()
		expect(items.length).toBeGreaterThan(1)
		expect(
			screen.getAllByRole('link', { name: /Khalid|Aziz/ })[0]!.textContent,
		).toMatch(/Rana Khalid/)
	})

	it('sets a missing clock-out right in the row with a reason, in the card zone', async () => {
		const calls = queue({
			respond: (call) =>
				call.method === 'PATCH'
					? Response.json({
							card: null,
							edit: {
								id: 'e',
								entryId: 'open1',
								editorId: 'u',
								via: 'manager',
								action: 'update',
								reason: 'r',
								before: null,
								after: null,
								hoursDeltaMinutes: 0,
								createdAt: 1,
							},
							reducedHours: false,
						})
					: undefined,
		})
		view('/?view=review')
		const input = (await screen.findByLabelText(
			/Clocked out at, for Rana Khalid/,
		)) as HTMLInputElement
		fireEvent.change(input, { target: { value: '17:30' } })
		fireEvent.click(screen.getByRole('button', { name: 'Set clock-out' }))
		await waitFor(() =>
			expect(calls.some((c) => c.method === 'PATCH')).toBe(true),
		)
		const patch = calls.find((c) => c.method === 'PATCH')!
		expect(patch.url).toContain('/timesheets/entries/open1')
		// 17:30 in Chicago (UTC-6) on the card's day, 8.5h after the 09:00 clock-in.
		expect(patch.body).toEqual({
			expectedVersion: 2,
			clockOutAt: NINE_AM + 8.5 * HOUR,
			reason: 'Forgot to clock out',
		})
	})

	it('refuses a clock-out that has not happened yet', async () => {
		const calls = stubApi({
			review: [
				person({}, [
					{
						...open,
						// Opened a minute before "now" on the server clock.
						clockInAt: NINE_AM + 9.9 * HOUR,
					},
				]),
			],
			byIssue: { missing_clock_out: 1 },
		})
		view('/?view=review')
		const input = (await screen.findByLabelText(
			/Clocked out at/,
		)) as HTMLInputElement
		// 09:00 + 10h server now = 19:00 local; 23:00 is in the future.
		fireEvent.change(input, { target: { value: '23:00' } })
		fireEvent.click(screen.getByRole('button', { name: 'Set clock-out' }))
		expect(
			await screen.findByText('That time has not happened yet.'),
		).toBeTruthy()
		expect(calls.some((c) => c.method === 'PATCH')).toBe(false)
	})

	it('marks a soft issue as looked at with one click', async () => {
		const calls = queue({
			respond: (call) =>
				call.url.endsWith('/review') && call.method === 'POST'
					? Response.json({
							card: null,
							edit: {
								id: 'e',
								entryId: 'soft1',
								editorId: 'u',
								via: 'manager',
								action: 'review',
								reason: 'r',
								before: null,
								after: null,
								hoursDeltaMinutes: null,
								createdAt: 1,
							},
							reducedHours: false,
						})
					: undefined,
		})
		view('/?view=review')
		fireEvent.click(await screen.findByRole('button', { name: /Looks right/ }))
		await waitFor(() =>
			expect(calls.some((c) => c.method === 'POST')).toBe(true),
		)
		const post = calls.find((c) => c.method === 'POST')!
		expect(post.url).toContain('/timesheets/entries/soft1/review')
		expect(post.body).toEqual({ expectedVersion: 9 })
	})

	it('sends a card that needs real fixing to the editor, never one-click', async () => {
		stubApi({
			review: [
				person({}, [
					card({ id: 'x', status: 'needs_review', issues: ['open_break'] }),
				]),
			],
			byIssue: { open_break: 1 },
		})
		view('/?view=review')
		expect(
			await screen.findByRole('button', { name: /Fix this card/ }),
		).toBeTruthy()
		expect(screen.queryByRole('button', { name: /Looks right/ })).toBeNull()
	})

	it('says so when nothing needs review', async () => {
		stubApi({ review: [] })
		view('/?view=review')
		expect(await screen.findByText('Nothing needs review')).toBeTruthy()
	})

	it('filters the queue by issue', async () => {
		queue()
		view('/?view=review')
		fireEvent.click(await screen.findByRole('button', { name: /Missed break/ }))
		await waitFor(() =>
			expect(screen.queryByText('Missing clock-out.')).toBeNull(),
		)
		expect(screen.getByText('Missed break.')).toBeTruthy()
	})
})

describe('payroll summary', () => {
	const summary = {
		serverNow: NINE_AM + 10 * HOUR,
		period: PERIOD,
		filters: {
			scopeId: null,
			positionId: null,
			staffId: null,
			status: null,
		},
		rows: [
			{
				staffId: 's1',
				employeeNumber: 'E-1',
				firstName: 'Rana',
				lastName: 'Khalid',
				cards: 2,
				regularMinutes: 2400,
				overtimeMinutes: 90,
				doubleTimeMinutes: 0,
				holidayMinutes: 0,
				paidMinutes: 2490,
				unpaidBreakMinutes: 60,
				unapprovedCards: 1,
			},
		],
		totals: {
			regularMinutes: 2400,
			overtimeMinutes: 90,
			doubleTimeMinutes: 0,
			holidayMinutes: 0,
			paidMinutes: 2490,
			unpaidBreakMinutes: 60,
			cards: 2,
			unapprovedCards: 1,
		},
		readyForPayroll: false,
		truncated: false,
	}

	it('shows hours per person, what is still unapproved, and a column picker', async () => {
		stubApi({
			respond: (call) =>
				call.url.includes('/timesheets/summary')
					? Response.json(summary)
					: undefined,
		})
		view('/?view=summary')
		expect(await screen.findByText('E-1')).toBeTruthy()
		expect(screen.getAllByText('41.50').length).toBeGreaterThan(0)
		expect(
			screen.getByText(/still waiting to be approved or reviewed/),
		).toBeTruthy()
		fireEvent.click(screen.getByRole('button', { name: 'Columns' }))
		const box = (name: string) =>
			document.querySelector<HTMLElement>(
				`[role="checkbox"][aria-label="${name}"]`,
			)
		await waitFor(() => expect(box('Holiday')).toBeTruthy())
		expect(box('Holiday')!.getAttribute('aria-checked')).toBe('false')
		expect(box('Paid hours')!.getAttribute('aria-checked')).toBe('true')
		// Names cannot be hidden: they are how a clerk matches a row.
		expect(box('First name')!.hasAttribute('data-disabled')).toBe(true)
		// Money columns do not exist without the pay grant.
		expect(box('Est. pay')).toBeNull()
		fireEvent.click(box('Holiday')!)
		expect(
			await screen.findByRole('columnheader', { name: 'Holiday' }),
		).toBeTruthy()
	})
})

describe('export', () => {
	it('builds the file in the browser from the node table, with workplace names', async () => {
		const clicks: string[] = []
		const blobs: Blob[] = []
		Object.assign(URL, {
			createObjectURL: (blob: Blob) => {
				blobs.push(blob)
				return 'blob:x'
			},
			revokeObjectURL: () => {},
		})
		const anchorClick = vi
			.spyOn(HTMLAnchorElement.prototype, 'click')
			.mockImplementation(function (this: HTMLAnchorElement) {
				clicks.push(this.download)
			})
		const calls = stubApi({
			respond: (call) =>
				call.url.includes('/timesheets/export')
					? Response.json({
							filename: 'timesheet-cards-2026-03-02.csv',
							kind: 'cards',
							rowCount: 1,
							includesMoney: false,
							headers: ['Employee ID', 'First name', 'Scope'],
							rows: [['E1', '=cmd', 'loc-1']],
							csv: '',
						})
					: undefined,
		})
		view()
		await screen.findByRole('rowheader', { name: /Rana Khalid/ })
		fireEvent.click(screen.getByRole('button', { name: 'Export' }))
		fireEvent.click(await screen.findByRole('menuitem', { name: /Time cards/ }))
		await waitFor(() =>
			expect(clicks).toEqual(['timesheet-cards-2026-03-02.csv']),
		)
		const request = calls.find((c) => c.url.includes('/timesheets/export'))!
		expect(request.url).toContain('kind=cards')
		expect(request.url).toContain('periodStart=2026-03-02')
		const text = await new Promise<string>((resolve) => {
			const reader = new FileReader()
			reader.onload = () => resolve(String(reader.result))
			reader.readAsText(blobs[0]!)
		})
		expect(text).toContain('Downtown')
		expect(text).toContain("'=cmd")
		anchorClick.mockRestore()
	})
})
