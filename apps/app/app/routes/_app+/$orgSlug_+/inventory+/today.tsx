import { Trans, useLingui } from '@lingui/react/macro'
import { inventoryStatusSchema } from '@repo/inventory'
import { Alert, AlertAction, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { Skeleton } from '@repo/ui/skeleton'
import { useCallback, useEffect, useState } from 'react'
import { useLocation } from 'react-router'
import { EmptyState } from '#app/components/empty-state.tsx'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { InventorySetupChecklist } from '#app/components/inventory/setup-checklist.tsx'
import { useInventoryQuery } from '#app/hooks/use-inventory-client.ts'
import { requireInventoryAccess } from '#app/utils/inventory/access.server.ts'
import { inventoryErrorMessage } from '#app/utils/inventory/inventory-errors.ts'
import { deriveInventorySetupSteps } from '#app/utils/inventory/setup-progress.ts'
import { type Route } from './+types/today.ts'
import { useInventoryLayoutData } from './_layout.tsx'

export async function loader({ request, params }: Route.LoaderArgs) {
	await requireInventoryAccess(request, params.orgSlug)
	return null
}

function dismissKey(orgSlug: string, locationId: string) {
	return `inventory-setup-dismissed:${orgSlug}:${locationId}`
}

/** Per-viewer convenience only; a blocked storage just keeps the line. */
function useSetupDismissed(orgSlug: string, locationId: string) {
	const [dismissed, setDismissed] = useState(false)
	useEffect(() => {
		try {
			setDismissed(
				window.localStorage.getItem(dismissKey(orgSlug, locationId)) === '1',
			)
		} catch {
			setDismissed(false)
		}
	}, [orgSlug, locationId])
	const dismiss = useCallback(() => {
		setDismissed(true)
		try {
			window.localStorage.setItem(dismissKey(orgSlug, locationId), '1')
		} catch {
			// Storage unavailable: dismissed for this visit only.
		}
	}, [orgSlug, locationId])
	return [dismissed, dismiss] as const
}

export default function InventoryTodayRoute() {
	const { t, i18n } = useLingui()
	const { orgSlug, locations, activeLocationId } = useInventoryLayoutData()
	const { search } = useLocation()
	const status = useInventoryQuery(
		`/status?locationId=${encodeURIComponent(activeLocationId)}`,
		inventoryStatusSchema,
	)
	const [dismissed, dismiss] = useSetupDismissed(orgSlug, activeLocationId)
	const linkSearch = locations.length > 1 ? search : ''

	if (status.loading && !status.data) {
		return (
			<div
				role="status"
				className="flex flex-col gap-3"
				data-testid="inventory-today-loading"
			>
				<span className="sr-only">
					<Trans>Loading your inventory setup</Trans>
				</span>
				<Skeleton className="h-6 w-1/3" />
				<Skeleton className="h-40 w-full rounded-xl" />
			</div>
		)
	}

	if (status.error && !status.data) {
		return (
			<Alert variant="destructive" data-testid="inventory-today-error">
				<AlertDescription>
					{i18n._(inventoryErrorMessage(status.error))}
				</AlertDescription>
				<AlertAction>
					<Button variant="outline" onClick={status.reload}>
						<Trans>Try again</Trans>
					</Button>
				</AlertAction>
			</Alert>
		)
	}

	const steps = deriveInventorySetupSteps(status.data)
	return (
		<div
			className={
				status.refreshing
					? 'flex flex-col gap-6 opacity-70 transition-opacity'
					: 'flex flex-col gap-6'
			}
			aria-busy={status.refreshing}
		>
			<InventorySetupChecklist
				steps={steps}
				orgSlug={orgSlug}
				search={linkSearch}
				dismissed={dismissed}
				onDismiss={dismiss}
			/>
			{steps.every((step) => step.status === 'done') ? (
				<EmptyState
					icons={['check-circle']}
					title={t`Nothing needs you right now`}
					description={t`Items running low, counts that are due and deliveries expected today will show here.`}
				/>
			) : null}
		</div>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
