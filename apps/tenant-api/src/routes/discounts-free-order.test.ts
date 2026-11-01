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
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeDiscount } from '../../../../packages/discounts/src/test-fixtures.ts'
import {
	findActiveOrganizationById,
	resolveOrganizationForBrowserAuth,
} from '../lib/origin.ts'
import { kitchenFeed } from '../services/kds-service.ts'
import {
	getOperatorOrder,
	operatorOrder,
	updateOperatorOrder,
} from '../services/order-service.ts'
import {
	countedOrderCondition,
	loadOrderItemRecords,
} from '../services/report-records.ts'
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
 * A 100% discount leaves nothing to pay. The order is accepted at once, so it
 * must reach the kitchen and every sales report like a paid one.
 */

const orgId = 'org_discount_free_1'
const internalToken = 'test-internal-token-very-long-and-secure-12345'
const operatorToken = 'test-operator-token-very-long-and-secure-12345'
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

function menuContext(discounts: Record<string, unknown> | null) {
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
		qrOrdering: { enabled: true, dineIn: true, online: true },
		...(discounts ? { discounts } : {}),
	}
}

function freeDiscounts() {
	return {
		features: { automatic: true, coupons: true },
		discounts: [
			makeDiscount({
				id: 'disc_free',
				name: 'Everything free',
				percentBp: 10000,
			}),
		],
		codes: [],
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
		lines: [{ itemId: 'item-burger', quantity: 2, options: [] }],
		...overrides,
	}
}

async function operatorJwt() {
	return new SignJWT({ orgId, role: 'operator', scope: 'qr:write' })
		.setSubject('user_1')
		.setProtectedHeader({ alg: 'HS256' })
		.setAudience('tenant-api-operator')
		.setIssuer(brand.shortName)
		.setExpirationTime('15m')
		.sign(new TextEncoder().encode(operatorToken))
}

describe('a 100% discount order', () => {
	let directory: string
	let app: Hono

	async function place(overrides: Record<string, unknown>) {
		const response = await app.request('/orders', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				origin: 'https://test-org.example.com',
			},
			body: JSON.stringify(
				orderBody({
					discounts: { expectedDiscountMinor: 2000 },
					...overrides,
				}),
			),
		})
		expect(response.status).toBe(201)
		return (await response.json()).order as { id: string; totalCents: number }
	}

	beforeEach(async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'discount-free-'))
		vi.stubEnv('TENANT_DB_DIR', directory)
		vi.stubEnv('DATA_REGION', 'us')
		vi.stubEnv('INTERNAL_COMMAND_TOKEN', internalToken)
		vi.stubEnv('TENANT_OPERATOR_TOKEN', operatorToken)
		vi.stubEnv('JWT_SECRET', 'test-jwt-secret-123456789')
		vi.stubEnv('AUTH_HMAC_SECRET', 'test-hmac-secret-123456789')
		vi.stubEnv('APP_URL', 'https://app.test')
		vi.stubEnv('DISCOUNTS_ENABLED', 'true')
		const context = menuContext(freeDiscounts())
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = typeof input === 'string' ? input : input.toString()
				if (url.includes('/resources/order-context')) {
					return Response.json(context)
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
		try {
			await destroyTenantDb(orgId)
			fs.rmSync(directory, { recursive: true, force: true })
		} catch {
			// The directory is already gone when a test failed mid-setup.
		}
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
		vi.clearAllMocks()
	})

	async function stored(id: string) {
		const db = await getTenantDb(orgId)
		const [row] = await db
			.select()
			.from(restaurantOrders)
			.where(eq(restaurantOrders.id, id))
		return row!
	}

	async function salesCounted(id: string) {
		const db = await getTenantDb(orgId)
		const rows = await db
			.select({ id: restaurantOrders.id })
			.from(restaurantOrders)
			.where(and(eq(restaurantOrders.orgId, orgId), countedOrderCondition()))
		return rows.some((row) => row.id === id)
	}

	it('an online order is stored not_required and shows in the kitchen and in sales', async () => {
		const order = await place({ paymentMethod: 'online' })
		expect(order.totalCents).toBe(0)
		expect(await stored(order.id)).toMatchObject({
			paymentMethod: 'online',
			paymentStatus: 'not_required',
			discountCents: 2000,
		})

		const db = await getTenantDb(orgId)
		const feed = await kitchenFeed(db, orgId, 'loc-1')
		expect(feed.tickets.map((ticket) => ticket.id)).toContain(order.id)
		expect(await salesCounted(order.id)).toBe(true)

		const items = await loadOrderItemRecords(
			db,
			orgId,
			{
				timeframe: { preset: 'last_30_days', field: 'createdAt' },
			} as never,
			new Date(),
		)
		expect(items.records.map((record) => record.itemName)).toContain('Burger')
	})

	it('a pay-at-pickup order is stored not_required, so no mark-paid step is left', async () => {
		const order = await place({ paymentMethod: 'handoff' })
		expect(await stored(order.id)).toMatchObject({
			paymentMethod: 'handoff',
			paymentStatus: 'not_required',
			totalCents: 0,
		})
		expect(await salesCounted(order.id)).toBe(true)
		const db = await getTenantDb(orgId)
		expect(
			(await kitchenFeed(db, orgId, 'loc-1')).tickets.map((t) => t.id),
		).toContain(order.id)

		// A stale "mark paid" tap is harmless: nothing is invented.
		const marked = await updateOperatorOrder(orgId, order.id, {
			status: 'accepted',
			markPaid: true,
		})
		expect(marked.ok).toBe(true)
		expect(await stored(order.id)).toMatchObject({
			paymentStatus: 'not_required',
			paidAt: null,
		})
		const found = await getOperatorOrder(orgId, order.id)
		if (!found.ok) throw new Error('order missing')
		expect(operatorOrder(found.data).paymentStatus).toBe('not_required')
	})

	it('a handoff order that is not free still waits to be marked paid', async () => {
		const order = await place({
			paymentMethod: 'handoff',
			discounts: undefined,
		})
		expect(order.totalCents).toBeGreaterThan(0)
		expect(await stored(order.id)).toMatchObject({
			paymentStatus: 'unpaid',
		})
		const marked = await updateOperatorOrder(orgId, order.id, {
			status: 'accepted',
			markPaid: true,
		})
		expect(marked.ok).toBe(true)
		expect(await stored(order.id)).toMatchObject({ paymentStatus: 'paid' })
	})
})
