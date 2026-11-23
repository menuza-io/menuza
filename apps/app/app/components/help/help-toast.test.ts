import { describe, expect, it, vi } from 'vitest'
import { installGetHelpOnErrorToasts } from './help-toast.ts'

describe('Get help on error toasts', () => {
	it('adds a Get help action to an error toast', () => {
		const error = vi.fn()
		const api = { error }
		const onClick = vi.fn()
		const restore = installGetHelpOnErrorToasts(
			() => ({ label: 'Get help', onClick }),
			api,
		)
		api.error('Could not save', { description: 'Try again' })
		expect(error).toHaveBeenCalledWith('Could not save', {
			description: 'Try again',
			action: { label: 'Get help', onClick },
		})
		restore()
		api.error('after')
		expect(error).toHaveBeenLastCalledWith('after')
	})

	it('keeps a toast that has its own action', () => {
		const error = vi.fn()
		const api = { error }
		installGetHelpOnErrorToasts(
			() => ({ label: 'Get help', onClick: vi.fn() }),
			api,
		)
		const own = { label: 'Retry', onClick: vi.fn() }
		api.error('Failed', { action: own })
		expect(error).toHaveBeenCalledWith('Failed', { action: own })
	})

	it('does not stack when installed twice', () => {
		const error = vi.fn()
		const api = { error }
		installGetHelpOnErrorToasts(() => ({ label: 'A', onClick: vi.fn() }), api)
		const second = vi.fn()
		installGetHelpOnErrorToasts(() => ({ label: 'B', onClick: second }), api)
		api.error('x')
		expect(error).toHaveBeenCalledTimes(1)
		expect(error.mock.calls[0]![1]).toMatchObject({ action: { label: 'B' } })
	})
})
