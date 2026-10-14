import { isImpersonating } from '@repo/auth'
import { staffingScopeSchema, type StaffingScope } from '@repo/staffing'
import { data, type LoaderFunctionArgs } from 'react-router'
import {
	getStaffingFeatureState,
	requireStaffingAccess,
} from '#app/utils/staffing/access.server.ts'
import { STAFF_SECTION_REQUIREMENTS } from '#app/utils/staffing/sections.ts'
import {
	grantStrings,
	mintStaffingToken,
	selectGrantsForScope,
} from '#app/utils/staffing/token.server.ts'

/** The Staff section whose flag and permission gate each token scope. */
const SCOPE_SECTION: Record<
	StaffingScope,
	keyof typeof STAFF_SECTION_REQUIREMENTS
> = {
	staff: 'team',
	timeclock: 'timeclock',
	schedule: 'schedule',
	labor: 'labor',
	hiring: 'hiring',
}

/**
 * Credentials for browser-direct staff calls: `GET /:orgSlug/staff/token` (the
 * `scope` query is `staff` by default).
 *
 * Gate order mirrors every other staffing loader: signed-in active member (404
 * otherwise), the section's feature flags (404 while off), then permission
 * (403). Only after all three does the App sign a token, so a token can never
 * exist for an organization whose flag is off. tenant-api trusts what is
 * minted here and does no flag lookup of its own.
 *
 * The token carries the member's scope scope (`scopeIds`, `null` for
 * every workplace) read from the control plane at mint time; tenant-api applies
 * it on every route. A scope change therefore reaches an already-minted token
 * only when that token expires (15 minutes, 5 with pay or private grants).
 *
 * Nothing about staff is read here: no names, rates or times. The response is
 * a bearer token, the regional URL, its expiry, the grants it carries, and the
 * scope ids it is limited to.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
	const rawScope = new URL(request.url).searchParams.get('scope') ?? 'staff'
	const parsedScope = staffingScopeSchema.safeParse(rawScope)
	if (!parsedScope.success) {
		throw data({ error: 'Unknown workplace' }, { status: 400 })
	}
	const scope = parsedScope.data
	const requirement = STAFF_SECTION_REQUIREMENTS[SCOPE_SECTION[scope]]

	const access = await requireStaffingAccess(request, params.orgSlug, {
		feature: requirement.feature,
		anyOf: requirement.anyOf,
	})
	const features = await getStaffingFeatureState(access.organizationId)
	const grants = selectGrantsForScope(
		grantStrings(access.grants),
		scope,
		features,
	)
	const minted = await mintStaffingToken({
		organizationId: access.organizationId,
		userId: access.userId,
		dataRegion: access.dataRegion,
		scope,
		grants,
		scopeIds: access.scopeIds,
		impersonated: await isImpersonating(request),
	})

	return data(
		{
			jwt: minted.jwt,
			tenantApiUrl: minted.tenantApiUrl,
			scope: minted.scope,
			grants: minted.grants,
			scopeIds: minted.scopeIds,
			expiresAt: minted.expiresAt,
		},
		{ headers: { 'Cache-Control': 'private, no-store' } },
	)
}
