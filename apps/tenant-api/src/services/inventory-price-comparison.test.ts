import {
	INVENTORY_PERMISSIONS,
	itemDetailSchema,
	priceComparisonResultSchema,
} from '@repo/inventory'
import { destroyTenantDb, provisionTenantDb } from '@repo/tenant-db'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { type PublishedOrganization } from '../lib/origin.ts'
import {
	BASE,
	cid,
	makeClient,
	mintToken,
	READ,
	setupTenantEnv,
	UPDATE,
} from '../routes/inventory-test-utils.ts'
import { operatorInventoryRoutes } from '../routes/operator-inventory.ts'

const ORG = 'org_inv_cmp_a'
const LOC_A = 'loc_cmp_a'
const LOC_B = 'loc_cmp_b'

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
let fullToken: string
let noCostToken: string
let locAToken: string

beforeAll(async () => {
	env = setupTenantEnv('inv-cmp')
	orgs.set(ORG, {
		id: ORG,
		slug: ORG,
		customDomain: null,
		hasProvisionedDb: true,
		dataRegion: 'us',
		name: ORG,
	})
	await provisionTenantDb(ORG)
	fullToken = await mintToken(ORG)
	noCostToken = await mintToken(ORG, { grants: [READ, UPDATE] })
	locAToken = await mintToken(ORG, {
		locationIds: [LOC_A],
		grants: [
			READ,
			UPDATE,
			INVENTORY_PERMISSIONS.READ_INVENTORY_COST,
			INVENTORY_PERMISSIONS.UPDATE_INVENTORY_PURCHASING,
		],
	})
})

afterAll(async () => {
	await destroyTenantDb(ORG)
	env.cleanup()
})

async function createSupplier(name: string) {
	const res = await call('POST', `${BASE}/suppliers`, {
		token: fullToken,
		body: { clientId: cid('sup'), name, currency: 'SAR' },
	})
	expect(res.status, JSON.stringify(res.body)).toBe(200)
	return res.body as { id: string; name: string }
}

async function createItem(name: string, baseUnit = 'g') {
	const res = await call('POST', `${BASE}/items`, {
		token: fullToken,
		body: {
			clientId: cid('itm'),
			name,
			category: 'meat',
			kind: 'bought',
			baseUnit,
		},
	})
	expect(res.status, JSON.stringify(res.body)).toBe(200)
	return res.body as { id: string; name: string }
}

async function postDelivery(input: {
	locationId: string
	supplierId: string | null
	invoiceDate?: string
	isCredit?: boolean
	quantityOnly?: boolean
	lines: Array<{
		itemId: string
		quantity: number
		packs?: number
		packName?: string
		packBaseQuantity?: number
		realWeightQuantity?: number
		lineTotalMinor?: number
	}>
}) {
	const res = await call('POST', `${BASE}/deliveries`, {
		token: fullToken,
		body: {
			clientId: cid('del'),
			locationId: input.locationId,
			supplierId: input.supplierId,
			...(input.invoiceDate ? { invoiceDate: input.invoiceDate } : {}),
			...(input.isCredit ? { isCredit: true } : {}),
			...(input.quantityOnly ? { quantityOnly: true } : { currency: 'SAR' }),
			lines: input.lines,
		},
	})
	expect(res.status, JSON.stringify(res.body)).toBe(200)
	return res.body as { id: string; businessDate: string }
}

