import {
	GIFT_CARD_PERMISSIONS,
	type GiftCardNotifyEvent,
} from '@repo/common/gift-cards'
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

export type GiftCardAlertRecipient = { userId: string; email: string }

const MAX_RECIPIENTS = 50

/** The in-app notification type for gift card notices. */
export const GIFT_CARD_ALERT_TYPE = 'gift-card-alert'

/**
 * Active, unbanned members whose role holds `update:gift_card:any`: the people
 * who review held purchases and adjust cards. Capped, so a notice can never
 * become a mass mailing.
 */
export async function resolveGiftCardAlertRecipients(input: {
	organizationId: string
	now?: Date
}): Promise<GiftCardAlertRecipient[]> {
	const now = input.now ?? new Date()
	const [action = '', entity = '', access = ''] =
		GIFT_CARD_PERMISSIONS.UPDATE_GIFT_CARD.split(':')
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
	const recipients: GiftCardAlertRecipient[] = []
	for (const row of rows.sort((a, b) => a.userId.localeCompare(b.userId))) {
		if (seen.has(row.userId) || !row.email) continue
		const banned =
			row.bannedAt !== null && (row.banExpiresAt === null || row.banExpiresAt > now)
		if (banned) continue
		seen.add(row.userId)
		recipients.push({ userId: row.userId, email: row.email })
		if (recipients.length >= MAX_RECIPIENTS) break
	}
	return recipients
}

/** Plain English for the email (a request from the region carries no locale). */
export function giftCardAlertCopy(kind: GiftCardNotifyEvent['kind'], count: number) {
	switch (kind) {
		case 'burst':
			return {
				subject: 'Many gift card purchases from one device',
				headline: 'Many gift card purchases from one device',
				detail: `${count} gift cards were bought from one device within an hour. Open Gift cards to review them.`,
			}
		case 'needs_review':
			return {
				subject: 'A gift card purchase needs review',
				headline: 'A gift card purchase needs review',
				detail:
					'The payment provider flagged a gift card purchase as higher risk. The card is on hold until you approve it or refund the buyer.',
			}
		case 'frozen':
			return {
				subject: 'A gift card was frozen: payment dispute',
				headline: 'A gift card was frozen',
				detail:
					'A gift card purchase was disputed, so the card was frozen at once. Open it to see what was spent before the freeze.',
			}
		case 'delivery_failed':
			return {
				subject: 'A gift card email could not be delivered',
				headline: 'A gift card email could not be delivered',
				detail:
					'A paid gift card could not be emailed to its recipient after several tries. Open Gift cards and check the card.',
			}
	}
}
