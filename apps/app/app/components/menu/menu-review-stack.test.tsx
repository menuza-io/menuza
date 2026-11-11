// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type UndoToastOptions } from '#app/components/undo-toast.ts'
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

const TRANSLATION: MenuSuggestion = {
	kind: 'translation',
	id: 'translation:i1:ar',
	itemId: 'i1',
	locale: 'ar',
	sourceLocale: 'en',
	name: 'فلافل',
	description: null,
	dishName: 'Falafel',
	imageUrl: null,
}
const SECOND_TRANSLATION: MenuSuggestion = {
	...TRANSLATION,
	id: 'translation:i3:ar',
	itemId: 'i3',
	name: 'شاي',
	dishName: 'Tea',
}
const STALE: MenuSuggestion = {
	kind: 'long_unavailable',
	id: 'long_unavailable:i2',
	itemId: 'i2',
	days: 12,
	dishName: 'Kunafa',
	imageUrl: null,
}

type Call = { intent: string } & Record<string, unknown>

function mockServer(suggestions: MenuSuggestion[]) {
	const calls: Call[] = []
	const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body)) as Call
		calls.push(body)
		const json = (value: unknown) =>
			new Response(JSON.stringify(value), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			})
		switch (body.intent) {
			case 'generate':
				return json({
					ok: true,
					batch: {
						suggestions:
							(body.seen as string[]).length === 0 ? suggestions : [],
						considered: suggestions.map((suggestion) => suggestion.id),
						remaining: 0,
						total: suggestions.length,
						aiUnavailable: false,
					},
				})
			case 'set-text':
			case 'set-text-bulk':
				return json({
					ok: true,
					results: [
						{
							itemId: body.itemId ?? 'i1',
							previous: [{ field: 'displayName', locale: 'ar', value: null }],
						},
					],
				})
			case 'set-item-availability':
				return json({
					ok: true,
					previous: {
						availabilityStatus: 'unavailable',
						unavailableUntil: null,
						updatedAt: '2026-10-01T00:00:00.000Z',
					},
				})
			default:
				return json({ ok: true, enabled: true })
		}
	})
	vi.stubGlobal('fetch', fetchMock)
	return { calls, fetchMock }
}

function renderStack(props: { translationLocales?: string[] } = {}) {
	i18n.load('en', {})
	i18n.activate('en')
	const onChanged = vi.fn()
	const onOpenChange = vi.fn()
	render(
		<I18nProvider i18n={i18n}>
			<MenuReviewStack
				orgSlug="cafe"
				open
				onOpenChange={onOpenChange}
				translationLocales={props.translationLocales ?? ['ar']}
				autoTranslate={false}
				onChanged={onChanged}
			/>
		</I18nProvider>,
	)
	return { onChanged, onOpenChange }
}

beforeEach(() => {
	undo.calls.length = 0
})
afterEach(() => {
	vi.unstubAllGlobals()
})

