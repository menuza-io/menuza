import { getCatalog, type ReportCatalog, withScopeWording } from '@repo/reports'
import { organizationHasLocations } from '#app/utils/staffing/restaurant/location-scopes.server.ts'
import { type ScopeWording } from '#app/utils/staffing/scope-wording.ts'

/**
 * The organization report catalog for one organization. Where a scope is a
 * restaurant location the staffing subjects say "Location" instead of
 * "Workplace". Only labels and descriptions change; field ids are untouched,
 * so saved reports keep working.
 */
export async function organizationReportCatalog(
	organizationId: string,
): Promise<{ catalog: ReportCatalog; scopeWording: ScopeWording }> {
	const catalog = getCatalog('organization')
	if (!(await organizationHasLocations(organizationId))) {
		return { catalog, scopeWording: 'workplace' }
	}
	return {
		catalog: {
			...catalog,
			subjects: withScopeWording(catalog.subjects, 'location'),
		},
		scopeWording: 'location',
	}
}
