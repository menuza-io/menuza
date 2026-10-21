import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORG_ALARM_LEGACY_ORG_KEY, ORG_ALARM_ORG_KEY } from './org-alarm.ts'

const rsvTick = vi.hoisted(() => vi.fn())
const staffTick = vi.hoisted(() => vi.fn())
const appFetch = vi.hoisted(() => vi.fn())
const migrate = vi.hoisted(() => vi.fn(async () => {}))

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
vi.mock('drizzle-orm/durable-sqlite', () => ({ drizzle: () => ({}) }))
vi.mock('drizzle-orm/durable-sqlite/migrator', () => ({ migrate }))
vi.mock('../../workers/migrations.generated.ts', () => ({
	durableSqliteMigrations: {},
}))
vi.mock('../app.ts', () => ({
	createTenantApiApp: () => ({ fetch: appFetch }),
}))
vi.mock('../services/rsv-tick-service.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../services/rsv-tick-service.ts')>()),
	runReservationsTickForOrg: rsvTick,
}))
vi.mock('../services/staff-tick-service.ts', async (importOriginal) => ({
	...(await importOriginal<
		typeof import('../services/staff-tick-service.ts')
	>()),
	runStaffTickForOrg: staffTick,
}))

const { TenantOrg, TENANT_ORG_HEADER } =
	await import('../../workers/tenant-org.ts')

const ORG = 'clw9x0a12000008l00rsvorga'
const NOW = 1_700_000_000_000

function fakeCtx(initial: Record<string, unknown> = {}) {
	const kv = new Map<string, unknown>(Object.entries(initial))
	const state = { alarm: null as number | null }
	const order: string[] = []
	const storage = {
		getAlarm: async () => state.alarm,
		setAlarm: async (at: number) => {
			order.push('setAlarm')
			state.alarm = at
		},
		deleteAlarm: async () => {
			order.push('deleteAlarm')
			state.alarm = null
		},
		deleteAll: async () => {
			order.push('deleteAll')
			kv.clear()
		},
		get: async (key: string) => kv.get(key),
		put: async (key: string, value: unknown) => {
			kv.set(key, value)
		},
		delete: async (key: string) => kv.delete(key),
	}
	return { ctx: { storage }, kv, state, order }
}

function makeOrg(initial: Record<string, unknown> = {}) {
	const fake = fakeCtx(initial)
	const org = new TenantOrg(
		fake.ctx as never,
		{
			JWT_SECRET: 'j'.repeat(32),
			AUTH_HMAC_SECRET: 'h'.repeat(32),
			INTERNAL_COMMAND_TOKEN: 'i'.repeat(32),
			TENANT_OPERATOR_TOKEN: 'o'.repeat(32),
		} as never,
	)
	return { org, ...fake }
}

function req(path: string, orgId: string | null = ORG, method = 'GET') {
	return new Request(`https://api.test${path}`, {
		method,
		headers: orgId ? { [TENANT_ORG_HEADER]: orgId } : {},
	})
}

