import { useLocation, useParams } from 'react-router'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { CountingScreen } from '#app/components/inventory/counting-screen.tsx'
import { requireInventoryAccess } from '#app/utils/inventory/access.server.ts'
import { type Route } from './+types/counts_.$countId.ts'
import { useInventoryLayoutData } from './_layout.tsx'

export async function loader({ request, params }: Route.LoaderArgs) {
	await requireInventoryAccess(request, params.orgSlug)
	return null
}

/** One count, full page: counting while it is open, read-only afterwards. */
export default function InventoryCountRoute() {
	const { orgSlug, canEdit, canSeeCost, locations } = useInventoryLayoutData()
	const { countId } = useParams()
	const { search } = useLocation()
	return (
		<CountingScreen
			key={countId}
			orgSlug={orgSlug}
			countId={countId ?? ''}
			canEdit={canEdit}
			canSeeCost={canSeeCost}
			search={locations.length > 1 ? search : ''}
		/>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
