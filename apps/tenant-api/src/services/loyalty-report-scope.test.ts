import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hashLoyaltyCart } from '@repo/loyalty'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
} from '@repo/tenant-db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withLoyaltyWrite } from '../lib/loyalty-write.ts'
import { reconcileLoyaltySource } from './loyalty-purchase-service.ts'
import {
	bindRedemptionInTx,
	consumeRedemptionInTx,
	restoreRedemptionInTx,
	type RedemptionRow,
} from './loyalty-redemption-service.ts'
import { getLoyaltyReport } from './loyalty-report-service.ts'
import {
	activateProgram,
	claimAndQueue,
	DAY as DAY_MS,
	givePoints,
	insertCustomer,
	insertOrder,
	LOC_1,
	LOC_2,
	loyaltyCart,
	makeMember,
	makeReward,
	NOW,
	reserveReward,
} from './loyalty-test-fixture.ts'

const ORG = 'org_ll_report_scope'
const DAY = { from: '2026-01-10', to: '2026-01-10' }

let directory: string

beforeEach(async () => {
	directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loyalty-report-scope-'))
	vi.stubEnv('TENANT_DB_DIR', directory)
	vi.stubEnv('DATA_REGION', 'us')
	vi.stubEnv('AUTH_HMAC_SECRET', 'test-hmac-secret-123456789')
	await provisionTenantDb(ORG)
	await activateProgram(ORG)
})

afterEach(async () => {
	await destroyTenantDb(ORG).catch(() => {})
	fs.rmSync(directory, { recursive: true, force: true })
	vi.unstubAllEnvs()
})

/** One member with a completed $10.00 purchase at the given location. */
async function memberWithPurchase(customerId: string, locationId: string) {
	await insertCustomer(ORG, { id: customerId })
	const memberId = await makeMember(ORG, { customerId })
	await givePoints(ORG, memberId, 50)
	const orderId = await insertOrder(ORG, { locationId })
	const source = { type: 'restaurant_order' as const, id: orderId }
	await claimAndQueue(ORG, { memberId, source, locationId })
	const result = await reconcileLoyaltySource(ORG, source, { now: NOW + 1000 })
	expect(result.purchase?.state).toBe('completed')
	return memberId
}

/** Another completed $10.00 purchase for an existing member. */
async function anotherPurchase(memberId: string) {
	const orderId = await insertOrder(ORG, { locationId: LOC_1 })
	const source = { type: 'restaurant_order' as const, id: orderId }
	await claimAndQueue(ORG, { memberId, source, locationId: LOC_1 })
	const result = await reconcileLoyaltySource(ORG, source, { now: NOW + 1000 })
	expect(result.purchase?.state).toBe('completed')
}

/** A reward the member reserved, bound to an order and used on it. */
async function usedReward(
	memberId: string,
	rewardId: string,
): Promise<RedemptionRow> {
	const cart = loyaltyCart()
	const reserved = await reserveReward(ORG, { memberId, rewardId, cart })
	const orderId = await insertOrder(ORG, { loyaltyDiscountCents: 500 })
	const cartHash = await hashLoyaltyCart(cart)
	const bound = await withLoyaltyWrite(
		{ orgId: ORG, now: NOW + 1000 },
		async (tx, ctx) =>
			bindRedemptionInTx(tx, reserved, {
				source: { type: 'restaurant_order', id: orderId },
				cartHash,
				at: ctx.now,
			}),
	)
	const consumed = await withLoyaltyWrite(
		{ orgId: ORG, now: NOW + 2000 },
		async (tx, ctx) =>
			consumeRedemptionInTx(tx, bound, { at: ctx.now, actorKind: 'system' }),
	)
	expect(consumed.state).toBe('consumed')
	return consumed
}

async function restore(redemption: RedemptionRow, at: number) {
	return withLoyaltyWrite({ orgId: ORG, now: at }, async (tx, ctx) =>
		restoreRedemptionInTx(tx, redemption, { at: ctx.now, actorKind: 'system' }),
	)
}

