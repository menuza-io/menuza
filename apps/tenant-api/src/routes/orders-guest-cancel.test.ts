import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	destroyTenantDb,
	getTenantDb,
	kdsTickets,
	loyaltyIdempotencyKeys,
	loyaltyRateCounters,
	orderMessages,
	provisionTenantDb,
	restaurantOrderRefunds,
	restaurantOrders,
} from '@repo/tenant-db'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { seedLoyaltyContextForTest } from '../lib/loyalty-context.ts'
import {
	countOrderGuestCancelAttempt,
	ORDER_GUEST_CANCEL_LIMITS,
} from '../lib/order-guest-cancel-limits.ts'
import { deriveOrderLinkToken } from '../lib/order-link.ts'
import {
	orderRefundKicksIdle,
	setOrderRefundKickForTest,
} from '../lib/order-refund-kick.ts'
import { resolveOrganizationForBrowserAuth } from '../lib/origin.ts'
import { syncEnvFromProcess } from '../lib/secrets.ts'
import { insertOrder, insertTab } from '../services/loyalty-test-fixture.ts'
import { clearGuestCancelViewCacheForTest } from '../services/order-guest-cancel.ts'
import { orderLinkResendsIdle } from '../services/order-link-access.ts'
import { setOrderMessageSendDepsForTest } from '../services/order-message-send.ts'
import { orderMessagesIdle } from '../services/order-messages.ts'
import { deriveReceiptToken } from '../services/order-service.ts'
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

const ORG = 'org_guest_cancel_a'
const ORG_B = 'org_guest_cancel_b'
const ORIGIN = 'https://test-org.example.com'
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
const GUEST_MESSAGES = {
	enabled: true,
	receipt: true,
	ready: true,
	cancelled: true,
}

let guestCancel: unknown
let drop: unknown
let contextStatus: number
let contextCalls: number

function menuContext(orgId: string) {
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
					taxRate: 0,
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
		drop,
		onlinePayment: { enabled: true, processor: 'connect' },
		guestMessages: GUEST_MESSAGES,
		guestCancel,
	}
}

function dropContext(ordersCloseAt: string | null, status = 'live') {
	return {
		organization: { id: ORG, slug: 'test-org', currency: 'USD' },
		drop: {
			id: 'drop-1',
			title: 'Friday',
			slug: 'friday',
			status,
			ordersOpenAt: null,
			ordersCloseAt,
			menu: { id: 'menu-1' },
		},
		pickupWindows: [],
		inventoryOverrides: [],
		categories: [],
	}
}

function liveReceiptTokenHash(orgId: string, orderId: string) {
	return crypto
		.createHash('sha256')
		.update(deriveReceiptToken(orgId, orderId))
		.digest('hex')
}

let counter = 0
const kicks: Array<{ orgId: string; refundId: string }> = []

/** A paid online pickup order at loc-1 (total 1000), paid just now. */
async function onlineOrder(
	overrides: Parameters<typeof insertOrder>[1] = {},
	orgId = ORG,
) {
	const id = overrides.id ?? `ord_gc_${++counter}`
	const now = new Date()
	return insertOrder(orgId, {
		id,
		status: 'accepted',
		completedAt: null,
		locationId: 'loc-1',
		paymentProcessor: 'connect',
		paymentSessionId: `cs_gc_${counter}`,
		paidAt: now,
		createdAt: now,
		contactEmail: 'rana@example.com',
		guestMessages: GUEST_MESSAGES,
		receiptTokenHash: liveReceiptTokenHash(orgId, id),
		...overrides,
	})
}

async function handoffOrder(overrides: Parameters<typeof insertOrder>[1] = {}) {
	return onlineOrder({
		paymentMethod: 'handoff',
		paymentStatus: 'unpaid',
		paymentProcessor: null,
		paymentSessionId: null,
		paidAt: null,
		...overrides,
	})
}

const receipt = (orderId: string, orgId = ORG) => ({
	Authorization: `Bearer ${deriveReceiptToken(orgId, orderId)}`,
})
const link = (orderId: string, orgId = ORG) => ({
	'X-Order-Link': deriveOrderLinkToken(orgId, orderId),
})

