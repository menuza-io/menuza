// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderStaff } from '#tests/staff-render.tsx'
import {
	apiError,
	createScriptedClient,
	type ScriptedCall,
} from '../scripted-test-client.ts'
import { GuestProfileScreen } from './guest-profile-screen.tsx'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

type State = {
	version: number
	notes: Array<{ id: string; body: string; pinned: boolean; createdAt: number }>
	tags: Array<{
		id: string
		name: string
		category: string
		colorToken: string
	}>
	erased: boolean
}

function setup(options: { canManage?: boolean; stale?: boolean } = {}) {
	const state: State = { version: 2, notes: [], tags: [], erased: false }
	const handler = (call: ScriptedCall): unknown => {
		const { path, method, body } = call
		if (path.endsWith('/guests/tags') && method === 'GET') {
			return {
				tags: [
					{
						id: 'tag_vip',
						name: 'VIP',
						category: 'general',
						colorToken: 'amber',
					},
				],
			}
		}
		if (path.endsWith('/guests/tags') && method === 'POST') {
			return {
				tag: {
					id: 'tag_new',
					name: body!.name,
					category: 'general',
					colorToken: 'slate',
				},
			}
		}
		if (path.endsWith('/g1/tags') && method === 'POST') {
			state.tags.push({
				id: body!.tagId,
				name: body!.tagId === 'tag_new' ? 'Window' : 'VIP',
				category: 'general',
				colorToken: 'slate',
			})
			return { ok: true }
		}
		if (path.endsWith('/g1/notes') && method === 'POST') {
			state.notes.push({
				id: `n${state.notes.length + 1}`,
				body: body!.body,
				pinned: Boolean(body!.pinned),
				createdAt: 1_700_000_000_000 + state.notes.length,
			})
			return { note: state.notes.at(-1) }
		}
		if (path.includes('/g1/notes/') && method === 'PATCH') {
			const id = path.split('/').pop()
			const note = state.notes.find((n) => n.id === id)!
			Object.assign(note, body)
			return { note }
		}
		if (path.includes('/g1/notes/') && method === 'DELETE') {
			const id = path.split('/').pop()
			state.notes = state.notes.filter((n) => n.id !== id)
			return { ok: true }
		}
		if (path.endsWith('/g1') && method === 'PATCH') {
			if (options.stale) {
				state.version += 1
				return apiError(409, 'stale_version')
			}
			state.version += 1
			return { guest: {} }
		}
		if (path.endsWith('/g1/erase') && method === 'POST') {
			state.erased = true
			return { ok: true }
		}
		if (path.endsWith('/g1/export') && method === 'GET') return { guest: {} }
		if (path.endsWith('/merge') && method === 'POST') return { guest: {} }
		if (path.endsWith('/guests') && method === 'GET') {
			return {
				guests: [
					{
						id: 'g2',
						firstName: 'Rana',
						lastName: 'Duplicate',
						name: 'Rana Duplicate',
						version: 5,
						tags: [],
					},
				],
				nextCursor: null,
				total: 1,
			}
		}
		if (path.endsWith('/g1') && method === 'GET') {
			return {
				guest: {
					id: 'g1',
					firstName: 'Rana',
					lastName: 'Haddad',
					name: 'Rana Haddad',
					phoneE164: '+15555550101',
					email: 'rana@example.test',
					visits: 4,
					noShows: 0,
					version: state.version,
					customerLinked: true,
					erasedAt: state.erased ? 1 : null,
					tags: state.tags,
				},
				notes: state.notes,
				pinnedNotes: state.notes
					.filter((n) => n.pinned)
					.map(({ id, body }) => ({ id, body })),
				reservations: [
					{
						id: 'r1',
						locationId: 'loc_1',
						businessDate: '2026-04-20',
						localStartMin: 1140,
						partySize: 2,
						status: 'finished',
						channel: 'online',
						lateCancel: false,
						serviceName: 'Dinner',
					},
				],
			}
		}
		throw new Error(`unscripted ${method} ${path}`)
	}
	const fake = createScriptedClient(handler)
	renderStaff(
		<GuestProfileScreen
			client={fake.client}
			orgSlug="acme"
			guestId="g1"
			canManage={options.canManage ?? true}
		/>,
	)
	return { ...fake, state }
}

const writes = (calls: ScriptedCall[]) =>
	calls.filter((call) => call.method !== 'GET')

