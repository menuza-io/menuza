import { brand } from '@repo/config/brand'
import {
	hasGrantSatisfying,
	maxTokenTtlSeconds,
	RESERVATIONS_TOKEN_AUDIENCE,
	RESERVATIONS_TOKEN_TYP,
	reservationsTokenClaimsSchema,
	restrictGrantsForImpersonation,
	SCOPE_GRANTS,
	type ReservationsFeatureState,
	type ReservationsPermission,
	type ReservationsScope,
} from '@repo/reservations'
import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'
import { jwtVerify } from 'jose'
import { getNodeRegion } from './region.ts'
import { getBearerToken, getOperatorToken } from './secrets.ts'

const LOCATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

function isWriteOrSensitiveGrant(grant: ReservationsPermission): boolean {
	return restrictGrantsForImpersonation([grant], true).length === 0
}

export type ReservationsOperatorContext = {
	orgId: string
	userId: string
	scope: ReservationsScope
	grants: ReadonlySet<ReservationsPermission>
	grantList: readonly ReservationsPermission[]
	/** Allowed location ids, or `null` when the token covers every location. */
	locationIds: ReadonlySet<string> | null
	locationIdList: readonly string[] | null
	features: ReservationsFeatureState
	impersonated: boolean
	region: 'us' | 'ksa'
	/** `station` for a token minted for a Station till (see `pos-reservations.ts`). */
	channel: 'station' | null
	/** The Station terminal behind a `station` token. */
	deviceId: string | null
}

export type ReservationsAuthContext = ReservationsOperatorContext

export type ReservationsTokenVerificationResult =
	| { ok: true; context: ReservationsOperatorContext }
	| { ok: false; status: 401 | 403 | 404 | 500; error: string }

/**
 * Verifies a short-lived reservations operator JWT issued by the App.
 *
 * Distinct from both customer tokens and staffing tokens:
 *  - signed with `TENANT_OPERATOR_TOKEN`
 *  - `typ` must be `rsv+jwt` (`RESERVATIONS_TOKEN_TYP`)
 *  - `aud` must be `tenant-api-reservations-operator` (`RESERVATIONS_TOKEN_AUDIENCE`)
 *  - `region` must match this node's `DATA_REGION`
 */
