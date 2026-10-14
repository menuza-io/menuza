import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { laborFixture } from '../../tests/labor-harness.ts'
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

describe('demand guide and labor target', () => {
	let h: ClockHarness
	let s: ScheduleFixture

	async function order(atMs: number, overrides: FakeOrderOverrides = {}) {
		orders.add(atMs, overrides)
	}

	/** Eight past Mondays (Jan 5 to Feb 23), `perDay` orders each at 12:30 local. */
	async function seedMondays(perDay: number | number[]) {
		for (let i = 0; i < 8; i++) {
			const day = new Date(Date.UTC(2026, 0, 5 + 7 * i))
				.toISOString()
				.slice(0, 10)
			const count = Array.isArray(perDay) ? perDay[i]! : perDay
			for (let n = 0; n < count; n++) await order(at(day, '12:30'))
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
		h.setClock(at('2026-03-02', '12:00'))
	})
	afterEach(async () => {
		registerOrderSource(null)
		await h.cleanup()
	})

	it('reports the median counted orders for each weekday and hour, labeled as a guide', async () => {
		// Medians ignore one wild Monday.
		await seedMondays([2, 2, 2, 2, 2, 2, 2, 60])
		const guide = await s.get(`/demand?scopeId=${LOC_1}&date=2026-03-09`, {
			grants: SCH_EDIT,
		})
		expect(guide.status).toBe(200)
		expect(guide.body).toMatchObject({
			kind: 'guide',
			estimate: true,
			source: 'online_orders',
			statistic: 'median',
			weeks: 8,
			timeZone: CHI,
			daysWithOrders: 8,
		})
		expect(guide.body.days).toHaveLength(7)
		const monday = guide.body.days[0]
		expect(monday).toMatchObject({
			date: '2026-03-09',
			weekday: 1,
			totalOrders: 2,
		})
		expect(monday.hours[12]).toBe(2)
		expect(monday.hours.filter((n: number) => n > 0)).toHaveLength(1)
		expect(guide.body.days[1].totalOrders).toBe(0)
		// No money without the labor grant.
		expect(monday).not.toHaveProperty('salesMinorByCurrency')
		expect(guide.raw).not.toContain('2000')
	})

	it('learns from the real weeks before a future week, and from the weeks before the requested week otherwise', async () => {
		await seedMondays(2)
		const now = await s.get(`/demand?scopeId=${LOC_1}&date=2026-03-02`, {
			grants: SCH_EDIT,
		})
		const future = await s.get(`/demand?scopeId=${LOC_1}&date=2026-06-01`, {
			grants: SCH_EDIT,
		})
		expect(now.body.windowStart).toBe('2026-01-05')
		expect(now.body.windowEnd).toBe('2026-03-01')
		expect(future.body.windowEnd).toBe('2026-03-01')
		expect(future.body.days[0].totalOrders).toBe(2)
	})

	it('counts only payable, live orders at this scope', async () => {
		const monday = at('2026-02-23', '12:30')
		await order(monday)
		await order(monday, { status: 'cancelled', cancelledAt: new Date(monday) })
		await order(monday, {
			paymentMethod: 'online',
			paymentStatus: 'pending',
			status: 'accepted',
		})
		await order(monday, {
			paymentMethod: 'online',
			paymentStatus: 'paid',
			status: 'accepted',
		})
		await order(monday, { scopeId: LOC_2 })
		const guide = await s.get(`/demand?scopeId=${LOC_1}&date=2026-03-02`, {
			grants: SCH_EDIT,
		})
		// Eight Mondays in the window, only one with orders: the median is zero.
		expect(guide.body.days[0].totalOrders).toBe(0)
		expect(guide.body.daysWithOrders).toBe(1)
		await seedMondays(0)
		// Make that Monday the majority: five Mondays with two counted orders each.
		for (const day of [
			'2026-01-05',
			'2026-01-12',
			'2026-01-19',
			'2026-01-26',
			'2026-02-02',
		]) {
			await order(at(day, '12:30'))
			await order(at(day, '12:30'))
		}
		const again = await s.get(`/demand?scopeId=${LOC_1}&date=2026-03-02`, {
			grants: SCH_EDIT,
		})
		expect(again.body.days[0].totalOrders).toBe(2)
	})

	it('puts an order in its local hour, including late in the evening', async () => {
		for (let i = 0; i < 8; i++) {
			const day = new Date(Date.UTC(2026, 0, 6 + 7 * i))
				.toISOString()
				.slice(0, 10)
			await order(at(day, '23:45'))
			await order(at(day, '00:10'))
		}
		const guide = await s.get(`/demand?scopeId=${LOC_1}&date=2026-03-02`, {
			grants: SCH_EDIT,
		})
		const tuesday = guide.body.days[1]
		expect(tuesday.hours[23]).toBe(1)
		expect(tuesday.hours[0]).toBe(1)
		expect(tuesday.totalOrders).toBe(2)
	})

	it('adds median daily sales only with the labor grant', async () => {
		await seedMondays(3)
		const labor = await s.get(`/demand?scopeId=${LOC_1}&date=2026-03-02`, {
			grants: SCH_LABOR,
		})
		expect(labor.body.days[0].salesMinorByCurrency).toEqual({ USD: 3000 })
		expect(labor.body.days[1].salesMinorByCurrency).toEqual({ USD: 0 })
	})

	it('puts cost against the guide sales and the policy target in the week footer', async () => {
		await seedMondays(2)
		await s.setPolicy(LOC_1, { laborTargetBp: 3000 })
		await laborFixture(h).send('PUT', '/settings', {
			scopeId: LOC_1,
			salesSource: 'online_orders',
		})
		const { staffId, positionIds } = await s.staff()
		await s.shift({ staffId, positionId: positionIds[0], date: '2026-03-02' })
		const week = await s.get(`/week?scopeId=${LOC_1}&date=2026-03-02`, {
			grants: SCH_LABOR,
		})
		const { days } = week.body.laborTarget
		expect(days).toHaveLength(7)
		expect(days[0]).toEqual({
			date: '2026-03-02',
			guideSalesMinorByCurrency: { USD: 2000 },
		})
		expect(week.body.laborTarget).toEqual({
			targetBp: 3000,
			salesSource: 'online_orders',
			// Online orders alone are not all of a workplace's sales: no judgement.
			salesComplete: false,
			targetColoring: false,
			days,
			currencies: [
				{
					currency: 'USD',
					costMinor: 16000,
					guideSalesMinor: 2000,
					laborBp: 80000,
					allowedCostMinor: 600,
				},
			],
		})
		expect(week.body.currencies).toEqual(['USD'])
	})

	it('gives no ratio when there are no sales, and keeps currencies apart', async () => {
		const { staffId, positionIds } = await s.staff()
		await s.shift({ staffId, positionId: positionIds[0], date: '2026-03-02' })
		const week = await s.get(`/week?scopeId=${LOC_1}&date=2026-03-02`, {
			grants: SCH_LABOR,
		})
		expect(week.body.laborTarget.currencies).toEqual([
			{
				currency: 'USD',
				costMinor: 16000,
				guideSalesMinor: 0,
				laborBp: null,
				allowedCostMinor: null,
			},
		])
		const sar = await s.staff({
			positions: [{ name: 'Cook', rateMinor: 5000, currency: 'SAR' }],
		})
		await s.shift({
			staffId: sar.staffId,
			positionId: sar.positionIds[0],
			date: '2026-03-03',
		})
		const mixed = await s.get(`/week?scopeId=${LOC_1}&date=2026-03-02`, {
			grants: SCH_LABOR,
		})
		expect(mixed.body.totals.costMinorByCurrency).toEqual({
			SAR: 40000,
			USD: 16000,
		})
	})

	it('is scoped like the rest of the schedule', async () => {
		const out = await s.get(`/demand?scopeId=${LOC_2}&date=2026-03-02`, {
			scopeIds: [LOC_1],
		})
		expect(out.status).toBe(404)
		const bad = await s.get(`/demand?scopeId=${LOC_1}`)
		expect(bad.status).toBe(400)
		const noGrant = await s.get(`/demand?scopeId=${LOC_1}&date=2026-03-02`, {
			grants: [],
		})
		expect(noGrant.status).toBe(403)
	})
})
