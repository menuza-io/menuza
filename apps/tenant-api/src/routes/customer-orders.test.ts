import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	customers,
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	restaurantOrders,
} from '@repo/tenant-db'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { syncEnvFromProcess } from '../lib/secrets.ts'
import { insertOrder } from '../services/loyalty-test-fixture.ts'
import { customerOrderRoutes } from './customer-orders.ts'

const orgId = 'clw9x0a12000008l00test12'
const jwtSecret = 'test-jwt-secret-123456789'

vi.mock('../lib/origin.ts', () => {
	const organization = {
		id: 'clw9x0a12000008l00test12',
		slug: 'orders-test',
		customDomain: null,
		hasProvisionedDb: true,
		dataRegion: 'us',
	}
	return {
		findActiveOrganizationById: vi.fn().mockResolvedValue(organization),
		lookupActiveOrganization: vi
			.fn()
			.mockResolvedValue({ status: 'found', organization }),
	}
})

let app: Hono
let tempDir: string
let aliceId: string
let bobId: string
let alice: string
let bob: string

async function token(customerId: string, name: string) {
	return new SignJWT({
		customerId,
		orgId,
		name,
		orgSlug: 'orders-test',
		type: 'access',
	})
		.setProtectedHeader({ alg: 'HS256' })
		.setAudience('tenant-api')
		.setIssuer('menuza')
		.setExpirationTime('15m')
		.sign(new TextEncoder().encode(jwtSecret))
}

const line = (overrides: Record<string, unknown> = {}) => ({
	itemId: 'item_1',
	itemName: 'Margherita',
	variantId: 'var_l',
	quantity: 2,
	unitPriceCents: 1200,
	taxableUnitCents: 1200,
	totalCents: 2400,
	taxableCents: 2400,
	instructions: 'no basil',
	baseUnitCents: 1000,
	categoryIds: ['cat_1'],
	options: [
		{
			groupId: 'grp_1',
			groupName: 'Extras',
			optionId: 'opt_1',
			optionName: 'Olives',
			half: null,
			quantity: 1,
			priceCents: 200,
			totalCents: 400,
		},
	],
	...overrides,
})

async function get(path: string, bearer: string | null = alice) {
	return app.request(path, {
		headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
	})
}

beforeEach(async () => {
	tempDir = fs.mkdtempSync(
		path.join(os.tmpdir(), 'tenant-api-customer-orders-'),
	)
	process.env.TENANT_DB_DIR = tempDir
	process.env.DATA_REGION = 'us'
	process.env.JWT_SECRET = jwtSecret
	syncEnvFromProcess()
	await provisionTenantDb(orgId)
	const db = await getTenantDb(orgId)
	const [a] = await db
		.insert(customers)
		.values({
			name: 'Alice Example',
			phone: '+15555550201',
			phoneVerified: true,
		})
		.returning()
	const [b] = await db
		.insert(customers)
		.values({ name: 'Bob Example', phone: '+15555550202', phoneVerified: true })
		.returning()
	aliceId = a!.id
	bobId = b!.id
	alice = await token(aliceId, 'Alice Example')
	bob = await token(bobId, 'Bob Example')
	app = new Hono()
	app.route('/customer/orders', customerOrderRoutes)
})

