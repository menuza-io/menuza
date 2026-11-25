import {
	parseCateringSettings,
	type CateringNotifyEvent,
} from '@repo/common/catering'
import {
	and,
	db,
	eq,
	inArray,
	OrganizationLocation,
	User,
	UserOrganization,
} from '@repo/database'

export type CateringAlertRecipient = { userId: string; email: string }

const MAX_RECIPIENTS = 25

/** The in-app notification type for catering notices. */
export const CATERING_ALERT_TYPE = 'catering-alert'

/**
 * The members the location chose to tell about catering (`alertUserIds` in its
 * catering settings), limited to people who are still active members of the
 * organization and not banned. Capped, so a notice can never become a mass
 * mailing. A location with nobody chosen tells nobody.
 */
export async function resolveCateringAlertRecipients(input: {
	organizationId: string
	locationId: string
	now?: Date
}): Promise<CateringAlertRecipient[]> {
	const now = input.now ?? new Date()
	const [location] = await db
		.select({ catering: OrganizationLocation.catering })
		.from(OrganizationLocation)
		.where(
			and(
				eq(OrganizationLocation.organizationId, input.organizationId),
				eq(OrganizationLocation.id, input.locationId),
			),
		)
	const settings = parseCateringSettings(location?.catering)
	if (!settings?.enabled || settings.alertUserIds.length === 0) return []
	const rows = await db
		.select({
			userId: UserOrganization.userId,
			email: User.email,
			bannedAt: User.bannedAt,
			banExpiresAt: User.banExpiresAt,
		})
		.from(UserOrganization)
		.innerJoin(User, eq(User.id, UserOrganization.userId))
		.where(
			and(
				eq(UserOrganization.organizationId, input.organizationId),
				eq(UserOrganization.active, true),
				inArray(UserOrganization.userId, settings.alertUserIds),
			),
		)
	const seen = new Set<string>()
	const recipients: CateringAlertRecipient[] = []
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

/**
 * Plain English for the notice and its email (a request from the region
 * carries no locale). Built from a kind and a count only: no name, phone,
 * address, note or dish ever reaches this text.
 */
export function cateringAlertCopy(
	kind: CateringNotifyEvent['kind'],
	count: number,
) {
	switch (kind) {
		case 'quote_request':
			return {
				subject: 'New catering quote request',
				headline: 'New catering quote request',
				detail:
					count > 1
						? `${count} guests asked for a catering quote. Open Orders, Catering to price and send them.`
						: 'A guest asked for a catering quote. Open Orders, Catering to price and send it.',
			}
		case 'order_placed':
			return {
				subject: 'New catering order',
				headline: 'New catering order',
				detail:
					'A catering order was placed and its deposit (or payment) cleared. Open Orders, Catering to see the event.',
			}
		case 'quote_paid':
			return {
				subject: 'A catering quote was paid',
				headline: 'A catering quote was paid',
				detail:
					'A guest paid a catering quote. It is now a confirmed catering order under Orders, Catering.',
			}
		case 'balance_paid':
			return {
				subject: 'A catering balance was paid',
				headline: 'A catering balance was paid',
				detail:
					'The balance of a catering order was paid. The order is paid in full.',
			}
		case 'event_tomorrow':
			return {
				subject: 'A catering event is tomorrow',
				headline: 'A catering event is tomorrow',
				detail:
					'A confirmed catering order is for tomorrow. Open Orders, Catering to check the details and prep.',
			}
		case 'balance_overdue':
			return {
				subject: 'A catering balance is overdue',
				headline: 'A catering balance is overdue',
				detail:
					'The balance of a catering order was due and has not been paid. Open Orders, Catering to send the link again or change the due date.',
			}
	}
}
