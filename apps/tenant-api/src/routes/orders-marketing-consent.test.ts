import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import {
	customers,
	customerSubscriptions,
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	restaurantOrders,
} from '@repo/tenant-db'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { seedLoyaltyContextForTest } from '../lib/loyalty-context.ts'
import {
	findActiveOrganizationById,
	resolveOrganizationForBrowserAuth,
} from '../lib/origin.ts'
import { syncEnvFromProcess } from '../lib/secrets.ts'
import { sendTenantEmail } from '../lib/tenant-email.ts'
import {
	emailConsentHash,
	setCustomerSubscription,
} from '../services/marketing-audience.ts'
import { orderConsentConfirmationsIdle } from '../services/order-marketing-consent.ts'
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

const orgId = 'org_orders_consent_1'
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

const BOTH = { email: true, sms: true, textVersion: 'guest-2026-11' }

async function customerJwt(customerId: string) {
	return new SignJWT({ customerId, orgId, orgSlug: 'test-org', type: 'access' })
		.setProtectedHeader({ alg: 'HS256' })
		.setIssuer(brand.slug)
		.setAudience('tenant-api')
		.setExpirationTime('1h')
		.sign(new TextEncoder().encode(jwtSecret))
}

describe('marketing consent ticked at checkout', () => {
	let directory: string
	let app: Hono
	const send = vi.mocked(sendTenantEmail)

	async function postOrder(
		body: unknown,
		customerId: string | null = 'cust_1',
	) {
		const headers: Record<string, string> = {
			'content-type': 'application/json',
			origin: 'https://test-org.example.com',
		}
		if (customerId) {
			headers.authorization = `Bearer ${await customerJwt(customerId)}`
		}
		const res = await app.request('/orders', {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
		})
		await orderConsentConfirmationsIdle()
		return res
	}

	async function subscriptions(customerId = 'cust_1') {
		const db = await getTenantDb(orgId)
		return db
			.select()
			.from(customerSubscriptions)
			.where(eq(customerSubscriptions.customerId, customerId))
			.all()
	}

	async function subscription(channel: 'email' | 'sms', customerId = 'cust_1') {
		const db = await getTenantDb(orgId)
		return db
			.select()
			.from(customerSubscriptions)
			.where(
				and(
					eq(customerSubscriptions.customerId, customerId),
					eq(customerSubscriptions.topic, 'marketing'),
					eq(customerSubscriptions.channel, channel),
				),
			)
			.get()
	}

	beforeEach(async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orders-consent-'))
		vi.stubEnv('TENANT_DB_DIR', directory)
		vi.stubEnv('DATA_REGION', 'us')
		vi.stubEnv(
			'INTERNAL_COMMAND_TOKEN',
			'test-internal-token-very-long-and-secure-12345',
		)
		vi.stubEnv('JWT_SECRET', jwtSecret)
		vi.stubEnv('AUTH_HMAC_SECRET', 'test-hmac-secret-123456789')
		vi.stubEnv('APP_URL', 'https://app.test')
		vi.stubEnv('TENANT_API_URL', 'https://tenant.example.com')
		syncEnvFromProcess()
		send.mockClear()

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

		app = new Hono()
		app.route('/orders', publicOrderRoutes)
	})

	afterEach(async () => {
		await orderConsentConfirmationsIdle()
		await destroyTenantDb(orgId).catch(() => {})
		fs.rmSync(directory, { recursive: true, force: true })
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
	})

	it('records the consent with the order: text active, email pending with one link', async () => {
		const res = await postOrder(orderBody({ marketingConsent: BOTH }))
		expect(res.status).toBe(201)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.marketingConsent).toEqual({
			email: 'pending',
			sms: 'subscribed',
		})

		expect(await subscription('sms')).toMatchObject({
			source: 'checkout',
			consentTextVersion: 'guest-2026-11',
			unsubscribedAt: null,
			confirmedEmailHash: null,
		})
		const email = await subscription('email')
		expect(email).toMatchObject({
			source: 'checkout',
			consentTextVersion: 'guest-2026-11',
			unsubscribedAt: null,
			confirmedEmailHash: null,
		})
		expect(send).toHaveBeenCalledTimes(1)
		expect(send.mock.calls[0]![0].to).toBe('rana@example.com')
		expect(send.mock.calls[0]![0].text).toMatch(
			/^Someone asked .* https:\/\/tenant\.example\.com\/subscriptions\/confirm\?token=/s,
		)
		// The send is recorded, so the resend throttle applies.
		expect(email!.confirmationSentAt).toBeInstanceOf(Date)
	})

	it('reports only the ticked channels and records nothing for an unticked one', async () => {
		const res = await postOrder(
			orderBody({
				marketingConsent: { sms: true, email: false, textVersion: 'v1' },
			}),
		)
		expect(res.status).toBe(201)
		expect(
			((await res.json()) as Record<string, unknown>).marketingConsent,
		).toEqual({
			sms: 'subscribed',
		})
		expect(await subscription('email')).toBeUndefined()
		expect(send).not.toHaveBeenCalled()
	})

	it('never records marketing consent for "Text me order updates"', async () => {
		const res = await postOrder(orderBody({ smsUpdates: true }))
		expect(res.status).toBe(201)
		expect(
			((await res.json()) as Record<string, unknown>).marketingConsent,
		).toBeUndefined()
		expect(await subscriptions()).toEqual([])
		const db = await getTenantDb(orgId)
		expect(await db.select().from(customerSubscriptions).all()).toEqual([])
		expect(send).not.toHaveBeenCalled()
	})

	it('records nothing when the order is refused', async () => {
		const res = await postOrder(
			orderBody({
				marketingConsent: BOTH,
				// The guest was shown a discount that does not exist: refused
				// inside the placement transaction.
				discounts: { expectedDiscountMinor: 500 },
			}),
		)
		expect(res.status).toBe(409)
		expect(await res.json()).toMatchObject({ error: 'discount_changed' })
		const db = await getTenantDb(orgId)
		expect(await db.select().from(restaurantOrders).all()).toHaveLength(0)
		expect(await subscriptions()).toEqual([])
		expect(send).not.toHaveBeenCalled()
	})

	it('writes once and sends one email on an idempotent retry', async () => {
		const body = orderBody({ marketingConsent: BOTH })
		const first = await postOrder(body)
		expect(first.status).toBe(201)
		const before = await subscriptions()

		// Later, the same checkout is retried (the guest's network dropped).
		const again = await postOrder(body)
		expect(again.status).toBe(200)
		expect(
			((await again.json()) as Record<string, unknown>).marketingConsent,
		).toBeUndefined()
		const after = await subscriptions()
		expect(after).toHaveLength(2)
		for (const row of after) {
			const prior = before.find((b) => b.id === row.id)!
			expect(row.subscribedAt).toEqual(prior.subscribedAt)
			expect(row.updatedAt).toEqual(prior.updatedAt)
		}
		expect(send).toHaveBeenCalledTimes(1)
	})

	it('is ignored without a customer token', async () => {
		const res = await postOrder(orderBody({ marketingConsent: BOTH }), null)
		expect(res.status).toBe(201)
		expect(
			((await res.json()) as Record<string, unknown>).marketingConsent,
		).toBeUndefined()
		const db = await getTenantDb(orgId)
		expect(await db.select().from(customerSubscriptions).all()).toEqual([])
		expect(send).not.toHaveBeenCalled()
	})

	it('never unsubscribes from checkout', async () => {
		const db = await getTenantDb(orgId)
		await setCustomerSubscription(db, {
			customerId: 'cust_1',
			topic: 'marketing',
			channel: 'sms',
			subscribed: true,
			source: 'profile',
		})
		const res = await postOrder(
			orderBody({
				marketingConsent: { sms: false, email: false, textVersion: 'v1' },
			}),
		)
		expect(res.status).toBe(201)
		expect(
			((await res.json()) as Record<string, unknown>).marketingConsent,
		).toBeUndefined()
		expect(await subscription('sms')).toMatchObject({
			source: 'profile',
			unsubscribedAt: null,
		})
	})

	it('keeps a confirmed email subscriber confirmed and sends nothing', async () => {
		const db = await getTenantDb(orgId)
		await setCustomerSubscription(db, {
			customerId: 'cust_1',
			topic: 'marketing',
			channel: 'email',
			subscribed: true,
			source: 'profile',
			confirmedEmail: 'rana@example.com',
		})
		const before = await subscription('email')
		const res = await postOrder(
			orderBody({ marketingConsent: { email: true, textVersion: 'v2' } }),
		)
		expect(
			((await res.json()) as Record<string, unknown>).marketingConsent,
		).toEqual({
			email: 'subscribed',
		})
		const after = await subscription('email')
		expect(after!.confirmedEmailHash).toBe(emailConsentHash('rana@example.com'))
		expect(after!.subscribedAt).toEqual(before!.subscribedAt)
		expect(after!.source).toBe('profile')
		expect(send).not.toHaveBeenCalled()
	})

	it('keeps a staff-recorded text subscription and its provenance on a re-tick', async () => {
		const db = await getTenantDb(orgId)
		await setCustomerSubscription(db, {
			customerId: 'cust_1',
			topic: 'marketing',
			channel: 'sms',
			subscribed: true,
			source: 'staff',
			now: new Date(Date.now() - 10 * 86_400_000),
			recordedBy: 'usr_staff',
			consentMethod: 'paper_form',
			consentTextVersion: 'staff-2026-11',
		})
		const before = await subscription('sms')
		const res = await postOrder(
			orderBody({ marketingConsent: { sms: true, textVersion: 'v2' } }),
		)
		expect(res.status).toBe(201)
		expect(
			((await res.json()) as Record<string, unknown>).marketingConsent,
		).toEqual({ sms: 'subscribed' })
		const after = await subscription('sms')
		expect(after).toMatchObject({
			source: 'staff',
			recordedBy: 'usr_staff',
			consentMethod: 'paper_form',
			consentTextVersion: 'staff-2026-11',
			unsubscribedAt: null,
		})
		expect(after!.subscribedAt).toEqual(before!.subscribedAt)
		expect(after!.updatedAt).toEqual(before!.updatedAt)
	})

	it('re-subscribes a text opt-out from checkout', async () => {
		const db = await getTenantDb(orgId)
		for (const subscribed of [true, false]) {
			await setCustomerSubscription(db, {
				customerId: 'cust_1',
				topic: 'marketing',
				channel: 'sms',
				subscribed,
				source: 'profile',
			})
		}
		const res = await postOrder(
			orderBody({ marketingConsent: { sms: true, textVersion: 'v2' } }),
		)
		expect(
			((await res.json()) as Record<string, unknown>).marketingConsent,
		).toEqual({ sms: 'subscribed' })
		expect(await subscription('sms')).toMatchObject({
			source: 'checkout',
			consentTextVersion: 'v2',
			unsubscribedAt: null,
		})
	})

	it('skips a channel the customer cannot receive', async () => {
		const db = await getTenantDb(orgId)
		await db.insert(customers).values({
			id: 'cust_2',
			name: 'Noor',
			phone: '+15551230002',
			phoneVerified: false,
		})
		const res = await postOrder(orderBody({ marketingConsent: BOTH }), 'cust_2')
		expect(res.status).toBe(201)
		expect(
			((await res.json()) as Record<string, unknown>).marketingConsent,
		).toEqual({
			email: 'skipped',
			sms: 'skipped',
		})
		expect(await subscriptions('cust_2')).toEqual([])
		expect(send).not.toHaveBeenCalled()
	})

	it('saves the typed address when none is on file: pending, one link to it', async () => {
		const db = await getTenantDb(orgId)
		await db.insert(customers).values({
			id: 'cust_3',
			name: 'Sami',
			phone: '+15551230003',
			phoneVerified: true,
		})
		const res = await postOrder(
			orderBody({
				contact: {
					name: 'Sami',
					phone: '+1 555 123 0003',
					email: 'sami@example.com',
				},
				marketingConsent: { email: true, textVersion: 'v1' },
			}),
			'cust_3',
		)
		expect(res.status).toBe(201)
		expect(
			((await res.json()) as Record<string, unknown>).marketingConsent,
		).toEqual({ email: 'pending' })
		const customer = await db
			.select({ email: customers.email })
			.from(customers)
			.where(eq(customers.id, 'cust_3'))
			.get()
		expect(customer?.email).toBe('sami@example.com')
		expect(await subscription('email', 'cust_3')).toMatchObject({
			source: 'checkout',
			unsubscribedAt: null,
			confirmedEmailHash: null,
		})
		expect(send).toHaveBeenCalledTimes(1)
		expect(send.mock.calls[0]![0].to).toBe('sami@example.com')
	})

	it('uses the address on file, never the typed one, and keeps the profile email', async () => {
		const res = await postOrder(
			orderBody({
				contact: {
					name: 'Rana Khalid',
					phone: '+1 555 123 4567',
					email: 'other@example.com',
				},
				marketingConsent: { email: true, textVersion: 'v1' },
			}),
		)
		expect(res.status).toBe(201)
		expect(
			((await res.json()) as Record<string, unknown>).marketingConsent,
		).toEqual({ email: 'pending' })
		const db = await getTenantDb(orgId)
		const customer = await db
			.select({ email: customers.email })
			.from(customers)
			.where(eq(customers.id, 'cust_1'))
			.get()
		expect(customer?.email).toBe('rana@example.com')
		expect(send).toHaveBeenCalledTimes(1)
		expect(send.mock.calls[0]![0].to).toBe('rana@example.com')
	})

	it('refuses an unsafe wording version without echoing it', async () => {
		const res = await postOrder(
			orderBody({
				marketingConsent: { sms: true, textVersion: '<b>evil</b>' },
			}),
		)
		expect(res.status).toBe(400)
		expect(await res.text()).not.toContain('evil')
		expect(await subscriptions()).toEqual([])
	})

	it('a failed confirmation email never fails the order', async () => {
		const log = vi.spyOn(console, 'error').mockImplementation(() => {})
		send.mockRejectedValueOnce(new Error('rana@example.com down'))
		const res = await postOrder(
			orderBody({ marketingConsent: { email: true, textVersion: 'v1' } }),
		)
		expect(res.status).toBe(201)
		expect(
			((await res.json()) as Record<string, unknown>).marketingConsent,
		).toEqual({
			email: 'pending',
		})
		expect(JSON.stringify(log.mock.calls)).not.toContain('rana@example.com')
		log.mockRestore()
	})
})
