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
		const eta = formatEta(progress.etaMs)
		return (
			<div
				className="flex flex-col gap-2 rounded-md border p-3"
				data-testid={`${testId}-progress`}
			>
				{cut ? (
					<p className="text-warning text-sm" data-testid={`${testId}-cut`}>
						<Trans>
							This view has <bdi>{cut.matching}</bdi> rows. The file holds the
							first <bdi>{cut.total}</bdi>. Narrow the filters to export the
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
							Exporting <bdi>{progress.percent}</bdi>% (
							<bdi>{progress.rowsDone}</bdi> of <bdi>{progress.rowsTotal}</bdi>{' '}
							rows)
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

	return (
		<p
			role="status"
			className="text-muted-foreground text-sm"
			data-testid={`${testId}-done`}
		>
			{state.cut ? (
				<Trans>
					Export finished. The file holds the first <bdi>{state.cut.total}</bdi>{' '}
					of <bdi>{state.cut.matching}</bdi> rows. Narrow the filters to export
					the rest.
				</Trans>
			) : (
				<Trans>
					Export finished (<bdi>{state.rowCount}</bdi> rows).
				</Trans>
			)}
		</p>
	)
}
