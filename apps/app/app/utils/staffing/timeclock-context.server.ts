import { loadOrganizationScopes } from '#app/utils/staffing/scope.server.ts'

/**
 * Control-plane facts the Time clock screens need about each scope: its
 * name and time zone. Nothing here is staff data. The browser forwards the time
 * zone and name when it creates a pairing code, so pairing works even if the
 * regional node cannot reach this app at that moment.
 */
export type TimeclockScope = {
	id: string
	name: string
	timeZone: string
}

export async function loadTimeclockScopes(
	organizationId: string,
	scopeIds: readonly string[] | null,
): Promise<TimeclockScope[]> {
	const scopes = await loadOrganizationScopes(organizationId)
	const allowed = scopeIds ? new Set(scopeIds) : null
	return scopes
		.filter((scope) => allowed === null || allowed.has(scope.id))
		.map(({ id, name, timeZone }) => ({ id, name, timeZone }))
}
