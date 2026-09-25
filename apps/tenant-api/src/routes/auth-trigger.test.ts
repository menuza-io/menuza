import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { eq } from 'drizzle-orm'
import {
	provisionTenantDb,
	destroyTenantDb,
	getTenantDb,
	customers,
	marketingJourneys,
	journeyRuns,
} from '@repo/tenant-db'
import { authRoutes } from './auth.ts'
import { hmacHash } from '../lib/secrets.ts'

const testOrgId = 'clw9x0a12000008l00test03'

vi.mock('../lib/origin.ts', () => ({
	resolveOrganizationForBrowserAuth: vi.fn().mockResolvedValue({
		id: 'clw9x0a12000008l00test03',
		slug: 'test-org',
		customDomain: null,
		hasProvisionedDb: true,
		dataRegion: 'us',
	}),
	findActiveOrganizationById: vi.fn().mockResolvedValue({
		id: 'clw9x0a12000008l00test03',
		slug: 'test-org',
		customDomain: null,
		hasProvisionedDb: true,
		dataRegion: 'us',
	}),
	resolvePublishedOrganization: vi.fn().mockResolvedValue({
		id: 'clw9x0a12000008l00test03',
		slug: 'test-org',
		customDomain: null,
		hasProvisionedDb: true,
		dataRegion: 'us',
	}),
}))

describe('Auth Trigger Lifecycle Hooks', () => {
	let tempDir: string
	let app: Hono
	const orgId = testOrgId
	const jwtSecret = 'test-jwt-secret-123456789'
	const hmacSecret = 'test-hmac-secret-123456789'

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-auth-test-'))
		process.env.TENANT_DB_DIR = tempDir
		process.env.DATA_REGION = 'us'
		process.env.INTERNAL_COMMAND_TOKEN = 'test-internal-token-123456789'
		process.env.JWT_SECRET = jwtSecret
		process.env.AUTH_HMAC_SECRET = hmacSecret

		await provisionTenantDb(orgId)

		app = new Hono()
		app.route('/auth', authRoutes)
	})

	afterEach(async () => {
		try {
			await destroyTenantDb(orgId)
			fs.rmSync(tempDir, { recursive: true, force: true })
		} catch {}
		delete process.env.TENANT_DB_DIR
		vi.restoreAllMocks()
	})

	it('spawns active phone_verified journeys upon OTP verify', async () => {
		const db = await getTenantDb(orgId)

		// Create active journey
		await db.insert(marketingJourneys).values({
			name: 'SMS on Phone Verified',
			status: 'active',
			triggerType: 'phone_verified',
		})

		// Seed unverified customer with valid OTP
		const code = '123456'
		const hashedCode = hmacHash(code)
		const expiresAt = new Date(Date.now() + 10 * 60 * 1000)

		const customerInsert = await db
			.insert(customers)
			.values({
				name: 'New Registered Customer',
				phone: '+15553334444',
				phoneVerificationCode: hashedCode,
				phoneVerificationExpiresAt: expiresAt,
			})
			.returning()
		const customer = customerInsert[0]!

		// Call /auth/verify
		const res = await app.request('/auth/verify', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				slug: 'test-org',
				phone: '+15553334444',
				code: '123456',
			}),
		})

		expect(res.status).toBe(200)
		const json = await res.json()
		expect(json.success).toBe(true)

		// Wait briefly for fire-and-forget async promises
		await new Promise((resolve) => setTimeout(resolve, 50))

		// Verify runs created in regional DB
		const runs = await db
			.select()
			.from(journeyRuns)
			.where(eq(journeyRuns.customerId, customer.id))
			.all()

		expect(runs.length).toBeGreaterThanOrEqual(1)
		const triggerEvents = runs.map((r) => r.triggerEvent)
		expect(triggerEvents).toContain('phone_verified')
	})

	it('spawns active profile_completed journeys upon customer profile update', async () => {
		const db = await getTenantDb(orgId)

		// Create active profile_completed journey
		await db.insert(marketingJourneys).values({
			name: 'On Profile Completed Flow',
			status: 'active',
			triggerType: 'profile_completed',
		})

		// Seed verified customer
		const customerInsert = await db
			.insert(customers)
			.values({
				name: 'Initial Name',
				phone: '+15556667777',
				phoneVerified: true,
			})
			.returning()
		const customer = customerInsert[0]!

		// Mint access token
		const secret = new TextEncoder().encode(jwtSecret)
		const accessToken = await new SignJWT({
			customerId: customer.id,
			orgId,
			name: 'Initial Name',
			orgSlug: 'test-org',
			type: 'access',
		})
			.setProtectedHeader({ alg: 'HS256' })
			.setAudience('tenant-api')
			.setIssuer('menuza')
			.setExpirationTime('15m')
			.sign(secret)

		// Call /auth/profile
		const res = await app.request('/auth/profile', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${accessToken}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				name: 'Updated Complete Name',
				email: 'updated@example.com',
			}),
		})

		expect(res.status).toBe(200)

		// Wait briefly for fire-and-forget async evaluation
		await new Promise((resolve) => setTimeout(resolve, 50))

		// Verify profile_completed run created
		const runs = await db
			.select()
			.from(journeyRuns)
			.where(eq(journeyRuns.customerId, customer.id))
			.all()

		const triggerEvents = runs.map((r) => r.triggerEvent)
		expect(triggerEvents).toContain('profile_completed')
	})
})
