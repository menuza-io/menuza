import { Plural, Trans, useLingui } from '@lingui/react/macro'
import {
	type AttentionItem,
	todaySchema,
	type Today,
	wasteSummarySchema,
} from '@repo/inventory'
import { Alert, AlertAction, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Skeleton } from '@repo/ui/skeleton'
import {
	WorkspaceMetric,
	WorkspaceMetricGrid,
	WorkspacePanel,
} from '@repo/ui/workspace'
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react'
import { Link, useLocation } from 'react-router'
import { EmptyState } from '#app/components/empty-state.tsx'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { InventoryHeaderActions } from '#app/components/inventory/inventory-chrome.tsx'
import {
	useInventoryRevision,
	useQuantityFormat,
} from '#app/components/inventory/inventory-prefs.tsx'
import { InventorySetupChecklist } from '#app/components/inventory/setup-checklist.tsx'
import { WasteBars } from '#app/components/inventory/waste-bars.tsx'
import { useInventoryQuery } from '#app/hooks/use-inventory-client.ts'
import { requireInventoryAccess } from '#app/utils/inventory/access.server.ts'
import { summarizeFoodCost } from '#app/utils/inventory/count-review.ts'
import { formatMoney } from '#app/utils/inventory/format.ts'
import { inventoryErrorMessage } from '#app/utils/inventory/inventory-errors.ts'
import { WASTE_REASON_LABELS } from '#app/utils/inventory/labels.ts'
import { deriveInventorySetupSteps } from '#app/utils/inventory/setup-progress.ts'
import {
	attentionTarget,
	daysSince,
	localDate,
	percentFromBp,
} from '#app/utils/inventory/today-view.ts'
import { resolveWasteRange } from '#app/utils/inventory/waste-range.ts'
import { type Route } from './+types/today.ts'
import { useInventoryLayoutData } from './_layout.tsx'

export async function loader({ request, params }: Route.LoaderArgs) {
	await requireInventoryAccess(request, params.orgSlug)
	return null
}

function dismissKey(orgSlug: string, locationId: string) {
	return `inventory-setup-dismissed:${orgSlug}:${locationId}`
}

/** Per-viewer convenience only; a blocked storage just keeps the line. */
function useSetupDismissed(orgSlug: string, locationId: string) {
	const [dismissed, setDismissed] = useState(false)
	useEffect(() => {
		try {
			setDismissed(
				window.localStorage.getItem(dismissKey(orgSlug, locationId)) === '1',
			)
		} catch {
			setDismissed(false)
		}
	}, [orgSlug, locationId])
	const dismiss = useCallback(() => {
		setDismissed(true)
		try {
			window.localStorage.setItem(dismissKey(orgSlug, locationId), '1')
		} catch {
			// Storage unavailable: dismissed for this visit only.
		}
	}, [orgSlug, locationId])
	return [dismissed, dismiss] as const
}

