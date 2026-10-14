import { type AnyColumn, inArray, or, type SQL, sql } from 'drizzle-orm'
import { type Context } from 'hono'
import { jwtVerify } from 'jose'
import { brand } from '@repo/config/brand'
import {
	grantsSatisfying,
	restrictGrantsForImpersonation,
	STAFFING_SENSITIVE_GRANTS,
	STAFFING_SENSITIVE_TOKEN_TTL_SECONDS,
	STAFFING_TOKEN_AUDIENCE,
	STAFFING_TOKEN_TTL_SECONDS,
	STAFFING_TOKEN_TYP,
	staffingTokenClaimsSchema,
	type StaffingPermission,
	type StaffingScope,
} from '@repo/staffing'
import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'
import { findActiveOrganizationById } from './origin.ts'
import { getNodeRegion, orgMatchesNodeRegion } from './region.ts'
import { getBearerToken, getOperatorToken } from './secrets.ts'

/**
 * Staffing principals authenticate with App-minted operator tokens that carry
 * their own audience (`tenant-api-staff-operator`), JOSE `typ` (`staff+jwt`),
 * a single `scope`, the permission `grants` the user held at mint time, and a
 * `scopeIds` claim (`null` means every scope). Everything that verifies
 * those tokens lives here so there is one place to audit.
 *
 * tenant-api does not look up feature flags or roles: it trusts only what the
 * App minted. The App refuses to mint unless the flag and permission allow it,
 * and mints short-lived tokens (15 minutes, 5 when pay or private grants are
 * present). This module enforces those lifetimes too, so a token minted with a
 * longer life, even with the right secret, is rejected.
 */

export type StaffAuth = {
	orgId: string
	/** Control-plane operator user id. Never staff data. */
	userId: string
	scope: StaffingScope
	grants: readonly StaffingPermission[]
	/** `null` means every scope. */
	scopeIds: readonly string[] | null
	/** Impersonated sessions are read-only with no pay or private grants. */
	impersonated: boolean
	/**
	 * Who is acting: an `operator` (the default) or a person using their own
	 * schedule link (`staff_link`, where `userId` is `staff:<id>` and no grants
	 * are held). Recorded on every audit row.
	 */
	actorKind?: 'operator' | 'staff_link'
}

type AuthFailure = { error: Response }
type AuthSuccess = { auth: StaffAuth }

const NO_STORE = { 'Cache-Control': 'private, no-store' }

export function staffError(
	status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503,
	error: string,
	extra: Record<string, unknown> = {},
) {
	return Response.json({ error, ...extra }, { status, headers: NO_STORE })
}

const SENSITIVE: readonly string[] = STAFFING_SENSITIVE_GRANTS

/**
 * Verifies the bearer token and the organization it names. Order: signature,
 * audience, `typ`, lifetime, claim shape, scope, node region, then the
 * organization lookup (unknown or unprovisioned orgs are 404).
 */
export async function authenticateStaffOperator(
	c: Context,
	scope: StaffingScope,
): Promise<AuthSuccess | AuthFailure> {
	const token = getBearerToken(c.req.header('Authorization'))
	if (!token) return { error: staffError(401, 'Unauthorized') }

	const secretValue = getOperatorToken()
	if (secretValue.length < 16) {
		return { error: staffError(503, 'Not configured') }
	}

	let payload: Record<string, unknown>
	try {
		const verified = await jwtVerify(
			token,
			new TextEncoder().encode(secretValue),
			{
				audience: STAFFING_TOKEN_AUDIENCE,
				issuer: brand.shortName,
				algorithms: ['HS256'],
				typ: STAFFING_TOKEN_TYP,
				requiredClaims: ['exp', 'iat', 'sub'],
				maxTokenAge: STAFFING_TOKEN_TTL_SECONDS,
			},
		)
		payload = verified.payload as Record<string, unknown>
	} catch {
		return { error: staffError(401, 'Unauthorized') }
	}

	const parsed = staffingTokenClaimsSchema.safeParse(payload)
	if (!parsed.success || !TENANT_ORG_ID_PATTERN.test(parsed.data.orgId)) {
		return { error: staffError(401, 'Unauthorized') }
	}
	const claims = parsed.data

	// Lifetime caps are enforced on the claims themselves, not just on age.
	const lifetime = (payload.exp as number) - (payload.iat as number)
	const sensitive = claims.grants.some((grant) => SENSITIVE.includes(grant))
	const maxLifetime = sensitive
		? STAFFING_SENSITIVE_TOKEN_TTL_SECONDS
		: STAFFING_TOKEN_TTL_SECONDS
	if (!(lifetime > 0) || lifetime > maxLifetime) {
		return { error: staffError(401, 'Unauthorized') }
	}

	if (claims.scope !== scope) {
		return { error: staffError(403, 'Missing staff scope') }
	}

	if (claims.region && claims.region !== getNodeRegion()) {
		return {
			error: staffError(409, 'region_mismatch', {
				message: `Token region "${claims.region}" does not match this node ("${getNodeRegion()}")`,
			}),
		}
	}

	const denied = await assertStaffOrg(claims.orgId)
	if (denied) return { error: denied }

	// Defense in depth: even a correctly signed impersonation token never keeps
	// write, pay or private grants.
	const grants = claims.impersonated
		? restrictGrantsForImpersonation(claims.grants)
		: [...claims.grants]

	return {
		auth: {
			orgId: claims.orgId,
			userId: claims.sub,
			scope: claims.scope,
			grants,
			scopeIds: claims.scopeIds,
			impersonated: claims.impersonated,
		},
	}
}