describe('TenantOrg alarm wiring', () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(NOW)
		rsvTick.mockReset()
		staffTick.mockReset()
		appFetch.mockReset()
		migrate.mockClear()
		appFetch.mockImplementation(async () => Response.json({ ok: true }))
		rsvTick.mockResolvedValue({ needsFollowUp: false, nextDueAt: null })
		staffTick.mockResolvedValue({ needsFollowUp: false, nextDueAt: null })
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	describe('fetch', () => {
		it('answers 400 without a valid org header and never reaches the app', async () => {
			for (const id of [null, '../bad', 'x y']) {
				const { org } = makeOrg()
				const res = await org.fetch(req('/reservations/config', id))
				expect(res.status).toBe(400)
				expect(appFetch).not.toHaveBeenCalled()
			}
		})

		it('arms the alarm at the reservations interval after a successful reservations request', async () => {
			const { org, state, kv } = makeOrg()
			const res = await org.fetch(req('/operator/reservations/book'))
			expect(res.status).toBe(200)
			expect(state.alarm).toBe(NOW + 2 * 60 * 1000)
			expect(kv.get(ORG_ALARM_ORG_KEY)).toBe(ORG)
		})

		it('does not arm for an unrelated request', async () => {
			const { org, state } = makeOrg()
			await org.fetch(req('/health'))
			expect(state.alarm).toBeNull()
		})

		it('does not arm when the request failed', async () => {
			appFetch.mockResolvedValue(Response.json({ error: 'x' }, { status: 500 }))
			const { org, state } = makeOrg()
			await org.fetch(req('/operator/reservations/book'))
			expect(state.alarm).toBeNull()
		})

		it('arms nothing after a reservations tick that reports no follow-up', async () => {
			appFetch.mockResolvedValue(
				Response.json({ result: { needsFollowUp: false, nextDueAt: null } }),
			)
			const { org, state } = makeOrg()
			await org.fetch(req('/api/reservations/tick', ORG, 'POST'))
			expect(state.alarm).toBeNull()
		})

		it('arms at nextDueAt (clamped) after a tick that reports a follow-up', async () => {
			appFetch.mockResolvedValue(
				Response.json({
					result: { needsFollowUp: true, nextDueAt: NOW + 10 * 60 * 1000 },
				}),
			)
			const { org, state } = makeOrg()
			await org.fetch(req('/api/reservations/tick', ORG, 'POST'))
			expect(state.alarm).toBe(NOW + 10 * 60 * 1000)
		})

		it('arms for a staff tick that reports a follow-up too', async () => {
			appFetch.mockResolvedValue(
				Response.json({
					result: { needsFollowUp: true, nextDueAt: NOW + 5 * 60 * 1000 },
				}),
			)
			const { org, state } = makeOrg()
			await org.fetch(req('/api/staff/tick', ORG, 'POST'))
			expect(state.alarm).toBe(NOW + 5 * 60 * 1000)
		})

		it('does not fail the request when the tick answer is not JSON', async () => {
			appFetch.mockResolvedValue(new Response('<html>', { status: 200 }))
			const { org, state } = makeOrg()
			const res = await org.fetch(req('/api/reservations/tick', ORG, 'POST'))
			expect(res.status).toBe(200)
			expect(state.alarm).toBeNull()
		})

		it('does not fail the request when arming throws, and logs only the error name', async () => {
			const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
			const { org, ctx } = makeOrg()
			ctx.storage.getAlarm = async () => {
				throw new TypeError('row 42 for jane@example.com')
			}
			const res = await org.fetch(req('/operator/reservations/book'))
			expect(res.status).toBe(200)
			expect(spy).toHaveBeenCalledWith('Org alarm arming failed', 'TypeError')
			expect(JSON.stringify(spy.mock.calls)).not.toContain('jane@example.com')
			spy.mockRestore()
		})

		it('hands back the app response body unread by the arming step', async () => {
			const { org } = makeOrg()
			const res = await org.fetch(req('/api/reservations/tick', ORG, 'POST'))
			expect(await res.json()).toEqual({ ok: true })
		})
	})

	describe('alarm', () => {
		it('does nothing when the object never recorded an organization', async () => {
			const { org } = makeOrg()
			await org.alarm()
			expect(rsvTick).not.toHaveBeenCalled()
			expect(staffTick).not.toHaveBeenCalled()
		})

		it('runs both registered modules for the stored organization with the current time', async () => {
			const { org } = makeOrg({ [ORG_ALARM_ORG_KEY]: ORG })
			await org.alarm()
			expect(rsvTick).toHaveBeenCalledTimes(1)
			expect(rsvTick).toHaveBeenCalledWith(ORG, {
				deps: { now: expect.any(Function) },
			})
			const deps = rsvTick.mock.calls[0]![1] as { deps: { now: () => number } }
			expect(deps.deps.now()).toBe(NOW)
			expect(staffTick).toHaveBeenCalledWith(ORG)
		})

		it('still reads an organization stored under the legacy staffing key', async () => {
			const { org } = makeOrg({ [ORG_ALARM_LEGACY_ORG_KEY]: ORG })
			await org.alarm()
			expect(rsvTick).toHaveBeenCalledWith(ORG, expect.anything())
		})

		it('re-arms at the earliest follow-up the modules asked for', async () => {
			rsvTick.mockResolvedValue({
				needsFollowUp: true,
				nextDueAt: NOW + 4 * 60 * 1000,
			})
			staffTick.mockResolvedValue({
				needsFollowUp: true,
				nextDueAt: NOW + 9 * 60 * 1000,
			})
			const { org, state } = makeOrg({ [ORG_ALARM_ORG_KEY]: ORG })
			await org.alarm()
			expect(state.alarm).toBe(NOW + 4 * 60 * 1000)
		})

		it('does not re-arm when nothing needs a follow-up', async () => {
			const { org, state } = makeOrg({ [ORG_ALARM_ORG_KEY]: ORG })
			await org.alarm()
			expect(state.alarm).toBeNull()
		})

		it('does not throw when a module fails, and still runs the other', async () => {
			const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
			rsvTick.mockRejectedValue(new Error('boom'))
			const { org, state } = makeOrg({ [ORG_ALARM_ORG_KEY]: ORG })
			await expect(org.alarm()).resolves.toBeUndefined()
			expect(staffTick).toHaveBeenCalled()
			expect(state.alarm).not.toBeNull()
			spy.mockRestore()
		})

		it('points the tenant database at this object, for this organization only, while the tick runs', async () => {
			const { getTenantDb } = await import('@repo/tenant-db')
			let seen: unknown
			rsvTick.mockImplementation(async (orgId: string) => {
				seen = await getTenantDb(orgId)
				await expect(getTenantDb('clw9x0a12000008l00rsvorgb')).rejects.toThrow(
					'Tenant DB org mismatch',
				)
				return { needsFollowUp: false, nextDueAt: null }
			})
			const { org } = makeOrg({ [ORG_ALARM_ORG_KEY]: ORG })
			await org.alarm()
			expect(seen).toBeDefined()
		})

		it('runs the schema migration before the tick', async () => {
			const { org } = makeOrg({ [ORG_ALARM_ORG_KEY]: ORG })
			await org.alarm()
			expect(migrate).toHaveBeenCalledTimes(1)
			expect(migrate.mock.invocationCallOrder[0]).toBeLessThan(
				rsvTick.mock.invocationCallOrder[0]!,
			)
		})
	})

	describe('deprovision', () => {
		it('cancels the pending alarm before deleting storage', async () => {
			const { org, order, state } = makeOrg()
			state.alarm = NOW + 1000
			await org.deprovision()
			expect(order).toEqual(['deleteAlarm', 'deleteAll'])
			expect(state.alarm).toBeNull()
		})
	})
})
