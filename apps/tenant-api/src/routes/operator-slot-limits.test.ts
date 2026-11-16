import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readySlotFloorMs } from '@repo/common/available-times'
import { brand } from '@repo/config/brand'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	restaurantOrders,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { findActiveOrganizationById } from '../lib/origin.ts'
import { operatorOrderRoutes } from './operator-orders.ts'

vi.mock('../lib/origin.ts', () => ({
	findActiveOrganizationById: vi.fn(),
}))

const orgId = 'clw9x0a12000008l00slot00001'
const operatorToken = 'test-operator-token-very-long-and-secure-12345'

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
		slotLimits: { enabled: true },
		menu: {
			organization: { id: orgId, slug: 'test-org', currency: 'USD' },
			locations: [
				{
					id: 'loc_a',
					name: 'Main',
					timezone: 'UTC',
					taxRate: 8.25,
					prepTime: 15,
					currency: 'USD',
					fulfillmentOptions: { pickup: true, delivery: true },
					inHouseTips: {
						pickupTips: true,
						deliveryTips: true,
						dineInTips: true,
					},
					isActive: true,
					storeHours: ALL_DAYS,
					onlineHours: ALL_DAYS,
					slotLimitSettings: {
						enabled: true,
						unit: 'orders',
						defaultLimit: 5,
					},
				},
			],
			menus: [
				{
					id: 'menu-1',
					displayName: 'Main',
					menuType: 'regular',
					availabilityStatus: 'available',
					categories: [
						{
							id: 'cat-1',
							displayName: 'Food',
							availabilityStatus: 'available',
							items: [
								{
									id: 'item-1',
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
	}
}

let sequence = 0
function orderRow(
	values: Partial<typeof restaurantOrders.$inferInsert>,
): typeof restaurantOrders.$inferInsert {
	sequence += 1
	return {
		orgId,
		number: `S${sequence}`,
		status: 'preparing',
		paymentMethod: 'handoff',
		paymentStatus: 'unpaid',
		fulfillment: 'pickup',
		locationId: 'loc_a',
		locationName: 'Main',
		contactName: 'Guest',
		contactPhone: '+15551234567',
		contactEmail: 'guest@example.com',
		currency: 'usd',
		subtotalCents: 1000,
		taxCents: 0,
		totalCents: 1000,
		lines: [],
		idempotencyKey: `idem-${sequence}`,
		requestHash: `hash-${sequence}`,
		receiptTokenHash: `receipt-${sequence}`,
		locationTimezone: 'UTC',
		...values,
	}
}

describe('operator slot limits routes', () => {
	let directory: string
	let app: Hono
	let futureSlot: Date

	async function operatorJwt(scope: 'orders:read' | 'orders:write') {
		return new SignJWT({
			orgId,
			sub: 'user-1',
			role: 'operator',
			scope,
		})
			.setProtectedHeader({ alg: 'HS256' })
			.setAudience('tenant-api-operator')
			.setIssuer(brand.shortName)
			.setExpirationTime('1h')
			.sign(new TextEncoder().encode(operatorToken))
	}

	beforeEach(async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-slot-limits-'))
		vi.stubEnv('TENANT_DB_DIR', directory)
		vi.stubEnv('DATA_REGION', 'us')
		vi.stubEnv('TENANT_OPERATOR_TOKEN', operatorToken)
		vi.stubEnv('APP_URL', 'https://app.test')

		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = typeof input === 'string' ? input : input.toString()
				if (url.includes('/resources/order-context')) {
					return new Response(JSON.stringify(menuContext()), {
						status: 200,
						headers: { 'content-type': 'application/json' },
					})
				}
				return new Response('not found', { status: 404 })
			}),
		)

		vi.mocked(findActiveOrganizationById).mockResolvedValue({
			id: orgId,
			slug: 'test-org',
			name: 'Org',
			customDomain: null,
			hasProvisionedDb: true,
			dataRegion: 'us',
		} as never)

		await provisionTenantDb(orgId)
		app = new Hono()
		app.route('/operator/orders', operatorOrderRoutes)
		const soon = Date.now() + 45 * 60_000
		futureSlot = new Date(readySlotFloorMs(soon, 'UTC'))
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

	it('GET /limits/today answers slot usage without PII', async () => {
		const db = await getTenantDb(orgId)
		await db.insert(restaurantOrders).values(
			orderRow({
				id: 'ord_slot_1',
				lines: [
					{
						itemId: 'item-1',
						itemName: 'Burger',
						quantity: 1,
						categoryIds: ['cat-1'],
					},
				],
				readySlotAt: futureSlot,
				readySlotUnits: 1,
			}),
		)

		const token = await operatorJwt('orders:read')
		const res = await app.request(
			'/operator/orders/limits/today?locationId=loc_a&fulfillment=pickup',
			{ headers: { authorization: `Bearer ${token}` } },
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			enabled: boolean
			slots: Array<{ used: number }>
		}
		expect(body.enabled).toBe(true)
		expect(body.limit).toBe(5)
		expect(body.slots.length).toBeGreaterThan(0)
	})

	it('POST /limits/reset requires write scope and recounts active orders', async () => {
		const db = await getTenantDb(orgId)
		await db.insert(restaurantOrders).values(
			orderRow({
				id: 'ord_slot_2',
				lines: [
					{
						itemId: 'item-1',
						itemName: 'Burger',
						quantity: 1,
						categoryIds: ['cat-1'],
					},
				],
				readySlotAt: futureSlot,
				readySlotUnits: 99,
			}),
		)
		await db.insert(restaurantOrders).values(
			orderRow({
				id: 'ord_slot_3',
				status: 'cancelled',
				readySlotAt: futureSlot,
				readySlotUnits: 4,
			}),
		)

		const read = await operatorJwt('orders:read')
		const denied = await app.request('/operator/orders/limits/reset', {
			method: 'POST',
			headers: {
				authorization: `Bearer ${read}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ locationId: 'loc_a' }),
		})
		expect(denied.status).toBe(403)

		const write = await operatorJwt('orders:write')
		const ok = await app.request('/operator/orders/limits/reset', {
			method: 'POST',
			headers: {
				authorization: `Bearer ${write}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ locationId: 'loc_a' }),
		})
		expect(ok.status).toBe(200)
		const [active] = await db
			.select({ units: restaurantOrders.readySlotUnits })
			.from(restaurantOrders)
			.where(eq(restaurantOrders.id, 'ord_slot_2'))
		expect(active?.units).toBe(1)
		const [cancelled] = await db
			.select({ units: restaurantOrders.readySlotUnits })
			.from(restaurantOrders)
			.where(eq(restaurantOrders.id, 'ord_slot_3'))
		expect(cancelled?.units).toBeNull()
	})
})
