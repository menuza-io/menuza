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
 * Display names for operator ids that appear as actors in regional history
 * (who published, who edited a time card). Operators only, never staff.
 */
export async function loadMemberNames(organizationId: string) {
	const rows = await db
		.select({ id: User.id, name: User.name, username: User.username })
		.from(UserOrganization)
		.innerJoin(User, eq(User.id, UserOrganization.userId))
		.where(eq(UserOrganization.organizationId, organizationId))
	return Object.fromEntries(
		rows.map((row) => [row.id, row.name || row.username]),
	) as Record<string, string>
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
