// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { type ChatChannelSummary } from '@repo/common/chat'
import { render, screen, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initialChatState } from '#app/modules/chat/chat-state.ts'
import { ChatView } from './chat-view.tsx'

vi.mock('#app/hooks/use-chat.ts', () => ({
	useChat: () => ({ state: initialChatState }),
}))

const channels: ChatChannelSummary[] = [
	{
		id: 'general',
		name: 'general',
		description: '',
		access: 'everyone',
		kind: 'channel',
	},
	{
		id: 'team',
		name: 'Team',
		description: '',
		access: 'restricted',
		kind: 'group',
	},
]

beforeEach(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

describe('compact chat navigation', () => {
	it('uses compact rows while preserving touch targets and focus states', () => {
		const router = createMemoryRouter(
			[
				{
					path: '/',
					element: (
						<ChatView
							orgSlug="example"
							channels={channels}
							activeChannelId={null}
							canManage={true}
							canCreateGroup={false}
							members={[]}
							groupMemberIds={{}}
						/>
					),
				},
			],
			{ initialEntries: ['/?channel=general'] },
		)
		render(
			<I18nProvider i18n={i18n}>
				<RouterProvider router={router} />
			</I18nProvider>,
		)

		const nav = within(screen.getByRole('navigation', { name: 'Channels' }))
		for (const name of ['general', 'Team', 'Manage channels']) {
			const row = nav.getByRole('link', { name })
			expect(row).toHaveClass(
				'min-h-8',
				'px-2',
				'py-1',
				'gap-2',
				'pointer-coarse:min-h-11',
				'focus-visible:ring-2',
			)
			expect(row).not.toHaveClass('min-h-11', 'py-2')
		}
		expect(nav.getByRole('link', { name: 'general' })).toHaveAttribute(
			'href',
			'/?channel=general',
		)
		expect(nav.getByRole('link', { name: 'Manage channels' })).toHaveAttribute(
			'href',
			'/example/settings/chat',
		)
	})
})
