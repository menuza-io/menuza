import {
	and,
	db,
	eq,
	OrganizationRole,
	Permission,
	Role,
	_OrganizationPermissionToRole,
	_PermissionToRole,
} from './db.server.ts'

const ORG_ROLES = [
	{
		id: 'org_role_admin',
		name: 'admin',
		description: 'Full access to organization settings and members',
		level: 4,
	},
	{
		id: 'org_role_member',
		name: 'member',
		description: 'Standard organization member with note access',
		level: 3,
	},
	{
		id: 'org_role_viewer',
		name: 'viewer',
		description: 'Read-only access to organization notes',
		level: 2,
	},
	{
		id: 'org_role_guest',
		name: 'guest',
		description: 'Limited access for temporary collaborators',
		level: 1,
	},
] as const

const ORG_PERMISSIONS = [
	{
		id: 'org_perm_create_note_own',
		action: 'create',
		entity: 'note',
		access: 'own',
		context: 'organization',
		description: 'Create notes within organization',
	},
	{
		id: 'org_perm_read_note_own',
		action: 'read',
		entity: 'note',
		access: 'own',
		context: 'organization',
		description: 'Read own notes within organization',
	},
	{
		id: 'org_perm_read_note_org',
		action: 'read',
		entity: 'note',
		access: 'org',
		context: 'organization',
		description: 'Read organization notes',
	},
	{
		id: 'org_perm_update_note_own',
		action: 'update',
		entity: 'note',
		access: 'own',
		context: 'organization',
		description: 'Update own notes within organization',
	},
	{
		id: 'org_perm_update_note_org',
		action: 'update',
		entity: 'note',
		access: 'org',
		context: 'organization',
		description: 'Update organization notes',
	},
	{
		id: 'org_perm_delete_note_own',
		action: 'delete',
		entity: 'note',
		access: 'own',
		context: 'organization',
		description: 'Delete own notes within organization',
	},
	{
		id: 'org_perm_delete_note_org',
		action: 'delete',
		entity: 'note',
		access: 'org',
		context: 'organization',
		description: 'Delete organization notes',
	},
	{
		id: 'org_perm_read_member_any',
		action: 'read',
		entity: 'member',
		access: 'any',
		context: 'organization',
		description: 'View organization members',
	},
	{
		id: 'org_perm_create_member_any',
		action: 'create',
		entity: 'member',
		access: 'any',
		context: 'organization',
		description: 'Invite new organization members',
	},
	{
		id: 'org_perm_update_member_any',
		action: 'update',
		entity: 'member',
		access: 'any',
		context: 'organization',
		description: 'Update organization member roles',
	},
	{
		id: 'org_perm_delete_member_any',
		action: 'delete',
		entity: 'member',
		access: 'any',
		context: 'organization',
		description: 'Remove organization members',
	},
	{
		id: 'org_perm_update_settings_any',
		action: 'update',
		entity: 'settings',
		access: 'any',
		context: 'organization',
		description: 'Update organization settings',
	},
	{
		id: 'org_perm_read_settings_any',
		action: 'read',
		entity: 'settings',
		access: 'any',
		context: 'organization',
		description: 'View organization settings',
	},
	{
		id: 'org_perm_read_website_any',
		action: 'read',
		entity: 'website',
		access: 'any',
		context: 'organization',
		description: 'View website pages, forms, redirects, and analytics',
	},
	{
		id: 'org_perm_update_website_any',
		action: 'update',
		entity: 'website',
		access: 'any',
		context: 'organization',
		description: 'Edit website pages, forms, redirects, and translations',
	},
	{
		id: 'org_perm_read_announcement_any',
		action: 'read',
		entity: 'announcement',
		access: 'any',
		context: 'organization',
		description: 'View website announcements',
	},
	{
		id: 'org_perm_update_announcement_any',
		action: 'update',
		entity: 'announcement',
		access: 'any',
		context: 'organization',
		description: 'Create, edit, publish, and delete website announcements',
	},
	{
		id: 'org_perm_read_campaign_any',
		action: 'read',
		entity: 'campaign',
		access: 'any',
		context: 'organization',
		description: 'View marketing broadcasts',
	},
	{
		id: 'org_perm_update_campaign_any',
		action: 'update',
		entity: 'campaign',
		access: 'any',
		context: 'organization',
		description: 'Create and send marketing broadcasts',
	},
	{
		id: 'org_perm_read_automation_any',
		action: 'read',
		entity: 'automation',
		access: 'any',
		context: 'organization',
		description: 'View marketing automations',
	},
	{
		id: 'org_perm_update_automation_any',
		action: 'update',
		entity: 'automation',
		access: 'any',
		context: 'organization',
		description: 'Create, edit, publish, and delete marketing automations',
	},
] as const

