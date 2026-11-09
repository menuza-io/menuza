import { Trans, useLingui } from '@lingui/react/macro'
import {
	listWasteResultSchema,
	type WasteEntry,
	type WasteReason,
	WASTE_REASONS,
	WASTE_UNDO_WINDOW_MS,
	type WasteSummary,
	wasteSummarySchema,
} from '@repo/inventory'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent,
	type ChartConfig,
} from '@repo/ui/chart'
import { Frame } from '@repo/ui/frame'
import { Input } from '@repo/ui/input'
import {
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemGroup,
	ItemTitle,
} from '@repo/ui/item'
import { Skeleton } from '@repo/ui/skeleton'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import {
	WorkspaceMetric,
	WorkspaceMetricGrid,
	WorkspacePanel,
} from '@repo/ui/workspace'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLoaderData, useSearchParams } from 'react-router'
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { toast } from 'sonner'
import { EmptyState } from '#app/components/empty-state.tsx'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import {
	useInventoryRevision,
	useNotifyInventoryChanged,
	useQuantityFormat,
} from '#app/components/inventory/inventory-prefs.tsx'
import { FilterSelect } from '#app/components/staff/controls.tsx'
import {
	useInventoryClient,
	useInventoryQuery,
} from '#app/hooks/use-inventory-client.ts'
import { requireInventoryAccess } from '#app/utils/inventory/access.server.ts'
import { loadMemberNames } from '#app/utils/inventory/actors.server.ts'
import { formatMoney } from '#app/utils/inventory/format.ts'
import {
	inventoryErrorMessage,
	inventorySaveErrorMessage,
} from '#app/utils/inventory/inventory-errors.ts'
import {
	categoryLabel,
	WASTE_REASON_LABELS,
} from '#app/utils/inventory/labels.ts'
import { newClientId } from '#app/utils/inventory/waste-form.ts'
import {
	resolveWasteRange,
	shareOfPurchases,
	WASTE_MAX_LIMIT,
	WASTE_PAGE_SIZE,
	type WasteRange,
	wasteLimit,
	withWasteRange,
} from '#app/utils/inventory/waste-range.ts'
import { type Route } from './+types/waste.ts'
import { useInventoryLayoutData } from './_layout.tsx'

export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireInventoryAccess(request, params.orgSlug)
	return { memberNames: await loadMemberNames(access.organizationId) }
}

const ALL = 'all'

