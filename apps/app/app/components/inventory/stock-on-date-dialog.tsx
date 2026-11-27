import { Trans, useLingui } from '@lingui/react/macro'
import {
	exportChunkSchema,
	STOCK_DAY_COLUMNS,
	stockDaySchema,
	stockOnDateSchema,
	type StockDayColumn,
	type StockDayRow,
} from '@repo/inventory'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { Skeleton } from '@repo/ui/skeleton'
import { useId, useState } from 'react'
import { ExportProgressPanel } from '#app/components/exports/export-progress-panel.tsx'
import { useChunkedExport } from '#app/components/exports/use-chunked-export.ts'
import { useQuantityFormat } from '#app/components/inventory/inventory-prefs.tsx'
import {
	useInventoryClient,
	useInventoryQuery,
} from '#app/hooks/use-inventory-client.ts'
import { formatMoney } from '#app/utils/inventory/format.ts'
import { inventoryErrorMessage } from '#app/utils/inventory/inventory-errors.ts'

function isoToday(): string {
	const now = new Date()
	const month = String(now.getMonth() + 1).padStart(2, '0')
	const day = String(now.getDate()).padStart(2, '0')
	return `${now.getFullYear()}-${month}-${day}`
}

/** The last day of the month before `date`'s month, or `date` when it is already a month end. */
export function previousMonthEnd(date: string): string {
	const [year, month] = date.split('-').map(Number)
	const end = new Date(Date.UTC(year!, month! - 1, 0))
	return end.toISOString().slice(0, 10)
}

const COLUMN_ORDER: readonly StockDayColumn[] = STOCK_DAY_COLUMNS

/**
 * Stock and stock value on any past business day (#521): on hand and value at
 * the end of the chosen day, rebuilt by the region from the movements; a day
 * view per item (opening, delivered, used, wasted, transfers, adjustments,
 * count corrections, closing) that always balances; and the month-end stock
 * value file. Money needs the cost grant. The business day is the location's own
 * (its time zone and closing time).
 */
