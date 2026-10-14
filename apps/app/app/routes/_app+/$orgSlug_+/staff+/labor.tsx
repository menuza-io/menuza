import { type ShouldRevalidateFunctionArgs, useLoaderData } from 'react-router'
import { LaborPage } from '#app/components/staff/labor/labor-page.tsx'
import { requireLaborAccess } from '#app/utils/staffing/labor-access.server.ts'
import { loadLaborScopes } from '#app/utils/staffing/labor-context.server.ts'
import { type Route } from './+types/labor.ts'

/**
 * Labor: hours, estimated wages and sales by day, the sales a team enters, the
 * tip-pool report and the settings behind them. The loader only checks who may
 * look and names the scopes (a name, a time zone and a currency, nothing
 * about people); every figure is fetched from the regional node by the browser.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireLaborAccess(request, params.orgSlug)
	return {
		orgSlug: params.orgSlug,
		scopes: await loadLaborScopes(access.organizationId, access.scopeIds),
		can: access.can,
	}
}

// Everything on this screen is fetched browser-direct, and the view, scope
// and range live in the address bar, so the loader never needs to run again
// until you come back or switch organizations.
export function shouldRevalidate({
	currentParams,
	nextParams,
	defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
	return currentParams.orgSlug === nextParams.orgSlug
		? false
		: defaultShouldRevalidate
}

export default function StaffLaborRoute() {
	const { scopes, can } = useLoaderData<typeof loader>()
	return <LaborPage scopes={scopes} can={can} />
}
