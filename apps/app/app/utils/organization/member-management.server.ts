import {
	and,
	db,
	eq,
	isNull,
	or,
	OrganizationRole,
	Permission,
	UserOrganization,
	_OrganizationPermissionToRole,
} from '@repo/database'
import {
	resolveMemberLocationIds,
	scopeIsInside,
} from '#app/utils/location/member-scope.server.ts'

/**
 * One guard for every team change (#126): invite, role change, location change
 * and removal. An organization admin is unrestricted (the callers keep their
 * own last-admin and self checks). Everybody else may only:
 *
 * - grant locations inside their own scope (`location_not_in_your_scope`);
 * - grant a role whose permissions they hold themselves, and never Admin
 *   (`role_above_yours`);
 * - change or remove members whose scope lies inside their own and who are not
 *   admins (`member_outside_your_scope`, `cannot_manage_admin`), and never
 *   themselves (`cannot_change_self`).
 *
 * The codes are stable: the UI and the tests match on them.
 */

export const OWN_LOCATIONS_PERMISSION = {
	action: 'update',
	entity: 'member',
	access: 'own_locations',
} as const

export const MEMBER_MANAGEMENT_ERRORS = {
	location_not_in_your_scope: {
		status: 403,
		message: 'You can only give access to locations you have yourself.',
	},
	role_above_yours: {
		status: 403,
		message: 'You can only give a role that has no permission you lack.',
	},
	member_outside_your_scope: {
		status: 403,
		message:
			'This member has access to locations outside yours, so you can view but not change them.',
	},
	cannot_manage_admin: {
		status: 403,
		message: 'Only organization admins can change an admin.',
	},
	cannot_change_self: {
		status: 400,
		message: 'You cannot change your own role or locations.',
	},
	locations_required: {
		status: 400,
		message: 'Choose at least one location.',
	},
	forbidden: { status: 403, message: 'You cannot manage team members.' },
} as const
export type MemberManagementErrorCode = keyof typeof MEMBER_MANAGEMENT_ERRORS

export type MemberActor = {
	userId: string
	organizationId: string
	isAdmin: boolean
	/** Holds `update:member:own_locations`. */
	manageOwnLocations: boolean
	/** `null` is every location. */
	scope: string[] | null
	/** `action:entity:access` of every permission the actor's role carries. */
	permissions: Set<string>
}

export type MemberCheck =
	| { ok: true }
	| { ok: false; code: MemberManagementErrorCode; status: number; error: string }

function refuse(code: MemberManagementErrorCode): MemberCheck {
	const { status, message } = MEMBER_MANAGEMENT_ERRORS[code]
	return { ok: false, code, status, error: message }
}

const key = (p: { action: string; entity: string; access: string }) =>
	`${p.action}:${p.entity}:${p.access}`

async function permissionKeysOfRole(
	organizationId: string,
	roleId: string,
): Promise<Set<string>> {
	const rows = await db
		.select({
			action: Permission.action,
			entity: Permission.entity,
			access: Permission.access,
		})
		.from(_OrganizationPermissionToRole)
		.innerJoin(
			OrganizationRole,
			eq(OrganizationRole.id, _OrganizationPermissionToRole.A),
		)
		.innerJoin(Permission, eq(Permission.id, _OrganizationPermissionToRole.B))
		.where(
			and(
				eq(_OrganizationPermissionToRole.A, roleId),
				eq(Permission.context, 'organization'),
				or(
					isNull(OrganizationRole.organizationId),
					eq(OrganizationRole.organizationId, organizationId),
				),
			),
		)
	return new Set(rows.map(key))
}

/** The acting member: role, permissions and resolved location scope. */
export async function loadMemberActor(
	userId: string,
	organizationId: string,
): Promise<MemberActor | null> {
	const [membership] = await db
		.select({
			roleId: UserOrganization.organizationRoleId,
			active: UserOrganization.active,
		})
		.from(UserOrganization)
		.where(
			and(
				eq(UserOrganization.userId, userId),
				eq(UserOrganization.organizationId, organizationId),
			),
		)
		.limit(1)
	if (!membership?.active) return null
	const [permissions, scope] = await Promise.all([
		permissionKeysOfRole(organizationId, membership.roleId),
		resolveMemberLocationIds(userId, organizationId),
	])
	return {
		userId,
		organizationId,
		isAdmin: membership.roleId === 'org_role_admin',
		manageOwnLocations: permissions.has(key(OWN_LOCATIONS_PERMISSION)),
		scope,
		permissions,
	}
}

