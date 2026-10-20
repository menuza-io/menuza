import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STAFFING_PERMISSIONS as P } from '@repo/staffing'
import { staffAuditLog } from '@repo/tenant-db'
import { registerOrderSource } from '../services/order-source.ts'
import {
	createFakeOrderSource,
	type FakeOrderOverrides,
} from '../../tests/order-source.ts'
import { makeOrg, type TestOrg } from '../../tests/staff-harness.ts'
import {
	at,
	CHI,
	createClockHarness,
	LAB_SALES,
	LAB_VIEW,
	laborFixture,
	LOC_1,
	LOC_2,
	ORG_A,
	ORG_B,
	type ClockHarness,
	type LaborFixture,
} from '../../tests/labor-harness.ts'

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

const orders = createFakeOrderSource(LOC_1)

describe('/operator/labor', () => {
	let h: ClockHarness
	let l: LaborFixture

	async function order(atMs: number, overrides: FakeOrderOverrides = {}) {
		orders.add(atMs, overrides)
	}

	beforeEach(async () => {
		orders.clear()
		registerOrderSource(orders.source)
		orgs.clear()
		orgs.set(ORG_A, makeOrg(ORG_A))
		orgs.set(ORG_B, makeOrg(ORG_B))
		facts.clear()
		facts.set(LOC_1, { name: 'Downtown', timeZone: CHI })
		facts.set(LOC_2, { name: 'Airport', timeZone: CHI })
		h = await createClockHarness([ORG_A, ORG_B])
		l = laborFixture(h)
		h.setClock(at('2026-03-10', '12:00'))
	})
	afterEach(async () => {
		registerOrderSource(null)
		await h.cleanup()
	})

	/**
	 * One hand-calculated week (Monday 2026-03-02 to Sunday 03-08), Chicago.
	 * Cook A is paid $20 an hour, Cook B $12.
	 *
	 *   Mon  A 09-17 (8h) $160 + B 10-16 (6h) $72     cost $232  sales $800
	 *   Tue  A 09-17 (8h)                             cost $160  sales $640
	 *   Wed  B 08:00-13:30 (5.5h)                     cost  $66  (no sales entered)
	 *   Thu  nobody                                   cost   $0  sales $500
	 *   Fri  A 09-17 $160 + B 09-17 $96               cost $256  sales $1,280
	 *   Sat  A 09-19 (10h)                            cost $200  sales $1,000
	 */
	async function seedWeek() {
		const a = await l.staff({
			firstName: 'Ana',
			lastName: 'Adams',
			rateMinor: 2000,
		})
		const b = await l.staff({
			firstName: 'Ben',
			lastName: 'Brown',
			rateMinor: 1200,
		})
		const card = async (
			staffId: string,
			date: string,
			startTime: string,
			endTime: string,
			extra: Record<string, unknown> = {},
		) => {
			const response = await l.card({
				staffId,
				scopeId: LOC_1,
				date,
				startTime,
				endTime,
				reason: 'Test week',
				...extra,
			})
			expect(response.status).toBe(201)
		}
		await card(a.staffId, '2026-03-02', '09:00', '17:00')
		await card(b.staffId, '2026-03-02', '10:00', '16:00')
		await card(a.staffId, '2026-03-03', '09:00', '17:00')
		await card(b.staffId, '2026-03-04', '08:00', '13:30')
		await card(a.staffId, '2026-03-06', '09:00', '17:00')
		await card(b.staffId, '2026-03-06', '09:00', '17:00')
		await card(a.staffId, '2026-03-07', '09:00', '19:00')
		return { a, b }
	}

	const WEEK = 'scopeId=loc-1&from=2026-03-02&to=2026-03-08'

	async function enterWeekSales() {
		const response = await l.send('POST', '/sales/bulk', {
			scopeId: LOC_1,
			currency: 'USD',
			entries: [
				{ date: '2026-03-02', netSalesMinor: 80_000 },
				{ date: '2026-03-03', netSalesMinor: 64_000 },
				{ date: '2026-03-05', netSalesMinor: 50_000 },
				{ date: '2026-03-06', netSalesMinor: 128_000 },
				{ date: '2026-03-07', netSalesMinor: 100_000 },
			],
		})
		expect(response.status).toBe(200)
		await l.send('PUT', '/settings', {
			scopeId: LOC_1,
			salesSource: 'manual',
		})
	}

	const usd = (money: any[]) => money.find((m) => m.currency === 'USD')

	describe('the labor summary against a hand calculation', () => {
		it('matches the week to the cent with entered sales, and judges the target', async () => {
			await seedWeek()
			await l.setPolicy(LOC_1, { laborTargetBp: 2200 })
			await enterWeekSales()

			const week = await l.get(`/summary?${WEEK}`)
			expect(week.status).toBe(200)
			const s = week.body
			expect(s).toMatchObject({
				estimate: true,
				scopeId: LOC_1,
				timeZone: CHI,
				salesSource: 'manual',
				salesComplete: true,
				targetBp: 2200,
				targetColoring: true,
				currencyMismatch: null,
				unpricedMinutes: 0,
				openCards: 0,
				truncated: false,
			})
			const [mon, tue, wed, thu, fri, sat, sun] = s.days
			expect(mon).toMatchObject({
				date: '2026-03-02',
				paidMinutes: 840,
				people: 2,
			})
			expect(usd(mon.money)).toMatchObject({
				costMinor: 23_200,
				salesMinor: 80_000,
				laborBp: 2900,
				salesPerLaborHourMinor: 5714,
				targetStatus: 'over',
			})
			expect(usd(tue.money)).toMatchObject({
				costMinor: 16_000,
				salesMinor: 64_000,
				laborBp: 2500,
				salesPerLaborHourMinor: 8000,
				targetStatus: 'over',
			})
			expect(wed).toMatchObject({ paidMinutes: 330, hasSales: false })
			expect(usd(wed.money)).toMatchObject({
				costMinor: 6_600,
				salesMinor: null,
				laborBp: null,
			})
			expect(usd(thu.money)).toMatchObject({
				costMinor: 0,
				salesMinor: 50_000,
				laborBp: 0,
			})
			expect(usd(fri.money)).toMatchObject({
				costMinor: 25_600,
				salesMinor: 128_000,
				laborBp: 2000,
				targetStatus: 'within',
			})
			expect(usd(sat.money)).toMatchObject({
				costMinor: 20_000,
				salesMinor: 100_000,
				laborBp: 2000,
				salesPerLaborHourMinor: 10_000,
			})
			expect(sun).toMatchObject({ paidMinutes: 0, cards: 0, money: [] })

			// Ratio of sums over the five days with sales: $848 / $4,220 = 20.09%.
			expect(s.totals).toMatchObject({
				paidMinutes: 3210,
				cards: 7,
				salesDays: 5,
				daysWithoutSales: 2,
			})
			expect(usd(s.totals.money)).toMatchObject({
				costMinor: 91_400,
				salesMinor: 422_000,
				laborBp: 2009,
				// 2880 paid minutes on the days with sales = 48 hours: $4,220 / 48.
				salesPerLaborHourMinor: 8792,
				targetStatus: 'within',
			})
		})

		it('counts online orders by business date, and never colors against a target', async () => {
			await seedWeek()
			await l.setPolicy(LOC_1, { laborTargetBp: 2200 })
			await l.send('PUT', '/settings', {
				scopeId: LOC_1,
				salesSource: 'online_orders',
			})
			// Online orders source. Monday $800, Friday $1,280 net of tax.
			await order(at('2026-03-02', '12:00'), { subtotalCents: 50_000 })
			await order(at('2026-03-02', '18:30'), { subtotalCents: 30_000 })
			await order(at('2026-03-06', '13:00'), { subtotalCents: 128_000 })
			// Left out: unpaid online, cancelled, another scope, outside the range.
			await order(at('2026-03-02', '19:00'), {
				paymentMethod: 'online',
				paymentStatus: 'pending',
				status: 'accepted',
			})
			await order(at('2026-03-02', '19:05'), { status: 'cancelled' })
			await order(at('2026-03-02', '19:10'), { scopeId: LOC_2 })
			await order(at('2026-03-09', '12:00'), { subtotalCents: 99_999 })

			const week = await l.get(`/summary?${WEEK}`)
			expect(week.status).toBe(200)
			const s = week.body
			expect(s).toMatchObject({
				salesSource: 'online_orders',
				salesComplete: false,
				targetColoring: false,
			})
			expect(usd(s.days[0].money)).toMatchObject({
				costMinor: 23_200,
				salesMinor: 80_000,
				laborBp: 2900,
			})
			expect(usd(s.days[4].money)).toMatchObject({
				salesMinor: 128_000,
				laborBp: 2000,
			})
			// The share is shown, but nothing says "within" or "over".
			expect(week.raw).not.toContain('targetStatus')
			// Every day counts as having sales on an online source.
			expect(s.days.every((d: any) => d.hasSales)).toBe(true)
			expect(s.totals.daysWithoutSales).toBe(0)
		})

		it('colors an online source only once the scope is flagged online-only', async () => {
			await seedWeek()
			await l.setPolicy(LOC_1, { laborTargetBp: 2200 })
			await order(at('2026-03-02', '12:00'), { subtotalCents: 80_000 })
			const set = await l.send('PUT', '/settings', {
				scopeId: LOC_1,
				salesSource: 'online_only',
			})
			expect(set.status).toBe(200)
			const week = await l.get(`/summary?${WEEK}`)
			expect(week.body).toMatchObject({
				salesSource: 'online_only',
				targetColoring: true,
			})
			expect(usd(week.body.days[0].money).targetStatus).toBe('over')
		})

		it('puts an order after midnight on the previous business day when the workday starts later', async () => {
			await l.setPolicy(LOC_1, { workdayStartMinute: 240 })
			await l.send('PUT', '/settings', {
				scopeId: LOC_1,
				salesSource: 'online_orders',
			})
			// 01:30 on Tuesday belongs to Monday's business day.
			await order(at('2026-03-03', '01:30'), { subtotalCents: 7_700 })
			await order(at('2026-03-03', '05:00'), { subtotalCents: 1_100 })
			const week = await l.get(`/summary?${WEEK}`)
			const byDate = Object.fromEntries(
				week.body.days.map((d: any) => [
					d.date,
					usd(d.money)?.salesMinor ?? null,
				]),
			)
			expect(byDate['2026-03-02']).toBe(7_700)
			expect(byDate['2026-03-03']).toBe(1_100)
		})

		it('splits business days exactly at a workday start that is not on a quarter hour', async () => {
			// 04:10: an order at 04:12 is in the bucket that holds 04:00 to 04:15,
			// which straddles the boundary, yet belongs to the new business day.
			await l.setPolicy(LOC_1, { workdayStartMinute: 250 })
			await l.send('PUT', '/settings', {
				scopeId: LOC_1,
				salesSource: 'online_orders',
			})
			await order(at('2026-03-03', '04:05'), { subtotalCents: 7_700 })
			await order(at('2026-03-03', '04:12'), { subtotalCents: 1_100 })
			const week = await l.get(`/summary?${WEEK}`)
			const byDate = Object.fromEntries(
				week.body.days.map((d: any) => [
					d.date,
					usd(d.money)?.salesMinor ?? null,
				]),
			)
			expect(byDate['2026-03-02']).toBe(7_700)
			expect(byDate['2026-03-03']).toBe(1_100)
		})

		it('never adds currencies: wages in SAR and sales in USD are surfaced, not converted', async () => {
			const sar = await l.staff({ currency: 'SAR', rateMinor: 4000 })
			await l.card({
				staffId: sar.staffId,
				scopeId: LOC_1,
				date: '2026-03-02',
				startTime: '09:00',
				endTime: '17:00',
				reason: 'SAR card',
			})
			await l.send('PUT', '/sales', {
				scopeId: LOC_1,
				date: '2026-03-02',
				netSalesMinor: 100_000,
				currency: 'USD',
			})
			await l.send('PUT', '/settings', {
				scopeId: LOC_1,
				salesSource: 'manual',
			})
			const week = await l.get(`/summary?${WEEK}`)
			expect(week.body.currencyMismatch).toEqual({
				costOnly: ['SAR'],
				salesOnly: ['USD'],
			})
			const money = week.body.totals.money
			expect(money.map((m: any) => m.currency)).toEqual(['SAR', 'USD'])
			expect(money.every((m: any) => m.laborBp === null)).toBe(true)
			expect(week.body.targetColoring).toBe(true)
			expect(week.raw).not.toContain('targetStatus')
		})

		it('counts a card that is still open and cards with no pay rate without inventing cost', async () => {
			const unpriced = await l.staff({ rateMinor: 2000 })
			const db = await h.db(ORG_A)
			const { timeEntries } = await import('@repo/tenant-db')
			await l.card({
				staffId: unpriced.staffId,
				scopeId: LOC_1,
				date: '2026-03-02',
				startTime: '09:00',
				endTime: '11:00',
				reason: 'Two hours',
			})
			await db
				.update(timeEntries)
				.set({ rateMinor: null, currency: null })
				.where(eq(timeEntries.staffId, unpriced.staffId))
			const week = await l.get(`/summary?${WEEK}`)
			expect(week.body.unpricedMinutes).toBe(120)
			expect(week.body.days[0]).toMatchObject({ paidMinutes: 120, money: [] })
		})
	})

	describe('export', () => {
		it('names the sales source on every row and totals the week', async () => {
			await seedWeek()
			await enterWeekSales()
			const res = await l.get(`/summary/export?${WEEK}`)
			expect(res.status).toBe(200)
			expect(res.body.filename).toBe('labor-summary_2026-03-02_2026-03-08.csv')
			expect(res.body.csv.startsWith('\uFEFF')).toBe(true)
			expect(res.body.headers).toContain('Sales source')
			const withMoney = res.body.rows.filter((row: any[]) => row[4] === 'USD')
			expect(withMoney.length).toBeGreaterThan(0)
			expect(
				withMoney.every((row: any[]) => row.at(-1) === 'Entered sales'),
			).toBe(true)
			const total = res.body.rows.find((row: any[]) => row[0] === 'Total')
			// 914.00 of wages, 20.09 percent, $87.92 an hour.
			expect(total.slice(4)).toEqual([
				'USD',
				914,
				4220,
				20.09,
				87.92,
				'Entered sales',
			])
			const audit = await (await h.db(ORG_A)).select().from(staffAuditLog)
			expect(audit.some((row) => row.action === 'labor.exported')).toBe(true)
		})
	})

	describe('settings', () => {
		it('starts on manual sales with no standards, then saves and audits a change', async () => {
			const before = await l.get(`/settings?scopeId=${LOC_1}`)
			expect(before.body).toEqual({
				scopeId: LOC_1,
				salesSource: 'manual',
				ordersPerLaborHour: {},
				configured: false,
				updatedAt: null,
			})
			const cook = await l.staff()
			const saved = await l.send('PUT', '/settings', {
				scopeId: LOC_1,
				salesSource: 'online_orders',
				ordersPerLaborHour: { [cook.positionId]: 12.5 },
			})
			expect(saved.status).toBe(200)
			expect(saved.body).toMatchObject({
				salesSource: 'online_orders',
				ordersPerLaborHour: { [cook.positionId]: 12.5 },
				configured: true,
			})
			const after = await l.get(`/settings?scopeId=${LOC_1}`)
			expect(after.body.salesSource).toBe('online_orders')
			const audit = await (await h.db(ORG_A)).select().from(staffAuditLog)
			const row = audit.find((r) => r.action === 'labor.settings.updated')
			expect(row).toMatchObject({ scopeId: LOC_1, entityId: LOC_1 })
			expect(row!.changes).toMatchObject({
				salesSource: { before: 'manual', after: 'online_orders' },
			})
		})

		it('keeps what a partial update does not name', async () => {
			const cook = await l.staff()
			await l.send('PUT', '/settings', {
				scopeId: LOC_1,
				salesSource: 'manual',
				ordersPerLaborHour: { [cook.positionId]: 10 },
			})
			const next = await l.send('PUT', '/settings', {
				scopeId: LOC_1,
				salesSource: 'online_only',
			})
			expect(next.body).toMatchObject({
				salesSource: 'online_only',
				ordersPerLaborHour: { [cook.positionId]: 10 },
			})
		})

		it('refuses a standard for a position that does not exist', async () => {
			const res = await l.send('PUT', '/settings', {
				scopeId: LOC_1,
				ordersPerLaborHour: { 'nope-1': 10 },
			})
			expect(res.status).toBe(422)
			expect(res.body).toMatchObject({ error: 'unknown_position' })
		})

		it('refuses bad bodies without echoing them', async () => {
			for (const body of [
				{ scopeId: LOC_1 },
				{ scopeId: LOC_1, salesSource: 'pos' },
				{ scopeId: LOC_1, salesSource: 'manual', extra: 1 },
				{ scopeId: '../etc', salesSource: 'manual' },
			]) {
				const res = await l.send('PUT', '/settings', body)
				expect(res.status).toBe(400)
				expect(res.raw).not.toContain('pos')
			}
		})
	})

	describe('positions', () => {
		it('lists active positions by name with no pay, and needs the labor grant', async () => {
			const cook = await l.staff()
			const res = await l.get('/positions', { grants: LAB_VIEW })
			expect(res.status).toBe(200)
			expect(res.body.positions).toEqual([
				{
					id: cook.positionId,
					name: expect.stringContaining('Cook'),
					nameAr: null,
				},
			])
			expect(res.raw).not.toMatch(/rate|Minor|2000/)
			expect(
				(await l.get('/positions', { grants: [P.READ_STAFF] })).status,
			).toBe(403)
			expect((await l.get('/positions', { impersonated: true })).status).toBe(
				403,
			)
		})
	})

	describe('manual sales', () => {
		it('saves a day, replaces it in place, lists it and deletes it, with an audit row each time', async () => {
			const created = await l.send('PUT', '/sales', {
				scopeId: LOC_1,
				date: '2026-03-02',
				netSalesMinor: 120_000,
				currency: 'USD',
				note: 'Rain',
			})
			expect(created.status).toBe(200)
			expect(created.body).toMatchObject({
				date: '2026-03-02',
				netSalesMinor: 120_000,
				source: 'manual',
				note: 'Rain',
			})
			const replaced = await l.send('PUT', '/sales', {
				scopeId: LOC_1,
				date: '2026-03-02',
				netSalesMinor: 130_000,
				currency: 'USD',
			})
			expect(replaced.body.id).toBe(created.body.id)
			expect(replaced.body).toMatchObject({
				netSalesMinor: 130_000,
				note: null,
			})
			const list = await l.get(`/sales?${WEEK}`)
			expect(list.body.entries).toHaveLength(1)
			const del = await l.send(
				'DELETE',
				`/sales?scopeId=${LOC_1}&date=2026-03-02`,
			)
			expect(del.status).toBe(200)
			expect((await l.get(`/sales?${WEEK}`)).body.entries).toEqual([])
			const gone = await l.send(
				'DELETE',
				`/sales?scopeId=${LOC_1}&date=2026-03-02`,
			)
			expect(gone.status).toBe(404)
			const actions = (await (await h.db(ORG_A)).select().from(staffAuditLog))
				.map((r) => r.action)
				.filter((a) => a.startsWith('labor.sales'))
			expect(actions).toEqual([
				'labor.sales.created',
				'labor.sales.updated',
				'labor.sales.deleted',
			])
		})

		it('imports a file in one go and reports created, updated and unchanged days', async () => {
			const entries = [
				{ date: '2026-03-02', netSalesMinor: 100_000 },
				{ date: '2026-03-03', netSalesMinor: 200_000 },
			]
			const first = await l.send('POST', '/sales/bulk', {
				scopeId: LOC_1,
				currency: 'USD',
				entries,
			})
			expect(first.body).toEqual({ created: 2, updated: 0, unchanged: 0 })
			const second = await l.send('POST', '/sales/bulk', {
				scopeId: LOC_1,
				currency: 'USD',
				entries: [
					{ date: '2026-03-02', netSalesMinor: 100_000 },
					{ date: '2026-03-03', netSalesMinor: 250_000 },
					{ date: '2026-03-04', netSalesMinor: 1 },
				],
			})
			expect(second.body).toEqual({ created: 1, updated: 1, unchanged: 1 })
			const list = await l.get(`/sales?${WEEK}`)
			expect(
				list.body.entries.map((e: any) => [e.date, e.netSalesMinor, e.source]),
			).toEqual([
				['2026-03-02', 100_000, 'csv'],
				['2026-03-03', 250_000, 'csv'],
				['2026-03-04', 1, 'csv'],
			])
		})

		it('does not accept a day that has not happened yet, and saves nothing when one row is bad', async () => {
			const future = await l.send('PUT', '/sales', {
				scopeId: LOC_1,
				date: '2026-03-11',
				netSalesMinor: 1,
				currency: 'USD',
			})
			expect(future.status).toBe(422)
			expect(future.body.error).toBe('future_date')
			const bulk = await l.send('POST', '/sales/bulk', {
				scopeId: LOC_1,
				currency: 'USD',
				entries: [
					{ date: '2026-03-02', netSalesMinor: 5 },
					{ date: '2026-03-12', netSalesMinor: 5 },
				],
			})
			expect(bulk.status).toBe(422)
			expect(bulk.body).toMatchObject({
				error: 'future_date',
				dates: ['2026-03-12'],
			})
			expect((await l.get(`/sales?${WEEK}`)).body.entries).toEqual([])
			// Today itself is fine.
			const today = await l.send('PUT', '/sales', {
				scopeId: LOC_1,
				date: '2026-03-10',
				netSalesMinor: 5,
				currency: 'USD',
			})
			expect(today.status).toBe(200)
		})

		it('rejects fractions, negatives, unknown currencies and repeated dates', async () => {
			const base = { scopeId: LOC_1, date: '2026-03-02', currency: 'USD' }
			for (const body of [
				{ ...base, netSalesMinor: 12.5 },
				{ ...base, netSalesMinor: -1 },
				{ ...base, netSalesMinor: 1, currency: 'EUR' },
				{ ...base, netSalesMinor: 1e15 },
			]) {
				expect((await l.send('PUT', '/sales', body)).status).toBe(400)
			}
			const dup = await l.send('POST', '/sales/bulk', {
				scopeId: LOC_1,
				currency: 'USD',
				entries: [
					{ date: '2026-03-02', netSalesMinor: 1 },
					{ date: '2026-03-02', netSalesMinor: 2 },
				],
			})
			expect(dup.status).toBe(400)
		})
	})

	describe('who may do what', () => {
		it('answers 401 without a token and 403 for a token of another scope', async () => {
			expect((await l.get(`/summary?${WEEK}`, { token: null })).status).toBe(
				401,
			)
			const wrongScope = await l.get(`/summary?${WEEK}`, { scope: 'schedule' })
			expect(wrongScope.status).toBe(403)
			const timeclock = await l.get(`/summary?${WEEK}`, { scope: 'timeclock' })
			expect(timeclock.status).toBe(403)
		})

		it('needs the labor grant: hours-only roles get nothing', async () => {
			const grants = [P.READ_STAFF, P.READ_TIMESHEET, P.UPDATE_TIMESHEET]
			for (const path of [
				`/summary?${WEEK}`,
				`/summary/export?${WEEK}`,
				`/sales?${WEEK}`,
				`/settings?scopeId=${LOC_1}`,
			]) {
				const res = await l.get(path, { grants })
				expect(res.status).toBe(403)
				expect(res.body).toMatchObject({ required: P.READ_LABOR })
			}
		})

		it('lets a pay-only token read the aggregate too, since it could add the wages up', async () => {
			const res = await l.get(`/summary?${WEEK}`, {
				grants: [P.READ_STAFF, P.READ_STAFF_PAY, P.READ_LABOR],
			})
			expect(res.status).toBe(200)
		})

		it('keeps settings and daily sales behind their own update grants', async () => {
			const viewOnly = { grants: LAB_VIEW }
			expect(
				(
					await l.send(
						'PUT',
						'/settings',
						{ scopeId: LOC_1, salesSource: 'manual' },
						viewOnly,
					)
				).status,
			).toBe(403)
			// Entering sales is a timesheet-level job, not a policy one.
			const sales = { grants: LAB_SALES }
			expect(
				(
					await l.send(
						'PUT',
						'/sales',
						{
							scopeId: LOC_1,
							date: '2026-03-02',
							netSalesMinor: 5,
							currency: 'USD',
						},
						sales,
					)
				).status,
			).toBe(200)
			expect(
				(
					await l.send(
						'PUT',
						'/settings',
						{ scopeId: LOC_1, salesSource: 'manual' },
						sales,
					)
				).status,
			).toBe(403)
			expect(
				(
					await l.send(
						'PUT',
						'/sales',
						{
							scopeId: LOC_1,
							date: '2026-03-02',
							netSalesMinor: 5,
							currency: 'USD',
						},
						viewOnly,
					)
				).status,
			).toBe(403)
			expect(
				(
					await l.send(
						'DELETE',
						`/sales?scopeId=${LOC_1}&date=2026-03-02`,
						undefined,
						viewOnly,
					)
				).status,
			).toBe(403)
		})

		it('refuses an impersonated (support) session everything, wages included', async () => {
			const opts = { impersonated: true }
			expect((await l.get(`/summary?${WEEK}`, opts)).status).toBe(403)
			expect((await l.get(`/summary/export?${WEEK}`, opts)).status).toBe(403)
			expect((await l.get(`/sales?${WEEK}`, opts)).status).toBe(403)
			expect((await l.get(`/settings?scopeId=${LOC_1}`, opts)).status).toBe(403)
			expect(
				(
					await l.send(
						'PUT',
						'/sales',
						{
							scopeId: LOC_1,
							date: '2026-03-02',
							netSalesMinor: 1,
							currency: 'USD',
						},
						opts,
					)
				).status,
			).toBe(403)
		})

		it('hides a scope outside the token scope on reads (404) and refuses writes naming it (403)', async () => {
			await seedWeek()
			const scoped = { scopeIds: [LOC_2] }
			expect((await l.get(`/summary?${WEEK}`, scoped)).status).toBe(404)
			expect((await l.get(`/sales?${WEEK}`, scoped)).status).toBe(404)
			expect((await l.get(`/settings?scopeId=${LOC_1}`, scoped)).status).toBe(
				404,
			)
			const put = await l.send(
				'PUT',
				'/sales',
				{
					scopeId: LOC_1,
					date: '2026-03-02',
					netSalesMinor: 1,
					currency: 'USD',
				},
				scoped,
			)
			expect(put.status).toBe(403)
			expect(put.body).toMatchObject({ error: 'scope_out_of_scope' })
			expect(
				(
					await l.send(
						'PUT',
						'/settings',
						{ scopeId: LOC_1, salesSource: 'manual' },
						scoped,
					)
				).status,
			).toBe(403)
			// An empty scope sees nothing at all.
			expect((await l.get(`/summary?${WEEK}`, { scopeIds: [] })).status).toBe(
				404,
			)
			// The scope the token covers works, and says nothing of the other one.
			const own = await l.get(
				`/summary?scopeId=${LOC_2}&from=2026-03-02&to=2026-03-08`,
				scoped,
			)
			expect(own.status).toBe(200)
			expect(own.body.totals.cards).toBe(0)
		})

		it("does not read another organization's data", async () => {
			await seedWeek()
			await enterWeekSales()
			const other = await l.get(`/summary?${WEEK}`, { orgId: ORG_B })
			expect(other.status).toBe(200)
			expect(other.body.totals).toMatchObject({ cards: 0, paidMinutes: 0 })
			expect(other.body.salesSource).toBe('manual')
			const sales = await l.get(`/sales?${WEEK}`, { orgId: ORG_B })
			expect(sales.body.entries).toEqual([])
		})

		it('refuses a range that is backwards, too long, or malformed', async () => {
			for (const q of [
				'scopeId=loc-1&from=2026-03-08&to=2026-03-02',
				'scopeId=loc-1&from=2026-01-01&to=2026-06-01',
				'scopeId=loc-1&from=2026-02-30&to=2026-03-02',
				'scopeId=loc-1&from=2026-03-02',
				'from=2026-03-02&to=2026-03-08',
				'scopeId=loc-1&from=2026-03-02&to=2026-03-08&x=1',
			]) {
				expect((await l.get(`/summary?${q}`)).status).toBe(400)
			}
		})

		it('sends no cache headers a shared cache could keep', async () => {
			const res = await l.get(`/summary?${WEEK}`)
			expect(res.headers.get('cache-control')).toBe('private, no-store')
		})
	})
})
