import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import {
	destroyTenantDb,
	discountRedemptions,
	getTenantDb,
	provisionTenantDb,
	qrTabPayments,
	qrTabRefunds,
	restaurantOrderRefunds,
	restaurantOrders,
} from '@repo/tenant-db'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import * as jose from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type PublishedOrganization } from '../lib/origin.ts'
import {
	orderRefundKicksIdle,
	setOrderRefundKickForTest,
} from '../lib/order-refund-kick.ts'
import { reconcileLoyaltySource } from '../services/loyalty-purchase-service.ts'
import { getLoyaltyReport } from '../services/loyalty-report-service.ts'
import {
	activateProgram,
	balanceOf,
	claimAndQueue,
	insertCustomer,
	insertOrder,
	insertRound,
	insertTab,
	LOC_1,
	LOC_2,
	makeMember,
	NOW,
} from '../services/loyalty-test-fixture.ts'
import { runOrdersTickForOrg } from '../services/order-acceptance.ts'
import { linkReceiptOrder } from '../services/order-link-access.ts'
import {
	OWED_CANCEL_REFUNDS_BATCH,
	processOwedCancelRefunds,
} from '../services/order-provider-refund-service.ts'
import { receiptOrder } from '../services/order-service.ts'
import { operatorOrderRoutes } from './operator-orders.ts'
import { orderSystemRoutes } from './order-system.ts'

const OPERATOR_SECRET = 'test-operator-secret-key-for-provider-refunds-32!'
const INTERNAL = 'test-internal-token-for-provider-refunds-123456'
const ORG = 'org_prref_a'
const ORG_B = 'org_prref_b'

const orgs = vi.hoisted(() => new Map<string, PublishedOrganization>())
vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	findActiveOrganizationById: vi.fn(async (id: string) => orgs.get(id) ?? null),
}))

const app = new Hono()
app.route('/api/orders', orderSystemRoutes)
app.route('/operator/orders', operatorOrderRoutes)

let tempDir: string
let counter = 0
const kicks: Array<{ orgId: string; refundId: string }> = []
const NOTE = 'Guest asked for a refund'

async function system(
	pathname: string,
	body: unknown,
	options: { token?: string | null } = {},
) {
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
	}
	const token = options.token === undefined ? INTERNAL : options.token
	if (token) headers.Authorization = `Bearer ${token}`
	return app.request(`/api/orders${pathname}`, {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
	})
}

async function operatorToken(claims: Record<string, unknown>) {
	const now = Math.floor(Date.now() / 1000)
	return new jose.SignJWT({ role: 'operator', orgId: ORG, ...claims })
		.setProtectedHeader({ alg: 'HS256' })
		.setSubject('usr_1')
		.setIssuer(brand.shortName)
		.setAudience('tenant-api-operator')
		.setIssuedAt(now)
		.setExpirationTime(now + 300)
		.sign(new TextEncoder().encode(OPERATOR_SECRET))
}

async function operator(
	method: string,
	pathname: string,
	claims: Record<string, unknown>,
	body?: unknown,
) {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${await operatorToken(claims)}`,
	}
	if (body !== undefined) headers['Content-Type'] = 'application/json'
	return app.request(`/operator/orders${pathname}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	})
}

const WRITE = { scope: 'orders:write' }
const REFUNDER = { scope: 'orders:write', refundProvider: true }

/** A paid online order (total 1000) with its Checkout Session bound. */
async function onlineOrder(
	overrides: Parameters<typeof insertOrder>[1] = {},
	orgId = ORG,
) {
	const n = ++counter
	return insertOrder(orgId, {
		paymentProcessor: 'connect',
		paymentSessionId: `cs_test_${n}`,
		...overrides,
	})
}

function key() {
	return `refund-key-${++counter}`
}

type IntentBody = {
	refundId: string
	orderId: string
	tabPaymentId: string | null
	amountCents: number
	currency: string
	processor: string
	sessionId: string
	paymentId: string | null
	status: string
	providerRefundId: string | null
	createdAt: string
	updatedAt: string
	replayed: boolean
}

async function intent(
	orderId: string,
	amount: { amountCents: number } | { full: true },
	options: {
		idempotencyKey?: string
		orgId?: string
		note?: string
		tabPaymentId?: string
		locationIds?: string[] | null
		loyaltyAccess?: { refundLoyalty: boolean }
	} = {},
) {
	return system('/refund-intent', {
		orgId: options.orgId ?? ORG,
		orderId,
		...(options.tabPaymentId ? { tabPaymentId: options.tabPaymentId } : {}),
		...(options.locationIds !== undefined
			? { locationIds: options.locationIds }
			: {}),
		...(options.loyaltyAccess ? { loyaltyAccess: options.loyaltyAccess } : {}),
		...amount,
		note: options.note ?? NOTE,
		idempotencyKey: options.idempotencyKey ?? key(),
		actor: { origin: 'operator', actorId: 'usr_1' },
	})
}

async function settle(
	refundId: string,
	status: 'succeeded' | 'failed' | 'pending',
	extra: Record<string, unknown> = {},
) {
	return system('/refund-status', { orgId: ORG, refundId, status, ...extra })
}

async function orderRow(orderId: string) {
	const db = await getTenantDb(ORG)
	const [row] = await db
		.select()
		.from(restaurantOrders)
		.where(eq(restaurantOrders.id, orderId))
	return row!
}

beforeEach(async () => {
	tempDir = mkdtempSync(path.join(tmpdir(), 'provider-refunds-'))
	vi.stubEnv('TENANT_DB_DIR', tempDir)
	vi.stubEnv('DATA_REGION', 'us')
	vi.stubEnv('TENANT_OPERATOR_TOKEN', OPERATOR_SECRET)
	vi.stubEnv('INTERNAL_COMMAND_TOKEN', INTERNAL)
	vi.stubEnv('AUTH_HMAC_SECRET', 'test-hmac-secret-123456789')
	kicks.length = 0
	setOrderRefundKickForTest(async (request) => {
		kicks.push(request)
		return { status: 'sent' }
	})
	for (const id of [ORG, ORG_B]) {
		orgs.set(id, {
			id,
			slug: id,
			customDomain: null,
			hasProvisionedDb: true,
			dataRegion: 'us',
		} as PublishedOrganization)
		await provisionTenantDb(id)
	}
})

afterEach(async () => {
	await orderRefundKicksIdle()
	setOrderRefundKickForTest(null)
	for (const id of [ORG, ORG_B]) await destroyTenantDb(id).catch(() => {})
	rmSync(tempDir, { recursive: true, force: true })
	vi.unstubAllEnvs()
})

