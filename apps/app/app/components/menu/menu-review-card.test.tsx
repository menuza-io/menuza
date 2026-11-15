// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type UndoToastOptions } from '#app/components/undo-toast.ts'
import { type MenuCard } from '#app/utils/menu/menu-cards.ts'
import { type MenuSuggestion } from '#app/utils/menu/menu-suggestions.ts'
import { MenuReviewStack } from './menu-review-stack.tsx'

const undo = vi.hoisted(() => ({ calls: [] as UndoToastOptions[] }))

vi.mock('#app/components/undo-toast.ts', () => ({
	showUndoToast: (options: UndoToastOptions) => {
		undo.calls.push(options)
		return 1
	},
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const ref = (id: string) => ({
	type: 'item' as const,
	id,
	updatedAt: '2026-11-01T00:00:00.000Z',
})

const MERGE: MenuCard = {
	kind: 'merge_duplicates',
	id: 'merge_duplicates:a',
	primary: { type: 'item', id: 'a' },
	subject: 'Falafel wrap',
	refs: [ref('a'), ref('b')],
	fingerprint: 'f1',
	params: { ids: ['a', 'b'] },
	preview: {
		before: [
			{
				entity: 'item',
				title: 'Falafel wrap',
				rows: [{ text: 'Falafel wrap', price: 8 }],
			},
		],
		after: [
			{
				entity: 'item',
				title: 'Falafel wrap',
				rows: [
					{ text: 'Falafel wrap', price: 8 },
					{ text: 'Falafel wrap copy', change: 'hidden', price: 8 },
				],
			},
		],
	},
	options: [
		{ id: 'keep-a', code: 'keep', subject: 'Falafel wrap' },
		{ id: 'keep-b', code: 'keep', subject: 'Falafel wrap copy' },
	],
	defaultOptionId: 'keep-a',
	references: [
		{
			entity: 'item',
			id: 'b',
			name: 'Falafel wrap copy',
			groups: [{ kind: 'in_categories', total: 1, names: ['Wraps'] }],
		},
	],
	warnings: ['prices_differ'],
	explanation: 'Same dish listed twice.',
	ai: true,
}

const CAPITALS: MenuCard = {
	kind: 'capitals',
	id: 'capitals:c',
	primary: { type: 'category', id: 'c' },
	subject: 'DRINKS',
	refs: [{ type: 'category', id: 'c', updatedAt: '2026-11-01T00:00:00.000Z' }],
	fingerprint: 'f2',
	params: {},
	preview: {
		before: [{ entity: 'category', title: 'DRINKS', rows: [] }],
		after: [
			{
				entity: 'category',
				title: 'Drinks',
				rows: [{ text: 'Drinks', change: 'changed' }],
			},
		],
	},
	options: [
		{ id: 'title', code: 'title' },
		{ id: 'sentence', code: 'sentence' },
		{ id: 'upper', code: 'upper' },
	],
	defaultOptionId: 'title',
	ai: false,
}

const PRICE: MenuCard = {
	kind: 'check_price',
	id: 'check_price:p',
	primary: { type: 'item', id: 'p' },
	subject: 'Tea',
	refs: [ref('p')],
	fingerprint: 'f3',
	params: {},
	preview: {
		before: [
			{ entity: 'item', title: 'Tea', rows: [{ text: 'Tea', price: 0.5 }] },
		],
		after: [
			{
				entity: 'item',
				title: 'Tea',
				rows: [{ text: 'Tea', price: null, change: 'changed' }],
			},
		],
	},
	options: [
		{ id: 'set', code: 'set_price', input: 'price' },
		{ id: 'keep', code: 'keep' },
	],
	defaultOptionId: 'set',
	ai: false,
}

type Call = { intent: string } & Record<string, unknown>
type Handler = (body: Call) => unknown

function mockServer(
	suggestions: MenuSuggestion[],
	handler: Handler = () => ({}),
) {
	const calls: Call[] = []
	const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body)) as Call
		calls.push(body)
		const json = (value: unknown, status = 200) =>
			new Response(JSON.stringify(value), {
				status,
				headers: { 'content-type': 'application/json' },
			})
		if (body.intent === 'generate') {
			return json({
				ok: true,
				batch: {
					suggestions: (body.seen as string[]).length === 0 ? suggestions : [],
					considered: suggestions.map((s) => s.id),
					remaining: 0,
					total: suggestions.length,
					aiUnavailable: false,
				},
			})
		}
		const custom = handler(body) as
			{ status: number; body: unknown } | Record<string, unknown>
		if (custom && 'status' in custom)
			return json(custom.body, custom.status as number)
		if (custom && 'ok' in custom) return json(custom)
		const UNDO = { snapshotId: 's1', touched: [], created: [], links: [] }
		switch (body.intent) {
			case 'apply-card':
				return json({ ok: true, undo: UNDO })
			case 'apply-cards':
				return json({
					ok: true,
					results: (body.cards as Array<{ id: string }>).map((card) => ({
						id: card.id,
						ok: true,
						undo: { ...UNDO, snapshotId: `s-${card.id}` },
					})),
				})
			case 'skip-card':
				return json({ ok: true, stored: true })
			case 'skip-cards':
				return json({
					ok: true,
					results: (body.cards as Array<{ id: string }>).map((card) => ({
						id: card.id,
						ok: true,
						stored: true,
					})),
				})
			default:
				return json({ ok: true, settings: { capitalStyle: 'title' } })
		}
	})
	vi.stubGlobal('fetch', fetchMock)
	return { calls, fetchMock }
}

