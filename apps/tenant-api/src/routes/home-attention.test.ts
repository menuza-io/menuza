import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { brand } from '@repo/config/brand'
import {
	destroyTenantDb,
	getTenantDb,
	invItems,
	invSoldOut,
	posDevices,
	provisionTenantDb,
	restaurantOrders,
} from '@repo/tenant-db'
import { findActiveOrganizationById } from '../lib/origin.ts'
import { homeInternalRoutes } from './home-internal.ts'
import { operatorOrderRoutes } from './operator-orders.ts'

vi.mock('../lib/origin.ts', () => ({
	findActiveOrganizationById: vi.fn(),
}))

const orgId = 'clw9x0a12000008l00home0001'
const otherOrgId = 'clw9x0a12000008l00home0002'
const internalToken = 'test-internal-token-very-long-and-secure-12345'
const operatorToken = 'test-operator-token-very-long-and-secure-12345'

function org(id: string) {
	return {
		id,
		slug: id,
		name: 'Org',
		customDomain: null,
		hasProvisionedDb: true,
		dataRegion: 'us',
	}
}

let sequence = 0
function order(
	values: Partial<typeof restaurantOrders.$inferInsert>,
): typeof restaurantOrders.$inferInsert {
	sequence += 1
	return {
		orgId,
		number: `H${sequence}`,
		status: 'completed',
		paymentMethod: 'handoff',
		paymentStatus: 'unpaid',
		fulfillment: 'pickup',
		locationId: 'loc_a',
		locationName: 'Olaya',
		contactName: 'Grace Hopper',
		contactPhone: '+15550001234',
		contactEmail: 'grace@example.com',
		currency: 'usd',
		subtotalCents: 1000,
		taxCents: 0,
		totalCents: 1000,
		lines: [],
		idempotencyKey: `idempotency-${sequence}`,
		requestHash: 'request-hash',
		receiptTokenHash: `receipt-${sequence}`,
		createdAt: new Date('2026-05-01T12:00:00Z'),
		...values,
	}
}

