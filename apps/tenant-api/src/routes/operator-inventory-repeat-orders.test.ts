import {
	type InventoryNotifyEvent,
	listRepeatOrdersResultSchema,
	repeatOrderSummarySchema,
	supplierSchema,
} from '@repo/inventory'
import {
	destroyTenantDb,
	getTenantDb,
	invItems,
	invLocationSettings,
	invOrders,
	invRepeatOrderRuns,
	provisionTenantDb,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { type PublishedOrganization } from '../lib/origin.ts'
import { processDueRepeatOrders } from '../services/inventory-repeat-orders-service.ts'
import { makeWorld } from './inventory-orders-fixture.ts'
import {
	BASE,
	cid,
	makeClient,
	mintToken,
	PURCHASING,
	READ,
	setupTenantEnv,
	UPDATE,
} from './inventory-test-utils.ts'
import { operatorInventoryRoutes } from './operator-inventory.ts'

const ORG = 'org_inv_repeat_a'
const LOC = 'loc_repeat'

const orgs = vi.hoisted(() => new Map<string, PublishedOrganization>())

vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	lookupActiveOrganization: vi.fn(async (id: string) => {
		const organization = orgs.get(id)
		return organization
			? { status: 'found' as const, organization }
			: { status: 'missing' as const }
	}),
}))

const app = new Hono()
app.route(BASE, operatorInventoryRoutes)
const call = makeClient(app)

