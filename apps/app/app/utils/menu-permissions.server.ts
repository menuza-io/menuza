import { ORG_PERMISSIONS, type OrganizationPermissionString } from '@repo/auth'

export const MENU_READ_PERMISSION: OrganizationPermissionString =
	ORG_PERMISSIONS.READ_MENU_ANY

export const MENU_WRITE_PERMISSION: OrganizationPermissionString =
	ORG_PERMISSIONS.UPDATE_MENU_ANY

export const LOCATION_READ_PERMISSION: OrganizationPermissionString =
	ORG_PERMISSIONS.READ_LOCATION_ANY

export const LOCATION_WRITE_PERMISSION: OrganizationPermissionString =
	ORG_PERMISSIONS.UPDATE_LOCATION_ANY

/**
 * Maps proposed `menu:read` / `menu:write` strings to Menuza permission tuples.
 */
export function mapManuzaMenuPermission(
	permission: 'menu:read' | 'menu:write',
): OrganizationPermissionString {
	return permission === 'menu:read'
		? MENU_READ_PERMISSION
		: MENU_WRITE_PERMISSION
}

export function mapManuzaLocationPermission(
	permission: 'locations:read' | 'locations:write',
): OrganizationPermissionString {
	return permission === 'locations:read'
		? LOCATION_READ_PERMISSION
		: LOCATION_WRITE_PERMISSION
}
