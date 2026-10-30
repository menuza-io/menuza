import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { type OperatorOrderRefundRequest } from '@repo/common/restaurant-orders'
import {
	destroyTenantDb,
	getTenantDb,
	loyaltyAuditLog,
	loyaltyLedger,
	loyaltyOutbox,
	loyaltyPurchases,
	loyaltyRefunds,
	provisionTenantDb,
	restaurantOrderRefunds,
	restaurantOrders,
} from '@repo/tenant-db'
import { and, asc, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withLoyaltyWrite } from '../lib/loyalty-write.ts'
import { eraseLoyaltyMembersInTx } from './loyalty-erasure.ts'
import { setProgramStatus } from './loyalty-program-service.ts'
import {
	reconcileLoyaltySource,
	resolvePurchase,
} from './loyalty-purchase-service.ts'
import {
	readRedemptionInTx,
	resolveRedemption,
} from './loyalty-redemption-service.ts'
import { recordLoyaltyRefund } from './loyalty-refund-service.ts'
import { getLoyaltyReport } from './loyalty-report-service.ts'
import {
	activateProgram,
	assertBalancesMatchLedger,
	balanceOf,
	cartLine,
	claimAndQueue,
	expectLoyaltyError,
	givePoints,
	insertCustomer,
	insertOrder,
	insertRound,
	insertTab,
	LOC_2,
	loyaltyCart,
	makeMember,
	makeReward,
	MINUTE,
	NOW,
	reserveReward,
} from './loyalty-test-fixture.ts'
import { recordOrderRefund } from './order-refund-service.ts'

/**
 * Money returned after a sale. An online order's refunds are recorded on the
 * order and loyalty reads them whenever it reconciles; a QR tab paid from the
 * phone is refunded through loyalty. Either way points come back from the
 * purchase's own snapshot and the reward's points come back once, when every
 * cent paid is back.
 */

const ORG = 'org_ll_refund'
const OPERATOR = 'op_refunder'
const NOTE = 'Customer returned it'

let directory: string
let programVersion: number
let customerCounter = 0
let keyCounter = 0

async function member(
	points = 0,
	customerId = `cus_${++customerCounter}`,
): Promise<string> {
	await insertCustomer(ORG, { id: customerId })
	const memberId = await makeMember(ORG, { customerId })
	if (points > 0) await givePoints(ORG, memberId, points)
	return memberId
}

function key(): string {
	return `refund-key-${++keyCounter}`
}

/** The member's sale-driven ledger rows, in the order they were posted. */
async function saleLedgerOf(memberId: string) {
	const db = await getTenantDb(ORG)
	const rows = await db
		.select()
		.from(loyaltyLedger)
		.where(eq(loyaltyLedger.memberId, memberId))
		.orderBy(asc(loyaltyLedger.at), asc(loyaltyLedger.type))
	return rows
		.filter((row) => row.purchaseId !== null || row.redemptionId !== null)
		.map((row) => [row.type, row.delta])
}

function decideRedemption(
	redemptionId: string,
	action: 'consume' | 'release',
	now: number,
) {
	return resolveRedemption(ORG, {
		redemptionId,
		action,
		note: 'Checked the receipt',
		actorId: OPERATOR,
		locationIds: null,
		now,
	})
}

function decidePurchase(
	purchaseId: string,
	action: 'award' | 'exclude',
	now: number,
) {
	return resolvePurchase(ORG, {
		purchaseId,
		action,
		note: 'Checked the receipt',
		actorId: OPERATOR,
		locationIds: null,
		now,
	})
}

async function purchaseFor(type: 'restaurant_order' | 'qr_tab', id: string) {
	const db = await getTenantDb(ORG)
	return db
		.select()
		.from(loyaltyPurchases)
		.where(
			and(
				eq(loyaltyPurchases.sourceType, type),
				eq(loyaltyPurchases.sourceId, id),
			),
		)
		.get()
}

type OrderRefundInput = {
	amountCents?: number
	full?: boolean
	idempotencyKey?: string
	loyaltyAccess?: { refundLoyalty: boolean; impersonated: boolean }
	now?: number
}

function orderRefund(orderId: string, input: OrderRefundInput = {}) {
	const request: OperatorOrderRefundRequest = input.full
		? { full: true, note: NOTE }
		: { amountCents: input.amountCents ?? 0, note: NOTE }
	return recordOrderRefund(ORG, orderId, {
		request,
		actorId: OPERATOR,
		idempotencyKey: input.idempotencyKey ?? key(),
		loyaltyAccess: input.loyaltyAccess ?? {
			refundLoyalty: true,
			impersonated: false,
		},
		now: input.now ?? NOW,
	})
}

async function refundOrder(orderId: string, input: OrderRefundInput = {}) {
	const result = await orderRefund(orderId, input)
	if (!result.ok) throw new Error(`refund refused: ${result.failure.code}`)
	return result.data
}

async function refusal(orderId: string, input: OrderRefundInput = {}) {
	const result = await orderRefund(orderId, input)
	if (result.ok) throw new Error('expected the refund to be refused')
	return result.failure
}

