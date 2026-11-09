import { useLingui } from '@lingui/react/macro'
import { EmptyState } from '#app/components/empty-state.tsx'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { requireInventoryAccess } from '#app/utils/inventory/access.server.ts'
import { type Route } from './+types/counts.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	await requireInventoryAccess(request, params.orgSlug)
	return null
}

export default function InventoryCountsRoute() {
	const { t } = useLingui()
	return (
		<EmptyState
			icons={['list', 'check-circle', 'layers']}
			title={t`No counts yet`}
			description={t`Counts let you walk your fridges and shelves, enter what is there, and see what is missing compared with what you expected. Counting is coming soon.`}
		/>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
