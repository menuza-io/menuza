import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { seedLoyaltyContextForTest } from '../lib/loyalty-context.ts'
import {
	deriveOrderLinkToken,
	verifyOrderLinkToken,
} from '../lib/order-link.ts'
import { renderOrderEmail } from '../lib/order-messages-email.ts'
import { resolveOrganizationForBrowserAuth } from '../lib/origin.ts'
import { syncEnvFromProcess } from '../lib/secrets.ts'
import { sendTenantEmail } from '../lib/tenant-email.ts'
import { publicOrderRoutes } from '../routes/orders.ts'
import {
	ORDER_SMS_DAILY_CAP,
	runOrderMessagesTickForOrg,
	sendOrderReceiptNow,
	setOrderMessageSendDepsForTest,
} from './order-message-send.ts'
import { kitchenCommand, kitchenFeed } from './kds-service.ts'
import {
	orderMessagesIdle,
	queueEtaChangedMessage,
	queueOrderMessage,
	queueOrderStatusMessages,
} from './order-messages.ts'
import {
	applyPaymentEvent,
	bindPaymentSession,
	updateOperatorOrder,
} from './order-service.ts'

vi.mock('../lib/origin.ts', () => ({
	findActiveOrganizationById: vi.fn(),
	lookupActiveOrganization: vi.fn(async () => ({ status: 'missing' })),
	resolveOrganizationForBrowserAuth: vi.fn(),
	resolvePublishedOrganization: vi.fn(async () => null),
}))

vi.mock('../lib/tenant-email.ts', () => ({
	sendTenantEmail: vi.fn().mockResolvedValue({ status: 'success' }),
}))

const orgId = 'org_order_messages_1'
const PHONE = '+1 555 123 4567'
const EMAIL = 'rana@example.com'
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

const ALL_ON = { enabled: true, receipt: true, ready: true, cancelled: true }

let region: 'us' | 'ksa' = 'us'
let guestMessages: unknown = ALL_ON

function menuContext() {
	return {
		orgId,
		dataRegion: region,
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
									displayName: '{"en":"Burger","ar":"برجر"}',
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
		...(guestMessages === undefined ? {} : { guestMessages }),
		// The App also sends this for #109; the region ignores it here.
		largeOrder: {
			'loc-1': { threshold: 100, unit: 'amount', extraMinutes: 10 },
		},
	}
}