function tabRefund(
	tabId: string,
	input: {
		amountMinor?: number
		full?: boolean
		idempotencyKey?: string
		locationIds?: readonly string[] | null
		now?: number
	} = {},
) {
	return recordLoyaltyRefund(ORG, {
		source: { type: 'qr_tab', id: tabId },
		amountMinor: input.amountMinor,
		full: input.full,
		note: NOTE,
		actorId: OPERATOR,
		locationIds: input.locationIds === undefined ? null : input.locationIds,
		idempotencyKey: input.idempotencyKey ?? key(),
		now: input.now ?? NOW,
	})
}

/** A paid, completed 1000-minor order, claimed and reconciled: 10 points. */
async function earnedOrder(memberId: string): Promise<string> {
	const orderId = await insertOrder(ORG)
	const source = { type: 'restaurant_order' as const, id: orderId }
	await claimAndQueue(ORG, { memberId, source })
	await reconcileLoyaltySource(ORG, source, { now: NOW })
	return orderId
}

/** A 1000-minor tab paid from the phone, claimed and reconciled: 10 points. */
async function earnedTab(memberId: string): Promise<string> {
	const tabId = await insertTab(ORG)
	await insertRound(ORG, tabId)
	const source = { type: 'qr_tab' as const, id: tabId }
	await claimAndQueue(ORG, { memberId, source })
	await reconcileLoyaltySource(ORG, source, { now: NOW })
	return tabId
}

beforeEach(async () => {
	directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loyalty-refund-'))
	vi.stubEnv('TENANT_DB_DIR', directory)
	vi.stubEnv('DATA_REGION', 'us')
	vi.stubEnv('AUTH_HMAC_SECRET', 'test-hmac-secret-123456789')
	await provisionTenantDb(ORG)
	programVersion = (await activateProgram(ORG)).version
})

afterEach(async () => {
	try {
		await assertBalancesMatchLedger(ORG)
	} finally {
		await destroyTenantDb(ORG).catch(() => {})
		fs.rmSync(directory, { recursive: true, force: true })
		vi.unstubAllEnvs()
	}
})

