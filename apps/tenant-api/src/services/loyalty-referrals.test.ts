import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LoyaltyDomainError } from '@repo/loyalty'
import {
	destroyTenantDb,
	getTenantDb,
	loyaltyLedger,
	loyaltyReferrals,
	provisionTenantDb,
	restaurantOrderRefunds,
	restaurantOrders,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	invalidateLoyaltyContext,
	seedLoyaltyContextForTest,
} from '../lib/loyalty-context.ts'
import {
	findActiveOrganizationById,
	resolveOrganizationForBrowserAuth,
} from '../lib/origin.ts'
import '../restaurant/loyalty-sources.ts'
import { quoteOrderDiscounts } from './discount-quote.ts'
import {
	ensureMemberForCustomer,
	getWallet,
	readMemberInTx,
} from './loyalty-member-service.ts'
import { reconcileLoyaltySource } from './loyalty-purchase-service.ts'
import {
	claimReferral,
	listOperatorReferrals,
	lookupPublicReferral,
} from './loyalty-referral-service.ts'
import { getLoyaltyReport } from './loyalty-report-service.ts'
import { runLoyaltyTickForOrg } from './loyalty-tick-service.ts'
import {
	activateProgram,
	ACTOR,
	assertBalancesMatchLedger,
	balanceOf,
	DAY,
	insertCustomer,
	NOW,
	programConfig,
} from './loyalty-test-fixture.ts'
import { placeOrder, updateOperatorOrder } from './order-service.ts'
import { erasePerson } from './person-erasure-service.ts'

vi.mock('../lib/origin.ts', () => {
	const findActiveOrganizationById = vi.fn()
	return {
		findActiveOrganizationById,
		lookupActiveOrganization: vi.fn(async (id: string) => {
			const organization = await findActiveOrganizationById(id)
			return organization
				? { status: 'found', organization }
				: { status: 'missing' }
		}),
		resolveOrganizationForBrowserAuth: vi.fn(),
		resolvePublishedOrganization: vi.fn(async () => null),
	}
})

const orgId = 'org_ll_referrals'
const ORG = {
	id: orgId,
	slug: 'ref-bistro',
	customDomain: null,
	hasProvisionedDb: true,
	dataRegion: 'us',
	name: 'Ref Bistro',
}
const FEATURES_REF_ON = { enabled: true, redemption: true, referrals: true }
const ALL_DAYS = [
	'sunday',
	'monday',
	'tuesday',
	'wednesday',
	'thursday',
	'friday',
	'saturday',
].map((day) => ({
	day,
	isOpen: true,
	slots: [{ start: '00:00', end: '23:59' }],
}))

function menuContext(extra: Record<string, unknown> = {}) {
	return {
		orgId,
		dataRegion: 'us',
		discounts: {
			features: { automatic: false, coupons: false },
			discounts: [],
			codes: [],
		},
		menu: {
			organization: { id: orgId, slug: 'ref-bistro', currency: 'USD' },
			locations: [
				{
					id: 'loc-1',
					name: 'Main Street',
					timezone: 'UTC',
					taxRate: 0,
					prepTime: 15,
					currency: 'USD',
					fulfillmentOptions: {
						pickup: true,
						delivery: false,
						dineIn: true,
						curbside: false,
					},
					inHouseTips: {
						pickupTips: false,
						deliveryTips: false,
						dineInTips: false,
					},
					onlineHours: ALL_DAYS,
				},
			],
			menus: [
				{
					id: 'menu-1',
					displayName: 'Main',
					menuType: 'regular',
					specialInstructions: true,
					availabilityStatus: 'available',
					categories: [
						{
							id: 'cat-food',
							displayName: 'Food',
							availabilityStatus: 'available',
							items: [
								{
									id: 'item-burger',
									displayName: 'Burger',
									price: 10,
									availabilityStatus: 'available',
								},
							],
						},
					],
				},
			],
			locationOverrides: {},
		},
		drop: null,
		onlinePayment: { enabled: false, processor: 'connect' },
		...extra,
	}
}

function orderInput(overrides: Record<string, unknown> = {}) {
	return {
		slug: 'ref-bistro',
		idempotencyKey: crypto.randomUUID(),
		locale: 'en',
		locationId: 'loc-1',
		fulfillment: 'pickup' as const,
		paymentMethod: 'handoff' as const,
		contact: { name: 'Friend', phone: '+14155551101' },
		tipPercent: 0,
		lines: [{ itemId: 'item-burger', quantity: 2, options: [] }],
		...overrides,
	}
}

let directory: string

