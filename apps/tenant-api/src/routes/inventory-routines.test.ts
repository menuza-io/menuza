import {
	routineRunsSchema,
	routinesSchema,
	type InventoryNotifyEvent,
} from '@repo/inventory'
import {
	destroyTenantDb,
	getTenantDb,
	invItems,
	invOrders,
	invRoutineRuns,
	invWaste,
	provisionTenantDb,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
	invalidateInventoryContext,
	seedInventoryContextForTest,
} from '../lib/inventory-context.ts'
import { type PublishedOrganization } from '../lib/origin.ts'
import { runInventoryTickForOrg } from '../services/inventory-tick-service.ts'
import { makeWorld } from './inventory-orders-fixture.ts'
import {
	BASE,
	cid,
	makeClient,
	mintToken,
	READ,
	setupTenantEnv,
	UPDATE,
} from './inventory-test-utils.ts'
import { operatorInventoryRoutes } from './operator-inventory.ts'

/**
 * Ready-made routines (#529): off until a manager turns one on at a location;
 * the count routine drafts orders after the next approved count and asks a
 * manager to review; the weekly, morning and cut-off routines run on the
 * region's tick; every run is listed with what it did; nothing is ever sent to
 * a supplier or to staff. The App is a recorded `post`; no live service.
 */

const ORG = 'org_inv_routines'
const LOC = 'loc_routines'
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

const FLAGS = {
	enabled: true,
	purchasing: true,
	recipes: false,
	prep: false,
	transfers: false,
	routines: true,
}

let env: ReturnType<typeof setupTenantEnv>
let owner: string
let noCost: string
let noPurchasing: string
let world: ReturnType<typeof makeWorld>
let supplier: { id: string }
let item: { id: string; version: number }
let product: { id: string }
const posts: InventoryNotifyEvent[] = []
const post = async (event: InventoryNotifyEvent) => {
	posts.push(event)
	return { status: 'delivered' as const }
}
const fetches: string[] = []

const routines = async (token = owner) => {
	const reply = await call('GET', `${BASE}/routines?locationId=${LOC}`, { token })
	expect(reply.status, JSON.stringify(reply.body)).toBe(200)
	return routinesSchema.parse(reply.body).routines
}
const turn = async (key: string, enabled: boolean, token = owner) => {
	const current = (await routines()).find((routine) => routine.key === key)!
	return call('PUT', `${BASE}/routines/${key}`, {
		token,
		body: { locationId: LOC, enabled, expectedVersion: current.version },
	})
}
const runs = async (key?: string, token = owner) => {
	const reply = await call(
		'GET',
		`${BASE}/routines/runs?locationId=${LOC}${key ? `&key=${key}` : ''}`,
		{ token },
	)
	expect(reply.status).toBe(200)
	return routineRunsSchema.parse(reply.body).runs
}
const settle = async (key: string, count: number) => {
	for (let i = 0; i < 100; i++) {
		const found = await runs(key)
		if (found.length >= count) return found
		await new Promise((resolve) => setTimeout(resolve, 15))
	}
	throw new Error(`no ${key} run`)
}
const tick = (now: number) => runInventoryTickForOrg(ORG, { now, post })
const routineMessages = () =>
	posts.filter(
		(event) =>
			event.kind === 'inventory_routine' ||
			event.kind === 'inventory_repeat_order_draft',
	)

/** Cancels every open order, through the route (a draft nobody wants any more). */
async function cancelOrders() {
	const db = await getTenantDb(ORG)
	for (const order of await db.select().from(invOrders)) {
		if (order.status === 'cancelled') continue
		const cancelled = await call('POST', `${BASE}/orders/${order.id}/cancel`, {
			token: owner,
			body: { expectedVersion: order.version },
		})
		expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200)
	}
}

/** Approves a count of `amount` kg of the item, through the real routes. */
async function approveCount(amount: number) {
	const started = await call('POST', `${BASE}/counts`, {
		token: owner,
		body: { clientId: cid('count'), locationId: LOC, listId: null },
	})
	expect(started.status, JSON.stringify(started.body)).toBe(200)
	const id = started.body.id as string
	const entered = await call('POST', `${BASE}/counts/${id}/entries`, {
		token: owner,
		body: {
			entries: [
				{ clientId: cid('e'), itemId: item.id, areaId: null, amount, unit: 'kg' },
			],
		},
	})
	expect(entered.status, JSON.stringify(entered.body)).toBe(200)
	const sent = await call('POST', `${BASE}/counts/${id}/send`, {
		token: owner,
		body: { expectedVersion: started.body.version },
	})
	expect(sent.status, JSON.stringify(sent.body)).toBe(200)
	const approved = await call('POST', `${BASE}/counts/${id}/approve`, {
		token: owner,
		body: { expectedVersion: sent.body.version, uncounted: {}, notes: {} },
	})
	expect(approved.status, JSON.stringify(approved.body)).toBe(200)
	return id
}

