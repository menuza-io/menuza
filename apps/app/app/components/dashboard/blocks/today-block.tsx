import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	type SalesBasis,
	SALES_BASIS_VALUES,
} from '@repo/common/sales-report-facts'
import { Button } from '@repo/ui/button'
import { Card, CardContent } from '@repo/ui/card'
import { Skeleton } from '@repo/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@repo/ui/toggle-group'
import {
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from 'react'
import { ReservationsClientContext } from '#app/components/reservations/reservations-client-provider.tsx'
import { FilterSelect } from '#app/components/staff/controls.tsx'
import {
	ALL_LOCATIONS,
	averageOrderMinor,
	compareSales,
	selectedLocations,
	todayQuery,
	todayTotalsSchema,
	totalOrders,
	type SalesComparison,
	type TodayAccess,
	type TodayTotals,
} from '#app/utils/dashboards/today.ts'
import { formatMoney } from '#app/utils/orders/order-model.ts'
import { fetchBookingsToday } from '#app/utils/reservations/bookings-today-api.ts'
import { useHomeLocation } from '../use-home-location.ts'
import { sharedReservationsPool } from './bookings-today-block.tsx'
import { MissedWhilePausedLine } from './missed-while-paused-line.tsx'

export const TODAY_REFRESH_MS = 60_000

type Figures = {
	totals: TodayTotals | null
	covers: number | null
}

type State =
	{ kind: 'loading' } | { kind: 'ready'; figures: Figures } | { kind: 'error' }

async function fetchTodayTotals(
	urls: { tokenUrl: string; tenantApiUrl: string },
	query: string,
	signal: AbortSignal,
): Promise<TodayTotals> {
	const tokenResponse = await fetch(urls.tokenUrl, { signal })
	const tokenPayload = (await tokenResponse.json().catch(() => ({}))) as {
		token?: unknown
	}
	if (!tokenResponse.ok || typeof tokenPayload.token !== 'string') {
		throw new Error('today_token_failed')
	}
	const response = await fetch(
		`${urls.tenantApiUrl}/analytics/today?${query}`,
		{
			headers: { Authorization: `Bearer ${tokenPayload.token}` },
			signal,
		},
	)
	if (!response.ok) throw new Error('today_failed')
	return todayTotalsSchema.parse(await response.json())
}

/**
 * Today's sales, orders, average order value, guests and covers, for one
 * location or all of them. Figures come straight from the regional
 * tenant-api in the browser (totals only); each location counts its own
 * business day. Refreshed once a minute while the tab is visible.
 */
export function TodayBlock({
	orgSlug,
	access,
	locationStorageKey,
}: {
	orgSlug: string
	access: TodayAccess
	locationStorageKey: string
}) {
	const { _ } = useLingui()
	const [selection, setSelection] = useHomeLocation(locationStorageKey)
	const [salesBasis, setSalesBasis] = useState<SalesBasis>(
		access.reportSalesBasis,
	)
	const [state, setState] = useState<State>({ kind: 'loading' })
	const [attempt, setAttempt] = useState(0)
	const providedPool = useContext(ReservationsClientContext)
	const bookingsClient = useMemo(
		() =>
			access.covers
				? (providedPool ?? sharedReservationsPool(orgSlug)).forScope('book')
				: null,
		[access.covers, providedPool, orgSlug],
	)
	const locations = useMemo(
		() => selectedLocations(access.locations, selection),
		[access.locations, selection],
	)
	const query = useMemo(
		() => todayQuery(locations, salesBasis),
		[locations, salesBasis],
	)
	const coverIds = useMemo(
		() =>
			locations
				.map((location) => location.id)
				.filter((id) => access.coverLocationIds.includes(id)),
		[access.coverLocationIds, locations],
	)

	const { orders, tokenUrl, tenantApiUrl } = access
	useEffect(() => {
		let cancelled = false
		let controller = new AbortController()
		const load = async () => {
			controller.abort()
			controller = new AbortController()
			const signal = controller.signal
			try {
				const [totals, covers] = await Promise.all([
					orders && tenantApiUrl
						? fetchTodayTotals({ tokenUrl, tenantApiUrl }, query, signal)
						: null,
					bookingsClient && coverIds.length > 0
						? Promise.all(
								coverIds.map((id) =>
									fetchBookingsToday(bookingsClient, id, signal),
								),
							).then((rows) =>
								rows.reduce((sum, row) => sum + row.totalCovers, 0),
							)
						: null,
				])
				if (!cancelled && !signal.aborted) {
					setState({ kind: 'ready', figures: { totals, covers } })
				}
			} catch {
				if (!cancelled && !signal.aborted) {
					setState((previous) =>
						previous.kind === 'ready' ? previous : { kind: 'error' },
					)
				}
			}
		}
		void load()
		const timer = window.setInterval(() => {
			if (document.visibilityState === 'hidden') return
			void load()
		}, TODAY_REFRESH_MS)
		const onVisible = () => {
			if (document.visibilityState === 'visible') void load()
		}
		document.addEventListener('visibilitychange', onVisible)
		return () => {
			cancelled = true
			controller.abort()
			window.clearInterval(timer)
			document.removeEventListener('visibilitychange', onVisible)
		}
	}, [orders, tokenUrl, tenantApiUrl, bookingsClient, coverIds, query, attempt])

	const persistSalesBasis = useCallback(
		async (next: SalesBasis) => {
			setSalesBasis(next)
			setState({ kind: 'loading' })
			try {
				await fetch(access.reportSalesBasisUrl, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ orgSlug, basis: next }),
				})
			} catch {
				// The tile still reloads with the chosen basis when the region answers.
			}
		},
		[access.reportSalesBasisUrl, orgSlug],
	)

	const retry = useCallback(() => {
		setState({ kind: 'loading' })
		setAttempt((value) => value + 1)
	}, [])

	return (
		<Card className="h-full overflow-auto" data-testid="today-block">
			<CardContent className="flex flex-col gap-4">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<h3 className="text-sm font-semibold">
						<Trans>Today</Trans>
					</h3>
					<div className="flex flex-wrap items-center gap-2">
						{access.orders ? (
							<ToggleGroup
								value={[salesBasis]}
								onValueChange={(values) => {
									const next = values[0]
									if (
										next &&
										(SALES_BASIS_VALUES as readonly string[]).includes(next)
									) {
										void persistSalesBasis(next as SalesBasis)
									}
								}}
								aria-label={_(msg`Sales basis`)}
								variant="outline"
								size="sm"
							>
								<ToggleGroupItem value="gross" type="button">
									<Trans>Gross</Trans>
								</ToggleGroupItem>
								<ToggleGroupItem value="net" type="button">
									<Trans>Net</Trans>
								</ToggleGroupItem>
							</ToggleGroup>
						) : null}
						{access.locations.length > 1 ? (
							<FilterSelect
								label={_(msg`Location`)}
								options={[
									{ value: ALL_LOCATIONS, label: _(msg`All locations`) },
									...access.locations.map((location) => ({
										value: location.id,
										label: location.name,
									})),
								]}
								value={
									locations.length === 1 && access.locations.length > 1
										? locations[0]!.id
										: ALL_LOCATIONS
								}
								onValueChange={(next) => {
									setState({ kind: 'loading' })
									setSelection(next)
								}}
								testId="today-location"
							/>
						) : null}
					</div>
				</div>
				{state.kind === 'loading' ? (
					<Skeleton className="h-24 rounded-lg" aria-hidden="true" />
				) : state.kind === 'error' ? (
					<div
						className="flex flex-col items-start gap-2"
						role="status"
						data-testid="today-error"
					>
						<p className="text-muted-foreground text-sm">
							<Trans>Couldn't load today's numbers.</Trans>
						</p>
						<Button variant="outline" size="sm" onClick={retry}>
							<Trans>Retry</Trans>
						</Button>
					</div>
				) : (
					<TodayFigures figures={state.figures} access={access} />
				)}
				{access.orders && access.tenantApiUrl ? (
					<MissedWhilePausedLine
						orgSlug={orgSlug}
						tokenUrl={access.tokenUrl}
						tenantApiUrl={access.tenantApiUrl}
						locationIds={locations.map((location) => location.id)}
					/>
				) : null}
			</CardContent>
		</Card>
	)
}

