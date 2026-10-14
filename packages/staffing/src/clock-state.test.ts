import { describe, expect, it } from 'vitest'
import {
	allowedClockEvents,
	CLOCK_EVENTS,
	CLOCK_STATES,
	checkOfflinePunchTime,
	deriveClockState,
	nextClockState,
	OFFLINE_PUNCH_MAX_AGE_MS,
} from './clock-state.ts'

describe('nextClockState', () => {
	it('walks the happy path', () => {
		expect(nextClockState('out', 'clock_in')).toBe('in')
		expect(nextClockState('in', 'break_start')).toBe('on_break')
		expect(nextClockState('on_break', 'break_end')).toBe('in')
		expect(nextClockState('in', 'clock_out')).toBe('out')
	})
	it('lets a person end the day straight from a break', () => {
		expect(nextClockState('on_break', 'clock_out')).toBe('out')
	})
	it('rejects every impossible transition', () => {
		const allowed = new Set([
			'out:clock_in',
			'in:break_start',
			'in:clock_out',
			'on_break:break_end',
			'on_break:clock_out',
		])
		for (const state of CLOCK_STATES) {
			for (const event of CLOCK_EVENTS) {
				const expected = allowed.has(`${state}:${event}`)
				expect(nextClockState(state, event) !== null).toBe(expected)
			}
		}
		expect(nextClockState('out', 'clock_out')).toBeNull()
		expect(nextClockState('in', 'clock_in')).toBeNull()
	})
	it('lists the allowed events per state', () => {
		expect(allowedClockEvents('out')).toEqual(['clock_in'])
		expect(allowedClockEvents('in').sort()).toEqual([
			'break_start',
			'clock_out',
		])
	})
})

describe('deriveClockState', () => {
	it('derives state from the open entry', () => {
		expect(deriveClockState(null)).toBe('out')
		expect(deriveClockState({ clockOutAt: 5, openBreak: false })).toBe('out')
		expect(deriveClockState({ clockOutAt: null, openBreak: false })).toBe('in')
		expect(deriveClockState({ clockOutAt: null, openBreak: true })).toBe(
			'on_break',
		)
	})
})

describe('checkOfflinePunchTime', () => {
	const server = Date.UTC(2026, 5, 10, 12, 0, 0)
	it('accepts a recent queued punch', () => {
		const v = checkOfflinePunchTime(server - 60 * 60_000, server)
		expect(v).toEqual({
			ok: true,
			effectiveAtMs: server - 60 * 60_000,
			flaggedSkew: false,
		})
	})
	it('rejects a punch in the future and clamps trivial drift', () => {
		expect(checkOfflinePunchTime(server + 10 * 60_000, server)).toEqual({
			ok: false,
			reason: 'in_future',
		})
		const drift = checkOfflinePunchTime(server + 30_000, server)
		expect(drift).toMatchObject({ ok: true, effectiveAtMs: server })
	})
	it('rejects a punch older than 12 hours but accepts exactly 12', () => {
		expect(
			checkOfflinePunchTime(server - OFFLINE_PUNCH_MAX_AGE_MS - 1, server),
		).toEqual({ ok: false, reason: 'too_old' })
		expect(
			checkOfflinePunchTime(server - OFFLINE_PUNCH_MAX_AGE_MS, server).ok,
		).toBe(true)
	})
	it('flags clock skew when the device clock is more than 5 minutes off', () => {
		const t = server - 60_000
		expect(checkOfflinePunchTime(t, server, server + 4 * 60_000)).toMatchObject(
			{ flaggedSkew: false },
		)
		expect(checkOfflinePunchTime(t, server, server + 6 * 60_000)).toMatchObject(
			{ flaggedSkew: true },
		)
		expect(checkOfflinePunchTime(t, server, server - 6 * 60_000)).toMatchObject(
			{ flaggedSkew: true },
		)
	})
	it('rejects non-finite times', () => {
		expect(checkOfflinePunchTime(Number.NaN, server).ok).toBe(false)
		expect(checkOfflinePunchTime(server, Infinity).ok).toBe(false)
	})
})