export default function InventoryWasteRoute() {
	const { t, i18n } = useLingui()
	const { memberNames } = useLoaderData<typeof loader>()
	const { activeLocationId, canSeeCost, canEdit, currency } =
		useInventoryLayoutData()
	const { request } = useInventoryClient()
	const quantity = useQuantityFormat()
	const notifyChanged = useNotifyInventoryChanged()
	const [searchParams, setSearchParams] = useSearchParams()

	// The period is the viewer's calendar, so it is worked out after mount.
	const [now, setNow] = useState<Date | null>(null)
	useEffect(() => setNow(new Date()), [])
	const range = useMemo(
		() => (now ? resolveWasteRange(searchParams, now) : null),
		[now, searchParams],
	)
	const reasonParam = searchParams.get('reason')
	const reason: WasteReason | null = (
		WASTE_REASONS as readonly string[]
	).includes(reasonParam ?? '')
		? (reasonParam as WasteReason)
		: null
	const limit = wasteLimit(searchParams)

	const summaryPath = range
		? `/waste/summary?${new URLSearchParams({ locationId: activeLocationId, from: range.from, to: range.to })}`
		: null
	const listPath = range
		? `/waste?${new URLSearchParams({
				locationId: activeLocationId,
				from: range.from,
				to: range.to,
				limit: String(limit),
				...(reason ? { reason } : {}),
			})}`
		: null
	const summary = useInventoryQuery(summaryPath, wasteSummarySchema)
	const log = useInventoryQuery(listPath, listWasteResultSchema)
	const { reload: reloadSummary } = summary
	const { reload: reloadLog } = log

	const revision = useInventoryRevision()
	const seenRevision = useRef(revision)
	useEffect(() => {
		if (revision !== seenRevision.current) {
			seenRevision.current = revision
			reloadSummary()
			reloadLog()
		}
	}, [revision, reloadSummary, reloadLog])

	function patch(update: (next: URLSearchParams) => URLSearchParams) {
		setSearchParams((current) => update(current), { replace: true })
	}

	const rangeOptions = [
		{ value: '7d', label: t`Last 7 days` },
		{ value: '30d', label: t`Last 30 days` },
		{ value: 'month', label: t`This month` },
		{ value: 'custom', label: t`Custom dates` },
	]
	const reasonOptions = [
		{ value: ALL, label: t`All reasons` },
		...WASTE_REASONS.map((value) => ({
			value,
			label: i18n._(WASTE_REASON_LABELS[value]),
		})),
	]

	const entries = log.data?.entries ?? []
	const shown = entries.length
	const hasMore =
		log.data?.nextCursor !== null && log.data?.nextCursor !== undefined

	return (
		<div className="flex flex-col gap-6">
			<div
				role="group"
				aria-label={t`Waste filters`}
				className="flex flex-col gap-2 md:flex-row md:items-center"
			>
				<FilterSelect
					label={t`Period`}
					options={rangeOptions}
					value={range?.range ?? '7d'}
					onValueChange={(next) =>
						patch((current) =>
							withWasteRange(
								current,
								next as WasteRange,
								next === 'custom' && range
									? { from: range.from, to: range.to }
									: undefined,
							),
						)
					}
					testId="waste-filter-range"
				/>
				{range?.range === 'custom' ? (
					<div
						className="flex items-center gap-2"
						data-testid="waste-custom-dates"
					>
						<Input
							type="date"
							aria-label={t`From`}
							value={range.from}
							max={range.to}
							onChange={(event) => {
								const value = event.target.value
								if (value) {
									patch((current) =>
										withWasteRange(current, 'custom', {
											from: value,
											to: range.to,
										}),
									)
								}
							}}
							className="h-11 md:h-8 md:w-40"
						/>
						<span className="text-muted-foreground text-sm">
							<Trans>to</Trans>
						</span>
						<Input
							type="date"
							aria-label={t`To`}
							value={range.to}
							min={range.from}
							onChange={(event) => {
								const value = event.target.value
								if (value) {
									patch((current) =>
										withWasteRange(current, 'custom', {
											from: range.from,
											to: value,
										}),
									)
								}
							}}
							className="h-11 md:h-8 md:w-40"
						/>
					</div>
				) : null}
				<FilterSelect
					label={t`Filter by reason`}
					options={reasonOptions}
					value={reason ?? ALL}
					onValueChange={(next) =>
						patch((current) => {
							const params = new URLSearchParams(current)
							params.delete('limit')
							if (next === ALL) params.delete('reason')
							else params.set('reason', next)
							return params
						})
					}
					testId="waste-filter-reason"
				/>
			</div>
			{range?.invalidCustom ? (
				<Alert data-testid="waste-range-invalid">
					<AlertDescription>
						<Trans>
							Those dates cannot be used. Showing the last 7 days instead.
						</Trans>
					</AlertDescription>
				</Alert>
			) : null}

			{summary.error && !summary.data ? (
				<Alert variant="destructive" data-testid="waste-summary-error">
					<AlertDescription>
						{i18n._(inventoryErrorMessage(summary.error))}
					</AlertDescription>
					<Button
						className="mt-2 justify-self-start"
						variant="outline"
						onClick={reloadSummary}
					>
						<Trans>Try again</Trans>
					</Button>
				</Alert>
			) : summary.data ? (
				<div
					className="flex flex-col gap-6"
					aria-busy={summary.refreshing}
					data-testid="waste-summary"
				>
					<WasteMetrics
						summary={summary.data}
						canSeeCost={canSeeCost}
						currency={currency}
					/>
					{summary.data.count > 0 ? (
						<div className="grid gap-6 lg:grid-cols-2">
							<WorkspacePanel title={<Trans>By reason</Trans>}>
								<WasteBars
									rows={summary.data.byReason.map((row) => ({
										key: row.reason,
										label: i18n._(WASTE_REASON_LABELS[row.reason]),
										count: row.count,
										valueMinor: row.valueMinor,
									}))}
									currency={summary.data.currency ?? currency}
									testId="waste-chart-reason"
								/>
							</WorkspacePanel>
							<WorkspacePanel title={<Trans>By category</Trans>}>
								<WasteBars
									rows={summary.data.byCategory.map((row) => ({
										key: row.category,
										label: categoryLabel(row.category, i18n),
										count: row.count,
										valueMinor: row.valueMinor,
									}))}
									currency={summary.data.currency ?? currency}
									testId="waste-chart-category"
								/>
							</WorkspacePanel>
						</div>
					) : null}
				</div>
			) : (
				<div role="status" className="flex flex-col gap-3">
					<span className="sr-only">
						<Trans>Loading waste</Trans>
					</span>
					<Skeleton className="h-20 w-full rounded-xl" />
				</div>
			)}

			<WorkspacePanel title={<Trans>Waste log</Trans>}>
				{log.error && !log.data ? (
					<Alert variant="destructive" data-testid="waste-log-error">
						<AlertDescription>
							{i18n._(inventoryErrorMessage(log.error))}
						</AlertDescription>
						<Button
							className="mt-2 justify-self-start"
							variant="outline"
							onClick={reloadLog}
						>
							<Trans>Try again</Trans>
						</Button>
					</Alert>
				) : !log.data ? (
					<div role="status" className="flex flex-col gap-2">
						<span className="sr-only">
							<Trans>Loading the waste log</Trans>
						</span>
						<Skeleton className="h-10 w-full" />
						<Skeleton className="h-10 w-full" />
					</div>
				) : entries.length === 0 ? (
					<EmptyState
						title={
							reason ? (
								<Trans>Nothing logged for this reason</Trans>
							) : (
								<Trans>No waste logged</Trans>
							)
						}
						description={
							reason ? (
								<Trans>Try another reason or a longer period.</Trans>
							) : (
								<Trans>
									Nothing was thrown away in this period. Use Log waste when
									something is.
								</Trans>
							)
						}
						icons={['trash-2', 'chef-hat', 'receipt']}
					/>
				) : (
					<div
						className={
							log.refreshing ? 'opacity-70 transition-opacity' : undefined
						}
						aria-busy={log.refreshing}
					>
						<WasteLog
							entries={entries}
							memberNames={memberNames}
							canSeeCost={canSeeCost}
							canUndo={canEdit}
							currency={currency}
							quantityText={(entry) =>
								entry.baseUnit
									? quantity.format(entry.quantity, {
											baseUnit: entry.baseUnit,
										})
									: '—'
							}
							onUndo={async (entry) => {
								try {
									await request(`/waste/${encodeURIComponent(entry.id)}/undo`, {
										method: 'POST',
										body: JSON.stringify({ clientId: newClientId('u') }),
									})
									toast.success(t`Waste undone.`)
									notifyChanged()
								} catch (caught) {
									toast.error(i18n._(inventorySaveErrorMessage(caught)))
								}
							}}
						/>
						<div className="text-muted-foreground mt-3 flex flex-wrap items-center justify-between gap-3 text-sm">
							<span aria-live="polite">
								<Trans>Showing {shown} entries</Trans>
							</span>
							{hasMore && limit < WASTE_MAX_LIMIT ? (
								<Button
									variant="outline"
									onClick={() =>
										patch((current) => {
											const params = new URLSearchParams(current)
											params.set(
												'limit',
												String(
													Math.min(limit + WASTE_PAGE_SIZE, WASTE_MAX_LIMIT),
												),
											)
											return params
										})
									}
									data-testid="waste-show-more"
								>
									<Trans>Show more</Trans>
								</Button>
							) : hasMore ? (
								<span>
									<Trans>
										Choose a shorter period or a reason to narrow the log.
									</Trans>
								</span>
							) : null}
						</div>
					</div>
				)}
			</WorkspacePanel>
		</div>
	)
}

