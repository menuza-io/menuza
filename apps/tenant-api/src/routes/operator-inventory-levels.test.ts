import {
	levelSuggestionsSchema,
	listLevelsResultSchema,
	todaySchema,
} from '@repo/inventory'
import { addDays } from '@repo/reservations'
import {
	destroyTenantDb,
	getTenantDb,
	invMovements,
	provisionTenantDb,
} from '@repo/tenant-db'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { type PublishedOrganization } from '../lib/origin.ts'
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

const ORG = 'org_inv_levels_suggestions'
const LOC = 'loc_a'
const KG = 1_000_000

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

async function createItem(name: string) {
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

async function seedUse(itemId: string, days: number, perDay: number) {
	const db = await getTenantDb(ORG)
	const rows: (typeof invMovements.$inferInsert)[] = [
		{
			locationId: LOC,
			itemId,
			quantity: 200 * KG,
			kind: 'delivery',
			sourceType: 'delivery',
			sourceId: `d_${itemId}`,
			businessDate: addDays(today, -30),
			actorKind: 'system',
			createdAt: Date.now() - 40 * 86_400_000,
		},
	]
	for (let offset = 1; offset <= days; offset++) {
		rows.push({
			locationId: LOC,
			itemId,
			quantity: -perDay,
			kind: 'sale',
			sourceType: 'pos_order',
			sourceId: `s_${itemId}_${offset}`,
			businessDate: addDays(today, -offset),
			actorKind: 'system',
			createdAt: Date.now() - offset * 86_400_000,
		})
	}
	await db.insert(invMovements).values(rows)
}

beforeAll(async () => {
	env = setupTenantEnv('inv-levels')
	orgs.set(ORG, {
		id: ORG,
		slug: ORG,
		customDomain: null,
		hasProvisionedDb: true,
		dataRegion: 'us',
		name: ORG,
	})
	await provisionTenantDb(ORG)
	token = await mintToken(ORG, { grants: [READ, UPDATE, PURCHASING] })
	const t = todaySchema.parse(
		await ok(call('GET', `${BASE}/today?locationId=${LOC}`, { token })),
	)
	today = t.date
})

afterAll(async () => {
	await destroyTenantDb(ORG)
	env.cleanup()
})

describe('GET /levels/suggestions (#498)', () => {
	it('returns structured delivery-aware pack-rounded suggestions for >=14 days and not_enough_history for <14 days without modifying levels', async () => {
		const chicken = await createItem('Chicken thighs')
		const garlic = await createItem('Garlic sauce')
		const basil = await createItem('Fresh basil')

		const supplier = await ok(
			call('POST', `${BASE}/suppliers`, {
				token,
				body: {
					clientId: cid('sup'),
					name: 'Al Watania',
					currency: 'SAR',
					deliveryDays: [1, 4],
					cutoffTime: '16:00',
					cutoffDaysBefore: 1,
				},
			}),
		)
		await ok(
			call('POST', `${BASE}/suppliers/${supplier.id}/products`, {
				token,
				body: {
					itemId: chicken,
					packName: '5 kg Box',
					packBaseQuantity: 5 * KG,
					priceMinor: 9000,
					preferred: true,
				},
			}),
		)

		await seedUse(chicken, 16, 3 * KG)
		await seedUse(garlic, 14, 2 * KG)
		await seedUse(basil, 10, 1 * KG)

		const res = levelSuggestionsSchema.parse(
			await ok(
				call('GET', `${BASE}/levels/suggestions?locationId=${LOC}`, { token }),
			),
		)

		const chickenSug = res.suggestions.find((s) => s.itemId === chicken)!
		expect(chickenSug.state).toBe('ok')
		expect(chickenSug.useDays).toBe(16)
		expect(chickenSug.dailyUseQuantity).toBe(3 * KG)
		expect(chickenSug.deliveryDays).toEqual([1, 4])
		expect(chickenSug.cycleDays).toBeNull()
		expect(chickenSug.supplierName).toBe('Al Watania')
		expect(chickenSug.packName).toBe('5 kg Box')
		expect(chickenSug.packBaseQuantity).toBe(5 * KG)
		expect(chickenSug.orderBelowQuantity % (5 * KG)).toBe(0)
		expect(chickenSug.fillUpToQuantity % (5 * KG)).toBe(0)
		expect(chickenSug.orderBelowQuantity).toBeGreaterThan(0)
		expect(chickenSug.orderBelowQuantity).toBeLessThanOrEqual(
			chickenSug.fillUpToQuantity,
		)

		const garlicSug = res.suggestions.find((s) => s.itemId === garlic)!
		expect(garlicSug.state).toBe('ok')
		expect(garlicSug.useDays).toBe(14)
		expect(garlicSug.dailyUseQuantity).toBe(2 * KG)
		expect(garlicSug.deliveryDays).toEqual([])
		expect(garlicSug.cycleDays).toBe(7)
		expect(garlicSug.supplierName).toBeNull()
		expect(garlicSug.packBaseQuantity).toBeNull()
		expect(garlicSug.orderBelowQuantity).toBe(14 * KG)
		expect(garlicSug.fillUpToQuantity).toBe(33_600_000)

		const basilSug = res.suggestions.find((s) => s.itemId === basil)!
		expect(basilSug).toMatchObject({
			itemId: basil,
			state: 'not_enough_history',
			useDays: 10,
			orderBelowQuantity: 0,
			fillUpToQuantity: 0,
		})

		// Suggestions never change stored levels on their own.
		const levels = listLevelsResultSchema.parse(
			await ok(call('GET', `${BASE}/levels?locationId=${LOC}`, { token })),
		)
		for (const row of levels.levels) {
			expect(row.orderBelowQuantity).toBeNull()
			expect(row.fillUpToQuantity).toBeNull()
		}
	})
})
