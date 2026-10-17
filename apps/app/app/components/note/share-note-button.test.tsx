// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ShareNoteButton } from './share-note-button.tsx'

const mocks = vi.hoisted(() => ({ submit: vi.fn() }))

vi.mock('react-router', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	useFetcher: () => ({
		submit: mocks.submit,
		state: 'idle',
		data: undefined,
	}),
}))

const owner = { id: 'owner', name: 'Test Owner', username: 'owner' }
const sam = { id: 'sam', name: 'Sam Rivera', username: 'sam' }

const members = [owner, sam].map((user) => ({ userId: user.id, user }))

function renderDialog(
	options: { isPublic?: boolean; noteAccess?: (typeof sam)[] } = {},
) {
	const onOpenChange = vi.fn()
	render(
		<I18nProvider i18n={i18n}>
			<ShareNoteButton
				showTrigger={false}
				open
				onOpenChange={onOpenChange}
				noteId="note-1"
				noteOwnerId={owner.id}
				isPublic={options.isPublic ?? true}
				noteAccess={(options.noteAccess ?? []).map((user) => ({
					id: `access-${user.id}`,
					user,
				}))}
				organizationMembers={members}
			/>
		</I18nProvider>,
	)
	return { onOpenChange }
}

beforeEach(() => {
	i18n.load('en', {})
	i18n.activate('en')
	mocks.submit.mockReset()
})

afterEach(() => cleanup())

describe('share note dialog', () => {
	it('offers Done, not Make Public, for a note that is already public', async () => {
		const user = userEvent.setup()
		const { onOpenChange } = renderDialog()
		expect(
			screen.queryByRole('button', { name: 'Make Public' }),
		).not.toBeInTheDocument()
		await user.click(screen.getByRole('button', { name: 'Done' }))
		expect(onOpenChange).toHaveBeenCalledWith(false)
		expect(mocks.submit).not.toHaveBeenCalled()
	})

	it('does not offer the note owner or a "Share with 0 members" action', async () => {
		const user = userEvent.setup()
		renderDialog()
		await user.click(screen.getByRole('switch'))

		expect(screen.queryByText('Test Owner')).not.toBeInTheDocument()
		expect(screen.getByText('Sam Rivera')).toBeInTheDocument()
		expect(screen.queryByText(/Share with 0 members/)).not.toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Make Private' })).toBeEnabled()
		expect(
			screen.getByText('Only you can access this note'),
		).toBeInTheDocument()

		await user.click(screen.getByText('Sam Rivera'))
		await user.click(
			screen.getByRole('button', { name: 'Share with 1 member' }),
		)
		const formData = mocks.submit.mock.calls[0]?.[0] as FormData
		expect(formData.get('intent')).toBe('batch-update-note-access')
		expect(formData.getAll('usersToAdd')).toEqual([sam.id])
	})

	it('shows Done for a private note until its members change', async () => {
		const user = userEvent.setup()
		renderDialog({ isPublic: false, noteAccess: [sam] })
		expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled()

		await user.click(screen.getByRole('button', { name: 'Remove' }))
		expect(screen.getByRole('button', { name: 'Make Private' })).toBeEnabled()
		expect(
			screen.queryByRole('button', { name: 'Done' }),
		).not.toBeInTheDocument()
	})
})
