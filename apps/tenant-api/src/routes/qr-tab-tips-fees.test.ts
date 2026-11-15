import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	qrTabs,
	restaurantOrders,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
	findActiveOrganizationById,
	resolveOrganizationForBrowserAuth,
} from '../lib/origin.ts'
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

/**
 * A table tab paid from the phone (#118, #123): the tip is a share of the
 * subtotal or an exact amount, the fee is priced by the region on the tab's
 * subtotal and compared with what the page showed, and both are fixed by the
 * pay request and settle with the tab. Two teas at 4.00: subtotal 8.00, tax
 * 10 % = 0.80.
 */

const orgId = 'org_qr_tab_tips_fees_1'
const internalToken = 'test-internal-token-very-long-and-secure-12345'
const operatorToken = 'test-operator-token-very-long-and-secure-12345'

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

const feeSettings = (patch: Record<string, unknown> = {}) => ({
	enabled: true,
	percentBp: 300,
	fixedMinor: 0,
	capMinor: null,
	smallOrderBelowMinor: null,
	smallOrderFeeMinor: null,
	fulfillments: ['dine_in'],
	label: 'Online fee',
	explanation: 'Covers card costs.',
	taxable: false,
	...patch,
})

function context(
	extra: Record<string, unknown> = {},
	location: Record<string, unknown> = {},
) {
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
					...location,
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
		...extra,
	}
}

const withFee = (
	settings: Record<string, unknown> = feeSettings(),
	location: Record<string, unknown> = {},
) =>
	context({ serviceFee: { version: 1, locations: { 'loc-1': settings } } }, location)

