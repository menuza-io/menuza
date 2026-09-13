import { type LoaderFunctionArgs, useLoaderData } from 'react-router'
import { ReadOnlyRoleView } from '#app/components/roles/tenant-role-access-manager.tsx'
import {
	getRoleWithPermissions,
	requireOrganizationMember,
} from './roles.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const { organization, isAdmin } = await requireOrganizationMember(
		request,
		params.orgSlug,
	)

	const roleId = params.roleId
	if (!roleId) throw new Response('Role not found', { status: 404 })

	const role = await getRoleWithPermissions(roleId, organization.organizationId)
	if (!role) throw new Response('Role not found', { status: 404 })

	return {
		organization: {
			id: organization.organizationId,
			name: organization.organizationName,
			slug: organization.organizationSlug,
		},
		role,
		canEdit: isAdmin && !role.isBuiltIn,
	}
}

export default function ViewRoleRoute() {
	const { organization, role, canEdit } = useLoaderData<typeof loader>()
	const basePath = `/${organization.slug}/settings/roles`

	return (
		<ReadOnlyRoleView
			orgSlug={organization.slug}
			role={role}
			editHref={canEdit ? `${basePath}/${role.id}/edit` : undefined}
		/>
	)
}
