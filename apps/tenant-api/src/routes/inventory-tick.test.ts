import {
	INVENTORY_NOTIFY_PATH,
	inventoryNotifyDedupeKey,
	inventoryNotifyEventSchema,
	inventoryTickAnswerSchema,
	type InventoryNotifyEvent,
} from '@repo/inventory'
import {
	destroyTenantDb,
	getTenantDb,
	invAlertLog,
	provisionTenantDb,
} from '@repo/tenant-db'
import { Hono } from 'hono'
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest'
import {
	invalidateInventoryContext,
	seedInventoryContextForTest,
} from '../lib/inventory-context.ts'
import {
	postInventoryNotify,
	type InventoryNotifyOutcome,
} from '../lib/inventory-notify.ts'
import { createInventoryTickModule } from '../lib/inventory-alarm.ts'
import { handleOrgAlarm } from '../lib/org-alarm.ts'
import { type PublishedOrganization } from '../lib/origin.ts'
import { syncEnvFromProcess } from '../lib/secrets.ts'
import {
	fanOutInventoryTick,
	inventoryAlertEventId,
	INVENTORY_ALERT_GIVE_UP_MS,
	INVENTORY_ALERT_RETRY_MS,
	runInventoryTickForOrg,
} from '../services/inventory-tick-service.ts'
import { inventoryTickRoutes } from './inventory-tick.ts'
import { makeWorld } from './inventory-orders-fixture.ts'
import {
	BASE,
	cid,
	makeClient,
	mintToken,
	setupTenantEnv,
} from './inventory-test-utils.ts'
import { operatorInventoryRoutes } from './operator-inventory.ts'

/**
 * The inventory tick: what it records, that an hourly run never resends,
 * that an App outage is retried and a refusal is not, the budget, and the
 * route and alarm around it.
 */

const ORG = 'org_inv_tick_a'
const ORG_EMPTY = 'org_inv_tick_empty'
const LOC = 'loc_tick'
const FEATURES = {
	enabled: true,
	purchasing: true,
	recipes: false,
	prep: false,
	transfers: false,
}

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

let env: ReturnType<typeof setupTenantEnv>
let world: ReturnType<typeof makeWorld>
const DAY = 24 * 60 * 60 * 1000
const midnight = Math.floor(Date.now() / DAY) * DAY
/** Today (UTC, no reservations settings: UTC with a 04:00 day start) at this hour. */
const at = (hour: number, days = 0) => midnight + days * DAY + hour * 3_600_000

type Event = InventoryNotifyEvent

function recorder(outcome: InventoryNotifyOutcome = { status: 'delivered' }) {
	const events: Event[] = []
	const post = vi.fn(async (event: Event) => {
		events.push(event)
		return outcome
	})
	return { events, post }
}

async function log() {
	const db = await getTenantDb(ORG)
	return db.select().from(invAlertLog)
}

async function clearLog() {
	const db = await getTenantDb(ORG)
	await db.delete(invAlertLog)
}

beforeAll(async () => {
	env = setupTenantEnv('inv-tick')
	process.env.APP_URL = 'https://app.example.test'
	syncEnvFromProcess()
	for (const id of [ORG, ORG_EMPTY]) {
		orgs.set(id, {
			id,
			slug: id,
			customDomain: null,
			hasProvisionedDb: true,
			dataRegion: 'us',
			name: id,
		})
		await provisionTenantDb(id)
	}
	const admin = await mintToken(ORG)
	world = makeWorld(call, admin, LOC)
	await world.ok('PUT', '/settings', {
		expectedVersion: 0,
		unitSystem: 'metric',
	})

	const supplier = await world.supplier('Tick Supplier', {
		deliveryDays: [0, 1, 2, 3, 4, 5, 6],
	})
	const flour = await world.item('Tick flour')
	await world.levels([
		{
			itemId: flour.id,
			orderBelowQuantity: 10_000_000,
			fillUpToQuantity: 20_000_000,
		},
	])
	// Low stock: below its level. (The flour is delivered to below.)
	const eggs = await world.item('Tick eggs')
	await world.levels([
		{
			itemId: eggs.id,
			orderBelowQuantity: 10_000_000,
			fillUpToQuantity: 20_000_000,
		},
	])
	await world.stock(eggs.id, 2_000_000)
	const flourProduct = await world.product(supplier.id, flour.id)

	// An order that was due yesterday and has not come.
	const order = await world.ok('POST', '/orders', {
		clientId: cid('ord'),
		locationId: LOC,
		supplierId: supplier.id,
		expectedDate: new Date(midnight - DAY).toISOString().slice(0, 10),
		lines: [{ itemId: flour.id, supplierProductId: flourProduct.id, packs: 1 }],
	})
	await world.ok('POST', `/orders/${order.id}/send`, {
		expectedVersion: 1,
		channel: 'copy',
	})

	// A count waiting for review.
	const count = await world.ok('POST', '/counts', {
		clientId: cid('cnt'),
		locationId: LOC,
		listId: null,
	})
	await world.ok('POST', `/counts/${count.id}/send`, { expectedVersion: 1 })

	// A price that rose by 30%.
	const receive = (total: number) =>
		world.ok('POST', '/deliveries', {
			clientId: cid('del'),
			locationId: LOC,
			supplierId: supplier.id,
			currency: 'SAR',
			lines: [
				{ itemId: flour.id, quantity: 10_000_000, lineTotalMinor: total },
			],
		})
	await receive(10_000)
	await receive(13_000)
})

