import { t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { STAFFING_PERMISSIONS as P } from '@repo/staffing'
import { PageHeader } from '@repo/ui/page-header'
import { Outlet, useLoaderData } from 'react-router'
import { SectionTabs } from '#app/components/staff/section-tabs.tsx'
import { requireStaffingAccess } from '#app/utils/staffing/access.server.ts'
import {
	holdsStaffingGrant,
	STAFF_SECTION_REQUIREMENTS,
} from '#app/utils/staffing/sections.ts'
import { type Route } from './+types/timeclock.ts'

/**
 * Time clock layout: today's status, tablets (kiosk pairing) and labor rules
 * share one header and a quiet tab row. Each child loader repeats the flag and
 * permission check (parent loaders can be skipped on data requests); this one
 * only decides which tabs to offer.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireStaffingAccess(
		request,
		params.orgSlug,
		STAFF_SECTION_REQUIREMENTS.timeclock,
	)
	return {
		orgSlug: params.orgSlug,
		canToday: holdsStaffingGrant(access.grants, P.READ_TIMESHEET),
		// Names come from the roster, so timesheets need both grants.
		canTimesheets:
			holdsStaffingGrant(access.grants, P.READ_TIMESHEET) &&
			holdsStaffingGrant(access.grants, P.READ_STAFF),
		canSettings: holdsStaffingGrant(access.grants, P.READ_LABOR_POLICY),
	}
}

export default function StaffTimeclockLayout() {
	const { orgSlug, canToday, canTimesheets, canSettings } =
		useLoaderData<typeof loader>()
	const { _ } = useLingui()
	const base = `/${orgSlug}/staff/timeclock`
	const tabs = [
		canToday ? { to: base, label: _(t`Today`), end: true } : null,
		canTimesheets
			? { to: `${base}/timesheets`, label: _(t`Timesheets`) }
			: null,
		canSettings ? { to: `${base}/tablets`, label: _(t`Tablets`) } : null,
		canSettings ? { to: `${base}/rules`, label: _(t`Labor rules`) } : null,
	].filter((tab) => tab !== null)

	return (
		<div className="flex flex-col gap-6">
			<PageHeader
				title={_(t`Time clock`)}
				description={_(
					t`Who is on the clock, the tablets people punch in on, and the rules they follow.`,
				)}
			/>
			{tabs.length > 1 ? (
				<SectionTabs tabs={tabs} label={_(t`Time clock sections`)} />
			) : null}
			<Outlet />
		</div>
	)
}
