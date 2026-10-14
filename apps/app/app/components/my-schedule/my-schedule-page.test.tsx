// @vitest-environment jsdom

import { formatScheduleLinkToken } from '@repo/staffing'
import {
	cleanup,
	fireEvent,
	screen,
	waitFor,
	within,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderStaff } from '#tests/staff-render.tsx'
import { MySchedulePage } from './my-schedule-page.tsx'

// Catalog loading and the language switch are covered elsewhere; keep the page
// on English so these tests read what it says.
vi.mock('#app/utils/kiosk/kiosk-locale.ts', () => ({
	initialKioskLocale: () => 'en',
	activateKioskLocale: async () => {},
	preloadKioskCatalogs: async () => {},
}))

const URLS = { us: 'https://us.tenant.test', ksa: 'https://ksa.tenant.test' }
const TOKEN = formatScheduleLinkToken('org_1', 'link-0001', 'a'.repeat(64))
const HOUR = 3_600_000
// Wednesday 2026-03-04 at 12:00 in Chicago.
const NOW = Date.UTC(2026, 2, 4, 18, 0, 0)
const at = (day: number, hour: number) => Date.UTC(2026, 2, day, hour + 6, 0, 0)

const shift = (id: string, day: number, start: number, end: number) => ({
	id,
	scopeId: 'loc-1',
	positionName: 'Cook',
	positionNameAr: null,
	startsAt: at(day, start),
	endsAt: at(day, end),
	localDate: `2026-03-${String(day).padStart(2, '0')}`,
	timeZone: 'America/Chicago',
	unpaidBreakMinutes: 30,
	notes: id === 's2' ? 'Bring your apron' : null,
})

const schedule = (overrides: Record<string, unknown> = {}) => ({
	serverNow: NOW,
	person: { firstName: 'Ana', firstNameAr: null, locale: 'en' },
	scopes: [
		{
			id: 'loc-1',
			name: 'Downtown',
			timeZone: 'America/Chicago',
			scheduleVisibility: 'own',
		},
	],
	from: '2026-03-03',
	to: '2026-04-06',
	shifts: [
		// Yesterday, later today, and the day after tomorrow.
		shift('s1', 3, 9, 17),
		shift('s2', 4, 15, 23),
		shift('s3', 6, 9, 13),
	],
	link: { expiresAt: NOW + 90 * 24 * HOUR },
	...overrides,
})

type Call = {
	path: string
	search: string
	method: string
	body: any
	auth: string | null
}
type Handler = (call: Call) => Response | Promise<Response> | undefined

function stub(handler: Handler = () => undefined) {
	const calls: Call[] = []
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input))
			const call: Call = {
				path: url.pathname,
				search: url.search,
				method: init?.method ?? 'GET',
				body: init?.body ? JSON.parse(String(init.body)) : null,
				auth: new Headers(init?.headers).get('Authorization'),
			}
			calls.push(call)
			const custom = await handler(call)
			if (custom) return custom
			if (call.path === '/schedule-link/me') return Response.json(schedule())
			if (call.path === '/schedule-link/me/requests') {
				return Response.json({
					timeOff: [],
					availability: [],
					shiftRequests: [],
				})
			}
			if (call.path === '/schedule-link/me/time-cards') {
				return Response.json({
					serverNow: NOW,
					from: '2026-02-05',
					to: '2026-03-04',
					cards: [],
				})
			}
			return Response.json({ error: 'not_found' }, { status: 404 })
		}),
	)
	return calls
}

function open(hash = `#r=us&t=${TOKEN}`) {
	window.history.replaceState(null, '', `/my-schedule${hash}`)
	return renderStaff(<MySchedulePage urls={URLS} />)
}

beforeEach(() => {
	sessionStorage.clear()
	localStorage.clear()
	vi.useFakeTimers({ toFake: ['Date'] })
	vi.setSystemTime(NOW)
})
afterEach(() => {
	cleanup()
	vi.unstubAllGlobals()
	vi.useRealTimers()
})

