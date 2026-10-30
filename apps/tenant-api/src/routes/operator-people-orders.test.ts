import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import {
	customers,
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	restaurantOrders,
	rsvGuests,
} from '@repo/tenant-db'
import { Hono } from 'hono'
import * as jose from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type PublishedOrganization } from '../lib/origin.ts'
import { operatorOrderRoutes } from './operator-orders.ts'
import { operatorPeopleRoutes } from './operator-people.ts'

const SECRET = 'test-operator-secret-key-for-people-orders-32!!'
const ORG = 'org_pord_a'
const ORG_B = 'org_pord_b'

const orgs = vi.hoisted(() => new Map<string, PublishedOrganization>())
vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	findActiveOrganizationById: vi.fn(async (id: string) => orgs.get(id) ?? null),
}))

let tempDir: string
const app = new Hono()
app.route('/operator/people', operatorPeopleRoutes)
app.route('/operator/orders', operatorOrderRoutes)

type Claims = Record<string, unknown>
const CUSTOMERS: Claims = { scope: 'people', peopleCustomers: true }
const HOST: Claims = { scope: 'people', peopleDining: 'flags' }

async function token(claims: Claims, orgId = ORG) {
	const now = Math.floor(Date.now() / 1000)
	return new jose.SignJWT({ role: 'operator', orgId, ...claims })
		.setProtectedHeader({ alg: 'HS256' })
		.setSubject('usr_1')
		.setIssuer(brand.shortName)
		.setAudience('tenant-api-operator')
		.setIssuedAt(now)
		.setExpirationTime(now + 300)
		.sign(new TextEncoder().encode(SECRET))
}

const get = async (url: string, claims: Claims, orgId = ORG) =>
	app.request(url, {
		headers: { Authorization: `Bearer ${await token(claims, orgId)}` },
	})

let seq = 0
function order(
	over: Partial<typeof restaurantOrders.$inferInsert> & { at: number },
) {
	seq += 1
	const { at, ...rest } = over
	return {
		id: `ord_${seq}`,
		orgId: ORG,
		number: `A-${seq}`,
		customerId: null,
		paymentMethod: 'handoff',
		paymentStatus: 'paid',
		status: 'completed',
		fulfillment: 'pickup',
		locationId: 'loc',
		locationName: 'Downtown',
		contactName: 'Someone',
		contactPhone: '+14155559999',
		currency: 'usd',
		subtotalCents: 1000,
		taxCents: 0,
		totalCents: 1000,
		lines: [{ quantity: 2 }, { quantity: 1 }],
		idempotencyKey: `idem_${seq}`,
		requestHash: `hash_${seq}`,
		receiptTokenHash: `rcpt_${seq}`,
		createdAt: new Date(at * 1000),
		...rest,
	} as typeof restaurantOrders.$inferInsert
}

beforeEach(async () => {
	seq = 0
	tempDir = mkdtempSync(path.join(tmpdir(), 'op-people-orders-'))
	process.env.TENANT_DB_DIR = tempDir
	process.env.DATA_REGION = 'us'
	process.env.TENANT_OPERATOR_TOKEN = SECRET
	for (const id of [ORG, ORG_B]) {
		orgs.set(id, {
			id,
			slug: id,
			customDomain: null,
			hasProvisionedDb: true,
			dataRegion: 'us',
		} as PublishedOrganization)
		await provisionTenantDb(id)
	}
	const db = await getTenantDb(ORG)
	await db.insert(customers).values([
		{ id: 'cus_v', name: 'Vera', phone: '+14155550101', phoneVerified: true },
		{ id: 'cus_u', name: 'Una', phone: '+14155550109', phoneVerified: false },
		{ id: 'cus_o', name: 'Other', phone: '+14155550102', phoneVerified: true },
	])
	await db.insert(rsvGuests).values({
		id: 'gst_phone',
		firstName: 'Gus',
		lastName: 'Guest',
		phoneE164: '+14155550177',
	})
	const base = 1_700_000_000
	await db.insert(restaurantOrders).values([
		// Vera: bound, two bound in the same second (tie-break), one by phone.
		order({
			customerId: 'cus_v',
			at: base + 10,
			totalCents: 2000,
			refundedCents: 500,
		}),
		order({ customerId: 'cus_v', at: base + 10, totalCents: 500 }),
		order({
			customerId: 'cus_v',
			at: base + 5,
			status: 'cancelled',
			totalCents: 9999,
		}),
		order({ at: base, contactPhone: '+14155550101', totalCents: 700 }),
		// Never Vera's: another customer's order that carries Vera's phone, and
		// unrelated guest checkouts.
		order({
			customerId: 'cus_o',
			at: base + 20,
			contactPhone: '+14155550101',
		}),
		order({ at: base + 30, contactPhone: '+14155550999' }),
		// Unverified customer: same phone on a guest order must not link.
		order({ at: base + 40, contactPhone: '+14155550109' }),
		order({ at: base + 50, contactPhone: '+14155550177' }),
	])
})

afterEach(async () => {
	for (const id of [ORG, ORG_B]) await destroyTenantDb(id)
	rmSync(tempDir, { recursive: true, force: true })
})