export async function verifyReservationsOperatorToken(
	authHeader: string | undefined,
	options?: {
		secret?: string
		expectedRegion?: 'us' | 'ksa'
		clockToleranceSeconds?: number
	},
): Promise<ReservationsTokenVerificationResult> {
	const operatorSecret = options?.secret ?? getOperatorToken()
	if (!operatorSecret || operatorSecret.length < 16) {
		return {
			ok: false,
			status: 500,
			error: 'Reservations operator authentication is not configured',
		}
	}

	const token = getBearerToken(authHeader)
	if (!token) {
		return { ok: false, status: 401, error: 'Missing bearer token' }
	}

	let payload: unknown
	let protectedHeader: { typ?: string; alg?: string }
	try {
		const secret = new TextEncoder().encode(operatorSecret)
		const verified = await jwtVerify(token, secret, {
			audience: RESERVATIONS_TOKEN_AUDIENCE,
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
			error: 'Invalid or expired reservations operator token',
		}
	}

	if (protectedHeader.typ !== RESERVATIONS_TOKEN_TYP) {
		return {
			ok: false,
			status: 401,
			error: 'Invalid reservations operator token type',
		}
	}

	const rawRecord =
		payload && typeof payload === 'object'
			? (payload as Record<string, unknown>)
			: null
	const hasEmptyGrants =
		rawRecord !== null &&
		Array.isArray(rawRecord.grants) &&
		rawRecord.grants.length === 0

	const rawScope =
		rawRecord && typeof rawRecord.scope === 'string'
			? (rawRecord.scope as ReservationsScope)
			: 'book'
	const allowedScopeGrants = new Set<string>(
		(SCOPE_GRANTS as Record<string, readonly string[]>)[rawScope] ?? [],
	)
	const placeholderGrant =
		(SCOPE_GRANTS as Record<string, readonly string[]>)[rawScope]?.[0] ??
		'read:reservation:any'

	const extraBookGuestGrants: ReservationsPermission[] = []
	if (rawScope === 'book' && rawRecord && Array.isArray(rawRecord.grants)) {
		for (const g of rawRecord.grants) {
			if (
				g === 'read:reservation_guest:any' ||
				g === 'update:reservation_guest:any'
			) {
				extraBookGuestGrants.push(g)
			}
		}
	}

	const rawWithoutExtraKeys = rawRecord
		? (() => {
				const { canReadGuest: _canReadGuest, ...rest } = rawRecord
				return rest
			})()
		: null

	const payloadToValidate = hasEmptyGrants
		? {
				...rawWithoutExtraKeys,
				grants: [placeholderGrant],
			}
		: extraBookGuestGrants.length > 0 &&
			  rawWithoutExtraKeys &&
			  Array.isArray(rawWithoutExtraKeys.grants)
			? {
					...rawWithoutExtraKeys,
					grants: rawWithoutExtraKeys.grants.filter((g) =>
						allowedScopeGrants.has(String(g)),
					),
				}
			: (rawWithoutExtraKeys ?? payload)

	const parsed = reservationsTokenClaimsSchema.safeParse(payloadToValidate)
	if (!parsed.success) {
		return {
			ok: false,
			status: 401,
			error: 'Malformed reservations operator token claims',
		}
	}

	const claims = {
		...parsed.data,
		grants: hasEmptyGrants ? [] : parsed.data.grants,
	}
	if (!TENANT_ORG_ID_PATTERN.test(claims.orgId)) {
		return {
			ok: false,
			status: 401,
			error: 'Invalid organization in reservations operator token',
		}
	}

	if (
		claims.locationIds !== null &&
		claims.locationIds.some((id) => !LOCATION_ID_PATTERN.test(id))
	) {
		return {
			ok: false,
			status: 401,
			error: 'Invalid location in reservations operator token',
		}
	}

	const expectedRegion = options?.expectedRegion ?? getNodeRegion()
	if (claims.region !== expectedRegion) {
		return {
			ok: false,
			status: 403,
			error: 'region_mismatch',
		}
	}

	const allClaimGrants: ReservationsPermission[] = hasEmptyGrants
		? []
		: Array.from(new Set([...claims.grants, ...extraBookGuestGrants]))
	// The guest-PII grant rides in a claim, so it counts toward the lifetime
	// limit too: a token that can read guests lives 5 minutes, not 15.
	if (
		rawScope === 'book' &&
		!claims.impersonated &&
		rawRecord?.canReadGuest === true &&
		!allClaimGrants.includes('read:reservation_guest:any')
	) {
		allClaimGrants.push('read:reservation_guest:any')
	}

	const lifetime = claims.exp - claims.iat
	const maxLifetime = maxTokenTtlSeconds(allClaimGrants, claims.impersonated)
	if (!(lifetime > 0) || lifetime > maxLifetime) {
		return {
			ok: false,
			status: 401,
			error: 'Token lifetime exceeds maximum allowed TTL',
		}
	}

	const effectiveGrants = restrictGrantsForImpersonation(
		allClaimGrants,
		claims.impersonated,
	)

	return {
		ok: true,
		context: {
			orgId: claims.orgId,
			userId: claims.sub,
			scope: claims.scope,
			grants: new Set(effectiveGrants),
			grantList: effectiveGrants,
			locationIds: claims.locationIds ? new Set(claims.locationIds) : null,
			locationIdList: claims.locationIds ?? null,
			features: claims.features,
			impersonated: claims.impersonated,
			region: claims.region,
			channel: claims.channel ?? null,
			deviceId: claims.deviceId ?? null,
		},
	}
}

export function hasReservationsGrant(
	context: ReservationsOperatorContext,
	required: ReservationsPermission,
): boolean {
	if (context.impersonated && isWriteOrSensitiveGrant(required)) {
		return false
	}
	return hasGrantSatisfying(context.grantList, required)
}

export function requireReservationsGrant(
	context: ReservationsOperatorContext,
	required: ReservationsPermission,
): Response | null {
	if (context.impersonated && isWriteOrSensitiveGrant(required)) {
		return Response.json(
			{
				error: 'impersonated_read_only',
				message:
					'Write and sensitive operations are disabled during impersonation',
			},
			{ status: 403 },
		)
	}
	if (!hasReservationsGrant(context, required)) {
		return Response.json(
			{ error: 'insufficient_permissions', required },
			{ status: 403 },
		)
	}
	return null
}

export function requireAnyReservationsGrant(
	context: ReservationsOperatorContext,
	required: readonly ReservationsPermission[],
): Response | null {
	if (
		required.some((permission) => hasReservationsGrant(context, permission))
	) {
		return null
	}
	if (
		context.impersonated &&
		required.every((permission) => isWriteOrSensitiveGrant(permission))
	) {
		return Response.json(
			{
				error: 'impersonated_read_only',
				message:
					'Write and sensitive operations are disabled during impersonation',
			},
			{ status: 403 },
		)
	}
	return Response.json(
		{ error: 'insufficient_permissions', required },
		{ status: 403 },
	)
}

export function requireReservationsScope(
	context: ReservationsOperatorContext,
	expected: ReservationsScope | readonly ReservationsScope[],
): Response | null {
	const allowed = Array.isArray(expected) ? expected : [expected]
	if (!allowed.includes(context.scope)) {
		return Response.json(
			{
				error: 'invalid_scope',
				expected: allowed,
				actual: context.scope,
			},
			{ status: 403 },
		)
	}
	return null
}

export function requireReservationsFeatureFlag(
	context: ReservationsOperatorContext,
	feature: keyof ReservationsFeatureState = 'enabled',
): Response | null {
	if (!context.features.enabled || !context.features[feature]) {
		return Response.json({ error: 'Not found' }, { status: 404 })
	}
	return null
}

/**
 * Checks that the operator token covers `locationId`. When `locationIds` is
 * `null` (organization-wide access), any valid location id is accepted; when a
 * list is present, the id must be in it.
 */
export function requireReservationsLocation(
	context: ReservationsOperatorContext,
	locationId: string | null | undefined,
): { ok: true; locationId: string } | { ok: false; response: Response } {
	const trimmed = locationId?.trim() ?? ''
	if (!trimmed || !LOCATION_ID_PATTERN.test(trimmed)) {
		return {
			ok: false,
			response: Response.json(
				{ error: 'invalid_location', message: 'Valid locationId is required' },
				{ status: 400 },
			),
		}
	}
	if (context.locationIds !== null && !context.locationIds.has(trimmed)) {
		return {
			ok: false,
			response: Response.json(
				{
					error: 'location_forbidden',
					message: 'Location is outside your assigned scope',
				},
				{ status: 403 },
			),
		}
	}
	return { ok: true, locationId: trimmed }
}

export function filterReservationsLocations<T extends { locationId: string }>(
	context: ReservationsOperatorContext,
	items: readonly T[],
): T[] {
	if (context.locationIds === null) return [...items]
	const allowed = context.locationIds
	return items.filter((item) => allowed.has(item.locationId))
}
