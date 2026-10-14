import { db, eq, Organization } from '@repo/database'
import { DEFAULT_SCOPE_ID } from '@repo/staffing'
import { loadLocationScopes } from '#app/utils/staffing/restaurant/location-scopes.server.ts'
import {
	DEFAULT_SCOPE_CURRENCY,
	type OrganizationScopeFacts,
} from '#app/utils/staffing/staff-scopes.ts'

export { type OrganizationScopeFacts }

/**
 * Every scope of the organization, one per location when it has locations
 * (active ones only unless `includeInactive`), else the one implicit scope.
 */
export async function loadOrganizationScopes(
	organizationId: string,
	options: { includeInactive?: boolean } = {},
): Promise<OrganizationScopeFacts[]> {
	const locations = await loadLocationScopes(organizationId, options)
	if (locations) return locations
	return [await loadOrganizationScope(organizationId)]
}

/** True when the scopes are restaurant locations rather than the implicit one. */
export function hasLocationScopes(
	scopes: readonly OrganizationScopeFacts[],
): boolean {
	return scopes.some((scope) => scope.id !== DEFAULT_SCOPE_ID)
}

/**
 * The implicit scope every organization has (control plane, ids and names only;
 * ignores locations).
 *
 * The generic Staff module has a single implicit scope, `main`. Its display
 * name is the organization's name and its time zone is the organization's
 * `staffingTimeZone` setting. An organization that has restaurant locations
 * has one scope per location instead (see `loadOrganizationScopes`).
 */
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
		currency: DEFAULT_SCOPE_CURRENCY,
		isActive: true,
	}
}
