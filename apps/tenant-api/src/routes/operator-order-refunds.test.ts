import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	restaurantOrderRefunds,
} from '@repo/tenant-db'
import { Hono } from 'hono'
import * as jose from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type PublishedOrganization } from '../lib/origin.ts'
import { reconcileLoyaltySource } from '../services/loyalty-purchase-service.ts'
import {
	activateProgram,
	balanceOf,
	claimAndQueue,
	insertCustomer,
	insertOrder,
	makeMember,
	makeReward,
	NOW,
	reserveReward,
} from '../services/loyalty-test-fixture.ts'
import { operatorOrderRoutes } from './operator-orders.ts'

const SECRET = 'test-operator-secret-key-for-order-refunds-32!!'
const ORG = 'org_oref_a'
const ORG_B = 'org_oref_b'

const orgs = vi.hoisted(() => new Map<string, PublishedOrganization>())
vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	findActiveOrganizationById: vi.fn(async (id: string) => orgs.get(id) ?? null),
}))

const app = new Hono()
app.route('/operator/orders', operatorOrderRoutes)

let tempDir: string
let keyCounter = 0

type Claims = Record<string, unknown>
const WRITE: Claims = { scope: 'orders:write' }
const READ: Claims = { scope: 'orders:read' }

async function token(
	claims: Claims,
	options: { orgId?: string; secret?: string; audience?: string } = {},
) {
	const now = Math.floor(Date.now() / 1000)
	return new jose.SignJWT({
		role: 'operator',
		orgId: options.orgId ?? ORG,
		...claims,
	})
		.setProtectedHeader({ alg: 'HS256' })
		.setSubject('usr_1')
		.setIssuer(brand.shortName)
		.setAudience(options.audience ?? 'tenant-api-operator')
		.setIssuedAt(now)
		.setExpirationTime(now + 300)
		.sign(new TextEncoder().encode(options.secret ?? SECRET))
}

function newKey() {
	return `refund-key-${++keyCounter}`
}

async function postRefund(
	orderId: string,
	body: unknown,
	options: {
		claims?: Claims
		orgId?: string
		secret?: string
		audience?: string
		idempotencyKey?: string | null
	} = {},
) {
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		Authorization: `Bearer ${await token(options.claims ?? WRITE, options)}`,
	}
	const idempotencyKey =
		options.idempotencyKey === undefined ? newKey() : options.idempotencyKey
	if (idempotencyKey !== null) headers['Idempotency-Key'] = idempotencyKey
	return app.request(`/operator/orders/${orderId}/refunds`, {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
	})
}

type RefundBody = {
	order: {
		id: string
		refundedCents: number
		paymentStatus: string
		refunds: Array<{
			id: string
			amountCents: number
			currency: string
			full: boolean
			note: string | null
			actorId: string
			createdAt: string
		}>
	}
	refund: { id: string; amountCents: number; full: boolean }
	replayed: boolean
}

const NOTE = 'Customer returned it'

beforeEach(async () => {
	tempDir = mkdtempSync(path.join(tmpdir(), 'op-order-refunds-'))
	vi.stubEnv('TENANT_DB_DIR', tempDir)
	vi.stubEnv('DATA_REGION', 'us')
	vi.stubEnv('TENANT_OPERATOR_TOKEN', SECRET)
	vi.stubEnv('AUTH_HMAC_SECRET', 'test-hmac-secret-123456789')
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
	for (const id of [ORG, ORG_B]) await destroyTenantDb(id).catch(() => {})
	rmSync(tempDir, { recursive: true, force: true })
	vi.unstubAllEnvs()
})