const ORG_CONTEXT = {
	orgId,
	dataRegion: 'us',
	organization: {
		name: 'Rana’s Kitchen',
		slug: 'test-org',
		defaultLocale: 'en',
		locales: ['en', 'ar'],
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

function orderBody(overrides: Record<string, unknown> = {}) {
	return {
		slug: 'test-org',
		idempotencyKey: crypto.randomUUID(),
		locale: 'en',
		locationId: 'loc-1',
		fulfillment: 'pickup',
		paymentMethod: 'handoff',
		contact: { name: 'Rana Khalid', phone: PHONE, email: EMAIL },
		tipPercent: 0,
		lines: [{ itemId: 'item-burger', quantity: 2, options: [] }],
		...overrides,
	}
}

describe('guest order messages', () => {
	let directory: string
	let app: Hono
	const send = vi.mocked(sendTenantEmail)
	const sms = vi.fn(async (_input: { to: string; message: string }) => ({}))

	async function placeOrder(overrides: Record<string, unknown> = {}) {
		const res = await app.request('/orders', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				origin: 'https://test-org.example.com',
			},
			body: JSON.stringify(orderBody(overrides)),
		})
		await orderMessagesIdle()
		return res
	}

	async function placed(overrides: Record<string, unknown> = {}) {
		const res = await placeOrder(overrides)
		expect(res.status).toBe(201)
		const body = (await res.json()) as { order: { id: string } }
		return body.order.id
	}

	async function rows(orderId?: string) {
		const db = await getTenantDb(orgId)
		const all = await db.select().from(orderMessages).all()
		return orderId ? all.filter((row) => row.orderId === orderId) : all
	}

	async function orderRow(orderId: string): Promise<RestaurantOrder> {
		const db = await getTenantDb(orgId)
		const [row] = await db
			.select()
			.from(restaurantOrders)
			.where(eq(restaurantOrders.id, orderId))
		return row!
	}

	async function setStatus(orderId: string, status: RestaurantOrder['status']) {
		const result = await updateOperatorOrder(orgId, orderId, { status })
		await orderMessagesIdle()
		expect(result.ok).toBe(true)
	}

	async function payOnline(orderId: string) {
		const order = await orderRow(orderId)
		const sessionId = `cs_${orderId}`
		const bound = await bindPaymentSession({
			orgId,
			orderId,
			sessionId,
			processor: 'connect',
		})
		expect(bound.ok).toBe(true)
		const event = {
			orgId,
			orderId,
			sessionId,
			processor: 'connect' as const,
			status: 'paid' as const,
			amountCents: order.totalCents,
			currency: order.currency,
		}
		return { event, pay: () => applyPaymentEvent(event) }
	}

	beforeEach(async () => {
		region = 'us'
		guestMessages = ALL_ON
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'order-messages-'))
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
		vi.mocked(resolveOrganizationForBrowserAuth).mockImplementation(
			async (_origin, identity) =>
				identity?.slug === 'test-org'
					? ({
							id: orgId,
							slug: 'test-org',
							customDomain: null,
							hasProvisionedDb: true,
							dataRegion: region,
						} as never)
					: null,
		)

		await provisionTenantDb(orgId)
		seedLoyaltyContextForTest(orgId, { enabled: false, redemption: false })
		app = new Hono()
		app.route('/orders', publicOrderRoutes)
	})

	afterEach(async () => {
		await orderMessagesIdle()
		setOrderMessageSendDepsForTest(null)
		await destroyTenantDb(orgId).catch(() => {})
		fs.rmSync(directory, { recursive: true, force: true })
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
	})

	it('sends one receipt email when a pay-at-pickup order is placed, with the link in the fragment', async () => {
		const orderId = await placed()
		expect(await rows(orderId)).toEqual([
			expect.objectContaining({
				kind: 'receipt',
				channel: 'email',
				status: 'sent',
				attempts: 1,
				lastError: null,
			}),
		])
		expect(send).toHaveBeenCalledTimes(1)
		const mail = send.mock.calls[0]![0]
		expect(mail.to).toBe(EMAIL)
		expect(mail.subject).toMatch(/^Your order \S+ from Rana’s Kitchen$/)
		expect(mail.subject).not.toContain('555')
		expect(mail.subject).not.toContain('Rana Khalid')
		expect(mail.html).toContain('2×')
		expect(mail.html).toContain('Burger')
		expect(mail.html).toContain('Main Street')
		const token = deriveOrderLinkToken(orgId, orderId)
		expect(mail.text).toContain(
			`https://test-org.example.com/menu/success?order=${orderId}#link=${token}`,
		)
		// The token rides in the fragment only, never the query.
		expect(mail.text).not.toContain(`?link=`)
		// It verifies against the order as stored (live receipt hash, fresh).
		const order = await orderRow(orderId)
		expect(
			verifyOrderLinkToken({
				orgId,
				orderId,
				presented: token,
				createdAt: order.createdAt,
				receiptTokenHash: order.receiptTokenHash,
			}),
		).toBe(true)
		// Nothing about the guest's contact is stored on the message row.
		const stored = JSON.stringify(await rows(orderId))
		expect(stored).not.toContain(EMAIL)
		expect(stored).not.toContain('5551234567')
	})

	it('stores the policy and the text opt-in with the order, and only on pickup or delivery with a phone', async () => {
		const orderId = await placed({ smsUpdates: true })
		const order = await orderRow(orderId)
		expect(order.smsUpdatesOptIn).toBe(true)
		expect(order.guestMessages).toEqual({
			receipt: true,
			ready: true,
			cancelled: true,
		})
		const without = await placed({ smsUpdates: false })
		expect((await orderRow(without)).smsUpdatesOptIn).toBe(false)
	})

	it('sends an online order its receipt only after the paid event, once, even when the event is replayed', async () => {
		const orderId = await placed({ paymentMethod: 'online' })
		expect(await rows(orderId)).toEqual([])
		expect(send).not.toHaveBeenCalled()

		const { pay } = await payOnline(orderId)
		expect((await pay()).ok).toBe(true)
		await orderMessagesIdle()
		expect(await rows(orderId)).toEqual([
			expect.objectContaining({ kind: 'receipt', status: 'sent' }),
		])
		expect(send).toHaveBeenCalledTimes(1)

		expect((await pay()).ok).toBe(true)
		await orderMessagesIdle()
		expect(await rows(orderId)).toHaveLength(1)
		expect(send).toHaveBeenCalledTimes(1)
	})

	it('sends nothing for an online order whose payment failed (cancelled by the event)', async () => {
		const orderId = await placed({ paymentMethod: 'online' })
		const { event } = await payOnline(orderId)
		const failed = await applyPaymentEvent({ ...event, status: 'failed' })
		expect(failed.ok).toBe(true)
		await orderMessagesIdle()
		expect(await rows(orderId)).toEqual([])
		expect(send).not.toHaveBeenCalled()
	})

	it('marks ready: one email, and one text only with the opt-in on the US node', async () => {
		const optedIn = await placed({ smsUpdates: true })
		await setStatus(optedIn, 'ready')
		const readyRows = (await rows(optedIn)).filter(
			(row) => row.kind === 'ready',
		)
		expect(readyRows.map((row) => [row.channel, row.status]).sort()).toEqual([
			['email', 'sent'],
			['sms', 'sent'],
		])
		expect(sms).toHaveBeenCalledTimes(1)
		const text = sms.mock.calls[0]![0]
		// The number as stored on the order (normalized at checkout).
		expect(text.to).toBe('+15551234567')
		expect(text.message).toMatch(
			/^Your order \S+ from Rana’s Kitchen is ready\. https:\/\/test-org\.example\.com\/menu\/success\?order=/,
		)

		const notOptedIn = await placed()
		await setStatus(notOptedIn, 'ready')
		const plain = await rows(notOptedIn)
		expect(plain.filter((row) => row.channel === 'sms')).toEqual([])
		expect(plain.filter((row) => row.kind === 'ready')).toHaveLength(1)
		expect(sms).toHaveBeenCalledTimes(1)
	})

	it('sends the ready message when the kitchen screen makes an online order Ready', async () => {
		const orderId = await placed({ smsUpdates: true })
		const db = await getTenantDb(orgId)
		const actor = {
			orgId,
			locationId: 'loc-1',
			deviceId: 'kds-1',
			staffId: null,
		}
		const feed = await kitchenFeed(db, orgId, 'loc-1')
		const ticket = feed.tickets.find(
			(entry) => entry.source === 'online' && entry.id === orderId,
		)!
		await kitchenCommand(db, actor, {
			source: 'online',
			orderId,
			expectedVersion: ticket.version,
			action: 'stage',
			stage: 'ready',
		})
		await orderMessagesIdle()
		expect((await orderRow(orderId)).status).toBe('ready')
		const ready = (await rows(orderId)).filter((row) => row.kind === 'ready')
		expect(ready.map((row) => [row.channel, row.status]).sort()).toEqual([
			['email', 'sent'],
			['sms', 'sent'],
		])
	})

	it('never sends a kind twice when the status goes back and forth', async () => {
		const orderId = await placed({ smsUpdates: true })
		await setStatus(orderId, 'ready')
		const sends = send.mock.calls.length
		const db = await getTenantDb(orgId)
		const order = await orderRow(orderId)
		// The kitchen moves it back and makes it Ready again.
		await queueOrderStatusMessages(db, order, 'ready', 'preparing', {
			now: Date.now(),
		})
		const again = await queueOrderStatusMessages(
			db,
			order,
			'preparing',
			'ready',
			{
				now: Date.now(),
			},
		)
		expect(again).toEqual([])
		await runOrderMessagesTickForOrg(orgId, { now: Date.now() + 3_600_000 })
		expect(
			(await rows(orderId)).filter((row) => row.kind === 'ready'),
		).toHaveLength(2)
		expect(send.mock.calls.length).toBe(sends)
		expect(sms).toHaveBeenCalledTimes(1)
	})

	it('never inserts a text row on the KSA node, even with smsUpdates', async () => {
		region = 'ksa'
		vi.stubEnv('DATA_REGION', 'ksa')
		syncEnvFromProcess()
		const orderId = await placed({ smsUpdates: true })
		expect((await orderRow(orderId)).smsUpdatesOptIn).toBe(false)
		await setStatus(orderId, 'ready')
		const all = await rows(orderId)
		expect(all.some((row) => row.channel === 'sms')).toBe(false)
		expect(all.filter((row) => row.kind === 'ready')).toHaveLength(1)
		// Even an order that somehow carries the opt-in gets no text row here.
		const db = await getTenantDb(orgId)
		await db
			.update(restaurantOrders)
			.set({ smsUpdatesOptIn: true })
			.where(eq(restaurantOrders.id, orderId))
		await queueEtaChangedMessage(db, await orderRow(orderId), {
			now: Date.now(),
		})
		expect((await rows(orderId)).some((row) => row.channel === 'sms')).toBe(
			false,
		)
		expect(sms).not.toHaveBeenCalled()
	})

	it('queues nothing while the flag is off or the context field is missing or malformed', async () => {
		for (const value of [
			undefined,
			{ enabled: false, receipt: true, ready: true, cancelled: true },
			{ enabled: true },
			'yes',
		]) {
			guestMessages = value
			const orderId = await placed({ smsUpdates: true })
			const order = await orderRow(orderId)
			expect(order.guestMessages).toBeNull()
			expect(order.smsUpdatesOptIn).toBe(false)
			await setStatus(orderId, 'ready')
			expect(await rows(orderId)).toEqual([])
		}
		expect(send).not.toHaveBeenCalled()
	})

	it('honors each switch: no receipt when it is off, ready still goes', async () => {
		guestMessages = {
			enabled: true,
			receipt: false,
			ready: true,
			cancelled: false,
		}
		const orderId = await placed()
		expect(await rows(orderId)).toEqual([])
		await setStatus(orderId, 'ready')
		expect((await rows(orderId)).map((row) => row.kind)).toEqual(['ready'])
		await setStatus(orderId, 'cancelled')
		expect((await rows(orderId)).map((row) => row.kind)).toEqual(['ready'])
	})

	it('drops email while ORDERS_EMAIL_ENABLED is false and sends no backlog when it is back on', async () => {
		vi.stubEnv('ORDERS_EMAIL_ENABLED', 'false')
		const orderId = await placed()
		expect(await rows(orderId)).toEqual([
			expect.objectContaining({
				kind: 'receipt',
				status: 'dropped',
				lastError: 'email_disabled',
			}),
		])

		// A message queued while it was on, still waiting when it is switched off.
		vi.stubEnv('ORDERS_EMAIL_ENABLED', '')
		send.mockResolvedValueOnce({ status: 'error' } as never)
		await setStatus(orderId, 'ready')
		expect(
			(await rows(orderId)).find((row) => row.kind === 'ready'),
		).toMatchObject({ status: 'queued', attempts: 1 })
		vi.stubEnv('ORDERS_EMAIL_ENABLED', 'off')
		await runOrderMessagesTickForOrg(orgId, { now: Date.now() + 3_600_000 })
		expect(
			(await rows(orderId)).find((row) => row.kind === 'ready'),
		).toMatchObject({ status: 'dropped', lastError: 'email_disabled' })

		vi.stubEnv('ORDERS_EMAIL_ENABLED', 'true')
		const callsBefore = send.mock.calls.length
		const tick = await runOrderMessagesTickForOrg(orgId, {
			now: Date.now() + 7_200_000,
		})
		expect(tick).toMatchObject({ sent: 0, needsFollowUp: false })
		expect(send.mock.calls.length).toBe(callsBefore)
	})

	it('keeps the order when the transport fails, then the tick retries with backoff and sends', async () => {
		send.mockResolvedValueOnce({ status: 'error' } as never)
		const before = Date.now()
		const res = await placeOrder()
		expect(res.status).toBe(201)
		const { order } = (await res.json()) as { order: { id: string } }
		const [row] = await rows(order.id)
		expect(row).toMatchObject({
			status: 'queued',
			attempts: 1,
			lastError: 'email_failed',
		})
		expect(row!.nextAttemptAt).toBeGreaterThanOrEqual(before + 60_000)

		// Not due yet: nothing is sent, and the tick asks to be woken again.
		const early = await runOrderMessagesTickForOrg(orgId, {
			now: before + 1_000,
		})
		expect(early).toMatchObject({ sent: 0, needsFollowUp: true })
		expect(early.nextDueAt).toBe(row!.nextAttemptAt)

		const later = await runOrderMessagesTickForOrg(orgId, {
			now: row!.nextAttemptAt + 1,
		})
		expect(later).toMatchObject({
			sent: 1,
			needsFollowUp: false,
			nextDueAt: null,
		})
		expect((await rows(order.id))[0]).toMatchObject({
			status: 'sent',
			attempts: 2,
			lastError: null,
		})
		expect(send).toHaveBeenCalledTimes(2)
	})

	it('gives up after the last backoff step with a machine code', async () => {
		send.mockResolvedValue({ status: 'error' } as never)
		const orderId = await placed()
		let now = Date.now()
		for (let step = 0; step < 4; step++) {
			now += 3 * 60 * 60 * 1000
			await runOrderMessagesTickForOrg(orgId, { now })
		}
		expect((await rows(orderId))[0]).toMatchObject({
			status: 'failed',
			attempts: 5,
			lastError: 'email_failed',
		})
	})

	it('drops a text over the daily cap and still sends the email', async () => {
		expect(ORDER_SMS_DAILY_CAP).toBe(200)
		setOrderMessageSendDepsForTest({
			getContext: async () => ORG_CONTEXT,
			sendSms: sms,
			smsDailyCap: 1,
		})
		const first = await placed({ smsUpdates: true })
		await setStatus(first, 'ready')
		const second = await placed({ smsUpdates: true })
		await setStatus(second, 'ready')
		const secondRows = (await rows(second)).filter(
			(row) => row.kind === 'ready',
		)
		expect(
			secondRows.map((row) => [row.channel, row.status, row.lastError]).sort(),
		).toEqual([
			['email', 'sent', null],
			['sms', 'dropped', 'sms_daily_cap'],
		])
		expect(sms).toHaveBeenCalledTimes(1)
		expect((await orderRow(second)).status).toBe('ready')
	})

	it('drops a message whose order lost its contact (erased) before it went out', async () => {
		send.mockResolvedValueOnce({ status: 'error' } as never)
		const orderId = await placed()
		const db = await getTenantDb(orgId)
		await db
			.update(restaurantOrders)
			.set({ contactEmail: null })
			.where(eq(restaurantOrders.id, orderId))
		await runOrderMessagesTickForOrg(orgId, { now: Date.now() + 3_600_000 })
		expect((await rows(orderId))[0]).toMatchObject({
			status: 'dropped',
			lastError: 'no_contact',
		})
	})

	it('queues nothing without an email and no opt-in, and the order still succeeds', async () => {
		const orderId = await placed({ contact: { name: 'Rana', phone: PHONE } })
		await setStatus(orderId, 'ready')
		expect(await rows(orderId)).toEqual([])
	})

	it('refuses smsUpdates on a table round and never queues for a dine-in or tab order', async () => {
		const res = await placeOrder({
			fulfillment: 'dine_in',
			smsUpdates: true,
			contact: {},
		})
		expect(res.status).toBe(400)
		expect(await res.json()).toMatchObject({ error: 'invalid_request' })

		const orderId = await placed()
		const order = await orderRow(orderId)
		const db = await getTenantDb(orgId)
		for (const round of [
			{
				...order,
				id: orderId,
				fulfillment: 'dine_in' as const,
				tabId: 'tab_1',
			},
			{ ...order, tableId: 'table_1' },
		]) {
			expect(
				await queueOrderMessage(db, round, 'ready', { now: Date.now() }),
			).toEqual([])
		}
		expect((await rows(orderId)).filter((row) => row.kind === 'ready')).toEqual(
			[],
		)
	})

	it('writes Arabic orders in Arabic, right to left', async () => {
		const orderId = await placed({ locale: 'ar' })
		const mail = send.mock.calls[0]![0]
		expect(mail.subject).toContain('طلبك')
		expect(mail.html).toContain('<html lang="ar" dir="rtl">')
		expect(mail.html).toContain('برجر')
		expect(mail.html).toContain('عرض طلبك')
		expect(mail.text).toContain(orderId)
	})

	it('shows the refund on the cancelled email when the order records one', async () => {
		const orderId = await placed()
		const db = await getTenantDb(orgId)
		await db
			.update(restaurantOrders)
			.set({ refundedCents: 500 })
			.where(eq(restaurantOrders.id, orderId))
		await setStatus(orderId, 'cancelled')
		const mail = send.mock.calls.at(-1)![0]
		expect(mail.subject).toMatch(/^Your order \S+ was cancelled$/)
		expect(mail.text).toContain('Refunded: $5.00')
	})

	it('resends the receipt on demand, outside the once-per-kind queue', async () => {
		const orderId = await placed()
		expect(await sendOrderReceiptNow(orgId, orderId)).toBe('sent')
		expect(send).toHaveBeenCalledTimes(2)
		expect(await sendOrderReceiptNow(orgId, 'missing')).toBe('not_found')
		vi.stubEnv('ORDERS_EMAIL_ENABLED', '0')
		expect(await sendOrderReceiptNow(orgId, orderId)).toBe('disabled')
	})
})

