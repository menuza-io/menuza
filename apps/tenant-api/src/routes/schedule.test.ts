import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	schedulePublications,
	scheduleWeeks,
	shifts,
	staffAuditLog,
} from '@repo/tenant-db'
import { makeOrg, type TestOrg } from '../../tests/staff-harness.ts'
import {
	at,
	CHI,
	createClockHarness,
	LOC_1,
	LOC_2,
	ORG_A,
	ORG_B,
	SCH_EDIT,
	SCH_LABOR,
	SCH_VIEW,
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

const WEEK = '2026-03-02' // a Monday

describe('/operator/schedule', () => {
	let h: ClockHarness
	let s: ScheduleFixture

	beforeEach(async () => {
		orgs.clear()
		orgs.set(ORG_A, makeOrg(ORG_A))
		orgs.set(ORG_B, makeOrg(ORG_B))
		facts.clear()
		facts.set(LOC_1, { name: 'Downtown', timeZone: CHI })
		facts.set(LOC_2, { name: 'Airport', timeZone: CHI })
		h = await createClockHarness([ORG_A, ORG_B])
		s = scheduleFixture(h)
		h.setClock(at('2026-03-02', '12:00'))
	})
	afterEach(async () => {
		await h.cleanup()
	})

	describe('access', () => {
		it('needs a token of the schedule scope', async () => {
			expect(
				(await s.get(`/week?scopeId=${LOC_1}&date=${WEEK}`, { token: null }))
					.status,
			).toBe(401)
			const wrongScope = await s.get(`/week?scopeId=${LOC_1}&date=${WEEK}`, {
				scope: 'timeclock',
			})
			expect(wrongScope.status).toBe(403)
			expect(wrongScope.body.error).toBe('Missing staff scope')
		})

		it('needs the schedule and roster grants to view, and the update grant to write', async () => {
			const noStaff = await s.get(`/week?scopeId=${LOC_1}&date=${WEEK}`, {
				grants: ['read:schedule:any'],
			})
			expect(noStaff.status).toBe(403)
			const viewOnly = await s.send(
				'POST',
				'/shifts',
				{
					scopeId: LOC_1,
					dates: [WEEK],
					startTime: '09:00',
					endTime: '17:00',
				},
				{ grants: SCH_VIEW },
			)
			expect(viewOnly.status).toBe(403)
			expect(viewOnly.body.required).toBe('update:schedule:any')
			const ok = await s.get(`/week?scopeId=${LOC_1}&date=${WEEK}`, {
				grants: SCH_VIEW,
			})
			expect(ok.status).toBe(200)
		})

		it('refuses writes from an impersonated session', async () => {
			const response = await s.send(
				'POST',
				'/shifts',
				{
					scopeId: LOC_1,
					dates: [WEEK],
					startTime: '09:00',
					endTime: '17:00',
				},
				{ grants: SCH_EDIT, impersonated: true },
			)
			expect(response.status).toBe(403)
		})
	})

	describe('week view', () => {
		it('snaps any date to the week start and lists the roster', async () => {
			const { staffId } = await s.staff({ firstName: 'Ana', lastName: 'Cook' })
			const week = await s.get(`/week?scopeId=${LOC_1}&date=2026-03-05`)
			expect(week.status).toBe(200)
			expect(week.body).toMatchObject({
				estimate: true,
				scopeId: LOC_1,
				timeZone: CHI,
				weekStart: WEEK,
				weekEnd: '2026-03-08',
				weekStartsOn: 1,
				version: 0,
				unpublishedCount: 0,
			})
			expect(week.body.dates).toHaveLength(7)
			expect(week.body.people.map((p: any) => p.id)).toEqual([staffId])
			expect(week.body.footers).toHaveLength(7)
			expect(week.body.totals).toMatchObject({ minutes: 0, openShifts: 0 })
		})

		it('uses a Sunday week start when the policy says so', async () => {
			await s.setPolicy(LOC_1, { weekStartsOn: 0 })
			const week = await s.get(`/week?scopeId=${LOC_1}&date=2026-03-05`)
			expect(week.body.weekStart).toBe('2026-03-01')
			expect(week.body.dates[0]).toBe('2026-03-01')
			expect(week.body.dates[6]).toBe('2026-03-07')
		})

		it('answers 404 for a scope outside the token and for a bad id', async () => {
			const out = await s.get(`/week?scopeId=${LOC_2}&date=${WEEK}`, {
				scopeIds: [LOC_1],
			})
			expect(out.status).toBe(404)
			const bad = await s.get(
				`/week?scopeId=${encodeURIComponent("a'; drop--")}&date=${WEEK}`,
			)
			expect(bad.status).toBe(404)
			const malformed = await s.get(`/week?scopeId=${LOC_1}&date=2026-13-45`)
			expect(malformed.status).toBe(400)
		})

		it('fails closed when the time zone cannot be found', async () => {
			facts.clear()
			const response = await s.get(`/week?scopeId=${LOC_1}&date=${WEEK}`)
			expect(response.status).toBe(409)
			expect(response.body.error).toBe('time_zone_unknown')
		})
	})

	describe('shifts', () => {
		it('creates a draft shift from local times', async () => {
			const { staffId, positionIds } = await s.staff()
			const view = await s.shift({
				staffId,
				positionId: positionIds[0],
				date: '2026-03-03',
				unpaidBreakMinutes: 30,
				notes: 'Prep',
			})
			expect(view).toMatchObject({
				scopeId: LOC_1,
				staffId,
				positionId: positionIds[0],
				startsAt: at('2026-03-03', '09:00'),
				endsAt: at('2026-03-03', '17:00'),
				localDate: '2026-03-03',
				timeZone: CHI,
				unpaidBreakMinutes: 30,
				paidMinutes: 450,
				notes: 'Prep',
				state: 'draft',
				published: null,
				version: 1,
				conflicts: [],
			})
		})

		it('applies one shift to several days at once', async () => {
			const { staffId } = await s.staff()
			const response = await s.send('POST', '/shifts', {
				scopeId: LOC_1,
				staffId,
				dates: ['2026-03-04', '2026-03-02', '2026-03-03'],
				startTime: '10:00',
				endTime: '14:00',
			})
			expect(response.status).toBe(201)
			expect(response.body.shifts.map((x: any) => x.localDate)).toEqual([
				'2026-03-02',
				'2026-03-03',
				'2026-03-04',
			])
		})

		it('treats an end before the start as the next day', async () => {
			const { staffId } = await s.staff()
			const view = await s.shift({
				staffId,
				date: '2026-03-02',
				start: '22:00',
				end: '02:00',
			})
			expect(view.endsAt).toBe(at('2026-03-03', '02:00'))
			expect(view.paidMinutes).toBe(240)
			expect(view.localDate).toBe('2026-03-02')
		})

		it('allows several shifts on one day (a split shift) without a warning', async () => {
			const { staffId } = await s.staff()
			await s.shift({
				staffId,
				date: '2026-03-02',
				start: '09:00',
				end: '13:00',
			})
			await s.shift({
				staffId,
				date: '2026-03-02',
				start: '17:00',
				end: '22:00',
			})
			const week = await s.get(`/week?scopeId=${LOC_1}&date=${WEEK}`)
			const mine = week.body.shifts.filter((x: any) => x.staffId === staffId)
			expect(mine).toHaveLength(2)
			expect(mine.flatMap((x: any) => x.conflicts)).toEqual([])
			expect(week.body.footers[0]).toMatchObject({ minutes: 540, headcount: 1 })
		})

		it('creates open shifts and counts them apart from people', async () => {
			await s.shift({ date: '2026-03-02', start: '08:00', end: '12:00' })
			const week = await s.get(`/week?scopeId=${LOC_1}&date=${WEEK}`)
			expect(week.body.footers[0]).toMatchObject({
				minutes: 0,
				headcount: 0,
				openShifts: 1,
				openMinutes: 240,
			})
			expect(week.body.totals).toMatchObject({
				openShifts: 1,
				openMinutes: 240,
			})
		})

		it('refuses impossible times with a stable code', async () => {
			const same = await s.send('POST', '/shifts', {
				scopeId: LOC_1,
				dates: [WEEK],
				startTime: '09:00',
				endTime: '09:00',
			})
			expect(same.status).toBe(422)
			expect(same.body).toMatchObject({
				error: 'invalid_shift_time',
				reason: 'zero_length',
			})
			const longBreak = await s.send('POST', '/shifts', {
				scopeId: LOC_1,
				dates: [WEEK],
				startTime: '09:00',
				endTime: '10:00',
				unpaidBreakMinutes: 90,
			})
			expect(longBreak.body.error).toBe('break_exceeds_shift')
		})

		it('refuses a person who is unknown, terminated, or a position that is unknown', async () => {
			const gone = await s.staff({ status: 'terminated' })
			const terminated = await s.send('POST', '/shifts', {
				scopeId: LOC_1,
				staffId: gone.staffId,
				dates: [WEEK],
				startTime: '09:00',
				endTime: '17:00',
			})
			expect(terminated.status).toBe(422)
			expect(terminated.body.error).toBe('staff_terminated')
			const unknown = await s.send('POST', '/shifts', {
				scopeId: LOC_1,
				staffId: 'nobody',
				dates: [WEEK],
				startTime: '09:00',
				endTime: '17:00',
			})
			expect(unknown.body.error).toBe('staff_not_found')
			const position = await s.send('POST', '/shifts', {
				scopeId: LOC_1,
				positionId: 'nothing',
				dates: [WEEK],
				startTime: '09:00',
				endTime: '17:00',
			})
			expect(position.body.error).toBe('position_not_found')
		})

		it('writes into the audit log without names, times or pay', async () => {
			const { staffId } = await s.staff()
			await s.shift({ staffId, date: WEEK })
			const db = await h.db(ORG_A)
			const rows = await db
				.select()
				.from(staffAuditLog)
				.where(eq(staffAuditLog.action, 'schedule.shift.created'))
			expect(rows).toHaveLength(1)
			expect(rows[0]).toMatchObject({ staffId, scopeId: LOC_1 })
			expect(JSON.stringify(rows[0]!.changes)).not.toMatch(/2000|09:00/)
		})
	})

	describe('draft and published', () => {
		it('counts drafts, publishes them, and bumps the week version', async () => {
			const { staffId } = await s.staff()
			await s.shift({ staffId, date: '2026-03-02' })
			await s.shift({ staffId, date: '2026-03-03' })
			let week = await s.get(`/week?scopeId=${LOC_1}&date=${WEEK}`)
			expect(week.body.unpublishedCount).toBe(2)
			expect(week.body.version).toBe(0)

			const published = await s.publish(LOC_1, WEEK)
			expect(published.status).toBe(200)
			expect(published.body.week).toEqual({ version: 1, unpublishedCount: 0 })
			expect(published.body.publication).toMatchObject({
				scopeId: LOC_1,
				weekStart: WEEK,
				version: 1,
				notifyMode: 'changed',
				summary: { created: 2, changed: 0, cancelled: 0, shifts: 2, people: 1 },
			})
			expect(published.body.publication.changes).toHaveLength(2)

			week = await s.get(`/week?scopeId=${LOC_1}&date=${WEEK}`)
			expect(week.body.version).toBe(1)
			expect(week.body.unpublishedCount).toBe(0)
			expect(week.body.lastPublishedAt).toBe(at('2026-03-02', '12:00'))
			expect(week.body.shifts.every((x: any) => x.state === 'published')).toBe(
				true,
			)
		})

		it('refuses to publish nothing, and a stale week', async () => {
			const { staffId } = await s.staff()
			expect((await s.publish(LOC_1, WEEK)).body.error).toBe(
				'nothing_to_publish',
			)
			await s.shift({ staffId, date: WEEK })
			const stale = await s.send('POST', '/publish', {
				scopeId: LOC_1,
				weekStart: WEEK,
				expectedVersion: 4,
			})
			expect(stale.status).toBe(409)
			expect(stale.body).toMatchObject({
				error: 'stale_week',
				currentVersion: 0,
			})
			expect((await s.publish(LOC_1, WEEK)).status).toBe(200)
			expect((await s.publish(LOC_1, WEEK)).body.error).toBe(
				'nothing_to_publish',
			)
		})

		it('keeps the published shift untouched while an edit is pending', async () => {
			const { staffId } = await s.staff()
			const created = await s.shift({ staffId, date: WEEK })
			await s.publish(LOC_1, WEEK)

			const edited = await s.send('PATCH', `/shifts/${created.id}`, {
				startTime: '10:00',
				endTime: '18:00',
				notes: 'Later start',
			})
			expect(edited.status).toBe(200)
			expect(edited.body).toMatchObject({
				state: 'changed',
				startsAt: at(WEEK, '10:00'),
				endsAt: at(WEEK, '18:00'),
				notes: 'Later start',
				published: {
					staffId,
					startsAt: at(WEEK, '09:00'),
					endsAt: at(WEEK, '17:00'),
					notes: null,
				},
			})
			// The stored published fields did not move.
			const db = await h.db(ORG_A)
			const [row] = await db
				.select()
				.from(shifts)
				.where(eq(shifts.id, created.id))
			expect(row).toMatchObject({
				startsAt: at(WEEK, '09:00'),
				status: 'published',
			})
			expect(row!.draftPatch).toMatchObject({ startsAt: at(WEEK, '10:00') })

			const week = await s.get(`/week?scopeId=${LOC_1}&date=${WEEK}`)
			expect(week.body.unpublishedCount).toBe(1)

			const publication = await s.publish(LOC_1, WEEK)
			expect(publication.body.publication.summary).toMatchObject({
				created: 0,
				changed: 1,
			})
			expect(publication.body.week.version).toBe(2)
			const [after] = await db
				.select()
				.from(shifts)
				.where(eq(shifts.id, created.id))
			expect(after).toMatchObject({
				startsAt: at(WEEK, '10:00'),
				notes: 'Later start',
				draftPatch: null,
				publishedVersion: 2,
			})
		})

		it('drops a pending edit when the shift is edited back to what is published', async () => {
			const { staffId } = await s.staff()
			const created = await s.shift({ staffId, date: WEEK })
			await s.publish(LOC_1, WEEK)
			await s.send('PATCH', `/shifts/${created.id}`, { notes: 'x' })
			const back = await s.send('PATCH', `/shifts/${created.id}`, {
				notes: null,
			})
			expect(back.body.state).toBe('published')
			const week = await s.get(`/week?scopeId=${LOC_1}&date=${WEEK}`)
			expect(week.body.unpublishedCount).toBe(0)
		})

		it('reverts a pending edit', async () => {
			const { staffId } = await s.staff()
			const created = await s.shift({ staffId, date: WEEK })
			await s.publish(LOC_1, WEEK)
			await s.send('PATCH', `/shifts/${created.id}`, { staffId: null })
			const reverted = await s.send('POST', `/shifts/${created.id}/revert`)
			expect(reverted.status).toBe(200)
			expect(reverted.body).toMatchObject({ state: 'published', staffId })
			const draft = await s.shift({ date: '2026-03-04' })
			expect(
				(await s.send('POST', `/shifts/${draft.id}/revert`)).body.error,
			).toBe('not_published')
		})

		it('deletes a draft outright and marks a published shift for removal', async () => {
			const { staffId } = await s.staff()
			const draft = await s.shift({ staffId, date: '2026-03-02' })
			const live = await s.shift({ staffId, date: '2026-03-03' })
			const removedDraft = await s.send('DELETE', `/shifts/${draft.id}`)
			expect(removedDraft.body).toEqual({ state: 'deleted', id: draft.id })
			await s.publish(LOC_1, WEEK)

			const pending = await s.send('DELETE', `/shifts/${live.id}`)
			expect(pending.status).toBe(200)
			expect(pending.body.state).toBe('cancel_pending')
			expect(pending.body.shift.state).toBe('cancel_pending')
			// Still on the grid until published, but it no longer takes part in totals.
			let week = await s.get(`/week?scopeId=${LOC_1}&date=${WEEK}`)
			expect(week.body.shifts).toHaveLength(1)
			expect(week.body.unpublishedCount).toBe(1)
			expect(week.body.totals.minutes).toBe(0)
			// Deleting again is idempotent; editing is refused.
			expect((await s.send('DELETE', `/shifts/${live.id}`)).status).toBe(200)
			expect(
				(await s.send('PATCH', `/shifts/${live.id}`, { notes: 'x' })).body
					.error,
			).toBe('cancel_pending')

			const published = await s.publish(LOC_1, WEEK)
			expect(published.body.publication.summary).toMatchObject({ cancelled: 1 })
			week = await s.get(`/week?scopeId=${LOC_1}&date=${WEEK}`)
			expect(week.body.shifts).toHaveLength(0)
			expect(
				(await s.send('PATCH', `/shifts/${live.id}`, { notes: 'x' })).body
					.error,
			).toBe('shift_cancelled')
		})

		it('refuses an edit based on an old version', async () => {
			const created = await s.shift({ date: WEEK })
			await s.send('PATCH', `/shifts/${created.id}`, { notes: 'one' })
			const stale = await s.send('PATCH', `/shifts/${created.id}`, {
				notes: 'two',
				expectedVersion: 1,
			})
			expect(stale.status).toBe(409)
			expect(stale.body).toMatchObject({
				error: 'stale_shift',
				currentVersion: 2,
			})
		})

		it('assigns and unassigns an open shift, through a pending change once published', async () => {
			const { staffId } = await s.staff()
			const open = await s.shift({ date: WEEK })
			const assigned = await s.send('POST', `/shifts/${open.id}/assign`, {
				staffId,
			})
			expect(assigned.body).toMatchObject({ staffId, state: 'draft' })
			await s.publish(LOC_1, WEEK)
			const un = await s.send('POST', `/shifts/${open.id}/unassign`, {})
			expect(un.body).toMatchObject({
				staffId: null,
				state: 'changed',
				published: { staffId },
			})
		})

		it('moves a shift to another day and keeps its wall-clock times', async () => {
			const created = await s.shift({
				date: '2026-03-02',
				start: '11:00',
				end: '15:30',
			})
			const moved = await s.send('PATCH', `/shifts/${created.id}`, {
				date: '2026-03-04',
			})
			expect(moved.body).toMatchObject({
				localDate: '2026-03-04',
				startsAt: at('2026-03-04', '11:00'),
				endsAt: at('2026-03-04', '15:30'),
			})
		})

		it('records the publication in an append-only history', async () => {
			const { staffId } = await s.staff()
			await s.shift({ staffId, date: WEEK })
			await s.publish(LOC_1, WEEK, { notifyMode: 'nobody' })
			const history = await s.get(
				`/publications?scopeId=${LOC_1}&weekStart=${WEEK}`,
			)
			expect(history.body).toHaveLength(1)
			expect(history.body[0]).toMatchObject({
				version: 1,
				notifyMode: 'nobody',
			})
			const db = await h.db(ORG_A)
			await expect(
				db.update(schedulePublications).set({ version: 9 }),
			).rejects.toThrow()
			const [week] = await db.select().from(scheduleWeeks)
			expect(week).toMatchObject({ version: 1, lastPublishedBy: 'operator-1' })
		})
	})

	describe('money', () => {
		it('leaves cost out without the grants and includes it with them', async () => {
			const { staffId, positionIds } = await s.staff()
			await s.shift({ staffId, positionId: positionIds[0], date: WEEK })

			const hours = await s.get(`/week?scopeId=${LOC_1}&date=${WEEK}`, {
				grants: SCH_EDIT,
			})
			expect(hours.body.shifts[0]).not.toHaveProperty('costMinor')
			expect(hours.body.people[0]).not.toHaveProperty('weekCostMinor')
			expect(hours.body.totals).not.toHaveProperty('costMinorByCurrency')
			expect(hours.body.footers[0]).not.toHaveProperty('costMinorByCurrency')
			expect(hours.body).not.toHaveProperty('laborTarget')
			expect(hours.raw).not.toMatch(/[:[,](?:2000|16000)[,\]}]/)

			const labor = await s.get(`/week?scopeId=${LOC_1}&date=${WEEK}`, {
				grants: SCH_LABOR,
			})
			expect(labor.body.shifts[0]).not.toHaveProperty('costMinor')
			expect(labor.body.totals.costMinorByCurrency).toEqual({ USD: 16000 })
			expect(labor.body.footers[0].costMinorByCurrency).toEqual({ USD: 16000 })
			expect(labor.body.laborTarget.currencies[0]).toMatchObject({
				currency: 'USD',
				costMinor: 16000,
			})

			const pay = await s.get(`/week?scopeId=${LOC_1}&date=${WEEK}`)
			expect(pay.body.shifts[0]).toMatchObject({
				costMinor: 16000,
				currency: 'USD',
			})
			expect(pay.body.people[0].weekCostMinor).toEqual({ USD: 16000 })
		})

		it('does not leak cost through a write response either', async () => {
			const { staffId, positionIds } = await s.staff()
			const response = await s.send(
				'POST',
				'/shifts',
				{
					scopeId: LOC_1,
					staffId,
					positionId: positionIds[0],
					dates: [WEEK],
					startTime: '09:00',
					endTime: '17:00',
				},
				{ grants: SCH_EDIT },
			)
			expect(response.status).toBe(201)
			expect(response.raw).not.toMatch(/costMinor|[:[,](?:2000|16000)[,\]}]/)
		})
	})
})
