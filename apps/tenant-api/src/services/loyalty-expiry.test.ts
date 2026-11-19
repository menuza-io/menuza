import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { addExpiryMonths, LoyaltyDomainError } from '@repo/loyalty'
import {
	customers,
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withLoyaltyWrite } from '../lib/loyalty-write.ts'
import '../restaurant/loyalty-sources.ts'
import { getWallet, readMemberInTx } from './loyalty-member-service.ts'
import { setLoyaltyNoticeTransportForTest } from './loyalty-notices-service.ts'
import { readRewardInTx, saveProgram } from './loyalty-program-service.ts'
import { reconcileLoyaltySource } from './loyalty-purchase-service.ts'
import {
	bindRedemptionInTx,
	consumeRedemptionInTx,
	reserveRedemptionInTx,
} from './loyalty-redemption-service.ts'
import { getLoyaltyReport } from './loyalty-report-service.ts'
import { runLoyaltyTickForOrg } from './loyalty-tick-service.ts'
import { setCustomerSubscription } from './marketing-audience.ts'
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
	orderLine,
	programConfig,
	rewardDefinition,
} from './loyalty-test-fixture.ts'

const ORG = 'org_ll_expiry'
const FEATURES_ON = { enabled: true, redemption: true, referrals: false }

let directory: string

