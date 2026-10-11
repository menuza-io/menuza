import {
	STAFFING_SCOPE,
	STAFFING_TOKEN_MAX_LOCATIONS,
	type StaffingTokenClaims,
} from '@repo/staffing'
import { data, type LoaderFunctionArgs } from 'react-router'
import { getStaffingAccess } from '#app/utils/staffing/access.server.ts'
import { loadStaffingLocations } from '#app/utils/staffing/locations.server.ts'
import { getOperatorTenantClient } from '#app/utils/tenant-api.server.ts'

/**
 * Mints a short-lived staffing credential for the browser. Staff data never
 * transits App: the browser calls the organization's regional tenant-api.
 * The flag and permissions are re-checked on every mint, so turning the flag
 * off or revoking a role stops new credentials within one token lifetime.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
	const orgSlug = params.orgSlug || ''
	const access = await getStaffingAccess(request, orgSlug)
	if (!access.flags.enabled) throw new Response('Not found', { status: 404 })
	const areas: StaffingTokenClaims['areas'] = {}
	for (const [area, level] of Object.entries(access.grants)) {
		if (level) areas[area as keyof typeof areas] = level
	}
	if (Object.keys(areas).length === 0) {
		throw new Response('Forbidden', { status: 403 })
	}
	const locations = (await loadStaffingLocations(access.orgId))
		.slice(0, STAFFING_TOKEN_MAX_LOCATIONS)
		.map((location) => ({ id: location.id, tz: location.timezone }))
	const claims = {
		areas,
		// Location-scoped managers are not modeled yet: every grant is org-wide.
		locationIds: null,
		locations,
		canViewPay: access.canViewPay,
	} satisfies Omit<StaffingTokenClaims, 'scope'>
	const { jwt, tenantApiUrl } = await getOperatorTenantClient(
		request,
		orgSlug,
		{ scope: STAFFING_SCOPE, claims },
	)
	return data(
		{ jwt, tenantApiUrl, areas, canViewPay: access.canViewPay },
		{ headers: { 'Cache-Control': 'private, no-store' } },
	)
}