const SYSTEM_PERMISSIONS = [
	{
		id: 'sys_perm_read_platform_campaign_any',
		action: 'read',
		entity: 'platform_campaign',
		access: 'any',
		context: 'system',
		description: 'View platform broadcasts',
	},
	{
		id: 'sys_perm_update_platform_campaign_any',
		action: 'update',
		entity: 'platform_campaign',
		access: 'any',
		context: 'system',
		description: 'Create and send platform broadcasts',
	},
	{
		id: 'sys_perm_read_platform_automation_any',
		action: 'read',
		entity: 'platform_automation',
		access: 'any',
		context: 'system',
		description: 'View platform automations',
	},
	{
		id: 'sys_perm_update_platform_automation_any',
		action: 'update',
		entity: 'platform_automation',
		access: 'any',
		context: 'system',
		description: 'Create, edit, publish, and delete platform automations',
	},
] as const

const ADMIN_PERMISSION_IDS = ORG_PERMISSIONS.map((permission) => permission.id)

const MEMBER_PERMISSION_IDS = [
	'org_perm_create_note_own',
	'org_perm_read_note_own',
	'org_perm_read_note_org',
	'org_perm_update_note_own',
	'org_perm_delete_note_own',
	'org_perm_read_member_any',
	'org_perm_read_campaign_any',
	'org_perm_read_automation_any',
] as const

const VIEWER_PERMISSION_IDS = [
	'org_perm_read_note_own',
	'org_perm_read_note_org',
	'org_perm_read_member_any',
	'org_perm_read_campaign_any',
	'org_perm_read_automation_any',
] as const

async function ensureRole(name: string, description: string) {
	const [existing] = await db
		.select({ id: Role.id })
		.from(Role)
		.where(eq(Role.name, name))
		.limit(1)
	if (existing) return
	await db.insert(Role).values({ name, description })
	console.log(`Created ${name} role`)
}

async function ensureOrgRole(role: (typeof ORG_ROLES)[number]) {
	const [existing] = await db
		.select({ id: OrganizationRole.id })
		.from(OrganizationRole)
		.where(eq(OrganizationRole.id, role.id))
		.limit(1)
	if (existing) return
	await db.insert(OrganizationRole).values({ ...role, organizationId: null })
}

type PermissionSeed = {
	id: string
	action: string
	entity: string
	access: string
	context: string
	description: string
}

async function ensurePermission(permission: PermissionSeed) {
	const [existing] = await db
		.select({ id: Permission.id })
		.from(Permission)
		.where(eq(Permission.id, permission.id))
		.limit(1)
	if (existing) return
	await db.insert(Permission).values(permission)
}

async function ensureOrgRolePermission(roleId: string, permissionId: string) {
	const [pair] = await db
		.select({
			A: _OrganizationPermissionToRole.A,
			B: _OrganizationPermissionToRole.B,
		})
		.from(_OrganizationPermissionToRole)
		.where(
			and(
				eq(_OrganizationPermissionToRole.A, roleId),
				eq(_OrganizationPermissionToRole.B, permissionId),
			),
		)
		.limit(1)
	if (pair) return
	await db
		.insert(_OrganizationPermissionToRole)
		.values({ A: roleId, B: permissionId })
		.onConflictDoNothing()
}

async function ensureSystemRolePermission(
	roleId: string,
	permissionId: string,
) {
	const [pair] = await db
		.select({
			A: _PermissionToRole.A,
			B: _PermissionToRole.B,
		})
		.from(_PermissionToRole)
		.where(
			and(
				eq(_PermissionToRole.A, permissionId),
				eq(_PermissionToRole.B, roleId),
			),
		)
		.limit(1)
	if (pair) return
	await db
		.insert(_PermissionToRole)
		.values({ A: permissionId, B: roleId })
		.onConflictDoNothing()
}

export async function setupRoles() {
	console.log('Setting up roles...')

	await ensureRole('user', 'Regular user with basic permissions')
	await ensureRole('admin', 'Admin with full permissions')

	for (const role of ORG_ROLES) {
		await ensureOrgRole(role)
	}
	for (const permission of ORG_PERMISSIONS) {
		await ensurePermission(permission)
	}
	for (const permission of SYSTEM_PERMISSIONS) {
		await ensurePermission(permission)
	}
	for (const permissionId of ADMIN_PERMISSION_IDS) {
		await ensureOrgRolePermission('org_role_admin', permissionId)
	}
	for (const permissionId of MEMBER_PERMISSION_IDS) {
		await ensureOrgRolePermission('org_role_member', permissionId)
	}
	for (const permissionId of VIEWER_PERMISSION_IDS) {
		await ensureOrgRolePermission('org_role_viewer', permissionId)
	}

	// Platform admins get every system permission by default. They can still be
	// revoked from a specific system role from the admin roles UI.
	const [adminRole] = await db
		.select({ id: Role.id })
		.from(Role)
		.where(eq(Role.name, 'admin'))
		.limit(1)
	if (adminRole) {
		for (const permission of SYSTEM_PERMISSIONS) {
			await ensureSystemRolePermission(adminRole.id, permission.id)
		}
	}

	console.log('Roles setup complete')
}

// This function is called by seed.ts - do not run standalone
