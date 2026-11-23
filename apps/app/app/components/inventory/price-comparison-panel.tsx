import { Trans, useLingui } from '@lingui/react/macro'
import {
	type InventoryBaseUnit,
	type PriceComparisonItem,
	priceComparisonResultSchema,
} from '@repo/inventory'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Frame } from '@repo/ui/frame'
import { Input } from '@repo/ui/input'
import { Skeleton } from '@repo/ui/skeleton'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { useEffect, useMemo, useState } from 'react'
import { EmptyState } from '#app/components/empty-state.tsx'
import { type InventoryChromeLocation } from '#app/components/inventory/inventory-chrome.tsx'
import { useQuantityFormat } from '#app/components/inventory/inventory-prefs.tsx'
import { FilterSelect } from '#app/components/staff/controls.tsx'
import { useInventoryQuery } from '#app/hooks/use-inventory-client.ts'
import { OperatorRequestError } from '#app/hooks/use-operator-client.ts'
import {
	formatCostPerUnit,
	formatMoney,
	thousandthsInUnit,
} from '#app/utils/inventory/format.ts'
import { inventoryErrorMessage } from '#app/utils/inventory/inventory-errors.ts'
import { percentFromBp } from '#app/utils/inventory/today-view.ts'
import { toIsoDate } from '#app/utils/inventory/waste-range.ts'

export type PriceComparisonRange = '30d' | '90d' | '180d' | 'custom'

function daysAgoIso(now: Date, days: number): string {
	return toIsoDate(
		new Date(now.getFullYear(), now.getMonth(), now.getDate() - days),
	)
}

function displayUnitRefFor(baseUnit: InventoryBaseUnit) {
	if (baseUnit === 'piece') return 'piece' as const
	return baseUnit === 'g' ? ('kg' as const) : ('l' as const)
}

function PriceComparisonNoCostNotice() {
	return (
		<Alert data-testid="price-comparison-no-cost">
			<AlertDescription>
				<Trans>
					You need permission to view costs before you can compare prices paid
					across suppliers and locations.
				</Trans>
			</AlertDescription>
		</Alert>
	)
}

/**
 * Compares unit prices paid per item across suppliers and locations, showing
 * the lowest, highest, spread, and potential saving at the lowest price (#508).
 */
