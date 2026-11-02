import { db, eq, and, User, UserOrganization } from '@repo/database'

/**
 * True only for an unbanned user with an active membership. Every check that
 * grants access to organization data on a user's behalf (media, MCP tokens,
 * API keys) must go through this, so they cannot drift apart.
 */
export async function isActiveOrganizationMember(
	userId: string,
	organizationId: string,
) {
	const [row] = await db
		.select({ isBanned: User.isBanned, active: UserOrganization.active })
		.from(User)
		.innerJoin(
			UserOrganization,
			and(
				eq(UserOrganization.userId, User.id),
				eq(UserOrganization.organizationId, organizationId),
			),
		)
		.where(eq(User.id, userId))
		.limit(1)
	return Boolean(row && !row.isBanned && row.active)
}
