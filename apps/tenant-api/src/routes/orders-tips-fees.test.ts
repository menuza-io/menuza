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
 * Checkout tips (#118) and the guest service fee (#123) at placement: a custom
 * tip is charged exactly and stored with a null percent, a tip above the cap is
 * refused, and the region prices the fee itself and refuses a browser that
 * showed another amount. One burger line at 10.00, two of them: subtotal
 * 20.00, tax 8.25 % = 1.65.
 */

const orgId = 'org_tips_fees_1'
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

const feeSettings = (patch: Record<string, unknown> = {}) => ({
	enabled: true,
	percentBp: 300,
	fixedMinor: 0,
	capMinor: null,
	smallOrderBelowMinor: null,
	smallOrderFeeMinor: null,
	fulfillments: ['pickup', 'delivery'],
	label: 'Online fee',
	explanation: null,
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
						delivery: true,
						dineIn: true,
						curbside: false,
					},
					inHouseTips: {
						pickupTips: true,
						deliveryTips: true,
						dineInTips: true,
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

const feeContext = (
	settings: Record<string, unknown> = feeSettings(),
	location: Record<string, unknown> = {},
) =>
	menuContext(
		{ serviceFee: { version: 1, locations: { 'loc-1': settings } } },
		location,
	)

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

describe('checkout tips and the service fee', () => {
	let directory: string
	let app: Hono
	let activeContext: unknown

	async function postOrder(body: unknown) {
		return app.request('/orders', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				origin: 'https://test-org.example.com',
			},
			body: JSON.stringify(body),
		})
	}

	async function storedOrder(id: string) {
		const db = await getTenantDb(orgId)
		const [row] = await db
			.select()
			.from(restaurantOrders)
			.where(eq(restaurantOrders.id, id))
		return row!
	}

	beforeEach(async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orders-tips-fees-'))
		vi.stubEnv('TENANT_DB_DIR', directory)
		vi.stubEnv('DATA_REGION', 'us')
		vi.stubEnv('INTERNAL_COMMAND_TOKEN', 'test-internal-token-very-long-and-secure-12345')
		vi.stubEnv('TENANT_OPERATOR_TOKEN', 'test-operator-token-very-long-and-secure-12345')
		vi.stubEnv('JWT_SECRET', 'test-jwt-secret-123456789')
		vi.stubEnv('AUTH_HMAC_SECRET', 'test-hmac-secret-123456789')
		vi.stubEnv('APP_URL', 'https://app.test')
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
		try {
			await destroyTenantDb(orgId)
			fs.rmSync(directory, { recursive: true, force: true })
		} catch {}
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
		vi.clearAllMocks()
	})

	describe('tips (#118)', () => {
		it('still accepts the legacy tipPercent and stores the percent', async () => {
			const response = await postOrder(orderBody({ tipPercent: 10 }))
			expect(response.status).toBe(201)
			const { order } = await response.json()
			expect(order.tipCents).toBe(200)
			expect(order.totalCents).toBe(2000 + 165 + 200)
			expect((await storedOrder(order.id)).tipPercent).toBe(10)
		})

		it('takes a percentage through tip', async () => {
			const response = await postOrder(orderBody({ tip: { percent: 15 } }))
			expect(response.status).toBe(201)
			const { order } = await response.json()
			expect(order.tipCents).toBe(300)
			expect((await storedOrder(order.id)).tipPercent).toBe(15)
		})

		it('charges a custom amount exactly and stores a null percent', async () => {
			const response = await postOrder(
				orderBody({ tip: { amountMinor: 437 } }),
			)
			expect(response.status).toBe(201)
			const { order } = await response.json()
			expect(order.tipCents).toBe(437)
			expect(order.totalCents).toBe(2000 + 165 + 437)
			const row = await storedOrder(order.id)
			expect(row.tipCents).toBe(437)
			expect(row.tipPercent).toBeNull()
		})

		it('accepts a custom tip of 0', async () => {
			const response = await postOrder(orderBody({ tip: { amountMinor: 0 } }))
			expect(response.status).toBe(201)
			expect((await response.json()).order.tipCents).toBe(0)
		})

		it('refuses a custom tip above the cap with 422 tip_too_large', async () => {
			// 200 USD on a 20.00 subtotal: the cap is the larger of 50 % or 200.00.
			const refused = await postOrder(
				orderBody({ tip: { amountMinor: 20_001 } }),
			)
			expect(refused.status).toBe(422)
			expect((await refused.json()).error).toBe('tip_too_large')
			const allowed = await postOrder(
				orderBody({ tip: { amountMinor: 20_000 } }),
			)
			expect(allowed.status).toBe(201)
		})

		it('refuses tip together with a non-zero tipPercent', async () => {
			const response = await postOrder(
				orderBody({ tip: { percent: 10 }, tipPercent: 10 }),
			)
			expect(response.status).toBe(400)
		})

		it('refuses a malformed tip', async () => {
			for (const tip of [
				{ percent: 31 },
				{ amountMinor: -5 },
				{ amountMinor: 1.5 },
				{ percent: 10, amountMinor: 5 },
			]) {
				const response = await postOrder(orderBody({ tip }))
				expect(response.status).toBe(400)
			}
		})

		it('refuses any tip where tips are switched off', async () => {
			activeContext = menuContext(
				{},
				{
					inHouseTips: {
						pickupTips: false,
						deliveryTips: true,
						dineInTips: true,
					},
				},
			)
			const response = await postOrder(orderBody({ tip: { amountMinor: 100 } }))
			expect(response.status).toBe(422)
			expect((await response.json()).error).toBe('tips_disabled')
		})
	})

	describe('service fee (#123)', () => {
		it('adds the fee the region priced and stores it with its label', async () => {
			activeContext = feeContext()
			const response = await postOrder(
				orderBody({ expectedServiceFeeMinor: 60, tipPercent: 10 }),
			)
			expect(response.status).toBe(201)
			const { order } = await response.json()
			expect(order.serviceFeeCents).toBe(60)
			expect(order.serviceFeeLabel).toBe('Online fee')
			// The tip is 10 % of the 20.00 subtotal, never of the fee.
			expect(order.tipCents).toBe(200)
			expect(order.totalCents).toBe(2000 + 165 + 200 + 60)
			const row = await storedOrder(order.id)
			expect(row.serviceFeeCents).toBe(60)
			expect(row.serviceFeeTaxCents).toBe(0)
			expect(row.taxCents).toBe(165)
		})

		it('refuses a browser that showed a different fee with 409 service_fee_changed', async () => {
			activeContext = feeContext()
			const lower = await postOrder(orderBody({ expectedServiceFeeMinor: 10 }))
			expect(lower.status).toBe(409)
			const body = await lower.json()
			expect(body.error).toBe('service_fee_changed')
			expect(body.details.serviceFeeMinor).toBe(60)
			const db = await getTenantDb(orgId)
			expect(await db.select().from(restaurantOrders)).toHaveLength(0)
		})

		it('treats a missing expected fee as 0 where a fee is due', async () => {
			activeContext = feeContext()
			const response = await postOrder(orderBody())
			expect(response.status).toBe(409)
			expect((await response.json()).error).toBe('service_fee_changed')
		})

		it('refuses a fee the page showed after the fee was turned off', async () => {
			activeContext = menuContext()
			const response = await postOrder(orderBody({ expectedServiceFeeMinor: 60 }))
			expect(response.status).toBe(409)
			expect((await response.json()).error).toBe('service_fee_changed')
		})

		it('charges no fee on an order type it does not cover', async () => {
			activeContext = feeContext(feeSettings({ fulfillments: ['delivery'] }))
			const response = await postOrder(orderBody())
			expect(response.status).toBe(201)
			expect((await response.json()).order.serviceFeeCents).toBe(0)
		})

		it('caps the fee after the percentage plus the fixed amount', async () => {
			activeContext = feeContext(feeSettings({ fixedMinor: 100, capMinor: 120 }))
			const response = await postOrder(orderBody({ expectedServiceFeeMinor: 120 }))
			expect(response.status).toBe(201)
			expect((await response.json()).order.serviceFeeCents).toBe(120)
		})

		it('applies the small order fee below the limit', async () => {
			activeContext = feeContext(
				feeSettings({ smallOrderBelowMinor: 2500, smallOrderFeeMinor: 99 }),
			)
			const response = await postOrder(orderBody({ expectedServiceFeeMinor: 99 }))
			expect(response.status).toBe(201)
			expect((await response.json()).order.serviceFeeCents).toBe(99)
		})

		it('adds tax on a taxable fee to the order tax and total', async () => {
			activeContext = feeContext(feeSettings({ taxable: true }))
			const response = await postOrder(orderBody({ expectedServiceFeeMinor: 60 }))
			expect(response.status).toBe(201)
			const { order } = await response.json()
			// 8.25 % of 0.60 is 0.0495, so 0.05.
			expect(order.taxCents).toBe(165 + 5)
			expect(order.totalCents).toBe(2000 + 165 + 5 + 60)
			const row = await storedOrder(order.id)
			expect(row.serviceFeeTaxCents).toBe(5)
		})

		it('carves the tax out of the fee when prices include tax', async () => {
			activeContext = feeContext(feeSettings({ taxable: true }), {
				taxInclusive: true,
			})
			const response = await postOrder(orderBody({ expectedServiceFeeMinor: 60 }))
			expect(response.status).toBe(201)
			const { order } = await response.json()
			// Items 20.00 (tax inside) + fee 0.60 (tax inside): the total adds the fee only.
			expect(order.totalCents).toBe(2000 + 60)
			expect(order.serviceFeeTaxCents).toBe(Math.round((60 * 8.25) / 108.25))
		})

		it('refuses an order at a location whose fee it cannot read, never dropping it', async () => {
			activeContext = menuContext({
				serviceFee: {
					version: 1,
					locations: { 'loc-1': { enabled: true, percentBp: 'three' } },
				},
			})
			const response = await postOrder(orderBody({ expectedServiceFeeMinor: 0 }))
			expect(response.status).toBe(503)
			expect((await response.json()).error).toBe('service_fee_unavailable')
		})

		it('refuses a payload newer than the node knows', async () => {
			activeContext = menuContext({
				serviceFee: { version: 99, locations: { 'loc-1': feeSettings() } },
			})
			const response = await postOrder(orderBody({ expectedServiceFeeMinor: 60 }))
			expect(response.status).toBe(503)
		})

		it('a replay of the same checkout returns the order, not a second fee', async () => {
			activeContext = feeContext()
			const body = orderBody({ expectedServiceFeeMinor: 60 })
			const first = await postOrder(body)
			const second = await postOrder(body)
			expect(first.status).toBe(201)
			expect(second.status).toBe(200)
			expect((await second.json()).order.serviceFeeCents).toBe(60)
		})

		it('changing the fee afterwards does not touch a placed order', async () => {
			activeContext = feeContext()
			const placed = await postOrder(orderBody({ expectedServiceFeeMinor: 60 }))
			const { order } = await placed.json()
			activeContext = menuContext()
			const row = await storedOrder(order.id)
			expect(row.serviceFeeCents).toBe(60)
			expect(row.totalCents).toBe(2000 + 165 + 60)
		})
	})
})
