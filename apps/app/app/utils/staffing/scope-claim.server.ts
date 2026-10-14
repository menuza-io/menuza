import { resolveLocationGrantIds } from '#app/utils/staffing/restaurant/location-scope.server.ts'

/**
 * The `scopeIds` claim for a staffing token (control plane, ids only).
 *
 * `null` means every scope. A member can be limited to chosen restaurant
 * locations (the scope ids are location ids); an inactive or missing
 * membership, or a stored value this code does not recognize, resolves to no
 * scopes at all (fail closed). Organizations without locations never limit a
 * member, since every member starts on `all`. tenant-api applies the claim on
 * every route through `scopeToScopes`.
 */
export async function resolveStaffingScopeIds(
	userId: string,
	organizationId: string,
): Promise<string[] | null> {
	return resolveLocationGrantIds(userId, organizationId)
}
