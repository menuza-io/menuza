import { getUserOrganizationPermissions, isImpersonating } from '@repo/auth'
import {
	STAFF_PAY_REPORT_PERMISSION,
	type StaffingReportSubject,
} from '@repo/reports/token'
import {
	STAFFING_PERMISSIONS as P,
	type StaffingPermission,
	grantsSatisfying,
} from '@repo/staffing'
import {
	getStaffingFeatureState,
	type StaffingFeatureState,
} from '#app/utils/staffing/access.server.ts'
import { resolveStaffingScopeIds } from '#app/utils/staffing/scope-claim.server.ts'

/**
 * Which staff report subjects a person may run, decided on the App (flags and
 * permissions live here) and written into the reports token. tenant-api trusts
 * the token and applies the scope scope it carries on every query.
 *
 * Rules, in order:
 * - an impersonated (support) session gets nothing: reports hold names, hours
 *   and wages, and support never sees wages;
 * - the master `staffing.enabled` flag and the feature flag of the subject
 *   (`timeclock`, `scheduling`, `labor`, `hiring`) must be on;
 * - the person needs the permission of the subject: timesheet access for time
 *   cards, schedule access for shifts, labor access for daily labor, hiring
 *   access for applications. Time cards and shifts show names, so they need
 *   the roster grant too;
 * - one person's wages (`staff_pay`) need the pay grant and the labor flag
 *   (the same rule as the staffing tokens), and ride only with a subject that
 *   can show them;
 * - a person limited to selected scopes with none selected has no staffing
 *   access at all.
 */
export type StaffReportAccess = {
	subjects: Array<StaffingReportSubject | typeof STAFF_PAY_REPORT_PERMISSION>
	/** `null` is every scope. Always present, never widened by omission. */
	scopeIds: string[] | null
}

const NONE: StaffReportAccess = { subjects: [], scopeIds: [] }

export function staffReportAccess(input: {
	features: StaffingFeatureState
	/** `action:entity:access` strings the person holds. */
	held: ReadonlySet<string>
	scopeIds: string[] | null
	impersonated: boolean
}): StaffReportAccess {
	if (input.impersonated) return NONE
	if (!input.features.enabled) return NONE
	if (input.scopeIds !== null && input.scopeIds.length === 0) return NONE
	const holds = (permission: StaffingPermission) =>
		grantsSatisfying(permission).some((grant) => input.held.has(grant))

	const subjects: StaffReportAccess['subjects'] = []
	if (
		input.features.timeclock &&
		holds(P.READ_TIMESHEET) &&
		holds(P.READ_STAFF)
	) {
		subjects.push('time_entries')
	}
	if (
		input.features.scheduling &&
		holds(P.READ_SCHEDULE) &&
		holds(P.READ_STAFF)
	) {
		subjects.push('shifts')
	}
	if (input.features.labor && holds(P.READ_LABOR)) {
		subjects.push('labor_daily')
	}
	if (input.features.hiring && holds(P.READ_HIRING)) {
		subjects.push('applications')
	}
	if (
		subjects.includes('time_entries') &&
		input.features.labor &&
		holds(P.READ_STAFF_PAY)
	) {
		subjects.push(STAFF_PAY_REPORT_PERMISSION)
	}
	if (subjects.length === 0) return NONE
	return { subjects, scopeIds: input.scopeIds }
}

export async function resolveStaffReportAccess(input: {
	userId: string
	organizationId: string
	impersonated: boolean
}): Promise<StaffReportAccess> {
	if (input.impersonated) return NONE
	const features = await getStaffingFeatureState(input.organizationId)
	if (!features.enabled) return NONE
	const [grants, scopeIds] = await Promise.all([
		getUserOrganizationPermissions(input.userId, input.organizationId),
		resolveStaffingScopeIds(input.userId, input.organizationId),
	])
	return staffReportAccess({
		features,
		held: new Set(
			grants.map((grant) => `${grant.action}:${grant.entity}:${grant.access}`),
		),
		scopeIds,
		impersonated: false,
	})
}

/**
 * The staff report access of whoever made `request`, for the Reports screens
 * and their actions. Every one of them calls this itself: a parent loader can
 * be skipped on a data request, so none may rely on another having checked.
 */
export async function resolveStaffReportAccessForRequest(
	request: Request,
	userId: string,
	organizationId: string,
): Promise<StaffReportAccess> {
	return resolveStaffReportAccess({
		userId,
		organizationId,
		impersonated: await isImpersonating(request),
	})
}
