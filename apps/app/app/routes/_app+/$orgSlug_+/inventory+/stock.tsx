import { useLingui } from '@lingui/react/macro'
import { EmptyState } from '#app/components/empty-state.tsx'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { requireInventoryAccess } from '#app/utils/inventory/access.server.ts'
import { type Route } from './+types/stock.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	await requireInventoryAccess(request, params.orgSlug)
	return null
}

export default function InventoryStockRoute() {
	const { t } = useLingui()
	return (
		<EmptyState
			icons={['list', 'layers', 'shopping-bag']}
			title={t`No items yet`}
			description={t`Stock will list every item you buy and use: how much you have at this location, where you keep it and what it is worth. Adding items is coming soon.`}
		/>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
