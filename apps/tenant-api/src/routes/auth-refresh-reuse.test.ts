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
import { REFRESH_REUSE_GRACE_MS, authRoutes } from './auth.ts'
import { hmacHash } from '../lib/secrets.ts'

const orgId = 'clw9x0a12000008l00test06'

vi.mock('../lib/origin.ts', () => ({
	findActiveOrganizationById: vi.fn().mockResolvedValue({
		id: 'clw9x0a12000008l00test06',
		slug: 'refresh-test',
		customDomain: null,
		hasProvisionedDb: true,
		dataRegion: 'us',
	}),
	resolveOrganizationForBrowserAuth: vi.fn(),
	resolvePublishedOrganization: vi.fn(),
}))

function refresh(app: Hono, refreshToken: string) {
	return app.request('/auth/refresh', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ refreshToken, orgId }),
	})
}

// Moves a rotated token's rotation outside the lost-response grace window.
async function ageRotation(refreshToken: string) {
	const db = await getTenantDb(orgId)
	await db
		.update(customerRefreshTokens)
		.set({ rotatedAt: new Date(Date.now() - REFRESH_REUSE_GRACE_MS - 5_000) })
		.where(eq(customerRefreshTokens.tokenHash, hmacHash(refreshToken)))
		.run()
}

describe('refresh token rotation', () => {
	let app: Hono
	let tempDir: string
	let legacyRefreshToken: string

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-refresh-test-'))
		process.env.TENANT_DB_DIR = tempDir
		process.env.DATA_REGION = 'us'
		process.env.JWT_SECRET = 'test-jwt-secret-123456789'
		process.env.AUTH_HMAC_SECRET = 'test-hmac-secret-123456789'

		await provisionTenantDb(orgId)
		legacyRefreshToken = 'legacy-refresh-token'
		const db = await getTenantDb(orgId)
		await db.insert(customers).values({
			name: 'Refresh Customer',
			phone: '+15555550106',
			phoneVerified: true,
			refreshTokenHash: hmacHash(legacyRefreshToken),
			refreshTokenExpiresAt: new Date(Date.now() + 60_000),
		})

		app = new Hono()
		app.route('/auth', authRoutes)
	})

	afterEach(async () => {
		await destroyTenantDb(orgId).catch(() => {})
		fs.rmSync(tempDir, { recursive: true, force: true })
		delete process.env.TENANT_DB_DIR
	})

	it('revokes the current session when a rotated refresh token is reused', async () => {
		const legacyRefresh = await app.request('/auth/refresh', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ refreshToken: legacyRefreshToken, orgId }),
		})
		expect(legacyRefresh.status).toBe(200)
		const firstToken = (await legacyRefresh.json()).refreshToken as string

		const firstRotation = await app.request('/auth/refresh', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ refreshToken: firstToken, orgId }),
		})
		expect(firstRotation.status).toBe(200)
		const currentToken = (await firstRotation.json()).refreshToken as string

		// A replay inside the grace window is indistinguishable from a retry of
		// a lost response; this test covers the replay that arrives later.
		await ageRotation(firstToken)

		const replay = await app.request('/auth/refresh', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ refreshToken: firstToken, orgId }),
		})
		expect(replay.status).toBe(401)

		const currentSession = await app.request('/auth/refresh', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ refreshToken: currentToken, orgId }),
		})
		expect(currentSession.status).toBe(401)

		const db = await getTenantDb(orgId)
		const tokens = await db.select().from(customerRefreshTokens).all()
		expect(tokens).toHaveLength(2)
		expect(tokens.every((token) => token.revokedAt)).toBe(true)
		const customer = await db
			.select()
			.from(customers)
			.where(eq(customers.phone, '+15555550106'))
			.get()
		expect(customer?.refreshTokenHash).toBeNull()
	})

	it('gives a retry after a lost refresh response the same working session', async () => {
		const legacyRefresh = await refresh(app, legacyRefreshToken)
		const firstToken = (await legacyRefresh.json()).refreshToken as string

		// The response to this rotation is "lost": the client keeps firstToken.
		const lost = await refresh(app, firstToken)
		expect(lost.status).toBe(200)
		const lostChild = (await lost.json()).refreshToken as string

		const retry = await refresh(app, firstToken)
		expect(retry.status).toBe(200)
		const retryBody = await retry.json()
		expect(retryBody.accessToken).toEqual(expect.any(String))
		expect(retryBody.refreshToken).toBe(lostChild)

		// The session keeps working and nothing was revoked.
		const next = await refresh(app, retryBody.refreshToken as string)
		expect(next.status).toBe(200)
		const db = await getTenantDb(orgId)
		const tokens = await db.select().from(customerRefreshTokens).all()
		expect(tokens.some((token) => token.revokedAt)).toBe(false)
	})

	it('still revokes when an older ancestor is replayed inside the grace window', async () => {
		const legacyRefresh = await refresh(app, legacyRefreshToken)
		const firstToken = (await legacyRefresh.json()).refreshToken as string
		const second = await refresh(app, firstToken)
		const secondToken = (await second.json()).refreshToken as string
		const third = await refresh(app, secondToken)
		const thirdToken = (await third.json()).refreshToken as string

		// firstToken's child (secondToken) was already used, so this is a replay.
		const replay = await refresh(app, firstToken)
		expect(replay.status).toBe(401)
		expect((await refresh(app, thirdToken)).status).toBe(401)

		const db = await getTenantDb(orgId)
		const tokens = await db.select().from(customerRefreshTokens).all()
		expect(tokens.every((token) => token.revokedAt)).toBe(true)
	})

	it('gives concurrent refreshes of the same token the same session', async () => {
		const legacyRefresh = await refresh(app, legacyRefreshToken)
		expect(legacyRefresh.status).toBe(200)
		const firstToken = (await legacyRefresh.json()).refreshToken as string

		const [a, b] = await Promise.all([
			refresh(app, firstToken),
			refresh(app, firstToken),
		])
		expect([a.status, b.status]).toEqual([200, 200])
		const tokenA = (await a.json()).refreshToken as string
		const tokenB = (await b.json()).refreshToken as string
		expect(tokenA).toBe(tokenB)

		const db = await getTenantDb(orgId)
		const tokens = await db.select().from(customerRefreshTokens).all()
		expect(tokens).toHaveLength(2)
		expect((await refresh(app, tokenA)).status).toBe(200)
	})
})