describe('price comparison (#508)', () => {
	it('compares two locations and suppliers with exact saving, pack conversion, and realWeightQuantity', async () => {
		const supA = await createSupplier('Al Watania')
		const supB = await createSupplier('Fresh Farms')
		const chicken = await createItem('Chicken breast', 'g')
		const beef = await createItem('Beef tenderloin', 'g')
		const oil = await createItem('Olive oil', 'ml')

		// Chicken bought as packs across 2 deliveries at Loc A @ supA (weighted avg):
		// Delivery 1: 1 box of 10kg (10_000_000) for SAR 260 (26_000) -> 2_600_000 micro/g
		// Delivery 2: 1 box of 10kg (10_000_000) for SAR 300 (30_000) -> 3_000_000 micro/g
		// Weighted average = (26_000 + 30_000) / 20_000_000 = 2_800_000 micro/g (SAR 28/kg), latest = 3_000_000, deliveriesCount = 2
		await postDelivery({
			locationId: LOC_A,
			supplierId: supA.id,
			invoiceDate: '2026-11-10',
			lines: [
				{
					itemId: chicken.id,
					quantity: 10_000_000,
					packs: 1,
					packName: '10 kg Box',
					packBaseQuantity: 10_000_000,
					lineTotalMinor: 26_000,
				},
			],
		})
		await postDelivery({
			locationId: LOC_A,
			supplierId: supA.id,
			invoiceDate: '2026-11-11',
			lines: [
				{
					itemId: chicken.id,
					quantity: 10_000_000,
					packs: 1,
					packName: '10 kg Box',
					packBaseQuantity: 10_000_000,
					lineTotalMinor: 30_000,
				},
			],
		})
		// Loc B @ supB: 10 kg (10_000_000) for SAR 320 (32_000 minor) -> 3_200_000 micro/g (SAR 32/kg)
		await postDelivery({
			locationId: LOC_B,
			supplierId: supB.id,
			invoiceDate: '2026-11-12',
			lines: [
				{
					itemId: chicken.id,
					quantity: 10_000_000,
					packs: 1,
					packName: '10 kg Box',
					packBaseQuantity: 10_000_000,
					lineTotalMinor: 32_000,
				},
			],
		})
		// Credit note & unpriced delivery must be ignored in comparison
		await postDelivery({
			locationId: LOC_A,
			supplierId: supA.id,
			invoiceDate: '2026-11-13',
			isCredit: true,
			lines: [
				{
					itemId: chicken.id,
					quantity: 5_000_000,
					lineTotalMinor: 14_000,
				},
			],
		})
		await postDelivery({
			locationId: LOC_B,
			supplierId: supB.id,
			invoiceDate: '2026-11-14',
			quantityOnly: true,
			lines: [{ itemId: chicken.id, quantity: 5_000_000 }],
		})

		// Beef priced by weight (realWeightQuantity overrides nominal quantity):
		// Loc A @ supA: nominal 10kg, realWeight 8kg (8_000_000) for SAR 400 (40_000 minor) -> 5_000_000 micro/g (SAR 50/kg)
		await postDelivery({
			locationId: LOC_A,
			supplierId: supA.id,
			invoiceDate: '2026-11-10',
			lines: [
				{
					itemId: beef.id,
					quantity: 10_000_000,
					realWeightQuantity: 8_000_000,
					lineTotalMinor: 40_000,
				},
			],
		})
		// Loc B @ supB: nominal 10kg, realWeight 12kg (12_000_000) for SAR 480 (48_000 minor) -> 4_000_000 micro/g (SAR 40/kg)
		await postDelivery({
			locationId: LOC_B,
			supplierId: supB.id,
			invoiceDate: '2026-11-15',
			lines: [
				{
					itemId: beef.id,
					quantity: 10_000_000,
					realWeightQuantity: 12_000_000,
					lineTotalMinor: 48_000,
				},
			],
		})

		// Single-supplier/single-location item: oil (0 spread, 0 saving)
		await postDelivery({
			locationId: LOC_A,
			supplierId: supA.id,
			invoiceDate: '2026-11-11',
			lines: [
				{
					itemId: oil.id,
					quantity: 5_000_000,
					lineTotalMinor: 15_000,
				},
			],
		})

		const res = await call(
			'GET',
			`${BASE}/price-comparison?from=2026-11-01&to=2026-11-30`,
			{ token: fullToken },
		)
		expect(res.status, JSON.stringify(res.body)).toBe(200)
		const parsed = priceComparisonResultSchema.parse(res.body)

		// Beef saving = 40_000 - (8_000_000 * 4_000_000 / 1e9) = 40_000 - 32_000 = 8_000
		// Chicken saving = 32_000 - (10_000_000 * 2_800_000 / 1e9) = 32_000 - 28_000 = 4_000
		// Oil saving = 0
		expect(parsed.totalSavingMinor).toBe(12_000)
		expect(parsed.items.map((item) => item.itemId)).toEqual([
			beef.id,
			chicken.id,
			oil.id,
		])

		const beefReport = parsed.items[0]!
		expect(beefReport.lowestCostMicro).toBe(4_000_000)
		expect(beefReport.lowestLocationId).toBe(LOC_B)
		expect(beefReport.lowestSupplierName).toBe('Fresh Farms')
		expect(beefReport.highestCostMicro).toBe(5_000_000)
		expect(beefReport.highestLocationId).toBe(LOC_A)
		expect(beefReport.spreadCostMicro).toBe(1_000_000)
		expect(beefReport.spreadBp).toBe(2500)
		expect(beefReport.savingMinor).toBe(8_000)
		expect(beefReport.totalPaidMinor).toBe(88_000)

		const chickenReport = parsed.items[1]!
		expect(chickenReport.entries).toHaveLength(2)
		expect(chickenReport.entries[0]).toMatchObject({
			locationId: LOC_A,
			supplierId: supA.id,
			costMicro: 2_800_000,
			latestCostMicro: 3_000_000,
			deliveriesCount: 2,
			quantity: 20_000_000,
			paidMinor: 56_000,
		})
		expect(chickenReport.lowestCostMicro).toBe(2_800_000)
		expect(chickenReport.highestCostMicro).toBe(3_200_000)
		expect(chickenReport.spreadCostMicro).toBe(400_000)
		expect(chickenReport.spreadBp).toBe(1429)
		expect(chickenReport.savingMinor).toBe(4_000)
		expect(chickenReport.totalPaidMinor).toBe(88_000)

		const oilReport = parsed.items[2]!
		expect(oilReport.entries).toHaveLength(1)
		expect(oilReport.spreadCostMicro).toBe(0)
		expect(oilReport.savingMinor).toBe(0)

		// Default 90-day range also works and rejects from > to
		const defaultRes = await call('GET', `${BASE}/price-comparison`, {
			token: fullToken,
		})
		expect(defaultRes.status).toBe(200)
		const badRange = await call(
			'GET',
			`${BASE}/price-comparison?from=2026-12-01&to=2026-11-01`,
			{ token: fullToken },
		)
		expect(badRange.status).toBe(400)
	})

	it('enforces cost grant and locationIds scoping on /price-comparison and GET /items/:id othersPay', async () => {
		const sup1 = await createSupplier('Scope Sup 1')
		const sup2 = await createSupplier('Scope Sup 2')
		const cheese = await createItem('Mozzarella', 'g')

		// Loc B (restricted from locAToken) is MUCH cheaper (SAR 10/kg)
		await postDelivery({
			locationId: LOC_B,
			supplierId: sup2.id,
			invoiceDate: '2026-11-18',
			lines: [
				{
					itemId: cheese.id,
					quantity: 10_000_000,
					lineTotalMinor: 10_000,
				},
			],
		})
		// Loc A (allowed for locAToken) buys from sup1 at SAR 20/kg and sup2 at SAR 30/kg
		await postDelivery({
			locationId: LOC_A,
			supplierId: sup1.id,
			invoiceDate: '2026-11-18',
			lines: [
				{
					itemId: cheese.id,
					quantity: 10_000_000,
					lineTotalMinor: 20_000,
				},
			],
		})
		// Make sup2 at LOC_A newer (inserted after sup1, higher rowid / timestamp)
		await postDelivery({
			locationId: LOC_A,
			supplierId: sup2.id,
			invoiceDate: '2026-11-19',
			lines: [
				{
					itemId: cheese.id,
					quantity: 10_000_000,
					lineTotalMinor: 30_000,
				},
			],
		})

		// 1. Caller without cost grant gets 403 on /price-comparison
		const denied = await call('GET', `${BASE}/price-comparison`, {
			token: noCostToken,
		})
		expect(denied.status).toBe(403)

		// 2. Caller without cost grant gets no othersPay on GET /items/:id
		const itemNoCostRes = await call(
			'GET',
			`${BASE}/items/${cheese.id}?locationId=${LOC_A}`,
			{ token: noCostToken },
		)
		expect(itemNoCostRes.status).toBe(200)
		const itemNoCost = itemDetailSchema.parse(itemNoCostRes.body)
		expect(itemNoCost.othersPay).toBeUndefined()
		expect(itemNoCost.cost).toBeUndefined()

		// 3. Caller restricted to [LOC_A] never sees LOC_B in /price-comparison
		const scopedCmpRes = await call(
			'GET',
			`${BASE}/price-comparison?from=2026-11-01&to=2026-11-30&itemId=${cheese.id}`,
			{ token: locAToken },
		)
		expect(scopedCmpRes.status).toBe(200)
		const scopedCmp = priceComparisonResultSchema.parse(scopedCmpRes.body)
		expect(scopedCmp.items).toHaveLength(1)
		const scopedEntries = scopedCmp.items[0]!.entries
		expect(scopedEntries.every((e) => e.locationId === LOC_A)).toBe(true)
		expect(scopedCmp.items[0]!.lowestCostMicro).toBe(2_000_000)
		expect(scopedCmp.items[0]!.lowestLocationId).toBe(LOC_A)
		// Saving within LOC_A alone: 30_000 - (10_000_000 * 2_000_000 / 1e9) = 10_000
		expect(scopedCmp.items[0]!.savingMinor).toBe(10_000)

		// 4. Caller restricted to [LOC_A] never sees LOC_B in othersPay (sees sup1 at LOC_A instead)
		const itemScopedRes = await call(
			'GET',
			`${BASE}/items/${cheese.id}?locationId=${LOC_A}`,
			{ token: locAToken },
		)
		expect(itemScopedRes.status).toBe(200)
		const itemScoped = itemDetailSchema.parse(itemScopedRes.body)
		expect(itemScoped.othersPay).toMatchObject({
			locationId: LOC_A,
			supplierId: sup1.id,
			supplierName: 'Scope Sup 1',
			costMicro: 2_000_000,
			currentCostMicro: 3_000_000,
			diffCostMicro: 1_000_000,
		})

		// 5. Full caller viewing LOC_A sees LOC_B (SAR 10/kg) in othersPay
		const itemFullLocARes = await call(
			'GET',
			`${BASE}/items/${cheese.id}?locationId=${LOC_A}`,
			{ token: fullToken },
		)
		expect(itemFullLocARes.status).toBe(200)
		const itemFullLocA = itemDetailSchema.parse(itemFullLocARes.body)
		expect(itemFullLocA.othersPay).toMatchObject({
			locationId: LOC_B,
			supplierId: sup2.id,
			supplierName: 'Scope Sup 2',
			costMicro: 1_000_000,
			currentCostMicro: 3_000_000,
			diffCostMicro: 2_000_000,
		})

		// 6. Full caller viewing LOC_B (already cheapest) gets othersPay = null
		const itemFullLocBRes = await call(
			'GET',
			`${BASE}/items/${cheese.id}?locationId=${LOC_B}`,
			{ token: fullToken },
		)
		expect(itemFullLocBRes.status).toBe(200)
		const itemFullLocB = itemDetailSchema.parse(itemFullLocBRes.body)
		expect(itemFullLocB.othersPay).toBeNull()
	})
})
