import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	armForRequest,
	armOrgAlarm,
	clampAlarmTime,
	handleOrgAlarm,
	moduleForTickPath,
	moduleInterval,
	ORG_ALARM_DEFAULT_INTERVAL_MS,
	ORG_ALARM_FAILURES_KEY_PREFIX,
	ORG_ALARM_LEGACY_ORG_KEY,
	ORG_ALARM_MAX_DELAY_MS,
	ORG_ALARM_MAX_FAILURES,
	ORG_ALARM_MIN_DELAY_MS,
	ORG_ALARM_ORG_KEY,
	readAlarmOrgId,
	registerOrgTickModule,
	registeredOrgTickModules,
	resetOrgTickModulesForTest,
	type OrgAlarmStorage,
	type OrgTickModule,
	type OrgTickOutcome,
} from './org-alarm.ts'

const NOW = 1_800_000_000_000
const MINUTE = 60_000

function fakeStorage(initial: Record<string, unknown> = {}) {
	const kv = new Map<string, unknown>(Object.entries(initial))
	const state = { alarm: null as number | null }
	const calls = { setAlarm: [] as number[], put: [] as string[] }
	const storage: OrgAlarmStorage = {
		getAlarm: async () => state.alarm,
		setAlarm: async (at) => {
			calls.setAlarm.push(at)
			state.alarm = at
		},
		get: async <T>(key: string) => kv.get(key) as T | undefined,
		put: async <T>(key: string, value: T) => {
			calls.put.push(key)
			kv.set(key, value)
		},
		delete: async (key) => kv.delete(key),
	}
	return { storage, kv, state, calls }
}

function fakeModule(
	name: 'staff' | 'reservations',
	options: {
		run?: OrgTickModule['run']
		intervalMs?: number
		tickPath?: string
		activity?: (pathname: string) => boolean
	} = {},
): OrgTickModule & { run: ReturnType<typeof vi.fn> } {
	return {
		name,
		tickPath: options.tickPath ?? `/api/${name}/tick`,
		intervalMs: options.intervalMs,
		isActivityPath: options.activity ?? ((pathname) => pathname === `/${name}`),
		run: vi.fn(
			options.run ??
				(async (): Promise<OrgTickOutcome> => ({ needsFollowUp: false })),
		),
	}
}

describe('clamping the alarm time', () => {
	it('keeps a time inside the window as it is', () => {
		expect(clampAlarmTime(NOW, NOW + 10 * MINUTE)).toBe(NOW + 10 * MINUTE)
	})

	it('never schedules sooner than the minimum delay', () => {
		expect(clampAlarmTime(NOW, NOW - 5 * MINUTE)).toBe(
			NOW + ORG_ALARM_MIN_DELAY_MS,
		)
		expect(clampAlarmTime(NOW, NOW)).toBe(NOW + ORG_ALARM_MIN_DELAY_MS)
		expect(clampAlarmTime(NOW, NOW + 1)).toBe(NOW + ORG_ALARM_MIN_DELAY_MS)
		expect(ORG_ALARM_MIN_DELAY_MS).toBe(30_000)
	})

	it('never schedules later than the maximum delay', () => {
		expect(clampAlarmTime(NOW, NOW + 3 * 60 * MINUTE)).toBe(
			NOW + ORG_ALARM_MAX_DELAY_MS,
		)
		expect(ORG_ALARM_MAX_DELAY_MS).toBe(60 * MINUTE)
	})

	it('treats the exact bounds as valid', () => {
		expect(clampAlarmTime(NOW, NOW + ORG_ALARM_MIN_DELAY_MS)).toBe(
			NOW + ORG_ALARM_MIN_DELAY_MS,
		)
		expect(clampAlarmTime(NOW, NOW + ORG_ALARM_MAX_DELAY_MS)).toBe(
			NOW + ORG_ALARM_MAX_DELAY_MS,
		)
	})
})

