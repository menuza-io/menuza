import { userHasOrganizationPermission } from '@repo/auth'
import {
	ORG_WIDE_REPORT_SUBJECTS,
	PERMISSION_GATED_REPORT_SUBJECTS,
} from '@repo/reports/token'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'
import { resolveStaffReportAccessForRequest } from './report-access.server.ts'

/**
 * Permissions that open organization-wide reports (customers, shop orders).
 * A staffing manager holding only staff report grants has none of them and
 * gets a reports token limited to their own staff subjects.
 */
export const REPORT_ADMIN_PERMISSIONS = [
	ORG_PERMISSIONS.READ_ANALYTICS_ANY,
	ORG_PERMISSIONS.READ_SETTINGS_ANY,
	ORG_PERMISSIONS.READ_WEBSITE_ANY,
]

export async function hasAdminReportAccess(
	userId: string,
	organizationId: string,
): Promise<boolean> {
	for (const permission of REPORT_ADMIN_PERMISSIONS) {
		if (
			await userHasOrganizationPermission(userId, organizationId, permission)
		) {
			return true
		}
	}
	return false
}

/**
 * The restricted report subjects a person may run, as the reports token lists
 * them (minus phone calls, which the token route adds): the organization-wide
 * subjects with analytics, settings or website access, plus the staff
 * subjects their staffing grants cover. The Reports screens and the dashboard
 * block picker filter with this so they offer only reports that will run.
 */
export async function resolveReportGrantsForRequest(
	request: Request,
	userId: string,
	organizationId: string,
): Promise<string[]> {
	const [staff, admin, pageSubjects] = await Promise.all([
		resolveStaffReportAccessForRequest(request, userId, organizationId),
		hasAdminReportAccess(userId, organizationId),
		permissionGatedReportSubjects(userId, organizationId),
	])
	return [
		...(admin ? ORG_WIDE_REPORT_SUBJECTS : []),
		...pageSubjects,
		...staff.subjects,
	]
}

/**
 * Members and notes reports need the permission their app page needs
 * (`read:member:any`, `read:note:own`).
 */
export async function permissionGatedReportSubjects(
	userId: string,
	organizationId: string,
): Promise<string[]> {
	const entries = Object.entries(PERMISSION_GATED_REPORT_SUBJECTS)
	const allowed = await Promise.all(
		entries.map(([, permission]) =>
			userHasOrganizationPermission(userId, organizationId, permission),
		),
	)
	return entries
		.filter((_, index) => allowed[index])
		.map(([subject]) => subject)
}
