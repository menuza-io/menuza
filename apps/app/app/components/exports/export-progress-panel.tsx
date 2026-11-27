import { Plural, Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { formatEta } from '@repo/reports/export'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Progress } from '@repo/ui/progress'
import { type ChunkedExportState } from './use-chunked-export.ts'

/**
 * What an export shows while it runs and after it ends (#386): a percentage,
 * the estimated time left, Cancel, and the warning that the cap cuts the
 * result. Rendered inline, so the page stays usable.
 */
export function ExportProgressPanel({
	state,
	onCancel,
	testId = 'export',
}: {
	state: ChunkedExportState
	onCancel: () => void
	testId?: string
}) {
	const { _ } = useLingui()
	if (state.status === 'idle') return null

	if (state.status === 'running') {
		const { progress, cut } = state
		const cutMatching = cut?.matching
		const cutTotal = cut?.total
		const percent = progress.percent
		const rowsDone = progress.rowsDone
		const rowsTotal = progress.rowsTotal
		const eta = formatEta(progress.etaMs)
		return (
			<div
				className="flex flex-col gap-2 rounded-md border p-3"
				data-testid={`${testId}-progress`}
			>
				{cut ? (
					<p className="text-warning text-sm" data-testid={`${testId}-cut`}>
						<Trans>
							This view has <bdi>{cutMatching}</bdi> rows. The file holds the
							first <bdi>{cutTotal}</bdi>. Narrow the filters to export the
							rest.
						</Trans>
					</p>
				) : null}
				<Progress
					value={progress.percent}
					aria-label={_(msg`Export progress`)}
					data-testid={`${testId}-bar`}
				/>
				<div className="flex flex-wrap items-center gap-3 text-sm">
					<span role="status" aria-live="polite" className="tabular-nums">
						<Trans>
							Exporting <bdi>{percent}</bdi>% (<bdi>{rowsDone}</bdi> of{' '}
							<bdi>{rowsTotal}</bdi> rows)
						</Trans>
					</span>
					<span className="text-muted-foreground tabular-nums">
						{eta.unit === 'unknown' ? (
							<Trans>Estimating time left…</Trans>
						) : eta.unit === 'seconds' ? (
							<Trans>
								About{' '}
								<Plural
									value={eta.value}
									one="# second left"
									other="# seconds left"
								/>
							</Trans>
						) : (
							<Trans>
								About{' '}
								<Plural
									value={eta.value}
									one="# minute left"
									other="# minutes left"
								/>
							</Trans>
						)}
					</span>
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="ms-auto"
						onClick={onCancel}
						data-testid={`${testId}-cancel`}
					>
						<Icon name="x" className="size-4" />
						<Trans>Cancel</Trans>
					</Button>
				</div>
			</div>
		)
	}

	if (state.status === 'cancelled') {
		return (
			<p
				role="status"
				className="text-muted-foreground text-sm"
				data-testid={`${testId}-cancelled`}
			>
				<Trans>Export cancelled. No file was saved.</Trans>
			</p>
		)
	}

	if (state.status === 'failed') {
		return (
			<Alert variant="destructive" data-testid={`${testId}-failed`}>
				<Icon name="alert-triangle" />
				<AlertDescription>
					<Trans>The export failed. No file was saved. Try again.</Trans>
				</AlertDescription>
			</Alert>
		)
	}

	const doneCutTotal = state.cut?.total
	const doneCutMatching = state.cut?.matching
	const doneRows = state.rowCount
	return (
		<p
			role="status"
			className="text-muted-foreground text-sm"
			data-testid={`${testId}-done`}
		>
			{state.cut ? (
				<Trans>
					Export finished. The file holds the first <bdi>{doneCutTotal}</bdi> of{' '}
					<bdi>{doneCutMatching}</bdi> rows. Narrow the filters to export the
					rest.
				</Trans>
			) : (
				<Trans>
					Export finished (<bdi>{doneRows}</bdi> rows).
				</Trans>
			)}
		</p>
	)
}
