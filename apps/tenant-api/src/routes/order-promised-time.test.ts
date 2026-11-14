import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import { type ReservationsContext } from '@repo/reservations'
import {
	destroyTenantDb,
	getTenantDb,
	orderMessages,
	provisionTenantDb,
	restaurantOrders,
	type RestaurantOrder,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import * as jose from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { seedLoyaltyContextForTest } from '../lib/loyalty-context.ts'
import {
	findActiveOrganizationById,
	resolveOrganizationForBrowserAuth,
} from '../lib/origin.ts'
import { syncEnvFromProcess } from '../lib/secrets.ts'
import { sendTenantEmail } from '../lib/tenant-email.ts'
import { setOrderMessageSendDepsForTest } from '../services/order-message-send.ts'
import { orderMessagesIdle } from '../services/order-messages.ts'
import { operatorOrderRoutes } from './operator-orders.ts'
import { publicOrderRoutes } from './orders.ts'

/**
 * Promised ready / arrival time (#109): set at placement, returned on the
 * receipt and the operator order, and pushed back through
 * `PATCH /operator/orders/:id` with `delayMinutes`.
 */

vi.mock('../lib/origin.ts', () => ({
	findActiveOrganizationById: vi.fn(),
	lookupActiveOrganization: vi.fn(async () => ({ status: 'missing' })),
	resolveOrganizationForBrowserAuth: vi.fn(),
	resolvePublishedOrganization: vi.fn(async () => null),
}))

vi.mock('../lib/tenant-email.ts', () => ({
	sendTenantEmail: vi.fn().mockResolvedValue({ status: 'success' }),
}))

const orgId = 'org_promised_time_1'
const SECRET = 'test-operator-secret-key-for-promised-time-32!!'
const NOW = new Date('2026-11-13T18:00:00.000Z')
const MIN = 60_000
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

let busyMode: unknown = null
let largeOrder: unknown = undefined

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
					timezone: 'America/Chicago',
					taxRate: 0,
					prepTime: 15,
					currency: 'USD',
					fulfillmentOptions: {
						pickup: true,
						delivery: true,
						dineIn: false,
						curbside: false,
					},
					inHouseTips: {
						pickupTips: true,
						deliveryTips: true,
						dineInTips: true,
					},
					deliveryConfig: {
						providers: ['in_house'],
						estimatedDeliveryTimeMin: 30,
						estimatedDeliveryTimeMax: 45,
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
					address: { country: 'US' },
					onlineHours: ALL_DAYS,
					busyMode,
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
		guestMessages: {
			enabled: true,
			receipt: true,
			ready: true,
			cancelled: true,
		},
		...(largeOrder === undefined ? {} : { largeOrder }),
	}
}

const ORG_CONTEXT = {
	orgId,
	dataRegion: 'us',
	organization: {
		name: 'Rana’s Kitchen',
		slug: 'test-org',
		defaultLocale: 'en',
		locales: ['en'],
		siteOrigin: 'https://test-org.example.com',
		sitePublished: true,
		emailTheme: {
			organizationName: 'Rana’s Kitchen',
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
			name: 'Main Street',
			slug: 'main',
			timeZone: 'America/Chicago',
			currency: 'USD',
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
			phone: '+1 555 123 4567',
			email: 'rana@example.com',
		},
		tipPercent: 0,
		lines: [{ itemId: 'item-burger', quantity: 2, options: [] }],
		...overrides,
	}
}

async function operatorToken(scope: 'orders:read' | 'orders:write') {
	const now = Math.floor(Date.now() / 1000)
	return new jose.SignJWT({ role: 'operator', orgId, scope })
		.setProtectedHeader({ alg: 'HS256' })
		.setSubject('usr_1')
		.setIssuer(brand.shortName)
		.setAudience('tenant-api-operator')
		.setIssuedAt(now)
		.setExpirationTime(now + 300)
		.sign(new TextEncoder().encode(SECRET))
}