export default function InventoryTodayRoute() {
	const { t, i18n } = useLingui()
	const {
		orgSlug,
		locations,
		activeLocationId,
		canEdit,
		canSeeCost,
		currency,
	} = useInventoryLayoutData()
	const { search } = useLocation()
	const linkSearch = locations.length > 1 ? search : ''
	const today = useInventoryQuery(
		`/today?locationId=${encodeURIComponent(activeLocationId)}`,
		todaySchema,
	)
	// The week's waste by reason is a second, quieter request: the page does
	// not wait for it, and its failure only hides the chart.
	const [now, setNow] = useState<Date | null>(null)
	useEffect(() => setNow(new Date()), [])
	const range = useMemo(
		() => (now ? resolveWasteRange(new URLSearchParams(), now) : null),
		[now],
	)
	const summary = useInventoryQuery(
		range
			? `/waste/summary?${new URLSearchParams({ locationId: activeLocationId, from: range.from, to: range.to })}`
			: null,
		wasteSummarySchema,
	)
	const { reload: reloadToday } = today
	const { reload: reloadSummary } = summary
	const revision = useInventoryRevision()
	const seenRevision = useRef(revision)
	useEffect(() => {
		if (revision !== seenRevision.current) {
			seenRevision.current = revision
			reloadToday()
			reloadSummary()
		}
	}, [revision, reloadToday, reloadSummary])

	const [dismissed, dismiss] = useSetupDismissed(orgSlug, activeLocationId)

	if (today.loading && !today.data) {
		return (
			<div
				role="status"
				className="flex flex-col gap-3"
				data-testid="inventory-today-loading"
			>
				<span className="sr-only">
					<Trans>Loading your inventory</Trans>
				</span>
				<Skeleton className="h-6 w-1/3" />
				<Skeleton className="h-24 w-full rounded-xl" />
				<Skeleton className="h-40 w-full rounded-xl" />
			</div>
		)
	}

	if (today.error && !today.data) {
		return (
			<Alert variant="destructive" data-testid="inventory-today-error">
				<AlertDescription>
					{i18n._(inventoryErrorMessage(today.error))}
				</AlertDescription>
				<AlertAction>
					<Button variant="outline" onClick={today.reload}>
						<Trans>Try again</Trans>
					</Button>
				</AlertAction>
			</Alert>
		)
	}

	const data = today.data!
	const steps = deriveInventorySetupSteps(data.setup)
	const setupDone = steps.every((step) => step.status === 'done')
	const hasItems = data.setup.items > 0
	const nowMs = now?.getTime() ?? null
	const attentionCount = data.attention.length

	return (
		<div
			className={
				today.refreshing
					? 'flex flex-col gap-6 opacity-70 transition-opacity'
					: 'flex flex-col gap-6'
			}
			aria-busy={today.refreshing}
			data-testid="inventory-today"
		>
			{canEdit ? (
				<InventoryHeaderActions>
					<Button
						render={
							<Link
								to={`/${orgSlug}/inventory/counts${linkSearch ? `${linkSearch}&start=1` : '?start=1'}`}
							/>
						}
						data-testid="today-start-count"
					>
						<Icon name="plus" />
						<Trans>Start count</Trans>
					</Button>
					{canSeeCost ? (
						<Button
							variant="outline"
							render={
								<Link
									to={`/${orgSlug}/inventory/purchasing/deliveries/new${linkSearch}`}
								/>
							}
							data-testid="today-record-delivery"
						>
							<Trans>Record delivery</Trans>
						</Button>
					) : null}
				</InventoryHeaderActions>
			) : null}

			<InventorySetupChecklist
				steps={steps}
				orgSlug={orgSlug}
				search={linkSearch}
				dismissed={dismissed}
				onDismiss={dismiss}
			/>

			{hasItems ? (
				<TodayMetrics
					data={data}
					canSeeCost={canSeeCost}
					currency={currency}
					nowMs={nowMs}
				/>
			) : null}

			{hasItems || setupDone ? (
				<div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
					<WorkspacePanel
						title={
							data.attention.length > 0 ? (
								<Trans>Needs attention ({attentionCount})</Trans>
							) : (
								<Trans>Needs attention</Trans>
							)
						}
					>
						{data.attention.length === 0 ? (
							<EmptyState
								icons={['check-circle']}
								title={<Trans>Nothing needs you right now</Trans>}
								description={
									<Trans>
										Items running low, counts that are due and deliveries to pay
										will show here.
									</Trans>
								}
							/>
						) : (
							<ul
								className="flex flex-col divide-y rounded-xl border"
								data-testid="today-attention"
							>
								{data.attention.map((item, index) => (
									<AttentionRow
										key={`${item.kind}-${index}`}
										item={item}
										href={
											attentionTarget(item, {
												orgSlug,
												search: linkSearch,
												canEdit,
											}).to
										}
										canEdit={canEdit}
										canSeeCost={canSeeCost}
										currency={currency}
										today={data.date}
									/>
								))}
							</ul>
						)}
					</WorkspacePanel>

					<div className="flex flex-col gap-6">
						<WorkspacePanel title={<Trans>This week</Trans>}>
							<WeekList week={data.week} />
						</WorkspacePanel>
						<WorkspacePanel title={<Trans>Waste by reason</Trans>}>
							{summary.data && summary.data.byReason.length > 0 ? (
								<WasteBars
									rows={summary.data.byReason.map((row) => ({
										key: row.reason,
										label: i18n._(WASTE_REASON_LABELS[row.reason]),
										count: row.count,
										valueMinor: row.valueMinor,
									}))}
									currency={summary.data.currency ?? currency}
									testId="today-waste-chart"
								/>
							) : summary.data ? (
								<p
									className="text-muted-foreground text-sm"
									data-testid="today-waste-empty"
								>
									{t`Nothing was thrown away in the last 7 days.`}
								</p>
							) : summary.error ? null : (
								<Skeleton className="h-24 w-full rounded-xl" />
							)}
						</WorkspacePanel>
					</div>
				</div>
			) : null}
		</div>
	)
}

