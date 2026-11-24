/**
 * #516: the phone app's inventory credentials. The route is real (bearer
 * login, organization membership, database); the feature flags, the member's
 * permissions and the location scope are the boundaries the web token route's
 * test also replaces.
 */
import { db, OrganizationLocation } from '@repo/database'
import {
	INVENTORY_FLAG_KEYS,
	INVENTORY_PERMISSIONS as P,
	INVENTORY_TOKEN_AUDIENCE,
	inventoryTokenClaimsSchema,
} from '@repo/inventory'
import { decodeJwt } from 'jose'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTokenPair } from '#app/utils/jwt.server.ts'
import { setupTestOrgWithUser } from '#tests/test-utils.ts'

const mocks = vi.hoisted(() => ({
	flags: new Map<string, unknown>(),
	permissions: vi.fn(),
	locations: vi.fn(),
}))

vi.mock('@repo/auth', async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>()
	return { ...actual, getUserOrganizationPermissions: mocks.permissions }
})
vi.mock('@repo/common/feature-flags', async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>()
	return {
		...actual,
		getFeatureFlag: vi.fn(async (key: string) => mocks.flags.get(key) ?? false),
	}
})
vi.mock('#app/utils/discounts/location-scope.server.ts', () => ({
	resolveDiscountLocationIds: mocks.locations,
}))

import { loader } from './inventory.token.ts'

function held(...grants: string[]) {
	return grants.map((grant) => {
		const [action, entity, access] = grant.split(':')
		return { action, entity, access, description: '' }
	})
}

async function bearer(user: { id: string; email: string; username: string }) {
	const tokens = await createTokenPair(
		{ id: user.id, email: user.email, username: user.username },
		{ userAgent: 'test', ip: '127.0.0.1' },
	)
	return `Bearer ${tokens.accessToken}`
}

async function run(query: Record<string, string>, auth?: string) {
	const result = (await loader({
		request: new Request(
			`http://localhost:3000/api/inventory/token?${new URLSearchParams(query)}`,
			{ headers: auth ? { Authorization: auth } : {} },
		),
		params: {},
		context: {},
	} as never)) as {
		data?: Record<string, any>
		init?: { status?: number; headers?: Record<string, string> }
	}
	return {
		status: result?.init?.status ?? 200,
		body: result.data as Record<string, any>,
		headers: result.init?.headers,
	}
}

beforeEach(() => {
	mocks.flags.clear()
	mocks.flags.set(INVENTORY_FLAG_KEYS.enabled, true)
	mocks.flags.set(INVENTORY_FLAG_KEYS.purchasing, true)
	mocks.permissions.mockReset()
	mocks.permissions.mockResolvedValue(held(P.READ_INVENTORY))
	mocks.locations.mockReset()
	mocks.locations.mockResolvedValue(null)
})

describe('GET /api/inventory/token (the phone app)', () => {
	it('needs a bearer login', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const { status } = await run({ organizationId: organization.id })
		expect(status).toBe(401)
	})

	it('mints the same short-lived token the web does, and names the region and the locations', async () => {
		const { user, organization } = await setupTestOrgWithUser('admin')
		await db.insert(OrganizationLocation).values([
			{ organizationId: organization.id, name: 'Downtown', slug: 'downtown' },
			{ organizationId: organization.id, name: 'Airport', slug: 'airport' },
		])
		mocks.permissions.mockResolvedValue(
			held(P.UPDATE_INVENTORY, P.UPDATE_INVENTORY_PURCHASING),
		)
		const { status, body, headers } = await run(
			{ organizationId: organization.id, scope: 'write' },
			await bearer(user),
		)
		expect(status).toBe(200)
		expect(headers).toEqual({ 'Cache-Control': 'private, no-store' })
		expect(body.success).toBe(true)
		const data = body.data
		expect(data.scope).toBe('write')
		expect(data.grants).toEqual(
			expect.arrayContaining([P.READ_INVENTORY, P.UPDATE_INVENTORY]),
		)
		expect(data.tenantApiUrl).toContain('3007')
		expect(data.features).toMatchObject({ enabled: true, purchasing: true })
		expect(data.locations.map((l: { name: string }) => l.name).sort()).toEqual([
			'Airport',
			'Downtown',
		])
		const claims = decodeJwt(data.jwt)
		expect(claims.aud).toBe(INVENTORY_TOKEN_AUDIENCE)
		expect(inventoryTokenClaimsSchema.parse(claims)).toMatchObject({
			orgId: organization.id,
			scope: 'write',
		})
		expect(claims.sub).toBe(user.id)
	})

	it('limits the locations to the ones the member may see', async () => {
		const { user, organization } = await setupTestOrgWithUser('admin')
		const rows = await db
			.insert(OrganizationLocation)
			.values([
				{ organizationId: organization.id, name: 'Downtown', slug: 'downtown' },
				{ organizationId: organization.id, name: 'Airport', slug: 'airport' },
			])
			.returning()
		const airport = rows.find((row) => row.slug === 'airport')!
		mocks.locations.mockResolvedValue([airport.id])
		const { body } = await run(
			{ organizationId: organization.id },
			await bearer(user),
		)
		expect(body.data.locations).toEqual([{ id: airport.id, name: 'Airport' }])
		expect(decodeJwt(body.data.jwt).locationIds).toEqual([airport.id])
	})

	it('answers 404 for an organization the member is not in, and while inventory is off', async () => {
		const mine = await setupTestOrgWithUser('admin')
		const theirs = await setupTestOrgWithUser('admin')
		const auth = await bearer(mine.user)
		expect(
			(await run({ organizationId: theirs.organization.id }, auth)).status,
		).toBe(404)
		mocks.flags.set(INVENTORY_FLAG_KEYS.enabled, false)
		expect(
			(await run({ organizationId: mine.organization.id }, auth)).status,
		).toBe(404)
	})

	it('answers 403 without an inventory role, and for a write token without a write grant', async () => {
		const { user, organization } = await setupTestOrgWithUser('admin')
		const auth = await bearer(user)
		mocks.permissions.mockResolvedValue(held('read:discount:any'))
		expect((await run({ organizationId: organization.id }, auth)).status).toBe(
			403,
		)
		mocks.permissions.mockResolvedValue(held(P.READ_INVENTORY))
		expect(
			(await run({ organizationId: organization.id, scope: 'write' }, auth))
				.status,
		).toBe(403)
	})

	it('refuses a malformed request', async () => {
		const { user } = await setupTestOrgWithUser('admin')
		expect(
			(await run({ organizationId: 'x' }, await bearer(user))).status,
		).toBe(400)
	})
})
