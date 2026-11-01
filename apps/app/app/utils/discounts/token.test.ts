import { brand } from '@repo/config/brand'
import {
	DISCOUNT_TOKEN_AUDIENCE,
	DISCOUNT_TOKEN_IMPERSONATED_TTL_SECONDS,
	DISCOUNT_TOKEN_MAX_TTL_SECONDS,
	DISCOUNT_TOKEN_TYP,
	discountTokenClaimsSchema,
} from '@repo/discounts'
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
	mintDiscountToken,
	type MintDiscountTokenInput,
} from '#app/utils/discounts/token.server.ts'

const NOW = 1_700_000_000

function input(overrides: Partial<MintDiscountTokenInput> = {}) {
	return {
		organizationId: 'org_test',
		userId: 'user_test',
		dataRegion: 'us',
		held: ['read:discount:any'],
		locationIds: null,
		impersonated: false,
		nowSeconds: NOW,
		...overrides,
	}
}

describe('mintDiscountToken', () => {
	it('signs a dsc+jwt that the claims schema accepts', async () => {
		const minted = await mintDiscountToken(input())
		expect(decodeProtectedHeader(minted.jwt).typ).toBe(DISCOUNT_TOKEN_TYP)
		const { payload } = await jwtVerify(
			minted.jwt,
			new TextEncoder().encode(ENV.TENANT_OPERATOR_TOKEN),
			{
				audience: DISCOUNT_TOKEN_AUDIENCE,
				issuer: brand.shortName,
				currentDate: new Date((NOW + 1) * 1000),
			},
		)
		expect(discountTokenClaimsSchema.safeParse(payload).success).toBe(true)
		expect(payload).toMatchObject({
			orgId: 'org_test',
			region: 'us',
			scope: 'read',
			grants: ['read:discount:any'],
			locationIds: null,
			impersonated: false,
		})
		expect(minted.ttlSeconds).toBe(DISCOUNT_TOKEN_MAX_TTL_SECONDS)
		expect(minted.expiresAt).toBe((NOW + DISCOUNT_TOKEN_MAX_TTL_SECONDS) * 1000)
	})

	it('update implies read, and KSA orgs get the ksa region', async () => {
		const minted = await mintDiscountToken(
			input({ held: ['update:discount:any'], dataRegion: 'KSA' }),
		)
		expect(minted.grants).toEqual(['read:discount:any'])
		const { payload } = await jwtVerify(
			minted.jwt,
			new TextEncoder().encode(ENV.TENANT_OPERATOR_TOKEN),
			{ currentDate: new Date((NOW + 1) * 1000) },
		)
		expect(payload.region).toBe('ksa')
	})

	it('shortens the token while impersonating', async () => {
		const minted = await mintDiscountToken(input({ impersonated: true }))
		expect(minted.ttlSeconds).toBe(DISCOUNT_TOKEN_IMPERSONATED_TTL_SECONDS)
	})

	it('refuses a member without the grant and a weak secret', async () => {
		await expect(mintDiscountToken(input({ held: [] }))).rejects.toMatchObject({
			status: 403,
		})
		await expect(
			mintDiscountToken(input({ secret: 'short' })),
		).rejects.toMatchObject({ status: 500 })
	})
})
