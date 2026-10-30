import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import {
	destroyTenantDb,
	getTenantDb,
	loyaltyMembers,
	loyaltyPurchases,
	loyaltyRedemptions,
	provisionTenantDb,
	restaurantOrders,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
	findActiveOrganizationById,
	resolveOrganizationForBrowserAuth,
} from '../lib/origin.ts'
import {
	invalidateLoyaltyContext,
	LOYALTY_CONTEXT_TIMEOUT_MS,
	seedLoyaltyContextForTest,
} from '../lib/loyalty-context.ts'
import { ONLINE_PAYABLE_AFTER_HOLD_MS } from '../restaurant/loyalty-sources.ts'
import {
	readProgramInTx,
	saveProgram,
} from '../services/loyalty-program-service.ts'
import { processLoyaltyOutbox } from '../services/loyalty-purchase-service.ts'
import {
	activateProgram,
	balanceOf,
	givePoints,
	insertCustomer,
	makeMember,
	makeReward,
	programConfig,
	rewardDefinition,
} from '../services/loyalty-test-fixture.ts'
import { runLoyaltyTickForOrg } from '../services/loyalty-tick-service.ts'
import {
	applyPaymentEvent,
	bindPaymentSession,
	placeOrder,
	sweepExpiredHolds,
	updateOperatorOrder,
} from '../services/order-service.ts'
import { loyaltyRoutes } from './loyalty.ts'
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

const orgId = 'org_orders_loyalty_1'
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