/** Role assignable by this actor: never Admin, and nothing they lack. */
export async function checkRoleAssignable(
	actor: MemberActor,
	roleId: string,
): Promise<MemberCheck> {
	if (actor.isAdmin) return { ok: true }
	if (roleId === 'org_role_admin') return refuse('role_above_yours')
	const wanted = await permissionKeysOfRole(actor.organizationId, roleId)
	for (const permission of wanted) {
		if (!actor.permissions.has(permission)) return refuse('role_above_yours')
	}
	return { ok: true }
}

/** Locations an actor may hand out: only ones inside their own scope. */
export function checkLocationsGrantable(
	actor: MemberActor,
	grant: { scope: 'all' | 'selected'; locationIds: readonly string[] },
): MemberCheck {
	if (actor.isAdmin || actor.scope === null) return { ok: true }
	if (grant.scope !== 'selected') return refuse('location_not_in_your_scope')
	if (grant.locationIds.length === 0) return refuse('locations_required')
	const inside = grant.locationIds.every((id) => actor.scope!.includes(id))
	return inside ? { ok: true } : refuse('location_not_in_your_scope')
}

/**
 * Whether the actor may change or remove this member. `checkRole` adds the
 * role comparison used by role and location changes; removal leaves it out
 * because removing someone only takes access away.
 */
export async function checkMemberManageable(
	actor: MemberActor,
	targetUserId: string,
	options: { checkRole: boolean } = { checkRole: true },
): Promise<MemberCheck> {
	if (targetUserId === actor.userId) return refuse('cannot_change_self')
	if (actor.isAdmin) return { ok: true }
	const [target] = await db
		.select({
			roleId: UserOrganization.organizationRoleId,
			active: UserOrganization.active,
		})
		.from(UserOrganization)
		.where(
			and(
				eq(UserOrganization.userId, targetUserId),
				eq(UserOrganization.organizationId, actor.organizationId),
			),
		)
		.limit(1)
	// A member who is not there looks the same as one outside the scope.
	if (!target) return refuse('member_outside_your_scope')
	if (target.roleId === 'org_role_admin') return refuse('cannot_manage_admin')
	const targetScope = await resolveMemberLocationIds(
		targetUserId,
		actor.organizationId,
	)
	if (!scopeIsInside(targetScope, actor.scope)) {
		return refuse('member_outside_your_scope')
	}
	if (options.checkRole) {
		const assignable = await checkRoleAssignable(actor, target.roleId)
		if (!assignable.ok) return assignable
	}
	return { ok: true }
}

/** The single guard the routes call, by action. */
export async function assertCanManageMember(
	actor: MemberActor,
	input:
		| {
				action: 'invite'
				roleId: string
				scope: 'all' | 'selected'
				locationIds: readonly string[]
		  }
		| { action: 'remove'; targetUserId: string }
		| { action: 'change_role'; targetUserId: string; roleId: string }
		| {
				action: 'change_locations'
				targetUserId: string
				scope: 'all' | 'selected'
				locationIds: readonly string[]
		  },
): Promise<MemberCheck> {
	if (input.action === 'invite') {
		const role = await checkRoleAssignable(actor, input.roleId)
		if (!role.ok) return role
		return checkLocationsGrantable(actor, input)
	}
	if (input.action === 'remove') {
		return checkMemberManageable(actor, input.targetUserId, {
			checkRole: false,
		})
	}
	const manageable = await checkMemberManageable(actor, input.targetUserId)
	if (!manageable.ok) return manageable
	if (input.action === 'change_role') {
		return checkRoleAssignable(actor, input.roleId)
	}
	return checkLocationsGrantable(actor, input)
}

/** A JSON `Response` for a refused check, shaped like the route's other errors. */
export function memberCheckResponse(check: Extract<MemberCheck, { ok: false }>) {
	return Response.json(
		{ error: check.error, code: check.code },
		{ status: check.status },
	)
}

/**
 * Which of these members the actor may change (role, locations, removal), for
 * showing or hiding the controls. The server still checks every write. An admin
 * may change everyone but themselves.
 */
export async function manageableMemberIds(
	actor: MemberActor,
	members: ReadonlyArray<{ userId: string; roleId: string }>,
	scopes: ReadonlyMap<string, string[] | null>,
): Promise<Set<string>> {
	const out = new Set<string>()
	if (!actor.isAdmin && !actor.manageOwnLocations) return out
	const roleOk = new Map<string, boolean>()
	for (const member of members) {
		if (member.userId === actor.userId) continue
		if (actor.isAdmin) {
			out.add(member.userId)
			continue
		}
		if (member.roleId === 'org_role_admin') continue
		if (!scopeIsInside(scopes.get(member.userId) ?? [], actor.scope)) continue
		if (!roleOk.has(member.roleId)) {
			roleOk.set(
				member.roleId,
				(await checkRoleAssignable(actor, member.roleId)).ok,
			)
		}
		if (roleOk.get(member.roleId)) out.add(member.userId)
	}
	return out
}
