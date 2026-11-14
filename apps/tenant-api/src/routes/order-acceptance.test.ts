import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import {
	destroyTenantDb,
	discountRedemptions,
	getTenantDb,
	orderMessages,
	provisionTenantDb,
	restaurantOrderRefunds,
	restaurantOrders,
	type RestaurantOrder,
} from '@repo/tenant-db'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import * as jose from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeDiscount } from '../../../../packages/discounts/src/test-fixtures.ts'

import { seedLoyaltyContextForTest } from '../lib/loyalty-context.ts'
import {
	findActiveOrganizationById,
	resolveOrganizationForBrowserAuth,
} from '../lib/origin.ts'
import {
	orderRefundKicksIdle,
	setOrderRefundKickForTest,
} from '../lib/order-refund-kick.ts'
import { syncEnvFromProcess } from '../lib/secrets.ts'
import { kitchenFeed } from '../services/kds-service.ts'
import { insertOrder } from '../services/loyalty-test-fixture.ts'
import {
	fanOutOrderAcceptanceTick,
	processOrderAcceptance,
	runOrdersTickForOrg,
} from '../services/order-acceptance.ts'
import { linkReceiptOrder } from '../services/order-link-access.ts'
import { setOrderMessageSendDepsForTest } from '../services/order-message-send.ts'
import { orderMessagesIdle } from '../services/order-messages.ts'
import {
	applyPaymentEvent,
	deriveReceiptToken,
	operatorOrder,
	placementAcceptance,
	receiptOrder,
} from '../services/order-service.ts'
import { countedOrderCondition } from '../services/report-records.ts'
import { operatorOrderRoutes } from './operator-orders.ts'
import { publicOrderRoutes } from './orders.ts'

/**
 * Manual order acceptance (#107), region side: placement, the paid event,
 * accept and reject on `PATCH /operator/orders/:id`, the timeout tick, the
 * kitchen, capacity and the guest's views.
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

/** What order writes queue for inventory and loyalty (source ids). */
const queued = vi.hoisted(() => ({
	inventory: [] as string[],
	loyalty: [] as string[],
}))

vi.mock('../services/inventory-sales-service.ts', async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import('../services/inventory-sales-service.ts')
		>()
	return {
		...actual,
		inventorySaleQueue: () => {
			const inner = actual.inventorySaleQueue()
			return {
				...inner,
				queue: (async (...args: Parameters<typeof inner.queue>) => {
					queued.inventory.push(args[1].id)
					return inner.queue(...args)
				}) as typeof inner.queue,
			}
		},
	}
})

vi.mock('../services/loyalty-purchase-service.ts', async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import('../services/loyalty-purchase-service.ts')
		>()
	return {
		...actual,
		loyaltySettleQueue: () => {
			const inner = actual.loyaltySettleQueue()
			return {
				...inner,
				queue: (async (...args: Parameters<typeof inner.queue>) => {
					queued.loyalty.push(args[1].id)
					return inner.queue(...args)
				}) as typeof inner.queue,
			}
		},
	}
})

const ORG = 'org_acceptance_a'
const ORG_B = 'org_acceptance_b'
const SECRET = 'test-operator-secret-key-for-acceptance-32!!!'
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

let acceptance: unknown
let discounts: unknown
let drop: unknown
let guestCancel: unknown

const MANUAL = {
	'loc-1': {
		mode: 'manual',
		timeoutMinutes: 5,
		minTotalCents: null,
		scheduledOnly: false,
	},
}

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
		guestMessages: {
			enabled: true,
			receipt: true,
			ready: true,
			cancelled: true,
		},
		...(acceptance === undefined ? {} : { acceptance }),
		...(discounts === undefined ? {} : { discounts }),
		...(guestCancel === undefined ? {} : { guestCancel }),
	}
}