function WasteMetrics({
	summary,
	canSeeCost,
	currency,
}: {
	summary: WasteSummary
	canSeeCost: boolean
	currency: string
}) {
	const { i18n } = useLingui()
	const withMoney = canSeeCost && summary.valueMinor !== undefined
	const topReason = [...summary.byReason].sort((a, b) =>
		withMoney
			? (b.valueMinor ?? 0) - (a.valueMinor ?? 0) || b.count - a.count
			: b.count - a.count,
	)[0]
	const share = shareOfPurchases(summary.valueMinor, summary.purchasesMinor)
	const periodFrom = formatDay(summary.from, i18n.locale)
	const periodTo = formatDay(summary.to, i18n.locale)
	const money = (minor: number) =>
		formatMoney(minor, summary.currency ?? currency, i18n.locale)
	const percent = (value: number) =>
		new Intl.NumberFormat(i18n.locale, {
			style: 'percent',
			maximumFractionDigits: 1,
		}).format(value / 100)

	return (
		<WorkspaceMetricGrid>
			{withMoney ? (
				<WorkspaceMetric
					label={<Trans>Wasted</Trans>}
					value={<bdi dir="ltr">{money(summary.valueMinor ?? 0)}</bdi>}
					hint={
						<Trans>
							From {periodFrom} to {periodTo}
						</Trans>
					}
				/>
			) : null}
			{withMoney ? (
				<WorkspaceMetric
					label={<Trans>Share of what you bought</Trans>}
					value={
						share === null ? (
							<span className="text-muted-foreground">—</span>
						) : (
							<bdi dir="ltr">{percent(share)}</bdi>
						)
					}
					hint={
						share === null ? (
							<Trans>No deliveries in this period.</Trans>
						) : undefined
					}
				/>
			) : null}
			<WorkspaceMetric
				label={<Trans>Times wasted</Trans>}
				value={<bdi dir="ltr">{summary.count}</bdi>}
				hint={
					withMoney ? undefined : (
						<Trans>
							From {periodFrom} to {periodTo}
						</Trans>
					)
				}
			/>
			<WorkspaceMetric
				label={<Trans>Top reason</Trans>}
				value={
					topReason ? (
						<span className="text-base wrap-anywhere">
							{i18n._(WASTE_REASON_LABELS[topReason.reason])}
						</span>
					) : (
						<span className="text-muted-foreground">—</span>
					)
				}
				hint={
					topReason && withMoney && topReason.valueMinor !== undefined ? (
						<bdi dir="ltr">{money(topReason.valueMinor)}</bdi>
					) : undefined
				}
			/>
		</WorkspaceMetricGrid>
	)
}

