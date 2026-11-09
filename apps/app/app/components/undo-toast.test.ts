import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { showUndoToast, UNDO_TOAST_DURATION_MS } from './undo-toast.ts'

vi.mock('sonner', () => {
	const toastFn = Object.assign(
		vi.fn(() => 'toast-1'),
		{
			success: vi.fn(),
			error: vi.fn(),
		},
	)
	return { toast: toastFn }
})

type Options = {
	duration: number
	action: { label: string; onClick: () => void }
}

function lastOptions(): Options {
	const calls = vi.mocked(toast).mock.calls
	return calls[calls.length - 1]![1] as unknown as Options
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe('showUndoToast', () => {
	it('stays for a minute with an Undo action', () => {
		const id = showUndoToast({
			message: 'Waste logged: chicken, 2 kg',
			undoLabel: 'Undo',
			failedMessage: 'Could not undo',
			onUndo: vi.fn(),
		})
		expect(id).toBe('toast-1')
		expect(toast).toHaveBeenCalledWith(
			'Waste logged: chicken, 2 kg',
			expect.anything(),
		)
		expect(UNDO_TOAST_DURATION_MS).toBe(60_000)
		expect(lastOptions().duration).toBe(60_000)
		expect(lastOptions().action.label).toBe('Undo')
	})

	it('runs the undo and confirms it', async () => {
		const onUndo = vi.fn().mockResolvedValue(undefined)
		showUndoToast({
			message: 'm',
			undoLabel: 'Undo',
			undoneMessage: 'Undone',
			failedMessage: 'Failed',
			onUndo,
		})
		lastOptions().action.onClick()
		await vi.waitFor(() => expect(toast.success).toHaveBeenCalledWith('Undone'))
		expect(onUndo).toHaveBeenCalledTimes(1)
		expect(toast.error).not.toHaveBeenCalled()
	})

	it('says so when the undo fails', async () => {
		showUndoToast({
			message: 'm',
			undoLabel: 'Undo',
			failedMessage: 'Could not undo',
			onUndo: () => Promise.reject(new Error('down')),
		})
		lastOptions().action.onClick()
		await vi.waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith('Could not undo'),
		)
		expect(toast.success).not.toHaveBeenCalled()
	})

	it('treats a synchronous throw like a failed undo', async () => {
		showUndoToast({
			message: 'm',
			undoLabel: 'Undo',
			failedMessage: 'Could not undo',
			onUndo: () => {
				throw new Error('boom')
			},
		})
		lastOptions().action.onClick()
		await vi.waitFor(() => expect(toast.error).toHaveBeenCalled())
	})
})
