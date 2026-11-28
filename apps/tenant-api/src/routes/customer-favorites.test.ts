import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	customerFavorites,
	customers,
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
} from '@repo/tenant-db'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { syncEnvFromProcess } from '../lib/secrets.ts'
import { erasePerson } from '../services/person-erasure-service.ts'
import { customerFavoriteRoutes } from './customer-favorites.ts'

const orgId = 'clw9x0a12000008l00favs01'
const jwtSecret = 'test-jwt-secret-123456789'

vi.mock('../lib/origin.ts', () => {
	const organization = {
		id: 'clw9x0a12000008l00favs01',
		slug: 'favs-test',
		customDomain: null,
		hasProvisionedDb: true,
		dataRegion: 'us',
	}
	return {
		findActiveOrganizationById: vi.fn().mockResolvedValue(organization),
		lookupActiveOrganization: vi
			.fn()
			.mockResolvedValue({ status: 'found', organization }),
	}
})

let app: Hono
let tempDir: string
let aliceId: string
let bobId: string
let alice: string
let bob: string

async function token(customerId: string) {
	return new SignJWT({
		customerId,
		orgId,
		orgSlug: 'favs-test',
		type: 'access',
	})
		.setProtectedHeader({ alg: 'HS256' })
		.setAudience('tenant-api')
		.setIssuer('menuza')
		.setExpirationTime('15m')
		.sign(new TextEncoder().encode(jwtSecret))
}

function call(method: string, url: string, bearer: string | null = alice) {
	return app.request(url, {
		method,
		headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
	})
}

async function list(bearer: string | null = alice) {
	return (await (await call('GET', '/customer/favorites', bearer)).json()) as {
		favorites: Array<{ itemId: string; createdAt: number }>
		limit: number
	}
}

beforeEach(async () => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-favorites-'))
	vi.stubEnv('TENANT_DB_DIR', tempDir)
	vi.stubEnv('DATA_REGION', 'us')
	vi.stubEnv('JWT_SECRET', jwtSecret)
	syncEnvFromProcess()
	await provisionTenantDb(orgId)
	const db = await getTenantDb(orgId)
	const [a] = await db
		.insert(customers)
		.values({
			name: 'Alice Example',
			phone: '+15555550401',
			phoneVerified: true,
		})
		.returning()
	const [b] = await db
		.insert(customers)
		.values({ name: 'Bob Example', phone: '+15555550402', phoneVerified: true })
		.returning()
	aliceId = a!.id
	bobId = b!.id
	alice = await token(aliceId)
	bob = await token(bobId)
	app = new Hono()
	app.route('/customer/favorites', customerFavoriteRoutes)
})

afterEach(async () => {
	await destroyTenantDb(orgId)
	fs.rmSync(tempDir, { recursive: true, force: true })
	vi.unstubAllEnvs()
})

describe('favorite dishes (#158)', () => {
	it('needs a customer token', async () => {
		expect((await call('GET', '/customer/favorites', null)).status).toBe(401)
		expect((await call('PUT', '/customer/favorites/item_1', null)).status).toBe(
			401,
		)
		expect(
			(await call('DELETE', '/customer/favorites/item_1', 'junk')).status,
		).toBe(401)
	})

	it('shows a favorite on the next visit, newest first, and keeps it per guest', async () => {
		expect((await call('PUT', '/customer/favorites/item_a')).status).toBe(201)
		await new Promise((resolve) => setTimeout(resolve, 5))
		expect((await call('PUT', '/customer/favorites/item_b')).status).toBe(201)
		const body = await list()
		expect(body.favorites.map((f) => f.itemId)).toEqual(['item_b', 'item_a'])
		expect(body.limit).toBe(100)
		expect((await list(bob)).favorites).toEqual([])
	})

	it('is idempotent: a second PUT uses no slot, DELETE of a missing dish is fine', async () => {
		expect((await call('PUT', '/customer/favorites/item_a')).status).toBe(201)
		expect((await call('PUT', '/customer/favorites/item_a')).status).toBe(200)
		expect((await list()).favorites).toHaveLength(1)
		expect((await call('DELETE', '/customer/favorites/item_a')).status).toBe(
			200,
		)
		expect((await call('DELETE', '/customer/favorites/item_a')).status).toBe(
			200,
		)
		expect((await list()).favorites).toEqual([])
	})

	it('allows up to 100 per customer and refuses the 101st, per guest', async () => {
		const db = await getTenantDb(orgId)
		await db.insert(customerFavorites).values(
			Array.from({ length: 100 }, (_, i) => ({
				customerId: aliceId,
				itemId: `item_${i}`,
			})),
		)
		const over = await call('PUT', '/customer/favorites/item_over')
		expect(over.status).toBe(409)
		expect(((await over.json()) as { error: string }).error).toBe(
			'favorites_limit_reached',
		)
		// An existing favorite is still fine at the limit; removing one frees a slot.
		expect((await call('PUT', '/customer/favorites/item_5')).status).toBe(200)
		expect((await call('DELETE', '/customer/favorites/item_5')).status).toBe(
			200,
		)
		expect((await call('PUT', '/customer/favorites/item_over')).status).toBe(
			201,
		)
		// Bob has his own 100.
		expect(
			(await call('PUT', '/customer/favorites/item_over', bob)).status,
		).toBe(201)
	})

	it('rejects a malformed dish id', async () => {
		expect(
			(await call('PUT', `/customer/favorites/${'x'.repeat(101)}`)).status,
		).toBe(400)
	})

	it('is removed by person erasure, only for that person', async () => {
		await call('PUT', '/customer/favorites/item_a')
		await call('PUT', '/customer/favorites/item_b', bob)
		const db = await getTenantDb(orgId)
		await erasePerson(db, { customerId: aliceId }, { actorId: 'user_1' })
		const rows = await db.select().from(customerFavorites)
		expect(rows.map((row) => row.customerId)).toEqual([bobId])
	})
})
