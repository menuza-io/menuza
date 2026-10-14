import { type ShouldRevalidateFunctionArgs, useLoaderData } from 'react-router'
import { SchedulePage } from '#app/components/staff/schedule/schedule-page.tsx'
import { requireScheduleAccess } from '#app/utils/staffing/schedule-access.server.ts'
import { loadTimeclockScopes } from '#app/utils/staffing/timeclock-context.server.ts'
import { type Route } from './+types/schedule._index.ts'

/**
 * The week schedule. The loader only checks who may look and names the
 * scopes the member can reach (a name and a time zone, nothing about
 * people); every shift, person and figure is fetched from the regional node by
 * the browser.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireScheduleAccess(request, params.orgSlug)
	return {
		orgSlug: params.orgSlug,
		scopes: await loadTimeclockScopes(access.organizationId, access.scopeIds),
	}
}

// Everything on this screen is fetched browser-direct, and the view lives in
// the address bar, so the loader never needs to run again.
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

export default function StaffScheduleRoute() {
	const { orgSlug, scopes } = useLoaderData<typeof loader>()
	return <SchedulePage orgSlug={orgSlug} scopes={scopes} />
}
