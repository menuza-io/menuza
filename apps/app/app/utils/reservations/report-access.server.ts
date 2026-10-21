import { isImpersonating } from '@repo/auth'
import {
	RESERVATIONS_REPORT_SUBJECTS,
	type ReservationsReportSubject,
} from '@repo/reports/token'
import {
	RESERVATIONS_PERMISSIONS,
	type ReservationsFeatureState,
	type ReservationsPermission,
} from '@repo/reservations'
import {
	getReservationsFeatureState,
	getUserReservationsGrants,
	resolveReservationsLocationIds,
} from '#app/utils/reservations/access.server.ts'

/**
 * Which Reservations report subjects (`bookings`, `waitlist_entries`) a person
 * may run, decided on the App and written into the reports token. tenant-api
 * trusts the token and limits every query to the location ids it carries.
 *
 * Rules: an impersonated (support) session gets nothing; the master
 * `reservations.enabled` flag must be on; the person needs
 * `read:reservation_report:any`; a person limited to selected locations with
 * none selected has no access at all.
 */
export type ReservationsReportAccess = {
	subjects: ReservationsReportSubject[]
	/** `null` is every location. Always present, never widened by omission. */
	scopeIds: string[] | null
}

const NONE: ReservationsReportAccess = { subjects: [], scopeIds: [] }

export function reservationsReportAccess(input: {
	features: Pick<ReservationsFeatureState, 'enabled'>
	held: ReadonlySet<ReservationsPermission>
	locationIds: string[] | null
	impersonated: boolean
}): ReservationsReportAccess {
	if (input.impersonated) return NONE
	if (!input.features.enabled) return NONE
	if (!input.held.has(RESERVATIONS_PERMISSIONS.READ_RESERVATION_REPORT)) {
		return NONE
	}
	if (input.locationIds !== null && input.locationIds.length === 0) return NONE
	return {
		subjects: [...RESERVATIONS_REPORT_SUBJECTS],
		scopeIds: input.locationIds,
	}
}

export async function resolveReservationsReportAccess(input: {
	request: Request
	userId: string
	organizationId: string
}): Promise<ReservationsReportAccess> {
	if (await isImpersonating(input.request)) return NONE
	const features = await getReservationsFeatureState(input.organizationId)
	if (!features.enabled) return NONE
	const [grants, locationIds] = await Promise.all([
		getUserReservationsGrants(input.userId, input.organizationId),
		resolveReservationsLocationIds(input.userId, input.organizationId),
	])
	return reservationsReportAccess({
		features,
		held: new Set(grants),
		locationIds,
		impersonated: false,
	})
}

/** Narrower of two location limits (`null` is unlimited). */
export function intersectScopeIds(
	a: string[] | null,
	b: string[] | null,
): string[] | null {
	if (a === null) return b
	if (b === null) return a
	const allowed = new Set(b)
	return a.filter((id) => allowed.has(id))
}
