import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { cn } from '@repo/ui'
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Icon } from '@repo/ui/icon'
import { Skeleton } from '@repo/ui/skeleton'
import { Link } from 'react-router'
import { setupSuggestionCountLabel } from '#app/components/reservations/settings/setup-checklist.tsx'
import {
	type SetupIssueItem,
	type SetupStatus,
} from '#app/utils/reservations/setup-progress.ts'

/**
 * The one status for "can guests book?", shared by the Settings header and the
 * diagnostics. Shows a skeleton, never a guess, until the checks have loaded.
 */
export function SetupStatusBadge({
	status,
	loading,
}: {
	status: SetupStatus | null
	loading: boolean
}) {
	const { _ } = useLingui()
	if (loading || !status) {
		return loading ? (
			<Skeleton
				className="h-5 w-32 rounded-full"
				data-testid="setup-validation-status-skeleton"
			/>
		) : null
	}
	const suggestions = setupSuggestionCountLabel(status.suggestionCount)
	if (status.state === 'needs_attention') {
		const count = status.blockingCount
		return (
			<Badge variant="warning" data-testid="setup-validation-status-badge">
				<Icon name="alert-triangle" />
				{_(msg`Needs attention (${count})`)}
			</Badge>
		)
	}
	return (
		<Badge variant="success" data-testid="setup-validation-status-badge">
			<Icon name="check-circle" />
			{status.state === 'ready_suggestions'
				? _(msg`Ready, ${suggestions}`)
				: _(msg`Ready to take bookings`)}
		</Badge>
	)
}

function IssueRow({ item, search }: { item: SetupIssueItem; search: string }) {
	const { _ } = useLingui()
	const blocking = item.severity === 'error'
	return (
		<li
			className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1"
			data-testid="setup-validation-issue"
			data-severity={item.severity}
		>
			<Icon
				name={blocking ? 'octagon-alert' : 'alert-triangle'}
				className={cn(
					'size-3.5 shrink-0',
					blocking ? 'text-destructive' : 'text-muted-foreground',
				)}
			/>
			<span className={cn(!blocking && 'text-muted-foreground')}>
				{_(item.text)}
			</span>
			{item.tab ? (
				<Link
					to={{ pathname: item.tab, search }}
					className="text-foreground font-medium underline underline-offset-2"
				>
					<Trans>Fix</Trans>
				</Link>
			) : null}
		</li>
	)
}

/**
 * Lists the specific issues, blocking ones first in the destructive tone and
 * suggestions muted. Renders nothing when there is nothing to fix: the header
 * badge already says "Ready to take bookings".
 */
export function SetupDiagnostics({
	items,
	status,
	loading,
	search,
}: {
	items: readonly SetupIssueItem[]
	status: SetupStatus | null
	loading: boolean
	search: string
}) {
	if (loading) {
		return (
			<Skeleton
				className="h-12 w-full rounded-xl"
				data-testid="setup-validation-skeleton"
			/>
		)
	}
	if (!status || items.length === 0) return null
	const blocking = status.state === 'needs_attention'
	return (
		<Alert
			variant={blocking ? 'destructive' : 'default'}
			data-testid="setup-validation-alert"
		>
			<Icon name={blocking ? 'octagon-alert' : 'shield-check'} />
			<AlertTitle>
				{blocking ? (
					<Trans>Guests cannot book until this is fixed</Trans>
				) : (
					<Trans>Ready for guests. A few things could be better</Trans>
				)}
			</AlertTitle>
			<AlertDescription>
				<ul
					className="flex flex-col gap-1"
					data-testid="setup-validation-issues-list"
				>
					{items.map((item) => (
						<IssueRow key={item.key} item={item} search={search} />
					))}
				</ul>
			</AlertDescription>
		</Alert>
	)
}
