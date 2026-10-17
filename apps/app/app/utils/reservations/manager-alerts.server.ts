import {
	and,
	db,
	eq,
	inArray,
	isNull,
	NotificationPreference,
	OrganizationRole,
	or,
	Permission,
	User,
	UserOrganization,
	_OrganizationPermissionToRole,
} from '@repo/database'
import { resolveReservationsLocationIds } from '#app/utils/reservations/access.server.ts'
import {
	RESERVATION_ALERT_GRANTS,
	reservationAlertWorkflow,
	type ReservationAlertKind,
} from '#app/utils/reservations/manager-alerts.ts'

export type AlertRecipient = { userId: string; email: string }

export const MAX_ALERT_RECIPIENTS = 200

/**
 * Active, unbanned members whose role grants `read:reservation:any` (or a
 * stronger grant) or `update:reservation_settings:any` and whose location scope
 * covers the alert's location. Capped and ordered so one noisy organization
 * cannot turn an alert into a mass mailing.
 */
export async function resolveReservationAlertRecipients(input: {
	organizationId: string
	locationId: string
	now?: Date
}): Promise<AlertRecipient[]> {
	const now = input.now ?? new Date()
	const grantConditions = RESERVATION_ALERT_GRANTS.map((grant) => {
		const [action = '', entity = '', access = ''] = grant.split(':')
		return and(
			eq(Permission.action, action),
			eq(Permission.entity, entity),
			eq(Permission.access, access),
		)
	})

	const rows = await db
		.selectDistinct({
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
				or(...grantConditions),
			),
		)

	const recipients: AlertRecipient[] = []
	for (const row of rows.sort((a, b) => a.userId.localeCompare(b.userId))) {
		const banned =
			row.bannedAt !== null &&
			(row.banExpiresAt === null || row.banExpiresAt > now)
		if (banned || !row.email) continue
		const scope = await resolveReservationsLocationIds(
			row.userId,
			input.organizationId,
		)
		if (scope !== null && !scope.includes(input.locationId)) continue
		recipients.push({ userId: row.userId, email: row.email })
		if (recipients.length >= MAX_ALERT_RECIPIENTS) break
	}
	return recipients
}

export type ChannelPreference = { inApp: boolean; email: boolean }

/** A member who never touched the setting gets both channels. */
export async function loadReservationChannelPreferences(input: {
	organizationId: string
	kind: ReservationAlertKind
	userIds: readonly string[]
}): Promise<Map<string, ChannelPreference>> {
	const result = new Map<string, ChannelPreference>(
		input.userIds.map((id) => [id, { inApp: true, email: true }]),
	)
	if (input.userIds.length === 0) return result
	const rows = await db
		.select({
			userId: NotificationPreference.userId,
			inApp: NotificationPreference.inApp,
			email: NotificationPreference.email,
		})
		.from(NotificationPreference)
		.where(
			and(
				eq(NotificationPreference.organizationId, input.organizationId),
				eq(
					NotificationPreference.workflow,
					reservationAlertWorkflow(input.kind),
				),
				inArray(NotificationPreference.userId, [...input.userIds]),
			),
		)
	for (const row of rows) {
		result.set(row.userId, { inApp: row.inApp, email: row.email })
	}
	return result
}
