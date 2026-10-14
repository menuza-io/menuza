import {
	and,
	db,
	desc,
	eq,
	Organization,
	OrganizationLocation,
} from '@repo/database'
import { DEFAULT_SCOPE_ID } from '@repo/staffing'

/**
 * The scope the seeds work in. A restaurant organization works by location, so
 * its default (else first active) location is the scope: the id is the location
 * id and the time zone is the location's. Any other organization has the one
 * implicit scope: id `main`, the organization's name and its staffing time zone.
 * The seeds read the control plane directly, so they do not need the App running.
 */
export async function loadSeedScope(organizationId: string) {
	const [location] = await db
		.select({
			id: OrganizationLocation.id,
			name: OrganizationLocation.name,
			timeZone: OrganizationLocation.timezone,
		})
		.from(OrganizationLocation)
		.where(
			and(
				eq(OrganizationLocation.organizationId, organizationId),
				eq(OrganizationLocation.isActive, true),
			),
		)
		.orderBy(desc(OrganizationLocation.isDefault), OrganizationLocation.name)
		.limit(1)
	if (location) return location

	const [org] = await db
		.select({
			name: Organization.name,
			timeZone: Organization.staffingTimeZone,
		})
		.from(Organization)
		.where(eq(Organization.id, organizationId))
		.limit(1)
	return {
		id: DEFAULT_SCOPE_ID,
		name: org?.name || 'Main',
		timeZone: org?.timeZone || 'UTC',
	}
}
