// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { AIChat } from '@repo/ai'
import { render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { stubImageDecoding } from '../test-image-decoding.ts'

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

test('sends a question handed over from outside once, then reports it sent', async () => {
	const fetchMock = vi
		.fn<typeof fetch>()
		.mockResolvedValue(uiMessageStreamResponse('Opened your reports.'))
	vi.stubGlobal('fetch', fetchMock)
	const onSent = vi.fn()

	render(
		<I18nProvider i18n={i18n}>
			<AIChat
				orgSlug="acme"
				pendingMessage={{ text: 'Take me to my reports' }}
				onPendingMessageSent={onSent}
			/>
		</I18nProvider>,
	)

	expect(await screen.findByText('Opened your reports.')).toBeInTheDocument()
	expect(fetchMock).toHaveBeenCalledTimes(1)
	expect(onSent).toHaveBeenCalledTimes(1)
	const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
		messages: unknown
	}
	expect(JSON.stringify(body.messages)).toContain('Take me to my reports')
})

test('attaches an image and sends it with the message', async () => {
	stubImageDecoding()
	const fetchMock = vi
		.fn<typeof fetch>()
		.mockResolvedValue(uiMessageStreamResponse('It is a cat.'))
	vi.stubGlobal('fetch', fetchMock)

	const user = userEvent.setup()
	const { container } = render(
		<I18nProvider i18n={i18n}>
			<AIChat orgSlug="acme" />
		</I18nProvider>,
	)

	const file = new File([new Uint8Array([137, 80, 78, 71])], 'cat.png', {
		type: 'image/png',
	})
	const input = container.querySelector('input[type="file"]')
	expect(input).not.toBeNull()
	await user.upload(input as HTMLInputElement, file)

	expect(
		await screen.findByRole('button', { name: 'Remove cat.png' }),
	).toBeInTheDocument()
	// A picture alone is enough to send.
	await user.click(screen.getByRole('button', { name: 'Send' }))

	expect(await screen.findByText('It is a cat.')).toBeInTheDocument()
	const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
		messages: Array<{ parts: Array<{ type: string; mediaType?: string }> }>
	}
	const parts = body.messages[0]?.parts ?? []
	expect(parts.some((part) => part.type === 'file')).toBe(true)
	expect(parts.some((part) => part.type === 'text' && 'text' in part)).toBe(
		false,
	)
})

test('removes an attached image before sending', async () => {
	stubImageDecoding()
	vi.stubGlobal('fetch', vi.fn<typeof fetch>())
	const user = userEvent.setup()
	const { container } = render(
		<I18nProvider i18n={i18n}>
			<AIChat orgSlug="acme" />
		</I18nProvider>,
	)
	const file = new File([new Uint8Array([1, 2, 3])], 'a.png', {
		type: 'image/png',
	})
	await user.upload(
		container.querySelector('input[type="file"]') as HTMLInputElement,
		file,
	)
	await screen.findByRole('button', { name: 'Remove a.png' })
	await user.click(screen.getByRole('button', { name: 'Remove a.png' }))
	expect(
		screen.queryByRole('button', { name: 'Remove a.png' }),
	).not.toBeInTheDocument()
})

test('refuses a file that is not an image', async () => {
	vi.stubGlobal('fetch', vi.fn<typeof fetch>())
	const { container } = render(
		<I18nProvider i18n={i18n}>
			<AIChat orgSlug="acme" />
		</I18nProvider>,
	)
	const input = container.querySelector(
		'input[type="file"]',
	) as HTMLInputElement
	const file = new File(['x'], 'notes.pdf', { type: 'application/pdf' })
	// user.upload honours `accept`, so fire the change directly.
	const { fireEvent } = await import('@testing-library/react')
	fireEvent.change(input, { target: { files: [file] } })
	expect(await screen.findByRole('status')).toHaveTextContent(
		"Some images couldn't be added",
	)
	expect(screen.queryByRole('img')).not.toBeInTheDocument()
})
