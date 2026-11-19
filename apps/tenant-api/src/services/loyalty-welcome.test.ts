import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	destroyTenantDb,
	getTenantDb,
	loyaltyLedger,
	loyaltyMembers,
	provisionTenantDb,
	restaurantOrderRefunds,
	restaurantOrders,
} from '@repo/tenant-db'
import { desc, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderOrderEmail } from '../lib/order-messages-email.ts'
import '../restaurant/loyalty-sources.ts'
import {
	ensureMemberForCustomer,
	getWallet,
	setMemberStatus,
} from './loyalty-member-service.ts'
import { readProgramInTx, saveProgram } from './loyalty-program-service.ts'
import { reconcileLoyaltySource } from './loyalty-purchase-service.ts'
import { getLoyaltyReport } from './loyalty-report-service.ts'
import { welcomeBonusForOrderReceipt } from './loyalty-welcome-service.ts'
import { erasePerson } from './person-erasure-service.ts'
import {
	activateProgram,
	ACTOR,
	assertBalancesMatchLedger,
	balanceOf,
	claimAndQueue,
	DAY,
	HOUR,
	insertCustomer,
	insertOrder,
	NOW,
	programConfig,
} from './loyalty-test-fixture.ts'

const ORG = 'org_ll_welcome'
const FEATURES_ON = { enabled: true, redemption: true, referrals: false }

let directory: string

beforeEach(async () => {
	directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loyalty-welcome-'))
	vi.stubEnv('TENANT_DB_DIR', directory)
	vi.stubEnv('DATA_REGION', 'us')
	vi.stubEnv('AUTH_HMAC_SECRET', 'test-hmac-secret-123456789')
	await provisionTenantDb(ORG)
})

afterEach(async () => {
	try {
		await assertBalancesMatchLedger(ORG)
	} finally {
		vi.unstubAllEnvs()
		await destroyTenantDb(ORG)
		fs.rmSync(directory, { recursive: true, force: true })
	}
})