describe('POST /api/orders/refund-intent and refund-status', () => {
	it('books a full refund pending, then counts it once it succeeded', async () => {
		const orderId = await onlineOrder()
		const res = await intent(orderId, { full: true })
		expect(res.status).toBe(201)
		const booked = (await res.json()) as IntentBody
		expect(booked).toEqual({
			refundId: expect.any(String),
			orderId,
			tabPaymentId: null,
			amountCents: 1000,
			currency: 'USD',
			processor: 'connect',
			sessionId: expect.stringMatching(/^cs_test_/),
			paymentId: null,
			status: 'pending',
			providerRefundId: null,
			createdAt: expect.any(String),
			updatedAt: expect.any(String),
			replayed: false,
		})
		// A pending refund only reserves the amount.
		expect((await orderRow(orderId)).refundedCents).toBe(0)
		// The App asked for it and executes it itself: no kick.
		await orderRefundKicksIdle()
		expect(kicks).toEqual([])

		const detail = await operator('GET', `/${orderId}`, {
			scope: 'orders:read',
		})
		expect(await detail.json()).toMatchObject({
			order: {
				refundedCents: 0,
				refundPendingCents: 1000,
				refundableCents: 0,
				refundStatus: 'pending',
				refunds: [{ kind: 'provider', status: 'pending', origin: 'operator' }],
			},
		})

		const done = await settle(booked.refundId, 'succeeded', {
			providerRefundId: 're_1',
			amountCents: 1000,
			currency: 'usd',
			processor: 'connect',
		})
		expect(done.status).toBe(200)
		expect(await done.json()).toEqual({
			refundId: booked.refundId,
			orderId,
			status: 'succeeded',
			applied: true,
		})
		const row = await orderRow(orderId)
		expect(row.refundedCents).toBe(1000)

		const list = await operator('GET', '', { scope: 'orders:read' })
		const listed = (await list.json()) as {
			orders: Array<Record<string, unknown>>
		}
		expect(listed.orders.find((order) => order.id === orderId)).toMatchObject({
			refundedCents: 1000,
			refundPendingCents: 0,
			refundStatus: 'full',
			disputed: false,
		})

		// Nothing is left to refund.
		const again = await intent(orderId, { full: true })
		expect(again.status).toBe(409)
		expect(await again.json()).toMatchObject({ error: 'refund_complete' })
	})

	it('answers what is left to refund, net of what already came back', async () => {
		const orderId = await onlineOrder()
		const first = (await (
			await intent(orderId, { amountCents: 300 })
		).json()) as IntentBody
		await settle(first.refundId, 'succeeded')
		const tooMuch = await intent(orderId, { amountCents: 800 })
		expect(tooMuch.status).toBe(422)
		expect(await tooMuch.json()).toMatchObject({
			error: 'refund_exceeds_payment',
			refundableCents: 700,
		})
	})

	it('allows one provider refund at a time, also when two race', async () => {
		const orderId = await onlineOrder()
		const [a, b] = await Promise.all([
			intent(orderId, { amountCents: 100 }),
			intent(orderId, { amountCents: 200 }),
		])
		expect([a.status, b.status].sort()).toEqual([201, 409])
		const refused = a.status === 409 ? a : b
		expect(await refused.json()).toMatchObject({ error: 'refund_pending' })

		const third = await intent(orderId, { amountCents: 50 })
		expect(third.status).toBe(409)
		expect(await third.json()).toMatchObject({ error: 'refund_pending' })
		const db = await getTenantDb(ORG)
		expect(await db.select().from(restaurantOrderRefunds)).toHaveLength(1)
	})

	it('a failed refund gives the amount back and changes no total', async () => {
		const orderId = await onlineOrder()
		const booked = (await (
			await intent(orderId, { amountCents: 400 })
		).json()) as IntentBody
		const failed = await settle(booked.refundId, 'failed', {
			failureCode: 'Insufficient_Funds',
		})
		expect(await failed.json()).toMatchObject({
			status: 'failed',
			applied: true,
		})
		expect((await orderRow(orderId)).refundedCents).toBe(0)

		const detail = await operator('GET', `/${orderId}`, {
			scope: 'orders:read',
		})
		expect(await detail.json()).toMatchObject({
			order: {
				refundStatus: 'failed',
				refundFailureCode: 'insufficient_funds',
				refundPendingCents: 0,
				refundableCents: 1000,
				refunds: [{ status: 'failed', failureCode: 'insufficient_funds' }],
			},
		})
		// Final states win: a late success changes nothing.
		const late = await settle(booked.refundId, 'succeeded')
		expect(await late.json()).toMatchObject({
			status: 'failed',
			applied: false,
		})
		expect((await orderRow(orderId)).refundedCents).toBe(0)

		const retry = await intent(orderId, { full: true })
		expect(retry.status).toBe(201)
		expect(await retry.json()).toMatchObject({ amountCents: 1000 })
	})

	it('never counts a replayed success twice, by refund id or provider id', async () => {
		const orderId = await onlineOrder()
		const booked = (await (
			await intent(orderId, { amountCents: 250 })
		).json()) as IntentBody

		// The provider id arrives first (the App's direct answer).
		const known = await settle(booked.refundId, 'pending', {
			providerRefundId: 're_known',
		})
		expect(await known.json()).toMatchObject({
			status: 'pending',
			applied: true,
		})
		const knownAgain = await settle(booked.refundId, 'pending', {
			providerRefundId: 're_known',
		})
		expect(await knownAgain.json()).toMatchObject({ applied: false })

		const byProvider = await system('/refund-status', {
			orgId: ORG,
			providerRefundId: 're_known',
			status: 'succeeded',
		})
		expect(await byProvider.json()).toMatchObject({
			refundId: booked.refundId,
			status: 'succeeded',
			applied: true,
		})
		for (const replay of [
			{ refundId: booked.refundId },
			{ providerRefundId: 're_known' },
			{ refundId: booked.refundId, orderId },
		]) {
			const res = await system('/refund-status', {
				orgId: ORG,
				...replay,
				status: 'succeeded',
			})
			expect(res.status).toBe(200)
			expect(await res.json()).toMatchObject({ applied: false })
		}
		expect((await orderRow(orderId)).refundedCents).toBe(250)
	})

	it('records a success the provider reverses afterwards, never shrinking the refunded total', async () => {
		const orderId = await onlineOrder()
		const booked = (await (
			await intent(orderId, { amountCents: 250 })
		).json()) as IntentBody
		await settle(booked.refundId, 'succeeded', { providerRefundId: 're_rev' })
		expect((await orderRow(orderId)).refundedCents).toBe(250)

		// Stripe moves the refund from succeeded to failed.
		const reversed = await system('/refund-status', {
			orgId: ORG,
			providerRefundId: 're_rev',
			status: 'failed',
			failureCode: 'Expired_Or_Canceled_Card',
		})
		expect(await reversed.json()).toEqual({
			refundId: booked.refundId,
			orderId,
			status: 'failed',
			applied: true,
		})
		const row = await orderRow(orderId)
		expect(row.refundedCents).toBe(250)
		expect(row.refundReversedCents).toBe(250)
		// Guest receipts (the receipt token and the order link) show the net.
		for (const body of [receiptOrder(row), linkReceiptOrder(row)]) {
			expect(body).toMatchObject({ refundedCents: 0 })
		}
		const db = await getTenantDb(ORG)
		const [refund] = await db
			.select()
			.from(restaurantOrderRefunds)
			.where(eq(restaurantOrderRefunds.id, booked.refundId))
		expect(refund).toMatchObject({
			status: 'succeeded',
			reversalCode: 'expired_or_canceled_card',
		})
		expect(refund!.reversedAt).toEqual(expect.any(Number))

		// It reads failed with its code, and the amount is refundable again.
		const detail = await operator('GET', `/${orderId}`, {
			scope: 'orders:read',
		})
		expect(await detail.json()).toMatchObject({
			order: {
				refundedCents: 0,
				refundableCents: 1000,
				refundStatus: 'failed',
				refundFailureCode: 'expired_or_canceled_card',
				refunds: [
					{
						status: 'failed',
						failureCode: 'expired_or_canceled_card',
						reversedAt: expect.any(String),
					},
				],
			},
		})

		// Replays and late reports change nothing.
		for (const status of ['failed', 'succeeded', 'pending'] as const) {
			const replay = await settle(booked.refundId, status)
			expect(await replay.json()).toMatchObject({
				status: 'failed',
				applied: false,
			})
		}
		expect(await orderRow(orderId)).toMatchObject({
			refundedCents: 250,
			refundReversedCents: 250,
		})

		// Try again: the whole payment can go back, and the totals stay right.
		const retry = (await (
			await intent(orderId, { full: true })
		).json()) as IntentBody
		expect(retry.amountCents).toBe(1000)
		await settle(retry.refundId, 'succeeded')
		expect(await orderRow(orderId)).toMatchObject({
			refundedCents: 1250,
			refundReversedCents: 250,
		})
		const after = await operator('GET', `/${orderId}`, {
			scope: 'orders:read',
		})
		expect(await after.json()).toMatchObject({
			order: { refundedCents: 1000, refundableCents: 0, refundStatus: 'full' },
		})
		const none = await intent(orderId, { amountCents: 1 })
		expect(await none.json()).toMatchObject({ error: 'refund_complete' })
	})

	it('refuses a report that does not match the refund', async () => {
		const orderId = await onlineOrder()
		const booked = (await (
			await intent(orderId, { amountCents: 250 })
		).json()) as IntentBody
		for (const extra of [
			{ amountCents: 300 },
			{ currency: 'EUR' },
			{ processor: 'checkout' },
		]) {
			const res = await settle(booked.refundId, 'succeeded', extra)
			expect(res.status, JSON.stringify(extra)).toBe(409)
			expect(await res.json()).toMatchObject({ error: 'refund_mismatch' })
		}
		await settle(booked.refundId, 'pending', { providerRefundId: 're_a' })
		const otherId = await settle(booked.refundId, 'succeeded', {
			providerRefundId: 're_b',
		})
		expect(otherId.status).toBe(409)
		expect((await orderRow(orderId)).refundedCents).toBe(0)
	})

	it('replays the same key and body, and refuses the key with other details', async () => {
		const orderId = await onlineOrder()
		const idempotencyKey = key()
		const first = await intent(
			orderId,
			{ amountCents: 100 },
			{ idempotencyKey },
		)
		expect(first.status).toBe(201)
		const booked = (await first.json()) as IntentBody
		const replay = await intent(
			orderId,
			{ amountCents: 100 },
			{ idempotencyKey },
		)
		expect(replay.status).toBe(200)
		expect(await replay.json()).toMatchObject({
			refundId: booked.refundId,
			replayed: true,
		})
		const conflict = await intent(
			orderId,
			{ amountCents: 200 },
			{ idempotencyKey },
		)
		expect(conflict.status).toBe(409)
		expect(await conflict.json()).toMatchObject({
			error: 'idempotency_conflict',
		})
	})

	it('refuses orders the provider cannot refund', async () => {
		const handoff = await insertOrder(ORG, { paymentMethod: 'handoff' })
		const unpaid = await onlineOrder({
			status: 'accepted',
			paymentStatus: 'pending',
			paidAt: null,
			completedAt: null,
		})
		const free = await onlineOrder({ paymentStatus: 'not_required' })
		for (const orderId of [handoff, unpaid, free]) {
			const res = await intent(orderId, { full: true })
			expect(res.status, orderId).toBe(409)
			expect(await res.json()).toMatchObject({ error: 'order_not_refundable' })
		}
		const missing = await intent('ord_missing', { full: true })
		expect(missing.status).toBe(404)
		expect(await missing.json()).toMatchObject({ error: 'order_not_found' })
	})

	it('takes loyalty points back only once the refund succeeded', async () => {
		await activateProgram(ORG)
		await insertCustomer(ORG, { id: 'cus_1' })
		const memberId = await makeMember(ORG, { customerId: 'cus_1' })
		const orderId = await onlineOrder()
		const source = { type: 'restaurant_order' as const, id: orderId }
		await claimAndQueue(ORG, { memberId, source })
		await reconcileLoyaltySource(ORG, source, { now: NOW })
		expect((await balanceOf(ORG, memberId)).points).toBe(10)

		const failing = (await (
			await intent(orderId, { amountCents: 500 })
		).json()) as IntentBody
		expect((await balanceOf(ORG, memberId)).points).toBe(10)
		await settle(failing.refundId, 'failed')
		expect((await balanceOf(ORG, memberId)).points).toBe(10)

		const working = (await (
			await intent(orderId, { amountCents: 500 })
		).json()) as IntentBody
		expect((await balanceOf(ORG, memberId)).points).toBe(10)
		await settle(working.refundId, 'succeeded')
		expect((await balanceOf(ORG, memberId)).points).toBe(5)
		await settle(working.refundId, 'succeeded')
		expect((await balanceOf(ORG, memberId)).points).toBe(5)
	})

	it('a reversed refund refunded again takes the points back only once', async () => {
		await activateProgram(ORG)
		await insertCustomer(ORG, { id: 'cus_rev' })
		const memberId = await makeMember(ORG, { customerId: 'cus_rev' })
		const orderId = await onlineOrder()
		const source = { type: 'restaurant_order' as const, id: orderId }
		await claimAndQueue(ORG, { memberId, source })
		await reconcileLoyaltySource(ORG, source, { now: NOW })
		expect((await balanceOf(ORG, memberId)).points).toBe(10)

		const first = (await (
			await intent(orderId, { amountCents: 500 })
		).json()) as IntentBody
		await settle(first.refundId, 'succeeded', {
			providerRefundId: 're_points_rev',
		})
		expect((await balanceOf(ORG, memberId)).points).toBe(5)
		// The provider reverses it: the points stay taken (never handed back
		// for money that may still come back), and the amount is refundable.
		await settle(first.refundId, 'failed', {
			failureCode: 'card_closed',
			providerRefundId: 're_points_rev',
		})
		await reconcileLoyaltySource(ORG, source, { now: NOW })
		expect((await balanceOf(ORG, memberId)).points).toBe(5)

		// Refunded again: the same money, so no second take-back.
		const again = (await (
			await intent(orderId, { amountCents: 500 })
		).json()) as IntentBody
		await settle(again.refundId, 'succeeded')
		await reconcileLoyaltySource(ORG, source, { now: NOW })
		expect((await balanceOf(ORG, memberId)).points).toBe(5)
		expect(await orderRow(orderId)).toMatchObject({
			refundedCents: 1000,
			refundReversedCents: 500,
		})
		// What is left is still the other half, never more than was paid.
		const rest = await intent(orderId, { amountCents: 501 })
		expect(await rest.json()).toMatchObject({
			error: 'refund_exceeds_payment',
			refundableCents: 500,
		})
	})

	it('stores the payment id from the paid event and answers it with the refund', async () => {
		const orderId = await onlineOrder({
			status: 'accepted',
			paymentStatus: 'pending',
			paidAt: null,
			completedAt: null,
			paymentSessionId: 'cs_test_paid_event',
		})
		const paid = await system('/payment-status', {
			orgId: ORG,
			orderId,
			sessionId: 'cs_test_paid_event',
			processor: 'connect',
			status: 'paid',
			amountCents: 1000,
			currency: 'USD',
			paymentId: 'pi_test_1',
		})
		expect(paid.status).toBe(200)
		expect((await orderRow(orderId)).paymentId).toBe('pi_test_1')
		const res = await intent(orderId, { amountCents: 100 })
		expect(await res.json()).toMatchObject({ paymentId: 'pi_test_1' })
	})

	it('keeps the first payment id: a replay fills an empty one, never replaces one', async () => {
		const paidEvent = (orderId: string, paymentId?: string) =>
			system('/payment-status', {
				orgId: ORG,
				orderId,
				sessionId: `cs_test_${orderId}`,
				processor: 'connect',
				status: 'paid',
				amountCents: 1000,
				currency: 'USD',
				...(paymentId ? { paymentId } : {}),
			})
		const pendingOrder = async () => {
			const id = `ord_pid_${++counter}`
			await onlineOrder({
				id,
				status: 'accepted',
				paymentStatus: 'pending',
				paidAt: null,
				completedAt: null,
				paymentSessionId: `cs_test_${id}`,
			})
			return id
		}
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

		// Paid before the id was sent: a later replay that carries it fills it.
		const legacy = await pendingOrder()
		expect((await paidEvent(legacy)).status).toBe(200)
		expect((await orderRow(legacy)).paymentId).toBeNull()
		const before = await orderRow(legacy)
		expect((await paidEvent(legacy, 'pi_late_1')).status).toBe(200)
		const filled = await orderRow(legacy)
		expect(filled.paymentId).toBe('pi_late_1')
		// Only the id: the order's version (updated_at) does not move.
		expect(filled.updatedAt).toEqual(before.updatedAt)

		// A second payment on the same order never replaces the first.
		const twice = await pendingOrder()
		expect((await paidEvent(twice, 'pay_first_1')).status).toBe(200)
		expect((await paidEvent(twice, 'pay_second_1')).status).toBe(200)
		expect((await orderRow(twice)).paymentId).toBe('pay_first_1')
		// A replay without an id leaves it alone.
		expect((await paidEvent(twice)).status).toBe(200)
		expect((await orderRow(twice)).paymentId).toBe('pay_first_1')
		// Logged by order id only, never the payment ids.
		const logged = warn.mock.calls.map((call) => call.join(' ')).join('\n')
		expect(logged).toContain(twice)
		expect(logged).not.toContain('pay_second_1')
		expect(logged).not.toContain('pay_first_1')
		warn.mockRestore()

		const res = await intent(twice, { full: true })
		expect(await res.json()).toMatchObject({ paymentId: 'pay_first_1' })
	})
})