function Comparison({
	label,
	comparison,
}: {
	label: string
	comparison: SalesComparison
}) {
	return (
		<span className="text-muted-foreground text-xs">
			{label}{' '}
			{comparison.kind === 'none' ? (
				<Trans>No sales then</Trans>
			) : (
				<bdi className="tabular-nums">
					{comparison.percent > 0 ? '+' : ''}
					{comparison.percent}%
				</bdi>
			)}
		</span>
	)
}

function Tile({
	label,
	value,
	testId,
	children,
}: {
	label: string
	value: string | number
	testId: string
	children?: ReactNode
}) {
	return (
		<div className="flex flex-col gap-0.5" data-testid={testId}>
			<dt className="text-muted-foreground text-xs">{label}</dt>
			<dd className="text-xl font-semibold tabular-nums">
				<bdi>{value}</bdi>
			</dd>
			{children ? <dd className="flex flex-col">{children}</dd> : null}
		</div>
	)
}

function GuestSplit({
	firstTime,
	returning,
}: {
	firstTime: number
	returning: number
}) {
	return (
		<span className="text-muted-foreground text-xs">
			<Trans>
				<bdi>{firstTime}</bdi> first-time, <bdi>{returning}</bdi> returning
			</Trans>
		</span>
	)
}

function TodayFigures({
	figures,
	access,
}: {
	figures: Figures
	access: TodayAccess
}) {
	const { _, i18n } = useLingui()
	const totals = figures.totals
	return (
		<dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
			{access.orders && totals ? (
				<>
					{totals.today.length === 0 ? (
						<Tile label={_(msg`Sales`)} value={0} testId="today-sales">
							<span className="text-muted-foreground text-xs">
								<Trans>No sales yet today</Trans>
							</span>
						</Tile>
					) : (
						// One tile per currency: amounts in different currencies are
						// never added together.
						totals.today.map((row) => {
							const currency = row.currency
							return (
								<Tile
									key={row.currency}
									label={
										totals.today.length > 1
											? _(msg`Sales (${currency})`)
											: _(msg`Sales`)
									}
									value={formatMoney(row.salesMinor, row.currency, i18n.locale)}
									testId={`today-sales-${row.currency}`}
								>
									<Comparison
										label={_(msg`vs yesterday`)}
										comparison={compareSales(
											row.salesMinor,
											totals.yesterday,
											row.currency,
										)}
									/>
									<Comparison
										label={_(msg`vs last week`)}
										comparison={compareSales(
											row.salesMinor,
											totals.lastWeek,
											row.currency,
										)}
									/>
								</Tile>
							)
						})
					)}
					<Tile
						label={_(msg`Orders`)}
						value={totalOrders(totals.today)}
						testId="today-orders"
					>
						{totals.today.map((row) => {
							const average = averageOrderMinor(row)
							if (average === null) return null
							const averageText = formatMoney(
								average,
								row.currency,
								i18n.locale,
							)
							return (
								<span
									key={row.currency}
									className="text-muted-foreground text-xs"
								>
									<Trans>
										Average <bdi>{averageText}</bdi>
									</Trans>
								</span>
							)
						})}
					</Tile>
					<Tile
						label={_(msg`Guests`)}
						value={totals.guests.total}
						testId="today-guests"
					>
						<GuestSplit
							firstTime={totals.guests.firstTime}
							returning={totals.guests.returning}
						/>
					</Tile>
				</>
			) : null}
			{access.covers && figures.covers !== null ? (
				<Tile
					label={_(msg`Covers booked`)}
					value={figures.covers}
					testId="today-covers"
				/>
			) : null}
		</dl>
	)
}
