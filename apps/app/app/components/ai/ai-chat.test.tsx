// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { AIChat } from '@repo/ai'
import { render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

function uiMessageStreamResponse(text: string) {
	return sseResponse([
		{ type: 'start' },
		{ type: 'text-start', id: 't1' },
		{ type: 'text-delta', id: 't1', delta: text },
		{ type: 'text-end', id: 't1' },
		{ type: 'finish' },
	])
}

function sseResponse(chunks: Array<Record<string, unknown>>) {
	const body =
		chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') +
		'data: [DONE]\n\n'
	return new Response(body, {
		headers: {
			'content-type': 'text/event-stream',
			'x-vercel-ai-ui-message-stream': 'v1',
		},
	})
}

beforeEach(() => {
	i18n.load('en', {})
	i18n.activate('en')
	// jsdom has no layout APIs that the conversation scroller relies on.
	Element.prototype.scrollTo ??= () => {}
	Element.prototype.getAnimations ??= () => []
	globalThis.ResizeObserver ??= class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver
})

afterEach(() => {
	vi.unstubAllGlobals()
})

test('shows an error with a retry when the chat request fails', async () => {
	const fetchMock = vi
		.fn<typeof fetch>()
		.mockResolvedValueOnce(
			new Response('AI provider is not configured', { status: 500 }),
		)
		.mockResolvedValueOnce(uiMessageStreamResponse('Here is the summary.'))
	vi.stubGlobal('fetch', fetchMock)

	const user = userEvent.setup()
	render(
		<I18nProvider i18n={i18n}>
			<AIChat noteId="note-1" orgSlug="acme" />
		</I18nProvider>,
	)

	await user.click(screen.getByRole('button', { name: 'Summarize this note' }))
	await user.click(screen.getByRole('button', { name: 'Send' }))

	const alert = await screen.findByRole('alert')
	expect(alert).toHaveTextContent(
		"The assistant couldn't reply. Check your connection and try again.",
	)
	// Follow-up chips must not pretend a reply arrived.
	expect(
		screen.queryByRole('button', { name: 'Make it more detailed' }),
	).not.toBeInTheDocument()

	await user.click(within(alert).getByRole('button', { name: 'Try again' }))

	expect(await screen.findByText('Here is the summary.')).toBeInTheDocument()
	expect(screen.queryByRole('alert')).not.toBeInTheDocument()
	expect(fetchMock).toHaveBeenCalledTimes(2)
})

test('lets the user send a new message after a failed request', async () => {
	const fetchMock = vi
		.fn<typeof fetch>()
		.mockResolvedValueOnce(new Response('Unavailable', { status: 503 }))
		.mockResolvedValueOnce(uiMessageStreamResponse('Key points follow.'))
	vi.stubGlobal('fetch', fetchMock)

	const user = userEvent.setup()
	render(
		<I18nProvider i18n={i18n}>
			<AIChat noteId="note-1" orgSlug="acme" />
		</I18nProvider>,
	)

	const input = screen.getByRole('textbox')
	await user.type(input, 'Summarize this note{Enter}')
	await screen.findByRole('alert')

	await user.type(input, 'What are the key points?{Enter}')

	expect(await screen.findByText('Key points follow.')).toBeInTheDocument()
	expect(fetchMock).toHaveBeenCalledTimes(2)
})

async function sendSummarize() {
	const user = userEvent.setup()
	render(
		<I18nProvider i18n={i18n}>
			<AIChat noteId="note-1" orgSlug="acme" />
		</I18nProvider>,
	)
	await user.click(screen.getByRole('button', { name: 'Summarize this note' }))
	await user.click(screen.getByRole('button', { name: 'Send' }))
	return user
}

test('shows the error when the provider fails inside a 200 stream', async () => {
	// What `toUIMessageStreamResponse()` sends when the AI provider is not
	// configured (for example no GOOGLE_GENERATIVE_AI_API_KEY): HTTP 200.
	vi.stubGlobal(
		'fetch',
		vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				sseResponse([
					{ type: 'start' },
					{ type: 'error', errorText: 'An error occurred.' },
				]),
			),
	)

	await sendSummarize()

	expect(await screen.findByRole('alert')).toHaveTextContent(
		"The assistant couldn't reply.",
	)
	expect(
		screen.queryByRole('button', { name: 'Make it more detailed' }),
	).not.toBeInTheDocument()
})

test('shows the error when the stream ends without a reply', async () => {
	const fetchMock = vi
		.fn<typeof fetch>()
		.mockResolvedValueOnce(sseResponse([{ type: 'start' }, { type: 'finish' }]))
		.mockResolvedValueOnce(uiMessageStreamResponse('Here is the summary.'))
	vi.stubGlobal('fetch', fetchMock)

	const user = await sendSummarize()

	const alert = await screen.findByRole('alert')
	expect(alert).toHaveTextContent("The assistant couldn't reply.")
	expect(
		screen.queryByRole('button', { name: 'Make it more detailed' }),
	).not.toBeInTheDocument()

	expect(alert).not.toHaveTextContent('Check your connection')

	await user.click(within(alert).getByRole('button', { name: 'Try again' }))

	expect(await screen.findByText('Here is the summary.')).toBeInTheDocument()
	expect(screen.queryByRole('alert')).not.toBeInTheDocument()
	// The retry button unmounts, so focus goes back to the input.
	expect(screen.getByRole('textbox')).toHaveFocus()
})

test('clears the empty-reply error when the user sends a new message', async () => {
	vi.stubGlobal(
		'fetch',
		vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				sseResponse([{ type: 'start' }, { type: 'finish' }]),
			)
			.mockResolvedValueOnce(uiMessageStreamResponse('Key points follow.')),
	)

	const user = await sendSummarize()
	await screen.findByRole('alert')

	await user.type(
		screen.getByRole('textbox'),
		'What are the key points?{Enter}',
	)

	expect(await screen.findByText('Key points follow.')).toBeInTheDocument()
	expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

test('does not report a reply the user stopped as failed', async () => {
	const encoder = new TextEncoder()
	vi.stubGlobal(
		'fetch',
		vi.fn<typeof fetch>((_input, init) => {
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					for (const chunk of [
						{ type: 'start' },
						{ type: 'text-start', id: 't1' },
					]) {
						controller.enqueue(
							encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
						)
					}
					init?.signal?.addEventListener('abort', () => {
						controller.error(new DOMException('Aborted', 'AbortError'))
					})
				},
			})
			return Promise.resolve(
				new Response(body, {
					headers: {
						'content-type': 'text/event-stream',
						'x-vercel-ai-ui-message-stream': 'v1',
					},
				}),
			)
		}),
	)

	const user = await sendSummarize()
	await user.click(await screen.findByRole('button', { name: 'Stop' }))

	expect(
		await screen.findByRole('button', { name: 'Send' }),
	).toBeInTheDocument()
	expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

test('shows a loading state while the request is pending', async () => {
	vi.stubGlobal(
		'fetch',
		vi.fn<typeof fetch>(() => new Promise<Response>(() => {})),
	)

	await sendSummarize()

	expect(await screen.findByText('One moment…')).toBeInTheDocument()
	expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})
