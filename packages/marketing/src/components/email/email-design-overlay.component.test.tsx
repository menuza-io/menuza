// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { type EmailBlock } from '@repo/common/email-blocks'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'

// The designer's editor posts preview requests through a React Router fetcher;
// stub it so the overlay can be tested without a data router.
vi.mock('react-router', async (importOriginal) => ({
	...(await importOriginal<typeof import('react-router')>()),
	useFetcher: () => ({ submit: () => {}, state: 'idle', data: undefined }),
}))

import { EmailDesignOverlay } from './email-design-overlay.tsx'

i18n.loadAndActivate({ locale: 'en', messages: {} })

function Harness({
	initialBlocks,
	onSave,
	onOpenChange,
}: {
	initialBlocks: EmailBlock[]
	onSave: (blocks: EmailBlock[]) => void
	onOpenChange?: (open: boolean) => void
}) {
	const [open, setOpen] = useState(true)
	return (
		<I18nProvider i18n={i18n}>
			<button type="button" onClick={() => setOpen(true)}>
				Open
			</button>
			<EmailDesignOverlay
				open={open}
				onOpenChange={(next) => {
					onOpenChange?.(next)
					setOpen(next)
				}}
				initialBlocks={initialBlocks}
				subject="Welcome aboard"
				onSave={onSave}
			/>
		</I18nProvider>
	)
}

const overlay = () => screen.queryByRole('dialog', { name: 'Email design' })
const saveButton = () => screen.getByRole('button', { name: /^save$/i })
const cancelButton = () => screen.getByRole('button', { name: /^cancel$/i })
const discardGuard = () => screen.queryByText('Discard unsaved changes?')

/** Start from a blank design so applying a template is a single visible edit. */
async function applyTemplate(user: ReturnType<typeof userEvent.setup>) {
	await user.click(await screen.findByText('Announcement'))
}

describe('EmailDesignOverlay', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('holds edits in a draft and does not save them', async () => {
		const user = userEvent.setup()
		const onSave = vi.fn()
		render(<Harness initialBlocks={[]} onSave={onSave} />)

		expect(overlay()).toBeInTheDocument()
		// Nothing to save until the draft differs from the seed.
		expect(saveButton()).toBeDisabled()

		await applyTemplate(user)

		expect(saveButton()).toBeEnabled()
		expect(screen.getByText('Unsaved changes')).toBeInTheDocument()
		expect(onSave).not.toHaveBeenCalled()
	})

	it('saves the draft and closes', async () => {
		const user = userEvent.setup()
		const onSave = vi.fn()
		render(<Harness initialBlocks={[]} onSave={onSave} />)

		await applyTemplate(user)
		await user.click(saveButton())

		await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
		const saved = onSave.mock.calls[0]![0] as EmailBlock[]
		expect(saved.length).toBeGreaterThan(0)
		await waitFor(() => expect(overlay()).not.toBeInTheDocument())
	})

	it('asks before discarding unsaved changes', async () => {
		const user = userEvent.setup()
		const onSave = vi.fn()
		render(<Harness initialBlocks={[]} onSave={onSave} />)

		await applyTemplate(user)
		await user.click(cancelButton())

		expect(
			await screen.findByText('Discard unsaved changes?'),
		).toBeInTheDocument()

		// "Keep editing" leaves the designer open with the draft intact.
		await user.click(screen.getByRole('button', { name: /keep editing/i }))
		await waitFor(() => expect(discardGuard()).not.toBeInTheDocument())
		expect(overlay()).toBeInTheDocument()
		expect(saveButton()).toBeEnabled()
		expect(onSave).not.toHaveBeenCalled()
	})

	it('discards without saving when confirmed', async () => {
		const user = userEvent.setup()
		const onSave = vi.fn()
		const onOpenChange = vi.fn()
		render(
			<Harness
				initialBlocks={[]}
				onSave={onSave}
				onOpenChange={onOpenChange}
			/>,
		)

		await applyTemplate(user)
		await user.click(cancelButton())
		await screen.findByText('Discard unsaved changes?')
		await user.click(screen.getByRole('button', { name: /^discard$/i }))

		await waitFor(() => expect(overlay()).not.toBeInTheDocument())
		expect(onOpenChange).toHaveBeenCalledWith(false)
		expect(onSave).not.toHaveBeenCalled()
	})

	it('closes without prompting when there are no changes', async () => {
		const user = userEvent.setup()
		const onSave = vi.fn()
		const onOpenChange = vi.fn()
		render(
			<Harness
				initialBlocks={[]}
				onSave={onSave}
				onOpenChange={onOpenChange}
			/>,
		)

		await user.click(cancelButton())

		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
		expect(discardGuard()).not.toBeInTheDocument()
		expect(onSave).not.toHaveBeenCalled()
	})

	it('seeds a fresh draft each time it opens', async () => {
		const user = userEvent.setup()
		const onSave = vi.fn()
		render(<Harness initialBlocks={[]} onSave={onSave} />)

		await applyTemplate(user)
		expect(saveButton()).toBeEnabled()

		// Discard, then reopen.
		await user.click(cancelButton())
		await user.click(await screen.findByRole('button', { name: /^discard$/i }))
		await waitFor(() => expect(overlay()).not.toBeInTheDocument())

		await user.click(screen.getByRole('button', { name: /^open$/i }))

		await waitFor(() => expect(overlay()).toBeInTheDocument())
		// Draft reset to the seed, so there is nothing to save again.
		await waitFor(() => expect(saveButton()).toBeDisabled())
	})
})
