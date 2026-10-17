import { and, asc, db, desc, eq, OrganizationLocation } from '@repo/database'
import { RESERVATIONS_PERMISSIONS } from '@repo/reservations'
import {
	displayLocationName,
	orgDefaultLocale,
} from '#app/utils/location-name.server.ts'
import {
	getUserReservationsGrants,
	isReservationsFeatureEnabled,
	resolveReservationsLocationIds,
} from '#app/utils/reservations/access.server.ts'
import {
	NO_BOOKINGS_TODAY_ACCESS,
	type BookingsTodayAccess,
} from './bookings-today.ts'

/**
 * The block is offered only while `reservations.enabled` is on and the viewer
 * holds `read:reservation:any`. No tenant-api call happens here.
 */
export async function loadBookingsTodayAccess({
	userId,
	organizationId,
}: {
	userId: string
	organizationId: string
}): Promise<BookingsTodayAccess> {
	if (!(await isReservationsFeatureEnabled(organizationId))) {
		return NO_BOOKINGS_TODAY_ACCESS
	}
	const [grants, allowedIds] = await Promise.all([
		getUserReservationsGrants(userId, organizationId),
		resolveReservationsLocationIds(userId, organizationId),
	])
	if (!grants.includes(RESERVATIONS_PERMISSIONS.READ_RESERVATION)) {
		return NO_BOOKINGS_TODAY_ACCESS
	}
	const rows = await db
		.select({ id: OrganizationLocation.id, name: OrganizationLocation.name })
		.from(OrganizationLocation)
		.where(
			and(
				eq(OrganizationLocation.organizationId, organizationId),
				eq(OrganizationLocation.isActive, true),
			),
		)
		.orderBy(
			desc(OrganizationLocation.isDefault),
			asc(OrganizationLocation.createdAt),
		)
	const defaultLocale = await orgDefaultLocale(organizationId)
	const locations = rows
		.filter((row) => allowedIds === null || allowedIds.includes(row.id))
		.map((row) => ({
			id: row.id,
			name: displayLocationName(row.name, defaultLocale, defaultLocale),
		}))
	return { available: locations.length > 0, locations }
}
