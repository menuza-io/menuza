import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import { readGuestOrderingFeatures } from '@repo/common/guest-ordering'
import {
	TEST_ORDER_AUTO_COMPLETE_MS,
	TEST_ORDER_CODE_TTL_MS,
	TEST_ORDER_DAILY_LIMIT,
	TEST_ORDER_HEADER,
	serializeTestOrderCode,
	parseTestOrderCode,
} from '@repo/common/test-orders'
import {
	destroyTenantDb,
	discountRedemptions,
	getTenantDb,
	invMovements,
	invOutbox,
	invSaleUsage,
	loyaltyLedger,
	loyaltyOutbox,
	loyaltyPurchases,
	loyaltyRedemptions,
	orderMessages,
	provisionTenantDb,
	restaurantOrderRefunds,
	restaurantOrders,
	testOrderNonces,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { makeDiscount } from '../../../../packages/discounts/src/test-fixtures.ts'
import {
	findActiveOrganizationById,
	resolveOrganizationForBrowserAuth,
} from '../lib/origin.ts'
import {
	invalidateLoyaltyContext,
	seedLoyaltyContextForTest,
} from '../lib/loyalty-context.ts'
import { mintTestOrderCode, newTestOrderNonce } from '../lib/test-order-code.ts'
import { loadLaunchFacts } from './home-internal.ts'
import { renderOrderEmail } from '../lib/order-messages-email.ts'
import { kitchenFeed } from '../services/kds-service.ts'
import {
	activateProgram,
	givePoints,
	insertCustomer,
	makeMember,
	programConfig,
} from '../services/loyalty-test-fixture.ts'
import {
	operatorOrder,
	updateOperatorOrder,
} from '../services/order-service.ts'
import { recordOrderRefund } from '../services/order-refund-service.ts'
import { createProviderRefundIntent } from '../services/order-provider-refund-service.ts'
import {
	countedOrderCondition,
	orderCountsTowardSales,
} from '../services/report-records.ts'
import {
	mintTestOrderCodeForOrg,
	recordTestPrintAnswer,
	runTestOrdersTick,
	testOrderDoneAt,
} from '../services/test-orders-service.ts'
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

const orgId = 'org_test_orders_1'
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

function menuContext(
	guestOrdering: Record<string, boolean> | null = { testOrders: true },
) {
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
					fulfillmentOptions: { pickup: true, delivery: false, dineIn: false },
					inHouseTips: { pickupTips: true },
					onlineHours: ALL_DAYS,
				},
				{
					id: 'loc-2',
					name: 'Second Street',
					timezone: 'UTC',
					taxRate: 8.25,
					prepTime: 15,
					currency: 'USD',
					fulfillmentOptions: { pickup: true, delivery: false, dineIn: false },
					onlineHours: ALL_DAYS,
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
		// Online payment is off on purpose: a test order must not need it.
		onlinePayment: { enabled: false, processor: null },
		discounts: {
			features: { automatic: true, coupons: true },
			discounts: [
				makeDiscount({ id: 'disc_half', name: 'Half off', percentBp: 5000 }),
			],
			codes: [],
		},
		guestMessages: {
			enabled: true,
			receipt: true,
			ready: true,
			cancelled: true,
		},
		...(guestOrdering ? { guestOrdering } : {}),
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
			email: 'owner@restaurant.test',
		},
		tipPercent: 0,
		lines: [{ itemId: 'item-burger', quantity: 2, options: [] }],
		...overrides,
	}
}

