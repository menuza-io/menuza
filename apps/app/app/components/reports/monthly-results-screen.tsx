import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	figureChangePercent,
	keptByOrderingDirect,
	type FigureEntry,
	type FigureId,
	type FigureModule,
	type FigureValue,
} from '@repo/reports'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/card'
import { Icon } from '@repo/ui/icon'
import { PageHeader } from '@repo/ui/page-header'
import { Skeleton } from '@repo/ui/skeleton'
import { WorkspacePage } from '@repo/ui/workspace'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { fetchMonthlyFigures } from '#app/utils/reports/monthly-client.ts'

const FIGURE_MESSAGES = {
	netSales: msg`Net sales`,
	orders: msg`Orders`,
	averageSale: msg`Average sale`,
	tips: msg`Tips`,
	refunds: msg`Refunds`,
	laborCost: msg`Labor cost`,
	laborPercent: msg`Labor cost percent`,
	covers: msg`Covers`,
	newReviews: msg`New reviews`,
	averageRating: msg`Average rating`,
	directSales: msg`Direct sales`,
	directOrders: msg`Direct orders`,
	onlineSales: msg`Direct online sales`,
	newGuestOrders: msg`Orders from new guests`,
	returningGuestOrders: msg`Orders from returning guests`,
	bookings: msg`Table bookings`,
	callsAnswered: msg`Calls answered by the phone agent`,
	callsHandled: msg`Calls handled without staff`,
	attributedSales: msg`Sales from your emails and texts`,
	attributedOrders: msg`Orders from your emails and texts`,
	loyaltyRewards: msg`Loyalty rewards used`,
} satisfies Record<FigureId, ReturnType<typeof msg>>

const SECTIONS: Array<{ title: ReturnType<typeof msg>; ids: FigureId[] }> = [
	{ title: msg`Sales`, ids: ['directSales', 'directOrders'] },
	{ title: msg`Guests`, ids: ['newGuestOrders', 'returningGuestOrders'] },
	{ title: msg`Table bookings`, ids: ['bookings', 'covers'] },
	{ title: msg`Phone agent`, ids: ['callsAnswered', 'callsHandled'] },
	{ title: msg`Marketing`, ids: ['attributedOrders', 'attributedSales'] },
	{ title: msg`Loyalty`, ids: ['loyaltyRewards'] },
	{ title: msg`Reviews`, ids: ['newReviews', 'averageRating'] },
]

const MODULE_MESSAGES: Record<FigureModule, ReturnType<typeof msg>> = {
	staffing_labor: msg`Labor`,
	reservations: msg`Reservations`,
	phone_agent: msg`Phone agent`,
	marketing: msg`Marketing`,
	loyalty: msg`Loyalty`,
}

const MODULE_LINKS: Record<FigureModule, string> = {
	staffing_labor: 'staff',
	reservations: 'reservations',
	phone_agent: 'phone-agent',
	marketing: 'marketing',
	loyalty: 'loyalty',
}

export type MonthlyResultsData = {
	orgSlug: string
	month: string
	previousMonth: string
	nextMonth: string | null
	timeZone: string
	tokenUrl: string
	tenantApiUrl: string
	/** The region figures this viewer may ask for (grants and modules already applied). */
	regionIds: FigureId[]
	/** The control plane's own aggregates (reviews), computed by the App. */
	reviews: FigureValue[]
	off: FigureModule[]
	commissionBp: number
	partialSince: string | null
	canEditRate: boolean
	showKept: boolean
}

function monthTitle(month: string, locale: string) {
	const [y, m] = month.split('-').map(Number) as [number, number]
	return new Intl.DateTimeFormat(locale, {
		month: 'long',
		year: 'numeric',
		timeZone: 'UTC',
	}).format(new Date(Date.UTC(y, m - 1, 1)))
}

/**
 * Reports, Monthly results (#221): one screen per month. Each figure is a report
 * definition run in the region by the member's own reports token, so the page
 * equals the matching reports; a line the member has no grant for is hidden,
 * not zero, and a module that is off is one quiet line (at most two).
 * "Kept by ordering direct" is always an estimate, with the rate shown.
 */
