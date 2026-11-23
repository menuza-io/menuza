import {
	deliveryDetailSchema,
	invoicePhotoUploadSchema,
	priceAlertsSchema,
	recordDeliveryResultSchema,
	todaySchema,
} from '@repo/inventory'
import {
	destroyTenantDb,
	getTenantDb,
	invDeliveries,
	invItemCosts,
	invItemGroupMembers,
	invItemGroups,
	invItems,
	invLocationSettings,
	invMovements,
	invRecipeLines,
	invRecipes,
	invSettings,
	invWaste,
	provisionTenantDb,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
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
import { type InventoryCaller } from '../services/inventory-items-service.ts'
import { recordDelivery } from '../services/inventory-purchasing-service.ts'
import { getPriceAlerts } from '../services/inventory-receiving-service.ts'
import { logWaste } from '../services/inventory-waste-service.ts'
import { makeWorld } from './inventory-orders-fixture.ts'
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

/**
 * Receiving without prices (quantity only) and pricing it later, the invoice
 * photo, price alerts, and what a Station tablet's delivery may do that the
 * operator route may not.
 */

const ORG = 'org_inv_rcv_a'
const ORG_B = 'org_inv_rcv_b'
const LOC = 'loc_rcv'

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
let staff: string
let noPurchasing: string
let costOnly: string
let world: ReturnType<typeof makeWorld>

beforeAll(async () => {
	env = setupTenantEnv('inv-rcv')
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
	// A person who may receive goods but sees no money and cannot price them.
	staff = await mintToken(ORG, { grants: [READ, UPDATE] })
	noPurchasing = await mintToken(ORG, { grants: [READ, UPDATE, COST] })
	costOnly = await mintToken(ORG, { scope: 'read', grants: [READ, COST] })
	world = makeWorld(call, full, LOC)
})

afterAll(async () => {
	await destroyTenantDb(ORG)
	await destroyTenantDb(ORG_B)
	env.cleanup()
})

async function costOf(itemId: string) {
	const db = await getTenantDb(ORG)
	return db
		.select()
		.from(invItemCosts)
		.where(eq(invItemCosts.itemId, itemId))
		.get()
}

async function onHand(itemId: string): Promise<number> {
	const res = await call('GET', `${BASE}/items/${itemId}?locationId=${LOC}`, {
		token: full,
	})
	return res.body.onHand
}

describe('a quantity-only delivery and confirming its prices', () => {
	let supplier: { id: string }
	let chicken: { id: string }
	let product: { id: string }

	beforeAll(async () => {
		supplier = await world.supplier('Qty Supplier')
		chicken = await world.item('Qty chicken')
		product = await world.product(supplier.id, chicken.id, {
			packName: 'Box 10 kg',
			packBaseQuantity: 10_000_000,
			priceMinor: 28_000,
		})
		// A priced delivery first, so there is a cost and a stock to weigh against.
		await world.ok('POST', '/deliveries', {
			clientId: cid('del'),
			locationId: LOC,
			supplierId: supplier.id,
			currency: 'SAR',
			lines: [
				{
					itemId: chicken.id,
					supplierProductId: product.id,
					quantity: 10_000_000,
					lineTotalMinor: 28_000,
				},
			],
		})
	})

	const quantityOnly = (token: string, extra: Record<string, unknown> = {}) =>
		call('POST', `${BASE}/deliveries`, {
			token,
			body: {
				clientId: cid('del'),
				locationId: LOC,
				supplierId: supplier.id,
				quantityOnly: true,
				lines: [
					{
						itemId: chicken.id,
						supplierProductId: product.id,
						quantity: 10_000_000,
						packs: 1,
					},
				],
				...extra,
			},
		})

	it('stocks the goods in with no money, never touches costs, and waits for prices', async () => {
		const before = await costOf(chicken.id)
		expect(before).toMatchObject({
			lastCostMicro: 2_800_000,
			avgCostMicro: 2_800_000,
		})
		const stockBefore = await onHand(chicken.id)

		const body = {
			clientId: cid('del'),
			locationId: LOC,
			supplierId: supplier.id,
			quantityOnly: true,
			invoiceNumber: 'INV-1',
			lines: [
				{
					itemId: chicken.id,
					supplierProductId: product.id,
					quantity: 10_000_000,
					packs: 1,
				},
			],
		}
		const res = await call('POST', `${BASE}/deliveries`, { token: staff, body })
		expect(res.status, JSON.stringify(res.body)).toBe(200)
		// A token without the cost grant is told nothing about money.
		expect(JSON.stringify(res.body)).not.toMatch(
			/Minor|currency|priceChange|"cost/,
		)
		const result = recordDeliveryResultSchema.parse(res.body)
		expect(result.delivery).toMatchObject({
			pricesPending: true,
			source: 'operator',
			lateSync: false,
			orderId: null,
			invoiceNumber: 'INV-1',
			paid: false,
		})
		expect(result.delivery.lines[0]).toMatchObject({
			priced: false,
			quantity: 10_000_000,
		})
		expect(result.priceChanges).toBeUndefined()

		expect(await onHand(chicken.id)).toBe(stockBefore + 10_000_000)
		// Costs and the supplier's price are exactly as they were.
		expect(await costOf(chicken.id)).toEqual(before)
		const supplierView = await call('GET', `${BASE}/suppliers/${supplier.id}`, {
			token: full,
		})
		expect(supplierView.body.products[0].priceMinor).toBe(28_000)

		// The delivery stores the organization's currency (its items already cost in it) and no value.
		const db = await getTenantDb(ORG)
		const row = await db
			.select()
			.from(invDeliveries)
			.where(eq(invDeliveries.id, result.delivery.id))
			.get()
		expect(row).toMatchObject({
			currency: 'SAR',
			quantityOnly: true,
			pricesConfirmedAt: null,
		})
		const movements = await db
			.select()
			.from(invMovements)
			.where(eq(invMovements.sourceId, result.delivery.id))
		expect(movements).toHaveLength(1)
		expect(movements[0]).toMatchObject({ valueMinor: null, currency: null })

		// A replay answers the first result and does not stock twice.
		const replay = await call('POST', `${BASE}/deliveries`, {
			token: staff,
			body,
		})
		expect(replay.body.delivery.id).toBe(result.delivery.id)
		expect(await onHand(chicken.id)).toBe(stockBefore + 10_000_000)

		// With the cost grant the pending line shows no money (not a zero).
		const detail = deliveryDetailSchema.parse(
			(
				await call('GET', `${BASE}/deliveries/${result.delivery.id}`, {
					token: full,
				})
			).body,
		)
		expect(detail.pricesPending).toBe(true)
		expect(detail.lines[0]).not.toHaveProperty('lineTotalMinor')
		expect(detail.lines[0]).not.toHaveProperty('packPriceMinor')
	})

	it('refuses money, paid and a mix that the wire contract forbids, and a paid mark without the purchasing grant', async () => {
		const withMoney = await quantityOnly(staff, {
			lines: [{ itemId: chicken.id, quantity: 1000, lineTotalMinor: 5 }],
		})
		expect(withMoney.status).toBe(400)
		const paid = await quantityOnly(full, { paid: true })
		expect(paid.status).toBe(400)
		const vat = await quantityOnly(full, { vatMinor: 10 })
		expect(vat.status).toBe(400)
		const priced = await call('POST', `${BASE}/deliveries`, {
			token: staff,
			body: {
				clientId: cid('del'),
				locationId: LOC,
				supplierId: supplier.id,
				currency: 'SAR',
				paid: true,
				lines: [{ itemId: chicken.id, quantity: 1000, lineTotalMinor: 5 }],
			},
		})
		expect(priced.status).toBe(403)
		expect(priced.body.code).toBe('purchasing_required')
		// A priced delivery without a currency is not a quantity-only one.
		const noCurrency = await call('POST', `${BASE}/deliveries`, {
			token: full,
			body: {
				clientId: cid('del'),
				locationId: LOC,
				supplierId: supplier.id,
				lines: [{ itemId: chicken.id, quantity: 1000, lineTotalMinor: 5 }],
			},
		})
		expect(noCurrency.status).toBe(400)
	})

	it('prices it once: weighted average over the stock before it, last cost, supplier price and price changes', async () => {
		const received = (await quantityOnly(staff)).body
		const lineId = received.delivery.lines[0].id
		const confirm = (token: string, body: Record<string, unknown>) =>
			call(
				'POST',
				`${BASE}/deliveries/${received.delivery.id}/confirm-prices`,
				{
					token,
					body,
				},
			)
		const valid = {
			expectedVersion: received.delivery.version,
			currency: 'SAR',
			invoiceNumber: 'INV-2',
			invoiceDate: '2031-04-01',
			vatMinor: 4_500,
			totalMinor: 34_500,
			paid: true,
			lines: [{ lineId, lineTotalMinor: 30_000, packPriceMinor: 30_000 }],
		}
		// Only a person with the purchasing grant prices goods.
		const denied = await confirm(noPurchasing, valid)
		expect(denied.status).toBe(403)
		expect(denied.body).toMatchObject({
			code: 'forbidden',
			required: PURCHASING,
		})
		// Every unpriced line exactly once.
		for (const lines of [
			[],
			[{ lineId: 'not-a-line', lineTotalMinor: 1 }],
			[
				{ lineId, lineTotalMinor: 1 },
				{ lineId, lineTotalMinor: 2 },
			],
		]) {
			const bad = await confirm(full, { ...valid, lines })
			expect(bad.status, JSON.stringify(lines)).toBe(400)
		}
		const stale = await confirm(full, { ...valid, expectedVersion: 99 })
		expect(stale.status).toBe(409)
		expect(stale.body.code).toBe('stale_version')
		const wrongCurrency = await confirm(full, { ...valid, currency: 'USD' })
		expect(wrongCurrency.status).toBe(400)

		const stockNow = await onHand(chicken.id)
		const before = await costOf(chicken.id)
		const res = await confirm(full, valid)
		expect(res.status, JSON.stringify(res.body)).toBe(200)
		const result = recordDeliveryResultSchema.parse(res.body)
		expect(result.delivery).toMatchObject({
			pricesPending: false,
			invoiceNumber: 'INV-2',
			invoiceDate: '2031-04-01',
			vatMinor: 4_500,
			totalMinor: 34_500,
			paid: true,
			linesTotalMinor: 30_000,
			version: received.delivery.version + 1,
		})
		expect(result.delivery.lines[0]).toMatchObject({
			priced: true,
			lineTotalMinor: 30_000,
			packPriceMinor: 30_000,
		})
		// 3.0 per gram against a last cost of 2.8: a rise of 714 basis points.
		expect(result.priceChanges).toEqual([
			{
				itemId: chicken.id,
				itemName: 'Qty chicken',
				previousCostMicro: before!.lastCostMicro,
				costMicro: 3_000_000,
				changeBp: Math.round(
					((3_000_000 - before!.lastCostMicro!) * 10_000) /
						before!.lastCostMicro!,
				),
			},
		])
		const after = await costOf(chicken.id)
		expect(after!.lastCostMicro).toBe(3_000_000)
		// The average weighs the stock that was there BEFORE this delivery at the old average.
		const earlier = stockNow - 10_000_000
		const expected = Math.round(
			(earlier * before!.avgCostMicro! + 10_000_000 * 3_000_000) / stockNow,
		)
		expect(after!.avgCostMicro).toBe(expected)
		// The pack price became the supplier's price.
		const supplierView = await call('GET', `${BASE}/suppliers/${supplier.id}`, {
			token: full,
		})
		expect(supplierView.body.products[0].priceMinor).toBe(30_000)
		// The value of the purchase is in the ledger now, with no extra stock.
		const db = await getTenantDb(ORG)
		const movements = await db
			.select()
			.from(invMovements)
			.where(eq(invMovements.sourceId, received.delivery.id))
		expect(
			movements.map((entry) => [entry.quantity, entry.valueMinor]),
		).toEqual(
			expect.arrayContaining([
				[10_000_000, null],
				[0, 30_000],
			]),
		)
		expect(await onHand(chicken.id)).toBe(stockNow)

		// Once only.
		const again = await confirm(full, {
			...valid,
			expectedVersion: result.delivery.version,
		})
		expect(again.status).toBe(409)
		expect(again.body.code).toBe('prices_confirmed')
		// A priced delivery has nothing to confirm.
		const priced = (
			await world.ok('POST', '/deliveries', {
				clientId: cid('del'),
				locationId: LOC,
				supplierId: supplier.id,
				currency: 'SAR',
				lines: [{ itemId: chicken.id, quantity: 1000, lineTotalMinor: 3 }],
			})
		).delivery
		const nothing = await confirm(full, valid).then(() =>
			call('POST', `${BASE}/deliveries/${priced.id}/confirm-prices`, {
				token: full,
				body: { ...valid, expectedVersion: priced.version },
			}),
		)
		expect(nothing.status).toBe(409)
		expect(nothing.body.code).toBe('prices_confirmed')
	})

	it('shows a delivery waiting for prices on Today until it is confirmed', async () => {
		const received = (await quantityOnly(staff)).body
		const today = async () =>
			todaySchema.parse(
				(await call('GET', `${BASE}/today?locationId=${LOC}`, { token: full }))
					.body,
			)
		const waiting = (await today()).attention.find(
			(item) => item.kind === 'prices_pending',
		)
		expect(waiting).toMatchObject({
			kind: 'prices_pending',
			supplierName: 'Qty Supplier',
			lineCount: 1,
		})
		await world.ok(
			'POST',
			`/deliveries/${received.delivery.id}/confirm-prices`,
			{
				expectedVersion: received.delivery.version,
				currency: 'SAR',
				lines: [
					{ lineId: received.delivery.lines[0].id, lineTotalMinor: 30_000 },
				],
			},
		)
		const rest = (await today()).attention.filter(
			(item) => item.kind === 'prices_pending',
		)
		// The oldest waiting delivery comes first: the one confirmed above was the newest.
		expect(rest.every((item) => item.kind === 'prices_pending')).toBe(true)
	})

	it('cancels an unpriced delivery by reversing its stock, with no value and no cost change', async () => {
		const before = await costOf(chicken.id)
		const stock = await onHand(chicken.id)
		const received = (await quantityOnly(staff)).body
		expect(await onHand(chicken.id)).toBe(stock + 10_000_000)
		const cancelled = await call(
			'POST',
			`${BASE}/deliveries/${received.delivery.id}/cancel`,
			{ token: full, body: { expectedVersion: received.delivery.version } },
		)
		expect(cancelled.status).toBe(200)
		expect(cancelled.body.status).toBe('cancelled')
		expect(await onHand(chicken.id)).toBe(stock)
		expect(await costOf(chicken.id)).toEqual(before)
		const db = await getTenantDb(ORG)
		const movements = await db
			.select()
			.from(invMovements)
			.where(eq(invMovements.sourceId, received.delivery.id))
		expect(movements.map((entry) => entry.valueMinor)).toEqual([null, null])
		// A cancelled delivery has no prices to confirm.
		const confirm = await call(
			'POST',
			`${BASE}/deliveries/${received.delivery.id}/confirm-prices`,
			{
				token: full,
				body: {
					expectedVersion: cancelled.body.version,
					currency: 'SAR',
					lines: [{ lineId: received.delivery.lines[0].id, lineTotalMinor: 1 }],
				},
			},
		)
		expect(confirm.status).toBe(409)
	})
})

describe('price alerts', () => {
	let supplier: { id: string }
	let rising: { id: string }
	let steady: { id: string }
	let falling: { id: string }
	let LOC_ALERT = 'loc_rcv_alerts'
	let alertWorld: ReturnType<typeof makeWorld>

	beforeAll(async () => {
		alertWorld = makeWorld(call, full, LOC_ALERT)
		supplier = await alertWorld.supplier('Alert Supplier')
		rising = await alertWorld.item('Alert rising')
		steady = await alertWorld.item('Alert steady')
		falling = await alertWorld.item('Alert falling')
		const receive = (lines: Array<[string, number]>) =>
			alertWorld.ok('POST', '/deliveries', {
				clientId: cid('del'),
				locationId: LOC_ALERT,
				supplierId: supplier.id,
				currency: 'SAR',
				lines: lines.map(([itemId, total]) => ({
					itemId,
					quantity: 10_000_000,
					lineTotalMinor: total,
					packName: 'Box',
					packPriceMinor: total,
				})),
			})
		await receive([
			[rising.id, 10_000],
			[steady.id, 10_000],
			[falling.id, 10_000],
		])
		await receive([
			// +30%: a big rise. +5%: not an alert (it must be MORE than 5%). -10%: a fall.
			[rising.id, 13_000],
			[steady.id, 10_500],
			[falling.id, 9_000],
		])
	})

	it('lists items whose latest price rose by more than 5%, largest first, with the severity', async () => {
		const res = await call(
			'GET',
			`${BASE}/price-alerts?locationId=${LOC_ALERT}&days=30`,
			{ token: costOnly },
		)
		expect(res.status).toBe(200)
		const view = priceAlertsSchema.parse(res.body)
		expect(view).toMatchObject({
			locationId: LOC_ALERT,
			days: 30,
			thresholdBp: 500,
			currency: 'SAR',
		})
		expect(view.alerts).toHaveLength(1)
		expect(view.alerts[0]).toMatchObject({
			itemId: rising.id,
			itemName: 'Alert rising',
			supplierName: 'Alert Supplier',
			changeBp: 3000,
			severity: 'big',
			packName: 'Box',
			previousPackPriceMinor: 10_000,
			packPriceMinor: 13_000,
			affectedDishes: 0,
			dishes: [],
		})
		// Another location has none.
		const other = await call('GET', `${BASE}/price-alerts?locationId=${LOC}`, {
			token: full,
		})
		expect(other.body.alerts).toEqual([])
	})

	it('needs the cost grant (403, not an empty list) and a valid window', async () => {
		const denied = await call(
			'GET',
			`${BASE}/price-alerts?locationId=${LOC_ALERT}`,
			{ token: staff },
		)
		expect(denied.status).toBe(403)
		await expect(
			getPriceAlerts(await getTenantDb(ORG), {
				query: { locationId: LOC_ALERT, days: 30 },
				now: Date.now(),
				caller: { cost: false, region: 'us' },
			}),
		).rejects.toMatchObject({ status: 403, code: 'forbidden' })
		for (const days of ['0', '181', 'x']) {
			const bad = await call(
				'GET',
				`${BASE}/price-alerts?locationId=${LOC_ALERT}&days=${days}`,
				{ token: full },
			)
			expect(bad.status, days).toBe(400)
		}
	})

	it('computes affected dishes directly, through groups, and through both standard and batch-counted made items (#520)', async () => {
		const db = await getTenantDb(ORG)
		const locImpact = 'loc_rcv_dish_impact'
		const impactWorld = makeWorld(call, full, locImpact)
		const impactSup = await impactWorld.supplier('Impact Supplier')
		const flour = await impactWorld.item('Impact flour')
		// 10 kg box: 10_000 minor (1.00/kg = 1_000_000 micro/g) -> 13_000 minor (1.30/kg = 1_300_000 micro/g)
		const deliverFlour = (totalMinor: number) =>
			impactWorld.ok('POST', '/deliveries', {
				clientId: cid('del'),
				locationId: locImpact,
				supplierId: impactSup.id,
				currency: 'SAR',
				lines: [
					{
						itemId: flour.id,
						quantity: 10_000_000,
						lineTotalMinor: totalMinor,
						packName: 'Bag 10 kg',
						packPriceMinor: totalMinor,
					},
				],
			})
		await deliverFlour(10_000)
		await deliverFlour(13_000)

		// Settings: target 30% (3000 bp) and tax-inclusive 15% (1500 bp) at this location.
		await db
			.insert(invSettings)
			.values({
				id: 'default',
				targetFoodCostBp: 3000,
				unitSystem: 'metric',
				updatedAt: Date.now(),
			})
			.onConflictDoUpdate({
				target: invSettings.id,
				set: { targetFoodCostBp: 3000 },
			})
		await db
			.insert(invLocationSettings)
			.values({
				locationId: locImpact,
				currency: 'SAR',
				pricesIncludeTax: true,
				taxRateBp: 1500,
				updatedAt: Date.now(),
			})
			.onConflictDoUpdate({
				target: invLocationSettings.locationId,
				set: { pricesIncludeTax: true, taxRateBp: 1500 },
			})

		const now = Date.now()
		// 1) Direct dish: 500 g of flour -> old 500 minor, new 650 minor.
		await db.insert(invRecipes).values({
			id: 'rec_direct_bread',
			ownerKind: 'menu_item',
			ownerId: 'dish_direct_bread',
			version: 1,
			effectiveFrom: now - 1000,
			createdByKind: 'system',
		})
		await db.insert(invRecipeLines).values({
			recipeId: 'rec_direct_bread',
			itemId: flour.id,
			quantity: 500_000,
		})

		// 2) Standard (non-batch-counted) made item: dough makes 1 kg from 1 kg flour; dish uses 400 g dough -> old 400 minor, new 520 minor.
		await db.insert(invItems).values({
			id: 'made_std_dough',
			name: 'Std dough',
			kind: 'made',
			baseUnit: 'g',
			batchCounted: false,
		})
		await db.insert(invRecipes).values([
			{
				id: 'rec_made_std_dough',
				ownerKind: 'made_item',
				ownerId: 'made_std_dough',
				version: 1,
				makesQuantity: 1_000_000,
				effectiveFrom: now - 1000,
				createdByKind: 'system',
			},
			{
				id: 'rec_std_pizza',
				ownerKind: 'menu_item',
				ownerId: 'dish_std_pizza',
				version: 1,
				effectiveFrom: now - 1000,
				createdByKind: 'system',
			},
		])
		await db.insert(invRecipeLines).values([
			{
				recipeId: 'rec_made_std_dough',
				itemId: flour.id,
				quantity: 1_000_000,
			},
			{
				recipeId: 'rec_std_pizza',
				itemId: 'made_std_dough',
				quantity: 400_000,
			},
		])

		// 3) Batch-counted made item: batch sauce makes 1 kg from 500 g flour; dish uses 200 g -> old 100 minor, new 130 minor.
		await db.insert(invItems).values({
			id: 'made_batch_roux',
			name: 'Batch roux',
			kind: 'made',
			baseUnit: 'g',
			batchCounted: true,
		})
		await db.insert(invItemCosts).values({
			itemId: 'made_batch_roux',
			currency: 'SAR',
			lastCostMicro: 500_000,
			avgCostMicro: 500_000,
			lastPricedAt: now - 5000,
		})
		await db.insert(invRecipes).values([
			{
				id: 'rec_made_batch_roux',
				ownerKind: 'made_item',
				ownerId: 'made_batch_roux',
				version: 1,
				makesQuantity: 1_000_000,
				effectiveFrom: now - 1000,
				createdByKind: 'system',
			},
			{
				id: 'rec_batch_pasta',
				ownerKind: 'menu_item',
				ownerId: 'dish_batch_pasta',
				version: 1,
				effectiveFrom: now - 1000,
				createdByKind: 'system',
			},
		])
		await db.insert(invRecipeLines).values([
			{
				recipeId: 'rec_made_batch_roux',
				itemId: flour.id,
				quantity: 500_000,
			},
			{
				recipeId: 'rec_batch_pasta',
				itemId: 'made_batch_roux',
				quantity: 200_000,
			},
		])

		// 4) Item group pass-through: flour is primary of group; dish uses 300 g group -> old 300 minor, new 390 minor.
		await db.insert(invItems).values({
			id: 'grp_all_flour',
			name: 'All flour group',
			kind: 'bought',
			baseUnit: 'g',
		})
		await db.insert(invItemGroups).values({ itemId: 'grp_all_flour' })
		await db.insert(invItemGroupMembers).values({
			groupItemId: 'grp_all_flour',
			memberItemId: flour.id,
			rank: 0,
			memberQuantity: 1,
			groupQuantity: 1,
		})
		await db.insert(invRecipes).values({
			id: 'rec_group_cake',
			ownerKind: 'menu_item',
			ownerId: 'dish_group_cake',
			version: 1,
			effectiveFrom: now - 1000,
			createdByKind: 'system',
		})
		await db.insert(invRecipeLines).values({
			recipeId: 'rec_group_cake',
			itemId: 'grp_all_flour',
			quantity: 300_000,
		})

		const res = await call(
			'GET',
			`${BASE}/price-alerts?locationId=${locImpact}&days=30`,
			{ token: costOnly },
		)
		expect(res.status, JSON.stringify(res.body)).toBe(200)
		const parsed = priceAlertsSchema.parse(res.body)
		expect(parsed.alerts).toHaveLength(1)
		const alert = parsed.alerts[0]!
		expect(alert).toMatchObject({
			itemId: flour.id,
			affectedDishes: 4,
			targetFoodCostBp: 3000,
			pricesIncludeTax: true,
			taxRateBp: 1500,
		})
		const byDish = new Map(alert.dishes!.map((d) => [d.menuItemId, d]))
		// priceForTargetMinor(650, 3000, { pricesIncludeTax: true, taxRateBp: 1500 })
		// net = round(650 * 10000 / 3000) = 2167; gross = round(2167 * 11500 / 10000) = 2492
		expect(byDish.get('dish_direct_bread')).toEqual({
			menuItemId: 'dish_direct_bread',
			variantId: null,
			previousCostMinor: 500,
			costMinor: 650,
			priceForTargetMinor: 2492,
		})
		expect(byDish.get('dish_std_pizza')).toMatchObject({
			menuItemId: 'dish_std_pizza',
			variantId: null,
			previousCostMinor: 400,
			costMinor: 520,
		})
		expect(byDish.get('dish_batch_pasta')).toMatchObject({
			menuItemId: 'dish_batch_pasta',
			variantId: null,
			previousCostMinor: 100,
			costMinor: 130,
		})
		expect(byDish.get('dish_group_cake')).toMatchObject({
			menuItemId: 'dish_group_cake',
			variantId: null,
			previousCostMinor: 300,
			costMinor: 390,
		})
	})
})

describe('the invoice photo', () => {
	let delivery: Record<string, any>
	let supplier: { id: string }
	let item: { id: string }
	const storageEnv = {
		RECORDING_S3_BUCKET: 'region-bucket',
		RECORDING_S3_ENDPOINT: 'https://s3.example.test',
		RECORDING_S3_ACCESS_KEY: 'access',
		RECORDING_S3_SECRET: 'secret',
	}
	let fetchSpy: ReturnType<typeof vi.spyOn>
	let objects: Map<string, { size: number; type: string }>
	let deleted: string[]

	beforeAll(async () => {
		supplier = await world.supplier('Photo Supplier')
		item = await world.item('Photo item')
		delivery = (
			await world.ok('POST', '/deliveries', {
				clientId: cid('del'),
				locationId: LOC,
				supplierId: supplier.id,
				currency: 'SAR',
				lines: [{ itemId: item.id, quantity: 1000, lineTotalMinor: 10 }],
			})
		).delivery
	})

	afterEach(() => {
		for (const key of Object.keys(storageEnv)) process.env[key] = ''
		fetchSpy?.mockRestore()
	})

	function withStorage() {
		Object.assign(process.env, storageEnv)
		objects = new Map()
		deleted = []
		fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockImplementation(async (url, init) => {
				const method = (init as RequestInit | undefined)?.method
				const key = decodeURIComponent(new URL(String(url)).pathname).replace(
					'/region-bucket/',
					'',
				)
				if (method === 'DELETE') {
					deleted.push(key)
					objects.delete(key)
					return new Response(null, { status: 204 })
				}
				const object = objects.get(key)
				if (!object) return new Response(null, { status: 404 })
				return new Response(null, {
					status: 200,
					headers: {
						'content-length': String(object.size),
						'content-type': object.type,
					},
				})
			})
	}

	const request = (body: Record<string, unknown>, id = delivery.id) =>
		call('POST', `${BASE}/deliveries/${id}/invoice-photo`, {
			token: full,
			body,
		})
	const confirm = (key: string, id = delivery.id) =>
		call('POST', `${BASE}/deliveries/${id}/invoice-photo/confirm`, {
			token: full,
			body: { key },
		})

	it('answers 503 upload_not_configured on a node with no object storage', async () => {
		const res = await request({ contentType: 'image/jpeg', sizeBytes: 1000 })
		expect(res.status).toBe(503)
		expect(res.body.code).toBe('upload_not_configured')
		const confirmRes = await confirm(
			`inventory-invoices/${ORG}/${delivery.id}/00000000-0000-4000-8000-000000000000.jpg`,
		)
		expect(confirmRes.status).toBe(503)
	})

	it('hands out a signed upload target in the region’s own storage, then confirms the stored object', async () => {
		withStorage()
		const target = invoicePhotoUploadSchema.parse(
			(await request({ contentType: 'image/png', sizeBytes: 2048 })).body,
		)
		expect(target.key).toMatch(
			new RegExp(
				`^inventory-invoices/${ORG}/${delivery.id}/[0-9a-f-]{36}\\.png$`,
			),
		)
		expect(target.method).toBe('PUT')
		expect(target.uploadUrl).toContain(
			`https://s3.example.test/region-bucket/${target.key}?`,
		)
		expect(target.uploadUrl).toContain(
			'X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost',
		)
		expect(target.headers).toMatchObject({ 'Content-Type': 'image/png' })
		expect(target.maxBytes).toBe(5 * 1024 * 1024)
		expect(target.expiresAt).toBeGreaterThan(Date.now())

		// Nothing is stored yet.
		const missing = await confirm(target.key)
		expect(missing.status).toBe(409)
		objects.set(target.key, { size: 2048, type: 'image/png' })
		const done = deliveryDetailSchema.parse((await confirm(target.key)).body)
		expect(done.hasPhoto).toBe(true)
		expect(done.photo).toMatchObject({ contentType: 'image/png' })
		expect(done.photo!.url).toContain(target.key)
		expect(done.photo!.url).toContain('X-Amz-Expires=300')
		// The read link is on the delivery, never in a list.
		const list = await call('GET', `${BASE}/deliveries?locationId=${LOC}`, {
			token: full,
		})
		const listed = list.body.deliveries.find(
			(entry: { id: string }) => entry.id === delivery.id,
		)
		expect(listed.hasPhoto).toBe(true)
		expect(listed).not.toHaveProperty('photo')
		const detail = await call('GET', `${BASE}/deliveries/${delivery.id}`, {
			token: full,
		})
		expect(detail.body.photo.contentType).toBe('image/png')

		// A confirm replay changes nothing; a new photo replaces and deletes the old one.
		const replay = await confirm(target.key)
		expect(replay.status).toBe(200)
		expect(deleted).toEqual([])
		const next = invoicePhotoUploadSchema.parse(
			(await request({ contentType: 'image/webp', sizeBytes: 500 })).body,
		)
		objects.set(next.key, { size: 500, type: 'image/webp' })
		const replaced = await confirm(next.key)
		expect(replaced.status).toBe(200)
		expect(replaced.body.photo.contentType).toBe('image/webp')
		expect(deleted).toEqual([target.key])
	})

	it('refuses keys that were not issued for this delivery, and objects of the wrong size or type (deleting them)', async () => {
		withStorage()
		const other = (
			await world.ok('POST', '/deliveries', {
				clientId: cid('del'),
				locationId: LOC,
				supplierId: supplier.id,
				currency: 'SAR',
				lines: [{ itemId: item.id, quantity: 1000, lineTotalMinor: 10 }],
			})
		).delivery
		const uuid = '00000000-0000-4000-8000-000000000000'
		for (const key of [
			`inventory-invoices/${ORG_B}/${delivery.id}/${uuid}.jpg`,
			`inventory-invoices/${ORG}/${other.id}/${uuid}.jpg`,
			`inventory-invoices/${ORG}/${delivery.id}/../${other.id}/${uuid}.jpg`,
			`inventory-invoices/${ORG}/${delivery.id}/${uuid}.gif`,
			`voice-recordings/${ORG}/call.ogg`,
		]) {
			const res = await confirm(key)
			expect(res.status, key).toBe(400)
		}
		expect(fetchSpy).not.toHaveBeenCalled()

		const wrongType = invoicePhotoUploadSchema.parse(
			(await request({ contentType: 'image/jpeg', sizeBytes: 100 })).body,
		)
		objects.set(wrongType.key, { size: 100, type: 'text/html' })
		expect((await confirm(wrongType.key)).status).toBe(400)
		expect(deleted).toContain(wrongType.key)
		const tooBig = invoicePhotoUploadSchema.parse(
			(await request({ contentType: 'image/jpeg', sizeBytes: 100 })).body,
		)
		objects.set(tooBig.key, { size: 6 * 1024 * 1024, type: 'image/jpeg' })
		expect((await confirm(tooBig.key)).status).toBe(400)
		expect(deleted).toContain(tooBig.key)

		// Request limits: type and size.
		for (const body of [
			{ contentType: 'application/pdf', sizeBytes: 100 },
			{ contentType: 'image/jpeg', sizeBytes: 0 },
			{ contentType: 'image/jpeg', sizeBytes: 5 * 1024 * 1024 + 1 },
		]) {
			expect((await request(body)).status).toBe(400)
		}
		// A cancelled delivery takes no photo.
		await world.ok('POST', `/deliveries/${other.id}/cancel`, {
			expectedVersion: other.version,
		})
		expect(
			(await request({ contentType: 'image/jpeg', sizeBytes: 100 }, other.id))
				.status,
		).toBe(409)
	})
})

describe('a Station tablet’s delivery (the service the Station routes call)', () => {
	let supplier: { id: string }
	let item: { id: string }
	let product: { id: string }
	let otherSupplier: { id: string }
	const tablet: InventoryCaller = {
		orgId: ORG,
		region: 'us',
		actor: { kind: 'staff', id: 'staff_1' },
		locationIds: [LOC],
		cost: false,
		purchasing: false,
	}

	beforeAll(async () => {
		supplier = await world.supplier('Tablet Supplier')
		otherSupplier = await world.supplier('Tablet Other')
		item = await world.item('Tablet item')
		product = await world.product(supplier.id, item.id)
	})

	function station(
		overrides: Record<string, unknown> = {},
		options: Parameters<typeof recordDelivery>[1]['options'] = {},
	) {
		const body = {
			clientId: cid('tab'),
			locationId: LOC,
			supplierId: supplier.id,
			quantityOnly: true,
			paid: false,
			lines: [
				{ itemId: item.id, supplierProductId: product.id, quantity: 5_000_000 },
			],
			...overrides,
		}
		return recordDelivery(tablet, {
			body: body as never,
			idempotency: {
				scope: 'pos-inventory:device_1:deliveries',
				key: body.clientId as string,
				requestHash: JSON.stringify(body),
			},
			options: { source: 'station', lenientOrder: true, ...options },
		})
	}

	it('records the goods as the staff member, from the station, flagged late and dated when it happened', async () => {
		const madeAt = Date.now() - 3 * 24 * 60 * 60 * 1000
		const result = await station({}, { lateSync: true, madeAt })
		expect(result.delivery).toMatchObject({
			source: 'station',
			lateSync: true,
			pricesPending: true,
			receivedAt: madeAt,
			receivedBy: { kind: 'staff', id: 'staff_1' },
		})
		const db = await getTenantDb(ORG)
		const [move] = await db
			.select()
			.from(invMovements)
			.where(eq(invMovements.sourceId, result.delivery.id))
		expect(move?.createdAt).toBe(madeAt)
		expect(result.order).toBeUndefined()
		expect(result.orderLinkIgnored).toBeUndefined()
		// A time in the future is no later than now.
		const future = await station({}, { madeAt: Date.now() + 86_400_000 })
		expect(future.delivery.receivedAt).toBeLessThanOrEqual(Date.now())
	})

	it('never refuses goods for the order: a closed, unknown or other-supplier order is recorded unlinked', async () => {
		const order = (await world.ok('POST', '/orders', {
			clientId: cid('ord'),
			locationId: LOC,
			supplierId: supplier.id,
			lines: [{ itemId: item.id, supplierProductId: product.id, packs: 2 }],
		})) as Record<string, any>

		const wrongSupplier = await station({
			orderId: order.id,
			supplierId: otherSupplier.id,
		})
		expect(wrongSupplier.orderLinkIgnored).toBe('wrong_supplier')
		expect(wrongSupplier.delivery.orderId).toBeNull()
		const unknown = await station({ orderId: 'no-such-order' })
		expect(unknown.orderLinkIgnored).toBe('not_found')
		const unlinkedLine = await station({
			orderId: order.id,
			lines: [
				{
					itemId: item.id,
					supplierProductId: product.id,
					quantity: 1000,
					orderLineId: 'not-a-line',
				},
			],
		})
		expect(unlinkedLine.delivery.orderId).toBe(order.id)
		expect(unlinkedLine.delivery.lines[0].orderLineId).toBeUndefined()

		const linked = await station({
			orderId: order.id,
			lines: [
				{
					itemId: item.id,
					supplierProductId: product.id,
					quantity: 20_000_000,
					orderLineId: order.lines[0].id,
				},
			],
			closeOrder: true,
		})
		expect(linked.orderLinkIgnored).toBeNull()
		expect(linked.order).toMatchObject({ id: order.id, status: 'received' })
		expect(linked.delivery).toMatchObject({
			orderId: order.id,
			pricesPending: true,
		})

		const closed = await station({ orderId: order.id })
		expect(closed.orderLinkIgnored).toBe('closed')
		expect(closed.delivery.orderId).toBeNull()
		// The operator route refuses the same closed order.
		const refused = await call('POST', `${BASE}/deliveries`, {
			token: full,
			body: {
				clientId: cid('del'),
				locationId: LOC,
				supplierId: supplier.id,
				currency: 'SAR',
				orderId: order.id,
				lines: [{ itemId: item.id, quantity: 1000, lineTotalMinor: 3 }],
			},
		})
		expect(refused.status).toBe(409)
		expect(refused.body.code).toBe('order_closed')
	})

	it('tells the caller when the clientId was already stored, and answers the first result', async () => {
		const clientId = cid('tab')
		const onReplay = vi.fn()
		const first = await station({ clientId }, { onReplay })
		expect(onReplay).not.toHaveBeenCalled()
		const second = await station({ clientId }, { onReplay })
		expect(onReplay).toHaveBeenCalledTimes(1)
		expect(second.delivery.id).toBe(first.delivery.id)
		// The same id with another body is a conflict, never a silent second delivery.
		await expect(
			station({ clientId, supplierId: null }, { onReplay }),
		).rejects.toMatchObject({ code: 'idempotency_conflict' })
	})

	it('cannot leave the terminal’s location, and a tablet cannot mark paid', async () => {
		await expect(
			station({ locationId: 'loc_elsewhere' }),
		).rejects.toMatchObject({
			code: 'location_forbidden',
		})
	})
})

describe('canceling a priced delivery rewinds average cost', () => {
	it('drops cancelled quantity from later onHandBefore steps', async () => {
		const supplier = await world.supplier('Rewind Sup')
		const item = await world.item('Rewind avg item')
		await world.ok('POST', '/deliveries', {
			clientId: cid('del-1'),
			locationId: LOC,
			supplierId: supplier.id,
			currency: 'SAR',
			lines: [
				{ itemId: item.id, quantity: 10_000_000, lineTotalMinor: 20_000 },
			],
		})
		const dup = (
			await world.ok('POST', '/deliveries', {
				clientId: cid('del-dup'),
				locationId: LOC,
				supplierId: supplier.id,
				currency: 'SAR',
				lines: [
					{ itemId: item.id, quantity: 10_000_000, lineTotalMinor: 20_000 },
				],
			})
		).delivery as { id: string; version: number }
		await world.ok('POST', '/deliveries', {
			clientId: cid('del-3'),
			locationId: LOC,
			supplierId: supplier.id,
			currency: 'SAR',
			lines: [
				{ itemId: item.id, quantity: 10_000_000, lineTotalMinor: 40_000 },
			],
		})
		await world.ok('POST', `/deliveries/${dup.id}/cancel`, {
			expectedVersion: dup.version,
		})
		const cost = await costOf(item.id)
		expect(cost?.avgCostMicro).toBe(3_000_000)
	})
})
