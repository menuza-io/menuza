/**
 * Organization-scoped RBAC permission strings for the Reservations module.
 * Kept in sync with `ORG_PERMISSIONS` in `@repo/auth`.
 */
export const RESERVATIONS_PERMISSIONS = {
	READ_RESERVATION: 'read:reservation:any',
	UPDATE_RESERVATION: 'update:reservation:any',
	READ_RESERVATION_SETTINGS: 'read:reservation_settings:any',
	UPDATE_RESERVATION_SETTINGS: 'update:reservation_settings:any',
	READ_RESERVATION_GUEST: 'read:reservation_guest:any',
	UPDATE_RESERVATION_GUEST: 'update:reservation_guest:any',
	READ_RESERVATION_REPORT: 'read:reservation_report:any',
	UPDATE_RESERVATION_PAYMENT: 'update:reservation_payment:any',
} as const

export type ReservationsPermissionKey = keyof typeof RESERVATIONS_PERMISSIONS
export type ReservationsPermission =
	(typeof RESERVATIONS_PERMISSIONS)[ReservationsPermissionKey]

export const RESERVATIONS_PERMISSION_LIST: readonly ReservationsPermission[] =
	Object.values(RESERVATIONS_PERMISSIONS)

/**
 * Sensitive grants shorten the operator token TTL from 15 minutes to 5 minutes
 * and are never issued during support impersonation.
 */
export const SENSITIVE_GRANTS = [
	RESERVATIONS_PERMISSIONS.READ_RESERVATION_GUEST,
	RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_GUEST,
	RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_PAYMENT,
] as const satisfies readonly ReservationsPermission[]

export type SensitiveReservationsGrant = (typeof SENSITIVE_GRANTS)[number]

const sensitiveSet = new Set<string>(SENSITIVE_GRANTS)

export function isSensitiveGrant(
	grant: string,
): grant is SensitiveReservationsGrant {
	return sensitiveSet.has(grant)
}

export function hasSensitiveGrant(grants: readonly string[]): boolean {
	return grants.some((grant) => sensitiveSet.has(grant))
}

/**
 * Each `update:*` permission implies its matching `read:*` permission at
 * runtime. `update:reservation_payment:any` has no dedicated read permission
 * and implies `read:reservation:any`.
 */
export const IMPLIED_READ_BY_UPDATE: Readonly<
	Partial<Record<ReservationsPermission, ReservationsPermission>>
> = {
	[RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION]:
		RESERVATIONS_PERMISSIONS.READ_RESERVATION,
	[RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_SETTINGS]:
		RESERVATIONS_PERMISSIONS.READ_RESERVATION_SETTINGS,
	[RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_GUEST]:
		RESERVATIONS_PERMISSIONS.READ_RESERVATION_GUEST,
}

/**
 * Return every permission that satisfies `required` (either `required` itself
 * or the matching `update:*` permission when `required` is a `read:*` grant).
 */
export function grantsSatisfying(
	required: ReservationsPermission,
): readonly ReservationsPermission[] {
	const out: ReservationsPermission[] = [required]
	for (const [updatePerm, readPerm] of Object.entries(IMPLIED_READ_BY_UPDATE)) {
		if (readPerm === required) {
			out.push(updatePerm as ReservationsPermission)
		}
	}
	return out
}

/**
 * Check whether `heldGrants` satisfies `required` (directly or via `update:*` -> `read:*`).
 */
export function hasGrantSatisfying(
	heldGrants: readonly string[],
	required: ReservationsPermission,
): boolean {
	const satisfying = grantsSatisfying(required)
	return satisfying.some((perm) => heldGrants.includes(perm))
}

/**
 * Expand `grants` so any `update:*` grant also includes its implied `read:*` grant.
 */
export function expandImpliedGrants(
	grants: readonly ReservationsPermission[],
): ReservationsPermission[] {
	const set = new Set<ReservationsPermission>(grants)
	for (const grant of grants) {
		const implied = IMPLIED_READ_BY_UPDATE[grant]
		if (implied) set.add(implied)
	}
	return RESERVATIONS_PERMISSION_LIST.filter((perm) => set.has(perm))
}

/**
 * Strip all write (`update:*`) and sensitive grants during support impersonation.
 */
export function restrictGrantsForImpersonation(
	grants: readonly ReservationsPermission[],
	impersonated: boolean,
): ReservationsPermission[] {
	if (!impersonated) return [...grants]
	return grants.filter(
		(grant) => !grant.startsWith('update:') && !isSensitiveGrant(grant),
	)
}

export type ReservationsRolePresetId =
	| 'host'
	| 'shift_manager'
	| 'reservations_manager'
	| 'guest_relations'
	| 'guestbook_manager'
	| 'finance'
	| 'owner'

export type ReservationsRolePreset = {
	id: ReservationsRolePresetId
	permissions: readonly ReservationsPermission[]
}

export const RESERVATIONS_ROLE_PRESETS: Readonly<
	Record<ReservationsRolePresetId, ReservationsRolePreset>
> = {
	host: {
		id: 'host',
		permissions: [
			RESERVATIONS_PERMISSIONS.READ_RESERVATION,
			RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION,
		],
	},
	shift_manager: {
		id: 'shift_manager',
		permissions: [
			RESERVATIONS_PERMISSIONS.READ_RESERVATION,
			RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION,
			RESERVATIONS_PERMISSIONS.READ_RESERVATION_GUEST,
			RESERVATIONS_PERMISSIONS.READ_RESERVATION_REPORT,
		],
	},
	reservations_manager: {
		id: 'reservations_manager',
		permissions: [
			RESERVATIONS_PERMISSIONS.READ_RESERVATION,
			RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION,
			RESERVATIONS_PERMISSIONS.READ_RESERVATION_SETTINGS,
			RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_SETTINGS,
			RESERVATIONS_PERMISSIONS.READ_RESERVATION_GUEST,
			RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_GUEST,
			RESERVATIONS_PERMISSIONS.READ_RESERVATION_REPORT,
		],
	},
	guest_relations: {
		id: 'guest_relations',
		permissions: [
			RESERVATIONS_PERMISSIONS.READ_RESERVATION,
			RESERVATIONS_PERMISSIONS.READ_RESERVATION_GUEST,
			RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_GUEST,
		],
	},
	guestbook_manager: {
		id: 'guestbook_manager',
		permissions: [
			RESERVATIONS_PERMISSIONS.READ_RESERVATION,
			RESERVATIONS_PERMISSIONS.READ_RESERVATION_GUEST,
			RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_GUEST,
		],
	},
	finance: {
		id: 'finance',
		permissions: [
			RESERVATIONS_PERMISSIONS.READ_RESERVATION,
			RESERVATIONS_PERMISSIONS.READ_RESERVATION_REPORT,
			RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_PAYMENT,
		],
	},
	owner: {
		id: 'owner',
		permissions: [...RESERVATIONS_PERMISSION_LIST],
	},
}