describe('POST /operator/orders/:id/refunds', () => {
	it('records a refund, replays the same key and lists refunds on the order', async () => {
		const orderId = await insertOrder(ORG)
		const idempotencyKey = newKey()
		const res = await postRefund(
			orderId,
			{ amountCents: 250, note: NOTE },
			{ idempotencyKey },
		)
		expect(res.status).toBe(201)
		expect(res.headers.get('Cache-Control')).toBe('private, no-store')
		const body = (await res.json()) as RefundBody
		expect(body.replayed).toBe(false)
		expect(body.refund).toMatchObject({ amountCents: 250, full: false })
		expect(body.order).toMatchObject({
			id: orderId,
			refundedCents: 250,
			paymentStatus: 'paid',
		})
		expect(body.order.refunds).toEqual([
			{
				id: body.refund.id,
				amountCents: 250,
				currency: 'USD',
				full: false,
				note: NOTE,
				actorId: 'usr_1',
				createdAt: expect.any(String),
			},
		])

		const replay = await postRefund(
			orderId,
			{ amountCents: 250, note: NOTE },
			{ idempotencyKey },
		)
		expect(replay.status).toBe(200)
		const replayed = (await replay.json()) as RefundBody
		expect(replayed.replayed).toBe(true)
		expect(replayed.refund.id).toBe(body.refund.id)
		expect(replayed.order.refundedCents).toBe(250)

		const conflict = await postRefund(
			orderId,
			{ amountCents: 300, note: NOTE },
			{ idempotencyKey },
		)
		expect(conflict.status).toBe(409)
		expect(await conflict.json()).toMatchObject({
			error: 'idempotency_conflict',
		})

		const rest = await postRefund(orderId, { full: true, note: NOTE })
		expect(rest.status).toBe(201)
		const full = (await rest.json()) as RefundBody
		expect(full.refund).toMatchObject({ amountCents: 750, full: true })
		expect(full.order.refundedCents).toBe(1000)
		expect(full.order.refunds.map((refund) => refund.amountCents)).toEqual([
			250, 750,
		])

		const detail = await app.request(`/operator/orders/${orderId}`, {
			headers: { Authorization: `Bearer ${await token(READ)}` },
		})
		expect(detail.status).toBe(200)
		const detailBody = (await detail.json()) as Pick<RefundBody, 'order'>
		expect(detailBody.order.refundedCents).toBe(1000)
		expect(detailBody.order.refunds).toHaveLength(2)
	})

	it('answers with what is left to refund and refuses orders it cannot refund', async () => {
		const orderId = await insertOrder(ORG)
		const tooMuch = await postRefund(orderId, { amountCents: 1001, note: NOTE })
		expect(tooMuch.status).toBe(422)
		expect(await tooMuch.json()).toMatchObject({
			error: 'refund_exceeds_payment',
			refundableCents: 1000,
		})

		const missing = await postRefund('ord_missing', { full: true, note: NOTE })
		expect(missing.status).toBe(404)
		expect(await missing.json()).toMatchObject({ error: 'order_not_found' })

		const handoff = await insertOrder(ORG, { paymentMethod: 'handoff' })
		const notOnline = await postRefund(handoff, { full: true, note: NOTE })
		expect(notOnline.status).toBe(409)
		expect(await notOnline.json()).toMatchObject({ error: 'refund_not_online' })

		const unpaid = await insertOrder(ORG, {
			status: 'accepted',
			paymentStatus: 'pending',
			paidAt: null,
			completedAt: null,
		})
		const notPaid = await postRefund(unpaid, { full: true, note: NOTE })
		expect(notPaid.status).toBe(409)
		expect(await notPaid.json()).toMatchObject({ error: 'refund_not_paid' })
	})

	it('needs an idempotency key and a valid body', async () => {
		const orderId = await insertOrder(ORG)
		const noKey = await postRefund(
			orderId,
			{ amountCents: 100, note: NOTE },
			{ idempotencyKey: null },
		)
		expect(noKey.status).toBe(400)
		expect(await noKey.json()).toMatchObject({
			error: 'idempotency_key_required',
		})
		const shortKey = await postRefund(
			orderId,
			{ amountCents: 100, note: NOTE },
			{ idempotencyKey: 'short' },
		)
		expect(shortKey.status).toBe(400)

		for (const body of [
			{ amountCents: 0, note: NOTE },
			{ amountCents: 1.5, note: NOTE },
			{ amountCents: -100, note: NOTE },
			{ amountCents: 100 },
			{ amountCents: 100, note: 'no' },
			{ amountCents: 100, note: 'x'.repeat(281) },
			{ full: false, note: NOTE },
			{ full: true, amountCents: 100, note: NOTE },
			{ amountCents: 100, note: NOTE, orderId: 'other' },
			null,
		]) {
			const res = await postRefund(orderId, body)
			expect(res.status, JSON.stringify(body)).toBe(400)
			expect(await res.json()).toMatchObject({ error: 'invalid_refund' })
		}
		const db = await getTenantDb(ORG)
		expect(await db.select().from(restaurantOrderRefunds)).toEqual([])
	})

	it('refuses a missing, forged, wrong-audience or read-only token', async () => {
		const orderId = await insertOrder(ORG)
		const body = JSON.stringify({ amountCents: 100, note: NOTE })
		const anonymous = await app.request(`/operator/orders/${orderId}/refunds`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Idempotency-Key': newKey(),
			},
			body,
		})
		expect(anonymous.status).toBe(401)

		const forged = await postRefund(
			orderId,
			{ amountCents: 100, note: NOTE },
			{ secret: 'another-secret-that-is-long-enough-32!!' },
		)
		expect(forged.status).toBe(401)
		const wrongAudience = await postRefund(
			orderId,
			{ amountCents: 100, note: NOTE },
			{ audience: 'tenant-api-loyalty-operator' },
		)
		expect(wrongAudience.status).toBe(401)
		const readOnly = await postRefund(
			orderId,
			{ amountCents: 100, note: NOTE },
			{ claims: READ },
		)
		expect(readOnly.status).toBe(403)
		const noScope = await postRefund(
			orderId,
			{ amountCents: 100, note: NOTE },
			{ claims: { scope: 'people' } },
		)
		expect(noScope.status).toBe(403)

		const db = await getTenantDb(ORG)
		expect(await db.select().from(restaurantOrderRefunds)).toEqual([])
	})

	it('never reaches another organization or an unprovisioned one', async () => {
		const orderId = await insertOrder(ORG)
		const crossOrg = await postRefund(
			orderId,
			{ amountCents: 100, note: NOTE },
			{ orgId: ORG_B },
		)
		expect(crossOrg.status).toBe(404)

		orgs.set(ORG, { ...orgs.get(ORG)!, hasProvisionedDb: false })
		const unprovisioned = await postRefund(orderId, {
			amountCents: 100,
			note: NOTE,
		})
		expect(unprovisioned.status).toBe(404)

		orgs.set(ORG, {
			...orgs.get(ORG)!,
			hasProvisionedDb: true,
			dataRegion: 'ksa',
		})
		const wrongRegion = await postRefund(orderId, {
			amountCents: 100,
			note: NOTE,
		})
		expect(wrongRegion.status).toBe(409)

		const db = await getTenantDb(ORG)
		expect(await db.select().from(restaurantOrderRefunds)).toEqual([])
	})

	it('takes loyalty points back even with loyalty switched off on this node', async () => {
		await activateProgram(ORG)
		await insertCustomer(ORG, { id: 'cus_1' })
		const memberId = await makeMember(ORG, { customerId: 'cus_1' })
		const orderId = await insertOrder(ORG)
		const source = { type: 'restaurant_order' as const, id: orderId }
		await claimAndQueue(ORG, { memberId, source })
		await reconcileLoyaltySource(ORG, source, { now: NOW })
		expect((await balanceOf(ORG, memberId)).points).toBe(10)

		vi.stubEnv('LOYALTY_ENABLED', 'false')
		const res = await postRefund(
			orderId,
			{ amountCents: 250, note: NOTE },
			{ claims: { ...WRITE, refundLoyalty: true } },
		)
		expect(res.status).toBe(201)
		expect((await balanceOf(ORG, memberId)).points).toBe(7)
	})

	it('needs the loyalty refund claim when the order carries loyalty, and refuses impersonation', async () => {
		await activateProgram(ORG)
		await insertCustomer(ORG, { id: 'cus_1' })
		const memberId = await makeMember(ORG, { customerId: 'cus_1' })
		const earned = await insertOrder(ORG)
		const source = { type: 'restaurant_order' as const, id: earned }
		await claimAndQueue(ORG, { memberId, source })
		await reconcileLoyaltySource(ORG, source, { now: NOW })
		expect((await balanceOf(ORG, memberId)).points).toBe(10)

		const redeemed = await insertOrder(ORG)
		const reward = await makeReward(ORG)
		await reserveReward(ORG, {
			memberId,
			rewardId: reward.id,
			source: { type: 'restaurant_order', id: redeemed },
		})

		const db = await getTenantDb(ORG)
		for (const orderId of [earned, redeemed]) {
			const plain = await postRefund(orderId, { amountCents: 250, note: NOTE })
			expect(plain.status, orderId).toBe(403)
			expect(await plain.json()).toMatchObject({
				error: 'loyalty_refund_forbidden',
			})
			const impersonated = await postRefund(
				orderId,
				{ amountCents: 250, note: NOTE },
				{ claims: { ...WRITE, refundLoyalty: true, impersonated: true } },
			)
			expect(impersonated.status, orderId).toBe(403)
			expect(await impersonated.json()).toMatchObject({
				error: 'impersonation_forbidden',
			})
		}
		expect(await db.select().from(restaurantOrderRefunds)).toEqual([])
		expect((await balanceOf(ORG, memberId)).points).toBe(10)

		const allowed = await postRefund(
			earned,
			{ amountCents: 250, note: NOTE },
			{ claims: { ...WRITE, refundLoyalty: true } },
		)
		expect(allowed.status).toBe(201)
		expect((await balanceOf(ORG, memberId)).points).toBe(7)

		// An order loyalty never touched needs only the orders write scope.
		const plainOrder = await insertOrder(ORG)
		const plainRefund = await postRefund(
			plainOrder,
			{ amountCents: 100, note: NOTE },
			{ claims: { ...WRITE, impersonated: true } },
		)
		expect(plainRefund.status).toBe(201)
	})
})

