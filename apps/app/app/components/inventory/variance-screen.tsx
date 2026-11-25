import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import {
	type VarianceRow,
	varianceMovementsSchema,
	varianceSchema,
} from '@repo/inventory'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Frame } from '@repo/ui/frame'
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
import { Fragment, useState } from 'react'
import { EmptyState } from '#app/components/empty-state.tsx'
import { useQuantityFormat } from '#app/components/inventory/inventory-prefs.tsx'
import { FilterSelect } from '#app/components/staff/controls.tsx'
import { useInventoryQuery } from '#app/hooks/use-inventory-client.ts'
import { formatMoney } from '#app/utils/inventory/format.ts'
import { inventoryErrorMessage } from '#app/utils/inventory/inventory-errors.ts'

/**
 * Expected versus actual use by item between two approved full counts (#509):
 * per item the opening, deliveries, transfers, waste, closing, actual use,
 * expected use (from sales and batches by recipe) and the gap in quantity,
 * money and share of sales, worst first, with a trend of the last periods.
 * Click a row for the movements behind it. An item no recipe uses shows actual
 * use only, marked "No recipe", so its gap cannot mislead. Money needs the
 * cost grant.
 */
export function VarianceScreen({
	locationId,
	canSeeCost,
	currency,
	closingCountId,
	onPeriodChange,
}: {
	locationId: string
	canSeeCost: boolean
	currency: string
	closingCountId: string | null
	onPeriodChange: (closingCountId: string) => void
}) {
	const { t, i18n } = useLingui()
	const query = useInventoryQuery(
		`/variance?${new URLSearchParams({ locationId, ...(closingCountId ? { closingCountId } : {}) })}`,
		varianceSchema,
	)
	const [open, setOpen] = useState<string | null>(null)
	const data = query.data

	const dayText = (iso: string) => {
		const [year, month, day] = iso.split('-').map(Number) as [
			number,
			number,
			number,
		]
		return new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium' }).format(
			new Date(year, month - 1, day),
		)
	}
	const money = (minor: number | undefined, code = currency) =>
		minor === undefined ? '—' : formatMoney(minor, code, i18n.locale)
	const percent = (bp: number | null | undefined) =>
		bp == null
			? '—'
			: new Intl.NumberFormat(i18n.locale, {
					style: 'percent',
					maximumFractionDigits: 1,
				}).format(bp / 10_000)

	if (query.error && !data) {
		return (
			<Alert variant="destructive" data-testid="variance-error">
				<AlertDescription>
					{i18n._(inventoryErrorMessage(query.error))}
				</AlertDescription>
				<Button
					className="mt-2 justify-self-start"
					variant="outline"
					onClick={query.reload}
				>
					<Trans>Try again</Trans>
				</Button>
			</Alert>
		)
	}
	if (!data) return <Skeleton className="h-24 w-full" />
	if (data.state === 'need_two_counts' || !data.period) {
		return (
			<EmptyState
				title={<Trans>Two counts are needed</Trans>}
				description={
					<Trans>
						This report compares what your recipes say you used with what your
						counts say you used. Approve two full counts first.
					</Trans>
				}
				icons={['list', 'chef-hat', 'receipt']}
			/>
		)
	}
	const period = data.period
	const totals = data.totals
	const fromText = dayText(period.from)
	const toText = dayText(period.to)
	const gapPercent = totals ? percent(totals.gapBpOfSales) : ''
	const noRecipeMoney = totals
		? money(totals.noRecipeUseMinor, data.currency)
		: ''
	return (
		<div className="flex flex-col gap-6" data-testid="variance">
			<div className="flex flex-wrap items-center gap-3">
				<FilterSelect
					label={t`Period`}
					options={data.periods.map((entry) => ({
						value: entry.closingCountId,
						label: `${dayText(entry.from)} – ${dayText(entry.to)}`,
					}))}
					value={period.closingCountId}
					onValueChange={onPeriodChange}
					testId="variance-period"
				/>
				<p className="text-muted-foreground text-sm">
					<Trans>
						Between two approved counts, from {fromText} to {toText}.
					</Trans>
				</p>
			</div>

			{canSeeCost && totals ? (
				<div data-testid="variance-totals">
					<WorkspaceMetricGrid>
						<WorkspaceMetric
							label={<Trans>Actual food cost</Trans>}
							value={
								<bdi dir="ltr">{money(totals.actualMinor, data.currency)}</bdi>
							}
							hint={<Trans>Opening plus purchases less closing.</Trans>}
						/>
						<WorkspaceMetric
							label={<Trans>Expected food cost</Trans>}
							value={
								<bdi dir="ltr">
									{money(totals.expectedMinor, data.currency)}
								</bdi>
							}
							hint={<Trans>What recipes say sales and batches used.</Trans>}
						/>
						<WorkspaceMetric
							label={<Trans>Gap</Trans>}
							value={
								<bdi dir="ltr">{money(totals.gapMinor, data.currency)}</bdi>
							}
							hint={
								totals.gapBpOfSales === null ? (
									<Trans>No sales in this period.</Trans>
								) : (
									<Trans>
										<bdi dir="ltr">{gapPercent}</bdi> of sales
									</Trans>
								)
							}
						/>
						<WorkspaceMetric
							label={<Trans>Logged waste</Trans>}
							value={
								<bdi dir="ltr">{money(totals.wasteMinor, data.currency)}</bdi>
							}
							hint={
								totals.noRecipeUseMinor !== 0 ? (
									<Trans>
										Of the actual cost, <bdi dir="ltr">{noRecipeMoney}</bdi> is
										items no recipe uses.
									</Trans>
								) : undefined
							}
						/>
					</WorkspaceMetricGrid>
				</div>
			) : null}

			<WorkspacePanel title={<Trans>By item</Trans>}>
				{data.rows.length === 0 ? (
					<p
						className="text-muted-foreground text-sm"
						data-testid="variance-empty"
					>
						<Trans>Nothing was used between these two counts.</Trans>
					</p>
				) : (
					<Frame className="w-full overflow-x-auto">
						<Table variant="card" data-testid="variance-table">
							<TableHeader>
								<TableRow>
									<TableHead>
										<Trans>Item</Trans>
									</TableHead>
									<TableHead className="text-end">
										<Trans>Opening</Trans>
									</TableHead>
									<TableHead className="text-end">
										<Trans>Delivered</Trans>
									</TableHead>
									<TableHead className="text-end">
										<Trans>Transfers</Trans>
									</TableHead>
									<TableHead className="text-end">
										<Trans>Waste</Trans>
									</TableHead>
									<TableHead className="text-end">
										<Trans>Closing</Trans>
									</TableHead>
									<TableHead className="text-end">
										<Trans>Actual use</Trans>
									</TableHead>
									<TableHead className="text-end">
										<Trans>Expected use</Trans>
									</TableHead>
									<TableHead className="text-end">
										<Trans>Gap</Trans>
									</TableHead>
									{canSeeCost ? (
										<TableHead className="text-end">
											<Trans>Gap in money</Trans>
										</TableHead>
									) : null}
									{canSeeCost ? (
										<TableHead className="text-end">
											<Trans>% of sales</Trans>
										</TableHead>
									) : null}
									<TableHead>
										<Trans>Last periods</Trans>
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{data.rows.map((row) => (
									<VarianceRowView
										key={row.itemId}
										row={row}
										locationId={locationId}
										closingCountId={period.closingCountId}
										canSeeCost={canSeeCost}
										currency={data.currency ?? currency}
										open={open === row.itemId}
										onToggle={() =>
											setOpen((current) =>
												current === row.itemId ? null : row.itemId,
											)
										}
										percent={percent}
									/>
								))}
							</TableBody>
						</Table>
					</Frame>
				)}
			</WorkspacePanel>
		</div>
	)
}

