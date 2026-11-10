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
import { type InventoryNotifyKind } from '@repo/inventory'
import { resolveDiscountLocationIds } from '#app/utils/discounts/location-scope.server.ts'
import {
	INVENTORY_ALERT_GRANTS,
	inventoryAlertAllowedFor,
	inventoryAlertWorkflow,
} from './manager-alerts.ts'

export type AlertRecipient = { userId: string; email: string }

export const MAX_ALERT_RECIPIENTS = 200

/**
 * Active, unbanned members whose role holds an inventory grant (every one of
 * them reads stock), whose location scope covers the alert's location and, for
 * a kind that carries money, who hold `read:inventory_cost:any`. Capped and
 * ordered so one noisy organization cannot turn an alert into a mass mailing.
 */
export async function resolveInventoryAlertRecipients(input: {
	organizationId: string
	locationId: string
	kind: InventoryNotifyKind
	now?: Date
}): Promise<AlertRecipient[]> {
	const now = input.now ?? new Date()
	const grantConditions = INVENTORY_ALERT_GRANTS.map((grant) => {
		const [action = '', entity = '', access = ''] = grant.split(':')
		return and(
			eq(Permission.action, action),
			eq(Permission.entity, entity),
			eq(Permission.access, access),
		)
	})

	const rows = await db
		.select({
			userId: UserOrganization.userId,
			email: User.email,
			bannedAt: User.bannedAt,
			banExpiresAt: User.banExpiresAt,
			action: Permission.action,
			entity: Permission.entity,
			access: Permission.access,
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

	const members = new Map<
		string,
		{ email: string; banned: boolean; held: Set<string> }
	>()
	for (const row of rows) {
		const banned =
			row.bannedAt !== null &&
			(row.banExpiresAt === null || row.banExpiresAt > now)
		const member = members.get(row.userId) ?? {
			email: row.email,
			banned,
			held: new Set<string>(),
		}
		member.held.add(`${row.action}:${row.entity}:${row.access}`)
		members.set(row.userId, member)
	}

	const recipients: AlertRecipient[] = []
	for (const [userId, member] of [...members].sort(([a], [b]) =>
		a.localeCompare(b),
	)) {
		if (member.banned || !member.email) continue
		if (!inventoryAlertAllowedFor(input.kind, member.held)) continue
		const scope = await resolveDiscountLocationIds(userId, input.organizationId)
		if (scope !== null && !scope.includes(input.locationId)) continue
		recipients.push({ userId, email: member.email })
		if (recipients.length >= MAX_ALERT_RECIPIENTS) break
	}
	return recipients
}

export type ChannelPreference = { inApp: boolean; email: boolean }

/** A member who never touched the setting gets both channels. */
export async function loadInventoryChannelPreferences(input: {
	organizationId: string
	kind: InventoryNotifyKind
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
				eq(NotificationPreference.workflow, inventoryAlertWorkflow(input.kind)),
				inArray(NotificationPreference.userId, [...input.userIds]),
			),
		)
	for (const row of rows) {
		result.set(row.userId, { inApp: row.inApp, email: row.email })
	}
	return result
}
