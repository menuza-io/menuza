import { describe, expect, it, vi } from 'vitest'
import {
	armStaffAlarm,
	type AlarmStorage,
	handleStaffAlarm,
	isStaffActivityPath,
	STAFF_ALARM_FAILURES_KEY,
	STAFF_ALARM_INTERVAL_MS,
	STAFF_ALARM_MAX_FAILURES,
	STAFF_ALARM_ORG_KEY,
} from './staff-alarm.ts'

function fakeStorage(initial: Record<string, unknown> = {}) {
	const kv = new Map<string, unknown>(Object.entries(initial))
	const state = { alarm: null as number | null }
	const storage: AlarmStorage = {
		getAlarm: async () => state.alarm,
		setAlarm: async (at) => {
			state.alarm = at
		},
		get: async <T>(key: string) => kv.get(key) as T | undefined,
		put: async <T>(key: string, value: T) => {
			kv.set(key, value)
		},
		delete: async (key) => kv.delete(key),
	}
	return { storage, kv, state }
}

const NOW = 1_800_000_000_000

describe('which requests show staffing is in use', () => {
	it.each([
		['/kiosk/punch', true],
		['/kiosk/config', true],
		['/operator/staff', true],
		['/operator/staff/export', true],
		['/operator/timeclock/timesheets', true],
		['/operator/timeclock', true],
		['/operator/schedule', true],
		['/operator/schedule/publish', true],
		['/operator/labor/summary', true],
		['/operator/hiring', true],
		['/operator/hiring/applications', true],
		['/operator/hiringx', false],
		['/careers/apply', true],
		['/careersx/apply', false],
		['/operator/laborers', false],
		['/operator/schedulefoo', false],
		['/api/staff/tick', true],
		['/operator/orders', false],
		['/operator/staffing-fake', false],
		['/shop/menu', false],
		['/auth/me', false],
		['/health', false],
	])('%s -> %s', (pathname, expected) => {
		expect(isStaffActivityPath(pathname)).toBe(expected)
	})
})

describe('arming the alarm', () => {
	it('arms one interval ahead and remembers the organization', async () => {
		const { storage, kv, state } = fakeStorage()
		expect(await armStaffAlarm(storage, 'org_1', NOW)).toBe('armed')
		expect(state.alarm).toBe(NOW + STAFF_ALARM_INTERVAL_MS)
		expect(kv.get(STAFF_ALARM_ORG_KEY)).toBe('org_1')
	})

	it('never pushes back an alarm that is already pending', async () => {
		const { storage, state } = fakeStorage()
		await armStaffAlarm(storage, 'org_1', NOW)
		const first = state.alarm
		// A busy kiosk: a request every few seconds for a minute.
		for (let i = 1; i <= 12; i++) {
			expect(await armStaffAlarm(storage, 'org_1', NOW + i * 5_000)).toBe(
				'already_armed',
			)
		}
		expect(state.alarm).toBe(first)
	})

	it('re-arms when the pending alarm is long past (a lost alarm)', async () => {
		const { storage, state } = fakeStorage()
		state.alarm = NOW - 3 * STAFF_ALARM_INTERVAL_MS
		expect(await armStaffAlarm(storage, 'org_1', NOW)).toBe('armed')
		expect(state.alarm).toBe(NOW + STAFF_ALARM_INTERVAL_MS)
	})
})

describe('when the alarm fires', () => {
	it('does nothing for an object that was never armed', async () => {
		const { storage } = fakeStorage()
		const runTick = vi.fn()
		expect(await handleStaffAlarm({ storage, now: NOW, runTick })).toEqual({
			status: 'no_org',
		})
		expect(runTick).not.toHaveBeenCalled()
	})

	it('runs the tick for the remembered organization and re-arms while there is work', async () => {
		const { storage, state } = fakeStorage({ [STAFF_ALARM_ORG_KEY]: 'org_1' })
		const runTick = vi.fn(async () => ({ needsFollowUp: true }))
		const outcome = await handleStaffAlarm({ storage, now: NOW, runTick })
		expect(runTick).toHaveBeenCalledWith('org_1')
		expect(outcome).toEqual({ status: 'ran', rearmed: true })
		expect(state.alarm).toBe(NOW + STAFF_ALARM_INTERVAL_MS)
	})

	it('goes quiet when there is nothing left to watch', async () => {
		const { storage, state } = fakeStorage({ [STAFF_ALARM_ORG_KEY]: 'org_1' })
		const outcome = await handleStaffAlarm({
			storage,
			now: NOW,
			runTick: async () => ({ needsFollowUp: false }),
		})
		expect(outcome).toEqual({ status: 'ran', rearmed: false })
		expect(state.alarm).toBeNull()
	})

	it('survives a failing tick, re-arming a bounded number of times', async () => {
		const { storage, state, kv } = fakeStorage({
			[STAFF_ALARM_ORG_KEY]: 'org_1',
		})
		const runTick = vi.fn(async () => {
			throw new Error('database is locked')
		})
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
		for (let i = 1; i < STAFF_ALARM_MAX_FAILURES; i++) {
			const outcome = await handleStaffAlarm({ storage, now: NOW + i, runTick })
			expect(outcome).toEqual({ status: 'failed', rearmed: true })
			expect(state.alarm).toBe(NOW + i + STAFF_ALARM_INTERVAL_MS)
		}
		state.alarm = null
		const last = await handleStaffAlarm({ storage, now: NOW + 99, runTick })
		expect(last).toEqual({ status: 'failed', rearmed: false })
		expect(state.alarm).toBeNull()
		expect(kv.get(STAFF_ALARM_FAILURES_KEY)).toBe(STAFF_ALARM_MAX_FAILURES)
		// Only the error name is logged: a message can quote a row.
		expect(JSON.stringify(spy.mock.calls)).not.toContain('database is locked')
		spy.mockRestore()
	})

	it('forgives earlier failures after a good run', async () => {
		const { storage, kv } = fakeStorage({
			[STAFF_ALARM_ORG_KEY]: 'org_1',
			[STAFF_ALARM_FAILURES_KEY]: 4,
		})
		await handleStaffAlarm({
			storage,
			now: NOW,
			runTick: async () => ({ needsFollowUp: false }),
		})
		expect(kv.has(STAFF_ALARM_FAILURES_KEY)).toBe(false)
	})
})
