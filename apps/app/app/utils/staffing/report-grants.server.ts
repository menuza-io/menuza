import { isImpersonating, userHasOrganizationPermission } from '@repo/auth'
import {
	ORDER_REPORT_SUBJECTS,
	ORG_WIDE_REPORT_SUBJECTS,
	PERMISSION_GATED_REPORT_SUBJECTS,
	SALES_STAFF_FIELD_PERMISSION,
} from '@repo/reports/token'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'
import { resolveReservationsReportAccess } from '#app/utils/reservations/report-access.server.ts'
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
 * subjects with analytics, settings or website access, plus the staff and
 * Reservations subjects their grants cover. `catalogForGrants` hides every
 * gated subject missing from this list, so the Reports screens and the
 * dashboard block picker filter with it and offer only reports that will run.
 */
const SALES_STAFF_PERMISSIONS = [
	ORG_PERMISSIONS.READ_STAFF_ANY,
	ORG_PERMISSIONS.READ_TIMESHEET_ANY,
	ORG_PERMISSIONS.UPDATE_MENU_ANY,
	ORG_PERMISSIONS.UPDATE_POS_SHIFT_ANY,
] as const

/**
 * Whether this member may see cashier/staff names on Station sales and cash
 * drawer reports (`SALES_STAFF_FIELD_PERMISSION`). Never allowed when
 * impersonating or without menu/order read access.
 */
export async function canReadSalesStaffFields(
	userId: string,
	organizationId: string,
	impersonated: boolean,
): Promise<boolean> {
	if (impersonated) return false
	for (const permission of SALES_STAFF_PERMISSIONS) {
		if (
			await userHasOrganizationPermission(userId, organizationId, permission)
		) {
			return true
		}
	}
	return false
}

export async function resolveReportGrantsForRequest(
	request: Request,
	userId: string,
	organizationId: string,
): Promise<string[]> {
	const [staff, reservations, admin, canReadMenu, impersonated, pageSubjects] =
		await Promise.all([
			resolveStaffReportAccessForRequest(request, userId, organizationId),
			resolveReservationsReportAccess({ request, userId, organizationId }),
			hasAdminReportAccess(userId, organizationId),
			userHasOrganizationPermission(
				userId,
				organizationId,
				ORG_PERMISSIONS.READ_MENU_ANY,
			),
			isImpersonating(request),
			permissionGatedReportSubjects(userId, organizationId),
		])
	const canReadOrders = admin && canReadMenu
	const canReadSalesStaff =
		canReadOrders &&
		(await canReadSalesStaffFields(userId, organizationId, impersonated))
	return [
		...(admin ? ORG_WIDE_REPORT_SUBJECTS : []),
		...(canReadOrders ? ORDER_REPORT_SUBJECTS : []),
		...(canReadSalesStaff ? [SALES_STAFF_FIELD_PERMISSION] : []),
		...pageSubjects,
		...staff.subjects,
		...reservations.subjects,
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
