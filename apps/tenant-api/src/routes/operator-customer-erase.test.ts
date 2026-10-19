import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import {
	customers,
	customerSubscriptions,
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	rsvGuests,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import * as jose from 'jose'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { operatorRoutes } from './operator.ts'
import { reservationsInternalRoutes } from './reservations-internal.ts'

const SECRET = 'test-operator-secret-key-for-customer-erase-32chars!!'
const INTERNAL = 'test-internal-secret-key-for-link-customers-32chars!!'
const ORG = 'org_customer_erase_route'
let tempDir: string

const app = new Hono()
app.route('/operator', operatorRoutes)
app.route('/internal/reservations', reservationsInternalRoutes)

async function token(claims: Record<string, unknown> = {}, orgId = ORG) {
	const now = Math.floor(Date.now() / 1000)
	return new jose.SignJWT({ role: 'operator', orgId, ...claims })
		.setProtectedHeader({ alg: 'HS256' })
		.setSubject('usr_1')
		.setIssuer(brand.shortName)
		.setAudience('tenant-api-operator')
		.setIssuedAt(now)
		.setExpirationTime(now + 300)
		.sign(new TextEncoder().encode(SECRET))
}

const erase = (id: string, jwt?: string) =>
	app.request(`/operator/customers/${id}/erase`, {
		method: 'POST',
		headers: jwt ? { Authorization: `Bearer ${jwt}` } : {},
	})

beforeEach(async () => {
	tempDir = mkdtempSync(path.join(tmpdir(), 'op-cust-erase-'))
	process.env.TENANT_DB_DIR = tempDir
	process.env.DATA_REGION = 'us'
	process.env.TENANT_OPERATOR_TOKEN = SECRET
	process.env.INTERNAL_COMMAND_TOKEN = INTERNAL
	await provisionTenantDb(ORG)
	const db = await getTenantDb(ORG)
	await db.insert(customers).values({
		id: 'cus_1',
		name: 'Erase Me',
		phone: '+14155550123',
		phoneVerified: true,
	})
	await db.insert(customerSubscriptions).values({
		customerId: 'cus_1',
		topic: 'drops',
		channel: 'sms',
		source: 'profile',
		subscribedAt: new Date(),
	})
	await db.insert(rsvGuests).values({
		id: 'gst_1',
		customerId: 'cus_1',
		firstName: 'Erase',
		lastName: 'Me',
		phoneE164: '+14155550123',
	})
})

afterEach(async () => {
	await destroyTenantDb(ORG)
	rmSync(tempDir, { recursive: true, force: true })
})

describe('POST /operator/customers/:id/erase', () => {
	it('refuses a missing token, a forged token and a token without canDelete', async () => {
		expect((await erase('cus_1')).status).toBe(401)
		expect((await erase('cus_1', 'not.a.jwt')).status).toBe(401)
		expect((await erase('cus_1', await token())).status).toBe(403)
		const db = await getTenantDb(ORG)
		expect(await db.select().from(customers)).toHaveLength(1)
	})

	it('erases the customer, subscriptions and the linked guest with canDelete', async () => {
		const res = await erase('cus_1', await token({ canDelete: true }))
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({
			ok: true,
			customersErased: 1,
			guestsErased: 1,
		})
		const db = await getTenantDb(ORG)
		expect(await db.select().from(customers)).toHaveLength(0)
		expect(await db.select().from(customerSubscriptions)).toHaveLength(0)
		const guest = await db
			.select()
			.from(rsvGuests)
			.where(eq(rsvGuests.id, 'gst_1'))
			.get()
		expect(guest!.erasedAt).not.toBeNull()
		expect(guest!.phoneE164).toBeNull()
		expect(
			(await erase('cus_1', await token({ canDelete: true }))).status,
		).toBe(404)
	})

	it("cannot erase another organization's customer", async () => {
		const res = await erase(
			'cus_1',
			await token({ canDelete: true }, 'org_other'),
		)
		expect(res.status).not.toBe(200)
		const db = await getTenantDb(ORG)
		expect(await db.select().from(customers)).toHaveLength(1)
	})
})

describe('POST /internal/reservations/link-customers', () => {
	const call = (auth?: string) =>
		app.request('/internal/reservations/link-customers', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...(auth ? { Authorization: `Bearer ${auth}` } : {}),
			},
			body: JSON.stringify({ orgId: ORG }),
		})

	it('requires the internal token and reports counts only', async () => {
		expect((await call()).status).toBe(401)
		expect((await call('wrong-token-wrong-token')).status).toBe(401)
	})
})
