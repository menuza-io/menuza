import { Trans } from '@lingui/react/macro'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Link, useSearchParams } from 'react-router'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { InventoryHeaderActions } from '#app/components/inventory/inventory-chrome.tsx'
import { VarianceScreen } from '#app/components/inventory/variance-screen.tsx'
import { requireInventoryAccess } from '#app/utils/inventory/access.server.ts'
import { type Route } from './+types/counts_.variance.ts'
import { useInventoryLayoutData } from './_layout.tsx'

/**
 * Expected versus actual use by item between two approved full counts (#509),
 * under Counts. Needs the recipes flag: expected use comes from sales and
 * batches through recipes.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireInventoryAccess(request, params.orgSlug)
	if (!access.features.recipes) {
		throw new Response('Not Found', { status: 404 })
	}
	return null
}

export default function InventoryVarianceRoute() {
	const { activeLocationId, canSeeCost, currency, orgSlug } =
		useInventoryLayoutData()
	const [searchParams, setSearchParams] = useSearchParams()
	return (
		<div className="flex flex-col gap-6">
			<InventoryHeaderActions>
				<Button
					variant="outline"
					size="sm"
					render={<Link to={`/${orgSlug}/inventory/counts`} />}
				>
					<Icon name="arrow-left" />
					<Trans>Back to counts</Trans>
				</Button>
			</InventoryHeaderActions>
			<VarianceScreen
				locationId={activeLocationId}
				canSeeCost={canSeeCost}
				currency={currency}
				closingCountId={searchParams.get('closing')}
				onPeriodChange={(closing) =>
					setSearchParams(
						(current) => {
							const next = new URLSearchParams(current)
							next.set('closing', closing)
							return next
						},
						{ replace: true },
					)
				}
			/>
		</div>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
