import { Trans } from '@lingui/react/macro'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Card, CardContent } from '@repo/ui/card'
import { Icon } from '@repo/ui/icon'
import { Link } from 'react-router'
import { type LocationPerformance } from '#app/utils/gbp/metrics.server.ts'

function deltaLabel(current: number, previous: number): string | null {
	if (previous <= 0) return current > 0 ? '+100%' : null
	const pct = Math.round(((current - previous) / previous) * 100)
	if (pct === 0) return '0%'
	return pct > 0 ? `+${pct}%` : `${pct}%`
}

function MetricCell({
	label,
	current,
	previous,
}: {
	label: React.ReactNode
	current: number
	previous: number
}) {
	const delta = deltaLabel(current, previous)
	const positive = current >= previous
	return (
		<div className="rounded-md border p-2.5">
			<p className="text-muted-foreground text-xs">{label}</p>
			<div className="mt-0.5 flex items-baseline justify-between gap-1">
				<span className="text-base font-semibold tabular-nums">
					{current.toLocaleString()}
				</span>
				{delta ? (
					<span
						className={`text-xs tabular-nums ${
							positive ? 'text-emerald-600' : 'text-amber-600'
						}`}
					>
						{delta}
					</span>
				) : null}
			</div>
		</div>
	)
}

export function GooglePerformanceBlock({
	orgSlug,
	locations,
}: {
	orgSlug: string
	locations: readonly LocationPerformance[]
}) {
	return (
		<Card
			className="h-full overflow-auto"
			data-testid="google-performance-block"
		>
			<CardContent className="flex flex-col gap-4">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<div>
						<h3 className="text-sm font-semibold">
							<Trans>Google listing performance</Trans>
						</h3>
						<p className="text-muted-foreground text-xs">
							<Trans>Last 28 days compared with the 28 days before.</Trans>
						</p>
					</div>
					<Button
						variant="ghost"
						size="sm"
						render={<Link to={`/${orgSlug}/reports`} />}
					>
						<Trans>Open reports</Trans>
						<Icon name="arrow-right" className="size-3.5" />
					</Button>
				</div>

				{locations.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						<Trans>No locations available.</Trans>
					</p>
				) : (
					<div className="flex flex-col gap-4">
						{locations.map((loc) => {
							const comp = loc.comparison
							const currentViews = comp
								? comp.current.searchViews + comp.current.mapsViews
								: 0
							const previousViews = comp
								? comp.previous.searchViews + comp.previous.mapsViews
								: 0
							const maxTrend = comp
								? Math.max(1, ...comp.trend.map((t) => t.views))
								: 1

							return (
								<div
									key={loc.locationId}
									className="flex flex-col gap-2.5 rounded-lg border p-3"
								>
									<div className="flex flex-wrap items-center justify-between gap-2">
										<Link
											to={`/${orgSlug}/settings/locations/${loc.locationId}?tab=google`}
											className="text-sm font-medium hover:underline"
										>
											{loc.locationName}
										</Link>
										{loc.state === 'ok' && comp?.dataUntil ? (
											<span className="text-muted-foreground text-xs">
												<Trans>Data until {comp.dataUntil}</Trans>
											</span>
										) : loc.state === 'not_verified' ? (
											<Badge variant="outline">
												<Trans>Unverified</Trans>
											</Badge>
										) : loc.state === 'not_connected' ? (
											<Badge variant="secondary">
												<Trans>Not connected</Trans>
											</Badge>
										) : null}
									</div>

									{loc.state === 'not_verified' ? (
										<p className="text-muted-foreground text-xs">
											<Trans>No data until your profile is verified</Trans>
										</p>
									) : loc.state === 'not_connected' ? (
										<p className="text-muted-foreground text-xs">
											<Trans>
												Connect this location to Google Business Profile to
												track views, calls, and clicks.
											</Trans>
										</p>
									) : loc.state === 'no_data' || !comp ? (
										<p className="text-muted-foreground text-xs">
											<Trans>
												Google performance metrics will appear after the next
												daily sync.
											</Trans>
										</p>
									) : (
										<>
											<div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
												<MetricCell
													label={<Trans>Views</Trans>}
													current={currentViews}
													previous={previousViews}
												/>
												<MetricCell
													label={<Trans>Calls</Trans>}
													current={comp.current.calls}
													previous={comp.previous.calls}
												/>
												<MetricCell
													label={<Trans>Directions</Trans>}
													current={comp.current.directions}
													previous={comp.previous.directions}
												/>
												<MetricCell
													label={<Trans>Website clicks</Trans>}
													current={comp.current.websiteClicks}
													previous={comp.previous.websiteClicks}
												/>
												<MetricCell
													label={<Trans>Order clicks</Trans>}
													current={comp.current.orderClicks}
													previous={comp.previous.orderClicks}
												/>
												<MetricCell
													label={<Trans>Bookings</Trans>}
													current={comp.current.bookingClicks}
													previous={comp.previous.bookingClicks}
												/>
											</div>
											{comp.trend.length > 1 ? (
												<div
													className="flex h-10 items-end gap-0.5 pt-1"
													aria-label="Daily views trend"
												>
													{comp.trend.map((pt) => (
														<div
															key={pt.date}
															title={`${pt.date}: ${pt.views}`}
															className="bg-primary/70 flex-1 rounded-t-xs"
															style={{
																height: `${Math.max(8, Math.round((pt.views / maxTrend) * 100))}%`,
															}}
														/>
													))}
												</div>
											) : null}
										</>
									)}
								</div>
							)
						})}
					</div>
				)}
			</CardContent>
		</Card>
	)
}
