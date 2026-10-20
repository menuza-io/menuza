import { requireUserId } from '@repo/auth'
import { STAFFING_PERMISSIONS } from '@repo/staffing'
import { AnnotatedLayout, AnnotatedSection } from '@repo/ui/annotated-layout'
import { useLoaderData, type LoaderFunctionArgs } from 'react-router'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { NotificationPreferencesCard } from '#app/components/settings/cards/notification-preferences-card.tsx'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	isStaffingFeatureEnabled,
	userHasStaffingPermission,
} from '#app/utils/staffing/access.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const userId = await requireUserId(request)
	const org = await requireUserOrganization(request, params.orgSlug, {
		id: true,
	})
	// Time clock alerts are offered only where they can arrive: the time clock
	// flag is on and this member can read timesheets (what the alerts open).
	const showStaffingAlerts =
		(await isStaffingFeatureEnabled(org.id, 'timeclock')) &&
		(await userHasStaffingPermission(
			userId,
			org.id,
			STAFFING_PERMISSIONS.READ_TIMESHEET,
		))
	// A published schedule is offered where scheduling is on and the member can
	// read the schedule it opens.
	const showScheduleAlerts =
		(await isStaffingFeatureEnabled(org.id, 'scheduling')) &&
		(await userHasStaffingPermission(
			userId,
			org.id,
			STAFFING_PERMISSIONS.READ_SCHEDULE,
		))
	// New applicants are offered where hiring is on and the member can read the
	// applicants they open.
	const showHiringAlerts =
		(await isStaffingFeatureEnabled(org.id, 'hiring')) &&
		(await userHasStaffingPermission(
			userId,
			org.id,
			STAFFING_PERMISSIONS.READ_HIRING,
		))
	return {
		organizationId: org.id,
		showStaffingAlerts,
		showScheduleAlerts,
		showHiringAlerts,
	}
}

export default function NotificationSettings() {
	const {
		organizationId,
		showStaffingAlerts,
		showScheduleAlerts,
		showHiringAlerts,
	} = useLoaderData<typeof loader>()
	return (
		<AnnotatedLayout>
			<AnnotatedSection>
				<NotificationPreferencesCard
					organizationId={organizationId}
					showStaffingAlerts={showStaffingAlerts}
					showScheduleAlerts={showScheduleAlerts}
					showHiringAlerts={showHiringAlerts}
				/>
			</AnnotatedSection>
		</AnnotatedLayout>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