function Sparkline({ values }: { values: readonly (number | null)[] }) {
	const points = values.map((value) => value ?? 0)
	const max = Math.max(1, ...points.map((value) => Math.abs(value)))
	return (
		<svg
			viewBox="0 0 60 16"
			className="h-4 w-14"
			role="img"
			aria-hidden
			data-testid="variance-trend"
		>
			{points.map((value, index) => {
				const height = Math.max(1, (Math.abs(value) / max) * 7)
				const x = (index * 60) / Math.max(1, points.length)
				return (
					<rect
						key={index}
						x={x + 1}
						y={value >= 0 ? 8 - height : 8}
						width={Math.max(2, 60 / Math.max(1, points.length) - 3)}
						height={height}
						className={
							value >= 0 ? 'fill-destructive' : 'fill-muted-foreground'
						}
					/>
				)
			})}
		</svg>
	)
}

function VarianceRowView({
	row,
	locationId,
	closingCountId,
	canSeeCost,
	currency,
	open,
	onToggle,
	percent,
}: {
	row: VarianceRow
	locationId: string
	closingCountId: string
	canSeeCost: boolean
	currency: string
	open: boolean
	onToggle: () => void
	percent: (bp: number | null | undefined) => string
}) {
	const { i18n } = useLingui()
	const quantity = useQuantityFormat()
	const fmt = (amount: number) =>
		quantity.format(amount, {
			baseUnit: row.baseUnit,
			countUnit: row.countUnit,
			units: row.units,
		})
	const money = (minor: number | undefined) =>
		minor === undefined ? '—' : formatMoney(minor, currency, i18n.locale)
	const trend = row.trend.map((point) =>
		canSeeCost && point.gapMinor !== undefined
			? point.gapMinor
			: point.gapQuantity,
	)
	return (
		<Fragment>
			<TableRow
				className="cursor-pointer"
				onClick={onToggle}
				data-testid={`variance-row-${row.itemId}`}
			>
				<TableCell>
					<button
						type="button"
						className="text-start font-medium wrap-anywhere"
						aria-expanded={open}
						onClick={(event) => {
							event.stopPropagation()
							onToggle()
						}}
					>
						{row.name}
					</button>
				</TableCell>
				<TableCell className="text-end tabular-nums">
					<bdi dir="ltr">{fmt(row.opening)}</bdi>
				</TableCell>
				<TableCell className="text-end tabular-nums">
					<bdi dir="ltr">{fmt(row.delivered)}</bdi>
				</TableCell>
				<TableCell className="text-end tabular-nums">
					<bdi dir="ltr">{fmt(row.transfers)}</bdi>
				</TableCell>
				<TableCell className="text-end tabular-nums">
					<bdi dir="ltr">{fmt(row.waste)}</bdi>
				</TableCell>
				<TableCell className="text-end tabular-nums">
					<bdi dir="ltr">{fmt(row.closing)}</bdi>
				</TableCell>
				<TableCell className="text-end tabular-nums">
					<bdi dir="ltr">{fmt(row.actualUse)}</bdi>
				</TableCell>
				<TableCell className="text-end tabular-nums">
					{row.noRecipe ? (
						<Badge
							variant="outline"
							data-testid={`variance-norecipe-${row.itemId}`}
						>
							<Trans>No recipe</Trans>
						</Badge>
					) : (
						<bdi dir="ltr">{fmt(row.expectedUse ?? 0)}</bdi>
					)}
				</TableCell>
				<TableCell className="text-end tabular-nums">
					{row.gapQuantity === null ? (
						<span className="text-muted-foreground">—</span>
					) : (
						<bdi dir="ltr">{fmt(row.gapQuantity)}</bdi>
					)}
				</TableCell>
				{canSeeCost ? (
					<TableCell className="text-end tabular-nums">
						<bdi dir="ltr">{money(row.gapMinor)}</bdi>
					</TableCell>
				) : null}
				{canSeeCost ? (
					<TableCell className="text-end tabular-nums">
						<bdi dir="ltr">{percent(row.gapBpOfSales)}</bdi>
					</TableCell>
				) : null}
				<TableCell>
					<Sparkline values={trend} />
				</TableCell>
			</TableRow>
			{open ? (
				<TableRow>
					<TableCell colSpan={canSeeCost ? 12 : 10}>
						<Movements
							row={row}
							locationId={locationId}
							closingCountId={closingCountId}
							canSeeCost={canSeeCost}
							currency={currency}
						/>
					</TableCell>
				</TableRow>
			) : null}
		</Fragment>
	)
}

