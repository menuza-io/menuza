import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import {
	customers,
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	restaurantOrders,
	restaurantOrderReservations,
} from '@repo/tenant-db'
import { restaurantOrderRequestSchema } from '@repo/common/restaurant-orders'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
	findActiveOrganizationById,
	resolveOrganizationForBrowserAuth,
} from '../lib/origin.ts'
import {
	applyPaymentEvent,
	bindPaymentSession,
	getOrderQuote,
	placeOrder,
} from '../services/order-service.ts'
import { publicOrderRoutes } from './orders.ts'

vi.mock('../lib/origin.ts', () => ({
	findActiveOrganizationById: vi.fn(),
	resolveOrganizationForBrowserAuth: vi.fn(),
	resolvePublishedOrganization: vi.fn(async () => null),
}))

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const orgId = 'org_orders_adversarial_1'
const internalToken = 'test-internal-token-very-long-and-secure-12345'
const operatorToken = 'test-operator-token-very-long-and-secure-12345'
const jwtSecret = 'test-jwt-secret-123456789'
const hmacSecret = 'test-hmac-secret-123456789'

const ORG = {
	id: orgId,
	slug: 'test-org',
	customDomain: null,
	hasProvisionedDb: true,
	dataRegion: 'us',
}

const ALL_DAYS = [
	'sunday',
	'monday',
	'tuesday',
	'wednesday',
	'thursday',
	'friday',
	'saturday',
].map((day) => ({
	day,
	isOpen: true,
	slots: [{ start: '00:00', end: '23:59' }],
}))

const burger = {
	id: 'item-burger',
	displayName: 'Burger',
	price: 10,
	availabilityStatus: 'available',
	modifierGroups: [
		{
			id: 'grp-size',
			name: 'Size',
			selectionType: 'single',
			minSelections: 1,
			availabilityStatus: 'available',
			options: [
				{
					id: 'opt-reg',
					displayName: 'Regular',
					price: 0,
					availabilityStatus: 'available',
				},
				{
					id: 'opt-large',
					displayName: 'Large',
					price: 3,
					availabilityStatus: 'available',
				},
			],
		},
		{
			id: 'grp-toppings',
			name: 'Toppings',
			selectionType: 'multiple',
			minSelections: 0,
			maxSelections: 2,
			availabilityStatus: 'available',
			options: [
				{
					id: 'opt-cheese',
					displayName: 'Cheese',
					price: 1,
					availabilityStatus: 'available',
				},
				{
					id: 'opt-bacon',
					displayName: 'Bacon',
					price: 2,
					applySalesTax: false,
					availabilityStatus: 'available',
				},
			],
		},
	],
}

const brisket = {
	id: 'item-brisket',
	displayName: 'Brisket Plate',
	price: 18,
	availabilityStatus: 'available',
}
const ribs = {
	id: 'item-ribs',
	displayName: 'Ribs',
	price: 15,
	availabilityStatus: 'available',
}

function menuContext() {
	return {
		orgId,
		dataRegion: 'us',
		menu: {
			organization: { id: orgId, slug: 'test-org', currency: 'USD' },
			locations: [
				{
					id: 'loc-1',
					name: 'Main Street',
					timezone: 'UTC',
					taxRate: 8.25,
					prepTime: 15,
					currency: 'USD',
					fulfillmentOptions: {
						pickup: true,
						delivery: true,
						dineIn: true,
						curbside: false,
					},
					inHouseTips: {
						pickupTips: true,
						deliveryTips: true,
						dineInTips: true,
					},
					onlineHours: ALL_DAYS,
				},
			],
			menus: [
				{
					id: 'menu-1',
					displayName: 'Main',
					menuType: 'regular',
					specialInstructions: true,
					availabilityStatus: 'available',
					categories: [
						{
							id: 'cat-food',
							displayName: 'Food',
							availabilityStatus: 'available',
							items: [burger],
						},
					],
				},
			],
			locationOverrides: {},
		},
		drop: null,
		onlinePayment: { enabled: true, processor: 'connect' },
	}
}

