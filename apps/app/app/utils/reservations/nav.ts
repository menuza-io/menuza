import {
	hasGrantSatisfying,
	RESERVATIONS_PERMISSIONS,
	type ReservationsFeatureState,
	type ReservationsPermission,
} from '@repo/reservations'
import {
	canSeeReservationsSection,
	RESERVATIONS_SECTIONS,
	type ReservationsSection,
	type ReservationsSectionDefinition,
} from './sections.ts'

/** Which links of the sidebar "Reservations" group the current member should see. */
export type ReservationsNavAccess = {
	visible: boolean
	today: boolean
	book: boolean
	waitlist: boolean
	/** May open the Customers screen's dining facet (guest read grant). */
	customers: boolean
	experiences: boolean
	reports: boolean
	settings: boolean
}

export const HIDDEN_RESERVATIONS_NAV: ReservationsNavAccess = {
	visible: false,
	today: false,
	book: false,
	waitlist: false,
	customers: false,
	experiences: false,
	reports: false,
	settings: false,
}

type NavInputObject = {
	enabled?: boolean
	features: ReservationsFeatureState
	grants: Iterable<string>
}

function normalizeNavArgs(
	featuresOrObj: ReservationsFeatureState | NavInputObject,
	grantsArg?: Iterable<string>,
): { features: ReservationsFeatureState; grants: Iterable<string> } {
	if ('features' in featuresOrObj && 'grants' in featuresOrObj) {
		const enabled =
			featuresOrObj.enabled !== undefined
				? featuresOrObj.enabled && featuresOrObj.features.enabled
				: featuresOrObj.features.enabled
		return {
			features: { ...featuresOrObj.features, enabled },
			grants: featuresOrObj.grants,
		}
	}
	return {
		features: featuresOrObj,
		grants: grantsArg ?? [],
	}
}

export function computeReservationsNavAccess(
	featuresOrObj: ReservationsFeatureState | NavInputObject,
	grantsArg?: ReadonlySet<string> | readonly ReservationsPermission[],
): ReservationsNavAccess {
	const { features, grants } = normalizeNavArgs(featuresOrObj, grantsArg)
	if (!features.enabled) return HIDDEN_RESERVATIONS_NAV
	const today = canSeeReservationsSection('today', features, grants)
	const book = canSeeReservationsSection('book', features, grants)
	const waitlist = canSeeReservationsSection('waitlist', features, grants)
	const customers = hasGrantSatisfying(
		Array.from(grants),
		RESERVATIONS_PERMISSIONS.READ_RESERVATION_GUEST,
	)
	const experiences = canSeeReservationsSection('experiences', features, grants)
	const reports = canSeeReservationsSection('reports', features, grants)
	const settings = canSeeReservationsSection('settings', features, grants)
	return {
		visible: today || book || waitlist || experiences || reports || settings,
		today,
		book,
		waitlist,
		customers,
		experiences,
		reports,
		settings,
	}
}

export function visibleReservationsSections(
	featuresOrObj: ReservationsFeatureState | NavInputObject,
	grantsArg?: ReadonlySet<string> | readonly ReservationsPermission[],
): ReservationsSectionDefinition[] {
	const { features, grants } = normalizeNavArgs(featuresOrObj, grantsArg)
	return RESERVATIONS_SECTIONS.filter((s) =>
		canSeeReservationsSection(s.id, features, grants),
	)
}

export function firstVisibleReservationsSection(
	featuresOrObj: ReservationsFeatureState | NavInputObject,
	grantsArg?: ReadonlySet<string> | readonly ReservationsPermission[],
): ReservationsSection | null {
	const visible = visibleReservationsSections(featuresOrObj, grantsArg)
	return visible[0]?.id ?? null
}

export function firstVisibleReservationsPath(
	orgSlug: string,
	featuresOrObj: ReservationsFeatureState | NavInputObject,
	grantsArg?: ReadonlySet<string> | readonly ReservationsPermission[],
): string | null {
	const visible = visibleReservationsSections(featuresOrObj, grantsArg)
	if (visible.length === 0) return null
	return `/${orgSlug}/reservations/${visible[0]!.path}`
}
