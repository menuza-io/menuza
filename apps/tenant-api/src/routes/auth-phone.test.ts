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
import { hmacHash } from '../lib/secrets.ts'

const orgId = 'clw9x0a12000008l00test08'

vi.mock('@repo/sms', () => ({
	sendSms: vi.fn().mockResolvedValue({ success: true }),
}))
vi.mock('../lib/origin.ts', () => ({
	findActiveOrganizationById: vi.fn(),
	resolveOrganizationForBrowserAuth: vi.fn(),
	resolvePublishedOrganization: vi.fn(),
}))
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

	describe('legacy stored forms', () => {
		const legacyForms = [
			scenario.e164.slice(1),
			scenario.region === 'ksa' ? '0501234567' : '5551234567',
		]

		it.each(legacyForms)(
			'finds a customer stored as %s and rewrites it to E.164 on verify',
			async (stored) => {
				const db = await getTenantDb(orgId)
				await db.insert(customers).values({ name: 'Old', phone: stored })
				expect(
					(await post(app, '/auth/send-code', { phone: scenario.national }))
						.status,
				).toBe(200)
				// No duplicate customer was created.
				expect(await db.select().from(customers).all()).toHaveLength(1)
				const code = vi.mocked(sendSms).mock.calls.at(-1)![0].message
				const digits = /(\d{6})/.exec(code)![1]!
				const res = await post(app, '/auth/verify', {
					phone: scenario.e164,
					code: digits,
				})
				expect(res.status).toBe(200)
				const [row] = await db.select().from(customers)
				expect(row?.phone).toBe(scenario.e164)
				expect(row?.name).toBe('Old')
				expect(row?.phoneVerified).toBe(true)
			},
		)

		it('prefers the exact E.164 row and keeps a colliding legacy row as stored', async () => {
			const db = await getTenantDb(orgId)
			await db
				.insert(customers)
				.values({ name: 'Legacy', phone: scenario.e164.slice(1) })
			await db.insert(customers).values({ name: 'Exact', phone: scenario.e164 })
			await post(app, '/auth/send-code', { phone: scenario.e164 })
			const digits = /(\d{6})/.exec(
				vi.mocked(sendSms).mock.calls.at(-1)![0].message,
			)![1]!
			const res = await post(app, '/auth/verify', {
				phone: scenario.e164,
				code: digits,
			})
			expect(res.status).toBe(200)
			const rows = await db.select().from(customers).all()
			expect(rows.map((r) => r.phone).sort()).toEqual(
				[scenario.e164, scenario.e164.slice(1)].sort(),
			)
		})
	})
})
