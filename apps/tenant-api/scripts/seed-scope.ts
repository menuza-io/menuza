import { db, eq, Organization } from '@repo/database'
import { DEFAULT_SCOPE_ID } from '@repo/staffing'

/**
 * The one scope every organization has: id `main`, the organization's name and
 * its staffing time zone from the control plane. The seeds read it directly, so
 * they do not need the App running.
 */
export async function loadSeedScope(organizationId: string) {
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