describe('refund-intent: members limited to some locations', () => {
	it('books inside the scope and says it checked; outside is the uniform 404', async () => {
		const here = await onlineOrder({ locationId: LOC_1 })
		const there = await onlineOrder({ locationId: LOC_2 })

		const ok = await intent(
			here,
			{ amountCents: 100 },
			{ locationIds: [LOC_1] },
		)
		expect(ok.status).toBe(201)
		expect(await ok.json()).toMatchObject({
			orderId: here,
			status: 'pending',
			locationScoped: true,
		})

		const refusedKey = key()
		const outside = await intent(
			there,
			{ amountCents: 100 },
			{ locationIds: [LOC_1], idempotencyKey: refusedKey },
		)
		expect(outside.status).toBe(404)
		const outsideBody = await outside.json()
		expect(outsideBody).toEqual({
			error: 'order_not_found',
			message: 'Order not found.',
		})
		// Same answer as an order that does not exist: nothing about it leaks.
		const missing = await intent(
			'ord_does_not_exist',
			{ amountCents: 100 },
			{ locationIds: [LOC_1] },
		)
		expect(missing.status).toBe(404)
		expect(await missing.json()).toEqual(outsideBody)
		// Nothing was booked for the order outside the scope.
		const db = await getTenantDb(ORG)
		expect(
			await db
				.select()
				.from(restaurantOrderRefunds)
				.where(eq(restaurantOrderRefunds.orderId, there)),
		).toHaveLength(0)

		// An empty list reaches no location at all.
		const none = await intent(here, { amountCents: 100 }, { locationIds: [] })
		expect(none.status).toBe(404)
	})

	it('a replayed key outside the scope is still the 404', async () => {
		const orderId = await onlineOrder({ locationId: LOC_2 })
		const replayKey = key()
		const unscoped = await intent(
			orderId,
			{ amountCents: 100 },
			{ idempotencyKey: replayKey },
		)
		expect(unscoped.status).toBe(201)
		const scoped = await intent(
			orderId,
			{ amountCents: 100 },
			{ idempotencyKey: replayKey, locationIds: [LOC_1] },
		)
		expect(scoped.status).toBe(404)
	})

	it('unscoped requests (absent or null) behave as before and claim no check', async () => {
		const orderId = await onlineOrder({ locationId: LOC_2 })
		const absent = await intent(orderId, { amountCents: 100 })
		expect(absent.status).toBe(201)
		const absentBody = (await absent.json()) as Record<string, unknown>
		expect(absentBody).not.toHaveProperty('locationScoped')
		await settle(absentBody.refundId as string, 'succeeded')

		const nulled = await intent(
			orderId,
			{ amountCents: 100 },
			{ locationIds: null },
		)
		expect(nulled.status).toBe(201)
		expect(await nulled.json()).not.toHaveProperty('locationScoped')
	})

	it('scopes a tab by its location too', async () => {
		const tabId = await insertTab(ORG, {
			id: 'tab-scope-1',
			locationId: LOC_2,
			paymentProcessor: 'checkout',
			paymentSessionId: 'pay_scope_1',
			paymentAmountCents: 1000,
		})
		const outside = await intent(
			`tab:${tabId}`,
			{ amountCents: 100 },
			{ locationIds: [LOC_1] },
		)
		expect(outside.status).toBe(404)
		const inside = await intent(
			`tab:${tabId}`,
			{ amountCents: 100 },
			{ locationIds: [LOC_2] },
		)
		expect(inside.status).toBe(201)
		expect(await inside.json()).toMatchObject({ locationScoped: true })
	})

	it('refuses malformed or oversized location lists without echoing them', async () => {
		const orderId = await onlineOrder()
		for (const locationIds of [
			['bad id with spaces'],
			['x'.repeat(65)],
			Array.from({ length: 201 }, (_, index) => `loc_${index}`),
			'loc_1',
		]) {
			const res = await system('/refund-intent', {
				orgId: ORG,
				orderId,
				amountCents: 100,
				note: NOTE,
				idempotencyKey: key(),
				actor: { origin: 'operator', actorId: 'usr_1' },
				locationIds,
			})
			expect(res.status).toBe(400)
			const text = await res.text()
			expect(text).not.toContain('bad id')
			expect(text).not.toContain('loc_200')
		}
	})
})