describe('opening the link', () => {
	it('shows the persons own shifts from the regional node, with the token only in the header', async () => {
		const calls = stub()
		open()
		expect(await screen.findByRole('heading', { name: 'Hi Ana' })).toBeTruthy()
		const list = await screen.findByText(/9:00\sAM\s–\s5:00\sPM/)
		expect(list).toBeTruthy()
		expect(screen.getByText('Bring your apron')).toBeTruthy()
		expect(screen.getAllByText(/3:00\sPM\s–\s11:00\sPM/)).toHaveLength(2)
		expect(screen.getAllByText('Cook')).toHaveLength(3)
		expect(screen.getByText(/Next shift: Wed, Mar 4/)).toBeTruthy()

		const [call] = calls
		expect(call!.path).toBe('/schedule-link/me')
		expect(call!.auth).toBe(`Bearer ${TOKEN}`)
		expect(call!.search).toBe('')
		// The fragment never stays in the address bar, or the history.
		expect(window.location.hash).toBe('')
		expect(window.location.href).not.toContain('slk1')
	})

	it('uses the node of the region in the link', async () => {
		const calls = stub()
		open(`#r=ksa&t=${TOKEN}`)
		await screen.findByRole('heading', { name: 'Hi Ana' })
		expect(fetch).toHaveBeenCalledWith(
			expect.stringContaining('https://ksa.tenant.test/schedule-link/me'),
			expect.anything(),
		)
		expect(calls).toHaveLength(1)
	})

	it('marks today and keeps the past quiet', async () => {
		stub()
		open()
		const today = await screen.findByText('Today', { selector: 'p' })
		expect(
			today.closest('[role="listitem"]')?.getAttribute('aria-current'),
		).toBe('date')
	})

	it('explains a page opened without a link, and asks the server nothing', async () => {
		const calls = stub()
		open('')
		expect(
			await screen.findByRole('heading', {
				name: 'Open your schedule from your email',
			}),
		).toBeTruthy()
		expect(calls).toHaveLength(0)
	})

	it('survives a reload within the tab, using the stored link', async () => {
		stub()
		const first = open()
		await screen.findByRole('heading', { name: 'Hi Ana' })
		first.unmount()
		const calls = stub()
		window.history.replaceState(null, '', '/my-schedule')
		renderStaff(<MySchedulePage urls={URLS} />)
		await screen.findByRole('heading', { name: 'Hi Ana' })
		expect(calls[0]!.auth).toBe(`Bearer ${TOKEN}`)
	})

	it.each([
		['link_revoked', 'This link was turned off'],
		['link_expired', 'This link has expired'],
		['invalid_link', 'This link does not work'],
		['staff_inactive', 'This schedule is no longer available'],
		['schedule_disabled', 'The schedule is not available right now'],
	])(
		'replaces the page when the link answers %s, and forgets it',
		async (code, title) => {
			stub(() => Response.json({ error: code }, { status: 401 }))
			open()
			expect(await screen.findByRole('heading', { name: title })).toBeTruthy()
			expect(screen.queryByText('Schedule')).toBeNull()
			await waitFor(() => expect(sessionStorage).toHaveLength(0))
		},
	)

	it('keeps what it has and says so when the connection drops', async () => {
		let down = false
		stub(() => {
			if (down) throw new TypeError('Failed to fetch')
			return undefined
		})
		open()
		await screen.findByRole('heading', { name: 'Hi Ana' })
		down = true
		fireEvent.click(screen.getByRole('button', { name: 'Later weeks' }))
		expect(
			await screen.findByText(/No connection\. Check your internet/),
		).toBeTruthy()
		expect(screen.getByText(/Bring your apron/)).toBeTruthy()
	})

	it('moves the window of weeks and comes back to today', async () => {
		const calls = stub()
		open()
		await screen.findByRole('heading', { name: 'Hi Ana' })
		fireEvent.click(screen.getByRole('button', { name: 'Later weeks' }))
		await waitFor(() =>
			expect(calls.some((c) => c.search.includes('from=2026-03-31'))).toBe(
				true,
			),
		)
		fireEvent.click(screen.getByRole('button', { name: 'Earlier weeks' }))
		await waitFor(() =>
			expect(calls.some((c) => c.search.includes('from=2026-02-03'))).toBe(
				true,
			),
		)
		fireEvent.click(screen.getByRole('button', { name: 'Today' }))
		await waitFor(() => expect(calls.at(-1)!.search).toBe(''))
	})

	it('says plainly when nothing is published', async () => {
		stub((call) =>
			call.path === '/schedule-link/me'
				? Response.json(schedule({ shifts: [] }))
				: undefined,
		)
		open()
		expect(
			await screen.findByText(/No shifts are published for these dates/),
		).toBeTruthy()
		expect(screen.getByText('No upcoming shifts are published.')).toBeTruthy()
	})
})

