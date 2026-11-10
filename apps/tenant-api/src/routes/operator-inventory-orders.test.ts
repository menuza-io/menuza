import {
	addDaysIso,
	levelSuggestionsSchema,
	listLevelsResultSchema,
	listOrdersResultSchema,
	nextOrderableDelivery,
	orderDetailSchema,
	orderTextSchema,
	putLevelsResultSchema,
	receivePrefillSchema,
	sendOrderResultSchema,
	suggestedOrdersSchema,
	todaySchema,
} from '@repo/inventory'
import { currentBusinessDate } from '@repo/reservations'
import {
	destroyTenantDb,
	getTenantDb,
	invMovements,
	provisionTenantDb,
} from '@repo/tenant-db'
import { Hono } from 'hono'
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from 'vitest'
import { type PublishedOrganization } from '../lib/origin.ts'
import { setTenantEmailDevCapture } from '../lib/tenant-email.ts'
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

/**
 * Levels, suggested orders, orders, sending and the text of an order: the
 * rounding of a suggestion from real stock, what counts as on order, the
 * status of an order, who may see money, and the flag and grant rules.
 */

const ORG = 'org_inv_ord_a'
const ORG_B = 'org_inv_ord_b'
const LOC = 'loc_ord'
const SUG_LOC = 'loc_ord_sug'

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

const email = vi.hoisted(() => ({ fail: false }))

// The send goes through the real `sendTenantEmail`; only the provider call can be made to fail.
vi.mock('@repo/email', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@repo/email')>()
	return {
		...actual,
		sendOciEmail: async (input: Parameters<typeof actual.sendOciEmail>[0]) =>
			email.fail
				? ({
						status: 'error',
						error: { message: 'provider down', statusCode: 500 },
					} as const)
				: actual.sendOciEmail(input),
	}
})

const app = new Hono()
app.route(BASE, operatorInventoryRoutes)
const call = makeClient(app)

let env: ReturnType<typeof setupTenantEnv>
let full: string
let noCost: string
let noPurchasing: string
let flagOff: string
let readOnly: string
let tokenB: string
let scoped: string
let world: ReturnType<typeof makeWorld>
let sugWorld: ReturnType<typeof makeWorld>
const today = currentBusinessDate(Date.now(), 'UTC', 240)

beforeAll(async () => {
	env = setupTenantEnv('inv-ord')
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
	noCost = await mintToken(ORG, { grants: [READ, UPDATE, PURCHASING] })
	noPurchasing = await mintToken(ORG, { grants: [READ, UPDATE] })
	flagOff = await mintToken(ORG, { features: { purchasing: false } })
	readOnly = await mintToken(ORG, { scope: 'read', grants: [READ] })
	tokenB = await mintToken(ORG_B)
	scoped = await mintToken(ORG, { locationIds: ['loc_elsewhere'] })
	world = makeWorld(call, full, LOC)
	sugWorld = makeWorld(call, full, SUG_LOC)
	// Metric units, so a count unit of kilograms rounds the way the tests say.
	await world.ok('PUT', '/settings', {
		expectedVersion: 0,
		unitSystem: 'metric',
	})
})

afterEach(() => setTenantEmailDevCapture(null))

afterAll(async () => {
	await destroyTenantDb(ORG)
	await destroyTenantDb(ORG_B)
	env.cleanup()
})

