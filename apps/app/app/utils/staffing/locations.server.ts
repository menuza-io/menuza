import {
	and,
	asc,
	db,
	eq,
	OrganizationLocation,
	User,
	UserOrganization,
} from '@repo/database'

import { type StaffingLocation } from './client.ts'

/** Control-plane location metadata only; no staff data. */
export async function loadStaffingLocations(
	organizationId: string,
): Promise<StaffingLocation[]> {
	return db
		.select({
			id: OrganizationLocation.id,
			name: OrganizationLocation.name,
			timezone: OrganizationLocation.timezone,
			isActive: OrganizationLocation.isActive,
		})
		.from(OrganizationLocation)
		.where(eq(OrganizationLocation.organizationId, organizationId))
		.orderBy(asc(OrganizationLocation.createdAt))
}

/**
 * Lower-cased operator emails, used only for a client-side "has login" hint
 * next to staff rows. Staff emails are never sent to App to do this match.
 */
export async function loadMemberEmails(organizationId: string) {
	const rows = await db
		.select({ email: User.email })
		.from(UserOrganization)
		.innerJoin(User, eq(User.id, UserOrganization.userId))
		.where(
			and(
				eq(UserOrganization.organizationId, organizationId),
				eq(UserOrganization.active, true),
			),
		)
	return rows.map((row) => row.email.toLowerCase())
}