beforeEach(async () => {
	invalidateInventoryContext()
	seedInventoryContextForTest(ORG, FEATURES)
	seedInventoryContextForTest(ORG_EMPTY, FEATURES)
	await clearLog()
})

afterEach(() => {
	delete process.env.INVENTORY_ENABLED
	vi.restoreAllMocks()
})

afterAll(async () => {
	await destroyTenantDb(ORG)
	await destroyTenantDb(ORG_EMPTY)
	env.cleanup()
})

describe('what a tick records and sends', () => {
	it('sends each alert once, with ids and counts only, under a stable event id', async () => {
		const { events, post } = recorder()
		const result = await runInventoryTickForOrg(ORG, { now: at(9), post })
		expect(result).toMatchObject({
			lowStockDigests: 1,
			deliveryDueAlerts: 1,
			countReviewAlerts: 1,
			priceRiseAlerts: 1,
			alertsSent: 4,
			alertsDeferred: 0,
			alertsSkipped: 0,
			errors: 0,
			salesSettled: 0,
			needsFollowUp: false,
			nextDueAt: null,
		})
		expect(events.map((event) => event.kind).sort()).toEqual([
			'inventory_count_review',
			'inventory_delivery_due',
			'inventory_low_stock',
			'inventory_price_rise',
		])
		for (const event of events) {
			expect(Object.keys(event).sort()).toEqual([
				'count',
				'eventId',
				'kind',
				'locationId',
				'orgId',
			])
			expect(inventoryNotifyEventSchema.safeParse(event).success).toBe(true)
			expect(event).toMatchObject({ orgId: ORG, locationId: LOC, count: 1 })
		}
		// The event id is the SHA-256 of the dedupe key (a date, a count id or a delivery id).
		const rows = await log()
		expect(rows).toHaveLength(4)
		const date = new Date(at(9)).toISOString().slice(0, 10)
		const digest = events.find((event) => event.kind === 'inventory_low_stock')!
		expect(digest.eventId).toBe(
			inventoryAlertEventId({
				orgId: ORG,
				kind: 'inventory_low_stock',
				locationId: LOC,
				dedupeKey: date,
			}),
		)
		expect(digest.eventId).toMatch(/^[a-f0-9]{64}$/)
		expect(
			inventoryNotifyDedupeKey({
				orgId: ORG,
				kind: 'inventory_low_stock',
				locationId: LOC,
				key: date,
			}),
		).toBe(`inventory:${ORG}:inventory_low_stock:${LOC}:${date}`)
		const review = rows.find((row) => row.kind === 'inventory_count_review')!
		expect(review.dedupeKey).not.toBe(date)
		expect(
			rows.every(
				(row) =>
					row.status === 'sent' && row.sentAt === at(9) && row.attempts === 1,
			),
		).toBe(true)
	})

	it('does not resend what was sent: a later tick the same day skips every alert', async () => {
		const first = recorder()
		await runInventoryTickForOrg(ORG, { now: at(9), post: first.post })
		const later = recorder()
		const result = await runInventoryTickForOrg(ORG, {
			now: at(10),
			post: later.post,
		})
		expect(later.post).not.toHaveBeenCalled()
		expect(result).toMatchObject({
			alertsSent: 0,
			alertsSkipped: 4,
			lowStockDigests: 0,
			deliveryDueAlerts: 0,
			countReviewAlerts: 0,
			priceRiseAlerts: 0,
		})
		expect(await log()).toHaveLength(4)
	})

	it('starts the digests in the morning, and sends a new one the next day', async () => {
		const early = recorder()
		await runInventoryTickForOrg(ORG, { now: at(6), post: early.post })
		// Before 07:00: a count and a price rise are news at once; the daily ones wait.
		expect(early.events.map((event) => event.kind).sort()).toEqual([
			'inventory_count_review',
			'inventory_price_rise',
		])
		const morning = recorder()
		await runInventoryTickForOrg(ORG, { now: at(7), post: morning.post })
		expect(morning.events.map((event) => event.kind).sort()).toEqual([
			'inventory_delivery_due',
			'inventory_low_stock',
		])
		const tomorrow = recorder()
		await runInventoryTickForOrg(ORG, { now: at(9, 1), post: tomorrow.post })
		// A new day: new digests; the count and the rise were already told.
		expect(tomorrow.events.map((event) => event.kind).sort()).toEqual([
			'inventory_delivery_due',
			'inventory_low_stock',
		])
		const ids = new Set([
			...morning.events.map((event) => event.eventId),
			...tomorrow.events.map((event) => event.eventId),
		])
		expect(ids.size).toBe(4)
	})

	it('retries what the App could not take under the same event id, then stops', async () => {
		const down = recorder({ status: 'retry', code: 'http_503' })
		const first = await runInventoryTickForOrg(ORG, {
			now: at(9),
			post: down.post,
		})
		expect(first).toMatchObject({
			alertsSent: 0,
			alertsDeferred: 4,
			needsFollowUp: true,
			nextDueAt: at(9) + INVENTORY_ALERT_RETRY_MS,
		})
		expect(
			(await log()).every(
				(row) => row.status === 'pending' && row.attempts === 1,
			),
		).toBe(true)

		const up = recorder()
		const second = await runInventoryTickForOrg(ORG, {
			now: at(9) + INVENTORY_ALERT_RETRY_MS,
			post: up.post,
		})
		expect(second).toMatchObject({
			alertsSent: 4,
			alertsDeferred: 0,
			needsFollowUp: false,
			// They are retries, not new events.
			lowStockDigests: 0,
		})
		expect(up.events.map((event) => event.eventId).sort()).toEqual(
			down.events.map((event) => event.eventId).sort(),
		)
		expect(
			(await log()).every((row) => row.status === 'sent' && row.attempts === 2),
		).toBe(true)
		const third = recorder()
		await runInventoryTickForOrg(ORG, { now: at(10), post: third.post })
		expect(third.post).not.toHaveBeenCalled()
	})

	it('does not retry an alert the App refused, and counts it as an error', async () => {
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
		const refuse = recorder({ status: 'rejected', code: 'http_400' })
		const result = await runInventoryTickForOrg(ORG, {
			now: at(9),
			post: refuse.post,
		})
		expect(result).toMatchObject({
			alertsSent: 0,
			alertsDeferred: 0,
			errors: 4,
			needsFollowUp: false,
		})
		const rows = await log()
		expect(
			rows.every((row) => row.status === 'sent' && row.sentAt === null),
		).toBe(true)
		const again = recorder()
		await runInventoryTickForOrg(ORG, { now: at(10), post: again.post })
		expect(again.post).not.toHaveBeenCalled()
		errors.mockRestore()
	})

	it('gives up on an alert that has waited for days', async () => {
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
		const down = recorder({ status: 'retry', code: 'network_error' })
		await runInventoryTickForOrg(ORG, { now: at(9), post: down.post })
		const later = recorder()
		const result = await runInventoryTickForOrg(ORG, {
			now: at(9) + INVENTORY_ALERT_GIVE_UP_MS + 1,
			post: later.post,
		})
		// The four old ones are given up (never posted again); days later has its own news.
		const old = new Set(down.events.map((event) => event.eventId))
		expect(later.events.some((event) => old.has(event.eventId))).toBe(false)
		expect(result.errors).toBe(4)
		const rows = await log()
		const gone = rows.filter((row) => row.createdAt === at(9))
		expect(gone).toHaveLength(4)
		expect(
			gone.every((row) => row.status === 'sent' && row.sentAt === null),
		).toBe(true)
		errors.mockRestore()
	})

	it('stops posting at its deadline and leaves the rest pending', async () => {
		const slow = recorder()
		const result = await runInventoryTickForOrg(ORG, {
			now: at(9),
			post: slow.post,
			deadline: Date.now() - 1,
		})
		expect(slow.post).not.toHaveBeenCalled()
		expect(result).toMatchObject({
			alertsSent: 0,
			alertsDeferred: 4,
			needsFollowUp: true,
		})
		expect(
			(await log()).every(
				(row) => row.status === 'pending' && row.attempts === 0,
			),
		).toBe(true)
	})

	it('does nothing while inventory is off for the organization or stopped on the node, and for an organization with no items', async () => {
		const none = recorder()
		seedInventoryContextForTest(ORG, { ...FEATURES, enabled: false })
		expect(
			await runInventoryTickForOrg(ORG, { now: at(9), post: none.post }),
		).toMatchObject({
			alertsSent: 0,
			errors: 0,
		})
		seedInventoryContextForTest(ORG, FEATURES)
		process.env.INVENTORY_ENABLED = 'false'
		await runInventoryTickForOrg(ORG, { now: at(9), post: none.post })
		delete process.env.INVENTORY_ENABLED
		await runInventoryTickForOrg(ORG_EMPTY, { now: at(9), post: none.post })
		expect(none.post).not.toHaveBeenCalled()
		expect(await log()).toHaveLength(0)
	})

	it('never throws: an organization with no database is counted as an error', async () => {
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
		const result = await runInventoryTickForOrg('org_inv_tick_missing', {
			now: at(9),
			post: recorder().post,
		})
		expect(result.errors).toBe(1)
		errors.mockRestore()
	})
})

