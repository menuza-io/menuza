import { brand } from '@repo/config/brand'
import {
	GIFT_CARD_TOKEN_AUDIENCE,
	GIFT_CARD_TOKEN_TYP,
	giftCardAllowsLocation,
	giftCardTokenClaimsSchema,
	hasGiftCardGrant,
	restrictGiftCardGrantsForImpersonation,
	type GiftCardFeatures,
	type GiftCardPermission,
	type GiftCardScope,
} from '@repo/common/gift-cards'
import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'
import { jwtVerify } from 'jose'
import { getNodeRegion } from './region.ts'
import { getBearerToken, getOperatorToken } from './secrets.ts'

export type GiftCardOperatorContext = {
	orgId: string
	userId: string
	/** The named operator, kept on adjustments and charges. */
	actorName: string | null
	scope: GiftCardScope
	grants: readonly GiftCardPermission[]
	/** `null` allows every location; `[]` none. */
	locationIds: readonly string[] | null
	features: GiftCardFeatures
	impersonated: boolean
	region: 'us' | 'ksa'
}

export type GiftCardTokenVerificationResult =
	| { ok: true; context: GiftCardOperatorContext }
	| { ok: false; status: 401 | 403 | 500; code: string; reason: string }

/**
 * Verifies a short-lived gift-card operator JWT minted by the App
 * (`GET /<orgSlug>/gift-cards-token?scope=`). Signed with
 * `TENANT_OPERATOR_TOKEN`, but distinct from every other token on this node:
 * `typ` must be `gft+jwt`, `aud` `tenant-api-gift-cards-operator`, and
 * `region` this node's `DATA_REGION`. The claims schema is strict, caps the
 * lifetime (15 minutes, 5 when impersonating), refuses grants outside the
 * token's scope and refuses write grants on an impersonated token.
 */
export async function verifyGiftCardOperatorToken(
	authHeader: string | undefined,
	options?: {
		secret?: string
		expectedRegion?: 'us' | 'ksa'
		clockToleranceSeconds?: number
	},
): Promise<GiftCardTokenVerificationResult> {
	const operatorSecret = options?.secret ?? getOperatorToken()
	if (!operatorSecret || operatorSecret.length < 16) {
		return {
			ok: false,
			status: 500,
			code: 'gift_cards_unavailable',
			reason: 'not_configured',
		}
	}
	const token = getBearerToken(authHeader)
	if (!token) {
		return {
			ok: false,
			status: 401,
			code: 'unauthorized',
			reason: 'missing_token',
		}
	}

	let payload: unknown
	let protectedHeader: { typ?: string }
	try {
		const verified = await jwtVerify(
			token,
			new TextEncoder().encode(operatorSecret),
			{
				audience: GIFT_CARD_TOKEN_AUDIENCE,
				issuer: brand.shortName,
				algorithms: ['HS256'],
				clockTolerance: options?.clockToleranceSeconds ?? 5,
			},
		)
		payload = verified.payload
		protectedHeader = verified.protectedHeader
	} catch {
		return {
			ok: false,
			status: 401,
			code: 'unauthorized',
			reason: 'invalid_token',
		}
	}
	if (protectedHeader.typ !== GIFT_CARD_TOKEN_TYP) {
		return {
			ok: false,
			status: 401,
			code: 'unauthorized',
			reason: 'invalid_token_type',
		}
	}
	const parsed = giftCardTokenClaimsSchema.safeParse(payload)
	if (!parsed.success) {
		return {
			ok: false,
			status: 401,
			code: 'unauthorized',
			reason: 'invalid_claims',
		}
	}
	const claims = parsed.data
	if (!TENANT_ORG_ID_PATTERN.test(claims.orgId)) {
		return {
			ok: false,
			status: 401,
			code: 'unauthorized',
			reason: 'invalid_organization',
		}
	}
	const expectedRegion = options?.expectedRegion ?? getNodeRegion()
	if (claims.region !== expectedRegion) {
		return {
			ok: false,
			status: 403,
			code: 'forbidden',
			reason: 'region_mismatch',
		}
	}
	// Defense in depth: the claims schema already refuses write grants on an
	// impersonated token; strip them again so a future change cannot widen.
	const grants = restrictGiftCardGrantsForImpersonation(
		claims.grants,
		claims.impersonated,
	)
	return {
		ok: true,
		context: {
			orgId: claims.orgId,
			userId: claims.sub,
			actorName: claims.actorName ?? null,
			scope: claims.scope,
			grants,
			locationIds: claims.locationIds,
			features: claims.features,
			impersonated: claims.impersonated,
			region: claims.region,
		},
	}
}

export function hasGiftCardOperatorGrant(
	context: GiftCardOperatorContext,
	required: GiftCardPermission,
): boolean {
	return hasGiftCardGrant(context.grants, required)
}

/** An id outside the token's `locationIds` is 403 `location_forbidden`. */
export function giftCardLocationAllowed(
	context: Pick<GiftCardOperatorContext, 'locationIds'>,
	locationId: string | null | undefined,
): boolean {
	// A card with no location (online, default) is visible to every operator;
	// a location-scoped operator sees only cards of their own locations.
	if (context.locationIds === null) return true
	if (!locationId) return false
	return giftCardAllowsLocation(context.locationIds, locationId)
}
