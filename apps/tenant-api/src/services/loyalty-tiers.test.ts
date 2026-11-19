import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { addCalendarMonths, LoyaltyDomainError } from '@repo/loyalty'
import {
	customers,
	destroyTenantDb,
	getTenantDb,
	loyaltyMembers,
	provisionTenantDb,
	restaurantOrderRefunds,
	restaurantOrders,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withLoyaltyWrite } from '../lib/loyalty-write.ts'
import '../restaurant/loyalty-sources.ts'
import {
	getMemberSummaryInTx,
	getWallet,
	readMemberInTx,
} from './loyalty-member-service.ts'
import { setLoyaltyNoticeTransportForTest } from './loyalty-notices-service.ts'
import { readRewardInTx } from './loyalty-program-service.ts'
import { reconcileLoyaltySource } from './loyalty-purchase-service.ts'
import {
	quoteReward,
	reserveRedemptionInTx,
} from './loyalty-redemption-service.ts'
import { runLoyaltyTickForOrg } from './loyalty-tick-service.ts'
import {
	activateProgram,
	ACTOR,
	assertBalancesMatchLedger,
	balanceOf,
	claimAndQueue,
	DAY,
	insertCustomer,
	insertOrder,
	loyaltyCart,
	makeMember,
	makeReward,
	NOW,
	programConfig,
	rewardDefinition,
} from './loyalty-test-fixture.ts'

const ORG = 'org_ll_tiers'
const FEATURES_ON = { enabled: true, redemption: true, referrals: false }

let directory: string

beforeEach(async () => {
	directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loyalty-tiers-'))
	vi.stubEnv('TENANT_DB_DIR', directory)
	vi.stubEnv('DATA_REGION', 'us')
	vi.stubEnv('AUTH_HMAC_SECRET', 'test-hmac-secret-123456789')
	await provisionTenantDb(ORG)
})

afterEach(async () => {
	setLoyaltyNoticeTransportForTest(null)
	try {
		await assertBalancesMatchLedger(ORG)
	} finally {
		vi.unstubAllEnvs()
		await destroyTenantDb(ORG)
		fs.rmSync(directory, { recursive: true, force: true })
	}
})

function tiersConfig(
	overrides: Partial<ReturnType<typeof programConfig>['tiers']> = {},
) {
	return {
		enabled: true,
		metric: 'qualifying_points' as const,
		periodMonths: 12,
		graceDays: 14,
		tiers: [
			{ id: 'silver', name: 'Silver', threshold: 100, multiplierBp: 15_000 },
			{ id: 'gold', name: 'Gold', threshold: 300, multiplierBp: 20_000 },
		],
		...overrides,
	}
}

