import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	DEFAULT_TICK_INTERVAL_SECONDS,
	MIN_TICK_INTERVAL_SECONDS,
	startStaffTickInterval,
	tickIntervalMs,
} from './staff-tick-interval.ts'

describe('tick interval setting', () => {
	it('defaults to five minutes when unset or blank', () => {
		expect(tickIntervalMs(undefined)).toBe(DEFAULT_TICK_INTERVAL_SECONDS * 1000)
		expect(tickIntervalMs('')).toBe(300_000)
		expect(tickIntervalMs(null)).toBe(300_000)
	})

	it('turns off at zero or anything that is not a positive number', () => {
		for (const raw of ['0', '-5', 'abc', 'off', 0]) {
			expect(tickIntervalMs(raw)).toBeNull()
		}
	})

	it('never goes below the minimum, so a typo cannot hammer the App', () => {
		expect(tickIntervalMs('5')).toBe(MIN_TICK_INTERVAL_SECONDS * 1000)
		expect(tickIntervalMs('120')).toBe(120_000)
	})
})

describe('in-process tick interval', () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it('does not start when switched off', () => {
		expect(
			startStaffTickInterval({ intervalMs: null, run: vi.fn() }),
		).toBeNull()
	})

	it('runs on each period and can be stopped', async () => {
		const run = vi.fn(async () => {})
		const handle = startStaffTickInterval({ intervalMs: 60_000, run })!
		await vi.advanceTimersByTimeAsync(60_000)
		await vi.advanceTimersByTimeAsync(60_000)
		expect(run).toHaveBeenCalledTimes(2)
		handle.stop()
		await vi.advanceTimersByTimeAsync(120_000)
		expect(run).toHaveBeenCalledTimes(2)
	})

	it('never overlaps a slow pass, and keeps going after a failure', async () => {
		let release: () => void = () => {}
		let calls = 0
		const run = vi.fn(async () => {
			calls++
			if (calls === 1) {
				await new Promise<void>((resolve) => {
					release = resolve
				})
			}
			if (calls === 2) throw new Error('boom')
		})
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
		startStaffTickInterval({ intervalMs: 60_000, run })
		await vi.advanceTimersByTimeAsync(60_000) // pass 1 starts and hangs
		await vi.advanceTimersByTimeAsync(180_000) // three more periods: all skipped
		expect(run).toHaveBeenCalledTimes(1)
		release()
		await vi.advanceTimersByTimeAsync(60_000) // pass 2 fails
		await vi.advanceTimersByTimeAsync(60_000) // pass 3 still runs
		expect(run).toHaveBeenCalledTimes(3)
		spy.mockRestore()
	})
})