function dropContext(
	inventoryOverrides: Record<string, unknown>[] = [
		{
			entityType: 'item',
			entityId: 'item-brisket',
			inventory: 5,
			maxPerOrder: 3,
		},
	],
	maxOrdersPerSlot: number | null = null,
) {
	const base = menuContext()
	return {
		...base,
		drop: {
			organization: { id: orgId, slug: 'test-org', currency: 'USD' },
			drop: {
				id: 'drop-1',
				title: 'Friday BBQ',
				slug: 'friday-bbq',
				status: 'live',
				checkoutHoldMinutes: 10,
				menu: {
					id: 'menu-drop',
					displayName: 'BBQ',
					specialInstructions: true,
				},
			},
			pickupWindows: [
				{
					id: 'win-1',
					locationId: 'loc-1',
					location: { id: 'loc-1', name: 'Main Street', timezone: 'UTC' },
					date: '2099-06-20',
					startTime: '17:00',
					endTime: '19:00',
					slotIntervalMinutes: 30,
					maxOrdersPerSlot,
					orderLeadTimeMinutes: 0,
					slots: [],
				},
			],
			inventoryOverrides,
			categories: [
				{
					id: 'cat-bbq',
					displayName: 'BBQ',
					availabilityStatus: 'available',
					items: [brisket, ribs],
				},
			],
		},
	}
}

function orderBody(overrides: Record<string, unknown> = {}) {
	return {
		slug: 'test-org',
		idempotencyKey: crypto.randomUUID(),
		locale: 'en',
		locationId: 'loc-1',
		fulfillment: 'pickup',
		paymentMethod: 'handoff',
		contact: { name: 'Rana Khalid', phone: '+1 555 123 4567' },
		tipPercent: 0,
		lines: [
			{
				itemId: 'item-burger',
				quantity: 2,
				options: [{ groupId: 'grp-size', optionId: 'opt-reg' }],
			},
		],
		...overrides,
	}
}

function dropOrderBody(overrides: Record<string, unknown> = {}) {
	return orderBody({
		dropSlug: 'friday-bbq',
		pickup: { windowId: 'win-1', time: '17:30' },
		lines: [{ itemId: 'item-brisket', quantity: 1, options: [] }],
		...overrides,
	})
}

