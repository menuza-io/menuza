import {
	and,
	db,
	eq,
	inArray,
	isNull,
	OrganizationRole,
	or,
	Permission,
	User,
	UserOrganization,
	_OrganizationPermissionToRole,
} from '@repo/database'
import { resolveMemberLocationIds } from '#app/utils/location/member-scope.server.ts'

export type AlertMember = {
	userId: string
	email: string
	/** Holds `update:settings:any`: the "owners and managers" push defaults apply. */
	isManager: boolean
}

/** Capped so one noisy organization cannot turn an alert into a mass mailing. */
export const MAX_ALERT_MEMBERS = 200

const MANAGER_PERMISSION = 'update:settings:any'

function parse(permission: string) {
	const [action = '', entity = '', access = ''] = permission.split(':')
	return { action, entity, access }
}

/**
 * Active, unbanned members whose role holds `permission` and whose location
 * scope covers the alert's location (`null` location: any scope). Ordered by
 * id and capped. Removing a member, deactivating them or taking the permission
 * away drops them here, so they are never alerted again.
 */
export async function resolveAlertMembers(input: {
	organizationId: string
	permission: string
	locationId: string | null
	now?: Date
}): Promise<AlertMember[]> {
	const now = input.now ?? new Date()
	const wanted = [input.permission, MANAGER_PERMISSION].map((permission) => {
		const { action, entity, access } = parse(permission)
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
				or(...wanted),
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

	const out: AlertMember[] = []
	for (const [userId, member] of [...members].sort(([a], [b]) =>
		a.localeCompare(b),
	)) {
		if (member.banned || !member.email) continue
		if (!member.held.has(input.permission)) continue
		if (input.locationId !== null) {
			const scope = await resolveMemberLocationIds(userId, input.organizationId)
			if (scope !== null && !scope.includes(input.locationId)) continue
		}
		out.push({
			userId,
			email: member.email,
			isManager: member.held.has(MANAGER_PERMISSION),
		})
		if (out.length >= MAX_ALERT_MEMBERS) break
	}
	return out
}

/** Whether these users are still active members (the push checks this at send time). */
export async function activeMemberIds(
	organizationId: string,
	userIds: readonly string[],
): Promise<Set<string>> {
	if (userIds.length === 0) return new Set()
	const rows = await db
		.select({ userId: UserOrganization.userId })
		.from(UserOrganization)
		.where(
			and(
				eq(UserOrganization.organizationId, organizationId),
				eq(UserOrganization.active, true),
				inArray(UserOrganization.userId, [...userIds]),
			),
		)
	return new Set(rows.map((row) => row.userId))
}
