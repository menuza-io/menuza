import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeOrg, type TestOrg } from '../../tests/staff-harness.ts'
import {
	at,
	CHI,
	createClockHarness,
	LOC_1,
	LOC_2,
	ORG_A,
	scheduleFixture,
	type ClockHarness,
	type ScheduleFixture,
} from '../../tests/schedule-harness.ts'

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

const WEEK = '2026-03-02'

/** Regressions found in review of the schedule API. */
describe('schedule review regressions', () => {
	let h: ClockHarness
	let s: ScheduleFixture

	beforeEach(async () => {
		orgs.clear()
		orgs.set(ORG_A, makeOrg(ORG_A))
		facts.clear()
		facts.set(LOC_1, { name: 'Downtown', timeZone: CHI })
		facts.set(LOC_2, { name: 'Airport', timeZone: CHI })
		h = await createClockHarness([ORG_A])
		s = scheduleFixture(h)
		h.setClock(at('2026-03-02', '12:00'))
	})
	afterEach(async () => {
		await h.cleanup()
	})

	it('leaves no pending request behind when a manager-entered request cannot be applied', async () => {
		const a = await s.staff()
		const b = await s.staff()
		const shift = await s.shift({
			staffId: a.staffId,
			positionId: a.positionIds[0],
			date: WEEK,
		})
		expect((await s.publish(LOC_1, WEEK)).status).toBe(200)
		// A pending removal means the shift is about to go away.
		expect((await s.send('DELETE', `/shifts/${shift.id}`)).status).toBe(200)

		const refused = await s.send('POST', '/requests', {
			kind: 'cover',
			shiftId: shift.id,
			requesterStaffId: a.staffId,
			targetStaffId: b.staffId,
			submission: 'manager_entered',
		})
		expect(refused.status).toBe(409)

		const listed = await s.get('/requests')
		expect(listed.status).toBe(200)
		expect(listed.body).toEqual([])
	})

	it('refuses dates outside the supported range instead of building a corrupt week', async () => {
		for (const date of [
			'9999-12-31',
			'0100-01-01',
			'1999-12-31',
			'2100-01-01',
		]) {
			const create = await s.send('POST', '/shifts', {
				scopeId: LOC_1,
				dates: [date],
				startTime: '22:00',
				endTime: '02:00',
			})
			expect(create.status, date).toBe(400)
			const week = await s.get(`/week?scopeId=${LOC_1}&date=${date}`)
			expect(week.status, date).toBe(400)
		}
		const edge = await s.send('POST', '/shifts', {
			scopeId: LOC_1,
			dates: ['2099-12-31'],
			startTime: '22:00',
			endTime: '02:00',
		})
		expect(edge.status).toBe(201)
		const week = await s.get(`/week?scopeId=${LOC_1}&date=2099-12-31`)
		expect(week.status).toBe(200)
		expect(week.body.weekEnd).toBe('2100-01-03')
	})

	it('lets only an unrestricted token change the organization-wide settings', async () => {
		const scoped = await s.send(
			'PUT',
			'/settings',
			{ minRestMinutes: 0 },
			{ scopeIds: [LOC_1] },
		)
		expect(scoped.status).toBe(403)
		expect(scoped.body.error).toBe('unrestricted_scope_required')
		expect((await s.get('/settings')).body.minRestMinutes).toBe(480)

		const open = await s.send('PUT', '/settings', { minRestMinutes: 0 })
		expect(open.status).toBe(200)
	})
})
