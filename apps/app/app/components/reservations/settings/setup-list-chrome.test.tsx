// @vitest-environment jsdom
import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderStaff } from '#tests/staff-render.tsx'
import { SetupNotices, useDiscardGuard } from './setup-list-chrome.tsx'

function Harness({ dirty, close }: { dirty: boolean; close: () => void }) {
	const { requestClose, discardDialog } = useDiscardGuard(dirty, close)
	return (
		<>
			<button type="button" onClick={requestClose}>
				close
			</button>
			{discardDialog}
		</>
	)
}

describe('useDiscardGuard', () => {
	it('closes straight away when nothing was edited', () => {
		const close = vi.fn()
		renderStaff(<Harness dirty={false} close={close} />)
		fireEvent.click(screen.getByText('close'))
		expect(close).toHaveBeenCalledTimes(1)
	})

	it('asks first when there are unsaved edits and closes only on Discard', async () => {
		const close = vi.fn()
		renderStaff(<Harness dirty close={close} />)
		fireEvent.click(screen.getByText('close'))
		expect(close).not.toHaveBeenCalled()
		fireEvent.click(await screen.findByTestId('setup-confirm-discard'))
		expect(close).toHaveBeenCalledTimes(1)
	})

	it('keeps the sheet open on Keep editing', async () => {
		const close = vi.fn()
		renderStaff(<Harness dirty close={close} />)
		fireEvent.click(screen.getByText('close'))
		fireEvent.click(await screen.findByText('Keep editing'))
		expect(close).not.toHaveBeenCalled()
	})
})

describe('SetupNotices retry', () => {
	it('offers Retry on a load error', () => {
		const onRetry = vi.fn()
		renderStaff(
			<SetupNotices errorMessage="Could not load." onRetry={onRetry} />,
		)
		fireEvent.click(screen.getByTestId('setup-retry'))
		expect(onRetry).toHaveBeenCalled()
	})
})
