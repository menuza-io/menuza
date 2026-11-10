import { brand } from '@repo/config/brand'
import {
	INVENTORY_TOKEN_AUDIENCE,
	INVENTORY_TOKEN_TYP,
	inventoryScopeGrantsFor,
	inventoryTokenClaimsSchema,
	inventoryTokenTtlSeconds,
	type InventoryFeatures,
	type InventoryPermission,
	type InventoryScope,
} from '@repo/inventory'
import { SignJWT } from 'jose'
import { ENV } from 'varlock/env'
import { resolveRegionalTenantApiUrls } from '#app/utils/tenant-api.server.ts'

export type MintInventoryTokenInput = {
	organizationId: string
	userId: string
	dataRegion: string | null | undefined
	scope: InventoryScope
	/** The member's inventory grants (`<action>:<entity>:<access>`). */
	grants: readonly string[]
	/** `null` = every location; `[]` = none. */
	locationIds: readonly string[] | null
	features: InventoryFeatures
	impersonated: boolean
	/** Injectable clock for tests (epoch seconds). */
	nowSeconds?: number
	secret?: string
}

export type MintedInventoryToken = {
	jwt: string
	tenantApiUrl: string
	scope: InventoryScope
	grants: InventoryPermission[]
	locationIds: string[] | null
	features: InventoryFeatures
	/** Epoch milliseconds when the token stops working. */
	expiresAt: number
	ttlSeconds: number
}

/**
 * Mints the `inv+jwt` the browser uses to call the regional
 * `/operator/inventory/*` routes. Holds ids, grants and flags only.
 */
export async function mintInventoryToken(
	input: MintInventoryTokenInput,
): Promise<MintedInventoryToken> {
	const operatorSecret = input.secret ?? ENV.TENANT_OPERATOR_TOKEN
	if (!operatorSecret || operatorSecret.length < 16) {
		throw new Response(
			'TENANT_OPERATOR_TOKEN must be configured with >= 16 chars',
			{ status: 500 },
		)
	}

	const grants = inventoryScopeGrantsFor(
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
	const ttlSeconds = inventoryTokenTtlSeconds(input.impersonated)
	const issuedAt = input.nowSeconds ?? Math.floor(Date.now() / 1000)
	const expSeconds = issuedAt + ttlSeconds

	const claims = {
		aud: INVENTORY_TOKEN_AUDIENCE,
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
	inventoryTokenClaimsSchema.parse(claims)

	const {
		aud: ignoredAudience,
		sub: ignoredSubject,
		iat: ignoredIat,
		exp: ignoredExp,
		...payload
	} = claims
	const jwt = await new SignJWT(payload)
		.setProtectedHeader({ alg: 'HS256', typ: INVENTORY_TOKEN_TYP })
		.setAudience(INVENTORY_TOKEN_AUDIENCE)
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