describe('order refunds', () => {
	it('takes back the refunded share of the points from the purchase snapshot', async () => {
		const memberId = await member()
		const orderId = await earnedOrder(memberId)
		expect((await balanceOf(ORG, memberId)).points).toBe(10)

		// 250 of 1000 back: 750 eligible remain, keeping 7 of 10 points.
		const first = await refundOrder(orderId, { amountCents: 250 })
		expect(first.replayed).toBe(false)
		expect(first.refund).toMatchObject({
			amountCents: 250,
			currency: 'USD',
			full: false,
			note: NOTE,
			actorId: OPERATOR,
		})
		expect(first.order).toMatchObject({
			refundedCents: 250,
			paymentStatus: 'paid',
		})
		expect((await balanceOf(ORG, memberId)).points).toBe(7)
		expect(await purchaseFor('restaurant_order', orderId)).toMatchObject({
			awardedPoints: 10,
			refundedMinor: 250,
			reversedPoints: 3,
		})

		// Another 250 (500 back): 5 points kept.
		await refundOrder(orderId, { amountCents: 250 })
		expect((await balanceOf(ORG, memberId)).points).toBe(5)

		// Reconciling again changes nothing.
		await reconcileLoyaltySource(
			ORG,
			{ type: 'restaurant_order', id: orderId },
			{ now: NOW + MINUTE },
		)
		expect((await balanceOf(ORG, memberId)).points).toBe(5)
	})

	it('replays the same key without recording again, and refuses it with other details', async () => {
		const memberId = await member()
		const orderId = await earnedOrder(memberId)
		const idempotencyKey = key()
		const first = await refundOrder(orderId, {
			amountCents: 250,
			idempotencyKey,
		})
		const replay = await refundOrder(orderId, {
			amountCents: 250,
			idempotencyKey,
		})
		expect(replay.replayed).toBe(true)
		expect(replay.refund.id).toBe(first.refund.id)
		expect(replay.order.refundedCents).toBe(250)
		const db = await getTenantDb(ORG)
		const rows = await db
			.select()
			.from(restaurantOrderRefunds)
			.where(eq(restaurantOrderRefunds.orderId, orderId))
		expect(rows).toHaveLength(1)
		expect((await balanceOf(ORG, memberId)).points).toBe(7)

		expect(
			await refusal(orderId, { amountCents: 300, idempotencyKey }),
		).toMatchObject({ status: 409, code: 'idempotency_conflict' })
	})

	it('refuses more than is left, and anything once all of it came back', async () => {
		const memberId = await member()
		const orderId = await earnedOrder(memberId)
		await refundOrder(orderId, { amountCents: 250 })
		expect(await refusal(orderId, { amountCents: 800 })).toMatchObject({
			status: 422,
			code: 'refund_exceeds_payment',
			details: { refundableCents: 750 },
		})

		const rest = await refundOrder(orderId, { full: true })
		expect(rest.refund).toMatchObject({ amountCents: 750, full: true })
		expect(rest.order.refundedCents).toBe(1000)
		expect((await balanceOf(ORG, memberId)).points).toBe(0)

		expect(await refusal(orderId, { full: true })).toMatchObject({
			status: 409,
			code: 'refund_complete',
		})
		expect(await refusal(orderId, { amountCents: 1 })).toMatchObject({
			status: 409,
			code: 'refund_complete',
		})
	})

	it('records refunds of paid online orders only', async () => {
		expect(await refusal('ord_missing', { amountCents: 100 })).toMatchObject({
			status: 404,
			code: 'order_not_found',
		})
		const handoff = await insertOrder(ORG, { paymentMethod: 'handoff' })
		expect(await refusal(handoff, { amountCents: 100 })).toMatchObject({
			status: 409,
			code: 'refund_not_online',
		})
		const pending = await insertOrder(ORG, {
			status: 'accepted',
			paymentStatus: 'pending',
			paidAt: null,
			completedAt: null,
		})
		expect(await refusal(pending, { amountCents: 100 })).toMatchObject({
			status: 409,
			code: 'refund_not_paid',
		})
		// A tab's round is handed over and paid with the tab.
		const round = await insertRound(ORG, await insertTab(ORG))
		expect(await refusal(round, { full: true })).toMatchObject({
			status: 409,
			code: 'refund_not_online',
		})
	})

	it('records a refund of an order loyalty never tracked, queueing nothing', async () => {
		const orderId = await insertOrder(ORG)
		const recorded = await refundOrder(orderId, { amountCents: 100 })
		expect(recorded.order.refundedCents).toBe(100)
		const db = await getTenantDb(ORG)
		expect(await db.select().from(loyaltyOutbox)).toEqual([])
		expect(await db.select().from(loyaltyRefunds)).toEqual([])
	})

	it('refuses a refund on a loyalty order inside the transaction unless the operator may move points', async () => {
		const orderId = await earnedOrder(await member())
		const noClaim = await refusal(orderId, {
			amountCents: 250,
			loyaltyAccess: { refundLoyalty: false, impersonated: false },
		})
		expect(noClaim).toMatchObject({
			status: 403,
			code: 'loyalty_refund_forbidden',
		})
		const impersonated = await refusal(orderId, {
			amountCents: 250,
			loyaltyAccess: { refundLoyalty: true, impersonated: true },
		})
		expect(impersonated).toMatchObject({
			status: 403,
			code: 'impersonation_forbidden',
		})
		const db = await getTenantDb(ORG)
		expect(await db.select().from(restaurantOrderRefunds)).toEqual([])

		// An order loyalty never touched needs neither.
		const plain = await insertOrder(ORG)
		const recorded = await refundOrder(plain, {
			amountCents: 100,
			loyaltyAccess: { refundLoyalty: false, impersonated: true },
		})
		expect(recorded.order.refundedCents).toBe(100)
	})

	it('can take the member into points debt', async () => {
		const memberId = await member()
		const orderId = await earnedOrder(memberId) // +10
		// Spend the ten points on a reward for another order and consume it.
		const reward = await makeReward(ORG)
		const otherOrderId = await insertOrder(ORG, { loyaltyDiscountCents: 500 })
		const other = { type: 'restaurant_order' as const, id: otherOrderId }
		await reserveReward(ORG, { memberId, rewardId: reward.id, source: other })
		await claimAndQueue(ORG, { memberId, source: other })
		await reconcileLoyaltySource(ORG, other, { now: NOW })
		// Spent 10 on the reward, earned 5 on the discounted order: 5 points.
		expect((await balanceOf(ORG, memberId)).points).toBe(5)

		// A full refund of the first order takes its 10 points back into debt.
		await refundOrder(orderId, { full: true })
		expect((await balanceOf(ORG, memberId)).points).toBe(-5)
	})

	it('keeps taking points back while loyalty is switched off or paused', async () => {
		const memberId = await member()
		const orderId = await earnedOrder(memberId)

		vi.stubEnv('LOYALTY_ENABLED', 'false')
		await refundOrder(orderId, { amountCents: 250, now: NOW + MINUTE })
		expect((await balanceOf(ORG, memberId)).points).toBe(7)

		vi.stubEnv('LOYALTY_ENABLED', 'true')
		await setProgramStatus(ORG, {
			expectedVersion: programVersion,
			status: 'paused',
			actorId: OPERATOR,
			now: NOW + 2 * MINUTE,
		})
		await refundOrder(orderId, { full: true, now: NOW + 3 * MINUTE })
		expect((await balanceOf(ORG, memberId)).points).toBe(0)
	})

	it('applies a refund recorded before the sale finished once it does', async () => {
		const memberId = await member()
		const orderId = await insertOrder(ORG, {
			status: 'ready',
			completedAt: null,
		})
		const source = { type: 'restaurant_order' as const, id: orderId }
		await claimAndQueue(ORG, { memberId, source })

		await refundOrder(orderId, { amountCents: 250 })
		expect(await purchaseFor('restaurant_order', orderId)).toMatchObject({
			state: 'open',
			refundedMinor: 250,
			awardedPoints: 0,
		})

		const db = await getTenantDb(ORG)
		await db
			.update(restaurantOrders)
			.set({ status: 'completed', completedAt: new Date(NOW + MINUTE) })
			.where(eq(restaurantOrders.id, orderId))
		await reconcileLoyaltySource(ORG, source, { now: NOW + MINUTE })
		expect(await purchaseFor('restaurant_order', orderId)).toMatchObject({
			state: 'completed',
			awardedPoints: 10,
			reversedPoints: 3,
		})
		expect((await balanceOf(ORG, memberId)).points).toBe(7)
	})
})

