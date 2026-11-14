import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { type ReservationsContext } from '@repo/reservations'
import {
	destroyTenantDb,
	getTenantDb,
	loyaltyRateCounters,
	provisionTenantDb,
} from '@repo/tenant-db'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { seedLoyaltyContextForTest } from '../lib/loyalty-context.ts'
import { deriveOrderLinkToken } from '../lib/order-link.ts'
import {
	countOrderResendAttempt,
	ORDER_RESEND_LINK_LIMIT,
} from '../lib/order-link-limits.ts'
import { resolveOrganizationForBrowserAuth } from '../lib/origin.ts'
import { syncEnvFromProcess } from '../lib/secrets.ts'
import { sendTenantEmail } from '../lib/tenant-email.ts'
import { orderLinkResendsIdle } from '../services/order-link-access.ts'
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

const orgId = 'org_order_resend_link_1'
const EMAIL = 'rana@example.com'
const ORIGIN = 'https://test-org.example.com'
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

let guestMessages: unknown = {
	enabled: true,
	receipt: true,
	ready: true,
	cancelled: true,
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
		guestMessages,
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
		siteOrigin: ORIGIN,
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
			timeZone: 'UTC',
			currency: 'USD',
			phone: null,
			address: null,
			storeHours: null,
			specialHours: null,
			isActive: true,
		},
	],
} as unknown as ReservationsContext