describe('levels', () => {
	it('lists every item with its level, sets levels in bulk, refuses stale rows singly and replays a clientId', async () => {
		const supplier = await world.supplier('Levels Supplier')
		const flour = await world.item('Levels flour')
		const rice = await world.item('Levels rice')
		const salt = await world.item('Levels salt')
		await world.product(supplier.id, flour.id, {
			packName: 'Sack 25 kg',
			packBaseQuantity: 25_000_000,
			priceMinor: 9000,
		})

		const before = await call('GET', `${BASE}/levels?locationId=${LOC}`, {
			token: full,
		})
		expect(before.status).toBe(200)
		const listed = listLevelsResultSchema.parse(before.body)
		const row = listed.levels.find((level) => level.itemId === flour.id)!
		expect(row).toMatchObject({
			name: 'Levels flour',
			orderBelowQuantity: null,
			fillUpToQuantity: null,
			placeVersion: 0,
			supplierName: 'Levels Supplier',
			packName: 'Sack 25 kg',
			packBaseQuantity: 25_000_000,
		})

		const body = {
			clientId: cid('lvl'),
			locationId: LOC,
			levels: [
				{
					itemId: flour.id,
					orderBelowQuantity: 10_000_000,
					fillUpToQuantity: 50_000_000,
					expectedVersion: 0,
				},
				{
					itemId: rice.id,
					orderBelowQuantity: 5_000_000,
					fillUpToQuantity: null,
					expectedVersion: 3,
				},
				{
					itemId: 'no-such-item',
					orderBelowQuantity: 1,
					fillUpToQuantity: null,
					expectedVersion: 0,
				},
			],
		}
		const saved = await call('PUT', `${BASE}/levels/bulk`, {
			token: full,
			body,
		})
		expect(saved.status).toBe(200)
		const result = putLevelsResultSchema.parse(saved.body)
		expect(result.updated).toEqual([
			{
				itemId: flour.id,
				version: 1,
				orderBelowQuantity: 10_000_000,
				fillUpToQuantity: 50_000_000,
			},
		])
		expect(result.refused).toEqual([
			{ itemId: rice.id, code: 'stale_version' },
			{ itemId: 'no-such-item', code: 'not_found' },
		])
		// A replay of the same clientId answers the first result and writes nothing.
		const replay = await call('PUT', `${BASE}/levels/bulk`, {
			token: full,
			body,
		})
		expect(replay.body).toEqual(saved.body)
		// The same clientId with other rows is a conflict.
		const conflict = await call('PUT', `${BASE}/levels/bulk`, {
			token: full,
			body: { ...body, levels: [body.levels[0]] },
		})
		expect(conflict.status).toBe(409)
		expect(conflict.body.code).toBe('idempotency_conflict')
		// The place row was created with the default count unit.
		const after = listLevelsResultSchema.parse(
			(await call('GET', `${BASE}/levels?locationId=${LOC}`, { token: full }))
				.body,
		)
		expect(
			after.levels.find((level) => level.itemId === flour.id),
		).toMatchObject({
			placeVersion: 1,
			countUnit: 'kg',
			orderBelowQuantity: 10_000_000,
		})

		// A second save with the version it read works; the old version is stale.
		const again = await world.ok('PUT', '/levels/bulk', {
			clientId: cid('lvl'),
			locationId: LOC,
			levels: [
				{
					itemId: flour.id,
					orderBelowQuantity: 12_000_000,
					fillUpToQuantity: 50_000_000,
					expectedVersion: 1,
				},
				{
					itemId: salt.id,
					orderBelowQuantity: 1_000_000,
					fillUpToQuantity: 3_000_000,
					expectedVersion: 0,
				},
			],
		})
		expect(
			again.updated.map((entry: { version: number }) => entry.version),
		).toEqual([2, 1])

		// Filters.
		const unset = listLevelsResultSchema.parse(
			(
				await call(
					'GET',
					`${BASE}/levels?locationId=${LOC}&filter=unset&q=levels`,
					{ token: full },
				)
			).body,
		)
		expect(unset.levels.map((level) => level.name)).toEqual(['Levels rice'])
		const set = listLevelsResultSchema.parse(
			(
				await call(
					'GET',
					`${BASE}/levels?locationId=${LOC}&filter=set&q=levels`,
					{
						token: full,
					},
				)
			).body,
		)
		expect(set.levels.map((level) => level.name)).toEqual([
			'Levels flour',
			'Levels salt',
		])
		const bySupplier = listLevelsResultSchema.parse(
			(
				await call(
					'GET',
					`${BASE}/levels?locationId=${LOC}&supplierId=${supplier.id}`,
					{ token: full },
				)
			).body,
		)
		expect(bySupplier.levels.map((level) => level.name)).toEqual([
			'Levels flour',
		])
	})

	it('refuses a level above its fill-up-to, and duplicate items in one request', async () => {
		const item = await world.item('Levels bad')
		const bad = await call('PUT', `${BASE}/levels/bulk`, {
			token: full,
			body: {
				clientId: cid('lvl'),
				locationId: LOC,
				levels: [
					{
						itemId: item.id,
						orderBelowQuantity: 9,
						fillUpToQuantity: 5,
						expectedVersion: 0,
					},
				],
			},
		})
		expect(bad.status).toBe(400)
		expect(bad.body.code).toBe('invalid_request')
		const row = {
			itemId: item.id,
			orderBelowQuantity: 1,
			fillUpToQuantity: 2,
			expectedVersion: 0,
		}
		const dup = await call('PUT', `${BASE}/levels/bulk`, {
			token: full,
			body: { clientId: cid('lvl'), locationId: LOC, levels: [row, row] },
		})
		expect(dup.status).toBe(400)
	})

	it('suggests levels from what was used (sales, waste and counted shortfalls, never deliveries)', async () => {
		const item = await world.item('Levels used')
		const other = await world.item('Levels unused')
		await world.levels([
			{ itemId: item.id, orderBelowQuantity: null, fillUpToQuantity: null },
		])
		const db = await getTenantDb(ORG)
		const at = (daysAgo: number) => addDaysIso(today, -daysAgo)
		const move = (
			itemId: string,
			kind: 'sale' | 'delivery' | 'count' | 'waste',
			quantity: number,
			daysAgo: number,
		) =>
			db.insert(invMovements).values({
				locationId: LOC,
				itemId,
				quantity,
				kind,
				sourceType: kind,
				sourceId: `src-${kind}-${daysAgo}-${quantity}`,
				businessDate: at(daysAgo),
				actorKind: 'system',
			})
		await move(item.id, 'delivery', 100_000_000, 40)
		await move(other.id, 'delivery', 10_000_000, 40)
		await move(item.id, 'sale', -20_000_000, 10)
		await move(item.id, 'sale', -4_000_000, 3)
		await move(item.id, 'waste', -3_000_000, 2)
		// A counted shortfall counts as used; a count that found more does not.
		await move(item.id, 'count', -1_000_000, 1)
		await move(item.id, 'count', 5_000_000, 1)
		// Outside the 28-day window: not used.
		await move(item.id, 'sale', -50_000_000, 35)

		const res = await call(
			'GET',
			`${BASE}/levels/suggestions?locationId=${LOC}&days=28`,
			{ token: full },
		)
		expect(res.status).toBe(200)
		const view = levelSuggestionsSchema.parse(res.body)
		expect(view).toMatchObject({ days: 28, daysObserved: 28 })
		const mine = view.suggestions.find((entry) => entry.itemId === item.id)!
		// 28 kg used over 28 days: a kilogram a day, 7 kg a week, rounded up to whole kilograms.
		expect(mine).toEqual({
			itemId: item.id,
			usedQuantity: 28_000_000,
			weeklyUseQuantity: 7_000_000,
			orderBelowQuantity: 3_000_000,
			fillUpToQuantity: 7_000_000,
		})
		expect(view.suggestions.some((entry) => entry.itemId === other.id)).toBe(
			false,
		)

		const longer = levelSuggestionsSchema.parse(
			(
				await call(
					'GET',
					`${BASE}/levels/suggestions?locationId=${LOC}&days=28&coverDays=14&orderBelowDays=7`,
					{ token: full },
				)
			).body,
		)
		expect(
			longer.suggestions.find((entry) => entry.itemId === item.id),
		).toMatchObject({
			orderBelowQuantity: 7_000_000,
			fillUpToQuantity: 14_000_000,
		})
	})

	it('needs the purchasing flag, the right grants and a location the token may use', async () => {
		const get = (token: string, path = `/levels?locationId=${LOC}`) =>
			call('GET', `${BASE}${path}`, { token })
		expect((await get(flagOff)).body).toMatchObject({
			code: 'feature_disabled',
		})
		expect((await get(scoped)).body).toMatchObject({
			code: 'location_forbidden',
		})
		expect((await get(readOnly)).status).toBe(200)
		const put = (token: string) =>
			call('PUT', `${BASE}/levels/bulk`, {
				token,
				body: {
					clientId: cid('lvl'),
					locationId: LOC,
					levels: [
						{
							itemId: 'x',
							orderBelowQuantity: null,
							fillUpToQuantity: null,
							expectedVersion: 0,
						},
					],
				},
			})
		expect((await put(noPurchasing)).body).toMatchObject({
			code: 'forbidden',
			required: PURCHASING,
		})
		expect((await put(readOnly)).body).toMatchObject({ reason: 'scope' })
		expect((await put(flagOff)).body).toMatchObject({
			code: 'feature_disabled',
		})
	})
})

