import { auditService, AuditAction } from '@repo/audit'
import { redirectWithToast } from '@repo/common/toast'
import {
	and,
	count,
	db,
	eq,
	inArray,
	isNull,
	or,
	sql,
	OrganizationRole,
	Permission,
	_OrganizationPermissionToRole,
	UserOrganization,
} from '@repo/database'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	useActionData,
	useLoaderData,
} from 'react-router'
import { RoleAccessForm } from '#app/components/roles/tenant-role-access-manager.tsx'
import {
	hasOnlyTenantRolePermissions,
	TENANT_ROLE_PERMISSION_IDS,
} from '#app/utils/organization/tenant-role-permissions.ts'
import {
	getCustomRole,
	invalidateAssignedActiveMembers,
	requireBuiltInOrganizationAdmin,
	roleInputSchema,
} from './roles.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const { organization } = await requireBuiltInOrganizationAdmin(
		request,
		params.orgSlug,
	)

	const roleId = params.roleId
	if (!roleId) throw new Response('Role not found', { status: 404 })

	const role = await getCustomRole(roleId, organization.organizationId)
	if (!role) throw new Response('Role not found', { status: 404 })

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
					eq(UserOrganization.organizationId, organization.organizationId),
					eq(UserOrganization.organizationRoleId, role.id),
				),
			),
	])

	return {
		organization: {
			id: organization.organizationId,
			name: organization.organizationName,
			slug: organization.organizationSlug,
		},
		role: {
			id: role.id,
			name: role.name,
			description: role.description ?? '',
			isBuiltIn: false,
			permissionIds: grants.map((g) => g.permissionId),
			memberCount: memberCountRow?.total ?? 0,
		},
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	const { userId, organization } = await requireBuiltInOrganizationAdmin(
		request,
		params.orgSlug,
	)
	const roleId = params.roleId
	if (!roleId) throw new Response('Role not found', { status: 404 })

	const role = await getCustomRole(roleId, organization.organizationId)
	if (!role) throw new Response('Role not found', { status: 404 })

	const formData = await request.formData()
	const submission = roleInputSchema.safeParse({
		name: formData.get('name'),
		description: formData.get('description') ?? '',
		permissionIds: formData.getAll('permissionIds'),
	})
	if (!submission.success) {
		return {
			error:
				submission.error.issues[0]?.message ??
				'Check the role details and try again.',
		}
	}
	const permissionIds = [...new Set(submission.data.permissionIds)]
	if (!hasOnlyTenantRolePermissions(permissionIds)) {
		return {
			error:
				'One or more selected access options are not available for custom roles.',
		}
	}

	const { name, description } = submission.data
	const duplicateWhere = and(
		or(
			eq(OrganizationRole.organizationId, organization.organizationId),
			isNull(OrganizationRole.organizationId),
		),
		sql`lower(${OrganizationRole.name}) = lower(${name})`,
	)
	const [duplicate] = await db
		.select({ id: OrganizationRole.id })
		.from(OrganizationRole)
		.where(duplicateWhere)
		.limit(1)

	if (duplicate && duplicate.id !== role.id) {
		return {
			error:
				'A custom role cannot use the name of another custom or built-in role.',
		}
	}

	await db.transaction(async (tx) => {
		await tx
			.update(OrganizationRole)
			.set({ name, description })
			.where(
				and(
					eq(OrganizationRole.id, role.id),
					eq(OrganizationRole.organizationId, organization.organizationId),
				),
			)
		await tx
			.delete(_OrganizationPermissionToRole)
			.where(eq(_OrganizationPermissionToRole.A, role.id))
		if (permissionIds.length) {
			await tx.insert(_OrganizationPermissionToRole).values(
				permissionIds.map((permissionId) => ({
					A: role.id,
					B: permissionId,
				})),
			)
		}
	})

	try {
		await invalidateAssignedActiveMembers(role.id)
	} catch (invalidationError) {
		console.error(
			'Failed to invalidate member caches after role update:',
			invalidationError,
		)
	}
	await auditService.log({
		action: AuditAction.ROLE_UPDATED,
		userId,
		organizationId: organization.organizationId,
		details: 'Custom organization role updated.',
		resourceType: 'organization_role',
		resourceId: role.id,
		request,
	})

	return redirectWithToast(`/${organization.organizationSlug}/settings/roles`, {
		type: 'success',
		title: 'Role updated',
		description: `The role "${name}" has been updated.`,
	})
}

export default function EditRoleRoute() {
	const data = useLoaderData<typeof loader>()
	const actionData = useActionData<typeof action>()
	const rolesPath = `/${data.organization.slug}/settings/roles`

	return (
		<RoleAccessForm
			orgSlug={data.organization.slug}
			role={data.role}
			cancelHref={rolesPath}
			error={actionData?.error}
		/>
	)
}
