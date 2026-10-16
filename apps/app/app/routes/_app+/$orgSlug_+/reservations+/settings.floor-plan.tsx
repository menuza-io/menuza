import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Button } from '@repo/ui/button'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import {
	FloorPlanCanvas,
	type FloorPlanSaveDraft,
} from '#app/components/reservations/floor-plan-canvas.tsx'
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
		} catch (err) {
			setErrorMessage(
				extractApiErrorMessage(err, _(msg`Failed to load floor plan.`)),
			)
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
			const refreshed = await fetchFloorPlan(client, selectedLocationId)
			setFloorPlan(refreshed)
			const newFloorPlanVersion = refreshed.floorPlanVersion
			setSavedBanner(_(msg`Floor plan saved (v${newFloorPlanVersion}).`))
			await refreshSummary()
			return true
		} catch (err) {
			if (isVersionConflictError(err)) {
				setConflictMessage(
					_(
						msg`Stale floor plan version (409 conflict): another operator saved changes since you opened this floor plan. Reload the latest floor plan or inspect your draft before re-applying.`,
					),
				)
			} else {
				setErrorMessage(
					extractApiErrorMessage(err, _(msg`Failed to save floor plan.`)),
				)
			}
			return false
		} finally {
			setSaving(false)
		}
	}

	const handleReloadAfterConflict = () => {
		setConflictMessage(null)
		setSavedBanner(null)
		void loadFloorPlan()
	}

	const handleLeave = () => {
		const suffix = searchParams.toString() ? `?${searchParams.toString()}` : ''
		void navigate(`/${orgSlug}/reservations/settings/tables${suffix}`)
	}

	if (loading && !floorPlan) {
		return (
			<div
				className="border-border bg-card rounded-xl border p-6 text-sm"
				data-testid="floor-plan-loading"
			>
				<Trans>Loading floor plan designer…</Trans>
			</div>
		)
	}

	if (!floorPlan) {
		return (
			<div
				className="border-destructive/40 bg-destructive/10 text-destructive flex items-center justify-between gap-4 rounded-xl border p-6 text-sm"
				data-testid="floor-plan-error"
			>
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
		)
	}

	return (
		<div className="flex flex-col gap-3" data-testid="setup-floor-plan-page">
			{errorMessage ? (
				<div
					role="alert"
					className="border-destructive/40 bg-destructive/10 text-destructive rounded-xl border px-4 py-3 text-sm"
					data-testid="floor-plan-save-error"
				>
					{errorMessage}
				</div>
			) : null}

			{savedBanner ? (
				<div
					role="status"
					className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-sm text-emerald-800 dark:text-emerald-200"
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
			/>
		</div>
	)
}
