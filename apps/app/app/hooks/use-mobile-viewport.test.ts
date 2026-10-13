// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMobileViewport } from './use-mobile-viewport.ts'

let matches = false
const listeners = new Set<() => void>()

function resizeTo({ mobile }: { mobile: boolean }) {
	matches = mobile
	listeners.forEach((listener) => listener())
}

function elapse(ms: number) {
	act(() => {
		vi.advanceTimersByTime(ms)
	})
}

beforeEach(() => {
	vi.useFakeTimers()
	matches = false
	listeners.clear()
	vi.stubGlobal(
		'matchMedia',
		vi.fn(() => ({
			get matches() {
				return matches
			},
			addEventListener: (ignoredType: string, listener: () => void) =>
				listeners.add(listener),
			removeEventListener: (ignoredType: string, listener: () => void) =>
				listeners.delete(listener),
		})),
	)
})

afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllGlobals()
})

describe('useMobileViewport', () => {
	it('reads the viewport once mounted', () => {
		matches = true
		const { result } = renderHook(() => useMobileViewport(100))
		expect(result.current).toBe(true)
	})

	it('applies a change only after the viewport settles', () => {
		const { result } = renderHook(() => useMobileViewport(100))
		expect(result.current).toBe(false)

		act(() => resizeTo({ mobile: true }))
		elapse(99)
		expect(result.current).toBe(false)

		elapse(1)
		expect(result.current).toBe(true)
	})

	it('ignores a brief trip across the breakpoint', () => {
		const { result } = renderHook(() => useMobileViewport(100))

		act(() => resizeTo({ mobile: true }))
		elapse(50)
		act(() => resizeTo({ mobile: false }))
		elapse(200)
		expect(result.current).toBe(false)
	})

	it('stops listening on unmount', () => {
		const { unmount } = renderHook(() => useMobileViewport(100))
		expect(listeners.size).toBe(1)
		unmount()
		expect(listeners.size).toBe(0)
	})
})
