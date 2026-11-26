import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	destroyTenantDb,
	getTenantDb,
	kdsTickets,
	provisionTenantDb,
	restaurantOrderRevisions,
	restaurantOrders,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type OrderContextResponse } from '@repo/common/restaurant-orders'
import { signDeliveryQuote } from '../lib/delivery-quote-token.ts'
import {
	listOrderRevisions,
	reviseOperatorOrder,
} from './order-revise-service.ts'
import { operatorOrder, receiptOrder } from './order-service.ts'

const mockSendEmail = vi.fn(async () => ({ id: 'em_mock' }))
vi.mock('../lib/tenant-email.ts', () => ({
	sendTenantEmail: (...args: unknown[]) => mockSendEmail(...args),
}))

function testContext(
	orgId: string,
	locId: string,
	currency = 'USD',
): OrderContextResponse {
	const everyDay = [
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
	return {
		orgId,
		dataRegion: 'us',
		drop: null,
		onlinePayment: { enabled: true, processor: 'connect' },
		menu: {
			organization: {
				id: orgId,
				slug: 'demo',
				currency,
				defaultLocale: 'en',
			},
			locationOverrides: {},
			locations: [
				{
					id: locId,
					name: 'Downtown',
					currency,
					timezone: 'America/New_York',
					taxRate: 10,
					taxInclusive: false,
					prepTime: 15,
					fulfillmentOptions: { pickup: true, delivery: true, dineIn: false },
					inHouseTips: {
						pickupTips: true,
						deliveryTips: true,
						dineInTips: false,
					},
					onlineHours: everyDay,
					deliveryConfig: {
						providers: ['in_house'],
						estimatedDeliveryTimeMin: 25,
						estimatedDeliveryTimeMax: 45,
					},
					deliveryZones: [
						{
							id: 'z-1',
							name: 'Downtown',
							provider: 'in_house',
							restriction: 'allowed',
							type: 'radius',
							radius: { value: 10, unit: 'miles' },
							zipCodes: [],
							polygon: [],
							deliveryFee: 3.5,
							minimumOrder: 5,
							enabled: true,
						},
					],
					address: { lat: 40.7128, lng: -74.006, country: 'US' },
				},
			],
			menus: [
				{
					id: 'menu-main',
					displayName: 'Main Menu',
					menuType: 'regular',
					specialInstructions: true,
					availabilityStatus: 'available',
					categories: [
						{
							id: 'cat-1',
							displayName: 'Mains',
							availabilityStatus: 'available',
							items: [
								{
									id: 'item-burger',
									displayName: 'Classic Burger',
									price: 10,
									availabilityStatus: 'available',
								},
								{
									id: 'item-drink',
									displayName: 'Lemonade',
									price: 4,
									availabilityStatus: 'available',
								},
							],
						},
					],
				},
			],
		},
	} as unknown as OrderContextResponse
}

describe('operator order editing (#162) and tax-exempt (#166)', () => {
	const orgId = `org-revise-${crypto.randomUUID().slice(0, 8)}`
	const locId = 'loc-1'
	let tmpDir: string
	let prevDbDir: string | undefined
	let prevHmac: string | undefined

	beforeEach(async () => {
		mockSendEmail.mockClear()
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'menuza-revise-'))
		prevDbDir = process.env.TENANT_DB_DIR
		prevHmac = process.env.AUTH_HMAC_SECRET
		process.env.TENANT_DB_DIR = tmpDir
		process.env.AUTH_HMAC_SECRET = 'test-hmac-secret-0123456789abcdef0123456789'
		await provisionTenantDb(orgId)
	})

	afterEach(async () => {
		await destroyTenantDb(orgId).catch(() => {})
		if (prevDbDir === undefined) delete process.env.TENANT_DB_DIR
		else process.env.TENANT_DB_DIR = prevDbDir
		if (prevHmac === undefined) delete process.env.AUTH_HMAC_SECRET
		else process.env.AUTH_HMAC_SECRET = prevHmac
		fs.rmSync(tmpDir, { recursive: true, force: true })
	})

	async function insertOrder(
		overrides: Partial<typeof restaurantOrders.$inferInsert> = {},
	) {
		const db = await getTenantDb(orgId)
		const id = crypto.randomUUID()
		await db.insert(restaurantOrders).values({
			id,
			orgId,
			number: '2001',
			locale: 'en',
			status: 'accepted',
			paymentMethod: 'online',
			paymentStatus: 'paid',
			fulfillment: 'pickup',
			locationId: locId,
			locationName: 'Downtown',
			contactName: 'Sam Guest',
			contactPhone: '+15550001111',
			contactEmail: 'sam@example.com',
			currency: 'USD',
			subtotalCents: 1000,
			taxCents: 100,
			deliveryFeeCents: 0,
			totalCents: 1100,
			paidCents: 1100,
			lines: [
				{
					itemId: 'item-burger',
					itemName: 'Classic Burger',
					variantId: null,
					quantity: 1,
					unitPriceCents: 1000,
					taxableUnitCents: 1000,
					totalCents: 1000,
					taxableCents: 1000,
					instructions: null,
					options: [],
					baseUnitCents: 1000,
					categoryIds: ['cat-1'],
				},
			],
			idempotencyKey: `idem-${id}`,
			requestHash: 'hash',
			receiptTokenHash: 'rhash',
			...overrides,
		})
		return id
	}

	it('adding a drink updates the total, receipt, KDS ticket, and offers a pay link for the difference', async () => {
		const orderId = await insertOrder()
		const db = await getTenantDb(orgId)
		await db.insert(kdsTickets).values({
			source: 'online',
			orderId,
			locationId: locId,
			version: 1,
			progress: { 'item-burger': 'ready' },
			completedAt: Date.now(),
			updatedAt: Date.now(),
		})

		const res = await reviseOperatorOrder({
			orgId,
			orderId,
			scope: {
				locationIds: [locId],
				userId: 'op-1',
				operatorName: 'Alex Manager',
				refundProvider: true,
			},
			request: {
				expectedRevision: 1,
				reason: 'Guest called to add a drink',
				lines: [
					{ itemId: 'item-burger', quantity: 1, options: [] },
					{ itemId: 'item-drink', quantity: 1, options: [] },
				],
			},
			idempotencyKey: 'rev-key-1',
			contextOverride: testContext(orgId, locId),
		})
		expect(res.ok ? null : res.failure).toBeNull()
		if (!res.ok) return
		expect(res.data.revision).toBe(2)
		expect(res.data.newTotalCents).toBe(1540) // 1400 + 10% tax
		expect(res.data.deltaCents).toBe(440)
		expect(res.data.amountDueCents).toBe(440)
		expect(res.data.suggestedAction).toBe('pay_link')
		expect(res.data.kdsUpdated).toBe(true)
		expect(res.data.receiptSent).toBe(true)
		expect(mockSendEmail).toHaveBeenCalledTimes(1)

		// KDS ticket reopened, unchanged burger kept its progress
		const [ticket] = await db
			.select()
			.from(kdsTickets)
			.where(eq(kdsTickets.orderId, orderId))
		expect(ticket?.completedAt).toBeNull()
		expect(ticket?.progress).toEqual({ 'item-burger': 'ready' })

		// Revision history recorded
		const history = await listOrderRevisions(orgId, orderId)
		expect(history).toHaveLength(1)
		expect(history[0]?.revision).toBe(2)
		expect(history[0]?.reason).toBe('Guest called to add a drink')

		// Idempotent replay returns same revision
		const replay = await reviseOperatorOrder({
			orgId,
			orderId,
			scope: {
				locationIds: [locId],
				userId: 'op-1',
				operatorName: 'Alex Manager',
				refundProvider: true,
			},
			request: {
				expectedRevision: 1,
				lines: [
					{ itemId: 'item-burger', quantity: 1, options: [] },
					{ itemId: 'item-drink', quantity: 1, options: [] },
				],
			},
			idempotencyKey: 'rev-key-1',
			contextOverride: testContext(orgId, locId),
		})
		expect(replay.ok).toBe(true)
		if (replay.ok) expect(replay.data.replayed).toBe(true)
	})

	it('switching delivery to pickup removes the delivery fee and offers its refund', async () => {
		const orderId = await insertOrder({
			fulfillment: 'delivery',
			deliveryAddress: '123 Main St',
			deliveryFeeCents: 500,
			totalCents: 1600,
			paidCents: 1600,
		})

		const res = await reviseOperatorOrder({
			orgId,
			orderId,
			scope: {
				locationIds: [locId],
				userId: 'op-1',
				operatorName: 'Alex Manager',
				refundProvider: true,
			},
			request: {
				expectedRevision: 1,
				reason: 'Guest will pick up instead',
				fulfillment: 'pickup',
			},
			contextOverride: testContext(orgId, locId),
		})
		expect(res.ok ? null : res.failure).toBeNull()
		if (!res.ok) return
		expect(res.data.order.fulfillment).toBe('pickup')
		expect(res.data.order.deliveryFeeCents).toBe(0)
		expect(res.data.newTotalCents).toBe(1100)
		expect(res.data.refundAvailableCents).toBe(500)
		expect(res.data.suggestedAction).toBe('refund')
	})

	it('two operators editing at once: the second gets stale_version; closed/QR/comp rules enforced', async () => {
		const orderId = await insertOrder()
		const first = await reviseOperatorOrder({
			orgId,
			orderId,
			scope: {
				locationIds: null,
				userId: 'op-1',
				operatorName: 'Op 1',
				refundProvider: false,
			},
			request: {
				expectedRevision: 1,
				lines: [{ itemId: 'item-burger', quantity: 2, options: [] }],
			},
			contextOverride: testContext(orgId, locId),
		})
		expect(first.ok).toBe(true)

		// Second operator still has expectedRevision: 1
		const second = await reviseOperatorOrder({
			orgId,
			orderId,
			scope: {
				locationIds: null,
				userId: 'op-2',
				operatorName: 'Op 2',
				refundProvider: true,
			},
			request: {
				expectedRevision: 1,
				lines: [{ itemId: 'item-drink', quantity: 1, options: [] }],
			},
			contextOverride: testContext(orgId, locId),
		})
		expect(second.ok).toBe(false)
		if (!second.ok) {
			expect(second.failure.status).toBe(409)
			expect(second.failure.code).toBe('stale_version')
		}

		// Comp without refund permission is refused (403)
		const compDenied = await reviseOperatorOrder({
			orgId,
			orderId,
			scope: {
				locationIds: null,
				userId: 'op-1',
				operatorName: 'Op 1',
				refundProvider: false,
			},
			request: {
				expectedRevision: 2,
				lines: [
					{
						itemId: 'item-burger',
						quantity: 1,
						options: [],
						comped: true,
						compReason: 'Long wait',
					},
				],
			},
			contextOverride: testContext(orgId, locId),
		})
		expect(compDenied.ok).toBe(false)
		if (!compDenied.ok) {
			expect(compDenied.failure.status).toBe(403)
			expect(compDenied.failure.code).toBe('comp_permission_required')
		}

		// Closed order returns 409 order_closed
		const closedId = await insertOrder({ status: 'completed' })
		const closedRes = await reviseOperatorOrder({
			orgId,
			orderId: closedId,
			scope: {
				locationIds: null,
				userId: 'op-1',
				operatorName: 'Op 1',
				refundProvider: true,
			},
			request: { expectedRevision: 1, reason: 'Too late' },
			contextOverride: testContext(orgId, locId),
		})
		expect(closedRes.ok).toBe(false)
		if (!closedRes.ok) {
			expect(closedRes.failure.status).toBe(409)
			expect(closedRes.failure.code).toBe('order_closed')
		}

		// QR tab round cannot be edited
		const qrId = await insertOrder({ tabId: 'tab-1' })
		const qrRes = await reviseOperatorOrder({
			orgId,
			orderId: qrId,
			scope: {
				locationIds: null,
				userId: 'op-1',
				operatorName: 'Op 1',
				refundProvider: true,
			},
			request: { expectedRevision: 1, reason: 'QR round' },
			contextOverride: testContext(orgId, locId),
		})
		expect(qrRes.ok).toBe(false)
		if (!qrRes.ok) expect(qrRes.failure.code).toBe('order_not_editable')
	})

	it('marks an unpaid order tax-exempt (#166), removes tax, shows certificate on receipt, and blocks SAR', async () => {
		const orderId = await insertOrder({
			paymentMethod: 'handoff',
			paymentStatus: 'unpaid',
			paidCents: 0,
		})

		const res = await reviseOperatorOrder({
			orgId,
			orderId,
			scope: {
				locationIds: [locId],
				userId: 'op-1',
				operatorName: 'Alex Manager',
				refundProvider: true,
			},
			request: {
				expectedRevision: 1,
				reason: 'School tax-exempt certificate',
				taxExempt: { ref: 'EX-99421', org: 'Lincoln Elementary' },
			},
			contextOverride: testContext(orgId, locId),
		})
		expect(res.ok ? null : res.failure).toBeNull()
		if (!res.ok) return
		expect(res.data.order.taxCents).toBe(0)
		expect(res.data.order.totalCents).toBe(1000)
		expect(res.data.order.taxExemptRef).toBe('EX-99421')
		expect(res.data.order.taxExemptOrg).toBe('Lincoln Elementary')

		const receipt = receiptOrder(res.data.order)
		expect(receipt.taxExempt).toEqual({
			ref: 'EX-99421',
			org: 'Lincoln Elementary',
		})
		const opView = operatorOrder(res.data.order)
		expect(opView.revision).toBe(2)

		// SAR location refuses tax-exempt
		const sarId = await insertOrder({ currency: 'SAR' })
		const sarRes = await reviseOperatorOrder({
			orgId,
			orderId: sarId,
			scope: {
				locationIds: [locId],
				userId: 'op-1',
				operatorName: 'Alex Manager',
				refundProvider: true,
			},
			request: {
				expectedRevision: 1,
				taxExempt: { ref: 'EX-1', org: 'Charity' },
			},
			contextOverride: testContext(orgId, locId, 'SAR'),
		})
		expect(sarRes.ok).toBe(false)
		if (!sarRes.ok) {
			expect(sarRes.failure.status).toBe(422)
			expect(sarRes.failure.code).toBe('tax_exempt_unavailable_sar')
		}

		// Switching to delivery with valid signed quote works
		const quoteToken = await signDeliveryQuote({
			orgId,
			locationId: locId,
			formatted: '500 Oak Ave, New York, NY 10001',
			line1: '500 Oak Ave',
			city: 'New York',
			state: 'NY',
			postalCode: '10001',
			country: 'US',
			unit: null,
			lat: 40.72,
			lng: -74.01,
			exp: Date.now() + 60 * 60 * 1000,
		})
		const toDelivery = await reviseOperatorOrder({
			orgId,
			orderId,
			scope: {
				locationIds: [locId],
				userId: 'op-1',
				operatorName: 'Alex Manager',
				refundProvider: true,
			},
			request: {
				expectedRevision: 2,
				fulfillment: 'delivery',
				deliveryQuoteToken: quoteToken,
			},
			contextOverride: testContext(orgId, locId),
		})
		expect(toDelivery.ok ? null : toDelivery.failure).toBeNull()
		if (toDelivery.ok) {
			expect(toDelivery.data.order.fulfillment).toBe('delivery')
			expect(toDelivery.data.order.deliveryFeeCents).toBe(350)
			expect(toDelivery.data.order.taxCents).toBe(0) // still tax-exempt
		}
	})
})
