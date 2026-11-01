import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import {
	destroyTenantDb,
	discountCodeAttempts,
	discountRedemptions,
	getTenantDb,
	provisionTenantDb,
	qrTabs,
	restaurantOrders,
} from '@repo/tenant-db'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeDiscount } from '../../../../packages/discounts/src/test-fixtures.ts'
import { DISCOUNT_RATE_LIMITS } from '../lib/discount-rate-limit.ts'
import {
	findActiveOrganizationById,
	resolveOrganizationForBrowserAuth,
} from '../lib/origin.ts'
import {
	getOperatorOrder,
	operatorOrder,
	sweepExpiredHolds,
	updateOperatorOrder,
} from '../services/order-service.ts'
import { resetTabViewContextCache } from '../services/qr-tab-service.ts'
import { operatorQrRoutes } from './operator-qr.ts'
import { orderSystemRoutes } from './order-system.ts'
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
 * How discounts are recorded and limited over an order's and a tab's life:
 * counter close, late payments, coupon guessing, no-shows and pickup time.
 */

const orgId = 'org_discount_life_1'
const internalToken = 'test-internal-token-very-long-and-secure-12345'
const operatorToken = 'test-operator-token-very-long-and-secure-12345'
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
const HOUR = 60 * 60 * 1000

function menuContext(discounts: Record<string, unknown> | null) {
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
		...(discounts ? { discounts } : {}),
	}
}

