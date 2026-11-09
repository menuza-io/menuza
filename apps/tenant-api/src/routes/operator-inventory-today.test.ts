import { todaySchema } from '@repo/inventory'
import { currentBusinessDate, dayOfWeek } from '@repo/reservations'
import {
	destroyTenantDb,
	getTenantDb,
	invCounts,
	invMovements,
	provisionTenantDb,
} from '@repo/tenant-db'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { type PublishedOrganization } from '../lib/origin.ts'
import { insertPosSale } from '../services/loyalty-test-fixture.ts'
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
 * Today: four metrics and at most five attention rows ranked by money at
 * stake, the week ahead, food cost between two approved counts, and what a
 * token without the cost grant gets (no money anywhere).
 */

const ORG = 'org_inv_today_a'
const ORG_B = 'org_inv_today_b'
const LOC = 'loc_today'

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
let full: string
let noCost: string
let readOnly: string
let tokenB: string
let scoped: string
const today = currentBusinessDate(Date.now(), 'UTC', 240)

beforeAll(async () => {
	env = setupTenantEnv('inv-today')
	for (const id of [ORG, ORG_B]) {
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
	full = await mintToken(ORG)
	noCost = await mintToken(ORG, { grants: [READ, UPDATE] })
	readOnly = await mintToken(ORG, { scope: 'read', grants: [READ] })
	tokenB = await mintToken(ORG_B)
	scoped = await mintToken(ORG, { locationIds: ['loc_elsewhere'] })
})

afterAll(async () => {
	await destroyTenantDb(ORG)
	await destroyTenantDb(ORG_B)
	env.cleanup()
})

async function ok(method: string, path: string, token: string, body?: unknown) {
	const res = await call(method, `${BASE}${path}`, { token, body })
	expect(res.status, `${method} ${path} ${JSON.stringify(res.body)}`).toBe(200)
	return res.body
}

const getToday = async (token: string, locationId = LOC) =>
	todaySchema.parse(await ok('GET', `/today?locationId=${locationId}`, token))

const world = { chicken: '', rice: '', supplier: '' }

describe('GET /today', () => {
	it('on an empty location answers zeros, no attention and the setup facts', async () => {
		const empty = await getToday(full)
		expect(empty).toMatchObject({
			locationId: LOC,
			date: today,
			attention: [],
			week: [],
			setup: { items: 0, storageAreas: 0, approvedCounts: 0, deliveries: 0 },
		})
		expect(empty.metrics).toMatchObject({
			stockValueMinor: 0,
			lastCountAt: null,
			wasteWeekCount: 0,
			lowItems: 0,
			outItems: 0,
			foodCost: {
				state: 'need_two_counts',
				from: null,
				to: null,
				targetBp: 3000,
			},
		})
	})

	it('ranks what needs attention by money at stake and lists the week ahead', async () => {
		await ok('PUT', '/settings', full, {
			expectedVersion: 0,
			countDayOfWeek: dayOfWeek(today),
		})
		world.supplier = (
			await ok('POST', '/suppliers', full, {
				clientId: cid('sup'),
				name: 'Today supplier',
				currency: 'SAR',
				deliveryDays: [0, 1, 2, 3, 4, 5, 6],
			})
		).id
		const create = async (
			name: string,
			baseUnit: string,
			extra: Record<string, unknown> = {},
		) =>
			ok('POST', '/items', full, {
				clientId: cid('item'),
				name,
				category: 'meat',
				kind: 'bought',
				baseUnit,
				place: {
					locationId: LOC,
					countUnit: baseUnit === 'g' ? 'kg' : 'l',
					areaIds: [],
					orderBelowQuantity: 8_000_000,
					fillUpToQuantity: 30_000_000,
				},
				...extra,
			})
		world.chicken = (await create('Today chicken', 'g')).id
		world.rice = (await create('Today rice', 'g')).id
		const salt = (await create('Today salt', 'g')).id
		await ok('POST', `/suppliers/${world.supplier}/products`, full, {
			itemId: world.chicken,
			packName: 'Box',
			packBaseQuantity: 10_000_000,
			priceMinor: 28000,
			preferred: true,
		})
		const deliver = (total: number) =>
			ok('POST', '/deliveries', full, {
				clientId: cid('del'),
				locationId: LOC,
				supplierId: world.supplier,
				currency: 'SAR',
				lines: [
					{
						itemId: world.chicken,
						quantity: 10_000_000,
						lineTotalMinor: total,
					},
				],
			})
		await deliver(28000)
		await new Promise((resolve) => setTimeout(resolve, 8))
		const second = await deliver(33000)
		expect(second.priceChanges[0].changeBp).toBe(1786)
		await ok('POST', `/items/${salt}/adjust`, full, {
			clientId: cid('adj'),
			locationId: LOC,
			quantity: 50_000_000,
			reason: 'found',
		})
		await ok('POST', '/waste', full, {
			entries: [
				{
					clientId: cid('w'),
					locationId: LOC,
					itemId: world.chicken,
					amount: 14,
					unit: 'kg',
					reason: 'spoiled',
				},
			],
		})

		const view = await getToday(full)
		expect(view.metrics).toMatchObject({
			stockValueMinor: 18300,
			wasteWeekCount: 1,
			wasteWeekMinor: 42700,
			wasteWeekShareBp: 7000,
			lowItems: 1,
			outItems: 1,
			currency: 'SAR',
			lastCountAt: null,
		})
		expect(view.attention).toEqual([
			{
				kind: 'low_stock',
				itemId: world.chicken,
				itemName: 'Today chicken',
				onHand: 6_000_000,
				countUnit: 'kg',
				baseUnit: 'g',
				status: 'low',
				supplierId: world.supplier,
				supplierName: 'Today supplier',
				more: 1,
				valueAtStakeMinor: 73200,
			},
			{
				kind: 'price_rise',
				itemId: world.chicken,
				itemName: 'Today chicken',
				changeBp: 1786,
				deliveryId: second.delivery.id,
				supplierName: 'Today supplier',
			},
			{ kind: 'count_due', date: today },
		])
		expect(view.week).toHaveLength(8)
		expect(view.week[0]).toEqual({
			date: today,
			kind: 'count',
			supplierId: null,
			supplierName: null,
		})
		expect(view.week[1]).toMatchObject({
			date: today,
			kind: 'delivery',
			supplierName: 'Today supplier',
		})
		expect(view.setup).toMatchObject({
			items: 3,
			deliveries: 2,
			approvedCounts: 0,
		})
	})

	it('shows a count in progress, then waiting for review, ahead of the count due', async () => {
		const started = await ok('POST', '/counts', full, {
			clientId: cid('count'),
			locationId: LOC,
			listId: null,
		})
		let view = await getToday(full)
		expect(view.attention.map((item) => item.kind)).toEqual([
			'low_stock',
			'price_rise',
			'count_in_progress',
		])
		expect(view.attention[2]).toEqual({
			kind: 'count_in_progress',
			countId: started.id,
			itemsCounted: 0,
			itemTotal: 3,
		})
		await ok('POST', `/counts/${started.id}/entries`, full, {
			entries: [
				{
					clientId: cid('e'),
					itemId: world.chicken,
					areaId: null,
					amount: 4,
					unit: 'kg',
				},
			],
		})
		await ok('POST', `/counts/${started.id}/send`, full, { expectedVersion: 1 })
		view = await getToday(full)
		// 2 kg short at 3.05 per gram (6100) outranks the price rise (5000).
		expect(view.attention.map((item) => item.kind)).toEqual([
			'low_stock',
			'count_in_review',
			'price_rise',
		])
		expect(view.attention[1]).toEqual({
			kind: 'count_in_review',
			countId: started.id,
		})
		await ok('POST', `/counts/${started.id}/cancel`, full, {
			expectedVersion: 2,
		})
		view = await getToday(full)
		expect(view.attention.map((item) => item.kind)).toContain('count_due')
	})

	it('gives a token without the cost grant counts and quantities only', async () => {
		const view = await getToday(noCost)
		const text = JSON.stringify(view)
		for (const field of [
			'Minor',
			'currency',
			'foodCost',
			'ShareBp',
			'price_rise',
		]) {
			expect(text, field).not.toContain(field)
		}
		expect(view.metrics).toMatchObject({
			wasteWeekCount: 1,
			lowItems: 1,
			outItems: 1,
		})
		expect(view.attention[0]).toMatchObject({
			kind: 'low_stock',
			itemName: 'Today rice',
			status: 'out',
			more: 1,
		})
		expect(view.setup.items).toBe(3)
	})

	it('refuses other organizations, excluded locations, a missing location and read-only access is fine', async () => {
		const other = await getToday(tokenB)
		expect(other.setup.items).toBe(0)
		const excluded = await call('GET', `${BASE}/today?locationId=${LOC}`, {
			token: scoped,
		})
		expect(excluded.status).toBe(403)
		expect(excluded.body.code).toBe('location_forbidden')
		expect((await call('GET', `${BASE}/today`, { token: full })).status).toBe(
			400,
		)
		expect(
			(
				await call('GET', `${BASE}/today?locationId=${LOC}`, {
					token: readOnly,
				})
			).status,
		).toBe(200)
	})

	it('caps attention at five rows', async () => {
		const location = 'loc_many'
		for (let i = 0; i < 3; i++) {
			await ok('POST', '/items', full, {
				clientId: cid('item'),
				name: `Many low ${i}`,
				category: 'meat',
				kind: 'bought',
				baseUnit: 'g',
				place: {
					locationId: location,
					countUnit: 'kg',
					areaIds: [],
					orderBelowQuantity: 1000,
					fillUpToQuantity: null,
				},
			})
		}
		const view = await getToday(full, location)
		expect(view.attention.length).toBeLessThanOrEqual(5)
		expect(view.attention[0]).toMatchObject({
			kind: 'low_stock',
			more: view.metrics.outItems - 1,
		})
	})
})

describe('food cost', () => {
	it('is (opening + purchases - closing) / net sales between the two latest approved full counts', async () => {
		const location = 'loc_food'
		const item = await ok('POST', '/items', full, {
			clientId: cid('item'),
			name: 'Food cost item',
			category: 'meat',
			kind: 'bought',
			baseUnit: 'g',
		})
		const db = await getTenantDb(ORG)
		const t1 = Date.UTC(2026, 10, 1, 20, 0, 0)
		const t2 = t1 + 7 * 24 * 3600_000
		const count = (id: string, businessDate: string, approvedAt: number) => ({
			id,
			locationId: location,
			status: 'approved' as const,
			businessDate,
			startedByKind: 'operator' as const,
			approvedAt,
			createdAt: approvedAt - 1000,
		})
		await db
			.insert(invCounts)
			.values([count('cf1', '2026-11-01', t1), count('cf2', '2026-11-08', t2)])
		const movement = (
			kind: 'count' | 'delivery' | 'waste',
			quantity: number,
			valueMinor: number,
			createdAt: number,
			key: string,
		) => ({
			locationId: location,
			itemId: item.id,
			quantity,
			valueMinor,
			currency: 'SAR',
			kind,
			sourceType: kind,
			sourceId: key,
			eventKey: `food:${key}`,
			businessDate: '2026-11-03',
			actorKind: 'operator' as const,
			createdAt,
		})
		await db.insert(invMovements).values([
			movement('count', 1000, 30000, t1, 'a'),
			movement('delivery', 1000, 20000, t1 + 3600_000, 'b'),
			movement('waste', -1000, -25000, t1 + 7200_000, 'c'),
			// Before the opening count: part of its value, not of purchases.
			movement('delivery', 1000, 99, t1 - 3600_000, 'd'),
		])
		await insertPosSale(ORG, {
			locationId: location,
			currency: 'SAR',
			businessDate: '2026-11-05',
			subtotalCents: 100000,
			totalCents: 100000,
			lines: [
				{
					id: 'l1',
					itemId: 'dish_1',
					name: 'Dish',
					variantId: null,
					variantLabel: null,
					quantity: 1,
					baseCents: 100000,
					instructions: '',
					options: [],
				},
			],
		})
		// A sale on the opening day itself and one after the closing day do not count.
		await insertPosSale(ORG, {
			locationId: location,
			currency: 'SAR',
			businessDate: '2026-11-01',
			subtotalCents: 5000,
			totalCents: 5000,
			lines: [
				{
					id: 'l1',
					itemId: 'dish_1',
					name: 'Dish',
					variantId: null,
					variantLabel: null,
					quantity: 1,
					baseCents: 5000,
					instructions: '',
					options: [],
				},
			],
		})
		await insertPosSale(ORG, {
			locationId: location,
			currency: 'SAR',
			businessDate: '2026-11-09',
			subtotalCents: 7000,
			totalCents: 7000,
			lines: [
				{
					id: 'l1',
					itemId: 'dish_1',
					name: 'Dish',
					variantId: null,
					variantLabel: null,
					quantity: 1,
					baseCents: 7000,
					instructions: '',
					options: [],
				},
			],
		})

		const view = await getToday(full, location)
		expect(view.metrics.foodCost).toEqual({
			state: 'ok',
			from: '2026-11-01',
			to: '2026-11-08',
			targetBp: 3000,
			bp: 2500,
			openingMinor: 30099,
			purchasesMinor: 20000,
			closingMinor: 25099,
			salesMinor: 100000,
		})
		expect(view.metrics.lastCountAt).toBe(t2)
		expect(view.setup.approvedCounts).toBe(2)
	})
})