describe('suggested orders', () => {
	// One supplier with a delivery every day and a cut-off at midnight, so the
	// first delivery it can still make is the day after tomorrow.
	let fresh: { id: string }
	let other: { id: string }
	let chicken: { id: string }
	let lamb: { id: string }
	let oil: { id: string }
	let salt: { id: string }
	let flour: { id: string }
	let freshChicken: { id: string }
	let freshLamb: { id: string }
	let freshOil: { id: string }
	let drum: { id: string }

	beforeAll(async () => {
		fresh = await sugWorld.supplier('Sug Fresh Farms', {
			email: 'orders@fresh.example',
			phone: '+966 50 123 4567',
			contactName: 'Omar',
			orderChannel: 'email',
			deliveryDays: [0, 1, 2, 3, 4, 5, 6],
			cutoffTime: '00:00',
			cutoffDaysBefore: 1,
			minimumOrderMinor: 250_000,
		})
		other = await sugWorld.supplier('Sug Other Oils')
		chicken = await sugWorld.item('Sug chicken')
		lamb = await sugWorld.item('Sug lamb')
		oil = await sugWorld.item('Sug oil', 'ml')
		salt = await sugWorld.item('Sug salt')
		flour = await sugWorld.item('Sug flour')
		freshChicken = await sugWorld.product(fresh.id, chicken.id, {
			packName: 'Box 10 kg',
			packBaseQuantity: 10_000_000,
			priceMinor: 28_000,
			preferred: true,
		})
		freshLamb = await sugWorld.product(fresh.id, lamb.id, {
			packName: 'Leg about 5 kg',
			packBaseQuantity: 5_000_000,
			priceMinor: 20_000,
			pricedByWeight: true,
		})
		freshOil = await sugWorld.product(fresh.id, oil.id, {
			packName: 'Can 5 L',
			packBaseQuantity: 5_000_000,
			priceMinor: 9_000,
		})
		drum = await sugWorld.product(other.id, oil.id, {
			packName: 'Drum 20 L',
			packBaseQuantity: 20_000_000,
			priceMinor: 30_000,
		})
		await sugWorld.levels([
			{
				itemId: chicken.id,
				orderBelowQuantity: 20_000_000,
				fillUpToQuantity: 50_000_000,
			},
			{
				itemId: lamb.id,
				orderBelowQuantity: 5_000_000,
				fillUpToQuantity: 12_000_000,
			},
			{
				itemId: oil.id,
				orderBelowQuantity: 10_000_000,
				fillUpToQuantity: 20_000_000,
			},
			{
				itemId: salt.id,
				orderBelowQuantity: 1_000_000,
				fillUpToQuantity: 3_000_000,
			},
			{
				itemId: flour.id,
				orderBelowQuantity: 5_000_000,
				fillUpToQuantity: 10_000_000,
			},
		])
		await sugWorld.stock(chicken.id, 6_000_000)
		await sugWorld.stock(lamb.id, 1_000_000)
		await sugWorld.stock(salt.id, 500_000)
		await sugWorld.stock(flour.id, 8_000_000)
	})

	const suggested = async (token = full) => {
		const res = await call(
			'GET',
			`${BASE}/orders/suggested?locationId=${SUG_LOC}`,
			{
				token,
			},
		)
		expect(res.status, JSON.stringify(res.body)).toBe(200)
		return { raw: res.body, view: suggestedOrdersSchema.parse(res.body) }
	}

	it('rounds the quantity up to whole packs (halves for a pack priced by weight) and picks the supplier product by the rules', async () => {
		const { view } = await suggested()
		expect(view.locationId).toBe(SUG_LOC)
		expect(view.toOrderItems).toBe(3)
		expect(view.suppliers.map((card) => card.supplierName)).toEqual([
			'Sug Fresh Farms',
			'Sug Other Oils',
		])
		const card = view.suppliers[0]!
		expect(card.lineCount).toBe(2)
		const lines = Object.fromEntries(
			card.lines.map((line) => [line.itemName, line]),
		)
		// 44 kg short of 50 kg in 10 kg boxes: 4.4 boxes, five bought.
		expect(lines['Sug chicken']).toMatchObject({
			supplierProductId: freshChicken.id,
			onHand: 6_000_000,
			onOrderQuantity: 0,
			status: 'low',
			packs: 5,
			quantity: 50_000_000,
			packPriceMinor: 28_000,
			lineTotalMinor: 140_000,
		})
		// 11 kg short in a pack priced by weight: 2.2 packs, ordered in halves.
		expect(lines['Sug lamb']).toMatchObject({
			supplierProductId: freshLamb.id,
			pricedByWeight: true,
			packs: 2.5,
			quantity: 12_500_000,
			lineTotalMinor: 50_000,
		})
		// No preferred product and two suppliers: the cheaper per millilitre wins.
		const oilCard = view.suppliers[1]!
		expect(oilCard.lines).toHaveLength(1)
		expect(oilCard.lines[0]).toMatchObject({
			itemName: 'Sug oil',
			supplierProductId: drum.id,
			status: 'out',
			packs: 1,
			quantity: 20_000_000,
		})
		expect(freshOil.id).not.toBe(drum.id)
		// Salt has levels and no supplier; flour is above its level.
		expect(view.unsourced.map((entry) => entry.itemName)).toEqual(['Sug salt'])
		expect(
			view.suppliers.flatMap((entry) =>
				entry.lines.map((line) => line.itemName),
			),
		).not.toContain('Sug flour')

		// Money: totals, the minimum, and what is short of it.
		expect(card).toMatchObject({
			currency: 'SAR',
			totalMinor: 190_000,
			minimumOrderMinor: 250_000,
			belowMinimum: true,
			unpricedLines: 0,
		})
		// The delivery day and the cut-off follow the supplier's schedule.
		const now = new Date()
		const local = {
			date: now.toISOString().slice(0, 10),
			time: now.toISOString().slice(11, 16),
		}
		const next = nextOrderableDelivery(
			{
				deliveryDays: [0, 1, 2, 3, 4, 5, 6],
				cutoffTime: '00:00',
				cutoffDaysBefore: 1,
			},
			local,
		)!
		expect(card.expectedDate).toBe(next.expectedDate)
		expect(card.cutoff).toEqual(next.cutoff)
		expect(card.cutoffPassed).toBe(false)
		expect(card.draftOrderId).toBeNull()
		// The other supplier has no delivery days: no date and no cut-off.
		expect(oilCard).toMatchObject({ expectedDate: null, cutoff: null })
	})

	it('leaves money out for a token without the cost grant, with the same cards', async () => {
		const { raw, view } = await suggested(noCost)
		expect(view.toOrderItems).toBe(3)
		expect(JSON.stringify(raw)).not.toMatch(
			/Minor|currency|belowMinimum|unpricedLines/,
		)
		expect(view.suppliers[0]!.lines[0]).toMatchObject({ packs: 5 })
	})

	it('counts sent orders as stock on the way, but not a draft', async () => {
		const created = await sugWorld.ok('POST', '/orders', {
			clientId: cid('ord'),
			locationId: SUG_LOC,
			supplierId: fresh.id,
			fromSuggestion: true,
		})
		expect(orderDetailSchema.parse(created)).toMatchObject({
			status: 'draft',
			supplierName: 'Sug Fresh Farms',
			lineCount: 2,
			totalMinor: 190_000,
		})
		expect(
			created.lines.map((line: { packs: number; suggestedPacks: number }) => [
				line.packs,
				line.suggestedPacks,
			]),
		).toEqual([
			[5, 5],
			[2.5, 2.5],
		])
		let { view } = await suggested()
		// A draft is not on order: the suggestion is unchanged and offers it.
		expect(view.toOrderItems).toBe(3)
		expect(view.suppliers[0]!.draftOrderId).toBe(created.id)
		expect(view.suppliers[0]!.lines[0]!.onOrderQuantity).toBe(0)

		await sugWorld.ok('POST', `/orders/${created.id}/send`, {
			expectedVersion: created.version,
			channel: 'copy',
		})
		;({ view } = await suggested())
		expect(view.suppliers.map((card) => card.supplierName)).toEqual([
			'Sug Other Oils',
		])
		expect(view.toOrderItems).toBe(1)
	})
})