describe('home attention and launch routes', () => {
	let directory: string
	let app: Hono

	async function operatorJwt({
		tokenOrgId = orgId,
		secret = operatorToken,
		locationIds,
	}: {
		tokenOrgId?: string
		secret?: string
		locationIds?: string[] | null
	} = {}) {
		return new SignJWT({
			orgId: tokenOrgId,
			role: 'operator',
			scope: 'orders:read',
			...(locationIds === undefined ? {} : { locationIds }),
		})
			.setProtectedHeader({ alg: 'HS256' })
			.setAudience('tenant-api-operator')
			.setIssuer(brand.shortName)
			.setExpirationTime('1h')
			.sign(new TextEncoder().encode(secret))
	}

	function attention(token: string) {
		return app.request('/operator/orders/attention', {
			headers: { authorization: `Bearer ${token}` },
		})
	}

	function internal(pathname: string, body: unknown, token = internalToken) {
		return app.request(`/internal/home${pathname}`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(body),
		})
	}

	beforeEach(async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'home-attention-test-'))
		vi.stubEnv('TENANT_DB_DIR', directory)
		vi.stubEnv('DATA_REGION', 'us')
		vi.stubEnv('INTERNAL_COMMAND_TOKEN', internalToken)
		vi.stubEnv('TENANT_OPERATOR_TOKEN', operatorToken)
		vi.mocked(findActiveOrganizationById).mockImplementation(async (id) => {
			if (id === orgId || id === otherOrgId) return org(id) as never
			return null
		})
		await provisionTenantDb(orgId)
		await provisionTenantDb(otherOrgId)
		const db = await getTenantDb(orgId)
		await db.insert(restaurantOrders).values([
			order({ status: 'payment_review', paymentMethod: 'online' }),
			order({ status: 'payment_review', paymentMethod: 'online' }),
			order({
				status: 'payment_review',
				paymentMethod: 'online',
				locationId: 'loc_b',
			}),
			order({ createdAt: new Date('2026-04-02T09:00:00Z') }),
			// Cancelled: never the first order.
			order({
				status: 'cancelled',
				createdAt: new Date('2026-03-01T09:00:00Z'),
			}),
		])
		app = new Hono()
		app.route('/operator/orders', operatorOrderRoutes)
		app.route('/internal/home', homeInternalRoutes)
	})

	afterEach(async () => {
		await destroyTenantDb(orgId).catch(() => {})
		await destroyTenantDb(otherOrgId).catch(() => {})
		fs.rmSync(directory, { recursive: true, force: true })
		vi.unstubAllEnvs()
	})

	describe('GET /operator/orders/attention', () => {
		it('counts orders in payment review per location, counts only', async () => {
			const res = await attention(await operatorJwt())
			expect(res.status).toBe(200)
			const body = (await res.json()) as {
				locations: Array<{ locationId: string; paymentReview: number }>
			}
			expect(
				body.locations.sort((a, b) => a.locationId.localeCompare(b.locationId)),
			).toEqual([
				{ locationId: 'loc_a', paymentReview: 2 },
				{ locationId: 'loc_b', paymentReview: 1 },
			])
			const text = JSON.stringify(body)
			for (const pii of ['Grace', '555', 'example.com']) {
				expect(text).not.toContain(pii)
			}
		})

		it('limits a location-scoped token to its locations', async () => {
			const res = await attention(await operatorJwt({ locationIds: ['loc_b'] }))
			expect(await res.json()).toEqual({
				locations: [{ locationId: 'loc_b', paymentReview: 1 }],
				problems: [],
			})
			const none = await attention(await operatorJwt({ locationIds: [] }))
			expect(await none.json()).toEqual({ locations: [], problems: [] })
		})

		it('refuses a forged token', async () => {
			const res = await attention(
				await operatorJwt({ secret: 'some-other-secret-value-123456789' }),
			)
			expect(res.status).toBe(401)
		})

		it('answers another organization only with its own counts', async () => {
			const res = await attention(await operatorJwt({ tokenOrgId: otherOrgId }))
			expect(res.status).toBe(200)
			expect(await res.json()).toEqual({ locations: [], problems: [] })
		})
	})

	describe('POST /internal/home/launch-facts', () => {
		it('refuses a missing or wrong internal token', async () => {
			expect((await internal('/launch-facts', { orgId }, '')).status).toBe(401)
			expect(
				(await internal('/launch-facts', { orgId }, 'wrong-token-1234567890'))
					.status,
			).toBe(401)
		})

		it('returns paired locations and the first counted order time only', async () => {
			const db = await getTenantDb(orgId)
			await db.insert(posDevices).values([
				{
					label: 'Counter',
					terminalCode: 'T1',
					locationId: 'loc_a',
					secretHash: 'hash-1',
					pairedBy: 'user_1',
				},
				{
					label: 'Old',
					terminalCode: 'T2',
					locationId: 'loc_b',
					secretHash: 'hash-2',
					pairedBy: 'user_1',
					revokedAt: Date.now(),
				},
			] as never)
			const res = await internal('/launch-facts', { orgId })
			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toEqual({
				pairedLocationIds: ['loc_a'],
				firstOrderAt: '2026-04-02T09:00:00.000Z',
				// No test order was confirmed or run through the kitchen (#119).
				testOrderDoneAt: null,
			})
		})

		it('answers an empty organization with nothing', async () => {
			const res = await internal('/launch-facts', { orgId: otherOrgId })
			expect(await res.json()).toEqual({
				pairedLocationIds: [],
				firstOrderAt: null,
				testOrderDoneAt: null,
			})
		})

		it('refuses an unknown organization and a bad body', async () => {
			expect(
				(
					await internal('/launch-facts', {
						orgId: 'clw9x0a12000008l00home0009',
					})
				).status,
			).toBe(404)
			expect((await internal('/launch-facts', {})).status).toBe(400)
		})
	})

	describe('POST /internal/home/stock-sold-out', () => {
		it('lists only dishes inventory still holds off at the location', async () => {
			const db = await getTenantDb(orgId)
			const [item] = await db
				.insert(invItems)
				.values({ name: 'Tomatoes', baseUnit: 'g' } as never)
				.returning({ id: invItems.id })
			await db.insert(invSoldOut).values([
				{
					locationId: 'loc_a',
					entityType: 'item',
					entityId: 'dish_1',
					causeItemId: item!.id,
					state: 'out',
				},
				{
					locationId: 'loc_a',
					entityType: 'item',
					entityId: 'dish_2',
					causeItemId: item!.id,
					state: 'undone',
				},
				{
					locationId: 'loc_b',
					entityType: 'item',
					entityId: 'dish_3',
					causeItemId: item!.id,
					state: 'out',
				},
			] as never)
			const res = await internal('/stock-sold-out', {
				orgId,
				locationId: 'loc_a',
			})
			expect(res.status).toBe(200)
			expect(await res.json()).toEqual({ itemIds: ['dish_1'] })
		})
	})
})
