import { auditService, AuditAction } from '@repo/audit'
import { getUserId } from '@repo/auth'
import {
	and,
	count,
	db,
	desc,
	eq,
	inArray,
	Organization,
	OrganizationImage,
	OrganizationRole,
	OrganizationRole as OrgRoleTable,
	Permission,
	_OrganizationPermissionToRole,
	UserOrganization,
	WebsitePage,
	WebsitePageSection,
} from '@repo/database'
import { type User } from '@repo/database/types'
import { data } from 'react-router'
import { getDefaultConfig } from '#app/utils/website/block-types.ts'
import {
	getDefaultHomePageSections,
	HOME_PAGE_SLUG,
	HOME_PAGE_TITLE,
} from '#app/utils/website/home-page.ts'

export type OrganizationWithImage = {
	id: string
	name: string
	slug: string
	image?: { id: string; altText?: string | null; objectKey: string } | null
	userCount?: number
}

export type UserOrganizationWithRole = {
	organization: OrganizationWithImage
	organizationRole: {
		id: string
		name: string
		level: number
		permissions?: Array<{ action: string; entity: string; access: string }>
	}
	isDefault: boolean
	role?: string
}

async function getOrganizationSummary(organizationId: string) {
	const [row] = await db
		.select({
			id: Organization.id,
			name: Organization.name,
			slug: Organization.slug,
			imageId: OrganizationImage.id,
			altText: OrganizationImage.altText,
			objectKey: OrganizationImage.objectKey,
		})
		.from(Organization)
		.leftJoin(
			OrganizationImage,
			eq(OrganizationImage.organizationId, Organization.id),
		)
		.where(eq(Organization.id, organizationId))
		.limit(1)
	if (!row) return null
	return {
		id: row.id,
		name: row.name,
		slug: row.slug,
		image: row.imageId
			? { id: row.imageId, altText: row.altText, objectKey: row.objectKey! }
			: null,
	}
}

export async function getUserOrganizations(
	userId: User['id'],
	includePermissions = false,
) {
	const memberships = await db
		.select({
			organizationId: UserOrganization.organizationId,
			isDefault: UserOrganization.isDefault,
			roleId: OrgRoleTable.id,
			roleName: OrgRoleTable.name,
			roleLevel: OrgRoleTable.level,
			organizationName: Organization.name,
			organizationSlug: Organization.slug,
			imageId: OrganizationImage.id,
			imageAltText: OrganizationImage.altText,
			imageObjectKey: OrganizationImage.objectKey,
		})
		.from(UserOrganization)
		.innerJoin(
			OrgRoleTable,
			eq(UserOrganization.organizationRoleId, OrgRoleTable.id),
		)
		.innerJoin(
			Organization,
			eq(UserOrganization.organizationId, Organization.id),
		)
		.leftJoin(
			OrganizationImage,
			eq(OrganizationImage.organizationId, Organization.id),
		)
		.where(
			and(
				eq(UserOrganization.userId, userId),
				eq(UserOrganization.active, true),
			),
		)
	const permissionsByRole = new Map<
		string,
		Array<{ action: string; entity: string; access: string }>
	>()
	if (includePermissions && memberships.length > 0) {
		const permissions = await db
			.select({
				roleId: _OrganizationPermissionToRole.A,
				action: Permission.action,
				entity: Permission.entity,
				access: Permission.access,
			})
			.from(_OrganizationPermissionToRole)
			.innerJoin(Permission, eq(_OrganizationPermissionToRole.B, Permission.id))
			.where(
				and(
					inArray(
						_OrganizationPermissionToRole.A,
						memberships.map((membership) => membership.roleId),
					),
					eq(Permission.context, 'organization'),
				),
			)
		for (const permission of permissions) {
			const rolePermissions = permissionsByRole.get(permission.roleId) ?? []
			rolePermissions.push({
				action: permission.action,
				entity: permission.entity,
				access: permission.access,
			})
			permissionsByRole.set(permission.roleId, rolePermissions)
		}
	}

	return memberships.map((membership) => {
		const permissions = includePermissions
			? (permissionsByRole.get(membership.roleId) ?? [])
			: undefined
		return {
			organization: {
				id: membership.organizationId,
				name: membership.organizationName,
				slug: membership.organizationSlug,
				image: membership.imageId
					? {
							id: membership.imageId,
							altText: membership.imageAltText,
							objectKey: membership.imageObjectKey ?? '',
						}
					: null,
			},
			organizationRole: {
				id: membership.roleId,
				name: membership.roleName,
				level: membership.roleLevel,
				...(permissions ? { permissions } : {}),
			},
			isDefault: membership.isDefault,
		}
	})
}