describe('orders', () => {
	let supplier: { id: string; version: number }
	let otherSupplier: { id: string }
	let item: { id: string }
	let weighed: { id: string }
	let product: { id: string }
	let weighedProduct: { id: string }
	let foreignProduct: { id: string }

	beforeAll(async () => {
		supplier = await world.supplier('Ord Supplier', {
			email: 'buy@ord.example',
			phone: '+966 55 000 1111',
			deliveryDays: [1, 4],
		})
		otherSupplier = await world.supplier('Ord Other')
		item = await world.item('Ord tomatoes')
		weighed = await world.item('Ord beef')
		product = await world.product(supplier.id, item.id, {
			packName: 'Crate 6 kg',
			packBaseQuantity: 6_000_000,
			priceMinor: 4_500,
		})
		weighedProduct = await world.product(supplier.id, weighed.id, {
			packName: 'Side',
			packBaseQuantity: 10_000_000,
			priceMinor: 20_000,
			pricedByWeight: true,
		})
		foreignProduct = await world.product(otherSupplier.id, item.id)
	})

	const create = (extra: Record<string, unknown> = {}) =>
		call('POST', `${BASE}/orders`, {
			token: full,
			body: {
				clientId: cid('ord'),
				locationId: LOC,
				supplierId: supplier.id,
				...extra,
			},
		})

	it('creates a draft with a human number, snapshots the lines, defaults the date and replays a clientId', async () => {
		const body = {
			clientId: cid('ord'),
			locationId: LOC,
			supplierId: supplier.id,
			note: 'Early please',
			lines: [{ itemId: item.id, supplierProductId: product.id, packs: 3 }],
		}
		const first = await call('POST', `${BASE}/orders`, { token: full, body })
		expect(first.status, JSON.stringify(first.body)).toBe(200)
		const order = orderDetailSchema.parse(first.body)
		expect(order).toMatchObject({
			status: 'draft',
			note: 'Early please',
			version: 1,
			lineCount: 1,
			receivedLineCount: 0,
			currency: 'SAR',
			totalMinor: 13_500,
			createdBy: { kind: 'operator', id: 'user_owner' },
			sentAt: null,
			closedAt: null,
			supplierEmail: 'buy@ord.example',
			supplierPhone: '+966 55 000 1111',
		})
		expect(order.lines[0]).toMatchObject({
			itemName: 'Ord tomatoes',
			packName: 'Crate 6 kg',
			packBaseQuantity: 6_000_000,
			packs: 3,
			quantity: 18_000_000,
			receivedQuantity: 0,
			packPriceMinor: 4_500,
			lineTotalMinor: 13_500,
		})
		const next = nextOrderableDelivery(
			{ deliveryDays: [1, 4], cutoffTime: null, cutoffDaysBefore: 1 },
			{
				date: new Date().toISOString().slice(0, 10),
				time: new Date().toISOString().slice(11, 16),
			},
		)
		expect(order.expectedDate).toBe(next?.expectedDate)
		// No cut-off configured: none is shown.
		expect(order.cutoff).toBeNull()

		const replay = await call('POST', `${BASE}/orders`, { token: full, body })
		expect(replay.body.id).toBe(order.id)
		expect(replay.body.number).toBe(order.number)
		const changed = await call('POST', `${BASE}/orders`, {
			token: full,
			body: { ...body, note: 'Different' },
		})
		expect(changed.status).toBe(409)
		expect(changed.body.code).toBe('idempotency_conflict')

		const second = orderDetailSchema.parse((await create()).body)
		expect(second.number).toBe(order.number + 1)
		expect(second.lines).toEqual([])

		const list = listOrdersResultSchema.parse(
			(
				await call(
					'GET',
					`${BASE}/orders?locationId=${LOC}&supplierId=${supplier.id}&limit=1`,
					{ token: full },
				)
			).body,
		)
		// Newest first, with a cursor to the rest.
		expect(list.orders.map((entry) => entry.number)).toEqual([second.number])
		expect(list.nextCursor).not.toBeNull()
		const page2 = listOrdersResultSchema.parse(
			(
				await call(
					'GET',
					`${BASE}/orders?locationId=${LOC}&supplierId=${supplier.id}&limit=1&cursor=${list.nextCursor}`,
					{ token: full },
				)
			).body,
		)
		expect(page2.orders[0]!.id).toBe(order.id)
	})

	it('refuses lines it cannot honour: wrong supplier, pack steps, duplicates, unknown products', async () => {
		const mismatch = await create({
			lines: [
				{ itemId: item.id, supplierProductId: foreignProduct.id, packs: 1 },
			],
		})
		expect(mismatch.status).toBe(409)
		expect(mismatch.body.code).toBe('supplier_mismatch')
		const fraction = await create({
			lines: [{ itemId: item.id, supplierProductId: product.id, packs: 1.5 }],
		})
		expect(fraction.status).toBe(400)
		const half = await create({
			lines: [
				{
					itemId: weighed.id,
					supplierProductId: weighedProduct.id,
					packs: 1.5,
				},
			],
		})
		expect(half.status).toBe(200)
		const quarter = await create({
			lines: [
				{
					itemId: weighed.id,
					supplierProductId: weighedProduct.id,
					packs: 1.25,
				},
			],
		})
		expect(quarter.status).toBe(400)
		const dup = await create({
			lines: [
				{ itemId: item.id, supplierProductId: product.id, packs: 1 },
				{ itemId: item.id, supplierProductId: product.id, packs: 2 },
			],
		})
		expect(dup.status).toBe(400)
		const wrongItem = await create({
			lines: [{ itemId: weighed.id, supplierProductId: product.id, packs: 1 }],
		})
		expect(wrongItem.status).toBe(404)
		const unknown = await create({
			lines: [{ itemId: item.id, supplierProductId: 'nope', packs: 1 }],
		})
		expect(unknown.status).toBe(404)
		const both = await create({ fromSuggestion: true, lines: [] })
		expect(both.status).toBe(400)
	})

	it('edits a draft wholesale, keeps the suggested packs, and enforces expectedVersion', async () => {
		const order = (
			await create({
				lines: [{ itemId: item.id, supplierProductId: product.id, packs: 3 }],
			})
		).body
		const patched = await call('PATCH', `${BASE}/orders/${order.id}`, {
			token: full,
			body: {
				expectedVersion: 1,
				expectedDate: '2031-01-05',
				note: null,
				lines: [
					{ itemId: item.id, supplierProductId: product.id, packs: 4 },
					{
						itemId: weighed.id,
						supplierProductId: weighedProduct.id,
						packs: 0.5,
					},
				],
			},
		})
		expect(patched.status, JSON.stringify(patched.body)).toBe(200)
		const view = orderDetailSchema.parse(patched.body)
		expect(view).toMatchObject({
			version: 2,
			expectedDate: '2031-01-05',
			note: null,
			lineCount: 2,
			totalMinor: 4 * 4_500 + 10_000,
		})
		const stale = await call('PATCH', `${BASE}/orders/${order.id}`, {
			token: full,
			body: { expectedVersion: 1, note: 'x' },
		})
		expect(stale.status).toBe(409)
		expect(stale.body).toMatchObject({
			code: 'stale_version',
			currentVersion: 2,
		})
		const nothing = await call('PATCH', `${BASE}/orders/${order.id}`, {
			token: full,
			body: { expectedVersion: 2 },
		})
		expect(nothing.status).toBe(400)
		// Sending and cancelling check the version too, and change nothing when stale.
		for (const [path, body] of [
			['send', { expectedVersion: 1, channel: 'copy' }],
			['cancel', { expectedVersion: 1 }],
		] as const) {
			const res = await call('POST', `${BASE}/orders/${order.id}/${path}`, {
				token: full,
				body,
			})
			expect(res.status, path).toBe(409)
			expect(res.body).toMatchObject({
				code: 'stale_version',
				currentVersion: 2,
			})
		}
		const still = await call('GET', `${BASE}/orders/${order.id}`, {
			token: full,
		})
		expect(still.body).toMatchObject({ status: 'draft', version: 2 })
	})

	it('goes draft to sent, refuses to edit lines once sent, keeps date and note editable, and cancels', async () => {
		const empty = (await create()).body
		const noLines = await call('POST', `${BASE}/orders/${empty.id}/send`, {
			token: full,
			body: { expectedVersion: 1, channel: 'copy' },
		})
		expect(noLines.status).toBe(409)
		expect(noLines.body.code).toBe('order_empty')

		const order = (
			await create({
				lines: [{ itemId: item.id, supplierProductId: product.id, packs: 2 }],
			})
		).body
		const sent = sendOrderResultSchema.parse(
			(
				await call('POST', `${BASE}/orders/${order.id}/send`, {
					token: full,
					body: { expectedVersion: 1, channel: 'pdf' },
				})
			).body,
		)
		expect(sent.order).toMatchObject({
			status: 'sent',
			sentVia: 'pdf',
			version: 2,
		})
		expect(sent.order.sentAt).toEqual(expect.any(Number))
		expect(sent).toMatchObject({
			emailSent: false,
			emailSkipped: null,
			waLink: null,
			mailto: null,
		})
		expect(sent.text).toContain('2 × Crate 6 kg (12 kg)')

		const lines = await call('PATCH', `${BASE}/orders/${order.id}`, {
			token: full,
			body: {
				expectedVersion: 2,
				lines: [{ itemId: item.id, supplierProductId: product.id, packs: 9 }],
			},
		})
		expect(lines.status).toBe(409)
		expect(lines.body.code).toBe('order_not_editable')
		const date = await call('PATCH', `${BASE}/orders/${order.id}`, {
			token: full,
			body: {
				expectedVersion: 2,
				expectedDate: '2031-02-02',
				note: 'Call first',
			},
		})
		expect(date.status).toBe(200)
		expect(date.body).toMatchObject({
			status: 'sent',
			expectedDate: '2031-02-02',
			note: 'Call first',
			version: 3,
		})
		// Sending again changes nothing about when it was first sent.
		const again = sendOrderResultSchema.parse(
			(
				await call('POST', `${BASE}/orders/${order.id}/send`, {
					token: full,
					body: { expectedVersion: 3, channel: 'whatsapp' },
				})
			).body,
		)
		expect(again.order).toMatchObject({
			sentVia: 'pdf',
			sentAt: sent.order.sentAt,
			version: 3,
		})
		expect(again.waLink).toMatch(/^https:\/\/wa\.me\/966550001111\?text=/)

		const cancelled = await call('POST', `${BASE}/orders/${order.id}/cancel`, {
			token: full,
			body: { expectedVersion: 3, note: 'Wrong supplier' },
		})
		expect(cancelled.status).toBe(200)
		expect(cancelled.body).toMatchObject({
			status: 'cancelled',
			note: 'Wrong supplier',
			version: 4,
		})
		expect(cancelled.body.closedAt).toEqual(expect.any(Number))
		for (const [method, path, body] of [
			['PATCH', `/orders/${order.id}`, { expectedVersion: 4, note: 'x' }],
		] as const) {
			const res = await call(method, `${BASE}${path}`, { token: full, body })
			expect(res.status).toBe(409)
			expect(res.body.code).toBe('order_not_editable')
		}
		const sendClosed = await call('POST', `${BASE}/orders/${order.id}/send`, {
			token: full,
			body: { expectedVersion: 4, channel: 'copy' },
		})
		expect(sendClosed.body.code).toBe('order_closed')
		const cancelAgain = await call(
			'POST',
			`${BASE}/orders/${order.id}/cancel`,
			{
				token: full,
				body: { expectedVersion: 4 },
			},
		)
		expect(cancelAgain.body.code).toBe('order_closed')
		const prefill = await call(
			'GET',
			`${BASE}/orders/${order.id}/receive-prefill`,
			{ token: full },
		)
		expect(prefill.status).toBe(409)
		expect(prefill.body.code).toBe('order_closed')
		// Closed orders are in the closed list, not the open one.
		const closed = listOrdersResultSchema.parse(
			(
				await call(
					'GET',
					`${BASE}/orders?locationId=${LOC}&status=cancelled&supplierId=${supplier.id}`,
					{ token: full },
				)
			).body,
		)
		expect(closed.orders.map((entry) => entry.id)).toEqual([order.id])
	})

	it('writes the order text in English and Arabic without money, and builds the links', async () => {
		const order = (
			await create({
				expectedDate: '2031-03-06',
				note: 'Ring the bell',
				lines: [
					{ itemId: item.id, supplierProductId: product.id, packs: 2 },
					{
						itemId: weighed.id,
						supplierProductId: weighedProduct.id,
						packs: 1.5,
					},
				],
			})
		).body
		const en = orderTextSchema.parse(
			(await call('GET', `${BASE}/orders/${order.id}/text`, { token: full }))
				.body,
		)
		expect(en.locale).toBe('en')
		expect(en.subject).toBe(`Order ${order.number}`)
		expect(en.text).toContain('Hello Ord Supplier,')
		expect(en.text).toContain('- Ord tomatoes: 2 × Crate 6 kg (12 kg)')
		expect(en.text).toContain('- Ord beef: 1.5 × Side (15 kg)')
		expect(en.text).toContain('Delivery date: Thu, Mar 6')
		expect(en.text).toContain('Note: Ring the bell')
		expect(en.text).not.toMatch(/SAR|\d+\.\d\d|price|total/i)
		expect(en.mailto).toMatch(/^mailto:buy@ord\.example\?subject=Order/)
		expect(en.waLink).toMatch(/^https:\/\/wa\.me\/966550001111\?text=/)

		const ar = orderTextSchema.parse(
			(
				await call('GET', `${BASE}/orders/${order.id}/text?locale=ar`, {
					token: noCost,
				})
			).body,
		)
		expect(ar.locale).toBe('ar')
		expect(ar.subject).toBe(`طلب شراء رقم ${order.number}`)
		expect(ar.text).toContain('نرجو توريد الطلب التالي:')
		expect(ar.text).toContain('- Ord tomatoes: 2 × Crate 6 kg (12 كغ)')
		expect(ar.text).toContain('تاريخ التسليم المطلوب')
		expect(ar.text).not.toMatch(/SAR|ريال/)
		const bad = await call('GET', `${BASE}/orders/${order.id}/text?locale=fr`, {
			token: full,
		})
		expect(bad.status).toBe(400)
	})

	it('sends by email only when the node can, and says why when it did not', async () => {
		const order = (
			await create({
				lines: [{ itemId: item.id, supplierProductId: product.id, packs: 1 }],
			})
		).body
		// A node with no email configured: the order is marked sent and the App gets a mailto.
		const none = sendOrderResultSchema.parse(
			(
				await call('POST', `${BASE}/orders/${order.id}/send`, {
					token: full,
					body: { expectedVersion: 1, channel: 'email', locale: 'en' },
				})
			).body,
		)
		expect(none).toMatchObject({
			emailSent: false,
			emailSkipped: 'not_configured',
			waLink: null,
		})
		expect(none.mailto).toMatch(/^mailto:buy@ord\.example/)
		expect(none.order.status).toBe('sent')

		const captured: Array<Record<string, any>> = []
		setTenantEmailDevCapture(async (record) => {
			captured.push(record)
		})
		const second = (
			await create({
				lines: [{ itemId: item.id, supplierProductId: product.id, packs: 1 }],
			})
		).body
		const sent = sendOrderResultSchema.parse(
			(
				await call('POST', `${BASE}/orders/${second.id}/send`, {
					token: full,
					body: { expectedVersion: 1, channel: 'email', locale: 'ar' },
				})
			).body,
		)
		expect(sent).toMatchObject({
			emailSent: true,
			emailSkipped: null,
			mailto: null,
			channel: 'email',
		})
		expect(sent.order).toMatchObject({ status: 'sent', sentVia: 'email' })
		expect(captured).toHaveLength(1)
		expect(captured[0]).toMatchObject({
			to: 'buy@ord.example',
			subject: sent.subject,
			meta: {
				orgId: ORG,
				messageKind: 'inventory_order',
				messageId: second.id,
			},
		})
		expect(captured[0]!.html).toContain('dir="rtl"')
		expect(captured[0]!.text).not.toMatch(/SAR/)

		// A supplier with no address: nothing is sent, the person opens their mail app.
		const noEmail = await world.supplier('Ord No Email')
		const noEmailProduct = await world.product(noEmail.id, item.id)
		const third = (
			await call('POST', `${BASE}/orders`, {
				token: full,
				body: {
					clientId: cid('ord'),
					locationId: LOC,
					supplierId: noEmail.id,
					lines: [
						{ itemId: item.id, supplierProductId: noEmailProduct.id, packs: 1 },
					],
				},
			})
		).body
		const skipped = sendOrderResultSchema.parse(
			(
				await call('POST', `${BASE}/orders/${third.id}/send`, {
					token: full,
					body: { expectedVersion: 1, channel: 'email' },
				})
			).body,
		)
		expect(skipped).toMatchObject({
			emailSent: false,
			emailSkipped: 'no_supplier_email',
		})
		expect(skipped.mailto).toMatch(/^mailto:\?subject=/)
		expect(captured).toHaveLength(1)
	})

	it('a provider failure answers 502 email_failed and leaves the order as it was', async () => {
		setTenantEmailDevCapture(async () => {})
		const order = (
			await create({
				lines: [{ itemId: item.id, supplierProductId: product.id, packs: 1 }],
			})
		).body
		email.fail = true
		try {
			const res = await call('POST', `${BASE}/orders/${order.id}/send`, {
				token: full,
				body: { expectedVersion: 1, channel: 'email' },
			})
			expect(res.status).toBe(502)
			expect(res.body.code).toBe('email_failed')
		} finally {
			email.fail = false
		}
		const after = await call('GET', `${BASE}/orders/${order.id}`, {
			token: full,
		})
		expect(after.body).toMatchObject({
			status: 'draft',
			version: 1,
			sentAt: null,
		})
	})

	it('leaves money out of orders for a token without the cost grant', async () => {
		const order = (
			await create({
				lines: [{ itemId: item.id, supplierProductId: product.id, packs: 2 }],
			})
		).body
		for (const path of [
			`/orders/${order.id}`,
			`/orders?locationId=${LOC}`,
			`/orders/${order.id}/receive-prefill`,
		]) {
			const res = await call('GET', `${BASE}${path}`, { token: noCost })
			expect(res.status, path).toBe(200)
			expect(JSON.stringify(res.body), path).not.toMatch(
				/Minor|currency|unpricedLines|shortOfMinimum/,
			)
		}
		const withCost = await call('GET', `${BASE}/orders/${order.id}`, {
			token: full,
		})
		expect(JSON.stringify(withCost.body)).toContain('lineTotalMinor')
	})

	it('keeps organizations, locations, flags and grants apart', async () => {
		const order = (
			await create({
				lines: [{ itemId: item.id, supplierProductId: product.id, packs: 1 }],
			})
		).body
		const foreign = await call('GET', `${BASE}/orders/${order.id}`, {
			token: tokenB,
		})
		expect(foreign.status).toBe(404)
		const elsewhere = await call('GET', `${BASE}/orders/${order.id}`, {
			token: scoped,
		})
		expect(elsewhere.status).toBe(403)
		expect(elsewhere.body.code).toBe('location_forbidden')
		for (const [method, path, body] of [
			['PATCH', `/orders/${order.id}`, { expectedVersion: 1, note: 'x' }],
			['POST', `/orders/${order.id}/cancel`, { expectedVersion: 1 }],
		] as const) {
			const res = await call(method, `${BASE}${path}`, { token: scoped, body })
			expect(res.status, path).toBe(403)
			const noGrant = await call(method, `${BASE}${path}`, {
				token: noPurchasing,
				body,
			})
			expect(noGrant.body).toMatchObject({ code: 'forbidden', reason: 'grant' })
			const off = await call(method, `${BASE}${path}`, { token: flagOff, body })
			expect(off.body.code).toBe('feature_disabled')
		}
		const after = await call('GET', `${BASE}/orders/${order.id}`, {
			token: full,
		})
		expect(after.body).toMatchObject({ status: 'draft', version: 1 })
	})
})

