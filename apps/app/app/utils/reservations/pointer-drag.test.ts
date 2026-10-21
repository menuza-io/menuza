import { describe, expect, it, vi } from 'vitest'
import { trackPointerDrag } from './pointer-drag.ts'

function fakeWindow() {
	const listeners = new Map<string, Set<(event: unknown) => void>>()
	return {
		listeners,
		addEventListener(type: string, fn: (event: unknown) => void) {
			listeners.set(type, (listeners.get(type) ?? new Set()).add(fn))
		},
		removeEventListener(type: string, fn: (event: unknown) => void) {
			listeners.get(type)?.delete(fn)
		},
		fire(type: string, event: unknown = {}) {
			for (const fn of [...(listeners.get(type) ?? [])]) fn(event)
		},
		count() {
			return [...listeners.values()].reduce((n, set) => n + set.size, 0)
		},
	}
}

const handlers = () => ({ move: vi.fn(), up: vi.fn(), cancel: vi.fn() })

describe('trackPointerDrag', () => {
	it('moves, then releases and removes every listener', () => {
		const win = fakeWindow()
		const h = handlers()
		trackPointerDrag(win as never, h)
		expect(win.count()).toBe(3)
		win.fire('pointermove')
		win.fire('pointerup')
		expect(h.move).toHaveBeenCalledTimes(1)
		expect(h.up).toHaveBeenCalledTimes(1)
		expect(win.count()).toBe(0)
	})

	it('a cancelled pointer cleans up and commits nothing', () => {
		const win = fakeWindow()
		const h = handlers()
		trackPointerDrag(win as never, h)
		win.fire('pointercancel')
		expect(h.cancel).toHaveBeenCalledTimes(1)
		expect(h.up).not.toHaveBeenCalled()
		expect(win.count()).toBe(0)
		win.fire('pointermove')
		expect(h.move).not.toHaveBeenCalled()
	})

	it('detach (unmount mid-drag) removes everything and is idempotent', () => {
		const win = fakeWindow()
		const h = handlers()
		const detach = trackPointerDrag(win as never, h)
		detach()
		detach()
		expect(win.count()).toBe(0)
		win.fire('pointerup')
		expect(h.up).not.toHaveBeenCalled()
	})
})
