import { brand } from '@repo/config/brand'
import {
	hasInventoryGrant,
	INVENTORY_TOKEN_AUDIENCE,
	INVENTORY_TOKEN_TYP,
	inventoryAllowsLocation,
	inventoryLocationIdSchema,
	inventoryTokenClaimsSchema,
	restrictInventoryGrantsForImpersonation,
	type InventoryErrorCode,
	type InventoryFeatures,
	type InventoryPermission,
	type InventoryScope,
} from '@repo/inventory'
import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'
import { jwtVerify } from 'jose'
import { inventoryDeny } from './inventory-http.ts'
import { getNodeRegion } from './region.ts'
import { getBearerToken, getOperatorToken } from './secrets.ts'

export type InventoryOperatorContext = {
	orgId: string
	userId: string
	scope: InventoryScope
	grants: readonly InventoryPermission[]
	/** `null` allows every location; `[]` none. */
	locationIds: readonly string[] | null
	features: InventoryFeatures
	impersonated: boolean
	region: 'us' | 'ksa'
}

export type InventoryTokenVerificationResult =
	| { ok: true; context: InventoryOperatorContext }
	| {
			ok: false
			status: 401 | 403 | 500
			code: InventoryErrorCode
			reason: string
	  }

/**
 * Verifies a short-lived inventory operator JWT issued by the App
 * (`GET /<orgSlug>/inventory-token?scope=`). Signed with
 * `TENANT_OPERATOR_TOKEN` like the loyalty token, but distinct from every
 * other token on this node: `typ` must be `inv+jwt`, `aud`
 * `tenant-api-inventory-operator`, and `region` this node's `DATA_REGION`.
 * The claims schema is strict and caps the lifetime (15 minutes, 5 when
 * impersonating), refuses grants outside the token's scope and refuses write
 * grants on an impersonated token.
 */
export async function verifyInventoryOperatorToken(
	authHeader: string | undefined,
	options?: {
		secret?: string
		expectedRegion?: 'us' | 'ksa'
		clockToleranceSeconds?: number
	},
): Promise<InventoryTokenVerificationResult> {
	const operatorSecret = options?.secret ?? getOperatorToken()
	if (!operatorSecret || operatorSecret.length < 16) {
		return {
			ok: false,
			status: 500,
			code: 'inventory_unavailable',
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
				audience: INVENTORY_TOKEN_AUDIENCE,
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

	if (protectedHeader.typ !== INVENTORY_TOKEN_TYP) {
		return {
			ok: false,
			status: 401,
			code: 'unauthorized',
			reason: 'invalid_token_type',
		}
	}

	const parsed = inventoryTokenClaimsSchema.safeParse(payload)
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
	// impersonated token; strip them again so a future claims change can
	// never silently widen.
	const grants = restrictInventoryGrantsForImpersonation(
		claims.grants,
		claims.impersonated,
	)

	return {
		ok: true,
		context: {
			orgId: claims.orgId,
			userId: claims.sub,
			scope: claims.scope,
			grants,
			locationIds: claims.locationIds,
			features: claims.features,
			impersonated: claims.impersonated,
			region: claims.region,
		},
	}
}

export function hasInventoryOperatorGrant(
	context: InventoryOperatorContext,
	required: InventoryPermission,
): boolean {
	return hasInventoryGrant(context.grants, required)
}

/**
 * The one location check every list and write route uses. A malformed id is
 * 400 `invalid_request`; an id outside the token's `locationIds` is 403
 * `location_forbidden`.
 */
export function requireInventoryLocation(
	context: Pick<InventoryOperatorContext, 'locationIds'>,
	locationId: string | null | undefined,
): { ok: true; locationId: string } | { ok: false; response: Response } {
	const parsed = inventoryLocationIdSchema.safeParse(locationId?.trim() ?? '')
	if (!parsed.success) {
		return {
			ok: false,
			response: inventoryDeny(400, 'invalid_request', {
				message: 'Valid locationId is required',
			}),
		}
	}
	if (!inventoryAllowsLocation(context.locationIds, parsed.data)) {
		return { ok: false, response: inventoryDeny(403, 'location_forbidden') }
	}
	return { ok: true, locationId: parsed.data }
}