describe('GuestProfileScreen', () => {
	beforeEach(() => {
		vi.mocked(toast.error).mockClear()
		vi.mocked(toast.success).mockClear()
	})

	it('shows the profile, the customer link and the visit history', async () => {
		setup()
		expect(await screen.findByTestId('guest-profile-name')).toHaveTextContent(
			'Rana Haddad',
		)
		expect(screen.getByTestId('guest-customer-linked')).toBeInTheDocument()
		expect(screen.getByTestId('guest-visit-r1')).toHaveTextContent('Dinner')
	})

	it('hides every write control without the update grant', async () => {
		setup({ canManage: false })
		await screen.findByTestId('guest-profile-name')
		for (const id of [
			'guest-edit',
			'guest-merge',
			'guest-erase',
			'guest-note-input',
			'guest-tag-manager',
			'guest-export-sensitive',
		]) {
			expect(screen.queryByTestId(id)).not.toBeInTheDocument()
		}
		expect(screen.getByTestId('guest-export')).toBeInTheDocument()
	})

	it('adds a pinned note that leads the list and the profile card', async () => {
		const { calls } = setup()
		await screen.findByTestId('guest-notes-empty')
		fireEvent.change(screen.getByTestId('guest-note-input'), {
			target: { value: 'Prefers the window' },
		})
		fireEvent.click(screen.getByTestId('guest-note-pin-new'))
		fireEvent.click(screen.getByTestId('guest-note-add'))
		await waitFor(() =>
			expect(screen.getByTestId('guest-note-n1')).toHaveAttribute(
				'data-pinned',
				'true',
			),
		)
		expect(writes(calls).at(-1)).toMatchObject({
			method: 'POST',
			body: { body: 'Prefers the window', pinned: true },
		})
		expect(
			within(screen.getByTestId('guest-pinned-notes')).getByText(
				'Prefers the window',
			),
		).toBeInTheDocument()
	})

	it('unpins and deletes a note', async () => {
		const { calls, state } = setup()
		await screen.findByTestId('guest-notes-empty')
		state.notes.push({ id: 'n1', body: 'First', pinned: true, createdAt: 1 })
		fireEvent.change(screen.getByTestId('guest-note-input'), {
			target: { value: 'Second' },
		})
		fireEvent.click(screen.getByTestId('guest-note-add'))
		await screen.findByTestId('guest-note-n2')
		fireEvent.click(screen.getByTestId('guest-note-pin-n1'))
		await waitFor(() =>
			expect(screen.getByTestId('guest-note-n1')).toHaveAttribute(
				'data-pinned',
				'false',
			),
		)
		fireEvent.click(screen.getByTestId('guest-note-delete-n2'))
		await waitFor(() =>
			expect(screen.queryByTestId('guest-note-n2')).not.toBeInTheDocument(),
		)
		expect(writes(calls).map((c) => c.method)).toEqual([
			'POST',
			'PATCH',
			'DELETE',
		])
	})

	it('creates a tag and assigns it', async () => {
		const { calls } = setup()
		await screen.findByTestId('guest-new-tag')
		fireEvent.change(screen.getByTestId('guest-new-tag'), {
			target: { value: 'Window' },
		})
		fireEvent.click(screen.getByTestId('guest-new-tag-submit'))
		await waitFor(() =>
			expect(
				within(screen.getByTestId('guest-tags')).getByText('Window'),
			).toBeInTheDocument(),
		)
		expect(
			writes(calls).map((c) => `${c.method} ${c.path.split('/guests')[1]}`),
		).toEqual(['POST /tags', 'POST /g1/tags'])
	})

	it('explains a version conflict and reloads without losing the dialog values', async () => {
		const { calls, state } = setup({ stale: true })
		await screen.findByTestId('guest-edit')
		fireEvent.click(screen.getByTestId('guest-edit'))
		fireEvent.change(await screen.findByTestId('guest-first-name'), {
			target: { value: 'Ranya' },
		})
		fireEvent.click(screen.getByTestId('guest-edit-save'))
		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith(
				expect.stringContaining('Someone else changed this guest first'),
			),
		)
		expect(writes(calls)[0]!.body).toMatchObject({
			expectedVersion: 2,
			firstName: 'Ranya',
		})
		expect(state.version).toBe(3)
		expect(screen.getByTestId('guest-edit-dialog')).toBeInTheDocument()
		const gets = calls.filter(
			(c) => c.method === 'GET' && c.path.endsWith('/g1'),
		)
		expect(gets.length).toBeGreaterThanOrEqual(2)
	})

	it('merges a chosen duplicate with both versions', async () => {
		const { calls } = setup()
		await screen.findByTestId('guest-merge')
		fireEvent.click(screen.getByTestId('guest-merge'))
		fireEvent.change(await screen.findByTestId('guest-merge-search'), {
			target: { value: 'rana' },
		})
		fireEvent.click(await screen.findByTestId('guest-merge-option-g2'))
		fireEvent.click(screen.getByTestId('guest-merge-confirm'))
		await waitFor(() => expect(writes(calls)).toHaveLength(1))
		expect(writes(calls)[0]).toMatchObject({
			path: '/operator/reservations/guests/merge',
			body: { keepId: 'g1', mergeId: 'g2', expectedVersions: { g1: 2, g2: 5 } },
		})
	})

	it('asks before erasing and sends nothing on cancel', async () => {
		const { calls } = setup()
		await screen.findByTestId('guest-erase')
		fireEvent.click(screen.getByTestId('guest-erase'))
		const dialog = await screen.findByTestId('guest-erase-dialog')
		fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
		expect(writes(calls)).toHaveLength(0)

		fireEvent.click(screen.getByTestId('guest-erase'))
		fireEvent.click(await screen.findByTestId('guest-erase-confirm'))
		expect(await screen.findByTestId('guest-erased-notice')).toBeInTheDocument()
		expect(writes(calls)[0]).toMatchObject({
			method: 'POST',
			path: '/operator/reservations/guests/g1/erase',
		})
	})

	it('downloads the sensitive export only when asked', async () => {
		const { calls } = setup()
		await screen.findByTestId('guest-export')
		const create = vi.fn(() => 'blob:x')
		Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() })
		const click = vi
			.spyOn(HTMLAnchorElement.prototype, 'click')
			.mockImplementation(() => {})
		const original = calls.length
		fireEvent.click(screen.getByTestId('guest-export-sensitive'))
		await waitFor(() => expect(calls.length).toBeGreaterThan(original))
		expect(calls.at(-1)!.query).toMatchObject({ includeSensitive: '1' })
		await waitFor(() => expect(click).toHaveBeenCalled())
		click.mockRestore()
	})

	it('says when the guest does not exist', async () => {
		const fake = createScriptedClient(() => apiError(404, 'not_found'))
		renderStaff(
			<GuestProfileScreen
				client={fake.client}
				orgSlug="acme"
				guestId="gx"
				canManage
			/>,
		)
		expect(await screen.findByTestId('guest-profile-error')).toHaveTextContent(
			'This guest does not exist.',
		)
	})
})
