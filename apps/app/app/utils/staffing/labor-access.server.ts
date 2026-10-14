import { STAFFING_PERMISSIONS as P } from '@repo/staffing'
import { requireStaffingAccess } from '#app/utils/staffing/access.server.ts'
import {
	holdsStaffingGrant,
	STAFF_SECTION_REQUIREMENTS,
} from '#app/utils/staffing/sections.ts'

/**
 * The guard the Labor loader calls first: the `staffing.labor` flag (404 while
 * off) and `read:labor:any` (403 without it). The page also learns which parts
 * the member may use: entering sales and changing settings need their own
 * update grants, and the tip report needs the pay and roster grants because it
 * names people and amounts. Only booleans leave the server; the regional node
 * enforces every one of them again on each request.
 */
export async function requireLaborAccess(
	request: Request,
	orgSlug: string | undefined,
) {
	const access = await requireStaffingAccess(
		request,
		orgSlug,
		STAFF_SECTION_REQUIREMENTS.labor,
	)
	const has = (permission: Parameters<typeof holdsStaffingGrant>[1]) =>
		holdsStaffingGrant(access.grants, permission)
	return {
		...access,
		can: {
			editSales: has(P.UPDATE_TIMESHEET),
			editSettings: has(P.UPDATE_LABOR_POLICY),
			seeTips: has(P.READ_STAFF_PAY) && has(P.READ_STAFF),
		},
	}
}
