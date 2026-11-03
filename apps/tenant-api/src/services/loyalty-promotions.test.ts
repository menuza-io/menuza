import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loyaltyPromotionSchema, type LoyaltyPromotion } from '@repo/loyalty'
import {
	destroyTenantDb,
	getTenantDb,
	loyaltyLedger,
	loyaltyPurchases,
	provisionTenantDb,
} from '@repo/tenant-db'
import { and, asc, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reconcileLoyaltySource } from './loyalty-purchase-service.ts'
import { getLoyaltyReport } from './loyalty-report-service.ts'
import { saveProgram } from './loyalty-program-service.ts'
import {
	activateProgram,
	assertBalancesMatchLedger,
	balanceOf,
	claimAndQueue,
	insertCustomer,
	insertOrder,
	makeMember,
	NOW,
	programConfig,
} from './loyalty-test-fixture.ts'
import { recordOrderRefund } from './order-refund-service.ts'

/**
 * Promotions through the real purchase path: a promotion in the program
 * version in force when the sale finished adds bonus points to the one `earn`
 * entry, refunds take them back with the base points, and editing the program
 * later never changes a past award. The sale is a paid, completed 1000-minor
 * online order finished at NOW (Saturday 2026-01-10 12:00 UTC); 1 point per
 * $1 earns 10.
 */

const ORG = 'org_ll_promo'
const OPERATOR = 'op_promo'

let directory: string
let customerCounter = 0
let keyCounter = 0

function promotion(extra: Partial<LoyaltyPromotion> = {}): LoyaltyPromotion {
	return loyaltyPromotionSchema.parse({
		id: 'double',
		name: 'Double points',
		kind: 'multiplier',
		value: 20_000,
		...extra,
	})
}

async function memberWith(): Promise<string> {
	const customerId = `cus_${++customerCounter}`
	await insertCustomer(ORG, { id: customerId })
	return makeMember(ORG, { customerId })
}

async function earn(memberId: string, locationId = 'loc_1') {
	const orderId = await insertOrder(ORG, { locationId })
	const source = { type: 'restaurant_order' as const, id: orderId }
	await claimAndQueue(ORG, { memberId, source, locationId })
	await reconcileLoyaltySource(ORG, source, { now: NOW })
	return orderId
}

async function purchaseOf(orderId: string) {
	const db = await getTenantDb(ORG)
	return db
		.select()
		.from(loyaltyPurchases)
		.where(
			and(
				eq(loyaltyPurchases.sourceType, 'restaurant_order'),
				eq(loyaltyPurchases.sourceId, orderId),
			),
		)
		.get()
}

async function refund(orderId: string, amountCents: number) {
	const result = await recordOrderRefund(ORG, orderId, {
		request: { amountCents, note: 'Returned' },
		actorId: OPERATOR,
		idempotencyKey: `promo-refund-${++keyCounter}`,
		loyaltyAccess: { refundLoyalty: true, impersonated: false },
		now: NOW,
	})
	if (!result.ok) throw new Error(`refund refused: ${result.failure.code}`)
}

async function ledgerOf(memberId: string) {
	const db = await getTenantDb(ORG)
	const rows = await db
		.select()
		.from(loyaltyLedger)
		.where(eq(loyaltyLedger.memberId, memberId))
		.orderBy(asc(loyaltyLedger.at), asc(loyaltyLedger.type))
	return rows
		.filter((row) => row.purchaseId !== null)
		.map((row) => [row.type, row.delta])
}