function dropContext(maxOrdersPerSlot: number) {
	return {
		organization: { id: ORG, slug: 'test-org', currency: 'USD' },
		drop: {
			id: 'drop-1',
			title: 'Friday BBQ',
			slug: 'friday-bbq',
			status: 'live',
			checkoutHoldMinutes: 10,
			menu: { id: 'menu-drop', displayName: 'BBQ', specialInstructions: true },
		},
		pickupWindows: [
			{
				id: 'win-1',
				locationId: 'loc-1',
				location: { id: 'loc-1', name: 'Main Street', timezone: 'UTC' },
				date: '2099-06-20',
				startTime: '17:00',
				endTime: '19:00',
				slotIntervalMinutes: 30,
				maxOrdersPerSlot,
				orderLeadTimeMinutes: 0,
				slots: [],
			},
		],
		inventoryOverrides: [],
		categories: [
			{
				id: 'cat-bbq',
				displayName: 'BBQ',
				availabilityStatus: 'available',
				items: [
					{
						id: 'item-brisket',
						displayName: 'Brisket Plate',
						price: 18,
						availabilityStatus: 'available',
					},
				],
			},
		],
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

async function operatorToken(claims: Record<string, unknown>) {
	const now = Math.floor(Date.now() / 1000)
	return new jose.SignJWT({ role: 'operator', orgId: ORG, ...claims })
		.setProtectedHeader({ alg: 'HS256' })
		.setSubject('usr_1')
		.setIssuer(brand.shortName)
		.setAudience('tenant-api-operator')
		.setIssuedAt(now)
		.setExpirationTime(now + 300)
		.sign(new TextEncoder().encode(SECRET))
}

const WRITE = { scope: 'orders:write' }
const at = (minutes: number) => new Date(NOW.getTime() + minutes * MIN)

describe('manual order acceptance (#107)', () => {
	let directory: string
	let app: Hono
	const kicks: Array<{ orgId: string; refundId: string }> = []

	async function placeRaw(overrides: Record<string, unknown> = {}) {
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

	async function place(overrides: Record<string, unknown> = {}) {
		const res = await placeRaw(overrides)
		expect(res.status).toBe(201)
		return ((await res.json()) as { order: { id: string } }).order.id
	}

	/** Places an online order and its paid event (session bound by hand). */
	async function placePaid(overrides: Record<string, unknown> = {}) {
		const id = await place({ paymentMethod: 'online', ...overrides })
		const db = await getTenantDb(ORG)
		await db
			.update(restaurantOrders)
			.set({ paymentSessionId: `cs_${id}` })
			.where(eq(restaurantOrders.id, id))
		const order = await row(id)
		const paid = await applyPaymentEvent({
			orgId: ORG,
			orderId: id,
			sessionId: `cs_${id}`,
			processor: 'connect',
			status: 'paid',
			amountCents: order.totalCents,
			currency: 'USD',
		})
		expect(paid.ok).toBe(true)
		await orderMessagesIdle()
		return id
	}

	async function row(orderId: string, orgId = ORG): Promise<RestaurantOrder> {
		const db = await getTenantDb(orgId)
		const [found] = await db
			.select()
			.from(restaurantOrders)
			.where(eq(restaurantOrders.id, orderId))
		return found!
	}

	async function patch(
		orderId: string,
		body: unknown,
		claims: Record<string, unknown> = WRITE,
	) {
		const res = await app.request(`/operator/orders/${orderId}`, {
			method: 'PATCH',
			headers: {
				'content-type': 'application/json',
				Authorization: `Bearer ${await operatorToken(claims)}`,
			},
			body: JSON.stringify(body),
		})
		await orderMessagesIdle()
		await orderRefundKicksIdle()
		return res
	}

	async function messages(orderId: string, kind: string) {
		const db = await getTenantDb(ORG)
		return db
			.select()
			.from(orderMessages)
			.where(
				and(eq(orderMessages.orderId, orderId), eq(orderMessages.kind, kind)),
			)
	}

	async function refunds(orderId: string) {
		const db = await getTenantDb(ORG)
		return db
			.select()
			.from(restaurantOrderRefunds)
			.where(eq(restaurantOrderRefunds.orderId, orderId))
	}

	async function redemptionStates(orderId: string) {
		const db = await getTenantDb(ORG)
		return (
			await db
				.select({ state: discountRedemptions.state })
				.from(discountRedemptions)
				.where(eq(discountRedemptions.sourceId, orderId))
		).map((entry) => entry.state)
	}

	async function inKitchen(orderId: string) {
		const db = await getTenantDb(ORG)
		const feed = await kitchenFeed(db, ORG, 'loc-1', Date.now())
		return feed.tickets.some((ticket) => ticket.id === orderId)
	}

	async function counted(orderId: string) {
		const db = await getTenantDb(ORG)
		const rows = await db
			.select({ id: restaurantOrders.id })
			.from(restaurantOrders)
			.where(and(eq(restaurantOrders.id, orderId), countedOrderCondition()))
		return rows.length === 1
	}

	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(NOW)
		acceptance = MANUAL
		discounts = undefined
		drop = null
		guestCancel = undefined
		queued.inventory.length = 0
		queued.loyalty.length = 0
		kicks.length = 0
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'order-acceptance-'))
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
		vi.stubEnv('DISCOUNTS_ENABLED', 'true')
		syncEnvFromProcess()
		setOrderMessageSendDepsForTest({ getContext: async () => null as never })
		setOrderRefundKickForTest(async (request) => {
			kicks.push(request)
			return { status: 'sent' }
		})
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(
					typeof input === 'string' ? input : input.toString(),
				)
				if (url.pathname === '/resources/order-context') {
					return Response.json(menuContext(url.searchParams.get('orgId')!))
				}
				return new Response('not found', { status: 404 })
			}),
		)
		const organization = (id: string) =>
			({
				id,
				slug: id === ORG ? 'test-org' : 'other-org',
				customDomain: null,
				hasProvisionedDb: true,
				dataRegion: 'us',
			}) as never
		vi.mocked(resolveOrganizationForBrowserAuth).mockImplementation(
			async (_origin, identity) =>
				identity?.slug === 'test-org' ? organization(ORG) : null,
		)
		vi.mocked(findActiveOrganizationById).mockImplementation(async (id) =>
			id === ORG || id === ORG_B ? organization(id) : null,
		)
		for (const id of [ORG, ORG_B]) {
			await provisionTenantDb(id)
			seedLoyaltyContextForTest(id, { enabled: false, redemption: false })
		}
		app = new Hono()
		app.route('/orders', publicOrderRoutes)
		app.route('/operator/orders', operatorOrderRoutes)
	})

	afterEach(async () => {
		await orderMessagesIdle()
		await orderRefundKicksIdle()
		setOrderRefundKickForTest(null)
		setOrderMessageSendDepsForTest(null)
		for (const id of [ORG, ORG_B]) await destroyTenantDb(id).catch(() => {})
		fs.rmSync(directory, { recursive: true, force: true })
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
		vi.useRealTimers()
	})

	describe('placement', () => {
		it('flag off (no policy in the context): accepted at once, in the kitchen, no accepted message', async () => {
			acceptance = undefined
			const id = await place()
			const order = await row(id)
			expect(order).toMatchObject({
				status: 'accepted',
				acceptanceDeadlineAt: null,
				acceptedAt: null,
			})
			expect(await inKitchen(id)).toBe(true)
			expect(await counted(id)).toBe(true)
			expect(queued.inventory).toContain(id)
			expect(await messages(id, 'receipt')).toHaveLength(1)
			expect(await messages(id, 'accepted')).toHaveLength(0)
			expect(receiptOrder(order)).toMatchObject({
				acceptanceDeadlineAt: null,
				rejected: false,
			})
		})

		it('Automatic and unknown policies behave as today', async () => {
			for (const policy of [
				{ 'loc-1': { ...MANUAL['loc-1'], mode: 'auto' } },
				{ 'loc-2': MANUAL['loc-1'] },
				{ 'loc-1': { mode: 'manual', timeoutMinutes: 7 } },
				'manual',
			]) {
				acceptance = policy
				const order = await row(await place())
				expect(order.status).toBe('accepted')
				expect(order.acceptanceDeadlineAt).toBeNull()
			}
		})

		it('manual: a pay-at-handoff order waits, out of the kitchen, with nothing settled', async () => {
			discounts = {
				features: { automatic: true, coupons: true },
				discounts: [
					makeDiscount({ id: 'disc_ten', name: 'Ten off', percentBp: 1000 }),
				],
				codes: [],
			}
			const id = await place({ discounts: { expectedDiscountMinor: 200 } })
			const order = await row(id)
			expect(order).toMatchObject({
				status: 'pending_acceptance',
				paymentStatus: 'unpaid',
				acceptedAt: null,
				rejectedReason: null,
			})
			expect(order.acceptanceDeadlineAt?.toISOString()).toBe(
				at(5).toISOString(),
			)
			expect(await inKitchen(id)).toBe(false)
			expect(await counted(id)).toBe(false)
			expect(queued.inventory).not.toContain(id)
			expect(queued.loyalty).not.toContain(id)
			expect(await redemptionStates(id)).toEqual(['reserved'])
			// The receipt goes out (it says "we received your order"), never
			// "accepted".
			expect(await messages(id, 'receipt')).toHaveLength(1)
			expect(await messages(id, 'accepted')).toHaveLength(0)

			// The guest sees the wait; the operator sees the deadline too.
			for (const view of [receiptOrder(order), linkReceiptOrder(order)]) {
				expect(view).toMatchObject({
					status: 'pending_acceptance',
					acceptanceDeadlineAt: at(5).toISOString(),
					rejected: false,
				})
			}
			expect(operatorOrder(order).acceptanceDeadlineAt).toBe(
				at(5).toISOString(),
			)

			// The badge: the list filter takes the status.
			const listed = await app.request(
				'/operator/orders?status=pending_acceptance',
				{
					headers: {
						Authorization: `Bearer ${await operatorToken({ scope: 'orders:read' })}`,
					},
				},
			)
			expect(listed.status).toBe(200)
			const body = (await listed.json()) as { orders: Array<{ id: string }> }
			expect(body.orders.map((entry) => entry.id)).toEqual([id])
		})

		it('an online order waits from its paid event, with the minutes counted from payment', async () => {
			discounts = {
				features: { automatic: true, coupons: true },
				discounts: [
					makeDiscount({ id: 'disc_ten', name: 'Ten off', percentBp: 1000 }),
				],
				codes: [],
			}
			const id = await place({
				paymentMethod: 'online',
				discounts: { expectedDiscountMinor: 200 },
			})
			const placed = await row(id)
			// Placed like today, awaiting payment; the deadline is only a mark.
			expect(placed.status).toBe('accepted')
			expect(placed.paymentStatus).toBe('pending')
			expect(operatorOrder(placed).acceptanceDeadlineAt).toBeNull()
			expect(receiptOrder(placed).acceptanceDeadlineAt).toBeNull()

			vi.setSystemTime(at(2))
			const db = await getTenantDb(ORG)
			await db
				.update(restaurantOrders)
				// `created_at` is the database clock; line it up with the fake one.
				.set({ paymentSessionId: `cs_${id}`, createdAt: NOW })
				.where(eq(restaurantOrders.id, id))
			const paid = await applyPaymentEvent({
				orgId: ORG,
				orderId: id,
				sessionId: `cs_${id}`,
				processor: 'connect',
				status: 'paid',
				amountCents: placed.totalCents,
				currency: 'USD',
			})
			expect(paid).toMatchObject({
				ok: true,
				data: { status: 'pending_acceptance', paymentStatus: 'paid' },
			})
			await orderMessagesIdle()
			const order = await row(id)
			expect(order.acceptanceDeadlineAt?.toISOString()).toBe(
				at(7).toISOString(),
			)
			expect(await inKitchen(id)).toBe(false)
			expect(await counted(id)).toBe(false)
			expect(queued.inventory).not.toContain(id)
			expect(queued.loyalty).not.toContain(id)
			// The use stays reserved until a person accepts.
			expect(await redemptionStates(id)).toEqual(['reserved'])
			expect(await messages(id, 'receipt')).toHaveLength(1)

			// A replayed paid event changes nothing.
			const again = await applyPaymentEvent({
				orgId: ORG,
				orderId: id,
				sessionId: `cs_${id}`,
				processor: 'connect',
				status: 'paid',
				amountCents: placed.totalCents,
				currency: 'USD',
			})
			expect(again).toMatchObject({
				ok: true,
				data: { status: 'pending_acceptance' },
			})

			const accepted = await patch(id, { status: 'accepted' })
			expect(accepted.status).toBe(200)
			expect(await redemptionStates(id)).toEqual(['consumed'])
			expect(queued.inventory).toContain(id)
			expect(queued.loyalty).toContain(id)
			expect(await counted(id)).toBe(true)
		})

		it('only orders over the amount wait (strictly over)', async () => {
			acceptance = {
				'loc-1': { ...MANUAL['loc-1'], minTotalCents: 2000 },
			}
			expect((await row(await place())).status).toBe('accepted')
			expect(
				(
					await row(
						await place({
							lines: [{ itemId: 'item-burger', quantity: 3, options: [] }],
						}),
					)
				).status,
			).toBe('pending_acceptance')
		})

		it('only scheduled orders wait, decided by 30 minutes before the kitchen starts', async () => {
			acceptance = {
				'loc-1': { ...MANUAL['loc-1'], scheduledOnly: true },
			}
			expect((await row(await place())).status).toBe('accepted')
			const later = await row(
				await place({ scheduledFor: at(180).toISOString() }),
			)
			expect(later.status).toBe('pending_acceptance')
			// fire = 180 - 15 prep; deadline = fire - 30.
			expect(later.acceptanceDeadlineAt?.toISOString()).toBe(
				at(135).toISOString(),
			)
			// One due soon still gets the configured minutes.
			const soon = await row(
				await place({ scheduledFor: at(40).toISOString() }),
			)
			expect(soon.acceptanceDeadlineAt?.toISOString()).toBe(at(5).toISOString())
		})

		it('QR table rounds, tabs and dine-in never wait', () => {
			const base = {
				context: menuContext(ORG) as never,
				locationId: 'loc-1',
				totalCents: 5000,
				fulfillment: 'pickup',
				source: null,
				tabId: null,
				scheduledFor: null,
				pickup: null,
				prepMinutes: 15,
				now: NOW,
			}
			expect(placementAcceptance(base).deadline).toEqual(at(5))
			expect(
				placementAcceptance({ ...base, source: 'qr_poster' }).deadline,
			).toEqual(at(5))
			for (const round of [
				{ fulfillment: 'dine_in', source: 'qr_table' },
				{ source: 'qr_table' },
				{ tabId: 'tab_1' },
			]) {
				expect(placementAcceptance({ ...base, ...round }).deadline).toBeNull()
			}
		})
	})

	describe('accept and reject', () => {
		it('accept: to the kitchen, settled as placement would, one accepted message', async () => {
			const id = await place()
			vi.setSystemTime(at(1))
			const res = await patch(id, { status: 'accepted' })
			expect(res.status).toBe(200)
			const body = (await res.json()) as {
				order: { status: string; acceptedAt: string }
			}
			expect(body.order).toMatchObject({
				status: 'accepted',
				acceptedAt: at(1).toISOString(),
			})
			expect(await inKitchen(id)).toBe(true)
			expect(await counted(id)).toBe(true)
			expect(queued.inventory).toContain(id)
			expect(queued.loyalty).toContain(id)
			expect(await messages(id, 'accepted')).toHaveLength(1)
			expect(receiptOrder(await row(id))).toMatchObject({
				status: 'accepted',
				acceptanceDeadlineAt: null,
				rejected: false,
			})

			// Idempotent: a repeat answers the order, no second message.
			const again = await patch(id, { status: 'accepted' })
			expect(again.status).toBe(200)
			expect((await row(id)).acceptedAt?.toISOString()).toBe(
				at(1).toISOString(),
			)
			expect(await messages(id, 'accepted')).toHaveLength(1)
		})

		it('two accepts at once produce one acceptance', async () => {
			const id = await place()
			const [a, b] = await Promise.all([
				patch(id, { status: 'accepted' }),
				patch(id, { status: 'accepted' }),
			])
			expect([a.status, b.status]).toEqual([200, 200])
			expect(await messages(id, 'accepted')).toHaveLength(1)
			// An accept and a reject at once: one decision, the other refused.
			const other = await place()
			const [accept, reject] = await Promise.all([
				patch(other, { status: 'accepted' }),
				patch(other, { status: 'cancelled', rejectReason: 'too_busy' }),
			])
			const statuses = [accept.status, reject.status].sort()
			expect(statuses).toEqual([200, 409])
			const loser = accept.status === 409 ? accept : reject
			expect(await loser.json()).toMatchObject({ error: 'order_not_pending' })
		})

		it('reject a paid online order: cancelled, refunded in full, guest told', async () => {
			const id = await placePaid()
			// No refund grant in the token: turning it down always refunds.
			const res = await patch(id, {
				status: 'cancelled',
				rejectReason: 'out_of_stock',
			})
			expect(res.status).toBe(200)
			const body = (await res.json()) as {
				order: Record<string, unknown>
				refundIntent: Record<string, unknown> | null
				refundError: string | null
			}
			expect(body.order).toMatchObject({
				status: 'cancelled',
				rejectedReason: 'out_of_stock',
				cancelReason: 'out_of_stock',
				cancelledBy: 'operator',
			})
			expect(body.refundError).toBeNull()
			expect(body.refundIntent).toMatchObject({
				orderId: id,
				amountCents: 2000,
				status: 'pending',
				replayed: false,
			})
			const [refund] = await refunds(id)
			expect(refund).toMatchObject({
				kind: 'provider',
				status: 'pending',
				origin: 'operator',
				actorId: 'usr_1',
				amountCents: 2000,
			})
			expect(kicks).toEqual([{ orgId: ORG, refundId: refund!.id }])
			expect(await messages(id, 'cancelled')).toHaveLength(1)
			expect(await messages(id, 'accepted')).toHaveLength(0)
			expect(await inKitchen(id)).toBe(false)
			const view = receiptOrder(await row(id))
			expect(view).toMatchObject({
				rejected: true,
				cancelReason: 'out_of_stock',
				cancelledBy: 'operator',
				acceptanceDeadlineAt: null,
			})
		})

		it('reject keeps the internal reason from the guest', async () => {
			const id = await placePaid()
			expect(
				(await patch(id, { status: 'cancelled', rejectReason: 'too_busy' }))
					.status,
			).toBe(200)
			const order = await row(id)
			expect(receiptOrder(order)).toMatchObject({
				rejected: true,
				cancelReason: null,
			})
			expect(linkReceiptOrder(order)).toMatchObject({
				rejected: true,
				cancelReason: null,
			})
			expect(operatorOrder(order).cancelReason).toBe('too_busy')
		})

		it('reject a pay-at-handoff order: simply cancelled, a reject reason is required', async () => {
			discounts = {
				features: { automatic: true, coupons: true },
				discounts: [
					makeDiscount({ id: 'disc_ten', name: 'Ten off', percentBp: 1000 }),
				],
				codes: [],
			}
			const id = await place({ discounts: { expectedDiscountMinor: 200 } })
			// A plain cancel of a waiting order is not a reject: the caller must
			// use `rejectReason` (a cancel reason alone is refused the same way).
			for (const body of [
				{ status: 'cancelled' },
				{ status: 'cancelled', cancelReason: 'guest_asked' },
				{ status: 'cancelled', cancelReason: 'duplicate', refund: 'none' },
			]) {
				const missing = await patch(id, body)
				expect(missing.status).toBe(409)
				expect(await missing.json()).toMatchObject({
					error: 'order_not_pending',
				})
			}
			expect((await row(id)).status).toBe('pending_acceptance')
			expect((await row(id)).rejectedReason).toBeNull()

			const res = await patch(id, {
				status: 'cancelled',
				rejectReason: 'kitchen_closed',
			})
			expect(res.status).toBe(200)
			const body = (await res.json()) as Record<string, unknown>
			expect(body).not.toHaveProperty('refundIntent')
			expect(await row(id)).toMatchObject({
				status: 'cancelled',
				rejectedReason: 'kitchen_closed',
				cancelledBy: 'operator',
			})
			expect(await refunds(id)).toEqual([])
			expect(await redemptionStates(id)).toEqual(['released'])
			expect(await messages(id, 'cancelled')).toHaveLength(1)
			expect(await inKitchen(id)).toBe(false)
			// A repeat answers the order as it is.
			expect(
				(
					await patch(id, {
						status: 'cancelled',
						rejectReason: 'kitchen_closed',
					})
				).status,
			).toBe(200)
		})

		it('an impersonating admin cannot turn down a paid online order', async () => {
			const id = await placePaid()
			const res = await patch(
				id,
				{ status: 'cancelled', rejectReason: 'too_busy' },
				{ ...WRITE, impersonated: true },
			)
			expect(res.status).toBe(403)
			expect(await res.json()).toMatchObject({ error: 'refund_forbidden' })
			expect((await row(id)).status).toBe('pending_acceptance')
			expect(await refunds(id)).toEqual([])
		})

		it('a decision on an order no longer waiting is refused', async () => {
			const rejected = await place()
			await patch(rejected, { status: 'cancelled', rejectReason: 'other' })
			const accept = await patch(rejected, { status: 'accepted' })
			expect(accept.status).toBe(409)
			expect(await accept.json()).toMatchObject({ error: 'order_not_pending' })

			const accepted = await place()
			await patch(accepted, { status: 'accepted' })
			const reject = await patch(accepted, {
				status: 'cancelled',
				rejectReason: 'too_busy',
			})
			expect(reject.status).toBe(409)
			expect(await reject.json()).toMatchObject({ error: 'order_not_pending' })
			expect((await row(accepted)).status).toBe('accepted')

			// The kitchen and the till cannot skip the decision.
			const waiting = await place()
			const ready = await patch(waiting, { status: 'ready' })
			expect(ready.status).toBe(422)
			expect((await row(waiting)).status).toBe('pending_acceptance')
		})

		it("another location's or organization's order is not found", async () => {
			const id = await place()
			const scoped = await patch(
				id,
				{ status: 'accepted' },
				{ ...WRITE, locationIds: ['loc-2'] },
			)
			expect(scoped.status).toBe(404)
			expect((await row(id)).status).toBe('pending_acceptance')

			const foreign = await insertOrder(ORG_B, {
				status: 'pending_acceptance',
				completedAt: null,
				acceptanceDeadlineAt: at(5),
			})
			const other = await patch(foreign, { status: 'accepted' })
			expect(other.status).toBe(404)
			expect((await row(foreign, ORG_B)).status).toBe('pending_acceptance')
		})

		it('accepting after the deadline but before the tick is allowed', async () => {
			const id = await place()
			vi.setSystemTime(at(9))
			expect((await patch(id, { status: 'accepted' })).status).toBe(200)
			const tick = await processOrderAcceptance(ORG)
			expect(tick.rejected).toBe(0)
			expect((await row(id)).status).toBe('accepted')
		})

		it('the guest may still cancel a waiting order', async () => {
			guestCancel = { 'loc-1': { minutes: 5, scheduledLeadMinutes: null } }
			const id = await place()
			const res = await app.request(`/orders/${id}/cancel`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					origin: 'https://test-org.example.com',
					'Idempotency-Key': `guest-cancel-${id}`,
					Authorization: `Bearer ${deriveReceiptToken(ORG, id)}`,
				},
				body: JSON.stringify({ slug: 'test-org' }),
			})
			await orderMessagesIdle()
			expect(res.status).toBe(200)
			expect(await row(id)).toMatchObject({
				status: 'cancelled',
				cancelledBy: 'guest',
				cancelReason: 'guest_asked',
				rejectedReason: null,
			})
			expect(receiptOrder(await row(id)).rejected).toBe(false)
			expect(await inKitchen(id)).toBe(false)
		})
	})

	describe('timeout tick', () => {
		it('turns down a paid order not decided in time and refunds it in full', async () => {
			const id = await placePaid()
			const handoff = await place()
			const early = await processOrderAcceptance(ORG)
			expect(early).toMatchObject({
				rejected: 0,
				nextDeadlineAt: at(5).getTime(),
			})

			vi.setSystemTime(at(6))
			const tick = await runOrdersTickForOrg(ORG)
			await orderMessagesIdle()
			await orderRefundKicksIdle()
			expect(tick).toMatchObject({ acceptanceRejected: 2 })
			for (const orderId of [id, handoff]) {
				expect(await row(orderId)).toMatchObject({
					status: 'cancelled',
					rejectedReason: 'not_accepted_in_time',
					cancelReason: 'not_accepted_in_time',
					cancelledBy: 'system',
				})
				expect(await messages(orderId, 'cancelled')).toHaveLength(1)
				expect(await inKitchen(orderId)).toBe(false)
			}
			const [refund] = await refunds(id)
			expect(refund).toMatchObject({
				kind: 'provider',
				status: 'pending',
				origin: 'system',
				actorId: 'system',
				amountCents: 2000,
				full: true,
			})
			expect(kicks).toEqual([{ orgId: ORG, refundId: refund!.id }])
			expect(await refunds(handoff)).toEqual([])
			expect(receiptOrder(await row(id))).toMatchObject({
				rejected: true,
				cancelReason: null,
				cancelledBy: 'system',
			})

			// Idempotent: nothing left, nothing booked twice.
			const again = await processOrderAcceptance(ORG)
			expect(again).toEqual({
				rejected: 0,
				refundsBooked: 0,
				nextDeadlineAt: null,
			})
			expect(await refunds(id)).toHaveLength(1)
		})

		it('the acceptance sweep (the Node interval) turns a waiting order down and refunds it', async () => {
			const id = await placePaid()
			vi.setSystemTime(at(6))
			const swept = await fanOutOrderAcceptanceTick({ orgIds: [ORG] })
			await orderRefundKicksIdle()
			expect(swept).toMatchObject({ orgs: 1, errors: 0, rejected: 1 })
			expect(await row(id)).toMatchObject({
				status: 'cancelled',
				rejectedReason: 'not_accepted_in_time',
				cancelledBy: 'system',
			})
			expect(await refunds(id)).toHaveLength(1)
			expect(kicks).toHaveLength(1)
			// A second pass has nothing to do.
			expect(await fanOutOrderAcceptanceTick({ orgIds: [ORG] })).toMatchObject({
				rejected: 0,
			})
		})

		it('asks for the next run at the earliest deadline', async () => {
			await place()
			vi.setSystemTime(at(1))
			await place()
			const tick = await runOrdersTickForOrg(ORG)
			expect(tick).toMatchObject({
				acceptanceRejected: 0,
				needsFollowUp: true,
			})
			// The receipts are already sent (or retrying): the deadline or an
			// earlier message retry, never later than the first deadline.
			expect(tick.nextDueAt).not.toBeNull()
			expect(tick.nextDueAt!).toBeLessThanOrEqual(at(5).getTime())
		})
	})

	describe('capacity', () => {
		it('a waiting order holds its pickup slot until it is turned down', async () => {
			drop = dropContext(1)
			const dropOrder = {
				dropSlug: 'friday-bbq',
				pickup: { windowId: 'win-1', time: '17:30' },
				lines: [{ itemId: 'item-brisket', quantity: 1, options: [] }],
			}
			const first = await place(dropOrder)
			const firstRow = await row(first)
			expect(firstRow.status).toBe('pending_acceptance')
			// A drop's pickup slot is a scheduled order: decided by 30 minutes
			// before the kitchen starts it, long after the configured minutes.
			expect(firstRow.acceptanceDeadlineAt!.getTime()).toBeGreaterThan(
				at(60).getTime(),
			)

			const full = await placeRaw(dropOrder)
			expect(full.status).toBe(422)
			expect(await full.json()).toMatchObject({ error: 'slot_full' })

			expect(
				(await patch(first, { status: 'cancelled', rejectReason: 'too_busy' }))
					.status,
			).toBe(200)
			expect((await row(await place(dropOrder))).status).toBe(
				'pending_acceptance',
			)
		})
	})
})