beforeAll(async () => {
	env = setupTenantEnv('inv-routines')
	orgs.set(ORG, {
		id: ORG,
		slug: ORG,
		customDomain: null,
		hasProvisionedDb: true,
		dataRegion: 'us',
		name: ORG,
	})
	await provisionTenantDb(ORG)
	seedInventoryContextForTest(ORG, FLAGS)
	owner = await mintToken(ORG, { features: { routines: true }, subject: 'user_owner' })
	noCost = await mintToken(ORG, { grants: [READ, UPDATE], features: { routines: true } })
	noPurchasing = await mintToken(ORG, { features: { routines: true, purchasing: false } })
	world = makeWorld(call, owner, LOC)
	supplier = await world.supplier('Routine Farms', {
		deliveryDays: [0, 1, 2, 3, 4, 5, 6],
		cutoffTime: '23:59',
		cutoffDaysBefore: 1,
		email: 'orders@routine-farms.example',
	})
	item = await world.item('Routine tomatoes')
	product = await world.product(supplier.id, item.id, {
		packName: 'Crate 6 kg',
		packBaseQuantity: 6_000_000,
		priceMinor: 9_000,
	})
	await world.levels([
		{ itemId: item.id, orderBelowQuantity: 5_000_000, fillUpToQuantity: 20_000_000 },
	])
	await world.stock(item.id, 1_000_000)
})

afterEach(() => {
	vi.useRealTimers()
	posts.length = 0
	fetches.length = 0
})

afterAll(async () => {
	invalidateInventoryContext()
	await destroyTenantDb(ORG)
	env.cleanup()
})

describe('the Routines page', () => {
	it('lists every template, all off, with what each needs', async () => {
		const all = await routines()
		expect(all.map((routine) => routine.key)).toEqual([
			'count_low_stock',
			'weekly_waste',
			'morning_brief',
			'supplier_cutoff',
		])
		expect(all.every((routine) => !routine.enabled && routine.lastRuns.length === 0)).toBe(true)
		const blocked = await routines(noPurchasing)
		expect(blocked.filter((routine) => routine.blocked).map((r) => r.key)).toEqual([
			'count_low_stock',
			'supplier_cutoff',
		])
	})

	it('turns one on and off per location, with a version check', async () => {
		const on = await turn('morning_brief', true)
		expect(on.status, JSON.stringify(on.body)).toBe(200)
		expect(on.body).toMatchObject({ key: 'morning_brief', enabled: true, version: 1 })
		const stale = await call('PUT', `${BASE}/routines/morning_brief`, {
			token: owner,
			body: { locationId: LOC, enabled: false, expectedVersion: 0 },
		})
		expect(stale.status).toBe(409)
		const off = await turn('morning_brief', false)
		expect(off.body).toMatchObject({ enabled: false, version: 2 })
		// Another location is separate.
		const other = await call('GET', `${BASE}/routines?locationId=loc_routines_two`, { token: owner })
		expect(routinesSchema.parse(other.body).routines.every((r) => !r.enabled)).toBe(true)
	})

	it('refuses the purchasing routines while Purchasing is off, and unknown keys and fields', async () => {
		const blocked = await call('PUT', `${BASE}/routines/count_low_stock`, {
			token: noPurchasing,
			body: { locationId: LOC, enabled: true, expectedVersion: 0 },
		})
		expect(blocked.status).toBe(403)
		expect(blocked.body.code).toBe('feature_disabled')
		expect((await call('PUT', `${BASE}/routines/nope`, { token: owner, body: { locationId: LOC, enabled: true, expectedVersion: 0 } })).status).toBe(404)
		expect(
			(await call('PUT', `${BASE}/routines/morning_brief`, { token: owner, body: { locationId: LOC, enabled: true, expectedVersion: 0, extra: 1 } })).status,
		).toBe(400)
	})
})

