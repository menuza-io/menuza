import { brand } from '@repo/config/brand'
import {
	foldInventoryFeatures,
	INVENTORY_PERMISSIONS as P,
	INVENTORY_TOKEN_AUDIENCE,
	INVENTORY_TOKEN_IMPERSONATED_TTL_SECONDS,
	INVENTORY_TOKEN_MAX_TTL_SECONDS,
	INVENTORY_TOKEN_TYP,
	inventoryTokenClaimsSchema,
} from '@repo/inventory'
import { decodeProtectedHeader, jwtVerify } from 'jose'
import { ENV } from 'varlock/env'
import { describe, expect, it, vi } from 'vitest'

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

import {
	mintInventoryToken,
	type MintInventoryTokenInput,
} from '#app/utils/inventory/token.server.ts'

const FEATURES = foldInventoryFeatures({ enabled: true, purchasing: true })
const NOW = 1_700_000_000

function input(
	overrides: Partial<MintInventoryTokenInput> = {},
): MintInventoryTokenInput {
	return {
		organizationId: 'org_test',
		userId: 'user_test',
		dataRegion: 'us',
		scope: 'read',
		grants: [P.READ_INVENTORY],
		locationIds: null,
		features: FEATURES,
		impersonated: false,
		nowSeconds: NOW,
		...overrides,
	}
}

async function verify(jwt: string) {
	const verified = await jwtVerify(
		jwt,
		new TextEncoder().encode(ENV.TENANT_OPERATOR_TOKEN),
		{
			audience: INVENTORY_TOKEN_AUDIENCE,
			issuer: brand.shortName,
			currentDate: new Date(NOW * 1000),
		},
	)
	return inventoryTokenClaimsSchema.parse(verified.payload)
}

describe('Inventory operator token minting', () => {
	it('signs HS256 inv+jwt with TENANT_OPERATOR_TOKEN, the brand issuer and the inventory audience', async () => {
		const minted = await mintInventoryToken(input())

		expect(decodeProtectedHeader(minted.jwt)).toEqual({
			alg: 'HS256',
			typ: INVENTORY_TOKEN_TYP,
		})
		const claims = await verify(minted.jwt)
		expect(claims).toMatchObject({
			iss: brand.shortName,
			role: 'operator',
			region: 'us',
			orgId: 'org_test',
			sub: 'user_test',
			scope: 'read',
			grants: [P.READ_INVENTORY],
			locationIds: null,
			features: FEATURES,
			impersonated: false,
		})
		expect(claims.exp - claims.iat).toBe(INVENTORY_TOKEN_MAX_TTL_SECONDS)
		expect(minted.expiresAt).toBe(
			(NOW + INVENTORY_TOKEN_MAX_TTL_SECONDS) * 1000,
		)
		expect(minted.tenantApiUrl).toContain('3007')
	})

	it('limits grants to the scope: a read token never carries a write grant', async () => {
		const held = [
			P.READ_INVENTORY,
			P.UPDATE_INVENTORY,
			P.READ_INVENTORY_COST,
			P.UPDATE_INVENTORY_PURCHASING,
		]
		const read = await mintInventoryToken(input({ grants: held }))
		expect(read.grants).toEqual([P.READ_INVENTORY, P.READ_INVENTORY_COST])

		const write = await mintInventoryToken(
			input({ scope: 'write', grants: held }),
		)
		expect(write.grants).toEqual(held)
		expect((await verify(write.jwt)).grants).toEqual(held)
	})

	it('adds the read each grant implies', async () => {
		const minted = await mintInventoryToken(
			input({ scope: 'write', grants: [P.UPDATE_INVENTORY_RECIPE] }),
		)
		expect(minted.grants).toEqual([P.READ_INVENTORY, P.UPDATE_INVENTORY_RECIPE])
	})

	it('gives support impersonation read grants only and a 5 minute token', async () => {
		const minted = await mintInventoryToken(
			input({
				scope: 'write',
				grants: [P.UPDATE_INVENTORY, P.READ_INVENTORY_COST],
				impersonated: true,
			}),
		)
		expect(minted.grants).toEqual([P.READ_INVENTORY, P.READ_INVENTORY_COST])
		const claims = await verify(minted.jwt)
		expect(claims.impersonated).toBe(true)
		expect(claims.exp - claims.iat).toBe(
			INVENTORY_TOKEN_IMPERSONATED_TTL_SECONDS,
		)
	})

	it('answers 403 when the member holds no inventory grant', async () => {
		await expect(
			mintInventoryToken(input({ grants: ['read:discount:any'] })),
		).rejects.toSatisfy(
			(err: unknown) => err instanceof Response && err.status === 403,
		)
	})

	it('carries the location scope and the KSA region', async () => {
		const ksa = await mintInventoryToken(
			input({ dataRegion: 'KSA', locationIds: ['loc_a', 'loc-b'] }),
		)
		expect(ksa.tenantApiUrl).toContain('3009')
		const claims = await verify(ksa.jwt)
		expect(claims.region).toBe('ksa')
		expect(claims.locationIds).toEqual(['loc_a', 'loc-b'])
	})

	it('throws a 500 Response when the operator secret is missing or too short', async () => {
		await expect(mintInventoryToken(input({ secret: '' }))).rejects.toSatisfy(
			(err: unknown) => err instanceof Response && err.status === 500,
		)
		await expect(
			mintInventoryToken(input({ secret: 'too-short' })),
		).rejects.toSatisfy(
			(err: unknown) => err instanceof Response && err.status === 500,
		)
	})
})
