import {
	requireUserWithOrganizationPermission as _requireUserWithOrganizationPermission,
	createForbiddenResponse,
	getUserId,
	ORG_PERMISSIONS,
	getUserOrganizationPermissionsForClient,
	userHasOrganizationPermission,
	type OrganizationPermissionString,
} from '@repo/auth'

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
