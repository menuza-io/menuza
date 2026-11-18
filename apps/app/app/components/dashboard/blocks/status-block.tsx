import { Trans } from '@lingui/react/macro'
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/card'
import { Link } from 'react-router'
import {
	HealthSummaryBadge,
	LocationHealthCard,
} from '#app/components/status/location-status-view.tsx'
import { type LocationStatusData } from '#app/utils/status/location-status.server.ts'

/**
 * The Status card (#332): can each location take orders right now? The summary
 * is the worst state; locations with a problem are listed with what is wrong
 * and a link to fix it. All of it comes from the page load, no extra request.
 */
export function StatusBlock({
	orgSlug,
	data,
}: {
	orgSlug: string
	data: LocationStatusData | null | undefined
}) {
	if (!data) return null
	const problems = data.locations.filter(
		(location) => location.summary !== 'taking_orders',
	)
	return (
		<Card className="h-full overflow-auto" data-testid="status-block">
			<CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
				<CardTitle>
					<Trans>Status</Trans>
				</CardTitle>
				{data.locations.length > 0 ? (
					<HealthSummaryBadge summary={data.summary} />
				) : null}
			</CardHeader>
			<CardContent className="space-y-3">
				{data.locations.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						<Trans>No locations to check.</Trans>
					</p>
				) : problems.length === 0 ? (
					<p className="text-muted-foreground text-sm" data-testid="status-all-clear">
						<Trans>All checks passed at every location.</Trans>
					</p>
				) : (
					problems.map((health) => (
						<LocationHealthCard
							key={health.locationId}
							health={health as never}
							orgSlug={orgSlug}
							compact
						/>
					))
				)}
				<Link
					to={`/${orgSlug}/status`}
					className="text-primary text-sm underline-offset-4 hover:underline"
				>
					<Trans>See every check</Trans>
				</Link>
			</CardContent>
		</Card>
	)
}
