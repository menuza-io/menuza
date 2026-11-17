import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { priceRestaurantOrder } from '@repo/common/restaurant-orders'
import { brand } from '@repo/config/brand'
import {
	DISCOUNT_TOKEN_AUDIENCE,
	DISCOUNT_TOKEN_TYP,
	discountPerformanceFigures,
} from '@repo/discounts'
import {
	customers,
	destroyTenantDb,
	discountRedemptions,
	getTenantDb,
	provisionTenantDb,
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
import { prepareOrderDiscounts } from '../services/discount-apply.ts'
import { createAudience } from '../services/marketing-audience-service.ts'
import { operatorDiscountRoutes } from './operator-discounts.ts'
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
 * The discount rules of #273 (a cap and an item limit), #395 (which item an
 * item limit covers), #392 (a weekly budget), #415 (a saved audience) and
 * #390 (how a discount performed), against the region: quote, placement, the
 * counts and the usage and performance reads.
 */

const orgId = 'org_discount_rules_1'
const internalToken = 'test-internal-token-very-long-and-secure-12345'
const operatorSecret = 'test-operator-token-very-long-and-secure-12345'
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

function menuContext(discounts: Record<string, unknown>) {
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
								{
									id: 'item-fries',
									displayName: 'Fries',
									price: 3,
									availabilityStatus: 'available',
								},
								{
									id: 'item-steak',
									displayName: 'Steak',
									price: 20,
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
		discounts: {
			features: { automatic: true, coupons: true },
			discounts,
			codes: [],
		},
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

async function discountsToken(locationIds: string[] | null = null) {
	return new SignJWT({
		aud: DISCOUNT_TOKEN_AUDIENCE,
		role: 'operator',
		region: 'us',
		orgId,
		scope: 'read',
		grants: ['read:discount:any'],
		locationIds,
		impersonated: false,
	})
		.setProtectedHeader({ alg: 'HS256', typ: DISCOUNT_TOKEN_TYP })
		.setSubject('user_1')
		.setIssuer(brand.shortName)
		.setIssuedAt()
		.setExpirationTime('10m')
		.sign(new TextEncoder().encode(operatorSecret))
}

describe('discount rules 273 395 392 415 390', () => {
	let directory: string
	let app: Hono
	let context: Record<string, unknown>
	let notices: Array<Record<string, unknown>>

	const request = (
		pathname: string,
		init: RequestInit & { json?: unknown } = {},
	) =>
		app.request(pathname, {
			...init,
			headers: {
				'content-type': 'application/json',
				origin: 'https://test-org.example.com',
				...(init.headers as Record<string, string> | undefined),
			},
			...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
		})
	const post = (pathname: string, json: unknown) =>
		request(pathname, { method: 'POST', json })
	const quote = async (body: Record<string, unknown>) => {
		const response = await post('/orders/quote', {
			...body,
			discounts: { ...(body.discounts as object | undefined) },
		})
		expect(response.status).toBe(200)
		return (await response.json()) as {
			totalDiscountMinor: number
			discounts: Array<{ discountId: string; amountMinor: number }>
		}
	}
	const place = (body: Record<string, unknown>) => post('/orders', body)

	beforeEach(async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'discount-rules-'))
		vi.stubEnv('TENANT_DB_DIR', directory)
		vi.stubEnv('DATA_REGION', 'us')
		vi.stubEnv('INTERNAL_COMMAND_TOKEN', internalToken)
		vi.stubEnv('TENANT_OPERATOR_TOKEN', operatorSecret)
		vi.stubEnv('JWT_SECRET', 'test-jwt-secret-123456789')
		vi.stubEnv('AUTH_HMAC_SECRET', 'test-hmac-secret-123456789')
		vi.stubEnv('APP_URL', 'https://app.test')
		vi.stubEnv('DISCOUNTS_ENABLED', 'true')
		notices = []
		context = menuContext([])
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = typeof input === 'string' ? input : input.toString()
				if (url.includes('/resources/order-context')) {
					return Response.json(context)
				}
				if (url.endsWith('/resources/discounts/notify')) {
					notices.push(
						JSON.parse(String(init?.body)) as Record<string, unknown>,
					)
					return Response.json({ inApp: 1 })
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
		app.route('/operator/discounts', operatorDiscountRoutes)
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

	// -----------------------------------------------------------------------
	// #273 a capped percentage and an item limit
	// -----------------------------------------------------------------------

	describe('a capped percentage (#273)', () => {
		const capped = () =>
			makeDiscount({
				id: 'disc_cap',
				name: 'Twenty off, up to 15',
				percentBp: 2000,
				maxDiscountMinor: 1500,
				currency: 'USD',
			})

		it('takes exactly 15.00 off a 200.00 order at quote and placement', async () => {
			context = menuContext([capped()])
			const lines = [{ itemId: 'item-burger', quantity: 20, options: [] }]
			const quoted = await quote(orderBody({ lines }))
			expect(quoted.totalDiscountMinor).toBe(1500)
			const placed = await place(
				orderBody({ lines, discounts: { expectedDiscountMinor: 1500 } }),
			)
			expect(placed.status).toBe(201)
			const body = await placed.json()
			expect(body.order.discountCents).toBe(1500)
			expect(body.order.totalCents).toBe(20_000 - 1500)
		})

		it('says how often the cap was reached', async () => {
			context = menuContext([capped()])
			// 20.00 order: 20% is 4.00, under the cap. 200.00 order: capped.
			expect(
				(await place(orderBody({ discounts: { expectedDiscountMinor: 400 } })))
					.status,
			).toBe(201)
			const big = [{ itemId: 'item-burger', quantity: 20, options: [] }]
			expect(
				(
					await place(
						orderBody({
							lines: big,
							discounts: { expectedDiscountMinor: 1500 },
						}),
					)
				).status,
			).toBe(201)
			const response = await request('/operator/discounts/usage?ids=disc_cap', {
				headers: { authorization: `Bearer ${await discountsToken()}` },
			})
			expect(response.status).toBe(200)
			const { usage } = await response.json()
			expect(usage[0]).toMatchObject({
				discountId: 'disc_cap',
				uses: 2,
				capReached: 1,
				discountMinor: 400 + 1500,
			})
		})

		it('covers only the discounted items of a limited item discount, and agrees at placement', async () => {
			context = menuContext([
				makeDiscount({
					id: 'disc_two',
					name: 'Half price on up to 2',
					percentBp: 5000,
					target: {
						scope: 'items',
						itemIds: ['item-burger'],
						categoryIds: [],
						excludeItemIds: [],
						excludeCategoryIds: [],
					},
					maxDiscountedUnits: 2,
				}),
			])
			const lines = [{ itemId: 'item-burger', quantity: 5, options: [] }]
			const quoted = await quote(orderBody({ lines }))
			// Two of five burgers at half of 10.00.
			expect(quoted.totalDiscountMinor).toBe(1000)
			const placed = await place(
				orderBody({ lines, discounts: { expectedDiscountMinor: 1000 } }),
			)
			expect(placed.status).toBe(201)
		})
	})

	// -----------------------------------------------------------------------
	// #395 which item the limit covers
	// -----------------------------------------------------------------------

	describe('which eligible item is discounted (#395)', () => {
		const limited = (itemChoice?: 'cheapest' | 'dearest') =>
			makeDiscount({
				id: 'disc_one',
				name: 'One free',
				percentBp: 10_000,
				target: {
					scope: 'items',
					itemIds: ['item-burger', 'item-fries', 'item-steak'],
					categoryIds: [],
					excludeItemIds: [],
					excludeCategoryIds: [],
				},
				maxDiscountedUnits: 1,
				...(itemChoice ? { itemChoice } : {}),
			})
		const lines = [
			{ itemId: 'item-burger', quantity: 1, options: [] },
			{ itemId: 'item-fries', quantity: 1, options: [] },
			{ itemId: 'item-steak', quantity: 1, options: [] },
		]

		it('keeps the dearest item by default', async () => {
			context = menuContext([limited()])
			expect((await quote(orderBody({ lines }))).totalDiscountMinor).toBe(2000)
		})

		it('takes the cheapest item when chosen, and quote and placement match', async () => {
			context = menuContext([limited('cheapest')])
			const quoted = await quote(orderBody({ lines }))
			expect(quoted.totalDiscountMinor).toBe(300)
			const placed = await place(
				orderBody({ lines, discounts: { expectedDiscountMinor: 300 } }),
			)
			expect(placed.status).toBe(201)
			expect((await placed.json()).order.discountCents).toBe(300)
		})

		it('refuses a placement that still expects the other item’s discount', async () => {
			context = menuContext([limited('cheapest')])
			const placed = await place(
				orderBody({ lines, discounts: { expectedDiscountMinor: 2000 } }),
			)
			expect(placed.status).toBe(409)
			expect(await placed.json()).toMatchObject({ error: 'discount_changed' })
		})
	})

	// -----------------------------------------------------------------------
	// #392 a weekly budget
	// -----------------------------------------------------------------------

	describe('a weekly budget (#392)', () => {
		// 10% of two burgers is 2.00 an order, against a 3.00 budget.
		const budgeted = () =>
			makeDiscount({
				id: 'disc_budget',
				name: 'Ten percent, 3.00 a week',
				percentBp: 1000,
				currency: 'USD',
				weeklyBudgetMinor: 300,
			})

		const orderWith = (expected: number) =>
			place(orderBody({ discounts: { expectedDiscountMinor: expected } }))
		const flush = () => new Promise((resolve) => setTimeout(resolve, 20))

		it('stops applying once the week has given its budget and says so once', async () => {
			context = menuContext([budgeted()])
			// 0.00 given: applies. 2.00 given: still under 3.00, applies and crosses.
			expect((await orderWith(200)).status).toBe(201)
			await flush()
			expect(notices).toHaveLength(0)
			const crossing = await orderWith(200)
			expect(crossing.status).toBe(201)
			// The order that crossed the budget keeps its whole discount.
			expect((await crossing.json()).order.discountCents).toBe(200)
			await flush()
			expect(notices).toEqual([
				{
					orgId,
					kind: 'budget_reached',
					discountId: 'disc_budget',
					week: expect.stringMatching(/^\d{4}-W\d{2}$/),
				},
			])

			// 4.00 given: the quote shows no discount and a stale one is refused.
			expect((await quote(orderBody())).totalDiscountMinor).toBe(0)
			const stale = await orderWith(200)
			expect(stale.status).toBe(409)
			expect(await stale.json()).toMatchObject({ error: 'discount_changed' })
			const full = await orderWith(0)
			expect(full.status).toBe(201)
			expect((await full.json()).order.discountCents).toBe(0)
			await flush()
			// Never a second notice for the same week.
			expect(notices).toHaveLength(1)
		})

		it('lets orders already placed keep what they were quoted', async () => {
			context = menuContext([budgeted()])
			const first = await orderWith(200)
			const second = await orderWith(200)
			expect(first.status).toBe(201)
			expect(second.status).toBe(201)
			const db = await getTenantDb(orgId)
			const rows = await db.select().from(discountRedemptions).all()
			expect(rows.map((row) => row.amountMinor)).toEqual([200, 200])
			expect(rows.every((row) => row.state === 'reserved')).toBe(true)
		})

		it('resumes in the next week, judged at the pickup time', async () => {
			context = menuContext([budgeted()])
			await orderWith(200)
			await orderWith(200)
			expect((await quote(orderBody())).totalDiscountMinor).toBe(0)
			// The first moment of next week (Monday) in the location's zone.
			const nextWeek = new Date()
			nextWeek.setUTCDate(
				nextWeek.getUTCDate() + ((8 - nextWeek.getUTCDay()) % 7 || 7),
			)
			nextWeek.setUTCHours(12, 0, 0, 0)
			const later = await quote(
				orderBody({
					scheduledFor: nextWeek.toISOString(),
					idempotencyKey: undefined,
					contact: undefined,
				}),
			)
			expect(later.totalDiscountMinor).toBe(200)
		})

		it('lets only one of two racing orders take the last of the budget', async () => {
			context = menuContext([budgeted()])
			// 2.00 of the 3.00 is given. Each racing order alone is under the
			// budget; under the lock the second one sees the first's use.
			await orderWith(200)
			const [a, b] = await Promise.all([orderWith(200), orderWith(200)])
			expect([a.status, b.status].sort()).toEqual([201, 409])
			const db = await getTenantDb(orgId)
			expect(await db.select().from(discountRedemptions).all()).toHaveLength(2)
		})

		it('counts a week’s spend for the page', async () => {
			context = menuContext([budgeted()])
			await orderWith(200)
			const week = (
				(await (
					await request('/orders/quote', {
						method: 'POST',
						json: { ...orderBody(), discounts: {} },
					})
				).json()) as { totalDiscountMinor: number }
			).totalDiscountMinor
			expect(week).toBe(200)
			const db = await getTenantDb(orgId)
			const [row] = await db.select().from(discountRedemptions).all()
			const response = await request(
				`/operator/discounts/usage?ids=disc_budget&week=${row!.localWeek}`,
				{ headers: { authorization: `Bearer ${await discountsToken()}` } },
			)
			expect((await response.json()).usage[0]).toMatchObject({
				weekGivenMinor: 200,
			})
			const other = await request(
				'/operator/discounts/usage?ids=disc_budget&week=2020-W01',
				{ headers: { authorization: `Bearer ${await discountsToken()}` } },
			)
			expect((await other.json()).usage[0]).toMatchObject({
				weekGivenMinor: 0,
			})
			const bad = await request(
				'/operator/discounts/usage?ids=disc_budget&week=not-a-week',
				{ headers: { authorization: `Bearer ${await discountsToken()}` } },
			)
			expect(bad.status).toBe(400)
		})
	})

	// -----------------------------------------------------------------------
	// #415 a saved audience
	// -----------------------------------------------------------------------

	describe('a saved audience (#415)', () => {
		async function setup() {
			const db = await getTenantDb(orgId)
			const audience = await createAudience(db, {
				name: 'Verified guests',
				definition: {
					match: 'all',
					rules: [{ field: 'phone_verified', value: true }],
				},
			})
			expect(audience.ok).toBe(true)
			if (!audience.ok) throw new Error('audience')
			const [member] = await db
				.insert(customers)
				.values({ name: 'Member', phone: '+15550000001', phoneVerified: true })
				.returning()
			const [outsider] = await db
				.insert(customers)
				.values({
					name: 'Outsider',
					phone: '+15550000002',
					phoneVerified: false,
				})
				.returning()
			context = menuContext([
				makeDiscount({
					id: 'disc_audience',
					name: 'For verified guests',
					eligibility: 'signed_in',
					audienceId: audience.value.id,
				}),
			])
			return {
				db,
				audience: audience.value,
				member: member!,
				outsider: outsider!,
			}
		}

		async function priceFor(
			db: Awaited<ReturnType<typeof getTenantDb>>,
			customerId: string | null,
		) {
			const priced = priceRestaurantOrder(
				context as never,
				orderBody() as never,
				{
					now: new Date(),
				},
			)
			if (!priced.ok) throw new Error('price')
			const prepared = await prepareOrderDiscounts(db, {
				priced: priced.result,
				context: context as never,
				discounts: {},
				fulfillment: 'pickup',
				source: null,
				customerId,
				now: new Date(),
				killed: false,
			})
			if (!prepared.ok || !prepared.prepared) throw new Error('prepare')
			return prepared.prepared.evaluation.totalDiscountMinor
		}

		it('applies to a member and not to others', async () => {
			const { db, member, outsider } = await setup()
			expect(await priceFor(db, member.id)).toBe(200)
			expect(await priceFor(db, outsider.id)).toBe(0)
		})

		it('never applies to a guest who is not signed in', async () => {
			const { db } = await setup()
			expect(await priceFor(db, null)).toBe(0)
		})

		it('follows membership as it changes, never from a cache', async () => {
			const { db, outsider } = await setup()
			expect(await priceFor(db, outsider.id)).toBe(0)
			await db
				.update(customers)
				.set({ phoneVerified: true })
				.where(eq(customers.id, outsider.id))
			expect(await priceFor(db, outsider.id)).toBe(200)
		})

		it('gives nothing when the audience is gone, instead of widening to everyone', async () => {
			const { db, member, audience } = await setup()
			const { marketingAudiences } = await import('@repo/tenant-db')
			await db
				.delete(marketingAudiences)
				.where(eq(marketingAudiences.id, audience.id))
			expect(await priceFor(db, member.id)).toBe(0)
		})

		it('does not let an anonymous order through the route', async () => {
			await setup()
			expect((await quote(orderBody())).totalDiscountMinor).toBe(0)
		})
	})

	// -----------------------------------------------------------------------
	// #390 performance
	// -----------------------------------------------------------------------

	describe('how a discount performed (#390)', () => {
		const performance = async (
			query: string,
			token?: string,
		): Promise<Response> =>
			request(`/operator/discounts/performance?${query}`, {
				headers: {
					authorization: `Bearer ${token ?? (await discountsToken())}`,
				},
			})
		const today = () => new Date().toISOString().slice(0, 10)
		const params = (ids: string, extra = '') =>
			`ids=${ids}&from=${today()}&to=${today()}${extra}`

		async function consumeAll() {
			const db = await getTenantDb(orgId)
			await db
				.update(discountRedemptions)
				.set({ state: 'consumed' })
				.where(eq(discountRedemptions.state, 'reserved'))
		}

		it('matches the orders: sales, cost and return', async () => {
			context = menuContext([
				makeDiscount({ id: 'disc_perf', name: 'Ten off', percentBp: 1000 }),
			])
			// Ten orders of two burgers: 20.00 gross, 2.00 off, 18.00 net each.
			for (let i = 0; i < 10; i += 1) {
				expect(
					(
						await place(
							orderBody({ discounts: { expectedDiscountMinor: 200 } }),
						)
					).status,
				).toBe(201)
			}
			// An order that did not use it.
			context = menuContext([])
			expect((await place(orderBody())).status).toBe(201)
			await consumeAll()

			const net = await (await performance(params('disc_perf'))).json()
			expect(net.basis).toBe('net')
			expect(net.entries).toEqual([
				{
					discountId: 'disc_perf',
					orders: 10,
					salesMinor: 10 * 1800,
					discountMinor: 10 * 200,
				},
			])
			// 11 sales, 10 of which used a discount.
			expect(net.ordersTotal).toBe(11)
			expect(net.ordersWithDiscount).toBe(10)
			const figures = discountPerformanceFigures(net.entries[0])
			expect(figures).toEqual({ enough: true, orders: 10, returnPerUnit: 9 })

			const gross = await (
				await performance(params('disc_perf', '&basis=gross'))
			).json()
			expect(gross.entries[0].salesMinor).toBe(10 * 2000)
		})

		it('does not count a sale that is still reserved, cancelled or refunded', async () => {
			context = menuContext([
				makeDiscount({ id: 'disc_perf', name: 'Ten off', percentBp: 1000 }),
			])
			for (let i = 0; i < 3; i += 1) {
				await place(orderBody({ discounts: { expectedDiscountMinor: 200 } }))
			}
			const db = await getTenantDb(orgId)
			const rows = await db.select().from(discountRedemptions).all()
			await db
				.update(discountRedemptions)
				.set({ state: 'consumed' })
				.where(eq(discountRedemptions.id, rows[0]!.id))
			await db
				.update(discountRedemptions)
				.set({ state: 'released' })
				.where(eq(discountRedemptions.id, rows[1]!.id))
			// The third stays reserved.
			const { entries } = await (await performance(params('disc_perf'))).json()
			expect(entries[0]).toMatchObject({ orders: 1, discountMinor: 200 })
		})

		it('says not enough data under ten orders', async () => {
			expect(
				discountPerformanceFigures({
					orders: 9,
					salesMinor: 9000,
					discountMinor: 900,
				}),
			).toEqual({ enough: false, orders: 9 })
		})

		it('keeps to the token’s locations', async () => {
			context = menuContext([
				makeDiscount({ id: 'disc_perf', name: 'Ten off', percentBp: 1000 }),
			])
			await place(orderBody({ discounts: { expectedDiscountMinor: 200 } }))
			await consumeAll()
			const all = await (await performance(params('disc_perf'))).json()
			expect(all.entries[0].orders).toBe(1)
			const elsewhere = await (
				await performance(
					params('disc_perf'),
					await discountsToken(['loc-other']),
				)
			).json()
			expect(elsewhere.entries[0]).toMatchObject({ orders: 0, salesMinor: 0 })
			expect(elsewhere.ordersTotal).toBe(0)
			const here = await (
				await performance(params('disc_perf'), await discountsToken(['loc-1']))
			).json()
			expect(here.entries[0].orders).toBe(1)
		})

		it('refuses a bad period, zone or token', async () => {
			expect((await performance('ids=a&from=2026-01-01')).status).toBe(400)
			expect(
				(await performance('ids=a&from=2026-01-02&to=2026-01-01')).status,
			).toBe(400)
			expect(
				(await performance('ids=a&from=2024-01-01&to=2026-01-01')).status,
			).toBe(400)
			expect(
				(await performance('ids=a&from=2026-01-01&to=2026-01-02&tz=Not/AZone'))
					.status,
			).toBe(400)
			const unsigned = await request(
				`/operator/discounts/performance?${params('a')}`,
			)
			expect(unsigned.status).toBe(401)
		})

		it('only ever answers ids and amounts', async () => {
			context = menuContext([
				makeDiscount({ id: 'disc_perf', name: 'Ten off', percentBp: 1000 }),
			])
			await place(orderBody({ discounts: { expectedDiscountMinor: 200 } }))
			await consumeAll()
			const body = await (await performance(params('disc_perf'))).json()
			expect(Object.keys(body.entries[0]).sort()).toEqual([
				'discountId',
				'discountMinor',
				'orders',
				'salesMinor',
			])
			expect(JSON.stringify(body)).not.toMatch(/Rana|555|Ten off/)
		})
	})
})