describe('MenuReviewStack', () => {
	it('generates nothing until opened, then shows one card at a time', async () => {
		const { calls } = mockServer([TRANSLATION, STALE])
		renderStack()
		expect(await screen.findByRole('heading', { name: 'Falafel' })).toBeTruthy()
		expect(calls).toEqual([{ intent: 'generate', seen: [] }])
		expect(screen.getByText('0 of 2 reviewed')).toBeTruthy()
		expect(
			screen.getByText('فلافل').closest('[lang]')?.getAttribute('dir'),
		).toBe('rtl')
		expect(screen.queryByRole('heading', { name: 'Kunafa' })).toBeNull()
	})

	it('accepts with the keyboard, moves focus to the next card and offers undo', async () => {
		const { calls } = mockServer([TRANSLATION, STALE])
		const user = userEvent.setup()
		renderStack()
		const card = await screen.findByRole('group', { name: 'Falafel' })
		await waitFor(() => expect(card).toHaveFocus())

		// Tab from the card reaches Skip, then Accept.
		await user.tab()
		expect(document.activeElement?.textContent).toBe('Skip')
		await user.tab()
		expect(document.activeElement?.textContent).toBe('Accept')
		await user.keyboard('{Enter}')

		const next = await screen.findByRole('group', { name: 'Kunafa' })
		await waitFor(() => expect(next).toHaveFocus())
		expect(screen.getByText('1 of 2 reviewed')).toBeTruthy()
		expect(calls[1]).toEqual({
			intent: 'set-text',
			reason: 'translation',
			itemId: 'i1',
			changes: [{ field: 'displayName', locale: 'ar', value: 'فلافل' }],
		})

		expect(undo.calls).toHaveLength(1)
		expect(undo.calls[0]!.message).toBe('Translation saved for Falafel')
		await undo.calls[0]!.onUndo()
		expect(calls[2]).toEqual({
			intent: 'set-text',
			reason: 'undo',
			itemId: 'i1',
			changes: [{ field: 'displayName', locale: 'ar', value: null }],
		})
		// The undone card is back on top.
		expect(await screen.findByRole('group', { name: 'Falafel' })).toBeTruthy()
		expect(screen.getByText('0 of 2 reviewed')).toBeTruthy()
	})

	it('skips without saving anything', async () => {
		const { calls } = mockServer([TRANSLATION, STALE])
		const user = userEvent.setup()
		renderStack()
		await screen.findByRole('group', { name: 'Falafel' })
		await user.click(screen.getByRole('button', { name: 'Skip' }))
		expect(await screen.findByRole('group', { name: 'Kunafa' })).toBeTruthy()
		expect(calls.map((call) => call.intent)).toEqual(['generate'])
		expect(undo.calls).toHaveLength(0)
	})

	it('offers both availability choices and restores the old state on undo', async () => {
		const { calls } = mockServer([STALE])
		const user = userEvent.setup()
		const { onChanged, onOpenChange } = renderStack()
		await screen.findByRole('group', { name: 'Kunafa' })
		expect(screen.getByRole('button', { name: 'Hide from menu' })).toBeTruthy()
		await user.click(screen.getByRole('button', { name: 'Make available' }))
		expect(await screen.findByText('All reviewed. Nice work.')).toBeTruthy()
		expect(calls[1]).toMatchObject({
			intent: 'set-item-availability',
			reason: 'make_available',
			availability: { availabilityStatus: 'available' },
		})
		await undo.calls[0]!.onUndo()
		expect(calls[2]).toMatchObject({
			intent: 'set-item-availability',
			reason: 'undo',
			availability: { availabilityStatus: 'unavailable' },
			restoreUpdatedAt: '2026-10-01T00:00:00.000Z',
		})
		await user.click(await screen.findByRole('button', { name: 'Skip' }))
		await user.click(screen.getByRole('button', { name: 'Done' }))
		expect(onOpenChange).toHaveBeenCalledWith(false)
		expect(onChanged).toHaveBeenCalledOnce()
	})

	it('asks before accepting all translations', async () => {
		const { calls } = mockServer([TRANSLATION, SECOND_TRANSLATION, STALE])
		const user = userEvent.setup()
		renderStack()
		await screen.findByRole('group', { name: 'Falafel' })
		await user.click(
			screen.getByRole('button', { name: 'Accept all 2 translations' }),
		)
		expect(calls.map((call) => call.intent)).toEqual(['generate'])
		await user.click(
			screen.getByRole('button', { name: 'Save 2 translations' }),
		)
		expect(await screen.findByRole('group', { name: 'Kunafa' })).toBeTruthy()
		expect(calls[1]).toMatchObject({
			intent: 'set-text-bulk',
			reason: 'translation',
			entries: [{ itemId: 'i1' }, { itemId: 'i3' }],
		})
		expect(screen.getByText('2 of 3 reviewed')).toBeTruthy()
	})

	it('saves the auto-translate toggle', async () => {
		const { calls } = mockServer([STALE])
		const user = userEvent.setup()
		renderStack()
		const toggle = await screen.findByRole('switch', {
			name: 'Translate new dishes into Arabic automatically',
		})
		await user.click(toggle)
		await waitFor(() =>
			expect(calls).toContainEqual({
				intent: 'set-auto-translate',
				enabled: true,
			}),
		)
	})
})
