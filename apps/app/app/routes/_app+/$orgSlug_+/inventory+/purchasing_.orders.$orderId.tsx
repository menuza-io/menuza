import { useLocation, useParams } from 'react-router'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { ReviewOrderScreen } from '#app/components/inventory/review-order-screen.tsx'
import { requireInventoryAccess } from '#app/utils/inventory/access.server.ts'
import { type Route } from './+types/purchasing_.orders.$orderId.ts'
import { useInventoryLayoutData } from './_layout.tsx'

export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireInventoryAccess(request, params.orgSlug)
	// Orders come with the purchasing flag: with it off the page does not exist.
	if (!access.features.purchasing)
		throw new Response('Not Found', { status: 404 })
	return null
}

/** Review order, full page: edit a draft, then send it by email, WhatsApp, copy or PDF. */
export default function InventoryReviewOrderRoute() {
	const layout = useInventoryLayoutData()
	const { orderId = '' } = useParams()
	const { search } = useLocation()
	return (
		<ReviewOrderScreen
			orgSlug={layout.orgSlug}
			orderId={orderId}
			currency={layout.currency}
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
