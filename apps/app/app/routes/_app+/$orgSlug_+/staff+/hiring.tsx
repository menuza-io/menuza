import { t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { PageHeader } from '@repo/ui/page-header'
import { Outlet, useLoaderData, useLocation } from 'react-router'
import { SectionTabs } from '#app/components/staff/section-tabs.tsx'
import { requireStaffingAccess } from '#app/utils/staffing/access.server.ts'
import { STAFF_SECTION_REQUIREMENTS } from '#app/utils/staffing/sections.ts'
import { type Route } from './+types/hiring.ts'

/**
 * Hiring: job posts, applicants and onboarding templates. The layout keeps the section closed while
 * `staffing.hiring` is off or the member holds no hiring permission, and shows
 * the sections as tabs on the screens that are one of them (editing a job has
 * its own focused page). Every child repeats the check (parent loaders can be
 * skipped on data requests).
 */
export async function loader({ request, params }: Route.LoaderArgs) {
	await requireStaffingAccess(
		request,
		params.orgSlug,
		STAFF_SECTION_REQUIREMENTS.hiring,
	)
	return { orgSlug: params.orgSlug }
}

export default function StaffHiringLayout() {
	const { orgSlug } = useLoaderData<typeof loader>()
	const { _ } = useLingui()
	const { pathname } = useLocation()
	const base = `/${orgSlug}/staff/hiring`
	const onTabScreen =
		pathname === base ||
		pathname === `${base}/` ||
		pathname === `${base}/applicants` ||
		pathname.startsWith(`${base}/applicants/`) ||
		pathname === `${base}/onboarding`
	return (
		<div className="flex flex-col gap-6">
			{onTabScreen ? (
				<>
					<PageHeader
						title={_(t`Hiring`)}
						description={_(
							t`Post jobs, review applicants and get new hires started.`,
						)}
					/>
					<SectionTabs
						label={_(t`Hiring sections`)}
						tabs={[
							{ to: base, label: _(t`Jobs`), end: true },
							{ to: `${base}/applicants`, label: _(t`Applicants`) },
							{ to: `${base}/onboarding`, label: _(t`Onboarding`) },
						]}
					/>
				</>
			) : null}
			<Outlet />
		</div>
	)
}
