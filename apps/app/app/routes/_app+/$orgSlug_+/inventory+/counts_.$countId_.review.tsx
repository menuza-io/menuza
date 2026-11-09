import { useLocation, useParams } from 'react-router'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { CountReviewScreen } from '#app/components/inventory/count-review-screen.tsx'
import { requireInventoryAccess } from '#app/utils/inventory/access.server.ts'
import { type Route } from './+types/counts_.$countId_.review.ts'
import { useInventoryLayoutData } from './_layout.tsx'

export async function loader({ request, params }: Route.LoaderArgs) {
	await requireInventoryAccess(request, params.orgSlug)
	return null
}

/** The review of a sent count: what needs a look, then Approve (cost grant). */
export default function InventoryCountReviewRoute() {
	const { orgSlug, canEdit, canSeeCost, locations } = useInventoryLayoutData()
	const { countId } = useParams()
	const { search } = useLocation()
	return (
		<CountReviewScreen
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
