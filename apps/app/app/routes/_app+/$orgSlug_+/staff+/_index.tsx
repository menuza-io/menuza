import { t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { StaffSectionPlaceholder } from '#app/components/staff/section-placeholder.tsx'
import { requireStaffingAccess } from '#app/utils/staffing/access.server.ts'
import { STAFF_SECTION_PERMISSIONS } from '#app/utils/staffing/sections.ts'
import { type Route } from './+types/_index.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	await requireStaffingAccess(request, params.orgSlug, {
		feature: 'enabled',
		anyOf: STAFF_SECTION_PERMISSIONS,
	})
	return null
}

export default function StaffOverviewRoute() {
	const { _ } = useLingui()
	return (
		<StaffSectionPlaceholder
			title={_(t`Staff`)}
			description={_(
				t`The people who work at your organization: roster, time clock, schedule, and hiring.`,
			)}
			emptyTitle={_(t`Staff tools are on the way`)}
			emptyDescription={_(
				t`Your team, time clock, schedule, and hiring tools will appear here as they become available.`,
			)}
			icons={['users', 'clock', 'calendar']}
		/>
	)
}
