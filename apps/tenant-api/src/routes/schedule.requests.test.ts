import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shifts, staffAuditLog, staffAvailability } from '@repo/tenant-db'
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

describe('time off, availability and shift requests', () => {
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

	describe('time off', () => {
		it('approves at once when a manager enters it, and records who and when', async () => {
			const { staffId } = await s.staff()
			const created = await s.send('POST', '/time-off', {
				staffId,
				category: 'pto',
				startDate: '2026-03-10',
				endDate: '2026-03-12',
				note: 'Family trip',
			})
			expect(created.status).toBe(201)
			expect(created.body).toMatchObject({
				staffId,
				category: 'pto',
				startDate: '2026-03-10',
				endDate: '2026-03-12',
				allDay: true,
				status: 'approved',
				source: 'manager',
				decidedBy: 'operator-1',
				decidedAt: at('2026-03-02', '12:00'),
				note: 'Family trip',
				warnings: [],
			})
		})

		it('holds a request recorded as the person own until it is decided', async () => {
			const { staffId } = await s.staff()
			const created = await s.send('POST', '/time-off', {
				staffId,
				startDate: '2026-03-20',
				endDate: '2026-03-20',
				submission: 'staff_request',
			})
			expect(created.body).toMatchObject({
				status: 'pending',
				source: 'staff',
				decidedBy: null,
			})
			const approved = await s.send(
				'POST',
				`/time-off/${created.body.id}/decision`,
				{
					decision: 'approve',
					note: 'Enjoy',
				},
			)
			expect(approved.body).toMatchObject({
				status: 'approved',
				decidedBy: 'operator-1',
				decisionNote: 'Enjoy',
			})
			const again = await s.send(
				'POST',
				`/time-off/${created.body.id}/decision`,
				{
					decision: 'reject',
				},
			)
			expect(again.status).toBe(409)
			expect(again.body.error).toBe('already_decided')
		})

		it('rejects, and a rejected request no longer counts against the schedule', async () => {
			const { staffId } = await s.staff()
			const created = await s.send('POST', '/time-off', {
				staffId,
				startDate: WEEK,
				endDate: WEEK,
				submission: 'staff_request',
			})
			await s.send('POST', `/time-off/${created.body.id}/decision`, {
				decision: 'reject',
			})
			const shift = await s.shift({ staffId, date: WEEK })
			expect(shift.conflicts).toEqual([])
		})

		it('cancels an approved request, which stops its warning', async () => {
			const { staffId } = await s.staff()
			const created = await s.send('POST', '/time-off', {
				staffId,
				startDate: WEEK,
				endDate: WEEK,
			})
			const cancelled = await s.send(
				'POST',
				`/time-off/${created.body.id}/cancel`,
			)
			expect(cancelled.body.status).toBe('cancelled')
			expect((await s.shift({ staffId, date: WEEK })).conflicts).toEqual([])
			expect(
				(await s.send('POST', `/time-off/${created.body.id}/cancel`)).status,
			).toBe(409)
		})

		it('warns about short notice and a full day without refusing', async () => {
			await s.send('PUT', '/settings', { timeOffMinNoticeDays: 7 })
			await s.setPolicy(LOC_1, { timeOffMaxPerDay: 1 })
			const a = await s.staff()
			const b = await s.staff()
			await s.send('POST', '/time-off', {
				staffId: a.staffId,
				startDate: '2026-03-05',
				endDate: '2026-03-05',
			})
			const created = await s.send('POST', '/time-off', {
				staffId: b.staffId,
				startDate: '2026-03-05',
				endDate: '2026-03-06',
				submission: 'staff_request',
			})
			expect(created.status).toBe(201)
			expect(created.body.warnings).toEqual([
				{ code: 'short_notice', detail: 3 },
				{ code: 'over_daily_limit', detail: 1 },
			])
			const listed = await s.get('/time-off?status=pending')
			expect(listed.body[0].warnings).toHaveLength(2)
			const approved = await s.send(
				'POST',
				`/time-off/${created.body.id}/decision`,
				{
					decision: 'approve',
				},
			)
			expect(approved.status).toBe(200)
		})

		it('validates partial days and date order', async () => {
			const { staffId } = await s.staff()
			const base = { staffId, startDate: WEEK, endDate: WEEK }
			expect(
				(await s.send('POST', '/time-off', { ...base, allDay: false })).status,
			).toBe(400)
			expect(
				(
					await s.send('POST', '/time-off', {
						...base,
						allDay: false,
						startTime: '15:00',
						endTime: '14:00',
					})
				).status,
			).toBe(400)
			expect(
				(
					await s.send('POST', '/time-off', {
						...base,
						allDay: false,
						startTime: '09:00',
						endTime: '24:00',
					})
				).status,
			).toBe(201)
			expect(
				(
					await s.send('POST', '/time-off', {
						staffId,
						startDate: '2026-03-05',
						endDate: '2026-03-04',
					})
				).status,
			).toBe(400)
			expect(
				(
					await s.send('POST', '/time-off', {
						...base,
						allDay: true,
						startTime: '09:00',
					})
				).status,
			).toBe(400)
		})

		it('filters the list and keeps a scoped manager to their own scopes', async () => {
			const here = await s.staff({ scopeIds: [LOC_1] })
			const there = await s.staff({ scopeIds: [LOC_2] })
			const mine = await s.send('POST', '/time-off', {
				staffId: here.staffId,
				startDate: WEEK,
				endDate: WEEK,
			})
			const theirs = await s.send('POST', '/time-off', {
				staffId: there.staffId,
				startDate: '2026-03-20',
				endDate: '2026-03-20',
				submission: 'staff_request',
			})
			expect((await s.get('/time-off')).body).toHaveLength(2)
			expect(
				(await s.get(`/time-off?scopeId=${LOC_2}`)).body.map((r: any) => r.id),
			).toEqual([theirs.body.id])
			expect(
				(await s.get('/time-off?from=2026-03-10&to=2026-03-31')).body.map(
					(r: any) => r.id,
				),
			).toEqual([theirs.body.id])
			expect(
				(await s.get(`/time-off?staffId=${here.staffId}`)).body.map(
					(r: any) => r.id,
				),
			).toEqual([mine.body.id])
			const scoped = { scopeIds: [LOC_1] }
			expect(
				(await s.get('/time-off', scoped)).body.map((r: any) => r.id),
			).toEqual([mine.body.id])
			expect((await s.get(`/time-off?scopeId=${LOC_2}`, scoped)).status).toBe(
				404,
			)
			// The other scope's request does not exist as far as this token can tell.
			const decision = await s.send(
				'POST',
				`/time-off/${theirs.body.id}/decision`,
				{ decision: 'approve' },
				scoped,
			)
			expect(decision.status).toBe(404)
			const create = await s.send(
				'POST',
				'/time-off',
				{ staffId: there.staffId, startDate: WEEK, endDate: WEEK },
				scoped,
			)
			expect(create.status).toBe(422)
			expect(create.body.error).toBe('staff_not_found')
		})

		it('audits requests and decisions without notes or dates of birth', async () => {
			const { staffId } = await s.staff()
			const created = await s.send('POST', '/time-off', {
				staffId,
				startDate: WEEK,
				endDate: WEEK,
				submission: 'staff_request',
				note: 'private reason',
			})
			await s.send('POST', `/time-off/${created.body.id}/decision`, {
				decision: 'approve',
			})
			const db = await h.db(ORG_A)
			const rows = await db.select().from(staffAuditLog)
			const actions = rows.map((r) => r.action)
			expect(actions).toContain('schedule.time_off.created')
			expect(actions).toContain('schedule.time_off.approved')
			expect(JSON.stringify(rows.map((r) => r.changes))).not.toContain(
				'private reason',
			)
		})
	})

	describe('availability', () => {
		it('records a manager-entered pattern as approved, and a replacement supersedes it', async () => {
			const { staffId } = await s.staff()
			const first = await s.send('POST', '/availability', {
				staffId,
				rows: [
					{
						kind: 'weekly',
						weekday: 1,
						availability: 'unavailable',
						allDay: true,
					},
					{
						kind: 'weekly',
						weekday: 2,
						availability: 'unavailable',
						allDay: true,
					},
				],
			})
			expect(first.status).toBe(201)
			expect(first.body.every((r: any) => r.status === 'approved')).toBe(true)
			const second = await s.send('POST', '/availability', {
				staffId,
				replaceWeekly: true,
				rows: [
					{
						kind: 'weekly',
						weekday: 3,
						availability: 'unavailable',
						allDay: true,
					},
				],
			})
			expect(second.body[0].status).toBe('approved')
			const superseded = await s.get(
				`/availability?staffId=${staffId}&status=superseded`,
			)
			expect(superseded.body).toHaveLength(2)
			// Monday is open again.
			expect((await s.shift({ staffId, date: WEEK })).conflicts).toEqual([])
			expect(
				(await s.shift({ staffId, date: '2026-03-04' })).conflicts,
			).toHaveLength(1)
		})

		it('adds to the pattern when replaceWeekly is off', async () => {
			const { staffId } = await s.staff()
			await s.send('POST', '/availability', {
				staffId,
				rows: [
					{
						kind: 'weekly',
						weekday: 1,
						availability: 'unavailable',
						allDay: true,
					},
				],
			})
			await s.send('POST', '/availability', {
				staffId,
				rows: [
					{
						kind: 'weekly',
						weekday: 2,
						availability: 'unavailable',
						allDay: true,
					},
				],
			})
			expect(
				(await s.get(`/availability?staffId=${staffId}&status=approved`)).body,
			).toHaveLength(2)
		})

		it('lets a person submit a pattern that replaces the old one once it is approved', async () => {
			const { staffId } = await s.staff()
			await s.send('POST', '/availability', {
				staffId,
				rows: [
					{
						kind: 'weekly',
						weekday: 1,
						availability: 'unavailable',
						allDay: true,
					},
				],
			})
			h.advance(60_000)
			const submitted = await s.send('POST', '/availability', {
				staffId,
				submission: 'staff_request',
				rows: [
					{
						kind: 'weekly',
						weekday: 2,
						availability: 'available',
						allDay: false,
						startTime: '09:00',
						endTime: '12:00',
					},
					{
						kind: 'weekly',
						weekday: 2,
						availability: 'available',
						allDay: false,
						startTime: '16:00',
						endTime: '20:00',
					},
				],
			})
			expect(submitted.body.every((r: any) => r.status === 'pending')).toBe(
				true,
			)
			// Nothing changes while it waits.
			expect((await s.shift({ staffId, date: WEEK })).conflicts).toHaveLength(1)

			const decided = await s.send('POST', '/availability/decision', {
				ids: submitted.body.map((r: any) => r.id),
				decision: 'approve',
				note: 'ok',
			})
			expect(decided.status).toBe(200)
			expect(decided.body.map((r: any) => r.status)).toEqual([
				'approved',
				'approved',
			])
			// The old Monday row is superseded; both new Tuesday rows stay.
			expect(
				(await s.get(`/availability?staffId=${staffId}&status=superseded`))
					.body,
			).toHaveLength(1)
			expect(
				(await s.get(`/availability?staffId=${staffId}&status=approved`)).body,
			).toHaveLength(2)
			expect(
				(await s.shift({ staffId, date: '2026-03-09' })).conflicts,
			).toEqual([])
		})

		it('decides a whole batch or none of it', async () => {
			const { staffId } = await s.staff()
			const rows = await s.send('POST', '/availability', {
				staffId,
				submission: 'staff_request',
				rows: [
					{
						kind: 'one_off',
						date: '2026-03-05',
						availability: 'unavailable',
						allDay: true,
					},
					{
						kind: 'one_off',
						date: '2026-03-06',
						availability: 'unavailable',
						allDay: true,
					},
				],
			})
			const [first, second] = rows.body
			await s.send('POST', '/availability/decision', {
				ids: [first.id],
				decision: 'reject',
			})
			const mixed = await s.send('POST', '/availability/decision', {
				ids: [first.id, second.id],
				decision: 'approve',
			})
			expect(mixed.status).toBe(409)
			expect(mixed.body.error).toBe('already_decided')
			const db = await h.db(ORG_A)
			const [still] = await db
				.select()
				.from(staffAvailability)
				.where(eq(staffAvailability.id, second.id))
			expect(still!.status).toBe('pending')
			const missing = await s.send('POST', '/availability/decision', {
				ids: [second.id, 'nope'],
				decision: 'approve',
			})
			expect(missing.status).toBe(404)
		})

		it('cancels a row and validates the shape of rows', async () => {
			const { staffId } = await s.staff()
			const created = await s.send('POST', '/availability', {
				staffId,
				rows: [
					{
						kind: 'one_off',
						date: '2026-03-05',
						availability: 'unavailable',
						allDay: true,
					},
				],
			})
			expect(
				(await s.send('POST', `/availability/${created.body[0].id}/cancel`))
					.body.status,
			).toBe('cancelled')
			const bad = [
				{ kind: 'weekly', availability: 'unavailable', allDay: true },
				{
					kind: 'weekly',
					weekday: 9,
					availability: 'unavailable',
					allDay: true,
				},
				{
					kind: 'one_off',
					weekday: 1,
					availability: 'unavailable',
					allDay: true,
				},
				{
					kind: 'weekly',
					weekday: 1,
					availability: 'unavailable',
					allDay: false,
				},
				{
					kind: 'weekly',
					weekday: 1,
					availability: 'unavailable',
					allDay: false,
					startTime: '12:00',
					endTime: '10:00',
				},
			]
			for (const row of bad) {
				expect(
					(await s.send('POST', '/availability', { staffId, rows: [row] }))
						.status,
				).toBe(400)
			}
		})
	})

	describe('swap, cover and drop requests', () => {
		async function twoPublished() {
			const ana = await s.staff({ firstName: 'Ana' })
			const ben = await s.staff({ firstName: 'Ben' })
			const anaShift = await s.shift({
				staffId: ana.staffId,
				date: '2026-03-03',
			})
			const benShift = await s.shift({
				staffId: ben.staffId,
				date: '2026-03-04',
			})
			await s.publish(LOC_1, WEEK)
			return { ana, ben, anaShift, benShift }
		}

		it('turns an approved drop into a pending change that publishing applies', async () => {
			const { ana, anaShift } = await twoPublished()
			const created = await s.send('POST', '/requests', {
				kind: 'drop',
				shiftId: anaShift.id,
				requesterStaffId: ana.staffId,
				note: 'Sick kid',
			})
			expect(created.status).toBe(201)
			expect(created.body.request).toMatchObject({
				kind: 'drop',
				status: 'pending',
				source: 'staff',
				scopeId: LOC_1,
				localDate: '2026-03-03',
			})
			expect(created.body.shifts).toEqual([])
			expect(
				(await s.get(`/week?scopeId=${LOC_1}&date=${WEEK}`)).body.pending
					.shiftRequests,
			).toBe(1)

			const decided = await s.send(
				'POST',
				`/requests/${created.body.request.id}/decision`,
				{
					decision: 'approve',
				},
			)
			expect(decided.status).toBe(200)
			expect(decided.body.request.status).toBe('approved')
			expect(decided.body.shifts[0]).toMatchObject({
				id: anaShift.id,
				staffId: null,
				state: 'changed',
				published: { staffId: ana.staffId },
			})
			// Staff still see the published version until the week is published.
			const db = await h.db(ORG_A)
			const [row] = await db
				.select()
				.from(shifts)
				.where(eq(shifts.id, anaShift.id))
			expect(row!.staffId).toBe(ana.staffId)
			await s.publish(LOC_1, WEEK)
			const [after] = await db
				.select()
				.from(shifts)
				.where(eq(shifts.id, anaShift.id))
			expect(after!.staffId).toBeNull()
		})

		it('hands a covered shift to the person taking it, with their warnings', async () => {
			const { ana, ben, anaShift } = await twoPublished()
			await s.send('POST', '/time-off', {
				staffId: ben.staffId,
				startDate: '2026-03-03',
				endDate: '2026-03-03',
			})
			const created = await s.send('POST', '/requests', {
				kind: 'cover',
				shiftId: anaShift.id,
				requesterStaffId: ana.staffId,
				targetStaffId: ben.staffId,
			})
			const decided = await s.send(
				'POST',
				`/requests/${created.body.request.id}/decision`,
				{
					decision: 'approve',
				},
			)
			expect(decided.body.shifts[0]).toMatchObject({
				staffId: ben.staffId,
				state: 'changed',
			})
			expect(decided.body.shifts[0].conflicts.map((c: any) => c.code)).toEqual([
				'time_off',
			])
		})

		it('swaps two shifts together', async () => {
			const { ana, ben, anaShift, benShift } = await twoPublished()
			const created = await s.send('POST', '/requests', {
				kind: 'swap',
				shiftId: anaShift.id,
				requesterStaffId: ana.staffId,
				targetStaffId: ben.staffId,
				targetShiftId: benShift.id,
			})
			const decided = await s.send(
				'POST',
				`/requests/${created.body.request.id}/decision`,
				{
					decision: 'approve',
				},
			)
			expect(decided.body.shifts.map((x: any) => [x.id, x.staffId])).toEqual([
				[anaShift.id, ben.staffId],
				[benShift.id, ana.staffId],
			])
		})

		it('applies a manager-entered request at once', async () => {
			const { ana, ben, anaShift } = await twoPublished()
			const created = await s.send('POST', '/requests', {
				kind: 'cover',
				shiftId: anaShift.id,
				requesterStaffId: ana.staffId,
				targetStaffId: ben.staffId,
				submission: 'manager_entered',
			})
			expect(created.body.request).toMatchObject({
				status: 'approved',
				source: 'manager',
			})
			expect(created.body.shifts[0].staffId).toBe(ben.staffId)
		})

		it('refuses a request that no longer matches the schedule', async () => {
			const { ana, ben, anaShift } = await twoPublished()
			const created = await s.send('POST', '/requests', {
				kind: 'drop',
				shiftId: anaShift.id,
				requesterStaffId: ana.staffId,
			})
			// The manager already gave the shift to Ben.
			await s.send('POST', `/shifts/${anaShift.id}/assign`, {
				staffId: ben.staffId,
			})
			const stale = await s.send(
				'POST',
				`/requests/${created.body.request.id}/decision`,
				{
					decision: 'approve',
				},
			)
			expect(stale.status).toBe(409)
			expect(stale.body.error).toBe('request_stale')
			// It stays pending (and can be rejected).
			const rejected = await s.send(
				'POST',
				`/requests/${created.body.request.id}/decision`,
				{
					decision: 'reject',
				},
			)
			expect(rejected.body.request.status).toBe('rejected')
			expect(rejected.body.shifts).toEqual([])
		})

		it('only accepts requests the requester can make', async () => {
			const { ana, ben, anaShift, benShift } = await twoPublished()
			const notMine = await s.send('POST', '/requests', {
				kind: 'drop',
				shiftId: benShift.id,
				requesterStaffId: ana.staffId,
			})
			expect(notMine.status).toBe(422)
			expect(notMine.body.error).toBe('not_your_shift')
			const draft = await s.shift({ staffId: ana.staffId, date: '2026-03-06' })
			const unpublished = await s.send('POST', '/requests', {
				kind: 'drop',
				shiftId: draft.id,
				requesterStaffId: ana.staffId,
			})
			expect(unpublished.body.error).toBe('not_published')
			const self = await s.send('POST', '/requests', {
				kind: 'cover',
				shiftId: anaShift.id,
				requesterStaffId: ana.staffId,
				targetStaffId: ana.staffId,
			})
			expect(self.status).toBe(422)
			const wrongSwap = await s.send('POST', '/requests', {
				kind: 'swap',
				shiftId: anaShift.id,
				requesterStaffId: ana.staffId,
				targetStaffId: ben.staffId,
				targetShiftId: anaShift.id,
			})
			expect(wrongSwap.body.error).toBe('not_your_shift')
			// Shape errors.
			expect(
				(
					await s.send('POST', '/requests', {
						kind: 'swap',
						shiftId: anaShift.id,
						requesterStaffId: ana.staffId,
					})
				).status,
			).toBe(400)
			expect(
				(
					await s.send('POST', '/requests', {
						kind: 'drop',
						shiftId: anaShift.id,
						requesterStaffId: ana.staffId,
						targetStaffId: ben.staffId,
					})
				).status,
			).toBe(400)
		})

		it('allows one open request per shift, and a cancelled one frees it', async () => {
			const { ana, anaShift } = await twoPublished()
			const body = {
				kind: 'drop',
				shiftId: anaShift.id,
				requesterStaffId: ana.staffId,
			}
			const first = await s.send('POST', '/requests', body)
			const dup = await s.send('POST', '/requests', body)
			expect(dup.status).toBe(409)
			expect(dup.body.error).toBe('request_pending')
			expect(
				(await s.send('POST', `/requests/${first.body.request.id}/cancel`)).body
					.status,
			).toBe('cancelled')
			expect((await s.send('POST', '/requests', body)).status).toBe(201)
		})

		it('lists by status, kind and scope, within the token', async () => {
			const { ana, anaShift } = await twoPublished()
			await s.send('POST', '/requests', {
				kind: 'drop',
				shiftId: anaShift.id,
				requesterStaffId: ana.staffId,
			})
			expect((await s.get('/requests?status=pending')).body).toHaveLength(1)
			expect((await s.get('/requests?kind=swap')).body).toHaveLength(0)
			expect((await s.get(`/requests?scopeId=${LOC_1}`)).body).toHaveLength(1)
			expect(
				(await s.get('/requests', { scopeIds: [LOC_2] })).body,
			).toHaveLength(0)
			expect(
				(await s.get(`/requests?scopeId=${LOC_1}`, { scopeIds: [LOC_2] }))
					.status,
			).toBe(404)
			const id = (await s.get('/requests')).body[0].id
			expect(
				(
					await s.send(
						'POST',
						`/requests/${id}/decision`,
						{ decision: 'approve' },
						{ scopeIds: [LOC_2] },
					)
				).status,
			).toBe(404)
		})
	})
})