type OrdersBody = {
	orders: Array<{
		id: string
		matchedBy: string
		itemCount: number
		refundedCents: number
	}>
	nextCursor: string | null
	totals: { count: number; spend: Array<{ currency: string; cents: number }> }
}

describe('GET /operator/people/:key/orders', () => {
	it('lists bound and verified-phone orders, newest first, never another customer', async () => {
		const res = await get('/operator/people/c_cus_v/orders', CUSTOMERS)
		expect(res.status).toBe(200)
		const body = (await res.json()) as OrdersBody
		expect(body.orders.map((o) => o.id)).toEqual([
			'ord_2',
			'ord_1',
			'ord_3',
			'ord_4',
		])
		expect(body.orders.map((o) => o.matchedBy)).toEqual([
			'customer',
			'customer',
			'customer',
			'phone',
		])
		expect(body.orders[0]!.itemCount).toBe(3)
		// What came back stays visible; the payment status stays `paid`.
		expect(body.orders.map((o) => o.refundedCents)).toEqual([0, 500, 0, 0])
		expect(body.nextCursor).toBeNull()
		expect(body.totals.count).toBe(4)
		// 2000 + 500 + 700; the cancelled order is not spend.
		expect(body.totals.spend).toEqual([{ currency: 'usd', cents: 3200 }])
	})

	it('does not match by phone when the customer phone is unverified', async () => {
		const res = await get('/operator/people/c_cus_u/orders', CUSTOMERS)
		const body = (await res.json()) as OrdersBody
		expect(body.orders).toEqual([])
		expect(body.totals.count).toBe(0)
	})

	it('pages by keyset without gaps or repeats', async () => {
		const seen: string[] = []
		let cursor: string | null = null
		for (let i = 0; i < 4; i++) {
			const q: string = cursor ? `&cursor=${cursor}` : ''
			const res = await get(
				`/operator/people/c_cus_v/orders?limit=1${q}`,
				CUSTOMERS,
			)
			const body = (await res.json()) as OrdersBody
			seen.push(...body.orders.map((o) => o.id))
			cursor = body.nextCursor
			if (!cursor) break
		}
		expect(seen).toEqual(['ord_2', 'ord_1', 'ord_3', 'ord_4'])
		expect(cursor).toBeNull()
	})

	it('rejects a malformed cursor and unknown keys', async () => {
		expect(
			(await get('/operator/people/c_cus_v/orders?cursor=%%%', CUSTOMERS))
				.status,
		).toBe(400)
		expect(
			(await get('/operator/people/c_nobody/orders', CUSTOMERS)).status,
		).toBe(404)
		expect((await get('/operator/people/zzz/orders', CUSTOMERS)).status).toBe(
			404,
		)
	})

	it('refuses a host-only token (no customers claim)', async () => {
		expect((await get('/operator/people/c_cus_v/orders', HOST)).status).toBe(
			403,
		)
		expect(
			(await get('/operator/people/g_gst_phone/orders', HOST)).status,
		).toBe(403)
	})

	it('does not cross organizations', async () => {
		const res = await get('/operator/people/c_cus_v/orders', CUSTOMERS, ORG_B)
		expect(res.status).toBe(404)
	})
})

describe('customerKey on operator orders', () => {
	const ordersToken = (extra: Claims = {}) => ({
		scope: 'orders:read',
		...extra,
	})

	type Listed = {
		orders: Array<{
			id: string
			customerKey: string | null
			customerId: string | null
		}>
	}
	async function listed(extra: Claims) {
		const res = await get('/operator/orders', ordersToken(extra))
		expect(res.status).toBe(200)
		const body = (await res.json()) as Listed
		return new Map(body.orders.map((o) => [o.id, o.customerKey]))
	}

	it('is null for every order when the token carries no link claim', async () => {
		const keys = await listed({})
		expect([...keys.values()].every((k) => k === null)).toBe(true)
	})

	it('links by customer id, then by verified phone, never by unverified phone', async () => {
		const keys = await listed({ linkCustomers: true })
		expect(keys.get('ord_1')).toBe('c_cus_v')
		expect(keys.get('ord_4')).toBe('c_cus_v') // verified phone, no customer_id
		expect(keys.get('ord_5')).toBe('c_cus_o') // bound customer wins over phone
		expect(keys.get('ord_6')).toBeNull() // guest checkout
		expect(keys.get('ord_7')).toBeNull() // unverified customer phone
		expect(keys.get('ord_8')).toBeNull() // guest phone, no guest claim
	})

	it('links a guest by phone only with the guest claim', async () => {
		const keys = await listed({ linkCustomers: true, linkGuests: true })
		expect(keys.get('ord_8')).toBe('g_gst_phone')
		expect(keys.get('ord_6')).toBeNull()
		const guestsOnly = await listed({ linkGuests: true })
		expect(guestsOnly.get('ord_8')).toBe('g_gst_phone')
		expect(guestsOnly.get('ord_1')).toBeNull()
		expect(guestsOnly.get('ord_4')).toBeNull()
	})

	it('adds the key to the order detail too', async () => {
		const res = await get(
			'/operator/orders/ord_4',
			ordersToken({ linkCustomers: true }),
		)
		const body = (await res.json()) as { order: { customerKey: string | null } }
		expect(body.order.customerKey).toBe('c_cus_v')
	})
})
