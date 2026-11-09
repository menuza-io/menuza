import { INVENTORY_PERMISSIONS } from '@repo/inventory'
import { useLocation } from 'react-router'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { RecordDeliveryScreen } from '#app/components/inventory/record-delivery-screen.tsx'
import { requireInventoryAccess } from '#app/utils/inventory/access.server.ts'
import { type Route } from './+types/purchasing_.deliveries.new.ts'
import { useInventoryLayoutData } from './_layout.tsx'

export async function loader({ request, params }: Route.LoaderArgs) {
	await requireInventoryAccess(request, params.orgSlug, {
		anyOf: [INVENTORY_PERMISSIONS.UPDATE_INVENTORY],
	})
	return null
}

/** Record a delivery, full page. Needs the cost grant for the invoice prices (explained on the page). */
export default function InventoryRecordDeliveryRoute() {
	const layout = useInventoryLayoutData()
	const { search } = useLocation()
	return (
		<RecordDeliveryScreen
			orgSlug={layout.orgSlug}
			locationId={layout.activeLocationId}
			currency={layout.currency}
			dataRegion={layout.dataRegion}
			canEdit={layout.canEdit}
			canSeeCost={layout.canSeeCost}
			canManagePurchasing={layout.canManagePurchasing}
			search={layout.locations.length > 1 ? search : ''}
		/>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