describe('module registry', () => {
	beforeEach(() => resetOrgTickModulesForTest())
	afterEach(() => resetOrgTickModulesForTest())

	it('lists registered modules and replaces one registered twice by name', () => {
		expect(registeredOrgTickModules()).toEqual([])
		const first = fakeModule('staff')
		const second = fakeModule('reservations')
		registerOrgTickModule(first)
		registerOrgTickModule(second)
		expect(registeredOrgTickModules().map((m) => m.name)).toEqual([
			'staff',
			'reservations',
		])
		const replacement = fakeModule('staff')
		registerOrgTickModule(replacement)
		const listed = registeredOrgTickModules()
		expect(listed).toHaveLength(2)
		expect(listed.find((m) => m.name === 'staff')).toBe(replacement)
	})

	it('falls back to a five-minute interval for a module without one', () => {
		expect(moduleInterval({})).toBe(ORG_ALARM_DEFAULT_INTERVAL_MS)
		expect(ORG_ALARM_DEFAULT_INTERVAL_MS).toBe(5 * MINUTE)
		expect(moduleInterval({ intervalMs: 2 * MINUTE })).toBe(2 * MINUTE)
	})
})

describe('arming the alarm', () => {
	it('arms the default interval ahead and remembers the organization', async () => {
		const { storage, kv, state } = fakeStorage()
		expect(await armOrgAlarm(storage, 'org_1', NOW)).toBe('armed')
		expect(state.alarm).toBe(NOW + ORG_ALARM_DEFAULT_INTERVAL_MS)
		expect(kv.get(ORG_ALARM_ORG_KEY)).toBe('org_1')
	})

	it('writes the organization only when it changed', async () => {
		const { storage, calls } = fakeStorage({ [ORG_ALARM_ORG_KEY]: 'org_1' })
		await armOrgAlarm(storage, 'org_1', NOW)
		expect(calls.put).toEqual([])
		await armOrgAlarm(storage, 'org_2', NOW)
		expect(calls.put).toEqual([ORG_ALARM_ORG_KEY])
	})

	it('arms at the requested time inside the window', async () => {
		const { storage, state } = fakeStorage()
		await armOrgAlarm(storage, 'org_1', NOW, NOW + 2 * MINUTE)
		expect(state.alarm).toBe(NOW + 2 * MINUTE)
	})

	it('clamps a requested time that is too soon or too far', async () => {
		const soon = fakeStorage()
		await armOrgAlarm(soon.storage, 'org_1', NOW, NOW - MINUTE)
		expect(soon.state.alarm).toBe(NOW + ORG_ALARM_MIN_DELAY_MS)

		const far = fakeStorage()
		await armOrgAlarm(far.storage, 'org_1', NOW, NOW + 24 * 60 * MINUTE)
		expect(far.state.alarm).toBe(NOW + ORG_ALARM_MAX_DELAY_MS)
	})

	it('never pushes back an alarm that is already pending', async () => {
		const { storage, state, calls } = fakeStorage()
		await armOrgAlarm(storage, 'org_1', NOW, NOW + 2 * MINUTE)
		const first = state.alarm
		for (let i = 1; i <= 12; i++) {
			expect(
				await armOrgAlarm(
					storage,
					'org_1',
					NOW + i * 5_000,
					NOW + i * 5_000 + 5 * MINUTE,
				),
			).toBe('already_armed')
		}
		expect(state.alarm).toBe(first)
		expect(calls.setAlarm).toEqual([first])
	})

	it('treats an equal target as already armed', async () => {
		const { storage, calls } = fakeStorage()
		await armOrgAlarm(storage, 'org_1', NOW, NOW + 2 * MINUTE)
		expect(await armOrgAlarm(storage, 'org_1', NOW, NOW + 2 * MINUTE)).toBe(
			'already_armed',
		)
		expect(calls.setAlarm).toHaveLength(1)
	})

	it('moves a pending alarm earlier, never later', async () => {
		const { storage, state } = fakeStorage()
		await armOrgAlarm(storage, 'org_1', NOW, NOW + 10 * MINUTE)
		expect(await armOrgAlarm(storage, 'org_1', NOW, NOW + 2 * MINUTE)).toBe(
			'armed',
		)
		expect(state.alarm).toBe(NOW + 2 * MINUTE)
		expect(await armOrgAlarm(storage, 'org_1', NOW, NOW + 9 * MINUTE)).toBe(
			'already_armed',
		)
		expect(state.alarm).toBe(NOW + 2 * MINUTE)
	})

	it('keeps remembering the organization when it leaves a pending alarm alone', async () => {
		const { storage, kv } = fakeStorage()
		await armOrgAlarm(storage, 'org_1', NOW, NOW + MINUTE)
		kv.delete(ORG_ALARM_ORG_KEY)
		await armOrgAlarm(storage, 'org_1', NOW, NOW + 5 * MINUTE)
		expect(kv.get(ORG_ALARM_ORG_KEY)).toBe('org_1')
	})

	it('replaces a pending alarm that is long past (a lost alarm)', async () => {
		const { storage, state } = fakeStorage()
		state.alarm = NOW - 2 * ORG_ALARM_MAX_DELAY_MS
		expect(await armOrgAlarm(storage, 'org_1', NOW)).toBe('armed')
		expect(state.alarm).toBe(NOW + ORG_ALARM_DEFAULT_INTERVAL_MS)
	})

	it('leaves an alarm that is just overdue to fire', async () => {
		const { storage, state } = fakeStorage()
		state.alarm = NOW - MINUTE
		expect(await armOrgAlarm(storage, 'org_1', NOW)).toBe('already_armed')
		expect(state.alarm).toBe(NOW - MINUTE)
	})
})