describe('time cards', () => {
	it('loads when opened and shows the edit history, never pay', async () => {
		const calls = stub((call) =>
			call.path === '/schedule-link/me/time-cards'
				? Response.json({
						serverNow: NOW,
						from: '2026-02-05',
						to: '2026-03-04',
						cards: [
							{
								id: 'c1',
								scopeId: 'loc-1',
								positionName: 'Cook',
								positionNameAr: null,
								timeZone: 'America/Chicago',
								localDate: '2026-03-02',
								clockInAt: at(2, 9),
								clockOutAt: at(2, 17),
								status: 'approved',
								paidMinutes: 450,
								unpaidBreakMinutes: 30,
								edited: true,
								edits: [
									{
										id: 'e1',
										action: 'update',
										via: 'manager',
										reason: 'Forgot to clock out',
										hoursDeltaMinutes: -30,
										before: { clockInAt: at(2, 9), clockOutAt: null },
										after: { clockInAt: at(2, 9), clockOutAt: at(2, 17) },
										createdAt: at(3, 8),
									},
								],
							},
						],
					})
				: undefined,
		)
		open()
		await screen.findByRole('heading', { name: 'Hi Ana' })
		expect(calls.some((c) => c.path.endsWith('/time-cards'))).toBe(false)
		fireEvent.click(screen.getByRole('tab', { name: 'Time cards' }))
		expect((await screen.findAllByText('7 h 30 min')).length).toBeGreaterThan(0)
		expect(screen.getByText('Approved')).toBeTruthy()
		expect(screen.getByText('Edited')).toBeTruthy()
		fireEvent.click(screen.getByRole('button', { name: /Show changes/ }))
		expect(screen.getByText(/A manager changed this time card\./)).toBeTruthy()
		expect(screen.getByText('Reason: Forgot to clock out')).toBeTruthy()
		expect(screen.getByText(/Clock out – to 5:00\sPM/)).toBeTruthy()
		expect(screen.getByText('-0:30')).toBeTruthy()
		expect(screen.getByText(/talk to your manager/)).toBeTruthy()
		expect(document.body.textContent).not.toMatch(/rate|wage|tips|\$/i)
	})
})

