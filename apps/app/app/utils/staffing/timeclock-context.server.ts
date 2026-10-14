import { loadOrganizationScope } from '#app/utils/staffing/scope.server.ts'

/**
 * Control-plane facts the Time clock screens need about each workplace: its
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
	const scope = await loadOrganizationScope(organizationId)
	if (scopeIds !== null && !scopeIds.includes(scope.id)) return []
	return [scope]
}
