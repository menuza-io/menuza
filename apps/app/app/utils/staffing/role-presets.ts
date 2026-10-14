import {
	STAFFING_PERMISSIONS as P,
	type StaffingPermission,
} from '@repo/staffing'
import {
	TENANT_ROLE_PERMISSION_IDS,
	withImpliedStaffingPermissions,
} from '#app/utils/organization/tenant-role-permissions.ts'

/**
 * Staffing role presets: starting points an admin can create with one click.
 * Each becomes an ordinary, editable, tenant-owned custom role (level 0), not a
 * new built-in level, so admins can rename it, change its access, or delete it
 * like any other custom role. Creating one never changes an existing role.
 *
 * Presets only ever hold permissions from `TENANT_ROLE_PERMISSION_IDS`, and an
 * update grant always comes with the read grant it implies. Access to pay,
 * private details and time-card approval is withheld except where a preset's
 * purpose needs it; admins can tick more in the role editor.
 */

export const STAFFING_ROLE_PRESET_KEYS = [
	'shift_manager',
	'general_manager',
	'hiring_manager',
] as const
export type StaffingRolePresetKey = (typeof STAFFING_ROLE_PRESET_KEYS)[number]

export type StaffingRolePreset = {
	key: StaffingRolePresetKey
	name: string
	description: string
	permissions: readonly StaffingPermission[]
}

const SHIFT_MANAGER: readonly StaffingPermission[] = [
	P.READ_STAFF,
	P.READ_SCHEDULE,
	P.UPDATE_SCHEDULE,
	P.READ_TIMESHEET,
	P.UPDATE_TIMESHEET,
]

export const STAFFING_ROLE_PRESETS: readonly StaffingRolePreset[] = [
	{
		key: 'shift_manager',
		name: 'Shift manager',
		description:
			'Runs the floor: sees the team, builds and publishes schedules, and fixes time cards. No pay, private details, or approvals.',
		permissions: SHIFT_MANAGER,
	},
	{
		key: 'general_manager',
		name: 'General manager',
		description:
			'Everything a shift manager can do, plus managing the team, pay rates, labor cost, time card approval, and hiring.',
		permissions: [
			...SHIFT_MANAGER,
			P.UPDATE_STAFF,
			P.READ_STAFF_PAY,
			P.UPDATE_STAFF_PAY,
			P.READ_LABOR,
			P.APPROVE_TIMESHEET,
			P.READ_HIRING,
			P.UPDATE_HIRING,
		],
	},
	{
		key: 'hiring_manager',
		name: 'Hiring manager',
		description:
			'Posts jobs and moves applicants through hiring. Can see the team but not schedules, time cards, or pay.',
		permissions: [P.READ_STAFF, P.READ_HIRING, P.UPDATE_HIRING],
	},
]

/** `read:staff:any` becomes `org_perm_read_staff_any`. */
export function permissionIdFor(permission: StaffingPermission): string {
	const [action, entity, access] = permission.split(':')
	return `org_perm_${action}_${entity}_${access}`
}

/**
 * The stored permission ids for a preset: implied read grants added, only ids a
 * custom role may hold, sorted for stable output. Throws if a preset ever names
 * something a custom role cannot hold, so a bad edit fails in tests, not in an
 * admin's browser.
 */
export function presetPermissionIds(preset: StaffingRolePreset): string[] {
	const ids = withImpliedStaffingPermissions(
		preset.permissions.map(permissionIdFor),
	)
	const allowed = new Set<string>(TENANT_ROLE_PERMISSION_IDS)
	for (const id of ids) {
		if (!allowed.has(id)) {
			throw new Error(`Preset ${preset.key} uses a non-grantable permission`)
		}
	}
	return ids.sort()
}

export function isStaffingRolePresetKey(
	value: unknown,
): value is StaffingRolePresetKey {
	return (
		typeof value === 'string' &&
		(STAFFING_ROLE_PRESET_KEYS as readonly string[]).includes(value)
	)
}

export function getStaffingRolePreset(
	key: StaffingRolePresetKey,
): StaffingRolePreset {
	return STAFFING_ROLE_PRESETS.find((preset) => preset.key === key)!
}