function menuContext(extra: Record<string, unknown> = {}) {
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
		...extra,
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

async function customerJwt(customerId: string) {
	return new SignJWT({ customerId, orgId, orgSlug: 'test-org', type: 'access' })
		.setProtectedHeader({ alg: 'HS256' })
		.setIssuer(brand.slug)
		.setAudience('tenant-api')
		.setExpirationTime('1h')
		.sign(new TextEncoder().encode(jwtSecret))
}

const LATER = () => Date.now() + 60_000

describe('loyalty at order placement', () => {
	let directory: string
	let app: Hono
	let activeContext: Record<string, unknown>
	let memberId: string
	let rewardId: string

	async function postOrder(
		body: unknown,
		customerId: string | null = 'cust_1',
	) {
		const headers: Record<string, string> = {
			'content-type': 'application/json',
			origin: 'https://test-org.example.com',
		}
		if (customerId)
			headers.authorization = `Bearer ${await customerJwt(customerId)}`
		return app.request('/orders', {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
		})
	}

	function rewardSelection(overrides: Record<string, unknown> = {}) {
		return {
			rewardId,
			rewardVersion: 1,
			expectedDiscountMinor: 500,
			targetLineId: null,
			...overrides,
		}
	}

	async function redemptionsFor(orderId: string) {
		const db = await getTenantDb(orgId)
		return db
			.select()
			.from(loyaltyRedemptions)
			.where(eq(loyaltyRedemptions.sourceId, orderId))
			.all()
	}

	beforeEach(async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orders-loyalty-'))
		vi.stubEnv('TENANT_DB_DIR', directory)
		vi.stubEnv('DATA_REGION', 'us')
		vi.stubEnv(
			'INTERNAL_COMMAND_TOKEN',
			'test-internal-token-very-long-and-secure-12345',
		)
		vi.stubEnv(
			'TENANT_OPERATOR_TOKEN',
			'test-operator-token-very-long-and-secure-12345',
		)
		vi.stubEnv('JWT_SECRET', jwtSecret)
		vi.stubEnv('AUTH_HMAC_SECRET', 'test-hmac-secret-123456789')
		vi.stubEnv('APP_URL', 'https://app.test')

		activeContext = menuContext()
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = typeof input === 'string' ? input : input.toString()
				if (url.includes('/resources/order-context')) {
					return Response.json(activeContext)
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
		seedLoyaltyContextForTest(orgId, {
			enabled: true,
			redemption: true,
		})
		await activateProgram(orgId, programConfig())
		rewardId = (await makeReward(orgId, rewardDefinition())).id
		await insertCustomer(orgId, { id: 'cust_1', phone: '+15551230001' })
		memberId = await makeMember(orgId, { customerId: 'cust_1' })
		await givePoints(orgId, memberId, 50)

		app = new Hono()
		app.route('/orders', publicOrderRoutes)
		app.route('/loyalty', loyaltyRoutes)
	})

	async function postQuote(
		body: unknown,
		customerId: string | null = 'cust_1',
	) {
		const headers: Record<string, string> = {
			'content-type': 'application/json',
			origin: 'https://test-org.example.com',
		}
		if (customerId)
			headers.authorization = `Bearer ${await customerJwt(customerId)}`
		// The site is named in the body (top level), never nested or in the URL.
		return app.request('/loyalty/checkout/quote', {
			method: 'POST',
			headers,
			body: JSON.stringify({ slug: 'test-org', ...(body as object) }),
		})
	}

	afterEach(async () => {
		vi.useRealTimers()
		invalidateLoyaltyContext(orgId)
		try {
			await destroyTenantDb(orgId)
			fs.rmSync(directory, { recursive: true, force: true })
		} catch {}
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
		vi.clearAllMocks()
	})

	it('places an order with the reward taken off before tax and the points held', async () => {
		const response = await postOrder(orderBody({ loyalty: rewardSelection() }))
		expect(response.status).toBe(201)
		const body = await response.json()
		// 2 x 10.00, minus 5.00, tax 8.25% on 15.00 = 1.24
		expect(body.order.subtotalCents).toBe(2000)
		expect(body.order.loyaltyDiscountCents).toBe(500)
		expect(body.order.taxCents).toBe(124)
		expect(body.order.totalCents).toBe(1624)

		const [redemption] = await redemptionsFor(body.order.id)
		expect(redemption).toMatchObject({
			state: 'bound',
			sourceType: 'restaurant_order',
			memberId,
			points: 10,
			discountMinor: 500,
		})
		expect(await balanceOf(orgId, memberId)).toEqual({
			points: 50,
			reserved: 10,
			available: 40,
		})
		const db = await getTenantDb(orgId)
		const purchase = await db
			.select()
			.from(loyaltyPurchases)
			.where(eq(loyaltyPurchases.sourceId, body.order.id))
			.get()
		expect(purchase).toMatchObject({ memberId, state: 'open' })
	})

	it('replays a placed order even when rewards were turned off meanwhile', async () => {
		const key = crypto.randomUUID()
		const placed = await postOrder(
			orderBody({ idempotencyKey: key, loyalty: rewardSelection() }),
		)
		expect(placed.status).toBe(201)
		const first = await placed.json()

		// The answer was lost and redemption was switched off before the retry.
		seedLoyaltyContextForTest(orgId, {
			enabled: true,
			redemption: false,
		})
		const retry = await postOrder(
			orderBody({ idempotencyKey: key, loyalty: rewardSelection() }),
		)
		expect(retry.status).toBe(200)
		const replayed = await retry.json()
		expect(replayed.order.id).toBe(first.order.id)
		expect(replayed.receiptToken).toBe(first.receiptToken)

		const db = await getTenantDb(orgId)
		expect(await db.select().from(restaurantOrders).all()).toHaveLength(1)
	})

	it('spends the reward and earns on the net spend once the order is paid and completed', async () => {
		const placed = await (
			await postOrder(orderBody({ loyalty: rewardSelection() }))
		).json()
		const done = await updateOperatorOrder(orgId, placed.order.id, {
			status: 'completed',
			markPaid: true,
		})
		expect(done.ok).toBe(true)
		await processLoyaltyOutbox(orgId, { now: LATER() })

		const [redemption] = await redemptionsFor(placed.order.id)
		expect(redemption!.state).toBe('consumed')
		// 50 - 10 spent + 15 earned on 15.00 net of the reward (tax excluded).
		expect(await balanceOf(orgId, memberId)).toEqual({
			points: 55,
			reserved: 0,
			available: 55,
		})
	})

	it('earns on a signed-in order without a reward, and ignores guests', async () => {
		const placed = await (await postOrder(orderBody())).json()
		const guest = await (await postOrder(orderBody(), null)).json()
		for (const id of [placed.order.id, guest.order.id]) {
			await updateOperatorOrder(orgId, id, {
				status: 'completed',
				markPaid: true,
			})
		}
		await processLoyaltyOutbox(orgId, { now: LATER() })
		expect((await balanceOf(orgId, memberId)).points).toBe(70)
		const db = await getTenantDb(orgId)
		const guestPurchase = await db
			.select()
			.from(loyaltyPurchases)
			.where(eq(loyaltyPurchases.sourceId, guest.order.id))
			.get()
		expect(guestPurchase).toBeUndefined()
	})

	it('refuses a discount the cart no longer gives, with the corrected amount, and writes nothing', async () => {
		const response = await postOrder(
			orderBody({ loyalty: rewardSelection({ expectedDiscountMinor: 400 }) }),
		)
		expect(response.status).toBe(409)
		const body = await response.json()
		expect(body).toMatchObject({
			error: 'cart_changed',
			details: { discountMinor: 500 },
		})
		const db = await getTenantDb(orgId)
		expect(await db.select().from(restaurantOrders).all()).toHaveLength(0)
		expect(await db.select().from(loyaltyRedemptions).all()).toHaveLength(0)
		expect((await balanceOf(orgId, memberId)).reserved).toBe(0)
	})

	it('refuses a changed reward version and a reward the member cannot afford', async () => {
		const stale = await postOrder(
			orderBody({ loyalty: rewardSelection({ rewardVersion: 2 }) }),
		)
		expect(stale.status).toBe(409)
		expect((await stale.json()).error).toBe('stale_version')

		const pricey = (
			await makeReward(orgId, rewardDefinition({ pointsCost: 500 }))
		).id
		const short = await postOrder(
			orderBody({ loyalty: rewardSelection({ rewardId: pricey }) }),
		)
		expect((await short.json()).error).toBe('insufficient_points')
		const db = await getTenantDb(orgId)
		expect(await db.select().from(restaurantOrders).all()).toHaveLength(0)
	})

	it('refuses rewards for guests, when redemption is off, and on tab rounds', async () => {
		const guest = await postOrder(
			orderBody({ loyalty: rewardSelection() }),
			null,
		)
		expect(guest.status).toBe(401)

		seedLoyaltyContextForTest(orgId, {
			enabled: true,
			redemption: false,
		})
		const off = await postOrder(orderBody({ loyalty: rewardSelection() }))
		expect(off.status).toBe(403)
		expect((await off.json()).error).toBe('redemption_disabled')

		seedLoyaltyContextForTest(orgId, {
			enabled: true,
			redemption: true,
		})
		activeContext = menuContext({
			qrOrdering: { enabled: true, dineIn: true, online: true },
		})
		const round = await placeOrder({
			organization: ORG as never,
			request: orderBody({
				fulfillment: 'dine_in',
				loyalty: rewardSelection(),
			}) as never,
			customerId: 'cust_1',
			dineIn: { tableToken: 'any-table-token', tabToken: null } as never,
		})
		expect(round.ok).toBe(false)
		if (!round.ok) expect(round.failure.code).toBe('loyalty_on_tab')
	})

	it('gives the points back when an online order is never paid', async () => {
		const placed = await (
			await postOrder(
				orderBody({ paymentMethod: 'online', loyalty: rewardSelection() }),
			)
		).json()
		expect((await balanceOf(orgId, memberId)).reserved).toBe(10)
		const later = Date.now() + 6 * 60 * 60_000
		await sweepExpiredHolds(orgId, new Date(later))
		await processLoyaltyOutbox(orgId, { now: later + 1000 })
		const [redemption] = await redemptionsFor(placed.order.id)
		expect(redemption!.state).toBe('released')
		expect(await balanceOf(orgId, memberId)).toEqual({
			points: 50,
			reserved: 0,
			available: 50,
		})
	})

	async function holdOf(orderId: string) {
		const db = await getTenantDb(orgId)
		const order = await db
			.select({ holdExpiresAt: restaurantOrders.holdExpiresAt })
			.from(restaurantOrders)
			.where(eq(restaurantOrders.id, orderId))
			.get()
		return order!.holdExpiresAt!.getTime()
	}

	async function orderStatus(orderId: string) {
		const db = await getTenantDb(orgId)
		return (await db
			.select({
				status: restaurantOrders.status,
				paymentStatus: restaurantOrders.paymentStatus,
			})
			.from(restaurantOrders)
			.where(eq(restaurantOrders.id, orderId))
			.get())!
	}

	it('keeps the reward held while the payment page is open, and spends it when a late payment is accepted', async () => {
		vi.useFakeTimers({ toFake: ['Date'] })
		const t0 = Date.now()
		const placed = await (
			await postOrder(
				orderBody({ paymentMethod: 'online', loyalty: rewardSelection() }),
			)
		).json()
		const orderId = placed.order.id
		const bound = await bindPaymentSession({
			orgId,
			orderId,
			sessionId: 'cs_late',
			processor: 'connect',
		})
		expect(bound.ok).toBe(true)

		// The hold lapses; the Stripe page it opened can still take money.
		vi.setSystemTime(t0 + 11 * 60_000)
		await sweepExpiredHolds(orgId)
		await processLoyaltyOutbox(orgId, { now: Date.now() + 1000 })
		expect((await orderStatus(orderId)).status).toBe('expired')
		expect((await redemptionsFor(orderId))[0]).toMatchObject({
			state: 'bound',
			points: 10,
		})
		expect(await balanceOf(orgId, memberId)).toEqual({
			points: 50,
			reserved: 10,
			available: 40,
		})

		// The guest pays the discounted total on that page.
		vi.setSystemTime(t0 + 15 * 60_000)
		const paid = await applyPaymentEvent({
			orgId,
			orderId,
			sessionId: 'cs_late',
			processor: 'connect',
			status: 'paid',
			amountCents: placed.order.totalCents,
			currency: 'USD',
		})
		expect(paid.ok && paid.data.status).toBe('payment_review')
		expect((await redemptionsFor(orderId))[0]).toMatchObject({
			state: 'review',
			reviewReason: 'payment_uncertain',
		})

		// The operator accepts the order: the reward is spent, the net spend earns.
		vi.setSystemTime(t0 + 20 * 60_000)
		const done = await updateOperatorOrder(orgId, orderId, {
			status: 'completed',
		})
		expect(done.ok).toBe(true)
		await processLoyaltyOutbox(orgId, { now: Date.now() + 1000 })
		expect((await redemptionsFor(orderId))[0]!.state).toBe('consumed')
		// 50 - 10 spent + 15 earned on 15.00 net of the reward.
		expect(await balanceOf(orgId, memberId)).toEqual({
			points: 55,
			reserved: 0,
			available: 55,
		})
	})

	it('gives the points back from the tick once the lapsed order’s payment page has closed', async () => {
		const placed = await (
			await postOrder(
				orderBody({ paymentMethod: 'online', loyalty: rewardSelection() }),
			)
		).json()
		const orderId = placed.order.id
		await bindPaymentSession({
			orgId,
			orderId,
			sessionId: 'cs_gone',
			processor: 'connect',
		})
		const hold = await holdOf(orderId)
		const closes = hold + ONLINE_PAYABLE_AFTER_HOLD_MS.connect

		// The tick expires the lapsed hold itself; the page is still open.
		const lapsed = await runLoyaltyTickForOrg(orgId, { now: hold + 1000 })
		expect(await orderStatus(orderId)).toEqual({
			status: 'expired',
			paymentStatus: 'expired',
		})
		expect((await redemptionsFor(orderId))[0]!.state).toBe('bound')
		expect(lapsed.nextDueAt).toBe(closes)

		const early = await runLoyaltyTickForOrg(orgId, { now: closes - 1000 })
		expect((await redemptionsFor(orderId))[0]!.state).toBe('bound')
		expect(early.nextDueAt).toBe(closes)

		const closed = await runLoyaltyTickForOrg(orgId, { now: closes })
		expect((await redemptionsFor(orderId))[0]).toMatchObject({
			state: 'released',
			releaseReason: 'payment_expired',
		})
		expect(await balanceOf(orgId, memberId)).toEqual({
			points: 50,
			reserved: 0,
			available: 50,
		})
		expect(closed.nextDueAt).toBeNull()
	})

	it('lets the tick expire a hold nobody read, and wakes up when it lapses', async () => {
		const placed = await (
			await postOrder(
				orderBody({ paymentMethod: 'online', loyalty: rewardSelection() }),
			)
		).json()
		const orderId = placed.order.id
		const hold = await holdOf(orderId)

		const before = await runLoyaltyTickForOrg(orgId, { now: hold - 60_000 })
		expect(before.nextDueAt).toBe(hold)
		expect((await redemptionsFor(orderId))[0]!.state).toBe('bound')

		// No payment page was opened: nothing can still pay it.
		await runLoyaltyTickForOrg(orgId, { now: hold + 1000 })
		expect((await orderStatus(orderId)).status).toBe('expired')
		expect((await redemptionsFor(orderId))[0]).toMatchObject({
			state: 'released',
			releaseReason: 'payment_expired',
		})
		expect((await balanceOf(orgId, memberId)).reserved).toBe(0)
	})

	it('quotes every reward on the cart and the totals with the pick, holding nothing', async () => {
		const response = await postQuote({
			order: orderBody(),
			selection: rewardSelection(),
		})
		expect(response.status).toBe(200)
		expect(response.headers.get('cache-control')).toContain('no-store')
		const quote = await response.json()
		expect(quote).toMatchObject({
			currency: 'USD',
			unitLabel: 'points',
			balance: { points: 50, reserved: 0, available: 50 },
			selectedRewardId: rewardId,
			availableAfter: 40,
			totals: {
				subtotalMinor: 2000,
				discountMinor: 500,
				taxMinor: 124,
				taxInclusive: false,
				totalMinor: 1624,
			},
		})
		expect(quote.rewards).toEqual([
			expect.objectContaining({
				rewardId,
				rewardVersion: 1,
				applicable: true,
				affordable: true,
				discountMinor: 500,
				pointsCost: 10,
			}),
		])
		expect((await balanceOf(orgId, memberId)).reserved).toBe(0)

		// The quoted discount is the one placement accepts.
		const placed = await postOrder(
			orderBody({
				loyalty: rewardSelection({
					expectedDiscountMinor: quote.rewards[0].discountMinor,
				}),
			}),
		)
		expect(placed.status).toBe(201)
		expect((await placed.json()).order.totalCents).toBe(quote.totals.totalMinor)
	})

	it('quotes without a pick, and never applies one the member cannot afford', async () => {
		const plain = await (await postQuote({ order: orderBody() })).json()
		expect(plain.selectedRewardId).toBeNull()
		expect(plain.totals).toMatchObject({
			discountMinor: 0,
			taxMinor: 165,
			totalMinor: 2165,
		})

		const pricey = (
			await makeReward(orgId, rewardDefinition({ pointsCost: 500 }))
		).id
		const quote = await (
			await postQuote({
				order: orderBody(),
				selection: rewardSelection({ rewardId: pricey }),
			})
		).json()
		expect(quote.selectedRewardId).toBeNull()
		expect(quote.totals.discountMinor).toBe(0)
		expect(
			quote.rewards.find((r: { rewardId: string }) => r.rewardId === pricey),
		).toMatchObject({
			applicable: true,
			affordable: false,
			code: 'insufficient_points',
		})
	})

	it('quotes a browser cart without contact or idempotency key', async () => {
		const { idempotencyKey, contact, ...cart } = orderBody()
		expect(idempotencyKey).toBeTruthy()
		expect(contact).toBeTruthy()
		const response = await postQuote({ order: cart })
		expect(response.status).toBe(200)
		const quote = await response.json()
		expect(quote.totals).toMatchObject({
			subtotalMinor: 2000,
			discountMinor: 0,
			totalMinor: 2165,
		})
	})

	it('refuses quotes to guests, customers who cannot have an account, and when redemption is off', async () => {
		expect((await postQuote({ order: orderBody() }, null)).status).toBe(401)

		// A phone nobody verified is never linked to the points system.
		await insertCustomer(orgId, {
			id: 'cust_2',
			phone: '+15551230002',
			verified: false,
		})
		const stranger = await postQuote({ order: orderBody() }, 'cust_2')
		expect(stranger.status).toBe(404)
		expect((await stranger.json()).error).toBe('member_not_found')

		seedLoyaltyContextForTest(orgId, {
			enabled: true,
			redemption: false,
		})
		const off = await postQuote({ order: orderBody() })
		expect(off.status).toBe(403)
		expect((await off.json()).error).toBe('redemption_disabled')
	})

	it('opens the account of a customer who verified before the program went live, on their first quote', async () => {
		const db = await getTenantDb(orgId)
		await insertCustomer(orgId, { id: 'cust_early', phone: '+15551230003' })
		expect(
			await db
				.select()
				.from(loyaltyMembers)
				.where(eq(loyaltyMembers.customerId, 'cust_early'))
				.all(),
		).toHaveLength(0)
		const quote = await postQuote({ order: orderBody() }, 'cust_early')
		expect(quote.status).toBe(200)
		expect((await quote.json()).balance).toMatchObject({ points: 0 })
		expect(
			await db
				.select()
				.from(loyaltyMembers)
				.where(eq(loyaltyMembers.customerId, 'cust_early'))
				.all(),
		).toHaveLength(1)
	})

	it('earns on the very first order of a customer who verified before the program went live', async () => {
		const db = await getTenantDb(orgId)
		await insertCustomer(orgId, { id: 'cust_early', phone: '+15551230004' })
		const placed = await postOrder(orderBody(), 'cust_early')
		expect(placed.status).toBe(201)
		const order = (await placed.json()).order
		const account = await db
			.select()
			.from(loyaltyMembers)
			.where(eq(loyaltyMembers.customerId, 'cust_early'))
			.get()
		expect(account).toBeDefined()
		await updateOperatorOrder(orgId, order.id, {
			status: 'completed',
			markPaid: true,
		})
		await processLoyaltyOutbox(orgId, { now: LATER() })
		expect(
			await db
				.select()
				.from(loyaltyPurchases)
				.where(eq(loyaltyPurchases.sourceId, order.id))
				.get(),
		).toMatchObject({
			memberId: account!.id,
			state: 'completed',
			awardedPoints: 20,
		})
		expect((await balanceOf(orgId, account!.id)).points).toBe(20)
	})

	it('opens no account for an order while the program is paused or loyalty is off', async () => {
		const db = await getTenantDb(orgId)
		await insertCustomer(orgId, { id: 'cust_early', phone: '+15551230005' })
		seedLoyaltyContextForTest(orgId, { enabled: false, redemption: false })
		const placed = await postOrder(orderBody(), 'cust_early')
		expect(placed.status).toBe(201)
		expect(
			await db
				.select()
				.from(loyaltyMembers)
				.where(eq(loyaltyMembers.customerId, 'cust_early'))
				.all(),
		).toHaveLength(0)
	})

	it('asks for nothing when the program terms change: rewards and earning carry on', async () => {
		const db = await getTenantDb(orgId)
		const before = (await readProgramInTx(db))!
		// Saved a moment ago: order times are stored to the second.
		await saveProgram(orgId, {
			expectedVersion: before.program.version,
			config: programConfig({
				terms: 'New terms: points expire after a year.',
			}),
			actorId: 'op_test',
			now: Date.now() - 5_000,
		})

		const quote = await postQuote({
			order: orderBody(),
			selection: rewardSelection(),
		})
		expect(quote.status).toBe(200)
		expect((await quote.json()).selectedRewardId).toBe(rewardId)

		// An order without a reward earns as before.
		const placed = await (await postOrder(orderBody())).json()
		await updateOperatorOrder(orgId, placed.order.id, {
			status: 'completed',
			markPaid: true,
		})
		await processLoyaltyOutbox(orgId, { now: LATER() })
		expect(
			await db
				.select()
				.from(loyaltyPurchases)
				.where(eq(loyaltyPurchases.sourceId, placed.order.id))
				.get(),
		).toMatchObject({ state: 'completed', awardedPoints: 20 })
		expect((await balanceOf(orgId, memberId)).points).toBe(70)

		// And an order with a reward is placed.
		const rewarded = await postOrder(orderBody({ loyalty: rewardSelection() }))
		expect(rewarded.status).toBe(201)
	})

	it('replays the same checkout without holding the points twice', async () => {
		const body = orderBody({ loyalty: rewardSelection() })
		const first = await postOrder(body)
		const second = await postOrder(body)
		expect(first.status).toBe(201)
		expect(second.status).toBe(200)
		const firstBody = await first.json()
		expect((await second.json()).order.id).toBe(firstBody.order.id)
		expect(await redemptionsFor(firstBody.order.id)).toHaveLength(1)
		expect((await balanceOf(orgId, memberId)).reserved).toBe(10)
	})

	describe('while App cannot be asked for the flags', () => {
		let flagReads: number

		/**
		 * App never answers a request for the flags (`hangs`) or cannot be
		 * reached at all (`refuses`); nothing is cached.
		 */
		function appDown(mode: 'hangs' | 'refuses') {
			invalidateLoyaltyContext(orgId)
			flagReads = 0
			vi.stubGlobal(
				'fetch',
				vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
					const url = typeof input === 'string' ? input : input.toString()
					if (url.includes('/resources/order-context')) {
						return Response.json(activeContext)
					}
					if (url.includes('/resources/loyalty/context')) {
						flagReads += 1
						if (mode === 'refuses') throw new TypeError('fetch failed')
						return new Promise<Response>((_, reject) => {
							init?.signal?.addEventListener('abort', () =>
								reject(new DOMException('aborted', 'AbortError')),
							)
						})
					}
					return new Response('not found', { status: 404 })
				}),
			)
		}

		async function purchasesOf(orderId: string) {
			const db = await getTenantDb(orgId)
			return db
				.select()
				.from(loyaltyPurchases)
				.where(eq(loyaltyPurchases.sourceId, orderId))
				.all()
		}

		it('still credits signed-in members’ orders, asking App once and not on every order', async () => {
			appDown('hangs')
			const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
			try {
				const started = Date.now()
				const overlapping = await Promise.all([
					postOrder(orderBody()),
					postOrder(orderBody()),
				])
				// Both orders waited on the same request, cut off at the timeout.
				expect(Date.now() - started).toBeLessThan(
					LOYALTY_CONTEXT_TIMEOUT_MS + 1500,
				)
				expect(flagReads).toBe(1)

				// The next order does not wait on App at all.
				const next = Date.now()
				const third = await postOrder(orderBody())
				expect(Date.now() - next).toBeLessThan(LOYALTY_CONTEXT_TIMEOUT_MS)
				expect(flagReads).toBe(1)
				expect(errors).toHaveBeenCalledTimes(1)
				expect(errors).toHaveBeenCalledWith('Loyalty flags could not be read', {
					orgId,
					reason: 'timeout',
					status: 'unknown',
					stale: false,
				})

				const orders = []
				for (const response of [...overlapping, third]) {
					expect(response.status).toBe(201)
					orders.push((await response.json()).order)
				}
				for (const order of orders) {
					expect(await purchasesOf(order.id)).toEqual([
						expect.objectContaining({ memberId, state: 'open' }),
					])
					await updateOperatorOrder(orgId, order.id, {
						status: 'completed',
						markPaid: true,
					})
				}
				await processLoyaltyOutbox(orgId, { now: LATER() })
				// 50 + 20 points on each 20.00 order.
				expect((await balanceOf(orgId, memberId)).points).toBe(110)
			} finally {
				errors.mockRestore()
			}
		})

		it('refuses a reward without placing the order', async () => {
			appDown('refuses')
			const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
			try {
				const response = await postOrder(
					orderBody({ loyalty: rewardSelection() }),
				)
				expect(response.status).toBe(503)
				expect((await response.json()).error).toBe('loyalty_unavailable')
				const db = await getTenantDb(orgId)
				expect(await db.select().from(restaurantOrders).all()).toHaveLength(0)
				expect(await db.select().from(loyaltyRedemptions).all()).toHaveLength(0)
				expect((await balanceOf(orgId, memberId)).reserved).toBe(0)
			} finally {
				errors.mockRestore()
			}
		})

		it('credits nobody when App says loyalty is off', async () => {
			seedLoyaltyContextForTest(orgId, {
				enabled: false,
				redemption: false,
			})
			const placed = await postOrder(orderBody())
			expect(placed.status).toBe(201)
			expect(await purchasesOf((await placed.json()).order.id)).toEqual([])
		})
	})
})
