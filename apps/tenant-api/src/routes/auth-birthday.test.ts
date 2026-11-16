import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
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
import { authRoutes } from './auth.ts'

const ORG = 'clw9x0a12000008l00bday02'
const { organization } = vi.hoisted(() => ({
	organization: {
		id: 'clw9x0a12000008l00bday02',
		slug: 'test-org',
		customDomain: null,
		hasProvisionedDb: true,
		dataRegion: 'us',
	},
}))

vi.mock('../lib/origin.ts', () => ({
	resolveOrganizationForBrowserAuth: vi.fn().mockResolvedValue(organization),
	findActiveOrganizationById: vi.fn().mockResolvedValue(organization),
	lookupActiveOrganization: vi
		.fn()
		.mockResolvedValue({ status: 'found', organization }),
	resolvePublishedOrganization: vi.fn().mockResolvedValue(organization),
}))

describe('guest birthday on the profile (#151)', () => {
	let dir: string
	let app: Hono
	let token: string
	let customerId: string

	beforeEach(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-bday-auth-'))
		process.env.TENANT_DB_DIR = dir
		process.env.DATA_REGION = 'us'
		process.env.INTERNAL_COMMAND_TOKEN = 'test-internal-token-123456789'
		process.env.JWT_SECRET = 'test-jwt-secret-123456789'
		process.env.AUTH_HMAC_SECRET = 'test-hmac-secret-123456789'
		syncEnvFromProcess()
		await provisionTenantDb(ORG)
		const db = await getTenantDb(ORG)
		const [row] = await db
			.insert(customers)
			.values({ name: 'Guest One', phone: '+15556667777', phoneVerified: true })
			.returning()
		customerId = row!.id
		token = await new SignJWT({
			customerId,
			orgId: ORG,
			name: 'Guest One',
			orgSlug: 'test-org',
			type: 'access',
		})
			.setProtectedHeader({ alg: 'HS256' })
			.setAudience('tenant-api')
			.setIssuer('menuza')
			.setExpirationTime('15m')
			.sign(new TextEncoder().encode('test-jwt-secret-123456789'))
		app = new Hono()
		app.route('/auth', authRoutes)
	})

	afterEach(async () => {
		await destroyTenantDb(ORG).catch(() => {})
		fs.rmSync(dir, { recursive: true, force: true })
		delete process.env.TENANT_DB_DIR
	})

	const profile = (body: Record<string, unknown>) =>
		app.request('/auth/profile', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ name: 'Guest One', ...body }),
		})

	it('saves month and day, returns it to the guest, and clears it with null', async () => {
		const res = await profile({ birthMonthDay: '02-29' })
		expect(res.status).toBe(200)
		const db = await getTenantDb(ORG)
		const stored = await db.select().from(customers).where(eq(customers.id, customerId)).get()
		expect(stored?.birthMonthDay).toBe('02-29')
		expect(stored?.birthMonthDaySetAt).toBeGreaterThan(0)
		const me = await app.request('/auth/me', { headers: { Authorization: `Bearer ${token}` } })
		expect(((await me.json()) as { customer: { birthMonthDay: string } }).customer.birthMonthDay).toBe('02-29')
		const cleared = await profile({ birthMonthDay: null })
		expect(cleared.status).toBe(200)
		const after = await db.select().from(customers).where(eq(customers.id, customerId)).get()
		expect(after?.birthMonthDay).toBeNull()
	})

	it('refuses an invalid birthday with a code and never echoes the value', async () => {
		for (const bad of ['02-30', '1990-05-05', '13-01', 'my secret date', 42]) {
			const res = await profile({ birthMonthDay: bad })
			expect(res.status).toBe(400)
			const text = await res.text()
			expect(text).toBe(JSON.stringify({ error: 'invalid_birthday' }))
		}
		const db = await getTenantDb(ORG)
		const stored = await db.select().from(customers).where(eq(customers.id, customerId)).get()
		expect(stored?.birthMonthDay).toBeNull()
	})

	it('a profile save without a birthday leaves it alone', async () => {
		await profile({ birthMonthDay: '07-04' })
		await profile({})
		const db = await getTenantDb(ORG)
		const stored = await db.select().from(customers).where(eq(customers.id, customerId)).get()
		expect(stored?.birthMonthDay).toBe('07-04')
	})
})
