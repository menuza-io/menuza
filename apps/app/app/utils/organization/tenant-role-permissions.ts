/**
 * The only permissions organization administrators may assign to a custom role.
 * Keep this list in product language at the UI boundary; IDs are intentionally
 * kept server-side so a crafted form cannot grant platform capabilities.
 */
export const TENANT_ROLE_PERMISSION_IDS = [
	'org_perm_create_note_own',
	'org_perm_read_note_own',
	'org_perm_read_note_org',
	'org_perm_update_note_own',
	'org_perm_update_note_org',
	'org_perm_delete_note_own',
	'org_perm_delete_note_org',
	'org_perm_read_member_any',
	'org_perm_create_member_any',
	'org_perm_delete_member_any',
	'org_perm_read_settings_any',
	'org_perm_update_settings_any',
	'org_perm_read_website_any',
	'org_perm_update_website_any',
	'org_perm_read_announcement_any',
	'org_perm_update_announcement_any',
	'org_perm_read_campaign_any',
	'org_perm_update_campaign_any',
	'org_perm_read_automation_any',
	'org_perm_update_automation_any',
	'org_perm_read_menu_any',
	'org_perm_update_menu_any',
	'org_perm_update_chat_any',
	'org_perm_create_chat_group',
	'org_perm_read_phone_agent_any',
	'org_perm_update_phone_agent_any',
	'org_perm_read_phone_call_any',
	'org_perm_update_phone_call_any',
	'org_perm_delete_phone_call_any',
	'org_perm_read_staff_any',
	'org_perm_update_staff_any',
	'org_perm_read_staff_pay_any',
	'org_perm_update_staff_pay_any',
	'org_perm_read_staff_private_any',
	'org_perm_update_staff_private_any',
	'org_perm_read_schedule_any',
	'org_perm_update_schedule_any',
	'org_perm_read_schedule_own',
	'org_perm_create_timeclock_own',
	'org_perm_read_timesheet_any',
	'org_perm_update_timesheet_any',
	'org_perm_approve_timesheet_any',
	'org_perm_read_labor_any',
	'org_perm_read_labor_policy_any',
	'org_perm_update_labor_policy_any',
	'org_perm_read_hiring_any',
	'org_perm_update_hiring_any',
] as const

export type TenantRolePermissionId = (typeof TENANT_ROLE_PERMISSION_IDS)[number]

export function hasOnlyTenantRolePermissions(permissionIds: string[]) {
	const allowed = new Set<string>(TENANT_ROLE_PERMISSION_IDS)
	return permissionIds.every((permissionId) => allowed.has(permissionId))
}

/**
 * Staffing grants where holding the first permission is meaningless without
 * the second: editing something requires being able to see it. The role editor
 * applies this as the user ticks boxes; role save actions re-apply it so a
 * crafted form cannot store an update grant without its read grant.
 * `approve:timesheet` needs `read:timesheet` for the same reason.
 */
export const STAFFING_IMPLIED_PERMISSION_IDS: Record<
	string,
	readonly string[]
> = {
	org_perm_update_staff_any: ['org_perm_read_staff_any'],
	org_perm_update_staff_pay_any: ['org_perm_read_staff_pay_any'],
	org_perm_update_staff_private_any: ['org_perm_read_staff_private_any'],
	org_perm_update_schedule_any: ['org_perm_read_schedule_any'],
	org_perm_update_timesheet_any: ['org_perm_read_timesheet_any'],
	org_perm_approve_timesheet_any: ['org_perm_read_timesheet_any'],
	org_perm_update_labor_policy_any: ['org_perm_read_labor_policy_any'],
	org_perm_update_hiring_any: ['org_perm_read_hiring_any'],
}

/**
 * Add every read grant implied by a staffing update/approve grant. Returns a
 * de-duplicated list; permission ids outside the staffing set are untouched.
 */
export function withImpliedStaffingPermissions(
	permissionIds: readonly string[],
): string[] {
	const result = new Set(permissionIds)
	for (const id of permissionIds) {
		for (const implied of STAFFING_IMPLIED_PERMISSION_IDS[id] ?? []) {
			result.add(implied)
		}
	}
	return [...result]
}