function renderStack() {
	i18n.load('en', {})
	i18n.activate('en')
	render(
		<I18nProvider i18n={i18n}>
			<MenuReviewStack
				orgSlug="cafe"
				open
				onOpenChange={vi.fn()}
				translationLocales={[]}
				autoTranslate={false}
			/>
		</I18nProvider>,
	)
}

beforeEach(() => {
	undo.calls.length = 0
	vi.mocked(toast.error).mockClear()
})
afterEach(() => {
	vi.unstubAllGlobals()
})

describe('MenuReviewStack cards', () => {
	it('renders a structure card with preview, options, warnings and references', async () => {
		mockServer([MERGE])
		renderStack()
		const card = await screen.findByRole('group', {
			name: 'Merge duplicate dishes',
		})
		expect(within(card).getByRole('region', { name: 'Now' })).toBeTruthy()
		const after = within(card).getByRole('region', { name: 'After you accept' })
		expect(within(after).getByText('Hidden')).toBeTruthy()
		expect(
			within(card).getByRole('radio', { name: 'Keep Falafel wrap' }),
		).toBeTruthy()
		expect(
			within(card).getByRole('radio', { name: 'Keep Falafel wrap copy' }),
		).toBeTruthy()
		expect(within(card).getByText(/The prices differ/)).toBeTruthy()
		expect(within(card).getByText('Still used in')).toBeTruthy()
		expect(within(card).getByText('Same dish listed twice.')).toBeTruthy()
	})

	it('renders a polish card with options', async () => {
		mockServer([CAPITALS])
		renderStack()
		const card = await screen.findByRole('group', {
			name: 'Consistent capitals',
		})
		expect(within(card).getByRole('radio', { name: 'Title Case' })).toBeTruthy()
		expect(within(card).getByRole('radio', { name: 'UPPER CASE' })).toBeTruthy()
		expect(within(card).getByText('Changed')).toBeTruthy()
	})

	it('accepts with the chosen option, then undoes with the returned undo', async () => {
		const { calls } = mockServer([MERGE])
		const user = userEvent.setup()
		renderStack()
		await screen.findByRole('group', { name: 'Merge duplicate dishes' })
		await user.click(
			screen.getByRole('radio', { name: 'Keep Falafel wrap copy' }),
		)
		await user.click(screen.getByRole('button', { name: 'Accept' }))
		await waitFor(() => expect(undo.calls).toHaveLength(1))
		expect(calls[1]).toEqual({
			intent: 'apply-card',
			card: {
				kind: 'merge_duplicates',
				id: MERGE.id,
				refs: MERGE.refs,
				params: MERGE.params,
				optionId: 'keep-b',
			},
		})
		await undo.calls[0]!.onUndo()
		expect(calls[2]).toEqual({
			intent: 'undo-card',
			undo: { snapshotId: 's1', touched: [], created: [], links: [] },
		})
		expect(
			await screen.findByRole('group', { name: 'Merge duplicate dishes' }),
		).toBeTruthy()
	})

	it('sends the typed input and remembers the capitals style', async () => {
		const { calls } = mockServer([PRICE, CAPITALS])
		const user = userEvent.setup()
		renderStack()
		await screen.findByRole('group', { name: 'Check this price' })
		const accept = screen.getByRole('button', { name: 'Accept' })
		expect(accept).toBeDisabled()
		await user.type(screen.getByLabelText('Price'), '3.5')
		await user.click(accept)
		await screen.findByRole('group', { name: 'Consistent capitals' })
		expect(calls[1]).toMatchObject({
			intent: 'apply-card',
			card: { kind: 'check_price', optionId: 'set', input: '3.5' },
		})

		await user.click(screen.getByRole('radio', { name: 'UPPER CASE' }))
		await user.click(screen.getByRole('button', { name: 'Accept' }))
		await waitFor(() => expect(calls).toHaveLength(4))
		expect(calls[2]).toMatchObject({
			intent: 'apply-card',
			card: { kind: 'capitals', optionId: 'upper' },
		})
		expect(calls[3]).toEqual({
			intent: 'set-card-setting',
			setting: { key: 'capitalStyle', value: 'upper' },
		})
	})

	it('skips as "Not a problem" and undoes with unskip-card', async () => {
		const { calls } = mockServer([MERGE, CAPITALS])
		const user = userEvent.setup()
		renderStack()
		await screen.findByRole('group', { name: 'Merge duplicate dishes' })
		await user.click(screen.getByRole('button', { name: 'Skip' }))
		await user.click(
			await screen.findByRole('menuitem', { name: 'Not a problem' }),
		)
		await screen.findByRole('group', { name: 'Consistent capitals' })
		expect(calls[1]).toEqual({
			intent: 'skip-card',
			id: MERGE.id,
			kind: 'merge_duplicates',
			reason: 'not_a_problem',
		})
		await undo.calls[0]!.onUndo()
		expect(calls[2]).toEqual({
			intent: 'unskip-card',
			id: MERGE.id,
			kind: 'merge_duplicates',
		})
		expect(
			await screen.findByRole('group', { name: 'Merge duplicate dishes' }),
		).toBeTruthy()
	})

	it('records "I fixed it myself" and moves on without an undo', async () => {
		const { calls } = mockServer([MERGE, CAPITALS])
		const user = userEvent.setup()
		renderStack()
		await screen.findByRole('group', { name: 'Merge duplicate dishes' })
		await user.click(screen.getByRole('button', { name: 'Skip' }))
		await user.click(
			await screen.findByRole('menuitem', { name: 'I fixed it myself' }),
		)
		await screen.findByRole('group', { name: 'Consistent capitals' })
		expect(calls[1]).toMatchObject({
			intent: 'skip-card',
			reason: 'fixed_myself',
		})
		expect(undo.calls).toHaveLength(0)
	})

	it('moves on with Later without any request', async () => {
		const { calls } = mockServer([MERGE, CAPITALS])
		const user = userEvent.setup()
		renderStack()
		await screen.findByRole('group', { name: 'Merge duplicate dishes' })
		await user.click(screen.getByRole('button', { name: 'Skip' }))
		await user.click(await screen.findByRole('menuitem', { name: 'Later' }))
		await screen.findByRole('group', { name: 'Consistent capitals' })
		expect(calls.map((call) => call.intent)).toEqual(['generate'])
	})

	it('drops a card that changed since it was suggested', async () => {
		mockServer([MERGE, CAPITALS], (body) =>
			body.intent === 'apply-card'
				? { status: 409, body: { ok: false, error: 'stale_suggestion' } }
				: {},
		)
		const user = userEvent.setup()
		renderStack()
		await screen.findByRole('group', { name: 'Merge duplicate dishes' })
		await user.click(screen.getByRole('button', { name: 'Accept' }))
		await screen.findByRole('group', { name: 'Consistent capitals' })
		expect(toast.error).toHaveBeenCalledWith(
			'This changed since the suggestion was made',
		)
		expect(undo.calls).toHaveLength(0)
	})

	it('accepts several at once and reports each result', async () => {
		const { calls } = mockServer([MERGE, CAPITALS, PRICE], (body) =>
			body.intent === 'apply-cards'
				? {
						ok: true,
						results: [
							{
								id: MERGE.id,
								ok: true,
								undo: { snapshotId: 'u1', touched: [], created: [], links: [] },
							},
							{ id: CAPITALS.id, ok: false, error: 'stale_suggestion' },
						],
					}
				: {},
		)
		const user = userEvent.setup()
		renderStack()
		await screen.findByRole('group', { name: 'Merge duplicate dishes' })
		await user.click(screen.getByRole('button', { name: 'Select several' }))

		const price = screen.getByRole('checkbox', { name: /Check this price/ })
		await user.click(price)
		expect(
			screen.getByRole('button', { name: 'Accept selected' }),
		).toBeDisabled()
		await user.click(price)

		await user.click(
			screen.getByRole('checkbox', { name: /Merge duplicate dishes/ }),
		)
		await user.click(
			screen.getByRole('checkbox', { name: /Consistent capitals/ }),
		)
		await user.click(screen.getByRole('button', { name: 'Accept selected' }))

		await waitFor(() => expect(undo.calls).toHaveLength(1))
		expect(calls[1]).toMatchObject({
			intent: 'apply-cards',
			cards: [
				{ id: MERGE.id, optionId: 'keep-a' },
				{ id: CAPITALS.id, optionId: 'title' },
			],
		})
		const status = await screen.findByRole('status')
		expect(status.textContent).toContain('1 suggestion accepted')
		expect(status.textContent).toContain('1 changed since')

		await undo.calls[0]!.onUndo()
		expect(calls.at(-1)).toEqual({
			intent: 'undo-card',
			undo: { snapshotId: 'u1', touched: [], created: [], links: [] },
		})
	})

	it('skips several with a reason', async () => {
		const { calls } = mockServer([MERGE, CAPITALS])
		const user = userEvent.setup()
		renderStack()
		await screen.findByRole('group', { name: 'Merge duplicate dishes' })
		await user.click(screen.getByRole('button', { name: 'Select several' }))
		await user.click(screen.getByRole('button', { name: 'Select all' }))
		await user.click(screen.getByRole('button', { name: 'Skip selected' }))
		await user.click(
			await screen.findByRole('menuitem', { name: 'Not a problem' }),
		)
		await waitFor(() => expect(undo.calls).toHaveLength(1))
		expect(calls[1]).toEqual({
			intent: 'skip-cards',
			cards: [
				{ id: MERGE.id, kind: 'merge_duplicates', reason: 'not_a_problem' },
				{ id: CAPITALS.id, kind: 'capitals', reason: 'not_a_problem' },
			],
		})
	})
})
