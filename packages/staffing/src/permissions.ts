/**
 * Staffing permission strings (`action:entity:access`). These mirror
 * `ORG_PERMISSIONS` in `@repo/auth`; a unit test in the App keeps the two lists
 * identical. Kept here as plain strings so tenant-api and the App can share the
 * grant names carried inside operator tokens without importing server code.
 */
export const STAFFING_PERMISSIONS = {
	READ_STAFF: 'read:staff:any',
	UPDATE_STAFF: 'update:staff:any',
	READ_STAFF_PAY: 'read:staff_pay:any',
	UPDATE_STAFF_PAY: 'update:staff_pay:any',
	READ_STAFF_PRIVATE: 'read:staff_private:any',
	UPDATE_STAFF_PRIVATE: 'update:staff_private:any',
	READ_SCHEDULE: 'read:schedule:any',
	UPDATE_SCHEDULE: 'update:schedule:any',
	READ_SCHEDULE_OWN: 'read:schedule:own',
	CREATE_TIMECLOCK_OWN: 'create:timeclock:own',
	READ_TIMESHEET: 'read:timesheet:any',
	UPDATE_TIMESHEET: 'update:timesheet:any',
	APPROVE_TIMESHEET: 'approve:timesheet:any',
	READ_LABOR: 'read:labor:any',
	READ_LABOR_POLICY: 'read:labor_policy:any',
	UPDATE_LABOR_POLICY: 'update:labor_policy:any',
	READ_HIRING: 'read:hiring:any',
	UPDATE_HIRING: 'update:hiring:any',
} as const

export type StaffingPermission =
	(typeof STAFFING_PERMISSIONS)[keyof typeof STAFFING_PERMISSIONS]

export const STAFFING_PERMISSION_LIST = Object.values(
	STAFFING_PERMISSIONS,
) as StaffingPermission[]

/** Grants that unlock wage or personal data and so get the shorter token TTL. */
export const STAFFING_SENSITIVE_GRANTS: readonly StaffingPermission[] = [
	STAFFING_PERMISSIONS.READ_STAFF_PAY,
	STAFFING_PERMISSIONS.UPDATE_STAFF_PAY,
	STAFFING_PERMISSIONS.READ_STAFF_PRIVATE,
	STAFFING_PERMISSIONS.UPDATE_STAFF_PRIVATE,
]

export function isStaffingPermission(
	value: unknown,
): value is StaffingPermission {
	return (
		typeof value === 'string' &&
		(STAFFING_PERMISSION_LIST as string[]).includes(value)
	)
}

/** Seconds an operator token lives; shorter when it carries pay or private grants. */
export const STAFFING_TOKEN_TTL_SECONDS = 15 * 60
export const STAFFING_SENSITIVE_TOKEN_TTL_SECONDS = 5 * 60

export function staffingTokenTtlSeconds(
	grants: readonly string[],
	opts: { impersonated?: boolean } = {},
): number {
	if (opts.impersonated) return STAFFING_SENSITIVE_TOKEN_TTL_SECONDS
	const sensitive = grants.some((grant) =>
		(STAFFING_SENSITIVE_GRANTS as readonly string[]).includes(grant),
	)
	return sensitive
		? STAFFING_SENSITIVE_TOKEN_TTL_SECONDS
		: STAFFING_TOKEN_TTL_SECONDS
}

/**
 * Impersonated sessions get read-only staffing tokens: no write grants and no
 * pay or private grants (they also cannot pair kiosks or reset PINs).
 */
export function restrictGrantsForImpersonation(
	grants: readonly StaffingPermission[],
): StaffingPermission[] {
	return grants.filter(
		(grant) =>
			!grant.startsWith('update:') &&
			!grant.startsWith('create:') &&
			!grant.startsWith('approve:') &&
			!(STAFFING_SENSITIVE_GRANTS as readonly string[]).includes(grant),
	)
}

/**
 * Stronger grants that also satisfy a read requirement. The role editor and the
 * role save actions enforce "update implies read", so a stored role never holds
 * one without the other; this table lets runtime checks accept the stronger
 * grant on its own as well (defense in depth for roles written before the
 * rule, or by hand).
 */
const STRONGER_GRANTS: Partial<
	Record<StaffingPermission, StaffingPermission[]>
> = {
	'read:staff:any': ['update:staff:any'],
	'read:staff_pay:any': ['update:staff_pay:any'],
	'read:staff_private:any': ['update:staff_private:any'],
	'read:schedule:any': ['update:schedule:any'],
	'read:timesheet:any': ['update:timesheet:any', 'approve:timesheet:any'],
	'read:labor_policy:any': ['update:labor_policy:any'],
	'read:hiring:any': ['update:hiring:any'],
}

/** Every grant that satisfies `required`, the grant itself first. */
export function grantsSatisfying(
	required: StaffingPermission,
): StaffingPermission[] {
	return [required, ...(STRONGER_GRANTS[required] ?? [])]
}