beforeEach(async () => {
	vi.useFakeTimers({ toFake: ['Date'] })
	vi.setSystemTime(NOW)
	directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loyalty-referrals-'))
	vi.stubEnv('TENANT_DB_DIR', directory)
	vi.stubEnv('DATA_REGION', 'us')
	vi.stubEnv('AUTH_HMAC_SECRET', 'test-hmac-secret-123456789')
	vi.stubEnv('APP_URL', 'https://app.test')

	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL) => {
			const url = typeof input === 'string' ? input : input.toString()
			if (url.includes('/resources/order-context')) {
				return Response.json(menuContext())
			}
			return new Response('not found', { status: 404 })
		}),
	)
	vi.mocked(findActiveOrganizationById).mockImplementation(async (id) =>
		id === orgId ? (ORG as never) : null,
	)
	vi.mocked(resolveOrganizationForBrowserAuth).mockImplementation(
		async () => ORG as never,
	)

	await provisionTenantDb(orgId)
	invalidateLoyaltyContext()
	seedLoyaltyContextForTest(orgId, FEATURES_REF_ON)
})

afterEach(async () => {
	try {
		await assertBalancesMatchLedger(orgId)
	} finally {
		vi.useRealTimers()
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
		await destroyTenantDb(orgId)
		fs.rmSync(directory, { recursive: true, force: true })
	}
})

