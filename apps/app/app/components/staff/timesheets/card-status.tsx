import { Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type TimesheetStatus } from '@repo/staffing'
import { Badge } from '@repo/ui/badge'
import { Icon } from '@repo/ui/icon'
import {
	isReviewIssue,
	sortIssues,
} from '#app/utils/staffing/timesheet-view.ts'
import {
	FALLBACK_ISSUE_LABEL,
	ISSUE_HELP,
	ISSUE_LABELS,
	STATUS_LABELS,
} from './issue-copy.ts'

/** A card's state in words, never by color alone. */
export function StatusBadge({ status }: { status: TimesheetStatus }) {
	const { _ } = useLingui()
	const label = _(STATUS_LABELS[status])
	switch (status) {
		case 'needs_review':
			return (
				<Badge variant="destructive">
					<Icon name="alert-triangle" />
					{label}
				</Badge>
			)
		case 'open':
			return (
				<Badge variant="outline">
					<Icon name="clock" />
					{label}
				</Badge>
			)
		case 'approved':
			return (
				<Badge variant="secondary">
					<Icon name="check" />
					{label}
				</Badge>
			)
		case 'locked':
			return (
				<Badge variant="secondary">
					<Icon name="lock" />
					{label}
				</Badge>
			)
		default:
			return <span className="text-muted-foreground text-xs">{label}</span>
	}
}

export function useIssueText() {
	const { _ } = useLingui()
	return {
		label: (code: string) => _(ISSUE_LABELS[code] ?? FALLBACK_ISSUE_LABEL),
		help: (code: string) =>
			ISSUE_HELP[code] ? _(ISSUE_HELP[code]) : _(FALLBACK_ISSUE_LABEL),
	}
}

/**
 * Issue chips, the ones that need a manager first. Past `max` the rest fold into
 * "+N" whose title lists them, so a row never grows taller for information.
 */
export function IssueChips({
	issues,
	max = 2,
}: {
	issues: readonly string[]
	max?: number
}) {
	const text = useIssueText()
	const ordered = sortIssues(issues)
	if (ordered.length === 0) return null
	const shown = ordered.slice(0, max)
	const rest = ordered.slice(max)
	return (
		<span className="flex flex-wrap items-center gap-1">
			{shown.map((code) => (
				<Badge
					key={code}
					variant={isReviewIssue(code) ? 'secondary' : 'outline'}
					title={text.help(code)}
				>
					{text.label(code)}
				</Badge>
			))}
			{rest.length > 0 ? (
				<span
					className="text-muted-foreground text-xs"
					title={rest.map((code) => text.label(code)).join(', ')}
				>
					+{rest.length}
				</span>
			) : null}
		</span>
	)
}

/**
 * Overtime in words and a tint: "OT 1.50". The tint is the design system's
 * warning palette; the words carry the meaning, so it never relies on color.
 * It is an estimate, and the screens say so where overtime is summed.
 */
export function OvertimeChip({ hours }: { hours: string }) {
	return (
		<Badge
			variant="outline"
			className="border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300"
		>
			<span className="tabular-nums">
				<Trans>OT {hours}</Trans>
			</span>
		</Badge>
	)
}
