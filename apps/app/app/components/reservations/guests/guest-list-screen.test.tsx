// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderStaff } from '#tests/staff-render.tsx'
import {
	apiError,
	createScriptedClient,
	type ScriptedCall,
} from '../scripted-test-client.ts'
import { GuestListScreen } from './guest-list-screen.tsx'

const guest = (
	id: string,
	name: string,
	extra: Record<string, unknown> = {},
) => ({
	id,
	firstName: name,
	lastName: '',
	name,
	phoneE164: '+15555550101',
	email: `${id}@example.test`,
	visits: 3,
	noShows: 0,
	version: 1,
	tags: [],
	...extra,
})

const TAGS = [
	{
		id: 'tag_sys_first_visit',
		name: 'First visit',
		category: 'system',
		colorToken: 'slate',
	},
	{ id: 'tag_vip', name: 'VIP', category: 'general', colorToken: 'amber' },
]

function setup(
	pages: (call: ScriptedCall) => unknown = () => ({
		guests: [guest('g1', 'Rana'), guest('g2', 'Omar')],
		nextCursor: null,
		total: 2,
	}),
) {
	const fake = createScriptedClient((call) => {
		if (call.path.endsWith('/tags')) return { tags: TAGS }
		return pages(call)
	})
	renderStaff(<GuestListScreen client={fake.client} orgSlug="acme" />)
	return fake
}

const listCalls = (calls: ScriptedCall[]) =>
	calls.filter((call) => !call.path.endsWith('/tags'))

describe('GuestListScreen', () => {
	it('lists guests with a link to each profile', async () => {
		setup()
		const row = await screen.findByTestId('guest-row-g1')
		expect(row).toHaveTextContent('Rana')
		expect(screen.getByTestId('guest-link-g2')).toHaveAttribute(
			'href',
			'/acme/reservations/guests/g2',
		)
		expect(screen.getByTestId('guests-count')).toHaveTextContent('2 of 2')
	})

	it('asks for at most 50 guests per page', async () => {
		const { calls } = setup()
		await screen.findByTestId('guest-row-g1')
		expect(listCalls(calls)[0]!.query).toMatchObject({ limit: 50 })
	})

	it('searches by name, phone, or email after the typing pause', async () => {
		const { calls } = setup((call) =>
			call.query?.q === 'ran'
				? { guests: [guest('g1', 'Rana')], nextCursor: null, total: 1 }
				: {
						guests: [guest('g1', 'Rana'), guest('g2', 'Omar')],
						nextCursor: null,
						total: 2,
					},
		)
		await screen.findByTestId('guest-row-g2')
		fireEvent.change(screen.getByTestId('guests-search'), {
			target: { value: 'ran' },
		})
		await waitFor(() =>
			expect(screen.queryByTestId('guest-row-g2')).not.toBeInTheDocument(),
		)
		expect(listCalls(calls).at(-1)!.query).toMatchObject({ q: 'ran' })
	})

	it('shows the search empty state when nothing matches', async () => {
		setup((call) =>
			call.query?.q
				? { guests: [], nextCursor: null, total: 0 }
				: { guests: [guest('g1', 'Rana')], nextCursor: null, total: 1 },
		)
		await screen.findByTestId('guest-row-g1')
		fireEvent.change(screen.getByTestId('guests-search'), {
			target: { value: 'zzz' },
		})
		expect(await screen.findByTestId('guests-empty-search')).toBeInTheDocument()
	})

	it('shows the first-run empty state without any guests', async () => {
		setup(() => ({ guests: [], nextCursor: null, total: 0 }))
		expect(await screen.findByTestId('guests-empty')).toBeInTheDocument()
	})

	it('filters by tag with the tag id', async () => {
		const { calls } = setup()
		await screen.findByTestId('guest-row-g1')
		await screen.findByRole('option', { name: 'VIP' })
		fireEvent.change(screen.getByTestId('guests-tag-filter'), {
			target: { value: 'tag_vip' },
		})
		await waitFor(() =>
			expect(listCalls(calls).at(-1)!.query).toMatchObject({ tag: 'tag_vip' }),
		)
	})

	it('translates the automatic tags in the filter', async () => {
		setup()
		const filter = await screen.findByTestId('guests-tag-filter')
		await waitFor(() =>
			expect(
				within(filter).getByRole('option', { name: 'First visit' }),
			).toBeInTheDocument(),
		)
	})

	it('loads the next page with the cursor', async () => {
		const { calls } = setup((call) =>
			call.query?.cursor === 'c1'
				? { guests: [guest('g3', 'Lina')], nextCursor: null, total: 3 }
				: {
						guests: [guest('g1', 'Rana'), guest('g2', 'Omar')],
						nextCursor: 'c1',
						total: 3,
					},
		)
		await screen.findByTestId('guest-row-g1')
		fireEvent.click(screen.getByTestId('guests-load-more'))
		expect(await screen.findByTestId('guest-row-g3')).toBeInTheDocument()
		expect(screen.getByTestId('guest-row-g1')).toBeInTheDocument()
		expect(listCalls(calls).at(-1)!.query).toMatchObject({ cursor: 'c1' })
		expect(screen.queryByTestId('guests-load-more')).not.toBeInTheDocument()
	})

	it('says so when the grant is missing', async () => {
		setup(() => apiError(403, 'missing_grant'))
		expect(await screen.findByTestId('guests-denied')).toBeInTheDocument()
	})
})
