import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	restaurantOrders,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	findActiveOrganizationById,
	resolveOrganizationForBrowserAuth,
} from '../lib/origin.ts'
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

/**
 * Order-type prices (#412) and pricing rules (#388) at quote and placement:
 * the region prices every line with the shared resolver. Soup is 10.00, 12.00
 * for delivery and 9.00 at the table; tax is off.
 */

const orgId = 'org_menu_pricing_1'
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

function menuContext(menu: Record<string, unknown> = {}) {
	return {
		orgId,
		dataRegion: 'us',
		menu: {
			organization: {
				id: orgId,
				slug: 'test-org',
				currency: 'USD',
				defaultLocale: 'en',
			},
			locations: [
				{
					id: 'loc-1',
					name: 'Main Street',
					timezone: 'UTC',
					taxRate: 0,
					prepTime: 15,
					currency: 'USD',
					fulfillmentOptions: {
						pickup: true,
						delivery: true,
						dineIn: true,
						curbside: false,
					},
					inHouseTips: {
						pickupTips: false,
						deliveryTips: false,
						dineInTips: false,
					},
					deliveryConfig: {
						providers: ['in_house'],
						estimatedDeliveryTimeMin: 30,
						estimatedDeliveryTimeMax: 60,
					},
					deliveryZones: [
						{
							id: 'zone-1',
							name: 'Downtown',
							provider: 'in_house',
							restriction: 'allowed',
							type: 'zip_code',
							zipCodes: ['78701'],
							minimumOrder: 0,
							deliveryFee: 0,
							enabled: true,
						},
					],
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
									id: 'item-soup',
									displayName: 'Soup',
									price: 10,
									orderTypePrices: { delivery: 12, dine_in: 9 },
									availabilityStatus: 'available',
								},
							],
						},
					],
				},
			],
			locationOverrides: {},
			...menu,
		},
		drop: null,
		onlinePayment: { enabled: true, processor: 'connect' },
		// The quote route answers only while discounts are on (none apply here).
		discounts: {
			features: { automatic: true, coupons: false },
			discounts: [],
			codes: [],
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
		lines: [{ itemId: 'item-soup', quantity: 1, options: [] }],
		...overrides,
	}
}

const delivery = {
	fulfillment: 'delivery',
	delivery: { address: '100 Congress Ave 78701', city: 'Austin' },
}

describe('order-type prices and pricing rules at the region', () => {
	let directory: string
	let app: Hono
	let activeContext: unknown

	const headers = {
		'content-type': 'application/json',
		origin: 'https://test-org.example.com',
	}
	const postOrder = (body: unknown) =>
		app.request('/orders', {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
		})
	const quote = async (overrides: Record<string, unknown> = {}) => {
		const { idempotencyKey: _key, ...body } = orderBody(overrides)
		const response = await app.request('/orders/quote', {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
		})
		if (response.status !== 200) throw new Error(await response.text())
		return (await response.json()) as { subtotalMinor: number }
	}

	beforeEach(async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orders-menu-pricing-'))
		vi.stubEnv('TENANT_DB_DIR', directory)
		vi.stubEnv('DATA_REGION', 'us')
		vi.stubEnv(
			'INTERNAL_COMMAND_TOKEN',
			'test-internal-token-very-long-and-secure-12345',
		)
		vi.stubEnv(
			'TENANT_OPERATOR_TOKEN',
			'test-operator-token-very-long-and-secure-12345',
		)
		vi.stubEnv('JWT_SECRET', 'test-jwt-secret-123456789')
		vi.stubEnv('AUTH_HMAC_SECRET', 'test-hmac-secret-123456789')
		vi.stubEnv('APP_URL', 'https://app.test')
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(new Date('2026-03-10T12:00:00.000Z'))
		activeContext = menuContext()
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = typeof input === 'string' ? input : input.toString()
				if (url.includes('/resources/order-context')) {
					return new Response(JSON.stringify(activeContext), {
						status: 200,
						headers: { 'content-type': 'application/json' },
					})
				}
				return new Response('not found', { status: 404 })
			}),
		)
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
		vi.useRealTimers()
		try {
			await destroyTenantDb(orgId)
			fs.rmSync(directory, { recursive: true, force: true })
		} catch {}
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
		vi.clearAllMocks()
	})

	it('quotes the delivery price only for delivery and reprices when switched to pickup', async () => {
		expect((await quote(delivery)).subtotalMinor).toBe(1200)
		expect((await quote()).subtotalMinor).toBe(1000)
	})

	it('stores the price for the order type at placement', async () => {
		const response = await postOrder(orderBody(delivery))
		expect(response.status).toBe(201)
		const placed = (await response.json()) as { order: { id: string } }
		const db = await getTenantDb(orgId)
		const [row] = await db
			.select()
			.from(restaurantOrders)
			.where(eq(restaurantOrders.id, placed.order.id))
		expect(row!.subtotalCents).toBe(1200)
	})

	it('falls back to the base price when the order type has none', async () => {
		activeContext = menuContext({
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
									id: 'item-soup',
									displayName: 'Soup',
									price: 10,
									availabilityStatus: 'available',
								},
							],
						},
					],
				},
			],
		})
		expect((await quote(delivery)).subtotalMinor).toBe(1000)
	})

	it('applies a +10% round-up rule, but not to a dish with a fixed location price', async () => {
		const rule = {
			id: 'r1',
			percentBp: 1000,
			allDishes: false,
			categoryIds: ['cat-food'],
			locationIds: [],
			rounding: { mode: 'decimals', decimals: 0 },
		}
		activeContext = menuContext({ pricingRules: [rule] })
		// Delivery 12.00 + 10% = 13.20, rounded up to 14.00.
		expect((await quote(delivery)).subtotalMinor).toBe(1400)
		expect((await quote()).subtotalMinor).toBe(1100)
		activeContext = menuContext({
			pricingRules: [rule],
			locationOverrides: {
				'loc-1': [{ entityType: 'item', entityId: 'item-soup', price: 8 }],
			},
		})
		expect((await quote(delivery)).subtotalMinor).toBe(800)
	})
})
