import { describe, expect, it, vi } from 'vitest'
import {
	inventoryTickIntervalMs,
	startInventoryTickInterval,
} from './inventory-tick-interval.ts'

describe('inventory tick interval', () => {
	it('defaults to five minutes, floors at a minute and turns off at zero', () => {
		expect(inventoryTickIntervalMs(undefined)).toBe(300_000)
		expect(inventoryTickIntervalMs('')).toBe(300_000)
		expect(inventoryTickIntervalMs('30')).toBe(60_000)
		expect(inventoryTickIntervalMs('600')).toBe(600_000)
		expect(inventoryTickIntervalMs('0')).toBeNull()
		expect(inventoryTickIntervalMs('-5')).toBeNull()
		expect(inventoryTickIntervalMs('soon')).toBeNull()
	})

	it('runs on the interval, never overlaps a slow pass, and survives a failure', async () => {
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
		const handle = startInventoryTickInterval({
			intervalMs: 1000,
			run,
			setIntervalFn: setIntervalFn as unknown as typeof setInterval,
		})
		expect(handle).not.toBeNull()
		tick()
		tick()
		expect(run).toHaveBeenCalledTimes(1)
		release()
		await new Promise((resolve) => setTimeout(resolve, 0))
		tick()
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(run).toHaveBeenCalledTimes(2)
		expect(errors).toHaveBeenCalledWith(
			'Inventory tick interval failed',
			'Error',
		)
		errors.mockRestore()
		expect(startInventoryTickInterval({ intervalMs: null })).toBeNull()
	})
})
