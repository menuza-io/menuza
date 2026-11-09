import { useLingui } from '@lingui/react/macro'
import { EmptyState } from '#app/components/empty-state.tsx'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { requireInventoryAccess } from '#app/utils/inventory/access.server.ts'
import { type Route } from './+types/waste.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	await requireInventoryAccess(request, params.orgSlug)
	return null
}

export default function InventoryWasteRoute() {
	const { t } = useLingui()
	return (
		<EmptyState
			icons={['trash-2', 'chef-hat', 'receipt']}
			title={t`No waste logged yet`}
			description={t`Waste shows what was thrown away and why, so you can see where food and money are lost. Logging waste is coming soon.`}
		/>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
