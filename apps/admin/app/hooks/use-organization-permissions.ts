/**
 * Client-side hook for checking organization permissions
 * Used to conditionally show/hide UI elements based on user's role permissions
 */

import { useRouteLoaderData } from 'react-router'

// Permission string format: "action:entity:access" (e.g., "read:note:own")
export type PermissionString = string

export interface UserOrganizationPermissions {
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
			description?: string
		}>
	}
}

/**
 * Hook to access user's organization permissions from loader data
 */
export function useOrganizationPermissions(): UserOrganizationPermissions | null {
	// Try to get permissions from various potential loader data locations
	const orgLayoutData = useRouteLoaderData(
		'routes/_app+/$orgSlug_+/_layout',
	) as any
	const appLayoutData = useRouteLoaderData('routes/_app+/_layout') as any
	const currentRouteData = useRouteLoaderData('root') as any

	// Also check current route data (for pages like notes that provide their own permissions)
	const noteRouteData = useRouteLoaderData(
		'routes/_app+/$orgSlug_+/notes.$noteId',
	) as any
	const membersRouteData = useRouteLoaderData(
		'routes/_app+/$orgSlug_+/settings+/members',
	) as any

	// Look for permissions in the most likely places
	const permissions =
		orgLayoutData?.userPermissions ||
		appLayoutData?.userPermissions ||
		noteRouteData?.userPermissions ||
		membersRouteData?.userPermissions ||
		currentRouteData?.userPermissions ||
		null

	return permissions
}

/**
 * Hook to check if user has a specific permission
 */
export function useHasPermission() {
	const permissions = useOrganizationPermissions()

	return (permission: PermissionString): boolean => {
		if (!permissions) return false

		const [action, entity, access] = permission.split(':')

		return permissions.organizationRole.permissions.some(
			(p) => p.action === action && p.entity === entity && p.access === access,
		)
	}
}

/**
 * Hook to check multiple permissions (user needs ALL of them)
 */
export function useHasAllPermissions() {
	const hasPermission = useHasPermission()

	return (permissions: PermissionString[]): boolean => {
		return permissions.every((permission) => hasPermission(permission))
	}
}

/**
 * Hook to check multiple permissions (user needs ANY of them)
 */
export function useHasAnyPermission() {
	const hasPermission = useHasPermission()

	return (permissions: PermissionString[]): boolean => {
		return permissions.some((permission) => hasPermission(permission))
	}
}

/**
 * Hook to check if user can perform specific note actions
 */
export function useNotePermissions() {
	const hasPermission = useHasPermission()

	return {
		canCreate: () => hasPermission('create:note:own'),
		canReadOwn: () => hasPermission('read:note:own'),
		canReadAll: () => hasPermission('read:note:org'),
		canEditOwn: () => hasPermission('update:note:own'),
		canEditAll: () => hasPermission('update:note:org'),
		canDeleteOwn: () => hasPermission('delete:note:own'),
		canDeleteAll: () => hasPermission('delete:note:org'),
	}
}

/**
 * Hook to check if user can perform member management actions
 */
export function useMemberPermissions() {
	const hasPermission = useHasPermission()

	return {
		canView: () => hasPermission('read:member:any'),
		canInvite: () => hasPermission('create:member:any'),
		canUpdateRoles: () => hasPermission('update:member:any'),
		canRemove: () => hasPermission('delete:member:any'),
	}
}

/**
 * Hook to check if user can manage organization settings
 */
export function useSettingsPermissions() {
	const hasPermission = useHasPermission()

	return {
		canView: () => hasPermission('read:settings:any'),
		canUpdate: () => hasPermission('update:settings:any'),
	}
}

/**
 * Hook to get user's role information
 */
export function useOrganizationRole() {
	const permissions = useOrganizationPermissions()

	return permissions
		? {
				id: permissions.organizationRole.id,
				name: permissions.organizationRole.name,
				level: permissions.organizationRole.level,
				isAdmin: permissions.organizationRole.name.toLowerCase() === 'admin',
				isMember: permissions.organizationRole.name.toLowerCase() === 'member',
				isViewer: permissions.organizationRole.name.toLowerCase() === 'viewer',
				isGuest: permissions.organizationRole.name.toLowerCase() === 'guest',
			}
		: null
}
