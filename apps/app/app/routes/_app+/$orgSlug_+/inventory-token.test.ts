import {
	INVENTORY_FLAG_KEYS,
	INVENTORY_PERMISSIONS as P,
	INVENTORY_TOKEN_AUDIENCE,
	INVENTORY_TOKEN_IMPERSONATED_TTL_SECONDS,
	inventoryTokenClaimsSchema,
} from '@repo/inventory'
import { decodeJwt } from 'jose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
	process.env.SESSION_SECRET = 'test-session-secret'
	process.env.JWT_SECRET = 'test-jwt-secret-key'
	const workerId =
		process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? '0'
	process.env.DATABASE_URL = `file:./tests/database/data.${workerId}.db`
	process.env.AWS_ENDPOINT_URL_S3 = 'http://localhost:9000'
	process.env.AWS_REGION = 'us-east-1'
	process.env.AWS_ACCESS_KEY_ID = 'test'
	process.env.AWS_SECRET_ACCESS_KEY = 'test'
	process.env.BUCKET_NAME = 'test'
})

const mocks = vi.hoisted(() => ({
	organization: vi.fn(),
	flags: new Map<string, unknown>(),
	userId: vi.fn(),
	permissions: vi.fn(),
	impersonating: vi.fn(),
	locations: vi.fn(),
}))

vi.mock('@repo/auth', () => ({
	getUserId: mocks.userId,
	getUserOrganizationPermissions: mocks.permissions,
	isImpersonating: mocks.impersonating,
}))
vi.mock('@repo/common/feature-flags', () => ({
	getFeatureFlag: vi.fn(async (key: string) => mocks.flags.get(key) ?? false),
}))
vi.mock('#app/utils/organization/loader.server.ts', () => ({
	requireUserOrganization: mocks.organization,
}))
vi.mock('#app/utils/discounts/location-scope.server.ts', () => ({
	resolveDiscountLocationIds: mocks.locations,
}))

import { loader } from './inventory-token.ts'

function held(...grants: string[]) {
	return grants.map((grant) => {
		const [action, entity, access] = grant.split(':')
		return { action, entity, access, description: '' }
	})
}

async function run(query = '') {
	return loader({
		request: new Request(`https://app.example/cafe/inventory-token${query}`),
		params: { orgSlug: 'cafe' },
		context: {} as never,
	} as unknown as Parameters<typeof loader>[0])
}

async function status(promise: Promise<unknown>): Promise<number> {
	try {
		await promise
	} catch (error) {
		if (error instanceof Response) return error.status
		if (
			error &&
			typeof error === 'object' &&
			'init' in error &&
			(error as { init?: { status?: number } }).init?.status
		) {
			return (error as { init: { status: number } }).init.status
		}
		throw error
	}
	return 200
}

describe('GET /:orgSlug/inventory-token', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.flags.clear()
		mocks.flags.set(INVENTORY_FLAG_KEYS.enabled, true)
		mocks.organization.mockResolvedValue({
			id: 'org_cafe',
			slug: 'cafe',
			name: 'Cafe',
			dataRegion: 'us',
		})
		mocks.userId.mockResolvedValue('user_1')
		mocks.permissions.mockResolvedValue(held(P.READ_INVENTORY))
		mocks.impersonating.mockResolvedValue(false)
		mocks.locations.mockResolvedValue(null)
	})

	it('answers 404 while inventory.enabled is off, before reading grants', async () => {
		mocks.flags.set(INVENTORY_FLAG_KEYS.enabled, false)
		mocks.flags.set(INVENTORY_FLAG_KEYS.purchasing, true)
		expect(await status(run())).toBe(404)
		expect(mocks.permissions).not.toHaveBeenCalled()
	})

	it('only a literal true turns the flag on', async () => {
		mocks.flags.set(INVENTORY_FLAG_KEYS.enabled, 'true')
		expect(await status(run())).toBe(404)
	})

	it('answers 403 without an inventory grant', async () => {
		mocks.permissions.mockResolvedValue(held('read:discount:any'))
		expect(await status(run())).toBe(403)
	})

	it('mints a read token with flags, scope and location scope', async () => {
		mocks.flags.set(INVENTORY_FLAG_KEYS.recipes, true)
		mocks.permissions.mockResolvedValue(
			held(P.UPDATE_INVENTORY, P.READ_INVENTORY_COST),
		)
		mocks.locations.mockResolvedValue(['loc_a'])
		const result = await run('?scope=read')
		const body = result.data
		expect(result.init?.headers).toEqual({
			'Cache-Control': 'private, no-store',
		})
		expect(body.scope).toBe('read')
		expect(body.grants).toEqual([P.READ_INVENTORY, P.READ_INVENTORY_COST])
		expect(body.locationIds).toEqual(['loc_a'])
		expect(body.tenantApiUrl).toContain('3007')
		expect(body.features).toEqual({
			enabled: true,
			purchasing: false,
			recipes: true,
			prep: false,
			transfers: false,
		})
		const claims = inventoryTokenClaimsSchema.parse(decodeJwt(body.jwt))
		expect(claims.aud).toBe(INVENTORY_TOKEN_AUDIENCE)
		expect(claims.orgId).toBe('org_cafe')
		expect(claims.locationIds).toEqual(['loc_a'])
	})

	it('a write token needs an update grant', async () => {
		expect(await status(run('?scope=write'))).toBe(403)

		mocks.permissions.mockResolvedValue(held(P.UPDATE_INVENTORY))
		const result = await run('?scope=write')
		expect(result.data.grants).toEqual([P.READ_INVENTORY, P.UPDATE_INVENTORY])
	})

	it('support impersonation gets read grants only on a short token', async () => {
		mocks.impersonating.mockResolvedValue(true)
		mocks.permissions.mockResolvedValue(held(P.UPDATE_INVENTORY))
		const result = await run('?scope=write')
		expect(result.data.grants).toEqual([P.READ_INVENTORY])
		const claims = inventoryTokenClaimsSchema.parse(decodeJwt(result.data.jwt))
		expect(claims.impersonated).toBe(true)
		expect(claims.exp - claims.iat).toBe(
			INVENTORY_TOKEN_IMPERSONATED_TTL_SECONDS,
		)
	})

	it('answers 403 for a member scoped to no location', async () => {
		mocks.locations.mockResolvedValue([])
		expect(await status(run())).toBe(403)
	})

	it('answers 400 for an unknown scope', async () => {
		expect(await status(run('?scope=admin'))).toBe(400)
	})
})