describe('the fan-out', () => {
	it('sums the organizations, counts one that fails as an error, and defers what the budget did not reach', async () => {
		const totals = await fanOutInventoryTick({
			orgIds: ['a', 'b', 'c'],
			rotateBucket: 0,
			run: async (orgId) =>
				orgId === 'b'
					? null
					: {
							alertsSent: 2,
							alertsDeferred: 1,
							alertsSkipped: 3,
							lowStockDigests: 1,
							countReviewAlerts: 0,
							deliveryDueAlerts: 1,
							priceRiseAlerts: 0,
							salesSettled: 0,
							errors: 0,
							needsFollowUp: true,
							nextDueAt: 5,
						},
		})
		expect(totals).toEqual({
			orgs: 2,
			orgsDeferred: 0,
			alertsSent: 4,
			alertsDeferred: 2,
			alertsSkipped: 6,
			lowStockDigests: 2,
			countReviewAlerts: 0,
			deliveryDueAlerts: 2,
			priceRiseAlerts: 0,
			salesSettled: 0,
			errors: 1,
		})
		// The answer carries no follow-up fields (they are for one organization's alarm).
		expect(totals).not.toHaveProperty('needsFollowUp')

		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		let clock = 0
		const budgeted = await fanOutInventoryTick({
			orgIds: ['a', 'b', 'c', 'd'],
			rotateBucket: 0,
			concurrency: 1,
			budgetMs: 10,
			now: () => clock,
			run: async () => {
				clock += 20
				return null
			},
		})
		expect(budgeted.orgsDeferred).toBeGreaterThan(0)
		warn.mockRestore()
	})
})

