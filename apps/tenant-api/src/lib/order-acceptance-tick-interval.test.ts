import { describe, expect, it, vi } from 'vitest'
import {
	orderAcceptanceTickIntervalMs,
	startOrderAcceptanceTickInterval,
} from './order-acceptance-tick-interval.ts'
import {
	orderMessagesTickIntervalMs,
	startOrderMessagesTickInterval,
} from './order-messages-tick-interval.ts'

describe('order acceptance tick interval', () => {
	it('defaults to a minute, floors at 30 seconds and can never be turned off', () => {
		expect(orderAcceptanceTickIntervalMs(undefined)).toBe(60_000)
		expect(orderAcceptanceTickIntervalMs('')).toBe(60_000)
		expect(orderAcceptanceTickIntervalMs('10')).toBe(30_000)
		expect(orderAcceptanceTickIntervalMs('45')).toBe(45_000)
		// Zero, negative and unreadable values mean the default, not off.
		expect(orderAcceptanceTickIntervalMs('0')).toBe(60_000)
		expect(orderAcceptanceTickIntervalMs('-5')).toBe(60_000)
		expect(orderAcceptanceTickIntervalMs('soon')).toBe(60_000)
	})

	it('keeps running when message retries are switched off', () => {
		vi.stubEnv('ORDER_MESSAGES_TICK_INTERVAL_SECONDS', '0')
		vi.stubEnv('ORDER_ACCEPTANCE_TICK_INTERVAL_SECONDS', '')
		try {
			const setIntervalFn = vi.fn(
				() => ({ unref() {} }) as unknown as ReturnType<typeof setInterval>,
			)
			// The messages interval is off with `0`...
			expect(
				startOrderMessagesTickInterval({
					setIntervalFn: setIntervalFn as unknown as typeof setInterval,
				}),
			).toBeNull()
			expect(setIntervalFn).not.toHaveBeenCalled()
			expect(orderMessagesTickIntervalMs('0')).toBeNull()
			// ...and the acceptance interval is still armed, once a minute.
			const handle = startOrderAcceptanceTickInterval({
				setIntervalFn: setIntervalFn as unknown as typeof setInterval,
			})
			expect(handle).not.toBeNull()
			expect(setIntervalFn).toHaveBeenCalledTimes(1)
			expect(setIntervalFn).toHaveBeenCalledWith(expect.any(Function), 60_000)
		} finally {
			vi.unstubAllEnvs()
		}
	})

	it('never overlaps a slow pass and survives a failure', async () => {
		let tick: () => void = () => {}
		const setIntervalFn = vi.fn((fn: () => void) => {
			tick = fn
			return { unref() {} } as unknown as ReturnType<typeof setInterval>
		})
		let release: () => void = () => {}
		const run = vi
			.fn()
			.mockImplementationOnce(
				() => new Promise<void>((resolve) => (release = resolve)),
			)
			.mockRejectedValueOnce(new Error('boom'))
			.mockResolvedValue(undefined)
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
		startOrderAcceptanceTickInterval({
			intervalMs: 1000,
			run,
			setIntervalFn: setIntervalFn as unknown as typeof setInterval,
		})
		tick()
		tick()
		expect(run).toHaveBeenCalledTimes(1)
		release()
		await new Promise((resolve) => setTimeout(resolve, 0))
		tick()
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(run).toHaveBeenCalledTimes(2)
		expect(errors).toHaveBeenCalledWith(
			'Order acceptance tick interval failed',
			'Error',
		)
		errors.mockRestore()
	})
})
