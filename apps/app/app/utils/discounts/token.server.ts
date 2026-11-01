import { brand } from '@repo/config/brand'
import {
	DISCOUNT_TOKEN_AUDIENCE,
	DISCOUNT_TOKEN_TYP,
	discountScopeGrantsFor,
	discountTokenClaimsSchema,
	discountTokenTtlSeconds,
	type DiscountPermission,
	type DiscountScope,
} from '@repo/discounts'
import { SignJWT } from 'jose'
import { ENV } from 'varlock/env'
import { resolveRegionalTenantApiUrls } from '#app/utils/tenant-api.server.ts'

export type MintDiscountTokenInput = {
	organizationId: string
	userId: string
	dataRegion: string | null | undefined
	scope?: DiscountScope
	/** The member's `<action>:<entity>:<access>` grants. */
	held: readonly string[]
	/** `null` = every location; `[]` = none (see `resolveDiscountLocationIds`). */
	locationIds: string[] | null
	impersonated: boolean
	/** Injectable clock for tests (epoch seconds). */
	nowSeconds?: number
	secret?: string
}

export type MintedDiscountToken = {
	jwt: string
	tenantApiUrl: string
	scope: DiscountScope
	grants: DiscountPermission[]
	/** Epoch milliseconds when the token stops working. */
	expiresAt: number
	ttlSeconds: number
}

/** Mints the `dsc+jwt` the browser uses to read usage counts from the region. */
export async function mintDiscountToken(
	input: MintDiscountTokenInput,
): Promise<MintedDiscountToken> {
	const operatorSecret = input.secret ?? ENV.TENANT_OPERATOR_TOKEN
	if (!operatorSecret || operatorSecret.length < 16) {
		throw new Response(
			'TENANT_OPERATOR_TOKEN must be configured with >= 16 chars',
			{ status: 500 },
		)
	}
	const scope = input.scope ?? 'read'
	const grants = discountScopeGrantsFor(scope, input.held)
	if (grants.length === 0) {
		throw new Response('Forbidden: no grants for requested scope', {
			status: 403,
		})
	}

	const region = input.dataRegion?.toLowerCase() === 'ksa' ? 'ksa' : 'us'
	const ttlSeconds = discountTokenTtlSeconds(input.impersonated)
	const issuedAt = input.nowSeconds ?? Math.floor(Date.now() / 1000)
	const expSeconds = issuedAt + ttlSeconds

	const claims = {
		aud: DISCOUNT_TOKEN_AUDIENCE,
		role: 'operator' as const,
		region: region as 'us' | 'ksa',
		orgId: input.organizationId,
		sub: input.userId,
		scope,
		grants,
		locationIds: input.locationIds,
		impersonated: input.impersonated,
		iat: issuedAt,
		exp: expSeconds,
	}
	discountTokenClaimsSchema.parse(claims)

	const {
		aud: ignoredAudience,
		sub: ignoredSubject,
		iat: ignoredIat,
		exp: ignoredExp,
		...payload
	} = claims
	const jwt = await new SignJWT(payload)
		.setProtectedHeader({ alg: 'HS256', typ: DISCOUNT_TOKEN_TYP })
		.setAudience(DISCOUNT_TOKEN_AUDIENCE)
		.setIssuer(brand.shortName)
		.setSubject(input.userId)
		.setIssuedAt(issuedAt)
		.setExpirationTime(expSeconds)
		.sign(new TextEncoder().encode(operatorSecret))

	const { tenantApiUrl } = resolveRegionalTenantApiUrls(region)
	return {
		jwt,
		tenantApiUrl,
		scope,
		grants,
		expiresAt: expSeconds * 1000,
		ttlSeconds,
	}
}
