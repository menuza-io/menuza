import { auditService, AuditAction } from '@repo/audit'
import { redirectWithToast } from '@repo/common/toast'
import {
	and,
	db,
	eq,
	isNull,
	or,
	sql,
	OrganizationRole,
	_OrganizationPermissionToRole,
} from '@repo/database'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	useActionData,
	useLoaderData,
} from 'react-router'
import { RoleAccessForm } from '#app/components/roles/tenant-role-access-manager.tsx'
import { hasOnlyTenantRolePermissions } from '#app/utils/organization/tenant-role-permissions.ts'
import {
	requireBuiltInOrganizationAdmin,
	roleInputSchema,
} from './roles.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const { organization } = await requireBuiltInOrganizationAdmin(
		request,
		params.orgSlug,
	)

	return {
		organization: {
			id: organization.organizationId,
			name: organization.organizationName,
			slug: organization.organizationSlug,
		},
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	const { userId, organization } = await requireBuiltInOrganizationAdmin(
		request,
		params.orgSlug,
	)

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
	const [duplicate] = await db
		.select({ id: OrganizationRole.id })
		.from(OrganizationRole)
		.where(
			and(
				or(
					eq(OrganizationRole.organizationId, organization.organizationId),
					isNull(OrganizationRole.organizationId),
				),
				sql`lower(${OrganizationRole.name}) = lower(${name})`,
			),
		)
		.limit(1)

	if (duplicate) {
		return {
			error:
				'A role with this name already exists in your organization or as a built-in role.',
		}
	}

	const createdRole = await db.transaction(async (tx) => {
		const [role] = await tx
			.insert(OrganizationRole)
			.values({
				name,
				description,
				level: 0,
				organizationId: organization.organizationId,
			})
			.returning({ id: OrganizationRole.id })

		if (role && permissionIds.length) {
			await tx.insert(_OrganizationPermissionToRole).values(
				permissionIds.map((permissionId) => ({
					A: role.id,
					B: permissionId,
				})),
			)
		}

		return role ?? null
	})

	if (createdRole) {
		await auditService.log({
			action: AuditAction.ROLE_CREATED,
			userId,
			organizationId: organization.organizationId,
			details: 'Custom organization role created.',
			resourceType: 'organization_role',
			resourceId: createdRole.id,
			request,
		})
	}

	return redirectWithToast(`/${organization.organizationSlug}/settings/roles`, {
		type: 'success',
		title: 'Role created',
		description: `The role "${name}" has been created.`,
	})
}

export default function CreateRoleRoute() {
	const data = useLoaderData<typeof loader>()
	const actionData = useActionData<typeof action>()
	const rolesPath = `/${data.organization.slug}/settings/roles`

	return (
		<RoleAccessForm
			orgSlug={data.organization.slug}
			cancelHref={rolesPath}
			error={actionData?.error}
		/>
	)
}
