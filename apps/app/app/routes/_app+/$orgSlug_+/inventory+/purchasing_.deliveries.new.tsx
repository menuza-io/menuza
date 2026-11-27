import { INVENTORY_PERMISSIONS } from '@repo/inventory'
import { useLocation, useNavigate, useSearchParams } from 'react-router'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { CashPurchaseDialog } from '#app/components/inventory/cash-purchase-dialog.tsx'
import { RecordDeliveryScreen } from '#app/components/inventory/record-delivery-screen.tsx'
import { requireInventoryAccess } from '#app/utils/inventory/access.server.ts'
import { inventoryTabPath } from '#app/utils/inventory/nav.ts'
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
 * order. With `?creditFor=` it records a credit note / return. With `?cash=1`
 * it opens Cash purchase mode. Without the cost grant it records quantities
 * only; a person with the purchasing role confirms the prices later.
 */
export default function InventoryRecordDeliveryRoute() {
	const layout = useInventoryLayoutData()
	const navigate = useNavigate()
	const { search } = useLocation()
	const [searchParams] = useSearchParams()
	const orderId = searchParams.get('orderId')
	const creditForDeliveryId = searchParams.get('creditFor')
	const inboxId = searchParams.get('inboxId')
	const isCashMode = searchParams.get('cash') === '1'
	// One-off pointers are not filters to carry on every link.
	const kept = new URLSearchParams(search)
	kept.delete('orderId')
	kept.delete('creditFor')
	kept.delete('inboxId')
	kept.delete('cash')
	const keptSearch = kept.toString() === '' ? '' : `?${kept.toString()}`
	const cleanSearch = layout.locations.length > 1 ? keptSearch : ''

	if (isCashMode && layout.canSeeCost) {
		const backHref = `${inventoryTabPath(layout.orgSlug, 'purchasing')}${cleanSearch}`
		return (
			<CashPurchaseDialog
				open
				onOpenChange={(next) => {
					if (!next) void navigate(backHref)
				}}
				locationId={layout.activeLocationId}
				currency={layout.currency}
				onSaved={() => void navigate(backHref)}
			/>
		)
	}

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
			creditForDeliveryId={creditForDeliveryId}
			inboxId={inboxId}
			search={cleanSearch}
		/>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