describe('free test orders (#119)', () => {
	let directory: string
	let app: Hono
	let context: Record<string, unknown>

	async function db() {
		return getTenantDb(orgId)
	}
	async function mint(locationId = 'loc-1', now?: number) {
		return mintTestOrderCodeForOrg(orgId, await db(), { locationId, now })
	}
	async function post(
		body: unknown,
		code: string | null,
		customerId: string | null = null,
	) {
		const headers: Record<string, string> = {
			'content-type': 'application/json',
			origin: 'https://test-org.example.com',
		}
		if (code) headers[TEST_ORDER_HEADER] = code
		if (customerId) {
			headers.authorization = `Bearer ${await new SignJWT({
				customerId,
				orgId,
				orgSlug: 'test-org',
				type: 'access',
			})
				.setProtectedHeader({ alg: 'HS256' })
				.setIssuer(brand.slug)
				.setAudience('tenant-api')
				.setExpirationTime('1h')
				.sign(new TextEncoder().encode(jwtSecret))}`
		}
		return app.request('/orders', {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
		})
	}
	async function placeTest(
		overrides: Record<string, unknown> = {},
		customerId: string | null = null,
	) {
		const { code } = await mint()
		const response = await post(orderBody(overrides), code, customerId)
		expect(response.status).toBe(201)
		return (await response.json()) as {
			order: { id: string; isTest?: boolean }
			paymentToken?: string
		}
	}
	async function stored(id: string) {
		const [row] = await (
			await db()
		)
			.select()
			.from(restaurantOrders)
			.where(eq(restaurantOrders.id, id))
		return row!
	}

	beforeEach(async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orders-test-orders-'))
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
		context = menuContext()
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = typeof input === 'string' ? input : input.toString()
				if (url.includes('/resources/order-context'))
					return Response.json(context)
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
	})

	afterEach(async () => {
		invalidateLoyaltyContext(orgId)
		try {
			await destroyTenantDb(orgId)
			fs.rmSync(directory, { recursive: true, force: true })
		} catch {}
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
		vi.clearAllMocks()
	})

	describe('the code', () => {
		it('is minted for one location, for 30 minutes, only while the switch is on', async () => {
			const now = Date.now()
			const { code, expiresAt } = await mint('loc-1', now)
			expect(expiresAt).toBe(now + TEST_ORDER_CODE_TTL_MS)
			expect(parseTestOrderCode(code)).toMatchObject({
				locationId: 'loc-1',
				exp: expiresAt,
			})
			context = menuContext({ testOrders: false })
			await expect(mint()).rejects.toMatchObject({
				code: 'test_orders_disabled',
				status: 403,
			})
			context = menuContext(null)
			await expect(mint()).rejects.toMatchObject({
				code: 'test_orders_disabled',
			})
			expect(readGuestOrderingFeatures({ testOrders: 'true' }).testOrders).toBe(
				false,
			)
		})

		it('allows at most 10 per location per day (test_order_limit), per location', async () => {
			for (let i = 0; i < TEST_ORDER_DAILY_LIMIT; i += 1) await mint('loc-1')
			await expect(mint('loc-1')).rejects.toMatchObject({
				code: 'test_order_limit',
				status: 429,
			})
			await expect(mint('loc-2')).resolves.toBeDefined()
			// A day later the limit starts over.
			await expect(
				mintTestOrderCodeForOrg(orgId, await db(), {
					locationId: 'loc-1',
					now: Date.now() + 25 * 60 * 60 * 1000,
				}),
			).resolves.toBeDefined()
		})

		it('refuses a location that is not the organization’s', async () => {
			await expect(mint('loc-unknown')).rejects.toMatchObject({ status: 404 })
		})
	})

	describe('placing a test order', () => {
		it('runs the whole guest path without money: stored free, never needs payment', async () => {
			const placed = await placeTest()
			expect(placed.order.isTest).toBe(true)
			expect(placed.paymentToken).toBeUndefined()
			const row = await stored(placed.order.id)
			expect(row).toMatchObject({
				isTest: true,
				status: 'accepted',
				paymentMethod: 'handoff',
				paymentStatus: 'not_required',
				paymentProcessor: null,
				paymentSessionId: null,
				holdExpiresAt: null,
				attribution: null,
				readySlotAt: null,
			})
			// Priced like any order.
			expect(row.subtotalCents).toBe(2000)
		})

		it('online is a test too: it stops before the payment provider', async () => {
			const placed = await placeTest({ paymentMethod: 'online' })
			expect(placed.paymentToken).toBeUndefined()
			expect(await stored(placed.order.id)).toMatchObject({
				paymentMethod: 'handoff',
				paymentStatus: 'not_required',
				paymentTokenHash: null,
			})
		})

		it('a second order with the same code is refused with test_code_invalid, and a real order still works', async () => {
			const { code } = await mint()
			expect((await post(orderBody(), code)).status).toBe(201)
			const second = await post(orderBody(), code)
			expect(second.status).toBe(422)
			expect(((await second.json()) as { error: string }).error).toBe(
				'test_code_invalid',
			)
			const real = await post(orderBody(), null)
			expect(real.status).toBe(201)
			const body = (await real.json()) as {
				order: { isTest?: boolean; paymentStatus: string }
			}
			expect(body.order.isTest).toBeUndefined()
			expect(body.order.paymentStatus).toBe('unpaid')
			expect(await (await db()).select().from(restaurantOrders)).toHaveLength(2)
		})

		it('a replayed checkout returns the same order and does not spend a second code', async () => {
			const { code } = await mint()
			const body = orderBody()
			const first = (await (await post(body, code)).json()) as {
				order: { id: string }
			}
			const again = await post(body, code)
			expect(again.status).toBe(200)
			expect(((await again.json()) as { order: { id: string } }).order.id).toBe(
				first.order.id,
			)
		})

		it('refuses a tampered, expired, other-location or other-organization code, nothing written', async () => {
			const { code } = await mint()
			const parts = code.split('.')
			const flipped = `${parts.slice(0, 4).join('.')}.${parts[4]!.replace(/^./, (c) => (c === '0' ? '1' : '0'))}`
			const extended = serializeTestOrderCode({
				...parseTestOrderCode(code)!,
				exp: parseTestOrderCode(code)!.exp + 3_600_000,
			})
			const expired = (
				await mint('loc-1', Date.now() - TEST_ORDER_CODE_TTL_MS - 1000)
			).code
			const otherOrg = mintTestOrderCode({
				orgId: 'another_org',
				locationId: 'loc-1',
				nonce: newTestOrderNonce(),
				now: Date.now(),
			}).code
			const otherLocation = (await mint('loc-2')).code
			for (const bad of [
				flipped,
				extended,
				expired,
				otherOrg,
				otherLocation,
				'junk',
				`tc1.${'x'.repeat(500)}`,
			]) {
				const response = await post(orderBody(), bad)
				expect(response.status, bad.slice(0, 20)).toBe(422)
				expect(((await response.json()) as { error: string }).error).toBe(
					'test_code_invalid',
				)
			}
			expect(await (await db()).select().from(restaurantOrders)).toHaveLength(0)
			// The untouched code still works afterwards.
			expect((await post(orderBody(), code)).status).toBe(201)
		})

		it('a code minted but never saved by this region (guessed nonce) is refused', async () => {
			const { code } = mintTestOrderCode({
				orgId,
				locationId: 'loc-1',
				nonce: newTestOrderNonce(),
				now: Date.now(),
			})
			// Valid MAC, but no nonce row: this region never minted it.
			const response = await post(orderBody(), code)
			expect(response.status).toBe(422)
			expect(await (await db()).select().from(restaurantOrders)).toHaveLength(0)
		})

		it('is refused with test_code_invalid when the organization turned the switch off', async () => {
			const { code } = await mint()
			context = menuContext({ testOrders: false })
			const response = await post(orderBody(), code)
			expect(response.status).toBe(422)
			expect(((await response.json()) as { error: string }).error).toBe(
				'test_code_invalid',
			)
		})

		it('has no rewards, gift cards, coupons or table codes', async () => {
			const { code } = await mint()
			const withCoupon = await post(
				orderBody({ discounts: { code: 'SAVE10', expectedDiscountMinor: 0 } }),
				code,
			)
			expect(withCoupon.status).toBe(422)
			expect(((await withCoupon.json()) as { error: string }).error).toBe(
				'test_order_unsupported',
			)
			// The code was not spent by the refusal.
			expect((await post(orderBody(), code)).status).toBe(201)
		})

		it('a refusal after the code is checked gives the code back', async () => {
			const { code } = await mint()
			const closed = await post(
				orderBody({
					lines: [{ itemId: 'no-such-item', quantity: 1, options: [] }],
				}),
				code,
			)
			expect(closed.status).toBeGreaterThanOrEqual(400)
			const [nonce] = await (await db()).select().from(testOrderNonces)
			expect(nonce!.usedAt).toBeNull()
			expect((await post(orderBody(), code)).status).toBe(201)
		})
	})

	describe('nothing leaves the test', () => {
		async function leftovers() {
			const database = await db()
			const rows = async (table: never) =>
				(await database.select().from(table)).length
			return {
				ledger: await rows(loyaltyLedger as never),
				outbox: await rows(loyaltyOutbox as never),
				purchases: await rows(loyaltyPurchases as never),
				redemptions: await rows(loyaltyRedemptions as never),
				inventoryOutbox: await rows(invOutbox as never),
				inventoryUse: await rows(invSaleUsage as never),
				movements: await rows(invMovements as never),
				discounts: await rows(discountRedemptions as never),
			}
		}

		it('reports, loyalty, inventory and discount usage are unchanged after a test order', async () => {
			seedLoyaltyContextForTest(orgId, { enabled: true, redemption: true })
			await activateProgram(orgId, programConfig())
			await insertCustomer(orgId, { id: 'cust_1', phone: '+15551230001' })
			const memberId = await makeMember(orgId, { customerId: 'cust_1' })
			await givePoints(orgId, memberId, 50)
			const before = await leftovers()

			// A signed-in member, an automatic discount on, a full lifecycle.
			const placed = await placeTest(
				{ discounts: { expectedDiscountMinor: 1000 } },
				'cust_1',
			)
			for (const status of ['preparing', 'ready', 'completed'] as const) {
				expect(
					(await updateOperatorOrder(orgId, placed.order.id, { status })).ok,
				).toBe(true)
			}
			const row = await stored(placed.order.id)
			expect(row.status).toBe('completed')
			// No discount applied: the test order is full price.
			expect(row.discountCents).toBe(0)
			expect(row.discounts).toEqual([])
			expect(row.loyaltyDiscountCents).toBe(0)

			expect(await leftovers()).toEqual(before)

			// Not a sale, in any report.
			expect(orderCountsTowardSales(row)).toBe(false)
			const database = await db()
			// The one rule every report, total and marketing credit shares.
			const counted = async () =>
				(
					await database
						.select({ id: restaurantOrders.id })
						.from(restaurantOrders)
						.where(countedOrderCondition())
				).length
			expect(await counted()).toBe(0)
			// A real order of the same shape is counted: the test is the difference.
			expect((await post(orderBody(), null)).status).toBe(201)
			expect(await counted()).toBe(1)
			// No marketing message queue besides the one test email (below), no
			// attribution, no consent.
			expect(row.attribution).toBeNull()
			expect(row.attributionSource).toBeNull()
		})

		it('cannot be refunded (nothing was paid) or paid for later', async () => {
			const placed = await placeTest()
			const refund = await recordOrderRefund(orgId, placed.order.id, {
				request: { amountCents: 100, note: 'x' } as never,
				actorId: 'user_1',
				idempotencyKey: crypto.randomUUID(),
				loyaltyAccess: { refundLoyalty: true, impersonated: false },
			})
			expect(refund).toMatchObject({
				ok: false,
				failure: { code: 'test_order_not_refundable' },
			})
			const provider = await createProviderRefundIntent({
				orgId,
				orderRef: placed.order.id,
				amount: { full: true },
				note: null,
				idempotencyKey: crypto.randomUUID(),
				origin: 'operator',
				actorId: 'user_1',
			})
			expect(provider.ok).toBe(false)
			expect(
				await (await db()).select().from(restaurantOrderRefunds),
			).toHaveLength(0)
		})

		it('is never turned into a real order', async () => {
			const placed = await placeTest()
			await expect(
				(await db())
					.update(restaurantOrders)
					.set({ isTest: false })
					.where(eq(restaurantOrders.id, placed.order.id)),
			).rejects.toThrow()
			expect((await stored(placed.order.id)).isTest).toBe(true)
		})

		it('sends the confirmation only to the typed email, labelled test, and never a text', async () => {
			const placed = await placeTest({ smsUpdates: true })
			const messages = await (
				await db()
			)
				.select()
				.from(orderMessages)
				.where(eq(orderMessages.orderId, placed.order.id))
			expect(messages.map((m) => [m.kind, m.channel])).toEqual([
				['receipt', 'email'],
			])
			expect((await stored(placed.order.id)).smsUpdatesOptIn).toBe(false)
			// Moving it to ready or cancelling it tells nobody.
			await updateOperatorOrder(orgId, placed.order.id, { status: 'ready' })
			await updateOperatorOrder(orgId, placed.order.id, { status: 'completed' })
			expect(
				await (
					await db()
				)
					.select()
					.from(orderMessages)
					.where(eq(orderMessages.orderId, placed.order.id)),
			).toHaveLength(1)
			// The email says it is a test, in the subject and above the lead.
			const row = await stored(placed.order.id)
			const email = renderOrderEmail({
				kind: 'receipt',
				locale: 'en',
				theme: null,
				restaurantName: 'Acme',
				order: row as never,
				timeZone: 'UTC',
				linkUrl: null,
			})
			expect(email.subject).toMatch(/^\[Test\] Your order /)
			expect(email.text).toContain('Test order: nothing was charged.')
			const real = renderOrderEmail({
				kind: 'receipt',
				locale: 'en',
				theme: null,
				restaurantName: 'Acme',
				order: { ...row, isTest: false } as never,
				timeZone: 'UTC',
				linkUrl: null,
			})
			expect(real.subject.startsWith('[')).toBe(false)
			// No typed email: no confirmation at all.
			const quiet = await placeTest({
				contact: { name: 'Rana', phone: '+1 555 123 4567' },
			})
			expect(
				await (
					await db()
				)
					.select()
					.from(orderMessages)
					.where(eq(orderMessages.orderId, quiet.order.id)),
			).toHaveLength(0)
		})
	})

	describe('the kitchen and the inbox', () => {
		it('shows as TEST in the Orders inbox and on the kitchen display', async () => {
			const placed = await placeTest()
			const database = await db()
			expect(operatorOrder(await stored(placed.order.id)).isTest).toBe(true)
			const feed = await kitchenFeed(database, orgId, 'loc-1')
			const ticket = feed.tickets.find(
				(t) => t.id.includes(placed.order.id) || t.number,
			)
			expect(ticket).toBeDefined()
			expect(feed.tickets.some((t) => t.isTest === true)).toBe(true)
			expect(feed.tickets.find((t) => t.isTest)!.testPrintAnswer).toBeNull()
			// A real order is not badged.
			const real = await post(orderBody(), null)
			expect(real.status).toBe(201)
			const next = await kitchenFeed(database, orgId, 'loc-1')
			expect(next.tickets.filter((t) => t.isTest)).toHaveLength(1)
			expect(next.tickets).toHaveLength(2)
		})
	})

	describe('did the ticket print?', () => {
		it('confirming the print marks the launch step done', async () => {
			const placed = await placeTest()
			const database = await db()
			expect(await testOrderDoneAt(database)).toBeNull()
			expect((await loadLaunchFacts(database)).testOrderDoneAt).toBeNull()
			const no = await recordTestPrintAnswer(
				orgId,
				database,
				placed.order.id,
				'no',
			)
			expect(no.ok && no.order.testPrintAnswer).toBe('no')
			expect(await testOrderDoneAt(database)).toBeNull()
			const yes = await recordTestPrintAnswer(
				orgId,
				database,
				placed.order.id,
				'yes',
			)
			expect(yes.ok && yes.order.testPrintAnswer).toBe('yes')
			expect(await testOrderDoneAt(database)).not.toBeNull()
			const facts = await loadLaunchFacts(database)
			expect(facts.testOrderDoneAt).toMatch(/^\d{4}-/)
			// The kitchen screen sees the answer.
			const feed = await kitchenFeed(database, orgId, 'loc-1')
			expect(feed.tickets.find((t) => t.isTest)!.testPrintAnswer).toBe('yes')
		})

		it('a person moving the test order through the kitchen also does it; a real order has no such question', async () => {
			const placed = await placeTest()
			const database = await db()
			expect(await testOrderDoneAt(database)).toBeNull()
			await updateOperatorOrder(orgId, placed.order.id, { status: 'preparing' })
			expect(await testOrderDoneAt(database)).not.toBeNull()
			const real = (await (await post(orderBody(), null)).json()) as {
				order: { id: string }
			}
			expect(
				await recordTestPrintAnswer(orgId, database, real.order.id, 'yes'),
			).toMatchObject({
				ok: false,
				code: 'not_a_test_order',
			})
			expect(
				await recordTestPrintAnswer(orgId, database, 'missing', 'yes'),
			).toMatchObject({
				ok: false,
				status: 404,
			})
			// Another location's screen cannot answer for it.
			expect(
				await recordTestPrintAnswer(orgId, database, placed.order.id, 'yes', {
					locationIds: ['loc-2'],
				}),
			).toMatchObject({ ok: false, status: 404 })
		})
	})

	describe('the regional tick', () => {
		it('an open test order completes itself after 2 hours, not before', async () => {
			const placed = await placeTest()
			const database = await db()
			const createdAt = (await stored(placed.order.id)).createdAt!.getTime()
			const early = await runTestOrdersTick(
				orgId,
				database,
				createdAt + TEST_ORDER_AUTO_COMPLETE_MS - 60_000,
			)
			expect(early.completed).toBe(0)
			expect(early.nextDueAt).toBe(createdAt + TEST_ORDER_AUTO_COMPLETE_MS)
			expect((await stored(placed.order.id)).status).toBe('accepted')
			const late = await runTestOrdersTick(
				orgId,
				database,
				createdAt + TEST_ORDER_AUTO_COMPLETE_MS + 60_000,
			)
			expect(late.completed).toBe(1)
			expect(late.nextDueAt).toBeNull()
			const done = await stored(placed.order.id)
			expect(done.status).toBe('completed')
			expect(done.completedAt).not.toBeNull()
			// Finishing by the tick is not "a person moved it".
			expect(await testOrderDoneAt(database)).toBeNull()
			// A second pass has nothing to do.
			expect(
				(
					await runTestOrdersTick(
						orgId,
						database,
						createdAt + 3 * TEST_ORDER_AUTO_COMPLETE_MS,
					)
				).completed,
			).toBe(0)
		})

		it('leaves real orders alone and forgets spent codes after a day', async () => {
			const real = (await (await post(orderBody(), null)).json()) as {
				order: { id: string }
			}
			await placeTest()
			const database = await db()
			const farFuture = Date.now() + 3 * 24 * 60 * 60 * 1000
			const result = await runTestOrdersTick(orgId, database, farFuture)
			expect(result.completed).toBe(1)
			expect(result.noncesPruned).toBe(1)
			expect((await stored(real.order.id)).status).toBe('accepted')
			expect(await database.select().from(testOrderNonces)).toHaveLength(0)
		})
	})
})
