import { STAFFING_PERMISSIONS as P } from '@repo/staffing'
import { redirect, useLoaderData } from 'react-router'
import { TimeclockToday } from '#app/components/staff/timeclock-today.tsx'
import { requireStaffingAccess } from '#app/utils/staffing/access.server.ts'
import {
	holdsStaffingGrant,
	STAFF_SECTION_REQUIREMENTS,
	TIMECLOCK_TODAY_REQUIREMENT,
} from '#app/utils/staffing/sections.ts'
import { loadTimeclockScopes } from '#app/utils/staffing/timeclock-context.server.ts'
import { type Route } from './+types/timeclock._index.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	// Someone who can only manage tablets and rules lands on those instead of a
	// 403 on the section's front door.
	const section = await requireStaffingAccess(
		request,
		params.orgSlug,
		STAFF_SECTION_REQUIREMENTS.timeclock,
	)
	if (!holdsStaffingGrant(section.grants, P.READ_TIMESHEET)) {
		throw redirect(`/${params.orgSlug}/staff/timeclock/tablets`)
	}
	const access = await requireStaffingAccess(
		request,
		params.orgSlug,
		TIMECLOCK_TODAY_REQUIREMENT,
	)
	return {
		orgSlug: params.orgSlug,
		scopes: await loadTimeclockScopes(access.organizationId, access.scopeIds),
		canManageTablets: holdsStaffingGrant(access.grants, P.READ_LABOR_POLICY),
	}
}

export default function StaffTimeclockTodayRoute() {
	const { orgSlug, scopes, canManageTablets } = useLoaderData<typeof loader>()
	return (
		<TimeclockToday
			orgSlug={orgSlug}
			scopes={scopes}
			canManageTablets={canManageTablets}
		/>
	)
}
