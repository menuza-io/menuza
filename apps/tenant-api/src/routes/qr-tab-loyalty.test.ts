import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { QR_STATION_MARK_LISTED_MS } from '@repo/common/qr-ordering'
import { brand } from '@repo/config/brand'
import {
	destroyTenantDb,
	getTenantDb,
	loyaltyMembers,
	loyaltyPurchases,
	loyaltyRedemptions,
	provisionTenantDb,
	qrTabs,
	restaurantOrders,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
	invalidateLoyaltyContext,
	seedLoyaltyContextForTest,
} from '../lib/loyalty-context.ts'
import {
	findActiveOrganizationById,
	resolveOrganizationForBrowserAuth,
} from '../lib/origin.ts'
import { processLoyaltyOutbox } from '../services/loyalty-purchase-service.ts'
import {
	activateProgram,
	assertBalancesMatchLedger,
	balanceOf,
	givePoints,
	insertCustomer,
	makeMember,
	makeReward,
	programConfig,
	rewardDefinition,
} from '../services/loyalty-test-fixture.ts'
import { updateOperatorOrder } from '../services/order-service.ts'
import { loyaltyRoutes } from './loyalty.ts'
import { operatorQrRoutes } from './operator-qr.ts'
import { orderSystemRoutes } from './order-system.ts'
import { publicOrderRoutes } from './orders.ts'

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

const orgId = 'org_qr_tab_loyalty_1'
const internalToken = 'test-internal-token-very-long-and-secure-12345'
const operatorToken = 'test-operator-token-very-long-and-secure-12345'
const jwtSecret = 'test-jwt-secret-123456789'

const ORG = {
	id: orgId,
	slug: 'test-org',
	customDomain: null,
	hasProvisionedDb: true,
	dataRegion: 'us',
}

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