describe('the App notify call', () => {
	const event: Event = {
		orgId: ORG,
		eventId: 'a'.repeat(64),
		kind: 'inventory_low_stock',
		locationId: LOC,
		count: 3,
	}

	it('posts the event to the App with the internal token and nothing else', async () => {
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(
				new Response('{"inApp":1,"emailed":0}', { status: 200 }),
			)
		expect(await postInventoryNotify(event)).toEqual({ status: 'delivered' })
		const [url, init] = fetchSpy.mock.calls[0]!
		expect(String(url)).toBe(`https://app.example.test${INVENTORY_NOTIFY_PATH}`)
		expect((init as RequestInit).method).toBe('POST')
		expect((init as RequestInit).headers).toMatchObject({
			Authorization: 'Bearer inv-test-internal-token-0123456789',
		})
		expect(JSON.parse((init as RequestInit).body as string)).toEqual(event)
		expect((init as RequestInit).redirect).toBe('error')
	})

	it.each([
		[401, 'retry'],
		[408, 'retry'],
		[425, 'retry'],
		[429, 'retry'],
		[500, 'retry'],
		[503, 'retry'],
		[400, 'rejected'],
		[403, 'rejected'],
		[404, 'rejected'],
	] as const)('treats an App answer of %s as %s', async (status, expected) => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(null, { status }),
		)
		expect(await postInventoryNotify(event)).toEqual({
			status: expected,
			code: `http_${status}`,
		})
	})

	it('retries a network failure, refuses an invalid event without a call, and never carries an extra field', async () => {
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockRejectedValue(new Error('offline'))
		expect(await postInventoryNotify(event)).toEqual({
			status: 'retry',
			code: 'network_error',
		})
		fetchSpy.mockClear()
		expect(
			await postInventoryNotify({
				...event,
				itemName: 'Flour',
			} as unknown as Event),
		).toEqual({ status: 'rejected', code: 'invalid_event' })
		expect(
			await postInventoryNotify({ ...event, count: 0 } as unknown as Event),
		).toEqual({ status: 'rejected', code: 'invalid_event' })
		expect(fetchSpy).not.toHaveBeenCalled()
	})
})

