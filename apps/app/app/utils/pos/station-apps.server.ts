import { getUserId } from '@repo/auth'
import { RESERVATIONS_PERMISSIONS } from '@repo/reservations'
import { STAFFING_PERMISSIONS } from '@repo/staffing'
import {
	getReservationsFeatureState,
	getUserReservationsGrants,
	resolveReservationsLocationIds,
} from '#app/utils/reservations/access.server.ts'
import {
	getStaffingFeatureState,
	userHasStaffingPermission,
} from '#app/utils/staffing/access.server.ts'

export type StationAppGrants = {
	timeclock: boolean
	reservations: boolean
	/** May let a host see guests' phones, emails and allergies (the guest permission). */
	guestDetails: boolean
	/** Locations whose host stand this member may switch on; null is all of them. */
	locationIds: string[] | null
}

export const NO_STATION_APP_GRANTS: StationAppGrants = {
	timeclock: false,
	reservations: false,
	guestDetails: false,
	locationIds: [],
}

/**
 * Which Station apps a member may switch on for a terminal. The time clock is a
 * labor policy decision and the host stand a reservations setting, so each
 * needs that module's settings permission (and its feature on), not only the
 * menu permission the Terminals page asks for. Giving a host guest details
 * needs the guest permission, and a member limited to some locations may only
 * open the host stand at those. Signed into the operator token as
 * `stationApps`; tenant-api refuses a change the claims do not cover.
 */
export async function getStationAppGrants(
	request: Request,
	organizationId: string,
): Promise<StationAppGrants> {
	const userId = await getUserId(request)
	if (!userId) return NO_STATION_APP_GRANTS
	const [staffing, reservations, laborPolicy, reservationGrants, locationIds] =
		await Promise.all([
			getStaffingFeatureState(organizationId),
			getReservationsFeatureState(organizationId),
			userHasStaffingPermission(
				userId,
				organizationId,
				STAFFING_PERMISSIONS.UPDATE_LABOR_POLICY,
			),
			getUserReservationsGrants(userId, organizationId),
			resolveReservationsLocationIds(userId, organizationId),
		])
	const canHost =
		reservations.enabled &&
		reservationGrants.includes(
			RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_SETTINGS,
		)
	return {
		timeclock: staffing.timeclock && laborPolicy,
		reservations: canHost,
		guestDetails:
			canHost &&
			reservationGrants.includes(
				RESERVATIONS_PERMISSIONS.READ_RESERVATION_GUEST,
			),
		locationIds: canHost ? locationIds : [],
	}
}
