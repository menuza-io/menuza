import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	LOYALTY_OUTBOX_MAX_ATTEMPTS,
	LoyaltyDomainError,
	loyaltyOutboxBackoffMs,
} from '@repo/loyalty'
import {
	destroyTenantDb,
	getTenantDb,
	loyaltyAuditLog,
	loyaltyLedger,
	loyaltyOutbox,
	loyaltyPrograms,
	loyaltyProgramVersions,
	loyaltyPurchases,
	posHeldUploads,
	posPayments,
	provisionTenantDb,
	restaurantOrders,
} from '@repo/tenant-db'
import { and, desc, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withLoyaltyWrite } from '../lib/loyalty-write.ts'
import { posOrderLoyaltySource } from '../restaurant/pos-loyalty-source.ts'
import { getLoyaltyReviewQueue } from './loyalty-activity-service.ts'
import { countParkedLoyaltySources } from './loyalty-outbox.ts'
import {
	claimPurchaseInTx,
	loyaltySettleQueue,
	processLoyaltyOutbox,
	purchaseForSourceInTx,
	queueLoyaltySourceInTx,
	reconcileLoyaltySource,
	registerLoyaltySourceAdapter,
	requeueLoyaltySource,
	resolvePurchase,
	type LoyaltySourceRef,
} from './loyalty-purchase-service.ts'
import {
	readRedemptionInTx,
	releaseRedemptionInTx,
	resolveRedemption,
} from './loyalty-redemption-service.ts'
import { setProgramStatus } from './loyalty-program-service.ts'
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
	insertPosDevice,
	insertPosSale,
	insertRound,
	insertTab,
	LOC_1,
	LOC_2,
	loyaltyCart,
	makeMember,
	makeReward,
	memberRow,
	NOW,
	orderLine,
	programConfig,
	reserveReward,
	rewardDefinition,
} from './loyalty-test-fixture.ts'

const ORG = 'org_ll_recon'

let directory: string
let customerCounter = 0

async function member(points = 0): Promise<string> {
	const customerId = `cus_${++customerCounter}`
	await insertCustomer(ORG, { id: customerId })
	const memberId = await makeMember(ORG, { customerId })
	if (points > 0) await givePoints(ORG, memberId, points)
	return memberId
}

async function readPurchase(source: LoyaltySourceRef) {
	const db = await getTenantDb(ORG)
	return purchaseForSourceInTx(db, source)
}

async function readOutbox(source: LoyaltySourceRef) {
	const db = await getTenantDb(ORG)
	return db
		.select()
		.from(loyaltyOutbox)
		.where(
			and(
				eq(loyaltyOutbox.sourceType, source.type),
				eq(loyaltyOutbox.sourceId, source.id),
			),
		)
		.get()
}

/** Every read of a till sale fails: a stand-in for a broken source. */
function breakTillSales() {
	registerLoyaltySourceAdapter({
		type: 'pos_order',
		async read() {
			throw new LoyaltyDomainError('loyalty_unavailable')
		},
	})
}

async function setOrderState(
	orderId: string,
	state: Partial<typeof restaurantOrders.$inferInsert>,
) {
	const db = await getTenantDb(ORG)
	await db
		.update(restaurantOrders)
		.set(state)
		.where(eq(restaurantOrders.id, orderId))
}

beforeEach(async () => {
	directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loyalty-recon-'))
	vi.stubEnv('TENANT_DB_DIR', directory)
	vi.stubEnv('DATA_REGION', 'us')
	vi.stubEnv('AUTH_HMAC_SECRET', 'test-hmac-secret-123456789')
	await provisionTenantDb(ORG)
})

afterEach(async () => {
	registerLoyaltySourceAdapter(posOrderLoyaltySource)
	try {
		await assertBalancesMatchLedger(ORG)
	} finally {
		await destroyTenantDb(ORG).catch(() => {})
		fs.rmSync(directory, { recursive: true, force: true })
		vi.unstubAllEnvs()
	}
})

