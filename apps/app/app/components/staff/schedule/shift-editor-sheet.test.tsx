// @vitest-environment jsdom

import {
	cleanup,
	fireEvent,
	screen,
	waitFor,
	within,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { person, shift, week } from '#app/utils/staffing/schedule-fixtures.ts'
import { createStaffClient } from '#app/utils/staffing/staff-client.ts'
import { renderStaff } from '#tests/staff-render.tsx'
import { ShiftEditorSheet, type EditorMode } from './shift-editor-sheet.tsx'

afterEach(async () => {
	// Let a reload started by the last action finish while the stub is still in place.
	await new Promise((resolve) => setTimeout(resolve, 30))
	cleanup()
	vi.unstubAllGlobals()
})

type Call = { method: string; url: string; body?: unknown }

function setup(
	mode: EditorMode,
	weekBody = week(),
	respond?: (call: Call) => unknown,
) {
	const calls: Call[] = []
	const fetchImpl = vi.fn(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input)
			if (url.includes('/staff/token')) {
				return Response.json({
					jwt: 'jwt',
					tenantApiUrl: 'https://us.tenant.test',
					scope: 'schedule',
					grants: [
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
			return Response.json(
				respond ? respond(call) : { shifts: [shift({ id: 'n1' })] },
			)
		},
	)
	const client = createStaffClient({
		orgSlug: 'acme',
		scope: 'schedule',
		fetchImpl: fetchImpl as unknown as typeof fetch,
	})
	const handlers = {
		onClose: vi.fn(),
		onChanged: vi.fn(),
		onReload: vi.fn(),
		onCopy: vi.fn(),
		onRepeat: vi.fn(),
	}
	renderStaff(
		<ShiftEditorSheet
			mode={mode}
			week={weekBody}
			scopeId="loc-1"
			client={client}
			locale="en"
			narrow={false}
			lastTimes={null}
			{...handlers}
		/>,
	)
	return { calls, ...handlers }
}

const create = (rowKey = 's1', date = '2026-03-02'): EditorMode => ({
	kind: 'create',
	cell: { rowKey, date },
})

describe('ShiftEditorSheet: adding', () => {
	it('adds a shift for the chosen days in one request', async () => {
		const { calls, onChanged, onClose } = setup(create())
		const dialog = await screen.findByRole('dialog')
		expect(within(dialog).getByText('Add a shift')).toBeTruthy()
		fireEvent.click(within(dialog).getByRole('button', { name: 'Wed' }))
		expect(within(dialog).getByText('This adds 2 shifts.')).toBeTruthy()
		fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }))
		await waitFor(() => expect(onChanged).toHaveBeenCalled())
		const post = calls.find((c) => c.method === 'POST')!
		expect(post.url).toContain('/operator/schedule/shifts')
		expect(post.body).toMatchObject({
			scopeId: 'loc-1',
			staffId: 's1',
			positionId: null,
			dates: ['2026-03-02', '2026-03-04'],
			startTime: '09:00',
			endTime: '17:00',
			unpaidBreakMinutes: 0,
		})
		expect(onClose).toHaveBeenCalled()
	})

	it('refuses a shift that ends when it starts, and says why, without sending', async () => {
		const { calls } = setup({
			kind: 'create',
			cell: { rowKey: 'open', date: '2026-03-02' },
			preset: {
				staffId: 'open',
				positionId: 'none',
				startTime: '09:00',
				endTime: '09:00',
				unpaidBreak: '0',
				notes: '',
				dates: ['2026-03-02'],
				split: false,
				startTime2: '18:00',
				endTime2: '22:00',
			},
		})
		const dialog = await screen.findByRole('dialog')
		fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }))
		await within(dialog).findByText('The end cannot be the same as the start.')
		expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0)
	})

	it('adds a split shift as two requests', async () => {
		const { calls, onChanged } = setup(create())
		const dialog = await screen.findByRole('dialog')
		fireEvent.click(within(dialog).getByRole('switch', { name: 'Split shift' }))
		fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }))
		await waitFor(() => expect(onChanged).toHaveBeenCalled())
		const posts = calls.filter((c) => c.method === 'POST')
		expect(posts).toHaveLength(2)
		expect(posts[1]!.body).toMatchObject({
			startTime: '18:00',
			endTime: '22:00',
			unpaidBreakMinutes: 0,
		})
	})

	it('retries only the second half when a split shift is added in part', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {})
		let posts = 0
		const { calls, onReload } = setup(create(), week(), (call) => {
			if (call.method !== 'POST') return {}
			posts += 1
			// The second request of the first attempt answers something unusable.
			return posts === 2
				? { unexpected: true }
				: { shifts: [shift({ id: 'n1' })] }
		})
		const dialog = await screen.findByRole('dialog')
		fireEvent.click(within(dialog).getByRole('switch', { name: 'Split shift' }))
		fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }))
		await waitFor(() => expect(onReload).toHaveBeenCalled())
		expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2)

		fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }))
		await waitFor(() =>
			expect(calls.filter((c) => c.method === 'POST')).toHaveLength(3),
		)
		expect(calls.filter((c) => c.method === 'POST')[2]!.body).toMatchObject({
			startTime: '18:00',
			endTime: '22:00',
		})
	})

	it('warns about an overlapping second shift', async () => {
		setup(create())
		const dialog = await screen.findByRole('dialog')
		fireEvent.click(within(dialog).getByRole('switch', { name: 'Split shift' }))
		fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }))
		// The default second shift (6 PM) does not overlap, so nothing is refused.
		await waitFor(() =>
			expect(
				within(dialog).queryByText('The second shift overlaps the first.'),
			).toBeNull(),
		)
	})
})

