import { requireUserId } from '@repo/auth'
import { invalidateUserOrganizationsCache } from '@repo/cache'
import {
	and,
	asc,
	count,
	desc,
	db,
	eq,
	inArray,
	or,
	Organization,
	OrganizationRole,
	Permission,
	_OrganizationPermissionToRole,
	UserOrganization,
} from '@repo/database'
import { z } from 'zod'
import { TENANT_ROLE_PERMISSION_IDS } from '#app/utils/organization/tenant-role-permissions.ts'

export const BUILT_IN_ORG_ADMIN_ROLE_ID = 'org_role_admin'

export const BUILT_IN_ORG_ROLE_IDS = [
	'org_role_admin',
	'org_role_member',
	'org_role_viewer',
	'org_role_guest',
] as const

export const BUILT_IN_ROLE_NAMES: Record<string, string> = {
	org_role_admin: 'Admin',
	org_role_member: 'Member',
	org_role_viewer: 'Viewer',
	org_role_guest: 'Guest',
}

export const roleInputSchema = z.object({
	name: z
		.string()
		.trim()
		.min(2, 'Give the role a name with at least 2 characters.')
		.max(80),
	description: z.string().trim().max(280),
	permissionIds: z.array(z.string()).default([]),
})

export async function requireBuiltInOrganizationAdmin(
	request: Request,
	orgSlug: string | undefined,
) {
	const userId = await requireUserId(request)
	if (!orgSlug) throw new Response('Not Found', { status: 404 })

	const [membership] = await db
		.select({
			organizationId: Organization.id,
			organizationName: Organization.name,
			organizationSlug: Organization.slug,
		})
		.from(Organization)
		.innerJoin(
			UserOrganization,
			and(
				eq(UserOrganization.organizationId, Organization.id),
				eq(UserOrganization.userId, userId),
				eq(UserOrganization.active, true),
				eq(UserOrganization.organizationRoleId, BUILT_IN_ORG_ADMIN_ROLE_ID),
			),
		)
		.where(eq(Organization.slug, orgSlug))
		.limit(1)

	if (!membership) {
		throw new Response('Forbidden', { status: 403 })
	}

	return { userId, organization: membership }
}

export async function requireOrganizationMember(
	request: Request,
	orgSlug: string | undefined,
) {
	const userId = await requireUserId(request)
	if (!orgSlug) throw new Response('Not Found', { status: 404 })

	const [membership] = await db
		.select({
			organizationId: Organization.id,
			organizationName: Organization.name,
			organizationSlug: Organization.slug,
			organizationRoleId: UserOrganization.organizationRoleId,
		})
		.from(Organization)
		.innerJoin(
			UserOrganization,
			and(
				eq(UserOrganization.organizationId, Organization.id),
				eq(UserOrganization.userId, userId),
				eq(UserOrganization.active, true),
			),
		)
		.where(eq(Organization.slug, orgSlug))
		.limit(1)

	if (!membership) {
		throw new Response('Forbidden', { status: 403 })
	}

	return {
		userId,
		organization: membership,
		isAdmin: membership.organizationRoleId === BUILT_IN_ORG_ADMIN_ROLE_ID,
	}
}

export async function getCustomRole(roleId: string, organizationId: string) {
	const [role] = await db
		.select({
			id: OrganizationRole.id,
			name: OrganizationRole.name,
			description: OrganizationRole.description,
			organizationId: OrganizationRole.organizationId,
		})
		.from(OrganizationRole)
		.where(
			and(
				eq(OrganizationRole.id, roleId),
				eq(OrganizationRole.organizationId, organizationId),
			),
		)
		.limit(1)

	return role ?? null
}

export async function invalidateAssignedActiveMembers(roleId: string) {
	const assignedMembers = await db
		.select({ userId: UserOrganization.userId })
		.from(UserOrganization)
		.where(
			and(
				eq(UserOrganization.organizationRoleId, roleId),
				eq(UserOrganization.active, true),
			),
		)

	await Promise.all(
		assignedMembers.map((member) =>
			invalidateUserOrganizationsCache(member.userId),
		),
	)
}

