import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
	customerRefreshTokens,
	customers,
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
} from '@repo/tenant-db'
import { authRoutes } from './auth.ts'
import { hmacHash } from '../lib/secrets.ts'

const orgId = 'clw9x0a12000008l00test07'
const organization = {
	id: orgId,
	slug: 'hardening-test',
	customDomain: null,
	hasProvisionedDb: true,
	dataRegion: 'us',
}

vi.mock('../lib/origin.ts', () => ({
	findActiveOrganizationById: vi.fn(),
	resolveOrganizationForBrowserAuth: vi.fn(),
	resolvePublishedOrganization: vi.fn(),
}))
vi.mock('../services/journey-service.ts', () => ({
	evaluateAndSpawnTriggers: vi.fn().mockResolvedValue(undefined),
}))

const origin = await import('../lib/origin.ts')

function post(app: Hono, route: string, body: unknown, headers = {}) {
	return app.request(route, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...headers },
		body: JSON.stringify(body),
	})
}

describe('customer auth hardening', () => {
	let app: Hono
	let tempDir: string
	const phone = '+15555550107'

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-hardening-'))
		process.env.TENANT_DB_DIR = tempDir
		process.env.DATA_REGION = 'us'
		process.env.JWT_SECRET = 'test-jwt-secret-123456789'
		process.env.AUTH_HMAC_SECRET = 'test-hmac-secret-123456789'
		vi.mocked(origin.findActiveOrganizationById).mockResolvedValue(organization)
		vi.mocked(origin.resolveOrganizationForBrowserAuth).mockResolvedValue(
			organization,
		)
		await provisionTenantDb(orgId)
		app = new Hono()
		app.route('/auth', authRoutes)
	})

	afterEach(async () => {
		await destroyTenantDb(orgId).catch(() => {})
		fs.rmSync(tempDir, { recursive: true, force: true })
		delete process.env.TENANT_DB_DIR
	})

	it('rejects non-numeric and oversized phone numbers before sending SMS', async () => {
		for (const bad of [
			'abcdefgh',
			'+1555<script>',
			'1'.repeat(40),
			'+0123456',
		]) {
			const res = await post(app, '/auth/send-code', { phone: bad })
			expect(res.status).toBe(400)
		}
		const db = await getTenantDb(orgId)
		expect(await db.select().from(customers).all()).toHaveLength(0)
	})

	it('consumes a verification code only once', async () => {
		const db = await getTenantDb(orgId)
		await db.insert(customers).values({
			name: 'Otp Customer',
			phone,
			phoneVerificationCode: hmacHash('123456'),
			phoneVerificationExpiresAt: new Date(Date.now() + 60_000),
		})
		const first = await post(app, '/auth/verify', { phone, code: '123456' })
		expect(first.status).toBe(200)
		const second = await post(app, '/auth/verify', { phone, code: '123456' })
		expect(second.status).toBe(400)
	})

	it('rejects verification codes that are not six digits', async () => {
		const res = await post(app, '/auth/verify', { phone, code: '12345a' })
		expect(res.status).toBe(400)
	})

	it('does not revoke other sessions when an expired refresh token is presented', async () => {
		const db = await getTenantDb(orgId)
		const [customer] = await db
			.insert(customers)
			.values({ name: 'Two Devices', phone, phoneVerified: true })
			.returning()
		await db.insert(customerRefreshTokens).values([
			{
				customerId: customer!.id,
				tokenHash: hmacHash('expired-token'),
				expiresAt: new Date(Date.now() - 1000),
			},
			{
				customerId: customer!.id,
				tokenHash: hmacHash('live-token'),
				expiresAt: new Date(Date.now() + 60_000),
			},
		])

		const expired = await post(app, '/auth/refresh', {
			refreshToken: 'expired-token',
			orgId,
		})
		expect(expired.status).toBe(401)

		const live = await post(app, '/auth/refresh', {
			refreshToken: 'live-token',
			orgId,
		})
		expect(live.status).toBe(200)
	})

	it('keeps the existing refresh token valid when the profile is updated', async () => {
		const db = await getTenantDb(orgId)
		await db.insert(customers).values({
			name: 'Old Name',
			phone,
			phoneVerificationCode: hmacHash('654321'),
			phoneVerificationExpiresAt: new Date(Date.now() + 60_000),
		})
		const verified = await post(app, '/auth/verify', { phone, code: '654321' })
		const { accessToken, refreshToken } = (await verified.json()) as {
			accessToken: string
			refreshToken: string
		}

		const profile = await post(
			app,
			'/auth/profile',
			{ name: 'New Name' },
			{ Authorization: `Bearer ${accessToken}` },
		)
		expect(profile.status).toBe(200)
		expect(
			((await profile.json()) as { refreshToken?: string }).refreshToken,
		).toBeUndefined()

		const refreshed = await post(app, '/auth/refresh', { refreshToken, orgId })
		expect(refreshed.status).toBe(200)

		const row = await db
			.select()
			.from(customers)
			.where(eq(customers.phone, phone))
			.get()
		expect(row?.name).toBe('New Name')
	})

	it('rejects tokens for organizations that are no longer active', async () => {
		const db = await getTenantDb(orgId)
		await db.insert(customers).values({
			name: 'Gone Org',
			phone,
			phoneVerificationCode: hmacHash('111222'),
			phoneVerificationExpiresAt: new Date(Date.now() + 60_000),
		})
		const verified = await post(app, '/auth/verify', { phone, code: '111222' })
		const { accessToken } = (await verified.json()) as { accessToken: string }

		vi.mocked(origin.findActiveOrganizationById).mockResolvedValue(null)
		vi.mocked(origin.resolvePublishedOrganization).mockResolvedValue(null)
		const me = await app.request('/auth/me', {
			headers: { Authorization: `Bearer ${accessToken}` },
		})
		expect(me.status).toBe(403)
	})
})
