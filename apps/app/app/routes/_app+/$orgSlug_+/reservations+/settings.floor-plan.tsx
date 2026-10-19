import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Skeleton } from '@repo/ui/skeleton'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { EmptyState } from '#app/components/empty-state.tsx'
import {
	FloorPlanCanvas,
	type FloorPlanSaveDraft,
} from '#app/components/reservations/floor-plan-canvas.tsx'
import {
	useConfirmBlocker,
	useDirtyBeforeUnload,
} from '#app/utils/navigation-guards.ts'
import { requireReservationsAccess } from '#app/utils/reservations/access.server.ts'
import { RESERVATIONS_SECTION_REQUIREMENTS } from '#app/utils/reservations/sections.ts'
import {
	extractApiErrorMessage,
	fetchFloorPlan,
	type FloorPlanPayload,
	isVersionConflictError,
	type ReflowedMoveDto,
	saveFloorPlan,
	type SetupConflictDto,
} from '#app/utils/reservations/setup-api.ts'
import { type Route } from './+types/settings.floor-plan.ts'
import { useReservationsSetupContext } from './settings.tsx'

export async function loader({ request, params }: Route.LoaderArgs) {
	await requireReservationsAccess(
		request,
		params.orgSlug,
		RESERVATIONS_SECTION_REQUIREMENTS.settings,
	)
	return null
}

