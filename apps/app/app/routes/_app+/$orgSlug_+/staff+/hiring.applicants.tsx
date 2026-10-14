import { userHasOrganizationPermission } from '@repo/auth'
import { STAFFING_PERMISSIONS as P } from '@repo/staffing'
import { useLoaderData, type ShouldRevalidateFunctionArgs } from 'react-router'
import { ApplicantsPage } from '#app/components/hiring/applicants-page.tsx'
import { loadApplicantScopes } from '#app/utils/hiring/hiring-context.server.ts'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'
import { requireStaffingAccess } from '#app/utils/staffing/access.server.ts'
import {
	holdsStaffingGrant,
	STAFF_SECTION_REQUIREMENTS,
} from '#app/utils/staffing/sections.ts'
import { type Route } from './+types/hiring.applicants.ts'

/**
 * Applicants: the pipeline of people who applied through the careers page. The
 * loader only checks who may look and names the workplaces (a name, a time zone
 * and a currency, nothing about people); every applicant is fetched from the
 * regional node by the browser.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireStaffingAccess(
		request,
		params.orgSlug,
		STAFF_SECTION_REQUIREMENTS.hiring,
	)
	// Offering the new hire an app login needs what the invite route itself
	// checks: permission to update staff and to invite members, an organization
	// outside the Saudi region (a login email is a US-held identifier) and every
	// workplace.
	const canInvite =
		access.dataRegion !== 'ksa' &&
		access.scopeIds === null &&
		holdsStaffingGrant(access.grants, P.UPDATE_STAFF) &&
		(await userHasOrganizationPermission(
			access.userId,
			access.organizationId,
			ORG_PERMISSIONS.CREATE_MEMBER_ANY,
		))
	return {
		orgSlug: params.orgSlug,
		userId: access.userId,
		canWrite: holdsStaffingGrant(access.grants, P.UPDATE_HIRING),
		canInvite,
		scopes: await loadApplicantScopes(access.organizationId),
	}
}

// Everything on this screen is fetched browser-direct and the filters live in
// the address bar, so the loader never needs to run again until you come back.
export function shouldRevalidate({
	currentParams,
	nextParams,
	defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
	return currentParams.orgSlug === nextParams.orgSlug
		? false
		: defaultShouldRevalidate
}

export default function StaffHiringApplicantsRoute() {
	const { orgSlug, userId, canWrite, canInvite, scopes } =
		useLoaderData<typeof loader>()
	return (
		<ApplicantsPage
			orgSlug={orgSlug}
			userId={userId}
			canWrite={canWrite}
			canInvite={canInvite}
			scopes={scopes}
		/>
	)
}