describe('the count routine', () => {
	it('Turning it on drafts orders after the next approved count, and asks a manager to review', async () => {
		// A count approved BEFORE the routine is on drafts nothing.
		const before = await approveCount(1)
		expect((await turn('count_low_stock', true)).status).toBe(200)
		await new Promise((resolve) => setTimeout(resolve, 50))
		expect(await runs('count_low_stock')).toEqual([])
		const sweep = await tick(Date.now())
		expect(sweep.errors).toBe(0)
		expect(await runs('count_low_stock')).toEqual([])
		const db = await getTenantDb(ORG)
		expect((await db.select().from(invOrders)).length).toBe(0)

		// The next approved count does.
		const next = await approveCount(1)
		const [run] = await settle('count_low_stock', 1)
		expect(run).toMatchObject({ key: 'count_low_stock', runKey: next, status: 'done' })
		expect(run!.key === 'count_low_stock' && run!.summary.drafted).toHaveLength(1)
		const orders = await db.select().from(invOrders)
		expect(orders).toHaveLength(1)
		// A draft the manager reviews: never sent, to anyone.
		expect(orders[0]).toMatchObject({ status: 'draft', supplierId: supplier.id, locationId: LOC })
		expect(orders[0]!.sentAt ?? null).toBeNull()
		expect(fetches).toEqual([])
		expect(before).not.toBe(next)

		// The tick tells a manager once (a draft is ready), then nothing again.
		const first = await tick(Date.now())
		expect(first.errors).toBe(0)
		expect(routineMessages().map((p) => [p.kind, p.count, p.locationId])).toEqual([
			['inventory_repeat_order_draft', 1, LOC],
		])
		await tick(Date.now())
		expect(routineMessages()).toHaveLength(1)
		expect((await runs('count_low_stock'))[0]!.alerted).toBe(true)
	})

	it('makes no second draft for a supplier that already has one, and runs a count once', async () => {
		const next = await approveCount(1)
		const [first] = await settle('count_low_stock', 2)
		expect(first).toMatchObject({ runKey: next })
		const summary = first!.key === 'count_low_stock' ? first!.summary : null
		expect(summary!.drafted).toEqual([])
		expect(summary!.draftExisted).toHaveLength(1)
		expect(first!.status).toBe('nothing_to_do')
		const db = await getTenantDb(ORG)
		expect(await db.select().from(invOrders)).toHaveLength(1)
		// The tick finds the same count again and does nothing.
		await tick(Date.now())
		expect((await runs('count_low_stock')).filter((run) => run.runKey === next)).toHaveLength(1)
	})

	it('records nothing_to_do when nothing is low, and the run is still listed', async () => {
		const db = await getTenantDb(ORG)
		await cancelOrders()
		await world.stock(item.id, 30_000_000)
		const next = await approveCount(30)
		const found = await settle('count_low_stock', 3)
		expect(found[0]).toMatchObject({ runKey: next, status: 'nothing_to_do' })
		expect(found[0]!.alerted).toBe(true)
	})

	it('shows money in a run only to the cost grant', async () => {
		const withMoney = await runs('weekly_waste', owner)
		expect(withMoney).toEqual([])
		expect(JSON.stringify(await runs('count_low_stock', noCost))).not.toContain('valueMinor')
	})
})

describe('the Monday waste summary', () => {
	const monday = Date.UTC(2026, 10, 23, 8, 0) // Mon 23 Nov 2026, 08:00 UTC
	async function waste(itemId: string, date: string, quantity: number, reason: any, value: number) {
		const db = await getTenantDb(ORG)
		await db.insert(invWaste).values({
			locationId: LOC,
			itemId,
			quantity,
			reason,
			valueMinor: value,
			currency: 'SAR',
			actorKind: 'operator',
			clientId: cid('w'),
			businessDate: date,
			createdAt: Date.parse(`${date}T12:00:00Z`),
		})
	}

	it('runs on Monday morning with last week\'s top five items and reasons, once', async () => {
		const db = await getTenantDb(ORG)
		const ids: string[] = []
		for (let i = 0; i < 6; i++) {
			const id = `waste_item_${i}`
			ids.push(id)
			await db.insert(invItems).values({
				id,
				name: `Waste item ${i}`,
				category: 'produce',
				kind: 'bought',
				baseUnit: 'g',
			})
			await waste(id, '2026-11-18', 1_000 * (i + 1), i % 2 ? 'expired' : 'spoiled', 100 * (i + 1))
		}
		await waste(ids[0]!, '2026-11-24', 5_000, 'dropped', 900) // after the week: left out
		expect((await turn('weekly_waste', true)).status).toBe(200)
		// Not Monday: nothing.
		await tick(Date.UTC(2026, 10, 24, 8, 0))
		expect(await runs('weekly_waste')).toEqual([])
		// Monday before 07:00: nothing.
		await tick(Date.UTC(2026, 10, 23, 5, 0))
		expect(await runs('weekly_waste')).toEqual([])
		// Monday morning: one run.
		await tick(monday)
		await tick(monday + 60_000)
		const found = await runs('weekly_waste')
		expect(found).toHaveLength(1)
		const run = found[0]!
		expect(run).toMatchObject({ status: 'done', runKey: '2026-11-23' })
		const summary = run.key === 'weekly_waste' ? run.summary : null
		expect(summary).toMatchObject({ from: '2026-11-16', to: '2026-11-22', count: 6 })
		expect(summary!.topItems).toHaveLength(5)
		expect(summary!.byReason.map((row) => row.reason).sort()).toEqual(['expired', 'spoiled'])
		expect(routineMessages()).toMatchObject([
			{ kind: 'inventory_routine', routine: { key: 'weekly_waste' } },
		])
		// The manager with no cost grant sees no money.
		expect(JSON.stringify(await runs('weekly_waste', noCost))).not.toContain('valueMinor')
		expect(JSON.stringify(found)).toContain('valueMinor')
	})
})