describe('requests', () => {
	it('sends a time-off request and shows it waiting', async () => {
		const calls = stub((call) => {
			if (
				call.path === '/schedule-link/me/time-off' &&
				call.method === 'POST'
			) {
				return Response.json(
					{
						id: 't1',
						category: 'sick',
						startDate: '2026-03-10',
						endDate: '2026-03-11',
						allDay: true,
						startMinute: null,
						endMinute: null,
						note: 'Flu',
						status: 'pending',
						decisionNote: null,
						createdAt: NOW,
					},
					{ status: 201 },
				)
			}
			return undefined
		})
		open()
		await screen.findByRole('heading', { name: 'Hi Ana' })
		fireEvent.click(screen.getByRole('tab', { name: 'Requests' }))
		fireEvent.click(
			await screen.findByRole('button', { name: 'Request time off' }),
		)
		const sheet = await screen.findByRole('dialog')
		fireEvent.change(within(sheet).getByLabelText('First day'), {
			target: { value: '2026-03-10' },
		})
		fireEvent.change(within(sheet).getByLabelText('Last day'), {
			target: { value: '2026-03-11' },
		})
		fireEvent.change(within(sheet).getByLabelText(/Note for your manager/), {
			target: { value: 'Flu' },
		})
		fireEvent.click(within(sheet).getByRole('button', { name: 'Send request' }))
		await waitFor(() =>
			expect(
				calls.find((c) => c.path === '/schedule-link/me/time-off'),
			).toBeTruthy(),
		)
		expect(
			calls.find((c) => c.path === '/schedule-link/me/time-off')!.body,
		).toEqual({
			category: 'unpaid',
			startDate: '2026-03-10',
			endDate: '2026-03-11',
			allDay: true,
			note: 'Flu',
		})
	})

	it('refuses an end before the start without asking the server', async () => {
		const calls = stub()
		open()
		await screen.findByRole('heading', { name: 'Hi Ana' })
		fireEvent.click(screen.getByRole('tab', { name: 'Requests' }))
		fireEvent.click(
			await screen.findByRole('button', { name: 'Request time off' }),
		)
		const sheet = await screen.findByRole('dialog')
		fireEvent.change(within(sheet).getByLabelText('Last day'), {
			target: { value: '2026-03-01' },
		})
		fireEvent.click(within(sheet).getByRole('button', { name: 'Send request' }))
		expect(
			await within(sheet).findByText(
				'The last day cannot be before the first day.',
			),
		).toBeTruthy()
		expect(calls.some((c) => c.method === 'POST')).toBe(false)
	})

	it('lists what was asked for, in words, and takes back only what is waiting', async () => {
		const calls = stub((call) => {
			if (call.path === '/schedule-link/me/requests') {
				return Response.json({
					timeOff: [
						{
							id: 't1',
							category: 'pto',
							startDate: '2026-03-10',
							endDate: '2026-03-12',
							allDay: true,
							startMinute: null,
							endMinute: null,
							note: null,
							status: 'pending',
							decisionNote: null,
							createdAt: NOW,
						},
						{
							id: 't2',
							category: 'sick',
							startDate: '2026-03-20',
							endDate: '2026-03-20',
							allDay: true,
							startMinute: null,
							endMinute: null,
							note: null,
							status: 'rejected',
							decisionNote: 'We are short that day',
							createdAt: NOW,
						},
					],
					availability: [],
					shiftRequests: [
						{
							id: 'r1',
							kind: 'cover',
							shiftId: 's2',
							localDate: '2026-03-05',
							startsAt: at(5, 10),
							endsAt: at(5, 18),
							timeZone: 'America/Chicago',
							targetName: 'Ben O.',
							note: null,
							status: 'pending',
							decisionNote: null,
							createdAt: NOW,
						},
					],
				})
			}
			if (call.path === '/schedule-link/me/time-off/t1/cancel') {
				return Response.json({
					id: 't1',
					category: 'pto',
					startDate: '2026-03-10',
					endDate: '2026-03-12',
					allDay: true,
					startMinute: null,
					endMinute: null,
					note: null,
					status: 'cancelled',
					decisionNote: null,
					createdAt: NOW,
				})
			}
			return undefined
		})
		open()
		await screen.findByRole('heading', { name: 'Hi Ana' })
		fireEvent.click(screen.getByRole('tab', { name: 'Requests' }))
		expect(await screen.findByText('Paid time off')).toBeTruthy()
		expect(screen.getByText('Not approved')).toBeTruthy()
		expect(screen.getByText('We are short that day')).toBeTruthy()
		expect(screen.getByText(/Ben O\. to cover Thu, Mar 5/)).toBeTruthy()
		// Only the two waiting ones can be cancelled.
		expect(
			screen.getAllByRole('button', { name: 'Cancel request' }),
		).toHaveLength(2)
		fireEvent.click(
			screen.getAllByRole('button', { name: 'Cancel request' })[0]!,
		)
		await waitFor(() =>
			expect(
				calls.some((c) => c.path === '/schedule-link/me/time-off/t1/cancel'),
			).toBe(true),
		)
	})

	it('says why a request failed, in plain words', async () => {
		stub((call) =>
			call.path === '/schedule-link/me/time-off' && call.method === 'POST'
				? Response.json({ error: 'too_many_pending' }, { status: 409 })
				: undefined,
		)
		open()
		await screen.findByRole('heading', { name: 'Hi Ana' })
		fireEvent.click(screen.getByRole('tab', { name: 'Requests' }))
		fireEvent.click(
			await screen.findByRole('button', { name: 'Request time off' }),
		)
		const sheet = await screen.findByRole('dialog')
		fireEvent.click(within(sheet).getByRole('button', { name: 'Send request' }))
		expect(
			await within(sheet).findByText(/already have a lot of requests waiting/),
		).toBeTruthy()
	})
})

