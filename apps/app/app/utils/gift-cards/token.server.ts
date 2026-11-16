import { brand } from '@repo/config/brand'
import {
	GIFT_CARD_TOKEN_AUDIENCE,
	GIFT_CARD_TOKEN_TYP,
	giftCardScopeGrantsFor,
	giftCardTokenClaimsSchema,
	giftCardTokenTtlSeconds,
	type GiftCardFeatures,
	type GiftCardPermission,
	type GiftCardScope,
} from '@repo/common/gift-cards'
import { SignJWT } from 'jose'
import { ENV } from 'varlock/env'
import { resolveRegionalTenantApiUrls } from '#app/utils/tenant-api.server.ts'

export type MintGiftCardTokenInput = {
	organizationId: string
	userId: string
	/** The named operator, kept on adjustments and charges. */
	actorName: string
	dataRegion: string | null | undefined
	scope: GiftCardScope
	/** The member's gift card grants (`<action>:<entity>:<access>`). */
	grants: readonly string[]
	/** `null` = every location; `[]` = none. */
	locationIds: readonly string[] | null
	features: GiftCardFeatures
	impersonated: boolean
	/** Injectable clock for tests (epoch seconds). */
	nowSeconds?: number
	secret?: string
}

export type MintedGiftCardToken = {
	jwt: string
	tenantApiUrl: string
	scope: GiftCardScope
	grants: GiftCardPermission[]
	locationIds: string[] | null
	features: GiftCardFeatures
	/** Epoch milliseconds when the token stops working. */
	expiresAt: number
	ttlSeconds: number
}

/**
 * Mints the `gft+jwt` the browser uses to call the regional
 * `/operator/gift-cards/*` routes. Holds ids, grants, flags and the operator's
 * name only: no card, code, balance or guest detail.
 */
export async function mintGiftCardToken(
	input: MintGiftCardTokenInput,
): Promise<MintedGiftCardToken> {
	const operatorSecret = input.secret ?? ENV.TENANT_OPERATOR_TOKEN
	if (!operatorSecret || operatorSecret.length < 16) {
		throw new Response(
			'TENANT_OPERATOR_TOKEN must be configured with >= 16 chars',
			{ status: 500 },
		)
	}
	const grants = giftCardScopeGrantsFor(input.scope, input.grants, input.impersonated)
	if (grants.length === 0) {
		throw new Response('Forbidden: no grants for requested scope', { status: 403 })
	}
	const region = input.dataRegion?.toLowerCase() === 'ksa' ? 'ksa' : 'us'
	const ttlSeconds = giftCardTokenTtlSeconds(input.impersonated)
	const issuedAt = input.nowSeconds ?? Math.floor(Date.now() / 1000)
	const expSeconds = issuedAt + ttlSeconds

	const claims = {
		aud: GIFT_CARD_TOKEN_AUDIENCE,
		role: 'operator' as const,
		region: region as 'us' | 'ksa',
		orgId: input.organizationId,
		sub: input.userId,
		actorName: input.actorName.slice(0, 120),
		scope: input.scope,
		grants,
		locationIds: input.locationIds ? [...input.locationIds] : null,
		features: input.features,
		impersonated: input.impersonated,
		iat: issuedAt,
		exp: expSeconds,
	}
	giftCardTokenClaimsSchema.parse(claims)

	const {
		aud: ignoredAudience,
		sub: ignoredSubject,
		iat: ignoredIat,
		exp: ignoredExp,
		...payload
	} = claims
	const jwt = await new SignJWT(payload)
		.setProtectedHeader({ alg: 'HS256', typ: GIFT_CARD_TOKEN_TYP })
		.setAudience(GIFT_CARD_TOKEN_AUDIENCE)
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
