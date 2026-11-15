import { userHasOrganizationPermission } from '@repo/auth'
import { and, asc, db, desc, eq, OrganizationLocation } from '@repo/database'
import {
	displayLocationName,
	orgDefaultLocale,
} from '#app/utils/location-name.server.ts'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'
import { resolveReservationsLocationIds } from '#app/utils/reservations/access.server.ts'
import { hasAdminReportAccess } from '#app/utils/staffing/report-grants.server.ts'
import { resolveRegionalTenantApiUrls } from '#app/utils/tenant-api.server.ts'
import { type BookingsTodayAccess } from './bookings-today.ts'
import {
	type HomeLocation,
	NO_TODAY_ACCESS,
	type TodayAccess,
} from './today.ts'

/**
 * Active locations a member may see on the home page, default first. A
 * location-scoped member (`UserOrganization.locationScope = 'selected'`)
 * only gets their own; the scope rule is the one every module shares.
 */
export async function loadHomeLocations(
	userId: string,
	organizationId: string,
): Promise<HomeLocation[]> {
	const [rows, allowedIds, defaultLocale] = await Promise.all([
		db
			.select({
				id: OrganizationLocation.id,
				name: OrganizationLocation.name,
				timezone: OrganizationLocation.timezone,
			})
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
			),
		resolveReservationsLocationIds(userId, organizationId),
		orgDefaultLocale(organizationId),
	])
	return rows
		.filter((row) => allowedIds === null || allowedIds.includes(row.id))
		.map((row) => ({
			id: row.id,
			name: displayLocationName(row.name, defaultLocale, defaultLocale),
			timeZone: row.timezone || 'UTC',
		}))
}

/**
 * Whether the order tiles are shown: the same rule that puts the order
 * subjects in the reports token (report access plus menu read), so a tile
 * is shown exactly when the region will answer it.
 */
export async function canReadOrderTotals(
	userId: string,
	organizationId: string,
): Promise<boolean> {
	if (!(await hasAdminReportAccess(userId, organizationId))) return false
	return userHasOrganizationPermission(
		userId,
		organizationId,
		ORG_PERMISSIONS.READ_MENU_ANY,
	)
}

/**
 * The Today block's access: hidden tiles for missing grants (never a zero),
 * covers only while Reservations is on and readable. No tenant-api call
 * happens here.
 */
export async function loadTodayAccess({
	userId,
	organization,
	bookingsToday,
	locations,
}: {
	userId: string
	organization: { id: string; slug: string; dataRegion: string }
	bookingsToday: BookingsTodayAccess
	locations: HomeLocation[]
}): Promise<TodayAccess> {
	const orders = await canReadOrderTotals(userId, organization.id)
	const covers = bookingsToday.available
	if (locations.length === 0 || (!orders && !covers)) return NO_TODAY_ACCESS
	return {
		available: true,
		orders,
		covers,
		locations,
		coverLocationIds: bookingsToday.locations.map((location) => location.id),
		tokenUrl: `/${organization.slug}/reports/token`,
		tenantApiUrl: orders
			? resolveRegionalTenantApiUrls(organization.dataRegion).tenantApiUrl
			: null,
	}
}
