import { getLocationCurrency } from '@repo/common/location-currency'
import { asc, db, eq, OrganizationLocation } from '@repo/database'
import {
	displayLocationName,
	orgDefaultLocale,
} from '#app/utils/location-name.server.ts'
import { type OrganizationScopeFacts } from '#app/utils/staffing/staff-scopes.ts'

/**
 * Restaurant scopes: one staffing scope per `OrganizationLocation`.
 *
 * The scope id is the location id (the regional database keeps it as an opaque
 * `scope_id`). The time zone is the location's, the currency is derived from
 * its address (never stored), and the name is resolved in the organization's
 * default language. Returns `null` when the organization has no locations at
 * all, so the caller falls back to the generic single scope. An organization
 * whose locations are all inactive returns an empty list, not the fallback.
 */
export async function loadLocationScopes(
	organizationId: string,
	options: { includeInactive?: boolean } = {},
): Promise<OrganizationScopeFacts[] | null> {
	const rows = await db
		.select({
			id: OrganizationLocation.id,
			name: OrganizationLocation.name,
			timeZone: OrganizationLocation.timezone,
			address: OrganizationLocation.address,
			isActive: OrganizationLocation.isActive,
		})
		.from(OrganizationLocation)
		.where(eq(OrganizationLocation.organizationId, organizationId))
		.orderBy(asc(OrganizationLocation.name))
	if (rows.length === 0) return null

	const defaultLocale = await orgDefaultLocale(organizationId)
	return rows
		.filter((row) => options.includeInactive || row.isActive)
		.map((row) => ({
			id: row.id,
			name: displayLocationName(row.name, defaultLocale, defaultLocale),
			timeZone: row.timeZone || 'UTC',
			currency: getLocationCurrency(row.address),
			isActive: row.isActive,
		}))
}

/** True when the organization has any restaurant location (active or not). */
export async function organizationHasLocations(
	organizationId: string,
): Promise<boolean> {
	const [row] = await db
		.select({ id: OrganizationLocation.id })
		.from(OrganizationLocation)
		.where(eq(OrganizationLocation.organizationId, organizationId))
		.limit(1)
	return Boolean(row)
}
