import { Trans, useLingui } from '@lingui/react/macro'
import { isNotCountedLately, type StockItem } from '@repo/inventory'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Frame } from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
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
import { DaysLeftText } from '#app/components/inventory/days-left-text.tsx'
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
	/** Show the Days left column (Stock sorted by it, or always on wide screens). */
	showDaysLeft?: boolean
	/** Stars or unstars an item (a key item is in every quick count). Absent: the star is only shown. */
	onToggleKey?: (item: StockItem) => void
}

/** When an item was last counted at this location, greyed and flagged when over 14 days (#491). */
export function LastCountedText({
	lastCountedAt,
	now = Date.now(),
}: {
	lastCountedAt: number | null
	now?: number
}) {
	const { i18n } = useLingui()
	if (lastCountedAt === null) {
		return (
			<span className="text-warning" data-testid="last-counted-never">
				<Trans>Never counted</Trans>
			</span>
		)
	}
	const stale = isNotCountedLately(lastCountedAt, now)
	return (
		<span
			className={stale ? 'text-warning' : 'text-muted-foreground'}
			data-testid={stale ? 'last-counted-stale' : 'last-counted'}
		>
			<bdi dir="ltr">
				{new Intl.DateTimeFormat(i18n.locale, {
					month: 'short',
					day: 'numeric',
				}).format(new Date(lastCountedAt))}
			</bdi>
		</span>
	)
}

function KeyStar({
	item,
	onToggleKey,
}: {
	item: StockItem
	onToggleKey?: (item: StockItem) => void
}) {
	const { t } = useLingui()
	const on = item.isKey === true
	if (!onToggleKey) {
		return on ? (
			<Icon
				name="star"
				className="text-warning size-4"
				aria-label={t`Key item`}
			/>
		) : null
	}
	return (
		<Button
			type="button"
			variant="ghost"
			size="icon-sm"
			aria-pressed={on}
			aria-label={on ? t`Remove from key items` : t`Mark as a key item`}
			onClick={(event) => {
				event.stopPropagation()
				onToggleKey(item)
			}}
			data-testid={`stock-key-${item.id}`}
		>
			<Icon
				name="star"
				className={on ? 'text-warning' : 'text-muted-foreground'}
			/>
		</Button>
	)
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
	showDaysLeft = true,
	onToggleKey,
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
							<TableHead>
								<Trans>Last counted</Trans>
							</TableHead>
							{showDaysLeft ? (
								<TableHead>
									<Trans>Days left</Trans>
								</TableHead>
							) : null}
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
												<KeyStar item={item} onToggleKey={onToggleKey} />
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
												{item.isGroup ? (
													<Badge
														variant="secondary"
														data-testid={`stock-group-${item.id}`}
													>
														<Trans>Group</Trans>
													</Badge>
												) : null}
												{item.isDraft ? (
													<Badge
														variant="outline"
														data-testid={`stock-draft-${item.id}`}
													>
														<Trans>Draft</Trans>
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
									<TableCell data-testid={`stock-last-counted-${item.id}`}>
										{item.isGroup ? null : (
											<LastCountedText lastCountedAt={item.lastCountedAt} />
										)}
									</TableCell>
									{showDaysLeft ? (
										<TableCell data-testid={`stock-days-left-${item.id}`}>
											<DaysLeftText
												daysLeft={item.daysLeft}
												lastCountedAt={item.lastCountedAt}
											/>
										</TableCell>
									) : null}
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
								<ItemTitle className="flex flex-wrap items-center gap-1.5 wrap-anywhere">
									{item.isKey ? (
										<Icon
											name="star"
											className="text-warning size-3.5"
											aria-label={t`Key item`}
										/>
									) : null}
									<span>{item.name}</span>
									{item.isDraft ? (
										<Badge variant="outline">
											<Trans>Draft</Trans>
										</Badge>
									) : null}
								</ItemTitle>
								<ItemDescription className="truncate">
									{itemSubtitle(item, areaNames, i18n)}
								</ItemDescription>
								{item.isGroup ? null : (
									<span className="text-xs">
										<Trans>
											Last counted{' '}
											<LastCountedText lastCountedAt={item.lastCountedAt} />
										</Trans>
									</span>
								)}
								{showDaysLeft && item.daysLeft ? (
									<span className="text-xs">
										<DaysLeftText
											daysLeft={item.daysLeft}
											lastCountedAt={item.lastCountedAt}
										/>
									</span>
								) : null}
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
