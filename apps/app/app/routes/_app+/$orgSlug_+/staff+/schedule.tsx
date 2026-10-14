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
import { type Route } from './+types/schedule.ts'

/**
 * Schedule layout: the week schedule, time-off requests and availability share
 * one header and a quiet tab row. Each child loader repeats the flag and
 * permission check (parent loaders can be skipped on data requests); this one
 * only decides which tabs to offer. Names come from the roster, so every tab
 * needs the staff read grant as well.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireStaffingAccess(
		request,
		params.orgSlug,
		STAFF_SECTION_REQUIREMENTS.schedule,
	)
	return {
		orgSlug: params.orgSlug,
		canSeeNames: holdsStaffingGrant(access.grants, P.READ_STAFF),
	}
}

export default function StaffScheduleLayout() {
	const { orgSlug, canSeeNames } = useLoaderData<typeof loader>()
	const { _ } = useLingui()
	const base = `/${orgSlug}/staff/schedule`
	const tabs = [
		{ to: base, label: _(t`Schedule`), end: true },
		{ to: `${base}/time-off`, label: _(t`Time off`) },
		{ to: `${base}/availability`, label: _(t`Availability`) },
	]
	return (
		<div className="flex flex-col gap-6">
			<div className="print:hidden">
				<PageHeader
					title={_(t`Schedule`)}
					description={_(
						t`Plan shifts, publish the week to your team, and handle time off and availability.`,
					)}
				/>
			</div>
			{canSeeNames ? (
				<SectionTabs tabs={tabs} label={_(t`Schedule sections`)} />
			) : null}
			<Outlet />
		</div>
	)
}
