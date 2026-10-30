import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hashLoyaltyCart, LOYALTY_RESERVATION_TTL_MS } from '@repo/loyalty'
import {
	destroyTenantDb,
	getTenantDb,
	loyaltyLedger,
	provisionTenantDb,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withLoyaltyWrite } from '../lib/loyalty-write.ts'
import { readMemberInTx, setMemberStatus } from './loyalty-member-service.ts'
import { readRewardInTx } from './loyalty-program-service.ts'
import {
	bindRedemptionInTx,
	consumeRedemptionInTx,
	quoteReward,
	readRedemptionInTx,
	releaseRedemptionInTx,
	resolveRedemption,
	restoreRedemptionInTx,
	reviewRedemptionInTx,
} from './loyalty-redemption-service.ts'
import {
	activateProgram,
	balanceOf,
	cartLine,
	expectLoyaltyError,
	givePoints,
	insertCustomer,
	insertOrder,
	LOC_1,
	LOC_2,
	loyaltyCart,
	makeMember,
	makeReward,
	memberRow,
	NOW,
	rewardDefinition,
	reserveReward,
} from './loyalty-test-fixture.ts'

const ORG = 'org_ll_redemption'
const ACTOR = 'op_test'

let directory: string
let customerCounter = 0

async function member(points = 0): Promise<string> {
	const customerId = `cus_${++customerCounter}`
	await insertCustomer(ORG, { id: customerId })
	const memberId = await makeMember(ORG, { customerId })
	if (points > 0) await givePoints(ORG, memberId, points)
	return memberId
}

async function readRedemption(id: string) {
	const db = await getTenantDb(ORG)
	return readRedemptionInTx(db, id)
}

async function snapshotOf(rewardId: string) {
	const db = await getTenantDb(ORG)
	return (await readRewardInTx(db, rewardId))!.snapshot
}

async function ledgerOf(memberId: string) {
	const db = await getTenantDb(ORG)
	return db
		.select()
		.from(loyaltyLedger)
		.where(eq(loyaltyLedger.memberId, memberId))
}

