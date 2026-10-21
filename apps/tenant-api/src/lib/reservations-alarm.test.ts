import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	armForRequest,
	handleOrgAlarm,
	moduleForTickPath,
	ORG_ALARM_FAILURES_KEY_PREFIX,
	ORG_ALARM_LEGACY_ORG_KEY,
	ORG_ALARM_ORG_KEY,
	registeredOrgTickModules,
	registerOrgTickModule,
	resetOrgTickModulesForTest,
	type OrgAlarmStorage,
} from './org-alarm.ts'
import {
	createReservationsTickModule,
	isReservationsActivityPath,
	RESERVATIONS_ALARM_INTERVAL_MS,
} from './reservations-alarm.ts'
import {
	createStaffTickModule,
	STAFF_ALARM_INTERVAL_MS,
} from './staff-alarm.ts'

const NOW = 1_800_000_000_000
const MINUTE = 60_000

function fakeStorage(initial: Record<string, unknown> = {}) {
	const kv = new Map<string, unknown>(Object.entries(initial))
	const state = { alarm: null as number | null }
	const storage: OrgAlarmStorage = {
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

afterEach(() => resetOrgTickModulesForTest())

describe('which requests show reservations is in use', () => {
	it.each([
		['/reservations', true],
		['/reservations/config', true],
		['/reservations/holds', true],
		['/reservations/waitlist/join', true],
		['/operator/reservations', true],
		['/operator/reservations/book', true],
		['/operator/reservations/waitlist', true],
		['/api/reservations/tick', true],
		['/reservationsx', false],
		['/reservationsx/holds', false],
		['/operator/reservationsx', false],
		['/operator/reservationsx/book', false],
		['/api/reservations', false],
		['/api/reservations/other', false],
		['/internal/reservations/context-changed', false],
		['/api/staff/tick', false],
		['/operator/staff', false],
		['/kiosk/punch', false],
		['/shop/menu', false],
		['/health', false],
	])('%s -> %s', (pathname, expected) => {
		expect(isReservationsActivityPath(pathname)).toBe(expected)
	})
})

describe('the reservations tick module', () => {
	it('is named, routed and timed for reservations', () => {
		const module = createReservationsTickModule(async () => ({
			needsFollowUp: false,
			nextDueAt: null,
		}))
		expect(module.name).toBe('reservations')
		expect(module.tickPath).toBe('/api/reservations/tick')
		expect(module.intervalMs).toBe(RESERVATIONS_ALARM_INTERVAL_MS)
		expect(RESERVATIONS_ALARM_INTERVAL_MS).toBe(2 * MINUTE)
		expect(module.isActivityPath('/reservations/holds')).toBe(true)
		expect(module.isActivityPath('/kiosk/punch')).toBe(false)
	})

	it('passes the organization and time to the runner and returns only the follow-up fields', async () => {
		const run = vi.fn(async () => ({
			needsFollowUp: true,
			nextDueAt: NOW + 3 * MINUTE,
			orgId: 'org_1',
			guest: 'Rana',
		}))
		const module = createReservationsTickModule(run)
		const outcome = await module.run('org_1', NOW)
		expect(run).toHaveBeenCalledWith('org_1', NOW)
		expect(outcome).toEqual({
			needsFollowUp: true,
			nextDueAt: NOW + 3 * MINUTE,
		})
	})

	it('lets a runner failure reach the alarm, which owns the retry policy', async () => {
		const module = createReservationsTickModule(async () => {
			throw new Error('boom')
		})
		await expect(module.run('org_1', NOW)).rejects.toThrow('boom')
	})
})

describe('the staff and reservations modules share one alarm', () => {
	function register(
		staffRun = vi.fn(async (_orgId: string) => ({ needsFollowUp: false })),
		reservationsRun = vi.fn(async (_orgId: string, _now: number) => ({
			needsFollowUp: false,
			nextDueAt: null as number | null,
		})),
	) {
		registerOrgTickModule(createStaffTickModule(staffRun))
		registerOrgTickModule(createReservationsTickModule(reservationsRun))
		return { staffRun, reservationsRun }
	}

	it('registers both modules side by side', () => {
		register()
		expect(registeredOrgTickModules().map((m) => m.name)).toEqual([
			'staff',
			'reservations',
		])
		expect(moduleForTickPath('/api/staff/tick')?.name).toBe('staff')
		expect(moduleForTickPath('/api/reservations/tick')?.name).toBe(
			'reservations',
		)
	})

	it('runs both modules from one alarm', async () => {
		const { staffRun, reservationsRun } = register()
		const { storage } = fakeStorage({ [ORG_ALARM_ORG_KEY]: 'org_1' })
		const outcome = await handleOrgAlarm({ storage, now: NOW })
		expect(staffRun).toHaveBeenCalledWith('org_1')
		expect(reservationsRun).toHaveBeenCalledWith('org_1', NOW)
		expect(outcome).toMatchObject({
			status: 'ran',
			modules: [
				{ module: 'staff', status: 'ran' },
				{ module: 'reservations', status: 'ran' },
			],
		})
	})

	it('runs both modules for an object armed before alarms were shared', async () => {
		const { staffRun, reservationsRun } = register()
		const { storage } = fakeStorage({ [ORG_ALARM_LEGACY_ORG_KEY]: 'org_old' })
		await handleOrgAlarm({ storage, now: NOW })
		expect(staffRun).toHaveBeenCalledWith('org_old')
		expect(reservationsRun).toHaveBeenCalledWith('org_old', NOW)
	})

	it('re-arms at the reservations due time when it is sooner than the staff interval', async () => {
		register(
			vi.fn(async () => ({ needsFollowUp: true })),
			vi.fn(async () => ({
				needsFollowUp: true,
				nextDueAt: NOW + 90_000,
			})),
		)
		const { storage, state } = fakeStorage({ [ORG_ALARM_ORG_KEY]: 'org_1' })
		await handleOrgAlarm({ storage, now: NOW })
		expect(state.alarm).toBe(NOW + 90_000)
	})

	it('re-arms at the staff interval when only staffing has work', async () => {
		register(vi.fn(async () => ({ needsFollowUp: true })))
		const { storage, state } = fakeStorage({ [ORG_ALARM_ORG_KEY]: 'org_1' })
		await handleOrgAlarm({ storage, now: NOW })
		expect(state.alarm).toBe(NOW + STAFF_ALARM_INTERVAL_MS)
	})

	it('re-arms at the reservations interval when it asks for a follow-up with no due time', async () => {
		register(
			undefined,
			vi.fn(async () => ({ needsFollowUp: true, nextDueAt: null })),
		)
		const { storage, state } = fakeStorage({ [ORG_ALARM_ORG_KEY]: 'org_1' })
		await handleOrgAlarm({ storage, now: NOW })
		expect(state.alarm).toBe(NOW + RESERVATIONS_ALARM_INTERVAL_MS)
	})

	it('goes quiet when neither module has work', async () => {
		register()
		const { storage, state } = fakeStorage({ [ORG_ALARM_ORG_KEY]: 'org_1' })
		await handleOrgAlarm({ storage, now: NOW })
		expect(state.alarm).toBeNull()
	})

	it('keeps the staff tick running when reservations fails, and the other way round', async () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
		const staffRun = vi.fn(async () => ({ needsFollowUp: false }))
		const reservationsRun = vi.fn(async () => {
			throw new Error('locked')
		})
		register(staffRun, reservationsRun)
		const first = fakeStorage({ [ORG_ALARM_ORG_KEY]: 'org_1' })
		const outcome = await handleOrgAlarm({ storage: first.storage, now: NOW })
		expect(staffRun).toHaveBeenCalledTimes(1)
		expect(outcome).toMatchObject({
			modules: [
				{ module: 'staff', status: 'ran' },
				{ module: 'reservations', status: 'failed', gaveUp: false },
			],
		})
		expect(first.state.alarm).toBe(NOW + RESERVATIONS_ALARM_INTERVAL_MS)
		expect(first.kv.get(`${ORG_ALARM_FAILURES_KEY_PREFIX}reservations`)).toBe(1)

		resetOrgTickModulesForTest()
		const failingStaff = vi.fn(async () => {
			throw new Error('locked')
		})
		const okReservations = vi.fn(async () => ({
			needsFollowUp: false,
			nextDueAt: null,
		}))
		register(failingStaff, okReservations)
		const second = fakeStorage({ [ORG_ALARM_ORG_KEY]: 'org_1' })
		await handleOrgAlarm({ storage: second.storage, now: NOW })
		expect(okReservations).toHaveBeenCalledTimes(1)
		expect(second.state.alarm).toBe(NOW + STAFF_ALARM_INTERVAL_MS)
		spy.mockRestore()
	})

	describe('arming from requests', () => {
		it('arms the two-minute alarm for a booking request', async () => {
			register()
			const { storage, state, kv } = fakeStorage()
			expect(
				await armForRequest({
					storage,
					orgId: 'org_1',
					now: NOW,
					pathname: '/reservations/holds',
				}),
			).toBe('armed')
			expect(state.alarm).toBe(NOW + RESERVATIONS_ALARM_INTERVAL_MS)
			expect(kv.get(ORG_ALARM_ORG_KEY)).toBe('org_1')
		})

		it('arms the five-minute alarm for a kiosk request', async () => {
			register()
			const { storage, state } = fakeStorage()
			await armForRequest({
				storage,
				orgId: 'org_1',
				now: NOW,
				pathname: '/kiosk/punch',
			})
			expect(state.alarm).toBe(NOW + STAFF_ALARM_INTERVAL_MS)
		})

		it('lets a booking request pull a staff-armed alarm earlier', async () => {
			register()
			const { storage, state } = fakeStorage()
			await armForRequest({
				storage,
				orgId: 'org_1',
				now: NOW,
				pathname: '/kiosk/punch',
			})
			await armForRequest({
				storage,
				orgId: 'org_1',
				now: NOW + 30_000,
				pathname: '/operator/reservations/book',
			})
			expect(state.alarm).toBe(NOW + 30_000 + RESERVATIONS_ALARM_INTERVAL_MS)
		})

		it('does not arm for a reservations tick that finds nothing to watch', async () => {
			register()
			const { storage, state } = fakeStorage()
			expect(
				await armForRequest({
					storage,
					orgId: 'org_1',
					now: NOW,
					pathname: '/api/reservations/tick',
					tickResult: { needsFollowUp: false, nextDueAt: null },
				}),
			).toBe('skipped')
			expect(state.alarm).toBeNull()
		})

		it('arms at the due time a reservations tick reports', async () => {
			register()
			const { storage, state } = fakeStorage()
			await armForRequest({
				storage,
				orgId: 'org_1',
				now: NOW,
				pathname: '/api/reservations/tick',
				tickResult: { needsFollowUp: true, nextDueAt: NOW + 4 * MINUTE },
			})
			expect(state.alarm).toBe(NOW + 4 * MINUTE)
		})

		it('does not arm for a request outside every module', async () => {
			register()
			const { storage, state } = fakeStorage()
			expect(
				await armForRequest({
					storage,
					orgId: 'org_1',
					now: NOW,
					pathname: '/auth/me',
				}),
			).toBe('skipped')
			expect(state.alarm).toBeNull()
		})
	})
})
