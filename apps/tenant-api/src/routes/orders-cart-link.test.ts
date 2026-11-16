import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import {
	customerCarts,
	customers,
	destroyTenantDb,
	getTenantDb,
	marketingJourneys,
	provisionTenantDb,
} from '@repo/tenant-db'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { issueCartToken } from '../lib/cart-link.ts'
import { seedLoyaltyContextForTest } from '../lib/loyalty-context.ts'
import {
	findActiveOrganizationById,
	resolveOrganizationForBrowserAuth,
} from '../lib/origin.ts'
import { syncEnvFromProcess } from '../lib/secrets.ts'
import { setCustomerSubscription } from '../services/marketing-audience.ts'
import { publicOrderRoutes } from './orders.ts'

vi.mock('../lib/origin.ts', () => {
	const findActiveOrganizationById = vi.fn()
	return {
		findActiveOrganizationById,
		lookupActiveOrganization: vi.fn(async (id: string) => {
			const organization = await findActiveOrganizationById(id)
			return organization
				? { status: 'found', organization }
				: { status: 'missing' }
		}),
		resolveOrganizationForBrowserAuth: vi.fn(),
		resolvePublishedOrganization: vi.fn(async () => null),
	}
})

vi.mock('../lib/tenant-email.ts', () => ({
	sendTenantEmail: vi.fn().mockResolvedValue({ status: 'success' }),
}))

const orgId = 'org_cart_link_1'
const jwtSecret = 'test-jwt-secret-123456789'
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
						delivery: false,
						dineIn: false,
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
							items: [
								{
									id: 'item-burger',
									displayName: 'Burger',
									price: 10,
									availabilityStatus: 'available',
								},
							],
						},
					],
				},
			],
			locationOverrides: {},
		},
		drop: null,
		onlinePayment: { enabled: true, processor: 'connect' },
		// The quote endpoint answers only while discounts (or a gift card) are on.
		discounts: { features: { automatic: true, coupons: true }, discounts: [], codes: [] },
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
		lines: [{ itemId: 'item-burger', quantity: 1, options: [] }],
		...overrides,
	}
}


async function customerJwt(customerId: string) {
	return new SignJWT({ customerId, orgId, orgSlug: 'test-org', type: 'access' })
		.setProtectedHeader({ alg: 'HS256' })
		.setIssuer(brand.slug)
		.setAudience('tenant-api')
		.setExpirationTime('1h')
		.sign(new TextEncoder().encode(jwtSecret))
}

const lines = [{ itemId: 'item-burger', quantity: 2, options: [], instructions: 'no onions please' }]

