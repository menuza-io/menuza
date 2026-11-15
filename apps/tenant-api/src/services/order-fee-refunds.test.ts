import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	restaurantOrderRefunds,
	restaurantOrders,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { recordOrderRefund } from './order-refund-service.ts'
import { refundOrderThroughProvider } from './order-refund-test-fixture.ts'
import { operatorOrder } from './order-service.ts'

/**
 * The service fee on refunds (#123): a full refund gives it back with the
 * rest; a partial refund gives it back only when the operator ticked "include
 * service fee", never twice, and on top of the amount typed.
 */

const orgId = 'org_fee_refunds_1'
const ACCESS = { refundLoyalty: true, impersonated: false }

/** A paid order of 20.00 with a 0.60 fee: tax 8.25 % on the items. */
async function placePaidOrder(
	id: string,
	patch: Partial<typeof restaurantOrders.$inferInsert> = {},
) {
	const db = await getTenantDb(orgId)
	const subtotal = 2000
	const tax = 165
	const fee = 60
	const [row] = await db
		.insert(restaurantOrders)
		.values({
			id,
			orgId,
			number: `N-${id}`,
			paymentMethod: 'online',
			paymentStatus: 'paid',
			fulfillment: 'pickup',
			locationId: 'loc',
			locationName: 'Main',
			contactName: 'Ada',
			contactPhone: '+15550100',
			currency: 'USD',
			subtotalCents: subtotal,
			taxCents: tax,
			serviceFeeCents: fee,
			serviceFeeTaxCents: 0,
			serviceFeeLabel: 'Service fee',
			totalCents: subtotal + tax + fee,
			lines: [],
			idempotencyKey: `key-${id}`,
			requestHash: 'hash',
			receiptTokenHash: 'rcpt',
			...patch,
		})
		.returning()
	return row!
}

async function refundRows(orderId: string) {
	const db = await getTenantDb(orgId)
	return db
		.select()
		.from(restaurantOrderRefunds)
		.where(eq(restaurantOrderRefunds.orderId, orderId))
}

const request = (body: Record<string, unknown>, note = 'Cold food') =>
	({ ...body, note }) as never

