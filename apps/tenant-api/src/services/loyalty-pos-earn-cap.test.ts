import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	LOYALTY_ADJUSTMENT_CREDIT_WINDOW_MS,
	LOYALTY_POS_DAILY_EARN_REVIEW_POINTS,
} from '@repo/loyalty'
import { destroyTenantDb, provisionTenantDb } from '@repo/tenant-db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { adjustMemberPoints } from './loyalty-member-service.ts'
import {
	reconcileLoyaltySource,
	resolvePurchase,
} from './loyalty-purchase-service.ts'
import {
	activateProgram,
	balanceOf,
	claimAndQueue,
	expectLoyaltyError,
	insertCustomer,
	insertPosSale,
	makeMember,
	NOW,
} from './loyalty-test-fixture.ts'

const ORG = 'org_ll_pos_cap'

let directory: string

beforeEach(async () => {
	directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loyalty-pos-cap-'))
	vi.stubEnv('TENANT_DB_DIR', directory)
	vi.stubEnv('DATA_REGION', 'us')
	vi.stubEnv('AUTH_HMAC_SECRET', 'test-hmac-secret-123456789')
	await provisionTenantDb(ORG)
	await activateProgram(ORG) // 1 point per 100 minor of spend
})

afterEach(async () => {
	await destroyTenantDb(ORG).catch(() => {})
	fs.rmSync(directory, { recursive: true, force: true })
	vi.unstubAllEnvs()
})

async function member() {
	const customerId = `cus_${Math.random().toString(36).slice(2, 10)}`
	await insertCustomer(ORG, { id: customerId })
	return makeMember(ORG, { customerId })
}

/** A paid till sale whose only line totals `cents`. */
async function posSale(cents: number) {
	return insertPosSale(ORG, {
		subtotalCents: cents,
		totalCents: cents,
		lines: [
			{
				id: '0',
				itemId: 'item_1',
				name: 'Test item',
				variantId: null,
				variantLabel: null,
				quantity: 1,
				baseCents: cents,
				instructions: '',
				options: [],
			},
		],
	})
}

describe('register earn guardrails', () => {
	it('sends a very large till earning to review; an operator can award it', async () => {
		const memberId = await member()
		// $1,500.00 of merchandise -> 1,500 points, over the 1,000 daily cap.
		const saleId = await posSale(150_000)
		const source = { type: 'pos_order' as const, id: saleId }
		const purchase = await claimAndQueue(ORG, { memberId, source })
		const result = await reconcileLoyaltySource(ORG, source, {
			now: NOW + 1000,
		})
		expect(result.purchase?.state).toBe('review')
		expect(result.purchase?.reviewReason).toBe('large_earn')
		expect((await balanceOf(ORG, memberId)).points).toBe(0)

		const awarded = await resolvePurchase(ORG, {
			purchaseId: purchase.id,
			action: 'award',
			note: 'verified at the register',
			actorId: 'op_test',
			locationIds: null,
			now: NOW + 2000,
		})
		expect(awarded.state).toBe('completed')
		expect((await balanceOf(ORG, memberId)).points).toBe(1500)
	})

	it('counts the day’s till earnings cumulatively per member', async () => {
		const memberId = await member()
		// Two $60.00 sales -> 600 points each; the second crosses the cap.
		const firstId = await posSale(60_000)
		const secondId = await posSale(60_000)
		const first = { type: 'pos_order' as const, id: firstId }
		const second = { type: 'pos_order' as const, id: secondId }
		await claimAndQueue(ORG, { memberId, source: first })
		const firstResult = await reconcileLoyaltySource(ORG, first, {
			now: NOW + 1000,
		})
		expect(firstResult.purchase?.state).toBe('completed')
		expect(firstResult.purchase?.awardedPoints).toBe(600)
		expect(600 + 600).toBeGreaterThan(LOYALTY_POS_DAILY_EARN_REVIEW_POINTS)

		await claimAndQueue(ORG, { memberId, source: second })
		const secondResult = await reconcileLoyaltySource(ORG, second, {
			now: NOW + 2000,
		})
		expect(secondResult.purchase?.state).toBe('review')
		expect(secondResult.purchase?.reviewReason).toBe('large_earn')
		expect((await balanceOf(ORG, memberId)).points).toBe(600)
	})

	it('caps one operator adjustment and still allows the boundary', async () => {
		const memberId = await member()
		await expectLoyaltyError(
			adjustMemberPoints(ORG, {
				memberId,
				delta: 1_000_001,
				reason: 'goodwill',
				note: 'over the per-call cap',
				actorId: 'op_test',
				idempotencyKey: 'cap-over',
			}),
			'adjustment_invalid',
		)
		const ok = await adjustMemberPoints(ORG, {
			memberId,
			delta: 1_000_000,
			reason: 'goodwill',
			note: 'at the per-call cap',
			actorId: 'op_test',
			idempotencyKey: 'cap-at',
		})
		expect(ok.balance.points).toBe(1_000_000)
	})

	it('limits what one operator adds in 24 hours, never what they remove', async () => {
		const memberId = await member()
		const adjust = (
			actorId: string,
			delta: number,
			idempotencyKey: string,
			now: number,
		) =>
			adjustMemberPoints(ORG, {
				memberId,
				delta,
				reason: 'goodwill',
				note: 'daily limit test',
				actorId,
				idempotencyKey,
				now,
			})

		await adjust('op_a', 600_000, 'day-a1', NOW)
		const over = await expectLoyaltyError(
			adjust('op_a', 500_000, 'day-a2', NOW + 1),
			'adjustment_limit',
		)
		expect(over.status).toBe(429)
		expect(over.details).toEqual({ remainingPoints: 400_000 })
		await adjust('op_a', 400_000, 'day-a3', NOW + 2)
		await expectLoyaltyError(
			adjust('op_a', 1, 'day-a4', NOW + 3),
			'adjustment_limit',
		)
		// A retry of an adjustment already posted is not a new addition.
		const retry = await adjust('op_a', 400_000, 'day-a3', NOW + 4)
		expect(retry.balance.points).toBe(1_000_000)
		// Removing points, and another operator adding them, still work.
		await adjust('op_a', -5, 'day-a5', NOW + 5)
		const other = await adjust('op_b', 10, 'day-b1', NOW + 6)
		expect(other.balance.points).toBe(1_000_005)

		// Once the first addition is a day old, its points count no longer.
		const later = await adjust(
			'op_a',
			600_000,
			'day-a6',
			NOW + LOYALTY_ADJUSTMENT_CREDIT_WINDOW_MS,
		)
		expect(later.balance.points).toBe(1_600_005)
	})
})