export async function getUserDefaultOrganization(userId: User['id']) {
	const [membership] = await db
		.select({
			organizationId: UserOrganization.organizationId,
			isDefault: UserOrganization.isDefault,
			roleId: OrgRoleTable.id,
			roleName: OrgRoleTable.name,
			roleLevel: OrgRoleTable.level,
		})
		.from(UserOrganization)
		.innerJoin(
			OrgRoleTable,
			eq(UserOrganization.organizationRoleId, OrgRoleTable.id),
		)
		.where(
			and(
				eq(UserOrganization.userId, userId),
				eq(UserOrganization.active, true),
			),
		)
		.orderBy(desc(UserOrganization.isDefault), UserOrganization.createdAt)
		.limit(1)
	if (!membership) return null
	const organization = await getOrganizationSummary(membership.organizationId)
	if (!organization) return null
	const [countRow] = await db
		.select({ value: count() })
		.from(UserOrganization)
		.where(eq(UserOrganization.organizationId, membership.organizationId))
	if (!countRow)
		return {
			organization,
			organizationRole: {
				id: membership.roleId,
				name: membership.roleName,
				level: membership.roleLevel,
			},
			isDefault: membership.isDefault,
		}
	return {
		organization: { ...organization, userCount: countRow.value },
		organizationRole: {
			id: membership.roleId,
			name: membership.roleName,
			level: membership.roleLevel,
		},
		isDefault: membership.isDefault,
	} satisfies UserOrganizationWithRole
}

export async function setUserDefaultOrganization(
	userId: string,
	organizationId: string,
) {
	await db.transaction(async (tx) => {
		await tx
			.update(UserOrganization)
			.set({ isDefault: false })
			.where(eq(UserOrganization.userId, userId))
		await tx
			.update(UserOrganization)
			.set({ isDefault: true })
			.where(
				and(
					eq(UserOrganization.userId, userId),
					eq(UserOrganization.organizationId, organizationId),
				),
			)
	})
	return getUserDefaultOrganization(userId)
}

export async function getUserOrganizationsWithSlugHandling(
	userId: string,
	orgSlug: string | undefined,
	organizations?: UserOrganizationWithRole[],
) {
	const userOrganizations =
		organizations ?? (await getUserOrganizations(userId, true))
	const defaultOrg = await getUserDefaultOrganization(userId)
	const currentOrganization = defaultOrg || userOrganizations[0]
	if (
		currentOrganization &&
		orgSlug &&
		currentOrganization.organization.slug !== orgSlug
	) {
		const selected = userOrganizations.find(
			(org) => org.organization.slug === orgSlug,
		)
		if (!selected) throw new Response('Organization not found', { status: 404 })
		await setUserDefaultOrganization(userId, selected.organization.id)
		return {
			organizations: userOrganizations.map((organization) => ({
				...organization,
				isDefault: organization.organization.id === selected.organization.id,
			})),
			currentOrganization: {
				...selected,
				isDefault: true,
			},
		}
	}
	return {
		organizations: userOrganizations.map((organization) => ({
			...organization,
			isDefault:
				currentOrganization?.organization.id === organization.organization.id,
		})),
		currentOrganization,
	}
}

export async function createOrganization({
	name,
	slug,
	description,
	userId,
	imageObjectKey,
	request,
}: {
	name: string
	slug: string
	description?: string
	userId: string
	imageObjectKey?: string
	request?: Request
}) {
	const organization = await db.transaction(async (tx) => {
		const [adminRole] = await tx
			.select({ id: OrganizationRole.id })
			.from(OrganizationRole)
			.where(eq(OrganizationRole.name, 'admin'))
			.limit(1)
		if (!adminRole) throw new Error('Admin role not found')
		const [created] = await tx
			.insert(Organization)
			.values({
				name,
				slug,
				description,
				siteHeaderConfig: JSON.stringify(getDefaultConfig('header')),
				siteFooterConfig: JSON.stringify(getDefaultConfig('footer')),
			})
			.returning({
				id: Organization.id,
				name: Organization.name,
				slug: Organization.slug,
			})
		if (!created) throw new Error('Failed to create organization')
		await tx.insert(UserOrganization).values({
			userId,
			organizationId: created.id,
			organizationRoleId: adminRole.id,
			isDefault: true,
		})
		if (imageObjectKey)
			await tx.insert(OrganizationImage).values({
				organizationId: created.id,
				altText: `${name} logo`,
				objectKey: imageObjectKey,
			})
		const sections = getDefaultHomePageSections({
			organizationName: name,
			description,
		})
		const [page] = await tx
			.insert(WebsitePage)
			.values({
				organizationId: created.id,
				title: HOME_PAGE_TITLE,
				slug: HOME_PAGE_SLUG,
				status: 'published',
				template: 'blank',
				isHomePage: true,
				position: 0,
				createdById: userId,
			})
			.returning({ id: WebsitePage.id })
		if (page && sections.length) {
			await tx.insert(WebsitePageSection).values(
				sections.map((section) => ({
					pageId: page.id,
					type: section.type,
					position: section.position,
					config: JSON.stringify(section.config),
				})),
			)
		}
		return created
	})
	await auditService.log({
		action: AuditAction.ORG_CREATED,
		userId,
		organizationId: organization.id,
		details: `Organization created: ${name}`,
		metadata: {
			organizationName: name,
			organizationSlug: slug,
			description,
			hasImage: !!imageObjectKey,
		},
		request,
		resourceType: 'organization',
		resourceId: organization.id,
	})
	return {
		...organization,
		image: imageObjectKey
			? await getOrganizationSummary(organization.id).then(
					(row) => row?.image ?? null,
				)
			: null,
	}
}

