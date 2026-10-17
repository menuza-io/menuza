import { Trans, useLingui } from '@lingui/react/macro'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/card'
import { Link } from 'react-router'
import { useFormatMinutes } from '#app/components/reservations/waitlist/waitlist-clock.tsx'
import { type DayWaitlistView } from '#app/utils/reservations/book-api.ts'
import { enumLabel } from '#app/utils/reservations/labels.ts'
import {
	isActiveWaitlistStatus,
	WAITLIST_STATUS_LABELS,
	waitlistStatusVariant,
} from '#app/utils/reservations/waitlist-view.ts'

/** Read-only glance at the live queue for the Today board; the full tools live on the Waitlist screen. */
export function TodayWaitlistCard({
	entries,
	orgSlug,
}: {
	entries: readonly DayWaitlistView[]
	orgSlug: string
}) {
	const { i18n } = useLingui()
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
					<Badge variant="secondary" data-testid="today-waitlist-count">
						{queue.length}
					</Badge>
				</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col gap-2.5">
				{queue.length === 0 ? (
					<div
						className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-xs"
						data-testid="today-waitlist-empty"
					>
						<Trans>Nobody is waiting right now.</Trans>
					</div>
				) : (
					queue.map((entry) => {
						const quoted =
							entry.quotedWaitMin === null
								? null
								: formatMinutes(entry.quotedWaitMin)
						return (
							<div
								key={entry.id}
								className="bg-background flex flex-col gap-1.5 rounded-lg border p-3 text-xs"
								data-testid={`today-waitlist-row-${entry.id}`}
							>
								<div className="flex items-start justify-between gap-2">
									<span className="font-semibold wrap-anywhere">
										#{entry.position} {entry.guestName} ({entry.partySize})
									</span>
									<Badge variant={waitlistStatusVariant(entry.status)}>
										{enumLabel(
											(d) => i18n._(d),
											WAITLIST_STATUS_LABELS,
											entry.status,
										)}
									</Badge>
								</div>
								<div className="text-muted-foreground">
									{quoted === null ? (
										<Trans>No quote</Trans>
									) : (
										<Trans>Quoted {quoted}</Trans>
									)}
								</div>
							</div>
						)
					})
				)}
				<Button
					size="xs"
					variant="outline"
					className="self-start"
					render={<Link to={`/${orgSlug}/reservations/waitlist`} />}
					data-testid="today-waitlist-open"
				>
					<Trans>Open waitlist</Trans>
				</Button>
			</CardContent>
		</Card>
	)
}