beforeEach(async () => {
	directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loyalty-redemption-'))
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

describe('quoting', () => {
	it('a fixed discount caps at the eligible merchandise and spreads over lines', async () => {
		const reward = await makeReward(ORG)
		const snapshot = await snapshotOf(reward.id)
		const cart = loyaltyCart([
			cartLine({ lineId: 'a', unitMinor: 1000 }),
			cartLine({ lineId: 'b', unitMinor: 500 }),
		])
		const quote = quoteReward(snapshot, cart, 50)
		expect(quote).toMatchObject({
			applicable: true,
			affordable: true,
			discountMinor: 500,
			pointsCost: 10,
			eligibleLineIds: ['a', 'b'],
		})
		// 2:1 split by largest remainder: the leftover cent goes to the
		// bigger remainder (b's .67 beats a's .33).
		expect(quote.lines).toEqual([
			{ lineId: 'a', discountMinor: 333, rewardUnits: 0 },
			{ lineId: 'b', discountMinor: 167, rewardUnits: 0 },
		])
	})

	it('a quote is never binding and says so when the points are short', async () => {
		const reward = await makeReward(ORG)
		const quote = quoteReward(await snapshotOf(reward.id), loyaltyCart(), 4)
		expect(quote).toMatchObject({
			applicable: true,
			affordable: false,
			code: 'insufficient_points',
		})
	})

	it('a percentage reward rounds down and respects its cap', async () => {
		const reward = await makeReward(
			ORG,
			rewardDefinition({
				kind: 'order',
				pointsCost: 5,
				discount: { type: 'percent', percentBp: 1000, maxDiscountMinor: 400 },
			}),
		)
		// 10% of 3333 = 333 (rounded down); the cap wins on a bigger cart.
		const quote = quoteReward(
			await snapshotOf(reward.id),
			loyaltyCart([cartLine({ unitMinor: 3333 })]),
			100,
		)
		expect(quote.discountMinor).toBe(333)
		const capped = quoteReward(
			await snapshotOf(reward.id),
			loyaltyCart([cartLine({ unitMinor: 5000 })]),
			100,
		)
		expect(capped.discountMinor).toBe(400)
	})

	it('a free-item reward picks the dearest variant unless a target is named', async () => {
		const reward = await makeReward(ORG, {
			kind: 'free_item',
			name: 'Free drink',
			description: null,
			pointsCost: 3,
			itemId: 'drink_1',
			labels: { items: {}, categories: {} },
		})
		const cart = loyaltyCart([
			cartLine({
				lineId: 'cheap',
				itemId: 'drink_1',
				unitMinor: 200,
				unitBaseMinor: 200,
			}),
			cartLine({
				lineId: 'dear',
				itemId: 'drink_1',
				unitMinor: 350,
				unitBaseMinor: 350,
			}),
			cartLine({ lineId: 'food', itemId: 'burger', unitMinor: 900 }),
		])
		const quote = quoteReward(await snapshotOf(reward.id), cart, 100)
		expect(quote).toMatchObject({
			applicable: true,
			discountMinor: 350,
			targetLineId: 'dear',
		})
		expect(quote.lines).toEqual([
			{ lineId: 'dear', discountMinor: 350, rewardUnits: 1 },
		])
		const snapshot = await snapshotOf(reward.id)
		const targeted = quoteReward(snapshot, cart, 100, 'cheap')
		expect(targeted).toMatchObject({
			discountMinor: 200,
			targetLineId: 'cheap',
		})
		const wrongTarget = quoteReward(snapshot, cart, 100, 'food')
		expect(wrongTarget).toMatchObject({
			applicable: false,
			code: 'reward_not_applicable',
		})
	})

	it('refuses carts that do not fit the reward', async () => {
		const reward = await makeReward(ORG)
		const snapshot = await snapshotOf(reward.id)
		expect(
			quoteReward(snapshot, loyaltyCart([cartLine()], 'EUR'), 100),
		).toMatchObject({ applicable: false, code: 'currency_mismatch' })
		expect(
			quoteReward(
				snapshot,
				{ currency: 'USD', lines: [cartLine()], otherDiscountMinor: 100 },
				100,
			),
		).toMatchObject({ applicable: false, code: 'stacking_not_allowed' })
		const itemsReward = await makeReward(
			ORG,
			rewardDefinition({
				kind: 'items',
				itemIds: ['item_elsewhere'],
				pointsCost: 2,
			}),
		)
		expect(
			quoteReward(await snapshotOf(itemsReward.id), loyaltyCart(), 100),
		).toMatchObject({ applicable: false, code: 'reward_not_applicable' })
	})
})

describe('the reserve -> bind -> consume lifecycle', () => {
	it('holds the points at reserve and spends them at consume', async () => {
		const memberId = await member(10)
		const reward = await makeReward(ORG)
		const cart = loyaltyCart()
		const reserved = await reserveReward(ORG, {
			memberId,
			rewardId: reward.id,
			cart,
		})
		expect(reserved).toMatchObject({
			state: 'reserved',
			points: 10,
			discountMinor: 500,
			sourceType: null,
			sourceId: null,
			locationId: LOC_1,
			expiresAt: NOW + LOYALTY_RESERVATION_TTL_MS,
		})
		expect(await balanceOf(ORG, memberId)).toMatchObject({
			points: 10,
			reserved: 10,
		})

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
		expect(bound).toMatchObject({
			state: 'bound',
			sourceType: 'restaurant_order',
			sourceId: orderId,
			expiresAt: null,
			boundAt: NOW + 1000,
		})

		const consumed = await withLoyaltyWrite(
			{ orgId: ORG, now: NOW + 2000 },
			async (tx, ctx) =>
				consumeRedemptionInTx(tx, bound, {
					at: ctx.now,
					actorKind: 'system',
				}),
		)
		expect(consumed.state).toBe('consumed')
		expect(await balanceOf(ORG, memberId)).toMatchObject({
			points: 0,
			reserved: 0,
		})
		const entries = (await ledgerOf(memberId)).filter(
			(entry) => entry.type === 'redeem',
		)
		expect(entries).toHaveLength(1)
		expect(entries[0]).toMatchObject({ delta: -10, redemptionId: reserved.id })

		// Consuming again is a no-op.
		const again = await withLoyaltyWrite(
			{ orgId: ORG, now: NOW + 3000 },
			(tx) =>
				consumeRedemptionInTx(tx, consumed, {
					at: NOW + 3000,
					actorKind: 'system',
				}),
		)
		expect(again.consumedAt).toBe(consumed.consumedAt)
		expect(
			(await ledgerOf(memberId)).filter((entry) => entry.type === 'redeem'),
		).toHaveLength(1)
	})

	it('binding to the same source twice returns the same row', async () => {
		const memberId = await member(10)
		const reward = await makeReward(ORG)
		const cart = loyaltyCart()
		const reserved = await reserveReward(ORG, {
			memberId,
			rewardId: reward.id,
			cart,
		})
		const orderId = await insertOrder(ORG)
		const cartHash = await hashLoyaltyCart(cart)
		const bound = await withLoyaltyWrite({ orgId: ORG, now: NOW }, (tx) =>
			bindRedemptionInTx(tx, reserved, {
				source: { type: 'restaurant_order', id: orderId },
				cartHash,
				at: NOW,
			}),
		)
		const rebound = await withLoyaltyWrite({ orgId: ORG, now: NOW }, (tx) =>
			bindRedemptionInTx(tx, bound, {
				source: { type: 'restaurant_order', id: orderId },
				cartHash,
				at: NOW,
			}),
		)
		expect(rebound.id).toBe(bound.id)
	})

	it('an order takes one reward, from any member', async () => {
		const first = await member(10)
		const second = await member(10)
		const reward = await makeReward(ORG)
		const orderId = await insertOrder(ORG)
		await reserveReward(ORG, {
			memberId: first,
			rewardId: reward.id,
			source: { type: 'restaurant_order', id: orderId },
		})
		await expectLoyaltyError(
			reserveReward(ORG, {
				memberId: second,
				rewardId: reward.id,
				source: { type: 'restaurant_order', id: orderId },
			}),
			'one_reward_per_order',
		)
		// Binding a reserved hold onto the taken order fails the same way.
		const loose = await reserveReward(ORG, {
			memberId: second,
			rewardId: reward.id,
		})
		const cartHash = await hashLoyaltyCart(loyaltyCart())
		await expectLoyaltyError(
			withLoyaltyWrite({ orgId: ORG, now: NOW }, (tx) =>
				bindRedemptionInTx(tx, loose, {
					source: { type: 'restaurant_order', id: orderId },
					cartHash,
					at: NOW,
				}),
			),
			'one_reward_per_order',
		)
	})

	it('rejects binds from a changed cart or an expired hold', async () => {
		const memberId = await member(30)
		const reward = await makeReward(ORG)
		const reserved = await reserveReward(ORG, { memberId, rewardId: reward.id })
		const orderId = await insertOrder(ORG)
		await expectLoyaltyError(
			withLoyaltyWrite({ orgId: ORG, now: NOW }, (tx) =>
				bindRedemptionInTx(tx, reserved, {
					source: { type: 'restaurant_order', id: orderId },
					cartHash: 'deadbeef'.repeat(8),
					at: NOW,
				}),
			),
			'cart_changed',
		)

		// An expired hold reports as gone; the release rolls back with the
		// throwing transaction, so the tick frees the points later.
		const late = NOW + LOYALTY_RESERVATION_TTL_MS + 1
		await expectLoyaltyError(
			withLoyaltyWrite({ orgId: ORG, now: late }, (tx) =>
				bindRedemptionInTx(tx, reserved, {
					source: { type: 'restaurant_order', id: orderId },
					cartHash: reserved.cartHash,
					at: late,
				}),
			),
			'redemption_not_found',
		)
		expect((await readRedemption(reserved.id))!).toMatchObject({
			state: 'reserved',
		})
		expect(await balanceOf(ORG, memberId)).toMatchObject({
			points: 30,
			reserved: 10,
		})
	})

	it('refuses to spend what the member does not have, or for a suspended member', async () => {
		const memberId = await member(5)
		const reward = await makeReward(ORG)
		await expectLoyaltyError(
			reserveReward(ORG, { memberId, rewardId: reward.id }),
			'insufficient_points',
			{ available: 5, pointsCost: 10 },
		)
		expect(await balanceOf(ORG, memberId)).toMatchObject({
			points: 5,
			reserved: 0,
		})

		await givePoints(ORG, memberId, 10)
		await setMemberStatus(ORG, {
			memberId,
			status: 'suspended',
			note: 'fraud check',
			actorId: ACTOR,
			now: NOW,
		})
		await expectLoyaltyError(
			reserveReward(ORG, { memberId, rewardId: reward.id }),
			'member_inactive',
		)
	})

	it('rejects a reserve whose discount no longer matches what was shown', async () => {
		const memberId = await member(10)
		const reward = await makeReward(ORG)
		await expectLoyaltyError(
			withLoyaltyWrite({ orgId: ORG, now: NOW }, async (tx, ctx) => {
				const row = await readMemberInTx(tx, memberId)
				const { readRewardInTx } = await import('./loyalty-program-service.ts')
				const current = await readRewardInTx(tx, reward.id)
				const { reserveRedemptionInTx } =
					await import('./loyalty-redemption-service.ts')
				return reserveRedemptionInTx(tx, {
					member: row!,
					reward: current!.snapshot,
					cart: loyaltyCart(),
					cartHash: 'x'.repeat(64),
					targetLineId: null,
					expectedDiscountMinor: 499,
					channel: 'web',
					source: null,
					locationId: LOC_1,
					at: ctx.now,
				})
			}),
			'cart_changed',
			{ discountMinor: 500 },
		)
	})
})

describe('release, review, restore', () => {
	it('a release gives the points back and is idempotent', async () => {
		const memberId = await member(10)
		const reward = await makeReward(ORG)
		const orderId = await insertOrder(ORG)
		const bound = await reserveReward(ORG, {
			memberId,
			rewardId: reward.id,
			source: { type: 'restaurant_order', id: orderId },
		})
		const released = await withLoyaltyWrite(
			{ orgId: ORG, now: NOW + 1000 },
			(tx) =>
				releaseRedemptionInTx(tx, bound, {
					reason: 'order_cancelled',
					at: NOW + 1000,
				}),
		)
		expect(released).toMatchObject({
			state: 'released',
			releaseReason: 'order_cancelled',
		})
		expect(await balanceOf(ORG, memberId)).toMatchObject({
			points: 10,
			reserved: 0,
		})
		const again = await withLoyaltyWrite(
			{ orgId: ORG, now: NOW + 2000 },
			(tx) =>
				releaseRedemptionInTx(tx, released, {
					reason: 'order_cancelled',
					at: NOW + 2000,
				}),
		)
		expect(again.releasedAt).toBe(released.releasedAt)
		// A released redemption frees the source's reward slot.
		const second = await reserveReward(ORG, {
			memberId,
			rewardId: reward.id,
			source: { type: 'restaurant_order', id: orderId },
		})
		expect(second.state).toBe('bound')
	})

	it('illegal transitions throw', async () => {
		const memberId = await member(10)
		const reward = await makeReward(ORG)
		const reserved = await reserveReward(ORG, { memberId, rewardId: reward.id })
		await expectLoyaltyError(
			withLoyaltyWrite({ orgId: ORG, now: NOW }, (tx) =>
				consumeRedemptionInTx(tx, reserved, { at: NOW, actorKind: 'system' }),
			),
			'invalid_transition',
		)
		await expectLoyaltyError(
			withLoyaltyWrite({ orgId: ORG, now: NOW }, (tx) =>
				restoreRedemptionInTx(tx, reserved, { at: NOW, actorKind: 'system' }),
			),
			'invalid_transition',
		)
	})

	it('review holds the points until an operator decides', async () => {
		const memberId = await member(10)
		const reward = await makeReward(ORG)
		const orderId = await insertOrder(ORG)
		const bound = await reserveReward(ORG, {
			memberId,
			rewardId: reward.id,
			source: { type: 'restaurant_order', id: orderId },
		})
		const reviewed = await withLoyaltyWrite(
			{ orgId: ORG, now: NOW + 1000 },
			(tx) =>
				reviewRedemptionInTx(tx, bound, {
					reason: 'completed_unpaid',
					at: NOW + 1000,
				}),
		)
		expect(reviewed).toMatchObject({
			state: 'review',
			reviewReason: 'completed_unpaid',
		})
		expect(await balanceOf(ORG, memberId)).toMatchObject({
			points: 10,
			reserved: 10,
		})

		// A plain release of a review row works; an operator decision audits it.
		const decision = await resolveRedemption(ORG, {
			redemptionId: bound.id,
			action: 'consume',
			note: 'guest paid cash',
			actorId: ACTOR,
			locationIds: null,
			now: NOW + 2000,
		})
		expect(decision).toMatchObject({
			id: bound.id,
			state: 'consumed',
			memberId,
			rewardName: 'Five off',
		})
		expect(await balanceOf(ORG, memberId)).toMatchObject({
			points: 0,
			reserved: 0,
		})
	})

	it('an operator release from review returns the points', async () => {
		const memberId = await member(10)
		const reward = await makeReward(ORG)
		const orderId = await insertOrder(ORG)
		const bound = await reserveReward(ORG, {
			memberId,
			rewardId: reward.id,
			source: { type: 'restaurant_order', id: orderId },
		})
		await withLoyaltyWrite({ orgId: ORG, now: NOW + 1000 }, (tx) =>
			reviewRedemptionInTx(tx, bound, {
				reason: 'payment_uncertain',
				at: NOW + 1000,
			}),
		)
		const decision = await resolveRedemption(ORG, {
			redemptionId: bound.id,
			action: 'release',
			note: 'sale never happened',
			actorId: ACTOR,
			locationIds: [LOC_1],
			now: NOW + 2000,
		})
		expect(decision.state).toBe('released')
		expect(await balanceOf(ORG, memberId)).toMatchObject({
			points: 10,
			reserved: 0,
		})
	})

	it('resolveRedemption refuses unknown, misplaced and out-of-review rows', async () => {
		const memberId = await member(10)
		const reward = await makeReward(ORG)
		const orderId = await insertOrder(ORG)
		const bound = await reserveReward(ORG, {
			memberId,
			rewardId: reward.id,
			source: { type: 'restaurant_order', id: orderId },
		})
		await expectLoyaltyError(
			resolveRedemption(ORG, {
				redemptionId: 'red_missing',
				action: 'consume',
				note: 'x',
				actorId: ACTOR,
				locationIds: null,
			}),
			'redemption_not_found',
		)
		await expectLoyaltyError(
			resolveRedemption(ORG, {
				redemptionId: bound.id,
				action: 'consume',
				note: 'x',
				actorId: ACTOR,
				locationIds: [LOC_2],
			}),
			'location_forbidden',
		)
		await expectLoyaltyError(
			resolveRedemption(ORG, {
				redemptionId: bound.id,
				action: 'consume',
				note: 'x',
				actorId: ACTOR,
				locationIds: null,
			}),
			'invalid_transition',
		)
	})

	it('restore gives the spent points back once, only from consumed', async () => {
		const memberId = await member(10)
		const reward = await makeReward(ORG)
		const orderId = await insertOrder(ORG)
		const bound = await reserveReward(ORG, {
			memberId,
			rewardId: reward.id,
			source: { type: 'restaurant_order', id: orderId },
		})
		const consumed = await withLoyaltyWrite(
			{ orgId: ORG, now: NOW + 1000 },
			(tx) =>
				consumeRedemptionInTx(tx, bound, {
					at: NOW + 1000,
					actorKind: 'system',
				}),
		)
		const restored = await withLoyaltyWrite(
			{ orgId: ORG, now: NOW + 2000 },
			(tx) =>
				restoreRedemptionInTx(tx, consumed, {
					at: NOW + 2000,
					actorKind: 'operator',
				}),
		)
		expect(restored.state).toBe('restored')
		expect(await balanceOf(ORG, memberId)).toMatchObject({
			points: 10,
			reserved: 0,
		})
		// Restoring again is a no-op: one restore entry, balance unchanged.
		const again = await withLoyaltyWrite(
			{ orgId: ORG, now: NOW + 3000 },
			(tx) =>
				restoreRedemptionInTx(tx, restored, {
					at: NOW + 3000,
					actorKind: 'operator',
				}),
		)
		expect(again.restoredAt).toBe(restored.restoredAt)
		expect(
			(await ledgerOf(memberId)).filter(
				(entry) => entry.type === 'redeem_restore',
			),
		).toHaveLength(1)
		expect((await balanceOf(ORG, memberId)).points).toBe(10)
	})
})
