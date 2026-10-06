// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatComposeDialog } from './chat-compose-dialog.tsx'

const mocks = vi.hoisted(() => ({
	submit: vi.fn(),
	navigate: vi.fn(),
	state: 'idle',
	data: undefined as
		{ ok: boolean; error?: string; channelId?: string } | undefined,
}))

vi.mock('react-router', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	useFetcher: () => ({
		submit: mocks.submit,
		state: mocks.state,
		data: mocks.data,
	}),
	useNavigate: () => mocks.navigate,
}))

vi.mock('./chat-message.tsx', () => ({
	PersonAvatar: () => <span aria-hidden />,
}))

const members = [
	{ id: 'sam', label: 'Sam Rivera' },
	{ id: 'jules', label: 'Jules Chen' },
]

function renderDialog(
	options: { members?: typeof members; canCreateGroup?: boolean } = {},
) {
	return render(
		<I18nProvider i18n={i18n}>
			<ChatComposeDialog
				members={options.members ?? members}
				canCreateGroup={options.canCreateGroup ?? true}
				onClose={vi.fn()}
				onCreated={vi.fn()}
			/>
		</I18nProvider>,
	)
}

beforeEach(() => {
	i18n.load('en', {})
	i18n.activate('en')
	mocks.submit.mockReset()
	mocks.navigate.mockReset()
	mocks.state = 'idle'
	mocks.data = undefined
})

describe('new message dialog', () => {
	it('requires a selected teammate before starting a direct message', async () => {
		const user = userEvent.setup()
		renderDialog()
		const start = screen.getByRole('button', { name: 'Start conversation' })
		expect(start).toBeDisabled()
		await user.click(screen.getByRole('radio', { name: 'Sam Rivera' }))
		expect(start).toBeEnabled()
		await user.click(start)
		expect(mocks.submit).toHaveBeenCalledWith(
			{ intent: 'dm', targetUserId: 'sam' },
			{ method: 'POST', encType: 'application/json' },
		)
	})

	it('keeps the selection visible while filtering other teammates', async () => {
		const user = userEvent.setup()
		renderDialog()
		await user.click(screen.getByRole('radio', { name: 'Sam Rivera' }))
		await user.type(screen.getByRole('searchbox'), 'Jules')
		expect(screen.queryByRole('radio', { name: 'Sam Rivera' })).toBeNull()
		expect(
			screen.getByRole('button', { name: 'Remove Sam Rivera' }),
		).toBeVisible()
		await user.click(screen.getByRole('button', { name: 'Remove Sam Rivera' }))
		expect(
			screen.getByRole('button', { name: 'Start conversation' }),
		).toBeDisabled()
	})

	it('shows a useful empty search state and lets people clear it', async () => {
		const user = userEvent.setup()
		renderDialog()
		await user.type(screen.getByRole('searchbox'), 'nobody')
		expect(screen.getByText('No matching teammates')).toBeVisible()
		await user.click(screen.getByRole('button', { name: 'Clear search' }))
		expect(screen.getByRole('radio', { name: 'Jules Chen' })).toBeVisible()
	})

	it('requires both a group name and a teammate and submits the history setting', async () => {
		const user = userEvent.setup()
		renderDialog()
		await user.click(screen.getByRole('tab', { name: 'Group' }))
		const create = screen.getByRole('button', { name: 'Create group' })
		expect(create).toBeDisabled()
		await user.type(screen.getByLabelText('Group name'), '  Launch crew  ')
		expect(create).toBeDisabled()
		await user.click(screen.getByRole('checkbox', { name: 'Jules Chen' }))
		await user.click(
			screen.getByRole('checkbox', {
				name: /New members can read earlier messages/,
			}),
		)
		expect(create).toBeEnabled()
		await user.click(create)
		expect(mocks.submit).toHaveBeenCalledWith(
			{
				intent: 'createGroup',
				name: 'Launch crew',
				memberIds: ['jules'],
				showHistoryToNewMembers: true,
			},
			{ method: 'POST', encType: 'application/json' },
		)
	})

	it('does not offer group creation without permission', () => {
		renderDialog({ canCreateGroup: false })
		expect(screen.queryByRole('tab', { name: 'Group' })).toBeNull()
		expect(screen.getByRole('radio', { name: 'Sam Rivera' })).toBeVisible()
	})

	it('explains when no teammates are available', () => {
		renderDialog({ members: [] })
		expect(screen.getByText('No teammates available')).toBeVisible()
		expect(
			screen.getByRole('button', { name: 'Start conversation' }),
		).toBeDisabled()
	})

	it('prevents duplicate submissions while starting a conversation', () => {
		mocks.state = 'submitting'
		renderDialog()
		expect(screen.getByRole('button', { name: 'Starting…' })).toBeDisabled()
		expect(screen.getByRole('searchbox')).toBeDisabled()
		expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
	})

	it('shows server errors without discarding the dialog', () => {
		mocks.data = { ok: false, error: 'That person is not on the team.' }
		renderDialog()
		expect(screen.getByRole('alert')).toHaveTextContent(
			'That person is not on the team.',
		)
		expect(screen.getByRole('dialog')).toBeVisible()
	})
})