describe('POST /orders/:id/resend-link', () => {
	let directory: string
	let app: Hono
	const send = vi.mocked(sendTenantEmail)

	async function placed(contact: Record<string, unknown> = {}) {
		const res = await app.request('/orders', {
			method: 'POST',
			headers: { 'content-type': 'application/json', origin: ORIGIN },
			body: JSON.stringify({
				slug: 'test-org',
				idempotencyKey: crypto.randomUUID(),
				locale: 'en',
				locationId: 'loc-1',
				fulfillment: 'pickup',
				paymentMethod: 'handoff',
				contact: {
					name: 'Rana Khalid',
					phone: '+1 555 123 4567',
					email: EMAIL,
					...contact,
				},
				tipPercent: 0,
				lines: [{ itemId: 'item-burger', quantity: 1, options: [] }],
			}),
		})
		await orderMessagesIdle()
		expect(res.status).toBe(201)
		return (await res.json()) as {
			order: { id: string }
			receiptToken: string
		}
	}

	async function resend(orderId: string, headers: Record<string, string>) {
		const res = await app.request(`/orders/${orderId}/resend-link`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				origin: ORIGIN,
				...headers,
			},
			body: JSON.stringify({ slug: 'test-org' }),
		})
		await orderLinkResendsIdle()
		return res
	}

	const link = (orderId: string) => ({
		'X-Order-Link': deriveOrderLinkToken(orgId, orderId),
	})

	beforeEach(async () => {
		guestMessages = {
			enabled: true,
			receipt: true,
			ready: true,
			cancelled: true,
		}
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'order-resend-link-'))
		vi.stubEnv('TENANT_DB_DIR', directory)
		vi.stubEnv('DATA_REGION', 'us')
		vi.stubEnv(
			'INTERNAL_COMMAND_TOKEN',
			'test-internal-token-very-long-and-secure-12345',
		)
		vi.stubEnv('JWT_SECRET', 'test-jwt-secret-123456789')
		vi.stubEnv('AUTH_HMAC_SECRET', 'test-hmac-secret-123456789')
		vi.stubEnv('APP_URL', 'https://app.test')
		vi.stubEnv('TENANT_API_URL', 'https://tenant.example.com')
		vi.stubEnv('ORDERS_EMAIL_ENABLED', '')
		vi.stubEnv('ORDERS_SMS_ENABLED', '')
		syncEnvFromProcess()
		send.mockReset()
		send.mockResolvedValue({ status: 'success' } as never)
		setOrderMessageSendDepsForTest({ getContext: async () => ORG_CONTEXT })
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
		vi.mocked(resolveOrganizationForBrowserAuth).mockImplementation(
			async (_origin, identity) =>
				identity?.slug === 'test-org'
					? ({
							id: orgId,
							slug: 'test-org',
							customDomain: null,
							hasProvisionedDb: true,
							dataRegion: 'us',
						} as never)
					: null,
		)
		await provisionTenantDb(orgId)
		seedLoyaltyContextForTest(orgId, { enabled: false, redemption: false })
		app = new Hono()
		app.route('/orders', publicOrderRoutes)
	})

	afterEach(async () => {
		vi.useRealTimers()
		await orderLinkResendsIdle()
		await orderMessagesIdle()
		setOrderMessageSendDepsForTest(null)
		await destroyTenantDb(orgId).catch(() => {})
		fs.rmSync(directory, { recursive: true, force: true })
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
	})

	it('re-sends the receipt email with the link, by link token or receipt token', async () => {
		const order = await placed()
		expect(send).toHaveBeenCalledTimes(1)

		const byLink = await resend(order.order.id, link(order.order.id))
		expect(byLink.status).toBe(202)
		expect(byLink.headers.get('cache-control')).toBe('no-store')
		expect(await byLink.json()).toEqual({ ok: true })
		expect(send).toHaveBeenCalledTimes(2)
		const mail = send.mock.calls[1]![0]
		expect(mail.to).toBe(EMAIL)
		expect(mail.text).toContain(
			`${ORIGIN}/menu/success?order=${order.order.id}#link=${deriveOrderLinkToken(orgId, order.order.id)}`,
		)

		const byReceipt = await resend(order.order.id, {
			Authorization: `Bearer ${order.receiptToken}`,
		})
		expect(byReceipt.status).toBe(202)
		expect(send).toHaveBeenCalledTimes(3)
	})

	it('answers the same 202 whether or not anything could be sent', async () => {
		const noEmail = await placed({ email: undefined })
		send.mockClear()
		const res = await resend(noEmail.order.id, link(noEmail.order.id))
		expect(res.status).toBe(202)
		expect(await res.text()).toBe(JSON.stringify({ ok: true }))
		expect(send).not.toHaveBeenCalled()

		const withEmail = await placed()
		send.mockClear()
		vi.stubEnv('ORDERS_EMAIL_ENABLED', 'false')
		const off = await resend(withEmail.order.id, link(withEmail.order.id))
		expect(off.status).toBe(202)
		expect(await off.text()).toBe(JSON.stringify({ ok: true }))
		expect(send).not.toHaveBeenCalled()

		vi.stubEnv('ORDERS_EMAIL_ENABLED', '')
		send.mockRejectedValueOnce(new Error('provider_down'))
		const failed = await resend(withEmail.order.id, link(withEmail.order.id))
		expect(failed.status).toBe(202)
		expect(await failed.text()).toBe(JSON.stringify({ ok: true }))
	})

	it('allows 3 per order per hour: the 4th is 429 and sends nothing; another order is unaffected', async () => {
		const first = await placed()
		const second = await placed()
		send.mockClear()
		for (let i = 0; i < 3; i++) {
			expect((await resend(first.order.id, link(first.order.id))).status).toBe(
				202,
			)
		}
		expect(send).toHaveBeenCalledTimes(3)

		const limited = await resend(first.order.id, {
			Authorization: `Bearer ${first.receiptToken}`,
		})
		expect(limited.status).toBe(429)
		expect(limited.headers.get('cache-control')).toBe('no-store')
		const retryAfter = Number(limited.headers.get('retry-after'))
		expect(retryAfter).toBeGreaterThan(0)
		expect(retryAfter).toBeLessThanOrEqual(65 * 60)
		const body = await limited.json()
		expect(body).toEqual({
			error: 'rate_limit_exceeded',
			message: expect.any(String),
			retryAfterSeconds: retryAfter,
		})
		expect(send).toHaveBeenCalledTimes(3)

		// Per order: the second order still has its own three.
		expect((await resend(second.order.id, link(second.order.id))).status).toBe(
			202,
		)
		expect(send).toHaveBeenCalledTimes(4)
		// The counter holds no order id or contact in the clear.
		const db = await getTenantDb(orgId)
		const stored = JSON.stringify(await db.select().from(loyaltyRateCounters))
		expect(stored).not.toContain(first.order.id)
		expect(stored).not.toContain(EMAIL)
	})

	it('rolls the window after an hour', async () => {
		const order = await placed()
		send.mockClear()
		const start = Date.now()
		vi.useFakeTimers({ toFake: ['Date'], now: start })
		for (let i = 0; i < 3; i++) {
			expect((await resend(order.order.id, link(order.order.id))).status).toBe(
				202,
			)
		}
		vi.setSystemTime(start + 30 * 60_000)
		expect((await resend(order.order.id, link(order.order.id))).status).toBe(
			429,
		)
		vi.setSystemTime(
			start +
				ORDER_RESEND_LINK_LIMIT.windowMs +
				ORDER_RESEND_LINK_LIMIT.slotMs +
				1000,
		)
		expect((await resend(order.order.id, link(order.order.id))).status).toBe(
			202,
		)
		expect(send).toHaveBeenCalledTimes(4)
	})

	it('the counter slides: a burst at a boundary cannot spend two budgets', async () => {
		const db = await getTenantDb(orgId)
		const hour = ORDER_RESEND_LINK_LIMIT.windowMs
		const boundary = Math.ceil(Date.now() / hour) * hour + hour
		const subject = { orgId, orderId: 'ord_slide' }
		for (let i = 0; i < 3; i++) {
			expect(
				(await countOrderResendAttempt(db, subject, boundary - 1000)).ok,
			).toBe(true)
		}
		expect(
			(await countOrderResendAttempt(db, subject, boundary + 1000)).ok,
		).toBe(false)
	})
})