describe('receiving against an order', () => {
	let supplier: { id: string }
	let other: { id: string }
	let chicken: { id: string }
	let beef: { id: string }
	let chickenProduct: { id: string }
	let beefProduct: { id: string }

	beforeAll(async () => {
		supplier = await world.supplier('Rcv Supplier', { deliveryDays: [2] })
		other = await world.supplier('Rcv Other')
		chicken = await world.item('Rcv chicken')
		beef = await world.item('Rcv beef')
		chickenProduct = await world.product(supplier.id, chicken.id, {
			packName: 'Box 10 kg',
			packBaseQuantity: 10_000_000,
			priceMinor: 28_000,
		})
		beefProduct = await world.product(supplier.id, beef.id, {
			packName: 'Side',
			packBaseQuantity: 10_000_000,
			priceMinor: 20_000,
			pricedByWeight: true,
		})
	})

	const makeOrder = async () =>
		(await world.ok('POST', '/orders', {
			clientId: cid('ord'),
			locationId: LOC,
			supplierId: supplier.id,
			lines: [
				{ itemId: chicken.id, supplierProductId: chickenProduct.id, packs: 4 },
				{ itemId: beef.id, supplierProductId: beefProduct.id, packs: 2 },
			],
		})) as Record<string, any>

	const receive = (
		order: Record<string, any>,
		lines: Array<Record<string, unknown>>,
		extra: Record<string, unknown> = {},
	) =>
		call('POST', `${BASE}/deliveries`, {
			token: full,
			body: {
				clientId: cid('del'),
				locationId: LOC,
				supplierId: supplier.id,
				currency: 'SAR',
				orderId: order.id,
				lines,
				...extra,
			},
		})

	it('prefills what is outstanding, moves the order to partly received and then received, and counts a weight line complete at 95%', async () => {
		const order = await makeOrder()
		const [chickenLine, beefLine] = order.lines
		const prefill = receivePrefillSchema.parse(
			(
				await call('GET', `${BASE}/orders/${order.id}/receive-prefill`, {
					token: full,
				})
			).body,
		)
		expect(prefill).toMatchObject({
			orderId: order.id,
			number: order.number,
			supplierName: 'Rcv Supplier',
			status: 'draft',
		})
		expect(prefill.lines[0]).toMatchObject({
			orderLineId: chickenLine.id,
			orderedPacks: 4,
			orderedQuantity: 40_000_000,
			receivedQuantity: 0,
			outstandingQuantity: 40_000_000,
			outstandingPacks: 4,
			packPriceMinor: 28_000,
			lineTotalMinor: 112_000,
		})

		// 25 kg of the chicken arrives: the order is partly received.
		const first = await receive(order, [
			{
				itemId: chicken.id,
				supplierProductId: chickenProduct.id,
				orderLineId: chickenLine.id,
				orderedQuantity: 40_000_000,
				quantity: 25_000_000,
				packs: 2.5,
				packPriceMinor: 28_000,
				lineTotalMinor: 70_000,
			},
		])
		expect(first.status, JSON.stringify(first.body)).toBe(200)
		expect(first.body.order).toMatchObject({
			id: order.id,
			status: 'partly_received',
			receivedLineCount: 0,
			version: order.version + 1,
		})
		expect(first.body.delivery).toMatchObject({
			orderId: order.id,
			orderNumber: order.number,
			pricesPending: false,
		})
		expect(first.body.delivery.lines[0]).toMatchObject({
			orderLineId: chickenLine.id,
			orderedQuantity: 40_000_000,
			priced: true,
		})
		expect(first.body.orderLinkIgnored).toBeNull()

		const mid = receivePrefillSchema.parse(
			(
				await call('GET', `${BASE}/orders/${order.id}/receive-prefill`, {
					token: full,
				})
			).body,
		)
		expect(mid.status).toBe('partly_received')
		expect(mid.lines[0]).toMatchObject({
			receivedQuantity: 25_000_000,
			outstandingQuantity: 15_000_000,
			outstandingPacks: 1.5,
		})
		expect(mid.lines[1]).toMatchObject({ outstandingQuantity: 20_000_000 })

		// The rest of the chicken and 96% of the weighed beef: both lines are complete.
		const second = await receive(order, [
			{
				itemId: chicken.id,
				supplierProductId: chickenProduct.id,
				orderLineId: chickenLine.id,
				quantity: 15_000_000,
				lineTotalMinor: 42_000,
			},
			{
				itemId: beef.id,
				supplierProductId: beefProduct.id,
				orderLineId: beefLine.id,
				quantity: 19_200_000,
				realWeightQuantity: 19_200_000,
				lineTotalMinor: 38_400,
			},
		])
		expect(second.body.order).toMatchObject({
			status: 'received',
			receivedLineCount: 2,
		})
		expect(second.body.order.closedAt).toEqual(expect.any(Number))
		const detail = orderDetailSchema.parse(
			(await call('GET', `${BASE}/orders/${order.id}`, { token: full })).body,
		)
		expect(detail.status).toBe('received')
		expect(detail.deliveries).toHaveLength(2)
		expect(detail.lines.map((line) => line.receivedQuantity)).toEqual([
			40_000_000, 19_200_000,
		])
		// Received is final.
		const late = await receive(order, [
			{ itemId: chicken.id, quantity: 1000, lineTotalMinor: 10 },
		])
		expect(late.status).toBe(409)
		expect(late.body.code).toBe('order_closed')
	})

	it('closeOrder ends an order short, and the shortfall stays readable for credit', async () => {
		const order = await makeOrder()
		const [chickenLine] = order.lines
		const res = await receive(
			order,
			[
				{
					itemId: chicken.id,
					supplierProductId: chickenProduct.id,
					orderLineId: chickenLine.id,
					quantity: 10_000_000,
					lineTotalMinor: 28_000,
				},
			],
			{ closeOrder: true },
		)
		expect(res.body.order).toMatchObject({
			status: 'received',
			receivedLineCount: 0,
		})
		const credit = await call(
			'POST',
			`${BASE}/deliveries/${res.body.delivery.id}/credit-message`,
			{ token: full, body: { locale: 'en' } },
		)
		expect(credit.status).toBe(200)
		expect(credit.body.lines).toHaveLength(2)
		expect(credit.body.lines[0]).toMatchObject({
			itemName: 'Rcv chicken',
			kind: 'short',
			orderedQuantity: 40_000_000,
			receivedQuantity: 10_000_000,
			shortQuantity: 30_000_000,
			valueMinor: 84_000,
		})
		expect(credit.body.lines[1]).toMatchObject({
			itemName: 'Rcv beef',
			kind: 'missing',
			receivedQuantity: 0,
		})
		expect(credit.body.totalMinor).toBe(84_000 + 40_000)
		expect(credit.body.text).toContain(
			'Rcv chicken (Box 10 kg): ordered 40 kg, received 10 kg (short 30 kg)',
		)
		expect(credit.body.text).toContain(
			'Rcv beef (Side): ordered 20 kg, not delivered',
		)
		expect(credit.body.text).not.toMatch(/SAR|84/)
	})

	it('refuses a closed order, another supplier and an unknown order on the operator route', async () => {
		const order = await makeOrder()
		const line = {
			itemId: chicken.id,
			quantity: 1_000_000,
			lineTotalMinor: 2_800,
		}
		const wrongSupplier = await receive(order, [line], { supplierId: other.id })
		expect(wrongSupplier.status).toBe(409)
		expect(wrongSupplier.body.code).toBe('supplier_mismatch')
		const unknown = await receive({ id: 'no-such-order' }, [line])
		expect(unknown.status).toBe(404)
		const badLine = await receive(order, [
			{ ...line, orderLineId: 'not-a-line-of-this-order' },
		])
		expect(badLine.status).toBe(400)
		const lineOfAnotherItem = await receive(order, [
			{ ...line, itemId: beef.id, orderLineId: order.lines[0].id },
		])
		expect(lineOfAnotherItem.status).toBe(400)
		// A supplier left out is taken from the order.
		const adopted = await receive(order, [line], { supplierId: null })
		expect(adopted.status).toBe(200)
		expect(adopted.body.delivery.supplierId).toBe(supplier.id)
		// Nothing was written for the refusals: still draft-turned-partly with one delivery.
		const detail = await call('GET', `${BASE}/orders/${order.id}`, {
			token: full,
		})
		expect(detail.body.deliveries).toHaveLength(1)

		await world.ok('POST', `/orders/${order.id}/cancel`, { expectedVersion: 1 })
		const cancelled = await receive(order, [line])
		expect(cancelled.body.code).toBe('order_closed')
	})

	it('a cancelled delivery no longer counts as received against its order', async () => {
		const order = await makeOrder()
		const res = await receive(order, [
			{
				itemId: chicken.id,
				supplierProductId: chickenProduct.id,
				orderLineId: order.lines[0].id,
				quantity: 10_000_000,
				lineTotalMinor: 28_000,
			},
		])
		await world.ok('POST', `/deliveries/${res.body.delivery.id}/cancel`, {
			expectedVersion: res.body.delivery.version,
		})
		const prefill = await call(
			'GET',
			`${BASE}/orders/${order.id}/receive-prefill`,
			{
				token: full,
			},
		)
		expect(prefill.body.lines[0]).toMatchObject({
			receivedQuantity: 0,
			outstandingQuantity: 40_000_000,
		})
	})
})