describe('POST /api/orders/dispute-status', () => {
	it('blocks refunds while a dispute is open or lost, and a won one unblocks', async () => {
		const orderId = await onlineOrder()
		const { paymentSessionId } = await orderRow(orderId)
		const opened = await system('/dispute-status', {
			orgId: ORG,
			sessionId: paymentSessionId,
			processor: 'connect',
			status: 'open',
		})
		expect(opened.status).toBe(200)
		expect(await opened.json()).toEqual({
			orderId,
			disputeStatus: 'open',
			disputed: true,
			applied: true,
		})
		const blocked = await intent(orderId, { full: true })
		expect(blocked.status).toBe(409)
		expect(await blocked.json()).toMatchObject({ error: 'payment_disputed' })
		const detail = await operator('GET', `/${orderId}`, {
			scope: 'orders:read',
		})
		expect(await detail.json()).toMatchObject({
			order: { disputed: true, disputeStatus: 'open' },
		})

		const won = await system('/dispute-status', {
			orgId: ORG,
			orderId,
			status: 'won',
		})
		expect(await won.json()).toMatchObject({ disputed: false, applied: true })
		const replay = await system('/dispute-status', {
			orgId: ORG,
			orderId,
			status: 'won',
		})
		expect(await replay.json()).toMatchObject({ applied: false })
		expect((await intent(orderId, { full: true })).status).toBe(201)

		const lost = await system('/dispute-status', {
			orgId: ORG,
			orderId,
			status: 'lost',
		})
		expect(await lost.json()).toMatchObject({ disputed: true })
		const row = await orderRow(orderId)
		expect(row.disputeStatus).toBe('lost')
		expect(row.disputedAt).toBeInstanceOf(Date)
	})

	it('never reopens a closed dispute, delivered out of order', async () => {
		const dispute = (orderId: string, status: string) =>
			system('/dispute-status', { orgId: ORG, orderId, status })

		// Won, then a late `open` (the created event redelivered): stays won.
		const wonFirst = await onlineOrder()
		expect(await (await dispute(wonFirst, 'won')).json()).toEqual({
			orderId: wonFirst,
			disputeStatus: 'won',
			disputed: false,
			applied: true,
		})
		expect(await (await dispute(wonFirst, 'open')).json()).toEqual({
			orderId: wonFirst,
			disputeStatus: 'won',
			disputed: false,
			applied: false,
		})
		expect((await orderRow(wonFirst)).disputeStatus).toBe('won')
		expect((await intent(wonFirst, { full: true })).status).toBe(201)

		// Lost, then `open`: stays lost (refunds stay blocked).
		const lostFirst = await onlineOrder()
		await dispute(lostFirst, 'open')
		await dispute(lostFirst, 'lost')
		expect(await (await dispute(lostFirst, 'open')).json()).toMatchObject({
			disputeStatus: 'lost',
			disputed: true,
			applied: false,
		})
		expect((await orderRow(lostFirst)).disputeStatus).toBe('lost')

		// A closed dispute may still change to the other closed state.
		expect(await (await dispute(lostFirst, 'won')).json()).toMatchObject({
			disputeStatus: 'won',
			applied: true,
		})
		expect(await (await dispute(lostFirst, 'lost')).json()).toMatchObject({
			disputeStatus: 'lost',
			applied: true,
		})
		expect(await (await dispute(lostFirst, 'lost')).json()).toMatchObject({
			applied: false,
		})

		// Tabs follow the same rule.
		const tabId = await insertTab(ORG, {
			id: 'tab-dispute-order',
			paymentProcessor: 'checkout',
			paymentSessionId: 'pay_tab_dispute_order',
			paymentAmountCents: 1000,
		})
		await dispute(`tab:${tabId}`, 'won')
		expect(await (await dispute(`tab:${tabId}`, 'open')).json()).toMatchObject({
			disputeStatus: 'won',
			applied: false,
		})
	})

	it('answers the uniform 404 for an unknown order or payment', async () => {
		for (const body of [
			{ orgId: ORG, orderId: 'ord_missing', status: 'open' },
			{ orgId: ORG, sessionId: 'cs_unknown_session', status: 'open' },
			{ orgId: ORG, orderId: 'tab:missing', status: 'open' },
		]) {
			const res = await system('/dispute-status', body)
			expect(res.status, JSON.stringify(body)).toBe(404)
			expect(await res.json()).toMatchObject({ error: 'order_not_found' })
		}
	})
})

describe('system auth and organizations', () => {
	it('refuses a missing or forged token, bad bodies, another org and another region', async () => {
		const orderId = await onlineOrder()
		const body = {
			orgId: ORG,
			orderId,
			full: true,
			note: NOTE,
			idempotencyKey: key(),
			actor: { origin: 'operator' },
		}
		for (const pathname of [
			'/refund-intent',
			'/refund-status',
			'/dispute-status',
			'/refunds-pending',
		]) {
			expect((await system(pathname, body, { token: null })).status).toBe(401)
			expect(
				(await system(pathname, body, { token: `${INTERNAL}-forged` })).status,
			).toBe(401)
		}
		for (const bad of [
			{ ...body, amountCents: 100 },
			{ ...body, full: undefined },
			{ ...body, note: 'no' },
			{ ...body, extra: true },
			{ ...body, orgId: 'bad org id' },
			null,
		]) {
			const res = await system('/refund-intent', bad)
			expect(res.status, JSON.stringify(bad)).toBe(400)
			expect(JSON.stringify(await res.json())).not.toContain(NOTE)
		}

		const booked = (await (
			await system('/refund-intent', body)
		).json()) as IntentBody
		// The refund lives in ORG's database: ORG_B never finds it.
		const crossOrg = await system('/refund-status', {
			orgId: ORG_B,
			refundId: booked.refundId,
			status: 'succeeded',
		})
		expect(crossOrg.status).toBe(404)
		expect(await crossOrg.json()).toMatchObject({ error: 'refund_not_found' })
		const crossIntent = await intent(orderId, { full: true }, { orgId: ORG_B })
		expect(crossIntent.status).toBe(404)

		orgs.set(ORG, { ...orgs.get(ORG)!, dataRegion: 'ksa' })
		const wrongRegion = await settle(booked.refundId, 'succeeded')
		expect(wrongRegion.status).toBe(409)
		expect(await wrongRegion.json()).toMatchObject({ error: 'region_mismatch' })
		orgs.set(ORG, { ...orgs.get(ORG)!, dataRegion: 'us' })
		expect((await orderRow(orderId)).refundedCents).toBe(0)
	})
})

describe('QR tab refunds', () => {
	it('refunds each online payment of a tab on its own', async () => {
		const tabId = await insertTab(ORG, {
			id: 'tab-refund-1',
			paymentProcessor: 'checkout',
			paymentSessionId: 'pay_settling_1',
			paymentAmountCents: 1000,
		})
		const db = await getTenantDb(ORG)
		await db.insert(qrTabPayments).values({
			id: 'tabpay_review_1',
			tabId,
			sessionId: 'pay_review_1',
			processor: 'checkout',
			amountCents: 600,
			currency: 'USD',
		})

		const settling = await intent(`tab:${tabId}`, { amountCents: 400 })
		expect(settling.status).toBe(201)
		const first = (await settling.json()) as IntentBody
		expect(first).toMatchObject({
			orderId: `tab:${tabId}`,
			tabPaymentId: null,
			processor: 'checkout',
			sessionId: 'pay_settling_1',
			amountCents: 400,
			status: 'pending',
		})
		// One pending refund per tab.
		const busy = await intent(
			`tab:${tabId}`,
			{ full: true },
			{
				tabPaymentId: 'tabpay_review_1',
			},
		)
		expect(busy.status).toBe(409)
		expect(await busy.json()).toMatchObject({ error: 'refund_pending' })

		const pending = await system('/refunds-pending', { orgId: ORG })
		expect(await pending.json()).toMatchObject({
			refunds: [{ refundId: first.refundId, orderId: `tab:${tabId}` }],
		})

		const done = await system('/refund-status', {
			orgId: ORG,
			orderId: `tab:${tabId}`,
			refundId: first.refundId,
			status: 'succeeded',
			providerRefundId: 'act_1',
		})
		expect(await done.json()).toMatchObject({ applied: true })

		const review = await intent(
			`tab:${tabId}`,
			{ full: true },
			{
				tabPaymentId: 'tabpay_review_1',
			},
		)
		expect(review.status).toBe(201)
		expect(await review.json()).toMatchObject({
			tabPaymentId: 'tabpay_review_1',
			sessionId: 'pay_review_1',
			amountCents: 600,
		})
		const reviewRefund = await db
			.select()
			.from(qrTabRefunds)
			.where(eq(qrTabRefunds.tabPaymentId, 'tabpay_review_1'))
		await settle(reviewRefund[0]!.id, 'succeeded')

		// The settling payment still has 600 to give back.
		const tooMuch = await intent(`tab:${tabId}`, { amountCents: 700 })
		expect(tooMuch.status).toBe(422)
		expect(await tooMuch.json()).toMatchObject({ refundableCents: 600 })

		const otherTab = await intent('tab:other-tab', { full: true })
		expect(otherTab.status).toBe(404)
		const wrongPayment = await intent(
			`tab:${tabId}`,
			{ full: true },
			{
				tabPaymentId: 'tabpay_unknown',
			},
		)
		expect(wrongPayment.status).toBe(404)
	})

	it('gives a reversed tab refund back to refund again', async () => {
		const tabId = await insertTab(ORG, {
			id: 'tab-reversed-1',
			paymentProcessor: 'checkout',
			paymentSessionId: 'pay_settling_rev',
			paymentAmountCents: 1000,
		})
		const first = (await (
			await intent(`tab:${tabId}`, { full: true })
		).json()) as IntentBody
		await settle(first.refundId, 'succeeded', { providerRefundId: 'act_rev' })
		expect(
			await (await intent(`tab:${tabId}`, { amountCents: 1 })).json(),
		).toMatchObject({ error: 'refund_complete' })
		const reversed = await settle(first.refundId, 'failed', {
			failureCode: 'refund_failed',
			providerRefundId: 'act_rev',
		})
		expect(await reversed.json()).toMatchObject({
			orderId: `tab:${tabId}`,
			status: 'failed',
			applied: true,
		})
		expect(await (await settle(first.refundId, 'failed')).json()).toMatchObject(
			{ applied: false },
		)
		const again = await intent(`tab:${tabId}`, { full: true })
		expect(again.status).toBe(201)
		expect(await again.json()).toMatchObject({ amountCents: 1000 })
	})

	it('records disputes on the tab by its payment reference', async () => {
		const tabId = await insertTab(ORG, {
			id: 'tab-dispute-1',
			paymentProcessor: 'connect',
			paymentSessionId: 'cs_tab_dispute',
		})
		const res = await system('/dispute-status', {
			orgId: ORG,
			sessionId: 'cs_tab_dispute',
			status: 'open',
		})
		expect(await res.json()).toMatchObject({
			orderId: `tab:${tabId}`,
			disputed: true,
		})
		const blocked = await intent(`tab:${tabId}`, { full: true })
		expect(await blocked.json()).toMatchObject({ error: 'payment_disputed' })
	})
})