export default function ReservationsSettingsFloorPlanRoute() {
	const { _ } = useLingui()
	const navigate = useNavigate()
	const [searchParams] = useSearchParams()
	const {
		orgSlug,
		selectedLocationId,
		selectedLocation,
		canWrite,
		client,
		refreshSummary,
	} = useReservationsSetupContext()

	const [floorPlan, setFloorPlan] = useState<FloorPlanPayload | null>(null)
	const [loading, setLoading] = useState(true)
	const [saving, setSaving] = useState(false)
	const [errorMessage, setErrorMessage] = useState<string | null>(null)
	const [conflictMessage, setConflictMessage] = useState<string | null>(null)
	const [isDirty, setIsDirty] = useState(false)
	const [savedBanner, setSavedBanner] = useState<string | null>(null)
	const [lastConflicts, setLastConflicts] = useState<SetupConflictDto[]>([])
	const [lastReflowedMoves, setLastReflowedMoves] = useState<ReflowedMoveDto[]>(
		[],
	)

	const loadFloorPlan = useCallback(async () => {
		if (!selectedLocationId) {
			setLoading(false)
			return
		}
		setLoading(true)
		setErrorMessage(null)
		try {
			const res = await fetchFloorPlan(client, selectedLocationId)
			setFloorPlan(res)
		} catch {
			// Plain copy only: the server's own wording is never shown here.
			setErrorMessage(_(msg`The floor plan could not be loaded.`))
		} finally {
			setLoading(false)
		}
	}, [client, selectedLocationId, _])

	useEffect(() => {
		void loadFloorPlan()
	}, [loadFloorPlan])

	const handleSave = async (draft: FloorPlanSaveDraft): Promise<boolean> => {
		if (!canWrite || !selectedLocationId) return false
		setSaving(true)
		setErrorMessage(null)
		setConflictMessage(null)
		setSavedBanner(null)
		try {
			const saveRes = await saveFloorPlan(client, selectedLocationId, draft)
			if (saveRes.conflicts) setLastConflicts(saveRes.conflicts)
			if (saveRes.reflowedMoves) setLastReflowedMoves(saveRes.reflowedMoves)
			// A 200 PUT is a committed save and carries the new version and plan.
			setFloorPlan(saveRes)
			setSavedBanner(_(msg`Floor plan saved.`))
		} catch (err) {
			return handleSaveFailure(err)
		}

		try {
			const refreshed = await fetchFloorPlan(client, selectedLocationId)
			setFloorPlan(refreshed)
			await refreshSummary()
		} catch (err) {
			setErrorMessage(
				extractApiErrorMessage(
					err,
					_(
						msg`The floor plan was saved, but the latest version could not be reloaded.`,
					),
				),
			)
		} finally {
			setSaving(false)
		}
		return true
	}

	const handleSaveFailure = (err: unknown): boolean => {
		setSaving(false)
		if (isVersionConflictError(err)) {
			setConflictMessage(
				_(
					msg`Someone else saved a newer floor plan since you opened it. Your changes were not saved. Reload the latest floor plan, then redo your edits.`,
				),
			)
		} else {
			setErrorMessage(
				extractApiErrorMessage(err, _(msg`Failed to save floor plan.`)),
			)
		}
		return false
	}

	const handleReloadAfterConflict = () => {
		setConflictMessage(null)
		setSavedBanner(null)
		void loadFloorPlan()
	}

	useConfirmBlocker(
		isDirty,
		_(msg`You have unsaved floor plan changes. Leave and discard them?`),
	)
	useDirtyBeforeUnload(isDirty)

	const handleLeave = () => {
		const suffix = searchParams.toString() ? `?${searchParams.toString()}` : ''
		void navigate(`/${orgSlug}/reservations/settings/tables${suffix}`)
	}

	if (loading && !floorPlan) {
		return (
			<div
				className="flex flex-col gap-3"
				data-testid="floor-plan-loading"
				role="status"
				aria-label={_(msg`Loading floor plan`)}
			>
				<Skeleton className="h-10 w-full" />
				<Skeleton className="h-96 w-full" />
			</div>
		)
	}

	if (!floorPlan) {
		return (
			<Alert variant="destructive" data-testid="floor-plan-error">
				<Icon name="alert-triangle" className="size-4" />
				<AlertDescription>
					<div className="flex flex-wrap items-center justify-between gap-3">
						<span>
							{errorMessage ?? <Trans>Unable to load floor plan data.</Trans>}
						</span>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => void loadFloorPlan()}
						>
							<Trans>Retry</Trans>
						</Button>
					</div>
				</AlertDescription>
			</Alert>
		)
	}

	if (floorPlan.areas.length === 0) {
		return (
			<div data-testid="floor-plan-empty">
				<EmptyState
					icons={['layout-grid']}
					title={<Trans>Add a dining area first</Trans>}
					description={
						<Trans>
							The floor plan places your tables inside dining areas. Create an
							area and its tables, then come back to arrange them.
						</Trans>
					}
					action={{
						label: _(msg`Go to tables`),
						href: `/${orgSlug}/reservations/settings/tables`,
					}}
				/>
			</div>
		)
	}

	return (
		<div data-testid="setup-floor-plan-page">
			{errorMessage ? (
				<div
					role="alert"
					className="bg-background text-destructive fixed inset-x-0 top-12 z-[60] border-b px-4 py-2 text-sm"
					data-testid="floor-plan-save-error"
				>
					{errorMessage}
				</div>
			) : null}

			{savedBanner ? (
				<div
					role="status"
					className="bg-background text-success fixed inset-x-0 top-12 z-[60] border-b px-4 py-2 text-sm"
					data-testid="floor-plan-saved-banner"
				>
					{savedBanner}
				</div>
			) : null}

			<FloorPlanCanvas
				locationName={selectedLocation?.name ?? orgSlug}
				floorPlanVersion={floorPlan.floorPlanVersion}
				areas={floorPlan.areas}
				tables={floorPlan.tables}
				elements={floorPlan.elements}
				canWrite={canWrite}
				saving={saving}
				conflictMessage={conflictMessage}
				lastConflicts={lastConflicts}
				lastReflowedMoves={lastReflowedMoves}
				onSave={handleSave}
				onReloadLatest={handleReloadAfterConflict}
				onLeave={handleLeave}
				onDirtyChange={setIsDirty}
			/>
		</div>
	)
}
