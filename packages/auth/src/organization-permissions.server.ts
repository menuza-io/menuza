import {
	and,
	db,
	eq,
	inArray,
	isNull,
	OrganizationRole,
	or,
	Permission,
	UserOrganization,
	_OrganizationPermissionToRole,
} from '@repo/database'
import {
	parsePermissionString,
	createForbiddenResponse,
} from './authorize.server'

export type OrganizationPermissionString = `${string}:${string}:${string}`

/**
 * Parse organization permission string like "create:org_note:own"
 */
export function parseOrganizationPermissionString(
	permissionString: OrganizationPermissionString,
) {
	return parsePermissionString(permissionString)
}

async function loadOrgRolePermissions(
	userId: string,
	organizationId: string,
	extraFilters: ReturnType<typeof eq>[] = [],
) {
	return db
		.select({
			id: Permission.id,
			action: Permission.action,
			entity: Permission.entity,
			access: Permission.access,
			description: Permission.description,
			roleId: OrganizationRole.id,
			roleName: OrganizationRole.name,
			roleLevel: OrganizationRole.level,
			active: UserOrganization.active,
		})
		.from(UserOrganization)
		.innerJoin(
			OrganizationRole,
			eq(OrganizationRole.id, UserOrganization.organizationRoleId),
		)
		.innerJoin(
			_OrganizationPermissionToRole,
			eq(_OrganizationPermissionToRole.A, OrganizationRole.id),
		)
		.innerJoin(Permission, eq(Permission.id, _OrganizationPermissionToRole.B))
		.where(
			and(
				eq(UserOrganization.userId, userId),
				eq(UserOrganization.organizationId, organizationId),
				or(
					isNull(OrganizationRole.organizationId),
					eq(OrganizationRole.organizationId, organizationId),
				),
				eq(Permission.context, 'organization'),
				...extraFilters,
			),
		)
}

/**
 * Check if user has organization permission
 */
export async function userHasOrganizationPermission(
	userId: string,
	organizationId: string,
	permission: OrganizationPermissionString,
): Promise<boolean> {
	const { action, entity, access } =
		parseOrganizationPermissionString(permission)

	const extra = [
		eq(UserOrganization.active, true),
		eq(Permission.action, action),
		eq(Permission.entity, entity),
	]
	if (access?.length) extra.push(inArray(Permission.access, access))

	const rows = await loadOrgRolePermissions(userId, organizationId, extra)
	return rows.length > 0
}

/**
 * Require user to have organization permission - throws 403 if not
 * Note: This function expects userId to be passed in. In your app, you should
 * get the userId from your auth.server.ts:getUserId() function first.
 */
export async function requireUserWithOrganizationPermission(
	userId: string | undefined,
	organizationId: string,
	permission: OrganizationPermissionString,
): Promise<string> {
	if (!userId) {
		throw new Response('Authentication required', { status: 401 })
	}

	const hasPermission = await userHasOrganizationPermission(
		userId,
		organizationId,
		permission,
	)
	if (!hasPermission) {
		throw createForbiddenResponse(permission)
	}

	return userId
}

/**
 * Get all permissions for user in organization
 */
export async function getUserOrganizationPermissions(
	userId: string,
	organizationId: string,
) {
	const rows = await loadOrgRolePermissions(userId, organizationId, [
		eq(UserOrganization.active, true),
	])
	return rows.map(({ action, entity, access, description }) => ({
		action,
		entity,
		access,
		description,
	}))
}

/**
 * Client-side permission checking for organization permissions
 */
export function userHasOrganizationPermissionClient(
	userPermissions: { action: string; entity: string; access: string }[],
	permission: OrganizationPermissionString,
): boolean {
	const { action, entity, access } =
		parseOrganizationPermissionString(permission)

	return userPermissions.some(
		(p) =>
			p.action === action &&
			p.entity === entity &&
			(!access ||
				access.length === 0 ||
				access.includes('') ||
				access.includes(p.access)),
	)
}

// Common organization permission constants
export const ORG_PERMISSIONS = {
	// Note permissions
	CREATE_NOTE_OWN: 'create:note:own' as const,
	READ_NOTE_OWN: 'read:note:own' as const,
	READ_NOTE_ANY: 'read:note:org' as const,
	UPDATE_NOTE_OWN: 'update:note:own' as const,
	UPDATE_NOTE_ANY: 'update:note:org' as const,
	DELETE_NOTE_OWN: 'delete:note:own' as const,
	DELETE_NOTE_ANY: 'delete:note:org' as const,

	// Member permissions
	READ_MEMBER_ANY: 'read:member:any' as const,
	CREATE_MEMBER_ANY: 'create:member:any' as const,
	UPDATE_MEMBER_ANY: 'update:member:any' as const,
	DELETE_MEMBER_ANY: 'delete:member:any' as const,

	// Settings permissions
	READ_SETTINGS_ANY: 'read:settings:any' as const,
	UPDATE_SETTINGS_ANY: 'update:settings:any' as const,

	// Website permissions
	READ_WEBSITE_ANY: 'read:website:any' as const,
	UPDATE_WEBSITE_ANY: 'update:website:any' as const,

	// Analytics permissions
	READ_ANALYTICS_ANY: 'read:analytics:any' as const,
} as const

/**
 * Get user's organization permissions with role details for client-side use
 * Returns null if user doesn't have access to the organization
 */
export async function getUserOrganizationPermissionsForClient(
	userId: string,
	organizationId: string,
): Promise<{
	userId: string
	organizationId: string
	organizationRole: {
		id: string
		name: string
		level: number
		permissions: Array<{
			id: string
			action: string
			entity: string
			access: string
			description: string
		}>
	}
} | null> {
	const [membership] = await db
		.select({
			active: UserOrganization.active,
			roleId: OrganizationRole.id,
			roleName: OrganizationRole.name,
			roleLevel: OrganizationRole.level,
		})
		.from(UserOrganization)
		.innerJoin(
			OrganizationRole,
			eq(OrganizationRole.id, UserOrganization.organizationRoleId),
		)
		.where(
			and(
				eq(UserOrganization.userId, userId),
				eq(UserOrganization.organizationId, organizationId),
				or(
					isNull(OrganizationRole.organizationId),
					eq(OrganizationRole.organizationId, organizationId),
				),
			),
		)
		.limit(1)

	if (!membership || !membership.active) {
		return null
	}

	const permissions = await db
		.select({
			id: Permission.id,
			action: Permission.action,
			entity: Permission.entity,
			access: Permission.access,
			description: Permission.description,
		})
		.from(_OrganizationPermissionToRole)
		.innerJoin(Permission, eq(Permission.id, _OrganizationPermissionToRole.B))
		.where(
			and(
				eq(_OrganizationPermissionToRole.A, membership.roleId),
				eq(Permission.context, 'organization'),
			),
		)

	return {
		userId,
		organizationId,
		organizationRole: {
			id: membership.roleId,
			name: membership.roleName,
			level: membership.roleLevel,
			permissions,
		},
	}
}
