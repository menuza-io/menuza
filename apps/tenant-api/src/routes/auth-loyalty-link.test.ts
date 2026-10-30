import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
	customers,
	destroyTenantDb,
	getTenantDb,
	loyaltyMembers,
	provisionTenantDb,
} from '@repo/tenant-db'
import {
	invalidateLoyaltyContext,
	seedLoyaltyContextForTest,
} from '../lib/loyalty-context.ts'
import { hmacHash } from '../lib/secrets.ts'
import { activateProgram } from '../services/loyalty-test-fixture.ts'
import { authRoutes } from './auth.ts'

/**
 * Signing in with a phone code links the customer to the points system on its
 * own (no enroll step, no terms), without ever delaying or failing sign-in.
 */

const orgId = 'clw9x0a12000008l00test09'

vi.mock('@repo/sms', () => ({
	sendSms: vi.fn().mockResolvedValue({ success: true }),
}))
vi.mock('../lib/origin.ts', () => {
	const findActiveOrganizationById = vi.fn()
	return {
		findActiveOrganizationById,
		lookupActiveOrganization: vi.fn(async (id: string) => {
			const organization = await findActiveOrganizationById(id)
			return organization
				? { status: 'found', organization }
				: { status: 'missing' }
		}),
		resolveOrganizationForBrowserAuth: vi.fn(),
		resolvePublishedOrganization: vi.fn(),
	}
})
vi.mock('../services/journey-service.ts', () => ({
	evaluateAndSpawnTriggers: vi.fn().mockResolvedValue(undefined),
}))
const origin = await import('../lib/origin.ts')

const PHONE = '+15551234567'

function verify(app: Hono) {
	return app.request('/auth/verify', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ phone: PHONE, code: '123456' }),
	})
}

describe('sign-in links the customer to the points system', () => {
	let app: Hono
	let tempDir: string
	let customerId: string

	async function accounts() {
		const db = await getTenantDb(orgId)
		return db
			.select()
			.from(loyaltyMembers)
			.where(eq(loyaltyMembers.customerId, customerId))
			.all()
	}

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-auth-lty-'))
		process.env.TENANT_DB_DIR = tempDir
		process.env.DATA_REGION = 'us'
		process.env.JWT_SECRET = 'test-jwt-secret-123456789'
		process.env.AUTH_HMAC_SECRET = 'test-hmac-secret-123456789'
		const organization = {
			id: orgId,
			slug: 'auth-lty',
			customDomain: null,
			hasProvisionedDb: true,
			dataRegion: 'us',
		}
		vi.mocked(origin.findActiveOrganizationById).mockResolvedValue(organization)
		vi.mocked(origin.resolveOrganizationForBrowserAuth).mockResolvedValue(
			organization,
		)
		await provisionTenantDb(orgId)
		const db = await getTenantDb(orgId)
		const [row] = await db
			.insert(customers)
			.values({
				name: 'Otp Person',
				phone: PHONE,
				phoneVerificationCode: hmacHash('123456'),
				phoneVerificationExpiresAt: new Date(Date.now() + 60_000),
			})
			.returning({ id: customers.id })
		customerId = row!.id
		invalidateLoyaltyContext()
		app = new Hono()
		app.route('/auth', authRoutes)
	})

	afterEach(async () => {
		await destroyTenantDb(orgId).catch(() => {})
		fs.rmSync(tempDir, { recursive: true, force: true })
		delete process.env.TENANT_DB_DIR
		vi.restoreAllMocks()
	})

	it('opens the points account behind the verify response when the program is live', async () => {
		await activateProgram(orgId)
		seedLoyaltyContextForTest(orgId, { enabled: true, redemption: true })
		const res = await verify(app)
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({ success: true })
		await vi.waitFor(async () => expect(await accounts()).toHaveLength(1))
		const [account] = await accounts()
		expect(account).toMatchObject({ status: 'active', customerId })
	})

	it('opens nothing while loyalty is off for the organization', async () => {
		await activateProgram(orgId)
		seedLoyaltyContextForTest(orgId, { enabled: false, redemption: false })
		expect((await verify(app)).status).toBe(200)
		// Give the background work a moment to (wrongly) run.
		await new Promise((resolve) => setTimeout(resolve, 150))
		expect(await accounts()).toHaveLength(0)
	})

	it('opens nothing on a node whose kill switch is on', async () => {
		await activateProgram(orgId)
		seedLoyaltyContextForTest(orgId, { enabled: true, redemption: true })
		process.env.LOYALTY_ENABLED = 'false'
		try {
			expect((await verify(app)).status).toBe(200)
			await new Promise((resolve) => setTimeout(resolve, 150))
			expect(await accounts()).toHaveLength(0)
		} finally {
			// Not `delete`: the env snapshot would put the old value back.
			process.env.LOYALTY_ENABLED = 'true'
		}
	})

	it('opens nothing while there is no active program', async () => {
		seedLoyaltyContextForTest(orgId, { enabled: true, redemption: true })
		expect((await verify(app)).status).toBe(200)
		await new Promise((resolve) => setTimeout(resolve, 150))
		expect(await accounts()).toHaveLength(0)
	})

	it('never fails or delays sign-in when opening the account fails', async () => {
		await activateProgram(orgId)
		seedLoyaltyContextForTest(orgId, { enabled: true, redemption: true })
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
		// The write fails for real: the balance table is gone.
		await (await getTenantDb(orgId)).run(sql`drop table loyalty_balances`)
		const res = await verify(app)
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({
			success: true,
			accessToken: expect.any(String),
			refreshToken: expect.any(String),
		})
		await vi.waitFor(() => expect(errors).toHaveBeenCalled(), {
			timeout: 5000,
		})
		expect(errors).toHaveBeenCalledWith(
			'Loyalty account could not be opened at sign-in',
			expect.objectContaining({ orgId, customerId }),
		)
		expect(await accounts()).toHaveLength(0)
	})
})
