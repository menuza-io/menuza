import { useLoaderData } from 'react-router'
import { CandidateSheet } from '#app/components/hiring/candidate-sheet.tsx'
import { requireStaffingAccess } from '#app/utils/staffing/access.server.ts'
import { STAFF_SECTION_REQUIREMENTS } from '#app/utils/staffing/sections.ts'
import { type Route } from './+types/hiring.applicants.$applicationId.ts'

/**
 * One applicant, in the side sheet of the applicants page. Child routes repeat
 * the access check (parent loaders can be skipped on data requests); the person's
 * details come from the regional node, browser-direct.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
	await requireStaffingAccess(
		request,
		params.orgSlug,
		STAFF_SECTION_REQUIREMENTS.hiring,
	)
	return { applicationId: params.applicationId }
}

export default function StaffHiringApplicantRoute() {
	const { applicationId } = useLoaderData<typeof loader>()
	return <CandidateSheet key={applicationId} applicationId={applicationId} />
}
