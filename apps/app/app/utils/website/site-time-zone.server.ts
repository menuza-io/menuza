import {
	and,
	asc,
	db,
	desc,
	eq,
	Organization,
	OrganizationLocation,
} from '@repo/database'
import { isValidTimeZone } from '@repo/zoned-time'

/**
 * The time zone a restaurant's website is scheduled in (#180, #238): its
 * default active location's, else the organization's staff time zone, else
 * UTC. Times are stored in UTC and shown in this zone.
 */
export async function getSiteTimeZone(organizationId: string): Promise<string> {
	const [location] = await db
		.select({ timezone: OrganizationLocation.timezone })
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
		.limit(1)
	if (location?.timezone && isValidTimeZone(location.timezone)) {
		return location.timezone
	}
	const [org] = await db
		.select({ staffingTimeZone: Organization.staffingTimeZone })
		.from(Organization)
		.where(eq(Organization.id, organizationId))
		.limit(1)
	return org?.staffingTimeZone && isValidTimeZone(org.staffingTimeZone)
		? org.staffingTimeZone
		: 'UTC'
}
