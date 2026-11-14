import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	qrTabPayments,
	qrTabRefunds,
	restaurantOrderRefunds,
	restaurantOrders,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import * as jose from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type PublishedOrganization } from '../lib/origin.ts'
import {
	orderRefundKicksIdle,
	setOrderRefundKickForTest,
} from '../lib/order-refund-kick.ts'
import { reconcileLoyaltySource } from '../services/loyalty-purchase-service.ts'
import {
	activateProgram,
	balanceOf,
	claimAndQueue,
	insertCustomer,
	insertOrder,
	insertTab,
	LOC_1,
	LOC_2,
	makeMember,
	NOW,
} from '../services/loyalty-test-fixture.ts'
import { linkReceiptOrder } from '../services/order-link-access.ts'
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
	} = {},
) {
	return system('/refund-intent', {
		orgId: options.orgId ?? ORG,
		orderId,
		...(options.tabPaymentId ? { tabPaymentId: options.tabPaymentId } : {}),
		...(options.locationIds !== undefined
			? { locationIds: options.locationIds }
			: {}),
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

		// A failure reported after the success is not applied either.
		const lateFailure = await settle(booked.refundId, 'failed')
		expect(await lateFailure.json()).toMatchObject({
			status: 'succeeded',
			applied: false,
		})
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
