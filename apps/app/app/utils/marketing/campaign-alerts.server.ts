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
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'

export type CampaignAlertRecipient = { userId: string; email: string }

const MAX_RECIPIENTS = 50

/**
 * Active, unbanned members whose role holds `update:campaign:any`: the people
 * who can duplicate and reschedule a broadcast. Capped, so an alert can never
 * become a mass mailing.
 */
export async function resolveCampaignAlertRecipients(input: {
	organizationId: string
	now?: Date
}): Promise<CampaignAlertRecipient[]> {
	const now = input.now ?? new Date()
	const [action = '', entity = '', access = ''] =
		ORG_PERMISSIONS.UPDATE_CAMPAIGN_ANY.split(':')

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
	const recipients: CampaignAlertRecipient[] = []
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