describe('the restaurant order lifecycle', () => {
	it('claim -> queue -> reconcile earns on a paid, completed order', async () => {
		await activateProgram(ORG)
		const memberId = await member()
		const orderId = await insertOrder(ORG) // one 1000-minor line
		const source = { type: 'restaurant_order' as const, id: orderId }
		const purchase = await claimAndQueue(ORG, { memberId, source })
		expect(purchase.state).toBe('open')

		// Claiming again is a no-op for the same member.
		const again = await claimAndQueue(ORG, { memberId, source })
		expect(again.id).toBe(purchase.id)

		const result = await reconcileLoyaltySource(ORG, source, { now: NOW })
		expect(result.verdict).toBe('completed')
		expect(result.purchase).toMatchObject({
			state: 'completed',
			awardedPoints: 10,
			eligibleMinor: 1000,
			totalPaidMinor: 1000,
			programVersion: 2,
			skipReason: null,
		})
		expect((await balanceOf(ORG, memberId)).points).toBe(10)
		expect((await readOutbox(source))!.status).toBe('done')

		// Reconciling again never earns twice.
		const replay = await reconcileLoyaltySource(ORG, source, { now: NOW })
		expect(replay.purchase!.awardedPoints).toBe(10)
		expect((await balanceOf(ORG, memberId)).points).toBe(10)
		const db = await getTenantDb(ORG)
		const entries = await db
			.select()
			.from(loyaltyLedger)
			.where(eq(loyaltyLedger.purchaseId, purchase.id))
		expect(entries).toHaveLength(1)
	})

	it('an order that has not finished stays open and untracked sources are missing', async () => {
		await activateProgram(ORG)
		const memberId = await member()
		const orderId = await insertOrder(ORG, {
			status: 'accepted',
			paymentStatus: 'unpaid',
			paidAt: null,
			completedAt: null,
		})
		const source = { type: 'restaurant_order' as const, id: orderId }
		await claimAndQueue(ORG, { memberId, source })
		const result = await reconcileLoyaltySource(ORG, source, { now: NOW })
		expect(result.verdict).toBe('open')
		expect(result.purchase!.state).toBe('open')
		expect((await balanceOf(ORG, memberId)).points).toBe(0)

		const missing = await reconcileLoyaltySource(
			ORG,
			{ type: 'restaurant_order', id: 'ord_missing' },
			{ now: NOW },
		)
		expect(missing.verdict).toBe('untracked')
	})

	it('a cancelled order is excluded and its bound reward is released', async () => {
		await activateProgram(ORG)
		const memberId = await member(10)
		const reward = await makeReward(ORG)
		const orderId = await insertOrder(ORG, {
			status: 'cancelled',
			paymentStatus: 'unpaid',
			paidAt: null,
			completedAt: null,
			cancelledAt: new Date(NOW),
		})
		const source = { type: 'restaurant_order' as const, id: orderId }
		const redemption = await reserveReward(ORG, {
			memberId,
			rewardId: reward.id,
			source,
		})
		await claimAndQueue(ORG, { memberId, source })
		const result = await reconcileLoyaltySource(ORG, source, { now: NOW })
		expect(result.verdict).toBe('cancelled')
		expect(result.purchase).toMatchObject({
			state: 'excluded',
			excludedReason: 'cancelled',
		})
		const db = await getTenantDb(ORG)
		expect(await readRedemptionInTx(db, redemption.id)).toMatchObject({
			state: 'released',
			releaseReason: 'order_cancelled',
		})
		expect(await balanceOf(ORG, memberId)).toMatchObject({
			points: 10,
			reserved: 0,
		})
	})

	it('reopens a cancelled exclusion when a late payment completes the order', async () => {
		await activateProgram(ORG)
		const memberId = await member()
		const orderId = await insertOrder(ORG, {
			status: 'cancelled',
			paymentStatus: 'unpaid',
			paidAt: null,
			completedAt: null,
		})
		const source = { type: 'restaurant_order' as const, id: orderId }
		await claimAndQueue(ORG, { memberId, source })
		await reconcileLoyaltySource(ORG, source, { now: NOW })
		expect((await readPurchase(source))!.state).toBe('excluded')

		// The payment actually went through later.
		await setOrderState(orderId, {
			status: 'completed',
			paymentStatus: 'paid',
			paidAt: new Date(NOW + 10 * 60_000),
			completedAt: new Date(NOW + 10 * 60_000),
		})
		await claimAndQueue(ORG, { memberId, source }) // claim no-ops, queue re-arms
		const result = await reconcileLoyaltySource(ORG, source, {
			now: NOW + 11 * 60_000,
		})
		expect(result.purchase).toMatchObject({
			state: 'completed',
			excludedReason: null,
			awardedPoints: 10,
		})
		expect((await balanceOf(ORG, memberId)).points).toBe(10)
	})

	it('excludes a paid order in another currency', async () => {
		await activateProgram(ORG)
		const memberId = await member()
		const orderId = await insertOrder(ORG, { currency: 'EUR' })
		const source = { type: 'restaurant_order' as const, id: orderId }
		await claimAndQueue(ORG, { memberId, source, currency: 'EUR' })
		const result = await reconcileLoyaltySource(ORG, source, { now: NOW })
		expect(result.purchase).toMatchObject({
			state: 'excluded',
			excludedReason: 'currency_mismatch',
		})
		expect((await balanceOf(ORG, memberId)).points).toBe(0)
	})

	it('earns nothing below the minimum qualifying spend, but completes', async () => {
		await activateProgram(ORG, programConfig({ minimumSpendMinor: 2000 }))
		const memberId = await member()
		const orderId = await insertOrder(ORG)
		const source = { type: 'restaurant_order' as const, id: orderId }
		await claimAndQueue(ORG, { memberId, source })
		const result = await reconcileLoyaltySource(ORG, source, { now: NOW })
		expect(result.purchase).toMatchObject({
			state: 'completed',
			awardedPoints: 0,
			skipReason: 'below_minimum',
		})
	})

	it('sale-level discounts shrink the eligible merchandise', async () => {
		await activateProgram(ORG)
		const memberId = await member(10)
		const reward = await makeReward(ORG) // 500 off for 10 points
		const orderId = await insertOrder(ORG, { loyaltyDiscountCents: 500 })
		const source = { type: 'restaurant_order' as const, id: orderId }
		const redemption = await reserveReward(ORG, {
			memberId,
			rewardId: reward.id,
			source,
		})
		await claimAndQueue(ORG, { memberId, source })
		const result = await reconcileLoyaltySource(ORG, source, { now: NOW })
		// The reward is consumed and the discounted 500 minor still earns.
		expect(result.purchase).toMatchObject({
			state: 'completed',
			awardedPoints: 5,
			eligibleMinor: 500,
			totalPaidMinor: 500,
		})
		const db = await getTenantDb(ORG)
		expect((await readRedemptionInTx(db, redemption.id))!.state).toBe(
			'consumed',
		)
		expect(await balanceOf(ORG, memberId)).toMatchObject({
			points: 5,
			reserved: 0,
		})
	})
})