/** A business date (`YYYY-MM-DD`) as a short local date. */
function formatDay(date: string, locale: string): string {
	const [year, month, day] = date.split('-').map(Number) as [
		number,
		number,
		number,
	]
	return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(
		new Date(year, month - 1, day),
	)
}

type BarRow = {
	key: string
	label: string
	count: number
	valueMinor?: number
}

/** A horizontal bar per row: money when the member may see it, else counts. */
function WasteBars({
	rows,
	currency,
	testId,
}: {
	rows: readonly BarRow[]
	currency: string
	testId: string
}) {
	const { t, i18n } = useLingui()
	const withMoney =
		rows.length > 0 && rows.every((row) => row.valueMinor !== undefined)
	const data = rows
		.map((row) => ({
			key: row.key,
			label: row.label,
			value: withMoney ? (row.valueMinor ?? 0) / 100 : row.count,
		}))
		.sort((a, b) => b.value - a.value)
	const config = {
		value: {
			label: withMoney ? t`Cost` : t`Times`,
			color: 'var(--chart-1)',
		},
	} satisfies ChartConfig
	const height = Math.min(Math.max(data.length * 36 + 24, 96), 400)
	const heightClass =
		height <= 96
			? 'h-24'
			: height <= 160
				? 'h-40'
				: height <= 240
					? 'h-60'
					: height <= 320
						? 'h-80'
						: 'h-96'
	return (
		<ChartContainer
			config={config}
			className={`aspect-auto w-full ${heightClass}`}
			data-testid={testId}
		>
			<BarChart
				accessibilityLayer
				data={data}
				layout="vertical"
				margin={{ left: 8, right: 16 }}
			>
				<CartesianGrid horizontal={false} />
				<YAxis
					dataKey="label"
					type="category"
					tickLine={false}
					axisLine={false}
					width={110}
				/>
				<XAxis type="number" hide />
				<ChartTooltip
					cursor={false}
					content={
						<ChartTooltipContent
							hideLabel
							formatter={(value, _name, item) => (
								<span className="flex w-full items-center justify-between gap-4">
									<span className="text-muted-foreground">
										{(item.payload as { label: string }).label}
									</span>
									<bdi dir="ltr" className="font-medium tabular-nums">
										{withMoney
											? formatMoney(Number(value) * 100, currency, i18n.locale)
											: String(value)}
									</bdi>
								</span>
							)}
						/>
					}
				/>
				<Bar dataKey="value" fill="var(--color-value)" radius={4} />
			</BarChart>
		</ChartContainer>
	)
}

