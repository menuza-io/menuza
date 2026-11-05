import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
	customers,
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
} from '@repo/tenant-db'
import { sendSms } from '@repo/sms'
import { authRoutes } from './auth.ts'
import { hmacHash, syncEnvFromProcess } from '../lib/secrets.ts'

const orgId = 'clw9x0a12000008l00test08'

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

function post(app: Hono, route: string, body: unknown) {
	return app.request(route, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})
}

describe.each([
	{ region: 'ksa', national: '050 123 4567', e164: '+966501234567' },
	{ region: 'us', national: '(555) 123-4567', e164: '+15551234567' },
])('customer auth phone normalization ($region node)', (scenario) => {
	let app: Hono
	let tempDir: string

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-phone-'))
		process.env.TENANT_DB_DIR = tempDir
		process.env.DATA_REGION = scenario.region
		process.env.JWT_SECRET = 'test-jwt-secret-123456789'
		process.env.AUTH_HMAC_SECRET = 'test-hmac-secret-123456789'
		const organization = {
			id: orgId,
			slug: 'phone-test',
			customDomain: null,
			hasProvisionedDb: true,
			dataRegion: scenario.region,
		}
		vi.mocked(origin.findActiveOrganizationById).mockResolvedValue(organization)
		vi.mocked(origin.resolveOrganizationForBrowserAuth).mockResolvedValue(
			organization,
		)
		vi.mocked(sendSms).mockClear()
		await provisionTenantDb(orgId)
		app = new Hono()
		app.route('/auth', authRoutes)
	})

	afterEach(async () => {
		await destroyTenantDb(orgId).catch(() => {})
		fs.rmSync(tempDir, { recursive: true, force: true })
		delete process.env.TENANT_DB_DIR
	})

	it('stores and texts a national-format number as E.164 on send-code', async () => {
		const res = await post(app, '/auth/send-code', { phone: scenario.national })
		expect(res.status).toBe(200)
		const db = await getTenantDb(orgId)
		const rows = await db.select().from(customers).all()
		expect(rows.map((row) => row.phone)).toEqual([scenario.e164])
		expect(sendSms).toHaveBeenCalledWith(
			expect.objectContaining({ to: scenario.e164 }),
		)
	})

	it('verifies with national or E.164 input against the same customer', async () => {
		const db = await getTenantDb(orgId)
		await db.insert(customers).values({
			name: 'Otp',
			phone: scenario.e164,
			phoneVerificationCode: hmacHash('123456'),
			phoneVerificationExpiresAt: new Date(Date.now() + 60_000),
		})
		const res = await post(app, '/auth/verify', {
			phone: scenario.national,
			code: '123456',
		})
		expect(res.status).toBe(200)
		const [row] = await db
			.select()
			.from(customers)
			.where(eq(customers.phone, scenario.e164))
		expect(row?.phoneVerified).toBe(true)
	})

	it('keeps E.164 input unchanged and rejects numbers that are not valid', async () => {
		expect(
			(await post(app, '/auth/send-code', { phone: scenario.e164 })).status,
		).toBe(200)
		expect(
			(await post(app, '/auth/send-code', { phone: '12345' })).status,
		).toBe(400)
		const db = await getTenantDb(orgId)
		expect(await db.select().from(customers).all()).toHaveLength(1)
	})

	it('says a short number is invalid and only an empty one is required', async () => {
		const short = await post(app, '/auth/send-code', { phone: 'abc' })
		expect(short.status).toBe(400)
		expect(await short.json()).toEqual({ error: 'Invalid phone number' })
		const blank = await post(app, '/auth/send-code', { phone: '  ' })
		expect(blank.status).toBe(400)
		expect(await blank.json()).toEqual({ error: 'Phone number is required' })
	})

	// The per-phone send limit, the OTP and the SMS all use the normalized
	// number, so padding a number reaches the same customer (and limit bucket).
	it('treats a whitespace-padded number as the same number', async () => {
		expect(
			(await post(app, '/auth/send-code', { phone: ` ${scenario.e164} ` }))
				.status,
		).toBe(200)
		// A second send for the same number inside the cooldown is one customer.
		expect(
			(await post(app, '/auth/send-code', { phone: scenario.e164 })).status,
		).toBe(429)
		const db = await getTenantDb(orgId)
		const rows = await db.select().from(customers).all()
		expect(rows.map((row) => row.phone)).toEqual([scenario.e164])
		expect(vi.mocked(sendSms).mock.calls.map(([sms]) => sms.to)).toEqual([
			scenario.e164,
		])
	})

	it('never matches a row stored in another form of the digits', async () => {
		const db = await getTenantDb(orgId)
		// Digits only, and the national form: other numbers' rows, not this one's.
		const stranger = scenario.e164.slice(1)
		await db.insert(customers).values({ name: 'Stranger', phone: stranger })

		expect(
			(await post(app, '/auth/send-code', { phone: scenario.e164 })).status,
		).toBe(200)

		const rows = await db.select().from(customers).all()
		expect(rows.map((row) => row.phone).sort()).toEqual(
			[scenario.e164, stranger].sort(),
		)
		const strangerRow = rows.find((row) => row.phone === stranger)
		expect(strangerRow?.phoneVerificationCode ?? null).toBeNull()
	})

	it('never verifies or signs in as a row stored in another form of the digits', async () => {
		const db = await getTenantDb(orgId)
		const stranger = scenario.e164.slice(1)
		const code = '123456'
		await db.insert(customers).values({
			name: 'Stranger',
			phone: stranger,
			phoneVerificationCode: hmacHash(code),
			phoneVerificationExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
		})

		const res = await post(app, '/auth/verify', {
			phone: scenario.e164,
			code,
		})

		expect(res.status).toBe(400)
		const [row] = await db.select().from(customers).all()
		expect(row?.phone).toBe(stranger)
		expect(row?.phoneVerified).toBeFalsy()
	})
})

describe('send-code without Turnstile', () => {
	afterEach(() => {
		vi.unstubAllEnvs()
		syncEnvFromProcess()
	})

	it('does not send SMS when the secret is unset in production', async () => {
		vi.stubEnv('NODE_ENV', 'production')
		vi.stubEnv('TURNSTILE_SECRET_KEY', '')
		syncEnvFromProcess()
		const app = new Hono()
		app.route('/auth', authRoutes)
		vi.mocked(sendSms).mockClear()
		const res = await post(app, '/auth/send-code', { phone: '+15551234567' })
		expect(res.status).toBe(403)
		expect(await res.json()).toMatchObject({ error: 'challenge_required' })
		expect(sendSms).not.toHaveBeenCalled()
	})
})
