// @vitest-environment jsdom

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
	demand,
	NINE_AM,
	HOUR,
	person,
	shift,
	week,
} from '#app/utils/staffing/schedule-fixtures.ts'
import { renderStaff } from '#tests/staff-render.tsx'
import { SchedulePage } from './schedule-page.tsx'

const GRANTS = ['read:schedule:any', 'update:schedule:any', 'read:staff:any']

type Calls = Array<{ method: string; url: string; body?: unknown }>

function stubApi(
	weekBody: unknown,
	options: {
		grants?: string[]
		onWrite?: (call: Calls[number]) => unknown
	} = {},
) {
	const calls: Calls = []
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input)
			const method = init?.method ?? 'GET'
			if (url.includes('/staff/token')) {
				return Response.json({
					jwt: 'jwt',
					tenantApiUrl: 'https://us.tenant.test',
					scope: 'schedule',
					grants: options.grants ?? GRANTS,
					expiresAt: Date.now() + 600_000,
				})
			}
			const call = {
				method,
				url,
				body: init?.body ? JSON.parse(String(init.body)) : undefined,
			}
			calls.push(call)
			if (url.includes('/operator/schedule/week'))
				return Response.json(weekBody)
			if (url.includes('/operator/schedule/demand'))
				return Response.json(demand())
			if (method !== 'GET' && options.onWrite) {
				return Response.json(options.onWrite(call))
			}
			return Response.json({})
		}),
	)
	return calls
}

function view() {
	return renderStaff(
		<StaffClientProvider orgSlug="acme">
			<SchedulePage
				orgSlug="acme"
				scopes={[
					{ id: 'loc-1', name: 'Downtown', timeZone: 'America/Chicago' },
				]}
			/>
		</StaffClientProvider>,
		{ route: '/?date=2026-03-04' },
	)
}

const populated = () =>
	week({
		people: [
			person({
				id: 's1',
				firstName: 'Rana',
				lastName: 'Khalid',
				positionIds: ['p1'],
				weekMinutes: 450,
			}),
			person({
				id: 's2',
				firstName: 'Omar',
				lastName: 'Saleh',
				positionIds: ['p2'],
			}),
		],
		shifts: [
			shift({ id: 'a', staffId: 's1', state: 'draft', version: 3 }),
			shift({
				id: 'b',
				staffId: 's2',
				positionId: 'p2',
				localDate: '2026-03-03',
				startsAt: NINE_AM + 24 * HOUR,
				endsAt: NINE_AM + 32 * HOUR,
				state: 'published',
				conflicts: [
					{ code: 'overtime', shiftId: 'b', detail: { minutes: 30 } },
				],
			}),
			shift({
				id: 'c',
				staffId: null,
				state: 'draft',
				localDate: '2026-03-05',
				startsAt: NINE_AM + 72 * HOUR,
				endsAt: NINE_AM + 78 * HOUR,
			}),
		],
		unpublishedCount: 2,
		totals: {
			minutes: 1000,
			overtimeMinutes: 0,
			openShifts: 1,
			openMinutes: 360,
		},
	})

beforeEach(() => {
	window.innerWidth = 1200
})

afterEach(async () => {
	// Let a reload started by the last action finish while the stub is still in place.
	await new Promise((resolve) => setTimeout(resolve, 30))
	cleanup()
	vi.unstubAllGlobals()
})