export function PriceComparisonPanel({
	locations,
	canSeeCost,
	currency,
}: {
	locations: readonly InventoryChromeLocation[]
	canSeeCost: boolean
	currency: string
}) {
	const { t, i18n } = useLingui()
	const quantity = useQuantityFormat()
	const [now, setNow] = useState<Date | null>(null)
	useEffect(() => setNow(new Date()), [])

	const [range, setRange] = useState<PriceComparisonRange>('90d')
	const [customFrom, setCustomFrom] = useState('')
	const [customTo, setCustomTo] = useState('')

	const resolvedDates = useMemo(() => {
		if (!now) return null
		const today = toIsoDate(now)
		if (range === '30d') {
			return { from: daysAgoIso(now, 29), to: today }
		}
		if (range === '180d') {
			return { from: daysAgoIso(now, 179), to: today }
		}
		if (range === 'custom') {
			const from = customFrom || daysAgoIso(now, 89)
			const to = customTo || today
			return { from, to }
		}
		return { from: daysAgoIso(now, 89), to: today }
	}, [now, range, customFrom, customTo])

	const dateRangeInvalid = Boolean(
		resolvedDates && resolvedDates.from > resolvedDates.to,
	)

	const queryPath =
		canSeeCost && resolvedDates && !dateRangeInvalid
			? `/price-comparison?${new URLSearchParams({
					from: resolvedDates.from,
					to: resolvedDates.to,
				})}`
			: null

	const query = useInventoryQuery(queryPath, priceComparisonResultSchema)

	const locationNames = useMemo(
		() => new Map(locations.map((loc) => [loc.id, loc.name])),
		[locations],
	)

	if (!canSeeCost) {
		return <PriceComparisonNoCostNotice />
	}

	if (
		query.error instanceof OperatorRequestError &&
		query.error.status === 403
	) {
		return <PriceComparisonNoCostNotice />
	}

	const rangeOptions = [
		{ value: '30d', label: t`Last 30 days` },
		{ value: '90d', label: t`Last 90 days` },
		{ value: '180d', label: t`Last 180 days` },
		{ value: 'custom', label: t`Custom dates` },
	]

	function selectRange(next: string) {
		const cast = next as PriceComparisonRange
		setRange(cast)
		if (cast === 'custom' && now) {
			if (!customFrom) setCustomFrom(daysAgoIso(now, 89))
			if (!customTo) setCustomTo(toIsoDate(now))
		}
	}

	const reportCurrency = query.data?.currency ?? currency
	const items = query.data?.items ?? []

	const formatUnitPrice = (
		costMicro: number,
		baseUnit: InventoryBaseUnit,
		code: string,
	) => {
		const unitRef = displayUnitRefFor(baseUnit)
		const perUnit = thousandthsInUnit(unitRef, baseUnit) ?? 1_000
		return formatCostPerUnit(costMicro, perUnit, code, i18n.locale)
	}

	const unitLabelFor = (baseUnit: InventoryBaseUnit) =>
		quantity.unitName(displayUnitRefFor(baseUnit), undefined)

	const placeSupplierLabel = (
		locationId: string,
		supplierName: string | null,
	) => {
		const loc = locationNames.get(locationId) ?? locationId
		return [loc, supplierName ?? t`No supplier`].join(' · ')
	}

	return (
		<div className="flex flex-col gap-4" data-testid="price-comparison-panel">
			<div className="flex flex-wrap items-center gap-2">
				<FilterSelect
					id="price-comparison-range"
					testId="price-comparison-range"
					label={t`Period`}
					options={rangeOptions}
					value={range}
					onValueChange={selectRange}
				/>
				{range === 'custom' ? (
					<div className="flex flex-wrap items-center gap-2">
						<Input
							type="date"
							aria-label={t`Start date`}
							value={customFrom}
							onChange={(event) => setCustomFrom(event.target.value)}
							className="w-auto"
							data-testid="price-comparison-from"
						/>
						<span className="text-muted-foreground text-sm">–</span>
						<Input
							type="date"
							aria-label={t`End date`}
							value={customTo}
							onChange={(event) => setCustomTo(event.target.value)}
							className="w-auto"
							data-testid="price-comparison-to"
						/>
					</div>
				) : null}
			</div>

			{dateRangeInvalid ? (
				<Alert variant="destructive" data-testid="price-comparison-date-error">
					<AlertDescription>
						<Trans>Start date must be on or before end date.</Trans>
					</AlertDescription>
				</Alert>
			) : query.error && !query.data ? (
				<Alert variant="destructive" data-testid="price-comparison-error">
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
			) : !query.data ? (
				<div role="status" className="flex flex-col gap-2">
					<span className="sr-only">
						<Trans>Loading price comparison</Trans>
					</span>
					<Skeleton className="h-16 w-full" />
					<Skeleton className="h-32 w-full" />
				</div>
			) : (
				<>
					<div
						className="bg-card flex flex-col gap-1 rounded-xl border p-4"
						data-testid="price-comparison-summary"
					>
						<span className="text-muted-foreground text-xs">
							<Trans>Potential group saving at lowest price</Trans>
						</span>
						<bdi
							dir="ltr"
							className="text-xl font-semibold tabular-nums"
							data-testid="price-comparison-total-saving"
						>
							{formatMoney(
								query.data.totalSavingMinor,
								reportCurrency,
								i18n.locale,
							)}
						</bdi>
					</div>

					{items.length === 0 ? (
						<EmptyState
							title={<Trans>No priced deliveries in this period</Trans>}
							description={
								<Trans>
									Once priced deliveries are recorded, prices paid by supplier
									and location appear here.
								</Trans>
							}
							icons={['receipt-text', 'shopping-bag', 'list']}
						/>
					) : (
						<Frame className="w-full">
							<Table variant="card" data-testid="price-comparison-table">
								<TableHeader>
									<TableRow>
										<TableHead>
											<Trans>Item</Trans>
										</TableHead>
										<TableHead>
											<Trans>Prices paid</Trans>
										</TableHead>
										<TableHead className="text-end">
											<Trans>Lowest</Trans>
										</TableHead>
										<TableHead className="text-end">
											<Trans>Highest</Trans>
										</TableHead>
										<TableHead className="text-end">
											<Trans>Spread</Trans>
										</TableHead>
										<TableHead className="text-end">
											<Trans>Saving</Trans>
										</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{items.map((item) => (
										<PriceComparisonRow
											key={item.itemId}
											item={item}
											unitLabel={unitLabelFor(item.baseUnit)}
											formatUnitPrice={formatUnitPrice}
											placeSupplierLabel={placeSupplierLabel}
											locale={i18n.locale}
										/>
									))}
								</TableBody>
							</Table>
						</Frame>
					)}
				</>
			)}
		</div>
	)
}

