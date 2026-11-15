import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	recordServerClock,
	resetServerClock,
	serverNow,
} from './server-clock.ts'

afterEach(() => {
	resetServerClock()
	vi.useRealTimers()
})

describe('server clock', () => {
	it('is the local clock until a reading arrives', () => {
		vi.useFakeTimers().setSystemTime(1_000_000)
		expect(serverNow()).toBe(1_000_000)
	})

	it('measures the gap against the middle of the round trip', () => {
		// The PC is 5 minutes fast: it sent at 10_000 and heard back at 10_400
		// by its own clock; the server said 10_200 - 300_000.
		recordServerClock(10_200 - 300_000, 10_000, 10_400)
		vi.useFakeTimers().setSystemTime(20_000)
		expect(serverNow()).toBe(20_000 - 300_000)
	})

	it('ignores a reading that is not a number', () => {
		recordServerClock(1_000, 0, 0)
		vi.useFakeTimers().setSystemTime(5_000)
		recordServerClock(Number.NaN, 0, 0)
		expect(serverNow()).toBe(6_000)
	})
})