describe('Adversarial: restaurant ordering (public browser surface)', () => {
	let directory: string
	let app: Hono
	let activeContext: unknown
	let fetchMock: ReturnType<typeof vi.fn>

	async function postOrder(
		body: unknown,
		headers: Record<string, string> = {},
	) {
		return app.request('/orders', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				origin: 'https://test-org.example.com',
				...headers,
			},
			body: JSON.stringify(body),
		})
	}

	async function mintCustomerJwt(customerId = 'cust_1', tokenOrgId = orgId) {
		return new SignJWT({
			customerId,
			orgId: tokenOrgId,
			orgSlug: 'test-org',
			type: 'access',
		})
			.setProtectedHeader({ alg: 'HS256' })
			.setIssuer(brand.slug)
			.setAudience('tenant-api')
			.setExpirationTime('1h')
			.sign(new TextEncoder().encode(jwtSecret))
	}

	beforeEach(async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orders-adversarial-'))
		vi.stubEnv('TENANT_DB_DIR', directory)
		vi.stubEnv('DATA_REGION', 'us')
		vi.stubEnv('INTERNAL_COMMAND_TOKEN', internalToken)
		vi.stubEnv('TENANT_OPERATOR_TOKEN', operatorToken)
		vi.stubEnv('JWT_SECRET', jwtSecret)
		vi.stubEnv('AUTH_HMAC_SECRET', hmacSecret)
		vi.stubEnv('APP_URL', 'https://app.test')

		activeContext = menuContext()
		fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = typeof input === 'string' ? input : input.toString()
			if (url.includes('/resources/order-context')) {
				return new Response(JSON.stringify(activeContext), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				})
			}
			return new Response('not found', { status: 404 })
		})
		vi.stubGlobal('fetch', fetchMock)

		vi.mocked(resolveOrganizationForBrowserAuth).mockImplementation(
			async (_origin, identity) =>
				identity?.slug === 'test-org' ? (ORG as never) : null,
		)
		vi.mocked(findActiveOrganizationById).mockImplementation(async (id) =>
			id === orgId ? (ORG as never) : null,
		)

		await provisionTenantDb(orgId)
		app = new Hono()
		app.route('/orders', publicOrderRoutes)
	})

	afterEach(async () => {
		try {
			await destroyTenantDb(orgId)
			fs.rmSync(directory, { recursive: true, force: true })
		} catch {}
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
		vi.clearAllMocks()
	})

	// -----------------------------------------------------------------------
	// Placement + server-side repricing
	// -----------------------------------------------------------------------

	it('places a handoff order repriced entirely server-side and persists it durably', async () => {
		const response = await postOrder(
			orderBody({
				tipPercent: 10,
				lines: [
					{
						itemId: 'item-burger',
						quantity: 2,
						options: [
							{ groupId: 'grp-size', optionId: 'opt-reg' },
							{ groupId: 'grp-toppings', optionId: 'opt-cheese' },
						],
					},
				],
			}),
		)
		expect(response.status).toBe(201)
		expect(response.headers.get('cache-control')).toBe('no-store')
		const body = await response.json()
		expect(body.order.subtotalCents).toBe(2200)
		expect(body.order.taxCents).toBe(182)
		expect(body.order.tipCents).toBe(220)
		expect(body.order.totalCents).toBe(2602)
		expect(body.order.status).toBe('accepted')
		expect(body.order.paymentStatus).toBe('unpaid')
		expect(body.order.holdExpiresAt).toBeNull()
		expect(typeof body.receiptToken).toBe('string')
		expect(body.receiptToken.length).toBeGreaterThanOrEqual(32)
		expect(body.paymentToken).toBeUndefined()
		// Never echo PII in the placement response
		expect(JSON.stringify(body)).not.toContain('5551234567')

		const db = await getTenantDb(orgId)
		const rows = await db
			.select()
			.from(restaurantOrders)
			.where(eq(restaurantOrders.id, body.order.id))
		expect(rows).toHaveLength(1)
		expect(rows[0]!.orgId).toBe(orgId)
		expect(rows[0]!.contactName).toBe('Rana Khalid')
		expect(rows[0]!.contactPhone).toBe('+15551234567')
		expect(rows[0]!.number).toMatch(/^\d{8}-\d{4}$/)
		expect(Array.isArray(rows[0]!.lines)).toBe(true)
		// Only hashes of the capability tokens are stored
		expect(rows[0]!.receiptTokenHash).toMatch(/^[a-f0-9]{64}$/)
		expect(rows[0]!.receiptTokenHash).not.toBe(body.receiptToken)
	})

	it('authenticates the catalog context fetch with the internal command token', async () => {
		const response = await postOrder(orderBody())
		expect(response.status).toBe(201)
		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect((init.headers as Record<string, string>).Authorization).toBe(
			`Bearer ${internalToken}`,
		)
		expect(fetchMock.mock.calls[0]![0]).toContain(
			'https://app.test/resources/order-context',
		)
	})

	it('rejects browser-supplied prices and totals (strict schema)', async () => {
		const withLinePrice = await postOrder(
			orderBody({
				lines: [
					{ itemId: 'item-burger', quantity: 1, price: 0.01, options: [] },
				],
			}),
		)
		expect(withLinePrice.status).toBe(400)

		const withTotals = await postOrder(
			orderBody({ subtotalCents: 1, totalCents: 1 }),
		)
		expect(withTotals.status).toBe(400)

		const withCustomerId = await postOrder(
			orderBody({ customerId: 'cust_evil' }),
		)
		expect(withCustomerId.status).toBe(400)
	})

	it('rejects orders for unknown or wrong-region organizations', async () => {
		const unknown = await postOrder(orderBody({ slug: 'other-org' }))
		expect(unknown.status).toBe(404)

		vi.mocked(resolveOrganizationForBrowserAuth).mockImplementation(
			async () => ({ ...ORG, dataRegion: 'ksa' }) as never,
		)
		const wrongRegion = await postOrder(orderBody())
		expect(wrongRegion.status).toBe(404)

		vi.mocked(resolveOrganizationForBrowserAuth).mockImplementation(
			async () => ({ ...ORG, hasProvisionedDb: false }) as never,
		)
		const notProvisioned = await postOrder(orderBody())
		expect(notProvisioned.status).toBe(404)
	})

	it('fails closed when the App context fetch fails or returns mismatched org data', async () => {
		fetchMock.mockImplementation(
			async () => new Response('boom', { status: 500 }),
		)
		const failed = await postOrder(orderBody())
		expect(failed.status).toBe(503)

		activeContext = { ...menuContext(), orgId: 'org_someone_else' }
		const mismatched = await postOrder(orderBody())
		expect(mismatched.status).toBe(503)
	})

	it('never trusts browser totals: repricing uses catalog data even if the client computed differently', async () => {
		// 2 large burgers with cheese: catalog says (10 + 3 + 1) * 2 = 2800
		const response = await postOrder(
			orderBody({
				lines: [
					{
						itemId: 'item-burger',
						quantity: 2,
						options: [
							{ groupId: 'grp-size', optionId: 'opt-large' },
							{ groupId: 'grp-toppings', optionId: 'opt-cheese' },
						],
					},
				],
			}),
		)
		expect(response.status).toBe(201)
		const body = await response.json()
		expect(body.order.subtotalCents).toBe(2800)
	})

	// -----------------------------------------------------------------------
	// Idempotency
	// -----------------------------------------------------------------------

	it('replays the same checkout attempt with the same receipt capability', async () => {
		const key = crypto.randomUUID()
		const first = await postOrder(orderBody({ idempotencyKey: key }))
		expect(first.status).toBe(201)
		const firstBody = await first.json()

		const retry = await postOrder(orderBody({ idempotencyKey: key }))
		expect(retry.status).toBe(200)
		const retryBody = await retry.json()
		expect(retryBody.order.id).toBe(firstBody.order.id)
		expect(retryBody.receiptToken).toBe(firstBody.receiptToken)

		const db = await getTenantDb(orgId)
		const rows = await db.select().from(restaurantOrders)
		expect(rows).toHaveLength(1)
	})

	it('rejects an idempotency key reused with a different payload (409)', async () => {
		const key = crypto.randomUUID()
		const first = await postOrder(orderBody({ idempotencyKey: key }))
		expect(first.status).toBe(201)

		const conflict = await postOrder(
			orderBody({ idempotencyKey: key, tipPercent: 15 }),
		)
		expect(conflict.status).toBe(409)
		const body = await conflict.json()
		expect(body.error).toBe('idempotency_conflict')

		const db = await getTenantDb(orgId)
		expect(await db.select().from(restaurantOrders)).toHaveLength(1)
	})

	// -----------------------------------------------------------------------
	// Receipt capability
	// -----------------------------------------------------------------------

	it('serves the receipt only with the secret receipt token', async () => {
		const placed = await postOrder(orderBody())
		const placedBody = await placed.json()
		const orderId = placedBody.order.id as string

		const missing = await app.request(`/orders/${orderId}?slug=test-org`)
		expect(missing.status).toBe(401)

		const wrong = await app.request(`/orders/${orderId}?slug=test-org`, {
			headers: { Authorization: 'Bearer wrong-token' },
		})
		expect(wrong.status).toBe(403)

		const ok = await app.request(`/orders/${orderId}?slug=test-org`, {
			headers: { Authorization: `Bearer ${placedBody.receiptToken}` },
		})
		expect(ok.status).toBe(200)
		expect(ok.headers.get('cache-control')).toBe('no-store')
		const receipt = await ok.json()
		expect(receipt.order.contact.phone).toBe('+15551234567')
		expect(receipt.order.contact.name).toBe('Rana Khalid')
		expect(receipt.order.lines).toHaveLength(1)
		expect(receipt.order.lines[0].unitPriceCents).toBe(1000)
	})

	it('a customer access token is not a receipt capability', async () => {
		const placed = await postOrder(orderBody())
		const placedBody = await placed.json()
		const customerJwt = await mintCustomerJwt()

		const response = await app.request(
			`/orders/${placedBody.order.id}?slug=test-org`,
			{ headers: { Authorization: `Bearer ${customerJwt}` } },
		)
		expect(response.status).toBe(403)
	})

	it('a receipt token for one order does not open another order', async () => {
		const first = await (await postOrder(orderBody())).json()
		const second = await (await postOrder(orderBody())).json()
		const response = await app.request(
			`/orders/${second.order.id}?slug=test-org`,
			{ headers: { Authorization: `Bearer ${first.receiptToken}` } },
		)
		expect(response.status).toBe(403)
	})

	// -----------------------------------------------------------------------
	// Optional customer binding
	// -----------------------------------------------------------------------

	it('binds the authenticated customer and rejects cross-org customer tokens', async () => {
		const db = await getTenantDb(orgId)
		await db.insert(customers).values({
			id: 'cust_42',
			name: 'Rana Khalid',
			phone: '+15551234567',
		})
		const customerJwt = await mintCustomerJwt('cust_42')
		const bound = await postOrder(orderBody(), {
			authorization: `Bearer ${customerJwt}`,
		})
		expect(bound.status).toBe(201)
		const boundBody = await bound.json()
		const [row] = await db
			.select()
			.from(restaurantOrders)
			.where(eq(restaurantOrders.id, boundBody.order.id))
		expect(row!.customerId).toBe('cust_42')

		const crossOrg = await mintCustomerJwt('cust_42', 'org_someone_else')
		const rejected = await postOrder(orderBody(), {
			authorization: `Bearer ${crossOrg}`,
		})
		expect(rejected.status).toBe(403)
	})

	// -----------------------------------------------------------------------
	// Capacity: inventory, per-slot caps, slot order caps, concurrency
	// -----------------------------------------------------------------------

	it('enforces drop inventory durably across orders (no oversell)', async () => {
		activeContext = dropContext()
		const first = await postOrder(
			dropOrderBody({ lines: [{ itemId: 'item-brisket', quantity: 3 }] }),
		)
		expect(first.status).toBe(201)

		// 3 + 3 > inventory 5
		const over = await postOrder(
			dropOrderBody({
				pickup: { windowId: 'win-1', time: '18:00' },
				lines: [{ itemId: 'item-brisket', quantity: 3 }],
			}),
		)
		expect(over.status).toBe(422)
		expect((await over.json()).error).toBe('sold_out')

		// 3 + 2 == 5 fits
		const fits = await postOrder(
			dropOrderBody({
				pickup: { windowId: 'win-1', time: '18:00' },
				lines: [{ itemId: 'item-brisket', quantity: 2 }],
			}),
		)
		expect(fits.status).toBe(201)

		// inventory fully consumed
		const soldOut = await postOrder(
			dropOrderBody({
				pickup: { windowId: 'win-1', time: '18:30' },
				lines: [{ itemId: 'item-brisket', quantity: 1 }],
			}),
		)
		expect(soldOut.status).toBe(422)

		const db = await getTenantDb(orgId)
		const reservations = await db.select().from(restaurantOrderReservations)
		const total = reservations
			.filter((row) => row.entityId === 'item-brisket')
			.reduce((sum, row) => sum + row.quantity, 0)
		expect(total).toBe(5)
	})

	it('enforces per-slot item caps and max orders per slot', async () => {
		activeContext = dropContext(
			[
				{
					entityType: 'item',
					entityId: 'item-brisket',
					inventory: 100,
					maxPerPickupSlot: 4,
				},
			],
			2,
		)
		const a = await postOrder(
			dropOrderBody({ lines: [{ itemId: 'item-brisket', quantity: 3 }] }),
		)
		expect(a.status).toBe(201)

		// per-slot: 3 + 2 > 4
		const b = await postOrder(
			dropOrderBody({ lines: [{ itemId: 'item-brisket', quantity: 2 }] }),
		)
		expect(b.status).toBe(422)
		expect((await b.json()).error).toBe('sold_out')

		// second order in the same slot fits (3 + 1 <= 4)
		const c = await postOrder(
			dropOrderBody({ lines: [{ itemId: 'item-brisket', quantity: 1 }] }),
		)
		expect(c.status).toBe(201)

		// slot now has 2 active orders -> maxOrdersPerSlot reached
		const d = await postOrder(
			dropOrderBody({ lines: [{ itemId: 'item-brisket', quantity: 1 }] }),
		)
		expect(d.status).toBe(422)
		expect((await d.json()).error).toBe('slot_full')

		// another slot is unaffected
		const e = await postOrder(
			dropOrderBody({
				pickup: { windowId: 'win-1', time: '18:00' },
				lines: [{ itemId: 'item-brisket', quantity: 1 }],
			}),
		)
		expect(e.status).toBe(201)
	})

	it('enforces shared category inventory across items', async () => {
		activeContext = dropContext([
			{ entityType: 'category', entityId: 'cat-bbq', inventory: 4 },
		])
		const first = await postOrder(
			dropOrderBody({
				lines: [
					{ itemId: 'item-brisket', quantity: 2 },
					{ itemId: 'item-ribs', quantity: 1 },
				],
			}),
		)
		expect(first.status).toBe(201)

		const over = await postOrder(
			dropOrderBody({ lines: [{ itemId: 'item-ribs', quantity: 2 }] }),
		)
		expect(over.status).toBe(422)
		expect((await over.json()).error).toBe('sold_out')
	})

	it('enforces per-order caps before touching capacity', async () => {
		activeContext = dropContext()
		const over = await postOrder(
			dropOrderBody({ lines: [{ itemId: 'item-brisket', quantity: 4 }] }),
		)
		expect(over.status).toBe(422)
		expect((await over.json()).error).toBe('per_order_limit')
	})

	it('prevents oversell under concurrent placement', async () => {
		activeContext = dropContext([
			{
				entityType: 'item',
				entityId: 'item-brisket',
				inventory: 1,
				maxPerOrder: 1,
			},
		])
		const key1 = crypto.randomUUID()
		const key2 = crypto.randomUUID()
		const [first, second] = await Promise.all([
			postOrder(dropOrderBody({ idempotencyKey: key1 })),
			postOrder(dropOrderBody({ idempotencyKey: key2 })),
		])
		const statuses = [first.status, second.status].sort()
		expect(statuses).toEqual([201, 422])

		const db = await getTenantDb(orgId)
		const orders = await db.select().from(restaurantOrders)
		expect(orders).toHaveLength(1)
	})

	it('releases capacity when an order is cancelled', async () => {
		activeContext = dropContext([
			{
				entityType: 'item',
				entityId: 'item-brisket',
				inventory: 1,
				maxPerOrder: 1,
			},
		])
		const first = await postOrder(dropOrderBody())
		expect(first.status).toBe(201)
		const firstBody = await first.json()

		const db = await getTenantDb(orgId)
		await db
			.update(restaurantOrders)
			.set({ status: 'cancelled' })
			.where(eq(restaurantOrders.id, firstBody.order.id))

		const second = await postOrder(dropOrderBody())
		expect(second.status).toBe(201)
	})

	// -----------------------------------------------------------------------
	// Online payment lifecycle (service level, deterministic timing)
	// -----------------------------------------------------------------------

	function parsedRequest(body: Record<string, unknown>) {
		return restaurantOrderRequestSchema.parse(body)
	}

	it('online orders hold capacity until expiry, then release it', async () => {
		activeContext = dropContext([
			{
				entityType: 'item',
				entityId: 'item-brisket',
				inventory: 1,
				maxPerOrder: 1,
			},
		])
		const past = new Date(Date.now() - 20 * 60 * 1000)
		const held = await placeOrder({
			organization: ORG as never,
			request: parsedRequest(dropOrderBody({ paymentMethod: 'online' })),
			customerId: null,
			now: past,
		})
		expect(held.ok).toBe(true)
		if (!held.ok) return
		expect(held.data.paymentToken).toBeTruthy()
		expect(held.data.order.paymentStatus).toBe('pending')
		// Timestamps are stored with second precision in SQLite.
		expect(held.data.order.holdExpiresAt?.getTime()).toBe(
			Math.floor((past.getTime() + 10 * 60 * 1000) / 1000) * 1000,
		)

		// The hold has lapsed (placed 20 minutes ago with a 10-minute hold):
		// the next placement sweeps it and takes the capacity.
		const second = await placeOrder({
			organization: ORG as never,
			request: parsedRequest(dropOrderBody({ paymentMethod: 'handoff' })),
			customerId: null,
		})
		expect(second.ok).toBe(true)

		const db = await getTenantDb(orgId)
		const [expiredRow] = await db
			.select()
			.from(restaurantOrders)
			.where(eq(restaurantOrders.id, held.data.order.id))
		expect(expiredRow!.status).toBe('expired')
		expect(expiredRow!.paymentStatus).toBe('expired')
	})

	it('a late paid event moves the order to payment_review without resurrecting capacity', async () => {
		activeContext = dropContext([
			{
				entityType: 'item',
				entityId: 'item-brisket',
				inventory: 1,
				maxPerOrder: 1,
			},
		])
		const placed = await placeOrder({
			organization: ORG as never,
			request: parsedRequest(dropOrderBody({ paymentMethod: 'online' })),
			customerId: null,
		})
		expect(placed.ok).toBe(true)
		if (!placed.ok) return
		const orderId = placed.data.order.id

		const bound = await bindPaymentSession({
			orgId,
			orderId,
			sessionId: 'sess_1234567890',
			processor: 'connect',
		})
		expect(bound.ok).toBe(true)

		// Simulate time passing: the hold lapses before the webhook arrives.
		const db = await getTenantDb(orgId)
		await db
			.update(restaurantOrders)
			.set({ holdExpiresAt: new Date(Date.now() - 1000) })
			.where(eq(restaurantOrders.id, orderId))

		// Someone else takes the released capacity.
		const second = await placeOrder({
			organization: ORG as never,
			request: parsedRequest(dropOrderBody({ paymentMethod: 'handoff' })),
			customerId: null,
		})
		expect(second.ok).toBe(true)

		const late = await applyPaymentEvent({
			orgId,
			orderId,
			sessionId: 'sess_1234567890',
			processor: 'connect',
			status: 'paid',
			amountCents: placed.data.order.totalCents,
			currency: 'USD',
		})
		expect(late.ok).toBe(true)
		if (!late.ok) return
		expect(late.data.status).toBe('payment_review')
		expect(late.data.paymentStatus).toBe('paid')

		// Capacity was NOT resurrected: the expired order no longer counts.
		const [reviewed] = await db
			.select()
			.from(restaurantOrders)
			.where(eq(restaurantOrders.id, orderId))
		expect(reviewed!.status).toBe('payment_review')

		// Duplicate delivery of the same event is idempotent.
		const duplicate = await applyPaymentEvent({
			orgId,
			orderId,
			sessionId: 'sess_1234567890',
			processor: 'connect',
			status: 'paid',
			amountCents: placed.data.order.totalCents,
			currency: 'USD',
		})
		expect(duplicate.ok).toBe(true)
		if (duplicate.ok) expect(duplicate.data.status).toBe('payment_review')
	})

	it('rejects forged payment events: wrong session, amount, currency, processor', async () => {
		const placed = await placeOrder({
			organization: ORG as never,
			request: parsedRequest(orderBody({ paymentMethod: 'online' })),
			customerId: null,
		})
		expect(placed.ok).toBe(true)
		if (!placed.ok) return
		const orderId = placed.data.order.id
		const total = placed.data.order.totalCents

		// Event before any session is bound
		const unbound = await applyPaymentEvent({
			orgId,
			orderId,
			sessionId: 'sess_attacker',
			processor: 'connect',
			status: 'paid',
			amountCents: total,
			currency: 'USD',
		})
		expect(unbound.ok).toBe(false)
		if (!unbound.ok) expect(unbound.failure.code).toBe('session_mismatch')

		await bindPaymentSession({
			orgId,
			orderId,
			sessionId: 'sess_real_session',
			processor: 'connect',
		})

		const wrongSession = await applyPaymentEvent({
			orgId,
			orderId,
			sessionId: 'sess_attacker',
			processor: 'connect',
			status: 'paid',
			amountCents: total,
			currency: 'USD',
		})
		expect(wrongSession.ok).toBe(false)
		if (!wrongSession.ok)
			expect(wrongSession.failure.code).toBe('session_mismatch')

		const wrongAmount = await applyPaymentEvent({
			orgId,
			orderId,
			sessionId: 'sess_real_session',
			processor: 'connect',
			status: 'paid',
			amountCents: 1,
			currency: 'USD',
		})
		expect(wrongAmount.ok).toBe(false)
		if (!wrongAmount.ok)
			expect(wrongAmount.failure.code).toBe('amount_mismatch')

		const wrongCurrency = await applyPaymentEvent({
			orgId,
			orderId,
			sessionId: 'sess_real_session',
			processor: 'connect',
			status: 'paid',
			amountCents: total,
			currency: 'SAR',
		})
		expect(wrongCurrency.ok).toBe(false)
		if (!wrongCurrency.ok) {
			expect(wrongCurrency.failure.code).toBe('currency_mismatch')
		}

		const wrongProcessor = await applyPaymentEvent({
			orgId,
			orderId,
			sessionId: 'sess_real_session',
			processor: 'checkout',
			status: 'paid',
			amountCents: total,
			currency: 'USD',
		})
		expect(wrongProcessor.ok).toBe(false)
		if (!wrongProcessor.ok) {
			expect(wrongProcessor.failure.code).toBe('processor_mismatch')
		}

		// The legitimate event still succeeds and is idempotent on replay.
		const paid = await applyPaymentEvent({
			orgId,
			orderId,
			sessionId: 'sess_real_session',
			processor: 'connect',
			status: 'paid',
			amountCents: total,
			currency: 'USD',
		})
		expect(paid.ok).toBe(true)
		if (paid.ok) expect(paid.data.paymentStatus).toBe('paid')

		const replay = await applyPaymentEvent({
			orgId,
			orderId,
			sessionId: 'sess_real_session',
			processor: 'connect',
			status: 'paid',
			amountCents: total,
			currency: 'USD',
		})
		expect(replay.ok).toBe(true)

		// A failed event after paid cannot regress the terminal state.
		const regress = await applyPaymentEvent({
			orgId,
			orderId,
			sessionId: 'sess_real_session',
			processor: 'connect',
			status: 'failed',
			amountCents: total,
			currency: 'USD',
		})
		expect(regress.ok).toBe(false)
	})

	it('a failed payment cancels the order and releases its capacity', async () => {
		activeContext = dropContext([
			{
				entityType: 'item',
				entityId: 'item-brisket',
				inventory: 1,
				maxPerOrder: 1,
			},
		])
		const placed = await placeOrder({
			organization: ORG as never,
			request: parsedRequest(dropOrderBody({ paymentMethod: 'online' })),
			customerId: null,
		})
		expect(placed.ok).toBe(true)
		if (!placed.ok) return
		await bindPaymentSession({
			orgId,
			orderId: placed.data.order.id,
			sessionId: 'sess_fail_case',
			processor: 'connect',
		})
		const failed = await applyPaymentEvent({
			orgId,
			orderId: placed.data.order.id,
			sessionId: 'sess_fail_case',
			processor: 'connect',
			status: 'failed',
			amountCents: placed.data.order.totalCents,
			currency: 'USD',
		})
		expect(failed.ok).toBe(true)
		if (failed.ok) {
			expect(failed.data.status).toBe('cancelled')
			expect(failed.data.paymentStatus).toBe('failed')
		}

		const second = await placeOrder({
			organization: ORG as never,
			request: parsedRequest(dropOrderBody({ paymentMethod: 'handoff' })),
			customerId: null,
		})
		expect(second.ok).toBe(true)
	})

	it('payment sessions bind exactly once', async () => {
		const placed = await placeOrder({
			organization: ORG as never,
			request: parsedRequest(orderBody({ paymentMethod: 'online' })),
			customerId: null,
		})
		expect(placed.ok).toBe(true)
		if (!placed.ok) return
		const orderId = placed.data.order.id

		const first = await bindPaymentSession({
			orgId,
			orderId,
			sessionId: 'sess_first_one',
			processor: 'connect',
		})
		expect(first.ok).toBe(true)

		// Re-binding the same session is an idempotent no-op.
		const sameAgain = await bindPaymentSession({
			orgId,
			orderId,
			sessionId: 'sess_first_one',
			processor: 'connect',
		})
		expect(sameAgain.ok).toBe(true)

		// A different session for the same order is a conflict.
		const conflict = await bindPaymentSession({
			orgId,
			orderId,
			sessionId: 'sess_second_one',
			processor: 'connect',
		})
		expect(conflict.ok).toBe(false)
		if (!conflict.ok) expect(conflict.failure.code).toBe('session_conflict')
	})

	it('quotes carry amounts only, never PII, and require the payment capability', async () => {
		const placed = await placeOrder({
			organization: ORG as never,
			request: parsedRequest(orderBody({ paymentMethod: 'online' })),
			customerId: null,
		})
		expect(placed.ok).toBe(true)
		if (!placed.ok) return

		const denied = await getOrderQuote(
			orgId,
			placed.data.order.id,
			'forged-token',
		)
		expect(denied.ok).toBe(false)
		if (!denied.ok) expect(denied.failure.status).toBe(403)

		const quote = await getOrderQuote(
			orgId,
			placed.data.order.id,
			placed.data.paymentToken!,
		)
		expect(quote.ok).toBe(true)
		if (!quote.ok) return
		expect(quote.data.totalCents).toBe(placed.data.order.totalCents)
		expect(quote.data.currency).toBe('USD')
		const keys = Object.keys(quote.data)
		expect(keys.sort()).toEqual([
			'currency',
			'holdExpiresAt',
			'orderId',
			'orgId',
			'status',
			'totalCents',
		])
	})

	it('online orders are rejected when the org has no online payment processor', async () => {
		activeContext = {
			...menuContext(),
			onlinePayment: { enabled: false, processor: null },
		}
		const response = await postOrder(orderBody({ paymentMethod: 'online' }))
		expect(response.status).toBe(400)
		expect((await response.json()).error).toBe('online_payment_disabled')
	})

	// -----------------------------------------------------------------------
	// Public options capability route
	// -----------------------------------------------------------------------

	it('serves aggregate availability without any PII', async () => {
		activeContext = dropContext(undefined, 2)
		const placed = await postOrder(
			dropOrderBody({ lines: [{ itemId: 'item-brisket', quantity: 2 }] }),
		)
		expect(placed.status).toBe(201)

		const response = await app.request(
			'/orders/options?slug=test-org&locationId=loc-1&dropSlug=friday-bbq',
			{ headers: { origin: 'https://test-org.example.com' } },
		)
		expect(response.status).toBe(200)
		const body = await response.json()
		expect(body.drop.slug).toBe('friday-bbq')
		expect(body.drop.entityRemaining.items['item-brisket']).toBe(3)
		const slot = body.drop.windows[0].slots.find(
			(candidate: { time: string }) => candidate.time === '17:30',
		)
		expect(slot.ordersRemaining).toBe(1)
		const serialized = JSON.stringify(body)
		expect(serialized).not.toMatch(/Rana|phone|email|contact/i)
	})

	it('options requires a resolvable organization', async () => {
		const response = await app.request(
			'/orders/options?slug=other-org&locationId=loc-1',
		)
		expect(response.status).toBe(404)
	})
})