function PriceComparisonRow({
	item,
	unitLabel,
	formatUnitPrice,
	placeSupplierLabel,
	locale,
}: {
	item: PriceComparisonItem
	unitLabel: string
	formatUnitPrice: (
		costMicro: number,
		baseUnit: InventoryBaseUnit,
		currency: string,
	) => string
	placeSupplierLabel: (
		locationId: string,
		supplierName: string | null,
	) => string
	locale: string
}) {
	return (
		<TableRow data-testid={`price-comparison-row-${item.itemId}`}>
			<TableCell className="align-top whitespace-normal">
				<div className="flex flex-col gap-0.5">
					<span className="font-medium wrap-anywhere">{item.itemName}</span>
					<span className="text-muted-foreground text-xs">
						<Trans>
							per <bdi dir="ltr">{unitLabel}</bdi>
						</Trans>
					</span>
				</div>
			</TableCell>
			<TableCell className="align-top whitespace-normal">
				<ul className="flex flex-col gap-1 text-xs">
					{item.entries.map((entry) => {
						const isLowest =
							item.entries.length > 1 &&
							entry.locationId === item.lowestLocationId &&
							entry.supplierId === item.lowestSupplierId
						return (
							<li
								key={`${entry.locationId}-${entry.supplierId ?? 'none'}`}
								className="flex flex-wrap items-center justify-between gap-2"
							>
								<span className="text-muted-foreground wrap-anywhere">
									{placeSupplierLabel(entry.locationId, entry.supplierName)}
								</span>
								<span className="flex items-center gap-1.5 tabular-nums">
									<bdi dir="ltr">
										{formatUnitPrice(
											entry.costMicro,
											item.baseUnit,
											entry.currency,
										)}
									</bdi>
									{isLowest ? (
										<Badge variant="secondary">
											<Trans>Lowest</Trans>
										</Badge>
									) : null}
								</span>
							</li>
						)
					})}
				</ul>
			</TableCell>
			<TableCell className="text-end align-top tabular-nums">
				<div className="flex flex-col items-end gap-0.5">
					<bdi dir="ltr">
						{formatUnitPrice(
							item.lowestCostMicro,
							item.baseUnit,
							item.currency,
						)}
					</bdi>
					<span className="text-muted-foreground text-xs wrap-anywhere">
						{placeSupplierLabel(item.lowestLocationId, item.lowestSupplierName)}
					</span>
				</div>
			</TableCell>
			<TableCell className="text-end align-top tabular-nums">
				<div className="flex flex-col items-end gap-0.5">
					<bdi dir="ltr">
						{formatUnitPrice(
							item.highestCostMicro,
							item.baseUnit,
							item.currency,
						)}
					</bdi>
					<span className="text-muted-foreground text-xs wrap-anywhere">
						{placeSupplierLabel(
							item.highestLocationId,
							item.highestSupplierName,
						)}
					</span>
				</div>
			</TableCell>
			<TableCell className="text-end align-top tabular-nums">
				{item.spreadCostMicro > 0 ? (
					<div className="flex flex-col items-end gap-0.5">
						<bdi dir="ltr">
							{formatUnitPrice(
								item.spreadCostMicro,
								item.baseUnit,
								item.currency,
							)}
						</bdi>
						<span className="text-muted-foreground text-xs">
							<bdi dir="ltr">{percentFromBp(item.spreadBp)}%</bdi>
						</span>
					</div>
				) : (
					<span className="text-muted-foreground">—</span>
				)}
			</TableCell>
			<TableCell className="text-end align-top font-medium tabular-nums">
				<bdi dir="ltr">
					{formatMoney(item.savingMinor, item.currency, locale)}
				</bdi>
			</TableCell>
		</TableRow>
	)
}
