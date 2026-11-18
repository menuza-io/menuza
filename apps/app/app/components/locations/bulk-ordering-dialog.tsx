import { Trans, plural, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Field, FieldLabel } from '@repo/ui/field'
import { Input } from '@repo/ui/input'
import { Spinner } from '@repo/ui/spinner'
import { useEffect, useId, useState } from 'react'
import { useFetcher } from 'react-router'
import { SelectField } from '#app/components/staff/controls.tsx'
import { LOCATION_ERROR_LABELS } from './location-setting-labels.ts'

type BulkResult = {
	action: 'pause' | 'resume'
	total: number
	done: number
	skipped: number
	failed: number
	locations: Array<{
		locationId: string
		name: string | null
		status: 'done' | 'skipped' | 'failed'
		reason?: 'not_manageable' | 'not_found' | 'failed'
	}>
}

type BulkResponse =
	{ ok: true; bulk: BulkResult } | { ok: false; error: string }

/** The pause durations the Orders page offers, as people read them. */
function useDurationOptions() {
	const { _ } = useLingui()
	return [
		{ value: '15m', label: _(t`15 minutes`) },
		{ value: '30m', label: _(t`30 minutes`) },
		{ value: '60m', label: _(t`1 hour`) },
		{ value: 'rest_of_day', label: _(t`Rest of today`) },
		{ value: 'until_resumed', label: _(t`Until I resume it`) },
	]
}

/**
 * Pause or resume online ordering at the selected locations in one step.
 * It runs the Orders page's pause code once per location on the server; this
 * dialog shows how many were done and lists the ones that were skipped (not
 * yours to manage) or failed, so one problem never hides the rest.
 */
export function BulkOrderingDialog({
	open,
	onOpenChange,
	action,
	locationIds,
	locationCount,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	action: 'pause' | 'resume'
	locationIds: string[]
	locationCount: number
}) {
	const { _ } = useLingui()
	const fetcher = useFetcher<BulkResponse>()
	const idPrefix = useId()
	const durations = useDurationOptions()
	const [duration, setDuration] = useState('60m')
	const [reason, setReason] = useState('')

	useEffect(() => {
		if (open) {
			setDuration('60m')
			setReason('')
		}
	}, [open])

	const busy = fetcher.state !== 'idle'
	const response = fetcher.data
	const result = response && response.ok ? response.bulk : null
	const finished = result !== null && result.action === action
	const doneCount = result?.done ?? 0
	const totalCount = result?.total ?? 0

	function submit() {
		void fetcher.submit(
			{
				intent: 'bulk-ordering',
				payload: JSON.stringify(
					action === 'pause'
						? {
								action,
								locationIds,
								duration,
								...(reason.trim() ? { reason: reason.trim() } : {}),
							}
						: { action, locationIds },
				),
			},
			{ method: 'POST' },
		)
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>
						{action === 'pause' ? (
							<Trans>Pause online ordering</Trans>
						) : (
							<Trans>Resume online ordering</Trans>
						)}
					</DialogTitle>
					<DialogDescription>
						{action === 'pause'
							? plural(locationCount, {
									one: 'Guests cannot order online from # selected location until it is resumed or the time you choose has passed.',
									other:
										'Guests cannot order online from # selected locations until they are resumed or the time you choose has passed.',
								})
							: plural(locationCount, {
									one: 'Online ordering opens again at # selected location, within its normal hours.',
									other:
										'Online ordering opens again at # selected locations, within their normal hours.',
								})}
					</DialogDescription>
				</DialogHeader>

				{finished ? null : action === 'pause' ? (
					<div className="space-y-4">
						<SelectField
							label={<Trans>How long</Trans>}
							options={durations}
							value={duration}
							onValueChange={setDuration}
						/>
						<Field>
							<FieldLabel htmlFor={`${idPrefix}-reason`}>
								<Trans>Reason (optional)</Trans>
							</FieldLabel>
							<Input
								id={`${idPrefix}-reason`}
								maxLength={200}
								value={reason}
								onChange={(event) => setReason(event.target.value)}
								placeholder={t`For example: supplier delay`}
							/>
							<p className="text-muted-foreground text-xs">
								<Trans>
									Saved in the activity log with your name and the time, for
									every location.
								</Trans>
							</p>
						</Field>
					</div>
				) : null}

				{response && !response.ok ? (
					<Alert variant="destructive">
						<AlertDescription>
							{response.error in LOCATION_ERROR_LABELS
								? _(LOCATION_ERROR_LABELS[response.error]!)
								: response.error}
						</AlertDescription>
					</Alert>
				) : null}

				{finished ? (
					<div className="space-y-3" data-testid="bulk-ordering-result">
						<Alert variant={result.failed > 0 ? 'destructive' : 'default'}>
							<AlertDescription>
								<p className="font-medium" data-testid="bulk-progress">
									{action === 'pause'
										? t`${doneCount} of ${totalCount} paused`
										: t`${doneCount} of ${totalCount} resumed`}
								</p>
							</AlertDescription>
						</Alert>
						{result.locations.some((l) => l.status !== 'done') ? (
							<ul className="space-y-1 text-sm">
								{result.locations
									.filter((location) => location.status !== 'done')
									.map((location) => (
										<li key={location.locationId} className="wrap-anywhere">
											<span className="font-medium">
												{location.name ?? location.locationId}
											</span>
											{': '}
											{location.status === 'skipped' ? (
												<Trans>skipped</Trans>
											) : (
												<Trans>failed</Trans>
											)}
											{location.reason
												? ` (${_(LOCATION_ERROR_LABELS[location.reason]!)})`
												: null}
										</li>
									))}
							</ul>
						) : null}
					</div>
				) : null}

				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={() => onOpenChange(false)}
					>
						{finished ? <Trans>Close</Trans> : <Trans>Cancel</Trans>}
					</Button>
					{finished ? null : (
						<Button type="button" disabled={busy} onClick={submit}>
							{busy ? <Spinner /> : null}
							{action === 'pause' ? (
								<Trans>Pause ordering</Trans>
							) : (
								<Trans>Resume ordering</Trans>
							)}
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
