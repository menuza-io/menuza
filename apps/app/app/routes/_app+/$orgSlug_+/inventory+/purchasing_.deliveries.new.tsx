import { INVENTORY_PERMISSIONS } from '@repo/inventory'
import { useLocation, useSearchParams } from 'react-router'
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

/**
 * Record a delivery, full page. With `?orderId=` it receives against that
 * order. Without the cost grant it records quantities only; a person with the
 * purchasing role confirms the prices later.
 */
export default function InventoryRecordDeliveryRoute() {
	const layout = useInventoryLayoutData()
	const { search } = useLocation()
	const [searchParams] = useSearchParams()
	const orderId = searchParams.get('orderId')
	// The order id is a one-off pointer, not a filter to carry on every link.
	const kept = new URLSearchParams(search)
	kept.delete('orderId')
	const keptSearch = kept.toString() === '' ? '' : `?${kept.toString()}`
	return (
		<RecordDeliveryScreen
			orgSlug={layout.orgSlug}
			locationId={layout.activeLocationId}
			currency={layout.currency}
			dataRegion={layout.dataRegion}
			canEdit={layout.canEdit}
			canSeeCost={layout.canSeeCost}
			canManagePurchasing={layout.canManagePurchasing}
			purchasingEnabled={layout.purchasingEnabled}
			orderId={orderId}
			search={layout.locations.length > 1 ? keptSearch : ''}
		/>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
