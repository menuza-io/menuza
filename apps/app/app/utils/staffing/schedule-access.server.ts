import { STAFFING_PERMISSIONS as P } from '@repo/staffing'
import { requireStaffingAccess } from '#app/utils/staffing/access.server.ts'
import {
	holdsStaffingGrant,
	STAFF_SECTION_REQUIREMENTS,
} from '#app/utils/staffing/sections.ts'

/**
 * The guard every schedule loader calls first (parent loaders can be skipped,
 * so each route repeats it): the `staffing.scheduling` flag (404 while off),
 * `read:schedule:any`, and `read:staff:any` because the grid names people from
 * the roster (403 without either).
 */
export async function requireScheduleAccess(
	request: Request,
	orgSlug: string | undefined,
) {
	const access = await requireStaffingAccess(
		request,
		orgSlug,
		STAFF_SECTION_REQUIREMENTS.schedule,
	)
	if (!holdsStaffingGrant(access.grants, P.READ_STAFF)) {
		throw new Response(`Forbidden: requires ${P.READ_STAFF}`, { status: 403 })
	}
	return access
}
