import {
	and,
	db,
	eq,
	inArray,
	Permission,
	_PermissionToRole,
	_RoleToUser,
	Role,
	User,
	UserOrganization,
} from '@repo/database'
import {
	parsePermissionString,
	type PermissionString,
} from '@repo/common/user-permissions'
import { authorize } from './authorize.server'

export async function userHasPermission(
	userId: string,
	permission: PermissionString,
): Promise<boolean> {
	const permissionData = parsePermissionString(permission)
	const filters = [
		eq(User.id, userId),
		eq(Permission.action, permissionData.action),
		eq(Permission.entity, permissionData.entity),
	]
	if (permissionData.access?.length) {
		filters.push(inArray(Permission.access, permissionData.access))
	}

	const [user] = await db
		.select({ id: User.id })
		.from(User)
		.innerJoin(_RoleToUser, eq(_RoleToUser.B, User.id))
		.innerJoin(Role, eq(Role.id, _RoleToUser.A))
		.innerJoin(_PermissionToRole, eq(_PermissionToRole.B, Role.id))
		.innerJoin(Permission, eq(Permission.id, _PermissionToRole.A))
		.where(and(...filters))
		.limit(1)
	return Boolean(user)
}

export async function checkUserHasPermission(
	userId: string,
	permission: PermissionString,
): Promise<string> {
	const hasPermission = await userHasPermission(userId, permission)
	if (!hasPermission) {
		throw new Response(`Unauthorized: required permissions: ${permission}`, {
			status: 403,
		})
	}
	return userId
}

export async function checkUserHasRole(
	userId: string,
	name: string,
): Promise<{ id: string; defaultOrganizationId: string | null }> {
	const [user] = await db
		.select({ id: User.id })
		.from(User)
		.innerJoin(_RoleToUser, eq(_RoleToUser.B, User.id))
		.innerJoin(Role, eq(Role.id, _RoleToUser.A))
		.where(and(eq(User.id, userId), eq(Role.name, name)))
		.limit(1)

	if (!user) {
		throw new Response(`Unauthorized: required role: ${name}`, { status: 403 })
	}

	const [membership] = await db
		.select({ organizationId: UserOrganization.organizationId })
		.from(UserOrganization)
		.where(
			and(
				eq(UserOrganization.userId, userId),
				eq(UserOrganization.isDefault, true),
			),
		)
		.limit(1)

	return {
		id: user.id,
		defaultOrganizationId: membership?.organizationId ?? null,
	}
}

export async function requireUserWithPermission(
	request: Request,
	permission: PermissionString,
) {
	return authorize.userPermission(request, permission)
}

export async function requireAnyUserWithPermission(
	request: Request,
	permissions: PermissionString[],
) {
	return authorize.userAnyPermission(request, permissions)
}

export async function requireUserWithRole(request: Request, name: string) {
	return authorize.userRole(request, name)
}
