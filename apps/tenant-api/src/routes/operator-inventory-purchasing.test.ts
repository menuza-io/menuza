import {
	deliveryDetailSchema,
	listDeliveriesResultSchema,
	listSuppliersResultSchema,
	recordDeliveryResultSchema,
	supplierDetailSchema,
	supplierProductSchema,
	supplierSchema,
} from '@repo/inventory'
import {
	destroyTenantDb,
	getTenantDb,
	invMovements,
	provisionTenantDb,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { type PublishedOrganization } from '../lib/origin.ts'
import {
	ALL_GRANTS,
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
 * Suppliers, supplier products and deliveries: stock in, last and average
 * cost, price rises, paid marks, cancelling by reversing movements, and the
 * grant, location and organization rules around them.
 */

const ORG = 'org_inv_buy_a'
const ORG_B = 'org_inv_buy_b'
const LOC = 'loc_buy'

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
let noPurchasing: string
let readOnly: string
let tokenB: string
let scoped: string

beforeAll(async () => {
	env = setupTenantEnv('inv-buy')
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
	noPurchasing = await mintToken(ORG, {
		grants: ALL_GRANTS.filter((g) => g !== 'update:inventory_purchasing:any'),
	})
	readOnly = await mintToken(ORG, { scope: 'read', grants: [READ] })
	tokenB = await mintToken(ORG_B)
	scoped = await mintToken(ORG, { locationIds: [LOC] })
})

afterAll(async () => {
	await destroyTenantDb(ORG)
	await destroyTenantDb(ORG_B)
	env.cleanup()
})

async function supplier(name: string, extra: Record<string, unknown> = {}) {
	const res = await call('POST', `${BASE}/suppliers`, {
		token: full,
		body: { clientId: cid('sup'), name, currency: 'SAR', ...extra },
	})
	expect(res.status, JSON.stringify(res.body)).toBe(200)
	return supplierSchema.parse(res.body)
}

async function item(name: string, baseUnit = 'g') {
	const res = await call('POST', `${BASE}/items`, {
		token: full,
		body: {
			clientId: cid('item'),
			name,
			category: 'meat',
			kind: 'bought',
			baseUnit,
		},
	})
	expect(res.status, JSON.stringify(res.body)).toBe(200)
	return res.body as { id: string; version: number; name: string }
}

function delivery(
	supplierId: string | null,
	lines: Array<Record<string, unknown>>,
	extra: Record<string, unknown> = {},
) {
	return {
		clientId: cid('del'),
		locationId: LOC,
		supplierId,
		currency: 'SAR',
		lines,
		...extra,
	}
}

describe('suppliers', () => {
	it('creates with defaults, replays the clientId, refuses a duplicate name, and needs the purchasing grant', async () => {
		const body = {
			clientId: cid('sup'),
			name: 'Al Watania Poultry',
			currency: 'SAR',
			deliveryDays: [4, 1, 4],
			cutoffTime: '16:00',
			cutoffDaysBefore: 1,
			minimumOrderMinor: 40000,
			email: 'orders@watania.example',
		}
		const first = await call('POST', `${BASE}/suppliers`, { token: full, body })
		expect(first.status).toBe(200)
		const created = supplierSchema.parse(first.body)
		expect(created).toMatchObject({
			orderChannel: 'phone',
			deliveryDays: [1, 4],
			cutoffTime: '16:00',
			minimumOrderMinor: 40000,
			version: 1,
			productCount: 0,
			unpaidCount: 0,
			archived: false,
		})
		const replay = await call('POST', `${BASE}/suppliers`, {
			token: full,
			body,
		})
		expect(replay.body.id).toBe(created.id)
		const dup = await call('POST', `${BASE}/suppliers`, {
			token: full,
			body: { ...body, clientId: cid('sup'), name: 'al watania poultry' },
		})
		expect(dup.status).toBe(409)
		expect(dup.body.code).toBe('name_taken')
		const denied = await call('POST', `${BASE}/suppliers`, {
			token: noPurchasing,
			body: { ...body, clientId: cid('sup'), name: 'Other' },
		})
		expect(denied.status).toBe(403)
		expect(denied.body).toMatchObject({ code: 'forbidden', reason: 'grant' })
		const readDenied = await call('POST', `${BASE}/suppliers`, {
			token: readOnly,
			body: { ...body, clientId: cid('sup'), name: 'Other' },
		})
		expect(readDenied.status).toBe(403)
	})

	it('edits only what is sent (a PATCH keeps the order channel and delivery days), with expectedVersion', async () => {
		const created = await supplier('Fresh Farms', {
			orderChannel: 'whatsapp',
			deliveryDays: [0, 3],
		})
		const patched = await call('PATCH', `${BASE}/suppliers/${created.id}`, {
			token: full,
			body: { expectedVersion: 1, phone: '+966500000000' },
		})
		expect(patched.status).toBe(200)
		expect(patched.body).toMatchObject({
			orderChannel: 'whatsapp',
			deliveryDays: [0, 3],
			phone: '+966500000000',
			version: 2,
		})
		const cleared = await call('PATCH', `${BASE}/suppliers/${created.id}`, {
			token: full,
			body: { expectedVersion: 2, phone: null, cutoffTime: '15:30' },
		})
		expect(cleared.body).toMatchObject({ phone: null, cutoffTime: '15:30' })
		const stale = await call('PATCH', `${BASE}/suppliers/${created.id}`, {
			token: full,
			body: { expectedVersion: 1, name: 'Nope' },
		})
		expect(stale.body).toMatchObject({
			code: 'stale_version',
			currentVersion: 3,
		})
		const bad = await call('PATCH', `${BASE}/suppliers/${created.id}`, {
			token: full,
			body: { expectedVersion: 3, cutoffTime: '25:99', rogue: 'echo-me' },
		})
		expect(bad.status).toBe(400)
		expect(JSON.stringify(bad.body)).not.toContain('echo-me')
	})

	it('archives, lists with and without archived, and leaves money out without the cost grant', async () => {
		const a = await supplier('Archive me', { minimumOrderMinor: 500 })
		await supplier('Keep me')
		const archived = await call('POST', `${BASE}/suppliers/${a.id}/archive`, {
			token: full,
			body: { expectedVersion: 1 },
		})
		expect(archived.status).toBe(200)
		expect(archived.body.archived).toBe(true)
		const live = listSuppliersResultSchema.parse(
			(await call('GET', `${BASE}/suppliers`, { token: full })).body,
		)
		expect(live.suppliers.map((s) => s.name)).not.toContain('Archive me')
		const all = await call('GET', `${BASE}/suppliers?includeArchived=true`, {
			token: full,
		})
		expect(all.body.suppliers.map((s: { name: string }) => s.name)).toContain(
			'Archive me',
		)
		const explicitFalse = await call(
			'GET',
			`${BASE}/suppliers?includeArchived=false`,
			{ token: full },
		)
		expect(
			explicitFalse.body.suppliers.map((s: { name: string }) => s.name),
		).not.toContain('Archive me')

		const costFree = await call(
			'GET',
			`${BASE}/suppliers?includeArchived=true`,
			{ token: noCost },
		)
		expect(costFree.status).toBe(200)
		expect(JSON.stringify(costFree.body)).not.toContain('minimumOrderMinor')
		expect(JSON.stringify(costFree.body)).not.toContain('unpaidMinor')
		const gone = await call('GET', `${BASE}/suppliers/${a.id}`, {
			token: tokenB,
		})
		expect(gone.status).toBe(404)
	})
})

describe('supplier products', () => {
	it('adds, keeps one preferred product per item, updates, archives and shows them on the item', async () => {
		const s1 = await supplier('Product supplier one')
		const s2 = await supplier('Product supplier two')
		const rice = await item('Product rice')
		const first = await call('POST', `${BASE}/suppliers/${s1.id}/products`, {
			token: full,
			body: {
				itemId: rice.id,
				packName: 'Bag',
				packBaseQuantity: 25_000_000,
				priceMinor: 9000,
				preferred: true,
			},
		})
		expect(first.status, JSON.stringify(first.body)).toBe(200)
		const p1 = supplierProductSchema.parse(first.body)
		expect(p1).toMatchObject({
			preferred: true,
			priceMinor: 9000,
			currency: 'SAR',
			itemName: 'Product rice',
		})
		const second = await call('POST', `${BASE}/suppliers/${s2.id}/products`, {
			token: full,
			body: {
				itemId: rice.id,
				packName: 'Sack',
				packBaseQuantity: 50_000_000,
				priceMinor: 17000,
				preferred: true,
			},
		})
		expect(second.body.preferred).toBe(true)
		const detail = await call(
			'GET',
			`${BASE}/items/${rice.id}?locationId=${LOC}`,
			{ token: full },
		)
		const byName = Object.fromEntries(
			detail.body.suppliers.map(
				(s: { packName: string; preferred: boolean }) => [
					s.packName,
					s.preferred,
				],
			),
		)
		expect(byName).toEqual({ Bag: false, Sack: true })

		const updated = await call('PATCH', `${BASE}/supplier-products/${p1.id}`, {
			token: full,
			body: { expectedVersion: 2, priceMinor: 9500 },
		})
		expect(updated.body).toMatchObject({
			priceMinor: 9500,
			pricedByWeight: false,
			packName: 'Bag',
			version: 3,
		})
		const stale = await call('PATCH', `${BASE}/supplier-products/${p1.id}`, {
			token: full,
			body: { expectedVersion: 1, priceMinor: 1 },
		})
		expect(stale.body.code).toBe('stale_version')
		const costFree = await call('GET', `${BASE}/suppliers/${s1.id}`, {
			token: noCost,
		})
		expect(costFree.status).toBe(200)
		expect(
			supplierDetailSchema.parse(costFree.body).products[0]!.priceMinor,
		).toBeUndefined()
		const withCost = await call('GET', `${BASE}/suppliers/${s1.id}`, {
			token: full,
		})
		expect(withCost.body.productCount).toBe(1)
		expect(withCost.body.products[0].priceMinor).toBe(9500)

		const archived = await call(
			'POST',
			`${BASE}/supplier-products/${p1.id}/archive`,
			{
				token: full,
				body: { expectedVersion: 3 },
			},
		)
		expect(archived.status).toBe(200)
		expect(
			(await call('GET', `${BASE}/suppliers/${s1.id}`, { token: full })).body
				.products,
		).toEqual([])
		const missing = await call('POST', `${BASE}/suppliers/${s1.id}/products`, {
			token: full,
			body: {
				itemId: 'ghost-item',
				packName: 'Bag',
				packBaseQuantity: 1000,
				priceMinor: 1,
			},
		})
		expect(missing.status).toBe(404)
	})

	it('creates the first supplier product with a new item (and needs the purchasing grant for it)', async () => {
		const s = await supplier('Item form supplier')
		const body = {
			clientId: cid('item'),
			name: 'Form item',
			category: 'dairy',
			kind: 'bought',
			baseUnit: 'ml',
			supplierProduct: {
				supplierId: s.id,
				packName: 'Case',
				packBaseQuantity: 6000,
				priceMinor: 4200,
				currency: 'SAR',
				pricedByWeight: false,
			},
		}
		const denied = await call('POST', `${BASE}/items`, {
			token: noPurchasing,
			body,
		})
		expect(denied.status).toBe(403)
		const ok = await call('POST', `${BASE}/items`, {
			token: full,
			body: { ...body, clientId: cid('item') },
		})
		expect(ok.status, JSON.stringify(ok.body)).toBe(200)
		expect(ok.body.suppliers).toHaveLength(1)
		expect(ok.body.suppliers[0]).toMatchObject({
			preferred: true,
			priceMinor: 4200,
		})
	})
})

describe('deliveries', () => {
	it('posts stock in, sets last and average cost, reports price rises, and replays the clientId', async () => {
		const s = await supplier('Delivery supplier')
		const chicken = await item('Delivery chicken')
		const product = await call('POST', `${BASE}/suppliers/${s.id}/products`, {
			token: full,
			body: {
				itemId: chicken.id,
				packName: 'Box',
				packBaseQuantity: 10_000_000,
				priceMinor: 28000,
			},
		})
		const line = (total: number, extra: Record<string, unknown> = {}) => ({
			itemId: chicken.id,
			supplierProductId: product.body.id,
			quantity: 10_000_000,
			packs: 1,
			packName: 'Box',
			packBaseQuantity: 10_000_000,
			lineTotalMinor: total,
			...extra,
		})
		const body = delivery(s.id, [line(28000, { packPriceMinor: 28000 })], {
			invoiceNumber: 'INV-1',
			vatMinor: 4200,
			totalMinor: 32200,
		})
		const first = await call('POST', `${BASE}/deliveries`, {
			token: full,
			body,
		})
		expect(first.status, JSON.stringify(first.body)).toBe(200)
		const result = recordDeliveryResultSchema.parse(first.body)
		expect(result.delivery).toMatchObject({
			status: 'received',
			supplierName: 'Delivery supplier',
			invoiceNumber: 'INV-1',
			lineCount: 1,
			linesTotalMinor: 28000,
			vatMinor: 4200,
			totalMinor: 32200,
			paid: false,
			currency: 'SAR',
		})
		expect(result.delivery.lines[0]).toMatchObject({
			itemName: 'Delivery chicken',
			packs: 1,
			lineTotalMinor: 28000,
		})
		expect(result.priceChanges).toEqual([])

		const replay = await call('POST', `${BASE}/deliveries`, {
			token: full,
			body,
		})
		expect(replay.status).toBe(200)
		expect(replay.body.delivery.id).toBe(result.delivery.id)
		const stock = await call(
			'GET',
			`${BASE}/items/${chicken.id}?locationId=${LOC}`,
			{ token: full },
		)
		expect(stock.body.onHand).toBe(10_000_000)
		expect(stock.body.cost).toMatchObject({
			lastCostMicro: 2_800_000,
			avgCostMicro: 2_800_000,
			currency: 'SAR',
		})

		const second = await call('POST', `${BASE}/deliveries`, {
			token: full,
			body: delivery(s.id, [line(31920, { packPriceMinor: 31920 })]),
		})
		const rise = recordDeliveryResultSchema.parse(second.body)
		expect(rise.priceChanges).toEqual([
			{
				itemId: chicken.id,
				itemName: 'Delivery chicken',
				previousCostMicro: 2_800_000,
				costMicro: 3_192_000,
				changeBp: 1400,
			},
		])
		expect(rise.delivery.lines[0]!.priceChangeBp).toBe(1400)
		const after = await call(
			'GET',
			`${BASE}/items/${chicken.id}?locationId=${LOC}`,
			{ token: full },
		)
		expect(after.body.onHand).toBe(20_000_000)
		expect(after.body.cost).toMatchObject({
			lastCostMicro: 3_192_000,
			avgCostMicro: 2_996_000,
		})
		expect(
			after.body.cost.history.map((h: { costMicro: number }) => h.costMicro),
		).toEqual([2_800_000, 3_192_000])
		expect(after.body.valueMinor).toBe(59920)
		// The pack price was remembered on the supplier product.
		const supplierDetail = await call('GET', `${BASE}/suppliers/${s.id}`, {
			token: full,
		})
		expect(supplierDetail.body.products[0].priceMinor).toBe(31920)

		const clash = await call('POST', `${BASE}/deliveries`, {
			token: full,
			body: { ...body, invoiceNumber: 'INV-2' },
		})
		expect(clash.status).toBe(409)
		expect(clash.body.code).toBe('idempotency_conflict')
		const mismatch = await call('POST', `${BASE}/deliveries`, {
			token: full,
			body: { ...delivery(s.id, [line(1000)]), currency: 'USD' },
		})
		expect(mismatch.status).toBe(400)
	})

	it('a token without the cost grant records a delivery and gets no money back; without purchasing it leaves prices alone', async () => {
		const s = await supplier('Cost-less supplier')
		const flour = await item('Cost-less flour')
		const product = await call('POST', `${BASE}/suppliers/${s.id}/products`, {
			token: full,
			body: {
				itemId: flour.id,
				packName: 'Bag',
				packBaseQuantity: 1_000_000,
				priceMinor: 500,
			},
		})
		const res = await call('POST', `${BASE}/deliveries`, {
			token: noCost,
			body: delivery(s.id, [
				{
					itemId: flour.id,
					supplierProductId: product.body.id,
					quantity: 5_000_000,
					lineTotalMinor: 2600,
					packPriceMinor: 520,
				},
			]),
		})
		expect(res.status, JSON.stringify(res.body)).toBe(200)
		const text = JSON.stringify(res.body)
		for (const field of [
			'MinorValue',
			'lineTotalMinor',
			'linesTotalMinor',
			'priceChange',
			'currency',
			'totalMinor',
			'vatMinor',
		]) {
			expect(text, field).not.toContain(field)
		}
		expect(res.body.delivery.lineCount).toBe(1)
		// noCost has no purchasing grant: the pack price stays what purchasing set.
		const detail = await call('GET', `${BASE}/suppliers/${s.id}`, {
			token: full,
		})
		expect(detail.body.products[0].priceMinor).toBe(500)
		// The ledger still carries the value for those who may see it.
		const db = await getTenantDb(ORG)
		const moved = await db
			.select()
			.from(invMovements)
			.where(eq(invMovements.itemId, flour.id))
		expect(moved).toHaveLength(1)
		expect(moved[0]).toMatchObject({
			kind: 'delivery',
			quantity: 5_000_000,
			valueMinor: 2600,
		})
		const read = await call(
			'GET',
			`${BASE}/deliveries/${res.body.delivery.id}`,
			{ token: noCost },
		)
		expect(
			deliveryDetailSchema.parse(read.body).lines[0]!.lineTotalMinor,
		).toBeUndefined()
	})

	it('lists newest first with paging and the unpaid filter, marks paid and unpaid with expectedVersion, and totals what is owed', async () => {
		const s = await supplier('Paid supplier')
		const salt = await item('Paid salt')
		const make = (total: number, extra: Record<string, unknown> = {}) =>
			call('POST', `${BASE}/deliveries`, {
				token: full,
				body: delivery(
					s.id,
					[{ itemId: salt.id, quantity: 1_000_000, lineTotalMinor: total }],
					extra,
				),
			})
		const d1 = await make(1000, { vatMinor: 150 })
		const d2 = await make(2000, { totalMinor: 2300, paid: true })
		const d3 = await make(4000)
		const id1 = d1.body.delivery.id
		expect(d2.body.delivery).toMatchObject({ paid: true })

		const page = await call(
			'GET',
			`${BASE}/deliveries?locationId=${LOC}&supplierId=${s.id}&limit=2`,
			{ token: full },
		)
		const parsed = listDeliveriesResultSchema.parse(page.body)
		expect(parsed.deliveries.map((d) => d.id)).toEqual([
			d3.body.delivery.id,
			d2.body.delivery.id,
		])
		const rest = await call(
			'GET',
			`${BASE}/deliveries?locationId=${LOC}&supplierId=${s.id}&limit=2&cursor=${parsed.nextCursor}`,
			{ token: full },
		)
		expect(rest.body.deliveries.map((d: { id: string }) => d.id)).toEqual([id1])
		const unpaid = await call(
			'GET',
			`${BASE}/deliveries?locationId=${LOC}&supplierId=${s.id}&unpaid=true`,
			{ token: full },
		)
		expect(unpaid.body.deliveries).toHaveLength(2)
		const paidFalse = await call(
			'GET',
			`${BASE}/deliveries?locationId=${LOC}&supplierId=${s.id}&unpaid=false`,
			{ token: full },
		)
		expect(paidFalse.body.deliveries).toHaveLength(3)

		const owed = await call('GET', `${BASE}/suppliers`, { token: full })
		const mine = owed.body.suppliers.find((x: { id: string }) => x.id === s.id)
		expect(mine).toMatchObject({ unpaidCount: 2, unpaidMinor: 1150 + 4000 })

		const paid = await call('POST', `${BASE}/deliveries/${id1}/paid`, {
			token: full,
			body: { expectedVersion: 1, paid: true },
		})
		expect(paid.status).toBe(200)
		expect(paid.body).toMatchObject({ paid: true, version: 2 })
		expect(paid.body.paidAt).toEqual(expect.any(Number))
		expect(
			(
				await call('POST', `${BASE}/deliveries/${id1}/paid`, {
					token: full,
					body: { expectedVersion: 1, paid: false },
				})
			).body.code,
		).toBe('stale_version')
		const unmark = await call('POST', `${BASE}/deliveries/${id1}/paid`, {
			token: full,
			body: { expectedVersion: 2, paid: false },
		})
		expect(unmark.body).toMatchObject({ paid: false, paidAt: null })
		const denied = await call('POST', `${BASE}/deliveries/${id1}/paid`, {
			token: noPurchasing,
			body: { expectedVersion: 3, paid: true },
		})
		expect(denied.status).toBe(403)
	})

	it('cancels by reversing movements: stock goes back, history stays, last cost reverts, once', async () => {
		const s = await supplier('Cancel supplier')
		const oil = await item('Cancel oil', 'ml')
		const record = (total: number) =>
			call('POST', `${BASE}/deliveries`, {
				token: full,
				body: delivery(s.id, [
					{ itemId: oil.id, quantity: 2_000_000, lineTotalMinor: total },
				]),
			})
		const a = await record(1000)
		const b = await record(1200)
		const before = await call(
			'GET',
			`${BASE}/items/${oil.id}?locationId=${LOC}`,
			{ token: full },
		)
		expect(before.body.onHand).toBe(4_000_000)
		expect(before.body.cost.lastCostMicro).toBe(600_000)

		const cancelled = await call(
			'POST',
			`${BASE}/deliveries/${b.body.delivery.id}/cancel`,
			{
				token: full,
				body: { expectedVersion: 1, note: 'Wrong invoice' },
			},
		)
		expect(cancelled.status).toBe(200)
		expect(cancelled.body.status).toBe('cancelled')
		const after = await call(
			'GET',
			`${BASE}/items/${oil.id}?locationId=${LOC}`,
			{ token: full },
		)
		expect(after.body.onHand).toBe(2_000_000)
		expect(after.body.cost.lastCostMicro).toBe(500_000)
		const movements = await call(
			'GET',
			`${BASE}/items/${oil.id}/movements?locationId=${LOC}`,
			{ token: full },
		)
		expect(
			movements.body.movements.map((m: { quantity: number }) => m.quantity),
		).toEqual([-2_000_000, 2_000_000, 2_000_000])
		expect(movements.body.movements[0]).toMatchObject({
			kind: 'delivery',
			note: 'Wrong invoice',
			valueMinor: -1200,
		})
		const again = await call(
			'POST',
			`${BASE}/deliveries/${b.body.delivery.id}/cancel`,
			{ token: full, body: { expectedVersion: 2 } },
		)
		expect(again.status).toBe(409)
		const stale = await call(
			'POST',
			`${BASE}/deliveries/${a.body.delivery.id}/cancel`,
			{ token: full, body: { expectedVersion: 9 } },
		)
		expect(stale.body.code).toBe('stale_version')
		const lines = await call(
			'GET',
			`${BASE}/deliveries/${b.body.delivery.id}`,
			{ token: full },
		)
		expect(lines.body.lines).toHaveLength(1)
	})

	it('handles more than 100 lines and more than 100 items in one delivery (chunked)', async () => {
		const bulk = await call('POST', `${BASE}/items/bulk`, {
			token: full,
			body: {
				clientId: cid('bulk'),
				locationId: LOC,
				items: Array.from({ length: 150 }, (_, i) => ({
					name: `Delivery bulk ${i}`,
					category: 'other',
					kind: 'bought',
					baseUnit: 'g',
				})),
			},
		})
		const ids = bulk.body.created.map((entry: { id: string }) => entry.id)
		const res = await call('POST', `${BASE}/deliveries`, {
			token: full,
			body: delivery(
				null,
				ids.map((id: string) => ({
					itemId: id,
					quantity: 1_000_000,
					lineTotalMinor: 100,
				})),
			),
		})
		expect(res.status, JSON.stringify(res.body)).toBe(200)
		expect(res.body.delivery.lineCount).toBe(150)
		expect(res.body.delivery.lines).toHaveLength(150)
		expect(res.body.delivery.supplierId).toBeNull()
		const listed = await call(
			'GET',
			`${BASE}/deliveries?locationId=${LOC}&limit=1`,
			{ token: full },
		)
		expect(listed.body.deliveries[0].lineCount).toBe(150)
	})

	it('refuses an excluded location, another organization, an unknown supplier or item, and reads to a read-only token', async () => {
		const salt = await item('Guard salt')
		const line = { itemId: salt.id, quantity: 1000, lineTotalMinor: 10 }
		const excluded = await call('POST', `${BASE}/deliveries`, {
			token: scoped,
			body: { ...delivery(null, [line]), locationId: 'loc_other_branch' },
		})
		expect(excluded.status).toBe(403)
		expect(excluded.body.code).toBe('location_forbidden')
		const made = await call('POST', `${BASE}/deliveries`, {
			token: full,
			body: delivery(null, [line]),
		})
		const id = made.body.delivery.id
		expect(
			(await call('GET', `${BASE}/deliveries/${id}`, { token: tokenB })).status,
		).toBe(404)
		const noAccess = await mintToken(ORG, { locationIds: ['loc_elsewhere'] })
		const hidden = await call('GET', `${BASE}/deliveries/${id}`, {
			token: noAccess,
		})
		expect(hidden.status).toBe(403)
		expect(
			(
				await call('GET', `${BASE}/deliveries?locationId=${LOC}`, {
					token: noAccess,
				})
			).status,
		).toBe(403)
		expect(
			(
				await call('POST', `${BASE}/deliveries/${id}/cancel`, {
					token: noAccess,
					body: { expectedVersion: 1 },
				})
			).status,
		).toBe(403)
		expect(
			(
				await call('POST', `${BASE}/deliveries`, {
					token: full,
					body: delivery('ghost-supplier', [line]),
				})
			).status,
		).toBe(404)
		expect(
			(
				await call('POST', `${BASE}/deliveries`, {
					token: full,
					body: delivery(null, [{ ...line, itemId: 'ghost-item' }]),
				})
			).status,
		).toBe(404)
		expect(
			(
				await call('POST', `${BASE}/deliveries`, {
					token: readOnly,
					body: delivery(null, [line]),
				})
			).status,
		).toBe(403)
		expect(
			(await call('GET', `${BASE}/deliveries/${id}`, { token: readOnly }))
				.status,
		).toBe(200)
	})
})
