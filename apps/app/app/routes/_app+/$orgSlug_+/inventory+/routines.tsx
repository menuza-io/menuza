import { Trans } from '@lingui/react/macro'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Link } from 'react-router'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { InventoryHeaderActions } from '#app/components/inventory/inventory-chrome.tsx'
import { RoutinesScreen } from '#app/components/inventory/routines-screen.tsx'
import { requireInventoryAccess } from '#app/utils/inventory/access.server.ts'
import { type Route } from './+types/routines.ts'
import { useInventoryLayoutData } from './_layout.tsx'

/**
 * Ready-made routines (#529): templates a manager turns on or off per location,
 * each with its last runs and what it did. Behind `inventory.routines`; the
 * region runs them and keeps the record. They draft and tell, never send.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireInventoryAccess(request, params.orgSlug)
	if (!access.features.routines) {
		throw new Response('Not Found', { status: 404 })
	}
	return null
}

export default function InventoryRoutinesRoute() {
	const { activeLocationId, canEdit, canSeeCost, currency, orgSlug } =
		useInventoryLayoutData()
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
			<RoutinesScreen
				locationId={activeLocationId}
				orgSlug={orgSlug}
				canEdit={canEdit}
				canSeeCost={canSeeCost}
				currency={currency}
			/>
		</div>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