describe('the remembered organization', () => {
	it('is read from the shared key', async () => {
		const { storage } = fakeStorage({ [ORG_ALARM_ORG_KEY]: 'org_new' })
		expect(await readAlarmOrgId(storage)).toBe('org_new')
	})

	it('falls back to the legacy staffing key', async () => {
		const { storage } = fakeStorage({ [ORG_ALARM_LEGACY_ORG_KEY]: 'org_old' })
		expect(ORG_ALARM_LEGACY_ORG_KEY).toBe('staffTickOrgId')
		expect(await readAlarmOrgId(storage)).toBe('org_old')
	})

	it('prefers the shared key over the legacy one', async () => {
		const { storage } = fakeStorage({
			[ORG_ALARM_ORG_KEY]: 'org_new',
			[ORG_ALARM_LEGACY_ORG_KEY]: 'org_old',
		})
		expect(await readAlarmOrgId(storage)).toBe('org_new')
	})

	it('is undefined for an object that was never armed', async () => {
		expect(await readAlarmOrgId(fakeStorage().storage)).toBeUndefined()
	})
})

describe('when the alarm fires', () => {
	let errorSpy: ReturnType<typeof vi.spyOn>
	beforeEach(() => {
		resetOrgTickModulesForTest()
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
	})
	afterEach(() => {
		errorSpy.mockRestore()
		resetOrgTickModulesForTest()
	})

	it('does nothing for an object that was never armed', async () => {
		const { storage, state } = fakeStorage()
		const staff = fakeModule('staff')
		expect(
			await handleOrgAlarm({ storage, now: NOW, modules: [staff] }),
		).toEqual({ status: 'no_org' })
		expect(staff.run).not.toHaveBeenCalled()
		expect(state.alarm).toBeNull()
	})

	it('runs every module for the remembered organization with the current time', async () => {
		const { storage } = fakeStorage({ [ORG_ALARM_ORG_KEY]: 'org_1' })
		const staff = fakeModule('staff')
		const reservations = fakeModule('reservations')
		const outcome = await handleOrgAlarm({
			storage,
			now: NOW,
			modules: [staff, reservations],
		})
		expect(staff.run).toHaveBeenCalledWith('org_1', NOW)
		expect(reservations.run).toHaveBeenCalledWith('org_1', NOW)
		expect(outcome).toEqual({
			status: 'ran',
			rearmedAt: null,
			modules: [
				{ module: 'staff', status: 'ran', needsFollowUp: false },
				{ module: 'reservations', status: 'ran', needsFollowUp: false },
			],
		})
	})

	it('uses the registry when no modules are passed', async () => {
		const { storage } = fakeStorage({ [ORG_ALARM_ORG_KEY]: 'org_1' })
		const staff = fakeModule('staff')
		const reservations = fakeModule('reservations')
		registerOrgTickModule(staff)
		registerOrgTickModule(reservations)
		await handleOrgAlarm({ storage, now: NOW })
		expect(staff.run).toHaveBeenCalledTimes(1)
		expect(reservations.run).toHaveBeenCalledTimes(1)
	})

	it('still honours an alarm armed under the legacy staffing key', async () => {
		const { storage } = fakeStorage({ [ORG_ALARM_LEGACY_ORG_KEY]: 'org_old' })
		const staff = fakeModule('staff')
		const reservations = fakeModule('reservations')
		const outcome = await handleOrgAlarm({
			storage,
			now: NOW,
			modules: [staff, reservations],
		})
		expect(outcome.status).toBe('ran')
		expect(staff.run).toHaveBeenCalledWith('org_old', NOW)
		expect(reservations.run).toHaveBeenCalledWith('org_old', NOW)
	})

	it('goes quiet when no module has anything left to watch', async () => {
		const { storage, state } = fakeStorage({ [ORG_ALARM_ORG_KEY]: 'org_1' })
		const outcome = await handleOrgAlarm({
			storage,
			now: NOW,
			modules: [fakeModule('staff'), fakeModule('reservations')],
		})
		expect(outcome).toMatchObject({ status: 'ran', rearmedAt: null })
		expect(state.alarm).toBeNull()
	})

	it('re-arms a module that asked for a follow-up at its own interval', async () => {
		const { storage, state } = fakeStorage({ [ORG_ALARM_ORG_KEY]: 'org_1' })
		const staff = fakeModule('staff', {
			intervalMs: 5 * MINUTE,
			run: async () => ({ needsFollowUp: true }),
		})
		const outcome = await handleOrgAlarm({
			storage,
			now: NOW,
			modules: [staff],
		})
		expect(state.alarm).toBe(NOW + 5 * MINUTE)
		expect(outcome).toMatchObject({ rearmedAt: NOW + 5 * MINUTE })
	})

	it('falls back to the default interval for a module without one', async () => {
		const { storage, state } = fakeStorage({ [ORG_ALARM_ORG_KEY]: 'org_1' })
		await handleOrgAlarm({
			storage,
			now: NOW,
			modules: [
				fakeModule('staff', { run: async () => ({ needsFollowUp: true }) }),
			],
		})
		expect(state.alarm).toBe(NOW + ORG_ALARM_DEFAULT_INTERVAL_MS)
	})

	it('re-arms at the earliest follow-up of any module', async () => {
		const { storage, state } = fakeStorage({ [ORG_ALARM_ORG_KEY]: 'org_1' })
		const staff = fakeModule('staff', {
			intervalMs: 5 * MINUTE,
			run: async () => ({ needsFollowUp: true }),
		})
		const reservations = fakeModule('reservations', {
			intervalMs: 2 * MINUTE,
			run: async () => ({ needsFollowUp: true, nextDueAt: NOW + 3 * MINUTE }),
		})
		const outcome = await handleOrgAlarm({
			storage,
			now: NOW,
			modules: [staff, reservations],
		})
		expect(state.alarm).toBe(NOW + 3 * MINUTE)
		expect(outcome).toMatchObject({ rearmedAt: NOW + 3 * MINUTE })

		const reversed = fakeStorage({ [ORG_ALARM_ORG_KEY]: 'org_1' })
		await handleOrgAlarm({
			storage: reversed.storage,
			now: NOW,
			modules: [reservations, staff],
		})
		expect(reversed.state.alarm).toBe(NOW + 3 * MINUTE)
	})

	it('ignores the due time of a module that needs no follow-up', async () => {
		const { storage, state } = fakeStorage({ [ORG_ALARM_ORG_KEY]: 'org_1' })
		const reservations = fakeModule('reservations', {
			run: async () => ({ needsFollowUp: false, nextDueAt: NOW + MINUTE }),
		})
		await handleOrgAlarm({ storage, now: NOW, modules: [reservations] })
		expect(state.alarm).toBeNull()
	})

	it('clamps a follow-up that is due already or far away', async () => {
		const soon = fakeStorage({ [ORG_ALARM_ORG_KEY]: 'org_1' })
		await handleOrgAlarm({
			storage: soon.storage,
			now: NOW,
			modules: [
				fakeModule('reservations', {
					run: async () => ({ needsFollowUp: true, nextDueAt: NOW - MINUTE }),
				}),
			],
		})
		expect(soon.state.alarm).toBe(NOW + ORG_ALARM_MIN_DELAY_MS)

		const far = fakeStorage({ [ORG_ALARM_ORG_KEY]: 'org_1' })
		await handleOrgAlarm({
			storage: far.storage,
			now: NOW,
			modules: [
				fakeModule('reservations', {
					run: async () => ({
						needsFollowUp: true,
						nextDueAt: NOW + 10 * 60 * MINUTE,
					}),
				}),
			],
		})
		expect(far.state.alarm).toBe(NOW + ORG_ALARM_MAX_DELAY_MS)
	})

	it('treats a null due time as "use the module interval"', async () => {
		const { storage, state } = fakeStorage({ [ORG_ALARM_ORG_KEY]: 'org_1' })
		await handleOrgAlarm({
			storage,
			now: NOW,
			modules: [
				fakeModule('reservations', {
					intervalMs: 2 * MINUTE,
					run: async () => ({ needsFollowUp: true, nextDueAt: null }),
				}),
			],
		})
		expect(state.alarm).toBe(NOW + 2 * MINUTE)
	})

	it('sets the alarm once even when several modules want one', async () => {
		const { storage, calls } = fakeStorage({ [ORG_ALARM_ORG_KEY]: 'org_1' })
		const wants = async () => ({ needsFollowUp: true })
		await handleOrgAlarm({
			storage,
			now: NOW,
			modules: [
				fakeModule('staff', { run: wants }),
				fakeModule('reservations', { run: wants }),
			],
		})
		expect(calls.setAlarm).toHaveLength(1)
	})

	describe('a module that throws', () => {
		it('does not stop the other modules or propagate', async () => {
			const { storage } = fakeStorage({ [ORG_ALARM_ORG_KEY]: 'org_1' })
			const staff = fakeModule('staff', {
				run: async () => {
					throw new Error('database is locked')
				},
			})
			const reservations = fakeModule('reservations', {
				run: async () => ({ needsFollowUp: false }),
			})
			const outcome = await handleOrgAlarm({
				storage,
				now: NOW,
				modules: [staff, reservations],
			})
			expect(reservations.run).toHaveBeenCalledTimes(1)
			expect(outcome).toMatchObject({
				status: 'ran',
				modules: [
					{ module: 'staff', status: 'failed', gaveUp: false },
					{ module: 'reservations', status: 'ran', needsFollowUp: false },
				],
			})
		})

		it('re-arms at its normal interval and counts the failure', async () => {
			const { storage, state, kv } = fakeStorage({
				[ORG_ALARM_ORG_KEY]: 'org_1',
			})
			const reservations = fakeModule('reservations', {
				intervalMs: 2 * MINUTE,
				run: async () => {
					throw new Error('boom')
				},
			})
			await handleOrgAlarm({ storage, now: NOW, modules: [reservations] })
			expect(state.alarm).toBe(NOW + 2 * MINUTE)
			expect(kv.get(`${ORG_ALARM_FAILURES_KEY_PREFIX}reservations`)).toBe(1)
		})

		it('keeps separate failure counts for each module', async () => {
			const { storage, kv } = fakeStorage({ [ORG_ALARM_ORG_KEY]: 'org_1' })
			const boom = async () => {
				throw new Error('boom')
			}
			await handleOrgAlarm({
				storage,
				now: NOW,
				modules: [
					fakeModule('staff', { run: boom }),
					fakeModule('reservations'),
				],
			})
			expect(kv.get(`${ORG_ALARM_FAILURES_KEY_PREFIX}staff`)).toBe(1)
			expect(kv.has(`${ORG_ALARM_FAILURES_KEY_PREFIX}reservations`)).toBe(false)
		})

		it('gives up after the maximum number of failures in a row', async () => {
			const { storage, state, kv } = fakeStorage({
				[ORG_ALARM_ORG_KEY]: 'org_1',
			})
			const reservations = fakeModule('reservations', {
				run: async () => {
					throw new Error('boom')
				},
			})
			for (let i = 1; i < ORG_ALARM_MAX_FAILURES; i++) {
				const outcome = await handleOrgAlarm({
					storage,
					now: NOW + i,
					modules: [reservations],
				})
				expect(outcome).toMatchObject({
					modules: [{ status: 'failed', gaveUp: false }],
				})
				expect(state.alarm).not.toBeNull()
			}
			state.alarm = null
			const last = await handleOrgAlarm({
				storage,
				now: NOW + 99,
				modules: [reservations],
			})
			expect(last).toMatchObject({
				rearmedAt: null,
				modules: [{ status: 'failed', gaveUp: true }],
			})
			expect(state.alarm).toBeNull()
			expect(kv.get(`${ORG_ALARM_FAILURES_KEY_PREFIX}reservations`)).toBe(
				ORG_ALARM_MAX_FAILURES,
			)
		})

		it('still re-arms for another module while one has given up', async () => {
			const { storage, state } = fakeStorage({
				[ORG_ALARM_ORG_KEY]: 'org_1',
				[`${ORG_ALARM_FAILURES_KEY_PREFIX}staff`]: ORG_ALARM_MAX_FAILURES - 1,
			})
			const staff = fakeModule('staff', {
				run: async () => {
					throw new Error('boom')
				},
			})
			const reservations = fakeModule('reservations', {
				intervalMs: 2 * MINUTE,
				run: async () => ({ needsFollowUp: true }),
			})
			const outcome = await handleOrgAlarm({
				storage,
				now: NOW,
				modules: [staff, reservations],
			})
			expect(outcome).toMatchObject({
				modules: [
					{ module: 'staff', status: 'failed', gaveUp: true },
					{ module: 'reservations', status: 'ran', needsFollowUp: true },
				],
			})
			expect(state.alarm).toBe(NOW + 2 * MINUTE)
		})

		it('forgives earlier failures after a good run', async () => {
			const { storage, kv } = fakeStorage({
				[ORG_ALARM_ORG_KEY]: 'org_1',
				[`${ORG_ALARM_FAILURES_KEY_PREFIX}reservations`]: 4,
			})
			await handleOrgAlarm({
				storage,
				now: NOW,
				modules: [fakeModule('reservations')],
			})
			expect(kv.has(`${ORG_ALARM_FAILURES_KEY_PREFIX}reservations`)).toBe(false)
		})

		it('logs only the error name, never its message', async () => {
			const { storage } = fakeStorage({ [ORG_ALARM_ORG_KEY]: 'org_1' })
			await handleOrgAlarm({
				storage,
				now: NOW,
				modules: [
					fakeModule('reservations', {
						run: async () => {
							throw new TypeError('guest Rana Khalid row 7')
						},
					}),
					fakeModule('staff', {
						run: async () => {
							throw 'a plain string with a name'
						},
					}),
				],
			})
			const logged = JSON.stringify(errorSpy.mock.calls)
			expect(logged).toContain('TypeError')
			expect(logged).toContain('unknown')
			expect(logged).not.toContain('Rana')
			expect(logged).not.toContain('plain string')
		})
	})
})

