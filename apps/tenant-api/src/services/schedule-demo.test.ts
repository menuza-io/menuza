import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STAFFING_PERMISSION_LIST } from '@repo/staffing'
import { makeOrg, type TestOrg } from '../../tests/staff-harness.ts'
import {
	at,
	CHI,
	createClockHarness,
	LOC_1,
	ORG_A,
	scheduleFixture,
	type ClockHarness,
	type ScheduleFixture,
} from '../../tests/schedule-harness.ts'
import { scopeToScopes, type StaffAuth } from '../lib/staff-auth.ts'
import { seedDemoSchedule } from './schedule-demo.ts'

const facts = vi.hoisted(
	() => new Map<string, { name: string; timeZone: string }>(),
)
const orgs = vi.hoisted(() => new Map<string, TestOrg>())

vi.mock('../lib/scope-context.ts', () => ({
	getScopeFacts: vi.fn(
		async (_org: string, scope: string) => facts.get(scope) ?? null,
	),
	resetScopeContextCache: vi.fn(),
}))
vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	findActiveOrganizationById: vi.fn(async (id: string) => orgs.get(id) ?? null),
}))

describe('demo schedule', () => {
	let h: ClockHarness
	let s: ScheduleFixture

	beforeEach(async () => {
		orgs.clear()
		orgs.set(ORG_A, makeOrg(ORG_A))
		facts.clear()
		facts.set(LOC_1, { name: 'Downtown', timeZone: CHI })
		h = await createClockHarness([ORG_A])
		s = scheduleFixture(h)
		h.setClock(at('2026-03-04', '12:00'))
	})
	afterEach(async () => {
		await h.cleanup()
	})

	async function context() {
		const auth: StaffAuth = {
			orgId: ORG_A,
			userId: 'seed-script',
			scope: 'schedule',
			grants: STAFFING_PERMISSION_LIST,
			scopeIds: null,
			impersonated: false,
		}
		return {
			db: await h.db(ORG_A),
			auth,
			scope: scopeToScopes(auth),
			ipHash: null,
			now: h.clock.now,
		}
	}

	it('says so when there is nobody to schedule', async () => {
		const result = await seedDemoSchedule(await context(), {
			scopeId: LOC_1,
			timeZone: CHI,
		})
		expect(result).toEqual({ seeded: false, reason: 'no_staff' })
	})

	it('builds a published week with a pending edit and a drafted next week, once', async () => {
		for (let i = 0; i < 4; i++) await s.staff()
		const ctx = await context()
		const result = await seedDemoSchedule(ctx, {
			scopeId: LOC_1,
			timeZone: CHI,
		})
		expect(result).toMatchObject({
			seeded: true,
			weekStart: '2026-03-02',
			nextWeekStart: '2026-03-09',
			people: 4,
		})
		const week = await s.get(`/week?scopeId=${LOC_1}&date=2026-03-02`)
		expect(week.body.version).toBe(1)
		expect(week.body.unpublishedCount).toBe(1)
		expect(week.body.totals.openShifts).toBe(2)
		expect(week.body.shifts.length).toBe(22)
		const next = await s.get(`/week?scopeId=${LOC_1}&date=2026-03-09`)
		expect(next.body.shifts.length).toBe(22)
		expect(next.body.unpublishedCount).toBe(22)
		const timeOff = await s.get('/time-off')
		expect(timeOff.body.map((r: any) => r.status).sort()).toEqual([
			'approved',
			'pending',
		])

		const again = await seedDemoSchedule(ctx, {
			scopeId: LOC_1,
			timeZone: CHI,
		})
		expect(again).toEqual({ seeded: false, reason: 'shifts_exist' })
	})
})
