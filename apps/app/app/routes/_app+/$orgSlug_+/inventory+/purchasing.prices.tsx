import { Trans } from '@lingui/react/macro'
import { INVENTORY_PERMISSIONS } from '@repo/inventory'
import { useLoaderData } from 'react-router'
import { PriceComparisonPanel } from '#app/components/inventory/price-comparison-panel.tsx'
import { usePurchasingContext } from '#app/components/inventory/purchasing-context.ts'
import { SheetPanel } from '#app/components/staff/sheet-frame.tsx'
import { requireInventoryAccess } from '#app/utils/inventory/access.server.ts'
import { type Route } from './+types/purchasing.prices.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireInventoryAccess(request, params.orgSlug)
	if (!access.features.purchasing) {
		throw new Response('Not Found', { status: 404 })
	}
	return {
		canSeeCost: access.grants.includes(
			INVENTORY_PERMISSIONS.READ_INVENTORY_COST,
		),
	}
}

/**
 * Price comparison across suppliers and locations (#508). Gated behind
 * `inventory.purchasing` and `read:inventory_cost:any`.
 */
export default function InventoryPriceComparisonRoute() {
	const ctx = usePurchasingContext()
	// Undefined when the route renders without its loader (tests, previews).
	const loaderData = useLoaderData<typeof loader>() as
		Awaited<ReturnType<typeof loader>> | undefined
	const canSeeCost = (loaderData?.canSeeCost ?? true) && ctx.canSeeCost

	return (
		<SheetPanel
			title={<Trans>Price comparison</Trans>}
			description={
				<Trans>
					Compare unit prices paid for each item across suppliers and locations.
				</Trans>
			}
		>
			<PriceComparisonPanel
				locations={ctx.locations}
				canSeeCost={canSeeCost}
				currency={ctx.currency}
			/>
		</SheetPanel>
	)
}