describe('location-scoped order tokens', () => {
	async function call(
		method: string,
		pathname: string,
		claims: Claims,
		body?: unknown,
	) {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${await token(claims)}`,
		}
		if (body !== undefined) {
			headers['Content-Type'] = 'application/json'
			headers['Idempotency-Key'] = newKey()
		}
		return app.request(`/operator/orders${pathname}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
		})
	}

	async function listedIds(claims: Claims) {
		const res = await call('GET', '', claims)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { orders: Array<{ id: string }> }
		return body.orders.map((order) => order.id).sort()
	}

	it('lists, reads, changes and refunds only the orders at the token’s locations', async () => {
		const here = await insertOrder(ORG, { locationId: 'loc_here' })
		const there = await insertOrder(ORG, { locationId: 'loc_there' })
		const scopedRead = { ...READ, locationIds: ['loc_here'] }
		const scopedWrite = { ...WRITE, locationIds: ['loc_here'] }

		expect(await listedIds(scopedRead)).toEqual([here])
		expect(await listedIds({ ...READ, locationIds: null })).toEqual(
			[here, there].sort(),
		)
		expect(await listedIds({ ...READ, locationIds: [] })).toEqual([])
		// A claim that is present but malformed reaches no location.
		expect(await listedIds({ ...READ, locationIds: 'loc_here' })).toEqual([])

		expect((await call('GET', `/${here}`, scopedRead)).status).toBe(200)
		const hidden = await call('GET', `/${there}`, scopedRead)
		expect(hidden.status).toBe(404)
		expect(await hidden.json()).toMatchObject({ error: 'order_not_found' })

		const patch = await call('PATCH', `/${there}`, scopedWrite, {
			status: 'cancelled',
		})
		expect(patch.status).toBe(404)
		const refund = await call('POST', `/${there}/refunds`, scopedWrite, {
			amountCents: 100,
			note: NOTE,
		})
		expect(refund.status).toBe(404)
		const db = await getTenantDb(ORG)
		expect(await db.select().from(restaurantOrderRefunds)).toEqual([])

		const allowed = await call('POST', `/${here}/refunds`, scopedWrite, {
			amountCents: 100,
			note: NOTE,
		})
		expect(allowed.status).toBe(201)
	})
})
