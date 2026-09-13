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
] as const

export type TenantRolePermissionId = (typeof TENANT_ROLE_PERMISSION_IDS)[number]

export function hasOnlyTenantRolePermissions(permissionIds: string[]) {
	const allowed = new Set<string>(TENANT_ROLE_PERMISSION_IDS)
	return permissionIds.every((permissionId) => allowed.has(permissionId))
}