describe('which tick route is a module', () => {
	it('matches only the exact tick path', () => {
		const staff = fakeModule('staff')
		const reservations = fakeModule('reservations')
		const modules = [staff, reservations]
		expect(moduleForTickPath('/api/staff/tick', modules)).toBe(staff)
		expect(moduleForTickPath('/api/reservations/tick', modules)).toBe(
			reservations,
		)
		expect(moduleForTickPath('/api/reservations/tick/', modules)).toBeNull()
		expect(moduleForTickPath('/api/reservations', modules)).toBeNull()
		expect(moduleForTickPath('/health', modules)).toBeNull()
	})
})

describe('arming after a request', () => {
	function setup() {
		const staff = fakeModule('staff', {
			intervalMs: 5 * MINUTE,
			activity: (pathname) => pathname.startsWith('/kiosk/'),
		})
		const reservations = fakeModule('reservations', {
			intervalMs: 2 * MINUTE,
			activity: (pathname) => pathname.startsWith('/reservations'),
		})
		return { staff, reservations, modules: [staff, reservations] }
	}

	it('skips a request that no module cares about', async () => {
		const { modules } = setup()
		const { storage, state } = fakeStorage()
		expect(
			await armForRequest({
				storage,
				orgId: 'org_1',
				now: NOW,
				pathname: '/shop/menu',
				modules,
			}),
		).toBe('skipped')
		expect(state.alarm).toBeNull()
	})

	it('arms the module interval for an activity path', async () => {
		const { modules } = setup()
		const kiosk = fakeStorage()
		expect(
			await armForRequest({
				storage: kiosk.storage,
				orgId: 'org_1',
				now: NOW,
				pathname: '/kiosk/punch',
				modules,
			}),
		).toBe('armed')
		expect(kiosk.state.alarm).toBe(NOW + 5 * MINUTE)

		const booking = fakeStorage()
		await armForRequest({
			storage: booking.storage,
			orgId: 'org_1',
			now: NOW,
			pathname: '/reservations/holds',
			modules,
		})
		expect(booking.state.alarm).toBe(NOW + 2 * MINUTE)
		expect(booking.kv.get(ORG_ALARM_ORG_KEY)).toBe('org_1')
	})

	it('uses the shortest interval when several modules claim the path', async () => {
		const staff = fakeModule('staff', {
			intervalMs: 5 * MINUTE,
			activity: () => true,
		})
		const reservations = fakeModule('reservations', {
			intervalMs: 2 * MINUTE,
			activity: () => true,
		})
		const { storage, state } = fakeStorage()
		await armForRequest({
			storage,
			orgId: 'org_1',
			now: NOW,
			pathname: '/anything',
			modules: [staff, reservations],
		})
		expect(state.alarm).toBe(NOW + 2 * MINUTE)
	})

	it('does not push back a pending alarm for a later activity request', async () => {
		const { modules } = setup()
		const { storage, state } = fakeStorage()
		await armForRequest({
			storage,
			orgId: 'org_1',
			now: NOW,
			pathname: '/reservations/holds',
			modules,
		})
		const first = state.alarm
		expect(
			await armForRequest({
				storage,
				orgId: 'org_1',
				now: NOW + MINUTE,
				pathname: '/reservations/holds',
				modules,
			}),
		).toBe('already_armed')
		expect(state.alarm).toBe(first)
	})

	it('moves a pending alarm earlier when a faster module becomes active', async () => {
		const { modules } = setup()
		const { storage, state } = fakeStorage()
		await armForRequest({
			storage,
			orgId: 'org_1',
			now: NOW,
			pathname: '/kiosk/punch',
			modules,
		})
		expect(state.alarm).toBe(NOW + 5 * MINUTE)
		expect(
			await armForRequest({
				storage,
				orgId: 'org_1',
				now: NOW + MINUTE,
				pathname: '/reservations/holds',
				modules,
			}),
		).toBe('armed')
		expect(state.alarm).toBe(NOW + 3 * MINUTE)
	})

	describe('a module tick route', () => {
		it('does not arm when the tick reports nothing to watch', async () => {
			const { modules } = setup()
			const { storage, state } = fakeStorage()
			for (const tickResult of [
				null,
				undefined,
				{},
				{ needsFollowUp: false, nextDueAt: NOW + MINUTE },
			]) {
				expect(
					await armForRequest({
						storage,
						orgId: 'org_1',
						now: NOW,
						pathname: '/api/reservations/tick',
						tickResult,
						modules,
					}),
				).toBe('skipped')
			}
			expect(state.alarm).toBeNull()
		})

		it('arms at the reported due time when there is a follow-up', async () => {
			const { modules } = setup()
			const { storage, state, kv } = fakeStorage()
			expect(
				await armForRequest({
					storage,
					orgId: 'org_1',
					now: NOW,
					pathname: '/api/reservations/tick',
					tickResult: { needsFollowUp: true, nextDueAt: NOW + 7 * MINUTE },
					modules,
				}),
			).toBe('armed')
			expect(state.alarm).toBe(NOW + 7 * MINUTE)
			expect(kv.get(ORG_ALARM_ORG_KEY)).toBe('org_1')
		})

		it('arms the module interval when the follow-up has no due time', async () => {
			const { modules } = setup()
			const { storage, state } = fakeStorage()
			await armForRequest({
				storage,
				orgId: 'org_1',
				now: NOW,
				pathname: '/api/reservations/tick',
				tickResult: { needsFollowUp: true, nextDueAt: null },
				modules,
			})
			expect(state.alarm).toBe(NOW + 2 * MINUTE)
		})

		it('clamps the reported due time', async () => {
			const { modules } = setup()
			const { storage, state } = fakeStorage()
			await armForRequest({
				storage,
				orgId: 'org_1',
				now: NOW,
				pathname: '/api/staff/tick',
				tickResult: { needsFollowUp: true, nextDueAt: NOW - 10 * MINUTE },
				modules,
			})
			expect(state.alarm).toBe(NOW + ORG_ALARM_MIN_DELAY_MS)
		})

		it('only ever moves an existing alarm earlier', async () => {
			const { modules } = setup()
			const { storage, state } = fakeStorage()
			await armOrgAlarm(storage, 'org_1', NOW, NOW + 3 * MINUTE)
			expect(
				await armForRequest({
					storage,
					orgId: 'org_1',
					now: NOW,
					pathname: '/api/reservations/tick',
					tickResult: { needsFollowUp: true, nextDueAt: NOW + 20 * MINUTE },
					modules,
				}),
			).toBe('already_armed')
			expect(state.alarm).toBe(NOW + 3 * MINUTE)
		})
	})

	it('uses the registry when no modules are passed', async () => {
		resetOrgTickModulesForTest()
		const { staff, reservations } = setup()
		registerOrgTickModule(staff)
		registerOrgTickModule(reservations)
		const { storage, state } = fakeStorage()
		await armForRequest({
			storage,
			orgId: 'org_1',
			now: NOW,
			pathname: '/reservations/holds',
		})
		expect(state.alarm).toBe(NOW + 2 * MINUTE)
		resetOrgTickModulesForTest()
	})
})
