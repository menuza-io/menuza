import {
	hasGrantSatisfying,
	RESERVATIONS_FLAG_KEYS,
	RESERVATIONS_PERMISSION_LIST,
	RESERVATIONS_PERMISSIONS as P,
	type ReservationsFeatureState,
	type ReservationsFlagKey,
	type ReservationsPermission,
} from '@repo/reservations'

export type ReservationsSectionKey =
	| 'today'
	| 'book'
	| 'waitlist'
	| 'guests'
	| 'experiences'
	| 'reports'
	| 'settings'

export type ReservationsSectionDefinition = {
	id: ReservationsSectionKey
	key: ReservationsSectionKey
	path: ReservationsSectionKey
	/** Feature key on `ReservationsFeatureState` for `requireReservationsAccess`. */
	feature: keyof ReservationsFeatureState
	/** Sub-flag beyond `reservations.enabled`, or `null` when only master flag applies. */
	flag: Exclude<
		ReservationsFlagKey,
		typeof RESERVATIONS_FLAG_KEYS.enabled
	> | null
	/** Feature key on `ReservationsFeatureState`, or `null` when only `enabled` applies. */
	featureKey: Exclude<keyof ReservationsFeatureState, 'enabled'> | null
	/** Permissions that allow viewing this section (checked via `hasGrantSatisfying`). */
	permissions: readonly ReservationsPermission[]
	/** Alias for `requireReservationsAccess` options. */
	anyOf: readonly ReservationsPermission[]
}

export type ReservationsSection = ReservationsSectionKey

export const RESERVATIONS_SECTION_PERMISSIONS: readonly ReservationsPermission[] =
	RESERVATIONS_PERMISSION_LIST

export const RESERVATIONS_SECTIONS: readonly ReservationsSectionDefinition[] = [
	{
		id: 'today',
		key: 'today',
		path: 'today',
		feature: 'enabled',
		flag: null,
		featureKey: null,
		permissions: [P.READ_RESERVATION, P.UPDATE_RESERVATION],
		anyOf: [P.READ_RESERVATION, P.UPDATE_RESERVATION],
	},
	{
		id: 'book',
		key: 'book',
		path: 'book',
		feature: 'enabled',
		flag: null,
		featureKey: null,
		permissions: [P.READ_RESERVATION, P.UPDATE_RESERVATION],
		anyOf: [P.READ_RESERVATION, P.UPDATE_RESERVATION],
	},
	{
		id: 'waitlist',
		key: 'waitlist',
		path: 'waitlist',
		feature: 'waitlist',
		flag: RESERVATIONS_FLAG_KEYS.waitlist,
		featureKey: 'waitlist',
		permissions: [P.READ_RESERVATION, P.UPDATE_RESERVATION],
		anyOf: [P.READ_RESERVATION, P.UPDATE_RESERVATION],
	},
	{
		id: 'guests',
		key: 'guests',
		path: 'guests',
		feature: 'enabled',
		flag: null,
		featureKey: null,
		permissions: [P.READ_RESERVATION_GUEST, P.UPDATE_RESERVATION_GUEST],
		anyOf: [P.READ_RESERVATION_GUEST, P.UPDATE_RESERVATION_GUEST],
	},
	{
		id: 'experiences',
		key: 'experiences',
		path: 'experiences',
		feature: 'experiences',
		flag: RESERVATIONS_FLAG_KEYS.experiences,
		featureKey: 'experiences',
		permissions: [P.READ_RESERVATION_SETTINGS, P.UPDATE_RESERVATION_SETTINGS],
		anyOf: [P.READ_RESERVATION_SETTINGS, P.UPDATE_RESERVATION_SETTINGS],
	},
	{
		id: 'reports',
		key: 'reports',
		path: 'reports',
		feature: 'enabled',
		flag: null,
		featureKey: null,
		permissions: [P.READ_RESERVATION_REPORT],
		anyOf: [P.READ_RESERVATION_REPORT],
	},
	{
		id: 'settings',
		key: 'settings',
		path: 'settings',
		feature: 'enabled',
		flag: null,
		featureKey: null,
		permissions: [P.READ_RESERVATION_SETTINGS, P.UPDATE_RESERVATION_SETTINGS],
		anyOf: [P.READ_RESERVATION_SETTINGS, P.UPDATE_RESERVATION_SETTINGS],
	},
] as const

export const RESERVATIONS_SECTION_REQUIREMENTS: Readonly<
	Record<ReservationsSectionKey, ReservationsSectionDefinition>
> = Object.fromEntries(
	RESERVATIONS_SECTIONS.map((section) => [section.key, section]),
) as Record<ReservationsSectionKey, ReservationsSectionDefinition>

export function getReservationsSection(
	key: ReservationsSectionKey,
): ReservationsSectionDefinition {
	const found = RESERVATIONS_SECTIONS.find((section) => section.key === key)
	if (!found) {
		throw new Error(`Unknown reservations section: ${key}`)
	}
	return found
}

export function canSeeReservationsSection(
	sectionOrInput:
		| ReservationsSectionDefinition
		| ReservationsSectionKey
		| {
				section: ReservationsSectionDefinition | ReservationsSectionKey
				features: ReservationsFeatureState
				grants: Iterable<string>
		  },
	featuresArg?: ReservationsFeatureState,
	grantsArg?: Iterable<string>,
): boolean {
	let section: ReservationsSectionDefinition | ReservationsSectionKey
	let features: ReservationsFeatureState
	let grants: Iterable<string>

	if (
		typeof sectionOrInput === 'object' &&
		'section' in sectionOrInput &&
		'features' in sectionOrInput
	) {
		section = sectionOrInput.section
		features = sectionOrInput.features
		grants = sectionOrInput.grants
	} else {
		section = sectionOrInput as
			ReservationsSectionDefinition | ReservationsSectionKey
		features = featuresArg!
		grants = grantsArg ?? []
	}

	if (!features?.enabled) return false
	const resolved =
		typeof section === 'string' ? getReservationsSection(section) : section
	if (resolved.featureKey && !features[resolved.featureKey]) {
		return false
	}
	const grantList = Array.from(grants)
	return resolved.permissions.some((required) =>
		hasGrantSatisfying(grantList, required),
	)
}