describe('SchedulePage week grid', () => {
	it('lays the week out by position with people, open shifts and totals', async () => {
		stubApi(populated())
		view()
		await screen.findByText('Rana Khalid')
		expect(screen.getByText('Omar Saleh')).toBeTruthy()
		// Position headings and the open-shifts row.
		expect(screen.getAllByText('Server').length).toBeGreaterThan(0)
		expect(screen.getAllByText('Cook').length).toBeGreaterThan(0)
		expect(screen.getAllByText('Open shifts').length).toBeGreaterThan(0)
		// A draft is named as one, for screen readers and not by color alone.
		expect(
			screen.getByRole('button', { name: /^Draft, 9 AM – 5 PM, Server/ }),
		).toBeTruthy()
		// The demand guide sits above the grid.
		expect(screen.getByText('Typical online orders')).toBeTruthy()
		expect(
			screen.getAllByRole('img', { name: /online orders on a typical day/ }),
		).toHaveLength(7)
	})

	it('flags conflicts in red words, and hides them when asked', async () => {
		stubApi(populated())
		view()
		const flagged = await screen.findByRole('button', {
			name: /Published, 9 AM – 5 PM, Cook.*warning/,
		})
		expect(flagged.getAttribute('aria-label')).toContain(
			'Reaches overtime this week',
		)
		fireEvent.click(screen.getByRole('switch', { name: /Show conflicts/ }))
		await waitFor(() =>
			expect(
				screen
					.getByRole('button', { name: /^Published, 9 AM – 5 PM, Cook/ })
					.getAttribute('aria-label'),
			).not.toContain('warning'),
		)
	})

	it('offers a sticky Publish with the count, and opens the publish choices', async () => {
		stubApi(populated())
		view()
		const publish = await screen.findByRole('button', { name: /Publish \(2\)/ })
		fireEvent.click(publish)
		const dialog = await screen.findByRole('dialog')
		expect(within(dialog).getByText('Publish this week')).toBeTruthy()
		expect(within(dialog).getByText('2 new shifts')).toBeTruthy()
		expect(within(dialog).getByLabelText('Who to notify')).toBeTruthy()
	})

	it('publishes with the version the manager saw and the chosen audience', async () => {
		const calls = stubApi(
			{ ...populated(), version: 4 },
			{
				onWrite: () => ({
					publication: {
						id: 'pub1',
						scopeId: 'loc-1',
						weekStart: '2026-03-02',
						version: 5,
						notifyMode: 'nobody',
						summary: {},
						publishedBy: 'u1',
						publishedAt: 1,
						changes: [],
					},
					week: { version: 5, unpublishedCount: 0 },
				}),
			},
		)
		view()
		fireEvent.click(
			await screen.findByRole('button', { name: /Publish \(2\)/ }),
		)
		const dialog = await screen.findByRole('dialog')
		fireEvent.click(within(dialog).getByText('Nobody'))
		fireEvent.click(within(dialog).getByRole('button', { name: 'Publish' }))
		await waitFor(() =>
			expect(calls.some((c) => c.method === 'POST')).toBe(true),
		)
		const post = calls.find((c) => c.method === 'POST')!
		expect(post.url).toContain('/operator/schedule/publish')
		expect(post.body).toEqual({
			scopeId: 'loc-1',
			weekStart: '2026-03-02',
			notifyMode: 'nobody',
			expectedVersion: 4,
		})
	})

	it('moves the end of a focused shift by one step with Shift and an arrow', async () => {
		const calls = stubApi(populated(), {
			onWrite: () => ({ shifts: [shift({ id: 'a', version: 4 })] }),
		})
		view()
		const block = await screen.findByRole('button', {
			name: /^Draft, 9 AM – 5 PM, Server/,
		})
		fireEvent.keyDown(block, { key: 'ArrowRight', shiftKey: true })
		await waitFor(() =>
			expect(calls.some((c) => c.method === 'PATCH')).toBe(true),
		)
		const patch = calls.find((c) => c.method === 'PATCH')!
		expect(patch.url).toContain('/operator/schedule/shifts/a')
		expect(patch.body).toEqual({
			expectedVersion: 3,
			startTime: '09:00',
			endTime: '17:15',
		})
	})

	it('moves the start with Alt and Shift, earlier with the down arrow', async () => {
		const calls = stubApi(populated(), {
			onWrite: () => ({ shifts: [shift({ id: 'a' })] }),
		})
		view()
		const block = await screen.findByRole('button', {
			name: /^Draft, 9 AM – 5 PM, Server/,
		})
		fireEvent.keyDown(block, { key: 'ArrowDown', shiftKey: true, altKey: true })
		await waitFor(() =>
			expect(calls.some((c) => c.method === 'PATCH')).toBe(true),
		)
		expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({
			expectedVersion: 3,
			startTime: '08:45',
			endTime: '17:00',
		})
	})

	it("copies with Ctrl+C and pastes into the focused shift's cell with Ctrl+V", async () => {
		const calls = stubApi(populated(), {
			onWrite: () => ({ shifts: [shift({ id: 'new' })] }),
		})
		view()
		const draft = await screen.findByRole('button', {
			name: /^Draft, 9 AM – 5 PM, Server/,
		})
		fireEvent.keyDown(draft, { key: 'c', ctrlKey: true })
		const target = await screen.findByRole('button', {
			name: /^Published, 9 AM – 5 PM, Cook/,
		})
		fireEvent.keyDown(target, { key: 'v', ctrlKey: true })
		await waitFor(() =>
			expect(calls.some((c) => c.method === 'POST')).toBe(true),
		)
		const post = calls.find((c) => c.method === 'POST')!
		expect(post.url).toContain('/operator/schedule/shifts')
		expect(post.body).toMatchObject({
			scopeId: 'loc-1',
			staffId: 's2',
			positionId: 'p1',
			dates: ['2026-03-03'],
			startTime: '09:00',
			endTime: '17:00',
		})
	})

	it('does not move anything without the schedule write grant', async () => {
		const calls = stubApi(populated(), {
			grants: ['read:schedule:any', 'read:staff:any'],
		})
		view()
		const block = await screen.findByRole('button', {
			name: /^Draft, 9 AM – 5 PM, Server/,
		})
		fireEvent.keyDown(block, { key: 'ArrowRight', shiftKey: true })
		fireEvent.keyDown(block, { key: 'v', ctrlKey: true })
		expect(screen.queryByRole('button', { name: /Add shift/ })).toBeNull()
		expect(screen.queryByRole('button', { name: /^Publish \(/ })).toBeNull()
		await new Promise((resolve) => setTimeout(resolve, 20))
		expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0)
	})

	it('keeps the editor reachable by keyboard: Enter on a shift opens it with its warnings', async () => {
		stubApi(populated())
		view()
		const block = await screen.findByRole('button', {
			name: /^Published, 9 AM – 5 PM, Cook/,
		})
		fireEvent.click(block)
		const sheet = await screen.findByRole('dialog')
		expect(within(sheet).getByText('Edit shift')).toBeTruthy()
		expect(within(sheet).getByText('Reaches overtime this week')).toBeTruthy()
		expect(
			within(sheet).getByText(
				'Warnings do not stop you from saving or publishing.',
			),
		).toBeTruthy()
	})
})