type PayIntent = {
	orderRef: string
	tabPaymentToken: string
	amountCents: number
	tipCents: number
	serviceFeeCents: number
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

describe('table tab payment: tip choices and the service fee', () => {
	let directory: string
	let app: Hono
	let active: unknown

	async function request(
		pathname: string,
		init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
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

	/** A table with one served round of two teas; returns the tab's code and id. */
	async function servedTab() {
		const created = await request('/operator/qr/tables', {
			method: 'POST',
			body: { locationId: 'loc-1', label: 'T1' },
			headers: { authorization: `Bearer ${await operatorJwt()}` },
		})
		expect(created.status).toBe(201)
		const table = (await created.json()).table as { token: string }
		const round = await request('/orders', {
			method: 'POST',
			headers: { 'X-Table-Token': table.token },
			body: {
				slug: 'test-org',
				idempotencyKey: crypto.randomUUID(),
				locale: 'en',
				locationId: 'loc-1',
				fulfillment: 'dine_in',
				paymentMethod: 'handoff',
				contact: {},
				tipPercent: 0,
				lines: [{ itemId: 'item-tea', quantity: 2, options: [] }],
			},
		})
		expect(round.status).toBe(201)
		const { tab } = (await round.json()) as {
			tab: { id: string; tabToken: string }
		}
		const db = await getTenantDb(orgId)
		await db
			.update(restaurantOrders)
			.set({ status: 'completed' })
			.where(eq(restaurantOrders.tabId, tab.id))
		return tab
	}

	function pay(tabToken: string, body: Record<string, unknown> = {}) {
		return request('/orders/tab/pay', {
			method: 'POST',
			headers: { 'X-Tab-Token': tabToken },
			body: {
				slug: 'test-org',
				contact: { name: 'Lina Haddad', phone: '+1 555 222 3333' },
				...body,
			},
		})
	}

	async function intent(tabToken: string, body: Record<string, unknown> = {}) {
		const response = await pay(tabToken, body)
		expect(response.status).toBe(200)
		return (await response.json()) as PayIntent
	}

	async function paid(payIntent: PayIntent) {
		const bound = await system('/payment-session', {
			orgId,
			orderId: payIntent.orderRef,
			sessionId: 'cs_test_1',
			processor: 'connect',
		})
		expect(bound.status).toBe(200)
		const event = await system('/payment-status', {
			orgId,
			orderId: payIntent.orderRef,
			sessionId: 'cs_test_1',
			processor: 'connect',
			status: 'paid',
			amountCents: payIntent.amountCents,
			currency: 'usd',
		})
		expect(event.status).toBe(200)
		return (await event.json()).paymentStatus as string
	}

	async function tabRow(tabId: string) {
		const db = await getTenantDb(orgId)
		return db.select().from(qrTabs).where(eq(qrTabs.id, tabId)).get()
	}

	beforeEach(async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-tab-tips-fees-'))
		vi.stubEnv('TENANT_DB_DIR', directory)
		vi.stubEnv('DATA_REGION', 'us')
		vi.stubEnv('INTERNAL_COMMAND_TOKEN', internalToken)
		vi.stubEnv('TENANT_OPERATOR_TOKEN', operatorToken)
		vi.stubEnv('JWT_SECRET', 'test-jwt-secret-123456789')
		vi.stubEnv('AUTH_HMAC_SECRET', 'test-hmac-secret-123456789')
		vi.stubEnv('APP_URL', 'https://app.test')
		vi.stubEnv('QR_DINE_IN_ENABLED', '')
		active = context()
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = typeof input === 'string' ? input : input.toString()
				if (url.includes('/resources/order-context')) {
					return Response.json(active)
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
		app = new Hono()
		app.route('/orders', publicOrderRoutes)
		app.route('/operator/qr', operatorQrRoutes)
		app.route('/api/orders', orderSystemRoutes)
	})

	afterEach(async () => {
		try {
			await destroyTenantDb(orgId)
			fs.rmSync(directory, { recursive: true, force: true })
		} catch {}
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
		vi.clearAllMocks()
	})

	describe('tip', () => {
		it('still takes a share through tipPercent', async () => {
			const tab = await servedTab()
			const result = await intent(tab.tabToken, { tipPercent: 10 })
			// 8.00 + 0.80 tax + 0.80 tip.
			expect(result).toMatchObject({ tipCents: 80, amountCents: 960 })
		})

		it('charges a custom amount exactly and settles it with the tab', async () => {
			const tab = await servedTab()
			const result = await intent(tab.tabToken, { tip: { amountMinor: 150 } })
			expect(result).toMatchObject({ tipCents: 150, amountCents: 1030 })
			expect(await paid(result)).toBe('paid')
			expect(await tabRow(tab.id)).toMatchObject({
				status: 'closed',
				tipCents: 150,
				totalCents: 1030,
			})
		})

		it('refuses a tip above the cap with tip_too_large', async () => {
			const tab = await servedTab()
			const refused = await pay(tab.tabToken, { tip: { amountMinor: 20_001 } })
			expect(refused.status).toBe(422)
			expect((await refused.json()).error).toBe('tip_too_large')
			const allowed = await pay(tab.tabToken, { tip: { amountMinor: 20_000 } })
			expect(allowed.status).toBe(200)
		})

		it('refuses tip together with a non-zero tipPercent', async () => {
			const tab = await servedTab()
			const response = await pay(tab.tabToken, {
				tip: { percent: 10 },
				tipPercent: 10,
			})
			expect(response.status).toBe(400)
		})

		it('refuses any tip where table tips are switched off', async () => {
			active = context(
				{},
				{
					inHouseTips: {
						pickupTips: true,
						deliveryTips: true,
						dineInTips: false,
					},
				},
			)
			const tab = await servedTab()
			const refused = await pay(tab.tabToken, { tipPercent: 10 })
			expect(refused.status).toBe(422)
			expect((await refused.json()).error).toBe('tips_disabled')
			// No tip is still fine.
			expect((await pay(tab.tabToken, { tipPercent: 0 })).status).toBe(200)
		})
	})

	describe('service fee', () => {
		it('adds the fee the region priced, never on the tip, and settles it with the tab', async () => {
			active = withFee()
			const tab = await servedTab()
			const result = await intent(tab.tabToken, {
				tipPercent: 10,
				expectedServiceFeeMinor: 24,
			})
			// 8.00 + 0.80 tax + 0.80 tip + 3 % of 8.00 (0.24).
			expect(result).toMatchObject({
				tipCents: 80,
				serviceFeeCents: 24,
				amountCents: 984,
			})
			expect(await paid(result)).toBe('paid')
			expect(await tabRow(tab.id)).toMatchObject({
				status: 'closed',
				serviceFeeCents: 24,
				serviceFeeTaxCents: 0,
				serviceFeeLabel: 'Online fee',
				tipCents: 80,
				taxCents: 80,
				totalCents: 984,
			})
		})

		it('refuses a page that showed another fee with 409 service_fee_changed', async () => {
			active = withFee()
			const tab = await servedTab()
			for (const expected of [0, 5, 999]) {
				const refused = await pay(tab.tabToken, {
					expectedServiceFeeMinor: expected,
				})
				expect(refused.status).toBe(409)
				const body = await refused.json()
				expect(body.error).toBe('service_fee_changed')
				expect(body.details.serviceFeeMinor).toBe(24)
			}
			// Nothing was bound by a refused ask.
			expect((await tabRow(tab.id))?.paymentAmountCents).toBeNull()
		})

		it('caps the fee after the percentage plus the fixed amount', async () => {
			active = withFee(feeSettings({ fixedMinor: 50, capMinor: 60 }))
			const tab = await servedTab()
			const result = await intent(tab.tabToken, { expectedServiceFeeMinor: 60 })
			expect(result.serviceFeeCents).toBe(60)
		})

		it('adds tax on a taxable fee and puts it in the tab’s tax', async () => {
			active = withFee(feeSettings({ taxable: true }))
			const tab = await servedTab()
			const result = await intent(tab.tabToken, { expectedServiceFeeMinor: 24 })
			// Fee 0.24, its tax 10 % = 0.02.
			expect(result.amountCents).toBe(880 + 24 + 2)
			await paid(result)
			expect(await tabRow(tab.id)).toMatchObject({
				serviceFeeCents: 24,
				serviceFeeTaxCents: 2,
				taxCents: 82,
				totalCents: 906,
			})
		})

		it('charges no fee when the fee does not cover tables', async () => {
			active = withFee(feeSettings({ fulfillments: ['pickup'] }))
			const tab = await servedTab()
			const result = await intent(tab.tabToken, {})
			expect(result).toMatchObject({ serviceFeeCents: 0, amountCents: 880 })
		})

		it('refuses a paid-for amount that no longer matches once the fee changed', async () => {
			active = withFee()
			const tab = await servedTab()
			const result = await intent(tab.tabToken, { expectedServiceFeeMinor: 24 })
			// A page that pays an amount other than the bound one is kept for review.
			const bound = await system('/payment-session', {
				orgId,
				orderId: result.orderRef,
				sessionId: 'cs_test_x',
				processor: 'connect',
			})
			expect(bound.status).toBe(200)
			const event = await system('/payment-status', {
				orgId,
				orderId: result.orderRef,
				sessionId: 'cs_test_x',
				processor: 'connect',
				status: 'paid',
				amountCents: result.amountCents - 24,
				currency: 'usd',
			})
			expect((await event.json()).paymentStatus).toBe('review')
			expect((await tabRow(tab.id))?.status).toBe('open')
		})

		it('refuses a fee it cannot read instead of charging without it', async () => {
			active = context({
				serviceFee: { version: 1, locations: { 'loc-1': { enabled: true } } },
			})
			const tab = await servedTab()
			const refused = await pay(tab.tabToken, {})
			expect(refused.status).toBe(503)
			expect((await refused.json()).error).toBe('service_fee_unavailable')
		})

		it('re-serves the same bound payment, fee included', async () => {
			active = withFee()
			const tab = await servedTab()
			const first = await intent(tab.tabToken, { expectedServiceFeeMinor: 24 })
			const second = await intent(tab.tabToken, { expectedServiceFeeMinor: 24 })
			expect(second).toMatchObject({
				amountCents: first.amountCents,
				serviceFeeCents: 24,
			})
		})
	})

	describe('what the tab page reads', () => {
		it('shows the fee settings and the tab’s tip buttons', async () => {
			active = withFee(feeSettings(), {
				tipSettings: {
					qrTab: {
						choices: [{ percent: 12 }, { amountMinor: 200 }],
						defaultIndex: 0,
						allowCustom: true,
					},
				},
			})
			const tab = await servedTab()
			const response = await request('/orders/tab?slug=test-org', {
				headers: { 'X-Tab-Token': tab.tabToken },
			})
			expect(response.status).toBe(200)
			const { tab: view } = await response.json()
			expect(view.serviceFee).toMatchObject({
				taxRatePercent: 10,
				settings: { percentBp: 300, label: 'Online fee', explanation: 'Covers card costs.' },
			})
			expect(view.tipChoices).toEqual({
				enabled: true,
				currency: 'USD',
				settings: {
					choices: [{ percent: 12 }, { amountMinor: 200 }],
					defaultIndex: 0,
					allowCustom: true,
				},
			})
		})

		it('keeps the old buttons and shows no fee while nothing is saved', async () => {
			const tab = await servedTab()
			const response = await request('/orders/tab?slug=test-org', {
				headers: { 'X-Tab-Token': tab.tabToken },
			})
			const { tab: view } = await response.json()
			expect(view.serviceFee).toBeNull()
			expect(view.tipChoices.settings.choices).toEqual([
				{ percent: 10 },
				{ percent: 15 },
				{ percent: 20 },
			])
			expect(view.tipChoices.settings.defaultIndex).toBeNull()
		})

		it('says when table tips are switched off', async () => {
			active = context(
				{},
				{
					inHouseTips: {
						pickupTips: true,
						deliveryTips: true,
						dineInTips: false,
					},
				},
			)
			const tab = await servedTab()
			const response = await request('/orders/tab?slug=test-org', {
				headers: { 'X-Tab-Token': tab.tabToken },
			})
			expect((await response.json()).tab.tipChoices.enabled).toBe(false)
		})

		it('a fee that is off for tables is not shown', async () => {
			active = withFee(feeSettings({ fulfillments: ['pickup'] }))
			const tab = await servedTab()
			const response = await request('/orders/tab?slug=test-org', {
				headers: { 'X-Tab-Token': tab.tabToken },
			})
			expect((await response.json()).tab.serviceFee).toBeNull()
		})
	})
})