function context() {
	return {
		orgId,
		dataRegion: 'us',
		menu: {
			organization: { id: orgId, slug: 'test-org', currency: 'USD' },
			locations: [
				{
					id: 'loc-1',
					name: 'Main',
					timezone: 'UTC',
					taxRate: 10,
					prepTime: 15,
					currency: 'USD',
					fulfillmentOptions: {
						pickup: true,
						delivery: false,
						dineIn: true,
						curbside: false,
					},
					inHouseTips: {
						pickupTips: true,
						deliveryTips: true,
						dineInTips: true,
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
									id: 'item-tea',
									displayName: 'Tea',
									price: 4,
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
		onlinePayment: { enabled: true, processor: 'connect' },
		qrOrdering: { enabled: true, dineIn: true, online: true },
	}
}

function roundBody() {
	return {
		slug: 'test-org',
		idempotencyKey: crypto.randomUUID(),
		locale: 'en',
		locationId: 'loc-1',
		fulfillment: 'dine_in',
		paymentMethod: 'handoff',
		contact: {},
		tipPercent: 0,
		lines: [{ itemId: 'item-tea', quantity: 2, options: [] }],
	}
}

async function operatorJwt() {
	return new SignJWT({ orgId, role: 'operator', scope: 'qr:write' })
		.setSubject('user_1')
		.setProtectedHeader({ alg: 'HS256' })
		.setAudience('tenant-api-operator')
		.setIssuer(brand.shortName)
		.setExpirationTime('15m')
		.sign(new TextEncoder().encode(operatorToken))
}

async function customerJwt(customerId: string) {
	return new SignJWT({ customerId, orgId, orgSlug: 'test-org', type: 'access' })
		.setProtectedHeader({ alg: 'HS256' })
		.setIssuer(brand.slug)
		.setAudience('tenant-api')
		.setExpirationTime('1h')
		.sign(new TextEncoder().encode(jwtSecret))
}

async function signedIn(
	customerId: string | null | undefined,
): Promise<Record<string, string>> {
	return customerId
		? { authorization: `Bearer ${await customerJwt(customerId)}` }
		: {}
}

const LATER = () => Date.now() + 60_000

type PayIntent = {
	orderRef: string
	tabPaymentToken: string
	amountCents: number
	tipCents: number
	loyaltyDiscountCents: number
}

describe('QR tab loyalty: one purchase per tab, rewards only when paid from the phone', () => {
	let directory: string
	let app: Hono
	let memberId: string
	let rewardId: string

	async function request(
		pathname: string,
		init: {
			method?: string
			body?: unknown
			headers?: Record<string, string>
		} = {},
	) {
		return app.request(pathname, {
			method: init.method ?? 'GET',
			headers: {
				'content-type': 'application/json',
				origin: 'https://test-org.example.com',
				...init.headers,
			},
			...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
		})
	}

	async function operator(pathname: string, body?: unknown) {
		return request(`/operator/qr${pathname}`, {
			method: 'POST',
			body,
			headers: { authorization: `Bearer ${await operatorJwt()}` },
		})
	}

	async function system(pathname: string, body: unknown) {
		return app.request(`/api/orders${pathname}`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${internalToken}`,
			},
			body: JSON.stringify(body),
		})
	}

	async function createTable(label = 'T1') {
		const response = await request('/operator/qr/tables', {
			method: 'POST',
			body: { locationId: 'loc-1', label },
			headers: { authorization: `Bearer ${await operatorJwt()}` },
		})
		expect(response.status).toBe(201)
		return (await response.json()).table as { id: string; token: string }
	}

	async function placeRound(
		code: { 'X-Table-Token': string } | { 'X-Tab-Token': string },
		customerId: string | null = null,
	) {
		const response = await request('/orders', {
			method: 'POST',
			body: roundBody(),
			headers: { ...code, ...(await signedIn(customerId)) },
		})
		expect(response.status).toBe(201)
		return (await response.json()) as {
			order: { id: string }
			tab: { id: string; tabToken: string }
		}
	}

	/** Every round leaves the kitchen's queue, so the guest may pay. */
	async function serveAll(tabId: string, status = 'completed' as const) {
		const db = await getTenantDb(orgId)
		await db
			.update(restaurantOrders)
			.set({ status })
			.where(eq(restaurantOrders.tabId, tabId))
	}

	async function pay(
		tabToken: string,
		options: {
			tipPercent?: number
			customerId?: string | null
			loyalty?: Record<string, unknown>
		} = {},
	) {
		return request('/orders/tab/pay', {
			method: 'POST',
			headers: {
				'X-Tab-Token': tabToken,
				...(await signedIn(options.customerId)),
			},
			body: {
				slug: 'test-org',
				tipPercent: options.tipPercent ?? 0,
				contact: { name: 'Lina Haddad', phone: '+1 555 222 3333' },
				...(options.loyalty ? { loyalty: options.loyalty } : {}),
			},
		})
	}

	async function payIntent(
		tabToken: string,
		options: Parameters<typeof pay>[1] = {},
	): Promise<PayIntent> {
		const response = await pay(tabToken, options)
		expect(response.status).toBe(200)
		return response.json()
	}

	async function bind(intent: PayIntent, sessionId: string) {
		return system('/payment-session', {
			orgId,
			orderId: intent.orderRef,
			sessionId,
			processor: 'connect',
		})
	}

	async function paymentEvent(
		intent: PayIntent,
		sessionId: string,
		status: 'paid' | 'failed' | 'expired',
	) {
		const response = await system('/payment-status', {
			orgId,
			orderId: intent.orderRef,
			sessionId,
			processor: 'connect',
			status,
			amountCents: intent.amountCents,
			currency: 'usd',
		})
		expect(response.status).toBe(200)
		return (await response.json()).paymentStatus as string
	}

	async function payOnline(intent: PayIntent, sessionId: string) {
		expect((await bind(intent, sessionId)).status).toBe(200)
		return paymentEvent(intent, sessionId, 'paid')
	}

	async function tabQuote(
		tabToken: string | null,
		body: Record<string, unknown> = {},
		customerId: string | null = 'cust_1',
	) {
		return request('/loyalty/tab/quote', {
			method: 'POST',
			headers: {
				...(tabToken ? { 'X-Tab-Token': tabToken } : {}),
				...(await signedIn(customerId)),
			},
			body: { slug: 'test-org', ...body },
		})
	}

	function rewardSelection(overrides: Record<string, unknown> = {}) {
		return {
			rewardId,
			rewardVersion: 1,
			expectedDiscountMinor: 500,
			targetLineId: null,
			...overrides,
		}
	}

	async function redemptionsFor(tabId: string) {
		const db = await getTenantDb(orgId)
		return db
			.select()
			.from(loyaltyRedemptions)
			.where(eq(loyaltyRedemptions.sourceId, tabId))
			.all()
	}

	async function purchasesFor(sourceId: string) {
		const db = await getTenantDb(orgId)
		return db
			.select()
			.from(loyaltyPurchases)
			.where(eq(loyaltyPurchases.sourceId, sourceId))
			.all()
	}

	async function tabRow(tabId: string) {
		const db = await getTenantDb(orgId)
		return db.select().from(qrTabs).where(eq(qrTabs.id, tabId)).get()
	}

	async function addMember(customerId: string, phone: string, points = 50) {
		await insertCustomer(orgId, { id: customerId, phone })
		const id = await makeMember(orgId, { customerId })
		if (points > 0) await givePoints(orgId, id, points)
		return id
	}

	beforeEach(async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-tab-loyalty-'))
		vi.stubEnv('TENANT_DB_DIR', directory)
		vi.stubEnv('DATA_REGION', 'us')
		vi.stubEnv('INTERNAL_COMMAND_TOKEN', internalToken)
		vi.stubEnv('TENANT_OPERATOR_TOKEN', operatorToken)
		vi.stubEnv('JWT_SECRET', jwtSecret)
		vi.stubEnv('AUTH_HMAC_SECRET', 'test-hmac-secret-123456789')
		vi.stubEnv('APP_URL', 'https://app.test')
		vi.stubEnv('QR_DINE_IN_ENABLED', '')

		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = typeof input === 'string' ? input : input.toString()
				if (url.includes('/resources/order-context')) {
					return Response.json(context())
				}
				return new Response('not found', { status: 404 })
			}),
		)
		vi.mocked(resolveOrganizationForBrowserAuth).mockImplementation(
			async (_origin, identity) =>
				identity?.slug === 'test-org' ? (ORG as never) : null,
		)
		vi.mocked(findActiveOrganizationById).mockImplementation(async (id) =>
			id === orgId ? (ORG as never) : null,
		)

		await provisionTenantDb(orgId)
		seedLoyaltyContextForTest(orgId, {
			enabled: true,
			redemption: true,
		})
		await activateProgram(orgId, programConfig())
		rewardId = (await makeReward(orgId, rewardDefinition())).id
		memberId = await addMember('cust_1', '+15551230001')

		app = new Hono()
		app.route('/orders', publicOrderRoutes)
		app.route('/operator/qr', operatorQrRoutes)
		app.route('/api/orders', orderSystemRoutes)
		app.route('/loyalty', loyaltyRoutes)
	})

	afterEach(async () => {
		invalidateLoyaltyContext(orgId)
		try {
			await assertBalancesMatchLedger(orgId)
		} finally {
			try {
				await destroyTenantDb(orgId)
				fs.rmSync(directory, { recursive: true, force: true })
			} catch {}
			vi.unstubAllEnvs()
			vi.unstubAllGlobals()
			vi.clearAllMocks()
		}
	})

	it('spends a reward on a tab paid from the phone and earns once on what was paid for', async () => {
		const table = await createTable()
		// A signed-in member's round claims the tab; a guest's later round rides on it.
		const first = await placeRound({ 'X-Table-Token': table.token }, 'cust_1')
		await placeRound({ 'X-Tab-Token': first.tab.tabToken })
		await serveAll(first.tab.id)

		const intent = await payIntent(first.tab.tabToken, {
			tipPercent: 10,
			customerId: 'cust_1',
			loyalty: rewardSelection(),
		})
		// Two rounds of 2 teas at $4 = $16.00; $5.00 off before the 10% tax
		// ($1.10 on $11.00); the tip is 10% of the subtotal ($1.60).
		expect(intent).toMatchObject({
			orderRef: `tab:${first.tab.id}`,
			loyaltyDiscountCents: 500,
			tipCents: 160,
			amountCents: 1370,
		})
		const [held] = await redemptionsFor(first.tab.id)
		expect(held).toMatchObject({
			state: 'bound',
			sourceType: 'qr_tab',
			channel: 'qr',
			memberId,
			points: 10,
			discountMinor: 500,
		})
		expect(await balanceOf(orgId, memberId)).toEqual({
			points: 50,
			reserved: 10,
			available: 40,
		})

		// Asking again with the same reward keeps the one hold.
		expect(
			(
				await payIntent(first.tab.tabToken, {
					tipPercent: 10,
					customerId: 'cust_1',
					loyalty: rewardSelection(),
				})
			).amountCents,
		).toBe(1370)
		expect(await redemptionsFor(first.tab.id)).toHaveLength(1)

		const quote = await system('/quote', {
			orgId,
			orderId: intent.orderRef,
			paymentToken: intent.tabPaymentToken,
		})
		expect(await quote.json()).toMatchObject({ totalCents: 1370 })
		expect(await payOnline(intent, 'cs_test_reward')).toBe('paid')
		await processLoyaltyOutbox(orgId, { now: LATER() })

		const [redemption] = await redemptionsFor(first.tab.id)
		expect(redemption!.state).toBe('consumed')
		// 50 - 10 spent + 11 earned on $11.00 of tea (tax and tip excluded).
		expect(await balanceOf(orgId, memberId)).toEqual({
			points: 51,
			reserved: 0,
			available: 51,
		})
		expect(await tabRow(first.tab.id)).toMatchObject({
			status: 'closed',
			paymentMethod: 'online',
			subtotalCents: 1600,
			loyaltyDiscountCents: 500,
			taxCents: 110,
			tipCents: 160,
			totalCents: 1370,
		})
		const purchases = await purchasesFor(first.tab.id)
		expect(purchases).toHaveLength(1)
		expect(purchases[0]).toMatchObject({
			memberId,
			sourceType: 'qr_tab',
			channel: 'qr',
			state: 'completed',
		})
		// The rounds are part of the tab's purchase, never their own.
		expect(await purchasesFor(first.order.id)).toHaveLength(0)

		// The guest receipt shows the reward.
		const receipt = await request('/orders/tab?slug=test-org', {
			headers: { 'X-Tab-Token': first.tab.tabToken },
		})
		expect((await receipt.json()).tab.totals).toMatchObject({
			loyaltyDiscountCents: 500,
			taxCents: 110,
			totalCents: 1370,
		})

		// A redelivered payment event earns and spends nothing more.
		expect(await paymentEvent(intent, 'cs_test_reward', 'paid')).toBe('paid')
		await processLoyaltyOutbox(orgId, { now: LATER() })
		expect((await balanceOf(orgId, memberId)).points).toBe(51)
	})

	it('quotes every reward on the open tab with the tip, holding nothing', async () => {
		const table = await createTable()
		const first = await placeRound({ 'X-Table-Token': table.token }, 'cust_1')

		const response = await tabQuote(first.tab.tabToken, {
			tipPercent: 10,
			selection: rewardSelection(),
		})
		expect(response.status).toBe(200)
		expect(response.headers.get('cache-control')).toContain('no-store')
		const quote = await response.json()
		expect(quote).toMatchObject({
			currency: 'USD',
			unitLabel: 'points',
			balance: { points: 50, reserved: 0, available: 50 },
			selectedRewardId: rewardId,
			availableAfter: 40,
			totals: {
				subtotalMinor: 800,
				discountMinor: 500,
				taxMinor: 30,
				taxInclusive: false,
				tipMinor: 80,
				deliveryFeeMinor: 0,
				totalMinor: 410,
			},
		})
		expect(quote.rewards).toEqual([
			expect.objectContaining({
				rewardId,
				rewardVersion: 1,
				applicable: true,
				affordable: true,
				discountMinor: 500,
				pointsCost: 10,
			}),
		])
		expect(await redemptionsFor(first.tab.id)).toHaveLength(0)
		expect((await balanceOf(orgId, memberId)).reserved).toBe(0)

		const plain = await (await tabQuote(first.tab.tabToken)).json()
		expect(plain.selectedRewardId).toBeNull()
		expect(plain.totals).toMatchObject({
			discountMinor: 0,
			taxMinor: 80,
			tipMinor: 0,
			totalMinor: 880,
		})

		// The quoted total is the one the tab payment asks for.
		await serveAll(first.tab.id)
		const intent = await payIntent(first.tab.tabToken, {
			tipPercent: 10,
			customerId: 'cust_1',
			loyalty: rewardSelection({
				expectedDiscountMinor: quote.rewards[0].discountMinor,
			}),
		})
		expect(intent.amountCents).toBe(quote.totals.totalMinor)
	})

	it('refuses tab quotes without a customer, a tab code, redemption or the QR switch', async () => {
		const table = await createTable()
		const first = await placeRound({ 'X-Table-Token': table.token }, 'cust_1')

		expect((await tabQuote(first.tab.tabToken, {}, null)).status).toBe(401)
		const noTab = await tabQuote(null)
		expect(noTab.status).toBe(404)
		expect((await noTab.json()).error).toBe('tab_not_found')
		const forged = await tabQuote(`${first.tab.id}.1.${'0'.repeat(64)}`)
		expect(forged.status).toBe(404)

		await addMember('cust_2', '+15551230002', 0)
		// A phone nobody verified is never linked to the points system.
		await insertCustomer(orgId, {
			id: 'cust_3',
			phone: '+15551230003',
			verified: false,
		})
		const stranger = await tabQuote(first.tab.tabToken, {}, 'cust_3')
		expect(stranger.status).toBe(404)
		expect((await stranger.json()).error).toBe('member_not_found')

		seedLoyaltyContextForTest(orgId, {
			enabled: true,
			redemption: false,
		})
		const off = await tabQuote(first.tab.tabToken)
		expect(off.status).toBe(403)
		expect((await off.json()).error).toBe('redemption_disabled')

		seedLoyaltyContextForTest(orgId, {
			enabled: true,
			redemption: true,
		})
		vi.stubEnv('QR_DINE_IN_ENABLED', 'off')
		expect((await tabQuote(first.tab.tabToken)).status).toBe(503)
	})

	it('gives the reward back and earns on the full tab when staff close it at the counter', async () => {
		const table = await createTable()
		const first = await placeRound({ 'X-Table-Token': table.token }, 'cust_1')
		await serveAll(first.tab.id)
		await payIntent(first.tab.tabToken, {
			customerId: 'cust_1',
			loyalty: rewardSelection(),
		})
		expect((await balanceOf(orgId, memberId)).reserved).toBe(10)

		const closed = await operator(`/tabs/${first.tab.id}/close`, {
			paymentMethod: 'counter',
		})
		expect(closed.status).toBe(200)
		expect((await closed.json()).tab.totals.totalCents).toBe(880)
		await processLoyaltyOutbox(orgId, { now: LATER() })

		const [redemption] = await redemptionsFor(first.tab.id)
		expect(redemption).toMatchObject({
			state: 'released',
			releaseReason: 'counter_close',
		})
		// 50 + 8 earned on $8.00 of tea: a reward only rides on a phone payment.
		expect(await balanceOf(orgId, memberId)).toEqual({
			points: 58,
			reserved: 0,
			available: 58,
		})
		expect(await tabRow(first.tab.id)).toMatchObject({
			paymentMethod: 'counter',
			loyaltyDiscountCents: 0,
			totalCents: 880,
			rungUpOnStation: false,
		})
		expect((await purchasesFor(first.tab.id))[0]).toMatchObject({
			memberId,
			state: 'completed',
		})
	})

	it('earns nothing on a tab staff rang up on a Station till', async () => {
		const table = await createTable()
		const first = await placeRound({ 'X-Table-Token': table.token }, 'cust_1')
		const closed = await operator(`/tabs/${first.tab.id}/close`, {
			paymentMethod: 'counter',
			rungUpOnStation: true,
		})
		expect(closed.status).toBe(200)
		await processLoyaltyOutbox(orgId, { now: LATER() })

		expect((await tabRow(first.tab.id))?.rungUpOnStation).toBe(true)
		expect((await purchasesFor(first.tab.id))[0]).toMatchObject({
			memberId,
			state: 'excluded',
			excludedReason: 'rung_up_on_station',
		})
		expect((await balanceOf(orgId, memberId)).points).toBe(50)
	})

	it('earns once the mistaken Station mark is cleared', async () => {
		const table = await createTable()
		const first = await placeRound({ 'X-Table-Token': table.token }, 'cust_1')
		await operator(`/tabs/${first.tab.id}/close`, {
			paymentMethod: 'counter',
			rungUpOnStation: true,
		})
		await processLoyaltyOutbox(orgId, { now: LATER() })
		expect((await balanceOf(orgId, memberId)).points).toBe(50)

		const cleared = await operator(`/tabs/${first.tab.id}/clear-station-flag`)
		expect(cleared.status).toBe(200)
		expect((await cleared.json()).tab.rungUpOnStation).toBe(false)
		await processLoyaltyOutbox(orgId, { now: LATER() })

		expect((await tabRow(first.tab.id))?.rungUpOnStation).toBe(false)
		expect((await purchasesFor(first.tab.id))[0]).toMatchObject({
			memberId,
			state: 'completed',
			excludedReason: null,
		})
		// 50 + 8 earned on $8.00 of tea.
		expect(await balanceOf(orgId, memberId)).toEqual({
			points: 58,
			reserved: 0,
			available: 58,
		})

		// Clearing is not a second door in: only a flagged counter close has it.
		const again = await operator(`/tabs/${first.tab.id}/clear-station-flag`)
		expect(again.status).toBe(409)
		const missing = await operator(`/tabs/tab_missing/clear-station-flag`)
		expect(missing.status).toBe(404)
	})

	it('lists counter closes marked as rung up on a till for a day, newest close first', async () => {
		const tabIds: string[] = []
		for (const label of ['T1', 'T2', 'T3', 'T4', 'T5']) {
			const table = await createTable(label)
			tabIds.push((await placeRound({ 'X-Table-Token': table.token })).tab.id)
		}
		const [earlier, later, unmarked, dayOld, stillOpen] = tabIds
		for (const [tabId, rungUpOnStation] of [
			[earlier, true],
			[later, true],
			[unmarked, false],
			[dayOld, true],
		] as const) {
			const closed = await operator(`/tabs/${tabId}/close`, {
				paymentMethod: 'counter',
				...(rungUpOnStation ? { rungUpOnStation } : {}),
			})
			expect(closed.status).toBe(200)
		}
		const db = await getTenantDb(orgId)
		const now = Date.now()
		await db
			.update(qrTabs)
			.set({ closedAt: now - 60_000 })
			.where(eq(qrTabs.id, earlier!))
		await db
			.update(qrTabs)
			.set({ closedAt: now - QR_STATION_MARK_LISTED_MS - 60_000 })
			.where(eq(qrTabs.id, dayOld!))

		async function listed() {
			const response = await request('/operator/qr/tabs?status=station', {
				headers: { authorization: `Bearer ${await operatorJwt()}` },
			})
			expect(response.status).toBe(200)
			const body = (await response.json()) as {
				tabs: Array<{ id: string; rungUpOnStation: boolean }>
			}
			return body.tabs
		}
		const marked = await listed()
		expect(marked.map((tab) => tab.id)).toEqual([later, earlier])
		expect(marked.every((tab) => tab.rungUpOnStation)).toBe(true)
		expect(marked.some((tab) => tab.id === stillOpen)).toBe(false)

		const cleared = await operator(`/tabs/${later}/clear-station-flag`)
		expect(cleared.status).toBe(200)
		expect((await listed()).map((tab) => tab.id)).toEqual([earlier])
	})

	it('gives the reward back when staff void the tab', async () => {
		const table = await createTable()
		const first = await placeRound({ 'X-Table-Token': table.token }, 'cust_1')
		await serveAll(first.tab.id)
		await payIntent(first.tab.tabToken, {
			customerId: 'cust_1',
			loyalty: rewardSelection(),
		})

		const voided = await operator(`/tabs/${first.tab.id}/void`, {
			reason: 'Walked out',
		})
		expect(voided.status).toBe(200)
		await processLoyaltyOutbox(orgId, { now: LATER() })

		const [redemption] = await redemptionsFor(first.tab.id)
		expect(redemption).toMatchObject({
			state: 'released',
			releaseReason: 'tab_voided',
		})
		expect(await balanceOf(orgId, memberId)).toEqual({
			points: 50,
			reserved: 0,
			available: 50,
		})
		expect((await purchasesFor(first.tab.id))[0]?.state).toBe('excluded')
		expect((await tabRow(first.tab.id))?.loyaltyDiscountCents).toBe(0)
	})

	it('gives the reward back when the payment fails or expires, then pays in full', async () => {
		const table = await createTable()
		const first = await placeRound({ 'X-Table-Token': table.token }, 'cust_1')
		await serveAll(first.tab.id)

		const declined = await payIntent(first.tab.tabToken, {
			customerId: 'cust_1',
			loyalty: rewardSelection(),
		})
		// $8.00 less $5.00, plus 10% tax on $3.00.
		expect(declined.amountCents).toBe(330)
		expect((await bind(declined, 'cs_test_failed')).status).toBe(200)
		expect(await paymentEvent(declined, 'cs_test_failed', 'failed')).toBe(
			'failed',
		)
		expect((await balanceOf(orgId, memberId)).reserved).toBe(0)

		const lapsed = await payIntent(first.tab.tabToken, {
			customerId: 'cust_1',
			loyalty: rewardSelection(),
		})
		expect((await balanceOf(orgId, memberId)).reserved).toBe(10)
		expect((await bind(lapsed, 'cs_test_expired')).status).toBe(200)
		expect(await paymentEvent(lapsed, 'cs_test_expired', 'expired')).toBe(
			'expired',
		)
		const released = await redemptionsFor(first.tab.id)
		expect(released.map((row) => row.state)).toEqual(['released', 'released'])
		expect(released.map((row) => row.releaseReason).sort()).toEqual([
			'payment_expired',
			'payment_failed',
		])
		expect(await tabRow(first.tab.id)).toMatchObject({
			paymentStatus: 'unpaid',
			paymentAmountCents: null,
			loyaltyDiscountCents: 0,
		})

		const full = await payIntent(first.tab.tabToken, { customerId: 'cust_1' })
		expect(full).toMatchObject({ amountCents: 880, loyaltyDiscountCents: 0 })
		expect(await payOnline(full, 'cs_test_full')).toBe('paid')
		await processLoyaltyOutbox(orgId, { now: LATER() })
		expect(await balanceOf(orgId, memberId)).toEqual({
			points: 58,
			reserved: 0,
			available: 58,
		})
	})

	it('re-asks with the reward on the rounds that still count when staff cancel one', async () => {
		const table = await createTable()
		const first = await placeRound({ 'X-Table-Token': table.token }, 'cust_1')
		const second = await placeRound({ 'X-Tab-Token': first.tab.tabToken })
		await serveAll(first.tab.id, 'ready')
		const stale = await payIntent(first.tab.tabToken, {
			customerId: 'cust_1',
			loyalty: rewardSelection(),
		})
		expect(stale.amountCents).toBe(1210)

		const cancelled = await updateOperatorOrder(orgId, second.order.id, {
			status: 'cancelled',
		})
		expect(cancelled.ok).toBe(true)
		// The payment can no longer settle the tab at the price it froze.
		const refused = await bind(stale, 'cs_test_stale')
		expect(refused.status).toBe(409)
		expect((await refused.json()).error).toBe('amount_changed')

		const fresh = await payIntent(first.tab.tabToken, {
			customerId: 'cust_1',
			loyalty: rewardSelection(),
		})
		expect(fresh.amountCents).toBe(330)
		const rows = await redemptionsFor(first.tab.id)
		expect(rows.map((row) => row.state).sort()).toEqual(['bound', 'released'])
		expect(rows.find((row) => row.state === 'released')?.releaseReason).toBe(
			'payment_restarted',
		)
		expect((await balanceOf(orgId, memberId)).reserved).toBe(10)

		// Asking again without the reward gives it back.
		const plain = await payIntent(first.tab.tabToken, { customerId: 'cust_1' })
		expect(plain).toMatchObject({ amountCents: 880, loyaltyDiscountCents: 0 })
		expect((await balanceOf(orgId, memberId)).reserved).toBe(0)
	})

	describe('a Checkout.com page that outlives the tab’s payment hold', () => {
		async function bindCheckout(intent: PayIntent, sessionId: string) {
			const response = await system('/payment-session', {
				orgId,
				orderId: intent.orderRef,
				sessionId,
				processor: 'checkout',
			})
			expect(response.status).toBe(200)
		}

		async function checkoutPaid(intent: PayIntent, sessionId: string) {
			const response = await system('/payment-status', {
				orgId,
				orderId: intent.orderRef,
				sessionId,
				processor: 'checkout',
				status: 'paid',
				amountCents: intent.amountCents,
				currency: 'usd',
			})
			expect(response.status).toBe(200)
			return (await response.json()).paymentStatus as string
		}

		/** The page was bound this long ago: past the 45-minute hold. */
		async function ageBinding(tabId: string, ageMs: number) {
			const db = await getTenantDb(orgId)
			await db
				.update(qrTabs)
				.set({ paymentEventAt: Date.now() - ageMs })
				.where(eq(qrTabs.id, tabId))
		}

		/** A tab with a 5.00 reward bound to an open Checkout.com page. */
		async function rewardOnCheckoutPage(ageMs: number) {
			const table = await createTable()
			const first = await placeRound({ 'X-Table-Token': table.token }, 'cust_1')
			await serveAll(first.tab.id)
			const discounted = await payIntent(first.tab.tabToken, {
				customerId: 'cust_1',
				loyalty: rewardSelection(),
			})
			expect(discounted).toMatchObject({
				amountCents: 330,
				loyaltyDiscountCents: 500,
			})
			await bindCheckout(discounted, 'cko_page_1')
			await ageBinding(first.tab.id, ageMs)
			return { first, discounted }
		}

		it('a new pay request holds the reward for review while the old page can still take money', async () => {
			const { first, discounted } = await rewardOnCheckoutPage(50 * 60_000)

			const plain = await payIntent(first.tab.tabToken, {
				customerId: 'cust_1',
			})
			expect(plain).toMatchObject({ amountCents: 880, loyaltyDiscountCents: 0 })
			const [held] = await redemptionsFor(first.tab.id)
			expect(held).toMatchObject({
				state: 'review',
				reviewReason: 'payment_uncertain',
			})
			expect(await balanceOf(orgId, memberId)).toEqual({
				points: 50,
				reserved: 10,
				available: 40,
			})

			// The guest pays the old, discounted page after all: the money is
			// kept for review and the reward's points stay held with it.
			expect(await checkoutPaid(discounted, 'cko_page_1')).toBe('review')
			expect((await tabRow(first.tab.id))?.paymentStatus).toBe('review')
			expect((await redemptionsFor(first.tab.id))[0]?.state).toBe('review')
			expect(await balanceOf(orgId, memberId)).toMatchObject({
				points: 50,
				reserved: 10,
			})
		})

		it('the held reward comes back once the tab is paid in full on the new page', async () => {
			const { first } = await rewardOnCheckoutPage(50 * 60_000)
			const plain = await payIntent(first.tab.tabToken, {
				customerId: 'cust_1',
			})
			expect(await payOnline(plain, 'cs_test_full_after_cko')).toBe('paid')
			await processLoyaltyOutbox(orgId, { now: LATER() })
			expect((await redemptionsFor(first.tab.id))[0]).toMatchObject({
				state: 'released',
				releaseReason: 'reward_not_used',
			})
			expect((await purchasesFor(first.tab.id))[0]).toMatchObject({
				state: 'completed',
				awardedPoints: 8,
			})
			expect(await balanceOf(orgId, memberId)).toEqual({
				points: 58,
				reserved: 0,
				available: 58,
			})
		})

		it('a new round holds the reward for review while the old page can still take money', async () => {
			const { first } = await rewardOnCheckoutPage(50 * 60_000)
			await placeRound({ 'X-Tab-Token': first.tab.tabToken })
			expect((await redemptionsFor(first.tab.id))[0]).toMatchObject({
				state: 'review',
				reviewReason: 'payment_uncertain',
			})
			expect(await tabRow(first.tab.id)).toMatchObject({
				paymentStatus: 'unpaid',
				paymentSessionId: null,
				loyaltyDiscountCents: 0,
			})
			expect((await balanceOf(orgId, memberId)).reserved).toBe(10)
		})

		it('gives the reward back once the old page can no longer be paid', async () => {
			const { first } = await rewardOnCheckoutPage(25 * 60 * 60_000)
			await placeRound({ 'X-Tab-Token': first.tab.tabToken })
			expect((await redemptionsFor(first.tab.id))[0]).toMatchObject({
				state: 'released',
				releaseReason: 'tab_changed',
			})
			expect(await balanceOf(orgId, memberId)).toMatchObject({
				points: 50,
				reserved: 0,
			})
		})
	})

	it('keeps a shared tab with the first member: another member cannot spend a reward on it', async () => {
		const otherMemberId = await addMember('cust_2', '+15551230002')
		const table = await createTable()
		const first = await placeRound({ 'X-Table-Token': table.token }, 'cust_1')
		// The second member's round goes on; the claim stays.
		await placeRound({ 'X-Table-Token': table.token }, 'cust_2')
		await serveAll(first.tab.id)

		const quote = await tabQuote(first.tab.tabToken, {}, 'cust_2')
		expect(quote.status).toBe(409)
		expect((await quote.json()).error).toBe('already_claimed')
		const refused = await pay(first.tab.tabToken, {
			customerId: 'cust_2',
			loyalty: rewardSelection(),
		})
		expect(refused.status).toBe(409)
		expect((await refused.json()).error).toBe('already_claimed')
		expect(await redemptionsFor(first.tab.id)).toHaveLength(0)
		expect((await balanceOf(orgId, otherMemberId)).reserved).toBe(0)

		// Paying without a reward goes on, and the first member collects.
		const intent = await payIntent(first.tab.tabToken, {
			customerId: 'cust_2',
		})
		expect(intent.amountCents).toBe(1760)
		expect(await payOnline(intent, 'cs_test_shared')).toBe('paid')
		await processLoyaltyOutbox(orgId, { now: LATER() })
		expect((await balanceOf(orgId, memberId)).points).toBe(66)
		expect((await balanceOf(orgId, otherMemberId)).points).toBe(50)
		const purchases = await purchasesFor(first.tab.id)
		expect(purchases).toHaveLength(1)
		expect(purchases[0]?.memberId).toBe(memberId)
	})

	it('lets the member who pays a guest tab collect its points', async () => {
		const table = await createTable()
		const first = await placeRound({ 'X-Table-Token': table.token })
		await serveAll(first.tab.id)
		expect(await purchasesFor(first.tab.id)).toHaveLength(0)

		const intent = await payIntent(first.tab.tabToken, { customerId: 'cust_1' })
		expect(await payOnline(intent, 'cs_test_guest_tab')).toBe('paid')
		await processLoyaltyOutbox(orgId, { now: LATER() })
		expect((await purchasesFor(first.tab.id))[0]).toMatchObject({
			memberId,
			state: 'completed',
		})
		expect((await balanceOf(orgId, memberId)).points).toBe(58)
	})

	it('opens the account of a customer who verified before the program went live when they claim a tab, and earns', async () => {
		await insertCustomer(orgId, { id: 'cust_early', phone: '+15551230009' })
		const db = await getTenantDb(orgId)
		const accounts = () =>
			db
				.select()
				.from(loyaltyMembers)
				.where(eq(loyaltyMembers.customerId, 'cust_early'))
				.all()
		expect(await accounts()).toHaveLength(0)

		const table = await createTable()
		const first = await placeRound({ 'X-Table-Token': table.token })
		await serveAll(first.tab.id)
		const intent = await payIntent(first.tab.tabToken, {
			customerId: 'cust_early',
		})
		expect(await payOnline(intent, 'cs_test_early')).toBe('paid')
		await processLoyaltyOutbox(orgId, { now: LATER() })
		const [account] = await accounts()
		expect(account).toBeDefined()
		expect((await purchasesFor(first.tab.id))[0]).toMatchObject({
			memberId: account!.id,
			state: 'completed',
		})
		expect((await balanceOf(orgId, account!.id)).points).toBe(8)
	})

	it('earns nothing for a tab nobody signed in to', async () => {
		const table = await createTable()
		const first = await placeRound({ 'X-Table-Token': table.token })
		await serveAll(first.tab.id)
		const intent = await payIntent(first.tab.tabToken)
		expect(await payOnline(intent, 'cs_test_guest')).toBe('paid')
		await processLoyaltyOutbox(orgId, { now: LATER() })
		expect(await purchasesFor(first.tab.id)).toHaveLength(0)
		expect((await balanceOf(orgId, memberId)).points).toBe(50)
	})

	it('refuses a reward it cannot apply as shown, and holds nothing', async () => {
		const table = await createTable()
		const first = await placeRound({ 'X-Table-Token': table.token }, 'cust_1')
		await serveAll(first.tab.id)

		const guest = await pay(first.tab.tabToken, { loyalty: rewardSelection() })
		expect(guest.status).toBe(401)

		const changed = await pay(first.tab.tabToken, {
			customerId: 'cust_1',
			loyalty: rewardSelection({ expectedDiscountMinor: 400 }),
		})
		expect(changed.status).toBe(409)
		expect(await changed.json()).toMatchObject({
			error: 'cart_changed',
			details: { discountMinor: 500 },
		})

		const stale = await pay(first.tab.tabToken, {
			customerId: 'cust_1',
			loyalty: rewardSelection({ rewardVersion: 2 }),
		})
		expect((await stale.json()).error).toBe('stale_version')

		const pricey = (
			await makeReward(orgId, rewardDefinition({ pointsCost: 500 }))
		).id
		const short = await pay(first.tab.tabToken, {
			customerId: 'cust_1',
			loyalty: rewardSelection({ rewardId: pricey }),
		})
		expect((await short.json()).error).toBe('insufficient_points')

		// A reward worth the whole tab cannot go through a card payment.
		const whole = (
			await makeReward(
				orgId,
				rewardDefinition({ discount: { type: 'fixed', amountMinor: 1000 } }),
			)
		).id
		const free = await pay(first.tab.tabToken, {
			customerId: 'cust_1',
			loyalty: rewardSelection({ rewardId: whole, expectedDiscountMinor: 800 }),
		})
		expect(free.status).toBe(422)
		expect((await free.json()).error).toBe('reward_covers_total')

		seedLoyaltyContextForTest(orgId, {
			enabled: true,
			redemption: false,
		})
		const off = await pay(first.tab.tabToken, {
			customerId: 'cust_1',
			loyalty: rewardSelection(),
		})
		expect(off.status).toBe(403)
		expect((await off.json()).error).toBe('redemption_disabled')

		seedLoyaltyContextForTest(orgId, {
			enabled: false,
			redemption: false,
		})
		const disabled = await pay(first.tab.tabToken, {
			customerId: 'cust_1',
			loyalty: rewardSelection(),
		})
		expect(disabled.status).toBe(403)
		expect((await disabled.json()).error).toBe('loyalty_disabled')

		// Nothing cached and App cannot answer (this harness has no flag route).
		invalidateLoyaltyContext(orgId)
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
		const unknown = await pay(first.tab.tabToken, {
			customerId: 'cust_1',
			loyalty: rewardSelection(),
		})
		errors.mockRestore()
		expect(unknown.status).toBe(503)
		expect((await unknown.json()).error).toBe('loyalty_unavailable')

		expect(await redemptionsFor(first.tab.id)).toHaveLength(0)
		expect(await balanceOf(orgId, memberId)).toEqual({
			points: 50,
			reserved: 0,
			available: 50,
		})
		expect((await tabRow(first.tab.id))?.paymentAmountCents).toBeNull()
	})
})
