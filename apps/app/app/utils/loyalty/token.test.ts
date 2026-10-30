import { brand } from '@repo/config/brand'
import {
	LOYALTY_PERMISSIONS as P,
	LOYALTY_TOKEN_AUDIENCE,
	LOYALTY_TOKEN_MAX_TTL_SECONDS,
	LOYALTY_TOKEN_SENSITIVE_TTL_SECONDS,
	LOYALTY_TOKEN_TYP,
	loyaltyTokenClaimsSchema,
	type LoyaltyFeatures,
	type LoyaltyScope,
} from '@repo/loyalty'
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
	mintLoyaltyToken,
	type MintLoyaltyTokenInput,
} from '#app/utils/loyalty/token.server.ts'

const FEATURES: LoyaltyFeatures = {
	enabled: true,
	redemption: true,
}

const NOW = 1_700_000_000

function input(overrides: Partial<MintLoyaltyTokenInput> = {}) {
	return {
		organizationId: 'org_test',
		userId: 'user_test',
		dataRegion: 'us',
		scope: 'read' as LoyaltyScope,
		grants: [P.READ_LOYALTY],
		locationIds: null,
		features: FEATURES,
		impersonated: false,
		nowSeconds: NOW,
		...overrides,
	} satisfies MintLoyaltyTokenInput
}

async function verify(jwt: string) {
	const verified = await jwtVerify(
		jwt,
		new TextEncoder().encode(ENV.TENANT_OPERATOR_TOKEN),
		{
			audience: LOYALTY_TOKEN_AUDIENCE,
			issuer: brand.shortName,
			// Tests inject a fixed nowSeconds, so verify against that clock.
			currentDate: new Date(NOW * 1000),
		},
	)
	return loyaltyTokenClaimsSchema.parse(verified.payload)
}

describe('Loyalty operator token minting', () => {
	it('signs HS256 lty+jwt with TENANT_OPERATOR_TOKEN, brand issuer and tenant-api-loyalty-operator audience', async () => {
		const minted = await mintLoyaltyToken(input())

		expect(decodeProtectedHeader(minted.jwt)).toEqual({
			alg: 'HS256',
			typ: LOYALTY_TOKEN_TYP,
		})

		const claims = await verify(minted.jwt)
		expect(claims.iss).toBe(brand.shortName)
		expect(claims.role).toBe('operator')
		expect(claims.orgId).toBe('org_test')
		expect(claims.sub).toBe('user_test')
		expect(claims.scope).toBe('read')
		expect(claims.grants).toEqual([P.READ_LOYALTY])
		expect(claims.locationIds).toBeNull()
		expect(claims.features).toEqual(FEATURES)
		expect(claims.impersonated).toBe(false)

		// Read-only token: full TTL, expiresAt in epoch milliseconds.
		expect(claims.exp - claims.iat).toBe(LOYALTY_TOKEN_MAX_TTL_SECONDS)
		expect(minted.ttlSeconds).toBe(LOYALTY_TOKEN_MAX_TTL_SECONDS)
		expect(minted.expiresAt).toBe((NOW + LOYALTY_TOKEN_MAX_TTL_SECONDS) * 1000)
		expect(minted.tenantApiUrl).toContain('3007')
	})

	it('intersects held grants with the scope and adds implied reads (members scope)', async () => {
		const minted = await mintLoyaltyToken(
			input({ scope: 'members', grants: [P.UPDATE_LOYALTY_POINTS] }),
		)
		expect(minted.grants).toEqual([P.READ_LOYALTY, P.UPDATE_LOYALTY_POINTS])

		// A grant that moves points shortens the token to 5 minutes.
		const claims = await verify(minted.jwt)
		expect(claims.exp - claims.iat).toBe(LOYALTY_TOKEN_SENSITIVE_TTL_SECONDS)
		expect(minted.expiresAt).toBe(
			(NOW + LOYALTY_TOKEN_SENSITIVE_TTL_SECONDS) * 1000,
		)
	})

	it('keeps only the implied read for a scope the held writes do not cover, and 403s when nothing remains', async () => {
		// setup allows read + program writes; a points adjuster keeps the
		// implied read only (not a 403: the implied read is in scope).
		const setup = await mintLoyaltyToken(
			input({ scope: 'setup', grants: [P.UPDATE_LOYALTY_POINTS] }),
		)
		expect(setup.grants).toEqual([P.READ_LOYALTY])

		// reports allows read:loyalty_report:any only: a plain reader gets 403.
		await expect(
			mintLoyaltyToken(input({ scope: 'reports', grants: [P.READ_LOYALTY] })),
		).rejects.toSatisfy(
			(err: unknown) => err instanceof Response && err.status === 403,
		)
	})

	it('strips update grants from impersonated tokens, caps TTL at 300s, and 403s when no read remains in scope', async () => {
		const minted = await mintLoyaltyToken(
			input({
				scope: 'setup',
				grants: [P.UPDATE_LOYALTY_PROGRAM],
				impersonated: true,
			}),
		)
		// update:loyalty_program:any implies read:loyalty:any; impersonation
		// removes the write, so only the implied read survives.
		expect(minted.grants).toEqual([P.READ_LOYALTY])

		const claims = await verify(minted.jwt)
		expect(claims.impersonated).toBe(true)
		expect(claims.exp - claims.iat).toBe(LOYALTY_TOKEN_SENSITIVE_TTL_SECONDS)

		// Impersonated reports token from a points adjuster: the implied read is
		// not valid for the reports scope, so nothing remains.
		await expect(
			mintLoyaltyToken(
				input({
					scope: 'reports',
					grants: [P.UPDATE_LOYALTY_POINTS],
					impersonated: true,
				}),
			),
		).rejects.toSatisfy(
			(err: unknown) => err instanceof Response && err.status === 403,
		)
	})

	it('maps dataRegion to us/ksa, resolves the regional URL, and passes locationIds through', async () => {
		const ksa = await mintLoyaltyToken(
			input({ dataRegion: 'ksa', locationIds: ['loc_a', 'loc-b'] }),
		)
		expect(ksa.locationIds).toEqual(['loc_a', 'loc-b'])
		expect(ksa.tenantApiUrl).toContain('3009')
		const ksaClaims = await verify(ksa.jwt)
		expect(ksaClaims.region).toBe('ksa')
		expect(ksaClaims.locationIds).toEqual(['loc_a', 'loc-b'])

		for (const region of [null, undefined, 'US', 'eu']) {
			const minted = await mintLoyaltyToken(input({ dataRegion: region }))
			expect(minted.tenantApiUrl).toContain('3007')
			const claims = await verify(minted.jwt)
			expect(claims.region).toBe('us')
		}
	})

	it('throws a 500 Response when the operator secret is missing or too short', async () => {
		await expect(mintLoyaltyToken(input({ secret: '' }))).rejects.toSatisfy(
			(err: unknown) => err instanceof Response && err.status === 500,
		)
		await expect(
			mintLoyaltyToken(input({ secret: 'too-short' })),
		).rejects.toSatisfy(
			(err: unknown) => err instanceof Response && err.status === 500,
		)
	})
})