describe('order refunds and the reward', () => {
	it('restores the consumed reward exactly once, when every cent is back', async () => {
		const memberId = await member(10)
		const reward = await makeReward(ORG)
		const orderId = await insertOrder(ORG, { loyaltyDiscountCents: 500 })
		const source = { type: 'restaurant_order' as const, id: orderId }
		const redemption = await reserveReward(ORG, {
			memberId,
			rewardId: reward.id,
			source,
		})
		await claimAndQueue(ORG, { memberId, source })
		await reconcileLoyaltySource(ORG, source, { now: NOW })
		// Spent 10, earned 5 on the 500 paid: 5 points, the reward consumed.
		expect((await balanceOf(ORG, memberId)).points).toBe(5)
		const db = await getTenantDb(ORG)
		expect((await readRedemptionInTx(db, redemption.id))!.state).toBe(
			'consumed',
		)

		// 300 of 500 back: partial, the reward stays spent; 200 keeps 2 points.
		await refundOrder(orderId, { amountCents: 300, now: NOW + MINUTE })
		expect((await balanceOf(ORG, memberId)).points).toBe(2)
		expect((await readRedemptionInTx(db, redemption.id))!.state).toBe(
			'consumed',
		)

		// The rest: the reward's 10 points come back.
		const rest = await refundOrder(orderId, {
			full: true,
			now: NOW + 2 * MINUTE,
		})
		expect(rest.refund).toMatchObject({ amountCents: 200, full: true })
		expect((await readRedemptionInTx(db, redemption.id))!.state).toBe(
			'restored',
		)
		expect(await balanceOf(ORG, memberId)).toMatchObject({
			points: 10,
			reserved: 0,
		})

		// Reconciling again never restores it twice.
		await reconcileLoyaltySource(ORG, source, { now: NOW + 3 * MINUTE })
		expect((await balanceOf(ORG, memberId)).points).toBe(10)
		const audit = await db
			.select()
			.from(loyaltyAuditLog)
			.where(eq(loyaltyAuditLog.action, 'refund.applied'))
			.orderBy(asc(loyaltyAuditLog.at))
		expect(audit.map((row) => [row.actorKind, row.changes])).toEqual([
			[
				'system',
				expect.objectContaining({
					cumulativeRefundedMinor: 300,
					pointsReversed: 3,
					rewardRestored: false,
				}),
			],
			[
				'system',
				expect.objectContaining({
					cumulativeRefundedMinor: 500,
					pointsReversed: 2,
					fullRefund: true,
					rewardRestored: true,
				}),
			],
		])
	})

	it('gives a held reward back when a paid order is cancelled and fully refunded', async () => {
		const memberId = await member(10)
		const reward = await makeReward(ORG)
		const orderId = await insertOrder(ORG, {
			status: 'accepted',
			completedAt: null,
			loyaltyDiscountCents: 500,
		})
		const source = { type: 'restaurant_order' as const, id: orderId }
		const redemption = await reserveReward(ORG, {
			memberId,
			rewardId: reward.id,
			source,
		})
		await claimAndQueue(ORG, { memberId, source })
		const db = await getTenantDb(ORG)
		await db
			.update(restaurantOrders)
			.set({ status: 'cancelled' })
			.where(eq(restaurantOrders.id, orderId))

		// Paid, then cancelled with the money still out: an operator decides.
		await reconcileLoyaltySource(ORG, source, { now: NOW })
		expect((await readRedemptionInTx(db, redemption.id))!.state).toBe('review')
		expect(await purchaseFor('restaurant_order', orderId)).toMatchObject({
			state: 'review',
			reviewReason: 'payment_uncertain',
		})

		// Every cent back: the reward's points return and nothing waits.
		await refundOrder(orderId, { full: true, now: NOW + MINUTE })
		expect(await readRedemptionInTx(db, redemption.id)).toMatchObject({
			state: 'released',
			releaseReason: 'order_refunded',
		})
		expect(await purchaseFor('restaurant_order', orderId)).toMatchObject({
			state: 'excluded',
			excludedReason: 'cancelled',
			awardedPoints: 0,
		})
		expect(await balanceOf(ORG, memberId)).toMatchObject({
			points: 10,
			reserved: 0,
		})
	})

	it('restores the reward an operator spends after the order was fully refunded', async () => {
		const memberId = await member(50)
		const reward = await makeReward(ORG) // 10 points, 5.00 off
		// The order carries 3.00 off where 5.00 was approved: both wait.
		const orderId = await insertOrder(ORG, {
			subtotalCents: 2000,
			loyaltyDiscountCents: 300,
		})
		const source = { type: 'restaurant_order' as const, id: orderId }
		const redemption = await reserveReward(ORG, {
			memberId,
			rewardId: reward.id,
			source,
		})
		await claimAndQueue(ORG, { memberId, source })
		await reconcileLoyaltySource(ORG, source, { now: NOW })
		const db = await getTenantDb(ORG)
		expect((await readRedemptionInTx(db, redemption.id))!.state).toBe('review')

		await refundOrder(orderId, { full: true, now: NOW + MINUTE })
		// Nothing was spent yet, so nothing is restored yet.
		expect((await readRedemptionInTx(db, redemption.id))!.state).toBe('review')
		expect(await balanceOf(ORG, memberId)).toMatchObject({
			points: 50,
			reserved: 10,
		})

		await decideRedemption(redemption.id, 'consume', NOW + 2 * MINUTE)
		// Every cent paid is back already: the spent reward comes back at once.
		expect(await readRedemptionInTx(db, redemption.id)).toMatchObject({
			state: 'restored',
			consumedAt: NOW + 2 * MINUTE,
			restoredAt: NOW + 2 * MINUTE,
		})
		const purchase = (await purchaseFor('restaurant_order', orderId))!
		expect(purchase).toMatchObject({ state: 'review', refundedMinor: 1700 })
		await decidePurchase(purchase.id, 'exclude', NOW + 3 * MINUTE)
		expect(await purchaseFor('restaurant_order', orderId)).toMatchObject({
			state: 'excluded',
			excludedReason: 'operator_excluded',
			awardedPoints: 0,
		})
		expect((await readRedemptionInTx(db, redemption.id))!.state).toBe(
			'restored',
		)
		expect(await balanceOf(ORG, memberId)).toMatchObject({
			points: 50,
			reserved: 0,
		})
		expect(await saleLedgerOf(memberId)).toEqual([
			['redeem', -10],
			['redeem_restore', 10],
		])
	})

	it('restores the reward of an erased member once the order is fully refunded', async () => {
		const customerId = `cus_${++customerCounter}`
		const memberId = await member(50, customerId)
		const reward = await makeReward(ORG)
		const orderId = await insertOrder(ORG, {
			status: 'accepted',
			completedAt: null,
			loyaltyDiscountCents: 500,
		})
		const source = { type: 'restaurant_order' as const, id: orderId }
		const redemption = await reserveReward(ORG, {
			memberId,
			rewardId: reward.id,
			source,
		})
		await claimAndQueue(ORG, { memberId, source })
		await withLoyaltyWrite({ orgId: ORG, now: NOW + 500 }, (tx, ctx) =>
			eraseLoyaltyMembersInTx(tx, { customerIds: [customerId], now: ctx.now }),
		)
		const db = await getTenantDb(ORG)
		// Erasure gives back unbound holds only: this one rides on the order.
		expect((await readRedemptionInTx(db, redemption.id))!.state).toBe('bound')

		await db
			.update(restaurantOrders)
			.set({ status: 'completed', completedAt: new Date(NOW + 1000) })
			.where(eq(restaurantOrders.id, orderId))
		await reconcileLoyaltySource(ORG, source, { now: NOW + 1000 })
		expect((await readRedemptionInTx(db, redemption.id))!.state).toBe(
			'consumed',
		)
		expect(await purchaseFor('restaurant_order', orderId)).toMatchObject({
			state: 'excluded',
			excludedReason: 'member_inactive',
			awardedPoints: 0,
		})

		await refundOrder(orderId, { full: true, now: NOW + 2000 })
		expect((await readRedemptionInTx(db, redemption.id))!.state).toBe(
			'restored',
		)
		expect(await balanceOf(ORG, memberId)).toMatchObject({
			points: 50,
			reserved: 0,
		})
		expect(await saleLedgerOf(memberId)).toEqual([
			['redeem', -10],
			['redeem_restore', 10],
		])
	})

	it('gives the reward back when an order it paid in full is cancelled', async () => {
		const memberId = await member(50)
		const reward = await makeReward(ORG) // 5.00 off a 5.00 order: 0 due
		const orderId = await insertOrder(ORG, {
			subtotalCents: 500,
			loyaltyDiscountCents: 500,
			status: 'accepted',
			completedAt: null,
		})
		const source = { type: 'restaurant_order' as const, id: orderId }
		const redemption = await reserveReward(ORG, {
			memberId,
			rewardId: reward.id,
			source,
		})
		await claimAndQueue(ORG, { memberId, source })
		const db = await getTenantDb(ORG)
		await db
			.update(restaurantOrders)
			.set({ status: 'cancelled' })
			.where(eq(restaurantOrders.id, orderId))

		// No money moved, so none is left out: nothing waits for an operator.
		await reconcileLoyaltySource(ORG, source, { now: NOW })
		expect(await readRedemptionInTx(db, redemption.id)).toMatchObject({
			state: 'released',
			releaseReason: 'order_refunded',
		})
		expect(await purchaseFor('restaurant_order', orderId)).toMatchObject({
			state: 'excluded',
			excludedReason: 'cancelled',
			awardedPoints: 0,
		})
		expect(await balanceOf(ORG, memberId)).toMatchObject({
			points: 50,
			reserved: 0,
		})
		expect(await saleLedgerOf(memberId)).toEqual([])
		expect(await refusal(orderId, { full: true })).toMatchObject({
			code: 'refund_complete',
		})
	})

	it('gives the reward back when a late payment is refunded in full', async () => {
		const memberId = await member(50)
		const reward = await makeReward(ORG)
		const orderId = await insertOrder(ORG, {
			status: 'accepted',
			completedAt: null,
			loyaltyDiscountCents: 500,
		})
		const source = { type: 'restaurant_order' as const, id: orderId }
		const redemption = await reserveReward(ORG, {
			memberId,
			rewardId: reward.id,
			source,
		})
		await claimAndQueue(ORG, { memberId, source })
		const db = await getTenantDb(ORG)
		// The money arrived after the hold lapsed: the order waits for review.
		await db
			.update(restaurantOrders)
			.set({ status: 'payment_review' })
			.where(eq(restaurantOrders.id, orderId))
		await reconcileLoyaltySource(ORG, source, { now: NOW })
		expect((await readRedemptionInTx(db, redemption.id))!.state).toBe('review')

		await refundOrder(orderId, { full: true, now: NOW + MINUTE })
		expect(await readRedemptionInTx(db, redemption.id)).toMatchObject({
			state: 'released',
			releaseReason: 'order_refunded',
		})
		expect(await purchaseFor('restaurant_order', orderId)).toMatchObject({
			state: 'excluded',
			excludedReason: 'cancelled',
		})
		expect(await balanceOf(ORG, memberId)).toMatchObject({
			points: 50,
			reserved: 0,
		})
		expect(await saleLedgerOf(memberId)).toEqual([])
	})
})

