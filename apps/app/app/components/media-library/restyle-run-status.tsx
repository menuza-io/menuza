import { Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Badge } from '@repo/ui/badge'
import { Progress } from '@repo/ui/progress'
import { type RestyleRunSummary } from '#app/utils/media/restyle/types.ts'
import { RESTYLE_STATUS_LABELS } from './restyle-labels.ts'

/** A time in the viewer's zone. Server and browser can differ, so React is told. */
export function RestyleTime({ iso }: { iso: string }) {
	return (
		<time dateTime={iso} suppressHydrationWarning>
			{new Date(iso).toLocaleString(undefined, {
				dateStyle: 'medium',
				timeStyle: 'short',
			})}
		</time>
	)
}

const BADGE_VARIANT = {
	pending: 'secondary',
	running: 'default',
	paused: 'warning',
	ready: 'success',
	cancelled: 'outline',
} as const

/**
 * A run's state at a glance: the status, a progress bar while it works, and
 * the plain reason when it is waiting for tomorrow.
 */
export function RestyleRunStatus({
	run,
}: {
	run: Pick<
		RestyleRunSummary,
		'status' | 'done' | 'failed' | 'toDo' | 'resumeAt'
	>
}) {
	const { _ } = useLingui()
	const finished = run.done + run.failed
	const toDo = run.toDo
	const percent =
		run.toDo > 0 ? Math.min(100, Math.round((finished / run.toDo) * 100)) : 100
	const working =
		run.status === 'pending' ||
		run.status === 'running' ||
		run.status === 'paused'
	return (
		<div className="space-y-2">
			<div className="flex flex-wrap items-center gap-2">
				<Badge variant={BADGE_VARIANT[run.status]}>
					{_(RESTYLE_STATUS_LABELS[run.status])}
				</Badge>
				<span className="text-muted-foreground text-sm">
					<Trans>
						{finished} of {toDo} dishes done
					</Trans>
				</span>
			</div>
			{working ? (
				<Progress
					value={percent}
					aria-label={_(RESTYLE_STATUS_LABELS[run.status])}
				/>
			) : null}
			{run.status === 'paused' ? (
				<p className="text-muted-foreground text-sm">
					{run.resumeAt ? (
						<Trans>
							Paused: daily limit reached, resumes{' '}
							<RestyleTime iso={run.resumeAt} />
						</Trans>
					) : (
						<Trans>Paused: restyling is switched off for now.</Trans>
					)}
				</p>
			) : null}
		</div>
	)
}