describe('#169 & #336 unified referrals', () => {
	it('supports ?ref= link claim AND direct REF code in checkout with discounts.coupons=false, applying hold period then crediting both sides', async () => {
		await activateProgram(
			orgId,
			programConfig({
				earning: { method: 'spend', points: 10, perMinor: 100 },
				referrals: {
					enabled: true,
					referrerPoints: 100,
					friendPoints: 25,
					friendDiscount: { type: 'fixed', amountMinor: 500 },
					minimumOrderMinor: 1000,
					holdDays: 7,
					maxReferralsPerMember: 10,
					maxReferralsPerMonth: null,
				},
			}),
			NOW,
		)
		const db = await getTenantDb(orgId)

		// Referrer Alice gets her unique share code in wallet
		await insertCustomer(orgId, {
			id: 'cus_alice',
			name: 'Alice Smith',
			phone: '+14155551001',
			verified: true,
		})
		const aliceMember = (await ensureMemberForCustomer(orgId, {
			customerId: 'cus_alice',
			now: NOW,
		}))!
		const aliceWallet = await getWallet(db, {
			customerId: 'cus_alice',
			orgId,
			features: FEATURES_REF_ON,
			now: NOW,
		})
		const refCode = aliceWallet?.referral?.code
		expect(refCode).toMatch(/^REF-/)
		expect(aliceWallet?.referral?.sharePath).toBe(`/?ref=${refCode}`)

		// Anonymous lookup exposes offer + referrer first name only (no PII leak)
		const pub = await lookupPublicReferral(db, {
			orgId,
			code: refCode!,
			features: FEATURES_REF_ON,
			now: NOW,
		})
		expect(pub).toEqual({
			valid: true,
			code: refCode,
			referrerFirstName: 'Alice',
			friendDiscount: { type: 'fixed', amountMinor: 500 },
			friendPoints: 25,
			minimumOrderMinor: 1000,
		})

		// Path A: Friend Bob clicks ?ref= link, signs in & claims -> mints single-use discountCode
		await insertCustomer(orgId, {
			id: 'cus_bob',
			name: 'Bob Jones',
			phone: '+14155551101',
			verified: true,
		})
		const bobClaim = await claimReferral(orgId, {
			customerId: 'cus_bob',
			code: refCode!,
			deviceId: 'dev_bob_1',
			features: FEATURES_REF_ON,
			now: NOW,
		})
		expect(bobClaim.referral.status).toBe('claimed')
		expect(bobClaim.referral.discountCode).toMatch(/^RF-/)

		// Quote & place Bob's first order ($20 -> $5 referral discount -> $15 net)
		const bobQuote = await quoteOrderDiscounts({
			organization: ORG as never,
			customerId: 'cus_bob',
			now: new Date(NOW),
			request: orderInput({
				discounts: { code: bobClaim.referral.discountCode! },
			}) as never,
		})
		expect(bobQuote.ok).toBe(true)
		if (!bobQuote.ok) return
		expect(bobQuote.data.totalDiscountMinor).toBe(500)
		expect(bobQuote.data.totalMinor).toBe(1500)
		expect(bobQuote.data.couponsEnabled).toBe(true)

		const bobOrderRes = await placeOrder({
			organization: ORG as never,
			customerId: 'cus_bob',
			now: new Date(NOW),
			request: orderInput({
				contact: { name: 'Bob', phone: '+14155551101' },
				discounts: {
					code: bobClaim.referral.discountCode!,
					expectedDiscountMinor: 500,
				},
			}) as never,
		})
		expect(bobOrderRes.ok).toBe(true)
		if (!bobOrderRes.ok) return
		const bobOrderId = bobOrderRes.data.order.id
		expect(bobOrderRes.data.order.discountCents).toBe(500)

		// Complete order -> referral moves to 'holding' for 7 days; nothing credited yet
		vi.setSystemTime(NOW + 1000)
		expect(
			(
				await updateOperatorOrder(orgId, bobOrderId, {
					status: 'completed',
					markPaid: true,
				})
			).ok,
		).toBe(true)
		expect((await balanceOf(orgId, aliceMember.id)).points).toBe(0)

		// Path B: Guest friend Cara types Alice's REF code directly at checkout without prior claim
		const caraOrderRes = await placeOrder({
			organization: ORG as never,
			customerId: null,
			now: new Date(NOW + 2000),
			request: orderInput({
				contact: { name: 'Cara Guest', phone: '+14155551102' },
				referralDeviceId: 'dev_cara_1',
				discounts: {
					code: refCode!,
					expectedDiscountMinor: 500,
				},
			}) as never,
		})
		expect(caraOrderRes.ok).toBe(true)
		if (!caraOrderRes.ok) return
		expect(caraOrderRes.data.order.discountCents).toBe(500)
		vi.setSystemTime(NOW + 3000)
		expect(
			(
				await updateOperatorOrder(orgId, caraOrderRes.data.order.id, {
					status: 'completed',
					markPaid: true,
				})
			).ok,
		).toBe(true)

		// Tick before hold expires -> still holding (0 pts)
		await runLoyaltyTickForOrg(orgId, { now: NOW + 6 * DAY })
		expect((await balanceOf(orgId, aliceMember.id)).points).toBe(0)

		// Tick after 7d hold expires -> credits both referrals: Alice gets 200 pts, Bob gets 25 + order earn pts!
		await runLoyaltyTickForOrg(orgId, { now: NOW + 8 * DAY })
		expect((await balanceOf(orgId, aliceMember.id)).points).toBe(200)
		const bobMember = (await ensureMemberForCustomer(orgId, {
			customerId: 'cus_bob',
			now: NOW + 8 * DAY,
		}))!
		const bobLedger = await db
			.select()
			.from(loyaltyLedger)
			.where(eq(loyaltyLedger.memberId, bobMember.id))
			.all()
		expect(bobLedger.some((e) => e.type === 'referral' && e.delta === 25)).toBe(
			true,
		)

		const walletAfter = await getWallet(db, {
			customerId: 'cus_alice',
			orgId,
			features: FEATURES_REF_ON,
			now: NOW + 8 * DAY,
		})
		expect(walletAfter?.referral?.creditedCount).toBe(2)
		expect(walletAfter?.referral?.creditedPoints).toBe(200)

		const opList = await listOperatorReferrals(db)
		expect(opList.summary.credited).toBe(2)
		expect(opList.summary.friendDiscountMinor).toBe(1000)
	})

	it('blocks self-referral, existing customers, and cap breaches; cancels/reverses on refund; anonymizes on erasure', async () => {
		await activateProgram(
			orgId,
			programConfig({
				referrals: {
					enabled: true,
					referrerPoints: 50,
					friendPoints: 10,
					friendDiscount: {
						type: 'percent',
						percentBp: 1000,
						maxDiscountMinor: null,
					},
					minimumOrderMinor: 500,
					holdDays: 0, // immediate credit on completion
					maxReferralsPerMember: 2,
					maxReferralsPerMonth: 1,
				},
			}),
			NOW,
		)
		const db = await getTenantDb(orgId)
		await insertCustomer(orgId, {
			id: 'cus_ref',
			name: 'Referrer',
			phone: '+14155552001',
			verified: true,
		})
		const refMember = (await ensureMemberForCustomer(orgId, {
			customerId: 'cus_ref',
			now: NOW,
		}))!
		const refWallet = await getWallet(db, {
			customerId: 'cus_ref',
			orgId,
			features: FEATURES_REF_ON,
			now: NOW,
		})
		const refCode = refWallet!.referral!.code

		// 1. Self-referral blocked (same customer & same phone)
		await expect(
			claimReferral(orgId, {
				customerId: 'cus_ref',
				code: refCode,
				features: FEATURES_REF_ON,
				now: NOW,
			}),
		).rejects.toThrowError(LoyaltyDomainError)

		// 2. Existing customer with prior order blocked
		await insertCustomer(orgId, {
			id: 'cus_existing',
			name: 'Existing Guest',
			phone: '+14155552002',
			verified: true,
		})
		await placeOrder({
			organization: ORG as never,
			customerId: 'cus_existing',
			now: new Date(NOW),
			request: orderInput({
				contact: { name: 'Existing Guest', phone: '+14155552002' },
			}) as never,
		})
		await expect(
			claimReferral(orgId, {
				customerId: 'cus_existing',
				code: refCode,
				features: FEATURES_REF_ON,
				now: NOW + 1000,
			}),
		).rejects.toThrowError(/referral_existing_customer|for new customers/i)

		// 3. Cancelled order releases/cancels pending referral cleanly
		await insertCustomer(orgId, {
			id: 'cus_cancel',
			name: 'Cancel Friend',
			phone: '+14155552003',
			verified: true,
		})
		const cancelOrd = (await placeOrder({
			organization: ORG as never,
			customerId: 'cus_cancel',
			now: new Date(NOW + 2000),
			request: orderInput({
				contact: { name: 'Cancel', phone: '+14155552003' },
				referralDeviceId: 'dev_shared',
				discounts: { code: refCode, expectedDiscountMinor: 200 },
			}) as never,
		}))!
		expect(cancelOrd.ok).toBe(true)
		if (cancelOrd.ok) {
			vi.setSystemTime(NOW + 3000)
			await updateOperatorOrder(orgId, cancelOrd.data.order.id, {
				status: 'cancelled',
			})
		}
		expect((await balanceOf(orgId, refMember.id)).points).toBe(0)

		// 4. First valid friend in month 1 credits immediately (holdDays = 0), then monthly cap (1) blocks 2nd in month 1!
		await insertCustomer(orgId, {
			id: 'cus_f1',
			name: 'Friend One',
			phone: '+14155552004',
			verified: true,
		})
		const c1 = await claimReferral(orgId, {
			customerId: 'cus_f1',
			code: refCode,
			deviceId: 'dev_f1',
			features: FEATURES_REF_ON,
			now: NOW + 4000,
		})
		const o1 = (await placeOrder({
			organization: ORG as never,
			customerId: 'cus_f1',
			now: new Date(NOW + 5000),
			request: orderInput({
				contact: { name: 'Friend One', phone: '+14155552004' },
				deviceId: 'dev_f1',
				referralDeviceId: 'dev_f1',
				discounts: {
					code: c1.referral.discountCode!,
					expectedDiscountMinor: 200,
				},
			}) as never,
		}))!
		expect(o1.ok).toBe(true)
		if (!o1.ok) return
		vi.setSystemTime(NOW + 6000)
		expect(
			(
				await updateOperatorOrder(orgId, o1.data.order.id, {
					status: 'completed',
					markPaid: true,
				})
			).ok,
		).toBe(true)
		expect((await balanceOf(orgId, refMember.id)).points).toBe(50)

		// Same device on another phone blocked
		await insertCustomer(orgId, {
			id: 'cus_f2',
			name: 'Friend Two',
			phone: '+14155552005',
			verified: true,
		})
		await expect(
			claimReferral(orgId, {
				customerId: 'cus_f2',
				code: refCode,
				deviceId: 'dev_f1',
				features: FEATURES_REF_ON,
				now: NOW + 7000,
			}),
		).rejects.toThrowError(/referral_already_claimed/i)

		// Monthly cap blocks even on clean device in month 1
		await expect(
			claimReferral(orgId, {
				customerId: 'cus_f2',
				code: refCode,
				deviceId: 'dev_f2',
				features: FEATURES_REF_ON,
				now: NOW + 8000,
			}),
		).rejects.toThrowError(/referral_cap_reached/i)

		// 5. Full refund of credited referral reverses referrer points via referral_reversal!
		await db
			.update(restaurantOrders)
			.set({ refundedCents: 1800 })
			.where(eq(restaurantOrders.id, o1.data.order.id))
		await db.insert(restaurantOrderRefunds).values({
			id: 'ref_rev_1',
			orderId: o1.data.order.id,
			amountCents: 1800,
			currency: 'USD',
			full: true,
			status: 'succeeded',
			actorId: ACTOR,
			idempotencyKey: 'ref-rev-1',
			requestHash: 'req-ref-rev-1',
			createdAt: NOW + 9000,
		})
		await reconcileLoyaltySource(
			orgId,
			{ type: 'restaurant_order', id: o1.data.order.id },
			{ now: NOW + 9000 },
		)
		expect((await balanceOf(orgId, refMember.id)).points).toBe(0)

		// 6. Erasure of Friend One anonymizes PII while keeping phone hash
		await erasePerson(
			db,
			{ customerId: 'cus_f1' },
			{ actorId: ACTOR, now: NOW + 10_000 },
		)
		const [refAfterErase] = await db
			.select()
			.from(loyaltyReferrals)
			.where(eq(loyaltyReferrals.id, c1.referral.id))
			.all()
		expect(refAfterErase?.friendCustomerId).toBeNull()
		expect(refAfterErase?.deviceHash).toBeNull()
		expect(refAfterErase?.friendPhoneHash).toBeTruthy()
	})
})
