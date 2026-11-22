import { addDays, dayOfWeek } from '@repo/reservations'
import { listItemsResultSchema, todaySchema } from '@repo/inventory'
import {
	destroyTenantDb,
	getTenantDb,
	invCountEntries,
	invCounts,
	invMovements,
	provisionTenantDb,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { type PublishedOrganization } from '../lib/origin.ts'
import {
	BASE,
	cid,
	COST,
	makeClient,
	mintToken,
	PURCHASING,
	READ,
	setupTenantEnv,
	UPDATE,
} from './inventory-test-utils.ts'
import { operatorInventoryRoutes } from './operator-inventory.ts'

/** Days of stock left and the Today run-out flag (#492). */

const ORG = 'org_inv_days_left'
const LOC = 'loc_a'
const LOC2 = 'loc_b'

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
let token: string
let today: string

async function ok(res: Promise<{ status: number; body: any }>) {
	const reply = await res
	expect(reply.status, JSON.stringify(reply.body)).toBe(200)
	return reply.body
}

async function item(name: string) {
	const body = await ok(
		call('POST', `${BASE}/items`, {
			token,
			body: {
				clientId: cid('item'),
				name,
				category: 'meat',
				kind: 'bought',
				baseUnit: 'g',
			},
		}),
	)
	return body.id as string
}

/** `perDay` of use on each of the last `days` days at a location, and `onHand` now. */
async function seedUse(
	itemId: string,
	input: { days: number; perDay: number; onHand: number; locationId?: string },
) {
	const db = await getTenantDb(ORG)
	const locationId = input.locationId ?? LOC
	const rows: (typeof invMovements.$inferInsert)[] = [
		{
			locationId,
			itemId,
			quantity: input.onHand + input.days * input.perDay,
			kind: 'delivery',
			sourceType: 'delivery',
			sourceId: `d_${itemId}_${locationId}`,
			businessDate: addDays(today, -30),
			actorKind: 'system',
			createdAt: Date.now() - 40 * 86_400_000,
		},
	]
	for (let offset = 1; offset <= input.days; offset++) {
		rows.push({
			locationId,
			itemId,
			quantity: -input.perDay,
			kind: 'sale',
			sourceType: 'pos_order',
			sourceId: `s_${itemId}_${locationId}_${offset}`,
			businessDate: addDays(today, -offset),
			actorKind: 'system',
			createdAt: Date.now() - offset * 86_400_000,
		})
	}
	await db.insert(invMovements).values(rows)
}

async function daysLeftOf(itemId: string, locationId = LOC) {
	const list = listItemsResultSchema.parse(
		await ok(
			call(
				'GET',
				`${BASE}/items?locationId=${locationId}&limit=200&sort=daysLeft`,
				{
					token,
				},
			),
		),
	)
	return list.items.find((entry) => entry.id === itemId)!
}

beforeAll(async () => {
	env = setupTenantEnv('inv-days-left')
	orgs.set(ORG, {
		id: ORG,
		slug: ORG,
		customDomain: null,
		hasProvisionedDb: true,
		dataRegion: 'us',
		name: ORG,
	})
	await provisionTenantDb(ORG)
	token = await mintToken(ORG, { grants: [READ, UPDATE, COST, PURCHASING] })
	const t = todaySchema.parse(
		await ok(call('GET', `${BASE}/today?locationId=${LOC}`, { token })),
	)
	today = t.date
})

afterAll(async () => {
	await destroyTenantDb(ORG)
	env.cleanup()
})

describe('days left', () => {
	it('is 2.5 days for 2 kg a day with 5 kg on hand, with the use rate', async () => {
		const chicken = await item('Chicken thighs')
		await seedUse(chicken, { days: 28, perDay: 2_000_000, onHand: 5_000_000 })
		const row = await daysLeftOf(chicken)
		expect(row.daysLeft).toMatchObject({
			state: 'ok',
			days: 2.5,
			perDay: 2_000_000,
			useDays: 28,
		})
	})

	it('says not enough history under seven days of use', async () => {
		const saffron = await item('Saffron')
		await seedUse(saffron, { days: 5, perDay: 10_000, onHand: 100_000 })
		const row = await daysLeftOf(saffron)
		expect(row.daysLeft).toMatchObject({
			state: 'not_enough_history',
			useDays: 5,
		})
	})

	it('greys the number when the item was not counted in 14 days and un-greys it after a count', async () => {
		const rice = await item('Basmati rice')
		await seedUse(rice, { days: 10, perDay: 1_000_000, onHand: 20_000_000 })
		expect((await daysLeftOf(rice)).daysLeft!.stale).toBe(true)
		const db = await getTenantDb(ORG)
		const countId = cid('count')
		await db.insert(invCounts).values({
			id: countId,
			locationId: LOC,
			status: 'counting',
			businessDate: today,
			startedByKind: 'operator',
		})
		await db.insert(invCountEntries).values({
			countId,
			itemId: rice,
			quantity: 20_000_000,
			enteredAmount: '20',
			enteredUnit: 'kg',
			counterKind: 'operator',
			clientId: cid('entry'),
		})
		await db
			.update(invCounts)
			.set({ status: 'approved', approvedAt: Date.now() - 86_400_000 })
			.where(eq(invCounts.id, countId))
		expect((await daysLeftOf(rice)).daysLeft!.stale).toBe(false)
	})

	it('counts a transfer out as use at the sending place only', async () => {
		const flour = await item('Flour')
		const db = await getTenantDb(ORG)
		await seedUse(flour, { days: 8, perDay: 500_000, onHand: 4_000_000 })
		// Seven more days at the receiving place: it received stock, it used none.
		await db.insert(invMovements).values(
			Array.from({ length: 8 }, (_, index) => ({
				locationId: LOC2,
				itemId: flour,
				quantity: 500_000,
				kind: 'transfer_in' as const,
				sourceType: 'transfer',
				sourceId: `t_in_${index}`,
				businessDate: addDays(today, -(index + 1)),
				actorKind: 'system' as const,
				createdAt: Date.now() - (index + 1) * 86_400_000,
			})),
		)
		const there = await daysLeftOf(flour, LOC2)
		expect(there.daysLeft).toMatchObject({
			state: 'not_enough_history',
			useDays: 0,
		})
		await db.insert(invMovements).values(
			Array.from({ length: 8 }, (_, index) => ({
				locationId: LOC,
				itemId: flour,
				quantity: -100_000,
				kind: 'transfer_out' as const,
				sourceType: 'transfer',
				sourceId: `t_out_${index}`,
				businessDate: addDays(today, -(index + 1)),
				actorKind: 'system' as const,
				createdAt: Date.now() - (index + 1) * 86_400_000,
			})),
		)
		const here = await daysLeftOf(flour, LOC)
		// 500 g of sales plus 100 g sent out a day.
		expect(here.daysLeft).toMatchObject({ state: 'ok', perDay: 600_000 })
	})

	it('sorts by days left, soonest first, items without a number last', async () => {
		const list = listItemsResultSchema.parse(
			await ok(
				call('GET', `${BASE}/items?locationId=${LOC}&limit=200&sort=daysLeft`, {
					token,
				}),
			),
		)
		const states = list.items.map((entry) =>
			entry.daysLeft?.state === 'ok' ? entry.daysLeft.days : null,
		)
		const numbers = states.filter((value): value is number => value !== null)
		expect(numbers).toEqual([...numbers].sort((a, b) => a - b))
		expect(states.indexOf(null)).toBeGreaterThan(numbers.length - 1)
	})
})

describe('Today: runs out before the next delivery', () => {
	it('flags an item without a level that runs out before the supplier delivers', async () => {
		const lamb = await item('Lamb shoulder')
		await seedUse(lamb, { days: 28, perDay: 2_000_000, onHand: 5_000_000 })
		// Runs out on today + 2; the supplier next delivers on today + 4.
		const supplier = await ok(
			call('POST', `${BASE}/suppliers`, {
				token,
				body: {
					clientId: cid('sup'),
					name: 'Lamb Co',
					currency: 'SAR',
					deliveryDays: [dayOfWeek(addDays(today, 4))],
				},
			}),
		)
		await ok(
			call('POST', `${BASE}/suppliers/${supplier.id}/products`, {
				token,
				body: {
					itemId: lamb,
					packName: 'Box',
					packBaseQuantity: 5_000_000,
					priceMinor: 10_000,
				},
			}),
		)
		const result = todaySchema.parse(
			await ok(call('GET', `${BASE}/today?locationId=${LOC}`, { token })),
		)
		const flag = result.attention.find(
			(entry) => entry.kind === 'runs_out_soon',
		)
		expect(flag).toMatchObject({
			kind: 'runs_out_soon',
			itemId: lamb,
			itemName: 'Lamb shoulder',
			runsOutDate: addDays(today, 2),
			nextDeliveryDate: addDays(today, 4),
			supplierName: 'Lamb Co',
		})
	})

	it('does not flag it when the supplier delivers in time', async () => {
		const beef = await item('Beef ribs')
		await seedUse(beef, { days: 28, perDay: 2_000_000, onHand: 5_000_000 })
		const supplier = await ok(
			call('POST', `${BASE}/suppliers`, {
				token,
				body: {
					clientId: cid('sup'),
					name: 'Beef Co',
					currency: 'SAR',
					deliveryDays: [dayOfWeek(addDays(today, 1))],
				},
			}),
		)
		await ok(
			call('POST', `${BASE}/suppliers/${supplier.id}/products`, {
				token,
				body: {
					itemId: beef,
					packName: 'Box',
					packBaseQuantity: 5_000_000,
					priceMinor: 10_000,
				},
			}),
		)
		const result = todaySchema.parse(
			await ok(call('GET', `${BASE}/today?locationId=${LOC}`, { token })),
		)
		const flag = result.attention.find(
			(entry) => entry.kind === 'runs_out_soon',
		)
		// Only the lamb is flagged; the beef is delivered tomorrow.
		expect(flag).toMatchObject({ itemName: 'Lamb shoulder', more: 0 })
	})
})
