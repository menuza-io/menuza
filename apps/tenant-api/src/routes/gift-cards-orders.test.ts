import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defaultGiftCardSettings } from '@repo/common/gift-cards'
import {
	destroyTenantDb,
	getTenantDb,
	giftCardLedger,
	provisionTenantDb,
	restaurantOrderRefunds,
	restaurantOrders,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearGiftCardContextCache } from '../lib/gift-card-context.ts'
import {
	findActiveOrganizationById,
	resolveOrganizationForBrowserAuth,
} from '../lib/origin.ts'
import { sellGiftCard } from '../services/gift-card-service.ts'
import { giftCardBalance } from '../services/gift-card-store.ts'
import { recordOrderRefund } from '../services/order-refund-service.ts'
import { createProviderRefundIntent } from '../services/order-provider-refund-service.ts'
import {
	applyPaymentEvent,
	bindPaymentSession,
	getOrderQuote,
	sweepExpiredHolds,
	updateOperatorOrder,
} from '../services/order-service.ts'
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
 * A gift card is a tender: after discounts and loyalty it takes at most its
 * balance and at most what is left to pay; the rest is paid online or at
 * pickup. A burger order of two at 10.00 with 8.25% tax is 21.65.
 */

const orgId = 'org_gift_card_orders_1'
const ORG = {
	id: orgId,
	slug: 'test-org',
	customDomain: null,
	hasProvisionedDb: true,
	dataRegion: 'us',
}
const TOTAL = 2165
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

