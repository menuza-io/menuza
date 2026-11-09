import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import {
	INVENTORY_PERMISSIONS,
	INVENTORY_TOKEN_AUDIENCE,
	INVENTORY_TOKEN_TYP,
	inventorySettingsSchema,
	inventoryStatusSchema,
} from '@repo/inventory'
import {
	destroyTenantDb,
	getTenantDb,
	invAuditLog,
	invCounts,
	invDeliveries,
	invItems,
	invStorageAreas,
	provisionTenantDb,
} from '@repo/tenant-db'
import { asc } from 'drizzle-orm'
import { Hono } from 'hono'
import * as jose from 'jose'
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest'
import { type PublishedOrganization } from '../lib/origin.ts'
import { syncEnvFromProcess } from '../lib/secrets.ts'
import { operatorInventoryRoutes } from './operator-inventory.ts'

/**
 * Behaviour of the phase 0 operator inventory routes: settings (defaults per
 * region, saving, stale versions, the audit row, idempotent retries) and the
 * setup status counts. Security is swept in `inventory-security.test.ts`.
 */

const OPERATOR_SECRET = 'inv-beh-operator-token-0123456789abcdef'
const ORG_US = 'org_inv_beh_us'
const ORG_KSA = 'org_inv_beh_ksa'

const orgs = vi.hoisted(() => new Map<string, PublishedOrganization>())

vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	lookupActiveOrganization: vi.fn(async (id: string) => {
		const organization = orgs.get(id)
		return organization
			? { status: 'found' as const, organization }
			: { status: 'missing' as const }
	}),
}))

const app = new Hono()
app.route('/operator/inventory', operatorInventoryRoutes)

function setNodeRegion(region: 'us' | 'ksa') {
	process.env.DATA_REGION = region
	syncEnvFromProcess()
}

async function token(
	orgId: string,
	options: { region?: 'us' | 'ksa'; subject?: string } = {},
) {
	const now = Math.floor(Date.now() / 1000)
	return new jose.SignJWT({
		role: 'operator',
		orgId,
		region: options.region ?? 'us',
		scope: 'write',
		grants: [
			INVENTORY_PERMISSIONS.READ_INVENTORY,
			INVENTORY_PERMISSIONS.UPDATE_INVENTORY,
		],
		locationIds: null,
		features: {
			enabled: true,
			purchasing: false,
			recipes: false,
			prep: false,
			transfers: false,
		},
		impersonated: false,
	})
		.setProtectedHeader({ alg: 'HS256', typ: INVENTORY_TOKEN_TYP })
		.setSubject(options.subject ?? 'user_owner')
		.setIssuer(brand.shortName)
		.setAudience(INVENTORY_TOKEN_AUDIENCE)
		.setIssuedAt(now)
		.setExpirationTime(now + 600)
		.sign(new TextEncoder().encode(OPERATOR_SECRET))
}

