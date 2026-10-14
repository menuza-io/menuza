import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { staffMembers, staffPositions } from '@repo/tenant-db'
import { makeOrg, type TestOrg } from '../../tests/staff-harness.ts'
import {
	at,
	CHI,
	createClockHarness,
	LOC_1,
	LOC_2,
	ORG_A,
	SCH_EDIT,
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

const WEEK = '2026-03-02' // Monday

const codes = (view: any) => view.conflicts.map((c: any) => c.code).sort()

describe('schedule conflicts are warnings', () => {
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

	it('flags an overlap on both shifts and still writes it', async () => {
		const { staffId } = await s.staff()
		const first = await s.shift({
			staffId,
			date: WEEK,
			start: '09:00',
			end: '13:00',
		})
		const second = await s.shift({
			staffId,
			date: WEEK,
			start: '12:00',
			end: '16:00',
		})
		expect(codes(second)).toEqual(['overlap'])
		expect(second.conflicts[0]).toMatchObject({
			code: 'overlap',
			relatedId: first.id,
			date: WEEK,
		})
		const week = await s.get(`/week?scopeId=${LOC_1}&date=${WEEK}`)
		const byId = new Map(week.body.shifts.map((x: any) => [x.id, x]))
		expect(codes(byId.get(first.id))).toEqual(['overlap'])
		expect(codes(byId.get(second.id))).toEqual(['overlap'])
	})

	it('treats back-to-back shifts as no overlap', async () => {
		const { staffId } = await s.staff()
		await s.shift({ staffId, date: WEEK, start: '09:00', end: '13:00' })
		const next = await s.shift({
			staffId,
			date: WEEK,
			start: '13:00',
			end: '17:00',
		})
		expect(codes(next)).toEqual([])
	})

	it('flags an overlap with a shift at another scope', async () => {
		const { staffId } = await s.staff({ scopeIds: [LOC_1, LOC_2] })
		await s.shift({
			staffId,
			scopeId: LOC_2,
			date: WEEK,
			start: '09:00',
			end: '13:00',
		})
		const clash = await s.shift({
			staffId,
			date: WEEK,
			start: '10:00',
			end: '14:00',
		})
		expect(codes(clash)).toContain('overlap')
	})

	it('does not reveal another scope to a token that cannot see it', async () => {
		const { staffId } = await s.staff({ scopeIds: [LOC_1, LOC_2] })
		await s.shift({
			staffId,
			scopeId: LOC_2,
			date: WEEK,
			start: '09:00',
			end: '13:00',
		})
		const clash = await s.shift(
			{ staffId, date: WEEK, start: '10:00', end: '14:00' },
			{ scopeIds: [LOC_1] },
		)
		expect(codes(clash)).toEqual([])
	})

	it('flags approved time off but not a pending request', async () => {
		const { staffId } = await s.staff()
		await s.send('POST', '/time-off', {
			staffId,
			startDate: '2026-03-03',
			endDate: '2026-03-03',
			category: 'sick',
			submission: 'staff_request',
		})
		const pendingOnly = await s.shift({ staffId, date: '2026-03-03' })
		expect(codes(pendingOnly)).toEqual([])
		const approved = await s.send('POST', '/time-off', {
			staffId,
			startDate: '2026-03-04',
			endDate: '2026-03-04',
		})
		expect(approved.body.status).toBe('approved')
		const clash = await s.shift({ staffId, date: '2026-03-04' })
		expect(clash.conflicts).toEqual([
			expect.objectContaining({
				code: 'time_off',
				relatedId: approved.body.id,
			}),
		])
	})

	it('flags part-day time off only when the shift touches it', async () => {
		const { staffId } = await s.staff()
		await s.send('POST', '/time-off', {
			staffId,
			startDate: WEEK,
			endDate: WEEK,
			allDay: false,
			startTime: '14:00',
			endTime: '18:00',
		})
		expect(
			codes(
				await s.shift({ staffId, date: WEEK, start: '08:00', end: '13:00' }),
			),
		).toEqual([])
		expect(
			codes(
				await s.shift({ staffId, date: WEEK, start: '13:00', end: '15:00' }),
			),
		).toEqual(['time_off'])
	})

	it('flags work outside approved availability and inside an unavailable window', async () => {
		const { staffId } = await s.staff()
		// Mondays: only 09:00 to 12:00; Tuesdays: not before 11:00 is blocked.
		await s.send('POST', '/availability', {
			staffId,
			rows: [
				{
					kind: 'weekly',
					weekday: 1,
					availability: 'available',
					allDay: false,
					startTime: '09:00',
					endTime: '12:00',
				},
				{
					kind: 'weekly',
					weekday: 2,
					availability: 'unavailable',
					allDay: false,
					startTime: '00:00',
					endTime: '11:00',
				},
			],
		})
		expect(
			codes(
				await s.shift({
					staffId,
					date: '2026-03-02',
					start: '09:00',
					end: '12:00',
				}),
			),
		).toEqual([])
		expect(
			codes(
				await s.shift({
					staffId,
					date: '2026-03-09',
					start: '09:00',
					end: '15:00',
				}),
			),
		).toEqual(['unavailable'])
		expect(
			codes(
				await s.shift({
					staffId,
					date: '2026-03-03',
					start: '10:00',
					end: '14:00',
				}),
			),
		).toEqual(['unavailable'])
		expect(
			codes(
				await s.shift({
					staffId,
					date: '2026-03-10',
					start: '11:00',
					end: '14:00',
				}),
			),
		).toEqual([])
	})

	it('lets a one-off row override the weekly pattern for its date', async () => {
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
				{
					kind: 'one_off',
					date: '2026-03-09',
					availability: 'available',
					allDay: true,
				},
			],
		})
		expect(codes(await s.shift({ staffId, date: '2026-03-02' }))).toEqual([
			'unavailable',
		])
		expect(codes(await s.shift({ staffId, date: '2026-03-09' }))).toEqual([])
	})

	it('ignores pending availability', async () => {
		const { staffId } = await s.staff()
		await s.send('POST', '/availability', {
			staffId,
			submission: 'staff_request',
			rows: [
				{
					kind: 'weekly',
					weekday: 1,
					availability: 'unavailable',
					allDay: true,
				},
			],
		})
		expect(codes(await s.shift({ staffId, date: WEEK }))).toEqual([])
	})

	it('warns about weekly overtime on the shifts that cross the threshold', async () => {
		await s.setPolicy(LOC_1, {
			weeklyOvertime: { thresholdMinutes: 2400, multiplierBp: 15000 },
		})
		const { staffId } = await s.staff()
		const dates = [
			'2026-03-02',
			'2026-03-03',
			'2026-03-04',
			'2026-03-05',
			'2026-03-06',
		]
		let last: any
		for (const date of dates) {
			last = await s.shift({ staffId, date, start: '08:00', end: '18:00' })
		}
		expect(last.conflicts).toEqual([
			expect.objectContaining({
				code: 'overtime',
				detail: { overtimeMinutes: 600 },
			}),
		])
		const week = await s.get(`/week?scopeId=${LOC_1}&date=${WEEK}`)
		expect(week.body.people[0]).toMatchObject({
			weekMinutes: 3000,
			overtimeMinutes: 600,
		})
		expect(week.body.totals).toMatchObject({
			minutes: 3000,
			overtimeMinutes: 600,
		})
		// 40h regular at 20.00 plus 10h at 30.00.
		expect(week.body.people[0].weekCostMinor).toEqual({ USD: 80000 + 30000 })
	})

	it('warns about too little rest between two days, by the organization setting', async () => {
		const { staffId } = await s.staff()
		await s.shift({ staffId, date: '2026-03-02', start: '15:00', end: '23:00' })
		const early = await s.shift({
			staffId,
			date: '2026-03-03',
			start: '06:00',
			end: '12:00',
		})
		expect(early.conflicts).toEqual([
			expect.objectContaining({
				code: 'min_rest',
				detail: { restMinutes: 420, requiredMinutes: 480 },
			}),
		])
		const off = await s.send('PUT', '/settings', { minRestMinutes: 0 })
		expect(off.status).toBe(200)
		const week = await s.get(`/week?scopeId=${LOC_1}&date=${WEEK}`)
		expect(week.body.shifts.flatMap((x: any) => x.conflicts)).toEqual([])
	})

	it('warns when the person holds no pay row for the position', async () => {
		const { staffId } = await s.staff()
		const db = await h.db(ORG_A)
		const [other] = await db
			.insert(staffPositions)
			.values({ name: 'Barista-x' })
			.returning()
		const view = await s.shift({ staffId, positionId: other!.id, date: WEEK })
		expect(codes(view)).toEqual(['position_mismatch'])
	})

	it('warns when the person is not assigned to the scope, or is on leave', async () => {
		const away = await s.staff({ scopeIds: [LOC_2] })
		expect(codes(await s.shift({ staffId: away.staffId, date: WEEK }))).toEqual(
			['not_at_scope'],
		)
		const onLeave = await s.staff({ status: 'on_leave' })
		expect(
			codes(await s.shift({ staffId: onLeave.staffId, date: WEEK })),
		).toEqual(['staff_on_leave'])
	})

	it('reports several warnings at once and never refuses the write', async () => {
		const { staffId } = await s.staff({ status: 'on_leave' })
		await s.send('POST', '/time-off', {
			staffId,
			startDate: WEEK,
			endDate: WEEK,
		})
		await s.shift({ staffId, date: WEEK, start: '09:00', end: '13:00' })
		const view = await s.shift({
			staffId,
			date: WEEK,
			start: '10:00',
			end: '14:00',
		})
		expect(codes(view)).toEqual(['overlap', 'staff_on_leave', 'time_off'])
		const db = await h.db(ORG_A)
		const [member] = await db
			.select()
			.from(staffMembers)
			.where(eq(staffMembers.id, staffId))
		expect(member!.status).toBe('on_leave')
	})

	it('never puts names, money or notes into a conflict', async () => {
		const { staffId } = await s.staff({ firstName: 'Zelda', lastName: 'Quinn' })
		await s.shift({
			staffId,
			date: WEEK,
			start: '09:00',
			end: '13:00',
			notes: 'secret',
		})
		const view = await s.shift({
			staffId,
			date: WEEK,
			start: '10:00',
			end: '14:00',
		})
		expect(JSON.stringify(view.conflicts)).not.toMatch(
			/Zelda|Quinn|secret|2000/,
		)
	})

	it('measures a night shift over the spring-forward change by real time', async () => {
		const { staffId } = await s.staff()
		const night = await s.shift({
			staffId,
			date: '2026-03-07',
			start: '22:00',
			end: '06:00',
		})
		// 2026-03-08 02:00 to 03:00 does not exist in Chicago.
		expect(night.paidMinutes).toBe(420)
		expect(night.endsAt - night.startsAt).toBe(420 * 60_000)
	})

	it('measures a night shift over the fall-back change by real time', async () => {
		const { staffId } = await s.staff()
		const night = await s.shift({
			staffId,
			date: '2026-11-01',
			start: '22:00',
			end: '06:00',
		})
		// 2026-11-01 01:00 to 02:00 happens twice... after 22:00 on the 1st the day is already over:
		// the repeated hour is on the early morning of the 1st, so check the night before.
		expect(night.paidMinutes).toBe(480)
		const before = await s.shift({
			staffId,
			date: '2026-10-31',
			start: '22:00',
			end: '06:00',
		})
		expect(before.paidMinutes).toBe(540)
	})

	it('does not report shifts of the same week twice across a week boundary', async () => {
		const { staffId } = await s.staff()
		// Sunday night into Monday: belongs to the week it starts in (Sunday 2026-03-01).
		const overnight = await s.shift({
			staffId,
			date: '2026-03-01',
			start: '22:00',
			end: '04:00',
		})
		const prev = await s.get(`/week?scopeId=${LOC_1}&date=2026-03-01`)
		expect(prev.body.shifts.map((x: any) => x.id)).toEqual([overnight.id])
		expect(prev.body.footers.at(-1)).toMatchObject({
			date: '2026-03-01',
			minutes: 120,
		})
		const next = await s.get(`/week?scopeId=${LOC_1}&date=${WEEK}`)
		expect(next.body.shifts).toHaveLength(0)
		// The part after midnight counts on Monday.
		expect(next.body.footers[0]).toMatchObject({ date: WEEK, minutes: 240 })
	})

	it('works in Riyadh with no daylight saving', async () => {
		facts.set(LOC_1, { name: 'Riyadh', timeZone: 'Asia/Riyadh' })
		const { staffId } = await s.staff()
		const view = await s.shift(
			{ staffId, date: '2026-03-07', start: '22:00', end: '06:00' },
			{ grants: SCH_EDIT },
		)
		expect(view.paidMinutes).toBe(480)
		expect(view.timeZone).toBe('Asia/Riyadh')
		expect(view.startsAt).toBe(at('2026-03-07', '22:00', 'Asia/Riyadh'))
	})
})