const KIND_LABELS = {
	count: msg`Count`,
	delivery: msg`Delivery`,
	sale: msg`Sales`,
	waste: msg`Waste`,
	adjustment: msg`Adjustment`,
	batch_made: msg`Batch made`,
	batch_used: msg`Batch used`,
	transfer_in: msg`Transfer in`,
	transfer_out: msg`Transfer out`,
} as const

function Movements({
	row,
	locationId,
	closingCountId,
	canSeeCost,
	currency,
}: {
	row: VarianceRow
	locationId: string
	closingCountId: string
	canSeeCost: boolean
	currency: string
}) {
	const { i18n } = useLingui()
	const quantity = useQuantityFormat()
	const query = useInventoryQuery(
		`/variance/movements?${new URLSearchParams({ locationId, closingCountId, itemId: row.itemId })}`,
		varianceMovementsSchema,
	)
	if (!query.data) return <Skeleton className="h-10 w-full" />
	return (
		<div
			className="flex flex-col gap-1"
			data-testid={`variance-movements-${row.itemId}`}
		>
			<p className="text-muted-foreground text-xs">
				<Trans>
					What moved this item between the two counts, newest first.
				</Trans>
			</p>
			<ul className="flex flex-col divide-y rounded-md border text-sm">
				{query.data.movements.map((movement) => (
					<li
						key={movement.id}
						className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5"
					>
						<span>
							{movement.kind in KIND_LABELS
								? i18n._(KIND_LABELS[movement.kind as keyof typeof KIND_LABELS])
								: movement.kind}
							<span className="text-muted-foreground">
								{' · '}
								{movement.businessDate}
							</span>
						</span>
						<span className="tabular-nums">
							<bdi dir="ltr">
								{quantity.format(movement.quantity, {
									baseUnit: row.baseUnit,
									countUnit: row.countUnit,
									units: row.units,
								})}
							</bdi>
							{canSeeCost && movement.valueMinor !== undefined ? (
								<span className="text-muted-foreground">
									{' · '}
									<bdi dir="ltr">
										{formatMoney(
											movement.valueMinor,
											movement.currency ?? currency,
											i18n.locale,
										)}
									</bdi>
								</span>
							) : null}
						</span>
					</li>
				))}
			</ul>
			{query.data.truncated ? (
				<p className="text-muted-foreground text-xs">
					<Trans>Only the newest are shown.</Trans>
				</p>
			) : null}
		</div>
	)
}
