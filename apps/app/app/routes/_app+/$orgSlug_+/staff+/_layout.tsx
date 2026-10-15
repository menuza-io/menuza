import { WorkspacePage } from '@repo/ui/workspace'
import { Outlet, useLoaderData } from 'react-router'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { ScopeWordingProvider } from '#app/components/staff/scope-wording-provider.tsx'
import { StaffClientProvider } from '#app/components/staff/staff-client-provider.tsx'
import { requireStaffingAccess } from '#app/utils/staffing/access.server.ts'
import { scopeWordingFor } from '#app/utils/staffing/scope-wording.ts'
import { loadOrganizationScopes } from '#app/utils/staffing/scope.server.ts'
import { STAFF_SECTION_PERMISSIONS } from '#app/utils/staffing/sections.ts'
import { type Route } from './+types/_layout.ts'

// The layout only keeps the section out of reach when staffing is off or the
// member holds no staffing read permission. Child routes cannot rely on this
// (parent loaders can be skipped on data requests), so each one calls
// `requireStaffingAccess` with its own feature flag and permission.
export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireStaffingAccess(request, params.orgSlug, {
		feature: 'enabled',
		anyOf: STAFF_SECTION_PERMISSIONS,
	})
	// Organizations with restaurant locations say "location", others "workplace".
	const scopes = await loadOrganizationScopes(access.organizationId)
	return { orgSlug: params.orgSlug, scopeWording: scopeWordingFor(scopes) }
}

export default function StaffLayout() {
	const { orgSlug, scopeWording } = useLoaderData<typeof loader>()
	return (
		<ScopeWordingProvider wording={scopeWording}>
			<StaffClientProvider orgSlug={orgSlug}>
				<WorkspacePage>
					<Outlet />
				</WorkspacePage>
			</StaffClientProvider>
		</ScopeWordingProvider>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
