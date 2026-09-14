import { requireUserId } from './auth.server'
import { checkUserHasPermission, checkUserHasRole } from './permissions.server'
import {
	userHasOrganizationPermission,
	type OrganizationPermissionString,
} from './organization-permissions.server'
import { type PermissionString } from '@repo/common/user-permissions'

export interface AuthorizeOptions {
	permission?: PermissionString
	role?: string
	organizationId?: string
	orgPermission?: OrganizationPermissionString
}

/**
 * Single unified permission string parser for both global and organization permissions.
 */
export function parsePermissionString(permissionString: string) {
	const [action, entity, access] = permissionString.split(':')
	return {
		action: action?.trim() || '',
		entity: entity?.trim() || '',
		access:
			access !== undefined ? access.split(',').map((a) => a.trim()) : undefined,
	}
}

/**
 * Single unified 403 response builder across all authorization checks.
 */
export function createForbiddenResponse(
	permissionOrRole: string,
	isRole = false,
): Response {
	const label = isRole ? 'role' : 'permissions'
	return new Response(`Unauthorized: required ${label}: ${permissionOrRole}`, {
		status: 403,
	})
}

/**
 * Unified authorization helper for verifying user roles, user permissions,
 * and organization permissions behind a single seam.
 */
export async function authorize(
	request: Request,
	options: AuthorizeOptions,
): Promise<string> {
	const userId = await requireUserId(request)

	if (options.permission) {
		await checkUserHasPermission(userId, options.permission)
	}

	if (options.role) {
		await checkUserHasRole(userId, options.role)
	}

	if (options.organizationId && options.orgPermission) {
		const hasOrgPermission = await userHasOrganizationPermission(
			userId,
			options.organizationId,
			options.orgPermission,
		)
		if (!hasOrgPermission) {
			throw createForbiddenResponse(options.orgPermission)
		}
	}

	return userId
}

/**
 * Namespace helper for user permission check
 */
authorize.userPermission = async (
	request: Request,
	permission: PermissionString,
): Promise<string> => {
	return authorize(request, { permission })
}

/**
 * Namespace helper that succeeds when the user has at least one of the given
 * permissions. Useful for section landing pages that aggregate resources.
 */
authorize.userAnyPermission = async (
	request: Request,
	permissions: PermissionString[],
): Promise<string> => {
	const userId = await requireUserId(request)
	for (const permission of permissions) {
		try {
			await checkUserHasPermission(userId, permission)
			return userId
		} catch (error) {
			if (!(error instanceof Response)) throw error
		}
	}
	throw createForbiddenResponse(permissions.join(' or '))
}

/**
 * Namespace helper for user role check
 */
authorize.userRole = async (
	request: Request,
	role: string,
): Promise<string> => {
	return authorize(request, { role })
}

/**
 * Namespace helper for organization permission check
 */
authorize.orgPermission = async (
	request: Request,
	organizationId: string,
	orgPermission: OrganizationPermissionString,
): Promise<string> => {
	return authorize(request, { organizationId, orgPermission })
}