describe('loyalty report location scope', () => {
	it('counts only the token’s locations; org-wide stays complete', async () => {
		await memberWithPurchase('cus_scope_a', LOC_1)
		await memberWithPurchase('cus_scope_b', LOC_2)
		const db = await getTenantDb(ORG)

		const wide = await getLoyaltyReport(db, DAY, { now: NOW + 2000 })
		expect(wide.customers.accountsTotal).toBe(2)
		// Both accounts were opened on the reported day.
		expect(wide.customers.accountsOpened).toBe(2)
		expect(wide.customers.activeInWindow).toBe(2)
		expect(wide.purchases.count).toBe(2)
		expect(wide.purchases.customerRevenueMinor).toBe(2000)
		expect(wide.points.earned).toBe(20)
		expect(wide.points.outstandingNow).toBe(120)

		const scoped = await getLoyaltyReport(db, DAY, {
			locationIds: [LOC_1],
			now: NOW + 2000,
		})
		expect(scoped.customers.accountsTotal).toBe(1)
		expect(scoped.customers.activeInWindow).toBe(1)
		expect(scoped.purchases.count).toBe(1)
		expect(scoped.purchases.customerRevenueMinor).toBe(1000)
		expect(scoped.points.earned).toBe(10)
		expect(scoped.points.outstandingNow).toBe(60)
	})

	it('an empty scope sees only organization-wide rows', async () => {
		await memberWithPurchase('cus_scope_c', LOC_1)
		const db = await getTenantDb(ORG)
		const scoped = await getLoyaltyReport(db, DAY, {
			locationIds: [],
			now: NOW + 2000,
		})
		expect(scoped.purchases.count).toBe(0)
		expect(scoped.points.earned).toBe(0)
		expect(scoped.customers.accountsTotal).toBe(0)
	})
})

describe('loyalty report member figures', () => {
	it('counts active members, repeat buyers and members who used a reward', async () => {
		// Three purchases for one member, one each for two more; one member
		// uses two rewards and another uses one.
		const repeat = await memberWithPurchase('cus_figures_a', LOC_1)
		await anotherPurchase(repeat)
		await anotherPurchase(repeat)
		const twoRewards = await memberWithPurchase('cus_figures_b', LOC_1)
		const oneReward = await memberWithPurchase('cus_figures_c', LOC_1)
		const reward = await makeReward(ORG)
		await usedReward(twoRewards, reward.id)
		await usedReward(twoRewards, reward.id)
		await usedReward(oneReward, reward.id)
		const db = await getTenantDb(ORG)

		const report = await getLoyaltyReport(db, DAY, { now: NOW + 3000 })
		expect(report.customers.activeInWindow).toBe(3)
		expect(report.purchases).toEqual({
			count: 5,
			customerRevenueMinor: 5000,
			averageOrderValueMinor: 1000,
			repeatPurchaseRateBp: 3333,
			frequencyHundredths: 167,
		})
		expect(report.redemptions).toMatchObject({
			consumed: 3,
			discountCostMinor: 1500,
			conversionBp: 6666,
		})
	})

	it('a reward used and restored in the same window costs nothing, never less', async () => {
		const memberId = await memberWithPurchase('cus_restore_a', LOC_1)
		const reward = await makeReward(ORG)
		const used = await usedReward(memberId, reward.id)
		await restore(used, NOW + 3000)
		const db = await getTenantDb(ORG)
		const report = await getLoyaltyReport(db, DAY, { now: NOW + 4000 })
		expect(report.points).toMatchObject({ redeemed: 10, restored: 10 })
		expect(report.redemptions).toMatchObject({
			consumed: 1,
			restored: 1,
			discountCostMinor: 0,
		})
	})

	it('restoring a reward later never changes the window it was used in', async () => {
		const memberId = await memberWithPurchase('cus_restore_b', LOC_1)
		const reward = await makeReward(ORG)
		const used = await usedReward(memberId, reward.id)
		const db = await getTenantDb(ORG)
		const before = await getLoyaltyReport(db, DAY, { now: NOW + 3000 })
		expect(before.redemptions).toMatchObject({
			consumed: 1,
			restored: 0,
			discountCostMinor: 500,
		})

		await restore(used, NOW + DAY_MS)
		const usedDay = await getLoyaltyReport(db, DAY, { now: NOW + DAY_MS })
		expect(usedDay.redemptions).toEqual(before.redemptions)
		const nextDay = await getLoyaltyReport(
			db,
			{ from: '2026-01-11', to: '2026-01-11' },
			{ now: NOW + DAY_MS },
		)
		expect(nextDay.redemptions).toMatchObject({
			consumed: 0,
			restored: 1,
			discountCostMinor: -500,
		})
	})

	it('reports zeros for a day with no purchases or rewards used', async () => {
		const db = await getTenantDb(ORG)
		const report = await getLoyaltyReport(db, DAY, { now: NOW })
		expect(report.customers.activeInWindow).toBe(0)
		expect(report.purchases).toEqual({
			count: 0,
			customerRevenueMinor: 0,
			averageOrderValueMinor: 0,
			repeatPurchaseRateBp: 0,
			frequencyHundredths: 0,
		})
		expect(report.redemptions).toMatchObject({
			consumed: 0,
			discountCostMinor: 0,
			conversionBp: 0,
		})
	})
})
