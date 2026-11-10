import { Trans } from '@lingui/react/macro'
import { useSearchParams } from 'react-router'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { PrepLevelsPanel } from '#app/components/inventory/prep-levels-panel.tsx'
import { PrepScreen } from '#app/components/inventory/prep-screen.tsx'
import { requireInventoryAccess } from '#app/utils/inventory/access.server.ts'
import { type Route } from './+types/prep.ts'
import { useInventoryLayoutData } from './_layout.tsx'

export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireInventoryAccess(request, params.orgSlug)
	// Prep sits behind its own flag: off, the page does not exist.
	if (!access.features.prep) throw new Response('Not Found', { status: 404 })
	return null
}

/**
 * Prep: what to make today (list or board), and the levels behind it. The
 * list opens by planning the day if nobody has; a cook starts a task and says
 * how much came out, which records a batch.
 */
export default function InventoryPrepRoute() {
	const { activeLocationId, canEdit, nav } = useInventoryLayoutData()
	const [searchParams, setSearchParams] = useSearchParams()
	const view = searchParams.get('view') === 'board' ? 'board' : 'list'
	if (!nav.prep) return null
	return (
		<div className="flex flex-col gap-6">
			<PrepScreen
				locationId={activeLocationId}
				canEdit={canEdit}
				view={view}
				onViewChange={(next) =>
					setSearchParams(
						(current) => {
							const copy = new URLSearchParams(current)
							if (next === 'board') copy.set('view', 'board')
							else copy.delete('view')
							return copy
						},
						{ replace: true },
					)
				}
			/>
			<PrepLevelsPanel locationId={activeLocationId} canEdit={canEdit} />
		</div>
	)
}

export function ErrorBoundary() {
	return (
		<GeneralErrorBoundary
			statusHandlers={{
				404: () => (
					<Trans>Prep is not switched on for this organization.</Trans>
				),
			}}
		/>
	)
}
