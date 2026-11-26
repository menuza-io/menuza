import {
	CASHIER_PERMISSIONS,
	MANAGER_PERMISSIONS,
	effectivePermissions,
	type PosPermission,
} from '@repo/common/pos-roles'
import { type StaffRole } from './db.ts'

export type TillSession = {
	role: StaffRole
	permissions?: readonly string[]
} | null

/**
 * One helper for every till action (#230). Sign-in off still obeys a terminal
 * limit. A missing permission list fails closed to the built-in role.
 */
export function tillCan(input: {
	signInRequired: boolean
	session: TillSession
	terminalAllow: readonly string[] | null
	permission: PosPermission
}): boolean {
	const rolePermissions = input.signInRequired
		? (input.session?.permissions ??
			(input.session?.role === 'manager'
				? MANAGER_PERMISSIONS
				: input.session
					? CASHIER_PERMISSIONS
					: []))
		: MANAGER_PERMISSIONS
	return effectivePermissions({
		rolePermissions,
		terminalAllow: input.terminalAllow,
	}).includes(input.permission)
}
