import { Trans, useLingui } from '@lingui/react/macro'
import { Button } from '@repo/ui/button'
import { Skeleton } from '@repo/ui/skeleton'
import { Link } from 'react-router'
import { KanbanCard, KanbanColumn } from '#app/components/kanban/kanban.tsx'
import { StatusLabel } from '#app/components/reservations/status-style.tsx'
import { useFormatMinutes } from '#app/components/reservations/waitlist/waitlist-clock.tsx'
import { type DayWaitlistView } from '#app/utils/reservations/book-api.ts'
import { guestsCountLabel } from '#app/utils/reservations/count-labels.ts'
import { isActiveWaitlistStatus } from '#app/utils/reservations/waitlist-view.ts'

/** Read-only glance at the live queue for the Today board; the full tools live on the Waitlist screen. */
export function TodayWaitlistCard({
	entries,
	orgSlug,
	loading = false,
	className,
}: {
	entries: readonly DayWaitlistView[]
	orgSlug: string
	loading?: boolean
	className?: string
}) {
	const { t } = useLingui()
	const formatMinutes = useFormatMinutes()
	const queue = entries
		.filter((entry) => isActiveWaitlistStatus(entry.status))
		.sort((a, b) => a.position - b.position)
	const waitlistHref = `/${orgSlug}/reservations/waitlist`

	return (
		<KanbanColumn
			title={<Trans>Waitlist</Trans>}
			count={queue.length}
			countTestId="today-waitlist-count"
			testId="today-waitlist-card"
			className={className}
			footer={
				<div className="px-1 pb-1">
					<Button
						size="sm"
						variant="outline"
						className="self-start pointer-coarse:h-11"
						render={<Link to={waitlistHref} />}
						data-testid="today-waitlist-open"
					>
						<Trans>Open waitlist</Trans>
					</Button>
				</div>
			}
			empty={
				loading ? undefined : (
					<span data-testid="today-waitlist-empty">
						<Trans>Nobody is waiting right now.</Trans>
					</span>
				)
			}
		>
			{loading ? (
				<>
					<Skeleton className="h-14" />
					<Skeleton className="h-14" />
				</>
			) : (
				queue.map((entry) => {
					const quoted =
						entry.quotedWaitMin === null
							? null
							: formatMinutes(entry.quotedWaitMin)
					const guest = entry.guestName || t`Guest`
					return (
						<KanbanCard
							key={entry.id}
							testId={`today-waitlist-row-${entry.id}`}
						>
							<p className="text-muted-foreground flex items-baseline gap-x-1.5 text-xs">
								<span className="text-foreground font-medium tabular-nums">
									#{entry.position}
								</span>
								<span aria-hidden="true">·</span>
								<span>{guestsCountLabel(entry.partySize)}</span>
							</p>
							<Link
								to={waitlistHref}
								className="text-foreground focus-visible:ring-ring/50 rounded-sm text-sm font-medium wrap-anywhere outline-none hover:underline focus-visible:underline focus-visible:ring-3 pointer-coarse:min-h-11"
							>
								{guest}
							</Link>
							<div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
								<StatusLabel kind="waitlist" status={entry.status} />
								<span>
									{quoted === null ? (
										<Trans>No quote</Trans>
									) : (
										<Trans>Quoted {quoted}</Trans>
									)}
								</span>
							</div>
						</KanbanCard>
					)
				})
			)}
		</KanbanColumn>
	)
}
