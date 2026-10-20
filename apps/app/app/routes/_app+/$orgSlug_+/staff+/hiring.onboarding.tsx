import { STAFFING_PERMISSIONS as P } from '@repo/staffing'
import { useLoaderData, type ShouldRevalidateFunctionArgs } from 'react-router'
import { OnboardingTemplatesPage } from '#app/components/staff/onboarding/templates-page.tsx'
import { requireStaffingAccess } from '#app/utils/staffing/access.server.ts'
import {
	holdsStaffingGrant,
	STAFF_SECTION_REQUIREMENTS,
} from '#app/utils/staffing/sections.ts'
import { type Route } from './+types/hiring.onboarding.ts'

/**
 * Onboarding checklist templates. Behind `staffing.hiring` like the rest of
 * Hiring. The loader only decides who may look and who may change things;
 * templates are fetched by the browser from the regional node. Changing one
 * affects every workplace's new hires, so it needs access to every workplace as
 * well as the hiring update grant (tenant-api enforces the same rule).
 */
export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireStaffingAccess(
		request,
		params.orgSlug,
		STAFF_SECTION_REQUIREMENTS.hiring,
	)
	return {
		canWrite:
			access.scopeIds === null &&
			holdsStaffingGrant(access.grants, P.UPDATE_HIRING),
	}
}

// Everything is fetched browser-direct, so the loader never needs to run again
// until the organization changes.
export function shouldRevalidate({
	currentParams,
	nextParams,
	defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
	return currentParams.orgSlug === nextParams.orgSlug
		? false
		: defaultShouldRevalidate
}

export default function StaffHiringOnboardingRoute() {
	const { canWrite } = useLoaderData<typeof loader>()
	return <OnboardingTemplatesPage canWrite={canWrite} />
}
