// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AiDraftProvider, type AiDraftConfig } from './ai-draft-config.tsx'
import { AiDraftDialog, type AiDraftApply } from './ai-draft-dialog.tsx'

i18n.loadAndActivate({ locale: 'en', messages: {} })

const config: AiDraftConfig = {
	endpoint: '/resources/marketing/ai-draft',
	orgSlug: 'olive',
	defaultLanguage: 'en',
}

function show(
	props: { hasContent: boolean; channel?: 'email' | 'sms'; config?: AiDraftConfig | null },
	onApply = vi.fn<(draft: AiDraftApply) => void>(),
) {
	const router = createMemoryRouter(
		[
			{
				path: '/',
				element: (
					<I18nProvider i18n={i18n}>
						<AiDraftProvider config={props.config === undefined ? config : props.config}>
							<AiDraftDialog
								open
								onOpenChange={() => {}}
								channel={props.channel ?? 'sms'}
								hasContent={props.hasContent}
								initialGoal="Announce an event or an occasion"
								onApply={onApply}
							/>
						</AiDraftProvider>
					</I18nProvider>
				),
			},
		],
		{ initialEntries: ['/'] },
	)
	render(<RouterProvider router={router} />)
	return onApply
}

function mockFetch(answer: { status?: number; body: unknown }) {
	const fn = vi.fn(async () =>
		Response.json(answer.body, { status: answer.status ?? 200 }),
	)
	vi.stubGlobal('fetch', fn)
	return fn
}

afterEach(() => vi.unstubAllGlobals())

describe('AiDraftDialog (#155)', () => {
	it('renders nothing where drafts are not available', () => {
		show({ hasContent: false, config: null })
		expect(screen.queryByText('Draft with AI')).toBeNull()
	})

	it('starts from the goal a later occasion card passes in', () => {
		show({ hasContent: false })
		expect((screen.getByLabelText(/what is this message for/i) as HTMLTextAreaElement).value).toBe(
			'Announce an event or an occasion',
		)
	})

	it('shows the draft first and fills the editor only when used', async () => {
		const user = userEvent.setup()
		const fetchMock = mockFetch({ body: { draft: { channel: 'sms', message: 'Lunch is back!' } } })
		const onApply = show({ hasContent: false })
		await user.click(screen.getByRole('button', { name: /write a draft/i }))
		await screen.findByText('Lunch is back!')
		expect(onApply).not.toHaveBeenCalled()
		const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body)
		expect(body).toMatchObject({ orgSlug: 'olive', action: 'draft', channel: 'sms', language: 'en', itemIds: [] })
		await user.click(screen.getByRole('button', { name: /use this draft/i }))
		expect(onApply).toHaveBeenCalledWith({ channel: 'sms', message: 'Lunch is back!' })
	})

	it('asks before replacing existing content', async () => {
		const user = userEvent.setup()
		mockFetch({ body: { draft: { channel: 'sms', message: 'New text' } } })
		const onApply = show({ hasContent: true })
		await user.click(screen.getByRole('button', { name: /write a draft/i }))
		await user.click(await screen.findByRole('button', { name: /use this draft/i }))
		expect(onApply).not.toHaveBeenCalled()
		expect(await screen.findByText('Replace what you have?')).toBeTruthy()
		await user.click(screen.getByRole('button', { name: 'Keep mine' }))
		expect(onApply).not.toHaveBeenCalled()
		await user.click(screen.getByRole('button', { name: /use this draft/i }))
		await user.click(await screen.findByRole('button', { name: 'Replace' }))
		await waitFor(() => expect(onApply).toHaveBeenCalledWith({ channel: 'sms', message: 'New text' }))
	})

	it('says so plainly when the draft is invalid or the limit is reached, and changes nothing', async () => {
		const user = userEvent.setup()
		mockFetch({ status: 422, body: { error: 'ai_draft_invalid' } })
		const onApply = show({ hasContent: false })
		await user.click(screen.getByRole('button', { name: /write a draft/i }))
		expect(await screen.findByText(/could not be used/i)).toBeTruthy()
		mockFetch({ status: 429, body: { error: 'ai_draft_limit' } })
		await user.click(screen.getByRole('button', { name: /write a draft/i }))
		expect(await screen.findByText(/reached the limit/i)).toBeTruthy()
		expect(onApply).not.toHaveBeenCalled()
	})
})
