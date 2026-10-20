import { useLoaderData } from 'react-router'
import { KioskManager } from '#app/components/staff/kiosk-manager.tsx'
import { requireStaffingAccess } from '#app/utils/staffing/access.server.ts'
import { TIMECLOCK_SETTINGS_REQUIREMENT } from '#app/utils/staffing/sections.ts'
import { loadTimeclockScopes } from '#app/utils/staffing/timeclock-context.server.ts'
import { type Route } from './+types/timeclock.tablets.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireStaffingAccess(
		request,
		params.orgSlug,
		TIMECLOCK_SETTINGS_REQUIREMENT,
	)
	return {
		scopes: await loadTimeclockScopes(access.organizationId, access.scopeIds),
	}
}

export default function StaffTimeclockTabletsRoute() {
	const { scopes } = useLoaderData<typeof loader>()
	return <KioskManager scopes={scopes} />
}
