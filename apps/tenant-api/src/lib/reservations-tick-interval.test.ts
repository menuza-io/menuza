import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	DEFAULT_RESERVATIONS_TICK_INTERVAL_SECONDS,
	MIN_RESERVATIONS_TICK_INTERVAL_SECONDS,
	reservationsTickIntervalMs,
	startReservationsTickInterval,
} from './reservations-tick-interval.ts'

const tenantIds = vi.hoisted(() => ({ list: vi.fn() }))
const tickRuns = vi.hoisted(() => ({ run: vi.fn() }))

vi.mock('@repo/tenant-db', async (importOriginal) => ({
	...(await importOriginal<typeof import('@repo/tenant-db')>()),
	listTenantOrgIds: tenantIds.list,
}))
vi.mock('../services/rsv-tick-service.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../services/rsv-tick-service.ts')>()),
	runReservationsTickForOrg: tickRuns.run,
}))

describe('reservations tick interval setting', () => {
	it('defaults to two minutes when unset or blank', () => {
		expect(reservationsTickIntervalMs(undefined)).toBe(
			DEFAULT_RESERVATIONS_TICK_INTERVAL_SECONDS * 1000,
		)
		expect(reservationsTickIntervalMs('')).toBe(120_000)
		expect(reservationsTickIntervalMs('   ')).toBe(120_000)
		expect(reservationsTickIntervalMs(null)).toBe(120_000)
	})

	it('turns off at zero or anything that is not a positive number', () => {
		for (const raw of ['0', '-5', 'abc', 'off', 0, -1, 'Infinity', NaN]) {
			expect(reservationsTickIntervalMs(raw)).toBeNull()
		}
	})

	it('never goes below the minimum, so a typo cannot hammer the node', () => {
		expect(reservationsTickIntervalMs('5')).toBe(
			MIN_RESERVATIONS_TICK_INTERVAL_SECONDS * 1000,
		)
		expect(reservationsTickIntervalMs(59)).toBe(60_000)
		expect(reservationsTickIntervalMs('60')).toBe(60_000)
		expect(reservationsTickIntervalMs('90')).toBe(90_000)
		expect(reservationsTickIntervalMs(300)).toBe(300_000)
	})
})

describe('in-process reservations tick interval', () => {
	beforeEach(() => {
		vi.useFakeTimers()
		tenantIds.list.mockReset()
		tickRuns.run.mockReset()
	})
	afterEach(() => {
		vi.useRealTimers()
		vi.unstubAllEnvs()
	})

	it('does not start when switched off', () => {
		const setIntervalFn = vi.fn()
		expect(
			startReservationsTickInterval({
				intervalMs: null,
				run: vi.fn(),
				setIntervalFn: setIntervalFn as unknown as typeof setInterval,
			}),
		).toBeNull()
		expect(setIntervalFn).not.toHaveBeenCalled()
	})

	it('starts exactly one timer at the configured period and unrefs it', () => {
		const timer = { unref: vi.fn() }
		const setIntervalFn = vi.fn(() => timer)
		const handle = startReservationsTickInterval({
			intervalMs: 120_000,
			run: vi.fn(),
			setIntervalFn: setIntervalFn as unknown as typeof setInterval,
		})
		expect(handle).not.toBeNull()
		expect(setIntervalFn).toHaveBeenCalledTimes(1)
		expect(setIntervalFn.mock.calls[0]![1]).toBe(120_000)
		// A pending tick must never keep the Node process alive.
		expect(timer.unref).toHaveBeenCalledTimes(1)
	})

	it('tolerates a timer without unref', () => {
		const setIntervalFn = vi.fn(() => ({}))
		expect(() =>
			startReservationsTickInterval({
				intervalMs: 60_000,
				run: vi.fn(),
				setIntervalFn: setIntervalFn as unknown as typeof setInterval,
			}),
		).not.toThrow()
	})

	it('reads the period from RESERVATIONS_TICK_INTERVAL_SECONDS', () => {
		const setIntervalFn = vi.fn(() => ({ unref: vi.fn() }))
		vi.stubEnv('RESERVATIONS_TICK_INTERVAL_SECONDS', '240')
		startReservationsTickInterval({
			run: vi.fn(),
			setIntervalFn: setIntervalFn as unknown as typeof setInterval,
		})
		expect(setIntervalFn.mock.calls[0]![1]).toBe(240_000)
	})

	it('stays off when RESERVATIONS_TICK_INTERVAL_SECONDS is 0', () => {
		const setIntervalFn = vi.fn()
		vi.stubEnv('RESERVATIONS_TICK_INTERVAL_SECONDS', '0')
		expect(
			startReservationsTickInterval({
				run: vi.fn(),
				setIntervalFn: setIntervalFn as unknown as typeof setInterval,
			}),
		).toBeNull()
		expect(setIntervalFn).not.toHaveBeenCalled()
	})

	it('runs on each period and can be stopped', async () => {
		const run = vi.fn(async () => {})
		const handle = startReservationsTickInterval({
			intervalMs: 60_000,
			run,
		})!
		await vi.advanceTimersByTimeAsync(60_000)
		await vi.advanceTimersByTimeAsync(60_000)
		expect(run).toHaveBeenCalledTimes(2)
		handle.stop()
		await vi.advanceTimersByTimeAsync(180_000)
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
			if (calls === 2) throw new Error('boom row 42')
		})
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
		const handle = startReservationsTickInterval({ intervalMs: 60_000, run })!
		await vi.advanceTimersByTimeAsync(60_000)
		await vi.advanceTimersByTimeAsync(180_000)
		expect(run).toHaveBeenCalledTimes(1)
		release()
		await vi.advanceTimersByTimeAsync(60_000)
		await vi.advanceTimersByTimeAsync(60_000)
		expect(run).toHaveBeenCalledTimes(3)
		// Only the error name is logged: a message can quote a row.
		expect(JSON.stringify(spy.mock.calls)).not.toContain('boom row 42')
		handle.stop()
		spy.mockRestore()
	})

	it('by default ticks every organization on the node and swallows one failure', async () => {
		tenantIds.list.mockResolvedValue(['org_a', 'org_b', 'org_c'])
		tickRuns.run.mockImplementation(async (orgId: string) => {
			if (orgId === 'org_b') throw new Error('locked')
			return {
				orgId,
				status: 'ran',
				at: 0,
				tasks: [],
				messages: {
					sent: 0,
					failed: 0,
					retried: 0,
					suppressed: 0,
					dropped: 0,
					cancelled: 0,
					held: 0,
				},
				outbox: { groups: 0, delivered: 0, retried: 0, failed: 0 },
				needsFollowUp: false,
				nextDueAt: null,
			}
		})
		const handle = startReservationsTickInterval({ intervalMs: 60_000 })!
		await vi.advanceTimersByTimeAsync(60_000)
		expect(tickRuns.run.mock.calls.map((call) => call[0]).sort()).toEqual([
			'org_a',
			'org_b',
			'org_c',
		])
		handle.stop()
	})
})
