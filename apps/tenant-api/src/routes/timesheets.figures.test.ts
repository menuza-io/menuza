import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STAFFING_PERMISSIONS as P } from '@repo/staffing'
import { staffAuditLog, timeEntries } from '@repo/tenant-db'
import { makeOrg, type TestOrg } from '../../tests/staff-harness.ts'
import {
	at,
	CHI,
	createClockHarness,
	LOC_1,
	LOC_2,
	ORG_A,
	TS_APPROVE,
	TS_PAY,
	TS_VIEW,
	timesheetFixture,
	type ClockHarness,
	type TimesheetFixture,
} from '../../tests/timesheet-harness.ts'

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

describe('timesheet figures, pay periods and export', () => {
	let h: ClockHarness
	let t: TimesheetFixture

	beforeEach(async () => {
		orgs.clear()
		orgs.set(ORG_A, makeOrg(ORG_A))
		facts.clear()
		facts.set(LOC_1, { name: 'Downtown', timeZone: CHI })
		facts.set(LOC_2, { name: 'Airport', timeZone: CHI })
		h = await createClockHarness([ORG_A])
		t = timesheetFixture(h)
		h.setClock(at('2026-03-20', '12:00'))
	})
	afterEach(async () => {
		await h.cleanup()
	})

	const WEEK = [
		'2026-03-02',
		'2026-03-03',
		'2026-03-04',
		'2026-03-05',
		'2026-03-06',
	]

	async function workWeek(staffId: string, hours = 9, scopeId = LOC_1) {
		const out = []
		for (const date of WEEK) {
			const end = `${String(8 + hours).padStart(2, '0')}:00`
			const response = await t.card({
				staffId,
				scopeId,
				date,
				startTime: '08:00',
				endTime: end,
				reason: 'Weekly hours',
			})
			expect(response.status).toBe(201)
			out.push(response.body.card)
		}
		return out
	}

	describe('overtime across the workweek', () => {
		it('allocates weekly overtime to the cards that cross the threshold, priced as an estimate', async () => {
			await t.setPolicy(LOC_1, {
				weeklyOvertime: { thresholdMinutes: 2400, multiplierBp: 15000 },
			})
			const { staffId } = await t.staff()
			await workWeek(staffId)

			const period = await t.get('/timesheets/period?date=2026-03-04')
			expect(period.status).toBe(200)
			const person = period.body.people[0]
			expect(person.totals).toMatchObject({
				paidMinutes: 2700,
				regularMinutes: 2400,
				overtimeMinutes: 300,
				cards: 5,
			})
			const cards = person.cards
			expect(
				cards.slice(0, 4).every((c: any) => c.minutes.overtimeMinutes === 0),
			).toBe(true)
			expect(cards[4].minutes).toMatchObject({
				regularMinutes: 240,
				overtimeMinutes: 300,
				paidMinutes: 540,
			})
			// 40h at 20.00 plus 5h at 30.00 = 950.00; Friday alone is 230.00.
			expect(person.money.payMinorByCurrency.USD).toBe(95000)
			expect(cards[4].money.payMinor).toBe(23000)
			expect(cards[0].money.payMinor).toBe(18000)
			expect(period.body.labor).toEqual({
				estimate: true,
				payMinorByCurrency: { USD: 95000 },
				unpricedMinutes: 0,
			})
			expect(person.money.estimate).toBe(true)

			// The cached columns the reports read agree with what the view shows.
			const rows = await (await h.db(ORG_A)).select().from(timeEntries)
			const friday = rows.find((r) => r.id === cards[4].id)!
			expect(friday).toMatchObject({
				regularMinutes: 240,
				overtimeMinutes: 300,
			})
		})

		it('applies daily overtime and double time with their own multipliers', async () => {
			await t.setPolicy(LOC_1, {
				dailyOvertime: { thresholdMinutes: 480, multiplierBp: 15000 },
				dailyDoubleTime: { thresholdMinutes: 720, multiplierBp: 20000 },
			})
			const { staffId } = await t.staff()
			const response = await t.card({
				staffId,
				scopeId: LOC_1,
				date: '2026-03-02',
				startTime: '06:00',
				endTime: '20:00',
				reason: 'Long day',
			})
			expect(response.body.card.minutes).toMatchObject({
				regularMinutes: 480,
				overtimeMinutes: 240,
				doubleTimeMinutes: 120,
				paidMinutes: 840,
			})
			// 8h x 20 + 4h x 30 + 2h x 40 = 360.00
			expect(response.body.card.money.payMinor).toBe(36000)
		})

		it('pays a holiday at its own rate and keeps it out of the overtime count', async () => {
			await t.setPolicy(LOC_1, {
				weeklyOvertime: { thresholdMinutes: 2400, multiplierBp: 15000 },
				holiday: { dates: ['2026-03-04'], multiplierBp: 20000 },
			})
			const { staffId } = await t.staff()
			await workWeek(staffId)
			const week = await t.get('/timesheets/period?date=2026-03-04')
			const totals = week.body.people[0].totals
			// Wednesday's 9 holiday hours are not regular hours and not counted
			// toward the 40, so only 36h of regular time accrue and nothing is overtime.
			expect(totals).toMatchObject({
				holidayMinutes: 540,
				regularMinutes: 2160,
				overtimeMinutes: 0,
				paidMinutes: 2700,
			})
			// 36h x 20 + 9h x 40 = 1080.00
			expect(week.body.people[0].money.payMinorByCurrency.USD).toBe(108000)
		})

		it('splits a shift that crosses the week boundary between both weeks', async () => {
			await t.setPolicy(LOC_1, {
				weeklyOvertime: { thresholdMinutes: 60, multiplierBp: 15000 },
			})
			const { staffId } = await t.staff()
			const response = await t.card({
				staffId,
				scopeId: LOC_1,
				date: '2026-03-01',
				startTime: '22:00',
				endTime: '04:00',
				reason: 'Sunday close',
			})
			// 2h in the week ending Sunday and 4h in the next, 1h threshold each.
			expect(response.body.card.localDate).toBe('2026-03-01')
			expect(response.body.card.minutes).toMatchObject({
				paidMinutes: 360,
				regularMinutes: 120,
				overtimeMinutes: 240,
			})
			// It belongs to the period of its clock-in date (week of Feb 23).
			const that = await t.get('/timesheets/period?date=2026-03-01')
			expect(that.body.period).toMatchObject({
				start: '2026-02-23',
				end: '2026-03-01',
			})
			expect(that.body.people[0].cards).toHaveLength(1)
			const next = await t.get('/timesheets/period?date=2026-03-02')
			expect(next.body.people).toHaveLength(0)
		})

		it('counts overtime per scope unless the policy aggregates across scopes', async () => {
			const { staffId } = await t.staff({ scopeIds: [LOC_1, LOC_2] })
			const patch = {
				dailyOvertime: { thresholdMinutes: 480, multiplierBp: 15000 },
			}
			await t.setPolicy(LOC_1, {
				...patch,
				aggregateOvertimeAcrossScopes: false,
			})
			await t.setPolicy(LOC_2, {
				...patch,
				aggregateOvertimeAcrossScopes: false,
			})
			await t.card({
				staffId,
				scopeId: LOC_1,
				date: '2026-03-02',
				startTime: '08:00',
				endTime: '13:00',
				reason: 'Morning',
			})
			await t.card({
				staffId,
				scopeId: LOC_2,
				date: '2026-03-02',
				startTime: '13:00',
				endTime: '19:00',
				reason: 'Afternoon',
			})
			const separate = await t.get('/timesheets/day?date=2026-03-02')
			expect(separate.body.totals.overtimeMinutes).toBe(0)

			await t.setPolicy(LOC_1, { aggregateOvertimeAcrossScopes: true })
			await t.setPolicy(LOC_2, { aggregateOvertimeAcrossScopes: true })
			const combined = await t.get('/timesheets/day?date=2026-03-02')
			expect(combined.body.totals).toMatchObject({
				overtimeMinutes: 180,
				regularMinutes: 480,
			})
		})

		it('rounds each person once, so the card figures never drift the total', async () => {
			await t.setPolicy(LOC_1, { weeklyOvertime: null })
			const { staffId } = await t.staff({
				positions: [{ name: 'Cook', rateMinor: 1333 }],
			})
			for (const date of WEEK) {
				await t.card({
					staffId,
					scopeId: LOC_1,
					date,
					startTime: '08:00',
					endTime: '08:20',
					reason: 'Short',
				})
			}
			const period = await t.get('/timesheets/period?date=2026-03-02')
			const person = period.body.people[0]
			// 5 x 20 minutes at 13.33/h = 100 minutes = 22.216...; one rounding.
			expect(person.money.payMinorByCurrency.USD).toBe(2222)
			expect(period.body.labor.payMinorByCurrency.USD).toBe(2222)
			expect(person.cards[0].money.payMinor).toBe(444)
		})

		it('leaves a card with no rate unpriced and says so, instead of costing it at zero', async () => {
			const { staffId } = await t.staff({
				positions: [{ name: 'Cook', rateMinor: null, payType: 'salary' }],
			})
			const response = await t.card({
				staffId,
				scopeId: LOC_1,
				date: '2026-03-02',
				startTime: '08:00',
				endTime: '12:00',
				reason: 'Salaried',
			})
			expect(response.body.card.money.payMinor).toBeNull()
			const view = await t.get('/timesheets/day?date=2026-03-02')
			expect(view.body.labor).toEqual({
				estimate: true,
				payMinorByCurrency: {},
				unpricedMinutes: 240,
			})
		})

		it('never reprices history when the rate changes later', async () => {
			const { staffId } = await t.staff()
			const first = await t.card({
				staffId,
				scopeId: LOC_1,
				date: '2026-03-02',
				startTime: '08:00',
				endTime: '16:00',
				reason: 'Before the raise',
			})
			const db = await h.db(ORG_A)
			const { staffJobs } = await import('@repo/tenant-db')
			// Rates are effective-dated: close the old row, open a new one.
			const [old] = await db
				.select()
				.from(staffJobs)
				.where(eq(staffJobs.staffId, staffId))
			await db
				.update(staffJobs)
				.set({ effectiveTo: '2026-03-02' })
				.where(eq(staffJobs.id, old!.id))
			await db.insert(staffJobs).values({
				staffId,
				scopeId: LOC_1,
				positionId: old!.positionId,
				payType: 'hourly',
				rateMinor: 5000,
				currency: 'USD',
				isPrimary: true,
				effectiveFrom: '2026-03-03',
			})
			const second = await t.card({
				staffId,
				scopeId: LOC_1,
				date: '2026-03-03',
				startTime: '08:00',
				endTime: '16:00',
				reason: 'After the raise',
			})
			expect(first.body.card.money.payMinor).toBe(16000)
			expect(second.body.card.money.payMinor).toBe(40000)
			const view = await t.get('/timesheets/day?date=2026-03-02')
			expect(view.body.people[0].cards[0].money.payMinor).toBe(16000)
		})

		it('flags an approved card whose figures moved because a neighbouring card changed', async () => {
			await t.setPolicy(LOC_1, {
				dailyOvertime: { thresholdMinutes: 480, multiplierBp: 15000 },
				timesheetApprovalMode: 'approve',
			})
			const { staffId } = await t.staff()
			const eight = await t.card({
				staffId,
				scopeId: LOC_1,
				date: '2026-03-02',
				startTime: '08:00',
				endTime: '16:00',
				reason: 'Shift',
			})
			await t.send('POST', '/timesheets/approve', {
				entries: [{ id: eight.body.card.id, version: 1 }],
			})
			await t.card({
				staffId,
				scopeId: LOC_1,
				date: '2026-03-02',
				startTime: '05:00',
				endTime: '07:00',
				reason: 'Earlier prep the same day',
			})
			const day = await t.get('/timesheets/day?date=2026-03-02')
			const approved = day.body.people[0].cards.find(
				(c: any) => c.status === 'approved',
			)
			expect(approved.figuresChanged).toBe(true)
			expect(approved.minutes.overtimeMinutes).toBe(120)
			// The frozen columns were not rewritten behind the approver's back.
			const row = (
				await (
					await h.db(ORG_A)
				)
					.select()
					.from(timeEntries)
					.where(eq(timeEntries.id, approved.id))
			)[0]!
			expect(row.overtimeMinutes).toBe(0)
		})
	})

	describe('pay periods', () => {
		it('defaults to the workweek and reports the neighbouring periods', async () => {
			const settings = await t.get('/timesheets/settings')
			expect(settings.body).toMatchObject({
				payPeriod: 'weekly',
				payPeriodAnchor: null,
			})
			const period = await t.get('/timesheets/period?date=2026-03-11')
			expect(period.body.period).toEqual({
				type: 'weekly',
				start: '2026-03-09',
				end: '2026-03-15',
				days: 7,
				previousStart: '2026-03-02',
				nextStart: '2026-03-16',
			})
		})

		it('follows a Sunday workweek when the scope says so', async () => {
			await t.setPolicy(LOC_1, { weekStartsOn: 0 })
			const period = await t.get(
				`/timesheets/period?date=2026-03-11&scopeId=${LOC_1}`,
			)
			expect(period.body.period).toMatchObject({
				start: '2026-03-08',
				end: '2026-03-14',
			})
		})

		it('saves a biweekly cadence with an anchor and navigates by period start', async () => {
			const saved = await t.send('PUT', '/timesheets/settings', {
				payPeriod: 'biweekly',
				payPeriodAnchor: '2026-03-02',
			})
			expect(saved.status).toBe(200)
			expect(saved.body.current.type).toBe('biweekly')
			const period = await t.get('/timesheets/period?periodStart=2026-03-16')
			expect(period.status).toBe(200)
			expect(period.body.period).toMatchObject({
				start: '2026-03-16',
				end: '2026-03-29',
				previousStart: '2026-03-02',
				nextStart: '2026-03-30',
			})
			const bad = await t.get('/timesheets/period?periodStart=2026-03-17')
			expect(bad.status).toBe(422)
			expect(bad.body.error).toBe('invalid_pay_period')
			const audit = await (
				await h.db(ORG_A)
			)
				.select()
				.from(staffAuditLog)
				.where(eq(staffAuditLog.action, 'timesheet.pay_period.updated'))
			expect(audit).toHaveLength(1)
		})

		it('supports semimonthly and monthly cadences', async () => {
			await t.send('PUT', '/timesheets/settings', {
				payPeriod: 'semimonthly',
				payPeriodAnchor: null,
			})
			const first = await t.get('/timesheets/period?date=2026-03-11')
			expect(first.body.period).toMatchObject({
				start: '2026-03-01',
				end: '2026-03-15',
			})
			const second = await t.get('/timesheets/period?date=2026-03-20')
			expect(second.body.period).toMatchObject({
				start: '2026-03-16',
				end: '2026-03-31',
			})
			await t.send('PUT', '/timesheets/settings', {
				payPeriod: 'monthly',
				payPeriodAnchor: '2026-01-10',
			})
			const monthly = await t.get('/timesheets/period?date=2026-03-11')
			expect(monthly.body.period).toMatchObject({
				start: '2026-03-10',
				end: '2026-04-09',
			})
		})

		it('refuses anchors a cadence cannot use, and changes by anyone but a labor policy editor', async () => {
			const bad = await t.send('PUT', '/timesheets/settings', {
				payPeriod: 'monthly',
				payPeriodAnchor: '2026-01-31',
			})
			expect(bad.status).toBe(422)
			expect(bad.body.error).toBe('invalid_pay_period')
			const readOnly = await t.send(
				'PUT',
				'/timesheets/settings',
				{ payPeriod: 'weekly', payPeriodAnchor: null },
				{ grants: TS_APPROVE },
			)
			expect(readOnly.status).toBe(403)
			const scoped = await t.send(
				'PUT',
				'/timesheets/settings',
				{ payPeriod: 'weekly', payPeriodAnchor: null },
				{ scopeIds: [LOC_1] },
			)
			expect(scoped.status).toBe(403)
			expect(scoped.body.error).toBe('unrestricted_scope_required')
			for (const body of [
				{ payPeriod: 'daily', payPeriodAnchor: null },
				{ payPeriod: 'weekly', payPeriodAnchor: '2026-02-30' },
				{ payPeriod: 'weekly' },
			]) {
				expect((await t.send('PUT', '/timesheets/settings', body)).status).toBe(
					400,
				)
			}
			// The view tolerates a cadence whose anchor no longer fits.
			const db = await h.db(ORG_A)
			const { staffingSettings } = await import('@repo/tenant-db')
			await db
				.update(staffingSettings)
				.set({ payPeriod: 'monthly', payPeriodAnchor: '2026-01-31' })
				.where(eq(staffingSettings.id, 'org'))
			expect((await t.get('/timesheets/period?date=2026-03-11')).status).toBe(
				200,
			)
		})
	})

	describe('day and period views', () => {
		it('filters by scope, position, person and status, and echoes the filters', async () => {
			const a = await t.staff({ firstName: 'Ana', lastName: 'Zed' })
			const b = await t.staff({
				firstName: 'Bo',
				lastName: 'Aaron',
				scopeIds: [LOC_2],
				positions: [{ name: 'Host', rateMinor: 1400 }],
			})
			const base = {
				date: '2026-03-02',
				startTime: '09:00',
				endTime: '13:00',
				reason: 'Shift',
			}
			await t.card({ ...base, staffId: a.staffId, scopeId: LOC_1 })
			await t.card({ ...base, staffId: b.staffId, scopeId: LOC_2 })

			const all = await t.get('/timesheets/day?date=2026-03-02')
			// Ordered by last name.
			expect(all.body.people.map((p: any) => p.lastName)).toEqual([
				'Aaron',
				'Zed',
			])
			expect(all.body.totals).toMatchObject({ cards: 2, paidMinutes: 480 })
			const byScope = await t.get(
				`/timesheets/day?date=2026-03-02&scopeId=${LOC_2}`,
			)
			expect(byScope.body.people.map((p: any) => p.staffId)).toEqual([
				b.staffId,
			])
			expect(byScope.body.filters).toMatchObject({
				scopeId: LOC_2,
				status: null,
			})
			const byPosition = await t.get(
				`/timesheets/day?date=2026-03-02&positionId=${a.positionIds[0]}`,
			)
			expect(byPosition.body.people.map((p: any) => p.staffId)).toEqual([
				a.staffId,
			])
			const byStaff = await t.get(
				`/timesheets/day?date=2026-03-02&staffId=${b.staffId}`,
			)
			expect(byStaff.body.totals.cards).toBe(1)
			const none = await t.get(
				'/timesheets/day?date=2026-03-02&status=approved',
			)
			expect(none.body.people).toEqual([])
			expect(none.body.totals.cards).toBe(0)
			const closed = await t.get(
				'/timesheets/day?date=2026-03-02&status=closed',
			)
			expect(closed.body.totals.cards).toBe(2)
		})

		it('only includes cards whose business date is in the period', async () => {
			const { staffId } = await t.staff()
			for (const date of [
				'2026-03-01',
				'2026-03-02',
				'2026-03-08',
				'2026-03-09',
			]) {
				await t.card({
					staffId,
					scopeId: LOC_1,
					date,
					startTime: '09:00',
					endTime: '10:00',
					reason: 'Shift',
				})
			}
			const period = await t.get('/timesheets/period?date=2026-03-04')
			expect(period.body.people[0].cards.map((c: any) => c.localDate)).toEqual([
				'2026-03-02',
				'2026-03-08',
			])
		})

		it('rejects malformed queries without echoing them', async () => {
			for (const path of [
				'/timesheets/day',
				'/timesheets/day?date=2026-13-40',
				'/timesheets/day?date=2026-03-02&status=paid',
				'/timesheets/day?date=2026-03-02&scopeId=../../etc',
				'/timesheets/day?date=2026-03-02&unknown=1',
				'/timesheets/period?date=2026-03-02&periodStart=2026-03-02',
				'/timesheets/review?lookbackDays=100000',
				'/timesheets/export?kind=everything',
			]) {
				const response = await t.get(path)
				expect(response.status, path).toBe(400)
				expect(response.raw).not.toContain('etc')
			}
		})
	})

	describe('payroll summary', () => {
		async function twoPeople() {
			await t.setPolicy(LOC_1, {
				weeklyOvertime: { thresholdMinutes: 2400, multiplierBp: 15000 },
				timesheetApprovalMode: 'approve',
			})
			const a = await t.staff({ firstName: 'Ana', lastName: 'Adams' })
			const b = await t.staff({
				firstName: 'Bo',
				lastName: 'Baker',
				positions: [{ name: 'Host', rateMinor: 1500 }],
			})
			const cards = await workWeek(a.staffId)
			await t.card({
				staffId: b.staffId,
				scopeId: LOC_1,
				date: '2026-03-02',
				startTime: '10:00',
				endTime: '14:00',
				cashTipsMinor: 3000,
				creditTipsMinor: 1000,
				reason: 'Shift',
			})
			return { a, b, cards }
		}

		it('totals regular, overtime, paid hours, rate and tips by person', async () => {
			const { a, b } = await twoPeople()
			const summary = await t.get('/timesheets/summary?date=2026-03-04')
			expect(summary.status).toBe(200)
			expect(summary.body.period).toMatchObject({
				start: '2026-03-02',
				end: '2026-03-08',
			})
			const [ana, bo] = summary.body.rows
			expect(ana).toMatchObject({
				staffId: a.staffId,
				regularMinutes: 2400,
				overtimeMinutes: 300,
				paidMinutes: 2700,
				cards: 5,
				unapprovedCards: 5,
				money: {
					estimate: true,
					ratesMinor: [{ currency: 'USD', rateMinor: 2000 }],
					payMinorByCurrency: { USD: 95000 },
				},
			})
			expect(bo).toMatchObject({
				staffId: b.staffId,
				regularMinutes: 240,
				paidMinutes: 240,
				money: {
					cashTipsMinorByCurrency: { USD: 3000 },
					creditTipsMinorByCurrency: { USD: 1000 },
					payMinorByCurrency: { USD: 6000 },
				},
			})
			expect(summary.body.totals).toMatchObject({
				cards: 6,
				paidMinutes: 2940,
				unapprovedCards: 6,
			})
			expect(summary.body.readyForPayroll).toBe(false)
			expect(summary.body.labor.payMinorByCurrency.USD).toBe(101000)
		})

		it('becomes ready for payroll once every card is approved', async () => {
			await twoPeople()
			const view = await t.get('/timesheets/period?date=2026-03-04')
			const entries = view.body.people.flatMap((p: any) =>
				p.cards.map((c: any) => ({ id: c.id, version: c.version })),
			)
			const approved = await t.send('POST', '/timesheets/approve', { entries })
			expect(approved.body).toMatchObject({ changed: 6, skipped: 0 })
			const summary = await t.get('/timesheets/summary?date=2026-03-04')
			expect(summary.body.readyForPayroll).toBe(true)
			expect(summary.body.totals.unapprovedCards).toBe(0)
		})

		it('does not hold payroll for approval at a scope where approval is off', async () => {
			const { staffId } = await t.staff()
			await t.card({
				staffId,
				scopeId: LOC_1,
				date: '2026-03-02',
				startTime: '09:00',
				endTime: '10:00',
				reason: 'Shift',
			})
			const summary = await t.get('/timesheets/summary?date=2026-03-02')
			expect(summary.body.readyForPayroll).toBe(true)
		})

		it('leaves money out without the pay grant, and gives only the aggregate with the labor grant', async () => {
			await twoPeople()
			const hours = await t.get('/timesheets/summary?date=2026-03-04', {
				grants: TS_VIEW,
			})
			expect(hours.status).toBe(200)
			expect(hours.body.labor).toBeUndefined()
			for (const row of hours.body.rows) expect(row.money).toBeUndefined()
			expect(hours.raw).not.toMatch(
				/payMinor|rateMinor|cashTips|creditTips|"money"/,
			)

			const labor = await t.get('/timesheets/summary?date=2026-03-04', {
				grants: [...TS_VIEW, P.READ_LABOR],
			})
			expect(labor.body.labor.payMinorByCurrency.USD).toBe(101000)
			for (const row of labor.body.rows) expect(row.money).toBeUndefined()
			expect(labor.raw).not.toMatch(/rateMinor|cashTips|creditTips|"money"/)
		})
	})

	describe('export', () => {
		it('exports cards as formula-safe CSV and data rows', async () => {
			const { staffId } = await t.staff({
				firstName: '=HYPERLINK("http://evil.test","x")',
				lastName: '+SUM(1+1)',
			})
			await t.card({
				staffId,
				scopeId: LOC_1,
				date: '2026-03-02',
				startTime: '09:00',
				endTime: '17:00',
				managerNote: '@cmd|calc',
				cashTipsMinor: 500,
				reason: 'Shift',
			})
			const exported = await t.get(
				'/timesheets/export?date=2026-03-02&kind=cards',
			)
			expect(exported.status).toBe(200)
			expect(exported.body).toMatchObject({
				filename: 'time-cards_2026-03-02_2026-03-08.csv',
				kind: 'cards',
				rowCount: 1,
				includesMoney: true,
			})
			const csv: string = exported.body.csv
			expect(csv.charCodeAt(0)).toBe(0xfeff)
			const lines = csv.trim().split('\r\n')
			expect(lines).toHaveLength(2)
			expect(lines[1]).toContain(`"'=HYPERLINK(""http://evil.test"",""x"")"`)
			expect(lines[1]).toContain("'+SUM(1+1)")
			expect(lines[1]).toContain("'@cmd|calc")
			// The data rows are safe on their own, and re-neutralizing changes nothing.
			for (const cell of exported.body.rows[0]) {
				if (typeof cell === 'string') expect(cell).not.toMatch(/^[=+\-@\t\r]/)
			}
			expect(exported.body.headers).toContain('Estimated pay')
			expect(exported.body.rows[0]).toContain(160)
			expect(exported.body.rows[0]).toContain(5)
			const audit = await (
				await h.db(ORG_A)
			)
				.select()
				.from(staffAuditLog)
				.where(eq(staffAuditLog.action, 'timesheet.exported'))
			expect(audit).toHaveLength(1)
			expect(audit[0]).toMatchObject({
				sensitivity: 'pay',
				actorId: 'operator-1',
			})
			expect(audit[0]!.changes).toMatchObject({
				kind: 'cards',
				rows: 1,
				includesMoney: true,
			})
		})

		it('drops every money column without the pay grant', async () => {
			const { staffId } = await t.staff()
			await t.card({
				staffId,
				scopeId: LOC_1,
				date: '2026-03-02',
				startTime: '09:00',
				endTime: '17:00',
				cashTipsMinor: 500,
				reason: 'Shift',
			})
			for (const kind of ['cards', 'summary']) {
				const exported = await t.get(
					`/timesheets/export?date=2026-03-02&kind=${kind}`,
					{
						grants: [...TS_VIEW, P.READ_LABOR],
					},
				)
				expect(exported.status).toBe(200)
				expect(exported.body.includesMoney).toBe(false)
				expect(exported.body.headers.join(',')).not.toMatch(
					/pay|rate|tips|Currency/i,
				)
				expect(exported.body.csv).not.toMatch(/160|500|20\.00|5\.00/)
			}
			const audit = await (
				await h.db(ORG_A)
			)
				.select()
				.from(staffAuditLog)
				.where(eq(staffAuditLog.action, 'timesheet.exported'))
			expect(audit.every((a) => a.sensitivity === 'standard')).toBe(true)
		})

		it('exports the payroll summary with one row per person', async () => {
			const { staffId } = await t.staff({ firstName: 'Ana', lastName: 'Adams' })
			await workWeek(staffId)
			const exported = await t.get(
				'/timesheets/export?date=2026-03-02&kind=summary',
			)
			expect(exported.body).toMatchObject({
				filename: 'payroll-summary_2026-03-02_2026-03-08.csv',
				rowCount: 1,
			})
			expect(exported.body.rows[0]).toContain(45)
			expect(exported.body.rows[0]).toContain('USD')
			expect(exported.body.rows[0]).toContain(900)
		})

		it("limits the export to the token's scopes", async () => {
			const a = await t.staff({ firstName: 'Ana' })
			const b = await t.staff({ firstName: 'Bo', scopeIds: [LOC_2] })
			const base = {
				date: '2026-03-02',
				startTime: '09:00',
				endTime: '10:00',
				reason: 'Shift',
			}
			await t.card({ ...base, staffId: a.staffId, scopeId: LOC_1 })
			await t.card({ ...base, staffId: b.staffId, scopeId: LOC_2 })
			const exported = await t.get('/timesheets/export?date=2026-03-02', {
				scopeIds: [LOC_1],
			})
			expect(exported.body.rowCount).toBe(1)
			expect(exported.body.csv).toContain('Ana')
			expect(exported.body.csv).not.toContain('Bo')
			expect(exported.body.csv).not.toContain(LOC_2)
		})
	})

	describe('pay reads are audited', () => {
		it('writes one audit row for a view that disclosed money, and none for one that did not', async () => {
			const { staffId } = await t.staff()
			await t.card({
				staffId,
				scopeId: LOC_1,
				date: '2026-03-02',
				startTime: '09:00',
				endTime: '17:00',
				reason: 'Shift',
			})
			const db = await h.db(ORG_A)
			const reads = () =>
				db
					.select()
					.from(staffAuditLog)
					.where(eq(staffAuditLog.action, 'timesheet.pay.read'))
			await t.get('/timesheets/day?date=2026-03-02', { grants: TS_VIEW })
			expect(await reads()).toHaveLength(0)
			await t.get('/timesheets/day?date=2026-03-02')
			const rows = await reads()
			expect(rows).toHaveLength(1)
			expect(rows[0]).toMatchObject({
				sensitivity: 'pay',
				actorId: 'operator-1',
			})
			expect(rows[0]!.changes).toMatchObject({ view: 'day', cards: 1 })
		})
	})
})