describe('the morning brief and the cut-off reminder', () => {
	it('brings the day together every morning, once a day', async () => {
		const db = await getTenantDb(ORG)
		await db.update(invRoutineRuns).set({ alertStatus: 'sent' })
		expect((await turn('morning_brief', true)).status).toBe(200)
		await world.stock(item.id, -29_000_000)
		const day = Date.UTC(2026, 5, 10, 9, 0)
		await tick(Date.UTC(2026, 5, 10, 6, 0)) // before 07:00
		expect(await runs('morning_brief')).toEqual([])
		await tick(day)
		await tick(day + 3_600_000)
		const found = await runs('morning_brief')
		expect(found).toHaveLength(1)
		const brief = found[0]!.key === 'morning_brief' ? found[0]!.summary : null
		expect(brief).toMatchObject({ date: '2026-06-10', prep: null, useBy: null })
		expect(brief!.runningOut.some((row) => row.itemId === item.id)).toBe(true)
		expect(brief!.working).toEqual({ known: true, staff: [] })
		const message = posts.filter((p) => p.kind === 'inventory_routine' && p.routine?.key === 'morning_brief')
		expect(message).toHaveLength(1)
		// The notification carries the key and a run id: no summary, no names.
		expect(JSON.stringify(message[0])).not.toContain('Routine tomatoes')
		// The next morning is another run.
		await tick(day + 24 * 3_600_000)
		expect(await runs('morning_brief')).toHaveLength(2)
	})

	it('reminds before a supplier\'s cut-off when no order is drafted, and not once one is', async () => {
		const db = await getTenantDb(ORG)
		await cancelOrders()
		expect((await turn('supplier_cutoff', true)).status).toBe(200)
		// 23:59 cut-off today: far away at 15:30, near at 22:30.
		await tick(Date.UTC(2026, 5, 10, 15, 30))
		expect(await runs('supplier_cutoff')).toEqual([])
		await tick(Date.UTC(2026, 5, 10, 22, 30))
		await tick(Date.UTC(2026, 5, 10, 22, 45))
		const found = await runs('supplier_cutoff')
		expect(found).toHaveLength(1)
		expect(found[0]).toMatchObject({ key: 'supplier_cutoff', status: 'done', runKey: `2026-06-10:${supplier.id}` })
		expect(found[0]!.key === 'supplier_cutoff' && found[0]!.summary).toMatchObject({
			supplierName: 'Routine Farms',
			cutoffTime: '23:59',
			itemCount: 1,
		})
		// With a draft started the next day, no reminder.
		await world.ok('POST', '/orders', {
			clientId: cid('ord'),
			locationId: LOC,
			supplierId: supplier.id,
			lines: [{ itemId: item.id, supplierProductId: product.id, packs: 1 }],
		})
		await tick(Date.UTC(2026, 5, 11, 22, 30))
		expect(await runs('supplier_cutoff')).toHaveLength(1)
		// Reminder only: the order is still a draft nobody sent.
		const orders = await db.select().from(invOrders)
		expect(orders.every((order) => order.status !== 'sent')).toBe(true)
	})
})

describe('what routines never do', () => {
	it('do nothing while the flag is off, or when turned off', async () => {
		const db = await getTenantDb(ORG)
		const before = (await db.select().from(invRoutineRuns)).length
		seedInventoryContextForTest(ORG, { ...FLAGS, routines: false })
		await tick(Date.UTC(2026, 5, 12, 9, 0))
		expect((await db.select().from(invRoutineRuns)).length).toBe(before)
		seedInventoryContextForTest(ORG, FLAGS)
		await turn('morning_brief', false)
		await turn('supplier_cutoff', false)
		await tick(Date.UTC(2026, 5, 13, 9, 0))
		expect((await db.select().from(invRoutineRuns).where(eq(invRoutineRuns.key, 'morning_brief'))).length).toBe(2)
	})

	it('keep a run that failed, and never lose the record of a run', async () => {
		const db = await getTenantDb(ORG)
		const [row] = await db.select().from(invRoutineRuns)
		await expect(db.delete(invRoutineRuns).where(eq(invRoutineRuns.id, row!.id))).rejects.toThrow()
		await expect(
			db.update(invRoutineRuns).set({ status: 'failed' }).where(eq(invRoutineRuns.id, row!.id)),
		).rejects.toThrow()
	})
})