describe('Today with purchasing', () => {
	const TODAY_LOC = 'loc_ord_today'
	let todayWorld: ReturnType<typeof makeWorld>
	let supplier: { id: string }
	let item: { id: string }
	let product: { id: string }

	beforeAll(async () => {
		todayWorld = makeWorld(call, full, TODAY_LOC)
		// A delivery every day and a cut-off at 23:59 the day before: the first
		// delivery it can still make is tomorrow, and its cut-off is today.
		supplier = await todayWorld.supplier('Today Supplier', {
			deliveryDays: [0, 1, 2, 3, 4, 5, 6],
			cutoffTime: '23:59',
			cutoffDaysBefore: 1,
		})
		item = await todayWorld.item('Today onions')
		product = await todayWorld.product(supplier.id, item.id, {
			packName: 'Sack 10 kg',
			packBaseQuantity: 10_000_000,
			priceMinor: 3_000,
		})
		await todayWorld.levels([
			{
				itemId: item.id,
				orderBelowQuantity: 5_000_000,
				fillUpToQuantity: 20_000_000,
			},
		])
		await todayWorld.stock(item.id, 1_000_000)
	})

	const view = async (token = full) => {
		const res = await call('GET', `${BASE}/today?locationId=${TODAY_LOC}`, {
			token,
		})
		expect(res.status, JSON.stringify(res.body)).toBe(200)
		return todaySchema.parse(res.body)
	}

	it('counts what to order, and asks for an order whose cut-off is today', async () => {
		const today = await view()
		expect(today.metrics).toMatchObject({
			toOrderItems: 1,
			toOrderSuppliers: 1,
		})
		const cutoff = today.attention.find(
			(entry) => entry.kind === 'order_cutoff',
		)
		const tomorrow = addDaysIso(new Date().toISOString().slice(0, 10), 1)
		expect(cutoff).toEqual({
			kind: 'order_cutoff',
			supplierId: supplier.id,
			supplierName: 'Today Supplier',
			cutoffDate: new Date().toISOString().slice(0, 10),
			cutoffTime: '23:59',
			expectedDate: tomorrow,
			itemCount: 1,
			draftOrderId: null,
		})
		// The same cards are not a surprise to a token without the cost grant.
		expect((await view(noCost)).metrics).toMatchObject({ toOrderItems: 1 })
	})

	it('shows nothing about orders while the purchasing flag is off', async () => {
		const today = await view(flagOff)
		expect(today.metrics.toOrderItems).toBeUndefined()
		expect(today.metrics.toOrderSuppliers).toBeUndefined()
		expect(
			today.attention.some(
				(entry) =>
					entry.kind === 'order_cutoff' || entry.kind === 'delivery_expected',
			),
		).toBe(false)
		expect(today.week.every((entry) => entry.orderId === undefined)).toBe(true)
	})

	it('lists an open order that is due or overdue, and the order behind a delivery day', async () => {
		const date = new Date().toISOString().slice(0, 10)
		const overdue = await todayWorld.ok('POST', '/orders', {
			clientId: cid('ord'),
			locationId: TODAY_LOC,
			supplierId: supplier.id,
			expectedDate: addDaysIso(date, -2),
			lines: [{ itemId: item.id, supplierProductId: product.id, packs: 1 }],
		})
		await todayWorld.ok('POST', `/orders/${overdue.id}/send`, {
			expectedVersion: 1,
			channel: 'copy',
		})
		const coming = await todayWorld.ok('POST', '/orders', {
			clientId: cid('ord'),
			locationId: TODAY_LOC,
			supplierId: supplier.id,
			expectedDate: addDaysIso(date, 2),
			lines: [{ itemId: item.id, supplierProductId: product.id, packs: 1 }],
		})
		await todayWorld.ok('POST', `/orders/${coming.id}/send`, {
			expectedVersion: 1,
			channel: 'copy',
		})
		const today = await view()
		const expected = today.attention.filter(
			(entry) => entry.kind === 'delivery_expected',
		)
		expect(expected).toEqual([
			{
				kind: 'delivery_expected',
				orderId: overdue.id,
				supplierName: 'Today Supplier',
				expectedDate: addDaysIso(date, -2),
				overdue: true,
			},
		])
		const dayAfterTomorrow = today.week.find(
			(entry) =>
				entry.kind === 'delivery' &&
				entry.supplierId === supplier.id &&
				entry.date === addDaysIso(today.date, 2),
		)
		expect(dayAfterTomorrow?.orderId).toBe(coming.id)
		const tomorrow = today.week.find(
			(entry) =>
				entry.kind === 'delivery' &&
				entry.supplierId === supplier.id &&
				entry.date === addDaysIso(today.date, 1),
		)
		expect(tomorrow?.orderId).toBeNull()
		// What is on its way is no longer suggested; the sent orders cover the item.
		expect((await view()).metrics.toOrderItems).toBe(0)
	})
})