describe('orders paid with a gift card', () => {
	let directory: string
	let app: Hono
	let giftOnline = true

	async function card(amountMinor: number) {
		return sellGiftCard({
			orgId,
			amountMinor,
			currency: 'USD',
			locationId: 'loc-1',
			actor: { id: 'user_1', name: 'Pat' },
			deviceId: 'dev_1',
			clientRequestId: crypto.randomUUID(),
			paymentMethod: 'cash',
			settings: { ...defaultGiftCardSettings(), minAmountMinor: 100 },
		})
	}

	async function post(path: string, body: unknown) {
		const response = await app.request(path, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				origin: 'https://test-org.example.com',
			},
			body: JSON.stringify(body),
		})
		return { status: response.status, body: (await response.json()) as any }
	}

	async function stored(id: string) {
		const db = await getTenantDb(orgId)
		const [row] = await db.select().from(restaurantOrders).where(eq(restaurantOrders.id, id))
		return row!
	}

	beforeEach(async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gift-card-orders-'))
		vi.stubEnv('TENANT_DB_DIR', directory)
		vi.stubEnv('DATA_REGION', 'us')
		vi.stubEnv('INTERNAL_COMMAND_TOKEN', 'test-internal-token-very-long-and-secure-12345')
		vi.stubEnv('TENANT_OPERATOR_TOKEN', 'test-operator-token-very-long-and-secure-12345')
		vi.stubEnv('JWT_SECRET', 'test-jwt-secret-123456789')
		vi.stubEnv('AUTH_HMAC_SECRET', 'test-hmac-secret-123456789')
		vi.stubEnv('APP_URL', 'https://app.test')
		giftOnline = true
		clearGiftCardContextCache()
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = typeof input === 'string' ? input : input.toString()
				if (url.includes('/resources/order-context')) {
					return Response.json(menuContext())
				}
				if (url.includes('/resources/gift-cards/context')) {
					return Response.json({
						orgId,
						features: { enabled: true, online: giftOnline, pos: true },
						settings: { ...defaultGiftCardSettings(), minAmountMinor: 100 },
						currency: 'USD',
						locations: [],
					})
				}
				return new Response('not found', { status: 404 })
			}),
		)
		vi.mocked(resolveOrganizationForBrowserAuth).mockImplementation(
			async (_origin, identity) => (identity?.slug === 'test-org' ? (ORG as never) : null),
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
			// Already gone when a test failed mid-setup.
		}
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
		vi.clearAllMocks()
	})

	it('quotes what the card would take and what is still due', async () => {
		const sold = await card(1000)
		const quote = await post('/orders/quote', {
			...orderBody(),
			idempotencyKey: undefined,
			giftCard: { code: sold.code, expectedAmountMinor: 0 },
		})
		expect(quote.status).toBe(200)
		expect(quote.body.giftCard).toMatchObject({
			appliedMinor: 1000,
			balanceMinor: 1000,
			remainingBalanceMinor: 0,
			dueMinor: TOTAL - 1000,
		})
		// A card that covers the order takes only what is due.
		const big = await card(5000)
		const covered = await post('/orders/quote', {
			...orderBody(),
			idempotencyKey: undefined,
			giftCard: { code: big.code, expectedAmountMinor: 0 },
		})
		expect(covered.body.giftCard).toMatchObject({ appliedMinor: TOTAL, dueMinor: 0 })
	})

	it('pays an order in full: nothing to collect, the balance drops, the redemption is on the ledger', async () => {
		const sold = await card(5000)
		const placed = await post('/orders', {
			...orderBody({ paymentMethod: 'handoff' }),
			giftCard: { code: sold.code, expectedAmountMinor: TOTAL },
		})
		expect(placed.status).toBe(201)
		const order = await stored(placed.body.order.id)
		expect(order).toMatchObject({
			totalCents: TOTAL,
			giftCardCents: TOTAL,
			paymentStatus: 'not_required',
		})
		const db = await getTenantDb(orgId)
		expect(await giftCardBalance(db, sold.cardId)).toBe(5000 - TOTAL)
		const redeem = (await db.select().from(giftCardLedger).where(eq(giftCardLedger.cardId, sold.cardId))).find(
			(row) => row.kind === 'redeem',
		)
		expect(redeem).toMatchObject({
			sourceType: 'restaurant_order',
			sourceId: order.id,
			channel: 'online',
			locationId: 'loc-1',
			amountMinor: -TOTAL,
		})
	})

	it('pays part online: the provider is charged the rest, and the card stays spent when it is paid', async () => {
		const sold = await card(1000)
		const placed = await post('/orders', {
			...orderBody({ paymentMethod: 'online' }),
			giftCard: { code: sold.code, expectedAmountMinor: 1000 },
		})
		expect(placed.status).toBe(201)
		const orderId = placed.body.order.id as string
		const quote = await getOrderQuote(orgId, orderId, placed.body.paymentToken)
		expect(quote.ok && quote.data.totalCents).toBe(TOTAL - 1000)

		const bound = await bindPaymentSession({ orgId, orderId, sessionId: 'cs_test_12345678', processor: 'connect' })
		expect(bound.ok).toBe(true)
		// The whole total is not what the provider takes.
		const wrong = await applyPaymentEvent({
			orgId,
			orderId,
			sessionId: 'cs_test_12345678',
			processor: 'connect',
			status: 'paid',
			amountCents: TOTAL,
			currency: 'USD',
		})
		expect(wrong.ok).toBe(false)
		const paid = await applyPaymentEvent({
			orgId,
			orderId,
			sessionId: 'cs_test_12345678',
			processor: 'connect',
			status: 'paid',
			amountCents: TOTAL - 1000,
			currency: 'USD',
			paymentId: 'pi_12345',
		})
		expect(paid.ok).toBe(true)
		const db = await getTenantDb(orgId)
		expect(await giftCardBalance(db, sold.cardId)).toBe(0)
	})

	it('refuses a changed amount (409 gift_card_changed) and places nothing', async () => {
		const sold = await card(1000)
		const placed = await post('/orders', {
			...orderBody(),
			giftCard: { code: sold.code, expectedAmountMinor: 900 },
		})
		expect(placed.status).toBe(409)
		expect(placed.body.error).toBe('gift_card_changed')
		const db = await getTenantDb(orgId)
		expect(await giftCardBalance(db, sold.cardId)).toBe(1000)
		expect(await db.select().from(restaurantOrders)).toHaveLength(0)
	})

	it('answers a wrong code as not found and counts the guess; gift cards off is refused', async () => {
		const wrong = await post('/orders', {
			...orderBody(),
			giftCard: { code: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ', expectedAmountMinor: 100 },
		})
		expect(wrong.status).toBe(404)
		expect(wrong.body.error).toBe('code_invalid')
		giftOnline = false
		clearGiftCardContextCache()
		const sold = await card(1000)
		const off = await post('/orders', {
			...orderBody(),
			giftCard: { code: sold.code, expectedAmountMinor: 1000 },
		})
		expect(off.status).toBe(403)
		expect(off.body.error).toBe('gift_cards_disabled')
	})

	it('gives the card its part back when an unpaid online order lapses', async () => {
		const sold = await card(1000)
		const placed = await post('/orders', {
			...orderBody({ paymentMethod: 'online' }),
			giftCard: { code: sold.code, expectedAmountMinor: 1000 },
		})
		const db = await getTenantDb(orgId)
		expect(await giftCardBalance(db, sold.cardId)).toBe(0)
		await sweepExpiredHolds(orgId, new Date(Date.now() + 24 * 60 * 60_000))
		expect((await stored(placed.body.order.id)).paymentStatus).toBe('expired')
		expect(await giftCardBalance(db, sold.cardId)).toBe(1000)
	})

	it('gives the card its part back when an order it paid in full is cancelled', async () => {
		const sold = await card(5000)
		const placed = await post('/orders', {
			...orderBody(),
			giftCard: { code: sold.code, expectedAmountMinor: TOTAL },
		})
		const cancelled = await updateOperatorOrder(orgId, placed.body.order.id, {
			status: 'cancelled',
			cancelReason: 'kitchen_closed',
		} as never)
		expect(cancelled.ok).toBe(true)
		const db = await getTenantDb(orgId)
		expect(await giftCardBalance(db, sold.cardId)).toBe(5000)
	})

	describe('refunds go back to the card first', () => {
		async function paidPartly() {
			const sold = await card(1000)
			const placed = await post('/orders', {
				...orderBody({ paymentMethod: 'online' }),
				giftCard: { code: sold.code, expectedAmountMinor: 1000 },
			})
			const orderId = placed.body.order.id as string
			await bindPaymentSession({ orgId, orderId, sessionId: 'cs_test_12345678', processor: 'connect' })
			await applyPaymentEvent({
				orgId,
				orderId,
				sessionId: 'cs_test_12345678',
				processor: 'connect',
				status: 'paid',
				amountCents: TOTAL - 1000,
				currency: 'USD',
				paymentId: 'pi_12345',
			})
			return { sold, orderId }
		}

		it('a full refund returns the card part to the card and books the rest with the provider', async () => {
			const { sold, orderId } = await paidPartly()
			const refund = await createProviderRefundIntent({
				orgId,
				orderRef: orderId,
				amount: { full: true },
				note: null,
				idempotencyKey: 'refund-key-0001',
				origin: 'operator',
				actorId: 'user_1',
			})
			expect(refund.ok).toBe(true)
			const db = await getTenantDb(orgId)
			expect(await giftCardBalance(db, sold.cardId)).toBe(1000)
			const rows = await db.select().from(restaurantOrderRefunds).where(eq(restaurantOrderRefunds.orderId, orderId))
			const provider = rows.find((row) => row.kind === 'provider')
			expect(provider).toMatchObject({ status: 'pending', amountCents: TOTAL - 1000 })
			expect(rows.find((row) => row.kind === 'record')).toMatchObject({
				status: 'succeeded',
				amountCents: 1000,
			})
		})

		it('a small refund the card covers goes only to the card, never to the provider', async () => {
			const { sold, orderId } = await paidPartly()
			const refund = await createProviderRefundIntent({
				orgId,
				orderRef: orderId,
				amount: { amountCents: 400 },
				note: null,
				idempotencyKey: 'refund-key-0002',
				origin: 'operator',
				actorId: 'user_1',
			})
			expect(refund.ok).toBe(true)
			const db = await getTenantDb(orgId)
			expect(await giftCardBalance(db, sold.cardId)).toBe(400)
			const rows = await db.select().from(restaurantOrderRefunds).where(eq(restaurantOrderRefunds.orderId, orderId))
			expect(rows.filter((row) => row.kind === 'provider')).toHaveLength(0)
			// A replay of the same key books nothing more.
			const replay = await createProviderRefundIntent({
				orgId,
				orderRef: orderId,
				amount: { amountCents: 400 },
				note: null,
				idempotencyKey: 'refund-key-0002',
				origin: 'operator',
				actorId: 'user_1',
			})
			expect(replay.ok && replay.data.replayed).toBe(true)
			expect(await giftCardBalance(db, sold.cardId)).toBe(400)
			// Past the card part, the provider is asked for the rest.
			const more = await createProviderRefundIntent({
				orgId,
				orderRef: orderId,
				amount: { amountCents: 900 },
				note: null,
				idempotencyKey: 'refund-key-0003',
				origin: 'operator',
				actorId: 'user_1',
			})
			expect(more.ok).toBe(true)
			expect(await giftCardBalance(db, sold.cardId)).toBe(1000)
			const after = await db.select().from(restaurantOrderRefunds).where(eq(restaurantOrderRefunds.orderId, orderId))
			expect(after.find((row) => row.kind === 'provider')).toMatchObject({ amountCents: 300 })
		})

		it('a recorded refund of a pay-at-pickup order also returns the card part first', async () => {
			const sold = await card(1000)
			const placed = await post('/orders', {
				...orderBody({ paymentMethod: 'handoff' }),
				giftCard: { code: sold.code, expectedAmountMinor: 1000 },
			})
			const orderId = placed.body.order.id as string
			await updateOperatorOrder(orgId, orderId, { status: 'accepted', markPaid: true })
			const recorded = await recordOrderRefund(orgId, orderId, {
				request: { amountCents: 700, note: null } as never,
				actorId: 'user_1',
				idempotencyKey: 'record-key-0001',
				loyaltyAccess: { refundLoyalty: true, impersonated: false },
			})
			expect(recorded.ok).toBe(true)
			const db = await getTenantDb(orgId)
			expect(await giftCardBalance(db, sold.cardId)).toBe(700)
		})
	})
})
