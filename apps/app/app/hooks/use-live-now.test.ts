/** @vitest-environment jsdom */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLiveNow } from './use-live-now.ts'

describe('useLiveNow', () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it('computes businessDate, hhmm, and localStartMin in the location timezone and ticks without network requests', () => {
		// 2026-04-20T22:00:00Z -> America/New_York (EDT, UTC-4) is 18:00 (1080m)
		// Asia/Riyadh (UTC+3) is 2026-04-21 01:00 (60m)
		vi.setSystemTime(new Date('2026-04-20T22:00:00.000Z'))
		const fetchSpy = vi.spyOn(globalThis, 'fetch')

		const { result: nyResult } = renderHook(() =>
			useLiveNow({ timeZone: 'America/New_York', intervalMs: 30_000 }),
		)
		expect(nyResult.current.businessDate).toBe('2026-04-20')
		expect(nyResult.current.hhmm).toBe('18:00')
		expect(nyResult.current.localStartMin).toBe(18 * 60)

		const { result: ksaResult } = renderHook(() =>
			useLiveNow({ timeZone: 'Asia/Riyadh', intervalMs: 30_000 }),
		)
		// Default dayStartMin=240 (04:00 rollover): 01:00 is still 2026-04-20 business day (localStartMin=1500)
		expect(ksaResult.current.businessDate).toBe('2026-04-20')
		expect(ksaResult.current.hhmm).toBe('01:00')
		expect(ksaResult.current.clockMin).toBe(60)
		expect(ksaResult.current.localStartMin).toBe(1500)

		act(() => {
			vi.advanceTimersByTime(60_000)
		})

		expect(nyResult.current.hhmm).toBe('18:01')
		expect(nyResult.current.localStartMin).toBe(18 * 60 + 1)
		expect(fetchSpy).not.toHaveBeenCalled()
		fetchSpy.mockRestore()
	})
})