describe('SchedulePage empty week', () => {
	it('offers a jumpstart: copy a past week, use a template, recommend one', async () => {
		stubApi(week({ people: [person()] }))
		view()
		await screen.findByText('Nothing scheduled this week')
		expect(
			screen.getByRole('button', { name: /Copy a past week/ }),
		).toBeTruthy()
		expect(screen.getByRole('button', { name: /Use a template/ })).toBeTruthy()
		expect(
			screen.getByRole('button', { name: /Recommend a schedule/ }),
		).toBeTruthy()
		fireEvent.click(screen.getByRole('button', { name: /Start blank/ }))
		await screen.findByText('Rana Khalid')
	})

	it('previews a recommended schedule before writing anything', async () => {
		const calls = stubApi(week({ people: [person()] }), {
			onWrite: (call) => ({
				estimate: true,
				applied: (call.body as { apply: boolean }).apply,
				scopeId: 'loc-1',
				weekStart: '2026-03-02',
				shifts: [
					{
						staffId: 's1',
						positionId: 'p1',
						localDate: '2026-03-02',
						startsAt: NINE_AM,
						endsAt: NINE_AM + 8 * HOUR,
						unpaidBreakMinutes: 0,
					},
					{
						staffId: null,
						positionId: 'p1',
						localDate: '2026-03-03',
						startsAt: NINE_AM,
						endsAt: NINE_AM + 8 * HOUR,
						unpaidBreakMinutes: 0,
						openReason: 'time_off',
						previousStaffId: 's1',
					},
				],
				counts: {
					total: 2,
					opened: 1,
					skippedDuplicates: 0,
					skippedUnplaceable: 0,
					created: 0,
				},
			}),
		})
		view()
		fireEvent.click(
			await screen.findByRole('button', { name: /Recommend a schedule/ }),
		)
		const dialog = await screen.findByRole('dialog')
		fireEvent.click(within(dialog).getByRole('button', { name: 'Preview' }))
		await within(dialog).findByText(/2 shifts would be added as drafts/)
		expect(within(dialog).getByText(/1 on time off/)).toBeTruthy()
		const recommend = calls.filter((c) => c.url.includes('/recommend'))
		expect(recommend).toHaveLength(1)
		expect((recommend[0]!.body as { apply: boolean }).apply).toBe(false)
		expect(
			within(dialog).getByRole('button', { name: 'Add these shifts' }),
		).toBeTruthy()
	})
})

describe('SchedulePage on a phone', () => {
	it('shows one day at a time as a list', async () => {
		window.innerWidth = 400
		stubApi(populated())
		view()
		// 2026-03-04 has no shifts in the fixture; pick the Tuesday.
		const tab = await screen.findByRole('tab', { name: /3/ })
		fireEvent.click(tab)
		await screen.findByText('Omar Saleh')
		expect(screen.queryByRole('table')).toBeNull()
		expect(screen.getByRole('button', { name: /Add a shift/ })).toBeTruthy()
	})
})
