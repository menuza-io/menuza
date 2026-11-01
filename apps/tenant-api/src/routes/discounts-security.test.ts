import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { priceRestaurantOrder } from '@repo/common/restaurant-orders'
import { brand } from '@repo/config/brand'
import { DISCOUNT_TOKEN_AUDIENCE, DISCOUNT_TOKEN_TYP } from '@repo/discounts'
import { makeDiscount } from '../../../../packages/discounts/src/test-fixtures.ts'
import {
	destroyTenantDb,
	discountRedemptions,
	getTenantDb,
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
	prepareOrderDiscounts,
	publicRefusalReason,
} from '../services/discount-apply.ts'
import { evaluateTabDiscounts } from '../services/discount-tab.ts'
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

const orgId = 'org_discounts_1'
const otherOrgId = 'org_discounts_2'
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
		discounts: {
			features: { automatic: true, coupons: true },
			discounts: [
				makeDiscount({ id: 'disc_auto', name: 'Ten percent' }),
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
		},
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

async function operatorJwt(
	id = orgId,
	secret = operatorSecret,
	locationIds: string[] | null = null,
) {
	return new SignJWT({
		role: 'operator',
		region: 'us',
		orgId: id,
		scope: 'read',
		grants: ['read:discount:any'],
		locationIds,
		impersonated: false,
	})
		.setProtectedHeader({ alg: 'HS256', typ: DISCOUNT_TOKEN_TYP })
		.setSubject('user_1')
		.setIssuer(brand.shortName)
		.setAudience(DISCOUNT_TOKEN_AUDIENCE)
		.setIssuedAt()
		.setExpirationTime('10m')
		.sign(new TextEncoder().encode(secret))
}

describe('discounts on orders', () => {
	let directory: string
	let app: Hono
	let activeContext: Record<string, unknown>

	async function post(path: string, body: unknown) {
		return app.request(path, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				origin: 'https://test-org.example.com',
			},
			body: JSON.stringify(body),
		})
	}

	beforeEach(async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'discounts-'))
		vi.stubEnv('TENANT_DB_DIR', directory)
		vi.stubEnv('DATA_REGION', 'us')
		vi.stubEnv(
			'INTERNAL_COMMAND_TOKEN',
			'test-internal-token-very-long-and-secure-12345',
		)
		vi.stubEnv('TENANT_OPERATOR_TOKEN', operatorSecret)
		vi.stubEnv('JWT_SECRET', 'test-jwt-secret-123456789')
		vi.stubEnv('AUTH_HMAC_SECRET', 'test-hmac-secret-123456789')
		vi.stubEnv('APP_URL', 'https://app.test')
		vi.stubEnv('DISCOUNTS_ENABLED', 'true')

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
		await provisionTenantDb(otherOrgId)
		app = new Hono()
		app.route('/orders', publicOrderRoutes)
		app.route('/operator/discounts', operatorDiscountRoutes)
	})

	afterEach(async () => {
		try {
			await destroyTenantDb(orgId)
			await destroyTenantDb(otherOrgId)
			fs.rmSync(directory, { recursive: true, force: true })
		} catch {
			// The directory is already gone when a test failed mid-setup.
		}
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
		vi.clearAllMocks()
	})

	it('quotes and places an automatic discount, and reserves the use', async () => {
		const quote = await post('/orders/quote', orderBody())
		expect(quote.status).toBe(200)
		const quoted = await quote.json()
		expect(quoted.totalDiscountMinor).toBe(200)
		expect(quoted.discounts[0]).toMatchObject({
			discountId: 'disc_auto',
			amountMinor: 200,
		})

		const placed = await post(
			'/orders',
			orderBody({ discounts: { expectedDiscountMinor: 200 } }),
		)
		expect(placed.status).toBe(201)
		const body = await placed.json()
		expect(body.order.discountCents).toBe(200)
		expect(body.order.subtotalCents).toBe(2000)

		const db = await getTenantDb(orgId)
		const rows = await db
			.select()
			.from(discountRedemptions)
			.where(eq(discountRedemptions.sourceId, body.order.id))
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({
			discountId: 'disc_auto',
			state: 'reserved',
			amountMinor: 200,
			sourceType: 'order',
		})
	})

	it('refuses a total that is not the one quoted', async () => {
		const response = await post(
			'/orders',
			orderBody({ discounts: { expectedDiscountMinor: 1 } }),
		)
		expect(response.status).toBe(409)
		expect(await response.json()).toMatchObject({ error: 'discount_changed' })
	})

	it('refuses an unknown coupon and applies a known one', async () => {
		const refused = await post(
			'/orders/quote',
			orderBody({ discounts: { code: 'NOPE' } }),
		)
		expect(refused.status).toBe(200)
		expect((await refused.json()).coupon).toMatchObject({
			status: 'refused',
			reason: 'not_found',
		})

		const placed = await post(
			'/orders',
			orderBody({
				discounts: { code: 'nope', expectedDiscountMinor: 0 },
			}),
		)
		expect(placed.status).toBe(409)
		expect(await placed.json()).toMatchObject({ error: 'coupon_refused' })

		const welcome = await post(
			'/orders',
			orderBody({
				discounts: { code: 'save10', expectedDiscountMinor: 300 },
			}),
		)
		expect(welcome.status).toBe(201)
		expect((await welcome.json()).order.discountCents).toBe(300)
	})

	it('lets only one order take the last use', async () => {
		activeContext = menuContext({
			discounts: {
				features: { automatic: true, coupons: true },
				discounts: [makeDiscount({ id: 'disc_auto', totalLimit: 1 })],
				codes: [],
			},
		})
		const [first, second] = await Promise.all([
			post('/orders', orderBody({ discounts: { expectedDiscountMinor: 200 } })),
			post('/orders', orderBody({ discounts: { expectedDiscountMinor: 200 } })),
		])
		const statuses = [first.status, second.status].sort()
		expect(statuses).toEqual([201, 409])
		const failed = first.status === 409 ? first : second
		expect(await failed.json()).toMatchObject({ error: 'discount_changed' })
	})

	it('accepts a fully discounted online order without a payment and refunds redemptions if cancelled', async () => {
		activeContext = menuContext({
			discounts: {
				features: { automatic: true, coupons: false },
				discounts: [
					makeDiscount({
						id: 'disc_free',
						percentBp: 10000,
						name: 'On the house',
					}),
				],
				codes: [],
			},
		})
		const response = await post(
			'/orders',
			orderBody({
				paymentMethod: 'online',
				discounts: { expectedDiscountMinor: 2000 },
			}),
		)
		expect(response.status).toBe(201)
		const body = await response.json()
		expect(body.order.paymentStatus).toBe('not_required')
		expect(body.order.totalCents).toBe(0)
		const db = await getTenantDb(orgId)
		const [row] = await db
			.select()
			.from(discountRedemptions)
			.where(eq(discountRedemptions.sourceId, body.order.id))
		expect(row?.state).toBe('consumed')

		const { updateOperatorOrder } = await import('../services/order-service.ts')
		const cancelResult = await updateOperatorOrder(orgId, body.order.id, {
			status: 'cancelled',
		})
		expect(cancelResult.ok).toBe(true)

		const [cancelledRow] = await db
			.select()
			.from(discountRedemptions)
			.where(eq(discountRedemptions.sourceId, body.order.id))
		expect(cancelledRow?.state).toBe('refunded')
	})

	it('refuses a discount on a tab round and prices one when the tab is paid', async () => {
		const priced = priceRestaurantOrder(
			activeContext as never,
			orderBody() as never,
			{ now: new Date() },
		)
		expect(priced.ok).toBe(true)
		if (!priced.ok) return
		const refused = await prepareOrderDiscounts(await getTenantDb(orgId), {
			priced: priced.result,
			context: activeContext as never,
			discounts: { expectedDiscountMinor: 200 },
			fulfillment: 'dine_in',
			source: 'qr_table',
			customerId: null,
			now: new Date(),
			killed: false,
		})
		expect(refused.ok).toBe(false)
		if (!refused.ok) expect(refused.failure.code).toBe('discounts_on_tab')

		const placed = await post(
			'/orders',
			orderBody({ discounts: { expectedDiscountMinor: 200 } }),
		)
		expect(placed.status).toBe(201)
		const body = await placed.json()
		const db = await getTenantDb(orgId)
		const [round] = await db
			.select()
			.from(restaurantOrders)
			.where(eq(restaurantOrders.id, body.order.id))
		const tab = await evaluateTabDiscounts(db, {
			context: activeContext as never,
			rounds: round ? [round] : [],
			locationId: 'loc-1',
			customerId: null,
			discounts: { code: 'SAVE10' },
			now: new Date(),
		})
		expect(tab.ok).toBe(true)
		if (tab.ok) {
			expect(tab.quote?.discountCents).toBe(300)
			expect(tab.quote?.prepared.evaluation.applied[0]?.discountId).toBe(
				'disc_code',
			)
		}
	})

	it('refuses a typed code on a tab when coupons are off instead of charging full price', async () => {
		const placed = await post('/orders', orderBody())
		expect(placed.status).toBe(201)
		const body = await placed.json()
		const db = await getTenantDb(orgId)
		const [round] = await db
			.select()
			.from(restaurantOrders)
			.where(eq(restaurantOrders.id, body.order.id))
		const base = activeContext as {
			discounts: { features: Record<string, boolean> }
		}
		const noCoupons = {
			...activeContext,
			discounts: {
				...base.discounts,
				features: { ...base.discounts.features, coupons: false },
			},
		}
		const tab = await evaluateTabDiscounts(db, {
			context: noCoupons as never,
			rounds: round ? [round] : [],
			locationId: 'loc-1',
			customerId: null,
			discounts: { code: 'SAVE10' },
			now: new Date(),
		})
		expect(tab.ok).toBe(false)
		if (!tab.ok) {
			expect(tab.failure.code).toBe('coupon_refused')
			expect(tab.failure.reason).toBe('not_found')
		}
	})

	it('hides why a code was refused', () => {
		expect(publicRefusalReason('expired')).toBe('not_found')
		expect(publicRefusalReason('wrong_location')).toBe('not_found')
	})

	it('replays the same checkout and rejects a different code on that key', async () => {
		const key = crypto.randomUUID()
		const body = orderBody({
			idempotencyKey: key,
			discounts: { code: 'SAVE10', expectedDiscountMinor: 300 },
		})
		const first = await post('/orders', body)
		expect(first.status).toBe(201)
		const again = await post('/orders', body)
		expect(again.status).toBe(200)
		expect((await again.json()).order.id).toBe((await first.json()).order.id)

		const changed = await post('/orders', {
			...body,
			discounts: { code: 'OTHER', expectedDiscountMinor: 300 },
		})
		expect(changed.status).toBe(409)
		expect(await changed.json()).toMatchObject({
			error: 'idempotency_conflict',
		})
	})

	it('stops coupon checks when discounts are switched off', async () => {
		vi.stubEnv('DISCOUNTS_ENABLED', 'false')
		const response = await post(
			'/orders/quote',
			orderBody({ discounts: { code: 'SAVE10' } }),
		)
		expect(response.status).toBe(503)
		expect(await response.json()).toMatchObject({ error: 'discounts_disabled' })
	})

	it('refuses to charge full price when the guest was shown a discount and the switch is off', async () => {
		vi.stubEnv('DISCOUNTS_ENABLED', 'false')
		const response = await post(
			'/orders',
			orderBody({ discounts: { expectedDiscountMinor: 200 } }),
		)
		expect(response.status).toBe(409)
		expect(await response.json()).toMatchObject({ error: 'discount_changed' })
	})

	it('rejects a forged operator token and hides another organization', async () => {
		const placed = await post(
			'/orders',
			orderBody({ discounts: { expectedDiscountMinor: 200 } }),
		)
		expect(placed.status).toBe(201)

		const forged = await app.request(
			'/operator/discounts/usage?ids=disc_auto',
			{
				headers: {
					authorization: `Bearer ${await operatorJwt(orgId, 'wrong-secret-but-long-enough')}`,
				},
			},
		)
		expect(forged.status).toBe(401)

		const own = await app.request('/operator/discounts/usage?ids=disc_auto', {
			headers: { authorization: `Bearer ${await operatorJwt(orgId)}` },
		})
		expect(own.status).toBe(200)
		expect((await own.json()).usage[0].uses).toBe(1)

		const other = await app.request('/operator/discounts/usage?ids=disc_auto', {
			headers: { authorization: `Bearer ${await operatorJwt(otherOrgId)}` },
		})
		expect(other.status).toBe(200)
		expect((await other.json()).usage[0].uses).toBe(0)
	})

	it('counts only sales at the locations on the token', async () => {
		const placed = await post(
			'/orders',
			orderBody({ discounts: { expectedDiscountMinor: 200 } }),
		)
		expect(placed.status).toBe(201)
		const uses = async (locationIds: string[] | null) => {
			const response = await app.request(
				'/operator/discounts/usage?ids=disc_auto',
				{
					headers: {
						authorization: `Bearer ${await operatorJwt(orgId, operatorSecret, locationIds)}`,
					},
				},
			)
			expect(response.status).toBe(200)
			return (await response.json()).usage[0].uses
		}
		expect(await uses(['loc-1'])).toBe(1)
		expect(await uses(['loc-2'])).toBe(0)
		expect(await uses([])).toBe(0)
		expect(await uses(null)).toBe(1)
	})
})
