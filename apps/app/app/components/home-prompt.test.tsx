// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HomePrompt } from './home-prompt.tsx'
import { stubImageDecoding } from './test-image-decoding.ts'

const ask = vi.fn()

vi.mock('#app/components/ai/ai-panel-context.tsx', () => ({
	useAIPanel: () => ({ ask }),
}))

let currentUserId: string | undefined = 'user-1'
vi.mock('react-router', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	useRouteLoaderData: () =>
		currentUserId ? { user: { id: currentUserId } } : { user: null },
}))

beforeEach(() => {
	ask.mockClear()
	currentUserId = 'user-1'
	stubImageDecoding()
	i18n.load('en', {})
	i18n.activate('en')
	window.localStorage?.clear?.()
	vi.stubGlobal(
		'matchMedia',
		vi.fn(() => ({
			matches: false,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		})),
	)
	vi.stubGlobal(
		'ResizeObserver',
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	)
})

function setup() {
	const user = userEvent.setup()
	render(
		<I18nProvider i18n={i18n}>
			<HomePrompt />
		</I18nProvider>,
	)
	return { user, input: screen.getByRole('textbox') }
}

describe('HomePrompt', () => {
	it('opens the suggestions when the bar is focused', async () => {
		const { user, input } = setup()
		expect(screen.queryByText('Suggestions')).toBeNull()
		await user.click(input)
		expect(screen.getByText('Suggestions')).toBeTruthy()
		expect(
			screen.getByRole('button', { name: /Summarize my notes/ }),
		).toBeTruthy()
	})

	it('fills the bar with the full prompt when a suggestion is chosen', async () => {
		const { user, input } = setup()
		await user.click(input)
		await user.click(screen.getByRole('button', { name: /Summarize my notes/ }))
		expect((input as HTMLTextAreaElement).value).toContain(
			'Summarize my most recent notes',
		)
		expect(ask).not.toHaveBeenCalled()
	})

	it('asks the assistant on Enter and clears the bar', async () => {
		const { user, input } = setup()
		await user.type(input, 'Open my reports{Enter}')
		expect(ask).toHaveBeenCalledWith('Open my reports', [])
		expect((input as HTMLTextAreaElement).value).toBe('')
	})

	it('keeps a new line on Shift+Enter instead of sending', async () => {
		const { user, input } = setup()
		await user.type(input, 'one{Shift>}{Enter}{/Shift}two')
		expect(ask).not.toHaveBeenCalled()
		expect((input as HTMLTextAreaElement).value).toBe('one\ntwo')
	})

	it('walks the suggestions with the arrow keys and picks one with Enter', async () => {
		const { user, input } = setup()
		await user.click(input)
		await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{Enter}')
		expect((input as HTMLTextAreaElement).value).toContain(
			'Take me to my reports',
		)
		expect(ask).not.toHaveBeenCalled()
	})

	it('sends with the send button, which only appears with text', async () => {
		const { user, input } = setup()
		expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
		await user.type(input, 'Plan an email')
		await user.click(await screen.findByRole('button', { name: 'Send' }))
		expect(ask).toHaveBeenCalledWith('Plan an email', [])
	})

	it('attaches an image and hands it to the assistant with the question', async () => {
		const { user, input } = setup()
		const file = new File([new Uint8Array([137, 80, 78, 71])], 'plan.png', {
			type: 'image/png',
		})
		const fileInput = document.querySelector('input[type="file"]')
		await user.upload(fileInput as HTMLInputElement, file)
		expect(
			await screen.findByRole('button', { name: 'Remove plan.png' }),
		).toBeTruthy()
		await user.type(input, 'What is this?{Enter}')
		expect(ask).toHaveBeenCalledTimes(1)
		const [text, files] = ask.mock.calls[0] as [string, Array<{ name: string }>]
		expect(text).toBe('What is this?')
		expect(files.map((item) => item.name)).toEqual(['plan.png'])
	})

	it('can send a picture on its own, and removes one on request', async () => {
		const { user } = setup()
		const file = new File([new Uint8Array([1, 2, 3])], 'a.png', {
			type: 'image/png',
		})
		await user.upload(
			document.querySelector('input[type="file"]') as HTMLInputElement,
			file,
		)
		await screen.findByRole('button', { name: 'Remove a.png' })
		await user.click(screen.getByRole('button', { name: 'Remove a.png' }))
		expect(screen.queryByRole('button', { name: 'Remove a.png' })).toBeNull()

		await user.upload(
			document.querySelector('input[type="file"]') as HTMLInputElement,
			file,
		)
		await user.click(await screen.findByRole('button', { name: 'Send' }))
		expect(ask).toHaveBeenCalledTimes(1)
		expect(ask.mock.calls[0]?.[0]).toBe('')
	})

	it('does not send while an IME candidate is being committed', async () => {
		const { user, input } = setup()
		await user.type(input, 'konnichiwa')
		const { fireEvent } = await import('@testing-library/react')
		fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
		expect(ask).not.toHaveBeenCalled()
	})

	it('reopens the suggestions with the arrow keys after Escape', async () => {
		const { user, input } = setup()
		await user.click(input)
		expect(screen.getByText('Suggestions')).toBeTruthy()
		await user.keyboard('{Escape}')
		// The menu fades out before it leaves the DOM.
		await waitFor(() => expect(screen.queryByText('Suggestions')).toBeNull())
		await user.keyboard('{ArrowDown}')
		expect(screen.getByText('Suggestions')).toBeTruthy()
	})

	it('keeps recent questions per user and drops the old shared key', async () => {
		const store = new Map<string, string>([['home-prompt-recent', '["old"]']])
		Object.defineProperty(window, 'localStorage', {
			configurable: true,
			value: {
				getItem: (key: string) => store.get(key) ?? null,
				setItem: (key: string, value: string) => void store.set(key, value),
				removeItem: (key: string) => void store.delete(key),
				clear: () => store.clear(),
			},
		})
		const { user, input } = setup()
		await user.type(input, 'Open my reports{Enter}')
		expect(store.has('home-prompt-recent')).toBe(false)
		expect(JSON.parse(store.get('home-prompt-recent:user-1') ?? '[]')).toEqual([
			'Open my reports',
		])
	})

	it('keeps nothing when nobody is signed in', async () => {
		currentUserId = undefined
		const setItem = vi.fn()
		Object.defineProperty(window, 'localStorage', {
			configurable: true,
			value: { getItem: () => null, setItem, removeItem: vi.fn() },
		})
		const { user, input } = setup()
		await user.type(input, 'Open my reports{Enter}')
		expect(setItem).not.toHaveBeenCalled()
	})

	it('lights a suggestion row that takes keyboard focus', async () => {
		const { user, input } = setup()
		await user.click(input)
		const row = screen.getByRole('button', { name: /Summarize my notes/ })
		row.focus()
		await waitFor(() => expect(row.getAttribute('data-active')).toBe('true'))
	})

	it('reports an image dropped because the limit was already reached', async () => {
		const { user } = setup()
		const files = [1, 2, 3, 4, 5].map(
			(n) =>
				new File([new Uint8Array([n])], `p${n}.png`, { type: 'image/png' }),
		)
		const fileInput = document.querySelector('input[type="file"]')
		fireEvent.change(fileInput as HTMLInputElement, { target: { files } })
		await screen.findByRole('button', { name: 'Remove p1.png' })
		expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(4)
		expect(await screen.findByRole('status')).toBeTruthy()
		void user
	})
})