let app: Hono
let directory: string

async function check(
	orderId: string,
	headers: Record<string, string>,
	slug = 'test-org',
) {
	return app.request(`/orders/${orderId}/cancel?slug=${slug}`, {
		headers: { origin: ORIGIN, ...headers },
	})
}

async function cancel(
	orderId: string,
	headers: Record<string, string>,
	options: { key?: string | null; slug?: string } = {},
) {
	const key =
		options.key === undefined ? `cancel-key-${++counter}` : options.key
	const res = await app.request(`/orders/${orderId}/cancel`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			origin: ORIGIN,
			...(key === null ? {} : { 'Idempotency-Key': key }),
			...headers,
		},
		body: JSON.stringify({ slug: options.slug ?? 'test-org' }),
	})
	await orderMessagesIdle()
	await orderRefundKicksIdle()
	return res
}

async function orderRow(orderId: string, orgId = ORG) {
	const db = await getTenantDb(orgId)
	const [row] = await db
		.select()
		.from(restaurantOrders)
		.where(eq(restaurantOrders.id, orderId))
	return row!
}

async function refundRows(orderId: string) {
	const db = await getTenantDb(ORG)
	return db
		.select()
		.from(restaurantOrderRefunds)
		.where(eq(restaurantOrderRefunds.orderId, orderId))
}

async function cancelledMessages(orderId: string) {
	const db = await getTenantDb(ORG)
	return db
		.select()
		.from(orderMessages)
		.where(
			and(
				eq(orderMessages.orderId, orderId),
				eq(orderMessages.kind, 'cancelled'),
			),
		)
}

async function startKitchen(
	orderId: string,
	progress: Record<string, unknown>,
) {
	const db = await getTenantDb(ORG)
	await db.insert(kdsTickets).values({
		source: 'online',
		orderId,
		locationId: 'loc-1',
		version: 1,
		progress: progress as never,
		updatedAt: Date.now(),
	})
}

beforeEach(async () => {
	guestCancel = { 'loc-1': { minutes: 2, scheduledLeadMinutes: null } }
	drop = null
	contextStatus = 200
	contextCalls = 0
	kicks.length = 0
	clearGuestCancelViewCacheForTest()
	directory = fs.mkdtempSync(path.join(os.tmpdir(), 'order-guest-cancel-'))
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
	setOrderMessageSendDepsForTest({ getContext: async () => null as never })
	setOrderRefundKickForTest(async (request) => {
		kicks.push(request)
		return { status: 'sent' }
	})
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(typeof input === 'string' ? input : input.toString())
			if (url.pathname === '/resources/order-context') {
				contextCalls += 1
				if (contextStatus !== 200) {
					return new Response('unavailable', { status: contextStatus })
				}
				return Response.json(menuContext(url.searchParams.get('orgId')!))
			}
			return new Response('not found', { status: 404 })
		}),
	)
	vi.mocked(resolveOrganizationForBrowserAuth).mockImplementation(
		async (_origin, identity) => {
			const id =
				identity?.slug === 'test-org'
					? ORG
					: identity?.slug === 'other-org'
						? ORG_B
						: null
			return id
				? ({
						id,
						slug: identity!.slug,
						customDomain: null,
						hasProvisionedDb: true,
						dataRegion: 'us',
					} as never)
				: null
		},
	)
	for (const id of [ORG, ORG_B]) {
		await provisionTenantDb(id)
		seedLoyaltyContextForTest(id, { enabled: false, redemption: false })
	}
	app = new Hono()
	app.route('/orders', publicOrderRoutes)
})

afterEach(async () => {
	vi.useRealTimers()
	await orderLinkResendsIdle()
	await orderMessagesIdle()
	await orderRefundKicksIdle()
	setOrderRefundKickForTest(null)
	setOrderMessageSendDepsForTest(null)
	for (const id of [ORG, ORG_B]) await destroyTenantDb(id).catch(() => {})
	fs.rmSync(directory, { recursive: true, force: true })
	vi.unstubAllEnvs()
	vi.unstubAllGlobals()
})

