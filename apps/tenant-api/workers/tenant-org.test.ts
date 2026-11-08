import { beforeEach, describe, expect, it, vi } from 'vitest'

// The Durable Object runtime is not available under Vitest: a minimal base
// class and an in-memory storage stand in for it, and the migrator is a spy so
// the test can see when a database would be (re)built.
vi.mock('cloudflare:workers', () => ({
	DurableObject: class {
		ctx: unknown
		env: unknown
		constructor(ctx: unknown, env: unknown) {
			this.ctx = ctx
			this.env = env
		}
	},
}))
const migrate = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('drizzle-orm/durable-sqlite/migrator', () => ({ migrate }))
vi.mock('drizzle-orm/durable-sqlite', () => ({ drizzle: () => ({}) }))
vi.mock('./migrations.generated.ts', () => ({ durableSqliteMigrations: {} }))
const appFetch = vi.hoisted(() =>
	vi.fn(async () => Response.json({ ok: true })),
)
vi.mock('../src/app.ts', () => ({
	createTenantApiApp: () => ({ fetch: appFetch }),
}))
vi.mock('../src/lib/secrets.ts', () => ({ applyVarlockEnv: () => {} }))
const broadcasts = vi.hoisted(() => ({
	startBroadcastTickForOrg: vi.fn(),
	nextBroadcastWakeAt: vi.fn(async () => null as number | null),
}))
vi.mock('../src/services/broadcast-dispatch.ts', () => broadcasts)
const runStaffTickForOrg = vi.hoisted(() =>
	vi.fn(async () => ({ needsFollowUp: false })),
)
vi.mock('../src/services/staff-tick-service.ts', () => ({
	runStaffTickForOrg,
}))
// The other modules on the shared alarm have nothing to do here.
vi.mock('../src/services/rsv-tick-service.ts', () => ({
	runReservationsTickForOrg: vi.fn(async () => ({
		needsFollowUp: false,
		nextDueAt: null,
	})),
}))
vi.mock('../src/services/loyalty-tick-service.ts', () => ({
	runLoyaltyTickForOrg: vi.fn(async () => ({ needsFollowUp: false })),
}))

import { ORG_ALARM_ORG_KEY } from '../src/lib/org-alarm.ts'
import { STAFF_ALARM_ORG_KEY } from '../src/lib/staff-alarm.ts'
import { TENANT_ORG_HEADER, TenantOrg } from './tenant-org.ts'

function memoryStorage() {
	const values = new Map<string, unknown>()
	return {
		values,
		get: async (key: string) => values.get(key),
		put: async (key: string, value: unknown) => void values.set(key, value),
		delete: async (key: string) => values.delete(key),
		deleteAll: async () => values.clear(),
		deleteAlarm: async () => {},
		getAlarm: async () => null,
		setAlarm: async () => {},
		transaction: async (fn: () => unknown) => fn(),
	}
}

const ORG = 'clw9x0a12000008l00test79'

function orgRequest(path = '/auth/me') {
	return new Request(`https://tenant.example.test${path}`, {
		headers: { [TENANT_ORG_HEADER]: ORG },
	})
}

describe('TenantOrg after deprovision', () => {
	beforeEach(() => {
		migrate.mockClear()
		appFetch.mockClear()
	})

	it('does not rebuild a wiped database on a later request', async () => {
		const storage = memoryStorage()
		const object = new TenantOrg({ storage } as never, {} as never)
		await object.provision()
		expect(migrate).toHaveBeenCalledTimes(1)

		await object.deprovision()
		// A fresh instance, as after eviction, must also see the tombstone.
		for (const instance of [
			object,
			new TenantOrg({ storage } as never, {} as never),
		]) {
			const response = await instance.fetch(orgRequest())
			expect(response.status).toBe(404)
			expect(await response.json()).toEqual({ error: 'org_not_provisioned' })
		}
		expect(migrate).toHaveBeenCalledTimes(1)
		expect(appFetch).not.toHaveBeenCalled()
	})

	it('serves again once provision runs', async () => {
		const storage = memoryStorage()
		const object = new TenantOrg({ storage } as never, {} as never)
		await object.provision()
		await object.deprovision()
		await object.provision()

		const response = await object.fetch(orgRequest())
		expect(response.status).toBe(200)
		expect(migrate).toHaveBeenCalledTimes(2)
	})
})

describe('TenantOrg broadcasts on the alarm', () => {
	function alarmStorage() {
		const state = { alarm: null as number | null }
		return {
			state,
			storage: {
				...memoryStorage(),
				getAlarm: async () => state.alarm,
				setAlarm: async (at: number) => {
					state.alarm = at
				},
			},
		}
	}

	beforeEach(() => {
		broadcasts.startBroadcastTickForOrg.mockReset()
		broadcasts.nextBroadcastWakeAt.mockReset()
		runStaffTickForOrg.mockClear()
	})

	it('claims due broadcasts, sends them through waitUntil, and wakes for the next one', async () => {
		const { storage, state } = alarmStorage()
		await storage.put(STAFF_ALARM_ORG_KEY, ORG)
		const waitUntil = vi.fn()
		const nextAt = Date.now() + 30 * 60_000
		broadcasts.startBroadcastTickForOrg.mockImplementation(
			async (
				_orgId: string,
				options: { runDetached: (task: Promise<unknown>) => void },
			) => {
				options.runDetached(Promise.resolve())
				return { claimed: 1, nextAt }
			},
		)
		const object = new TenantOrg({ storage, waitUntil } as never, {} as never)

		await object.alarm()

		expect(broadcasts.startBroadcastTickForOrg).toHaveBeenCalledWith(
			ORG,
			expect.any(Object),
		)
		expect(runStaffTickForOrg).toHaveBeenCalledWith(ORG)
		expect(waitUntil).toHaveBeenCalledTimes(1)
		// Staffing needs nothing, but the scheduled broadcast does.
		expect(state.alarm).toBe(nextAt)
	})

	const scheduleCampaign = (object: TenantOrg) =>
		object.fetch(
			new Request('https://tenant.example.test/operator/marketing/campaigns', {
				method: 'POST',
				headers: { [TENANT_ORG_HEADER]: ORG },
			}),
		)

	it('arms the alarm for a campaign scheduled through the operator route', async () => {
		const { storage, state } = alarmStorage()
		const scheduledAt = Date.now() + 20 * 60_000
		broadcasts.nextBroadcastWakeAt.mockResolvedValue(scheduledAt)
		const object = new TenantOrg({ storage } as never, {} as never)

		const response = await scheduleCampaign(object)

		expect(response.status).toBe(200)
		expect(state.alarm).toBe(scheduledAt)
		expect(await storage.get(ORG_ALARM_ORG_KEY)).toBe(ORG)
	})

	it('leaves a campaign more than an hour out to the hourly staff tick', async () => {
		const { storage, state } = alarmStorage()
		broadcasts.nextBroadcastWakeAt.mockResolvedValue(
			Date.now() + 2 * 60 * 60_000,
		)
		const object = new TenantOrg({ storage } as never, {} as never)

		expect((await scheduleCampaign(object)).status).toBe(200)
		// Not woken every hour until then: the cron's tick arms it in time.
		expect(state.alarm).toBeNull()
	})
})
