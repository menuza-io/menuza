import {
	grantsSatisfying,
	STAFFING_PERMISSIONS,
	type StaffingPermission,
} from '@repo/staffing'

/** Permissions that, with the master flag, open the Staff section at all. */
export const STAFF_SECTION_PERMISSIONS: readonly StaffingPermission[] = [
	STAFFING_PERMISSIONS.READ_STAFF,
	STAFFING_PERMISSIONS.READ_TIMESHEET,
	STAFFING_PERMISSIONS.READ_LABOR_POLICY,
	STAFFING_PERMISSIONS.READ_SCHEDULE,
	STAFFING_PERMISSIONS.READ_LABOR,
	STAFFING_PERMISSIONS.READ_HIRING,
]

/**
 * Flag and permission requirement for each Staff section. The sidebar, the
 * route loaders, and the tests all read from this table so they cannot drift.
 */
export const STAFF_SECTION_REQUIREMENTS = {
	team: {
		feature: 'enabled',
		anyOf: [STAFFING_PERMISSIONS.READ_STAFF],
	},
	timeclock: {
		feature: 'timeclock',
		anyOf: [
			STAFFING_PERMISSIONS.READ_TIMESHEET,
			STAFFING_PERMISSIONS.READ_LABOR_POLICY,
		],
	},
	schedule: {
		feature: 'scheduling',
		anyOf: [STAFFING_PERMISSIONS.READ_SCHEDULE],
	},
	// Labor cost, sales and tips. Needs the `staffing.labor` flag and the
	// aggregate labor grant (a pay grant alone is not enough: it opens one
	// person's wage, not the labor view).
	labor: {
		feature: 'labor',
		anyOf: [STAFFING_PERMISSIONS.READ_LABOR],
	},
	hiring: {
		feature: 'hiring',
		anyOf: [STAFFING_PERMISSIONS.READ_HIRING],
	},
} as const

/** Screens that change staff data need the write grant, not just the read grant. */
export const STAFF_WRITE_REQUIREMENT = {
	feature: 'enabled',
	anyOf: [STAFFING_PERMISSIONS.UPDATE_STAFF],
} as const

/**
 * The Time clock page has two halves with different grants: today's status
 * (punch data) and settings (labor rules and tablets). Both need the
 * `staffing.timeclock` flag.
 */
export const TIMECLOCK_TODAY_REQUIREMENT = {
	feature: 'timeclock',
	anyOf: [STAFFING_PERMISSIONS.READ_TIMESHEET],
} as const

/**
 * Timesheets show names from the roster, so they need `read:staff:any` besides
 * `read:timesheet:any` (the regional API asks for both). Adding or editing a
 * card needs the write grant on top.
 */
export const TIMESHEETS_REQUIREMENT = {
	feature: 'timeclock',
	anyOf: [STAFFING_PERMISSIONS.READ_TIMESHEET],
} as const

export const TIMESHEETS_WRITE_REQUIREMENT = {
	feature: 'timeclock',
	anyOf: [STAFFING_PERMISSIONS.UPDATE_TIMESHEET],
} as const

export const TIMECLOCK_SETTINGS_REQUIREMENT = {
	feature: 'timeclock',
	anyOf: [STAFFING_PERMISSIONS.READ_LABOR_POLICY],
} as const

/** Changing the organization's staff time zone needs the labor policy grant. */
export const TIMEZONE_WRITE_REQUIREMENT = {
	feature: 'timeclock',
	anyOf: [STAFFING_PERMISSIONS.UPDATE_LABOR_POLICY],
} as const

/** Saving a day's sales or an import needs the timesheet edit grant as well. */
export const LABOR_SALES_WRITE_REQUIREMENT = {
	feature: 'labor',
	anyOf: [STAFFING_PERMISSIONS.UPDATE_TIMESHEET],
} as const

/**
 * Creating, editing, publishing and deleting job postings. Postings are
 * control-plane content, so they need no regional token: the grant is checked
 * by each loader and action here.
 */
export const HIRING_WRITE_REQUIREMENT = {
	feature: 'hiring',
	anyOf: [STAFFING_PERMISSIONS.UPDATE_HIRING],
} as const

/**
 * Whether `grants` (rows from `requireStaffingAccess`) hold `permission` or a
 * stronger grant that implies it. Used to decide which half of a screen to show.
 */
export function holdsStaffingGrant(
	grants: ReadonlyArray<{ action: string; entity: string; access: string }>,
	permission: StaffingPermission,
): boolean {
	const held = new Set(
		grants.map((grant) => `${grant.action}:${grant.entity}:${grant.access}`),
	)
	return grantsSatisfying(permission).some((grant) => held.has(grant))
}
