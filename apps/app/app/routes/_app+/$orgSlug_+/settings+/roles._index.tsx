import { auditService, AuditAction } from '@repo/audit'
import {
	and,
	count,
	db,
	eq,
	OrganizationInvitation,
	OrganizationInviteLink,
	OrganizationRole,
	_OrganizationPermissionToRole,
	UserOrganization,
} from '@repo/database'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	useActionData,
	useLoaderData,
} from 'react-router'
import { TenantRoleAccessManager } from '#app/components/roles/tenant-role-access-manager.tsx'
import {
	getCustomRole,
	invalidateAssignedActiveMembers,
	listOrganizationRoles,
	requireBuiltInOrganizationAdmin,
} from './roles.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const { organization } = await requireBuiltInOrganizationAdmin(
		request,
		params.orgSlug,
	)
	const roles = await listOrganizationRoles(organization.organizationId)

	return {
		organization: {
			id: organization.organizationId,
			name: organization.organizationName,
			slug: organization.organizationSlug,
		},
		roles,
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	const { userId, organization } = await requireBuiltInOrganizationAdmin(
		request,
		params.orgSlug,
	)
	const formData = await request.formData()
	const intent = formData.get('intent')

	if (intent === 'delete-role') {
		const roleId = formData.get('roleId')
		if (typeof roleId !== 'string')
			return { error: 'Choose a custom role to delete.' }
		const role = await getCustomRole(roleId, organization.organizationId)
		if (!role) return { error: 'This custom role was not found.' }

		const [memberReferences, invitationReferences, inviteLinkReferences] =
			await Promise.all([
				db
					.select({ total: count() })
					.from(UserOrganization)
					.where(
						and(
							eq(UserOrganization.organizationId, organization.organizationId),
							eq(UserOrganization.organizationRoleId, role.id),
						),
					),
				db
					.select({ total: count() })
					.from(OrganizationInvitation)
					.where(
						and(
							eq(
								OrganizationInvitation.organizationId,
								organization.organizationId,
							),
							eq(OrganizationInvitation.organizationRoleId, role.id),
						),
					),
				db
					.select({ total: count() })
					.from(OrganizationInviteLink)
					.where(
						and(
							eq(
								OrganizationInviteLink.organizationId,
								organization.organizationId,
							),
							eq(OrganizationInviteLink.organizationRoleId, role.id),
						),
					),
			])

		if ((memberReferences[0]?.total ?? 0) > 0) {
			return {
				error:
					'Cannot delete this role while team members are still assigned to it.',
			}
		}
		if (
			(invitationReferences[0]?.total ?? 0) > 0 ||
			(inviteLinkReferences[0]?.total ?? 0) > 0
		) {
			return {
				error:
					'Cannot delete this role while invitations or invite links still reference it.',
			}
		}

		await db.transaction(async (tx) => {
			await tx
				.delete(_OrganizationPermissionToRole)
				.where(eq(_OrganizationPermissionToRole.A, role.id))
			await tx
				.delete(OrganizationRole)
				.where(
					and(
						eq(OrganizationRole.id, role.id),
						eq(OrganizationRole.organizationId, organization.organizationId),
					),
				)
		})

		await invalidateAssignedActiveMembers(role.id)
		await auditService.log({
			action: AuditAction.ROLE_DELETED,
			userId,
			organizationId: organization.organizationId,
			details: 'Custom organization role deleted.',
			resourceType: 'organization_role',
			resourceId: role.id,
			request,
		})

		return { message: 'Role deleted.' }
	}

	return { error: 'Unsupported action.' }
}

export default function RolesIndexRoute() {
	const data = useLoaderData<typeof loader>()
	const actionData = useActionData<typeof action>()

	return (
		<TenantRoleAccessManager
			roles={data.roles}
			orgSlug={data.organization.slug}
			message={actionData?.message}
			error={actionData?.error}
		/>
	)
}