describe('guest cancel: happy paths', () => {
	it('a handoff order: the receipt offers it, the guest cancels, the cancelled message is queued once', async () => {
		const orderId = await handoffOrder()

		const receiptRead = await app.request(`/orders/${orderId}?slug=test-org`, {
			headers: { origin: ORIGIN, ...receipt(orderId) },
		})
		const { order: before } = (await receiptRead.json()) as {
			order: { cancel?: { allowed: boolean; until: string | null } }
		}
		expect(before.cancel?.allowed).toBe(true)
		expect(Date.parse(before.cancel!.until!)).toBeGreaterThan(Date.now())

		const state = await check(orderId, receipt(orderId))
		expect(state.status).toBe(200)
		expect(state.headers.get('cache-control')).toBe('no-store')
		const stateBody = (await state.json()) as Record<string, unknown>
		expect(stateBody).toEqual({
			allowed: true,
			until: before.cancel!.until,
			reason: null,
		})

		const res = await cancel(orderId, receipt(orderId))
		expect(res.status).toBe(200)
		expect(res.headers.get('cache-control')).toBe('no-store')
		expect(await res.json()).toEqual({
			allowed: false,
			until: before.cancel!.until,
			reason: null,
			status: 'cancelled',
			refund: { status: 'none', amountCents: 0 },
		})
		const row = await orderRow(orderId)
		expect(row.status).toBe('cancelled')
		expect(row.cancelledBy).toBe('guest')
		expect(row.cancelReason).toBe('guest_asked')
		expect(row.cancelledAt).not.toBeNull()
		expect(await refundRows(orderId)).toEqual([])
		expect(kicks).toEqual([])
		expect(await cancelledMessages(orderId)).toHaveLength(1)

		// The receipt now shows who cancelled and no longer offers it.
		const after = await app.request(`/orders/${orderId}?slug=test-org`, {
			headers: { origin: ORIGIN, ...receipt(orderId) },
		})
		expect(((await after.json()) as { order: unknown }).order).toMatchObject({
			status: 'cancelled',
			cancelledBy: 'guest',
			cancelReason: null,
			cancel: { allowed: false, until: null },
		})
	})

	it('a paid online order by the order link: one full provider refund, the kick, one message; a replay changes nothing', async () => {
		const orderId = await onlineOrder()
		const key = 'guest-cancel-key-1'

		const res = await cancel(orderId, link(orderId), { key })
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body).toMatchObject({
			allowed: false,
			reason: null,
			status: 'cancelled',
			refund: { status: 'pending', amountCents: 1000 },
		})
		expect(res.headers.get('idempotent-replayed')).toBeNull()

		const refunds = await refundRows(orderId)
		expect(refunds).toHaveLength(1)
		expect(refunds[0]).toMatchObject({
			kind: 'provider',
			status: 'pending',
			origin: 'guest',
			actorId: 'guest',
			amountCents: 1000,
			full: true,
			idempotencyKey: `cancel:${orderId}`,
			sessionId: expect.stringMatching(/^cs_gc_/),
		})
		expect(kicks).toEqual([{ orgId: ORG, refundId: refunds[0]!.id }])
		expect(await cancelledMessages(orderId)).toHaveLength(1)
		const row = await orderRow(orderId)
		expect(row).toMatchObject({
			status: 'cancelled',
			cancelledBy: 'guest',
			cancelReason: 'guest_asked',
			refundedCents: 0,
		})

		// The same key (a lost answer): the same body, nothing new.
		const replay = await cancel(orderId, link(orderId), { key })
		expect(replay.status).toBe(200)
		expect(replay.headers.get('idempotent-replayed')).toBe('true')
		expect(await replay.json()).toEqual(body)
		expect(await refundRows(orderId)).toHaveLength(1)
		expect(kicks).toHaveLength(1)
		expect(await cancelledMessages(orderId)).toHaveLength(1)

		// The receipt token replays the same key too (same order, same answer).
		const byReceipt = await cancel(orderId, receipt(orderId), { key })
		expect(await byReceipt.json()).toEqual(body)

		// A new tap (another key) on a cancelled order is refused.
		const again = await cancel(orderId, link(orderId))
		expect(again.status).toBe(409)
		expect(await again.json()).toMatchObject({
			error: 'not_cancellable',
			allowed: false,
			reason: 'not_cancellable',
		})
		expect(await refundRows(orderId)).toHaveLength(1)

		// The link view shows the refund on its way, never contact details.
		const view = await app.request(`/orders/${orderId}?slug=test-org`, {
			headers: { origin: ORIGIN, ...link(orderId) },
		})
		const viewBody = (await view.json()) as { order: Record<string, unknown> }
		expect(viewBody.order).toMatchObject({
			cancelledBy: 'guest',
			refundStatus: 'pending',
			refundPendingCents: 1000,
			cancel: { allowed: false, until: null },
		})
		expect(viewBody.order).not.toHaveProperty('contact')
	})

	it('a free online order (nothing paid) is cancelled with no refund', async () => {
		const orderId = await onlineOrder({ paymentStatus: 'not_required' })
		const res = await cancel(orderId, receipt(orderId))
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({
			status: 'cancelled',
			refund: { status: 'none', amountCents: 0 },
		})
		expect(await refundRows(orderId)).toEqual([])
		expect(kicks).toEqual([])
	})

	it('an order waiting for acceptance can be cancelled by the guest', async () => {
		const orderId = await onlineOrder({ status: 'pending_acceptance' })
		const res = await cancel(orderId, receipt(orderId))
		expect(res.status).toBe(200)
		const row = await orderRow(orderId)
		expect(row).toMatchObject({
			status: 'cancelled',
			cancelledBy: 'guest',
			rejectedReason: null,
		})
		expect(await refundRows(orderId)).toHaveLength(1)
	})
})