describe('POST /api/inventory/tick', () => {
	const tickApp = new Hono()
	tickApp.route('/api/inventory', inventoryTickRoutes)
	const token = 'inv-test-internal-token-0123456789'
	const post = (options: { token?: string | null; body?: unknown } = {}) =>
		tickApp.request('/api/inventory/tick', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...(options.token === null
					? {}
					: { Authorization: `Bearer ${options.token ?? token}` }),
			},
			body: JSON.stringify(options.body ?? {}),
		})

	it('needs the internal token, and no other bearer will do', async () => {
		expect((await post({ token: null })).status).toBe(401)
		expect((await post({ token: 'wrong-token-0123456789' })).status).toBe(401)
		// The operator token is not a command token.
		expect((await post({ token: await mintToken(ORG) })).status).toBe(401)
	})

	it('refuses a body it does not know, and a malformed organization id', async () => {
		for (const body of [
			{ orgId: '../etc' },
			{ orgId: ORG, extra: 1 },
			{ orgId: 5 },
		]) {
			const res = await post({ body })
			expect(res.status, JSON.stringify(body)).toBe(400)
			expect(await res.json()).toEqual({ error: 'validation_error' })
		}
	})

	it('runs one organization and answers counts only', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response('{}', { status: 200 }),
		)
		const res = await post({ body: { orgId: ORG } })
		expect(res.status).toBe(200)
		expect(res.headers.get('Cache-Control')).toBe('private, no-store')
		const answer = inventoryTickAnswerSchema.parse(await res.json())
		expect(answer).toMatchObject({ success: true })
		const rows = await log()
		expect(rows.length).toBeGreaterThan(0)
		const text = JSON.stringify(answer)
		expect(text).not.toMatch(/Tick flour|Tick Supplier|SAR/)
	})

	it('runs every organization on the node when no organization is named', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response('{}', { status: 200 }),
		)
		const res = await post()
		expect(res.status).toBe(200)
		const answer = inventoryTickAnswerSchema.parse(await res.json())
		expect(answer).toMatchObject({ success: true })
		expect('orgs' in answer && answer.orgs).toBeGreaterThanOrEqual(1)
	})
})

describe('the Durable Object alarm module', () => {
	it('runs the inventory tick and asks to be woken again only while an alert waits', async () => {
		const run = vi
			.fn()
			.mockResolvedValueOnce({ needsFollowUp: true, nextDueAt: 1_000_000 })
			.mockResolvedValueOnce({ needsFollowUp: false, nextDueAt: null })
		const module = createInventoryTickModule(run)
		expect(module.name).toBe('inventory')
		expect(module.tickPath).toBe('/api/inventory/tick')
		// Plain activity never arms the alarm: only a tick with something waiting does.
		expect(module.isActivityPath('/operator/inventory/orders')).toBe(false)
		expect(module.isActivityPath('/api/inventory/tick')).toBe(false)

		let alarm: number | null = null
		const store = new Map<string, unknown>([['orgAlarmOrgId', ORG]])
		const storage = {
			getAlarm: async () => alarm,
			setAlarm: async (at: number) => {
				alarm = at
			},
			get: async (key: string) => store.get(key) as never,
			put: async (key: string, value: unknown) => {
				store.set(key, value)
			},
			delete: async (key: string) => store.delete(key),
		}
		const now = 5_000_000
		const first = await handleOrgAlarm({ storage, now, modules: [module] })
		expect(first).toMatchObject({
			status: 'ran',
			modules: [{ module: 'inventory', status: 'ran', needsFollowUp: true }],
		})
		expect(run).toHaveBeenCalledWith(ORG, now)
		expect(alarm).not.toBeNull()
		alarm = null
		const second = await handleOrgAlarm({ storage, now, modules: [module] })
		expect(second).toMatchObject({ rearmedAt: null })
		expect(alarm).toBeNull()
	})
})
