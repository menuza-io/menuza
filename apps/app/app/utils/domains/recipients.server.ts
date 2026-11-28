import {
	and,
	db,
	eq,
	isNull,
	or,
	OrganizationRole,
	Permission,
	User,
	UserOrganization,
	_OrganizationPermissionToRole,
} from '@repo/database'

/**
 * Kept apart from `notify.server.ts` (which loads Lingui macros through the
 * domain alert copy) so code that must run outside the build, such as the SSO
 * failure notice, can resolve the same people.
 */

export type DomainAlertRecipient = { userId: string; email: string }

const MAX_RECIPIENTS = 20

/** Members whose role holds `update:settings:any`: the people who run the domain. */
export async function resolveDomainAlertRecipients(
	organizationId: string,
	now = new Date(),
): Promise<DomainAlertRecipient[]> {
	const rows = await db
		.select({
			userId: UserOrganization.userId,
			email: User.email,
			bannedAt: User.bannedAt,
			banExpiresAt: User.banExpiresAt,
		})
		.from(UserOrganization)
		.innerJoin(User, eq(User.id, UserOrganization.userId))
		.innerJoin(
			OrganizationRole,
			eq(OrganizationRole.id, UserOrganization.organizationRoleId),
		)
		.innerJoin(
			_OrganizationPermissionToRole,
			eq(_OrganizationPermissionToRole.A, OrganizationRole.id),
		)
		.innerJoin(Permission, eq(Permission.id, _OrganizationPermissionToRole.B))
		.where(
			and(
				eq(UserOrganization.organizationId, organizationId),
				eq(UserOrganization.active, true),
				or(
					isNull(OrganizationRole.organizationId),
					eq(OrganizationRole.organizationId, organizationId),
				),
				eq(Permission.context, 'organization'),
				eq(Permission.action, 'update'),
				eq(Permission.entity, 'settings'),
				eq(Permission.access, 'any'),
			),
		)
	const seen = new Set<string>()
	const out: DomainAlertRecipient[] = []
	for (const row of rows.sort((a, b) => a.userId.localeCompare(b.userId))) {
		if (seen.has(row.userId) || !row.email) continue
		if (
			row.bannedAt !== null &&
			(row.banExpiresAt === null || row.banExpiresAt > now)
		) {
			continue
		}
		seen.add(row.userId)
		out.push({ userId: row.userId, email: row.email })
		if (out.length >= MAX_RECIPIENTS) break
	}
	return out
}
