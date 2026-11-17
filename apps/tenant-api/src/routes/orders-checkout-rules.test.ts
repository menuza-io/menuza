import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	restaurantOrders,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeDiscount } from '../../../../packages/discounts/src/test-fixtures.ts'
import {
	findActiveOrganizationById,
	resolveOrganizationForBrowserAuth,
} from '../lib/origin.ts'
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
 * Checkout rules at placement: pickup instructions (#251), utensils (#257),
 * the large-order extra time (#355), the order size cap (#422) and the
 * packaging fee (#408). One burger is 10.00; tax is off unless a test turns it
 * on, so every figure is easy to read.
 */

const orgId = 'org_checkout_rules_1'
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

const packagingSettings = (patch: Record<string, unknown> = {}) => ({
	enabled: true,
	mode: 'per_order',
	amountMinor: 100,
	fulfillments: ['pickup', 'delivery'],
	label: 'Packaging fee',
	taxable: false,
	...patch,
})

function menuContext(
	extra: Record<string, unknown> = {},
	location: Record<string, unknown> = {},
) {
	return {
		orgId,
		dataRegion: 'us',
		menu: {
			organization: {
				id: orgId,
				slug: 'test-org',
				currency: 'USD',
				defaultLocale: 'en',
			},
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
						pickupTips: false,
						deliveryTips: false,
						dineInTips: false,
					},
					onlineHours: ALL_DAYS,
					...location,
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
									id: 'item-soda',
									displayName: 'Soda',
									price: 2,
									availabilityStatus: 'available',
									excludeFromOrderLimits: true,
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
		lines: [{ itemId: 'item-burger', quantity: 2, options: [] }],
		...overrides,
	}
}

const burgers = (quantity: number) => [
	{ itemId: 'item-burger', quantity, options: [] },
]

describe('checkout rules at placement', () => {
	let directory: string
	let app: Hono
	let activeContext: unknown

	const headers = {
		'content-type': 'application/json',
		origin: 'https://test-org.example.com',
	}
	const postOrder = (body: unknown) =>
		app.request('/orders', {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
		})
	const postQuote = (body: unknown) =>
		app.request('/orders/quote', {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
		})
	const getOptions = () =>
		app.request('/orders/options?slug=test-org&locationId=loc-1', {
			headers: { origin: 'https://test-org.example.com' },
		})

	async function storedOrder(id: string) {
		const db = await getTenantDb(orgId)
		const [row] = await db
			.select()
			.from(restaurantOrders)
			.where(eq(restaurantOrders.id, id))
		return row!
	}

	beforeEach(async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orders-checkout-rules-'))
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
		vi.stubEnv('JWT_SECRET', 'test-jwt-secret-123456789')
		vi.stubEnv('AUTH_HMAC_SECRET', 'test-hmac-secret-123456789')
		vi.stubEnv('APP_URL', 'https://app.test')
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(new Date('2026-03-10T12:00:00.000Z'))
		activeContext = menuContext()
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = typeof input === 'string' ? input : input.toString()
				if (url.includes('/resources/order-context')) {
					return new Response(JSON.stringify(activeContext), {
						status: 200,
						headers: { 'content-type': 'application/json' },
					})
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
	})

	afterEach(async () => {
		vi.useRealTimers()
		try {
			await destroyTenantDb(orgId)
			fs.rmSync(directory, { recursive: true, force: true })
		} catch {}
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
		vi.clearAllMocks()
	})

	describe('pickup instructions (#251)', () => {
		const localized = JSON.stringify({
			en: 'Park in the side lot and ring the bell.',
			ar: 'اركن في الموقف الجانبي واضغط الجرس.',
		})

		it('keeps a copy of what the guest saw, in the guest language, with the default as fallback', async () => {
			activeContext = menuContext({
				pickupInstructions: { 'loc-1': localized },
			})
			const arabic = await (await postOrder(orderBody({ locale: 'ar' }))).json()
			expect(arabic.order.pickupInstructions).toBe(
				'اركن في الموقف الجانبي واضغط الجرس.',
			)
			// A language with no translation reads the default language.
			const french = await (await postOrder(orderBody({ locale: 'fr' }))).json()
			expect(french.order.pickupInstructions).toBe(
				'Park in the side lot and ring the bell.',
			)
		})

		it('never rewrites a placed order when the text changes later', async () => {
			activeContext = menuContext({
				pickupInstructions: { 'loc-1': localized },
			})
			const placed = await (await postOrder(orderBody())).json()
			activeContext = menuContext({
				pickupInstructions: {
					'loc-1': JSON.stringify({ en: 'Use the front door.' }),
				},
			})
			expect((await storedOrder(placed.order.id)).pickupInstructions).toBe(
				'Park in the side lot and ring the bell.',
			)
			const receipt = await app.request(
				`/orders/${placed.order.id}?slug=test-org`,
				{
					headers: {
						origin: 'https://test-org.example.com',
						authorization: `Bearer ${placed.receiptToken}`,
					},
				},
			)
			expect((await receipt.json()).order.pickupInstructions).toBe(
				'Park in the side lot and ring the bell.',
			)
		})

		it('stores nothing when the location has no text', async () => {
			const none = await (await postOrder(orderBody())).json()
			expect(none.order.pickupInstructions).toBeNull()
		})

		it('limits the text to 300 characters', async () => {
			activeContext = menuContext({
				pickupInstructions: { 'loc-1': 'x'.repeat(500) },
			})
			const placed = await (await postOrder(orderBody())).json()
			expect(placed.order.pickupInstructions).toHaveLength(300)
		})

		it('is part of the options a guest page reads, not for a drop', async () => {
			activeContext = menuContext({
				pickupInstructions: { 'loc-1': localized },
			})
			const options = await (await getOptions()).json()
			expect(options.pickupInstructions).toBe(localized)
			activeContext = menuContext()
			expect((await (await getOptions()).json()).pickupInstructions).toBeNull()
		})
	})

	describe('utensils (#257)', () => {
		const asks = (defaultRequested = false) => ({
			utensils: { 'loc-1': { enabled: true, defaultRequested } },
		})

		it('stores the answer, with the configured default when none is sent', async () => {
			activeContext = menuContext(asks(true))
			const unanswered = await (await postOrder(orderBody())).json()
			expect(unanswered.order.utensilsRequested).toBe(true)
			const declined = await (
				await postOrder(orderBody({ utensilsRequested: false }))
			).json()
			expect(declined.order.utensilsRequested).toBe(false)
		})

		it('ignores the field while the location does not ask', async () => {
			const placed = await (
				await postOrder(orderBody({ utensilsRequested: true }))
			).json()
			expect(placed.order.utensilsRequested).toBeNull()
		})

		it('is stored on the order, so changing the setting later changes nothing', async () => {
			activeContext = menuContext(asks(false))
			const placed = await (
				await postOrder(orderBody({ utensilsRequested: true }))
			).json()
			activeContext = menuContext()
			expect((await storedOrder(placed.order.id)).utensilsRequested).toBe(true)
		})

		it('is offered in the options only when the location asks', async () => {
			activeContext = menuContext(asks(true))
			expect((await (await getOptions()).json()).utensils).toEqual({
				enabled: true,
				defaultRequested: true,
			})
			activeContext = menuContext()
			expect((await (await getOptions()).json()).utensils).toBeNull()
		})
	})

	describe('large-order extra time (#355)', () => {
		const rule = {
			threshold: 12,
			thresholdType: 'items',
			extraPrepMinutes: 15,
			itemThreshold: 12,
			amountThresholdMinor: 30_000,
		}
		const promisedMinutes = async (lines: unknown) => {
			const placed = await (await postOrder(orderBody({ lines }))).json()
			const row = await storedOrder(placed.order.id)
			return {
				extra: row.largeOrderExtraMinutes,
				minutes: (row.promisedAt!.getTime() - Date.now()) / 60_000,
			}
		}

		it('promises 15 minutes later for a 13-item ASAP order than for a 2-item one', async () => {
			activeContext = menuContext({ largeOrder: { 'loc-1': rule } })
			const small = await promisedMinutes(burgers(2))
			const large = await promisedMinutes(burgers(13))
			expect(small.extra).toBe(0)
			expect(large.extra).toBe(15)
			expect(large.minutes - small.minutes).toBe(15)
		})

		it('also applies when the amount is reached first', async () => {
			activeContext = menuContext({ largeOrder: { 'loc-1': rule } })
			// 31 burgers is over 30 000 minor units; 2 burgers with soda stays under.
			const byAmount = await promisedMinutes(burgers(31))
			expect(byAmount.extra).toBe(15)
		})

		it('does not count dishes that do not count toward order limits', async () => {
			activeContext = menuContext({ largeOrder: { 'loc-1': rule } })
			// 8 burgers and 10 sodas: 18 pieces, 8 that count.
			const mixed = await promisedMinutes([
				{ itemId: 'item-burger', quantity: 8, options: [] },
				{ itemId: 'item-soda', quantity: 10, options: [] },
			])
			expect(mixed.extra).toBe(0)
		})

		it('is the same on the ordering page: the options carry the rule the region applies', async () => {
			activeContext = menuContext({ largeOrder: { 'loc-1': rule } })
			const options = await (await getOptions()).json()
			expect(options.ordering.largeOrder).toMatchObject({
				itemThreshold: 12,
				amountThresholdMinor: 30_000,
				extraPrepMinutes: 15,
			})
		})
	})

	describe('order size cap (#422)', () => {
		const caps = (rule: Record<string, unknown>) => ({
			orderCaps: { locations: { 'loc-1': rule } },
		})

		it('refuses an order above the cap with a message that points to catering or the phone', async () => {
			activeContext = menuContext(caps({ pickup: { maxSubtotalMinor: 5_000 } }))
			const refused = await postOrder(orderBody({ lines: burgers(6) }))
			expect(refused.status).toBe(422)
			const body = await refused.json()
			expect(body.error).toBe('order_too_large')
			expect(body.message).toMatch(
				/call the restaurant or place a catering order/i,
			)
			expect(body.details).toEqual({ kind: 'amount', fulfillment: 'pickup' })
			// The cap's number is never in the message.
			expect(JSON.stringify(body)).not.toContain('5000')
			expect(JSON.stringify(body)).not.toContain('50.00')
		})

		it('lets an order at the cap through', async () => {
			activeContext = menuContext(caps({ pickup: { maxSubtotalMinor: 5_000 } }))
			expect((await postOrder(orderBody({ lines: burgers(5) }))).status).toBe(
				201,
			)
		})

		it('enforces the cap again at placement even when the page never asked', async () => {
			// No quote was ever requested: the order itself is what is checked.
			activeContext = menuContext(caps({ pickup: { maxSubtotalMinor: 1_000 } }))
			expect((await postOrder(orderBody({ lines: burgers(2) }))).status).toBe(
				422,
			)
		})

		it('applies at quote time too', async () => {
			activeContext = menuContext({
				...caps({ pickup: { maxSubtotalMinor: 5_000 } }),
				discounts: {
					features: { automatic: true, coupons: false },
					discounts: [makeDiscount({ id: 'd1', percentBp: 1000 })],
					codes: [],
				},
			})
			const { idempotencyKey: _ignored, ...quoteBody } = orderBody({
				lines: burgers(6),
				discounts: {},
			})
			const response = await postQuote(quoteBody)
			expect(response.status).toBe(422)
			expect((await response.json()).error).toBe('order_too_large')
		})

		it('caps a table by head count when the page sends one', async () => {
			activeContext = menuContext(caps({ dineIn: { maxGuests: 4 } }))
			expect((await getOptionsJson()).dineInMaxGuests).toBe(4)
		})

		async function getOptionsJson() {
			return (await getOptions()).json()
		}

		it('has no cap, and so no number to show, when none is set', async () => {
			expect((await getOptionsJson()).dineInMaxGuests).toBeNull()
		})
	})

	describe('packaging fee (#408)', () => {
		const fee = (settings: Record<string, unknown> = packagingSettings()) => ({
			packagingFee: { version: 1, locations: { 'loc-1': settings } },
		})

		it('adds a 1.00 fee to a takeaway order as its own line, with its label', async () => {
			activeContext = menuContext(fee())
			const response = await postOrder(
				orderBody({ expectedPackagingFeeMinor: 100 }),
			)
			expect(response.status).toBe(201)
			const { order } = await response.json()
			expect(order.packagingFeeCents).toBe(100)
			expect(order.packagingFeeLabel).toBe('Packaging fee')
			expect(order.totalCents).toBe(2000 + 100)
			expect((await storedOrder(order.id)).packagingFeeCents).toBe(100)
		})

		it('refuses a page that showed another amount, and one that showed none', async () => {
			activeContext = menuContext(fee())
			for (const expected of [{ expectedPackagingFeeMinor: 50 }, {}]) {
				const refused = await postOrder(orderBody(expected))
				expect(refused.status).toBe(409)
				const body = await refused.json()
				expect(body.error).toBe('packaging_fee_changed')
				expect(body.details).toEqual({ packagingFeeMinor: 100 })
			}
		})

		it('charges nothing and expects nothing where the location has no fee', async () => {
			const placed = await (await postOrder(orderBody())).json()
			expect(placed.order.packagingFeeCents).toBe(0)
			expect(placed.order.packagingFeeLabel).toBeNull()
		})

		it('counts per item, leaving out dishes that do not count toward order limits', async () => {
			activeContext = menuContext(fee(packagingSettings({ mode: 'per_item' })))
			const placed = await postOrder(
				orderBody({
					lines: [
						{ itemId: 'item-burger', quantity: 3, options: [] },
						{ itemId: 'item-soda', quantity: 5, options: [] },
					],
					expectedPackagingFeeMinor: 300,
				}),
			)
			expect(placed.status).toBe(201)
			expect((await placed.json()).order.packagingFeeCents).toBe(300)
		})

		it('taxes the fee at the location rate when it is taxable', async () => {
			activeContext = menuContext(fee(packagingSettings({ taxable: true })), {
				taxRate: 10,
			})
			const placed = await (
				await postOrder(orderBody({ expectedPackagingFeeMinor: 100 }))
			).json()
			// 10 % on 20.00 of items and on the 1.00 fee.
			expect(placed.order.taxCents).toBe(200 + 10)
			expect(placed.order.packagingFeeTaxCents).toBe(10)
			expect(placed.order.totalCents).toBe(2000 + 100 + 210)
		})

		it('refuses to take an order it cannot price instead of dropping the fee', async () => {
			activeContext = menuContext({
				packagingFee: { version: 1, locations: { 'loc-1': { enabled: true } } },
			})
			const refused = await postOrder(orderBody())
			expect(refused.status).toBe(503)
			expect((await refused.json()).error).toBe('packaging_fee_unavailable')
		})

		it('is in the options a guest page prices from, only while it is on', async () => {
			activeContext = menuContext(fee())
			expect((await (await getOptions()).json()).packagingFee).toMatchObject({
				amountMinor: 100,
				mode: 'per_order',
			})
			activeContext = menuContext(fee(packagingSettings({ enabled: false })))
			expect((await (await getOptions()).json()).packagingFee).toBeNull()
		})

		describe('waived by a discount', () => {
			const withDiscount = (waives: boolean) =>
				menuContext({
					...fee(),
					discounts: {
						features: { automatic: true, coupons: false },
						discounts: [
							makeDiscount({
								id: 'd_bag',
								name: 'Bring your own bag',
								percentBp: 1000,
								...(waives ? { waivesPackagingFee: true } : {}),
							}),
						],
						codes: [],
					},
				})
			const quoteBody = () => {
				const { idempotencyKey: _k, ...rest } = orderBody({ discounts: {} })
				return rest
			}

			it('quotes no fee when an applied discount waives it, and the fee otherwise', async () => {
				activeContext = withDiscount(true)
				expect(
					(await (await postQuote(quoteBody())).json()).packagingFeeMinor,
				).toBe(0)
				activeContext = withDiscount(false)
				expect(
					(await (await postQuote(quoteBody())).json()).packagingFeeMinor,
				).toBe(100)
			})

			it('places the order without the fee and refuses a page that still showed it', async () => {
				activeContext = withDiscount(true)
				const stale = await postOrder(
					orderBody({
						discounts: { expectedDiscountMinor: 200 },
						expectedPackagingFeeMinor: 100,
					}),
				)
				expect(stale.status).toBe(409)
				const placed = await postOrder(
					orderBody({ discounts: { expectedDiscountMinor: 200 } }),
				)
				expect(placed.status).toBe(201)
				const { order } = await placed.json()
				expect(order.packagingFeeCents).toBe(0)
				expect(order.totalCents).toBe(2000 - 200)
			})

			it('keeps the fee when a discount does not say it waives it', async () => {
				activeContext = withDiscount(false)
				const placed = await postOrder(
					orderBody({
						discounts: { expectedDiscountMinor: 200 },
						expectedPackagingFeeMinor: 100,
					}),
				)
				expect(placed.status).toBe(201)
				expect((await placed.json()).order.packagingFeeCents).toBe(100)
			})
		})
	})
})