describe('cart left behind: quote, restore link and clearing (#150)', () => {
	let directory: string
	let app: Hono

	const request = async (
		route: string,
		init: { method?: string; body?: unknown; token?: string | null; cartToken?: string } = {},
	) => {
		const headers: Record<string, string> = {
			'content-type': 'application/json',
			origin: 'https://test-org.example.com',
		}
		if (init.token) headers.authorization = `Bearer ${init.token}`
		if (init.cartToken) headers['x-cart-token'] = init.cartToken
		return app.request(route, {
			method: init.method ?? 'GET',
			headers,
			body: init.body === undefined ? undefined : JSON.stringify(init.body),
		})
	}

	const quote = async (customerId: string | null = 'cust_1') =>
		request('/orders/quote', {
			method: 'POST',
			token: customerId ? await customerJwt(customerId) : null,
			body: {
				slug: 'test-org',
				locale: 'en',
				locationId: 'loc-1',
				fulfillment: 'pickup',
				paymentMethod: 'handoff',
				tipPercent: 0,
				lines,
			},
		})

	const carts = async () => (await getTenantDb(orgId)).select().from(customerCarts).all()

	beforeEach(async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orders-cart-link-'))
		vi.stubEnv('TENANT_DB_DIR', directory)
		vi.stubEnv('DATA_REGION', 'us')
		vi.stubEnv('INTERNAL_COMMAND_TOKEN', 'test-internal-token-very-long-and-secure-12345')
		vi.stubEnv('JWT_SECRET', jwtSecret)
		vi.stubEnv('AUTH_HMAC_SECRET', 'test-hmac-secret-123456789')
		vi.stubEnv('APP_URL', 'https://app.test')
		vi.stubEnv('TENANT_API_URL', 'https://tenant.example.com')
		syncEnvFromProcess()
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = typeof input === 'string' ? input : input.toString()
				if (url.includes('/resources/order-context')) return Response.json(menuContext())
				return new Response('not found', { status: 404 })
			}),
		)
		vi.mocked(resolveOrganizationForBrowserAuth).mockImplementation(async (_origin, identity) =>
			identity?.slug === 'test-org' ? (ORG as never) : null,
		)
		vi.mocked(findActiveOrganizationById).mockImplementation(async (id) =>
			id === orgId ? (ORG as never) : null,
		)
		await provisionTenantDb(orgId)
		seedLoyaltyContextForTest(orgId, { enabled: false, redemption: false })
		const db = await getTenantDb(orgId)
		await db.insert(customers).values({
			id: 'cust_1',
			name: 'Rana',
			phone: '+15551230001',
			phoneVerified: true,
			email: 'rana@example.com',
		})
		await setCustomerSubscription(db, {
			customerId: 'cust_1',
			topic: 'marketing',
			channel: 'sms',
			subscribed: true,
			source: 'checkout',
		})
		await db.insert(marketingJourneys).values({
			name: 'Cart reminder',
			status: 'active',
			triggerType: 'cart_left_behind',
		})
		app = new Hono()
		app.route('/orders', publicOrderRoutes)
	})

	afterEach(async () => {
		await destroyTenantDb(orgId).catch(() => {})
		fs.rmSync(directory, { recursive: true, force: true })
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
	})

	it('a signed-in quote saves ids and quantities; a guest quote saves nothing', async () => {
		expect((await quote(null)).status).toBe(200)
		expect(await carts()).toEqual([])
		expect((await quote('cust_1')).status).toBe(200)
		const [row] = await carts()
		expect(row!.customerId).toBe('cust_1')
		expect(row!.items).toEqual([{ itemId: 'item-burger', quantity: 2, options: [] }])
		expect(JSON.stringify(row)).not.toMatch(/onions|Rana|rana@|\+1555/)
	})

	it('the restore link returns the cart only for a valid token, with no contact and one uniform 404', async () => {
		await quote('cust_1')
		const token = issueCartToken({ orgId, customerId: 'cust_1' })
		const ok = await request(`/orders/cart-link?slug=test-org`, { cartToken: token })
		expect(ok.status).toBe(200)
		const text = await ok.text()
		expect(JSON.parse(text)).toEqual({
			cart: {
				locationId: 'loc-1',
				currency: expect.any(String),
				lines: [{ itemId: 'item-burger', quantity: 2, options: [] }],
			},
		})
		expect(text).not.toMatch(/Rana|rana@|\+1555|onions|customerId/)
		// The token is never read from the query string.
		const inQuery = await request(`/orders/cart-link?slug=test-org&token=${token}`)
		expect(inQuery.status).toBe(404)
		const forged = await request('/orders/cart-link?slug=test-org', {
			cartToken: token.replace(/.$/, token.endsWith('0') ? '1' : '0'),
		})
		expect(forged.status).toBe(404)
		const expired = await request('/orders/cart-link?slug=test-org', {
			cartToken: issueCartToken({ orgId, customerId: 'cust_1', now: Date.now() - 8 * 24 * 3_600_000 }),
		})
		expect(expired.status).toBe(404)
		expect(await expired.json()).toEqual(await inQuery.json())
	})

	it('emptying the cart clears it, and so does placing an order', async () => {
		await quote('cust_1')
		const jwt = await customerJwt('cust_1')
		const cleared = await request('/orders/cart/clear?slug=test-org', { method: 'POST', token: jwt })
		expect(cleared.status).toBe(200)
		expect(await carts()).toEqual([])
		expect((await request('/orders/cart/clear?slug=test-org', { method: 'POST' })).status).toBe(401)

		await quote('cust_1')
		expect(await carts()).toHaveLength(1)
		const placed = await request('/orders', {
			method: 'POST',
			token: jwt,
			body: {
				slug: 'test-org',
				idempotencyKey: crypto.randomUUID(),
				locale: 'en',
				locationId: 'loc-1',
				fulfillment: 'pickup',
				paymentMethod: 'handoff',
				contact: { name: 'Rana Khalid', phone: '+1 555 123 4567' },
				tipPercent: 0,
				lines: [{ itemId: 'item-burger', quantity: 1, options: [] }],
			},
		})
		expect(placed.status).toBe(201)
		expect(await carts()).toEqual([])
	})
})