/**
 * Region and provisioning fail-closed check, mirroring the other operator
 * surfaces: unknown org is 404, an org owned by another region is 409, and an
 * org without a database on this node is 404.
 */
async function assertStaffOrg(orgId: string): Promise<Response | null> {
	const organization = await findActiveOrganizationById(orgId)
	if (!organization) return staffError(404, 'Organization not found')
	if (!orgMatchesNodeRegion(organization.dataRegion)) {
		return staffError(409, 'region_mismatch', {
			message: `Organization dataRegion "${organization.dataRegion}" does not match this node ("${getNodeRegion()}")`,
		})
	}
	if (!organization.hasProvisionedDb) {
		return staffError(404, 'Organization is not provisioned in this region')
	}
	return null
}

/** True when the token holds `permission` or a stronger grant that implies it. */
export function hasGrant(
	auth: Pick<StaffAuth, 'grants'>,
	permission: StaffingPermission,
): boolean {
	return grantsSatisfying(permission).some((grant) =>
		auth.grants.includes(grant),
	)
}

/** Returns a 403 response unless the token holds `permission`. */
export function requireGrant(
	auth: StaffAuth,
	permission: StaffingPermission,
): Response | null {
	if (!hasGrant(auth, permission)) {
		return staffError(403, 'Forbidden', { required: permission })
	}
	return null
}

/**
 * Writes need an `update:*` grant, and an impersonated session can never write
 * (its grants are already stripped, but the explicit check keeps the refusal
 * obvious and independent of grant filtering).
 */
export function requireWriteGrant(
	auth: StaffAuth,
	permission: StaffingPermission,
): Response | null {
	if (auth.impersonated) {
		return staffError(403, 'Impersonated sessions are read-only')
	}
	if (!permission.startsWith('update:') && !permission.startsWith('create:')) {
		throw new Error(`requireWriteGrant needs a write permission: ${permission}`)
	}
	return requireGrant(auth, permission)
}

export type ScopeAccess = {
	/** True when the token may act on every scope. */
	readonly unrestricted: boolean
	allows(scopeId: string): boolean
	/** True only if every id is allowed (vacuously true for no ids). */
	allowsAll(scopeIds: Iterable<string>): boolean
	/** True if at least one id is allowed. */
	allowsAny(scopeIds: Iterable<string>): boolean
	filter<T extends { scopeId: string }>(rows: readonly T[]): T[]
	/** Drizzle predicate for a `scope_id` column; `undefined` when unrestricted. */
	where(column: AnyColumn): SQL | undefined
	/**
	 * Like `where`, but a row also matches when any id in a JSON array column
	 * (a list of scope ids) is allowed. For records that belong to one scope
	 * and are open to others.
	 */
	whereAnyOf(column: AnyColumn, jsonIds: AnyColumn): SQL | undefined
}

/**
 * The one helper every list and write route uses to apply the token's
 * `scopeIds` claim. `null` is every scope; an empty array is no scope
 * at all (a scoped manager with nothing selected sees and changes nothing).
 */
export function scopeToScopes(auth: Pick<StaffAuth, 'scopeIds'>): ScopeAccess {
	const ids = auth.scopeIds ? new Set(auth.scopeIds) : null
	return {
		unrestricted: ids === null,
		allows: (scopeId) => ids === null || ids.has(scopeId),
		allowsAll(scopeIds) {
			if (ids === null) return true
			for (const id of scopeIds) if (!ids.has(id)) return false
			return true
		},
		allowsAny(scopeIds) {
			if (ids === null) return true
			for (const id of scopeIds) if (ids.has(id)) return true
			return false
		},
		filter: (rows) =>
			ids === null ? [...rows] : rows.filter((row) => ids.has(row.scopeId)),
		where(column) {
			if (ids === null) return undefined
			if (ids.size === 0) return sql`0 = 1`
			return inArray(column, [...ids])
		},
		whereAnyOf(column, jsonIds) {
			if (ids === null) return undefined
			if (ids.size === 0) return sql`0 = 1`
			const list = sql.join(
				[...ids].map((id) => sql`${id}`),
				sql`, `,
			)
			return or(
				inArray(column, [...ids]),
				sql`exists (select 1 from json_each(${jsonIds}) where json_each.value in (${list}))`,
			)
		},
	}
}