export async function getOrganizationBySlug(slug: string) {
	// Public lookup for SSO/login discovery. Returns only non-sensitive org metadata.
	// Callers that expose org data must enforce membership separately.
	const [organization] = await db
		.select()
		.from(Organization)
		.where(and(eq(Organization.slug, slug), eq(Organization.active, true)))
		.limit(1)
	return organization
		? {
				id: organization.id,
				name: organization.name,
				slug: organization.slug,
				description: organization.description,
				image: null,
			}
		: null
}

export async function getOrganizationByDomain(domain: string) {
	const [organization] = await db
		.select({
			id: Organization.id,
			name: Organization.name,
			slug: Organization.slug,
			verifiedDomain: Organization.verifiedDomain,
		})
		.from(Organization)
		.where(eq(Organization.verifiedDomain, domain.toLowerCase()))
		.limit(1)
	return organization ?? null
}

export async function discoverOrganizationFromEmail(email: string) {
	const domain = email.split('@')[1]
	return domain ? getOrganizationByDomain(domain) : null
}

export async function checkUserOrganizationAccess(
	userId: string,
	organizationId: string,
) {
	const [row] = await db
		.select({ membership: UserOrganization, organizationRole: OrgRoleTable })
		.from(UserOrganization)
		.innerJoin(
			OrgRoleTable,
			eq(UserOrganization.organizationRoleId, OrgRoleTable.id),
		)
		.where(
			and(
				eq(UserOrganization.userId, userId),
				eq(UserOrganization.organizationId, organizationId),
				eq(UserOrganization.active, true),
			),
		)
		.limit(1)
	return row
		? { ...row.membership, organizationRole: row.organizationRole }
		: null
}

export const ORGANIZATION_ROLE_LEVELS = {
	admin: 4,
	member: 3,
	viewer: 2,
	guest: 1,
} as const
export type OrganizationRoleName = keyof typeof ORGANIZATION_ROLE_LEVELS

export async function userHasOrganizationRole(
	userId: string,
	organizationId: string,
	requiredRole: OrganizationRoleName,
) {
	const userOrg = await checkUserOrganizationAccess(userId, organizationId)
	return (
		!!userOrg &&
		userOrg.organizationRole.level >= ORGANIZATION_ROLE_LEVELS[requiredRole]
	)
}

export async function requireUserWithOrganizationRole(
	request: Request,
	organizationId: string,
	requiredRole: OrganizationRoleName,
) {
	const userId = await getUserId(request)
	if (!userId)
		throw data(
			{ error: 'Unauthorized', message: 'Authentication required' },
			{ status: 401 },
		)
	if (!(await userHasOrganizationRole(userId, organizationId, requiredRole))) {
		throw data(
			{
				error: 'Unauthorized',
				requiredRole,
				message: `Insufficient permissions: required ${requiredRole} role in organization`,
			},
			{ status: 403 },
		)
	}
	return userId
}

export async function userHasOrgAccess(
	request: Request,
	organizationId: string,
) {
	const userId = await getUserId(request)
	if (!userId) throw new Response('Unauthorized', { status: 401 })
	if (!(await checkUserOrganizationAccess(userId, organizationId)))
		throw new Response('You do not have access to this organization', {
			status: 403,
		})
	return true
}

export async function getOrganizationWithAccess(
	orgSlug: string,
	userId: string,
	select: Record<string, true> = { id: true, name: true, slug: true },
) {
	const [organization] = await db
		.select()
		.from(Organization)
		.innerJoin(
			UserOrganization,
			and(
				eq(UserOrganization.organizationId, Organization.id),
				eq(UserOrganization.userId, userId),
				eq(UserOrganization.active, true),
			),
		)
		.where(and(eq(Organization.slug, orgSlug), eq(Organization.active, true)))
		.limit(1)
	if (!organization) throw new Response('Not Found', { status: 404 })
	const row = organization.Organization
	return Object.fromEntries(
		Object.keys(select).map((key) => [key, row[key as keyof typeof row]]),
	)
}
