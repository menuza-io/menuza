import { loadOrganizationScopes } from '#app/utils/staffing/scope.server.ts'
import { type ScopeCurrency } from '#app/utils/staffing/staff-scopes.ts'

/**
 * Control-plane facts the Labor screens need about each scope: its name,
 * time zone and currency. Nothing here is staff data. Sales entered by hand
 * carry the scope's currency, and every amount on the screen is shown in it.
 */
export type LaborScope = {
	id: string
	name: string
	timeZone: string
	currency: ScopeCurrency
}

export async function loadLaborScopes(
	organizationId: string,
	scopeIds: readonly string[] | null,
): Promise<LaborScope[]> {
	const scopes = await loadOrganizationScopes(organizationId)
	const allowed = scopeIds ? new Set(scopeIds) : null
	return scopes
		.filter((scope) => allowed === null || allowed.has(scope.id))
		.map(({ id, name, timeZone, currency }) => ({
			id,
			name,
			timeZone,
			currency,
		}))
}