export function MonthlyResultsScreen({ data }: { data: MonthlyResultsData }) {
	const { _, i18n } = useLingui()
	const [state, setState] = useState<
		| { kind: 'loading' }
		| { kind: 'ready'; figures: FigureValue[] }
		| { kind: 'error' }
	>({ kind: 'loading' })
	useEffect(() => {
		const controller = new AbortController()
		setState({ kind: 'loading' })
		const ids = data.regionIds
		if (ids.length === 0) {
			setState({ kind: 'ready', figures: [] })
			return () => controller.abort()
		}
		fetchMonthlyFigures({
			tokenUrl: data.tokenUrl,
			tenantApiUrl: data.tenantApiUrl,
			month: data.month,
			ids,
			timeZone: data.timeZone,
			signal: controller.signal,
		})
			.then((figures) => {
				if (!controller.signal.aborted) setState({ kind: 'ready', figures })
			})
			.catch(() => {
				if (!controller.signal.aborted) setState({ kind: 'error' })
			})
		return () => controller.abort()
	}, [
		data.month,
		data.regionIds,
		data.timeZone,
		data.tenantApiUrl,
		data.tokenUrl,
	])

	const figures =
		state.kind === 'ready' ? [...state.figures, ...data.reviews] : data.reviews
	const byId = new Map(figures.map((f) => [f.id, f]))
	const format = (entry: FigureEntry, f: FigureValue) => {
		if (f.format === 'currency' && entry.currency) {
			// Engine values are major units.
			try {
				return new Intl.NumberFormat(i18n.locale, {
					style: 'currency',
					currency: entry.currency,
				}).format(entry.value)
			} catch {
				return `${entry.value.toFixed(2)} ${entry.currency}`
			}
		}
		if (f.format === 'percent') return `${entry.value.toFixed(1)}%`
		if (f.format === 'rating') return entry.value.toFixed(2)
		return new Intl.NumberFormat(i18n.locale, {
			maximumFractionDigits: 0,
		}).format(entry.value)
	}
	const change = (entry: FigureEntry, f: FigureValue) => {
		const pct = figureChangePercent(entry, f.previous)
		if (pct === null) return null
		const rounded = Math.round(Math.abs(pct) * 10) / 10
		if (rounded === 0) return _(msg`no change`)
		return pct > 0 ? _(msg`up ${rounded}%`) : _(msg`down ${rounded}%`)
	}
	const partialSince = data.partialSince
	const ratePercent = data.commissionBp / 100
	const online = byId.get('onlineSales')
	const kept =
		data.showKept && online
			? keptByOrderingDirect(online.entries, data.commissionBp)
			: null

	return (
		<WorkspacePage>
			<PageHeader
				title={<Trans>Monthly results</Trans>}
				description={
					<Trans>
						What your restaurant did in the month, against the month before.
						Every figure is the same as the matching report for that month.
					</Trans>
				}
				actions={
					<div className="flex flex-wrap items-center gap-2">
						<Button
							variant="outline"
							size="sm"
							render={
								<Link
									to={`/${data.orgSlug}/reports/monthly?month=${data.previousMonth}`}
								/>
							}
							data-testid="monthly-previous"
						>
							<Icon name="chevron-left" />
							<Trans>Earlier month</Trans>
						</Button>
						{data.nextMonth ? (
							<Button
								variant="outline"
								size="sm"
								render={
									<Link
										to={`/${data.orgSlug}/reports/monthly?month=${data.nextMonth}`}
									/>
								}
								data-testid="monthly-next"
							>
								<Trans>Later month</Trans>
								<Icon name="chevron-right" />
							</Button>
						) : null}
					</div>
				}
			/>
			<h2 className="text-lg font-semibold" data-testid="monthly-title">
				{monthTitle(data.month, i18n.locale)}
			</h2>
			{data.partialSince ? (
				<Alert data-testid="monthly-partial">
					<Icon name="info" />
					<AlertDescription>
						<Trans>
							This is your first month, so it covers a partial month: from{' '}
							<bdi>{partialSince}</bdi>.
						</Trans>
					</AlertDescription>
				</Alert>
			) : null}
			{state.kind === 'error' ? (
				<Alert variant="destructive" data-testid="monthly-error">
					<Icon name="alert-triangle" />
					<AlertDescription>
						<Trans>
							The monthly figures could not be loaded. Try again later.
						</Trans>
					</AlertDescription>
				</Alert>
			) : null}
			{state.kind === 'loading' && data.regionIds.length > 0 ? (
				<Skeleton className="h-48 rounded-lg" aria-hidden="true" />
			) : (
				<div
					className="grid gap-4 md:grid-cols-2"
					data-testid="monthly-sections"
				>
					{kept ? (
						<Card className="md:col-span-2" data-testid="monthly-kept">
							<CardHeader>
								<CardTitle className="flex flex-wrap items-center gap-2">
									<Trans>Kept by ordering direct</Trans>
									<Badge variant="outline" data-testid="monthly-kept-estimate">
										<Trans>
											Estimate at <bdi>{ratePercent}</bdi>% commission
										</Trans>
									</Badge>
								</CardTitle>
							</CardHeader>
							<CardContent className="flex flex-col gap-2">
								<div className="text-2xl font-semibold tabular-nums">
									{kept.length === 0
										? '—'
										: kept.map((entry) => (
												<div
													key={entry.currency}
													data-testid={`monthly-kept-${entry.currency}`}
												>
													{format(entry, {
														id: 'onlineSales',
														format: 'currency',
														entries: [],
														previous: [],
													})}
												</div>
											))}
								</div>
								<p className="text-muted-foreground text-sm">
									<Trans>
										Your direct online sales times the delivery-app commission
										rate you set. An estimate of what the same orders would have
										cost on a delivery app, not real money.
									</Trans>
									{data.canEditRate ? (
										<>
											{' '}
											<Link
												to={`/${data.orgSlug}/settings`}
												className="underline underline-offset-4"
											>
												<Trans>Change the rate</Trans>
											</Link>
										</>
									) : null}
								</p>
							</CardContent>
						</Card>
					) : null}
					{SECTIONS.map((section) => {
						const present = section.ids
							.map((id) => byId.get(id))
							.filter((f): f is FigureValue => Boolean(f))
						if (present.length === 0) return null
						return (
							<Card
								key={section.title.id}
								data-testid={`monthly-section-${section.ids[0]}`}
							>
								<CardHeader>
									<CardTitle>{_(section.title)}</CardTitle>
								</CardHeader>
								<CardContent className="flex flex-col gap-3">
									{present.map((f) => (
										<div
											key={f.id}
											className="flex items-baseline justify-between gap-3"
											data-testid={`monthly-figure-${f.id}`}
										>
											<span className="text-sm">
												{_(FIGURE_MESSAGES[f.id as FigureId])}
											</span>
											<span className="text-end tabular-nums">
												{(f.entries.length > 0
													? f.entries
													: [{ currency: null, value: 0 }]
												).map((entry) => (
													<div
														key={entry.currency ?? 'n'}
														data-testid={`monthly-value-${f.id}-${entry.currency ?? 'n'}`}
													>
														<span className="font-medium">
															{format(entry, f)}
														</span>{' '}
														<span className="text-muted-foreground text-xs">
															{change(entry, f)}
														</span>
													</div>
												))}
											</span>
										</div>
									))}
								</CardContent>
							</Card>
						)
					})}
				</div>
			)}
			{data.off.length > 0 ? (
				<ul
					className="text-muted-foreground flex flex-col gap-1 text-sm"
					data-testid="monthly-off"
				>
					{data.off.map((module) => (
						<li key={module}>
							{_(MODULE_MESSAGES[module])}:{' '}
							<Link
								to={`/${data.orgSlug}/${MODULE_LINKS[module]}`}
								className="underline underline-offset-4"
							>
								<Trans>Not switched on yet</Trans>
							</Link>
						</li>
					))}
				</ul>
			) : null}
		</WorkspacePage>
	)
}