describe('#293 welcome bonus', () => {
	it('grants the bonus once on sign-up, shows it in wallet and confirmation email, and never grants again after erasure', async () => {
		await activateProgram(
			ORG,
			programConfig({
				welcomeBonus: { enabled: true, points: 50, afterFirstPaidOrder: false },
			}),
		)
		const db = await getTenantDb(ORG)
		await insertCustomer(ORG, {
			id: 'cus_alice',
			name: 'Alice',
			phone: '+14155550101',
			verified: true,
		})

		const alice = (await ensureMemberForCustomer(ORG, {
			customerId: 'cus_alice',
			now: NOW,
		}))!
		// Re-calling enrollment never grants a second time
		await ensureMemberForCustomer(ORG, {
			customerId: 'cus_alice',
			now: NOW + 1000,
		})

		expect((await balanceOf(ORG, alice.id)).points).toBe(50)
		const wallet = await getWallet(db, {
			customerId: 'cus_alice',
			orgId: ORG,
			features: FEATURES_ON,
			now: NOW + 1000,
		})
		expect(wallet!.welcomeBonus).toEqual({
			status: 'granted',
			points: 50,
			grantedAt: NOW,
		})

		// First order placed shortly after enrollment carries the welcome bonus line on receipt & email
		const ordId = await insertOrder(ORG, {
			id: 'ord_alice_1',
			customerId: 'cus_alice',
			subtotalCents: 1200,
			totalCents: 1200,
			createdAt: new Date(NOW + 60_000),
		})
		const receiptBonus = await welcomeBonusForOrderReceipt(db, {
			orderId: ordId,
			customerId: 'cus_alice',
			orderCreatedAt: NOW + 60_000,
		})
		expect(receiptBonus).toEqual({ points: 50, unitLabel: 'points' })
		const orderRow = await db
			.select()
			.from(restaurantOrders)
			.where(eq(restaurantOrders.id, ordId))
			.get()
		const renderedEn = renderOrderEmail({
			kind: 'receipt',
			locale: 'en',
			theme: null,
			restaurantName: 'Bistro',
			order: orderRow!,
			timeZone: 'UTC',
			linkUrl: null,
			welcomeBonus: receiptBonus,
		})
		expect(renderedEn.text).toContain('Welcome! 50 points added')
		expect(renderedEn.html).toContain('Welcome! 50 points added')

		const renderedAr = renderOrderEmail({
			kind: 'receipt',
			locale: 'ar',
			theme: null,
			restaurantName: 'بيسترو',
			order: orderRow!,
			timeZone: 'UTC',
			linkUrl: null,
			welcomeBonus: receiptBonus,
		})
		expect(renderedAr.text).toContain('أهلاً بك! تمت إضافة 50 نقطة')

		// Ledger stores `welcome`
		const ledgerRows = await db
			.select()
			.from(loyaltyLedger)
			.where(eq(loyaltyLedger.memberId, alice.id))
			.orderBy(desc(loyaltyLedger.at))
			.all()
		expect(ledgerRows.map((r) => [r.type, r.delta])).toEqual([['welcome', 50]])

		// Changing the welcome amount affects new members only
		const current = (await readProgramInTx(db))!
		await saveProgram(ORG, {
			expectedVersion: current.program.version,
			config: programConfig({
				welcomeBonus: {
					enabled: true,
					points: 100,
					afterFirstPaidOrder: false,
				},
			}),
			actorId: ACTOR,
			now: NOW + HOUR,
		})
		expect((await balanceOf(ORG, alice.id)).points).toBe(50)

		await insertCustomer(ORG, {
			id: 'cus_bob',
			name: 'Bob',
			phone: '+14155550102',
			verified: true,
		})
		const bob = (await ensureMemberForCustomer(ORG, {
			customerId: 'cus_bob',
			now: NOW + HOUR + 1000,
		}))!
		expect((await balanceOf(ORG, bob.id)).points).toBe(100)

		// Erasing Alice and re-joining with her verified phone gives nothing
		await erasePerson(
			db,
			{ customerId: 'cus_alice' },
			{ actorId: ACTOR, now: NOW + DAY },
		)
		await insertCustomer(ORG, {
			id: 'cus_alice_2',
			name: 'Alice Back',
			phone: '+1 415 555 0101',
			verified: true,
		})
		const alice2 = (await ensureMemberForCustomer(ORG, {
			customerId: 'cus_alice_2',
			now: NOW + DAY + 1000,
		}))!
		expect((await balanceOf(ORG, alice2.id)).points).toBe(0)
		const alice2Wallet = await getWallet(db, {
			customerId: 'cus_alice_2',
			orgId: ORG,
			features: FEATURES_ON,
			now: NOW + DAY + 1000,
		})
		expect(alice2Wallet!.welcomeBonus?.status).toBe('ineligible')
	})

	it('refuses imported or suspended members and claws back after-first-order bonus on refund', async () => {
		await activateProgram(
			ORG,
			programConfig({
				minimumSpendMinor: 500,
				earning: { method: 'spend', points: 1, perMinor: 100 },
				welcomeBonus: { enabled: true, points: 75, afterFirstPaidOrder: true },
			}),
		)
		const db = await getTenantDb(ORG)

		// Imported member gets nothing on first order
		await insertCustomer(ORG, {
			id: 'cus_imp',
			name: 'Imported',
			phone: '+14155550201',
			verified: true,
		})
		const imp = (await ensureMemberForCustomer(ORG, {
			customerId: 'cus_imp',
			now: NOW,
		}))!
		await db
			.update(loyaltyMembers)
			.set({ imported: true })
			.where(eq(loyaltyMembers.id, imp.id))
		const impOrd = await insertOrder(ORG, {
			id: 'ord_imp_1',
			customerId: 'cus_imp',
			subtotalCents: 1000,
			totalCents: 1000,
		})
		const impSrc = { type: 'restaurant_order' as const, id: impOrd }
		await claimAndQueue(ORG, { memberId: imp.id, source: impSrc, at: NOW })
		await reconcileLoyaltySource(ORG, impSrc, { now: NOW })
		expect((await balanceOf(ORG, imp.id)).points).toBe(10) // earned 10, no 75 welcome

		// Normal member: wallet shows pending_first_order until first paid order completes
		await insertCustomer(ORG, {
			id: 'cus_carol',
			name: 'Carol',
			phone: '+14155550202',
			verified: true,
		})
		const carol = (await ensureMemberForCustomer(ORG, {
			customerId: 'cus_carol',
			now: NOW,
		}))!
		expect((await balanceOf(ORG, carol.id)).points).toBe(0)
		const beforeWallet = await getWallet(db, {
			customerId: 'cus_carol',
			orgId: ORG,
			features: FEATURES_ON,
			now: NOW,
		})
		expect(beforeWallet!.welcomeBonus).toEqual({
			status: 'pending_first_order',
			points: 75,
			grantedAt: null,
		})

		// Suspended member does not receive the bonus when a claimed order settles
		const carolOrd = await insertOrder(ORG, {
			id: 'ord_carol_1',
			customerId: 'cus_carol',
			subtotalCents: 2000,
			totalCents: 2000,
		})
		const carolSrc = { type: 'restaurant_order' as const, id: carolOrd }
		await claimAndQueue(ORG, { memberId: carol.id, source: carolSrc, at: NOW })
		await setMemberStatus(ORG, {
			memberId: carol.id,
			status: 'suspended',
			actorId: ACTOR,
			now: NOW + 1000,
		})
		await reconcileLoyaltySource(ORG, carolSrc, { now: NOW + 2000 })
		expect((await balanceOf(ORG, carol.id)).points).toBe(0)

		// Active members Dan & Eve: verify grant + repeat-30d report + refund clawback
		await insertCustomer(ORG, {
			id: 'cus_dan',
			name: 'Dan',
			phone: '+14155550203',
			verified: true,
		})
		const dan = (await ensureMemberForCustomer(ORG, {
			customerId: 'cus_dan',
			now: NOW,
		}))!
		const danOrd1 = await insertOrder(ORG, {
			id: 'ord_dan_1',
			customerId: 'cus_dan',
			subtotalCents: 1000,
			totalCents: 1000,
			completedAt: new Date(NOW + 1000),
		})
		const danSrc1 = { type: 'restaurant_order' as const, id: danOrd1 }
		await claimAndQueue(ORG, {
			memberId: dan.id,
			source: danSrc1,
			at: NOW + 1000,
		})
		await reconcileLoyaltySource(ORG, danSrc1, { now: NOW + 1000 })
		expect((await balanceOf(ORG, dan.id)).points).toBe(85) // 10 earn + 75 welcome

		await insertCustomer(ORG, {
			id: 'cus_eve',
			name: 'Eve',
			phone: '+14155550204',
			verified: true,
		})
		const eve = (await ensureMemberForCustomer(ORG, {
			customerId: 'cus_eve',
			now: NOW,
		}))!
		const eveOrd1 = await insertOrder(ORG, {
			id: 'ord_eve_1',
			customerId: 'cus_eve',
			subtotalCents: 1000,
			totalCents: 1000,
			completedAt: new Date(NOW + 1000),
		})
		const eveSrc1 = { type: 'restaurant_order' as const, id: eveOrd1 }
		await claimAndQueue(ORG, {
			memberId: eve.id,
			source: eveSrc1,
			at: NOW + 1000,
		})
		await reconcileLoyaltySource(ORG, eveSrc1, { now: NOW + 1000 })

		const eveOrd2 = await insertOrder(ORG, {
			id: 'ord_eve_2',
			customerId: 'cus_eve',
			subtotalCents: 1000,
			totalCents: 1000,
			completedAt: new Date(NOW + 5 * DAY),
		})
		const eveSrc2 = { type: 'restaurant_order' as const, id: eveOrd2 }
		await claimAndQueue(ORG, {
			memberId: eve.id,
			source: eveSrc2,
			at: NOW + 5 * DAY,
		})
		await reconcileLoyaltySource(ORG, eveSrc2, { now: NOW + 5 * DAY })
		expect((await balanceOf(ORG, eve.id)).points).toBe(95) // 10 + 75 + 10

		const reportBeforeRefund = await getLoyaltyReport(
			db,
			{
				from: '2026-01-10',
				to: '2026-01-20',
			},
			{ locationIds: null, now: NOW + 6 * DAY },
		)
		expect(reportBeforeRefund.welcome).toEqual({
			bonusesGiven: 2,
			pointsGiven: 150,
			repeatOrders30d: 1,
			repeatRate30dBp: 5000,
		})

		// Full refund on Dan's first order reverses BOTH earn (10) and welcome bonus (75)
		await db.insert(restaurantOrderRefunds).values({
			id: 'ref_dan_1',
			orderId: danOrd1,
			amountCents: 1000,
			currency: 'USD',
			full: true,
			status: 'succeeded',
			actorId: ACTOR,
			idempotencyKey: 'ref-dan-1',
			requestHash: 'req-ref-dan-1',
			createdAt: NOW + 2 * DAY,
		})
		await db
			.update(restaurantOrders)
			.set({ refundedCents: 1000 })
			.where(eq(restaurantOrders.id, danOrd1))
		await reconcileLoyaltySource(ORG, danSrc1, { now: NOW + 2 * DAY })
		expect((await balanceOf(ORG, dan.id)).points).toBe(0)
	})
})
