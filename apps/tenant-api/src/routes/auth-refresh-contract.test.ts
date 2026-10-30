import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { and, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
	customerRefreshTokens,
	customers,
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
} from '@repo/tenant-db'
import { authRoutes, REFRESH_ROTATION_GRACE_MS } from './auth.ts'
import { hmacHash } from '../lib/secrets.ts'

const orgId = 'clw9x0a12000008l00test09'
const organization = {
	id: orgId,
	slug: 'refresh-contract',
	customDomain: null,
	hasProvisionedDb: true,
	dataRegion: 'us',
}

vi.mock('../lib/origin.ts', () => ({
	lookupActiveOrganization: vi.fn(),
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

async function liveTokens() {
	const db = await getTenantDb(orgId)
	return db
		.select()
		.from(customerRefreshTokens)
		.where(
			and(
				isNull(customerRefreshTokens.rotatedAt),
				isNull(customerRefreshTokens.revokedAt),
			),
		)
		.all()
}

async function backdateRotation(rawToken: string, msAgo: number) {
	const db = await getTenantDb(orgId)
	await db
		.update(customerRefreshTokens)
		.set({ rotatedAt: new Date(Date.now() - msAgo) })
		.where(eq(customerRefreshTokens.tokenHash, hmacHash(rawToken)))
		.run()
}

describe('customer refresh contract', () => {
	let app: Hono
	let tempDir: string
	const phone = '+15555550109'

	async function signIn() {
		const db = await getTenantDb(orgId)
		await db.insert(customers).values({
			name: 'Contract Customer',
			phone,
			phoneVerificationCode: hmacHash('424242'),
			phoneVerificationExpiresAt: new Date(Date.now() + 60_000),
		})
		const res = await post(app, '/auth/verify', { phone, code: '424242' })
		expect(res.status).toBe(200)
		return (await res.json()) as { accessToken: string; refreshToken: string }
	}

	async function refresh(refreshToken: string) {
		return post(app, '/auth/refresh', { refreshToken, orgId })
	}

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-contract-'))
		process.env.TENANT_DB_DIR = tempDir
		process.env.DATA_REGION = 'us'
		process.env.JWT_SECRET = 'test-jwt-secret-123456789'
		process.env.AUTH_HMAC_SECRET = 'test-hmac-secret-123456789'
		vi.mocked(origin.lookupActiveOrganization).mockResolvedValue({
			status: 'found',
			organization,
		})
		vi.mocked(origin.findActiveOrganizationById).mockResolvedValue(organization)
		vi.mocked(origin.resolveOrganizationForBrowserAuth).mockResolvedValue(
			organization,
		)
		vi.mocked(origin.resolvePublishedOrganization).mockResolvedValue(null)
		await provisionTenantDb(orgId)
		app = new Hono()
		app.route('/auth', authRoutes)
	})

	afterEach(async () => {
		await destroyTenantDb(orgId).catch(() => {})
		fs.rmSync(tempDir, { recursive: true, force: true })
		delete process.env.TENANT_DB_DIR
	})

	describe('organization lookup', () => {
		it('answers 503 on refresh when the control plane cannot be asked, and keeps the token', async () => {
			const { refreshToken } = await signIn()
			vi.mocked(origin.lookupActiveOrganization).mockResolvedValue({
				status: 'unavailable',
			})
			// The fallback a findActiveOrganizationById caller would see.
			vi.mocked(origin.findActiveOrganizationById).mockResolvedValue(null)
			const outage = await refresh(refreshToken)
			expect(outage.status).toBe(503)
			const body = (await outage.json()) as { code?: string }
			expect(body.code).not.toBe('organization_inactive')

			vi.mocked(origin.lookupActiveOrganization).mockResolvedValue({
				status: 'found',
				organization,
			})
			const after = await refresh(refreshToken)
			expect(after.status).toBe(200)
		})

		it('answers 403 organization_inactive on refresh when the organization is gone', async () => {
			const { refreshToken } = await signIn()
			vi.mocked(origin.lookupActiveOrganization).mockResolvedValue({
				status: 'missing',
			})
			const res = await refresh(refreshToken)
			expect(res.status).toBe(403)
			expect(await res.json()).toMatchObject({ code: 'organization_inactive' })
		})

		it('answers 403 organization_inactive on refresh when the organization moved region', async () => {
			const { refreshToken } = await signIn()
			vi.mocked(origin.lookupActiveOrganization).mockResolvedValue({
				status: 'found',
				organization: { ...organization, dataRegion: 'ksa' },
			})
			const res = await refresh(refreshToken)
			expect(res.status).toBe(403)
			expect(await res.json()).toMatchObject({ code: 'organization_inactive' })
		})

		it('answers 503 on an authenticated route when the control plane cannot be asked', async () => {
			const { accessToken } = await signIn()
			vi.mocked(origin.lookupActiveOrganization).mockResolvedValue({
				status: 'unavailable',
			})
			vi.mocked(origin.findActiveOrganizationById).mockResolvedValue(null)
			const me = await app.request('/auth/me', {
				headers: { Authorization: `Bearer ${accessToken}` },
			})
			expect(me.status).toBe(503)
			const body = (await me.json()) as { code?: string }
			expect(body.code).not.toBe('organization_inactive')
		})

		it('answers 403 organization_inactive on an authenticated route when the organization is gone', async () => {
			const { accessToken } = await signIn()
			vi.mocked(origin.lookupActiveOrganization).mockResolvedValue({
				status: 'missing',
			})
			vi.mocked(origin.findActiveOrganizationById).mockResolvedValue(null)
			const me = await app.request('/auth/me', {
				headers: { Authorization: `Bearer ${accessToken}` },
			})
			expect(me.status).toBe(403)
			expect(await me.json()).toMatchObject({ code: 'organization_inactive' })
		})

		it('still finds the organization through its published slug when the lookup cannot answer', async () => {
			const { accessToken } = await signIn()
			vi.mocked(origin.lookupActiveOrganization).mockResolvedValue({
				status: 'unavailable',
			})
			vi.mocked(origin.resolvePublishedOrganization).mockResolvedValue(
				organization,
			)
			const me = await app.request('/auth/me', {
				headers: { Authorization: `Bearer ${accessToken}` },
			})
			expect(me.status).toBe(200)
		})
	})

	describe('rotation grace window', () => {
		it('is between 30 and 60 seconds', () => {
			expect(REFRESH_ROTATION_GRACE_MS).toBeGreaterThanOrEqual(30_000)
			expect(REFRESH_ROTATION_GRACE_MS).toBeLessThanOrEqual(60_000)
		})

		it('answers a token whose rotation answer was lost with a fresh pair in the same session', async () => {
			const { refreshToken: first } = await signIn()
			const lost = await refresh(first)
			expect(lost.status).toBe(200)
			const lostSuccessor = ((await lost.json()) as { refreshToken: string })
				.refreshToken

			// The client never saw `lostSuccessor` and presents `first` again.
			const retry = await refresh(first)
			expect(retry.status).toBe(200)
			const pair = (await retry.json()) as {
				accessToken: string
				refreshToken: string
			}
			expect(typeof pair.accessToken).toBe('string')
			expect(pair.refreshToken).not.toBe(first)
			expect(pair.refreshToken).not.toBe(lostSuccessor)

			// Still exactly one live refresh token: the one just handed out.
			const live = await liveTokens()
			expect(live).toHaveLength(1)
			expect(live[0]!.tokenHash).toBe(hmacHash(pair.refreshToken))

			const next = await refresh(pair.refreshToken)
			expect(next.status).toBe(200)
		})

		it('lets two tabs that refresh with the same token at once both stay signed in', async () => {
			const { refreshToken: first } = await signIn()
			const [a, b] = await Promise.all([refresh(first), refresh(first)])
			expect([a.status, b.status]).toEqual([200, 200])
			const tokens = [
				((await a.json()) as { refreshToken: string }).refreshToken,
				((await b.json()) as { refreshToken: string }).refreshToken,
			]
			const live = await liveTokens()
			expect(live).toHaveLength(1)
			expect(tokens.map((token) => hmacHash(token))).toContain(
				live[0]!.tokenHash,
			)
		})

		it('still revokes the whole session when a rotated token comes back after the window', async () => {
			const { refreshToken: first } = await signIn()
			const rotated = await refresh(first)
			expect(rotated.status).toBe(200)
			const current = ((await rotated.json()) as { refreshToken: string })
				.refreshToken
			await backdateRotation(first, REFRESH_ROTATION_GRACE_MS + 5_000)

			const replay = await refresh(first)
			expect(replay.status).toBe(401)
			expect(await liveTokens()).toHaveLength(0)
			expect((await refresh(current)).status).toBe(401)
		})

		it('never revives a signed-out session', async () => {
			const { refreshToken: first } = await signIn()
			const rotated = await refresh(first)
			const current = ((await rotated.json()) as { refreshToken: string })
				.refreshToken
			const out = await post(app, '/auth/logout', {
				refreshToken: current,
				orgId,
			})
			expect(out.status).toBe(200)

			expect((await refresh(first)).status).toBe(401)
			expect((await refresh(current)).status).toBe(401)
			expect(await liveTokens()).toHaveLength(0)
		})
	})
})
