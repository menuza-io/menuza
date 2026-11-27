import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'

import {
	getTenantDb,
	provisionTenantDb,
	restaurantOrders,
} from '@repo/tenant-db'

import {
	activateProgram,
	assertBalancesMatchLedger,
	balanceOf,
	claimAndQueue,
	insertCustomer,
	insertOrder,
	makeMember,
	NOW,
} from './loyalty-test-fixture.ts'
import { processLoyaltyOutbox } from './loyalty-purchase-service.ts'
import { applyDisputeStatus } from './order-provider-refund-service.ts'

describe('lost dispute marks order disputed_lost and reverses loyalty points (#187)', () => {
	it('marks order disputed_lost, stores disputeFeeCents, and reverses loyalty points like a refund; won changes nothing', async () => {
		const orgId = `org-dispute-${randomUUID().slice(0, 8)}`
		await provisionTenantDb(orgId)
		const db = await getTenantDb(orgId)

		// Activate loyalty program and enroll a member
		await activateProgram(orgId)
		const customerId = randomUUID()
		await insertCustomer(orgId, { id: customerId, phone: '+15551234567' })
		const memberId = await makeMember(orgId, { customerId })

		// Insert a paid online order and settle its loyalty earn
		const lostOrderId = await insertOrder(orgId, {
			customerId,
			status: 'completed',
			paymentMethod: 'online',
			paymentStatus: 'paid',
			subtotalCents: 4000,
			totalCents: 4000,
		})
		await db
			.update(restaurantOrders)
			.set({
				paymentProcessor: 'connect',
				paymentSessionId: `cs_${lostOrderId}`,
				paymentId: `pi_${lostOrderId}`,
			})
			.where(eq(restaurantOrders.id, lostOrderId))

		await claimAndQueue(orgId, {
			memberId,
			source: { type: 'restaurant_order', id: lostOrderId },
			at: NOW,
		})
		await processLoyaltyOutbox(orgId, { now: NOW + 1000 })

		const earned = (await balanceOf(orgId, memberId)).points
		expect(earned).toBeGreaterThan(0)

		// Open dispute first
		const openRes = await applyDisputeStatus({
			orgId,
			orderId: lostOrderId,
			processor: 'connect',
			status: 'open',
			now: NOW + 2000,
		})
		expect(openRes.ok).toBe(true)

		// Lost dispute -> marks disputed_lost, stores feeCents, reverses loyalty points
		const lostRes = await applyDisputeStatus({
			orgId,
			orderId: lostOrderId,
			processor: 'connect',
			status: 'lost',
			feeCents: 1500,
			now: NOW + 3000,
		})
		expect(lostRes.ok).toBe(true)

		const [updatedOrder] = await db
			.select()
			.from(restaurantOrders)
			.where(eq(restaurantOrders.id, lostOrderId))
			.limit(1)
		expect(updatedOrder?.status).toBe('disputed_lost')
		expect(updatedOrder?.disputeStatus).toBe('lost')
		expect(updatedOrder?.disputedLostAt).not.toBeNull()
		expect(updatedOrder?.disputeFeeCents).toBe(1500)

		const afterLost = (await balanceOf(orgId, memberId)).points
		expect(afterLost).toBe(0)
		await assertBalancesMatchLedger(orgId)

		// Replay of lost dispute is idempotent (points stay 0)
		await applyDisputeStatus({
			orgId,
			orderId: lostOrderId,
			processor: 'connect',
			status: 'lost',
			feeCents: 1500,
			now: NOW + 4000,
		})
		expect((await balanceOf(orgId, memberId)).points).toBe(0)

		// Won dispute on another order leaves status and loyalty untouched
		const wonOrderId = await insertOrder(orgId, {
			customerId,
			status: 'completed',
			paymentMethod: 'online',
			paymentStatus: 'paid',
			subtotalCents: 2500,
			totalCents: 2500,
		})
		await db
			.update(restaurantOrders)
			.set({
				paymentProcessor: 'connect',
				paymentSessionId: `cs_${wonOrderId}`,
				paymentId: `pi_${wonOrderId}`,
			})
			.where(eq(restaurantOrders.id, wonOrderId))

		await claimAndQueue(orgId, {
			memberId,
			source: { type: 'restaurant_order', id: wonOrderId },
			at: NOW + 5000,
		})
		await processLoyaltyOutbox(orgId, { now: NOW + 6000 })
		const pointsBeforeWon = (await balanceOf(orgId, memberId)).points
		expect(pointsBeforeWon).toBeGreaterThan(0)

		await applyDisputeStatus({
			orgId,
			orderId: wonOrderId,
			processor: 'connect',
			status: 'won',
			now: NOW + 7000,
		})
		const [wonOrder] = await db
			.select()
			.from(restaurantOrders)
			.where(eq(restaurantOrders.id, wonOrderId))
			.limit(1)
		expect(wonOrder?.status).toBe('completed')
		expect(wonOrder?.disputeStatus).toBe('won')
		expect(wonOrder?.disputedLostAt).toBeNull()
		expect((await balanceOf(orgId, memberId)).points).toBe(pointsBeforeWon)
	})
})