beforeEach(async () => {
	directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loyalty-expiry-'))
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

describe('#307 loyalty points expiry', () => {
	it('expires oldest points FIFO after configured months, subtracts earlier spends, and sends deduplicated 30d/7d warnings', async () => {
		const notices: Array<{
			memberId: string
			kind: string
			channel: string
			text: string
		}> = []
		setLoyaltyNoticeTransportForTest(async (delivery) => {
			notices.push({
				memberId: delivery.memberId,
				kind: delivery.kind,
				channel: delivery.channel,
				text: delivery.text,
			})
		})

		await activateProgram(
			ORG,
			programConfig({
				earning: { method: 'spend', points: 10, perMinor: 100 }, // 10 pts / $1
				expiry: { mode: 'after_earn', months: 6, enabledAt: null },
			}),
			NOW,
		)
		const db = await getTenantDb(ORG)
		await insertCustomer(ORG, {
			id: 'cus_e1',
			name: 'Lina',
			phone: '+14155550301',
			verified: true,
		})
		await db
			.update(customers)
			.set({ email: 'lina@example.com' })
			.where(eq(customers.id, 'cus_e1'))

		const memberId = await makeMember(ORG, { customerId: 'cus_e1', now: NOW })

		// Lot 1: $10 at NOW -> 100 pts (expires at addExpiryMonths(NOW, 6))
		const o1 = await insertOrder(ORG, {
			customerId: 'cus_e1',
			subtotalCents: 1000,
			totalCents: 1000,
			createdAt: new Date(NOW),
			paidAt: new Date(NOW),
			completedAt: new Date(NOW),
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

		// Lot 2: $8 at NOW + 45 * DAY -> 80 pts
		const t2 = NOW + 45 * DAY
		const o2 = await insertOrder(ORG, {
			customerId: 'cus_e1',
			subtotalCents: 800,
			totalCents: 800,
			lines: [
				orderLine({
					unitPriceCents: 800,
					baseUnitCents: 800,
					totalCents: 800,
					taxableUnitCents: 800,
					taxableCents: 800,
				}),
			],
			createdAt: new Date(t2),
			paidAt: new Date(t2),
			completedAt: new Date(t2),
		})
		await claimAndQueue(ORG, {
			memberId,
			source: { type: 'restaurant_order', id: o2 },
			at: t2,
		})
		await reconcileLoyaltySource(
			ORG,
			{ type: 'restaurant_order', id: o2 },
			{ now: t2 },
		)
		expect((await balanceOf(ORG, memberId)).points).toBe(180)

		// Redeem 60 pts before expiry -> drains oldest lot first (40 left in Lot 1, 80 in Lot 2)
		const rewardRow = await makeReward(
			ORG,
			rewardDefinition({ name: 'Lunch Deal', pointsCost: 60 }),
			t2,
		)
		const rewardSnap = (await readRewardInTx(db, rewardRow.id))!.snapshot
		const ordSpend = await insertOrder(ORG, {
			customerId: 'cus_e1',
			subtotalCents: 1000,
			totalCents: 1000,
			createdAt: new Date(t2 + DAY),
		})
		await withLoyaltyWrite({ orgId: ORG, now: t2 + DAY }, async (tx) => {
			const m = (await readMemberInTx(tx, memberId))!
			const bound = await reserveRedemptionInTx(tx, {
				member: m,
				reward: rewardSnap,
				cart: loyaltyCart(),
				cartHash: 'c_e1',
				targetLineId: null,
				channel: 'web',
				source: { type: 'restaurant_order', id: ordSpend },
				locationId: null,
				at: t2 + DAY,
			})
			await consumeRedemptionInTx(tx, bound, {
				at: t2 + DAY,
				actorKind: 'system',
			})
		})
		expect((await balanceOf(ORG, memberId)).points).toBe(120)

		const lot1ExpiresAt = addExpiryMonths(NOW, 6)
		// 20 days before Lot 1 expires -> sends 30d notice for 40 pts once
		await runLoyaltyTickForOrg(ORG, { now: lot1ExpiresAt - 20 * DAY })
		await runLoyaltyTickForOrg(ORG, { now: lot1ExpiresAt - 19 * DAY })
		expect(notices.filter((n) => n.kind === 'expiry_30d')).toHaveLength(1)

		// Wallet surfaces next expiry and expiringWithin30d
		const walletSoon = await getWallet(db, {
			customerId: 'cus_e1',
			orgId: ORG,
			features: FEATURES_ON,
			now: lot1ExpiresAt - 19 * DAY,
		})
		expect(walletSoon?.expiry?.mode).toBe('after_earn')
		expect(walletSoon?.expiry?.nextExpiryAt).toBe(lot1ExpiresAt)
		expect(walletSoon?.expiry?.nextExpiryPoints).toBe(40)
		expect(walletSoon?.expiry?.expiringWithin30d).toBe(40)

		// 5 days before Lot 1 expires -> sends 7d notice once
		await runLoyaltyTickForOrg(ORG, { now: lot1ExpiresAt - 5 * DAY })
		await runLoyaltyTickForOrg(ORG, { now: lot1ExpiresAt - 4 * DAY })
		expect(notices.filter((n) => n.kind === 'expiry_7d')).toHaveLength(1)

		// Past Lot 1 expiry -> ONLY remaining 40 pts from Lot 1 expire; 80 pts remain from Lot 2!
		await runLoyaltyTickForOrg(ORG, { now: lot1ExpiresAt + 1000 })
		expect((await balanceOf(ORG, memberId)).points).toBe(80)

		// Repeating tick is idempotent
		await runLoyaltyTickForOrg(ORG, { now: lot1ExpiresAt + DAY })
		expect((await balanceOf(ORG, memberId)).points).toBe(80)

		// Report includes expired total in window
		const report = await getLoyaltyReport(
			db,
			{ from: '2026-01-01', to: '2026-08-01' },
			{ now: lot1ExpiresAt + 2 * DAY },
		)
		expect(report.expiry.pointsExpired).toBe(40)
	})

	it('grants a full grace period on existing points when expiry is turned on, resets inactivity on earn, and respects opt-out', async () => {
		const notices: Array<{ memberId: string; kind: string }> = []
		setLoyaltyNoticeTransportForTest(async (delivery) => {
			notices.push({ memberId: delivery.memberId, kind: delivery.kind })
		})

		const initial = await activateProgram(
			ORG,
			programConfig({
				earning: { method: 'spend', points: 10, perMinor: 100 },
				expiry: { mode: 'never', months: 12, enabledAt: null },
			}),
			NOW,
		)
		const db = await getTenantDb(ORG)
		await insertCustomer(ORG, {
			id: 'cus_e2',
			name: 'Tariq',
			phone: '+14155550302',
			verified: true,
		})
		await insertCustomer(ORG, {
			id: 'cus_optout',
			name: 'Unsub',
			phone: '+14155550303',
			verified: true,
		})
		await db
			.update(customers)
			.set({ email: 'tariq@example.com' })
			.where(eq(customers.id, 'cus_e2'))
		await db
			.update(customers)
			.set({ email: 'unsub@example.com' })
			.where(eq(customers.id, 'cus_optout'))
		await setCustomerSubscription(db, {
			customerId: 'cus_optout',
			topic: 'loyalty',
			channel: 'email',
			subscribed: true,
			source: 'profile',
			now: new Date(NOW - 1000),
		})
		await setCustomerSubscription(db, {
			customerId: 'cus_optout',
			topic: 'loyalty',
			channel: 'sms',
			subscribed: true,
			source: 'profile',
			now: new Date(NOW - 1000),
		})
		await setCustomerSubscription(db, {
			customerId: 'cus_optout',
			topic: 'loyalty',
			channel: 'email',
			subscribed: false,
			source: 'profile',
			now: new Date(NOW),
		})
		await setCustomerSubscription(db, {
			customerId: 'cus_optout',
			topic: 'loyalty',
			channel: 'sms',
			subscribed: false,
			source: 'profile',
			now: new Date(NOW),
		})

		const m1 = await makeMember(ORG, { customerId: 'cus_e2', now: NOW })
		const m2 = await makeMember(ORG, { customerId: 'cus_optout', now: NOW })

		const ordA = await insertOrder(ORG, {
			customerId: 'cus_e2',
			subtotalCents: 1000,
			totalCents: 1000,
			createdAt: new Date(NOW),
		})
		await claimAndQueue(ORG, {
			memberId: m1,
			source: { type: 'restaurant_order', id: ordA },
			at: NOW,
		})
		await reconcileLoyaltySource(
			ORG,
			{ type: 'restaurant_order', id: ordA },
			{ now: NOW },
		)

		const ordB = await insertOrder(ORG, {
			customerId: 'cus_optout',
			subtotalCents: 1000,
			totalCents: 1000,
			createdAt: new Date(NOW),
		})
		await claimAndQueue(ORG, {
			memberId: m2,
			source: { type: 'restaurant_order', id: ordB },
			at: NOW,
		})
		await reconcileLoyaltySource(
			ORG,
			{ type: 'restaurant_order', id: ordB },
			{ now: NOW },
		)

		// 8 months later, operator enables 3-month inactivity expiry -> neither expires immediately, enabledAt stamped at switchTime
		const switchTime = addExpiryMonths(NOW, 8)
		await saveProgram(ORG, {
			expectedVersion: initial.version,
			config: programConfig({
				earning: { method: 'spend', points: 10, perMinor: 100 },
				expiry: { mode: 'after_inactivity', months: 3, enabledAt: null },
			}),
			actorId: ACTOR,
			now: switchTime,
		})
		await new Promise((resolve) => setTimeout(resolve, 25))

		// m1 gets expiry_enabled notice; m2 opted out of email & sms -> receives 0 notices
		expect(
			notices.filter((n) => n.memberId === m1 && n.kind === 'expiry_enabled'),
		).toHaveLength(1)
		expect(notices.filter((n) => n.memberId === m2)).toHaveLength(0)

		// m1 makes a new purchase 2 months after switchTime -> resets inactivity clock!
		const activityTime = switchTime + 60 * DAY
		const ordC = await insertOrder(ORG, {
			customerId: 'cus_e2',
			subtotalCents: 200,
			totalCents: 200,
			lines: [
				orderLine({
					unitPriceCents: 200,
					baseUnitCents: 200,
					totalCents: 200,
					taxableUnitCents: 200,
					taxableCents: 200,
				}),
			],
			createdAt: new Date(activityTime),
			paidAt: new Date(activityTime),
			completedAt: new Date(activityTime),
		})
		await claimAndQueue(ORG, {
			memberId: m1,
			source: { type: 'restaurant_order', id: ordC },
			at: activityTime,
		})
		await reconcileLoyaltySource(
			ORG,
			{ type: 'restaurant_order', id: ordC },
			{ now: activityTime },
		)
		expect((await balanceOf(ORG, m1)).points).toBe(120)

		// At addExpiryMonths(switchTime, 3) + DAY: m2 (no new activity) expires, while m1 keeps all 120 pts!
		await runLoyaltyTickForOrg(ORG, {
			now: addExpiryMonths(switchTime, 3) + DAY,
		})
		expect((await balanceOf(ORG, m2)).points).toBe(0)
		expect((await balanceOf(ORG, m1)).points).toBe(120)

		// Once past addExpiryMonths(activityTime, 3) + DAY, m1's 120 pts expire too
		await runLoyaltyTickForOrg(ORG, {
			now: addExpiryMonths(activityTime, 3) + DAY,
		})
		expect((await balanceOf(ORG, m1)).points).toBe(0)
	})

	it('blocks time-based after_earn expiry in Canadian jurisdictions while permitting inactivity expiry', async () => {
		await expect(
			saveProgram(ORG, {
				expectedVersion: null,
				config: programConfig({
					currency: 'CAD',
					timeZone: 'America/Toronto',
					expiry: { mode: 'after_earn', months: 6, enabledAt: null },
				}),
				actorId: ACTOR,
				now: NOW,
			}),
		).rejects.toThrow(/inactivity expiry/i)

		const resCtx = await import('../lib/reservations-context.ts')
		const spy = vi.spyOn(resCtx, 'getReservationsContext').mockResolvedValue({
			organization: {
				id: ORG,
				name: 'Maple Bistro',
				slug: 'maple-bistro',
				defaultLocale: 'en',
				emailTheme: null,
			},
			locations: [
				{
					id: 'loc_ca',
					name: 'Toronto',
					address: '100 King St W, Toronto, ON M5X 1A9, Canada',
					timeZone: 'America/New_York',
				},
			],
		} as Awaited<ReturnType<typeof resCtx.getReservationsContext>>)
		try {
			await expect(
				saveProgram(ORG, {
					expectedVersion: null,
					config: programConfig({
						currency: 'USD',
						timeZone: 'America/New_York',
						expiry: { mode: 'after_earn', months: 6, enabledAt: null },
					}),
					actorId: ACTOR,
					now: NOW,
				}),
			).rejects.toThrowError(LoyaltyDomainError)
		} finally {
			spy.mockRestore()
		}

		const saved = await saveProgram(ORG, {
			expectedVersion: null,
			config: programConfig({
				currency: 'CAD',
				timeZone: 'America/Toronto',
				expiry: { mode: 'after_inactivity', months: 12, enabledAt: null },
			}),
			actorId: ACTOR,
			now: NOW,
		})
		expect(saved.current.config.expiry.mode).toBe('after_inactivity')
		expect(saved.current.config.expiry.enabledAt).toBe(NOW)
	})
})