describe('service fee refunds', () => {
	let directory: string

	beforeEach(async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fee-refunds-'))
		vi.stubEnv('TENANT_DB_DIR', directory)
		vi.stubEnv('DATA_REGION', 'us')
		vi.stubEnv('APP_URL', 'https://app.test')
		await provisionTenantDb(orgId)
	})

	afterEach(async () => {
		try {
			await destroyTenantDb(orgId)
			fs.rmSync(directory, { recursive: true, force: true })
		} catch {}
		vi.unstubAllEnvs()
	})

	it('a full refund gives back everything, the fee included', async () => {
		const order = await placePaidOrder('a')
		const result = await refundOrderThroughProvider(orgId, order.id, {
			request: request({ full: true }),
			actorId: 'user_1',
			idempotencyKey: 'k1',
			loyaltyAccess: ACCESS,
		})
		expect(result.ok).toBe(true)
		const [row] = await refundRows(order.id)
		expect(row).toMatchObject({ amountCents: 2225, serviceFeeCents: 60, full: true })
	})

	it('a partial refund leaves the fee alone unless ticked', async () => {
		const order = await placePaidOrder('b')
		await refundOrderThroughProvider(orgId, order.id, {
			request: request({ amountCents: 500 }),
			actorId: 'user_1',
			idempotencyKey: 'k1',
			loyaltyAccess: ACCESS,
		})
		const [row] = await refundRows(order.id)
		expect(row).toMatchObject({ amountCents: 500, serviceFeeCents: 0, full: false })
	})

	it('a partial refund with the box ticked adds the fee on top of the amount', async () => {
		const order = await placePaidOrder('c')
		await refundOrderThroughProvider(orgId, order.id, {
			request: request({ amountCents: 500, includeServiceFee: true }),
			actorId: 'user_1',
			idempotencyKey: 'k1',
			loyaltyAccess: ACCESS,
		})
		const [row] = await refundRows(order.id)
		expect(row).toMatchObject({ amountCents: 560, serviceFeeCents: 60 })
	})

	it('never gives the fee back twice', async () => {
		const order = await placePaidOrder('d')
		for (const [key, amount] of [
			['k1', 500],
			['k2', 300],
		] as const) {
			const result = await refundOrderThroughProvider(orgId, order.id, {
				request: request({ amountCents: amount, includeServiceFee: true }),
				actorId: 'user_1',
				idempotencyKey: key,
				loyaltyAccess: ACCESS,
			})
			expect(result.ok).toBe(true)
		}
		const rows = await refundRows(order.id)
		expect(rows.map((row) => [row.amountCents, row.serviceFeeCents])).toEqual([
			[560, 60],
			[300, 0],
		])
	})

	it('a full refund after a partial one with the fee gives back only what is left', async () => {
		const order = await placePaidOrder('e')
		await refundOrderThroughProvider(orgId, order.id, {
			request: request({ amountCents: 500, includeServiceFee: true }),
			actorId: 'user_1',
			idempotencyKey: 'k1',
			loyaltyAccess: ACCESS,
		})
		await refundOrderThroughProvider(orgId, order.id, {
			request: request({ full: true }),
			actorId: 'user_1',
			idempotencyKey: 'k2',
			loyaltyAccess: ACCESS,
		})
		const rows = await refundRows(order.id)
		expect(rows.map((row) => [row.amountCents, row.serviceFeeCents])).toEqual([
			[560, 60],
			[1665, 0],
		])
		expect(rows.reduce((sum, row) => sum + row.amountCents, 0)).toBe(2225)
	})

	it('refuses an amount plus the fee that is more than is left', async () => {
		const order = await placePaidOrder('f')
		const result = await refundOrderThroughProvider(orgId, order.id, {
			request: request({ amountCents: 2200, includeServiceFee: true }),
			actorId: 'user_1',
			idempotencyKey: 'k1',
			loyaltyAccess: ACCESS,
		})
		expect(result).toMatchObject({
			ok: false,
			failure: { code: 'refund_exceeds_payment' },
		})
		expect(await refundRows(order.id)).toHaveLength(0)
	})

	it('gives back the tax on a taxable fee with it', async () => {
		// Fee 0.60 plus 0.05 tax, added on top: the guest paid 0.65 for it.
		const order = await placePaidOrder('g', {
			serviceFeeTaxCents: 5,
			taxCents: 165 + 5,
			totalCents: 2000 + 170 + 60,
		})
		await refundOrderThroughProvider(orgId, order.id, {
			request: request({ amountCents: 100, includeServiceFee: true }),
			actorId: 'user_1',
			idempotencyKey: 'k1',
			loyaltyAccess: ACCESS,
		})
		const [row] = await refundRows(order.id)
		expect(row).toMatchObject({ amountCents: 165, serviceFeeCents: 65 })
	})

	it('with prices that include tax the fee is refunded as it was charged', async () => {
		// The fee's tax is inside the 0.60: the total adds only the fee.
		const order = await placePaidOrder('h', {
			serviceFeeTaxCents: 5,
			taxCents: 165 + 5,
			totalCents: 2000 + 60,
		})
		await refundOrderThroughProvider(orgId, order.id, {
			request: request({ amountCents: 100, includeServiceFee: true }),
			actorId: 'user_1',
			idempotencyKey: 'k1',
			loyaltyAccess: ACCESS,
		})
		const [row] = await refundRows(order.id)
		expect(row).toMatchObject({ amountCents: 160, serviceFeeCents: 60 })
	})

	it('ticking the box on an order with no fee adds nothing', async () => {
		const order = await placePaidOrder('i', {
			serviceFeeCents: 0,
			serviceFeeLabel: null,
			totalCents: 2165,
		})
		await refundOrderThroughProvider(orgId, order.id, {
			request: request({ amountCents: 500, includeServiceFee: true }),
			actorId: 'user_1',
			idempotencyKey: 'k1',
			loyaltyAccess: ACCESS,
		})
		const [row] = await refundRows(order.id)
		expect(row).toMatchObject({ amountCents: 500, serviceFeeCents: 0 })
	})

	it('a replay of the same request records one refund, a different box is a conflict', async () => {
		const order = await placePaidOrder('j')
		const first = await refundOrderThroughProvider(orgId, order.id, {
			request: request({ amountCents: 500, includeServiceFee: true }),
			actorId: 'user_1',
			idempotencyKey: 'same',
			loyaltyAccess: ACCESS,
		})
		const again = await refundOrderThroughProvider(orgId, order.id, {
			request: request({ amountCents: 500, includeServiceFee: true }),
			actorId: 'user_1',
			idempotencyKey: 'same',
			loyaltyAccess: ACCESS,
		})
		expect(first.ok && again.ok && again.data.replayed).toBe(true)
		expect(await refundRows(order.id)).toHaveLength(1)
		const other = await refundOrderThroughProvider(orgId, order.id, {
			request: request({ amountCents: 500 }),
			actorId: 'user_1',
			idempotencyKey: 'same',
			loyaltyAccess: ACCESS,
		})
		expect(other).toMatchObject({
			ok: false,
			failure: { code: 'idempotency_conflict' },
		})
	})

	it('records a refund of a pay-at-handoff order the same way', async () => {
		const order = await placePaidOrder('k', {
			paymentMethod: 'handoff',
			paymentStatus: 'paid',
		})
		const result = await recordOrderRefund(orgId, order.id, {
			request: request({ amountCents: 500, includeServiceFee: true }),
			actorId: 'user_1',
			idempotencyKey: 'k1',
			loyaltyAccess: ACCESS,
		})
		expect(result.ok).toBe(true)
		const [row] = await refundRows(order.id)
		expect(row).toMatchObject({ amountCents: 560, serviceFeeCents: 60, kind: 'record' })
		const full = await recordOrderRefund(orgId, order.id, {
			request: request({ full: true }),
			actorId: 'user_1',
			idempotencyKey: 'k2',
			loyaltyAccess: ACCESS,
		})
		expect(full.ok && full.data.refund.amountCents).toBe(1665)
	})

	it('tells the operator what the order charged for the fee', async () => {
		const order = await placePaidOrder('l', {
			serviceFeeTaxCents: 5,
			taxCents: 165 + 5,
			totalCents: 2000 + 170 + 60,
		})
		const view = operatorOrder(order)
		expect(view.serviceFeeChargeCents).toBe(65)
		expect(view.serviceFeeCents).toBe(60)
		expect(view.serviceFeeLabel).toBe('Service fee')
	})
})
