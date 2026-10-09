import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import {
	customerSubscriptions,
	customers,
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
} from '@repo/tenant-db'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { subscriptionRoutes } from './subscriptions.ts'
import { syncEnvFromProcess } from '../lib/secrets.ts'

const orgId = 'clw9x0a12000008l00test07'
const jwtSecret = 'test-jwt-secret-123456789'

vi.mock('../lib/origin.ts', () => ({
	findActiveOrganizationById: vi.fn().mockResolvedValue({
		id: 'clw9x0a12000008l00test07',
		slug: 'subs-test',
		customDomain: null,
		hasProvisionedDb: true,
		dataRegion: 'us',
	}),
}))

async function tokenFor(customerId: string) {
	return new SignJWT({
		customerId,
		orgId,
		name: 'Sam',
		orgSlug: 'subs-test',
		type: 'access',
	})
		.setProtectedHeader({ alg: 'HS256' })
		.setAudience('tenant-api')
		.setIssuer('menuza')
		.setExpirationTime('15m')
		.sign(new TextEncoder().encode(jwtSecret))
}

describe('customer subscription routes', () => {
	let app: Hono
	let tempDir: string
	let customerId: string
	let accessToken: string

	const put = (body: unknown, token = accessToken) =>
		app.request('/subscriptions/drops', {
			method: 'PUT',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(body),
		})
	const get = () =>
		app.request('/subscriptions', {
			headers: { Authorization: `Bearer ${accessToken}` },
		})

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-subs-test-'))
		process.env.TENANT_DB_DIR = tempDir
		process.env.DATA_REGION = 'us'
		process.env.JWT_SECRET = jwtSecret
		syncEnvFromProcess()

		await provisionTenantDb(orgId)
		const db = await getTenantDb(orgId)
		const [customer] = await db
			.insert(customers)
			.values({ name: 'Sam', phone: '+15555550111', phoneVerified: true })
			.returning()
		customerId = customer!.id
		accessToken = await tokenFor(customerId)

		app = new Hono()
		app.route('/subscriptions', subscriptionRoutes)
	})

	afterEach(async () => {
		await destroyTenantDb(orgId).catch(() => {})
		fs.rmSync(tempDir, { recursive: true, force: true })
		delete process.env.TENANT_DB_DIR
	})

	it('requires a signed-in customer', async () => {
		expect((await app.request('/subscriptions')).status).toBe(401)
	})

	it('starts unsubscribed, opts in, and records the source', async () => {
		await expect((await get()).json()).resolves.toEqual({
			drops: { sms: false },
		})

		const res = await put({ subscribed: true, source: 'menu' })
		expect(res.status).toBe(200)
		await expect((await get()).json()).resolves.toEqual({
			drops: { sms: true },
		})

		const db = await getTenantDb(orgId)
		const row = await db
			.select()
			.from(customerSubscriptions)
			.where(eq(customerSubscriptions.customerId, customerId))
			.get()
		expect(row).toMatchObject({
			topic: 'drops',
			channel: 'sms',
			source: 'menu',
			unsubscribedAt: null,
		})
	})

	it('keeps the opt-out on record and re-subscribes on the same row', async () => {
		await put({ subscribed: true, source: 'drops_page' })
		await put({ subscribed: false, source: 'profile' })
		await expect((await get()).json()).resolves.toEqual({
			drops: { sms: false },
		})

		const db = await getTenantDb(orgId)
		const optedOut = await db.select().from(customerSubscriptions).all()
		expect(optedOut).toHaveLength(1)
		expect(optedOut[0]!.unsubscribedAt).toBeInstanceOf(Date)

		await put({ subscribed: true, source: 'order_success' })
		const rows = await db.select().from(customerSubscriptions).all()
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({
			source: 'order_success',
			unsubscribedAt: null,
		})
	})

	it('refuses to subscribe an unverified phone', async () => {
		const db = await getTenantDb(orgId)
		const [unverified] = await db
			.insert(customers)
			.values({ name: '', phone: '+15555550112', phoneVerified: false })
			.returning()
		const res = await put(
			{ subscribed: true, source: 'menu' },
			await tokenFor(unverified!.id),
		)
		expect(res.status).toBe(409)
	})

	it('rejects unknown sources', async () => {
		expect((await put({ subscribed: true, source: 'popup' })).status).toBe(400)
	})
})