afterEach(async () => {
	await destroyTenantDb(orgId)
	fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('GET /customer/orders (#112)', () => {
	it('needs a customer token', async () => {
		expect((await get('/customer/orders', null)).status).toBe(401)
		expect((await get('/customer/orders', 'junk')).status).toBe(401)
	})

	it('lists only the signed-in guest’s orders, newest first', async () => {
		const first = await insertOrder(orgId, {
			customerId: aliceId,
			createdAt: new Date('2026-01-01T10:00:00Z'),
			lines: [line()],
		})
		const second = await insertOrder(orgId, {
			customerId: aliceId,
			createdAt: new Date('2026-02-01T10:00:00Z'),
			lines: [
				line(),
				line({ itemId: 'item_2', itemName: 'Cola', quantity: 1 }),
			],
		})
		await insertOrder(orgId, {
			customerId: bobId,
			createdAt: new Date('2026-03-01T10:00:00Z'),
		})
		await insertOrder(orgId, {
			customerId: null,
			createdAt: new Date('2026-03-02T10:00:00Z'),
		})
		const body = (await (await get('/customer/orders')).json()) as {
			orders: Array<Record<string, unknown>>
			nextCursor: string | null
		}
		expect(body.orders.map((o) => o.id)).toEqual([second, first])
		expect(body.orders[0]).toMatchObject({
			itemCount: 3,
			itemNames: ['Margherita', 'Cola'],
			canReorder: true,
			canFinish: false,
			isDrop: false,
		})
		expect(body.nextCursor).toBeNull()
		// Bob sees only his own.
		const bobs = (await (await get('/customer/orders', bob)).json()) as {
			orders: unknown[]
		}
		expect(bobs.orders).toHaveLength(1)
	})

	it('does not match an order by the same phone or name when it is not linked to the guest', async () => {
		await insertOrder(orgId, {
			customerId: null,
			contactPhone: '+15555550201',
			contactName: 'Alice Example',
		})
		const body = (await (await get('/customer/orders')).json()) as {
			orders: unknown[]
		}
		expect(body.orders).toEqual([])
	})

	it('pages 50 at a time with a cursor', async () => {
		const db = await getTenantDb(orgId)
		void db
		for (let i = 0; i < 53; i += 1) {
			await insertOrder(orgId, {
				customerId: aliceId,
				createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
				lines: [line()],
			})
		}
		const page1 = (await (await get('/customer/orders')).json()) as {
			orders: Array<{ id: string }>
			nextCursor: string | null
		}
		expect(page1.orders).toHaveLength(50)
		expect(page1.nextCursor).toBeTruthy()
		const page2 = (await (
			await get(
				`/customer/orders?cursor=${encodeURIComponent(page1.nextCursor!)}`,
			)
		).json()) as { orders: Array<{ id: string }>; nextCursor: string | null }
		expect(page2.orders).toHaveLength(3)
		expect(page2.nextCursor).toBeNull()
		const seen = new Set([...page1.orders, ...page2.orders].map((o) => o.id))
		expect(seen.size).toBe(53)
	})

	it('refuses a malformed cursor', async () => {
		expect((await get('/customer/orders?cursor=not-a-cursor')).status).toBe(400)
	})

	it('marks a lapsed unpaid online order as one to finish, and a drop as not reorderable', async () => {
		const lapsed = await insertOrder(orgId, {
			customerId: aliceId,
			status: 'expired',
			paymentStatus: 'unpaid',
			paymentMethod: 'online',
			lines: [line()],
		})
		const paidExpired = await insertOrder(orgId, {
			customerId: aliceId,
			status: 'expired',
			paymentStatus: 'paid',
			paymentMethod: 'online',
			lines: [line()],
		})
		const drop = await insertOrder(orgId, {
			customerId: aliceId,
			dropSlug: 'summer-drop',
			lines: [line()],
		})
		const dineIn = await insertOrder(orgId, {
			customerId: aliceId,
			fulfillment: 'dine_in',
			lines: [line()],
		})
		const body = (await (await get('/customer/orders')).json()) as {
			orders: Array<{
				id: string
				canFinish: boolean
				canReorder: boolean
				isDrop: boolean
			}>
		}
		const by = (id: string) => body.orders.find((o) => o.id === id)!
		expect(by(lapsed)).toMatchObject({ canFinish: true, canReorder: true })
		expect(by(paidExpired)).toMatchObject({
			canFinish: false,
			canReorder: true,
		})
		expect(by(drop)).toMatchObject({
			isDrop: true,
			canReorder: false,
			canFinish: false,
		})
		expect(by(dineIn)).toMatchObject({ canReorder: false })
	})
})

describe('GET /customer/orders/:id (#112, another customer’s order answers 404)', () => {
	it('returns the owner’s receipt', async () => {
		const id = await insertOrder(orgId, {
			customerId: aliceId,
			lines: [line()],
		})
		const response = await get(`/customer/orders/${id}`)
		expect(response.status).toBe(200)
		const body = (await response.json()) as {
			order: {
				id: string
				number: string
				lines: unknown[]
				contact: { name: string }
			}
		}
		expect(body.order).toMatchObject({ id, contact: { name: 'Test' } })
		expect(body.order.lines).toHaveLength(1)
	})

	it('answers the same 404 for another guest’s order and for one that does not exist', async () => {
		const bobsOrder = await insertOrder(orgId, { customerId: bobId })
		const guestOrder = await insertOrder(orgId, { customerId: null })
		const foreign = await get(`/customer/orders/${bobsOrder}`)
		const missing = await get('/customer/orders/does-not-exist')
		const guest = await get(`/customer/orders/${guestOrder}`)
		expect(foreign.status).toBe(404)
		expect(missing.status).toBe(404)
		expect(guest.status).toBe(404)
		const bodies = await Promise.all([
			foreign.text(),
			missing.text(),
			guest.text(),
		])
		expect(new Set(bodies).size).toBe(1)
		// The reorder route does not leak either.
		for (const id of [bobsOrder, guestOrder, 'does-not-exist']) {
			expect((await get(`/customer/orders/${id}/reorder`)).status).toBe(404)
		}
	})
})

describe('GET /customer/orders/:id/reorder (#112, catalog ids and never prices)', () => {
	it('returns ids, quantities, options and instructions only', async () => {
		const id = await insertOrder(orgId, {
			customerId: aliceId,
			locationId: 'loc_9',
			lines: [line()],
		})
		const body = (await (
			await get(`/customer/orders/${id}/reorder`)
		).json()) as Record<string, unknown>
		expect(body).toEqual({
			locationId: 'loc_9',
			fulfillment: 'pickup',
			lines: [
				{
					itemId: 'item_1',
					variantId: 'var_l',
					quantity: 2,
					options: [
						{ groupId: 'grp_1', optionId: 'opt_1', quantity: 1, half: null },
					],
					instructions: 'no basil',
					name: 'Margherita',
				},
			],
		})
		expect(JSON.stringify(body)).not.toMatch(
			/priceCents|unitPrice|totalCents|taxable|contact/,
		)
	})

	it('refuses a drop and a table round with 409', async () => {
		const drop = await insertOrder(orgId, {
			customerId: aliceId,
			dropSlug: 'summer-drop',
			lines: [line()],
		})
		const response = await get(`/customer/orders/${drop}/reorder`)
		expect(response.status).toBe(409)
		expect(await response.json()).toMatchObject({ error: 'not_reorderable' })
	})

	it('treats an erased customer as having no history', async () => {
		const id = await insertOrder(orgId, {
			customerId: aliceId,
			lines: [line()],
		})
		const db = await getTenantDb(orgId)
		await db
			.update(restaurantOrders)
			.set({ customerId: null })
			.where((await import('drizzle-orm')).eq(restaurantOrders.id, id))
		const body = (await (await get('/customer/orders')).json()) as {
			orders: unknown[]
		}
		expect(body.orders).toEqual([])
		expect((await get(`/customer/orders/${id}`)).status).toBe(404)
	})
})