beforeEach(async () => {
	directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loyalty-promo-'))
	vi.stubEnv('TENANT_DB_DIR', directory)
	vi.stubEnv('DATA_REGION', 'us')
	vi.stubEnv('AUTH_HMAC_SECRET', 'test-hmac-secret-123456789')
	await provisionTenantDb(ORG)
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

describe('promotions on a settled purchase', () => {
	it('adds the bonus to the one earn entry and records what applied', async () => {
		await activateProgram(ORG, programConfig({ promotions: [promotion()] }))
		const memberId = await memberWith()
		const orderId = await earn(memberId)

		expect(await ledgerOf(memberId)).toEqual([['earn', 20]])
		expect((await balanceOf(ORG, memberId)).points).toBe(20)
		expect(await purchaseOf(orderId)).toMatchObject({
			awardedPoints: 20,
			bonusPoints: 10,
			appliedPromotions: [{ id: 'double', name: 'Double points', points: 10 }],
		})
	})

	it('a purchase outside the promotion gets only the base award', async () => {
		// NOW is a Saturday (6); the window is Monday only.
		await activateProgram(
			ORG,
			programConfig({
				promotions: [
					promotion({
						recurring: { weekdays: [1], fromMinute: 0, toMinute: 1440 },
					}),
				],
			}),
		)
		const memberId = await memberWith()
		const orderId = await earn(memberId)
		expect((await balanceOf(ORG, memberId)).points).toBe(10)
		expect(await purchaseOf(orderId)).toMatchObject({
			awardedPoints: 10,
			bonusPoints: 0,
			appliedPromotions: null,
		})
	})

	it('a promotion for another location gives nothing here', async () => {
		await activateProgram(
			ORG,
			programConfig({ promotions: [promotion({ locationIds: ['loc_2'] })] }),
		)
		const memberId = await memberWith()
		await earn(memberId, 'loc_1')
		expect((await balanceOf(ORG, memberId)).points).toBe(10)
		const second = await earn(memberId, 'loc_2')
		expect((await balanceOf(ORG, memberId)).points).toBe(30)
		expect((await purchaseOf(second))?.bonusPoints).toBe(10)
	})

	it('a flat bonus for the whole order adds once per purchase', async () => {
		await activateProgram(
			ORG,
			programConfig({
				promotions: [promotion({ kind: 'bonus', value: 5 })],
			}),
		)
		const memberId = await memberWith()
		await earn(memberId)
		expect((await balanceOf(ORG, memberId)).points).toBe(15)
	})
})

describe('refunds of a boosted purchase', () => {
	it('take the bonus back in proportion, with the base points', async () => {
		await activateProgram(ORG, programConfig({ promotions: [promotion()] }))
		const memberId = await memberWith()
		const orderId = await earn(memberId)

		// 250 of 1000 back: 750 remain. Base keeps 7, bonus keeps 7 (of 10).
		await refund(orderId, 250)
		expect((await balanceOf(ORG, memberId)).points).toBe(14)
		expect(await purchaseOf(orderId)).toMatchObject({
			awardedPoints: 20,
			bonusPoints: 10,
			reversedPoints: 6,
		})

		// The rest comes back: nothing stays.
		await refund(orderId, 750)
		expect((await balanceOf(ORG, memberId)).points).toBe(0)
		expect(await ledgerOf(memberId)).toEqual([
			['earn', 20],
			['earn_reversal', -6],
			['earn_reversal', -14],
		])
	})

	it('editing or removing the promotion later never changes a past award or its reversal', async () => {
		const first = await activateProgram(
			ORG,
			programConfig({ promotions: [promotion()] }),
		)
		const memberId = await memberWith()
		const orderId = await earn(memberId)

		// The operator drops the promotion after the sale.
		await saveProgram(ORG, {
			expectedVersion: first.version,
			config: programConfig({ promotions: [] }),
			actorId: OPERATOR,
			now: NOW + 1000,
		})
		await refund(orderId, 250)
		// Still judged by the snapshot: 14 of 20 kept, as if it never changed.
		expect((await balanceOf(ORG, memberId)).points).toBe(14)
		expect(await purchaseOf(orderId)).toMatchObject({
			awardedPoints: 20,
			bonusPoints: 10,
		})
	})
})

describe('promotion figures in the report', () => {
	it('counts the bonus points and what each promotion gave', async () => {
		await activateProgram(
			ORG,
			programConfig({
				promotions: [
					promotion(),
					promotion({
						id: 'second',
						name: 'Second store',
						kind: 'bonus',
						value: 3,
						locationIds: ['loc_2'],
					}),
				],
				promotionStacking: 'add',
			}),
		)
		const memberId = await memberWith()
		await earn(memberId, 'loc_1') // +10 from "double"
		await earn(memberId, 'loc_2') // +10 and +3

		const db = await getTenantDb(ORG)
		const query = { from: '2026-01-10', to: '2026-01-10' }
		const report = await getLoyaltyReport(db, query, { now: NOW })
		expect(report.promotions.bonusPoints).toBe(23)
		expect(report.promotions.byPromotion).toEqual([
			{ id: 'double', name: 'Double points', points: 20, purchases: 2 },
			{ id: 'second', name: 'Second store', points: 3, purchases: 1 },
		])

		// A report scoped to loc_1 counts only its own purchases.
		const scoped = await getLoyaltyReport(db, query, {
			now: NOW,
			locationIds: ['loc_1'],
		})
		expect(scoped.promotions.bonusPoints).toBe(10)
		expect(scoped.promotions.byPromotion).toEqual([
			{ id: 'double', name: 'Double points', points: 10, purchases: 1 },
		])
	})

	it('is empty for a program with no promotions', async () => {
		await activateProgram(ORG)
		const memberId = await memberWith()
		await earn(memberId)
		const db = await getTenantDb(ORG)
		const report = await getLoyaltyReport(
			db,
			{ from: '2026-01-10', to: '2026-01-10' },
			{ now: NOW },
		)
		expect(report.promotions).toEqual({ bonusPoints: 0, byPromotion: [] })
	})
})
