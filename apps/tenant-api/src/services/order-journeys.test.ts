import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	customers,
	destroyTenantDb,
	getTenantDb,
	journeyRuns,
	marketingJourneys,
	orderJourneyEmissions,
	provisionTenantDb,
	triggerConfigMatches,
	type TenantDatabase,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { evaluateAndSpawnTriggers } from './journey-service.ts'
import {
	DAY,
	insertCustomer,
	insertOrder,
	insertPosSale,
	NOW,
} from './loyalty-test-fixture.ts'
import {
	evaluateOrderJourneys,
	runLapsedJourneys,
	setOrderJourneySpawner,
} from './order-journeys.ts'

const ORG = 'clw9x0a12000008l00ordj01'

describe('order journeys (#99)', () => {
	let dir: string
	let db: TenantDatabase
	const spawn = vi.fn(async (..._args: unknown[]) => ({ success: true }))

	beforeEach(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-order-journeys-'))
		process.env.TENANT_DB_DIR = dir
		process.env.DATA_REGION = 'us'
		process.env.AUTH_HMAC_SECRET = 'test-hmac-secret-123456789'
		await provisionTenantDb(ORG)
		db = await getTenantDb(ORG)
		spawn.mockClear()
		setOrderJourneySpawner(spawn as never)
	})

	afterEach(async () => {
		setOrderJourneySpawner(null)
		await destroyTenantDb(ORG).catch(() => {})
		fs.rmSync(dir, { recursive: true, force: true })
		delete process.env.TENANT_DB_DIR
	})

	async function listen(
		triggerType: 'order_first_placed' | 'order_completed' | 'guest_lapsed',
		triggerConfig: Record<string, unknown> = {},
		publishedAt: Date = new Date(NOW - 3 * DAY),
	) {
		const [row] = await db
			.insert(marketingJourneys)
			.values({
				name: triggerType,
				status: 'active',
				triggerType,
				triggerConfig,
				publishedAt,
			})
			.returning()
		return row!.id
	}

	const at = (daysAgo: number) => new Date(NOW - daysAgo * DAY)
	const calls = () => spawn.mock.calls.map((c) => c.slice(0, 3))

	it('starts a first-order journey once per guest, even when two passes run at once', async () => {
		await listen('order_first_placed')
		await insertCustomer(ORG, { id: 'a', phone: '+15550000001' })
		await insertOrder(ORG, { customerId: 'a', createdAt: at(0) })
		await Promise.all([
			evaluateOrderJourneys(ORG, { now: NOW }),
			evaluateOrderJourneys(ORG, { now: NOW }),
		])
		await evaluateOrderJourneys(ORG, { now: NOW + 1000 })
		expect(calls()).toEqual([[ORG, 'order_first_placed', 'a']])
		// A second order is not a first order.
		await insertOrder(ORG, { customerId: 'a', createdAt: at(0) })
		await evaluateOrderJourneys(ORG, { now: NOW + 2000 })
		expect(spawn).toHaveBeenCalledTimes(1)
	})

	it('does not fire for cancelled, unpaid, refunded-in-full or guest-less orders, and a fired trigger is not undone', async () => {
		await listen('order_first_placed')
		for (const id of ['c', 'u', 'r', 'ok']) {
			await insertCustomer(ORG, { id, phone: `+1555000${id.length}${id}0` })
		}
		await insertOrder(ORG, {
			customerId: 'c',
			status: 'cancelled',
			createdAt: at(0),
		})
		await insertOrder(ORG, {
			customerId: 'u',
			status: 'accepted',
			paymentStatus: 'pending',
			createdAt: at(0),
		})
		await insertOrder(ORG, {
			customerId: 'r',
			refundedCents: 1000,
			createdAt: at(0),
		})
		await insertOrder(ORG, { customerId: null, createdAt: at(0) })
		await insertOrder(ORG, { customerId: 'ok', createdAt: at(0) })
		await evaluateOrderJourneys(ORG, { now: NOW })
		expect(calls()).toEqual([[ORG, 'order_first_placed', 'ok']])
		// Refunding it afterwards does not un-fire it, and nothing fires twice.
		const rows = await db.select().from(orderJourneyEmissions).all()
		expect(
			rows.filter(
				(r) => r.trigger === 'order_first_placed' && r.state === 'fired',
			),
		).toHaveLength(1)
		await evaluateOrderJourneys(ORG, { now: NOW + 5000 })
		expect(spawn).toHaveBeenCalledTimes(1)
	})

	it('counts a first Station sale linked to a guest, and ignores an unlinked one', async () => {
		await listen('order_first_placed')
		await insertCustomer(ORG, { id: 'a', phone: '+15550000001' })
		await insertPosSale(ORG, {
			customerPhone: '+15550000001',
			rungUpAt: NOW - 1000,
		})
		await insertPosSale(ORG, {
			customerPhone: '+15559999999',
			rungUpAt: NOW - 1000,
		})
		await evaluateOrderJourneys(ORG, { now: NOW })
		expect(calls()).toEqual([[ORG, 'order_first_placed', 'a']])
	})

	it('is not retroactive: an old order, or one before the journey was turned on, starts nothing', async () => {
		await insertCustomer(ORG, { id: 'a', phone: '+15550000001' })
		await insertCustomer(ORG, { id: 'b', phone: '+15550000002' })
		await insertOrder(ORG, { customerId: 'a', createdAt: at(10) })
		await insertOrder(ORG, { customerId: 'b', createdAt: at(0) })
		// Nothing is listening yet: nothing is read or written.
		await evaluateOrderJourneys(ORG, { now: NOW })
		expect(await db.select().from(orderJourneyEmissions).all()).toEqual([])
		// Turned on after both orders.
		await listen('order_first_placed', {}, new Date(NOW + 5000))
		await evaluateOrderJourneys(ORG, { now: NOW + 6000 })
		expect(spawn).not.toHaveBeenCalled()
		// An order after it was turned on does start it.
		await insertCustomer(ORG, { id: 'c', phone: '+15550000003' })
		await insertOrder(ORG, {
			customerId: 'c',
			createdAt: new Date(NOW + 10_000),
		})
		await evaluateOrderJourneys(ORG, { now: NOW + 12_000 })
		expect(calls()).toEqual([[ORG, 'order_first_placed', 'c']])
	})

	it('retries a start that failed, and a stale claim', async () => {
		await listen('order_first_placed')
		await insertCustomer(ORG, { id: 'a', phone: '+15550000001' })
		await insertOrder(ORG, { customerId: 'a', createdAt: at(0) })
		spawn.mockRejectedValueOnce(new Error('worker down'))
		await evaluateOrderJourneys(ORG, { now: NOW })
		expect(
			(await db.select().from(orderJourneyEmissions).all()).filter(
				(r) => r.trigger === 'order_first_placed',
			),
		).toEqual([])
		await evaluateOrderJourneys(ORG, { now: NOW + 1000 })
		expect(spawn).toHaveBeenCalledTimes(2)
		// A claim that never finished (a crash) is taken over once it is stale.
		await db
			.delete(orderJourneyEmissions)
			.where(eq(orderJourneyEmissions.trigger, 'order_first_placed'))
		await db.insert(orderJourneyEmissions).values({
			customerId: 'a',
			trigger: 'order_first_placed',
			ref: 'first',
			state: 'pending',
			emittedAt: NOW - 10 * 60_000,
		})
		await evaluateOrderJourneys(ORG, { now: NOW + 2000 })
		expect(spawn).toHaveBeenCalledTimes(3)
	})

	it("order completed passes the guest's order number, and only finished orders fire", async () => {
		await listen('order_completed')
		await insertCustomer(ORG, { id: 'a', phone: '+15550000001' })
		await insertOrder(ORG, { customerId: 'a', createdAt: at(1), id: 'o1' })
		await insertOrder(ORG, { customerId: 'a', createdAt: at(0), id: 'o2' })
		await insertOrder(ORG, {
			customerId: 'a',
			status: 'preparing',
			createdAt: at(0),
			id: 'o3',
		})
		await evaluateOrderJourneys(ORG, { now: NOW })
		const contexts = spawn.mock.calls.map((c) => c[4])
		expect(contexts).toEqual([
			{ locationId: 'loc_1', orderSequence: 1 },
			{ locationId: 'loc_1', orderSequence: 2 },
		])
	})

	it('the Nth-order and location settings pick which journeys start', () => {
		expect(
			triggerConfigMatches('order_completed', { nth: 3 }, { orderSequence: 3 }),
		).toBe(true)
		expect(
			triggerConfigMatches('order_completed', { nth: 3 }, { orderSequence: 2 }),
		).toBe(false)
		expect(
			triggerConfigMatches(
				'order_first_placed',
				{ locationIds: ['a'] },
				{ locationId: 'b' },
			),
		).toBe(false)
		expect(
			triggerConfigMatches(
				'order_first_placed',
				{ locationIds: ['a'] },
				{ locationId: 'a' },
			),
		).toBe(true)
		expect(triggerConfigMatches('phone_verified', { nth: 3 }, {})).toBe(true)
	})

	it('evaluateAndSpawnTriggers starts only the journeys whose settings match', async () => {
		setOrderJourneySpawner(null)
		const nth2 = await listen('order_completed', { nth: 2 })
		await listen('order_completed', { nth: 5 })
		const any = await listen('order_completed', {})
		await insertCustomer(ORG, { id: 'a', phone: '+15550000001' })
		await evaluateAndSpawnTriggers(
			ORG,
			'order_completed',
			'a',
			'http://localhost:1',
			{
				orderSequence: 2,
				locationId: 'loc_1',
			},
		)
		const runs = await db.select().from(journeyRuns).all()
		expect(runs.map((r) => r.journeyId).sort()).toEqual([nth2, any].sort())
	})

	it('lapsed starts once per quiet spell and re-arms after the next order', async () => {
		const journey = await listen('guest_lapsed', { days: 30 })
		await insertCustomer(ORG, { id: 'a', phone: '+15550000001' })
		await insertCustomer(ORG, { id: 'fresh', phone: '+15550000002' })
		await insertCustomer(ORG, { id: 'ancient', phone: '+15550000003' })
		await insertOrder(ORG, { customerId: 'a', createdAt: at(40) })
		await insertOrder(ORG, { customerId: 'fresh', createdAt: at(5) })
		// Far past the grace window: turning the journey on does not wake them.
		await insertOrder(ORG, { customerId: 'ancient', createdAt: at(300) })
		await runLapsedJourneys(ORG, { now: NOW })
		await runLapsedJourneys(ORG, { now: NOW + 1000 })
		expect(calls()).toEqual([[ORG, 'guest_lapsed', 'a']])
		expect(spawn.mock.calls[0]![5]).toEqual({ journeyId: journey })
		// They order again (not quiet any more), then go quiet again: a new spell.
		await insertOrder(ORG, { customerId: 'a', createdAt: at(5) })
		await runLapsedJourneys(ORG, { now: NOW + 2000 })
		expect(spawn).toHaveBeenCalledTimes(1)
		await runLapsedJourneys(ORG, { now: NOW + 40 * DAY })
		// `a` fires a second time (a new quiet spell); `fresh` is quiet by now too.
		expect(spawn.mock.calls.filter((c) => c[2] === 'a')).toHaveLength(2)
		expect(spawn.mock.calls.filter((c) => c[2] === 'fresh')).toHaveLength(1)
	})

	it('a guest who ordered within the window is not lapsed, whatever else', async () => {
		await listen('guest_lapsed', { days: 30 })
		await insertCustomer(ORG, { id: 'a', phone: '+15550000001' })
		await insertOrder(ORG, { customerId: 'a', createdAt: at(40) })
		await insertOrder(ORG, { customerId: 'a', createdAt: at(2) })
		await runLapsedJourneys(ORG, { now: NOW })
		expect(spawn).not.toHaveBeenCalled()
	})
})

void customers
void eq