function WasteLog({
	entries,
	memberNames,
	canSeeCost,
	canUndo,
	currency,
	quantityText,
	onUndo,
}: {
	entries: readonly WasteEntry[]
	memberNames: Record<string, string>
	canSeeCost: boolean
	canUndo: boolean
	currency: string
	quantityText: (entry: WasteEntry) => string
	onUndo: (entry: WasteEntry) => Promise<void>
}) {
	const { t, i18n } = useLingui()
	const [undoing, setUndoing] = useState<string | null>(null)
	const [now] = useState(() => Date.now())
	const showCost =
		canSeeCost && entries.some((entry) => entry.valueMinor !== undefined)

	const when = (entry: WasteEntry) =>
		new Intl.DateTimeFormat(i18n.locale, {
			dateStyle: 'medium',
			timeStyle: 'short',
		}).format(new Date(entry.createdAt))
	const who = (entry: WasteEntry) =>
		entry.actor.kind === 'operator' && entry.actor.id
			? (memberNames[entry.actor.id] ?? '')
			: entry.actor.kind === 'staff'
				? t`Staff member`
				: entry.actor.kind === 'system'
					? t`Automatic`
					: ''
	const name = (entry: WasteEntry) => entry.itemName ?? t`Removed item`
	const canUndoEntry = (entry: WasteEntry) =>
		canUndo &&
		entry.undoneAt === null &&
		now - entry.createdAt < WASTE_UNDO_WINDOW_MS

	async function undo(entry: WasteEntry) {
		setUndoing(entry.id)
		try {
			await onUndo(entry)
		} finally {
			setUndoing(null)
		}
	}
	const undoButton = (entry: WasteEntry, testId: string) =>
		canUndoEntry(entry) ? (
			<Button
				type="button"
				variant="ghost"
				size="sm"
				disabled={undoing === entry.id}
				onClick={() => void undo(entry)}
				data-testid={`${testId}-${entry.id}`}
			>
				<Trans>Undo</Trans>
			</Button>
		) : null

	return (
		<>
			<Frame className="hidden w-full md:flex">
				<Table variant="card" data-testid="waste-log">
					<TableHeader>
						<TableRow>
							<TableHead>
								<Trans>When</Trans>
							</TableHead>
							<TableHead>
								<Trans>Item</Trans>
							</TableHead>
							<TableHead>
								<Trans>Amount</Trans>
							</TableHead>
							<TableHead>
								<Trans>Reason</Trans>
							</TableHead>
							<TableHead>
								<Trans>Who</Trans>
							</TableHead>
							{showCost ? (
								<TableHead className="text-end">
									<Trans>Cost</Trans>
								</TableHead>
							) : null}
							<TableHead className="w-20">
								<span className="sr-only">
									<Trans>Actions</Trans>
								</span>
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{entries.map((entry) => (
							<TableRow key={entry.id} data-testid={`waste-row-${entry.id}`}>
								<TableCell className="text-muted-foreground whitespace-nowrap">
									{when(entry)}
								</TableCell>
								<TableCell>
									<div className="flex min-w-0 flex-col">
										<span
											className={
												entry.undoneAt !== null
													? 'text-muted-foreground font-medium wrap-anywhere line-through'
													: 'font-medium wrap-anywhere'
											}
										>
											{name(entry)}
										</span>
										{entry.note ? (
											<span className="text-muted-foreground text-xs wrap-anywhere">
												{entry.note}
											</span>
										) : null}
									</div>
								</TableCell>
								<TableCell className="tabular-nums">
									<bdi dir="ltr">{quantityText(entry)}</bdi>
								</TableCell>
								<TableCell>
									<div className="flex items-center gap-2">
										{i18n._(WASTE_REASON_LABELS[entry.reason])}
										{entry.undoneAt !== null ? (
											<Badge variant="secondary">
												<Trans>Undone</Trans>
											</Badge>
										) : null}
									</div>
								</TableCell>
								<TableCell className="text-muted-foreground wrap-anywhere">
									{who(entry)}
								</TableCell>
								{showCost ? (
									<TableCell className="text-end tabular-nums">
										{entry.valueMinor === undefined ? (
											<span className="text-muted-foreground">—</span>
										) : (
											<bdi dir="ltr">
												{formatMoney(
													entry.valueMinor,
													entry.currency ?? currency,
													i18n.locale,
												)}
											</bdi>
										)}
									</TableCell>
								) : null}
								<TableCell className="text-end">
									{undoButton(entry, 'waste-undo')}
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</Frame>

			<ItemGroup className="md:hidden">
				{entries.map((entry) => (
					<Item key={entry.id} variant="outline">
						<ItemContent>
							<ItemTitle className="wrap-anywhere">{name(entry)}</ItemTitle>
							<ItemDescription>
								{i18n._(WASTE_REASON_LABELS[entry.reason])}
								{' · '}
								{when(entry)}
								{who(entry) ? ` · ${who(entry)}` : ''}
							</ItemDescription>
							{entry.undoneAt !== null ? (
								<Badge variant="secondary" className="self-start">
									<Trans>Undone</Trans>
								</Badge>
							) : null}
						</ItemContent>
						<ItemActions>
							<div className="flex flex-col items-end gap-1">
								<bdi dir="ltr" className="text-sm tabular-nums">
									{quantityText(entry)}
								</bdi>
								{showCost && entry.valueMinor !== undefined ? (
									<bdi
										dir="ltr"
										className="text-muted-foreground text-xs tabular-nums"
									>
										{formatMoney(
											entry.valueMinor,
											entry.currency ?? currency,
											i18n.locale,
										)}
									</bdi>
								) : null}
								{undoButton(entry, 'waste-undo-card')}
							</div>
						</ItemActions>
					</Item>
				))}
			</ItemGroup>
		</>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