describe('guest cancel: capabilities', () => {
	it('refuses another order’s token, another organization, malformed, expired and missing credentials with the uniform 404', async () => {
		const orderId = await handoffOrder()
		const otherId = await handoffOrder()
		const old = new Date(Date.now() - 91 * 24 * 60 * MIN)
		const expiredId = await handoffOrder({ createdAt: old })

		const refused: Array<[string, Record<string, string>, string?]> = [
			[orderId, receipt(otherId)],
			[orderId, link(otherId)],
			[orderId, receipt(orderId, ORG_B)],
			[orderId, link(orderId, ORG_B)],
			// The right token sent to the other organization.
			[orderId, receipt(orderId), 'other-org'],
			[orderId, link(orderId), 'other-org'],
			[orderId, { 'X-Order-Link': 'not-a-token' }],
			[
				orderId,
				{ 'X-Order-Link': link(orderId)['X-Order-Link'].toUpperCase() },
			],
			[orderId, { Authorization: 'Bearer forged' }],
			[expiredId, link(expiredId)],
			[orderId, {}],
		]
		for (const [id, headers, slug] of refused) {
			const read = await check(id, headers, slug)
			expect(read.status, JSON.stringify(headers)).toBe(404)
			expect(await read.json()).toEqual({
				error: 'order_not_found',
				message: 'Order not found.',
			})
			const write = await cancel(id, headers, { slug })
			expect(write.status, JSON.stringify(headers)).toBe(404)
			expect(await write.json()).toEqual({
				error: 'order_not_found',
				message: 'Order not found.',
			})
		}
		expect((await orderRow(orderId)).status).toBe('accepted')
		// Refused credentials never spend the order's or the address's budget.
		const db = await getTenantDb(ORG)
		expect(await db.select().from(loyaltyRateCounters)).toEqual([])
		expect(contextCalls).toBe(0)
	})

	it('needs an Idempotency-Key on POST', async () => {
		const orderId = await handoffOrder()
		for (const key of [null, 'short', 'has space in it']) {
			const res = await cancel(orderId, receipt(orderId), { key })
			expect(res.status).toBe(400)
			expect(await res.json()).toMatchObject({
				error: 'idempotency_key_required',
			})
		}
		expect((await orderRow(orderId)).status).toBe('accepted')
	})
})