describe('promised time', () => {
	let directory: string
	let app: Hono
	const sms = vi.fn(async (_input: { to: string; message: string }) => ({}))

	type Placed = {
		order: {
			id: string
			promisedAt: string | null
			promisedUntil: string | null
		}
		receiptToken: string
	}

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
		return (await res.json()) as Placed
	}

	async function orderRow(orderId: string): Promise<RestaurantOrder> {
		const db = await getTenantDb(orgId)
		const [row] = await db
			.select()
			.from(restaurantOrders)
			.where(eq(restaurantOrders.id, orderId))
		return row!
	}

	async function etaRows(orderId: string) {
		const db = await getTenantDb(orgId)
		return (await db.select().from(orderMessages).all()).filter(
			(row) => row.orderId === orderId && row.kind === 'eta_changed',
		)
	}

	async function patch(
		orderId: string,
		body: unknown,
		scope: 'orders:read' | 'orders:write' = 'orders:write',
	) {
		const res = await app.request(`/operator/orders/${orderId}`, {
			method: 'PATCH',
			headers: {
				'content-type': 'application/json',
				Authorization: `Bearer ${await operatorToken(scope)}`,
			},
			body: JSON.stringify(body),
		})
		await orderMessagesIdle()
		return res
	}

	const at = (minutes: number) =>
		new Date(NOW.getTime() + minutes * MIN).toISOString()

	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(NOW)
		busyMode = null
		largeOrder = undefined
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'promised-time-'))
		vi.stubEnv('TENANT_DB_DIR', directory)
		vi.stubEnv('DATA_REGION', 'us')
		vi.stubEnv(
			'INTERNAL_COMMAND_TOKEN',
			'test-internal-token-very-long-and-secure-12345',
		)
		vi.stubEnv('TENANT_OPERATOR_TOKEN', SECRET)
		vi.stubEnv('JWT_SECRET', 'test-jwt-secret-123456789')
		vi.stubEnv('AUTH_HMAC_SECRET', 'test-hmac-secret-123456789')
		vi.stubEnv('APP_URL', 'https://app.test')
		vi.stubEnv('TENANT_API_URL', 'https://tenant.example.com')
		vi.stubEnv('ORDERS_EMAIL_ENABLED', '')
		vi.stubEnv('ORDERS_SMS_ENABLED', '')
		syncEnvFromProcess()
		vi.mocked(sendTenantEmail).mockReset()
		vi.mocked(sendTenantEmail).mockResolvedValue({ status: 'success' } as never)
		sms.mockClear()
		setOrderMessageSendDepsForTest({
			getContext: async () => ORG_CONTEXT,
			sendSms: sms,
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
		app.route('/operator/orders', operatorOrderRoutes)
	})

	afterEach(async () => {
		await orderMessagesIdle()
		setOrderMessageSendDepsForTest(null)
		await destroyTenantDb(orgId).catch(() => {})
		fs.rmSync(directory, { recursive: true, force: true })
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
		vi.useRealTimers()
	})

	describe('at placement', () => {
		it('promises an ASAP pickup at prep time plus busy minutes, and the receipt returns it', async () => {
			busyMode = { extraPrepMinutes: 10, until: null }
			const placed = await place()
			expect(placed.order).toMatchObject({
				promisedAt: at(25),
				promisedUntil: null,
			})
			const stored = await orderRow(placed.order.id)
			expect(stored.promisedAt?.toISOString()).toBe(at(25))
			expect(stored.promisedVersion).toBe(0)
			const receipt = await app.request(
				`/orders/${placed.order.id}?slug=test-org`,
				{
					headers: {
						origin: 'https://test-org.example.com',
						Authorization: `Bearer ${placed.receiptToken}`,
					},
				},
			)
			expect(receipt.status).toBe(200)
			expect(
				((await receipt.json()) as { order: Placed['order'] }).order,
			).toMatchObject({ promisedAt: at(25), promisedUntil: null })
		})

		it('adds large-order prep only over the threshold', async () => {
			largeOrder = {
				'loc-1': {
					threshold: 20,
					thresholdType: 'amount',
					extraPrepMinutes: 15,
				},
			}
			// 2 x 10.00 = 20.00: at the threshold, not over it.
			expect((await place()).order.promisedAt).toBe(at(15))
			const big = await place({
				lines: [{ itemId: 'item-burger', quantity: 3, options: [] }],
			})
			expect(big.order.promisedAt).toBe(at(30))
			largeOrder = {
				'loc-1': { threshold: 2, thresholdType: 'items', extraPrepMinutes: 5 },
			}
			expect(
				(
					await place({
						lines: [{ itemId: 'item-burger', quantity: 3, options: [] }],
					})
				).order.promisedAt,
			).toBe(at(20))
			// A malformed rule adds nothing.
			largeOrder = { 'loc-1': { threshold: 'x' } }
			expect(
				(
					await place({
						lines: [{ itemId: 'item-burger', quantity: 9, options: [] }],
					})
				).order.promisedAt,
			).toBe(at(15))
		})

		it('promises the scheduled time when scheduled', async () => {
			const scheduledFor = at(120)
			const placed = await place({ scheduledFor })
			expect(placed.order).toMatchObject({
				promisedAt: scheduledFor,
				promisedUntil: null,
			})
		})

		it('promises an ASAP delivery as the delivery estimate range', async () => {
			const placed = await place({
				fulfillment: 'delivery',
				delivery: { address: '100 Congress Ave 78701', city: 'Austin' },
			})
			expect(placed.order).toMatchObject({
				promisedAt: at(30),
				promisedUntil: at(45),
			})
		})
	})

	describe('PATCH delayMinutes', () => {
		it('moves the time later and returns the operator order; +5 tells nobody', async () => {
			const { order } = await place()
			const res = await patch(order.id, {
				delayMinutes: 5,
				expectedPromisedVersion: 0,
			})
			expect(res.status).toBe(200)
			const body = (await res.json()) as {
				order: {
					promisedAt: string
					promisedUntil: string | null
					promisedVersion: number
					promisedDelayMinutes: number
					updatedAt: string
				}
			}
			expect(body.order).toMatchObject({
				promisedAt: at(20),
				promisedUntil: null,
				promisedVersion: 1,
				promisedDelayMinutes: 5,
			})
			expect(await etaRows(order.id)).toEqual([])
		})

		it('moves both ends of a delivery range', async () => {
			const { order } = await place({
				fulfillment: 'delivery',
				delivery: { address: '100 Congress Ave 78701', city: 'Austin' },
			})
			const res = await patch(order.id, {
				delayMinutes: 15,
				expectedPromisedVersion: 0,
			})
			expect(res.status).toBe(200)
			const row = await orderRow(order.id)
			expect(row.promisedAt?.toISOString()).toBe(at(45))
			expect(row.promisedUntil?.toISOString()).toBe(at(60))
		})

		it('sends one updated-time message for +10, never a second one, with the new time', async () => {
			const { order } = await place()
			expect(
				(
					await patch(order.id, {
						delayMinutes: 10,
						expectedPromisedVersion: 0,
					})
				).status,
			).toBe(200)
			expect(await etaRows(order.id)).toEqual([
				expect.objectContaining({ channel: 'email', status: 'sent' }),
			])
			const mails = vi
				.mocked(sendTenantEmail)
				.mock.calls.map((call) => call[0])
				.filter((mail) => mail.subject.startsWith('New time'))
			expect(mails).toHaveLength(1)
			// 18:25 UTC is 12:25 PM in Chicago.
			expect(mails[0]!.text).toMatch(/Ready around 12:25\sPM/)
			expect(
				(
					await patch(order.id, {
						delayMinutes: 10,
						expectedPromisedVersion: 1,
					})
				).status,
			).toBe(200)
			expect(await etaRows(order.id)).toHaveLength(1)
			expect(sms).not.toHaveBeenCalled()
		})

		it('also texts a guest who opted in (US node)', async () => {
			const { order } = await place({ smsUpdates: true })
			await patch(order.id, { delayMinutes: 15, expectedPromisedVersion: 0 })
			expect(
				(await etaRows(order.id)).map((row) => row.channel).sort(),
			).toEqual(['email', 'sms'])
			expect(sms).toHaveBeenCalledTimes(1)
			expect(sms.mock.calls[0]![0].message).toMatch(
				/^New time for your order \S+ from Rana’s Kitchen: Ready around 12:30\sPM\./,
			)
		})

		it('refuses earlier or odd minutes, a status in the same body, and stale versions', async () => {
			const { order } = await place()
			for (const delayMinutes of [-5, 0, 20, 7])
				expect(
					(await patch(order.id, { delayMinutes, expectedPromisedVersion: 0 }))
						.status,
				).toBe(400)
			expect((await patch(order.id, { delayMinutes: 5 })).status).toBe(400)
			expect(
				(
					await patch(order.id, {
						status: 'preparing',
						delayMinutes: 5,
						expectedPromisedVersion: 0,
					})
				).status,
			).toBe(400)
			const stale = await patch(order.id, {
				delayMinutes: 5,
				expectedPromisedVersion: 3,
			})
			expect(stale.status).toBe(409)
			expect(await stale.json()).toMatchObject({ error: 'stale_version' })
			expect((await orderRow(order.id)).promisedVersion).toBe(0)
		})

		it('caps push-backs at 90 minutes in total', async () => {
			const { order } = await place()
			for (let version = 0; version < 6; version += 1)
				expect(
					(
						await patch(order.id, {
							delayMinutes: 15,
							expectedPromisedVersion: version,
						})
					).status,
				).toBe(200)
			const capped = await patch(order.id, {
				delayMinutes: 5,
				expectedPromisedVersion: 6,
			})
			expect(capped.status).toBe(409)
			expect(await capped.json()).toMatchObject({ error: 'delay_limit' })
			const row = await orderRow(order.id)
			expect(row.promisedDelayMinutes).toBe(90)
			expect(row.promisedAt?.toISOString()).toBe(at(105))
		})

		it('refuses completed and cancelled orders', async () => {
			for (const status of ['completed', 'cancelled'] as const) {
				const { order } = await place()
				expect((await patch(order.id, { status })).status).toBe(200)
				const res = await patch(order.id, {
					delayMinutes: 10,
					expectedPromisedVersion: 0,
				})
				expect(res.status).toBe(409)
				expect(await res.json()).toMatchObject({ error: 'order_closed' })
			}
		})

		it('refuses an order without a promised time', async () => {
			const { order } = await place()
			const db = await getTenantDb(orgId)
			await db
				.update(restaurantOrders)
				.set({ promisedAt: null })
				.where(eq(restaurantOrders.id, order.id))
			const res = await patch(order.id, {
				delayMinutes: 10,
				expectedPromisedVersion: 0,
			})
			expect(res.status).toBe(409)
			expect(await res.json()).toMatchObject({ error: 'no_promised_time' })
		})

		it('needs the orders:write grant', async () => {
			const { order } = await place()
			const res = await patch(
				order.id,
				{ delayMinutes: 10, expectedPromisedVersion: 0 },
				'orders:read',
			)
			expect(res.status).toBe(403)
			const missing = await app.request(`/operator/orders/${order.id}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ delayMinutes: 10, expectedPromisedVersion: 0 }),
			})
			expect(missing.status).toBe(401)
			expect((await orderRow(order.id)).promisedVersion).toBe(0)
		})
	})
})