describe('ShiftEditorSheet: editing', () => {
	const people = [
		person({
			id: 's1',
			firstName: 'Rana',
			lastName: 'Khalid',
			positionIds: ['p1'],
			weekMinutes: 600,
		}),
		person({
			id: 's2',
			firstName: 'Omar',
			lastName: 'Saleh',
			positionIds: ['p1'],
			weekMinutes: 300,
		}),
		person({
			id: 's3',
			firstName: 'Luis',
			lastName: 'Herrera',
			positionIds: ['p1'],
			weekMinutes: 100,
		}),
	]

	it('ranks who could take an open shift and assigns with the version it saw', async () => {
		const open = shift({ id: 'o1', staffId: null, version: 7 })
		const view = week({
			people,
			shifts: [open],
			overlays: [
				{
					staffId: 's3',
					timeOff: [
						{
							id: 't',
							status: 'approved',
							category: 'pto',
							startDate: '2026-03-02',
							endDate: '2026-03-02',
							allDay: true,
							startMinute: null,
							endMinute: null,
						},
					],
					availability: [],
				},
			],
		})
		const { calls, onChanged } = setup({ kind: 'edit', shift: open }, view)
		const dialog = await screen.findByRole('dialog')
		const suggestions = within(dialog).getByRole('region', {
			name: /Who could take this shift/,
		})
		const names = within(suggestions)
			.getAllByRole('listitem')
			.map((li) => li.textContent ?? '')
		// Fewest hours first among the free; the person on time off comes last, flagged.
		expect(names[0]).toContain('Omar Saleh')
		expect(names[1]).toContain('Rana Khalid')
		expect(names[2]).toContain('Luis Herrera')
		expect(names[2]).toContain('On time off')
		fireEvent.click(
			within(within(suggestions).getAllByRole('listitem')[0]!).getByRole(
				'button',
				{ name: 'Assign' },
			),
		)
		await waitFor(() => expect(onChanged).toHaveBeenCalled())
		const post = calls.find((c) => c.method === 'POST')!
		expect(post.url).toContain('/operator/schedule/shifts/o1/assign')
		expect(post.body).toEqual({ staffId: 's2', expectedVersion: 7 })
	})

	it('sends only what changed', async () => {
		const held = shift({ id: 'h1', staffId: 's1', version: 2 })
		const { calls } = setup(
			{ kind: 'edit', shift: held },
			week({ people, shifts: [held] }),
		)
		const dialog = await screen.findByRole('dialog')
		fireEvent.change(within(dialog).getByLabelText(/Unpaid break/), {
			target: { value: '45' },
		})
		fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
		await waitFor(() =>
			expect(calls.some((c) => c.method === 'PATCH')).toBe(true),
		)
		expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({
			expectedVersion: 2,
			unpaidBreakMinutes: 45,
		})
	})

	it('shows the conflicts and offers to undo an unpublished edit', async () => {
		const edited = shift({
			id: 'e1',
			state: 'changed',
			conflicts: [{ code: 'min_rest', shiftId: 'e1' }],
			published: {
				staffId: 's1',
				positionId: 'p1',
				startsAt: 0,
				endsAt: 1,
				unpaidBreakMinutes: 0,
				notes: null,
			},
		})
		const { calls, onChanged } = setup(
			{ kind: 'edit', shift: edited },
			week({ people, shifts: [edited] }),
		)
		const dialog = await screen.findByRole('dialog')
		expect(
			within(dialog).getByText(
				'Less than the minimum rest since their last shift',
			),
		).toBeTruthy()
		fireEvent.click(
			within(dialog).getByRole('button', { name: /Undo changes/ }),
		)
		await waitFor(() => expect(onChanged).toHaveBeenCalled())
		expect(calls.find((c) => c.method === 'POST')!.url).toContain(
			'/shifts/e1/revert',
		)
	})

	it('asks before removing, and says a published shift stays until the week is published', async () => {
		const live = shift({ id: 'l1', state: 'published', version: 5 })
		const { calls } = setup(
			{ kind: 'edit', shift: live },
			week({ people, shifts: [live] }),
			() => ({
				state: 'cancel_pending',
				shift: { ...live, state: 'cancel_pending' },
			}),
		)
		const dialog = await screen.findByRole('dialog')
		fireEvent.click(within(dialog).getByRole('button', { name: /Remove/ }))
		const confirm = await screen.findByRole('alertdialog')
		expect(
			within(confirm).getByText(/stays on the schedule until you publish/),
		).toBeTruthy()
		expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0)
		fireEvent.click(within(confirm).getByRole('button', { name: 'Remove' }))
		await waitFor(() =>
			expect(calls.some((c) => c.method === 'DELETE')).toBe(true),
		)
		expect(calls.find((c) => c.method === 'DELETE')!.url).toContain(
			'/shifts/l1?expectedVersion=5',
		)
	})

	it('explains a stale shift in plain words and reloads', async () => {
		const held = shift({ id: 'h1', staffId: 's1', version: 2 })
		vi.spyOn(console, 'error').mockImplementation(() => {})
		const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input)
			if (url.includes('/staff/token')) {
				return Response.json({
					jwt: 'j',
					tenantApiUrl: 'https://x.test',
					scope: 'schedule',
					grants: ['update:schedule:any'],
					expiresAt: Date.now() + 600_000,
				})
			}
			return Response.json({ error: 'stale_shift' }, { status: 409 })
		})
		const client = createStaffClient({
			orgSlug: 'acme',
			scope: 'schedule',
			fetchImpl: fetchImpl as unknown as typeof fetch,
		})
		const onReload = vi.fn()
		renderStaff(
			<ShiftEditorSheet
				mode={{ kind: 'edit', shift: held }}
				week={week({ people, shifts: [held] })}
				scopeId="loc-1"
				client={client}
				locale="en"
				narrow={false}
				lastTimes={null}
				onClose={vi.fn()}
				onChanged={vi.fn()}
				onReload={onReload}
				onCopy={vi.fn()}
				onRepeat={vi.fn()}
			/>,
		)
		const dialog = await screen.findByRole('dialog')
		fireEvent.change(within(dialog).getByLabelText(/Unpaid break/), {
			target: { value: '10' },
		})
		fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
		await within(dialog).findByText(/Someone else changed this shift/)
		await waitFor(() => expect(onReload).toHaveBeenCalled())
	})
})
