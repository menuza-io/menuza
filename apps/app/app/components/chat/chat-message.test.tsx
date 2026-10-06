// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { type ChatMessage } from '@repo/common/chat'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageItem, QUICK_REACTIONS } from './chat-message.tsx'

vi.mock('./chat-composer.tsx', () => ({
	ChatComposer: () => null,
}))

const message: ChatMessage = {
	id: 1,
	channel: 'general',
	parent: null,
	author: 'me',
	body: 'Hello team',
	attachments: [],
	createdAt: new Date(2026, 9, 6, 9).getTime(),
	editedAt: null,
	deleted: false,
	replyCount: 0,
	lastReplyAt: null,
	reactions: [],
}

beforeEach(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

function renderMessage() {
	const onReact = vi.fn()
	render(
		<I18nProvider i18n={i18n}>
			<MessageItem
				orgSlug="example"
				members={[]}
				message={message}
				people={{ me: { id: 'me', name: 'Alex', image: null } }}
				meId="me"
				canModerate
				online={[]}
				locale="en"
				showHeader
				onReact={onReact}
				onReply={vi.fn()}
				onEdit={vi.fn().mockResolvedValue(undefined)}
				onDelete={vi.fn()}
			/>
		</I18nProvider>,
	)
	return { onReact }
}

async function openReactions() {
	const user = userEvent.setup()
	await user.click(screen.getByRole('button', { name: 'Message actions' }))
	await user.click(
		await screen.findByRole('menuitem', { name: 'Add reaction' }),
	)
	await screen.findByRole('menuitem', { name: 'React with 👍' })
	return user
}

describe('compact message reactions', () => {
	it('shows each emoji once while keeping a screen-reader label', async () => {
		renderMessage()
		await openReactions()
		for (const emoji of QUICK_REACTIONS) {
			const item = screen.getByRole('menuitem', { name: `React with ${emoji}` })
			expect(item.textContent).toBe(emoji)
			expect(item).toHaveClass('size-10')
		}
	})

	it('reacts to the correct message and closes the menu', async () => {
		const { onReact } = renderMessage()
		await openReactions()
		fireEvent.click(screen.getByRole('menuitem', { name: 'React with 🎉' }))
		expect(onReact).toHaveBeenCalledExactlyOnceWith(message, '🎉')
		await waitFor(() => {
			expect(
				screen.queryByRole('menuitem', { name: 'React with 🎉' }),
			).toBeNull()
		})
	})

	it('supports choosing a reaction with the keyboard', async () => {
		const { onReact } = renderMessage()
		const user = await openReactions()
		screen.getByRole('menuitem', { name: 'React with ❤️' }).focus()
		await user.keyboard('{Enter}')
		expect(onReact).toHaveBeenCalledExactlyOnceWith(message, '❤️')
	})
})
