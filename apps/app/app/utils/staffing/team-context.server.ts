import { and, asc, db, eq, User, UserOrganization } from '@repo/database'
import { loadOrganizationScope } from '#app/utils/staffing/scope.server.ts'
import {
	DEFAULT_SCOPE_CURRENCY,
	type ImportableMember,
	type StaffScope,
} from './staff-scopes.ts'

/**
 * Control-plane facts the Team screens need. Nothing here is customer or staff
 * data: scope names and currencies, and the login identity of members the
 * manager may choose to import (US-held by design).
 */

export async function loadStaffScopes(
	organizationId: string,
): Promise<StaffScope[]> {
	const scope = await loadOrganizationScope(organizationId)
	return [{ id: scope.id, name: scope.name, currency: DEFAULT_SCOPE_CURRENCY }]
}

/** Active members of the organization, for the "Import current members" step. */
export async function loadImportableMembers(
	organizationId: string,
): Promise<ImportableMember[]> {
	const rows = await db
		.select({
			userId: User.id,
			name: User.name,
			email: User.email,
		})
		.from(UserOrganization)
		.innerJoin(User, eq(User.id, UserOrganization.userId))
		.where(
			and(
				eq(UserOrganization.organizationId, organizationId),
				eq(UserOrganization.active, true),
			),
		)
		.orderBy(asc(User.name), asc(User.email))
	return rows.map((row) => ({
		userId: row.userId,
		name: row.name?.trim() || row.email.split('@')[0] || row.email,
		email: row.email,
	}))
}

/**
 * Keeps only the scopes a scope-limited manager may use. `null` means
 * every workplace (the default); an empty list leaves nothing.
 */
export function filterScopesToScope(
	scopes: readonly StaffScope[],
	scopeIds: readonly string[] | null,
): StaffScope[] {
	if (scopeIds === null) return [...scopes]
	const allowed = new Set(scopeIds)
	return scopes.filter((scope) => allowed.has(scope.id))
}
