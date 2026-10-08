import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	restaurantOrders,
} from '@repo/tenant-db'
import { restaurantOrderRequestSchema } from '@repo/common/restaurant-orders'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { findActiveOrganizationById } from '../lib/origin.ts'
import {
	bindPaymentSession,
	placeOrder,
	type PlaceOrderSuccess,
} from '../services/order-service.ts'
import { operatorOrderRoutes } from './operator-orders.ts'
import { orderSystemRoutes } from './order-system.ts'

vi.mock('../lib/origin.ts', () => ({
	findActiveOrganizationById: vi.fn(),
	resolveOrganizationForBrowserAuth: vi.fn(async () => null),
	resolvePublishedOrganization: vi.fn(async () => null),
}))

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const orgId = 'org_system_adversarial_1'
const otherOrgId = 'org_system_adversarial_2'
const internalToken = 'test-internal-token-very-long-and-secure-12345'
const operatorToken = 'test-operator-token-very-long-and-secure-12345'
const jwtSecret = 'test-jwt-secret-123456789'
const hmacSecret = 'test-hmac-secret-123456789'

const ORG = {
	id: orgId,
	slug: 'test-org',
	customDomain: null,
	hasProvisionedDb: true,
	dataRegion: 'us',
}
const OTHER_ORG = { ...ORG, id: otherOrgId, slug: 'other-org' }

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

