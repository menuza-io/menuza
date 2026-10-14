import { type ShouldRevalidateFunctionArgs, useLoaderData } from 'react-router'
import { TimeOffPage } from '#app/components/staff/schedule/time-off-page.tsx'
import { requireScheduleAccess } from '#app/utils/staffing/schedule-access.server.ts'
import { loadTimeclockScopes } from '#app/utils/staffing/timeclock-context.server.ts'
import { type Route } from './+types/schedule.time-off.ts'

/**
 * Loader checks who may look and names the scopes they can reach; every
 * request, person and date is fetched from the regional node by the browser.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireScheduleAccess(request, params.orgSlug)
	return {
		scopes: await loadTimeclockScopes(access.organizationId, access.scopeIds),
	}
}

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

export default function StaffScheduleTimeOffRoute() {
	const { scopes } = useLoaderData<typeof loader>()
	return <TimeOffPage scopes={scopes} />
}