describe('order email rendering', () => {
	const order = {
		number: '20261113-0001',
		fulfillment: 'delivery' as const,
		locationName: 'Main Street',
		currency: 'USD',
		subtotalCents: 2000,
		taxCents: 165,
		deliveryFeeCents: 500,
		deliveryDiscountCents: 0,
		tipCents: 0,
		totalCents: 2665,
		discountCents: 0,
		loyaltyDiscountCents: 0,
		refundedCents: 0,
		lines: [
			{
				itemId: 'i',
				itemName: '<b>Pizza</b>',
				variantId: null,
				quantity: 1,
				unitPriceCents: 2000,
				taxableUnitCents: 2000,
				totalCents: 2000,
				taxableCents: 2000,
				instructions: 'No <script>',
				options: [
					{
						groupId: 'g',
						groupName: 'Extras',
						optionId: 'o',
						optionName: 'Olives',
						half: null,
						quantity: 2,
						priceCents: 0,
						totalCents: 0,
					},
				],
				baseUnitCents: 2000,
				categoryIds: [],
			},
		],
		scheduledFor: null,
		pickupDate: null,
		pickupTime: null,
		promisedAt: new Date('2026-11-13T18:00:00Z'),
		promisedUntil: new Date('2026-11-13T18:30:00Z'),
	}

	it('escapes menu and guest text, keeps the subject free of contact data, and shows the promised range', () => {
		const rendered = renderOrderEmail({
			kind: 'receipt',
			locale: 'en',
			theme: null,
			restaurantName: 'Acme',
			order,
			timeZone: 'UTC',
			linkUrl: 'https://acme.example.com/menu/success?order=o#link=abc',
		})
		expect(rendered.subject).toBe('Your order 20261113-0001 from Acme')
		expect(rendered.html).not.toContain('<b>Pizza</b>')
		expect(rendered.html).toContain('&lt;b&gt;Pizza&lt;/b&gt;')
		expect(rendered.html).not.toContain('<script>')
		expect(rendered.html).toContain('2x Olives')
		expect(rendered.text).toMatch(/Arriving 6:00\sPM to 6:30\sPM/)
		expect(rendered.text).toContain('Delivery fee: $5.00')
		expect(rendered.html).toContain('dir="ltr"')
	})

	it('reads "Ready around" for a pickup with a promised time', () => {
		const rendered = renderOrderEmail({
			kind: 'receipt',
			locale: 'en',
			theme: null,
			restaurantName: 'Acme',
			order: { ...order, fulfillment: 'pickup', promisedUntil: null },
			timeZone: 'UTC',
			linkUrl: null,
		})
		expect(rendered.text).toMatch(/Pickup time: Ready around 6:00\sPM/)
		expect(rendered.html).not.toContain('View your order')
	})
})
