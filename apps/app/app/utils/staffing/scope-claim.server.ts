import { and, db, eq, UserOrganization } from '@repo/database'

/**
 * The `scopeIds` claim for a staffing token (control plane, ids only).
 *
 * `null` means every workplace, which is the only answer the generic module
 * gives: it has one implicit scope and no per-member limits. An inactive or
 * missing membership resolves to no scopes at all (fail closed). A vertical
 * that limits members to some scopes replaces this resolver; tenant-api
 * already applies the claim on every route through `scopeToScopes`.
 */
export async function resolveStaffingScopeIds(
	userId: string,
	organizationId: string,
): Promise<string[] | null> {
	const [membership] = await db
		.select({ active: UserOrganization.active })
		.from(UserOrganization)
		.where(
			and(
				eq(UserOrganization.userId, userId),
				eq(UserOrganization.organizationId, organizationId),
			),
		)
		.limit(1)
	if (!membership?.active) return []
	return null
}
