import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { laborFixture, type LaborFixture } from '../../tests/labor-harness.ts'
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
	LOC_1,
	LOC_2,
	ORG_A,
	SCH_EDIT,
	SCH_LABOR,
	SCH_PAY,
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

const orders = createFakeOrderSource(LOC_1)

describe('forecast against the schedule, and the sales source in the week footer', () => {
	let h: ClockHarness
	let s: ScheduleFixture
	let l: LaborFixture

	async function order(atMs: number, overrides: FakeOrderOverrides = {}) {
		orders.add(atMs, overrides)
	}

	/** Eight past Mondays (Jan 5 to Feb 23): 20 orders at 12:30 and 10 at 18:15. */
	async function seedMondays() {
		for (let i = 0; i < 8; i++) {
			const day = new Date(Date.UTC(2026, 0, 5 + 7 * i))
				.toISOString()
				.slice(0, 10)
			for (let n = 0; n < 20; n++) await order(at(day, '12:30'))
			for (let n = 0; n < 10; n++) await order(at(day, '18:15'))
		}
	}

	beforeEach(async () => {
		orders.clear()
		registerOrderSource(orders.source)
		orgs.clear()
		orgs.set(ORG_A, makeOrg(ORG_A))
		facts.clear()
		facts.set(LOC_1, { name: 'Downtown', timeZone: CHI })
		facts.set(LOC_2, { name: 'Airport', timeZone: CHI })
		h = await createClockHarness([ORG_A])
		s = scheduleFixture(h)
		l = laborFixture(h)
		h.setClock(at('2026-03-02', '12:00'))
	})
	afterEach(async () => {
		registerOrderSource(null)
		await h.cleanup()
	})

	const FORECAST = `/forecast?scopeId=${LOC_1}&date=2026-03-09`

	describe('forecast gap', () => {
		it('compares the median hour against who is scheduled, hour by hour, by hand', async () => {
			await seedMondays()
			const a = await s.staff()
			const b = await s.staff()
			// A cook handles 10 orders an hour.
			const standard = await l.send('PUT', '/settings', {
				scopeId: LOC_1,
				ordersPerLaborHour: { [a.positionIds[0]!]: 10 },
			})
			expect(standard.status).toBe(200)
			await s.shift({
				staffId: a.staffId,
				positionId: a.positionIds[0]!,
				date: '2026-03-09',
				start: '11:00',
				end: '15:00',
			})
			await s.shift({
				staffId: b.staffId,
				positionId: a.positionIds[0]!,
				date: '2026-03-09',
				start: '12:00',
				end: '13:00',
			})
			// Fifteen orders are already booked for 18:00 next Monday; one is cancelled.
			for (let n = 0; n < 15; n++) {
				await order(at('2026-03-02', '10:00'), {
					scheduledFor: new Date(at('2026-03-09', '18:20')),
				})
			}
			await order(at('2026-03-02', '10:00'), {
				scheduledFor: new Date(at('2026-03-09', '18:20')),
				status: 'cancelled',
			})

			const res = await s.get(FORECAST, { grants: SCH_LABOR })
			expect(res.status).toBe(200)
			expect(res.body).toMatchObject({
				kind: 'forecast_gap',
				estimate: true,
				method: 'median_orders_per_labor_hour',
				source: 'online_orders',
				configured: true,
				timeZone: CHI,
				weeks: 8,
			})
			const monday = res.body.days[0]
			expect(monday.date).toBe('2026-03-09')
			const hour = (n: number) => monday.hours[n]
			// 11:00: no orders, one cook: a surplus of one.
			expect(hour(11)).toMatchObject({
				orders: 0,
				needed: 0,
				scheduled: 1,
				surplus: 1,
				status: 'over',
			})
			// 12:00: 20 orders need two cooks, and two are there.
			expect(hour(12)).toMatchObject({
				orders: 20,
				needed: 2,
				scheduled: 2,
				short: 0,
				surplus: 0,
				status: 'ok',
			})
			// 13:00 and 14:00: one cook with nothing to cook.
			expect(hour(13)).toMatchObject({ scheduled: 1, status: 'over' })
			// 18:00: the median is 10, but 15 are booked: two cooks needed, none scheduled.
			expect(hour(18)).toMatchObject({
				orders: 15,
				booked: 15,
				needed: 2,
				scheduled: 0,
				short: 2,
				status: 'short',
			})
			expect(monday).toMatchObject({
				neededHours: 4,
				scheduledHours: 5,
				shortHours: 2,
				surplusHours: 3,
			})
			expect(monday.byPosition).toEqual([
				{
					positionId: a.positionIds[0],
					ordersPerLaborHour: 10,
					neededHours: 4,
					scheduledHours: 5,
				},
			])
			// People are counted, not named; there is no money in it.
			expect(res.raw).not.toContain(a.staffId)
			expect(res.raw).not.toMatch(/cost|sales|rate|Minor/i)
		})

		it('does not count open shifts or positionless shifts as cover, and drafts do count', async () => {
			await seedMondays()
			const a = await s.staff()
			await l.send('PUT', '/settings', {
				scopeId: LOC_1,
				ordersPerLaborHour: { [a.positionIds[0]!]: 10 },
			})
			await s.shift({
				staffId: null,
				positionId: a.positionIds[0]!,
				date: '2026-03-09',
				start: '12:00',
				end: '14:00',
			})
			await s.shift({
				staffId: a.staffId,
				positionId: null,
				date: '2026-03-09',
				start: '12:00',
				end: '14:00',
			})
			let res = await s.get(FORECAST, { grants: SCH_LABOR })
			expect(res.body.days[0].hours[12]).toMatchObject({
				scheduled: 0,
				short: 2,
				status: 'short',
			})
			expect(res.body.days[0].unpositionedHours).toBe(2)
			// A draft shift (never published) counts: the point is to see the gap early.
			await s.shift({
				staffId: a.staffId,
				positionId: a.positionIds[0]!,
				date: '2026-03-09',
				start: '12:00',
				end: '14:00',
			})
			res = await s.get(FORECAST, { grants: SCH_LABOR })
			expect(res.body.days[0].hours[12].scheduled).toBe(1)
		})

		it('says nothing is configured until a position has a standard', async () => {
			await seedMondays()
			const res = await s.get(FORECAST, { grants: SCH_LABOR })
			expect(res.status).toBe(200)
			expect(res.body.configured).toBe(false)
			expect(
				res.body.days[0].hours.every((slot: any) => slot.status === 'quiet'),
			).toBe(true)
			expect(res.body.days[0].hours[12].orders).toBe(20)
		})

		it('is behind the labor grant, so it is behind the staffing.labor flag', async () => {
			expect((await s.get(FORECAST, { grants: SCH_EDIT })).status).toBe(403)
			expect((await s.get(FORECAST, { token: null })).status).toBe(401)
			expect(
				(await s.get(FORECAST, { grants: SCH_LABOR, scope: 'labor' })).status,
			).toBe(403)
			expect((await s.get(FORECAST, { grants: SCH_PAY })).status).toBe(200)
		})

		it('hides a scope outside the token scope and rejects a malformed request', async () => {
			expect(
				(await s.get(FORECAST, { grants: SCH_LABOR, scopeIds: [LOC_2] }))
					.status,
			).toBe(404)
			expect(
				(await s.get(`/forecast?scopeId=${LOC_1}`, { grants: SCH_LABOR }))
					.status,
			).toBe(400)
			expect(
				(
					await s.get(`/forecast?scopeId=${LOC_1}&date=2026-03-09&x=1`, {
						grants: SCH_LABOR,
					})
				).status,
			).toBe(400)
		})

		it('is deterministic: the same week reads the same twice', async () => {
			await seedMondays()
			const a = await s.staff()
			await l.send('PUT', '/settings', {
				scopeId: LOC_1,
				ordersPerLaborHour: { [a.positionIds[0]!]: 10 },
			})
			await s.shift({
				staffId: a.staffId,
				positionId: a.positionIds[0]!,
				date: '2026-03-09',
				start: '12:00',
				end: '14:00',
			})
			const first = await s.get(FORECAST, { grants: SCH_LABOR })
			const second = await s.get(FORECAST, { grants: SCH_LABOR })
			expect(second.body).toEqual(first.body)
		})
	})

	describe('week footer labor target by sales source', () => {
		async function scheduleWeek() {
			const a = await s.staff()
			await s.shift({
				staffId: a.staffId,
				positionId: a.positionIds[0]!,
				date: '2026-03-09',
				start: '09:00',
				end: '17:00',
			})
			return a
		}
		const WEEK = `/week?scopeId=${LOC_1}&date=2026-03-09`

		it('judges the week against a target once the scope enters its own sales', async () => {
			await scheduleWeek()
			await s.setPolicy(LOC_1, { laborTargetBp: 2000 })
			// Three Mondays of entered sales: median $1,000. One cook for eight hours is $160.
			const saved = await l.send('POST', '/sales/bulk', {
				scopeId: LOC_1,
				currency: 'USD',
				entries: [
					{ date: '2026-02-09', netSalesMinor: 80_000 },
					{ date: '2026-02-16', netSalesMinor: 120_000 },
					{ date: '2026-02-23', netSalesMinor: 100_000 },
				],
			})
			expect(saved.status).toBe(200)
			await l.send('PUT', '/settings', {
				scopeId: LOC_1,
				salesSource: 'manual',
			})

			const week = await s.get(WEEK, { grants: SCH_PAY })
			expect(week.status).toBe(200)
			const target = week.body.laborTarget
			expect(target).toMatchObject({
				targetBp: 2000,
				salesSource: 'manual',
				salesComplete: true,
				targetColoring: true,
			})
			expect(target.currencies).toEqual([
				{
					currency: 'USD',
					costMinor: 16_000,
					guideSalesMinor: 100_000,
					laborBp: 1600,
					allowedCostMinor: 20_000,
					targetStatus: 'within',
				},
			])
			expect(target.days[0]).toEqual({
				date: '2026-03-09',
				guideSalesMinorByCurrency: { USD: 100_000 },
			})
			// Tuesday through Sunday have no entered weekday to learn from.
			expect(target.days[1].guideSalesMinorByCurrency).toEqual({})
		})

		it('shows the share but never judges it while only online orders are counted', async () => {
			await scheduleWeek()
			await s.setPolicy(LOC_1, { laborTargetBp: 2000 })
			await l.send('PUT', '/settings', {
				scopeId: LOC_1,
				salesSource: 'online_orders',
			})
			await seedMondays()
			const week = await s.get(WEEK, { grants: SCH_PAY })
			const target = week.body.laborTarget
			expect(target).toMatchObject({
				salesSource: 'online_orders',
				salesComplete: false,
				targetColoring: false,
			})
			// 30 orders of $10 net a Monday: $300 guide sales, $160 of wages.
			expect(target.currencies[0]).toMatchObject({
				costMinor: 16_000,
				guideSalesMinor: 30_000,
				laborBp: 5333,
			})
			expect(week.raw).not.toContain('targetStatus')
		})

		it('keeps the labor target out of a token without the labor grant', async () => {
			await scheduleWeek()
			const week = await s.get(WEEK, { grants: SCH_EDIT })
			expect(week.body).not.toHaveProperty('laborTarget')
		})
	})
})
