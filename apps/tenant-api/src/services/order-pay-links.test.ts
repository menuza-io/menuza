import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	cateringPayments,
	destroyTenantDb,
	getTenantDb,
	posDevices,
	posOrders,
	posPayments,
	provisionTenantDb,
	restaurantOrders,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORDER_PAY_LINK_TTL_MS } from '@repo/common/order-pay-links'
import {
	applyOrderPayLinkPaymentEvent,
	bindOrderPayLinkSession,
	createOperatorOrderPayLink,
	createPosOrderPayLink,
	getOrderPayLinkQuote,
	getPublicPayLinkSummary,
	startPublicPayLinkPayment,
} from './order-pay-links.ts'
import {
	resetReservationsContextCache,
	seedReservationsContextForTest,
} from '../lib/reservations-context.ts'
import { publicContext } from '../routes/reservations-public-fixture.ts'

vi.mock('@repo/sms', () => ({
	sendSms: vi.fn(async () => ({ sid: 'SM_mock' })),
}))

vi.mock('../lib/tenant-email.ts', () => ({
	sendTenantEmail: vi.fn(async () => ({ id: 'em_mock' })),
}))

describe('order pay links (#163)', () => {
	const orgId = `org-paylink-${crypto.randomUUID().slice(0, 8)}`
	const locId = 'loc-1'
	let tmpDir: string
	let prevDbDir: string | undefined
	let prevHmac: string | undefined

	beforeEach(async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'menuza-paylink-'))
		prevDbDir = process.env.TENANT_DB_DIR
		prevHmac = process.env.AUTH_HMAC_SECRET
		process.env.TENANT_DB_DIR = tmpDir
		process.env.AUTH_HMAC_SECRET = 'test-hmac-secret-0123456789abcdef0123456789'
		process.env.DATA_REGION = 'us'
		await provisionTenantDb(orgId)
		seedReservationsContextForTest(
			orgId,
			publicContext({
				organization: {
					id: orgId,
					name: 'Demo Bistro',
					slug: 'demo-bistro',
					siteOrigin: 'https://demo.menuza.test',
					defaultLocale: 'en',
				},
			}),
		)
	})

	afterEach(async () => {
		resetReservationsContextCache()
		await destroyTenantDb(orgId).catch(() => {})
		if (prevDbDir === undefined) delete process.env.TENANT_DB_DIR
		else process.env.TENANT_DB_DIR = prevDbDir
		if (prevHmac === undefined) delete process.env.AUTH_HMAC_SECRET
		else process.env.AUTH_HMAC_SECRET = prevHmac
		fs.rmSync(tmpDir, { recursive: true, force: true })
	})

	async function insertPickupOrder(
		overrides: Partial<typeof restaurantOrders.$inferInsert> = {},
	) {
		const db = await getTenantDb(orgId)
		const id = crypto.randomUUID()
		await db.insert(restaurantOrders).values({
			id,
			orgId,
			number: '1042',
			locale: 'en',
			status: 'accepted',
			paymentMethod: 'handoff',
			paymentStatus: 'unpaid',
			fulfillment: 'pickup',
			locationId: locId,
			locationName: 'Downtown',
			contactName: 'Alice Guest',
			contactPhone: '+15551234567',
			contactEmail: 'alice@example.com',
			currency: 'USD',
			subtotalCents: 2000,
			taxCents: 160,
			totalCents: 2160,
			lines: [{ itemName: 'Burger', quantity: 2, totalCents: 2000 }],
			idempotencyKey: `idem-${id}`,
			requestHash: 'hash',
			receiptTokenHash: 'rhash',
			...overrides,
		})
		return id
	}

	it('pays a pay-at-pickup order through the link and refuses a second payment', async () => {
		const orderId = await insertPickupOrder()
		const created = await createOperatorOrderPayLink({
			orgId,
			orderId,
			scope: { locationIds: [locId], userId: 'op-1' },
			channel: 'copy',
		})
		expect(created.ok).toBe(true)
		if (!created.ok) return
		expect(created.data.url).toContain('/menu/pay#p=')
		expect(created.data.url).not.toContain('alice')
		expect(created.data.url).not.toContain('5551234567')
		expect(created.data.amountDueCents).toBe(2160)

		const summary = await getPublicPayLinkSummary({
			orgId,
			token: created.data.token,
		})
		expect(summary.ok).toBe(true)
		if (!summary.ok) return
		expect(summary.data.amountDueCents).toBe(2160)
		expect(summary.data.payable).toBe(true)
		expect(summary.data.lines).toHaveLength(1)

		const started = await startPublicPayLinkPayment({
			orgId,
			token: created.data.token,
		})
		expect(started.ok).toBe(true)
		if (!started.ok) return
		expect(started.data.orderRef).toBe(`bal:${orderId}`)

		const quote = await getOrderPayLinkQuote(
			orgId,
			orderId,
			started.data.paymentToken,
		)
		expect(quote.ok).toBe(true)
		if (!quote.ok) return
		expect(quote.data.totalCents).toBe(2160)
		expect(quote.data.payPage).toBe('order')

		const bound = await bindOrderPayLinkSession({
			orgId,
			orderId,
			sessionId: 'cs_test_1',
			processor: 'connect',
		})
		expect(bound.ok).toBe(true)

		// Amount tampering is rejected
		const tampered = await applyOrderPayLinkPaymentEvent({
			orgId,
			orderId,
			sessionId: 'cs_test_1',
			processor: 'connect',
			status: 'paid',
			amountCents: 100,
			currency: 'USD',
		})
		expect(tampered.ok).toBe(false)
		if (!tampered.ok) expect(tampered.failure.code).toBe('amount_mismatch')

		const settled = await applyOrderPayLinkPaymentEvent({
			orgId,
			orderId,
			sessionId: 'cs_test_1',
			processor: 'connect',
			status: 'paid',
			amountCents: 2160,
			currency: 'USD',
			paymentId: 'pi_1',
		})
		expect(settled.ok).toBe(true)

		const db = await getTenantDb(orgId)
		const [row] = await db
			.select()
			.from(restaurantOrders)
			.where(eq(restaurantOrders.id, orderId))
		expect(row?.paymentStatus).toBe('paid')
		expect(row?.paidCents).toBe(2160)

		// Second payment is refused with 409 order_fully_paid
		const again = await startPublicPayLinkPayment({
			orgId,
			token: created.data.token,
		})
		expect(again.ok).toBe(false)
		if (!again.ok) {
			expect(again.failure.status).toBe(409)
			expect(again.failure.code).toBe('order_fully_paid')
		}

		// Creating another pay link also refuses with 409 order_fully_paid
		const linkAgain = await createOperatorOrderPayLink({
			orgId,
			orderId,
			scope: { locationIds: [locId], userId: 'op-1' },
			channel: 'copy',
		})
		expect(linkAgain.ok).toBe(false)
		if (!linkAgain.ok) {
			expect(linkAgain.failure.status).toBe(409)
			expect(linkAgain.failure.code).toBe('order_fully_paid')
		}
	})

	it('refuses tampered tokens, expired links (>7d), cancelled orders, and zero-due orders', async () => {
		const orderId = await insertPickupOrder()
		const now = Date.now()
		const created = await createOperatorOrderPayLink({
			orgId,
			orderId,
			scope: { locationIds: null, userId: 'op-1' },
			channel: 'copy',
			now,
		})
		expect(created.ok).toBe(true)
		if (!created.ok) return

		// Tampered token
		const badToken =
			created.data.token.slice(0, -1) +
			(created.data.token.endsWith('a') ? 'b' : 'a')
		const badRes = await getPublicPayLinkSummary({
			orgId,
			token: badToken,
			now,
		})
		expect(badRes.ok).toBe(false)
		if (!badRes.ok) expect(badRes.failure.code).toBe('invalid_pay_link')

		// Expired after 7 days
		const expiredRes = await getPublicPayLinkSummary({
			orgId,
			token: created.data.token,
			now: now + ORDER_PAY_LINK_TTL_MS + 10_000,
		})
		expect(expiredRes.ok).toBe(false)
		if (!expiredRes.ok) {
			expect(expiredRes.failure.status).toBe(410)
			expect(expiredRes.failure.code).toBe('pay_link_expired')
		}

		// Cancelled order cannot be paid
		const cancelledId = await insertPickupOrder({ status: 'cancelled' })
		const cancelLink = await createOperatorOrderPayLink({
			orgId,
			orderId: cancelledId,
			scope: { locationIds: null, userId: 'op-1' },
			channel: 'copy',
		})
		expect(cancelLink.ok).toBe(false)
		if (!cancelLink.ok) {
			expect(cancelLink.failure.status).toBe(409)
			expect(cancelLink.failure.code).toBe('order_cancelled')
		}

		// Zero-due unpaid order returns 409 nothing_due
		const zeroId = await insertPickupOrder({
			subtotalCents: 0,
			taxCents: 0,
			totalCents: 0,
		})
		const zeroLink = await createOperatorOrderPayLink({
			orgId,
			orderId: zeroId,
			scope: { locationIds: null, userId: 'op-1' },
			channel: 'copy',
		})
		expect(zeroLink.ok).toBe(false)
		if (!zeroLink.ok) {
			expect(zeroLink.failure.status).toBe(409)
			expect(zeroLink.failure.code).toBe('nothing_due')
		}
	})

	it('allows multiple separate payments on one order (e.g. after edit increases total)', async () => {
		const orderId = await insertPickupOrder({ paidCents: 1000 })
		const created = await createOperatorOrderPayLink({
			orgId,
			orderId,
			scope: { locationIds: null, userId: 'op-1' },
			channel: 'copy',
		})
		expect(created.ok).toBe(true)
		if (!created.ok) return
		expect(created.data.amountDueCents).toBe(1160)

		const started = await startPublicPayLinkPayment({
			orgId,
			token: created.data.token,
		})
		expect(started.ok).toBe(true)
		await bindOrderPayLinkSession({
			orgId,
			orderId,
			sessionId: 'cs_multi_1',
			processor: 'connect',
		})
		await applyOrderPayLinkPaymentEvent({
			orgId,
			orderId,
			sessionId: 'cs_multi_1',
			processor: 'connect',
			status: 'paid',
			amountCents: 1160,
			currency: 'USD',
			paymentId: 'pi_m1',
		})

		// Simulate order total increasing after an edit
		const db = await getTenantDb(orgId)
		await db
			.update(restaurantOrders)
			.set({ totalCents: 2660 })
			.where(eq(restaurantOrders.id, orderId))

		const started2 = await startPublicPayLinkPayment({
			orgId,
			token: created.data.token,
		})
		expect(started2.ok).toBe(true)
		if (!started2.ok) return
		expect(started2.data.amountDueCents).toBe(500)
		await bindOrderPayLinkSession({
			orgId,
			orderId,
			sessionId: 'cs_multi_2',
			processor: 'connect',
		})
		await applyOrderPayLinkPaymentEvent({
			orgId,
			orderId,
			sessionId: 'cs_multi_2',
			processor: 'connect',
			status: 'paid',
			amountCents: 500,
			currency: 'USD',
			paymentId: 'pi_m2',
		})

		const rows = await db
			.select()
			.from(cateringPayments)
			.where(eq(cateringPayments.orderId, orderId))
		expect(rows).toHaveLength(2)
		expect(
			rows.every((r) => r.kind === 'pay_link' && r.status === 'paid'),
		).toBe(true)
	})

	it('pays a Station phone order (pos_orders) through the link and records it in pos_payments', async () => {
		const db = await getTenantDb(orgId)
		const deviceId = 'dev-station-1'
		await db.insert(posDevices).values({
			id: deviceId,
			label: 'Front Till',
			terminalCode: 'T1',
			locationId: locId,
			secretHash: 'hash',
			pairedBy: 'op-1',
			pairedAt: Date.now(),
		})
		const posOrderId = crypto.randomUUID()
		await db.insert(posOrders).values({
			id: posOrderId,
			deviceId,
			number: 'P-101',
			businessDate: '2026-11-25',
			revision: 1,
			status: 'open',
			orderType: 'takeaway',
			orderSource: 'phone',
			customerPhone: '+15559990000',
			guestName: 'Bob Caller',
			locationId: locId,
			locationName: 'Downtown',
			currency: 'USD',
			subtotalCents: 1500,
			taxCents: 120,
			totalCents: 1620,
			lines: [{ name: 'Pasta', quantity: 1, baseCents: 1500, options: [] }],
			adjustments: [],
			rungUpAt: Date.now(),
		})

		const created = await createPosOrderPayLink({
			orgId,
			orderId: posOrderId,
			locationId: locId,
			channel: 'sms',
		})
		expect(created.ok).toBe(true)
		if (!created.ok) return
		expect(created.data.sent).toBe(true)

		const started = await startPublicPayLinkPayment({
			orgId,
			token: created.data.token,
		})
		expect(started.ok).toBe(true)
		if (!started.ok) return

		const settled = await applyOrderPayLinkPaymentEvent({
			orgId,
			orderId: posOrderId,
			sessionId: 'cs_pos_1',
			processor: 'connect',
			status: 'paid',
			amountCents: 1620,
			currency: 'USD',
			paymentId: 'pi_pos_1',
		})
		expect(settled.ok).toBe(true)

		const [updatedPos] = await db
			.select()
			.from(posOrders)
			.where(eq(posOrders.id, posOrderId))
		expect(updatedPos?.status).toBe('paid')
		const pays = await db
			.select()
			.from(posPayments)
			.where(eq(posPayments.orderId, posOrderId))
		expect(pays).toHaveLength(1)
		expect(pays[0]?.amountCents).toBe(1620)
	})
})