describe('#292 loyalty tiers', () => {
	it('upgrades on qualifying earn, applies higher earn rate on next order + stacks promos, and never demotes on redeem', async () => {
		await activateProgram(
			ORG,
			programConfig({
				earning: { method: 'spend', points: 10, perMinor: 100 }, // 10 pts per $1
				tiers: tiersConfig(),
				promotions: [
					{
						id: 'promo_2x',
						name: 'Double Weekend',
						enabled: true,
						kind: 'multiplier',
						value: 20_000,
						scope: { type: 'order' },
						startsAt: null,
						endsAt: null,
						recurring: null,
						locationIds: null,
						maxPointsPerPurchase: null,
						labels: { items: {}, categories: {} },
					},
				],
				promotionStacking: 'add',
			}),
		)
		const db = await getTenantDb(ORG)
		await insertCustomer(ORG, {
			id: 'cus_t1',
			name: 'Nora',
			phone: '+14155550201',
			verified: true,
		})
		const memberId = await makeMember(ORG, { customerId: 'cus_t1', now: NOW })

		// Disable promo temporarily? Wait - let's test WITHOUT promo first then WITH promo:
		// With 2x promo on order 1 ($10): base = 100 pts, tier = none (1x), 2x promo = +100 -> 200 total -> reaches Silver (>= 100)!
		const o1 = await insertOrder(ORG, {
			customerId: 'cus_t1',
			subtotalCents: 1000,
			totalCents: 1000,
		})
		await claimAndQueue(ORG, {
			memberId,
			source: { type: 'restaurant_order', id: o1 },
			at: NOW,
		})
		await reconcileLoyaltySource(
			ORG,
			{ type: 'restaurant_order', id: o1 },
			{ now: NOW },
		)

		expect((await balanceOf(ORG, memberId)).points).toBe(200)
		const afterO1 = await readMemberInTx(db, memberId)
		expect(afterO1?.tierId).toBe('silver')
		expect(afterO1?.tierReviewAt).toBe(addCalendarMonths(NOW, 12))

		// Order 2 ($10): Silver 1.5x -> base becomes 150, then 2x promo stacks on top -> 300 total!
		// Cumulative qualifying points: 200 + 300 = 500 -> reaches Gold (>= 300)!
		const o2 = await insertOrder(ORG, {
			customerId: 'cus_t1',
			subtotalCents: 1000,
			totalCents: 1000,
		})
		await claimAndQueue(ORG, {
			memberId,
			source: { type: 'restaurant_order', id: o2 },
			at: NOW + DAY,
		})
		await reconcileLoyaltySource(
			ORG,
			{ type: 'restaurant_order', id: o2 },
			{ now: NOW + DAY },
		)

		expect((await balanceOf(ORG, memberId)).points).toBe(500)
		const afterO2 = await readMemberInTx(db, memberId)
		expect(afterO2?.tierId).toBe('gold')

		// Create Silver-only reward & reserve redemption spending 450 points (leaving only 50 spendable!).
		// Redeeming points MUST NOT demote the member from Gold!
		const vipRewardRow = await makeReward(
			ORG,
			rewardDefinition({
				name: 'Gold Coffee',
				pointsCost: 450,
				minTierId: 'silver',
			}),
			NOW + 2 * DAY,
		)
		const vipReward = (await readRewardInTx(db, vipRewardRow.id))!
		const cart = loyaltyCart()
		await withLoyaltyWrite({ orgId: ORG, now: NOW + 2 * DAY }, async (tx) => {
			const m = (await readMemberInTx(tx, memberId))!
			await reserveRedemptionInTx(tx, {
				member: m,
				reward: vipReward.snapshot,
				cart,
				cartHash: 'cart_t1',
				targetLineId: null,
				channel: 'web',
				source: null,
				locationId: null,
				at: NOW + 2 * DAY,
			})
		})
		const afterRedeem = await readMemberInTx(db, memberId)
		expect(afterRedeem?.tierId).toBe('gold')
		expect((await balanceOf(ORG, memberId)).available).toBe(50)

		const wallet = await getWallet(db, {
			customerId: 'cus_t1',
			orgId: ORG,
			features: FEATURES_ON,
			now: NOW + 2 * DAY,
		})
		expect(wallet?.tier?.current?.id).toBe('gold')
		expect(wallet?.tier?.progressValue).toBe(500)
		expect(wallet?.tier?.next).toBeNull()

		const opSummary = await getMemberSummaryInTx(db, memberId)
		expect(opSummary?.tier?.id).toBe('gold')
		expect(opSummary?.tier?.name).toBe('Gold')
		expect(opSummary?.tier?.multiplierBp).toBe(20_000)
	})

	it('locks tier-only rewards below minTierId and exposes progress in wallet', async () => {
		await activateProgram(
			ORG,
			programConfig({
				tiers: tiersConfig(),
			}),
		)
		const db = await getTenantDb(ORG)
		await insertCustomer(ORG, {
			id: 'cus_t2',
			name: 'Sam',
			phone: '+14155550202',
			verified: true,
		})
		const memberId = await makeMember(ORG, { customerId: 'cus_t2', now: NOW })
		const goldRewardRow = await makeReward(
			ORG,
			rewardDefinition({
				name: 'Gold Dessert',
				pointsCost: 5,
				minTierId: 'gold',
			}),
			NOW,
		)
		const goldReward = (await readRewardInTx(db, goldRewardRow.id))!

		const walletBefore = await getWallet(db, {
			customerId: 'cus_t2',
			orgId: ORG,
			features: FEATURES_ON,
			now: NOW,
		})
		expect(walletBefore?.tier?.current).toBeNull()
		expect(walletBefore?.tier?.next?.id).toBe('silver')
		expect(walletBefore?.tier?.next?.pointsRemaining).toBe(100)
		expect(walletBefore?.program.rewards[0]?.minTierId).toBe('gold')
		expect(walletBefore?.program.rewards[0]?.minTierName).toBe('Gold')
		expect(walletBefore?.program.rewards[0]?.lockedByTier).toBe(true)

		const cart = loyaltyCart()
		const q = quoteReward(goldReward.snapshot, cart, 500, null, {
			memberTierId: null,
			tiersConfig: tiersConfig(),
		})
		expect(q.applicable).toBe(false)
		expect(q.code).toBe('tier_required')

		await expect(
			withLoyaltyWrite({ orgId: ORG, now: NOW }, async (tx) => {
				const m = (await readMemberInTx(tx, memberId))!
				await reserveRedemptionInTx(tx, {
					member: m,
					reward: goldReward.snapshot,
					cart,
					cartHash: 'cart_t2',
					targetLineId: null,
					channel: 'web',
					source: null,
					locationId: null,
					at: NOW,
				})
			}),
		).rejects.toThrowError(LoyaltyDomainError)
	})

	it('demotes on refund reversal and warns before downgrading after review + grace', async () => {
		const emails: Array<{ to: string; subject: string | null; text: string }> =
			[]
		setLoyaltyNoticeTransportForTest(async (msg) => {
			if (msg.channel === 'email') {
				emails.push({ to: msg.to, subject: msg.subject, text: msg.text })
			}
		})
		await activateProgram(
			ORG,
			programConfig({
				earning: { method: 'spend', points: 10, perMinor: 100 },
				tiers: tiersConfig({ periodMonths: 6, graceDays: 14 }),
			}),
		)
		const db = await getTenantDb(ORG)
		await insertCustomer(ORG, {
			id: 'cus_t3',
			name: 'Omar',
			phone: '+14155550203',
			verified: true,
		})
		await db
			.update(customers)
			.set({ email: 'omar@example.com' })
			.where(eq(customers.id, 'cus_t3'))

		const memberId = await makeMember(ORG, { customerId: 'cus_t3', now: NOW })
		// Purchase $15 -> 150 pts -> reaches Silver (threshold 100)
		const ord1 = await insertOrder(ORG, {
			customerId: 'cus_t3',
			subtotalCents: 1500,
			totalCents: 1500,
		})
		await claimAndQueue(ORG, {
			memberId,
			source: { type: 'restaurant_order', id: ord1 },
			at: NOW,
		})
		await reconcileLoyaltySource(
			ORG,
			{ type: 'restaurant_order', id: ord1 },
			{ now: NOW },
		)
		expect((await readMemberInTx(db, memberId))?.tierId).toBe('silver')

		// Full refund removes qualifying points and immediately demotes back to null
		await db
			.update(restaurantOrders)
			.set({ refundedCents: 1500 })
			.where(eq(restaurantOrders.id, ord1))
		await db.insert(restaurantOrderRefunds).values({
			id: 'ref_t3_1',
			orderId: ord1,
			amountCents: 1500,
			currency: 'USD',
			full: true,
			status: 'succeeded',
			actorId: ACTOR,
			idempotencyKey: 'ref-t3-1',
			requestHash: 'req-ref-t3-1',
			createdAt: NOW + DAY,
		})
		await reconcileLoyaltySource(
			ORG,
			{ type: 'restaurant_order', id: ord1 },
			{ now: NOW + DAY },
		)
		expect((await readMemberInTx(db, memberId))?.tierId).toBeNull()

		// Earn again $12 (120 pts) -> Silver at t1 = NOW + 2 * DAY
		const t1 = NOW + 2 * DAY
		const ord2 = await insertOrder(ORG, {
			customerId: 'cus_t3',
			subtotalCents: 1200,
			totalCents: 1200,
			createdAt: new Date(t1),
		})
		await claimAndQueue(ORG, {
			memberId,
			source: { type: 'restaurant_order', id: ord2 },
			at: t1,
		})
		await reconcileLoyaltySource(
			ORG,
			{ type: 'restaurant_order', id: ord2 },
			{ now: t1 },
		)
		// Age purchase out of the 6-month window & set reviewAt near (5 days away) -> pre-review warning tick!
		const reviewAt = addCalendarMonths(t1, 6)
		await db
			.update(loyaltyMembers)
			.set({
				tierReviewAt: reviewAt,
			})
			.where(eq(loyaltyMembers.id, memberId))

		// Advance clock past reviewAt minus 5 days -> metric over trailing 6 months at tick is now 0 (< 100) because ord2 is more than 6 months before reviewAt? Wait: reviewAt - 5 days is inside 6m, so tick right BEFORE reviewAt won't see ord2 out of window unless ord2 was earlier; advance to reviewAt + 1_000 when ord2 IS outside [reviewAt - 6m, reviewAt]! Wait: at reviewAt + 1000, window since is addCalendarMonths(reviewAt + 1000, -6) = t1 + 1000 > t1, so ord2 drops out -> enters grace period + sends warning email!
		await runLoyaltyTickForOrg(ORG, { now: reviewAt + 1_000 })
		const inGrace = await readMemberInTx(db, memberId)
		expect(inGrace?.tierId).toBe('silver')
		expect(inGrace?.tierGraceUntil).toBe(reviewAt + 1_000 + 14 * DAY)
		expect(emails).toHaveLength(1)
		expect(emails[0]?.subject).toContain('Silver')

		// Running tick again during grace does NOT double-send the notice or prematurely downgrade
		await runLoyaltyTickForOrg(ORG, { now: reviewAt + 2 * DAY })
		expect((await readMemberInTx(db, memberId))?.tierId).toBe('silver')
		expect(emails).toHaveLength(1)

		// Past graceUntil -> downgraded cleanly!
		await runLoyaltyTickForOrg(ORG, { now: reviewAt + 15 * DAY })
		const downgraded = await readMemberInTx(db, memberId)
		expect(downgraded?.tierId).toBeNull()
		expect(downgraded?.tierGraceUntil).toBeNull()
	})
})