export function StockOnDateDialog({
	open,
	onOpenChange,
	locationId,
	canSeeCost,
	currency,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	locationId: string
	canSeeCost: boolean
	currency: string
}) {
	const { t, i18n } = useLingui()
	const dateId = useId()
	const [date, setDate] = useState(() => previousMonthEnd(isoToday()))
	const [dayFor, setDayFor] = useState<string | null>(null)
	const quantity = useQuantityFormat()
	const client = useInventoryClient()
	const chunkedExport = useChunkedExport()
	const valid = /^\d{4}-\d{2}-\d{2}$/.test(date) && date <= isoToday()
	const stock = useInventoryQuery(
		open && valid
			? `/stock/on-date?${new URLSearchParams({ locationId, date })}`
			: null,
		stockOnDateSchema,
	)
	const day = useInventoryQuery(
		open && valid && dayFor
			? `/stock/day?${new URLSearchParams({ locationId, date, itemId: dayFor })}`
			: null,
		stockDaySchema,
	)
	const money = (minor: number | null | undefined, code?: string) =>
		minor === null || minor === undefined
			? '-'
			: formatMoney(minor, code ?? stock.data?.currency ?? currency, i18n.locale)

	const columnLabel: Record<StockDayColumn, string> = {
		opening: t`Opening`,
		delivered: t`Delivered`,
		used: t`Used by sales`,
		wasted: t`Wasted`,
		transfersIn: t`Transfers in`,
		transfersOut: t`Transfers out`,
		adjustments: t`Adjustments`,
		countCorrections: t`Count corrections`,
		made: t`Made in the kitchen`,
		prepUsed: t`Used in prep`,
		closing: t`Closing`,
	}

	function startExport() {
		void chunkedExport.start({
			filename: `stock-value-${date}.csv`,
			fetchChunk: async (cursor) => {
				const body = await client.request(
					`/stock/value-export?${new URLSearchParams({
						locationId,
						date,
						...(cursor ? { cursor } : {}),
					})}`,
				)
				return exportChunkSchema.parse(body)
			},
		})
	}

	const row: StockDayRow | undefined = day.data?.rows[0]
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
				data-testid="stock-on-date"
			>
				<DialogHeader>
					<DialogTitle>
						<Trans>Stock on a date</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							What you had at the end of that business day, rebuilt from every
							movement up to it.
						</Trans>
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-wrap items-end gap-3">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor={dateId}>
							<Trans>End of day</Trans>
						</Label>
						<Input
							id={dateId}
							type="date"
							max={isoToday()}
							value={date}
							onChange={(event) => {
								setDate(event.target.value)
								setDayFor(null)
							}}
							data-testid="stock-date-input"
						/>
					</div>
					{canSeeCost ? (
						<Button
							variant="outline"
							size="sm"
							disabled={!valid || chunkedExport.running}
							onClick={startExport}
							data-testid="stock-value-export"
						>
							<Trans>Export stock value (CSV)</Trans>
						</Button>
					) : null}
				</div>
				<ExportProgressPanel
					state={chunkedExport.state}
					onCancel={chunkedExport.cancel}
					testId="stock-value-export"
				/>
				{!valid ? (
					<Alert>
						<AlertDescription>
							<Trans>Choose a day that has already started.</Trans>
						</AlertDescription>
					</Alert>
				) : stock.loading && !stock.data ? (
					<Skeleton className="h-32 w-full" />
				) : stock.error && !stock.data ? (
					<Alert variant="destructive">
						<AlertDescription>
							{i18n._(inventoryErrorMessage(stock.error))}
						</AlertDescription>
					</Alert>
				) : stock.data ? (
					<div className="flex flex-col gap-3">
						{canSeeCost && stock.data.totalValueMinor !== undefined ? (
							<p className="text-sm" data-testid="stock-date-total">
								<Trans>
									Stock value:{' '}
									<bdi dir="ltr" className="font-medium">
										{money(stock.data.totalValueMinor)}
									</bdi>
								</Trans>
								{stock.data.open ? (
									<span className="text-muted-foreground">
										{' '}
										<Trans>(today, so far)</Trans>
									</span>
								) : null}
								{(stock.data.unpricedItems ?? 0) > 0 ? (
									<span className="text-muted-foreground">
										{' '}
										<Trans>Some items have no cost yet.</Trans>
									</span>
								) : null}
							</p>
						) : null}
						<ul
							className="flex flex-col divide-y rounded-xl border"
							data-testid="stock-date-list"
						>
							{stock.data.items.map((item) => (
								<li
									key={item.itemId}
									className="flex items-center justify-between gap-3 p-3 text-sm"
								>
									<button
										type="button"
										className="min-w-0 text-start font-medium wrap-anywhere underline-offset-2 hover:underline"
										onClick={() =>
											setDayFor((current) =>
												current === item.itemId ? null : item.itemId,
											)
										}
										data-testid={`stock-date-item-${item.itemId}`}
									>
										{item.name}
									</button>
									<span className="flex items-center gap-3 tabular-nums">
										<bdi dir="ltr">
											{quantity.format(item.onHand, {
												baseUnit: item.baseUnit,
												countUnit: item.countUnit,
											})}
										</bdi>
										{canSeeCost ? (
											<bdi dir="ltr" className="text-muted-foreground">
												{money(item.valueMinor)}
											</bdi>
										) : null}
									</span>
								</li>
							))}
							{stock.data.items.length === 0 ? (
								<li className="text-muted-foreground p-3 text-sm">
									<Trans>Nothing was on hand that day.</Trans>
								</li>
							) : null}
						</ul>
						{dayFor ? (
							<div className="flex flex-col gap-2" data-testid="stock-day-view">
								<h3 className="text-sm font-medium">
									<Trans>That day, item by item</Trans>
								</h3>
								{day.loading && !day.data ? (
									<Skeleton className="h-24 w-full" />
								) : row ? (
									<table className="w-full text-sm">
										<tbody>
											{COLUMN_ORDER.map((column) => (
												<tr
													key={column}
													className={
														column === 'closing' || column === 'opening'
															? 'font-medium'
															: undefined
													}
												>
													<th className="py-1 text-start font-normal">
														{columnLabel[column]}
													</th>
													<td className="py-1 text-end tabular-nums">
														<bdi dir="ltr">
															{quantity.format(row.quantity[column]!, {
																baseUnit: row.baseUnit,
																countUnit: row.countUnit,
															})}
														</bdi>
													</td>
													{canSeeCost && row.money ? (
														<td className="text-muted-foreground py-1 text-end tabular-nums">
															<bdi dir="ltr">
																{money(row.money[column])}
															</bdi>
														</td>
													) : null}
												</tr>
											))}
										</tbody>
									</table>
								) : (
									<p className="text-muted-foreground text-sm">
										<Trans>Nothing moved that day.</Trans>
									</p>
								)}
							</div>
						) : null}
					</div>
				) : null}
			</DialogContent>
		</Dialog>
	)
}
