import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyUpdateIfIdle, setUpdater, updateWaiting } from './update.ts'

afterEach(() => applyUpdateIfIdle({ cartEmpty: true, dialogOpen: false }))

describe('applyUpdateIfIdle', () => {
	it('does nothing when no update is waiting', () => {
		expect(updateWaiting()).toBe(false)
		expect(applyUpdateIfIdle({ cartEmpty: true, dialogOpen: false })).toBe(
			false,
		)
	})

	it('never applies during a sale: an order on screen or a sheet open both hold it back', () => {
		const run = vi.fn()
		setUpdater(run)
		expect(applyUpdateIfIdle({ cartEmpty: false, dialogOpen: false })).toBe(
			false,
		)
		expect(applyUpdateIfIdle({ cartEmpty: true, dialogOpen: true })).toBe(false)
		expect(run).not.toHaveBeenCalled()
		expect(updateWaiting()).toBe(true)
	})

	it('applies once, as soon as the till is idle', () => {
		const run = vi.fn()
		setUpdater(run)
		expect(applyUpdateIfIdle({ cartEmpty: true, dialogOpen: false })).toBe(true)
		expect(applyUpdateIfIdle({ cartEmpty: true, dialogOpen: false })).toBe(
			false,
		)
		expect(run).toHaveBeenCalledTimes(1)
	})
})
