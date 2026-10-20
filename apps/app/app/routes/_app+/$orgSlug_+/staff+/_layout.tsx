import { WorkspacePage } from '@repo/ui/workspace'
import { Outlet, useLoaderData } from 'react-router'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { StaffClientProvider } from '#app/components/staff/staff-client-provider.tsx'
import { requireStaffingAccess } from '#app/utils/staffing/access.server.ts'
import { STAFF_SECTION_PERMISSIONS } from '#app/utils/staffing/sections.ts'
import { type Route } from './+types/_layout.ts'

// The layout only keeps the section out of reach when staffing is off or the
// member holds no staffing read permission. Child routes cannot rely on this
// (parent loaders can be skipped on data requests), so each one calls
// `requireStaffingAccess` with its own feature flag and permission.
export async function loader({ request, params }: Route.LoaderArgs) {
	await requireStaffingAccess(request, params.orgSlug, {
		feature: 'enabled',
		anyOf: STAFF_SECTION_PERMISSIONS,
	})
	return { orgSlug: params.orgSlug }
}

export default function StaffLayout() {
	const { orgSlug } = useLoaderData<typeof loader>()
	return (
		<StaffClientProvider orgSlug={orgSlug}>
			<WorkspacePage>
				<Outlet />
			</WorkspacePage>
		</StaffClientProvider>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
