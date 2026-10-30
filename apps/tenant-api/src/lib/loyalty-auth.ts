import { brand } from '@repo/config/brand'
import {
	hasLoyaltyGrant,
	LOYALTY_TOKEN_AUDIENCE,
	LOYALTY_TOKEN_TYP,
	loyaltyTokenClaimsSchema,
	restrictLoyaltyGrantsForImpersonation,
	type LoyaltyFeatures,
	type LoyaltyPermission,
	type LoyaltyScope,
} from '@repo/loyalty'
import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'
import { jwtVerify } from 'jose'
import { NO_STORE } from './http.ts'
import { isLoyaltyKillSwitchOn } from './loyalty-switches.ts'
import { getNodeRegion } from './region.ts'
import { getBearerToken, getOperatorToken } from './secrets.ts'

const LOCATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export type LoyaltyOperatorContext = {
	orgId: string
	userId: string
	scope: LoyaltyScope
	grants: ReadonlySet<LoyaltyPermission>
	grantList: readonly LoyaltyPermission[]
	/** Allowed location ids, or `null` when the token covers every location. */
	locationIds: ReadonlySet<string> | null
	locationIdList: readonly string[] | null
	features: LoyaltyFeatures
	impersonated: boolean
	region: 'us' | 'ksa'
}

export type LoyaltyTokenVerificationResult =
	| { ok: true; context: LoyaltyOperatorContext }
	| { ok: false; status: 401 | 403 | 500; error: string }

/**
 * Verifies a short-lived loyalty operator JWT issued by the App
 * (`GET /<orgSlug>/loyalty/token?scope=`). Distinct from every other token
 * on this node: signed with `TENANT_OPERATOR_TOKEN`, `typ` must be
 * `lty+jwt`, `aud` `tenant-api-loyalty-operator`, `region` this node's
 * `DATA_REGION`. The claims schema caps the lifetime (five minutes once a
 * grant moves points, or when impersonating) and refuses grants outside the
 * token's scope, so verification stays simple: signature, type, claims,
 * region.
 */
export async function verifyLoyaltyOperatorToken(
	authHeader: string | undefined,
	options?: {
		secret?: string
		expectedRegion?: 'us' | 'ksa'
		clockToleranceSeconds?: number
	},
): Promise<LoyaltyTokenVerificationResult> {
	const operatorSecret = options?.secret ?? getOperatorToken()
	if (!operatorSecret || operatorSecret.length < 16) {
		return {
			ok: false,
			status: 500,
			error: 'Loyalty operator authentication is not configured',
		}
	}

	const token = getBearerToken(authHeader)
	if (!token) {
		return { ok: false, status: 401, error: 'Missing bearer token' }
	}

	let payload: unknown
	let protectedHeader: { typ?: string }
	try {
		const secret = new TextEncoder().encode(operatorSecret)
		const verified = await jwtVerify(token, secret, {
			audience: LOYALTY_TOKEN_AUDIENCE,
			issuer: brand.shortName,
			algorithms: ['HS256'],
			clockTolerance: options?.clockToleranceSeconds ?? 5,
		})
		payload = verified.payload
		protectedHeader = verified.protectedHeader
	} catch {
		return {
			ok: false,
			status: 401,
			error: 'Invalid or expired loyalty operator token',
		}
	}

	if (protectedHeader.typ !== LOYALTY_TOKEN_TYP) {
		return {
			ok: false,
			status: 401,
			error: 'Invalid loyalty operator token type',
		}
	}

	const parsed = loyaltyTokenClaimsSchema.safeParse(payload)
	if (!parsed.success) {
		return {
			ok: false,
			status: 401,
			error: 'Malformed loyalty operator token claims',
		}
	}
	const claims = parsed.data

	if (!TENANT_ORG_ID_PATTERN.test(claims.orgId)) {
		return {
			ok: false,
			status: 401,
			error: 'Invalid organization in loyalty operator token',
		}
	}

	const expectedRegion = options?.expectedRegion ?? getNodeRegion()
	if (claims.region !== expectedRegion) {
		return { ok: false, status: 403, error: 'region_mismatch' }
	}

	// Defense in depth: the claims schema already rejects write grants on an
	// impersonated token; strip them again so a future claims change can
	// never silently widen.
	const grants = restrictLoyaltyGrantsForImpersonation(
		claims.grants,
		claims.impersonated,
	)

	return {
		ok: true,
		context: {
			orgId: claims.orgId,
			userId: claims.sub,
			scope: claims.scope,
			grants: new Set(grants),
			grantList: grants,
			locationIds: claims.locationIds ? new Set(claims.locationIds) : null,
			locationIdList: claims.locationIds ?? null,
			features: claims.features,
			impersonated: claims.impersonated,
			region: claims.region,
		},
	}
}

