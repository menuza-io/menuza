import { db, eq, Organization } from '@repo/database'
import { DEFAULT_SCOPE_ID } from '@repo/staffing'

/**
 * The one scope every organization has (control plane, ids and names only).
 *
 * The generic Staff module has a single implicit scope, `main`. Its display
 * name is the organization's name and its time zone is the organization's
 * `staffingTimeZone` setting. A vertical with several scopes replaces this
 * loader; every caller already treats the result as a list.
 */
export type OrganizationScopeFacts = {
	id: string
	/** The organization's name. */
	name: string
	timeZone: string
}

export async function loadOrganizationScope(
	organizationId: string,
): Promise<OrganizationScopeFacts> {
	const [row] = await db
		.select({
			name: Organization.name,
			timeZone: Organization.staffingTimeZone,
		})
		.from(Organization)
		.where(eq(Organization.id, organizationId))
		.limit(1)
	return {
		id: DEFAULT_SCOPE_ID,
		name: row?.name ?? '',
		timeZone: row?.timeZone || 'UTC',
	}
}
