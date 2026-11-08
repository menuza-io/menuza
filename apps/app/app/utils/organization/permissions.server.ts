import {
	requireUserWithOrganizationPermission as _requireUserWithOrganizationPermission,
	createForbiddenResponse,
	getUserId,
	ORG_PERMISSIONS,
	getUserOrganizationPermissionsForClient,
	userHasOrganizationPermission,
	type OrganizationPermissionString,
} from '@repo/auth'
import {
	and,
	db,
	eq,
	isNull,
	OrganizationRole,
	UserOrganization,
} from '@repo/database'

export { ORG_PERMISSIONS, getUserOrganizationPermissionsForClient }

/**
 * Require user to have organization permission - throws 403 if not
 * This is a wrapper around the shared function that gets userId from the request
 */
export async function requireUserWithOrganizationPermission(
	request: Request,
	organizationId: string,
	permission: OrganizationPermissionString,
): Promise<string> {
	const userId = await getUserId(request)
	if (!userId) {
		throw new Response('Unauthorized', { status: 401 })
	}
	return _requireUserWithOrganizationPermission(
		userId,
		organizationId,
		permission,
	)
}

/**
 * Require the user to have at least one of the given organization permissions.
 * Useful for section landing pages that aggregate more than one resource.
 */
export async function requireAnyUserWithOrganizationPermission(
	request: Request,
	organizationId: string,
	permissions: OrganizationPermissionString[],
): Promise<string> {
	const userId = await getUserId(request)
	if (!userId) {
		throw new Response('Unauthorized', { status: 401 })
	}

	for (const permission of permissions) {
		if (
			await userHasOrganizationPermission(userId, organizationId, permission)
		) {
			return userId
		}
	}

	throw createForbiddenResponse(permissions.join(' or '))
}

/**
 * Whether the user is an active member of the organization with the built-in
 * `admin` role. Custom roles never qualify, whatever permissions they carry:
 * this gates actions that cannot be undone, such as deleting the organization.
 */
export async function userIsOrganizationAdmin(
	userId: string,
	organizationId: string,
): Promise<boolean> {
	const [membership] = await db
		.select({ userId: UserOrganization.userId })
		.from(UserOrganization)
		.innerJoin(
			OrganizationRole,
			eq(OrganizationRole.id, UserOrganization.organizationRoleId),
		)
		.where(
			and(
				eq(UserOrganization.userId, userId),
				eq(UserOrganization.organizationId, organizationId),
				eq(UserOrganization.active, true),
				eq(OrganizationRole.name, 'admin'),
				isNull(OrganizationRole.organizationId),
			),
		)
		.limit(1)
	return Boolean(membership)
}

/** Require the built-in organization `admin` role - throws 403 if not. */
export async function requireOrganizationAdmin(
	request: Request,
	organizationId: string,
): Promise<string> {
	const userId = await getUserId(request)
	if (!userId) {
		throw new Response('Unauthorized', { status: 401 })
	}
	if (!(await userIsOrganizationAdmin(userId, organizationId))) {
		throw createForbiddenResponse('admin', true)
	}
	return userId
}