describe('guest cancel: the rule', () => {
	it('after the kitchen started a dish: 409 order_in_preparation, and the receipt hides it', async () => {
		const orderId = await onlineOrder()
		await startKitchen(orderId, { dishA: 'new', dishB: 'preparing' })
		const read = await check(orderId, receipt(orderId))
		expect(await read.json()).toMatchObject({
			allowed: false,
			reason: 'order_in_preparation',
		})
		const res = await cancel(orderId, receipt(orderId))
		expect(res.status).toBe(409)
		expect(await res.json()).toMatchObject({
			error: 'order_in_preparation',
			allowed: false,
			reason: 'order_in_preparation',
		})
		expect((await orderRow(orderId)).status).toBe('accepted')
		expect(await refundRows(orderId)).toEqual([])
		const view = await app.request(`/orders/${orderId}?slug=test-org`, {
			headers: { origin: ORIGIN, ...receipt(orderId) },
		})
		expect(((await view.json()) as { order: unknown }).order).toMatchObject({
			cancel: { allowed: false, until: null },
		})

		// A ticket still all New does not count as started.
		const fresh = await onlineOrder()
		await startKitchen(fresh, { dishA: 'new' })
		expect((await cancel(fresh, receipt(fresh))).status).toBe(200)

		// An order the kitchen moved to preparing reads the same.
		const preparing = await onlineOrder({ status: 'preparing' })
		const prepRes = await cancel(preparing, receipt(preparing))
		expect(prepRes.status).toBe(409)
		expect(await prepRes.json()).toMatchObject({
			error: 'order_in_preparation',
		})
	})

	it('after the window: 409 cancel_window_closed', async () => {
		const paidAt = new Date(Date.now() - 3 * MIN)
		const orderId = await onlineOrder({ paidAt, createdAt: paidAt })
		const read = await check(orderId, receipt(orderId))
		expect(await read.json()).toEqual({
			allowed: false,
			until: new Date(
				Math.floor(paidAt.getTime() / 1000) * 1000 + 2 * MIN,
			).toISOString(),
			reason: 'cancel_window_closed',
		})
		const res = await cancel(orderId, receipt(orderId))
		expect(res.status).toBe(409)
		expect(await res.json()).toMatchObject({ error: 'cancel_window_closed' })
		expect((await orderRow(orderId)).status).toBe('accepted')
	})

	it('flag off or the location Off: disabled, refused, and the receipt does not offer it', async () => {
		for (const value of [
			{},
			undefined,
			{ 'loc-2': { minutes: 5, scheduledLeadMinutes: null } },
			{ 'loc-1': { minutes: 3, scheduledLeadMinutes: null } },
		]) {
			guestCancel = value
			clearGuestCancelViewCacheForTest()
			const orderId = await handoffOrder()
			const read = await check(orderId, receipt(orderId))
			expect(await read.json()).toEqual({
				allowed: false,
				until: null,
				reason: 'disabled',
			})
			const res = await cancel(orderId, link(orderId))
			expect(res.status).toBe(409)
			expect(await res.json()).toMatchObject({
				error: 'guest_cancel_disabled',
				reason: 'disabled',
			})
			const view = await app.request(`/orders/${orderId}?slug=test-org`, {
				headers: { origin: ORIGIN, ...link(orderId) },
			})
			expect(((await view.json()) as { order: unknown }).order).toMatchObject({
				cancel: { allowed: false, until: null },
			})
			expect((await orderRow(orderId)).status).toBe('accepted')
		}
	})

	it('dine-in, QR table rounds and tab rounds are not the guest’s to cancel', async () => {
		const tabId = await insertTab(ORG, { status: 'open' })
		for (const overrides of [
			{ fulfillment: 'dine_in' as const },
			{ source: 'qr_table' as const },
			{ fulfillment: 'dine_in' as const, tabId },
		]) {
			const orderId = await handoffOrder(overrides)
			const res = await cancel(orderId, receipt(orderId))
			expect(res.status).toBe(409)
			expect(await res.json()).toMatchObject({ error: 'not_cancellable' })
			expect((await orderRow(orderId)).status).toBe('accepted')
		}
	})

	it('an order already cancelled by the restaurant, or an unpaid online one, is refused', async () => {
		const cancelled = await onlineOrder({
			status: 'cancelled',
			cancelledAt: new Date(),
			cancelledBy: 'operator',
			cancelReason: 'out_of_stock',
		})
		const res = await cancel(cancelled, receipt(cancelled))
		expect(res.status).toBe(409)
		expect(await res.json()).toMatchObject({ error: 'not_cancellable' })
		expect((await orderRow(cancelled)).cancelledBy).toBe('operator')

		const unpaid = await onlineOrder({
			paymentStatus: 'pending',
			paidAt: null,
			holdExpiresAt: new Date(Date.now() + 10 * MIN),
		})
		const unpaidRes = await cancel(unpaid, receipt(unpaid))
		expect(unpaidRes.status).toBe(409)
		expect(await unpaidRes.json()).toMatchObject({ error: 'not_cancellable' })
	})

	it('a scheduled order: until the lead before its time, never less than the ASAP window', async () => {
		guestCancel = { 'loc-1': { minutes: 2, scheduledLeadMinutes: 60 } }
		const paidAt = new Date(Date.now() - 30 * MIN)
		const scheduledFor = new Date(
			Math.floor((Date.now() + 120 * MIN) / 1000) * 1000,
		)
		const orderId = await onlineOrder({
			paidAt,
			createdAt: paidAt,
			scheduledFor,
		})
		const read = await check(orderId, receipt(orderId))
		expect(await read.json()).toEqual({
			allowed: true,
			until: new Date(scheduledFor.getTime() - 60 * MIN).toISOString(),
			reason: null,
		})

		// Inside the lead already: closed.
		const soon = await onlineOrder({
			paidAt,
			createdAt: paidAt,
			scheduledFor: new Date(Date.now() + 45 * MIN),
		})
		const res = await cancel(soon, receipt(soon))
		expect(res.status).toBe(409)
		expect(await res.json()).toMatchObject({ error: 'cancel_window_closed' })

		expect((await cancel(orderId, receipt(orderId))).status).toBe(200)
	})

	it('a drop order closes at the drop’s cutoff', async () => {
		guestCancel = { 'loc-1': { minutes: 10, scheduledLeadMinutes: null } }
		drop = dropContext(new Date(Date.now() - MIN).toISOString(), 'live')
		const pastCutoff = await onlineOrder({ dropSlug: 'friday' })
		const res = await cancel(pastCutoff, receipt(pastCutoff))
		expect(res.status).toBe(409)
		expect(await res.json()).toMatchObject({ error: 'cancel_window_closed' })

		const cutoff = new Date(Math.floor((Date.now() + 3 * MIN) / 1000) * 1000)
		drop = dropContext(cutoff.toISOString(), 'live')
		const beforeCutoff = await onlineOrder({ dropSlug: 'friday' })
		const read = await check(beforeCutoff, receipt(beforeCutoff))
		expect(await read.json()).toEqual({
			allowed: true,
			until: cutoff.toISOString(),
			reason: null,
		})

		// A drop the context no longer has fails closed.
		drop = null
		const missing = await onlineOrder({ dropSlug: 'friday' })
		expect((await cancel(missing, receipt(missing))).status).toBe(409)
	})

	it('answers 503 when the order context cannot be read, and the receipt says no', async () => {
		const orderId = await handoffOrder()
		contextStatus = 503
		const read = await check(orderId, receipt(orderId))
		expect(read.status).toBe(503)
		const res = await cancel(orderId, receipt(orderId))
		expect(res.status).toBe(503)
		expect(await res.json()).toMatchObject({ error: 'ordering_unavailable' })
		expect((await orderRow(orderId)).status).toBe('accepted')
		const view = await app.request(`/orders/${orderId}?slug=test-org`, {
			headers: { origin: ORIGIN, ...receipt(orderId) },
		})
		expect(view.status).toBe(200)
		expect(((await view.json()) as { order: unknown }).order).toMatchObject({
			cancel: { allowed: false, until: null },
		})
	})

	it('an old order never asks the App for the receipt view', async () => {
		const old = new Date(Date.now() - 30 * MIN)
		const orderId = await handoffOrder({ createdAt: old })
		const view = await app.request(`/orders/${orderId}?slug=test-org`, {
			headers: { origin: ORIGIN, ...receipt(orderId) },
		})
		expect(((await view.json()) as { order: unknown }).order).toMatchObject({
			cancel: { allowed: false, until: null },
		})
		expect(contextCalls).toBe(0)
	})
})