describe('asking for a change to a shift', () => {
	it('gives a shift away, and offers a cover only with teammates to ask', async () => {
		const calls = stub((call) => {
			if (call.path === '/schedule-link/me/teammates') {
				return Response.json({
					teammates: [{ id: 'b1', name: 'Ben O.' }],
					swapCandidates: [],
					canSwap: false,
				})
			}
			if (call.path === '/schedule-link/me/shift-requests') {
				return Response.json(
					{
						id: 'r1',
						kind: 'drop',
						shiftId: 's2',
						localDate: '2026-03-05',
						startsAt: at(5, 10),
						endsAt: at(5, 18),
						timeZone: 'America/Chicago',
						targetName: null,
						note: 'Appointment',
						status: 'pending',
						decisionNote: null,
						createdAt: NOW,
					},
					{ status: 201 },
				)
			}
			return undefined
		})
		open()
		await screen.findByRole('heading', { name: 'Hi Ana' })
		// The shift that has not started yet offers the action; the one that has, does not.
		const buttons = screen.getAllByRole('button', { name: 'Ask for a change' })
		expect(buttons).toHaveLength(2)
		fireEvent.click(buttons[0]!)
		const sheet = await screen.findByRole('dialog')
		expect(
			await within(sheet).findByRole('radio', { name: 'I cannot work it' }),
		).toBeTruthy()
		expect(
			within(sheet).getByRole('radio', { name: 'Ask a teammate to cover it' }),
		).toBeTruthy()
		expect(
			within(sheet).queryByRole('radio', { name: 'Swap it for one of theirs' }),
		).toBeNull()
		fireEvent.change(within(sheet).getByLabelText(/Note for your manager/), {
			target: { value: 'Appointment' },
		})
		fireEvent.click(within(sheet).getByRole('button', { name: 'Send request' }))
		await waitFor(() =>
			expect(
				calls.find((c) => c.path === '/schedule-link/me/shift-requests'),
			).toBeTruthy(),
		)
		expect(
			calls.find((c) => c.path === '/schedule-link/me/shift-requests')!.body,
		).toEqual({ kind: 'drop', shiftId: 's2', note: 'Appointment' })
		expect(
			calls.find((c) => c.path === '/schedule-link/me/teammates')!.search,
		).toBe('?shiftId=s2')
	})

	it('offers a swap only where the workplace allows it', async () => {
		stub((call) =>
			call.path === '/schedule-link/me/teammates'
				? Response.json({
						teammates: [{ id: 'b1', name: 'Ben O.' }],
						swapCandidates: [
							{
								id: 'x1',
								staffId: 'b1',
								startsAt: at(6, 10),
								endsAt: at(6, 18),
								localDate: '2026-03-06',
								timeZone: 'America/Chicago',
								positionName: 'Cook',
								positionNameAr: null,
							},
						],
						canSwap: true,
					})
				: undefined,
		)
		open()
		await screen.findByRole('heading', { name: 'Hi Ana' })
		fireEvent.click(
			screen.getAllByRole('button', { name: 'Ask for a change' })[0]!,
		)
		const sheet = await screen.findByRole('dialog')
		const swap = await within(sheet).findByRole('radio', {
			name: 'Swap it for one of theirs',
		})
		// Send is not available until the swap is complete.
		fireEvent.click(swap)
		expect(
			within(sheet).getByRole('button', { name: 'Send request' }),
		).toBeDisabled()
	})
})