function TodayMetrics({
	data,
	canSeeCost,
	currency,
	nowMs,
}: {
	data: Today
	canSeeCost: boolean
	currency: string
	nowMs: number | null
}) {
	const { i18n } = useLingui()
	const { metrics } = data
	const money = (minor: number) =>
		formatMoney(minor, metrics.currency ?? currency, i18n.locale)
	const percent = (bp: number) =>
		new Intl.NumberFormat(i18n.locale, {
			style: 'percent',
			maximumFractionDigits: 1,
		}).format(bp / 10_000)
	const toOrder = metrics.lowItems + metrics.outItems
	const lastCount = (() => {
		if (metrics.lastCountAt === null) {
			return <Trans>No count yet</Trans>
		}
		const days = nowMs === null ? 0 : daysSince(metrics.lastCountAt, nowMs)
		return days === 0 ? (
			<Trans>Last count today</Trans>
		) : (
			<Plural
				value={days}
				one="Last count # day ago"
				other="Last count # days ago"
			/>
		)
	})()

	const withMoney = canSeeCost && metrics.stockValueMinor !== undefined

	if (!withMoney) {
		return (
			<WorkspaceMetricGrid>
				<WorkspaceMetric
					label={<Trans>Items low</Trans>}
					value={<bdi dir="ltr">{metrics.lowItems}</bdi>}
					tone={metrics.lowItems > 0 ? 'warning' : 'default'}
					hint={<Trans>Below the amount you order at</Trans>}
				/>
				<WorkspaceMetric
					label={<Trans>Out of stock</Trans>}
					value={<bdi dir="ltr">{metrics.outItems}</bdi>}
					tone={metrics.outItems > 0 ? 'danger' : 'default'}
				/>
				<WorkspaceMetric
					label={<Trans>Times wasted this week</Trans>}
					value={<bdi dir="ltr">{metrics.wasteWeekCount}</bdi>}
				/>
				<WorkspaceMetric
					label={<Trans>Last count</Trans>}
					value={
						metrics.lastCountAt === null ? (
							<span className="text-muted-foreground">—</span>
						) : (
							<bdi dir="ltr">
								{new Intl.DateTimeFormat(i18n.locale, {
									dateStyle: 'medium',
								}).format(new Date(metrics.lastCountAt))}
							</bdi>
						)
					}
					hint={lastCount}
				/>
			</WorkspaceMetricGrid>
		)
	}

	const food = summarizeFoodCost(metrics.foodCost)
	const targetText = food?.kind === 'ready' ? percent(food.targetBp) : ''
	const shareText =
		metrics.wasteWeekShareBp === null || metrics.wasteWeekShareBp === undefined
			? ''
			: percent(metrics.wasteWeekShareBp)
	const outCount = metrics.outItems
	return (
		<WorkspaceMetricGrid>
			<WorkspaceMetric
				label={<Trans>Stock value</Trans>}
				value={<bdi dir="ltr">{money(metrics.stockValueMinor ?? 0)}</bdi>}
				hint={lastCount}
			/>
			<WorkspaceMetric
				label={<Trans>Food cost</Trans>}
				value={
					food?.kind === 'ready' ? (
						<bdi dir="ltr">{percent(food.bp)}</bdi>
					) : (
						<span className="text-muted-foreground">—</span>
					)
				}
				tone={food?.kind === 'ready' && food.overTarget ? 'warning' : 'default'}
				hint={
					food?.kind === 'ready' ? (
						<Trans>
							Target <bdi dir="ltr">{targetText}</bdi>
						</Trans>
					) : food?.kind === 'no_sales' ? (
						<Trans>No sales between your last two counts.</Trans>
					) : (
						<Trans>Shows after two approved counts.</Trans>
					)
				}
			/>
			<WorkspaceMetric
				label={<Trans>Waste this week</Trans>}
				value={<bdi dir="ltr">{money(metrics.wasteWeekMinor ?? 0)}</bdi>}
				hint={
					metrics.wasteWeekShareBp !== null &&
					metrics.wasteWeekShareBp !== undefined ? (
						<Trans>
							<bdi dir="ltr">{shareText}</bdi> of what you bought
						</Trans>
					) : (
						<Trans>No deliveries this week to compare with.</Trans>
					)
				}
			/>
			<WorkspaceMetric
				label={<Trans>To order</Trans>}
				value={
					<span dir="ltr">
						<Plural value={toOrder} one="# item" other="# items" />
					</span>
				}
				tone={toOrder > 0 ? 'warning' : 'default'}
				hint={
					<Trans>
						<bdi dir="ltr">{outCount}</bdi> of them out of stock
					</Trans>
				}
			/>
		</WorkspaceMetricGrid>
	)
}

