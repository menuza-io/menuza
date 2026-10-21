import { brand } from '@repo/config/brand'
import {
	hasGrantSatisfying,
	maxTokenTtlSeconds,
	RESERVATIONS_PERMISSIONS,
	RESERVATIONS_TOKEN_AUDIENCE,
	RESERVATIONS_TOKEN_TYP,
	reservationsTokenClaimsSchema,
	scopeGrantsFor,
	type ReservationsFeatureState,
	type ReservationsPermission,
	type ReservationsScope,
} from '@repo/reservations'
import { SignJWT } from 'jose'
import { ENV } from 'varlock/env'
import { resolveRegionalTenantApiUrls } from '#app/utils/tenant-api.server.ts'

export type MintReservationsTokenInput = {
	organizationId: string
	userId: string
	dataRegion: string | null | undefined
	scope: ReservationsScope
	grants: readonly ReservationsPermission[]
	locationIds: readonly string[] | null
	features: ReservationsFeatureState
	impersonated: boolean
	/** Injectable clock for tests (epoch seconds). */
	nowSeconds?: number
	secret?: string
}

export type MintedReservationsToken = {
	jwt: string
	tenantApiUrl: string
	scope: ReservationsScope
	grants: ReservationsPermission[]
	locationIds: string[] | null
	features: ReservationsFeatureState
	/** Epoch milliseconds when the token stops working. */
	expiresAt: number
	ttlSeconds: number
}

export async function mintReservationsToken(
	input: MintReservationsTokenInput,
): Promise<MintedReservationsToken> {
	const operatorSecret = input.secret ?? ENV.TENANT_OPERATOR_TOKEN
	if (!operatorSecret || operatorSecret.length < 16) {
		throw new Response(
			'TENANT_OPERATOR_TOKEN must be configured with >= 16 chars',
			{ status: 500 },
		)
	}

	const grants = scopeGrantsFor(input.scope, input.grants, input.impersonated)
	if (grants.length === 0) {
		throw new Response('Forbidden: no grants for requested scope', {
			status: 403,
		})
	}

	const region = input.dataRegion?.toLowerCase() === 'ksa' ? 'ksa' : 'us'
	// The guest-PII read grant is a claim of its own, but it makes the token
	// sensitive: count it, so such a token lives 5 minutes, not 15.
	const canReadGuest =
		input.scope === 'book' &&
		!input.impersonated &&
		hasGrantSatisfying(
			input.grants,
			RESERVATIONS_PERMISSIONS.READ_RESERVATION_GUEST,
		)
	const ttlSeconds = maxTokenTtlSeconds(
		canReadGuest
			? [
					...new Set([
						...grants,
						RESERVATIONS_PERMISSIONS.READ_RESERVATION_GUEST,
					]),
				]
			: grants,
		input.impersonated,
	)
	const issuedAt = input.nowSeconds ?? Math.floor(Date.now() / 1000)
	const expSeconds = issuedAt + ttlSeconds

	const claims = {
		aud: RESERVATIONS_TOKEN_AUDIENCE,
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
	reservationsTokenClaimsSchema.parse(claims)

	const {
		aud: ignoredAudience,
		sub: ignoredSubject,
		iat: ignoredIat,
		exp: ignoredExp,
		...payload
	} = claims
	const jwt = await new SignJWT(
		canReadGuest ? { ...payload, canReadGuest: true } : payload,
	)
		.setProtectedHeader({ alg: 'HS256', typ: RESERVATIONS_TOKEN_TYP })
		.setAudience(RESERVATIONS_TOKEN_AUDIENCE)
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

export const mintReservationsOperatorToken = mintReservationsToken