async function request(
	method: string,
	requestPath: string,
	options: { token: string; body?: unknown; idempotencyKey?: string },
) {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${options.token}`,
	}
	if (options.idempotencyKey)
		headers['Idempotency-Key'] = options.idempotencyKey
	let body: string | undefined
	if (options.body !== undefined) {
		headers['Content-Type'] = 'application/json'
		body = JSON.stringify(options.body)
	}
	const res = await app.request(requestPath, { method, headers, body })
	return {
		status: res.status,
		body: (await res.json()) as Record<string, unknown>,
	}
}

let tmpDir: string

beforeAll(async () => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-beh-test-'))
	process.env.TENANT_DB_DIR = tmpDir
	process.env.TENANT_OPERATOR_TOKEN = OPERATOR_SECRET
	setNodeRegion('us')
	for (const [id, dataRegion] of [
		[ORG_US, 'us'],
		[ORG_KSA, 'ksa'],
	] as const) {
		orgs.set(id, {
			id,
			slug: id,
			customDomain: null,
			hasProvisionedDb: true,
			dataRegion,
			name: id,
		})
		await provisionTenantDb(id)
	}
})

beforeEach(() => setNodeRegion('us'))

afterAll(async () => {
	setNodeRegion('us')
	await destroyTenantDb(ORG_US)
	await destroyTenantDb(ORG_KSA)
	fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('GET and PUT /operator/inventory/settings', () => {
	it('answers the defaults before the first save: 30%, the region’s units, no count day, version 0', async () => {
		const us = await request('GET', '/operator/inventory/settings', {
			token: await token(ORG_US),
		})
		expect(us.status).toBe(200)
		expect(inventorySettingsSchema.parse(us.body)).toEqual({
			targetFoodCostBp: 3000,
			unitSystem: 'us',
			countDayOfWeek: null,
			anyStaffCanReceive: false,
			version: 0,
			updatedAt: null,
		})

		setNodeRegion('ksa')
		const ksa = await request('GET', '/operator/inventory/settings', {
			token: await token(ORG_KSA, { region: 'ksa' }),
		})
		expect(ksa.status).toBe(200)
		expect(ksa.body).toMatchObject({ unitSystem: 'metric', version: 0 })
	})

	it('saves a change, bumps the version, keeps what was not sent, and writes one audit row', async () => {
		const auth = await token(ORG_US)
		const first = await request('PUT', '/operator/inventory/settings', {
			token: auth,
			body: { expectedVersion: 0, targetFoodCostBp: 2800, countDayOfWeek: 6 },
		})
		expect(first.status).toBe(200)
		const saved = inventorySettingsSchema.parse(first.body)
		expect(saved).toMatchObject({
			targetFoodCostBp: 2800,
			unitSystem: 'us',
			countDayOfWeek: 6,
			version: 1,
		})
		expect(saved.updatedAt).toEqual(expect.any(Number))

		const second = await request('PUT', '/operator/inventory/settings', {
			token: auth,
			body: { expectedVersion: 1, unitSystem: 'metric', countDayOfWeek: null },
		})
		expect(second.status).toBe(200)
		expect(second.body).toMatchObject({
			targetFoodCostBp: 2800,
			unitSystem: 'metric',
			countDayOfWeek: null,
			version: 2,
		})

		const read = await request('GET', '/operator/inventory/settings', {
			token: auth,
		})
		expect(read.body).toEqual(second.body)

		const db = await getTenantDb(ORG_US)
		const audit = await db
			.select()
			.from(invAuditLog)
			.orderBy(asc(invAuditLog.createdAt), asc(invAuditLog.id))
		expect(audit).toHaveLength(2)
		expect(audit.map((row) => row.detail)).toEqual(
			expect.arrayContaining([
				{ version: 1, targetFoodCostBp: 2800, countDayOfWeek: 6 },
				{ version: 2, unitSystem: 'metric', countDayOfWeek: null },
			]),
		)
		for (const row of audit) {
			expect(row).toMatchObject({
				actorKind: 'operator',
				actorId: 'user_owner',
				action: 'settings.update',
				resourceType: 'settings',
				resourceId: 'default',
			})
		}
	})

	it('refuses a stale version with 409 stale_version and the current version, changing nothing', async () => {
		const auth = await token(ORG_US)
		const before = await request('GET', '/operator/inventory/settings', {
			token: auth,
		})
		const stale = await request('PUT', '/operator/inventory/settings', {
			token: auth,
			body: { expectedVersion: 0, targetFoodCostBp: 9000 },
		})
		expect(stale.status).toBe(409)
		expect(stale.body).toMatchObject({
			code: 'stale_version',
			currentVersion: before.body.version,
		})
		const after = await request('GET', '/operator/inventory/settings', {
			token: auth,
		})
		expect(after.body).toEqual(before.body)
	})

	it('replays a retried save with the same Idempotency-Key, and refuses the key with another body', async () => {
		const auth = await token(ORG_KSA, { region: 'ksa' })
		setNodeRegion('ksa')
		const body = { expectedVersion: 0, targetFoodCostBp: 3200 }
		const first = await request('PUT', '/operator/inventory/settings', {
			token: auth,
			body,
			idempotencyKey: 'settings-retry-0001',
		})
		expect(first.status).toBe(200)
		const retry = await request('PUT', '/operator/inventory/settings', {
			token: auth,
			body,
			idempotencyKey: 'settings-retry-0001',
		})
		expect(retry.status).toBe(200)
		expect(retry.body).toEqual(first.body)
		expect(retry.body.version).toBe(1)

		const conflict = await request('PUT', '/operator/inventory/settings', {
			token: auth,
			body: { expectedVersion: 0, targetFoodCostBp: 1 },
			idempotencyKey: 'settings-retry-0001',
		})
		expect(conflict.status).toBe(409)
		expect(conflict.body).toMatchObject({ code: 'idempotency_conflict' })

		const malformed = await request('PUT', '/operator/inventory/settings', {
			token: auth,
			body,
			idempotencyKey: 'bad key',
		})
		expect(malformed.status).toBe(400)
	})

	it('refuses empty, unknown and out-of-range changes (400) without echoing them', async () => {
		const auth = await token(ORG_US)
		for (const body of [
			{ expectedVersion: 2 },
			{ expectedVersion: 2, targetFoodCostBp: 10_001 },
			{ expectedVersion: 2, countDayOfWeek: 7 },
			{ expectedVersion: 2, unitSystem: 'imperial' },
			{ expectedVersion: 2, targetFoodCostBp: 2500, secretField: 'x' },
			{ targetFoodCostBp: 2500 },
		]) {
			const res = await request('PUT', '/operator/inventory/settings', {
				token: auth,
				body,
			})
			expect(res.status, JSON.stringify(body)).toBe(400)
			expect(JSON.stringify(res.body)).not.toContain('imperial')
			expect(JSON.stringify(res.body)).not.toContain('secretField')
		}
	})
})

describe('GET /operator/inventory/status', () => {
	it('counts active items, the location’s active storage areas, approved counts and received deliveries', async () => {
		const db = await getTenantDb(ORG_US)
		await db.insert(invItems).values([
			{ id: 'i1', name: 'Chicken', baseUnit: 'g' },
			{ id: 'i2', name: 'Milk', baseUnit: 'ml' },
			{ id: 'i3', name: 'Old', baseUnit: 'piece', archivedAt: 1 },
		])
		await db.insert(invStorageAreas).values([
			{ id: 'a1', locationId: 'loc_a', name: 'Walk-in' },
			{ id: 'a2', locationId: 'loc_a', name: 'Freezer' },
			{ id: 'a3', locationId: 'loc_a', name: 'Gone', archivedAt: 1 },
			{ id: 'a4', locationId: 'loc_b', name: 'Walk-in' },
		])
		const count = (
			id: string,
			locationId: string,
			status: 'counting' | 'approved' | 'cancelled',
		) => ({
			id,
			locationId,
			status,
			businessDate: '2026-11-01',
			startedByKind: 'operator' as const,
			approvedAt: status === 'approved' ? 1 : null,
		})
		await db
			.insert(invCounts)
			.values([
				count('c1', 'loc_a', 'approved'),
				count('c2', 'loc_a', 'approved'),
				count('c3', 'loc_a', 'counting'),
				count('c4', 'loc_a', 'cancelled'),
				count('c5', 'loc_b', 'approved'),
			])
		const delivery = (
			id: string,
			locationId: string,
			status: 'received' | 'draft' | 'cancelled',
		) => ({
			id,
			locationId,
			status,
			currency: 'USD',
			receivedByKind: 'operator' as const,
			businessDate: '2026-11-01',
		})
		await db
			.insert(invDeliveries)
			.values([
				delivery('d1', 'loc_a', 'received'),
				delivery('d2', 'loc_a', 'draft'),
				delivery('d3', 'loc_a', 'cancelled'),
				delivery('d4', 'loc_b', 'received'),
			])

		const auth = await token(ORG_US)
		const a = await request(
			'GET',
			'/operator/inventory/status?locationId=loc_a',
			{
				token: auth,
			},
		)
		expect(a.status).toBe(200)
		expect(inventoryStatusSchema.parse(a.body)).toEqual({
			locationId: 'loc_a',
			items: 2,
			storageAreas: 2,
			approvedCounts: 2,
			deliveries: 1,
		})
		const empty = await request(
			'GET',
			'/operator/inventory/status?locationId=main',
			{ token: auth },
		)
		expect(empty.body).toEqual({
			locationId: 'main',
			items: 2,
			storageAreas: 0,
			approvedCounts: 0,
			deliveries: 0,
		})
	})
})
