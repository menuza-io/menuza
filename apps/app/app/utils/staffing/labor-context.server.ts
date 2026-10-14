import { loadOrganizationScope } from '#app/utils/staffing/scope.server.ts'
import { DEFAULT_SCOPE_CURRENCY } from '#app/utils/staffing/staff-scopes.ts'

/**
 * Control-plane facts the Labor screens need about each scope: its name,
 * time zone and currency. Nothing here is staff data. Sales entered by hand
 * carry the scope's currency, and every amount on the screen is shown in it.
 */
export type LaborScope = {
	id: string
	name: string
	timeZone: string
	currency: 'USD' | 'CAD' | 'SAR'
}

export async function loadLaborScopes(
	organizationId: string,
	scopeIds: readonly string[] | null,
): Promise<LaborScope[]> {
	const scope = await loadOrganizationScope(organizationId)
	if (scopeIds !== null && !scopeIds.includes(scope.id)) return []
	return [{ ...scope, currency: DEFAULT_SCOPE_CURRENCY }]
}
