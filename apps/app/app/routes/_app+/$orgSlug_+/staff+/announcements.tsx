import { useLoaderData } from 'react-router'
import { AnnouncementsPage } from '#app/components/staff/announcements/announcements-page.tsx'
import { requireStaffingAccess } from '#app/utils/staffing/access.server.ts'
import { STAFF_SECTION_REQUIREMENTS } from '#app/utils/staffing/sections.ts'
import { loadTimeclockScopes } from '#app/utils/staffing/timeclock-context.server.ts'
import { type Route } from './+types/announcements.ts'

/**
 * Announcements to staff (#486). The loader checks who may look and names the
 * workplaces they can reach; every announcement and every "Got it" is fetched
 * from the regional node by the browser, so what staff read and who read it
 * never passes through the control plane.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireStaffingAccess(
		request,
		params.orgSlug,
		STAFF_SECTION_REQUIREMENTS.team,
	)
	return {
		orgSlug: params.orgSlug,
		scopes: await loadTimeclockScopes(access.organizationId, access.scopeIds),
	}
}

export default function StaffAnnouncementsRoute() {
	const { orgSlug, scopes } = useLoaderData<typeof loader>()
	return <AnnouncementsPage orgSlug={orgSlug} scopes={scopes} />
}