describe('review verdicts', () => {
	it('a completed order that was never paid waits for an operator', async () => {
		await activateProgram(ORG)
		const memberId = await member(10)
		const reward = await makeReward(ORG)
		const orderId = await insertOrder(ORG, {
			paymentMethod: 'handoff',
			paymentStatus: 'unpaid',
			paidAt: null,
		})
		const source = { type: 'restaurant_order' as const, id: orderId }
		const redemption = await reserveReward(ORG, {
			memberId,
			rewardId: reward.id,
			source,
		})
		await claimAndQueue(ORG, { memberId, source })
		const result = await reconcileLoyaltySource(ORG, source, { now: NOW })
		expect(result.purchase).toMatchObject({
			state: 'review',
			reviewReason: 'completed_unpaid',
		})
		const db = await getTenantDb(ORG)
		expect(await readRedemptionInTx(db, redemption.id)).toMatchObject({
			state: 'review',
			reviewReason: 'completed_unpaid',
		})
		// The points are still held.
		expect(await balanceOf(ORG, memberId)).toMatchObject({
			points: 10,
			reserved: 10,
		})
	})

	it('a payment under review sends the purchase to review too', async () => {
		await activateProgram(ORG)
		const memberId = await member()
		const orderId = await insertOrder(ORG, { paymentStatus: 'review' })
		const source = { type: 'restaurant_order' as const, id: orderId }
		await claimAndQueue(ORG, { memberId, source })
		const result = await reconcileLoyaltySource(ORG, source, { now: NOW })
		expect(result.verdict).toBe('review')
		expect(result.purchase).toMatchObject({
			state: 'review',
			reviewReason: 'payment_uncertain',
		})
	})

	it('a sale carrying a loyalty discount with no redemption goes to review', async () => {
		await activateProgram(ORG)
		const memberId = await member()
		const orderId = await insertOrder(ORG, { loyaltyDiscountCents: 300 })
		const source = { type: 'restaurant_order' as const, id: orderId }
		await claimAndQueue(ORG, { memberId, source })
		const result = await reconcileLoyaltySource(ORG, source, { now: NOW })
		expect(result.purchase).toMatchObject({
			state: 'review',
			reviewReason: 'redemption_unknown',
		})
	})

	it('a sale carrying a released reward discount goes to review', async () => {
		await activateProgram(ORG)
		const memberId = await member(10)
		const reward = await makeReward(ORG)
		const orderId = await insertOrder(ORG, {
			status: 'cancelled',
			paymentStatus: 'unpaid',
			paidAt: null,
			completedAt: null,
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
		expect((await readRedemptionInTx(db, redemption.id))!.state).toBe(
			'released',
		)

		// The cancelled order was later completed and paid, still showing the
		// loyalty discount the till had recorded.
		await setOrderState(orderId, {
			status: 'completed',
			paymentStatus: 'paid',
			paidAt: new Date(NOW + 10 * 60_000),
			completedAt: new Date(NOW + 10 * 60_000),
			loyaltyDiscountCents: 500,
			totalCents: 500,
		})
		const result = await reconcileLoyaltySource(ORG, source, {
			now: NOW + 11 * 60_000,
		})
		expect(result.purchase).toMatchObject({
			state: 'review',
			reviewReason: 'redemption_released',
		})
	})
})

describe('a discount other than the approved one', () => {
	async function mismatched(source: LoyaltySourceRef, memberId: string) {
		const result = await reconcileLoyaltySource(ORG, source, { now: NOW })
		const db = await getTenantDb(ORG)
		const redemption = (await readRedemptionInTx(db, result.redemption!.id))!
		// Nothing is spent: the points stay held for the operator.
		expect(redemption).toMatchObject({
			state: 'review',
			reviewReason: 'upload_mismatch',
		})
		expect(result.purchase).toMatchObject({
			state: 'review',
			reviewReason: 'upload_mismatch',
		})
		expect(await balanceOf(ORG, memberId)).toMatchObject({
			points: 50,
			reserved: 10,
		})

		// The operator decides the reward was not used: the points come back.
		await resolveRedemption(ORG, {
			redemptionId: redemption.id,
			action: 'release',
			note: 'Till gave a smaller discount',
			actorId: 'op_test',
			locationIds: null,
			now: NOW + 1000,
		})
		await resolvePurchase(ORG, {
			purchaseId: result.purchase!.id,
			action: 'exclude',
			note: 'Mismatch',
			actorId: 'op_test',
			locationIds: null,
			now: NOW + 2000,
		})
		expect((await readRedemptionInTx(db, redemption.id))!.state).toBe(
			'released',
		)
		expect(await balanceOf(ORG, memberId)).toMatchObject({
			points: 50,
			reserved: 0,
		})
	}

	it('sends an order’s redemption to review with its purchase instead of spending it', async () => {
		await activateProgram(ORG)
		const memberId = await member(50)
		const reward = await makeReward(ORG) // 10 points, 5.00 off
		const orderId = await insertOrder(ORG, {
			subtotalCents: 2000,
			loyaltyDiscountCents: 300,
		})
		const source = { type: 'restaurant_order' as const, id: orderId }
		await reserveReward(ORG, { memberId, rewardId: reward.id, source })
		await claimAndQueue(ORG, { memberId, source })
		await mismatched(source, memberId)
	})

	it('sends a till sale’s redemption to review with its purchase instead of spending it', async () => {
		await activateProgram(ORG)
		const memberId = await member(50)
		const reward = await makeReward(ORG)
		const saleId = await insertPosSale(ORG, {
			subtotalCents: 1000,
			totalCents: 700,
			lines: [
				{
					id: '0',
					itemId: 'item_1',
					name: 'Test item',
					variantId: null,
					variantLabel: null,
					quantity: 1,
					baseCents: 1000,
					instructions: '',
					options: [],
				},
			],
			adjustments: [{ kind: 'loyalty', amountCents: 300 }],
		})
		const source = { type: 'pos_order' as const, id: saleId }
		await reserveReward(ORG, {
			memberId,
			rewardId: reward.id,
			source,
			channel: 'pos',
		})
		await claimAndQueue(ORG, { memberId, source })
		await mismatched(source, memberId)
	})

	it('sends a till sale to review when the uploaded lines no longer earn the approved discount', async () => {
		await activateProgram(ORG)
		const memberId = await member(50)
		const reward = await makeReward(
			ORG,
			rewardDefinition({
				kind: 'items',
				itemIds: ['item_a'],
				discount: { type: 'percent', percentBp: 5000, maxDiscountMinor: null },
			}),
		)
		// Approved against a $20.00 eligible item: 50% off = $10.00.
		const cart = loyaltyCart([
			cartLine({ itemId: 'item_a', unitBaseMinor: 2000, unitMinor: 2000 }),
		])
		const source = { type: 'pos_order' as const, id: 'sale_swapped' }
		await reserveReward(ORG, {
			memberId,
			rewardId: reward.id,
			cart,
			source,
			channel: 'pos',
		})
		// The upload keeps the discount amount but swaps in another item.
		await insertPosSale(ORG, {
			id: 'sale_swapped',
			subtotalCents: 2000,
			totalCents: 1000,
			lines: [
				{
					id: '0',
					itemId: 'item_b',
					name: 'Swapped item',
					variantId: null,
					variantLabel: null,
					quantity: 1,
					baseCents: 2000,
					instructions: '',
					options: [],
				},
			],
			adjustments: [{ kind: 'loyalty', amountCents: 1000 }],
		})
		await claimAndQueue(ORG, { memberId, source })
		const result = await reconcileLoyaltySource(ORG, source, {
			now: NOW + 1000,
		})
		expect(result.purchase).toMatchObject({
			state: 'review',
			reviewReason: 'upload_mismatch',
		})
		// The discount no longer fits the sale: the points stay held too.
		expect(result.redemption).toMatchObject({
			state: 'review',
			reviewReason: 'upload_mismatch',
		})
		expect(await balanceOf(ORG, memberId)).toMatchObject({
			points: 50,
			reserved: 10,
		})
	})

	it('a till sale whose upload matches the approved cart still earns and spends', async () => {
		await activateProgram(ORG)
		const memberId = await member(50)
		const reward = await makeReward(
			ORG,
			rewardDefinition({
				kind: 'items',
				itemIds: ['item_a'],
				discount: { type: 'percent', percentBp: 5000, maxDiscountMinor: null },
			}),
		)
		const cart = loyaltyCart([
			cartLine({ itemId: 'item_a', unitBaseMinor: 2000, unitMinor: 2000 }),
		])
		const source = { type: 'pos_order' as const, id: 'sale_matched' }
		const redemption = await reserveReward(ORG, {
			memberId,
			rewardId: reward.id,
			cart,
			source,
			channel: 'pos',
		})
		await insertPosSale(ORG, {
			id: 'sale_matched',
			subtotalCents: 2000,
			totalCents: 1000,
			lines: [
				{
					id: '0',
					itemId: 'item_a',
					name: 'Approved item',
					variantId: null,
					variantLabel: null,
					quantity: 1,
					baseCents: 2000,
					instructions: '',
					options: [],
				},
			],
			adjustments: [{ kind: 'loyalty', amountCents: 1000 }],
		})
		await claimAndQueue(ORG, { memberId, source })
		const result = await reconcileLoyaltySource(ORG, source, {
			now: NOW + 1000,
		})
		expect(result.purchase?.state).toBe('completed')
		const db = await getTenantDb(ORG)
		expect((await readRedemptionInTx(db, redemption.id))!.state).toBe(
			'consumed',
		)
		expect(result.purchase?.awardedPoints).toBeGreaterThan(0)
	})

	it('holds a reward whose approval was taken on another terminal', async () => {
		await activateProgram(ORG)
		const memberId = await member(50)
		const reward = await makeReward(ORG) // 10 points, 5.00 off
		// Terminal A took the approval; terminal B uploaded the paid sale.
		const tillA = await insertPosDevice(ORG)
		const tillB = await insertPosDevice(ORG)
		const source = { type: 'pos_order' as const, id: 'sale_moved' }
		const redemption = await reserveReward(ORG, {
			memberId,
			rewardId: reward.id,
			source,
			channel: 'pos',
			deviceId: tillA,
		})
		await insertPosSale(ORG, {
			id: 'sale_moved',
			deviceId: tillB,
			subtotalCents: 1000,
			totalCents: 500,
			adjustments: [{ kind: 'loyalty', amountCents: 500 }],
		})
		await claimAndQueue(ORG, { memberId, source })
		const result = await reconcileLoyaltySource(ORG, source, {
			now: NOW + 1000,
		})
		expect(result.purchase).toMatchObject({
			state: 'review',
			reviewReason: 'device_mismatch',
		})
		expect(result.redemption).toMatchObject({
			state: 'review',
			reviewReason: 'device_mismatch',
		})
		// The points stay held for the operator to decide.
		expect((await balanceOf(ORG, memberId)).reserved).toBe(10)
	})

	it('only a held upload from the sale’s own terminal holds its loyalty back', async () => {
		await activateProgram(ORG)
		const memberId = await member(50)
		const db = await getTenantDb(ORG)
		// Another terminal's unreadable upload naming the sale: ignored.
		const tillA = await insertPosDevice(ORG)
		const tillB = await insertPosDevice(ORG)
		const clearId = await insertPosSale(ORG, { deviceId: tillA })
		await db.insert(posHeldUploads).values({
			deviceId: tillB,
			orderId: clearId,
			revision: 99,
			error: 'invalid_request',
			payload: '{}',
			receivedAt: NOW + 1000,
		})
		const clearSource = { type: 'pos_order' as const, id: clearId }
		await claimAndQueue(ORG, { memberId, source: clearSource })
		const settled = await reconcileLoyaltySource(ORG, clearSource, {
			now: NOW + 2000,
		})
		expect(settled.purchase).toMatchObject({ state: 'completed' })
		// An unreadable newer revision from the sale's own terminal: it waits.
		const tillC = await insertPosDevice(ORG)
		const heldId = await insertPosSale(ORG, { deviceId: tillC })
		await db.insert(posHeldUploads).values({
			deviceId: tillC,
			orderId: heldId,
			revision: 2,
			error: 'invalid_request',
			payload: '{}',
			receivedAt: NOW + 1000,
		})
		const heldSource = { type: 'pos_order' as const, id: heldId }
		await claimAndQueue(ORG, { memberId, source: heldSource })
		const held = await reconcileLoyaltySource(ORG, heldSource, {
			now: NOW + 2000,
		})
		expect(held.purchase).toMatchObject({
			state: 'review',
			reviewReason: 'upload_held',
		})
	})
})

describe('what holds a finished sale at settle', () => {
	const tillLine = {
		id: '0',
		itemId: 'item_1',
		name: 'Test item',
		variantId: null,
		variantLabel: null,
		quantity: 1,
		baseCents: 1000,
		instructions: '',
		options: [],
	}

	it('a flagged till sale holds its reward with its purchase until an operator decides', async () => {
		await activateProgram(ORG)
		const memberId = await member(50)
		const reward = await makeReward(ORG) // 10 points, 5.00 off
		const deviceId = await insertPosDevice(ORG)
		const source = { type: 'pos_order' as const, id: 'sale_flagged' }
		const redemption = await reserveReward(ORG, {
			memberId,
			rewardId: reward.id,
			source,
			channel: 'pos',
			deviceId,
		})
		// The fiscal chain broke on this sale: it never earns on its own.
		await insertPosSale(ORG, {
			id: 'sale_flagged',
			deviceId,
			subtotalCents: 1000,
			totalCents: 500,
			reviewReason: 'chain_broken',
			lines: [tillLine],
			adjustments: [{ kind: 'loyalty', amountCents: 500 }],
		})
		await claimAndQueue(ORG, { memberId, source })
		const result = await reconcileLoyaltySource(ORG, source, {
			now: NOW + 1000,
		})
		expect(result.purchase).toMatchObject({
			state: 'review',
			reviewReason: 'sale_flagged',
			awardedPoints: 0,
		})
		expect(result.redemption).toMatchObject({
			id: redemption.id,
			state: 'review',
			reviewReason: 'sale_flagged',
		})
		expect(await balanceOf(ORG, memberId)).toMatchObject({
			points: 50,
			reserved: 10,
		})

		// Reconciling again changes nothing.
		await reconcileLoyaltySource(ORG, source, { now: NOW + 2000 })
		expect(await readPurchase(source)).toMatchObject({
			state: 'review',
			reviewReason: 'sale_flagged',
		})

		// The operator vouches for the sale: the reward is spent and it earns.
		const awarded = await resolvePurchase(ORG, {
			purchaseId: result.purchase!.id,
			action: 'award',
			note: 'Receipt checked',
			actorId: 'op_test',
			locationIds: null,
			now: NOW + 3000,
		})
		expect(awarded).toMatchObject({ state: 'completed', awardedPoints: 5 })
		const db = await getTenantDb(ORG)
		expect((await readRedemptionInTx(db, redemption.id))!.state).toBe(
			'consumed',
		)
		expect(await balanceOf(ORG, memberId)).toMatchObject({
			points: 45,
			reserved: 0,
		})
	})

	it('a till sale with a suspicious time waits for review, but its reward is spent', async () => {
		await activateProgram(ORG)
		const memberId = await member(50)
		const reward = await makeReward(ORG)
		const deviceId = await insertPosDevice(ORG)
		const source = { type: 'pos_order' as const, id: 'sale_future' }
		const redemption = await reserveReward(ORG, {
			memberId,
			rewardId: reward.id,
			source,
			channel: 'pos',
			deviceId,
		})
		// The till says it was paid ten minutes after the region received it.
		await insertPosSale(ORG, {
			id: 'sale_future',
			deviceId,
			subtotalCents: 1000,
			totalCents: 500,
			paidAt: NOW + 10 * 60_000,
			lines: [tillLine],
			adjustments: [{ kind: 'loyalty', amountCents: 500 }],
		})
		const db = await getTenantDb(ORG)
		await db.insert(posPayments).values({
			id: 'pay_future',
			orderId: 'sale_future',
			deviceId,
			method: 'card',
			amountCents: 500,
			tenderedCents: 500,
			paidAt: NOW + 10 * 60_000,
			receivedAt: NOW,
		})
		await claimAndQueue(ORG, { memberId, source })
		const result = await reconcileLoyaltySource(ORG, source, {
			now: NOW + 1000,
		})
		expect(result.purchase).toMatchObject({
			state: 'review',
			reviewReason: 'sale_time_suspicious',
			awardedPoints: 0,
		})
		// The till's upload carries the approved discount: only the earning is
		// in doubt, so the reward is spent.
		expect((await readRedemptionInTx(db, redemption.id))!.state).toBe(
			'consumed',
		)
		expect(await balanceOf(ORG, memberId)).toMatchObject({
			points: 40,
			reserved: 0,
		})

		const awarded = await resolvePurchase(ORG, {
			purchaseId: result.purchase!.id,
			action: 'award',
			note: 'Till clock was off',
			actorId: 'op_test',
			locationIds: null,
			now: NOW + 2000,
		})
		expect(awarded).toMatchObject({ state: 'completed', awardedPoints: 5 })
		expect(await balanceOf(ORG, memberId)).toMatchObject({
			points: 45,
			reserved: 0,
		})
	})

	it('a sale that finishes while the program is paused never earns', async () => {
		const activated = await activateProgram(ORG)
		const memberId = await member()
		await setProgramStatus(ORG, {
			expectedVersion: activated.version,
			status: 'paused',
			actorId: 'op_test',
			now: NOW + 1000,
		})
		const orderId = await insertOrder(ORG, {
			paidAt: new Date(NOW + 2000),
			completedAt: new Date(NOW + 2000),
		})
		const source = { type: 'restaurant_order' as const, id: orderId }
		await claimAndQueue(ORG, { memberId, source, at: NOW + 2000 })
		const result = await reconcileLoyaltySource(ORG, source, {
			now: NOW + 3000,
		})
		expect(result.purchase).toMatchObject({
			state: 'excluded',
			excludedReason: 'program_inactive',
			awardedPoints: 0,
		})
		expect(await balanceOf(ORG, memberId)).toMatchObject({
			points: 0,
			reserved: 0,
		})
		expect(await readOutbox(source)).toMatchObject({ status: 'done' })
	})
})

describe('the earning methods', () => {
	it('visits: one award per member per organization-local day', async () => {
		await activateProgram(
			ORG,
			programConfig({ earning: { method: 'visit', points: 5 } }),
		)
		const memberId = await member()
		const firstId = await insertOrder(ORG, {
			paidAt: new Date(NOW),
			completedAt: new Date(NOW),
		})
		const secondId = await insertOrder(ORG, {
			paidAt: new Date(NOW + 3 * 60 * 60_000),
			completedAt: new Date(NOW + 3 * 60 * 60_000),
		})
		const thirdId = await insertOrder(ORG, {
			paidAt: new Date(NOW + 26 * 60 * 60_000),
			completedAt: new Date(NOW + 26 * 60 * 60_000),
		})
		for (const [id, points, skip] of [
			[firstId, 5, null],
			[secondId, 0, 'visit_already_awarded'],
			[thirdId, 5, null],
		] as const) {
			const source = { type: 'restaurant_order' as const, id }
			await claimAndQueue(ORG, { memberId, source })
			const result = await reconcileLoyaltySource(ORG, source, {
				now: NOW + 27 * 60 * 60_000,
			})
			expect(result.purchase).toMatchObject({
				state: 'completed',
				awardedPoints: points,
				skipReason: skip,
			})
		}
		expect((await balanceOf(ORG, memberId)).points).toBe(10)
		const purchase = await readPurchase({
			type: 'restaurant_order',
			id: firstId,
		})
		expect(purchase).toMatchObject({
			visitAwarded: true,
			visitDate: '2026-01-10',
		})
	})

	it('a spend rule whose points outrun the ledger cap earns the cap instead of failing', async () => {
		// One point per cent is a valid rule, and a sale over $1,000,000.00 would
		// earn more than a ledger entry can hold: the award is capped.
		await activateProgram(
			ORG,
			programConfig({ earning: { method: 'spend', points: 1, perMinor: 1 } }),
		)
		const memberId = await member()
		const orderId = await insertOrder(ORG, {
			subtotalCents: 150_000_000,
			totalCents: 150_000_000,
			lines: [
				orderLine({
					unitPriceCents: 150_000_000,
					taxableUnitCents: 150_000_000,
				}),
			],
		})
		const source = { type: 'restaurant_order' as const, id: orderId }
		await claimAndQueue(ORG, { memberId, source })
		const result = await reconcileLoyaltySource(ORG, source, {
			now: NOW + 1000,
		})
		expect(result.purchase).toMatchObject({
			state: 'completed',
			awardedPoints: 100_000_000,
		})
		expect((await balanceOf(ORG, memberId)).points).toBe(100_000_000)
	})

	it('items: points per unit of the selected items only', async () => {
		await activateProgram(
			ORG,
			programConfig({
				earning: { method: 'items', points: 3, itemIds: ['item_1'] },
			}),
		)
		const memberId = await member()
		const orderId = await insertOrder(ORG, {
			lines: [
				orderLine({ itemId: 'item_1', quantity: 2, unitPriceCents: 500 }),
				orderLine({ itemId: 'item_2', lineId: undefined }),
			],
			subtotalCents: 2000,
			totalCents: 2000,
		})
		const source = { type: 'restaurant_order' as const, id: orderId }
		await claimAndQueue(ORG, { memberId, source })
		const result = await reconcileLoyaltySource(ORG, source, { now: NOW })
		// Two units of item_1 at 3 points each; item_2 earns nothing.
		expect(result.purchase).toMatchObject({ awardedPoints: 6 })
	})

	it('categories: a line in two selected categories never counts twice', async () => {
		await activateProgram(
			ORG,
			programConfig({
				earning: {
					method: 'categories',
					points: 2,
					categoryIds: ['cat_a', 'cat_b'],
				},
			}),
		)
		const memberId = await member()
		const orderId = await insertOrder(ORG, {
			lines: [
				orderLine({
					itemId: 'item_1',
					quantity: 2,
					categoryIds: ['cat_a', 'cat_b'],
				}),
				orderLine({ itemId: 'item_2', categoryIds: ['cat_c'] }),
			],
			subtotalCents: 3000,
			totalCents: 3000,
		})
		const source = { type: 'restaurant_order' as const, id: orderId }
		await claimAndQueue(ORG, { memberId, source })
		const result = await reconcileLoyaltySource(ORG, source, { now: NOW })
		// Two units in overlapping categories: once per unit, 2 * 2 = 4.
		expect(result.purchase).toMatchObject({ awardedPoints: 4 })
	})

	it('fully discounted lines earn no item points', async () => {
		await activateProgram(
			ORG,
			programConfig({
				earning: { method: 'items', points: 3, itemIds: ['item_1'] },
			}),
		)
		const memberId = await member()
		// The whole order is covered by another discount: nothing eligible.
		const orderId = await insertOrder(ORG, {
			loyaltyDiscountCents: 1000,
			totalCents: 0,
		})
		const source = { type: 'restaurant_order' as const, id: orderId }
		await claimAndQueue(ORG, { memberId, source })
		const result = await reconcileLoyaltySource(ORG, source, { now: NOW })
		// The discount matches no redemption: review first, then awarded by an
		// operator it still earns nothing because the net is zero.
		expect(result.purchase!.state).toBe('review')
		const awarded = await resolvePurchase(ORG, {
			purchaseId: result.purchase!.id,
			action: 'award',
			note: 'known comp',
			actorId: 'op_test',
			locationIds: null,
			now: NOW,
		})
		expect(awarded).toMatchObject({
			awardedPoints: 0,
			skipReason: 'nothing_eligible',
		})
	})
})

describe('the outbox', () => {
	it('queueing again coalesces into one pending row', async () => {
		await activateProgram(ORG)
		const memberId = await member()
		const orderId = await insertOrder(ORG, {
			status: 'accepted',
			paymentStatus: 'unpaid',
			paidAt: null,
			completedAt: null,
		})
		const source = { type: 'restaurant_order' as const, id: orderId }
		await claimAndQueue(ORG, { memberId, source })
		await withLoyaltyWrite({ orgId: ORG, now: NOW }, async (tx, ctx) => {
			await queueLoyaltySourceInTx(tx, source, ctx.now)
			await queueLoyaltySourceInTx(tx, source, ctx.now)
		})
		const row = await readOutbox(source)
		expect(row).toMatchObject({ status: 'pending', attempts: 0 })
	})

	it('queueing a source loyalty does not track is a no-op', async () => {
		await activateProgram(ORG)
		await withLoyaltyWrite({ orgId: ORG, now: NOW }, async (tx, ctx) => {
			const queued = await queueLoyaltySourceInTx(
				tx,
				{ type: 'restaurant_order', id: 'ord_unknown' },
				ctx.now,
			)
			expect(queued).toBe(false)
		})
	})

	it('backs a failing source off and parks it after the last attempt', async () => {
		await activateProgram(ORG)
		const memberId = await member()
		breakTillSales()
		const source = { type: 'pos_order' as const, id: 'sale_broken' }
		await claimAndQueue(ORG, { memberId, source })
		const t0 = NOW
		const first = await processLoyaltyOutbox(ORG, { now: t0 })
		expect(first).toMatchObject({ processed: 0, failed: 1, parked: 0 })
		let row = (await readOutbox(source))!
		expect(row).toMatchObject({
			status: 'pending',
			attempts: 1,
			lastError: 'loyalty_unavailable',
			nextAttemptAt: t0 + loyaltyOutboxBackoffMs(1),
		})

		// Not due yet: nothing runs.
		const early = await processLoyaltyOutbox(ORG, {
			now: t0 + loyaltyOutboxBackoffMs(1) - 1,
		})
		expect(early).toMatchObject({ processed: 0, failed: 0 })

		let now = t0 + loyaltyOutboxBackoffMs(1)
		let parkedAt = 0
		for (let attempt = 2; attempt <= LOYALTY_OUTBOX_MAX_ATTEMPTS; attempt++) {
			const result = await processLoyaltyOutbox(ORG, { now })
			expect(result.failed).toBe(1)
			row = (await readOutbox(source))!
			if (attempt < LOYALTY_OUTBOX_MAX_ATTEMPTS) {
				expect(row.status).toBe('pending')
				expect(row.attempts).toBe(attempt)
				now = row.nextAttemptAt
			} else {
				expect(result.parked).toBe(1)
				expect(row.status).toBe('failed')
				parkedAt = now
			}
		}
		// Parking sends the purchase to review for an operator.
		expect(await readPurchase(source)).toMatchObject({
			state: 'review',
			reviewReason: 'reconciliation_failed',
		})
		expect(parkedAt).toBeGreaterThan(t0)
	})

	it('settling right after a sale never throws: a failing source stays queued', async () => {
		await activateProgram(ORG)
		const memberId = await member()
		registerLoyaltySourceAdapter({
			type: 'pos_order',
			async read() {
				throw new TypeError('source read failed')
			},
		})
		const source = { type: 'pos_order' as const, id: 'sale_settle_broken' }
		await claimAndQueue(ORG, { memberId, source })
		const loyalty = loyaltySettleQueue()
		await withLoyaltyWrite({ orgId: ORG, now: NOW }, async (tx, ctx) => {
			expect(await loyalty.queue(tx, source, ctx.now)).toBe(true)
		})
		// The sale already committed: a throw here would turn it into an error.
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
		try {
			await expect(loyalty.settle(ORG, { now: NOW })).resolves.toEqual({
				settled: 0,
				deferred: 1,
				nextAttemptAt: expect.any(Number),
			})
			expect(errorSpy).toHaveBeenCalledWith(
				'Loyalty reconciliation deferred',
				expect.objectContaining({
					orgId: ORG,
					sourceType: 'pos_order',
					sourceId: 'sale_settle_broken',
					error: 'TypeError',
				}),
			)
		} finally {
			errorSpy.mockRestore()
		}
		expect(await readOutbox(source)).toMatchObject({
			status: 'pending',
			attempts: 1,
			lastError: 'TypeError',
		})
	})

	it('an operator requeues a parked source, scoped to their locations', async () => {
		await activateProgram(ORG)
		const memberId = await member()
		breakTillSales()
		const source = { type: 'pos_order' as const, id: 'sale_parked' }
		await claimAndQueue(ORG, { memberId, source })
		let now = NOW
		for (let attempt = 1; attempt <= LOYALTY_OUTBOX_MAX_ATTEMPTS; attempt++) {
			await processLoyaltyOutbox(ORG, { now })
			now = (await readOutbox(source))!.nextAttemptAt
		}
		expect((await readOutbox(source))!.status).toBe('failed')

		await expectLoyaltyError(
			requeueLoyaltySource(ORG, {
				source,
				actorId: 'op_test',
				locationIds: [LOC_2],
				now,
			}),
			'location_forbidden',
		)
		const requeued = await requeueLoyaltySource(ORG, {
			source,
			actorId: 'op_test',
			locationIds: [LOC_1],
			now,
		})
		expect(requeued).toEqual({ queued: true })
		// The immediate settle attempt fails again (the source is still
		// broken), so the row is pending with one attempt.
		expect(await readOutbox(source)).toMatchObject({
			status: 'pending',
			attempts: 1,
		})
	})

	it('a parked source with nothing in review is listed for the operator until they try again', async () => {
		await activateProgram(ORG)
		const memberId = await member()
		const source = { type: 'pos_order' as const, id: 'sale_settled_parked' }
		const claimed = await claimAndQueue(ORG, { memberId, source })
		const db = await getTenantDb(ORG)
		// The sale settled earlier; what fails is a later change to it.
		await db
			.update(loyaltyPurchases)
			.set({ state: 'completed', occurredAt: NOW })
			.where(eq(loyaltyPurchases.id, claimed.id))
		breakTillSales()
		let now = NOW
		for (let attempt = 1; attempt <= LOYALTY_OUTBOX_MAX_ATTEMPTS; attempt++) {
			await processLoyaltyOutbox(ORG, { now })
			now = (await readOutbox(source))!.nextAttemptAt
		}
		const row = (await readOutbox(source))!
		expect(row.status).toBe('failed')
		// Parking sent nothing to review: the purchase had already settled.
		expect((await readPurchase(source))!.state).toBe('completed')
		expect(await countParkedLoyaltySources(db)).toBe(1)

		const parked = {
			sourceType: 'pos_order',
			sourceId: 'sale_settled_parked',
			memberId,
			locationId: LOC_1,
			attempts: LOYALTY_OUTBOX_MAX_ATTEMPTS,
			lastError: 'loyalty_unavailable',
			parkedAt: row.updatedAt,
		}
		expect(await getLoyaltyReviewQueue(db, { locationIds: null })).toEqual({
			redemptions: [],
			purchases: [],
			parked: [parked],
		})
		expect(
			(await getLoyaltyReviewQueue(db, { locationIds: [LOC_1] })).parked,
		).toEqual([parked])
		expect(
			(await getLoyaltyReviewQueue(db, { locationIds: [LOC_2] })).parked,
		).toEqual([])
		expect(
			(await getLoyaltyReviewQueue(db, { locationIds: [] })).parked,
		).toEqual([])

		expect(
			await requeueLoyaltySource(ORG, {
				source,
				actorId: 'op_test',
				locationIds: [LOC_1],
				now,
			}),
		).toEqual({ queued: true })
		expect(await countParkedLoyaltySources(db)).toBe(0)
		expect(
			(await getLoyaltyReviewQueue(db, { locationIds: null })).parked,
		).toEqual([])
	})

	it('trying again closes a parked source that has nothing left to reconcile', async () => {
		await activateProgram(ORG)
		const memberId = await member(10)
		const reward = await makeReward(ORG)
		breakTillSales()
		const source = { type: 'pos_order' as const, id: 'sale_hold_only' }
		// A till hold with no purchase behind it yet.
		const redemption = await reserveReward(ORG, {
			memberId,
			rewardId: reward.id,
			source,
			channel: 'pos',
		})
		await withLoyaltyWrite({ orgId: ORG, now: NOW }, async (tx, ctx) => {
			expect(await queueLoyaltySourceInTx(tx, source, ctx.now)).toBe(true)
		})
		let now = NOW
		for (let attempt = 1; attempt <= LOYALTY_OUTBOX_MAX_ATTEMPTS; attempt++) {
			await processLoyaltyOutbox(ORG, { now })
			now = (await readOutbox(source))!.nextAttemptAt
		}
		expect((await readOutbox(source))!.status).toBe('failed')
		// The hold expires afterwards: nothing is left on the source.
		await withLoyaltyWrite({ orgId: ORG, now }, async (tx, ctx) => {
			await releaseRedemptionInTx(tx, redemption, {
				reason: 'expired',
				at: ctx.now,
			})
		})
		const db = await getTenantDb(ORG)
		expect(
			(await getLoyaltyReviewQueue(db, { locationIds: [LOC_1] })).parked,
		).toEqual([
			expect.objectContaining({
				sourceId: 'sale_hold_only',
				memberId,
				locationId: LOC_1,
			}),
		])
		expect(
			(await getLoyaltyReviewQueue(db, { locationIds: [LOC_2] })).parked,
		).toEqual([])

		await expectLoyaltyError(
			requeueLoyaltySource(ORG, {
				source,
				actorId: 'op_test',
				locationIds: [LOC_2],
				now,
			}),
			'location_forbidden',
		)
		expect(
			await requeueLoyaltySource(ORG, {
				source,
				actorId: 'op_test',
				locationIds: [LOC_1],
				now: now + 1,
			}),
		).toEqual({ queued: false })
		expect(await readOutbox(source)).toMatchObject({
			status: 'done',
			doneAt: now + 1,
			lastError: null,
		})
		expect(await countParkedLoyaltySources(db)).toBe(0)
		expect(
			await db
				.select()
				.from(loyaltyAuditLog)
				.where(eq(loyaltyAuditLog.action, 'outbox.closed'))
				.all(),
		).toEqual([
			expect.objectContaining({
				actorKind: 'operator',
				actorId: 'op_test',
				locationId: LOC_1,
				entityType: 'outbox',
				entityId: 'pos_order:sale_hold_only',
			}),
		])
		// A source that never reached the outbox is still unknown.
		await expectLoyaltyError(
			requeueLoyaltySource(ORG, {
				source: { type: 'pos_order', id: 'sale_unknown' },
				actorId: 'op_test',
				locationIds: null,
				now,
			}),
			'purchase_not_found',
		)
	})

	it.each([
		['the redemption, then the purchase', ['redemption', 'purchase']],
		['the purchase, then the redemption', ['purchase', 'redemption']],
	] as const)(
		'a parked source stays parked until the operator answers %s',
		async (_label, order) => {
			await activateProgram(ORG)
			const memberId = await member(10)
			const reward = await makeReward(ORG)
			breakTillSales()
			const source = {
				type: 'pos_order' as const,
				id: `sale_answered_${order[0]}`,
			}
			await claimAndQueue(ORG, { memberId, source })
			const redemption = await reserveReward(ORG, {
				memberId,
				rewardId: reward.id,
				source,
				channel: 'pos',
			})
			let now = NOW
			for (let attempt = 1; attempt <= LOYALTY_OUTBOX_MAX_ATTEMPTS; attempt++) {
				await processLoyaltyOutbox(ORG, { now })
				now = (await readOutbox(source))!.nextAttemptAt
			}
			const db = await getTenantDb(ORG)
			expect((await readOutbox(source))!.status).toBe('failed')
			expect(await countParkedLoyaltySources(db)).toBe(1)
			const purchase = (await readPurchase(source))!
			expect(purchase.state).toBe('review')
			expect((await readRedemptionInTx(db, redemption.id))!.state).toBe(
				'review',
			)
			// Its review items stand for it in the queue; it is not listed twice.
			expect(
				(await getLoyaltyReviewQueue(db, { locationIds: null })).parked,
			).toEqual([])

			const answer = {
				redemption: () =>
					resolveRedemption(ORG, {
						redemptionId: redemption.id,
						action: 'release',
						note: 'sale voided at the till',
						actorId: 'op_test',
						locationIds: null,
						now,
					}),
				purchase: () =>
					resolvePurchase(ORG, {
						purchaseId: purchase.id,
						action: 'exclude',
						note: 'sale voided at the till',
						actorId: 'op_test',
						locationIds: null,
						now,
					}),
			}
			await answer[order[0]]()
			// The other item still waits in review, so the source stays parked.
			expect((await readOutbox(source))!.status).toBe('failed')
			expect(await countParkedLoyaltySources(db)).toBe(1)
			await answer[order[1]]()
			expect(await readOutbox(source)).toMatchObject({
				status: 'done',
				lastError: null,
			})
			expect(await countParkedLoyaltySources(db)).toBe(0)
		},
	)
})

describe('operator purchase decisions', () => {
	it('awards a reviewed purchase the operator vouches for', async () => {
		await activateProgram(ORG)
		const memberId = await member()
		const orderId = await insertOrder(ORG, { loyaltyDiscountCents: 300 })
		const source = { type: 'restaurant_order' as const, id: orderId }
		await claimAndQueue(ORG, { memberId, source })
		const result = await reconcileLoyaltySource(ORG, source, { now: NOW })
		expect(result.purchase!.reviewReason).toBe('redemption_unknown')

		const awarded = await resolvePurchase(ORG, {
			purchaseId: result.purchase!.id,
			action: 'award',
			note: 'till confirmed the comp',
			actorId: 'op_test',
			locationIds: null,
			now: NOW,
		})
		expect(awarded).toMatchObject({ state: 'completed' })
		// The 300-minor sale-level discount spread over the single 1000 line.
		expect(awarded.eligibleMinor).toBe(700)
		expect(awarded.awardedPoints).toBe(7)
		expect((await balanceOf(ORG, memberId)).points).toBe(7)
	})

	it('excludes a reviewed purchase and refuses decisions outside review', async () => {
		await activateProgram(ORG)
		const memberId = await member()
		const orderId = await insertOrder(ORG, {
			paymentMethod: 'handoff',
			paymentStatus: 'unpaid',
			paidAt: null,
		})
		const source = { type: 'restaurant_order' as const, id: orderId }
		await claimAndQueue(ORG, { memberId, source })
		const result = await reconcileLoyaltySource(ORG, source, { now: NOW })
		const excluded = await resolvePurchase(ORG, {
			purchaseId: result.purchase!.id,
			action: 'exclude',
			note: 'never paid',
			actorId: 'op_test',
			locationIds: null,
			now: NOW,
		})
		expect(excluded).toMatchObject({
			state: 'excluded',
			excludedReason: 'operator_excluded',
		})
		await expectLoyaltyError(
			resolvePurchase(ORG, {
				purchaseId: result.purchase!.id,
				action: 'award',
				note: 'too late',
				actorId: 'op_test',
				locationIds: null,
				now: NOW,
			}),
			'invalid_transition',
		)
	})

	it('refuses an operator who cannot see the purchase location', async () => {
		await activateProgram(ORG)
		const memberId = await member()
		const orderId = await insertOrder(ORG, {
			paymentMethod: 'handoff',
			paymentStatus: 'unpaid',
			paidAt: null,
		})
		const source = { type: 'restaurant_order' as const, id: orderId }
		await claimAndQueue(ORG, { memberId, source })
		const result = await reconcileLoyaltySource(ORG, source, { now: NOW })
		await expectLoyaltyError(
			resolvePurchase(ORG, {
				purchaseId: result.purchase!.id,
				action: 'exclude',
				note: 'nope',
				actorId: 'op_test',
				locationIds: [LOC_2],
				now: NOW,
			}),
			'location_forbidden',
		)
	})
})

describe('QR tabs', () => {
	it('earns once at settlement, however many rounds and however often reconciled', async () => {
		await activateProgram(ORG)
		const memberId = await member()
		const tabId = await insertTab(ORG, {
			subtotalCents: 3000,
			totalCents: 3000,
		})
		await insertRound(ORG, tabId, { lines: [orderLine({ quantity: 2 })] })
		await insertRound(ORG, tabId)
		const source = { type: 'qr_tab' as const, id: tabId }
		await claimAndQueue(ORG, { memberId, source })
		const result = await reconcileLoyaltySource(ORG, source, { now: NOW })
		expect(result.purchase).toMatchObject({
			state: 'completed',
			awardedPoints: 30,
			eligibleMinor: 3000,
		})
		expect((await balanceOf(ORG, memberId)).points).toBe(30)

		const again = await reconcileLoyaltySource(ORG, source, { now: NOW })
		expect(again.purchase!.awardedPoints).toBe(30)
		expect((await balanceOf(ORG, memberId)).points).toBe(30)

		// A round is never a purchase of its own.
		const db = await getTenantDb(ORG)
		const rounds = await db
			.select({ id: restaurantOrders.id })
			.from(restaurantOrders)
			.where(eq(restaurantOrders.tabId, tabId))
		for (const round of rounds) {
			const roundSource = {
				type: 'restaurant_order' as const,
				id: round.id,
			}
			const missing = await reconcileLoyaltySource(ORG, roundSource, {
				now: NOW,
			})
			expect(missing.verdict).toBe('untracked')
		}
	})

	it('consumes the bound reward only when the tab is paid from the phone', async () => {
		await activateProgram(ORG)
		const memberId = await member(10)
		const reward = await makeReward(ORG)
		const tabId = await insertTab(ORG, { loyaltyDiscountCents: 500 })
		await insertRound(ORG, tabId)
		const source = { type: 'qr_tab' as const, id: tabId }
		const redemption = await reserveReward(ORG, {
			memberId,
			rewardId: reward.id,
			source,
			channel: 'qr',
		})
		await claimAndQueue(ORG, { memberId, source })
		const result = await reconcileLoyaltySource(ORG, source, { now: NOW })
		expect(result.purchase).toMatchObject({ state: 'completed' })
		const db = await getTenantDb(ORG)
		expect((await readRedemptionInTx(db, redemption.id))!.state).toBe(
			'consumed',
		)
	})

	it('a counter close releases the reward but the tab still earns', async () => {
		await activateProgram(ORG)
		const memberId = await member(10)
		const reward = await makeReward(ORG)
		const tabId = await insertTab(ORG, {
			paymentMethod: 'counter',
			loyaltyDiscountCents: 0,
		})
		await insertRound(ORG, tabId)
		const source = { type: 'qr_tab' as const, id: tabId }
		const redemption = await reserveReward(ORG, {
			memberId,
			rewardId: reward.id,
			source,
			channel: 'qr',
		})
		await claimAndQueue(ORG, { memberId, source })
		const result = await reconcileLoyaltySource(ORG, source, { now: NOW })
		expect(result.purchase).toMatchObject({
			state: 'completed',
			awardedPoints: 10,
		})
		const db = await getTenantDb(ORG)
		expect(await readRedemptionInTx(db, redemption.id)).toMatchObject({
			state: 'released',
			releaseReason: 'counter_close',
		})
		expect(await balanceOf(ORG, memberId)).toMatchObject({
			points: 20,
			reserved: 0,
		})
	})

	it('a counter close rung up on Station earns nothing on the tab', async () => {
		await activateProgram(ORG)
		const memberId = await member(10)
		const reward = await makeReward(ORG)
		const tabId = await insertTab(ORG, {
			paymentMethod: 'counter',
			rungUpOnStation: true,
		})
		await insertRound(ORG, tabId)
		const source = { type: 'qr_tab' as const, id: tabId }
		const redemption = await reserveReward(ORG, {
			memberId,
			rewardId: reward.id,
			source,
			channel: 'qr',
		})
		await claimAndQueue(ORG, { memberId, source })
		const result = await reconcileLoyaltySource(ORG, source, { now: NOW })
		expect(result.verdict).toBe('excluded')
		expect(result.purchase).toMatchObject({
			state: 'excluded',
			excludedReason: 'rung_up_on_station',
		})
		const db = await getTenantDb(ORG)
		expect(await readRedemptionInTx(db, redemption.id)).toMatchObject({
			state: 'released',
			releaseReason: 'counter_close',
		})
		expect(await balanceOf(ORG, memberId)).toMatchObject({
			points: 10,
			reserved: 0,
		})
	})

	it('an open tab and a cancelled tab never earn', async () => {
		await activateProgram(ORG)
		const memberId = await member()
		const openTab = await insertTab(ORG, {
			status: 'open',
			paymentMethod: null,
			paymentStatus: 'unpaid',
			paidAt: null,
			closedAt: null,
		})
		const openSource = { type: 'qr_tab' as const, id: openTab }
		await claimAndQueue(ORG, { memberId, source: openSource })
		const openResult = await reconcileLoyaltySource(ORG, openSource, {
			now: NOW,
		})
		expect(openResult.purchase!.state).toBe('open')

		const cancelledTab = await insertTab(ORG, {
			status: 'cancelled',
			paymentMethod: null,
			paymentStatus: 'unpaid',
			paidAt: null,
			voidReason: 'guest_left',
		})
		const cancelledSource = { type: 'qr_tab' as const, id: cancelledTab }
		await claimAndQueue(ORG, { memberId, source: cancelledSource })
		const cancelledResult = await reconcileLoyaltySource(ORG, cancelledSource, {
			now: NOW,
		})
		expect(cancelledResult.purchase).toMatchObject({
			state: 'excluded',
			excludedReason: 'cancelled',
		})
	})
})
