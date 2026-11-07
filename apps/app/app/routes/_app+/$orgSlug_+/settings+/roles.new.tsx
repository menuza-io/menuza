import { createId } from '@paralleldrive/cuid2'
import { auditService, AuditAction } from '@repo/audit'
import { redirectWithToast } from '@repo/common/toast'
import {
	and,
	db,
	eq,
	isD1Bound,
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
import {
	hasOnlyTenantRolePermissions,
	withImpliedStaffingPermissions,
} from '#app/utils/organization/tenant-role-permissions.ts'
import { isStaffingFeatureEnabled } from '#app/utils/staffing/access.server.ts'
import {
	getRoleInputErrors,
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
		staffingEnabled: await isStaffingFeatureEnabled(
			organization.organizationId,
		),
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
		return getRoleInputErrors(submission.error)
	}
	const requestedPermissionIds = [...new Set(submission.data.permissionIds)]
	if (!hasOnlyTenantRolePermissions(requestedPermissionIds)) {
		return {
			error:
				'One or more selected access options are not available for custom roles.',
		}
	}
	const permissionIds = withImpliedStaffingPermissions(requestedPermissionIds)

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
			nameError:
				'A role with this name already exists in your organization or as a built-in role.',
		}
	}

	const roleId = createId()
	const roleValues = {
		id: roleId,
		name,
		description,
		level: 0,
		organizationId: organization.organizationId,
	}
	const permissionRows = permissionIds.map((permissionId) => ({
		A: roleId,
		B: permissionId,
	}))
	if (isD1Bound()) {
		// D1 has no interactive transactions (the client's `transaction` is a
		// plain callback), so one batch keeps the create atomic: a failed link
		// insert must not leave a role without its permissions.
		await db.batch([
			db.insert(OrganizationRole).values(roleValues),
			...(permissionRows.length
				? [db.insert(_OrganizationPermissionToRole).values(permissionRows)]
				: []),
		])
	} else {
		await db.transaction(async (tx) => {
			await tx.insert(OrganizationRole).values(roleValues)
			if (permissionRows.length) {
				await tx.insert(_OrganizationPermissionToRole).values(permissionRows)
			}
		})
	}
	const createdRole = { id: roleId }

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
			errors={actionData}
			staffingEnabled={data.staffingEnabled}
		/>
	)
}