describe('operator inventory repeat orders (#499)', () => {
	let env: ReturnType<typeof setupTenantEnv> | null = null
	let token: string
	let supplierId: string
	let tomatoId: string
	let tomatoProductId: string
	let basilId: string
	let basilProductId: string

	beforeAll(async () => {
		env = setupTenantEnv('inv-repeat')
		orgs.set(ORG, {
			id: ORG,
			slug: ORG,
			customDomain: null,
			hasProvisionedDb: true,
			dataRegion: 'us',
			name: ORG,
		})
		await provisionTenantDb(ORG)
		token = await mintToken(ORG)
		const world = makeWorld(call, token, LOC)
		const supplier = await world.supplier('Fresh Farm', {
			deliveryDays: [1, 4],
			cutoffTime: '16:00',
			cutoffDaysBefore: 1,
		})
		const tomato = await world.item('Tomato')
		const basil = await world.item('Basil')
		const tomatoProduct = await world.product(supplier.id, tomato.id, {
			preferred: true,
		})
		const basilProduct = await world.product(supplier.id, basil.id, {
			preferred: true,
		})
		await world.levels([
			{
				itemId: tomato.id,
				orderBelowQuantity: 20_000_000,
				fillUpToQuantity: 50_000_000,
			},
		])

		supplierId = supplier.id
		tomatoId = tomato.id
		tomatoProductId = tomatoProduct.id
		basilId = basil.id
		basilProductId = basilProduct.id

		const db = await getTenantDb(ORG)
		await db
			.insert(invLocationSettings)
			.values({
				locationId: LOC,
				timeZone: 'UTC',
				dayStartMinutes: 240,
			})
			.onConflictDoUpdate({
				target: invLocationSettings.locationId,
				set: { timeZone: 'UTC' },
			})
	})

	afterAll(async () => {
		await destroyTenantDb(ORG)
		env?.cleanup()
	})

	it('drafts a fixed_lines weekly repeat order before cutoff, never sends, and dispatches manager alert', async () => {
		const res = await call('POST', `${BASE}/repeat-orders`, {
			token,
			body: {
				clientId: cid('repeat-fixed'),
				locationId: LOC,
				supplierId,
				cadenceWeeks: 1,
				weekdays: [4], // Thursday
				mode: 'fixed_lines',
				anchorDate: '2026-11-23',
				lines: [
					{
						itemId: tomatoId,
						supplierProductId: tomatoProductId,
						packs: 3,
					},
				],
				note: 'Weekly tomato restock',
			},
		})
		expect(res.status).toBe(201)
		const created = repeatOrderSummarySchema.parse(res.body)
		expect(created.status).toBe('active')
		expect(created.upcomingRuns.length).toBeGreaterThan(0)
		expect(created.upcomingRuns[0]?.deliveryDate).toBe('2026-11-26')

		const db = await getTenantDb(ORG)
		const alerts: InventoryNotifyEvent[] = []
		// Wednesday 2026-11-25 10:00 UTC (before 16:00 cutoff for Thursday 2026-11-26)
		const now = Date.UTC(2026, 10, 25, 10, 0, 0)
		const tick = await processDueRepeatOrders(db, {
			orgId: ORG,
			region: 'us',
			now,
			post: async (event) => {
				alerts.push(event)
				return { status: 'delivered', inApp: 1, emailed: 1 }
			},
		})
		expect(tick.drafted).toBe(1)
		expect(tick.alertsSent).toBe(1)
		expect(alerts).toHaveLength(1)
		expect(alerts[0]?.kind).toBe('inventory_repeat_order_draft')
		expect(alerts[0]?.repeatOrderDraft?.repeatOrderId).toBe(created.id)
		expect(alerts[0]?.repeatOrderDraft?.expectedDate).toBe('2026-11-26')

		const order = await db
			.select()
			.from(invOrders)
			.where(eq(invOrders.repeatOrderId, created.id))
			.get()
		expect(order).toBeDefined()
		expect(order?.status).toBe('draft')
		expect(order?.sentAt).toBeNull()
		expect(order?.expectedDate).toBe('2026-11-26')

		// Running tick again for the same date is idempotent (no duplicate draft)
		const tick2 = await processDueRepeatOrders(db, {
			orgId: ORG,
			region: 'us',
			now: now + 60 * 60 * 1000,
			post: async () => ({ status: 'delivered', inApp: 1, emailed: 1 }),
		})
		expect(tick2.drafted).toBe(0)

		const patchRes = await call(
			'PATCH',
			`${BASE}/repeat-orders/${created.id}`,
			{
				token,
				body: { expectedVersion: created.version, status: 'cancelled' },
			},
		)
		expect(patchRes.status).toBe(200)
	})

	it('skips a run when marked skipped and makes NO draft', async () => {
		const res = await call('POST', `${BASE}/repeat-orders`, {
			token,
			body: {
				clientId: cid('repeat-skip'),
				locationId: LOC,
				supplierId,
				cadenceWeeks: 1,
				weekdays: [1], // Monday 2026-11-30
				mode: 'fixed_lines',
				anchorDate: '2026-11-23',
				lines: [
					{
						itemId: tomatoId,
						supplierProductId: tomatoProductId,
						packs: 2,
					},
				],
			},
		})
		expect(res.status).toBe(201)
		const created = repeatOrderSummarySchema.parse(res.body)

		const skipRes = await call(
			'POST',
			`${BASE}/repeat-orders/${created.id}/skip`,
			{
				token,
				body: {
					deliveryDate: '2026-11-30',
					skipped: true,
					note: 'Stock still full',
				},
			},
		)
		expect(skipRes.status).toBe(200)
		const skippedSummary = repeatOrderSummarySchema.parse(skipRes.body)
		const run = skippedSummary.upcomingRuns.find(
			(r) => r.deliveryDate === '2026-11-30',
		)
		expect(run?.status).toBe('skipped')
		expect(run?.note).toBe('Stock still full')

		const db = await getTenantDb(ORG)
		const tick = await processDueRepeatOrders(db, {
			orgId: ORG,
			region: 'us',
			now: Date.UTC(2026, 10, 29, 10, 0, 0),
			post: async () => ({ status: 'delivered', inApp: 1, emailed: 1 }),
		})
		expect(tick.drafted).toBe(0)
		const orders = await db
			.select()
			.from(invOrders)
			.where(eq(invOrders.repeatOrderId, created.id))
		expect(orders).toHaveLength(0)

		await call('PATCH', `${BASE}/repeat-orders/${created.id}`, {
			token,
			body: { expectedVersion: created.version, status: 'cancelled' },
		})
	})

	it('skips closed special-hours day automatically with skipped_holiday and a note', async () => {
		const db = await getTenantDb(ORG)
		await db
			.update(invLocationSettings)
			.set({
				specialHours: JSON.stringify([
					{ date: '2026-12-03', isOpen: false, note: 'National Day' },
				]),
			})
			.where(eq(invLocationSettings.locationId, LOC))

		const res = await call('POST', `${BASE}/repeat-orders`, {
			token,
			body: {
				clientId: cid('repeat-holiday'),
				locationId: LOC,
				supplierId,
				cadenceWeeks: 1,
				weekdays: [4], // Thursday 2026-12-03
				mode: 'fixed_lines',
				anchorDate: '2026-11-23',
				lines: [
					{
						itemId: tomatoId,
						supplierProductId: tomatoProductId,
						packs: 1,
					},
				],
			},
		})
		expect(res.status).toBe(201)
		const created = repeatOrderSummarySchema.parse(res.body)

		const tick = await processDueRepeatOrders(db, {
			orgId: ORG,
			region: 'us',
			now: Date.UTC(2026, 11, 2, 10, 0, 0),
			post: async () => ({ status: 'delivered', inApp: 1, emailed: 1 }),
		})
		expect(tick.drafted).toBe(0)
		expect(tick.skippedHoliday).toBe(1)

		const runRow = await db
			.select()
			.from(invRepeatOrderRuns)
			.where(eq(invRepeatOrderRuns.repeatOrderId, created.id))
			.get()
		expect(runRow?.status).toBe('skipped_holiday')
		expect(runRow?.note).toContain('National Day')

		await db
			.update(invLocationSettings)
			.set({ specialHours: null })
			.where(eq(invLocationSettings.locationId, LOC))
		await call('PATCH', `${BASE}/repeat-orders/${created.id}`, {
			token,
			body: { expectedVersion: created.version, status: 'cancelled' },
		})
	})

	it('pauses repeat order drafting when supplier is paused', async () => {
		const res = await call('POST', `${BASE}/repeat-orders`, {
			token,
			body: {
				clientId: cid('repeat-supplier-pause'),
				locationId: LOC,
				supplierId,
				cadenceWeeks: 1,
				weekdays: [1], // Monday 2026-12-07
				mode: 'fixed_lines',
				anchorDate: '2026-11-23',
				lines: [
					{
						itemId: tomatoId,
						supplierProductId: tomatoProductId,
						packs: 1,
					},
				],
			},
		})
		expect(res.status).toBe(201)
		const created = repeatOrderSummarySchema.parse(res.body)

		const supGet = await call('GET', `${BASE}/suppliers/${supplierId}`, {
			token,
		})
		const sup = supplierSchema.parse(supGet.body)
		const pauseSup = await call('PATCH', `${BASE}/suppliers/${supplierId}`, {
			token,
			body: { expectedVersion: sup.version, paused: true },
		})
		expect(pauseSup.status).toBe(200)
		const pausedSup = supplierSchema.parse(pauseSup.body)
		expect(pausedSup.pausedAt).not.toBeNull()

		const listRes = await call(
			'GET',
			`${BASE}/repeat-orders?locationId=${LOC}`,
			{
				token,
			},
		)
		const list = listRepeatOrdersResultSchema.parse(listRes.body)
		const found = list.repeatOrders.find((r) => r.id === created.id)
		expect(found?.effectiveStatus).toBe('paused_supplier')

		const db = await getTenantDb(ORG)
		const tick = await processDueRepeatOrders(db, {
			orgId: ORG,
			region: 'us',
			now: Date.UTC(2026, 11, 6, 10, 0, 0),
			post: async () => ({ status: 'delivered', inApp: 1, emailed: 1 }),
		})
		expect(tick.drafted).toBe(0)

		await call('PATCH', `${BASE}/suppliers/${supplierId}`, {
			token,
			body: { expectedVersion: pausedSup.version, paused: false },
		})
		await call('PATCH', `${BASE}/repeat-orders/${created.id}`, {
			token,
			body: { expectedVersion: created.version, status: 'cancelled' },
		})
	})

	it('drops archived items with a note on the created draft and supports top_up mode', async () => {
		const db = await getTenantDb(ORG)
		await db
			.update(invItems)
			.set({ archivedAt: Date.now() })
			.where(eq(invItems.id, basilId))

		const res = await call('POST', `${BASE}/repeat-orders`, {
			token,
			body: {
				clientId: cid('repeat-archived-line'),
				locationId: LOC,
				supplierId,
				cadenceWeeks: 1,
				weekdays: [4], // Thursday 2026-12-10
				mode: 'fixed_lines',
				anchorDate: '2026-11-23',
				lines: [
					{ itemId: tomatoId, supplierProductId: tomatoProductId, packs: 2 },
					{ itemId: basilId, supplierProductId: basilProductId, packs: 1 },
				],
			},
		})
		expect(res.status).toBe(201)
		const created = repeatOrderSummarySchema.parse(res.body)

		const tick = await processDueRepeatOrders(db, {
			orgId: ORG,
			region: 'us',
			now: Date.UTC(2026, 11, 9, 10, 0, 0),
			post: async () => ({ status: 'delivered', inApp: 1, emailed: 1 }),
		})
		expect(tick.drafted).toBe(1)

		const order = await db
			.select()
			.from(invOrders)
			.where(eq(invOrders.repeatOrderId, created.id))
			.get()
		expect(order).toBeDefined()
		expect(order?.note).toContain('Dropped archived item(s): Basil')

		await db
			.update(invItems)
			.set({ archivedAt: null })
			.where(eq(invItems.id, basilId))
		await call('PATCH', `${BASE}/repeat-orders/${created.id}`, {
			token,
			body: { expectedVersion: created.version, status: 'cancelled' },
		})

		const topUpRes = await call('POST', `${BASE}/repeat-orders`, {
			token,
			body: {
				clientId: cid('repeat-topup'),
				locationId: LOC,
				supplierId,
				cadenceWeeks: 1,
				weekdays: [1], // Monday 2026-12-14
				mode: 'top_up',
				anchorDate: '2026-11-23',
			},
		})
		expect(topUpRes.status).toBe(201)
		const topUp = repeatOrderSummarySchema.parse(topUpRes.body)

		const tickTopUp = await processDueRepeatOrders(db, {
			orgId: ORG,
			region: 'us',
			now: Date.UTC(2026, 11, 13, 10, 0, 0),
			post: async () => ({ status: 'delivered', inApp: 1, emailed: 1 }),
		})
		expect(tickTopUp.drafted).toBe(1)
		const topUpOrder = await db
			.select()
			.from(invOrders)
			.where(eq(invOrders.repeatOrderId, topUp.id))
			.get()
		expect(topUpOrder?.status).toBe('draft')
		expect(topUpOrder?.expectedDate).toBe('2026-12-14')
	})

	it('copies decimal packs (not raw milli-packs) when repeating from sourceOrderId without explicit lines', async () => {
		const orderRes = await call('POST', `${BASE}/orders`, {
			token,
			body: {
				clientId: cid('src-order-packs'),
				locationId: LOC,
				supplierId,
				lines: [
					{
						itemId: tomatoId,
						supplierProductId: tomatoProductId,
						packs: 3,
					},
				],
			},
		})
		expect(orderRes.status).toBe(200)
		const sourceOrder = orderRes.body as { id: string }

		const repRes = await call('POST', `${BASE}/repeat-orders`, {
			token,
			body: {
				clientId: cid('repeat-from-source-order'),
				locationId: LOC,
				supplierId,
				sourceOrderId: sourceOrder.id,
				cadenceWeeks: 1,
				weekdays: [2], // Tuesday
				mode: 'fixed_lines',
				anchorDate: '2026-12-21',
			},
		})
		expect(repRes.status).toBe(201)
		const repeat = repeatOrderSummarySchema.parse(repRes.body)
		expect(repeat.status).toBe('active')

		const db = await getTenantDb(ORG)
		// Monday 2026-12-21 10:00 UTC (before 16:00 cutoff for Tuesday 2026-12-22)
		await processDueRepeatOrders(db, {
			orgId: ORG,
			region: 'us',
			now: Date.UTC(2026, 11, 21, 10, 0, 0),
			post: async () => ({ status: 'delivered', inApp: 1, emailed: 0 }),
		})
		const drafted = await db
			.select()
			.from(invOrders)
			.where(eq(invOrders.repeatOrderId, repeat.id))
			.get()
		expect(drafted).toBeDefined()
		const draftedRes = await call('GET', `${BASE}/orders/${drafted!.id}`, {
			token,
		})
		expect(draftedRes.status).toBe(200)
		const detail = draftedRes.body as { lines: Array<{ packs: number }> }
		expect(detail.lines[0]?.packs).toBe(3)
	})
})
