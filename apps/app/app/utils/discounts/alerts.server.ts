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

export type DiscountAlertRecipient = { userId: string; email: string }

const MAX_RECIPIENTS = 50

/**
 * Active, unbanned members whose role holds `update:discount:any`: the people
 * who change discounts, so the ones to hear that a weekly budget ran out
 * (#392). Capped, so a notice can never become a mass mailing.
 */
export async function resolveDiscountAlertRecipients(input: {
	organizationId: string
	now?: Date
}): Promise<DiscountAlertRecipient[]> {
	const now = input.now ?? new Date()
	const [action = '', entity = '', access = ''] = 'update:discount:any'.split(
		':',
	)
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
				eq(UserOrganization.organizationId, input.organizationId),
				eq(UserOrganization.active, true),
				or(
					isNull(OrganizationRole.organizationId),
					eq(OrganizationRole.organizationId, input.organizationId),
				),
				eq(Permission.context, 'organization'),
				eq(Permission.action, action),
				eq(Permission.entity, entity),
				eq(Permission.access, access),
			),
		)
	const seen = new Set<string>()
	const recipients: DiscountAlertRecipient[] = []
	for (const row of rows.sort((a, b) => a.userId.localeCompare(b.userId))) {
		if (seen.has(row.userId) || !row.email) continue
		const banned =
			row.bannedAt !== null &&
			(row.banExpiresAt === null || row.banExpiresAt > now)
		if (banned) continue
		seen.add(row.userId)
		recipients.push({ userId: row.userId, email: row.email })
		if (recipients.length >= MAX_RECIPIENTS) break
	}
	return recipients
}