function deny(
	status: number,
	code: string,
	extra: Record<string, unknown> = {},
): Response {
	return Response.json(
		{ error: code, code, ...extra },
		{ status, headers: NO_STORE },
	)
}

export function hasLoyaltyOperatorGrant(
	context: LoyaltyOperatorContext,
	required: LoyaltyPermission,
): boolean {
	return hasLoyaltyGrant(context.grantList, required)
}

export function requireLoyaltyGrant(
	context: LoyaltyOperatorContext,
	required: LoyaltyPermission,
): Response | null {
	if (!hasLoyaltyOperatorGrant(context, required)) {
		return deny(403, 'forbidden_grant', { required })
	}
	return null
}

export function requireLoyaltyScope(
	context: LoyaltyOperatorContext,
	expected: LoyaltyScope | readonly LoyaltyScope[],
): Response | null {
	const allowed = Array.isArray(expected) ? expected : [expected]
	if (!allowed.includes(context.scope)) {
		return deny(403, 'unauthorized_scope', {
			expected: allowed,
			actual: context.scope,
		})
	}
	return null
}

/**
 * Checks that the operator token covers `locationId`. `null` locationIds
 * (organization-wide) accepts any well-formed id; otherwise the id must be
 * in the token's list.
 */
export function requireLoyaltyLocation(
	context: LoyaltyOperatorContext,
	locationId: string | null | undefined,
): { ok: true; locationId: string } | { ok: false; response: Response } {
	const trimmed = locationId?.trim() ?? ''
	if (!trimmed || !LOCATION_ID_PATTERN.test(trimmed)) {
		return {
			ok: false,
			response: deny(400, 'invalid_request', {
				message: 'Valid locationId is required',
			}),
		}
	}
	if (context.locationIds !== null && !context.locationIds.has(trimmed)) {
		return { ok: false, response: deny(403, 'location_forbidden') }
	}
	return { ok: true, locationId: trimmed }
}

/**
 * The flag gate for operator routes. The node kill switch answers 503
 * `loyalty_unavailable` (reads pass `killSwitch: false`: the switch stops new
 * work, not looking); an organization flag that went off after the token was
 * minted answers 403. Reconciliation routes (refunds, review decisions,
 * requeue, balance check/repair) skip this on purpose: switching loyalty off
 * must never strand a sale or a redemption already in flight.
 */
export function requireLoyaltyFeature(
	context: LoyaltyOperatorContext,
	feature: keyof LoyaltyFeatures = 'enabled',
	options: { killSwitch?: boolean } = {},
): Response | null {
	if (options.killSwitch !== false && isLoyaltyKillSwitchOn()) {
		return deny(503, 'loyalty_unavailable')
	}
	if (!context.features.enabled) return deny(403, 'loyalty_disabled')
	if (feature !== 'enabled' && !context.features[feature]) {
		return deny(
			403,
			feature === 'redemption' ? 'redemption_disabled' : 'loyalty_disabled',
		)
	}
	return null
}