function autoDiscounts(overrides: Record<string, unknown> = {}) {
	return {
		features: { automatic: true, coupons: true },
		discounts: [
			makeDiscount({ id: 'disc_auto', name: 'Ten percent', ...overrides }),
			// Fifteen percent, so the code beats the automatic ten percent: a
			// code that only ties keeps the automatic discount.
			makeDiscount({
				id: 'disc_code',
				name: 'Welcome',
				application: 'code',
				percentBp: 1500,
			}),
		],
		codes: [
			{
				id: 'code_welcome',
				discountId: 'disc_code',
				normalizedCode: 'SAVE10',
				maxUses: null,
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
		contact: { name: 'Rana Khalid', phone: '+1 555 123 4567' },
		tipPercent: 0,
		lines: [{ itemId: 'item-burger', quantity: 2, options: [] }],
		...overrides,
	}
}

async function operatorJwt() {
	return new SignJWT({ orgId, role: 'operator', scope: 'qr:write' })
		.setSubject('user_1')
		.setProtectedHeader({ alg: 'HS256' })
		.setAudience('tenant-api-operator')
		.setIssuer(brand.shortName)
		.setExpirationTime('15m')
		.sign(new TextEncoder().encode(operatorToken))
}

describe('discount lifecycle', () => {
	let directory: string
	let app: Hono
	let activeContext: Record<string, unknown>

	async function request(
		pathname: string,
		init: {
			method?: string
			body?: unknown
			headers?: Record<string, string>
		} = {},
	) {
		return app.request(pathname, {
			method: init.method ?? 'GET',
			headers: {
				'content-type': 'application/json',
				origin: 'https://test-org.example.com',
				...init.headers,
			},
			...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
		})
	}

	const post = (pathname: string, body: unknown, headers = {}) =>
		request(pathname, { method: 'POST', body, headers })

	async function operator(pathname: string, body?: unknown) {
		return request(`/operator/qr${pathname}`, {
			method: body === undefined ? 'GET' : 'POST',
			body,
			headers: { authorization: `Bearer ${await operatorJwt()}` },
		})
	}

	async function system(pathname: string, body: unknown) {
		return app.request(`/api/orders${pathname}`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${internalToken}`,
			},
			body: JSON.stringify(body),
		})
	}

	async function redemptions(sourcePrefix: string) {
		const db = await getTenantDb(orgId)
		const rows = await db.select().from(discountRedemptions).all()
		return rows.filter(
			(row) =>
				row.sourceId === sourcePrefix ||
				row.sourceId.startsWith(`${sourcePrefix}:`),
		)
	}

	async function createTable(label = 'T1') {
		const response = await request('/operator/qr/tables', {
			method: 'POST',
			body: { locationId: 'loc-1', label },
			headers: { authorization: `Bearer ${await operatorJwt()}` },
		})
		expect(response.status).toBe(201)
		return (await response.json()).table as { id: string; token: string }
	}

	async function placeRound(code: Record<string, string>) {
		const response = await post(
			'/orders',
			orderBody({ fulfillment: 'dine_in', contact: {} }),
			code,
		)
		expect(response.status).toBe(201)
		return (await response.json()) as {
			order: { id: string }
			tab: { id: string; tabToken: string }
		}
	}

	/** A tab of two burgers (2000 plus 165 tax), every round served. */
	async function openServedTab(label = 'T1') {
		const table = await createTable(label)
		const round = await placeRound({ 'X-Table-Token': table.token })
		const db = await getTenantDb(orgId)
		await db
			.update(restaurantOrders)
			.set({ status: 'completed' })
			.where(eq(restaurantOrders.tabId, round.tab.id))
		return round.tab
	}

	async function close(tabId: string, body: Record<string, unknown> = {}) {
		return operator(`/tabs/${tabId}/close`, {
			paymentMethod: 'counter',
			...body,
		})
	}

	async function operatorTab(tabId: string) {
		const response = await operator(`/tabs/${tabId}`)
		expect(response.status).toBe(200)
		return (await response.json()).tab as {
			status: string
			totals: {
				subtotalCents: number
				taxCents: number
				totalCents: number
				discountCents?: number
			}
		}
	}

	beforeEach(async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'discount-life-'))
		vi.stubEnv('TENANT_DB_DIR', directory)
		vi.stubEnv('DATA_REGION', 'us')
		vi.stubEnv('INTERNAL_COMMAND_TOKEN', internalToken)
		vi.stubEnv('TENANT_OPERATOR_TOKEN', operatorToken)
		vi.stubEnv('JWT_SECRET', 'test-jwt-secret-123456789')
		vi.stubEnv('AUTH_HMAC_SECRET', 'test-hmac-secret-123456789')
		vi.stubEnv('APP_URL', 'https://app.test')
		vi.stubEnv('DISCOUNTS_ENABLED', 'true')
		vi.stubEnv('QR_DINE_IN_ENABLED', '')
		resetTabViewContextCache()

		activeContext = menuContext(autoDiscounts())
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
		app = new Hono()
		app.route('/orders', publicOrderRoutes)
		app.route('/operator/qr', operatorQrRoutes)
		app.route('/api/orders', orderSystemRoutes)
	})

	afterEach(async () => {
		try {
			await destroyTenantDb(orgId)
			fs.rmSync(directory, { recursive: true, force: true })
		} catch {
			// The directory is already gone when a test failed mid-setup.
		}
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
		vi.clearAllMocks()
	})

	// -----------------------------------------------------------------------
	// 1. A tab closed at the counter gets its discounts
	// -----------------------------------------------------------------------

	describe('a tab closed at the counter', () => {
		it('shows the discount in the quote and records it, reserved then consumed', async () => {
			const tab = await openServedTab()

			// What the guest reads in the drawer is net of the discount.
			const guest = await request('/orders/tab?slug=test-org', {
				headers: { 'X-Tab-Token': tab.tabToken },
			})
			const shown = (await guest.json()).tab
			expect(shown.totals.discountCents).toBe(200)
			expect(shown.totals.subtotalCents).toBe(2000)
			// Tax shrinks with the taxable amount: 165 becomes 149.
			expect(shown.totals.taxCents).toBe(149)
			expect(shown.totals.totalCents).toBe(1949)

			// The operator reads the same figure, and sends it back to confirm.
			const seen = await operatorTab(tab.id)
			expect(seen.totals.totalCents).toBe(1949)
			expect(seen.totals.discountCents).toBe(200)

			const closed = await close(tab.id, {
				tipCents: 100,
				expectedTotalCents: seen.totals.totalCents,
			})
			expect(closed.status).toBe(200)
			const body = (await closed.json()).tab
			expect(body.status).toBe('closed')
			// The counter charges what was shown, plus the tip.
			expect(body.totals.totalCents).toBe(1949 + 100)
			expect(body.totals.taxCents).toBe(149)
			expect(body.totals.discountCents).toBe(200)

			const rows = await redemptions(tab.id)
			expect(rows).toHaveLength(1)
			expect(rows[0]).toMatchObject({
				discountId: 'disc_auto',
				sourceType: 'tab',
				state: 'consumed',
				amountMinor: 200,
			})
		})

		it('records the same use a phone payment would', async () => {
			const tab = await openServedTab()
			const pay = await post(
				'/orders/tab/pay',
				{
					slug: 'test-org',
					tipPercent: 0,
					contact: { name: 'Lina Haddad', phone: '+1 555 222 3333' },
					discounts: { expectedDiscountMinor: 200 },
				},
				{ 'X-Tab-Token': tab.tabToken },
			)
			expect(pay.status).toBe(200)
			const intent = await pay.json()
			// The phone payment and the counter close charge the same bill.
			expect(intent.amountCents).toBe(1949)
			const [reserved] = await redemptions(tab.id)
			expect(reserved).toMatchObject({ state: 'reserved', amountMinor: 200 })
		})

		it('refuses a total that is not the one shown and writes nothing', async () => {
			const tab = await openServedTab()
			const response = await close(tab.id, {
				// The undiscounted total: the dialog showed a net one.
				expectedTotalCents: 2165,
			})
			expect(response.status).toBe(409)
			expect(await response.json()).toMatchObject({ error: 'stale_tab' })
			expect(await redemptions(tab.id)).toHaveLength(0)
			const db = await getTenantDb(orgId)
			const [row] = await db.select().from(qrTabs).where(eq(qrTabs.id, tab.id))
			expect(row?.status).toBe('open')
		})

		it('closes at the plain total when the order context cannot be reached', async () => {
			const tab = await openServedTab()
			vi.stubGlobal(
				'fetch',
				vi.fn(async () => new Response('down', { status: 503 })),
			)
			resetTabViewContextCache()
			const response = await close(tab.id)
			expect(response.status).toBe(200)
			const body = (await response.json()).tab
			expect(body.totals.totalCents).toBe(2165)
			expect(await redemptions(tab.id)).toHaveLength(0)
		})

		it('records no discount for a tab rung up on a Station till', async () => {
			const tab = await openServedTab()
			const response = await close(tab.id, {
				rungUpOnStation: true,
			})
			expect(response.status).toBe(200)
			expect((await response.json()).tab.totals.totalCents).toBe(2165)
			expect(await redemptions(tab.id)).toHaveLength(0)
		})

		it('counts toward a total limit, so the next tab does not get the last use twice', async () => {
			activeContext = menuContext(autoDiscounts({ totalLimit: 1 }))
			const first = await openServedTab('T1')
			const second = await openServedTab('T2')
			expect((await operatorTab(second.id)).totals.discountCents).toBe(200)
			expect((await close(first.id)).status).toBe(200)

			resetTabViewContextCache()
			const seen = await operatorTab(second.id)
			expect(seen.totals.discountCents).toBeUndefined()
			expect(seen.totals.totalCents).toBe(2165)
			const closed = await close(second.id, {
				expectedTotalCents: 2165,
			})
			expect(closed.status).toBe(200)
			expect(await redemptions(second.id)).toHaveLength(0)
		})
	})

	// -----------------------------------------------------------------------
	// 6. Tabs behave like orders: the field asks, a missing total is 0
	// -----------------------------------------------------------------------

	describe('a phone payment on a tab', () => {
		async function payWith(tab: { tabToken: string }, discounts?: unknown) {
			return post(
				'/orders/tab/pay',
				{
					slug: 'test-org',
					tipPercent: 0,
					contact: { name: 'Lina Haddad', phone: '+1 555 222 3333' },
					...(discounts === undefined ? {} : { discounts }),
				},
				{ 'X-Tab-Token': tab.tabToken },
			)
		}

		it('applies nothing when the client sent no discounts field', async () => {
			const tab = await openServedTab()
			const response = await payWith(tab)
			expect(response.status).toBe(200)
			expect((await response.json()).amountCents).toBe(2165)
			expect(await redemptions(tab.id)).toHaveLength(0)
		})

		it('reads a missing expected total as 0 and answers with what it priced', async () => {
			const tab = await openServedTab()
			const response = await payWith(tab, {})
			expect(response.status).toBe(409)
			expect(await response.json()).toMatchObject({
				error: 'discount_changed',
				details: { discountMinor: 200 },
			})
			expect(await redemptions(tab.id)).toHaveLength(0)

			const again = await payWith(tab, { expectedDiscountMinor: 200 })
			expect(again.status).toBe(200)
			expect((await again.json()).amountCents).toBe(1949)
		})
	})

	// -----------------------------------------------------------------------
	// 2. A late-paid order or tab is honored and counted
	// -----------------------------------------------------------------------

	describe('a sale paid after its hold lapsed', () => {
		async function lapsedPaidOrder() {
			const placed = await post(
				'/orders',
				orderBody({
					paymentMethod: 'online',
					discounts: { expectedDiscountMinor: 200 },
				}),
			)
			expect(placed.status).toBe(201)
			const { order } = await placed.json()
			const session = { orgId, orderId: order.id, sessionId: 'cs_late_1' }
			expect(
				(await system('/payment-session', { ...session, processor: 'connect' }))
					.status,
			).toBe(200)
			// The hold runs out and the sweep gives the use back.
			const db = await getTenantDb(orgId)
			await db
				.update(restaurantOrders)
				.set({ holdExpiresAt: new Date(Date.now() - 60_000) })
				.where(eq(restaurantOrders.id, order.id))
			await sweepExpiredHolds(orgId)
			const [released] = await redemptions(order.id)
			expect(released).toMatchObject({ state: 'released' })

			const paid = await system('/payment-status', {
				...session,
				processor: 'connect',
				status: 'paid',
				amountCents: order.totalCents,
				currency: 'usd',
			})
			expect(paid.status).toBe(200)
			expect((await paid.json()).status).toBe('payment_review')
			return order.id as string
		}

		/**
		 * An online order whose hold lapsed (the use came back), then another
		 * order takes the use, then the first one's payment arrives.
		 */
		async function lapsedThenTaken(discounts: Record<string, unknown>) {
			const body = (extra: Record<string, unknown>) =>
				orderBody({ discounts, ...extra })
			const placed = await post('/orders', body({ paymentMethod: 'online' }))
			expect(placed.status).toBe(201)
			const { order } = await placed.json()
			const session = { orgId, orderId: order.id, sessionId: 'cs_late_2' }
			expect(
				(await system('/payment-session', { ...session, processor: 'connect' }))
					.status,
			).toBe(200)
			const db = await getTenantDb(orgId)
			await db
				.update(restaurantOrders)
				.set({ holdExpiresAt: new Date(Date.now() - 60_000) })
				.where(eq(restaurantOrders.id, order.id))
			await sweepExpiredHolds(orgId)
			// Someone else takes the freed use.
			const other = await post('/orders', body({ paymentMethod: 'handoff' }))
			expect(other.status).toBe(201)
			const paid = await system('/payment-status', {
				...session,
				processor: 'connect',
				status: 'paid',
				amountCents: order.totalCents,
				currency: 'usd',
			})
			expect(paid.status).toBe(200)
			expect((await paid.json()).status).toBe('payment_review')
			return order.id as string
		}

		async function reviewReasonOf(orderId: string) {
			const found = await getOperatorOrder(orgId, orderId)
			if (!found.ok) throw new Error('order missing')
			return operatorOrder(found.data).reviewReason
		}

		it('flags a late sale for review when others took the last use of a limited discount', async () => {
			activeContext = menuContext(autoDiscounts({ totalLimit: 1 }))
			const orderId = await lapsedThenTaken({ expectedDiscountMinor: 200 })
			// The sale is honored: its use is recorded again, never refused.
			expect(
				(await redemptions(orderId)).map((row) => row.state).sort(),
			).toEqual(['released', 'reserved'])
			expect(await reviewReasonOf(orderId)).toBe('discount_limit_exceeded')
		})

		it('flags a late sale that used a single-use code another order has since taken', async () => {
			activeContext = menuContext({
				features: { automatic: true, coupons: true },
				discounts: [
					makeDiscount({
						id: 'disc_code',
						name: 'Welcome',
						application: 'code',
						percentBp: 1000,
					}),
				],
				codes: [
					{
						id: 'code_once',
						discountId: 'disc_code',
						normalizedCode: 'ONCE',
						maxUses: 1,
					},
				],
			})
			const orderId = await lapsedThenTaken({
				code: 'ONCE',
				expectedDiscountMinor: 200,
			})
			expect(
				(await redemptions(orderId)).map((row) => row.state).sort(),
			).toEqual(['released', 'reserved'])
			expect(await reviewReasonOf(orderId)).toBe('discount_limit_exceeded')
		})

		it('gives no reason when nothing was used up in the meantime', async () => {
			activeContext = menuContext(autoDiscounts({ totalLimit: 1 }))
			const orderId = await lapsedPaidOrder()
			expect(await reviewReasonOf(orderId)).toBeNull()
		})

		it('records the use again while the payment waits for review', async () => {
			activeContext = menuContext(autoDiscounts({ totalLimit: 1 }))
			const orderId = await lapsedPaidOrder()
			const rows = await redemptions(orderId)
			expect(rows.map((row) => row.state).sort()).toEqual([
				'released',
				'reserved',
			])
			// It counts: the one use is spoken for, so the next order is refused.
			const next = await post(
				'/orders',
				orderBody({ discounts: { expectedDiscountMinor: 200 } }),
			)
			expect(next.status).toBe(409)
			expect(await next.json()).toMatchObject({ error: 'discount_changed' })
		})

		it('consumes the use when the operator accepts the order', async () => {
			activeContext = menuContext(autoDiscounts({ totalLimit: 1 }))
			const orderId = await lapsedPaidOrder()
			const accepted = await updateOperatorOrder(orgId, orderId, {
				status: 'preparing',
			})
			expect(accepted.ok).toBe(true)
			const rows = await redemptions(orderId)
			expect(rows.map((row) => row.state).sort()).toEqual([
				'consumed',
				'released',
			])
			const next = await post(
				'/orders',
				orderBody({ discounts: { expectedDiscountMinor: 200 } }),
			)
			expect(next.status).toBe(409)
		})

		it('gives the use back when the operator cancels the order', async () => {
			activeContext = menuContext(autoDiscounts({ totalLimit: 1 }))
			const orderId = await lapsedPaidOrder()
			const cancelled = await updateOperatorOrder(orgId, orderId, {
				status: 'cancelled',
			})
			expect(cancelled.ok).toBe(true)
			expect((await redemptions(orderId)).map((row) => row.state)).toEqual([
				'released',
				'released',
			])
			const next = await post(
				'/orders',
				orderBody({ discounts: { expectedDiscountMinor: 200 } }),
			)
			expect(next.status).toBe(201)
		})

		it('honors a review order that reached review before the use was re-recorded', async () => {
			activeContext = menuContext(autoDiscounts({ totalLimit: 1 }))
			const placed = await post(
				'/orders',
				orderBody({
					paymentMethod: 'online',
					discounts: { expectedDiscountMinor: 200 },
				}),
			)
			const { order } = await placed.json()
			const db = await getTenantDb(orgId)
			await db
				.update(restaurantOrders)
				.set({ holdExpiresAt: new Date(Date.now() - 60_000) })
				.where(eq(restaurantOrders.id, order.id))
			await sweepExpiredHolds(orgId)
			// An order left in review by the earlier behavior: paid, use released.
			await db
				.update(restaurantOrders)
				.set({ status: 'payment_review', paymentStatus: 'paid' })
				.where(eq(restaurantOrders.id, order.id))
			const accepted = await updateOperatorOrder(orgId, order.id, {
				status: 'completed',
			})
			expect(accepted.ok).toBe(true)
			expect(
				(await redemptions(order.id)).map((row) => row.state).sort(),
			).toEqual(['consumed', 'released'])
		})

		it('refunds the re-recorded use with the order', async () => {
			activeContext = menuContext(autoDiscounts({ totalLimit: 1 }))
			const orderId = await lapsedPaidOrder()
			await updateOperatorOrder(orgId, orderId, { status: 'preparing' })
			const { refundDiscountRedemptions } =
				await import('../services/discount-apply.ts')
			const db = await getTenantDb(orgId)
			await refundDiscountRedemptions(db, orderId)
			expect(
				(await redemptions(orderId)).map((row) => row.state).sort(),
			).toEqual(['refunded', 'released'])
		})
	})

	describe('an abandoned tab payment', () => {
		it('stops counting against a limit once the payment hold has passed', async () => {
			activeContext = menuContext(autoDiscounts({ totalLimit: 1 }))
			const tab = await openServedTab()
			const pay = await post(
				'/orders/tab/pay',
				{
					slug: 'test-org',
					tipPercent: 0,
					contact: { name: 'Lina Haddad', phone: '+1 555 222 3333' },
					discounts: { expectedDiscountMinor: 200 },
				},
				{ 'X-Tab-Token': tab.tabToken },
			)
			expect(pay.status).toBe(200)
			// No provider session was ever bound: the tab's use is reserved.
			expect((await redemptions(tab.id)).map((row) => row.state)).toEqual([
				'reserved',
			])
			const place = () =>
				post(
					'/orders',
					orderBody({ discounts: { expectedDiscountMinor: 200 } }),
				)
			expect((await place()).status).toBe(409)

			const db = await getTenantDb(orgId)
			// 40 minutes in: inside the hold, still counted.
			await db
				.update(qrTabs)
				.set({ paymentEventAt: Date.now() - 40 * 60 * 1000 })
				.where(eq(qrTabs.id, tab.id))
			expect((await place()).status).toBe(409)

			// Past the 45 minute hold: it stops counting. Only the count changes.
			await db
				.update(qrTabs)
				.set({ paymentEventAt: Date.now() - 50 * 60 * 1000 })
				.where(eq(qrTabs.id, tab.id))
			expect((await place()).status).toBe(201)
			expect((await redemptions(tab.id)).map((row) => row.state)).toEqual([
				'reserved',
			])
		})
	})

	describe('a tab paid after its payment page lapsed', () => {
		it('is counted once, at the counter close that settles it', async () => {
			const tab = await openServedTab()
			const pay = await post(
				'/orders/tab/pay',
				{
					slug: 'test-org',
					tipPercent: 0,
					contact: { name: 'Lina Haddad', phone: '+1 555 222 3333' },
					discounts: { expectedDiscountMinor: 200 },
				},
				{ 'X-Tab-Token': tab.tabToken },
			)
			expect(pay.status).toBe(200)
			const intent = await pay.json()
			const session = {
				orgId,
				orderId: intent.orderRef,
				sessionId: 'cs_tab_late',
				processor: 'connect',
			}
			expect((await system('/payment-session', session)).status).toBe(200)
			// The page expires: the use comes back.
			const expired = await system('/payment-status', {
				...session,
				status: 'expired',
				amountCents: intent.amountCents,
				currency: 'usd',
			})
			expect(expired.status).toBe(200)
			expect((await redemptions(tab.id)).map((row) => row.state)).toEqual([
				'released',
			])
			// The money still arrives: kept for review, never closing blind.
			const late = await system('/payment-status', {
				...session,
				status: 'paid',
				amountCents: intent.amountCents,
				currency: 'usd',
			})
			expect((await late.json()).paymentStatus).toBe('review')

			const seen = await operatorTab(tab.id)
			const closed = await close(tab.id, {
				acknowledgeReview: true,
				expectedTotalCents: seen.totals.totalCents,
			})
			expect(closed.status).toBe(200)
			expect(
				(await redemptions(tab.id)).map((row) => row.state).sort(),
			).toEqual(['consumed', 'released'])
		})

		it('consumes the use of a payment that settles the tab online', async () => {
			const tab = await openServedTab()
			const pay = await post(
				'/orders/tab/pay',
				{
					slug: 'test-org',
					tipPercent: 0,
					contact: { name: 'Lina Haddad', phone: '+1 555 222 3333' },
					discounts: { expectedDiscountMinor: 200 },
				},
				{ 'X-Tab-Token': tab.tabToken },
			)
			const intent = await pay.json()
			const session = {
				orgId,
				orderId: intent.orderRef,
				sessionId: 'cs_tab_ok',
				processor: 'connect',
			}
			expect((await system('/payment-session', session)).status).toBe(200)
			const paid = await system('/payment-status', {
				...session,
				status: 'paid',
				amountCents: intent.amountCents,
				currency: 'usd',
			})
			expect((await paid.json()).paymentStatus).toBe('paid')
			expect((await redemptions(tab.id)).map((row) => row.state)).toEqual([
				'consumed',
			])
			// The settled tab keeps the discounted tax and shows its discount.
			const guest = await request('/orders/tab?slug=test-org', {
				headers: { 'X-Tab-Token': tab.tabToken },
			})
			const { totals } = (await guest.json()).tab
			expect(totals).toMatchObject({
				subtotalCents: 2000,
				taxCents: 149,
				discountCents: 200,
				totalCents: 1949,
			})
		})
	})

	// -----------------------------------------------------------------------
	// 3. The coupon guess limit holds under parallel requests
	// -----------------------------------------------------------------------

	describe('coupon guessing', () => {
		const ip = { 'cf-connecting-ip': '203.0.113.9' }

		async function quote(code: string, lines = 2) {
			return post(
				'/orders/quote',
				orderBody({
					idempotencyKey: undefined,
					contact: undefined,
					lines: [{ itemId: 'item-burger', quantity: lines, options: [] }],
					discounts: { code },
				}),
				ip,
			)
		}

		async function counted(bucket: string) {
			const db = await getTenantDb(orgId)
			const rows = await db
				.select()
				.from(discountCodeAttempts)
				.where(eq(discountCodeAttempts.bucket, bucket))
			return rows.reduce((sum, row) => sum + row.count, 0)
		}

		it('stops parallel wrong guesses at the limit instead of letting them all through', async () => {
			const codes = Array.from({ length: 50 }, (_, index) => `NOPE${index}`)
			const responses = await Promise.all(codes.map((code) => quote(code)))
			const statuses = responses.map((response) => response.status)
			// 20 wrong guesses per address per window, whatever the order they land.
			expect(statuses.filter((status) => status === 200)).toHaveLength(20)
			expect(statuses.filter((status) => status === 429)).toHaveLength(30)
			// Attempts that lost the race gave back what they counted.
			expect(await counted('codeIp')).toBe(20)
			const limited = responses.find((response) => response.status === 429)!
			expect((await limited.json()).error).toBe('rate_limit_exceeded')
		})

		it('counts the same cart and wrong code once, however often the page asks', async () => {
			for (let index = 0; index < 6; index++) {
				expect((await quote('NOPE')).status).toBe(200)
			}
			expect(await counted('codeIp')).toBe(1)
			expect(await counted('codeOrg')).toBe(1)
			// A changed cart is a new question.
			expect((await quote('NOPE', 3)).status).toBe(200)
			expect(await counted('codeIp')).toBe(2)
		})

		it('gives the count back when the code applies', async () => {
			for (let index = 0; index < 30; index++) {
				const response = await quote('SAVE10', 1 + (index % 5))
				expect(response.status).toBe(200)
				expect((await response.json()).coupon).toMatchObject({
					status: 'applied',
				})
			}
			expect(await counted('codeIp')).toBe(0)
			expect(await counted('codeOrg')).toBe(0)
		})

		it('does not charge the organization for an address that is already refused', async () => {
			for (let index = 0; index < 30; index++) await quote(`PROBE${index}`)
			// Over-budget requests are refused before a row is written.
			expect(await counted('codeIp')).toBe(20)
			// Only the 20 guesses the address was allowed reached the shared budget.
			expect(await counted('codeOrg')).toBe(20)
			// A different address is not locked out by the first one.
			const other = await post(
				'/orders/quote',
				orderBody({
					idempotencyKey: undefined,
					contact: undefined,
					discounts: { code: 'SAVE10' },
				}),
				{ 'cf-connecting-ip': '203.0.113.77' },
			)
			expect(other.status).toBe(200)
			expect((await other.json()).coupon).toMatchObject({ status: 'applied' })
		})

		it('asks guests to sign in once the organization guest budget is spent, counting nothing', async () => {
			const orgLimit = DISCOUNT_RATE_LIMITS.codeOrg as { max: number }
			const max = orgLimit.max
			orgLimit.max = 3
			try {
				for (const [index, address] of [
					'203.0.113.21',
					'203.0.113.22',
					'203.0.113.23',
				].entries()) {
					const response = await post(
						'/orders/quote',
						orderBody({
							idempotencyKey: undefined,
							contact: undefined,
							discounts: { code: `WRONG${index}` },
						}),
						{ 'cf-connecting-ip': address },
					)
					expect(response.status).toBe(200)
				}
				// A fresh address, even with a valid code, is asked to sign in
				// (where the customer's own budget applies) instead of locked out.
				const blocked = await post(
					'/orders/quote',
					orderBody({
						idempotencyKey: undefined,
						contact: undefined,
						discounts: { code: 'SAVE10' },
					}),
					{ 'cf-connecting-ip': '203.0.113.24' },
				)
				expect(blocked.status).toBe(409)
				expect(await blocked.json()).toMatchObject({
					error: 'coupon_refused',
					reason: 'sign_in_required',
				})
				expect(await counted('codeOrg')).toBe(3)
				expect(await counted('codeIp')).toBe(3)
			} finally {
				orgLimit.max = max
			}
		})

		it('refuses a guest code with no client address outside local runs', async () => {
			vi.stubEnv('NODE_ENV', 'production')
			const response = await post(
				'/orders/quote',
				orderBody({
					idempotencyKey: undefined,
					contact: undefined,
					discounts: { code: 'SAVE10' },
				}),
			)
			expect(response.status).toBe(429)
			expect((await response.json()).message).toMatch(/coupon attempts/)
			expect(await counted('codeIp')).toBe(0)
		})

		it('counts a code the cart does not meet yet once, and gives it back when it applies', async () => {
			activeContext = menuContext({
				features: { automatic: true, coupons: true },
				discounts: [
					makeDiscount({
						id: 'disc_code',
						name: 'Big spender',
						application: 'code',
						percentBp: 1000,
						minSubtotalMinor: 50_000,
						currency: 'USD',
					}),
				],
				codes: [
					{
						id: 'code_big',
						discountId: 'disc_code',
						normalizedCode: 'BIGSPEND',
						maxUses: null,
					},
				],
			})
			for (let index = 1; index <= 5; index++) {
				const response = await quote('BIGSPEND', index)
				expect((await response.json()).coupon).toMatchObject({
					status: 'refused',
					reason: 'minimum_not_met',
				})
			}
			// "Minimum not met" confirms the code exists, so a guest pays one
			// guess for it, once per code however often the cart changes.
			expect(await counted('codeIp')).toBe(1)
			expect(await counted('codeOrg')).toBe(1)
			// Meeting the minimum ($500 of $10 burgers) gives that guess back.
			const met = await quote('BIGSPEND', 50)
			expect((await met.json()).coupon).toMatchObject({ status: 'applied' })
			expect(await counted('codeIp')).toBe(0)
			expect(await counted('codeOrg')).toBe(0)
		})

		it('counts a valid code that a stronger automatic discount replaced', async () => {
			activeContext = menuContext({
				features: { automatic: true, coupons: true },
				discounts: [
					makeDiscount({
						id: 'disc_auto',
						name: 'Half off',
						percentBp: 5000,
					}),
					makeDiscount({
						id: 'disc_code',
						name: 'Welcome',
						application: 'code',
						percentBp: 1000,
					}),
				],
				codes: [
					{
						id: 'code_welcome',
						discountId: 'disc_code',
						normalizedCode: 'SAVE10',
						maxUses: null,
					},
				],
			})
			const response = await quote('SAVE10')
			expect((await response.json()).coupon).toMatchObject({
				status: 'replaced',
			})
			expect(await counted('codeIp')).toBe(1)
			expect(await counted('codeOrg')).toBe(1)
		})

		it('still refuses an already counted question once the budget is spent', async () => {
			expect((await quote('NOPE')).status).toBe(200)
			for (let index = 0; index < 25; index++) await quote(`GUESS${index}`)
			expect((await quote('NOPE')).status).toBe(429)
		})
	})

	// -----------------------------------------------------------------------
	// 4. Pay-at-pickup holds stop counting after a day
	// -----------------------------------------------------------------------

	describe('pay-at-pickup no-shows', () => {
		async function placeHandoff() {
			const response = await post(
				'/orders',
				orderBody({ discounts: { expectedDiscountMinor: 200 } }),
			)
			return response
		}

		it('counts a reserved use for a day past the order, then stops', async () => {
			activeContext = menuContext(autoDiscounts({ totalLimit: 1 }))
			const first = await placeHandoff()
			expect(first.status).toBe(201)
			const { order } = await first.json()
			expect((await placeHandoff()).status).toBe(409)

			const db = await getTenantDb(orgId)
			// 23 hours old: still held.
			await db
				.update(restaurantOrders)
				.set({
					createdAt: new Date(Date.now() - 23 * HOUR),
					number: 'OLD-0001',
				})
				.where(eq(restaurantOrders.id, order.id))
			expect((await placeHandoff()).status).toBe(409)

			// 25 hours old: it stopped counting. The order itself is untouched.
			await db
				.update(restaurantOrders)
				.set({ createdAt: new Date(Date.now() - 25 * HOUR) })
				.where(eq(restaurantOrders.id, order.id))
			const second = await placeHandoff()
			expect(second.status).toBe(201)
			const [stale] = await db
				.select()
				.from(restaurantOrders)
				.where(eq(restaurantOrders.id, order.id))
			expect(stale?.status).toBe('accepted')
			expect((await redemptions(order.id))[0]?.state).toBe('reserved')
		})

		it('counts from the scheduled time when the order has one', async () => {
			activeContext = menuContext(autoDiscounts({ totalLimit: 1 }))
			const first = await placeHandoff()
			const { order } = await first.json()
			const db = await getTenantDb(orgId)
			// Created long ago, but wanted tomorrow: it still counts.
			await db
				.update(restaurantOrders)
				.set({
					createdAt: new Date(Date.now() - 30 * HOUR),
					number: 'OLD-0001',
					scheduledFor: new Date(Date.now() + 5 * HOUR),
				})
				.where(eq(restaurantOrders.id, order.id))
			expect((await placeHandoff()).status).toBe(409)
			await db
				.update(restaurantOrders)
				.set({ scheduledFor: new Date(Date.now() - 25 * HOUR) })
				.where(eq(restaurantOrders.id, order.id))
			expect((await placeHandoff()).status).toBe(201)
		})

		it('never stops counting a consumed use', async () => {
			activeContext = menuContext(autoDiscounts({ totalLimit: 1 }))
			const first = await placeHandoff()
			const { order } = await first.json()
			await updateOperatorOrder(orgId, order.id, { status: 'completed' })
			const db = await getTenantDb(orgId)
			await db
				.update(restaurantOrders)
				.set({
					createdAt: new Date(Date.now() - 72 * HOUR),
					number: 'OLD-0001',
				})
				.where(eq(restaurantOrders.id, order.id))
			expect((await redemptions(order.id))[0]?.state).toBe('consumed')
			expect((await placeHandoff()).status).toBe(409)
		})
	})

	// -----------------------------------------------------------------------
	// 5. Schedules are judged at pickup time
	// -----------------------------------------------------------------------

	describe('schedules and pickup time', () => {
		// Tomorrow 16:30 UTC, a window the discount runs and "now" is not in.
		function tomorrowAt1630() {
			const when = new Date()
			when.setUTCDate(when.getUTCDate() + 1)
			when.setUTCHours(16, 30, 0, 0)
			return when
		}
		function hours(day: number) {
			return [{ day, start: '16:00', end: '17:00' }]
		}

		it('quotes and places a pre-order at the pickup time, not the order time', async () => {
			const when = tomorrowAt1630()
			activeContext = menuContext(
				autoDiscounts({ schedule: hours(when.getUTCDay()) }),
			)
			// Only the pickup falls in the window (tomorrow 16:00 to 17:00).
			const scheduled = {
				scheduledFor: when.toISOString(),
				fulfillment: 'pickup',
			}
			const quote = await post(
				'/orders/quote',
				orderBody({
					...scheduled,
					idempotencyKey: undefined,
					contact: undefined,
				}),
			)
			expect(quote.status).toBe(200)
			expect((await quote.json()).totalDiscountMinor).toBe(200)

			const placed = await post(
				'/orders',
				orderBody({ ...scheduled, discounts: { expectedDiscountMinor: 200 } }),
			)
			expect(placed.status).toBe(201)
			expect((await placed.json()).order.discountCents).toBe(200)

			// An order for right now is outside the hours and gets nothing.
			const asap = await post(
				'/orders/quote',
				orderBody({ idempotencyKey: undefined, contact: undefined }),
			)
			const nowHour = new Date().getUTCHours()
			const nowDay = new Date().getUTCDay()
			const inWindow = nowDay === when.getUTCDay() && nowHour === 16
			expect((await asap.json()).totalDiscountMinor).toBe(inWindow ? 200 : 0)
		})

		it('does not give a discount to an order placed in the window for a pickup outside it', async () => {
			const when = tomorrowAt1630()
			// Hours that run today around now but not at the pickup.
			const today = new Date()
			const start = `${String(today.getUTCHours()).padStart(2, '0')}:00`
			activeContext = menuContext(
				autoDiscounts({
					schedule: [{ day: today.getUTCDay(), start, end: '23:59' }],
				}),
			)
			const quote = await post(
				'/orders/quote',
				orderBody({
					scheduledFor: when.toISOString(),
					idempotencyKey: undefined,
					contact: undefined,
				}),
			)
			expect(quote.status).toBe(200)
			// Tomorrow's pickup is not on today's weekday, unless a week of
			// scheduling put it on the same one (it never does: 1 day ahead).
			expect((await quote.json()).totalDiscountMinor).toBe(0)
		})
	})

	// -----------------------------------------------------------------------
	// 7. Quote and placement count the same orders
	// -----------------------------------------------------------------------

	describe('first orders and lapsed holds', () => {
		async function seedCustomerOrder() {
			const db = await getTenantDb(orgId)
			const { insertCustomer } =
				await import('../services/loyalty-test-fixture.ts')
			await insertCustomer(orgId, { id: 'cust_new', phone: '+15551230099' })
			return db
		}

		it('does not treat a lapsed unpaid hold as a first order', async () => {
			const { discountCustomerFacts } =
				await import('../services/discount-apply.ts')
			const db = await seedCustomerOrder()
			const placed = await post(
				'/orders',
				orderBody({
					paymentMethod: 'online',
					discounts: { expectedDiscountMinor: 200 },
				}),
			)
			const { order } = await placed.json()
			await db
				.update(restaurantOrders)
				.set({ customerId: 'cust_new' })
				.where(eq(restaurantOrders.id, order.id))

			// Within the hold it is a prior order; past it, and before any sweep
			// has run, it is not (a quote does not sweep, placement does).
			expect(
				(await discountCustomerFacts(db, 'cust_new', new Date())).isNewCustomer,
			).toBe(false)
			await db
				.update(restaurantOrders)
				.set({ holdExpiresAt: new Date(Date.now() - 60_000) })
				.where(eq(restaurantOrders.id, order.id))
			const [still] = await db
				.select()
				.from(restaurantOrders)
				.where(and(eq(restaurantOrders.id, order.id)))
			expect(still?.status).toBe('accepted')
			expect(
				(await discountCustomerFacts(db, 'cust_new', new Date())).isNewCustomer,
			).toBe(true)
			await sweepExpiredHolds(orgId)
			expect(
				(await discountCustomerFacts(db, 'cust_new', new Date())).isNewCustomer,
			).toBe(true)
		})
	})
})
