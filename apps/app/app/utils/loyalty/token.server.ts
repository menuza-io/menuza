import { brand } from '@repo/config/brand'
import {
	LOYALTY_TOKEN_AUDIENCE,
	LOYALTY_TOKEN_TYP,
	loyaltyScopeGrantsFor,
	loyaltyTokenClaimsSchema,
	loyaltyTokenTtlSeconds,
	type LoyaltyFeatures,
	type LoyaltyPermission,
	type LoyaltyScope,
} from '@repo/loyalty'
import { SignJWT } from 'jose'
import { ENV } from 'varlock/env'
import { resolveRegionalTenantApiUrls } from '#app/utils/tenant-api.server.ts'

export type MintLoyaltyTokenInput = {
	organizationId: string
	userId: string
	dataRegion: string | null | undefined
	scope: LoyaltyScope
	grants: readonly LoyaltyPermission[]
	locationIds: readonly string[] | null
	features: LoyaltyFeatures
	impersonated: boolean
	/** Injectable clock for tests (epoch seconds). */
	nowSeconds?: number
	secret?: string
}

export type MintedLoyaltyToken = {
	jwt: string
	tenantApiUrl: string
	scope: LoyaltyScope
	grants: LoyaltyPermission[]
	locationIds: string[] | null
	features: LoyaltyFeatures
	/** Epoch milliseconds when the token stops working. */
	expiresAt: number
	ttlSeconds: number
}

export async function mintLoyaltyToken(
	input: MintLoyaltyTokenInput,
): Promise<MintedLoyaltyToken> {
	const operatorSecret = input.secret ?? ENV.TENANT_OPERATOR_TOKEN
	if (!operatorSecret || operatorSecret.length < 16) {
		throw new Response(
			'TENANT_OPERATOR_TOKEN must be configured with >= 16 chars',
			{ status: 500 },
		)
	}

	const grants = loyaltyScopeGrantsFor(
		input.scope,
		input.grants,
		input.impersonated,
	)
	if (grants.length === 0) {
		throw new Response('Forbidden: no grants for requested scope', {
			status: 403,
		})
	}

	const region = input.dataRegion?.toLowerCase() === 'ksa' ? 'ksa' : 'us'
	const ttlSeconds = loyaltyTokenTtlSeconds(grants, input.impersonated)
	const issuedAt = input.nowSeconds ?? Math.floor(Date.now() / 1000)
	const expSeconds = issuedAt + ttlSeconds

	const claims = {
		aud: LOYALTY_TOKEN_AUDIENCE,
		role: 'operator' as const,
		region: region as 'us' | 'ksa',
		orgId: input.organizationId,
		sub: input.userId,
		scope: input.scope,
		grants,
		locationIds: input.locationIds ? [...input.locationIds] : null,
		features: input.features,
		impersonated: input.impersonated,
		iat: issuedAt,
		exp: expSeconds,
	}
	loyaltyTokenClaimsSchema.parse(claims)

	const {
		aud: ignoredAudience,
		sub: ignoredSubject,
		iat: ignoredIat,
		exp: ignoredExp,
		...payload
	} = claims
	const jwt = await new SignJWT(payload)
		.setProtectedHeader({ alg: 'HS256', typ: LOYALTY_TOKEN_TYP })
		.setAudience(LOYALTY_TOKEN_AUDIENCE)
		.setIssuer(brand.shortName)
		.setSubject(input.userId)
		.setIssuedAt(issuedAt)
		.setExpirationTime(expSeconds)
		.sign(new TextEncoder().encode(operatorSecret))

	const { tenantApiUrl } = resolveRegionalTenantApiUrls(region)
	return {
		jwt,
		tenantApiUrl,
		scope: input.scope,
		grants,
		locationIds: claims.locationIds,
		features: input.features,
		expiresAt: expSeconds * 1000,
		ttlSeconds,
	}
}