describe('POST /api/orders/refunds-pending', () => {
	it('lists pending provider refunds oldest first, narrowed by id and age', async () => {
		const a = await onlineOrder()
		const b = await onlineOrder()
		const first = (await (await intent(a, { full: true })).json()) as IntentBody
		const second = (await (
			await intent(b, { amountCents: 10 })
		).json()) as IntentBody
		const all = await system('/refunds-pending', { orgId: ORG })
		expect(all.status).toBe(200)
		const listed = (await all.json()) as { refunds: IntentBody[] }
		expect(listed.refunds.map((refund) => refund.refundId)).toEqual([
			first.refundId,
			second.refundId,
		])
		const one = await system('/refunds-pending', {
			orgId: ORG,
			refundId: second.refundId,
		})
		const { replayed: _replayed, ...secondView } = second
		expect(await one.json()).toEqual({ refunds: [secondView] })
		const old = await system('/refunds-pending', {
			orgId: ORG,
			olderThanMs: 60_000,
		})
		expect(await old.json()).toEqual({ refunds: [] })
		await settle(first.refundId, 'succeeded')
		const left = await system('/refunds-pending', { orgId: ORG, limit: 5 })
		expect(
			((await left.json()) as { refunds: IntentBody[] }).refunds.map(
				(refund) => refund.refundId,
			),
		).toEqual([second.refundId])
	})
})