function AttentionRow({
	item,
	href,
	canEdit,
	canSeeCost,
	currency,
	today,
}: {
	item: AttentionItem
	href: string
	canEdit: boolean
	canSeeCost: boolean
	currency: string
	today: string
}) {
	const { i18n } = useLingui()
	const quantity = useQuantityFormat()
	let sentence: ReactNode
	let action: ReactNode
	switch (item.kind) {
		case 'low_stock': {
			const left = quantity.format(item.onHand, {
				baseUnit: item.baseUnit,
				countUnit: item.countUnit,
			})
			const name = item.itemName
			sentence = (
				<>
					{item.status === 'out' ? (
						<Trans>
							<span className="font-medium wrap-anywhere">{name}</span> is out
							of stock.
						</Trans>
					) : (
						<Trans>
							<span className="font-medium wrap-anywhere">{name}</span> is
							running low:{' '}
							<bdi dir="ltr" className="tabular-nums">
								{left}
							</bdi>{' '}
							left.
						</Trans>
					)}
					{item.more > 0 ? (
						<>
							{' '}
							<Plural
								value={item.more}
								one="And # more item is low."
								other="And # more items are low."
							/>
						</>
					) : null}
				</>
			)
			action = <Trans>See low items</Trans>
			break
		}
		case 'count_due': {
			const isToday = item.date === today
			const due = new Intl.DateTimeFormat(i18n.locale, {
				dateStyle: 'medium',
			}).format(localDate(item.date))
			sentence = isToday ? (
				<Trans>A count is due today.</Trans>
			) : (
				<Trans>
					A count was due on <bdi dir="ltr">{due}</bdi>.
				</Trans>
			)
			action = canEdit ? <Trans>Start count</Trans> : <Trans>See counts</Trans>
			break
		}
		case 'count_in_progress': {
			const counted = item.itemsCounted
			const total = item.itemTotal
			sentence = (
				<Trans>
					A count is in progress: <bdi dir="ltr">{counted}</bdi> of{' '}
					<bdi dir="ltr">{total}</bdi> items counted.
				</Trans>
			)
			action = canEdit ? <Trans>Resume</Trans> : <Trans>See count</Trans>
			break
		}
		case 'count_in_review':
			sentence = <Trans>A count is waiting for review.</Trans>
			action = <Trans>Review</Trans>
			break
		case 'price_rise': {
			const name = item.itemName
			const percent = percentFromBp(item.changeBp)
			const supplier = item.supplierName
			sentence = supplier ? (
				<Trans>
					<span className="font-medium wrap-anywhere">{name}</span> went up{' '}
					<bdi dir="ltr">{percent}%</bdi> on the last delivery from{' '}
					<span className="wrap-anywhere">{supplier}</span>.
				</Trans>
			) : (
				<Trans>
					<span className="font-medium wrap-anywhere">{name}</span> went up{' '}
					<bdi dir="ltr">{percent}%</bdi> on the last delivery.
				</Trans>
			)
			action = <Trans>See delivery</Trans>
			break
		}
		case 'unpaid_deliveries': {
			const owed =
				canSeeCost && item.amountMinor !== undefined
					? formatMoney(
							item.amountMinor,
							item.currency ?? currency,
							i18n.locale,
						)
					: null
			sentence = owed ? (
				<>
					<Plural
						value={item.count}
						one="# delivery is unpaid."
						other="# deliveries are unpaid."
					/>{' '}
					<Trans>
						You owe <bdi dir="ltr">{owed}</bdi>.
					</Trans>
				</>
			) : (
				<Plural
					value={item.count}
					one="# delivery is unpaid."
					other="# deliveries are unpaid."
				/>
			)
			action = <Trans>See unpaid</Trans>
			break
		}
	}
	return (
		<li
			className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
			data-testid={`today-attention-${item.kind}`}
		>
			<p className="text-sm text-pretty">{sentence}</p>
			<Button
				variant="outline"
				size="sm"
				className="self-start sm:self-auto"
				render={<Link to={href} />}
				data-testid={`today-attention-link-${item.kind}`}
			>
				{action}
				<Icon name="arrow-right" className="rtl:rotate-180" />
			</Button>
		</li>
	)
}

function WeekList({ week }: { week: Today['week'] }) {
	const { i18n } = useLingui()
	if (week.length === 0) {
		return (
			<p
				className="text-muted-foreground text-sm"
				data-testid="today-week-empty"
			>
				<Trans>Nothing is scheduled for the next seven days.</Trans>
			</p>
		)
	}
	return (
		<ul
			className="flex flex-col divide-y rounded-xl border"
			data-testid="today-week"
		>
			{week.map((entry, index) => {
				const day = new Intl.DateTimeFormat(i18n.locale, {
					weekday: 'short',
					day: 'numeric',
					month: 'short',
				}).format(localDate(entry.date))
				const supplier = entry.supplierName
				return (
					<li
						key={`${entry.date}-${entry.kind}-${index}`}
						className="flex items-baseline gap-3 p-3 text-sm"
					>
						<span className="text-muted-foreground w-24 shrink-0 tabular-nums">
							<bdi dir="ltr">{day}</bdi>
						</span>
						<span className="min-w-0 wrap-anywhere">
							{entry.kind === 'count' ? (
								<Trans>Count</Trans>
							) : supplier ? (
								<Trans>Delivery · {supplier}</Trans>
							) : (
								<Trans>Delivery</Trans>
							)}
						</span>
					</li>
				)
			})}
		</ul>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
