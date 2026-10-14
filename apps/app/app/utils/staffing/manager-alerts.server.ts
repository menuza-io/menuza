import {
	and,
	db,
	eq,
	inArray,
	isNull,
	Notification,
	NotificationPreference,
	OrganizationRole,
	or,
	Permission,
	User,
	UserOrganization,
	_OrganizationPermissionToRole,
} from '@repo/database'
import {
	grantsSatisfying,
	MANAGER_ALERT_PERMISSIONS,
	MANAGER_ALERT_WORKFLOW,
	type ManagerAlertKind,
} from '@repo/staffing'
import { resolveStaffingScopeIds } from '#app/utils/staffing/scope-claim.server.ts'

/**
 * Who a manager alert goes to, and how. Everything here is control-plane data:
 * members, roles, scope scope and notification preferences. The alert itself
 * is a kind, a scope id and a count, so nothing about staff is read.
 */

export type AlertRecipient = {
	userId: string
	email: string
	name: string | null
}

export const MAX_ALERT_RECIPIENTS = 200

function parseGrant(grant: string) {
	const [action = '', entity = '', access = ''] = grant.split(':')
	return { action, entity, access }
}

/**
 * Active members whose role grants the permission the alert needs (a stronger
 * grant counts) and whose scope scope covers the alert's scope. An alert
 * that is not about one scope goes only to members with every workplace.
 * Banned members are left out. The result is capped and ordered, so one noisy
 * organization cannot turn an alert into a mass mailing.
 */
export async function resolveAlertRecipients(input: {
	organizationId: string
	kind: ManagerAlertKind
	scopeId: string | null
	now?: Date
}): Promise<AlertRecipient[]> {
	const now = input.now ?? new Date()
	const grants = [
		...new Set(
			MANAGER_ALERT_PERMISSIONS[input.kind].flatMap((p) => grantsSatisfying(p)),
		),
	]
	const grantConditions = grants.map((grant) => {
		const { action, entity, access } = parseGrant(grant)
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
			name: User.name,
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
		const scope = await resolveStaffingScopeIds(
			row.userId,
			input.organizationId,
		)
		const covered =
			scope === null ||
			(input.scopeId !== null && scope.includes(input.scopeId))
		if (!covered) continue
		recipients.push({ userId: row.userId, email: row.email, name: row.name })
		if (recipients.length >= MAX_ALERT_RECIPIENTS) break
	}
	return recipients
}

export type ChannelPreference = { inApp: boolean; email: boolean }

/**
 * Each recipient's channels for the alert's workflow. A member who never touched
 * the setting gets both (the default is on).
 */
export async function loadChannelPreferences(input: {
	organizationId: string
	kind: ManagerAlertKind
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
				eq(NotificationPreference.workflow, MANAGER_ALERT_WORKFLOW[input.kind]),
				inArray(NotificationPreference.userId, [...input.userIds]),
			),
		)
	for (const row of rows) {
		result.set(row.userId, { inApp: row.inApp, email: row.email })
	}
	return result
}

/** Ids already notified for an event, so a retried delivery repeats nothing. */
export async function loadNotifiedUserIds(input: {
	organizationId: string
	type: string
	eventId: string
	userIds: readonly string[]
}): Promise<Set<string>> {
	if (input.userIds.length === 0) return new Set()
	const rows = await db
		.select({ userId: Notification.userId })
		.from(Notification)
		.where(
			and(
				eq(Notification.organizationId, input.organizationId),
				eq(Notification.type, input.type),
				eq(Notification.entityId, input.eventId),
				inArray(Notification.userId, [...input.userIds]),
			),
		)
	return new Set(rows.map((row) => row.userId))
}
