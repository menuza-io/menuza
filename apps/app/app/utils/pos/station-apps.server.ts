import { RESERVATIONS_PERMISSIONS } from '@repo/reservations'
import { STAFFING_PERMISSIONS } from '@repo/staffing'
import { getUserId } from '@repo/auth'
import {
	getReservationsFeatureState,
	getUserReservationsGrants,
} from '#app/utils/reservations/access.server.ts'
import {
	getStaffingFeatureState,
	userHasStaffingPermission,
} from '#app/utils/staffing/access.server.ts'

/**
 * Which Station apps a member may switch on for a terminal. The time clock is a
 * labor policy decision and the host stand a reservations setting, so each
 * needs that module's settings permission (and its feature on), not only the
 * menu permission the Terminals page asks for. Signed into the operator token
 * as `stationApps`; tenant-api refuses to switch an app on without it.
 */
export async function getStationAppGrants(
	request: Request,
	organizationId: string,
): Promise<{ timeclock: boolean; reservations: boolean }> {
	const userId = await getUserId(request)
	if (!userId) return { timeclock: false, reservations: false }
	const [staffing, reservations, laborPolicy, reservationGrants] =
		await Promise.all([
			getStaffingFeatureState(organizationId),
			getReservationsFeatureState(organizationId),
			userHasStaffingPermission(
				userId,
				organizationId,
				STAFFING_PERMISSIONS.UPDATE_LABOR_POLICY,
			),
			getUserReservationsGrants(userId, organizationId),
		])
	return {
		timeclock: staffing.timeclock && laborPolicy,
		reservations:
			reservations.enabled &&
			reservationGrants.includes(
				RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_SETTINGS,
			),
	}
}