describe('QR tab refunds', () => {
	it('takes back the refunded share and replays by key', async () => {
		const memberId = await member()
		const tabId = await earnedTab(memberId)
		expect((await balanceOf(ORG, memberId)).points).toBe(10)

		const idempotencyKey = key()
		const first = await tabRefund(tabId, { amountMinor: 250, idempotencyKey })
		expect(first).toMatchObject({
			refundedMinor: 250,
			cumulativeRefundedMinor: 250,
			pointsReversed: 3,
			fullRefund: false,
			rewardRestored: false,
		})
		expect((await balanceOf(ORG, memberId)).points).toBe(7)
		expect(
			await tabRefund(tabId, { amountMinor: 250, idempotencyKey }),
		).toEqual(first)
		const db = await getTenantDb(ORG)
		const rows = await db
			.select()
			.from(loyaltyRefunds)
			.where(eq(loyaltyRefunds.sourceId, tabId))
		expect(rows).toHaveLength(1)

		await expectLoyaltyError(
			tabRefund(tabId, { amountMinor: 300, idempotencyKey }),
			'idempotency_conflict',
		)
		const error = await expectLoyaltyError(
			tabRefund(tabId, { amountMinor: 800 }),
			'refund_exceeds_payment',
		)
		expect(error.details).toEqual({ refundableMinor: 750 })
	})

	it('replays from the refund row once the idempotency key has expired', async () => {
		const memberId = await member()
		const tabId = await earnedTab(memberId)
		const idempotencyKey = key()
		const first = await tabRefund(tabId, { amountMinor: 250, idempotencyKey })
		expect(first.pointsReversed).toBe(3)

		// Past the 48h idempotency TTL the stored key is gone; the refund row
		// still answers the retry instead of tripping its unique index.
		const later = NOW + 49 * 60 * 60_000
		const replay = await tabRefund(tabId, {
			amountMinor: 250,
			idempotencyKey,
			now: later,
		})
		expect(replay).toEqual({
			refundId: first.refundId,
			purchaseId: first.purchaseId,
			refundedMinor: 250,
			cumulativeRefundedMinor: 250,
			pointsReversed: 0,
			fullRefund: false,
			rewardRestored: false,
		})
		const db = await getTenantDb(ORG)
		expect(
			await db
				.select()
				.from(loyaltyRefunds)
				.where(eq(loyaltyRefunds.sourceId, tabId)),
		).toHaveLength(1)
		// Nothing was taken back a second time.
		expect((await balanceOf(ORG, memberId)).points).toBe(7)

		await expectLoyaltyError(
			tabRefund(tabId, { amountMinor: 300, idempotencyKey, now: later }),
			'idempotency_conflict',
		)
	})

	it.each([
		['a full refund', { full: true }],
		['a refund of everything that was paid', { amountMinor: 1000 }],
	] as const)(
		'replays %s once the idempotency key has expired',
		async (_label, request) => {
			const memberId = await member()
			const tabId = await earnedTab(memberId)
			const idempotencyKey = key()
			const first = await tabRefund(tabId, { ...request, idempotencyKey })
			expect(first).toMatchObject({
				refundedMinor: 1000,
				cumulativeRefundedMinor: 1000,
				pointsReversed: 10,
				fullRefund: true,
			})

			// Nothing is left to refund, so the retry must be answered from the
			// refund row before the amount is checked against what was paid.
			const later = NOW + 49 * 60 * 60_000
			const replay = await tabRefund(tabId, {
				...request,
				idempotencyKey,
				now: later,
			})
			expect(replay).toEqual({
				refundId: first.refundId,
				purchaseId: first.purchaseId,
				refundedMinor: 1000,
				cumulativeRefundedMinor: 1000,
				pointsReversed: 0,
				fullRefund: true,
				rewardRestored: false,
			})
			const db = await getTenantDb(ORG)
			expect(
				await db
					.select()
					.from(loyaltyRefunds)
					.where(eq(loyaltyRefunds.sourceId, tabId)),
			).toHaveLength(1)
			expect((await balanceOf(ORG, memberId)).points).toBe(0)
		},
	)

	it('restores the reward of a tab paid from the phone once every cent is back', async () => {
		const memberId = await member(10)
		const reward = await makeReward(ORG)
		const tabId = await insertTab(ORG, { loyaltyDiscountCents: 500 })
		const roundId = await insertRound(ORG, tabId)
		const source = { type: 'qr_tab' as const, id: tabId }
		const redemption = await reserveReward(ORG, {
			memberId,
			rewardId: reward.id,
			cart: loyaltyCart([cartLine({ lineId: `${roundId}:0` })]),
			source,
			channel: 'qr',
		})
		await claimAndQueue(ORG, { memberId, source })
		await reconcileLoyaltySource(ORG, source, { now: NOW })
		expect((await balanceOf(ORG, memberId)).points).toBe(5)

		const result = await tabRefund(tabId, { full: true })
		expect(result).toMatchObject({
			refundedMinor: 500,
			fullRefund: true,
			rewardRestored: true,
			pointsReversed: 5,
		})
		const db = await getTenantDb(ORG)
		expect((await readRedemptionInTx(db, redemption.id))!.state).toBe(
			'restored',
		)
		expect(await balanceOf(ORG, memberId)).toMatchObject({
			points: 10,
			reserved: 0,
		})

		const error = await expectLoyaltyError(
			tabRefund(tabId, { full: true }),
			'refund_exceeds_payment',
		)
		expect(error.details).toEqual({ refundableMinor: 0 })
		expect((await balanceOf(ORG, memberId)).points).toBe(10)
	})

	it('restores the reward a tab spends after it was refunded in full while still bound', async () => {
		const memberId = await member(10)
		const reward = await makeReward(ORG)
		const tabId = await insertTab(ORG, { loyaltyDiscountCents: 500 })
		const roundId = await insertRound(ORG, tabId)
		const source = { type: 'qr_tab' as const, id: tabId }
		const redemption = await reserveReward(ORG, {
			memberId,
			rewardId: reward.id,
			cart: loyaltyCart([cartLine({ lineId: `${roundId}:0` })]),
			source,
			channel: 'qr',
		})
		await claimAndQueue(ORG, { memberId, source })
		// The refund arrives before reconciliation spends the bound reward.
		const refund = await tabRefund(tabId, { full: true, now: NOW })
		expect(refund).toMatchObject({ fullRefund: true, rewardRestored: false })
		const db = await getTenantDb(ORG)
		expect((await readRedemptionInTx(db, redemption.id))!.state).toBe('bound')

		await reconcileLoyaltySource(ORG, source, { now: NOW + MINUTE })
		expect(await readRedemptionInTx(db, redemption.id)).toMatchObject({
			state: 'restored',
			restoredAt: NOW + MINUTE,
		})
		expect(await balanceOf(ORG, memberId)).toMatchObject({
			points: 10,
			reserved: 0,
		})
		// A second pass changes nothing: the reward comes back once.
		await reconcileLoyaltySource(ORG, source, { now: NOW + 2 * MINUTE })
		expect(await balanceOf(ORG, memberId)).toMatchObject({
			points: 10,
			reserved: 0,
		})
		expect(await saleLedgerOf(memberId)).toEqual(
			expect.arrayContaining([
				['redeem', -10],
				['redeem_restore', 10],
			]),
		)
	})

	/** A tab carrying 3.00 off where 5.00 was approved: both wait in review. */
	async function mismatchedTab(memberId: string) {
		const reward = await makeReward(ORG) // 10 points, 5.00 off
		const tabId = await insertTab(ORG, { loyaltyDiscountCents: 300 })
		const roundId = await insertRound(ORG, tabId)
		const source = { type: 'qr_tab' as const, id: tabId }
		const redemption = await reserveReward(ORG, {
			memberId,
			rewardId: reward.id,
			cart: loyaltyCart([cartLine({ lineId: `${roundId}:0` })]),
			source,
			channel: 'qr',
		})
		await claimAndQueue(ORG, { memberId, source })
		const result = await reconcileLoyaltySource(ORG, source, { now: NOW })
		expect(result.purchase).toMatchObject({
			state: 'review',
			reviewReason: 'upload_mismatch',
		})
		expect(result.redemption?.state).toBe('review')
		return {
			tabId,
			source,
			redemptionId: redemption.id,
			purchase: result.purchase!,
		}
	}

	it('restores the reward when an operator awards a tab refunded in full while it waited', async () => {
		const memberId = await member(50)
		const tab = await mismatchedTab(memberId)
		const refund = await tabRefund(tab.tabId, { full: true, now: NOW + MINUTE })
		// Nothing was spent or earned yet.
		expect(refund).toMatchObject({
			refundedMinor: 700,
			fullRefund: true,
			pointsReversed: 0,
			rewardRestored: false,
		})

		await decidePurchase(tab.purchase.id, 'award', NOW + 2 * MINUTE)
		const db = await getTenantDb(ORG)
		// Awarding spends the reward and earns; the refund takes both back.
		expect(await readRedemptionInTx(db, tab.redemptionId)).toMatchObject({
			state: 'restored',
			restoredAt: NOW + 2 * MINUTE,
		})
		expect(await purchaseFor('qr_tab', tab.tabId)).toMatchObject({
			state: 'completed',
			refundedMinor: 700,
			awardedPoints: 7,
			reversedPoints: 7,
		})
		expect(await balanceOf(ORG, memberId)).toMatchObject({
			points: 50,
			reserved: 0,
		})
		expect(await saleLedgerOf(memberId)).toEqual([
			['earn', 7],
			['earn_reversal', -7],
			['redeem', -10],
			['redeem_restore', 10],
		])
	})

	it('restores the reward an operator spends after the tab was refunded in full', async () => {
		const memberId = await member(50)
		const tab = await mismatchedTab(memberId)
		await tabRefund(tab.tabId, { full: true, now: NOW + MINUTE })

		await decideRedemption(tab.redemptionId, 'consume', NOW + 2 * MINUTE)
		const db = await getTenantDb(ORG)
		expect(await readRedemptionInTx(db, tab.redemptionId)).toMatchObject({
			state: 'restored',
			restoredAt: NOW + 2 * MINUTE,
		})
		expect(await balanceOf(ORG, memberId)).toMatchObject({
			points: 50,
			reserved: 0,
		})

		// Awarding the purchase later earns and takes it straight back; the
		// reward is not restored twice.
		await decidePurchase(tab.purchase.id, 'award', NOW + 3 * MINUTE)
		expect(await purchaseFor('qr_tab', tab.tabId)).toMatchObject({
			state: 'completed',
			awardedPoints: 7,
			reversedPoints: 7,
		})
		expect(await balanceOf(ORG, memberId)).toMatchObject({
			points: 50,
			reserved: 0,
		})
		expect(await saleLedgerOf(memberId)).toEqual([
			['redeem', -10],
			['redeem_restore', 10],
			['earn', 7],
			['earn_reversal', -7],
		])
	})

	it('refuses unknown and untracked tabs and hidden locations', async () => {
		await expectLoyaltyError(
			tabRefund('tab_missing', { amountMinor: 100 }),
			'purchase_not_found',
		)
		const untracked = await insertTab(ORG)
		await expectLoyaltyError(
			tabRefund(untracked, { amountMinor: 100 }),
			'purchase_not_found',
		)
		const tabId = await earnedTab(await member())
		await expectLoyaltyError(
			tabRefund(tabId, { amountMinor: 100, locationIds: [LOC_2] }),
			'location_forbidden',
		)
	})

	it('records refunds of tabs paid from the phone only', async () => {
		const memberId = await member()
		// A tracked tab closed at the counter: cash, no online refund to mirror.
		const counterTab = await insertTab(ORG, {
			paymentMethod: 'counter',
			paymentStatus: 'paid',
		})
		await insertRound(ORG, counterTab)
		const counterSource = { type: 'qr_tab' as const, id: counterTab }
		await claimAndQueue(ORG, { memberId, source: counterSource })
		await reconcileLoyaltySource(ORG, counterSource, { now: NOW })
		expect((await balanceOf(ORG, memberId)).points).toBe(10)
		await expectLoyaltyError(
			tabRefund(counterTab, { amountMinor: 100 }),
			'refund_not_online',
		)

		// A tracked tab whose online payment never landed.
		const unpaidTab = await insertTab(ORG, {
			paymentMethod: 'online',
			paymentStatus: 'unpaid',
			paidAt: null,
		})
		const unpaidSource = { type: 'qr_tab' as const, id: unpaidTab }
		await claimAndQueue(ORG, { memberId, source: unpaidSource })
		await reconcileLoyaltySource(ORG, unpaidSource, { now: NOW })
		await expectLoyaltyError(
			tabRefund(unpaidTab, { full: true }),
			'refund_not_paid',
		)

		// Nothing was recorded and no points moved.
		const db = await getTenantDb(ORG)
		expect(await db.select().from(loyaltyRefunds)).toEqual([])
		expect((await balanceOf(ORG, memberId)).points).toBe(10)
	})
})

describe('refunds in the report', () => {
	it('counts refunds of tracked orders and tabs in the window', async () => {
		const memberId = await member()
		const orderId = await earnedOrder(memberId)
		const tabId = await earnedTab(memberId)
		const untracked = await insertOrder(ORG)
		await refundOrder(orderId, { amountCents: 100 })
		await refundOrder(untracked, { amountCents: 100 })
		await tabRefund(tabId, { amountMinor: 100 })

		const db = await getTenantDb(ORG)
		const day = await getLoyaltyReport(
			db,
			{ from: '2026-01-10', to: '2026-01-10' },
			{ now: NOW },
		)
		expect(day.operations.refundsRecorded).toBe(2)
		const nextDay = await getLoyaltyReport(
			db,
			{ from: '2026-01-11', to: '2026-01-11' },
			{ now: NOW },
		)
		expect(nextDay.operations.refundsRecorded).toBe(0)
	})
})
