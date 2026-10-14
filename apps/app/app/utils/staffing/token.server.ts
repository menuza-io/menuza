import { brand } from '@repo/config/brand'
import {
	restrictGrantsForImpersonation,
	STAFFING_PERMISSIONS as P,
	STAFFING_TOKEN_AUDIENCE,
	STAFFING_TOKEN_TYP,
	staffingTokenClaimsSchema,
	staffingTokenTtlSeconds,
	type StaffingFeature,
	type StaffingPermission,
	type StaffingScope,
} from '@repo/staffing'
import { SignJWT } from 'jose'
import { ENV } from 'varlock/env'
import { resolveRegionalTenantApiUrls } from '#app/utils/tenant-api.server.ts'

/**
 * Mints the short-lived operator tokens the browser sends straight to the
 * regional tenant-api for staff data (roster, pay, PINs, later schedule and
 * time clock). The App never reads that data: it decides who may ask, signs a
 * token that says so, and gets out of the way, so no staff name or wage ever
 * transits the US control plane.
 *
 * The token carries:
 * - a distinct audience and `typ`, so it cannot be replayed on the generic
 *   operator routes (orders, mailbox, calls) and none of those tokens work on
 *   the staff routes;
 * - one `scope` (staff, schedule, timeclock, labor, hiring);
 * - the permission `grants` the user actually holds, nothing more;
 * - `scopeIds` (`null` means every workplace);
 * - a lifetime of 15 minutes, or 5 when it carries a pay or private grant;
 * - for an impersonated admin session, read-only grants only (no writes, no pay
 *   or private data), so support can look but never change or see wages.
 */

type ScopePolicy = {
	/** Permissions that may ride in a token of this workplace, if the user holds them. */
	grants: readonly StaffingPermission[]
	/** Added only when the `staffing.labor` flag is on. */
	laborGrants?: readonly StaffingPermission[]
}

const SCOPE_POLICIES: Record<StaffingScope, ScopePolicy> = {
	staff: {
		grants: [
			P.READ_STAFF,
			P.UPDATE_STAFF,
			P.READ_STAFF_PAY,
			P.UPDATE_STAFF_PAY,
			P.READ_STAFF_PRIVATE,
			P.UPDATE_STAFF_PRIVATE,
		],
	},
	timeclock: {
		// Names come from the roster, so the staff read grant rides along. Wages
		// are not here by default: individual rates, pay and tips ride along only
		// while `staffing.labor` is on (see `laborGrants`), and the token then
		// gets the shorter pay lifetime.
		grants: [
			P.READ_STAFF,
			P.READ_TIMESHEET,
			P.UPDATE_TIMESHEET,
			P.APPROVE_TIMESHEET,
			P.READ_LABOR_POLICY,
			P.UPDATE_LABOR_POLICY,
		],
		laborGrants: [P.READ_LABOR, P.READ_STAFF_PAY],
	},
	schedule: {
		grants: [P.READ_STAFF, P.READ_SCHEDULE, P.UPDATE_SCHEDULE],
		laborGrants: [P.READ_LABOR],
	},
	// The labor summary, sales entry and tip pool. Wages and tips ride along only
	// while `staffing.labor` is on (the section is closed otherwise), and the
	// token then gets the shorter pay lifetime. Entering daily sales is a
	// timesheet-level job; sales source and tip settings need the policy grant.
	labor: {
		grants: [
			P.READ_STAFF,
			P.READ_TIMESHEET,
			P.UPDATE_TIMESHEET,
			P.READ_LABOR_POLICY,
			P.UPDATE_LABOR_POLICY,
		],
		laborGrants: [P.READ_LABOR, P.READ_STAFF_PAY],
	},
	hiring: {
		grants: [P.READ_STAFF, P.READ_HIRING, P.UPDATE_HIRING],
	},
}

/**
 * The grants a token of `scope` may carry: those the user holds, limited to the
 * scope's own list. `read:labor:any` only counts while `staffing.labor` is on.
 * Order follows the policy so tokens are deterministic.
 */
export function selectGrantsForScope(
	held: ReadonlySet<string> | readonly string[],
	scope: StaffingScope,
	features: Pick<Record<StaffingFeature, boolean>, 'labor'>,
): StaffingPermission[] {
	const heldSet = held instanceof Set ? held : new Set(held)
	const policy = SCOPE_POLICIES[scope]
	const allowed = [
		...policy.grants,
		...(features.labor ? (policy.laborGrants ?? []) : []),
	]
	return allowed.filter((grant) => heldSet.has(grant))
}

/** `action:entity:access` strings for permission rows. */
export function grantStrings(
	rows: ReadonlyArray<{ action: string; entity: string; access: string }>,
): string[] {
	return rows.map((row) => `${row.action}:${row.entity}:${row.access}`)
}

export type MintStaffingTokenInput = {
	organizationId: string
	userId: string
	dataRegion: string | null | undefined
	scope: StaffingScope
	grants: readonly StaffingPermission[]
	scopeIds: readonly string[] | null
	impersonated: boolean
	/** Injectable clock for tests (epoch seconds). */
	nowSeconds?: number
}

export type MintedStaffingToken = {
	jwt: string
	tenantApiUrl: string
	scope: StaffingScope
	grants: StaffingPermission[]
	scopeIds: readonly string[] | null
	/** Epoch milliseconds when the token stops working. */
	expiresAt: number
	ttlSeconds: number
}

export async function mintStaffingToken(
	input: MintStaffingTokenInput,
): Promise<MintedStaffingToken> {
	const operatorSecret = ENV.TENANT_OPERATOR_TOKEN
	if (!operatorSecret || operatorSecret.length < 16) {
		throw new Response(
			'TENANT_OPERATOR_TOKEN must be configured with >= 16 chars',
			{ status: 500 },
		)
	}

	// Impersonated sessions never carry write, pay or private grants.
	const grants = input.impersonated
		? restrictGrantsForImpersonation(input.grants)
		: [...input.grants]
	// Same rule as `resolveRegionalTenantApiUrls`: anything but KSA is the US node.
	const region = input.dataRegion?.toLowerCase() === 'ksa' ? 'ksa' : 'us'
	const ttlSeconds = staffingTokenTtlSeconds(grants, {
		impersonated: input.impersonated,
	})
	const issuedAt = input.nowSeconds ?? Math.floor(Date.now() / 1000)

	const claims = {
		aud: STAFFING_TOKEN_AUDIENCE,
		role: 'operator' as const,
		region,
		orgId: input.organizationId,
		sub: input.userId,
		scope: input.scope,
		grants,
		scopeIds: input.scopeIds ? [...input.scopeIds] : null,
		impersonated: input.impersonated,
	}
	// App and tenant-api share this schema; refuse to sign anything it rejects.
	staffingTokenClaimsSchema.parse(claims)

	const { aud: ignoredAudience, sub: ignoredSubject, ...payload } = claims
	const jwt = await new SignJWT(payload)
		.setProtectedHeader({ alg: 'HS256', typ: STAFFING_TOKEN_TYP })
		.setAudience(STAFFING_TOKEN_AUDIENCE)
		.setIssuer(brand.shortName)
		.setSubject(input.userId)
		.setIssuedAt(issuedAt)
		.setExpirationTime(issuedAt + ttlSeconds)
		.sign(new TextEncoder().encode(operatorSecret))

	const { tenantApiUrl } = resolveRegionalTenantApiUrls(region)
	return {
		jwt,
		tenantApiUrl,
		scope: input.scope,
		grants,
		scopeIds: claims.scopeIds,
		expiresAt: (issuedAt + ttlSeconds) * 1000,
		ttlSeconds,
	}
}
