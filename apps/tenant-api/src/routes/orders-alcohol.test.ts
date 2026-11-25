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
import { makeDiscount } from '../../../../packages/discounts/src/test-fixtures.ts'
import {
	findActiveOrganizationById,
	resolveOrganizationForBrowserAuth,
} from '../lib/origin.ts'
import { operatorOrder } from '../services/order-service.ts'
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
 * Alcohol rules (#167) and the allergy flag (#294) at placement.
 */

const orgId = 'org_alcohol_rules_1'
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

const packagingSettings = (patch: Record<string, unknown> = {}) => ({
	enabled: true,
	mode: 'per_order',
	amountMinor: 100,
	fulfillments: ['pickup', 'delivery'],
	label: 'Packaging fee',
	taxable: false,
	...patch,
})

function menuContext(
	extra: Record<string, unknown> = {},
	location: Record<string, unknown> = {},
) {
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
							deliveryFee: 3,
							enabled: true,
						},
					],
					onlineHours: ALL_DAYS,
					...location,
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
								{
									id: 'item-wine',
									displayName: 'House wine',
									price: 9,
									isAlcohol: true,
									availabilityStatus: 'available',
								},
								{
									id: 'item-soda',
									displayName: 'Soda',
									price: 2,
									availabilityStatus: 'available',
									excludeFromOrderLimits: true,
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
		...extra,
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
		lines: [{ itemId: 'item-burger', quantity: 2, options: [] }],
		...overrides,
	}
}


describe('alcohol and allergy at placement (#167, #294)', () => {
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
	const postQuote = (body: unknown) =>
		app.request('/orders/quote', {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
		})
	const getOptions = () =>
		app.request('/orders/options?slug=test-org&locationId=loc-1', {
			headers: { origin: 'https://test-org.example.com' },
		})

	async function storedOrder(id: string) {
		const db = await getTenantDb(orgId)
		const [row] = await db
			.select()
			.from(restaurantOrders)
			.where(eq(restaurantOrders.id, id))
		return row!
	}

	beforeEach(async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orders-checkout-rules-'))
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

	const wine = [{ itemId: 'item-wine', quantity: 1, options: [] }]
	const delivery = {
		fulfillment: 'delivery',
		delivery: { address: '1 Main St, Austin, TX 78701', city: 'Austin' },
	}
	const notDeliverable = { alcohol: { locations: { 'loc-1': 'pickup' } } }

	it('refuses a delivery cart with wine when delivery is not allowed, naming the line', async () => {
		activeContext = menuContext(notDeliverable)
		const response = await postOrder(orderBody({ ...delivery, lines: wine }))
		expect(response.status).toBe(422)
		const body = await response.json()
		expect(body.error).toBe('alcohol_not_allowed')
		expect(body.details.lines).toEqual([
			{ line: 0, itemId: 'item-wine', name: 'House wine' },
		])
	})

	it('needs the guest\'s yes for alcohol and stores a yes, never a birth date', async () => {
		activeContext = menuContext(notDeliverable)
		const refused = await postOrder(orderBody({ lines: wine }))
		expect(refused.status).toBe(422)
		expect((await refused.json()).error).toBe('age_confirmation_required')

		const placed = await postOrder(
			orderBody({ lines: wine, ageConfirmed: true }),
		)
		expect(placed.status).toBe(201)
		const row = await storedOrder((await placed.json()).order.id)
		expect(row.ageConfirmed).toBe(true)
		expect(row.hasAlcohol).toBe(true)
		const columns = Object.keys(row).join(' ').toLowerCase()
		expect(columns).not.toMatch(/birth|dob|age_?date/)
	})

	it('asks nothing of an order without alcohol', async () => {
		const placed = await postOrder(orderBody())
		expect(placed.status).toBe(201)
		const row = await storedOrder((await placed.json()).order.id)
		expect(row.ageConfirmed).toBeNull()
		expect(row.hasAlcohol).toBe(false)
		expect(row.guestAllergy).toBe(false)
	})

	it('refuses alcohol online for KSA', async () => {
		activeContext = menuContext({ alcohol: { ksa: true } })
		const response = await postOrder(
			orderBody({ lines: wine, ageConfirmed: true }),
		)
		expect(response.status).toBe(422)
		expect((await response.json()).error).toBe('alcohol_not_allowed')
	})

	it('shows the operator "Check ID" and the allergy flag on the order', async () => {
		const placed = await postOrder(
			orderBody({ lines: wine, ageConfirmed: true, guestAllergy: true }),
		)
		const row = await storedOrder((await placed.json()).order.id)
		const view = operatorOrder(row)
		expect(view.hasAlcohol).toBe(true)
		expect(view.guestAllergy).toBe(true)
	})
})
