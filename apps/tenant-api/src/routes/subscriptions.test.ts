import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import {
	customerSubscriptions,
	customers,
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { syncEnvFromProcess } from '../lib/secrets.ts'
import { subscriptionRoutes } from './subscriptions.ts'

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
		.setIssuer(brand.slug)
		.setExpirationTime('15m')
		.sign(new TextEncoder().encode(jwtSecret))
}

describe('customer subscription routes', () => {
	let app: Hono
	let tempDir: string
	let customerId: string
	let accessToken: string

	const put = (path: string, body: unknown, token = accessToken) =>
		app.request(`/subscriptions/${path}`, {
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
			.values({
				name: 'Sam',
				phone: '+15555550111',
				phoneVerified: true,
				email: 'sam@example.com',
			})
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

	it('starts with no consent, opts in, and records the source', async () => {
		await expect((await get()).json()).resolves.toEqual({ subscriptions: [] })
		const res = await put('marketing/email', {
			subscribed: true,
			source: 'signup',
		})
		expect(res.status).toBe(200)
		await expect((await get()).json()).resolves.toEqual({
			subscriptions: [
				{ topic: 'marketing', channel: 'email', subscribed: true },
			],
		})
		const db = await getTenantDb(orgId)
		const row = await db
			.select()
			.from(customerSubscriptions)
			.where(eq(customerSubscriptions.customerId, customerId))
			.get()
		expect(row).toMatchObject({ source: 'signup', unsubscribedAt: null })
	})

	it('keeps the opt-out on record and re-subscribes on the same row', async () => {
		await put('marketing/sms', { subscribed: true })
		await put('marketing/sms', { subscribed: false })
		const db = await getTenantDb(orgId)
		const rows = await db.select().from(customerSubscriptions).all()
		expect(rows).toHaveLength(1)
		expect(rows[0]!.unsubscribedAt).toBeInstanceOf(Date)
		await put('marketing/sms', { subscribed: true, source: 'checkout' })
		const after = await db.select().from(customerSubscriptions).all()
		expect(after).toHaveLength(1)
		expect(after[0]).toMatchObject({ source: 'checkout', unsubscribedAt: null })
	})

	it('refuses an sms subscription for an unverified phone', async () => {
		const db = await getTenantDb(orgId)
		const [unverified] = await db
			.insert(customers)
			.values({ name: '', phone: '+15555550112', phoneVerified: false })
			.returning()
		const res = await put(
			'marketing/sms',
			{ subscribed: true },
			await tokenFor(unverified!.id),
		)
		expect(res.status).toBe(409)
	})

	it('refuses an email subscription without an address', async () => {
		const db = await getTenantDb(orgId)
		const [noEmail] = await db
			.insert(customers)
			.values({ name: '', phone: '+15555550113', phoneVerified: true })
			.returning()
		const res = await put(
			'marketing/email',
			{ subscribed: true },
			await tokenFor(noEmail!.id),
		)
		expect(res.status).toBe(409)
	})

	it('rejects unknown topics, channels and sources', async () => {
		expect((await put('promos/email', { subscribed: true })).status).toBe(404)
		expect((await put('marketing/fax', { subscribed: true })).status).toBe(404)
		expect(
			(await put('marketing/email', { subscribed: true, source: 'popup' }))
				.status,
		).toBe(400)
	})
})
