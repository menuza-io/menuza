// @vitest-environment jsdom

import { addDays } from '@repo/staffing'
import {
	cleanup,
	fireEvent,
	screen,
	waitFor,
	within,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StaffClientProvider } from '#app/components/staff/staff-client-provider.tsx'
import {
	DATES,
	demand,
	HOUR,
	NINE_AM,
	person,
	shift,
	week,
} from '#app/utils/staffing/schedule-fixtures.ts'
import { renderStaff } from '#tests/staff-render.tsx'
import { SchedulePage } from './schedule-page.tsx'

type Call = { method: string; url: string; body?: unknown }

function stub(weekBody: unknown, onWrite?: (call: Call) => unknown) {
	const calls: Call[] = []
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input)
			if (url.includes('/staff/token')) {
				return Response.json({
					jwt: 'j',
					tenantApiUrl: 'https://us.tenant.test',
					scope: 'schedule',
					grants: [
						'read:schedule:any',
						'update:schedule:any',
						'read:staff:any',
						'read:labor:any',
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
			if (url.includes('/week')) {
				// Each requested week comes back as itself, so a month never repeats a day.
				const requested = new URL(url).searchParams.get('date')
				const base = weekBody as ReturnType<typeof week>
				if (!requested || base.dates.includes(requested))
					return Response.json(base)
				const dates = Array.from({ length: 7 }, (ignored, i) =>
					addDays(requested, i),
				)
				return Response.json({
					...base,
					weekStart: requested,
					weekEnd: dates[6],
					dates,
					shifts: [],
					footers: dates.map((date) => ({
						date,
						minutes: 0,
						overtimeMinutes: 0,
						headcount: 0,
						openShifts: 0,
						openMinutes: 0,
					})),
				})
			}
			if (url.includes('/demand')) return Response.json(demand())
			return Response.json(onWrite ? onWrite(call) : {})
		}),
	)
	return calls
}

function view(route: string) {
	return renderStaff(
		<StaffClientProvider orgSlug="acme">
			<SchedulePage
				orgSlug="acme"
				scopes={[
					{ id: 'loc-1', name: 'Downtown', timeZone: 'America/Chicago' },
				]}
			/>
		</StaffClientProvider>,
		{ route },
	)
}

beforeEach(() => {
	window.innerWidth = 1200
})
afterEach(async () => {
	// Let a reload started by the last action finish while the stub is still in place.
	await new Promise((resolve) => setTimeout(resolve, 30))
	cleanup()
	vi.unstubAllGlobals()
})

const withShifts = () =>
	week({
		people: [
			person({ id: 's1', firstName: 'Rana', lastName: 'Khalid' }),
			person({ id: 's2', firstName: 'Omar', lastName: 'Saleh' }),
		],
		shifts: [
			shift({ id: 'a', staffId: 's1', state: 'published' }),
			shift({
				id: 'late',
				staffId: 's2',
				state: 'draft',
				startsAt: NINE_AM + 12 * HOUR,
				endsAt: NINE_AM + 18 * HOUR,
			}),
		],
		footers: DATES.map((date, index) => ({
			date,
			minutes: index === 0 ? 900 : 0,
			overtimeMinutes: 0,
			headcount: index === 0 ? 2 : 0,
			openShifts: 0,
			openMinutes: 0,
			...(index === 0 ? { costMinorByCurrency: { USD: 25_000 } } : {}),
		})),
	})

describe('day timeline', () => {
	it('shows the day as hours across with each shift as a bar', async () => {
		stub(withShifts())
		view('/?view=day&date=2026-03-02')
		await screen.findByRole('table', {
			name: /Schedule for Downtown, Monday, March 2/,
		})
		expect(screen.getByRole('columnheader', { name: /Team/ })).toBeTruthy()
		expect(
			screen.getByRole('button', { name: /^Published, 9 AM – 5 PM/ }),
		).toBeTruthy()
		// A night shift that runs past midnight says so.
		const night = screen.getByRole('button', {
			name: /^Draft, 9 PM – 3 AM.*Ends the next day/,
		})
		expect(night).toBeTruthy()
		expect(screen.getByText('Typical online orders')).toBeTruthy()
		expect(screen.getByText(/2 people/)).toBeTruthy()
	})

	it('resizes by keyboard in 15 minute steps', async () => {
		const calls = stub(withShifts(), () => ({ shifts: [shift({ id: 'a' })] }))
		view('/?view=day&date=2026-03-02')
		const bar = await screen.findByRole('button', {
			name: /^Published, 9 AM – 5 PM/,
		})
		fireEvent.keyDown(bar, { key: 'ArrowUp', shiftKey: true })
		await waitFor(() =>
			expect(calls.some((c) => c.method === 'PATCH')).toBe(true),
		)
		expect(calls.find((c) => c.method === 'PATCH')!.body).toMatchObject({
			endTime: '17:15',
			startTime: '09:00',
		})
	})

	it('resizes by dragging the end handle and snaps to the grid', async () => {
		const calls = stub(withShifts(), () => ({ shifts: [shift({ id: 'a' })] }))
		view('/?view=day&date=2026-03-02')
		const bar = await screen.findByRole('button', {
			name: /^Published, 9 AM – 5 PM/,
		})
		const handles = bar.querySelectorAll(
			'span[aria-hidden="true"].cursor-ew-resize',
		)
		expect(handles).toHaveLength(2)
		const end = handles[1]!
		// jsdom has no pointer capture; stub the one method the handler calls.
		;(end as HTMLElement).setPointerCapture = () => {}
		fireEvent.pointerDown(end, { button: 0, clientX: 100, pointerId: 1 })
		// 56px is one hour on the timeline; a little under it snaps to the hour.
		fireEvent.pointerUp(end, { clientX: 100 + 52, pointerId: 1 })
		await waitFor(() =>
			expect(calls.some((c) => c.method === 'PATCH')).toBe(true),
		)
		expect(calls.find((c) => c.method === 'PATCH')!.body).toMatchObject({
			startTime: '09:00',
			endTime: '18:00',
		})
	})
})

describe('month view', () => {
	it('fetches each week of the month and shows people, hours and open shifts per day', async () => {
		const calls = stub(withShifts())
		view('/?view=month&date=2026-03-15')
		await screen.findByRole('button', {
			name: /Monday, March 2: 2 people scheduled/,
		})
		const weekCalls = calls.filter((c) =>
			c.url.includes('/operator/schedule/week'),
		)
		// March 2026 touches six workweeks; one request each, never a month-sized one.
		expect(weekCalls).toHaveLength(6)
		fireEvent.click(
			screen.getByRole('button', {
				name: /Monday, March 2: 2 people scheduled/,
			}),
		)
		// The day opens in the day view.
		await screen.findByRole('table', { name: /Monday, March 2/ })
	})
})

describe('labor cost', () => {
	it('shows the estimate row and says it is not payroll when the labor grant is held', async () => {
		stub(withShifts())
		view('/?date=2026-03-04')
		await screen.findByText('Estimated labor cost')
		expect(screen.getByText('$250.00')).toBeTruthy()
		expect(screen.getByText(/They are not payroll|not payroll/)).toBeTruthy()
	})
})

describe('printing', () => {
	it('titles the table for the page and marks the printable region', async () => {
		stub(withShifts())
		const { container } = view('/?date=2026-03-04')
		const table = await screen.findByRole('table', {
			name: /Schedule for Downtown/,
		})
		expect(container.querySelector('[data-print-root]')).toBeTruthy()
		const caption = within(table).getByText(/Schedule for Downtown/)
		expect(caption.className).toContain('print:not-sr-only')
	})
})
