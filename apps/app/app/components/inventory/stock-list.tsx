import { Trans, useLingui } from '@lingui/react/macro'
import { type StockItem } from '@repo/inventory'
import { Badge } from '@repo/ui/badge'
import { Frame } from '@repo/ui/frame'
import {
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemGroup,
	ItemTitle,
} from '@repo/ui/item'
import { Progress } from '@repo/ui/progress'
import { Skeleton } from '@repo/ui/skeleton'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { Link, useNavigate } from 'react-router'
import { useQuantityFormat } from '#app/components/inventory/inventory-prefs.tsx'
import { fillRatio, formatMoney } from '#app/utils/inventory/format.ts'
import { categoryLabel } from '#app/utils/inventory/labels.ts'

type StockListProps = {
	items: readonly StockItem[]
	/** Where an item's sheet lives, for example `/acme/inventory/stock`. */
	basePath: string
	/** The query string to keep on links (filters, location), with its `?`. */
	search: string
	/** Names of the storage areas by id. */
	areaNames: ReadonlyMap<string, string>
	/** Add the Value column. Only true when the member may see cost. */
	showValue: boolean
	currency: string
}

function StatusBadge({ status }: { status: StockItem['status'] }) {
	if (status === 'low') {
		return (
			<Badge variant="warning" data-testid="stock-status-low">
				<Trans context="inventory stock status">Low</Trans>
			</Badge>
		)
	}
	if (status === 'out') {
		return (
			<Badge variant="destructive" data-testid="stock-status-out">
				<Trans context="inventory stock status">Out</Trans>
			</Badge>
		)
	}
	// Nothing for an item that is fine: no "OK" badges.
	return null
}

function itemSubtitle(
	item: StockItem,
	areaNames: ReadonlyMap<string, string>,
	i18n: Parameters<typeof categoryLabel>[1],
): string {
	const areas = item.areaIds
		.map((id) => areaNames.get(id))
		.filter((name): name is string => Boolean(name))
	return [categoryLabel(item.category, i18n), ...areas].join(' · ')
}

/**
 * The item list: a quiet table from `md` up, a stacked list below. A row is a
 * name, how much is on hand (with a bar against "fill up to") and a status
 * that only shows when something needs attention.
 */
export function StockList({
	items,
	basePath,
	search,
	areaNames,
	showValue,
	currency,
}: StockListProps) {
	const { t, i18n } = useLingui()
	const navigate = useNavigate()
	const quantity = useQuantityFormat()
	const hrefFor = (item: StockItem) => `${basePath}/${item.id}${search}`
	const onHandText = (item: StockItem) =>
		quantity.format(item.onHand, {
			baseUnit: item.baseUnit,
			countUnit: item.countUnit,
			units: item.units,
		})

	return (
		<>
			<Frame className="hidden w-full md:flex">
				<Table variant="card">
					<TableHeader>
						<TableRow>
							<TableHead>
								<Trans>Item</Trans>
							</TableHead>
							<TableHead>
								<Trans>On hand</Trans>
							</TableHead>
							{showValue ? (
								<TableHead className="text-end">
									<Trans>Value</Trans>
								</TableHead>
							) : null}
							<TableHead className="w-24">
								<span className="sr-only">
									<Trans>Status</Trans>
								</span>
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{items.map((item) => {
							const ratio = fillRatio(item.onHand, item.fillUpToQuantity)
							return (
								<TableRow
									key={item.id}
									className="cursor-pointer"
									data-testid={`stock-row-${item.id}`}
									onClick={() => void navigate(hrefFor(item))}
								>
									<TableCell>
										<div className="flex min-w-0 flex-col">
											<div className="flex items-center gap-2">
												<Link
													to={hrefFor(item)}
													className="focus-visible:ring-ring/50 truncate rounded-sm font-medium wrap-anywhere outline-none focus-visible:ring-3"
													onClick={(event) => event.stopPropagation()}
												>
													{item.name}
												</Link>
												{item.kind === 'made' ? (
													<Badge variant="secondary">
														<Trans>Made in house</Trans>
													</Badge>
												) : null}
											</div>
											<span className="text-muted-foreground truncate text-xs">
												{itemSubtitle(item, areaNames, i18n)}
											</span>
										</div>
									</TableCell>
									<TableCell>
										<div className="flex items-center gap-3">
											<bdi dir="ltr" className="tabular-nums">
												{onHandText(item)}
											</bdi>
											{ratio !== null ? (
												<Progress
													value={Math.round(ratio * 100)}
													aria-label={t`Compared with fill up to`}
													className="w-20 shrink-0"
												/>
											) : null}
										</div>
									</TableCell>
									{showValue ? (
										<TableCell className="text-end tabular-nums">
											{item.valueMinor === undefined ? (
												<span className="text-muted-foreground">—</span>
											) : (
												<bdi dir="ltr">
													{formatMoney(
														item.valueMinor,
														item.currency ?? currency,
														i18n.locale,
													)}
												</bdi>
											)}
										</TableCell>
									) : null}
									<TableCell>
										<StatusBadge status={item.status} />
									</TableCell>
								</TableRow>
							)
						})}
					</TableBody>
				</Table>
			</Frame>

			<ItemGroup className="md:hidden">
				{items.map((item) => {
					const ratio = fillRatio(item.onHand, item.fillUpToQuantity)
					return (
						<Item
							key={item.id}
							variant="outline"
							render={<Link to={hrefFor(item)} />}
							data-testid={`stock-card-${item.id}`}
						>
							<ItemContent>
								<ItemTitle className="wrap-anywhere">{item.name}</ItemTitle>
								<ItemDescription className="truncate">
									{itemSubtitle(item, areaNames, i18n)}
								</ItemDescription>
								{ratio !== null ? (
									<Progress
										value={Math.round(ratio * 100)}
										aria-label={t`Compared with fill up to`}
										className="w-24"
									/>
								) : null}
							</ItemContent>
							<ItemActions>
								<div className="flex flex-col items-end gap-1">
									<bdi dir="ltr" className="text-sm tabular-nums">
										{onHandText(item)}
									</bdi>
									<StatusBadge status={item.status} />
								</div>
							</ItemActions>
						</Item>
					)
				})}
			</ItemGroup>
		</>
	)
}

export function StockListSkeleton() {
	return (
		<div role="status" aria-live="polite" className="flex flex-col gap-3">
			<span className="sr-only">
				<Trans>Loading items</Trans>
			</span>
			{Array.from({ length: 6 }).map((_, index) => (
				<div key={index} className="flex items-center gap-3 py-1">
					<Skeleton className="h-4 w-40" />
					<Skeleton className="ms-auto h-4 w-20" />
				</div>
			))}
		</div>
	)
}
