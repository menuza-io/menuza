import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { type OrderNumberFormat } from '@repo/common/pos-orders'
import { type ReservationsContext } from '@repo/reservations'
import {
	destroyTenantDb,
	getTenantDb,
	posDevices,
	posOrders,
	provisionTenantDb,
	restaurantOrders,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { seedLoyaltyContextForTest } from '../lib/loyalty-context.ts'
import {
	findActiveOrganizationById,
	resolveOrganizationForBrowserAuth,
} from '../lib/origin.ts'
import { syncEnvFromProcess } from '../lib/secrets.ts'
import { setOrderMessageSendDepsForTest } from '../services/order-message-send.ts'
import { orderMessagesIdle } from '../services/order-messages.ts'
import { publicOrderRoutes } from './orders.ts'

vi.mock('../lib/origin.ts', () => ({
	findActiveOrganizationById: vi.fn(),
	lookupActiveOrganization: vi.fn(async () => ({ status: 'missing' })),
	resolveOrganizationForBrowserAuth: vi.fn(),
	resolvePublishedOrganization: vi.fn(async () => null),
}))

vi.mock('../lib/tenant-email.ts', () => ({
	sendTenantEmail: vi.fn().mockResolvedValue({ status: 'success' }),
}))

const orgId = 'org_order_number_format_1'
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

let locationTimezone = 'Asia/Riyadh'
let orderNumberFormat: OrderNumberFormat | undefined

function menuContext() {
	return {
		orgId,
		dataRegion: 'us',
		menu: {
			organization: { id: orgId, slug: 'test-org', currency: 'SAR' },
			locations: [
				{
					id: 'loc-1',
					name: 'Olaya',
					timezone: locationTimezone,
					taxRate: 0,
					prepTime: 15,
					currency: 'SAR',
					fulfillmentOptions: {
						pickup: true,
						delivery: false,
						dineIn: true,
						curbside: false,
					},
					inHouseTips: {
						pickupTips: false,
						deliveryTips: false,
						dineInTips: false,
					},
					address: { country: 'SA' },
					onlineHours: ALL_DAYS,
					...(orderNumberFormat ? { orderNumberFormat } : {}),
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
									price: 20,
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
		guestMessages: {
			enabled: false,
			receipt: false,
			ready: false,
			cancelled: false,
		},
	}
}

const ORG_CONTEXT = {
	orgId,
	dataRegion: 'ksa',
	organization: {
		name: 'Al Olaya Kitchen',
		slug: 'test-org',
		defaultLocale: 'en',
		locales: ['en'],
		siteOrigin: 'https://test-org.example.com',
		sitePublished: true,
		emailTheme: {
			organizationName: 'Al Olaya Kitchen',
			logoUrl: null,
			background: '#ffffff',
			card: '#ffffff',
			foreground: '#111111',
			mutedForeground: '#666666',
			border: '#eeeeee',
			primary: '#123456',
			primaryForeground: '#ffffff',
			radius: 8,
			headingFont: 'Inter',
			bodyFont: 'Inter',
		},
		logoUrl: null,
	},
	locations: [
		{
			id: 'loc-1',
			name: 'Olaya',
			slug: 'olaya',
			timeZone: 'Asia/Riyadh',
			currency: 'SAR',
			phone: null,
			address: null,
			storeHours: null,
			specialHours: null,
			isActive: true,
		},
	],
} as unknown as ReservationsContext

function orderBody(overrides: Record<string, unknown> = {}) {
	return {
		slug: 'test-org',
		idempotencyKey: crypto.randomUUID(),
		locale: 'en',
		locationId: 'loc-1',
		fulfillment: 'pickup',
		paymentMethod: 'handoff',
		contact: {
			name: 'Rana Khalid',
			phone: '+966 55 123 4567',
			email: 'rana@example.com',
		},
		tipPercent: 0,
		lines: [{ itemId: 'item-burger', quantity: 1, options: [] }],
		...overrides,
	}
}

describe('location order number format and daily reset (#371)', () => {
	let directory: string
	let app: Hono

	async function place(overrides: Record<string, unknown> = {}) {
		const res = await app.request('/orders', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				origin: 'https://test-org.example.com',
			},
			body: JSON.stringify(orderBody(overrides)),
		})
		await orderMessagesIdle()
		expect(res.status).toBe(201)
		return (await res.json()) as {
			order: { id: string; number: string }
			receiptToken: string
		}
	}

	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ['Date'] })
		// 2026-11-17 05:30:00 in Asia/Riyadh (UTC+3) = 02:30:00Z
		vi.setSystemTime(new Date('2026-11-17T02:30:00.000Z'))
		locationTimezone = 'Asia/Riyadh'
		orderNumberFormat = { prefix: 'A', digits: 3, resetTime: '06:00' }

		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'order-num-fmt-'))
		vi.stubEnv('TENANT_DB_DIR', directory)
		vi.stubEnv('DATA_REGION', 'us')
		vi.stubEnv('TENANT_OPERATOR_TOKEN', 'test-operator-secret-key-32-chars!!')
		vi.stubEnv('JWT_SECRET', 'test-jwt-secret-123456789')
		vi.stubEnv('AUTH_HMAC_SECRET', 'test-hmac-secret-123456789')
		vi.stubEnv('APP_URL', 'https://app.test')
		vi.stubEnv('TENANT_API_URL', 'https://tenant.example.com')
		syncEnvFromProcess()
		setOrderMessageSendDepsForTest({
			getContext: async () => ORG_CONTEXT,
			sendSms: async () => ({}),
		})
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = typeof input === 'string' ? input : input.toString()
				if (url.includes('/resources/order-context')) {
					return Response.json(menuContext())
				}
				return new Response('not found', { status: 404 })
			}),
		)
		const organization = {
			id: orgId,
			slug: 'test-org',
			customDomain: null,
			hasProvisionedDb: true,
			dataRegion: 'us',
		} as never
		vi.mocked(resolveOrganizationForBrowserAuth).mockImplementation(
			async (_origin, identity) =>
				identity?.slug === 'test-org' ? organization : null,
		)
		vi.mocked(findActiveOrganizationById).mockImplementation(async (id) =>
			id === orgId ? organization : null,
		)
		await provisionTenantDb(orgId)
		seedLoyaltyContextForTest(orgId, { enabled: false, redemption: false })
		app = new Hono()
		app.route('/orders', publicOrderRoutes)
	})

	afterEach(async () => {
		vi.useRealTimers()
		vi.unstubAllGlobals()
		vi.unstubAllEnvs()
		try {
			await destroyTenantDb(orgId)
		} finally {
			fs.rmSync(directory, { recursive: true, force: true })
		}
	})

	it('formats prefix and digits (A001, A002) and resets at configured timezone resetTime', async () => {
		// 05:30 Asia/Riyadh is before 06:00 reset -> business day 2026-11-16
		const first = await place()
		expect(first.order.number).toBe('A001')

		const second = await place()
		expect(second.order.number).toBe('A002')

		// Advance clock past 06:00 Asia/Riyadh (03:05Z = 06:05 Asia/Riyadh) -> new day resets to A001
		vi.setSystemTime(new Date('2026-11-17T03:05:00.000Z'))
		const afterReset = await place()
		expect(afterReset.order.number).toBe('A001')

		// Existing earlier order kept its number in the DB
		const db = await getTenantDb(orgId)
		const [kept] = await db
			.select()
			.from(restaurantOrders)
			.where(eq(restaurantOrders.id, first.order.id))
		expect(kept?.number).toBe('A001')
	})

	it('keeps existing order numbers when changing format and starts new format at B0001', async () => {
		const beforeChange = await place()
		expect(beforeChange.order.number).toBe('A001')

		orderNumberFormat = { prefix: 'B', digits: 4, resetTime: '06:00' }
		const afterChange = await place()
		expect(afterChange.order.number).toBe('B0001')

		const db = await getTenantDb(orgId)
		const [kept] = await db
			.select()
			.from(restaurantOrders)
			.where(eq(restaurantOrders.id, beforeChange.order.id))
		expect(kept?.number).toBe('A001')
	})

	it('skips order numbers already uploaded by Station (pos_orders) on the same business day', async () => {
		const db = await getTenantDb(orgId)
		await db.insert(posDevices).values({
			id: 'dev_1',
			label: 'Front Till',
			terminalCode: 'T1',
			locationId: 'loc-1',
			secretHash: 'test-secret-hash',
			pairedBy: 'usr_1',
		})
		await db.insert(posOrders).values({
			id: crypto.randomUUID(),
			deviceId: 'dev_1',
			locationId: 'loc-1',
			businessDate: '2026-11-16',
			number: 'A001',
			orderType: 'takeaway',
			orderSource: 'counter',
			currency: 'SAR',
			taxRatePercent: 0,
			status: 'paid',
			subtotalCents: 1000,
			taxCents: 0,
			discountCents: 0,
			tipCents: 0,
			totalCents: 1000,
			lines: [],
			adjustments: [],
			revision: 1,
			rungUpAt: Date.now(),
		})

		const placed = await place()
		expect(placed.order.number).toBe('A002')
	})

	it('allocates distinct sequential numbers when 5 orders race concurrently', async () => {
		const results = await Promise.all(
			Array.from({ length: 5 }, () =>
				place({ idempotencyKey: crypto.randomUUID() }),
			),
		)
		const numbers = results.map((r) => r.order.number).sort()
		expect(numbers).toEqual(['A001', 'A002', 'A003', 'A004', 'A005'])
	})
})