export async function listOrganizationRoles(organizationId: string) {
	const roles = await db
		.select({
			id: OrganizationRole.id,
			name: OrganizationRole.name,
			description: OrganizationRole.description,
			organizationId: OrganizationRole.organizationId,
		})
		.from(OrganizationRole)
		.where(
			or(
				inArray(OrganizationRole.id, [...BUILT_IN_ORG_ROLE_IDS]),
				eq(OrganizationRole.organizationId, organizationId),
			),
		)
		.orderBy(desc(OrganizationRole.organizationId), asc(OrganizationRole.name))

	const roleIds = roles.map((role) => role.id)
	const [grants, memberships] = await Promise.all([
		roleIds.length
			? db
					.select({
						roleId: _OrganizationPermissionToRole.A,
						permissionId: Permission.id,
					})
					.from(_OrganizationPermissionToRole)
					.innerJoin(
						Permission,
						eq(_OrganizationPermissionToRole.B, Permission.id),
					)
					.where(
						and(
							inArray(_OrganizationPermissionToRole.A, roleIds),
							inArray(Permission.id, TENANT_ROLE_PERMISSION_IDS),
						),
					)
			: Promise.resolve([]),
		roleIds.length
			? db
					.select({
						roleId: UserOrganization.organizationRoleId,
						total: count(),
					})
					.from(UserOrganization)
					.where(
						and(
							eq(UserOrganization.organizationId, organizationId),
							inArray(UserOrganization.organizationRoleId, roleIds),
						),
					)
					.groupBy(UserOrganization.organizationRoleId)
			: Promise.resolve([]),
	])

	const permissionsByRole = new Map<string, string[]>()
	for (const grant of grants) {
		permissionsByRole.set(grant.roleId, [
			...(permissionsByRole.get(grant.roleId) ?? []),
			grant.permissionId,
		])
	}
	const memberCounts = new Map(
		memberships.map((row) => [row.roleId, row.total]),
	)

	return roles.map((role) => {
		const isBuiltIn =
			role.organizationId === null ||
			(BUILT_IN_ORG_ROLE_IDS as readonly string[]).includes(role.id)
		return {
			...role,
			name:
				isBuiltIn && BUILT_IN_ROLE_NAMES[role.id]
					? BUILT_IN_ROLE_NAMES[role.id]!
					: role.name,
			isBuiltIn,
			permissionIds: permissionsByRole.get(role.id) ?? [],
			memberCount: memberCounts.get(role.id) ?? 0,
		}
	})
}

export async function getRoleWithPermissions(
	roleId: string,
	organizationId: string,
) {
	const isKnownBuiltIn = (BUILT_IN_ORG_ROLE_IDS as readonly string[]).includes(
		roleId,
	)
	const [role] = await db
		.select({
			id: OrganizationRole.id,
			name: OrganizationRole.name,
			description: OrganizationRole.description,
			organizationId: OrganizationRole.organizationId,
		})
		.from(OrganizationRole)
		.where(
			and(
				eq(OrganizationRole.id, roleId),
				isKnownBuiltIn
					? inArray(OrganizationRole.id, [...BUILT_IN_ORG_ROLE_IDS])
					: eq(OrganizationRole.organizationId, organizationId),
			),
		)
		.limit(1)

	if (!role) return null

	const isBuiltIn =
		role.organizationId === null ||
		(BUILT_IN_ORG_ROLE_IDS as readonly string[]).includes(role.id)

	const [grants, [memberCountRow]] = await Promise.all([
		db
			.select({
				permissionId: Permission.id,
			})
			.from(_OrganizationPermissionToRole)
			.innerJoin(Permission, eq(_OrganizationPermissionToRole.B, Permission.id))
			.where(
				and(
					eq(_OrganizationPermissionToRole.A, role.id),
					inArray(Permission.id, TENANT_ROLE_PERMISSION_IDS),
				),
			),
		db
			.select({ total: count() })
			.from(UserOrganization)
			.where(
				and(
					eq(UserOrganization.organizationId, organizationId),
					eq(UserOrganization.organizationRoleId, role.id),
				),
			),
	])

	return {
		...role,
		name:
			isBuiltIn && BUILT_IN_ROLE_NAMES[role.id]
				? BUILT_IN_ROLE_NAMES[role.id]!
				: role.name,
		isBuiltIn,
		permissionIds: grants.map((g) => g.permissionId),
		memberCount: memberCountRow?.total ?? 0,
	}
}