function menuContext(targetOrgId = orgId) {
	return {
		orgId: targetOrgId,
		dataRegion: 'us',
		menu: {
			organization: { id: targetOrgId, slug: 'test-org', currency: 'USD' },
			locations: [
				{
					id: 'loc-1',
					name: 'Main Street',
					timezone: 'UTC',
					taxRate: 8.25,
					prepTime: 15,
					currency: 'USD',
					fulfillmentOptions: {
						pickup: true,
						delivery: true,
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
		onlinePayment: { enabled: true, processor: 'connect' },
	}
}

function orderBody(overrides: Record<string, unknown> = {}) {
	return {
		slug: 'test-org',
		idempotencyKey: crypto.randomUUID(),
		locale: 'en',
		locationId: 'loc-1',
		fulfillment: 'pickup',
		paymentMethod: 'handoff',
		contact: { name: 'Rana Khalid', phone: '+15551234567' },
		tipPercent: 0,
		lines: [{ itemId: 'item-burger', quantity: 2, options: [] }],
		...overrides,
	}
}

describe('Adversarial: order system (App broker) + operator routes', () => {
	let directory: string
	let app: Hono

	async function placeOnlineOrder(targetOrg = ORG): Promise<PlaceOrderSuccess> {
		const result = await placeOrder({
			organization: targetOrg as never,
			request: restaurantOrderRequestSchema.parse(
				orderBody({ paymentMethod: 'online' }),
			),
			customerId: null,
		})
		expect(result.ok).toBe(true)
		if (!result.ok) throw new Error(result.failure.message)
		return result.data
	}

	async function placeHandoffOrder(
		targetOrg = ORG,
	): Promise<PlaceOrderSuccess> {
		const result = await placeOrder({
			organization: targetOrg as never,
			request: restaurantOrderRequestSchema.parse(orderBody()),
			customerId: null,
		})
		expect(result.ok).toBe(true)
		if (!result.ok) throw new Error(result.failure.message)
		return result.data
	}

	function systemPost(pathname: string, body: unknown, token = internalToken) {
		return app.request(`/api/orders${pathname}`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(body),
		})
	}

	async function operatorJwt(
		scope: string | null = 'orders:read',
		tokenOrgId = orgId,
		secret = operatorToken,
		audience = 'tenant-api-operator',
	) {
		return new SignJWT({
			orgId: tokenOrgId,
			role: 'operator',
			scope: scope ?? undefined,
		})
			.setProtectedHeader({ alg: 'HS256' })
			.setAudience(audience)
			.setIssuer(brand.shortName)
			.setExpirationTime('1h')
			.sign(new TextEncoder().encode(secret))
	}

	async function operatorCall(
		method: string,
		pathname: string,
		token: string,
		body?: unknown,
	) {
		return app.request(`/operator/orders${pathname}`, {
			method,
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		})
	}

	beforeEach(async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'order-system-test-'))
		vi.stubEnv('TENANT_DB_DIR', directory)
		vi.stubEnv('DATA_REGION', 'us')
		vi.stubEnv('INTERNAL_COMMAND_TOKEN', internalToken)
		vi.stubEnv('TENANT_OPERATOR_TOKEN', operatorToken)
		vi.stubEnv('JWT_SECRET', jwtSecret)
		vi.stubEnv('AUTH_HMAC_SECRET', hmacSecret)
		vi.stubEnv('APP_URL', 'https://app.test')

		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = typeof input === 'string' ? input : input.toString()
				if (url.includes('/resources/order-context')) {
					const params = new URL(url).searchParams
					return new Response(
						JSON.stringify(menuContext(params.get('orgId') ?? orgId)),
						{
							status: 200,
							headers: { 'content-type': 'application/json' },
						},
					)
				}
				return new Response('not found', { status: 404 })
			}),
		)

		vi.mocked(findActiveOrganizationById).mockImplementation(async (id) => {
			if (id === orgId) return ORG as never
			if (id === otherOrgId) return OTHER_ORG as never
			return null
		})

		await provisionTenantDb(orgId)
		await provisionTenantDb(otherOrgId)
		app = new Hono()
		app.route('/api/orders', orderSystemRoutes)
		app.route('/operator/orders', operatorOrderRoutes)
	})

	afterEach(async () => {
		try {
			await destroyTenantDb(orgId)
			await destroyTenantDb(otherOrgId)
			fs.rmSync(directory, { recursive: true, force: true })
		} catch {}
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
		vi.clearAllMocks()
	})

	// -----------------------------------------------------------------------
	// System auth
	// -----------------------------------------------------------------------

	it('rejects missing and wrong internal command tokens', async () => {
		const missing = await app.request('/api/orders/quote', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({}),
		})
		expect(missing.status).toBe(401)

		const wrong = await systemPost('/quote', {}, 'wrong-token-entirely-12345')
		expect(wrong.status).toBe(401)
	})

	it('rejects quote requests with extra properties or bad org ids', async () => {
		const extra = await systemPost('/quote', {
			orgId,
			orderId: 'ord_1',
			paymentToken: 'x'.repeat(32),
			contact: { phone: '+15551234567' },
		})
		expect(extra.status).toBe(400)

		const badOrg = await systemPost('/quote', {
			orgId: 'bad org!',
			orderId: 'ord_1',
			paymentToken: 'x'.repeat(32),
		})
		expect(badOrg.status).toBe(400)
	})

	it('fails closed on region mismatch and unknown organizations', async () => {
		vi.mocked(findActiveOrganizationById).mockResolvedValue({
			...ORG,
			dataRegion: 'ksa',
		} as never)
		const mismatch = await systemPost('/quote', {
			orgId,
			orderId: 'ord_1',
			paymentToken: 'x'.repeat(32),
		})
		expect(mismatch.status).toBe(409)
		expect((await mismatch.json()).error).toBe('region_mismatch')

		vi.mocked(findActiveOrganizationById).mockImplementation(async (id) => {
			if (id === orgId) return ORG as never
			if (id === otherOrgId) return OTHER_ORG as never
			return null
		})
		const unknown = await systemPost('/quote', {
			orgId: 'org_does_not_exist',
			orderId: 'ord_1',
			paymentToken: 'x'.repeat(32),
		})
		expect(unknown.status).toBe(404)
	})

	// -----------------------------------------------------------------------
	// Quote
	// -----------------------------------------------------------------------

	it('quote returns amounts and lifecycle state only — never PII', async () => {
		const placed = await placeOnlineOrder()
		const response = await systemPost('/quote', {
			orgId,
			orderId: placed.order.id,
			paymentToken: placed.paymentToken,
		})
		expect(response.status).toBe(200)
		const body = await response.json()
		expect(Object.keys(body).sort()).toEqual([
			'currency',
			'holdExpiresAt',
			'orderId',
			'orgId',
			'status',
			'totalCents',
		])
		expect(body.totalCents).toBe(2165) // 2000 + 8.25% tax
		expect(body.currency).toBe('USD')
		expect(body.holdExpiresAt).toBeTruthy()
	})

	it('quote rejects forged payment tokens and handoff orders', async () => {
		const placed = await placeOnlineOrder()
		const forged = await systemPost('/quote', {
			orgId,
			orderId: placed.order.id,
			paymentToken: 'f'.repeat(64),
		})
		expect(forged.status).toBe(403)

		const handoff = await placeHandoffOrder()
		const notOnline = await systemPost('/quote', {
			orgId,
			orderId: handoff.order.id,
			paymentToken: 'f'.repeat(64),
		})
		expect(notOnline.status).toBe(409)

		const missing = await systemPost('/quote', {
			orgId,
			orderId: 'ord_missing',
			paymentToken: 'f'.repeat(64),
		})
		expect(missing.status).toBe(404)
	})

	it('a quote for an order in another org database is not found (cross-org isolation)', async () => {
		const placed = await placeOnlineOrder(OTHER_ORG)
		const response = await systemPost('/quote', {
			orgId, // ask this org's node for the other org's order
			orderId: placed.order.id,
			paymentToken: placed.paymentToken,
		})
		expect(response.status).toBe(404)
	})

	// -----------------------------------------------------------------------
	// Payment session + status
	// -----------------------------------------------------------------------

	it('payment session binds exactly once and events flow monotonically', async () => {
		const placed = await placeOnlineOrder()
		const orderId = placed.order.id

		const bound = await systemPost('/payment-session', {
			orgId,
			orderId,
			sessionId: 'sess_abc123456',
			processor: 'connect',
		})
		expect(bound.status).toBe(200)

		const rebound = await systemPost('/payment-session', {
			orgId,
			orderId,
			sessionId: 'sess_abc123456',
			processor: 'connect',
		})
		expect(rebound.status).toBe(200)

		const conflict = await systemPost('/payment-session', {
			orgId,
			orderId,
			sessionId: 'sess_other_session',
			processor: 'connect',
		})
		expect(conflict.status).toBe(409)

		const paid = await systemPost('/payment-status', {
			orgId,
			orderId,
			sessionId: 'sess_abc123456',
			processor: 'connect',
			status: 'paid',
			amountCents: placed.order.totalCents,
			currency: 'USD',
		})
		expect(paid.status).toBe(200)
		expect((await paid.json()).paymentStatus).toBe('paid')

		// Duplicate webhook delivery is idempotent.
		const duplicate = await systemPost('/payment-status', {
			orgId,
			orderId,
			sessionId: 'sess_abc123456',
			processor: 'connect',
			status: 'paid',
			amountCents: placed.order.totalCents,
			currency: 'USD',
		})
		expect(duplicate.status).toBe(200)

		// Terminal states cannot regress.
		const regress = await systemPost('/payment-status', {
			orgId,
			orderId,
			sessionId: 'sess_abc123456',
			processor: 'connect',
			status: 'failed',
			amountCents: placed.order.totalCents,
			currency: 'USD',
		})
		expect(regress.status).toBe(409)
	})

	it('payment-status rejects unknown statuses and non-matching amounts', async () => {
		const placed = await placeOnlineOrder()
		await bindPaymentSession({
			orgId,
			orderId: placed.order.id,
			sessionId: 'sess_xyz789012',
			processor: 'connect',
		})

		const badStatus = await systemPost('/payment-status', {
			orgId,
			orderId: placed.order.id,
			sessionId: 'sess_xyz789012',
			processor: 'connect',
			status: 'pending',
			amountCents: placed.order.totalCents,
			currency: 'USD',
		})
		expect(badStatus.status).toBe(400)

		const badAmount = await systemPost('/payment-status', {
			orgId,
			orderId: placed.order.id,
			sessionId: 'sess_xyz789012',
			processor: 'connect',
			status: 'paid',
			amountCents: 1,
			currency: 'USD',
		})
		expect(badAmount.status).toBe(422)
	})

	it('a late paid webhook surfaces payment_review without resurrecting the order', async () => {
		const placed = await placeOnlineOrder()
		await bindPaymentSession({
			orgId,
			orderId: placed.order.id,
			sessionId: 'sess_late_arrival',
			processor: 'connect',
		})
		const db = await getTenantDb(orgId)
		await db
			.update(restaurantOrders)
			.set({ holdExpiresAt: new Date(Date.now() - 1000) })
			.where(eq(restaurantOrders.id, placed.order.id))

		const late = await systemPost('/payment-status', {
			orgId,
			orderId: placed.order.id,
			sessionId: 'sess_late_arrival',
			processor: 'connect',
			status: 'paid',
			amountCents: placed.order.totalCents,
			currency: 'USD',
		})
		expect(late.status).toBe(200)
		const body = await late.json()
		expect(body.status).toBe('payment_review')
		expect(body.paymentStatus).toBe('paid')
	})

	it('payment events for handoff orders are rejected', async () => {
		const placed = await placeHandoffOrder()
		const response = await systemPost('/payment-status', {
			orgId,
			orderId: placed.order.id,
			sessionId: 'sess_anything1',
			processor: 'connect',
			status: 'paid',
			amountCents: placed.order.totalCents,
			currency: 'USD',
		})
		expect(response.status).toBe(409)
	})

	// -----------------------------------------------------------------------
	// Operator routes: auth, scopes, region, transitions
	// -----------------------------------------------------------------------

	it('rejects unauthenticated, wrong-secret, and missing-scope operator tokens', async () => {
		const unauthenticated = await app.request('/operator/orders')
		expect(unauthenticated.status).toBe(401)

		const wrongSecret = await operatorJwt(
			'orders:read',
			orgId,
			'attacker-secret-key-12345',
		)
		expect((await operatorCall('GET', '', wrongSecret)).status).toBe(401)

		const wrongAudience = await operatorJwt(
			'orders:read',
			orgId,
			operatorToken,
			'tenant-api',
		)
		expect((await operatorCall('GET', '', wrongAudience)).status).toBe(401)

		const noScope = await operatorJwt(null)
		expect((await operatorCall('GET', '', noScope)).status).toBe(403)
	})

	it('enforces orders:read vs orders:write scopes separately', async () => {
		const placed = await placeHandoffOrder()
		const readToken = await operatorJwt('orders:read')
		const writeToken = await operatorJwt('orders:write')

		const list = await operatorCall('GET', '', readToken)
		expect(list.status).toBe(200)
		expect(list.headers.get('cache-control')).toBe('private, no-store')
		const listBody = await list.json()
		expect(listBody.orders).toHaveLength(1)
		expect(listBody.orders[0].id).toBe(placed.order.id)

		const readPatch = await operatorCall(
			'PATCH',
			`/${placed.order.id}`,
			readToken,
			{
				status: 'preparing',
			},
		)
		expect(readPatch.status).toBe(403)

		const writePatch = await operatorCall(
			'PATCH',
			`/${placed.order.id}`,
			writeToken,
			{ status: 'preparing' },
		)
		expect(writePatch.status).toBe(200)
		expect((await writePatch.json()).order.status).toBe('preparing')
	})

	it('operator reads are cross-org isolated by database', async () => {
		const placed = await placeHandoffOrder(OTHER_ORG)
		const token = await operatorJwt('orders:read', orgId)
		const response = await operatorCall('GET', `/${placed.order.id}`, token)
		expect(response.status).toBe(404)
	})

	it('operator routes fail closed on region mismatch', async () => {
		vi.mocked(findActiveOrganizationById).mockResolvedValue({
			...ORG,
			dataRegion: 'ksa',
		} as never)
		const token = await operatorJwt('orders:read')
		const response = await operatorCall('GET', '', token)
		expect(response.status).toBe(409)
	})

	it('walks the lifecycle forward and rejects invalid or backward transitions', async () => {
		const placed = await placeHandoffOrder()
		const token = await operatorJwt('orders:write')
		const id = placed.order.id

		expect(
			(await operatorCall('PATCH', `/${id}`, token, { status: 'preparing' }))
				.status,
		).toBe(200)
		expect(
			(await operatorCall('PATCH', `/${id}`, token, { status: 'ready' }))
				.status,
		).toBe(200)
		// backward
		const backward = await operatorCall('PATCH', `/${id}`, token, {
			status: 'accepted',
		})
		expect(backward.status).toBe(422)
		expect((await backward.json()).error).toBe('invalid_transition')

		expect(
			(await operatorCall('PATCH', `/${id}`, token, { status: 'completed' }))
				.status,
		).toBe(200)
		// completed is terminal
		expect(
			(await operatorCall('PATCH', `/${id}`, token, { status: 'cancelled' }))
				.status,
		).toBe(422)
	})

	it('rejects system-owned statuses in operator patches', async () => {
		const placed = await placeHandoffOrder()
		const token = await operatorJwt('orders:write')
		for (const status of ['expired', 'payment_review']) {
			const response = await operatorCall(
				'PATCH',
				`/${placed.order.id}`,
				token,
				{
					status,
				},
			)
			expect(response.status).toBe(400)
		}
	})

	it('markPaid applies only to handoff orders, never online orders', async () => {
		const handoff = await placeHandoffOrder()
		const token = await operatorJwt('orders:write')

		const completed = await operatorCall(
			'PATCH',
			`/${handoff.order.id}`,
			token,
			{
				status: 'completed',
				markPaid: true,
			},
		)
		expect(completed.status).toBe(200)
		const completedBody = await completed.json()
		expect(completedBody.order.status).toBe('completed')
		expect(completedBody.order.paymentStatus).toBe('paid')
		expect(completedBody.order.paidAt).toBeTruthy()

		const online = await placeOnlineOrder()
		const rejected = await operatorCall('PATCH', `/${online.order.id}`, token, {
			status: 'preparing',
			markPaid: true,
		})
		expect(rejected.status).toBe(409)
		expect((await rejected.json()).error).toBe('payment_not_markable')
	})

	it('operator can move a payment_review order forward after manual review', async () => {
		const placed = await placeOnlineOrder()
		await bindPaymentSession({
			orgId,
			orderId: placed.order.id,
			sessionId: 'sess_review_case',
			processor: 'connect',
		})
		const db = await getTenantDb(orgId)
		await db
			.update(restaurantOrders)
			.set({ holdExpiresAt: new Date(Date.now() - 1000) })
			.where(eq(restaurantOrders.id, placed.order.id))
		await systemPost('/payment-status', {
			orgId,
			orderId: placed.order.id,
			sessionId: 'sess_review_case',
			processor: 'connect',
			status: 'paid',
			amountCents: placed.order.totalCents,
			currency: 'USD',
		})

		const token = await operatorJwt('orders:write')
		const revived = await operatorCall('PATCH', `/${placed.order.id}`, token, {
			status: 'preparing',
		})
		expect(revived.status).toBe(200)
		expect((await revived.json()).order.status).toBe('preparing')
	})

	it('operator list supports status filters and rejects invalid ones', async () => {
		await placeHandoffOrder()
		await placeHandoffOrder()
		const token = await operatorJwt('orders:read')

		const accepted = await operatorCall('GET', '?status=accepted', token)
		expect(accepted.status).toBe(200)
		expect((await accepted.json()).orders).toHaveLength(2)

		const preparing = await operatorCall('GET', '?status=preparing', token)
		expect((await preparing.json()).orders).toHaveLength(0)

		const invalid = await operatorCall('GET', '?status=bogus', token)
		expect(invalid.status).toBe(400)
	})
})
