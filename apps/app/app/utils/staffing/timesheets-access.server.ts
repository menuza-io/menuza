import { STAFFING_PERMISSIONS as P } from '@repo/staffing'
import { requireStaffingAccess } from '#app/utils/staffing/access.server.ts'
import {
	holdsStaffingGrant,
	TIMESHEETS_REQUIREMENT,
	TIMESHEETS_WRITE_REQUIREMENT,
} from '#app/utils/staffing/sections.ts'

/**
 * The guard every timesheet loader calls first (parent loaders can be skipped,
 * so each route repeats it): the `staffing.timeclock` flag (404 while off),
 * `read:timesheet:any`, and `read:staff:any` because names come from the roster
 * (403 without either). `write` also asks for `update:timesheet:any`.
 */
export async function requireTimesheetsAccess(
	request: Request,
	orgSlug: string | undefined,
	options: { write?: boolean } = {},
) {
	const access = await requireStaffingAccess(
		request,
		orgSlug,
		options.write ? TIMESHEETS_WRITE_REQUIREMENT : TIMESHEETS_REQUIREMENT,
	)
	if (!holdsStaffingGrant(access.grants, P.READ_STAFF)) {
		throw new Response(`Forbidden: requires ${P.READ_STAFF}`, { status: 403 })
	}
	return access
}
