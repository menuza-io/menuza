import {
	RESERVATIONS_PERMISSIONS,
	RESERVATIONS_ROLE_PRESETS as DOMAIN_RESERVATIONS_ROLE_PRESETS,
	type ReservationsPermission,
	type ReservationsRolePresetId,
} from '@repo/reservations'
import {
	TENANT_ROLE_PERMISSION_IDS,
	withImpliedReservationsPermissions,
} from '#app/utils/organization/tenant-role-permissions.ts'

export const RESERVATIONS_ROLE_PRESET_KEYS = [
	'host',
	'shift_manager',
	'reservations_manager',
	'guest_relations',
	'guestbook_manager',
	'finance',
	'owner',
] as const satisfies readonly ReservationsRolePresetId[]

export type ReservationsRolePresetKey =
	(typeof RESERVATIONS_ROLE_PRESET_KEYS)[number]

/**
 * Mapping between `@repo/reservations` permission strings and the canonical
 * `Permission.id` values seeded by migration `0025_reservations_foundation.sql`.
 */
export const RESERVATIONS_PERMISSION_ID_BY_GRANT: Record<
	ReservationsPermission,
	string
> = {
	[RESERVATIONS_PERMISSIONS.READ_RESERVATION]: 'org_perm_read_reservation_any',
	[RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION]:
		'org_perm_update_reservation_any',
	[RESERVATIONS_PERMISSIONS.READ_RESERVATION_SETTINGS]:
		'org_perm_read_reservation_settings_any',
	[RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_SETTINGS]:
		'org_perm_update_reservation_settings_any',
	[RESERVATIONS_PERMISSIONS.READ_RESERVATION_GUEST]:
		'org_perm_read_reservation_guest_any',
	[RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_GUEST]:
		'org_perm_update_reservation_guest_any',
	[RESERVATIONS_PERMISSIONS.READ_RESERVATION_REPORT]:
		'org_perm_read_reservation_report_any',
	[RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_PAYMENT]:
		'org_perm_update_reservation_payment_any',
}

export const RESERVATIONS_GRANT_BY_PERMISSION_ID: Record<
	string,
	ReservationsPermission
> = Object.fromEntries(
	Object.entries(RESERVATIONS_PERMISSION_ID_BY_GRANT).map(([grant, id]) => [
		id,
		grant as ReservationsPermission,
	]),
)

export type ReservationsRolePreset = {
	key: ReservationsRolePresetKey
	name: string
	description: string
	permissionIds: readonly string[]
	permissions: readonly ReservationsPermission[]
}

/** `read:reservation:any` becomes `org_perm_read_reservation_any`. */
export function permissionIdFor(permission: ReservationsPermission): string {
	const [action, entity, access] = permission.split(':')
	return `org_perm_${action}_${entity}_${access}`
}

/**
 * The stored permission ids for a preset: implied read grants added, only ids a
 * custom role may hold, sorted for stable output.
 */
export function presetPermissionIds(preset: {
	key: string
	permissions: readonly ReservationsPermission[]
}): string[] {
	const ids = withImpliedReservationsPermissions(
		preset.permissions.map(permissionIdFor),
	)
	const allowed = new Set<string>(TENANT_ROLE_PERMISSION_IDS)
	for (const id of ids) {
		if (!allowed.has(id)) {
			throw new Error(`Preset ${preset.key} uses a non-grantable permission`)
		}
	}
	return ids.sort()
}

function buildPreset(
	key: ReservationsRolePresetKey,
	name: string,
	description: string,
): ReservationsRolePreset {
	const permissions = DOMAIN_RESERVATIONS_ROLE_PRESETS[key].permissions
	return {
		key,
		name,
		description,
		permissions,
		permissionIds: presetPermissionIds({ key, permissions }),
	}
}

/**
 * Ready-made Reservations role presets offered in Settings -> Roles while
 * `reservations.enabled` is turned on for the organization.
 *
 * Notice that `reservations_manager` intentionally excludes
 * `update:reservation_payment:any` (`org_perm_update_reservation_payment_any`),
 * which is reserved for the Finance / Owner presets or explicit assignment.
 */
export const RESERVATIONS_ROLE_PRESETS: readonly ReservationsRolePreset[] = [
	buildPreset(
		'host',
		'Host',
		'Runs the reservation book, waitlist, and table status.',
	),
	buildPreset(
		'shift_manager',
		'Shift manager',
		'Manages the reservation book and waitlist, views guest profiles, and views reservation reports.',
	),
	buildPreset(
		'reservations_manager',
		'Reservations manager',
		'Configures dining areas, tables, services, pacing, and experiences, and manages the book, guestbook, and reports without payment capture or refund access.',
	),
	buildPreset(
		'guest_relations',
		'Guest relations',
		'Views the reservation book and manages guest profiles, tags, notes, and merges.',
	),
	buildPreset(
		'guestbook_manager',
		'Guestbook manager',
		'Views the reservation book and manages guest profiles, tags, notes, and merges.',
	),
	buildPreset(
		'finance',
		'Finance',
		'Views reservation and deposit reports and captures, refunds, or waives reservation payments and no-show fees.',
	),
	buildPreset(
		'owner',
		'Owner',
		'Full access to all reservations, guestbook, setup, reports, and payment actions.',
	),
] as const

export function isReservationsRolePresetKey(
	value: unknown,
): value is ReservationsRolePresetKey {
	return (
		typeof value === 'string' &&
		(RESERVATIONS_ROLE_PRESET_KEYS as readonly string[]).includes(value)
	)
}

export function getReservationsRolePreset(
	key: ReservationsRolePresetKey,
): ReservationsRolePreset {
	const preset = RESERVATIONS_ROLE_PRESETS.find((item) => item.key === key)
	if (!preset) {
		throw new Error(`Unknown reservations role preset: ${key}`)
	}
	return preset
}
