import { useLingui } from '@lingui/react/macro'
import { EmptyState } from '#app/components/empty-state.tsx'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { requireInventoryAccess } from '#app/utils/inventory/access.server.ts'
import { type Route } from './+types/purchasing.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	await requireInventoryAccess(request, params.orgSlug)
	return null
}

export default function InventoryPurchasingRoute() {
	const { t } = useLingui()
	return (
		<EmptyState
			icons={['receipt-text', 'shopping-bag', 'list']}
			title={t`No deliveries yet`}
			description={t`Purchasing keeps your deliveries, what to order and the suppliers you buy from in one place. Recording deliveries is coming soon.`}
		/>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
