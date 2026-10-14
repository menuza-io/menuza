import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STAFFING_PERMISSIONS as P } from '@repo/staffing'
import { staffAuditLog, staffMembers, timeEntries } from '@repo/tenant-db'
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
	LAB_PAY,
	LAB_VIEW,
	laborFixture,
	LOC_1,
	LOC_2,
	ORG_A,
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

describe('/operator/labor/tips', () => {
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
		facts.clear()
		facts.set(LOC_1, { name: 'Downtown', timeZone: CHI })
		facts.set(LOC_2, { name: 'Airport', timeZone: CHI })
		h = await createClockHarness([ORG_A])
		l = laborFixture(h)
		h.setClock(at('2026-03-10', '12:00'))
	})
	afterEach(async () => {
		registerOrderSource(null)
		await h.cleanup()
	})

	const RANGE = 'scopeId=loc-1&from=2026-03-02&to=2026-03-03'

	/**
	 * Monday 2026-03-02: Ana works 09-17 (8h) and Ben 10-16 (6h), both
	 * tip-eligible; Cy works 09-17 but his pay row is not tip-eligible.
	 * Online tips: pickup $10.00 + $5.00 (and a delivery tip of $7.00).
	 * Ana declares $20.00 of cash tips.
	 */
	async function seedMonday() {
		const ana = await l.staff({
			firstName: 'Ana',
			lastName: 'Adams',
			tipEligible: true,
		})
		const ben = await l.staff({
			firstName: 'Ben',
			lastName: 'Brown',
			tipEligible: true,
		})
		const cy = await l.staff({ firstName: 'Cy', lastName: 'Cole' })
		const card = async (
			staffId: string,
			start: string,
			end: string,
			extra: Record<string, unknown> = {},
		) =>
			expect(
				(
					await l.card({
						staffId,
						scopeId: LOC_1,
						date: '2026-03-02',
						startTime: start,
						endTime: end,
						reason: 'Monday',
						...extra,
					})
				).status,
			).toBe(201)
		await card(ana.staffId, '09:00', '17:00', { cashTipsMinor: 2000 })
		await card(ben.staffId, '10:00', '16:00')
		await card(cy.staffId, '09:00', '17:00', { cashTipsMinor: 9999 })
		await order(at('2026-03-02', '12:00'), { tipCents: 1000 })
		await order(at('2026-03-02', '18:00'), { tipCents: 500 })
		await order(at('2026-03-02', '13:00'), {
			tipCents: 700,
			fulfillment: 'delivery',
		})
		return { ana, ben, cy }
	}

	const settings = (patch: Record<string, unknown> = {}) => ({
		scopeId: LOC_1,
		splitBasis: 'hours',
		cadence: 'period',
		cardFeeBp: 0,
		fulfillment: ['pickup'],
		positionPercentBp: {},
		...patch,
	})
	const save = (patch: Record<string, unknown> = {}) =>
		l.send('PUT', '/tips/settings', settings(patch))

	it('starts conservative and says it is using defaults', async () => {
		const res = await l.get('/tips/settings?scopeId=loc-1')
		expect(res.body).toEqual({
			scopeId: LOC_1,
			splitBasis: 'hours',
			cadence: 'period',
			cardFeeBp: 0,
			fulfillment: ['pickup'],
			positionPercentBp: {},
			configured: false,
			updatedAt: null,
		})
	})

	it('pools pickup tips and declared cash tips, takes the card fee off online tips only, and splits by hours', async () => {
		const { ana, ben } = await seedMonday()
		expect((await save({ cardFeeBp: 300 })).status).toBe(200)

		const res = await l.get(`/tips?${RANGE}`)
		expect(res.status).toBe(200)
		expect(res.body).toMatchObject({
			estimate: true,
			payout: false,
			scopeId: LOC_1,
			timeZone: CHI,
			openCards: 0,
			ineligibleMinutes: 480,
			undeclaredCurrencyCashTips: 0,
			truncated: false,
		})
		// Online $15.00 less 3% ($0.45) is $14.55, plus Ana's $20.00 of cash = $34.55.
		// Cy's $99.99 stays his: his pay row is not tip-eligible.
		expect(res.body.pools).toHaveLength(1)
		const pool = res.body.pools[0]
		expect(pool).toMatchObject({
			currency: 'USD',
			onlineTipsMinor: 1500,
			cardFeeMinor: 45,
			cashTipsMinor: 2000,
			poolMinor: 3455,
			unallocatedMinor: 0,
		})
		// Ana 480 of 840 minutes, Ben 360: 19.74 and 14.80 before the spare cent,
		// which goes to the larger remainder (Ben).
		expect(
			pool.people.map((p: any) => [p.staffId, p.minutes, p.shareMinor]),
		).toEqual([
			[ana.staffId, 480, 1974],
			[ben.staffId, 360, 1481],
		])
		expect(
			pool.people.reduce((sum: number, p: any) => sum + p.shareMinor, 0),
		).toBe(3455)
		expect(pool.people[0]).toMatchObject({
			firstName: 'Ana',
			lastName: 'Adams',
		})
		// Still-unapproved cards are surfaced: their hours may yet change.
		expect(res.body.unapprovedCards).toBe(2)
		expect(res.raw).not.toContain('9999')
	})

	it('adds delivery tips only when the scope chooses to pool them', async () => {
		await seedMonday()
		await save({ fulfillment: ['pickup', 'delivery'] })
		const both = await l.get(`/tips?${RANGE}`)
		expect(both.body.pools[0]).toMatchObject({
			onlineTipsMinor: 2200,
			poolMinor: 4200,
		})
		await save({ fulfillment: [] })
		const none = await l.get(`/tips?${RANGE}`)
		expect(none.body.pools[0]).toMatchObject({
			onlineTipsMinor: 0,
			poolMinor: 2000,
		})
	})

	it('splits each day on its own with a daily cadence', async () => {
		const { ana, ben } = await seedMonday()
		// Tuesday: only Ben works, with a $6.00 pickup tip.
		await l.card({
			staffId: ben.staffId,
			scopeId: LOC_1,
			date: '2026-03-03',
			startTime: '10:00',
			endTime: '14:00',
			reason: 'Tuesday',
		})
		await order(at('2026-03-03', '12:00'), { tipCents: 600 })
		await save({ cadence: 'daily' })
		const res = await l.get(`/tips?${RANGE}`)
		const pool = res.body.pools[0]
		expect(pool.groups.map((g: any) => [g.key, g.poolMinor])).toEqual([
			['2026-03-02', 3500],
			['2026-03-03', 600],
		])
		// Monday $35.00 by 480:360 = 20.00 and 15.00; Tuesday all $6.00 to Ben.
		expect(pool.people.map((p: any) => [p.staffId, p.shareMinor])).toEqual([
			[ana.staffId, 2000],
			[ben.staffId, 1500 + 600],
		])
	})

	it('splits by position percentage', async () => {
		const { ana, ben } = await seedMonday()
		const db = await h.db(ORG_A)
		const rows = await db.select().from(timeEntries)
		const position = (staffId: string) =>
			rows.find((r) => r.staffId === staffId)!.positionId!
		const res = await save({
			splitBasis: 'position_percent',
			positionPercentBp: {
				[position(ana.staffId)]: 6000,
				[position(ben.staffId)]: 4000,
			},
		})
		expect(res.status).toBe(200)
		const report = await l.get(`/tips?${RANGE}`)
		const pool = report.body.pools[0]
		// Pool $35.00: Ana's position 60% = $21.00, Ben's 40% = $14.00.
		expect(pool.people.map((p: any) => [p.staffId, p.shareMinor])).toEqual([
			[ana.staffId, 2100],
			[ben.staffId, 1400],
		])
		expect(pool.unallocatedMinor).toBe(0)
	})

	it('leaves the pool unallocated, never lost, when nobody eligible worked', async () => {
		await order(at('2026-03-02', '12:00'), { tipCents: 1000 })
		const res = await l.get(`/tips?${RANGE}`)
		expect(res.body.pools[0]).toMatchObject({
			poolMinor: 1000,
			unallocatedMinor: 1000,
			people: [],
		})
	})

	it('keeps currencies apart', async () => {
		await seedMonday()
		await order(at('2026-03-02', '12:30'), { tipCents: 400, currency: 'sar' })
		const res = await l.get(`/tips?${RANGE}`)
		expect(res.body.pools.map((p: any) => p.currency)).toEqual(['SAR', 'USD'])
		expect(res.body.pools[0]).toMatchObject({
			onlineTipsMinor: 400,
			cashTipsMinor: 0,
			poolMinor: 400,
		})
		expect(res.body.pools[1].onlineTipsMinor).toBe(1500)
	})

	it('does not count cards that are still open, and surfaces them', async () => {
		const { ana } = await seedMonday()
		const db = await h.db(ORG_A)
		await db
			.update(timeEntries)
			.set({ clockOutAt: null, status: 'open' })
			.where(eq(timeEntries.staffId, ana.staffId))
		const res = await l.get(`/tips?${RANGE}`)
		expect(res.body.openCards).toBe(1)
		expect(res.body.pools[0].people.map((p: any) => p.staffId)).not.toContain(
			ana.staffId,
		)
	})

	it('needs the pay grant, the labor grant and the roster, and records who looked', async () => {
		await seedMonday()
		for (const grants of [
			LAB_VIEW,
			[P.READ_LABOR, P.READ_STAFF_PAY],
			[P.READ_STAFF, P.READ_STAFF_PAY],
		]) {
			expect((await l.get(`/tips?${RANGE}`, { grants })).status).toBe(403)
		}
		expect((await l.get(`/tips?${RANGE}`, { impersonated: true })).status).toBe(
			403,
		)
		expect(
			(await l.get('/tips/settings?scopeId=loc-1', { grants: LAB_VIEW }))
				.status,
		).toBe(403)
		expect(
			(
				await l.get(`/tips?${RANGE}`, {
					grants: [...LAB_VIEW, P.READ_STAFF_PAY],
				})
			).status,
		).toBe(200)
		const audit = await (await h.db(ORG_A)).select().from(staffAuditLog)
		const read = audit.find((r) => r.action === 'labor.tips.read')
		expect(read).toMatchObject({ sensitivity: 'pay', scopeId: LOC_1 })
	})

	it('changes settings only with the policy grant, and audits it', async () => {
		const noPolicy = [...LAB_VIEW, P.READ_STAFF_PAY]
		const refused = await l.send(
			'PUT',
			'/tips/settings',
			settings({ cardFeeBp: 100 }),
			{ grants: noPolicy },
		)
		expect(refused.status).toBe(403)
		expect((await save({ cardFeeBp: 290 })).status).toBe(200)
		const audit = await (await h.db(ORG_A)).select().from(staffAuditLog)
		const row = audit.find(
			(r) => r.action === 'labor.tip_pool.settings.updated',
		)
		expect(row!.changes).toMatchObject({ cardFeeBp: { before: 0, after: 290 } })
	})

	it('validates settings: capped fee, percentages that add up, real positions', async () => {
		expect((await save({ cardFeeBp: 1001 })).status).toBe(400)
		expect(
			(
				await save({
					splitBasis: 'position_percent',
					positionPercentBp: { a: 5000 },
				})
			).status,
		).toBe(400)
		const unknown = await save({
			splitBasis: 'position_percent',
			positionPercentBp: { 'nope-1': 10_000 },
		})
		expect(unknown.status).toBe(422)
		expect(unknown.body.error).toBe('unknown_position')
		expect((await save({ fulfillment: ['dine_in'] })).status).toBe(400)
	})

	it('refuses a scope outside the token scope', async () => {
		const scoped = { scopeIds: [LOC_2] }
		expect((await l.get(`/tips?${RANGE}`, scoped)).status).toBe(404)
		expect((await l.get('/tips/settings?scopeId=loc-1', scoped)).status).toBe(
			404,
		)
		const write = await l.send('PUT', '/tips/settings', settings(), scoped)
		expect(write.status).toBe(403)
	})

	it('exports a formula-safe file with the pool lines, and audits the export', async () => {
		const { ana } = await seedMonday()
		const db = await h.db(ORG_A)
		await db
			.update(staffMembers)
			.set({ firstName: '=HYPERLINK("http://x")' })
			.where(eq(staffMembers.id, ana.staffId))
		await save({ cardFeeBp: 300 })
		const res = await l.get(`/tips/export?${RANGE}`)
		expect(res.status).toBe(200)
		expect(res.body.filename).toBe('tip-pool_2026-03-02_2026-03-03.csv')
		expect(res.body.kind).toBe('tip_pool')
		expect(res.body.csv.startsWith('﻿')).toBe(true)
		expect(res.body.csv).toContain("'=HYPERLINK")
		const labels = res.body.rows.map((r: any[]) => r[1])
		expect(labels).toEqual(
			expect.arrayContaining([
				'\'=HYPERLINK("http://x")',
				'Online order tips',
				'Card fee deduction',
				'Pool',
				'Not allocated',
			]),
		)
		const pool = res.body.rows.find((r: any[]) => r[1] === 'Pool')
		expect(pool[5]).toBe(34.55)
		const audit = await db.select().from(staffAuditLog)
		expect(
			audit.some(
				(r) => r.action === 'labor.exported' && r.sensitivity === 'pay',
			),
		).toBe(true)
	})

	it('leaves people outside the pool out of the report', async () => {
		await seedMonday()
		const res = await l.get(`/tips?${RANGE}`, { grants: LAB_PAY })
		expect(res.raw).not.toContain('Cole')
	})
})
