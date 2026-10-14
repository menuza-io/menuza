import { STAFFING_PERMISSIONS as P } from '@repo/staffing'
import { type ShouldRevalidateFunctionArgs, useLoaderData } from 'react-router'
import { TimesheetsPage } from '#app/components/staff/timesheets/timesheets-page.tsx'
import { holdsStaffingGrant } from '#app/utils/staffing/sections.ts'
import { loadTimeclockScopes } from '#app/utils/staffing/timeclock-context.server.ts'
import { requireTimesheetsAccess } from '#app/utils/staffing/timesheets-access.server.ts'
import { type Route } from './+types/timeclock.timesheets.ts'

/**
 * Timesheets: day and pay-period views, the needs-review queue and the payroll
 * summary. The loader only checks who may look and names the scopes (a
 * name and a time zone, nothing about people); every card is fetched from the
 * regional node by the browser.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireTimesheetsAccess(request, params.orgSlug)
	return {
		orgSlug: params.orgSlug,
		scopes: await loadTimeclockScopes(access.organizationId, access.scopeIds),
		// The pay period is an organization-wide setting: a manager limited to
		// some scopes cannot change it for the others.
		canChangePayPeriod:
			access.scopeIds === null &&
			holdsStaffingGrant(access.grants, P.UPDATE_LABOR_POLICY),
	}
}

// Everything on this screen is fetched browser-direct, and filters live in the
// address bar, so the loader never needs to run again until you come back.
export function shouldRevalidate({
	currentParams,
	nextParams,
	defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
	// Switching organizations must reload the scopes; nothing else does.
	return currentParams.orgSlug === nextParams.orgSlug
		? false
		: defaultShouldRevalidate
}

export default function StaffTimeclockTimesheetsRoute() {
	const { orgSlug, scopes, canChangePayPeriod } = useLoaderData<typeof loader>()
	return (
		<TimesheetsPage
			orgSlug={orgSlug}
			scopes={scopes}
			canChangePayPeriod={canChangePayPeriod}
		/>
	)
}
