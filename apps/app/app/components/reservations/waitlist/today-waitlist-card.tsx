import { Trans, useLingui } from '@lingui/react/macro'
import { Button } from '@repo/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/card'
import { Icon } from '@repo/ui/icon'
import { Skeleton } from '@repo/ui/skeleton'
import { Link } from 'react-router'
import { StatusLabel } from '#app/components/reservations/status-style.tsx'
import { useFormatMinutes } from '#app/components/reservations/waitlist/waitlist-clock.tsx'
import { type DayWaitlistView } from '#app/utils/reservations/book-api.ts'
import { isActiveWaitlistStatus } from '#app/utils/reservations/waitlist-view.ts'

/** Read-only glance at the live queue for the Today board; the full tools live on the Waitlist screen. */
export function TodayWaitlistCard({
	entries,
	orgSlug,
	loading = false,
}: {
	entries: readonly DayWaitlistView[]
	orgSlug: string
	loading?: boolean
}) {
	const { t } = useLingui()
	const formatMinutes = useFormatMinutes()
	const queue = entries
		.filter((entry) => isActiveWaitlistStatus(entry.status))
		.sort((a, b) => a.position - b.position)

	return (
		<Card className="flex flex-col" data-testid="today-waitlist-card">
			<CardHeader className="pb-2">
				<CardTitle className="flex items-center justify-between text-base">
					<span>
						<Trans>Waitlist</Trans>
					</span>
					<span
						className="text-muted-foreground text-sm font-normal tabular-nums"
						data-testid="today-waitlist-count"
					>
						{queue.length}
					</span>
				</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col gap-2.5">
				{loading ? (
					<>
						<Skeleton className="h-14" />
						<Skeleton className="h-14" />
					</>
				) : queue.length === 0 ? (
					<div
						className="text-muted-foreground flex flex-col items-center gap-2 rounded-lg border border-dashed p-6 text-center text-sm"
						data-testid="today-waitlist-empty"
					>
						<Icon name="users" className="size-5" />
						<Trans>Nobody is waiting right now.</Trans>
					</div>
				) : (
					queue.map((entry) => {
						const quoted =
							entry.quotedWaitMin === null
								? null
								: formatMinutes(entry.quotedWaitMin)
						const guest = entry.guestName || t`Guest`
						return (
							<div
								key={entry.id}
								className="bg-background flex flex-col gap-1 rounded-lg border p-3"
								data-testid={`today-waitlist-row-${entry.id}`}
							>
								<span className="text-sm font-semibold wrap-anywhere">
									#{entry.position} {guest} ({entry.partySize})
								</span>
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
							</div>
						)
					})
				)}
				<Button
					size="sm"
					variant="outline"
					className="h-11 self-start md:h-8"
					render={<Link to={`/${orgSlug}/reservations/waitlist`} />}
					data-testid="today-waitlist-open"
				>
					<Trans>Open waitlist</Trans>
				</Button>
			</CardContent>
		</Card>
	)
}
