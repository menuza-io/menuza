import { plural } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { cn } from '@repo/ui'
import { Icon } from '@repo/ui/icon'
import { type ScoreBand, scoreBand } from '#app/utils/hiring/applicant-view.ts'
import { type ApplicantLabels } from './applicant-labels.ts'

/** The "N answers to check" note: icon and words, never colour alone. */
export function FlagNote({ count }: { count: number }) {
	if (count <= 0) return null
	return (
		<span className="text-destructive inline-flex items-center gap-1 text-xs">
			<Icon name="alert-triangle" className="size-3.5 shrink-0" />
			{plural(count, {
				one: '# answer to check',
				other: '# answers to check',
			})}
		</span>
	)
}

const DOT: Record<ScoreBand, string> = {
	none: 'bg-muted-foreground/30',
	strong: 'bg-primary',
	mixed: 'bg-muted-foreground',
	low: 'bg-destructive/70',
}

/**
 * How the screening answers matched, as a dot and words. It never says "reject":
 * a score is a hint for where to look first, and the decision stays with a person.
 */
export function FitLabel({
	score,
	labels,
	className,
}: {
	score: number | null
	labels: ApplicantLabels
	className?: string
}) {
	const band = scoreBand(score)
	if (band === 'none') return null
	return (
		<span
			className={cn(
				'text-muted-foreground inline-flex items-center gap-1.5 text-xs',
				className,
			)}
		>
			<span
				aria-hidden="true"
				className={cn('size-1.5 shrink-0 rounded-full', DOT[band])}
			/>
			{labels.score[band]}
		</span>
	)
}

/** "2 days ago" in the viewer's language. */
export function useRelativeTime() {
	const { i18n } = useLingui()
	return (ms: number, now = Date.now()): string => {
		const seconds = Math.round((ms - now) / 1000)
		const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
			['day', 86_400],
			['hour', 3_600],
			['minute', 60],
		]
		const formatter = new Intl.RelativeTimeFormat(i18n.locale, {
			numeric: 'auto',
		})
		for (const [unit, size] of units) {
			if (Math.abs(seconds) >= size) {
				return formatter.format(Math.trunc(seconds / size), unit)
			}
		}
		return formatter.format(0, 'minute')
	}
}

export function StageDot({ stage }: { stage: string }) {
	const dot =
		stage === 'declined'
			? 'bg-destructive/70'
			: stage === 'hired'
				? 'bg-primary'
				: 'bg-muted-foreground/60'
	return (
		<span
			aria-hidden="true"
			className={cn('size-1.5 shrink-0 rounded-full', dot)}
		/>
	)
}