describe('PATCH /operator/orders/:id: cancel with a refund', () => {
	const accepted = { status: 'accepted' as const, completedAt: null }

	it('cancels at once, books the full refund in the same write and kicks the App', async () => {
		const orderId = await onlineOrder(accepted)
		const res = await operator('PATCH', `/${orderId}`, REFUNDER, {
			status: 'cancelled',
			cancelReason: 'out_of_stock',
			refund: 'full',
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			order: Record<string, unknown>
			refundIntent: IntentBody
			refundError: string | null
		}
		expect(body.order).toMatchObject({
			status: 'cancelled',
			cancelReason: 'out_of_stock',
			cancelledBy: 'operator',
			refundStatus: 'pending',
			refundPendingCents: 1000,
		})
		expect(body.refundIntent).toMatchObject({
			orderId,
			amountCents: 1000,
			status: 'pending',
			replayed: false,
		})
		expect(body.refundError).toBeNull()
		await orderRefundKicksIdle()
		expect(kicks).toEqual([
			{ orgId: ORG, refundId: body.refundIntent.refundId },
		])

		// A repeated cancel (lost answer) answers the same refund, no second one.
		const again = await operator('PATCH', `/${orderId}`, REFUNDER, {
			status: 'cancelled',
			cancelReason: 'out_of_stock',
			refund: 'full',
		})
		expect(await again.json()).toMatchObject({
			refundIntent: { refundId: body.refundIntent.refundId, replayed: true },
		})
		await orderRefundKicksIdle()
		expect(kicks).toHaveLength(1)

		// The refund fails: the order stays cancelled, the money is refundable.
		await settle(body.refundIntent.refundId, 'failed', {
			failureCode: 'expired_card',
		})
		const row = await orderRow(orderId)
		expect(row.status).toBe('cancelled')
		expect(row.refundedCents).toBe(0)
		expect(row.cancelReason).toBe('out_of_stock')
	})

	it('without the refund claim refuses and does not cancel', async () => {
		const orderId = await onlineOrder(accepted)
		for (const claims of [WRITE, { ...REFUNDER, impersonated: true }]) {
			const res = await operator('PATCH', `/${orderId}`, claims, {
				status: 'cancelled',
				cancelReason: 'guest_asked',
				refund: 'full',
			})
			expect(res.status).toBe(403)
			expect(await res.json()).toMatchObject({ error: 'refund_forbidden' })
		}
		expect((await orderRow(orderId)).status).toBe('accepted')
		const db = await getTenantDb(ORG)
		expect(await db.select().from(restaurantOrderRefunds)).toEqual([])
	})

	it('needs a reason for a paid online order, and no refund for one paid at handoff', async () => {
		const orderId = await onlineOrder(accepted)
		const noReason = await operator('PATCH', `/${orderId}`, WRITE, {
			status: 'cancelled',
		})
		expect(noReason.status).toBe(422)
		expect(await noReason.json()).toMatchObject({
			error: 'cancel_reason_required',
		})

		const keep = await operator('PATCH', `/${orderId}`, WRITE, {
			status: 'cancelled',
			cancelReason: 'duplicate',
			refund: 'none',
		})
		expect(keep.status).toBe(200)
		const kept = (await keep.json()) as Record<string, unknown>
		expect(kept.refundIntent).toBeUndefined()
		expect((await orderRow(orderId)).cancelReason).toBe('duplicate')

		const handoff = await insertOrder(ORG, {
			...accepted,
			paymentMethod: 'handoff',
			paymentStatus: 'paid',
		})
		const handoffRefund = await operator('PATCH', `/${handoff}`, REFUNDER, {
			status: 'cancelled',
			cancelReason: 'other',
			refund: 'full',
		})
		expect(handoffRefund.status).toBe(400)
		expect((await orderRow(handoff)).status).toBe('accepted')
		// A handoff order cancels without a reason, as before.
		const plain = await operator('PATCH', `/${handoff}`, WRITE, {
			status: 'cancelled',
		})
		expect(plain.status).toBe(200)
		const plainRow = await orderRow(handoff)
		expect(plainRow.cancelledBy).toBe('operator')
		expect(plainRow.cancelReason).toBeNull()
		await orderRefundKicksIdle()
		expect(kicks).toEqual([])
	})

	it('still cancels when the refund cannot start, and says why', async () => {
		const orderId = await onlineOrder({ ...accepted, disputeStatus: 'open' })
		const res = await operator('PATCH', `/${orderId}`, REFUNDER, {
			status: 'cancelled',
			cancelReason: 'kitchen_closed',
			refund: 'full',
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({
			order: { status: 'cancelled' },
			refundIntent: null,
			refundError: 'payment_disputed',
		})
		await orderRefundKicksIdle()
		expect(kicks).toEqual([])
	})
})

describe('refund-intent: the member loyalty grant', () => {
	async function loyaltyOrder() {
		await activateProgram(ORG)
		const customerId = `cus_l_${++counter}`
		await insertCustomer(ORG, { id: customerId })
		const memberId = await makeMember(ORG, { customerId })
		const orderId = await onlineOrder()
		const source = { type: 'restaurant_order' as const, id: orderId }
		await claimAndQueue(ORG, { memberId, source })
		await reconcileLoyaltySource(ORG, source, { now: NOW })
		return orderId
	}

	it('refuses an order loyalty tracks without the grant, and says it checked', async () => {
		const orderId = await loyaltyOrder()
		const refused = await intent(
			orderId,
			{ full: true },
			{ loyaltyAccess: { refundLoyalty: false } },
		)
		expect(refused.status).toBe(403)
		expect(await refused.json()).toMatchObject({
			error: 'loyalty_refund_forbidden',
		})
		const db = await getTenantDb(ORG)
		expect(await db.select().from(restaurantOrderRefunds)).toEqual([])

		const allowed = await intent(
			orderId,
			{ full: true },
			{ loyaltyAccess: { refundLoyalty: true } },
		)
		expect(allowed.status).toBe(201)
		expect(await allowed.json()).toMatchObject({ loyaltyChecked: true })
	})

	it('lets anyone refund an order loyalty does not track; no field, no claim', async () => {
		const plain = await onlineOrder()
		const checked = await intent(
			plain,
			{ amountCents: 100 },
			{ loyaltyAccess: { refundLoyalty: false } },
		)
		expect(checked.status).toBe(201)
		expect(await checked.json()).toMatchObject({ loyaltyChecked: true })
		const other = await onlineOrder()
		const unchecked = (await (
			await intent(other, { amountCents: 100 })
		).json()) as Record<string, unknown>
		expect(unchecked.loyaltyChecked).toBeUndefined()
	})

	it('cancel with a refund needs the grant on a loyalty order; the cancel stands', async () => {
		const orderId = await loyaltyOrder()
		await getTenantDb(ORG).then((db) =>
			db
				.update(restaurantOrders)
				.set({ status: 'accepted', completedAt: null })
				.where(eq(restaurantOrders.id, orderId)),
		)
		const res = await operator('PATCH', `/${orderId}`, REFUNDER, {
			status: 'cancelled',
			cancelReason: 'guest_asked',
			refund: 'full',
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({
			order: { status: 'cancelled' },
			refundIntent: null,
			refundError: 'loyalty_refund_forbidden',
		})
		const second = await onlineOrder({ status: 'accepted', completedAt: null })
		const withGrant = await operator(
			'PATCH',
			`/${second}`,
			{ ...REFUNDER, refundLoyalty: true },
			{ status: 'cancelled', cancelReason: 'guest_asked', refund: 'full' },
		)
		expect(await withGrant.json()).toMatchObject({
			refundIntent: { amountCents: 1000 },
			refundError: null,
		})
	})
})

describe('cancel with a full refund while another refund is pending', () => {
	const accepted = { status: 'accepted' as const, completedAt: null }

	async function cancelWithRefund(orderId: string) {
		return operator('PATCH', `/${orderId}`, REFUNDER, {
			status: 'cancelled',
			cancelReason: 'out_of_stock',
			refund: 'full',
		})
	}

	async function refundsOf(orderId: string) {
		const db = await getTenantDb(ORG)
		return db
			.select()
			.from(restaurantOrderRefunds)
			.where(eq(restaurantOrderRefunds.orderId, orderId))
	}

	it('owes the rest and books it once the pending refund succeeds', async () => {
		const orderId = await onlineOrder(accepted)
		const first = (await (
			await intent(orderId, { amountCents: 300 })
		).json()) as IntentBody
		const res = await cancelWithRefund(orderId)
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({
			order: { status: 'cancelled' },
			refundIntent: null,
			refundError: 'refund_pending',
		})
		expect((await orderRow(orderId)).cancelRefundDueAt).toBeInstanceOf(Date)
		await orderRefundKicksIdle()
		expect(kicks).toEqual([])
		// A repeated cancel says the same.
		expect(await (await cancelWithRefund(orderId)).json()).toMatchObject({
			refundError: 'refund_pending',
		})

		await settle(first.refundId, 'succeeded')
		const rows = await refundsOf(orderId)
		const rest = rows.find((row) => row.id !== first.refundId)
		expect(rest).toMatchObject({
			amountCents: 700,
			kind: 'provider',
			status: 'pending',
			origin: 'system',
			idempotencyKey: `cancel:${orderId}:rest`,
		})
		expect((await orderRow(orderId)).cancelRefundDueAt).toBeNull()
		await orderRefundKicksIdle()
		expect(kicks).toEqual([{ orgId: ORG, refundId: rest!.id }])

		// The repeated cancel now answers the refund it owed.
		expect(await (await cancelWithRefund(orderId)).json()).toMatchObject({
			refundIntent: { refundId: rest!.id, replayed: true },
		})
		// Settling it books nothing more.
		await settle(rest!.id, 'succeeded')
		expect(await refundsOf(orderId)).toHaveLength(2)
		expect((await orderRow(orderId)).refundedCents).toBe(1000)
	})

	it('books the whole payment when the pending refund fails instead', async () => {
		const orderId = await onlineOrder(accepted)
		const first = (await (
			await intent(orderId, { amountCents: 300 })
		).json()) as IntentBody
		await cancelWithRefund(orderId)
		await settle(first.refundId, 'failed', { failureCode: 'declined' })
		const rest = (await refundsOf(orderId)).find(
			(row) => row.id !== first.refundId,
		)
		expect(rest).toMatchObject({ amountCents: 1000, status: 'pending' })
	})

	it('keeps the mark while a dispute is open: a won dispute books it, a lost one drops it', async () => {
		const dispute = (orderId: string, status: string) =>
			system('/dispute-status', { orgId: ORG, orderId, status })

		// Disputed while the other refund waits: that refund fails, the rest
		// stays owed until the dispute closes, and the tick leaves it alone.
		const won = await onlineOrder(accepted)
		const first = (await (
			await intent(won, { amountCents: 300 })
		).json()) as IntentBody
		await cancelWithRefund(won)
		await dispute(won, 'open')
		await settle(first.refundId, 'failed')
		expect(await refundsOf(won)).toHaveLength(1)
		expect((await orderRow(won)).cancelRefundDueAt).toBeInstanceOf(Date)
		expect(await processOwedCancelRefunds(ORG)).toEqual({ booked: 0 })
		expect(await (await cancelWithRefund(won)).json()).toMatchObject({
			refundError: 'payment_disputed',
		})
		// A late `open` changes nothing; `won` books the whole payment.
		await dispute(won, 'open')
		expect(await refundsOf(won)).toHaveLength(1)
		await dispute(won, 'won')
		const rest = (await refundsOf(won)).find((row) => row.id !== first.refundId)
		expect(rest).toMatchObject({
			amountCents: 1000,
			status: 'pending',
			origin: 'system',
			idempotencyKey: `cancel:${won}:rest`,
		})
		expect((await orderRow(won)).cancelRefundDueAt).toBeNull()
		await orderRefundKicksIdle()
		expect(kicks).toEqual([{ orgId: ORG, refundId: rest!.id }])
		// Replays book nothing more.
		await dispute(won, 'won')
		await dispute(won, 'lost')
		expect(await refundsOf(won)).toHaveLength(2)

		// Cancelled during an open dispute: owed at once; lost drops it (the
		// chargeback already gave the money back).
		kicks.length = 0
		const lost = await onlineOrder(accepted)
		await dispute(lost, 'open')
		expect(await (await cancelWithRefund(lost)).json()).toMatchObject({
			order: { status: 'cancelled' },
			refundIntent: null,
			refundError: 'payment_disputed',
		})
		expect((await orderRow(lost)).cancelRefundDueAt).toBeInstanceOf(Date)
		await dispute(lost, 'lost')
		expect(await refundsOf(lost)).toHaveLength(0)
		expect((await orderRow(lost)).cancelRefundDueAt).toBeNull()
		await orderRefundKicksIdle()
		expect(kicks).toEqual([])
	})

	it('drops the mark when nothing is left to refund', async () => {
		const whole = await onlineOrder(accepted)
		const all = (await (
			await intent(whole, { full: true })
		).json()) as IntentBody
		await cancelWithRefund(whole)
		await settle(all.refundId, 'succeeded')
		expect(await refundsOf(whole)).toHaveLength(1)
		expect((await orderRow(whole)).cancelRefundDueAt).toBeNull()
		await orderRefundKicksIdle()
		expect(kicks).toEqual([])
	})

	it('never books the rest twice: replayed reports and repeated ticks', async () => {
		const orderId = await onlineOrder(accepted)
		const first = (await (
			await intent(orderId, { amountCents: 250 })
		).json()) as IntentBody
		await cancelWithRefund(orderId)
		await settle(first.refundId, 'succeeded')
		for (const status of ['succeeded', 'pending'] as const) {
			expect(await (await settle(first.refundId, status)).json()).toMatchObject(
				{ applied: false },
			)
		}
		expect(await processOwedCancelRefunds(ORG)).toEqual({ booked: 0 })
		const rows = await refundsOf(orderId)
		expect(rows).toHaveLength(2)
		const rest = rows.find((row) => row.id !== first.refundId)!
		expect(rest.amountCents).toBe(750)
		// The rest fails: the order is no longer marked, so nothing books by
		// itself; the screen shows "Refund failed" and a person refunds again.
		await settle(rest.id, 'failed')
		expect(await processOwedCancelRefunds(ORG)).toEqual({ booked: 0 })
		expect(await refundsOf(orderId)).toHaveLength(2)
		expect(await (await intent(orderId, { full: true })).json()).toMatchObject({
			amountCents: 750,
		})
	})

	it('a rejection and the acceptance timeout owe the rest the same way', async () => {
		const waiting = {
			status: 'pending_acceptance' as const,
			completedAt: null,
			acceptanceDeadlineAt: new Date(Date.now() + 60_000),
		}
		// Turned down by a person.
		const rejected = await onlineOrder(waiting)
		const first = (await (
			await intent(rejected, { amountCents: 200 })
		).json()) as IntentBody
		const res = await operator('PATCH', `/${rejected}`, WRITE, {
			status: 'cancelled',
			rejectReason: 'too_busy',
		})
		expect(res.status).toBe(200)
		expect(await orderRow(rejected)).toMatchObject({
			status: 'cancelled',
			cancelledBy: 'operator',
		})
		expect((await orderRow(rejected)).cancelRefundDueAt).toBeInstanceOf(Date)
		await settle(first.refundId, 'succeeded')
		expect(
			(await refundsOf(rejected)).find((row) => row.id !== first.refundId),
		).toMatchObject({ amountCents: 800, status: 'pending', origin: 'system' })

		// Not accepted in time.
		const timedOut = await onlineOrder({
			...waiting,
			acceptanceDeadlineAt: new Date(Date.now() - 60_000),
		})
		const partial = (await (
			await intent(timedOut, { amountCents: 100 })
		).json()) as IntentBody
		const tick = await runOrdersTickForOrg(ORG)
		expect(tick.acceptanceRejected).toBe(1)
		expect(await orderRow(timedOut)).toMatchObject({
			status: 'cancelled',
			cancelledBy: 'system',
			rejectedReason: 'not_accepted_in_time',
		})
		expect((await orderRow(timedOut)).cancelRefundDueAt).toBeInstanceOf(Date)
		await settle(partial.refundId, 'failed')
		expect(
			(await refundsOf(timedOut)).find((row) => row.id !== partial.refundId),
		).toMatchObject({ amountCents: 1000, status: 'pending', origin: 'system' })
		expect((await orderRow(timedOut)).cancelRefundDueAt).toBeNull()
	})

	it('the orders tick books what is still owed', async () => {
		const orderId = await onlineOrder(accepted)
		const first = (await (
			await intent(orderId, { amountCents: 400 })
		).json()) as IntentBody
		await cancelWithRefund(orderId)
		// Nothing to do while the other refund waits.
		expect(await processOwedCancelRefunds(ORG)).toEqual({ booked: 0 })
		expect((await orderRow(orderId)).cancelRefundDueAt).toBeInstanceOf(Date)
		// The other refund became final without the region booking the rest
		// (simulated: written directly).
		const db = await getTenantDb(ORG)
		await db
			.update(restaurantOrderRefunds)
			.set({ status: 'failed', settledAt: Date.now() })
			.where(eq(restaurantOrderRefunds.id, first.refundId))
		const tick = await runOrdersTickForOrg(ORG)
		expect(tick.owedRefundsBooked).toBe(1)
		const rest = (await refundsOf(orderId)).find(
			(row) => row.id !== first.refundId,
		)
		expect(rest).toMatchObject({ amountCents: 1000, status: 'pending' })
		await orderRefundKicksIdle()
		expect(kicks).toEqual([{ orgId: ORG, refundId: rest!.id }])
		expect(await processOwedCancelRefunds(ORG)).toEqual({ booked: 0 })
	})
})

describe('reports that cannot be trusted to move money', () => {
	async function refundRow(refundId: string) {
		const db = await getTenantDb(ORG)
		const [row] = await db
			.select()
			.from(restaurantOrderRefunds)
			.where(eq(restaurantOrderRefunds.id, refundId))
		return row!
	}

	it('failed without id after succeeded: nothing reverses, nothing is refundable again', async () => {
		const orderId = await onlineOrder()
		const booked = (await (
			await intent(orderId, { amountCents: 400 })
		).json()) as IntentBody
		await settle(booked.refundId, 'succeeded', { providerRefundId: 're_ok' })

		// A run that never reached the provider (payment not found).
		const blind = await settle(booked.refundId, 'failed', {
			failureCode: 'payment_not_found',
		})
		expect(blind.status).toBe(200)
		expect(await blind.json()).toEqual({
			refundId: booked.refundId,
			orderId,
			status: 'succeeded',
			applied: false,
		})
		// The same by another route: found by order id only.
		const withOrder = await settle(booked.refundId, 'failed', { orderId })
		expect(await withOrder.json()).toMatchObject({
			status: 'succeeded',
			applied: false,
		})
		expect(await orderRow(orderId)).toMatchObject({
			refundedCents: 400,
			refundReversedCents: 0,
		})
		expect((await refundRow(booked.refundId)).reversedAt).toBeNull()
		const detail = await operator('GET', `/${orderId}`, {
			scope: 'orders:read',
		})
		expect(await detail.json()).toMatchObject({
			order: {
				refundedCents: 400,
				refundableCents: 600,
				refundStatus: 'partial',
			},
		})
		// Only 600 can go back: no second refund of the 400.
		const tooMuch = await intent(orderId, { amountCents: 601 })
		expect(await tooMuch.json()).toMatchObject({
			error: 'refund_exceeds_payment',
			refundableCents: 600,
		})
	})

	it('a failure naming a provider id the row never stored does not reverse a success either', async () => {
		const orderId = await onlineOrder()
		const booked = (await (
			await intent(orderId, { amountCents: 400 })
		).json()) as IntentBody
		// Succeeded without the provider id on record.
		await settle(booked.refundId, 'succeeded')
		const res = await settle(booked.refundId, 'failed', {
			providerRefundId: 're_unknown',
		})
		expect(await res.json()).toMatchObject({
			status: 'succeeded',
			applied: false,
		})
		expect(await orderRow(orderId)).toMatchObject({
			refundedCents: 400,
			refundReversedCents: 0,
		})
	})

	it('the same rule holds for a tab refund', async () => {
		const tabId = await insertTab(ORG, {
			id: 'tab-blind-failed',
			paymentProcessor: 'checkout',
			paymentSessionId: 'pay_blind_failed',
			paymentAmountCents: 1000,
		})
		const first = (await (
			await intent(`tab:${tabId}`, { amountCents: 400 })
		).json()) as IntentBody
		await settle(first.refundId, 'succeeded', { providerRefundId: 'act_ok' })
		const blind = await settle(first.refundId, 'failed', {
			failureCode: 'processor_unavailable',
		})
		expect(await blind.json()).toEqual({
			refundId: first.refundId,
			orderId: `tab:${tabId}`,
			status: 'succeeded',
			applied: false,
		})
		const db = await getTenantDb(ORG)
		const [row] = await db
			.select()
			.from(qrTabRefunds)
			.where(eq(qrTabRefunds.id, first.refundId))
		expect(row).toMatchObject({ status: 'succeeded', reversedAt: null })
		const tooMuch = await intent(`tab:${tabId}`, { amountCents: 601 })
		expect(await tooMuch.json()).toMatchObject({ refundableCents: 600 })
		// With the provider's own id it is a reversal.
		const real = await settle(first.refundId, 'failed', {
			providerRefundId: 'act_ok',
		})
		expect(await real.json()).toMatchObject({ status: 'failed', applied: true })
	})

	it('a refund the provider accepted is never released by a report without its id', async () => {
		const orderId = await onlineOrder()
		const booked = (await (
			await intent(orderId, { amountCents: 250 })
		).json()) as IntentBody
		await settle(booked.refundId, 'pending', { providerRefundId: 're_held' })

		const blind = await settle(booked.refundId, 'failed', {
			failureCode: 'payment_not_found',
		})
		expect(await blind.json()).toMatchObject({
			status: 'pending',
			applied: false,
		})
		expect((await refundRow(booked.refundId)).status).toBe('pending')
		// The reservation holds: another refund is still refused.
		const busy = await intent(orderId, { amountCents: 10 })
		expect(await busy.json()).toMatchObject({ error: 'refund_pending' })

		// The webhook's real success then counts, once.
		const done = await system('/refund-status', {
			orgId: ORG,
			providerRefundId: 're_held',
			status: 'succeeded',
		})
		expect(await done.json()).toMatchObject({
			status: 'succeeded',
			applied: true,
		})
		expect((await orderRow(orderId)).refundedCents).toBe(250)
	})

	it('the provider’s own failure, naming its id, still releases a pending refund', async () => {
		const orderId = await onlineOrder()
		const booked = (await (
			await intent(orderId, { amountCents: 250 })
		).json()) as IntentBody
		await settle(booked.refundId, 'pending', { providerRefundId: 're_bad' })
		const failed = await settle(booked.refundId, 'failed', {
			providerRefundId: 're_bad',
			failureCode: 'declined',
		})
		expect(await failed.json()).toMatchObject({
			status: 'failed',
			applied: true,
		})
		expect((await orderRow(orderId)).refundedCents).toBe(0)
		expect((await intent(orderId, { full: true })).status).toBe(201)
	})

	it('a success with a provider id after a failure with none is flagged for review, never applied', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		try {
			const orderId = await onlineOrder()
			const booked = (await (
				await intent(orderId, { amountCents: 250 })
			).json()) as IntentBody
			// A run that never reached the provider released the reservation.
			await settle(booked.refundId, 'failed', {
				failureCode: 'payment_not_found',
			})
			const late = await settle(booked.refundId, 'succeeded', {
				providerRefundId: 're_late',
			})
			expect(await late.json()).toMatchObject({
				status: 'failed',
				applied: false,
			})
			expect((await orderRow(orderId)).refundedCents).toBe(0)
			const flagged = warn.mock.calls.find(([message]) =>
				String(message).includes('needs review'),
			)
			expect(flagged).toBeDefined()
			// Ids only.
			expect(JSON.stringify(flagged)).toContain(booked.refundId)
			expect(JSON.stringify(flagged)).not.toContain('re_late')
		} finally {
			warn.mockRestore()
		}
	})
})

describe('a succeeded tab refund does what an order refund does', () => {
	async function loyalTab(customerId: string, id: string) {
		await activateProgram(ORG)
		await insertCustomer(ORG, { id: customerId })
		const memberId = await makeMember(ORG, { customerId })
		const tabId = await insertTab(ORG, {
			id,
			paymentProcessor: 'checkout',
			paymentSessionId: `pay_${customerId}`,
			paymentAmountCents: 1000,
		})
		await insertRound(ORG, tabId)
		const source = { type: 'qr_tab' as const, id: tabId }
		await claimAndQueue(ORG, { memberId, source })
		await reconcileLoyaltySource(ORG, source, { now: NOW })
		const db = await getTenantDb(ORG)
		await db.insert(discountRedemptions).values({
			discountId: 'dsc_tab',
			discountVersion: 1,
			sourceType: 'tab',
			sourceId: tabId,
			state: 'reserved',
			amountMinor: 100,
			allocation: [],
			snapshot: { name: 'Tab promo' },
			localDay: '2026-01-10',
			localWeek: '2026-W02',
		})
		// Used when the tab was paid.
		await db
			.update(discountRedemptions)
			.set({ state: 'consumed' })
			.where(eq(discountRedemptions.sourceId, tabId))
		return { memberId, tabId, source }
	}

	async function redemptionState(tabId: string) {
		const db = await getTenantDb(ORG)
		const [row] = await db
			.select({ state: discountRedemptions.state })
			.from(discountRedemptions)
			.where(
				and(
					eq(discountRedemptions.sourceType, 'tab'),
					eq(discountRedemptions.sourceId, tabId),
				),
			)
		return row?.state
	}

	it('takes points back for a partial refund and returns the discount use on a full one', async () => {
		const { memberId, tabId } = await loyalTab(
			'cus_tab_refund',
			'tab-loyal-refund',
		)
		expect((await balanceOf(ORG, memberId)).points).toBe(10)

		// Pending moves nothing.
		const half = (await (
			await intent(`tab:${tabId}`, { amountCents: 500 })
		).json()) as IntentBody
		expect((await balanceOf(ORG, memberId)).points).toBe(10)
		await settle(half.refundId, 'succeeded', { providerRefundId: 'act_half' })
		// Settled by the region itself: no manual loyalty refund, no reconcile call.
		expect((await balanceOf(ORG, memberId)).points).toBe(5)
		expect(await redemptionState(tabId)).toBe('consumed')

		const rest = (await (
			await intent(`tab:${tabId}`, { full: true })
		).json()) as IntentBody
		expect(rest.amountCents).toBe(500)
		await settle(rest.refundId, 'succeeded', { providerRefundId: 'act_rest' })
		expect((await balanceOf(ORG, memberId)).points).toBe(0)
		expect(await redemptionState(tabId)).toBe('refunded')

		// Replays count nothing twice.
		await settle(rest.refundId, 'succeeded', { providerRefundId: 'act_rest' })
		expect((await balanceOf(ORG, memberId)).points).toBe(0)
	})

	it('a failed or reversed tab refund takes no points and returns no use', async () => {
		const { memberId, tabId, source } = await loyalTab(
			'cus_tab_failed',
			'tab-loyal-failed',
		)
		const failing = (await (
			await intent(`tab:${tabId}`, { full: true })
		).json()) as IntentBody
		await settle(failing.refundId, 'failed')
		expect((await balanceOf(ORG, memberId)).points).toBe(10)
		expect(await redemptionState(tabId)).toBe('consumed')

		const working = (await (
			await intent(`tab:${tabId}`, { amountCents: 500 })
		).json()) as IntentBody
		await settle(working.refundId, 'succeeded', { providerRefundId: 'act_w' })
		expect((await balanceOf(ORG, memberId)).points).toBe(5)
		await settle(working.refundId, 'failed', { providerRefundId: 'act_w' })
		await reconcileLoyaltySource(ORG, source, { now: NOW })
		// Points stay taken, and a reversed refund no longer counts as refunded.
		expect((await balanceOf(ORG, memberId)).points).toBe(5)
		expect(await redemptionState(tabId)).toBe('consumed')
	})
})

describe('the loyalty report counts only refunds that stood', () => {
	it('leaves out a refund the provider reversed', async () => {
		await activateProgram(ORG)
		await insertCustomer(ORG, { id: 'cus_report' })
		const memberId = await makeMember(ORG, { customerId: 'cus_report' })
		const orderId = await onlineOrder()
		const source = { type: 'restaurant_order' as const, id: orderId }
		await claimAndQueue(ORG, { memberId, source })
		await reconcileLoyaltySource(ORG, source, { now: NOW })
		const booked = (await (
			await intent(orderId, { amountCents: 500 })
		).json()) as IntentBody
		await settle(booked.refundId, 'succeeded', { providerRefundId: 're_rep' })
		// A window around the refund's real creation time.
		const day = (offsetDays: number) =>
			new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10)
		const query = { from: day(-1), to: day(1) }
		const db = await getTenantDb(ORG)
		expect((await getLoyaltyReport(db, query)).operations.refundsRecorded).toBe(
			1,
		)
		await settle(booked.refundId, 'failed', { providerRefundId: 're_rep' })
		expect((await getLoyaltyReport(db, query)).operations.refundsRecorded).toBe(
			0,
		)
	})
})

describe('QR tab disputes check the processor', () => {
	it('answers the uniform 404 for another processor, like an order', async () => {
		const tabId = await insertTab(ORG, {
			id: 'tab-dispute-processor',
			paymentProcessor: 'checkout',
			paymentSessionId: 'pay_tab_processor',
			paymentAmountCents: 1000,
		})
		const wrong = await system('/dispute-status', {
			orgId: ORG,
			orderId: `tab:${tabId}`,
			processor: 'connect',
			status: 'open',
		})
		expect(wrong.status).toBe(404)
		expect(await wrong.json()).toMatchObject({ error: 'order_not_found' })
		const blocked = await intent(`tab:${tabId}`, { full: true })
		expect(blocked.status).toBe(201)

		const right = await system('/dispute-status', {
			orgId: ORG,
			orderId: `tab:${tabId}`,
			processor: 'checkout',
			status: 'open',
		})
		expect(right.status).toBe(200)
	})
})

describe('a cancel’s refund the provider reversed', () => {
	const accepted = { status: 'accepted' as const, completedAt: null }

	async function refundsOf(orderId: string) {
		const db = await getTenantDb(ORG)
		return db
			.select()
			.from(restaurantOrderRefunds)
			.where(eq(restaurantOrderRefunds.orderId, orderId))
	}

	async function cancelWithRefund(orderId: string) {
		return operator('PATCH', `/${orderId}`, REFUNDER, {
			status: 'cancelled',
			cancelReason: 'out_of_stock',
			refund: 'full',
		})
	}

	it('is booked again, under its own key each time, and the App is kicked', async () => {
		const orderId = await onlineOrder(accepted)
		await cancelWithRefund(orderId)
		const [first] = await refundsOf(orderId)
		expect(first).toMatchObject({
			status: 'pending',
			idempotencyKey: `cancel:${orderId}`,
		})
		await settle(first!.id, 'succeeded', { providerRefundId: 're_cancel_1' })
		await orderRefundKicksIdle()
		kicks.length = 0

		// The provider takes it back: the guest was told it is coming.
		const reversed = await settle(first!.id, 'failed', {
			providerRefundId: 're_cancel_1',
			failureCode: 'expired_or_canceled_card',
		})
		expect(await reversed.json()).toMatchObject({
			status: 'failed',
			applied: true,
		})
		const second = (await refundsOf(orderId)).find(
			(row) => row.id !== first!.id,
		)
		expect(second).toMatchObject({
			amountCents: 1000,
			status: 'pending',
			origin: 'system',
			idempotencyKey: `cancel:${orderId}:rest`,
		})
		expect((await orderRow(orderId)).cancelRefundDueAt).toBeNull()
		await orderRefundKicksIdle()
		expect(kicks).toEqual([{ orgId: ORG, refundId: second!.id }])
		// Replays and ticks book nothing more.
		await settle(first!.id, 'failed', { providerRefundId: 're_cancel_1' })
		expect(await processOwedCancelRefunds(ORG)).toEqual({ booked: 0 })
		expect(await refundsOf(orderId)).toHaveLength(2)

		// Reversed again: the next try has its own key.
		await settle(second!.id, 'succeeded', { providerRefundId: 're_cancel_2' })
		await settle(second!.id, 'failed', { providerRefundId: 're_cancel_2' })
		const third = (await refundsOf(orderId)).find(
			(row) => row.idempotencyKey === `cancel:${orderId}:rest:2`,
		)
		expect(third).toMatchObject({ amountCents: 1000, status: 'pending' })
		await settle(third!.id, 'succeeded', { providerRefundId: 're_cancel_3' })
		expect(await orderRow(orderId)).toMatchObject({
			refundedCents: 3000,
			refundReversedCents: 2000,
		})
		expect(await processOwedCancelRefunds(ORG)).toEqual({ booked: 0 })
		expect(await refundsOf(orderId)).toHaveLength(3)
	})

	it('waits for what blocks it: an open dispute, then books it once won', async () => {
		const orderId = await onlineOrder(accepted)
		await cancelWithRefund(orderId)
		const [first] = await refundsOf(orderId)
		await settle(first!.id, 'succeeded', { providerRefundId: 're_wait_1' })
		await system('/dispute-status', { orgId: ORG, orderId, status: 'open' })
		await settle(first!.id, 'failed', { providerRefundId: 're_wait_1' })
		// Marked owed, nothing booked while the dispute is open.
		expect((await orderRow(orderId)).cancelRefundDueAt).toBeInstanceOf(Date)
		expect(await refundsOf(orderId)).toHaveLength(1)
		expect(await processOwedCancelRefunds(ORG)).toEqual({ booked: 0 })

		await system('/dispute-status', { orgId: ORG, orderId, status: 'won' })
		const rest = (await refundsOf(orderId)).find(
			(row) => row.idempotencyKey === `cancel:${orderId}:rest`,
		)
		expect(rest).toMatchObject({ amountCents: 1000, status: 'pending' })
		expect((await orderRow(orderId)).cancelRefundDueAt).toBeNull()
	})

	it('a reversal of any other refund is left to a person', async () => {
		const orderId = await onlineOrder(accepted)
		const booked = (await (
			await intent(orderId, { amountCents: 300 })
		).json()) as IntentBody
		await settle(booked.refundId, 'succeeded', { providerRefundId: 're_hand' })
		await cancelWithRefund(orderId)
		await settle(booked.refundId, 'failed', { providerRefundId: 're_hand' })
		// The cancel booked its own refund of the 700 left; the reversed manual
		// refund is not owed by the cancel.
		expect((await orderRow(orderId)).cancelRefundDueAt).toBeNull()
		expect(await refundsOf(orderId)).toHaveLength(2)

		// An order that is not cancelled is never marked.
		const open = await onlineOrder(accepted)
		const refund = (await (
			await intent(open, { amountCents: 300 })
		).json()) as IntentBody
		await settle(refund.refundId, 'succeeded', { providerRefundId: 're_open' })
		await settle(refund.refundId, 'failed', { providerRefundId: 're_open' })
		expect((await orderRow(open)).cancelRefundDueAt).toBeNull()
		expect(await refundsOf(open)).toHaveLength(1)
	})
})

describe('the owed-refund sweep', () => {
	it('is not starved by orders whose refund is still pending', async () => {
		const db = await getTenantDb(ORG)
		const stuck: string[] = []
		// More stuck orders (older marks) than one pass reads.
		for (let index = 0; index < OWED_CANCEL_REFUNDS_BATCH; index += 1) {
			const orderId = await onlineOrder({
				status: 'cancelled',
				completedAt: null,
			})
			await intent(orderId, { amountCents: 100 })
			await db
				.update(restaurantOrders)
				.set({ cancelRefundDueAt: new Date(NOW + index) })
				.where(eq(restaurantOrders.id, orderId))
			stuck.push(orderId)
		}
		// A newer owed order whose other refund is final: the crash backstop.
		const newer = await onlineOrder({ status: 'cancelled', completedAt: null })
		await db
			.update(restaurantOrders)
			.set({ cancelRefundDueAt: new Date(NOW + 10_000) })
			.where(eq(restaurantOrders.id, newer))

		expect(await processOwedCancelRefunds(ORG)).toEqual({ booked: 1 })
		const rows = await db
			.select()
			.from(restaurantOrderRefunds)
			.where(eq(restaurantOrderRefunds.orderId, newer))
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({ amountCents: 1000, status: 'pending' })
		// The stuck ones keep their marks for when their refund settles.
		expect((await orderRow(stuck[0]!)).cancelRefundDueAt).toBeInstanceOf(Date)
	})
})

describe('guest views', () => {
	it('carry the refund progress and only guest-visible reasons, on both receipts', async () => {
		const orderId = await onlineOrder({
			status: 'cancelled',
			cancelReason: 'duplicate',
			cancelledBy: 'operator',
		})
		const row = await orderRow(orderId)
		const glance = { refundStatus: 'pending' as const, pendingCents: 1000 }
		for (const body of [
			receiptOrder(row, glance),
			linkReceiptOrder(row, glance),
		]) {
			expect(body).toMatchObject({
				refundStatus: 'pending',
				refundPendingCents: 1000,
				cancelledBy: 'operator',
				// `duplicate` is internal.
				cancelReason: null,
			})
		}
		const visible = { ...row, cancelReason: 'out_of_stock' as const }
		expect(linkReceiptOrder(visible).cancelReason).toBe('out_of_stock')
		expect(receiptOrder(visible)).toMatchObject({
			refundStatus: 'none',
			refundPendingCents: 0,
		})
	})
})