describe('guest cancel: limits and storage', () => {
	it('limits attempts per order', async () => {
		const paidAt = new Date(Date.now() - 30 * MIN)
		const orderId = await onlineOrder({ paidAt, createdAt: paidAt })
		const { max } = ORDER_GUEST_CANCEL_LIMITS.cancelOrder
		for (let i = 0; i < max; i++) {
			expect((await cancel(orderId, receipt(orderId))).status).toBe(409)
		}
		const limited = await cancel(orderId, receipt(orderId))
		expect(limited.status).toBe(429)
		expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
		expect(await limited.json()).toMatchObject({
			error: 'rate_limit_exceeded',
		})
		// Another order keeps its own budget.
		const other = await handoffOrder()
		expect((await cancel(other, receipt(other))).status).toBe(200)
	})

	it('counts per address in a sliding window, and each bucket on its own', async () => {
		const db = await getTenantDb(ORG)
		const start = Date.UTC(2026, 10, 14, 12, 0, 30)
		const { max } = ORDER_GUEST_CANCEL_LIMITS.cancelAddress
		for (let i = 0; i < max; i++) {
			const result = await countOrderGuestCancelAttempt(
				db,
				'cancelAddress',
				`${ORG}:203.0.113.7`,
				start + i,
			)
			expect(result.ok).toBe(true)
		}
		const over = await countOrderGuestCancelAttempt(
			db,
			'cancelAddress',
			`${ORG}:203.0.113.7`,
			start + max,
		)
		expect(over).toEqual({ ok: false, retryAfterSeconds: expect.any(Number) })
		// Another address, and the read budget of the same address, are apart.
		expect(
			await countOrderGuestCancelAttempt(
				db,
				'cancelAddress',
				`${ORG}:203.0.113.8`,
				start + max,
			),
		).toEqual({ ok: true })
		expect(
			await countOrderGuestCancelAttempt(
				db,
				'checkAddress',
				`${ORG}:203.0.113.7`,
				start + max,
			),
		).toEqual({ ok: true })
		// Eleven minutes on, the window has slid past the burst.
		expect(
			await countOrderGuestCancelAttempt(
				db,
				'cancelAddress',
				`${ORG}:203.0.113.7`,
				start + 11 * MIN,
			),
		).toEqual({ ok: true })
		// Subjects are stored only as keyed hashes.
		const rows = await db.select().from(loyaltyRateCounters)
		expect(JSON.stringify(rows)).not.toContain('203.0.113')
	})

	it('stores only a hash of the key and an answer without personal data', async () => {
		const orderId = await onlineOrder()
		const key = 'guest-cancel-key-storage'
		expect((await cancel(orderId, receipt(orderId), { key })).status).toBe(200)
		const db = await getTenantDb(ORG)
		const rows = await db.select().from(loyaltyIdempotencyKeys)
		expect(rows).toHaveLength(1)
		expect(rows[0]!.scope).toBe(`order_guest_cancel:${orderId}`)
		expect(rows[0]!.key).not.toContain(key)
		expect(rows[0]!.memberId).toBeNull()
		expect(rows[0]!.responseJson).not.toContain('rana')
		expect(rows[0]!.responseJson).not.toContain('+1')
	})
})
