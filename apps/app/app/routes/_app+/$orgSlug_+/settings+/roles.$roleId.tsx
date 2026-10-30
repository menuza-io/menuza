import { type LoaderFunctionArgs, useLoaderData } from 'react-router'
import { ReadOnlyRoleView } from '#app/components/roles/tenant-role-access-manager.tsx'
import { type BreadcrumbHandle } from '#app/utils/breadcrumb.ts'
import { isLoyaltyFeatureEnabled } from '#app/utils/loyalty/access.server.ts'
import { isReservationsFeatureEnabled } from '#app/utils/reservations/access.server.ts'
import { isStaffingFeatureEnabled } from '#app/utils/staffing/access.server.ts'
import {
	getRoleWithPermissions,
	requireOrganizationMember,
} from './roles.server.ts'

const capitalize = (value: string) =>
	value.charAt(0).toUpperCase() + value.slice(1)

export const handle: BreadcrumbHandle<Awaited<ReturnType<typeof loader>>> = {
	breadcrumb: (data) => capitalize(data.role.name),
}

export async function loader({ request, params }: LoaderFunctionArgs) {
	const { organization, isAdmin } = await requireOrganizationMember(
		request,
		params.orgSlug,
	)

	const roleId = params.roleId
	if (!roleId) throw new Response('Role not found', { status: 404 })

	const role = await getRoleWithPermissions(roleId, organization.organizationId)
	if (!role) throw new Response('Role not found', { status: 404 })

	const [staffingEnabled, reservationsEnabled, loyaltyEnabled] =
		await Promise.all([
			isStaffingFeatureEnabled(organization.organizationId),
			isReservationsFeatureEnabled(organization.organizationId),
			isLoyaltyFeatureEnabled(organization.organizationId),
		])

	return {
		organization: {
			id: organization.organizationId,
			name: organization.organizationName,
			slug: organization.organizationSlug,
		},
		role,
		canEdit: isAdmin && !role.isBuiltIn,
		staffingEnabled,
		reservationsEnabled,
		loyaltyEnabled,
	}
}

export default function ViewRoleRoute() {
	const {
		organization,
		role,
		canEdit,
		staffingEnabled,
		reservationsEnabled,
		loyaltyEnabled,
	} = useLoaderData<typeof loader>()
	const basePath = `/${organization.slug}/settings/roles`

	return (
		<ReadOnlyRoleView
			orgSlug={organization.slug}
			role={role}
			editHref={canEdit ? `${basePath}/${role.id}/edit` : undefined}
			staffingEnabled={staffingEnabled}
			reservationsEnabled={reservationsEnabled}
			loyaltyEnabled={loyaltyEnabled}
		/>
	)
}
