import { Trans } from '@lingui/react/macro'
import { INVENTORY_PERMISSIONS } from '@repo/inventory'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Link, useLoaderData } from 'react-router'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { InventoryHeaderActions } from '#app/components/inventory/inventory-chrome.tsx'
import { ProfitabilityScreen } from '#app/components/inventory/profitability-screen.tsx'
import { requireInventoryAccess } from '#app/utils/inventory/access.server.ts'
import { loadProfitabilityDishes } from '#app/utils/inventory/profitability-dishes.server.ts'
import { orgSiteLocales } from '#app/utils/location-name.server.ts'
import { type Route } from './+types/profitability.ts'
import { useInventoryLayoutData } from './_layout.tsx'

/**
 * Dish profitability (#519): sold, price, cost, margin and a label (Keep,
 * Re-price, Promote, Rethink) per dish at a location. All margin and cost, so
 * it needs recipes on and the cost grant; without either it is not there.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireInventoryAccess(request, params.orgSlug)
	if (
		!access.features.recipes ||
		!access.grants.includes(INVENTORY_PERMISSIONS.READ_INVENTORY_COST)
	) {
		throw new Response('Not Found', { status: 404 })
	}
	const { defaultLocale } = await orgSiteLocales(access.organizationId)
	return {
		dishes: await loadProfitabilityDishes(access.organizationId, defaultLocale),
	}
}

export default function InventoryProfitabilityRoute() {
	const { dishes } = useLoaderData<typeof loader>()
	const { activeLocationId, currency, orgSlug } = useInventoryLayoutData()
	return (
		<div className="flex flex-col gap-6">
			<InventoryHeaderActions>
				<Button
					variant="outline"
					size="sm"
					render={<Link to={`/${orgSlug}/inventory/today`} />}
				>
					<Icon name="arrow-left" />
					<Trans>Back to Today</Trans>
				</Button>
			</InventoryHeaderActions>
			<ProfitabilityScreen
				locationId={activeLocationId}
				currency={currency}
				dishes={dishes}
			/>
		</div>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
