import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import {
	customers,
	customerSubscriptions,
	destroyTenantDb,
	getTenantDb,
	personErasureLog,
	provisionTenantDb,
	rsvGuests,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { operatorRoutes } from './operator.ts'
import { reservationsInternalRoutes } from './reservations-internal.ts'

const orgA = 'clw9x0a12000008l00route1'
const orgB = 'clw9x0a12000008l00route2'
const operatorSecret = 'test-operator-secret-123456789'
const internalSecret = 'test-internal-secret-key-for-link-customers-32chars!!'

vi.mock('@repo/email', () => ({
	getOciMarketingMetrics: vi.fn().mockResolvedValue(null),
	isOciEngagementLoggingConfigured: vi.fn().mockReturnValue(false),
}))
vi.mock('@repo/sms', () => ({
	sendSms: vi.fn().mockResolvedValue({ success: true }),
}))
vi.mock('../lib/tenant-email.ts', () => ({
	sendTenantEmail: vi.fn().mockResolvedValue({ status: 'success' }),
}))

async function token(
	orgId: string,
	claims: { canDelete?: boolean; scope?: string } = {},
) {
	return new SignJWT({ orgId, role: 'operator', ...claims })
		.setSubject('user_9')
		.setProtectedHeader({ alg: 'HS256' })
		.setAudience('tenant-api-operator')
		.setIssuer(brand.shortName)
		.setExpirationTime('1h')
		.sign(new TextEncoder().encode(operatorSecret))
}

describe('POST /operator/customers/:id/erase', () => {
	let tempDir: string
	let app: Hono

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-erase-route-'))
		process.env.TENANT_DB_DIR = tempDir
		process.env.DATA_REGION = 'us'
		process.env.JWT_SECRET = operatorSecret
		process.env.TENANT_OPERATOR_TOKEN = operatorSecret
		process.env.INTERNAL_COMMAND_TOKEN = internalSecret
		await provisionTenantDb(orgA)
		await provisionTenantDb(orgB)
		app = new Hono()
		app.route('/operator', operatorRoutes)
		app.route('/internal/reservations', reservationsInternalRoutes)
	})

	afterEach(async () => {
		await destroyTenantDb(orgA).catch(() => {})
		await destroyTenantDb(orgB).catch(() => {})
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	async function seed(orgId: string, phone: string) {
		const db = await getTenantDb(orgId)
		const [customer] = await db
			.insert(customers)
			.values({ name: 'Pat Person', phone, email: 'pat@example.test' })
			.returning()
		await db.insert(customerSubscriptions).values({
			customerId: customer!.id,
			topic: 'marketing',
			channel: 'sms',
			source: 'signup',
			subscribedAt: new Date(),
		})
		return customer!.id
	}

	function erase(customerId: string, bearer?: string) {
		return app.request(`/operator/customers/${customerId}/erase`, {
			method: 'POST',
			headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
		})
	}

	it('rejects a missing token', async () => {
		const id = await seed(orgA, '+15550003001')
		expect((await erase(id)).status).toBe(401)
	})

	it('rejects a token without canDelete and erases nothing', async () => {
		const id = await seed(orgA, '+15550003002')
		const res = await erase(id, await token(orgA))
		expect(res.status).toBe(403)
		const db = await getTenantDb(orgA)
		expect(await db.select().from(customers)).toHaveLength(1)
	})

	it('rejects a token scoped to another module', async () => {
		const id = await seed(orgA, '+15550003003')
		const res = await erase(
			id,
			await token(orgA, { canDelete: true, scope: 'phone_calls' }),
		)
		expect(res.status).toBe(401)
		const db = await getTenantDb(orgA)
		expect(await db.select().from(customers)).toHaveLength(1)
	})

	it('erases the customer with canDelete and records the operator', async () => {
		const id = await seed(orgA, '+15550003004')
		const res = await erase(id, await token(orgA, { canDelete: true }))
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({
			success: true,
			alreadyErased: false,
			customersErased: 1,
		})
		const db = await getTenantDb(orgA)
		expect(await db.select().from(customers)).toEqual([])
		expect(await db.select().from(customerSubscriptions)).toEqual([])
		const log = await db.select().from(personErasureLog)
		expect(log).toMatchObject([{ actorId: 'user_9', subjectId: id }])
	})

	it('erases the reservation guest linked to the customer too', async () => {
		const id = await seed(orgA, '+14155550123')
		const db = await getTenantDb(orgA)
		await db.insert(rsvGuests).values({
			id: 'gst_1',
			customerId: id,
			firstName: 'Pat',
			lastName: 'Person',
			phoneE164: '+14155550123',
		})
		const res = await erase(id, await token(orgA, { canDelete: true }))
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({
			success: true,
			customersErased: 1,
			guestsErased: 1,
		})
		const guest = await db
			.select()
			.from(rsvGuests)
			.where(eq(rsvGuests.id, 'gst_1'))
			.get()
		expect(guest!.erasedAt).not.toBeNull()
		expect(guest!.phoneE164).toBeNull()
	})

	it('cannot erase a customer of another organization', async () => {
		const idA = await seed(orgA, '+15550003005')
		await seed(orgB, '+15550003005')
		// A token for organization B names a customer id that only exists in A.
		const res = await erase(idA, await token(orgB, { canDelete: true }))
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({
			alreadyErased: true,
			customersErased: 0,
		})
		const dbA = await getTenantDb(orgA)
		const dbB = await getTenantDb(orgB)
		expect(await dbA.select().from(customers)).toHaveLength(1)
		expect(await dbB.select().from(customers)).toHaveLength(1)
		expect(await dbA.select().from(personErasureLog)).toEqual([])
	})

	it('is idempotent', async () => {
		const id = await seed(orgA, '+15550003006')
		const bearer = await token(orgA, { canDelete: true })
		await erase(id, bearer)
		const again = await erase(id, bearer)
		expect(again.status).toBe(200)
		expect(await again.json()).toMatchObject({ alreadyErased: true })
		const db = await getTenantDb(orgA)
		expect(await db.select().from(personErasureLog)).toHaveLength(1)
	})
})

describe('POST /internal/reservations/link-customers', () => {
	let tempDir: string
	let app: Hono

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-link-route-'))
		process.env.TENANT_DB_DIR = tempDir
		process.env.DATA_REGION = 'us'
		process.env.INTERNAL_COMMAND_TOKEN = internalSecret
		await provisionTenantDb(orgA)
		app = new Hono()
		app.route('/internal/reservations', reservationsInternalRoutes)
	})

	afterEach(async () => {
		await destroyTenantDb(orgA).catch(() => {})
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	const call = (auth?: string) =>
		app.request('/internal/reservations/link-customers', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...(auth ? { Authorization: `Bearer ${auth}` } : {}),
			},
			body: JSON.stringify({ orgId: orgA }),
		})

	it('requires the internal token', async () => {
		expect((await call()).status).toBe(401)
		expect((await call('wrong-token-wrong-token')).status).toBe(401)
	})
})
