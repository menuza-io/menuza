import { Trans, useLingui } from '@lingui/react/macro'
import {
	type ItemDetail,
	itemDetailSchema,
	listMovementsResultSchema,
} from '@repo/inventory'
import { Alert, AlertDescription } from '@repo/ui/alert'
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from '@repo/ui/alert-dialog'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent,
	type ChartConfig,
} from '@repo/ui/chart'
import { Icon } from '@repo/ui/icon'
import { Progress } from '@repo/ui/progress'
import { Skeleton } from '@repo/ui/skeleton'
import { useState } from 'react'
import { Link, useLoaderData, useParams } from 'react-router'
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts'
import { toast } from 'sonner'
import { AdjustStockDialog } from '#app/components/inventory/adjust-stock-dialog.tsx'
import {
	useNotifyInventoryChanged,
	useQuantityFormat,
} from '#app/components/inventory/inventory-prefs.tsx'
import { ItemRecipeSections } from '#app/components/inventory/item-recipe-sections.tsx'
import { useStockContext } from '#app/components/inventory/stock-context.ts'
import { SheetPanel } from '#app/components/staff/sheet-frame.tsx'
import {
	useInventoryClient,
	useInventoryQuery,
} from '#app/hooks/use-inventory-client.ts'
import { requireInventoryAccess } from '#app/utils/inventory/access.server.ts'
import { loadMemberNames } from '#app/utils/inventory/actors.server.ts'
import {
	fillRatio,
	formatCostPerUnit,
	formatMoney,
	thousandthsInUnit,
} from '#app/utils/inventory/format.ts'
import {
	inventoryErrorMessage,
	inventorySaveErrorMessage,
} from '#app/utils/inventory/inventory-errors.ts'
import {
	categoryLabel,
	MOVEMENT_KIND_LABELS,
	ADJUSTMENT_REASON_LABELS,
	WASTE_REASON_LABELS,
} from '#app/utils/inventory/labels.ts'
import { currencyExponent } from '#app/utils/money-input.ts'
import { type Route } from './+types/stock.$itemId.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireInventoryAccess(request, params.orgSlug)
	return { memberNames: await loadMemberNames(access.organizationId) }
}

const MOVEMENT_PAGE = 10

function formatDateTime(timestamp: number, locale: string): string {
	return new Intl.DateTimeFormat(locale, {
		dateStyle: 'medium',
		timeStyle: 'short',
	}).format(new Date(timestamp))
}

export default function InventoryItemSheetRoute() {
	const { i18n } = useLingui()
	const { itemId = '' } = useParams()
	const ctx = useStockContext()
	const { activeLocationId, canEdit, canSeeCost, locations } = ctx
	const [movementLimit, setMovementLimit] = useState(MOVEMENT_PAGE)

	const detail = useInventoryQuery(
		`/items/${encodeURIComponent(itemId)}?locationId=${encodeURIComponent(activeLocationId)}`,
		itemDetailSchema,
	)
	const movements = useInventoryQuery(
		`/items/${encodeURIComponent(itemId)}/movements?locationId=${encodeURIComponent(activeLocationId)}&limit=${movementLimit}`,
		listMovementsResultSchema,
	)
	const { reload: reloadDetail } = detail
	const { reload: reloadMovements } = movements
	const reloadAll = () => {
		reloadDetail()
		reloadMovements()
		ctx.reload()
	}

	if (detail.loading && !detail.data) {
		return (
			<SheetPanel title={<Trans>Item</Trans>}>
				<div role="status" className="flex flex-col gap-3">
					<span className="sr-only">
						<Trans>Loading item</Trans>
					</span>
					<Skeleton className="h-6 w-1/2" />
					<Skeleton className="h-24 w-full" />
					<Skeleton className="h-24 w-full" />
				</div>
			</SheetPanel>
		)
	}
	if (!detail.data) {
		return (
			<SheetPanel title={<Trans>Item</Trans>}>
				<Alert variant="destructive" data-testid="item-sheet-error">
					<AlertDescription>
						{i18n._(inventoryErrorMessage(detail.error))}
					</AlertDescription>
					<Button
						className="mt-2 justify-self-start"
						variant="outline"
						onClick={reloadDetail}
					>
						<Trans>Try again</Trans>
					</Button>
				</Alert>
			</SheetPanel>
		)
	}

	return (
		<ItemSheetBody
			item={detail.data}
			canEdit={canEdit && !detail.data.archived}
			canSeeCost={canSeeCost}
			locationName={
				locations.find((loc) => loc.id === activeLocationId)?.name ?? ''
			}
			locationNames={new Map(locations.map((loc) => [loc.id, loc.name]))}
			movements={movements}
			onShowMoreMovements={() =>
				setMovementLimit((value) => value + MOVEMENT_PAGE)
			}
			movementLimit={movementLimit}
			onChanged={reloadAll}
			editHref={`${ctx.basePath}/${itemId}/edit${ctx.search}`}
			close={ctx.close}
			locationId={activeLocationId}
			currency={ctx.currency}
			recipesEnabled={ctx.nav.recipes}
			canEditRecipes={ctx.nav.editRecipes}
		/>
	)
}

type MovementsQuery = ReturnType<
	typeof useInventoryQuery<typeof listMovementsResultSchema>
>

function ItemSheetBody({
	item,
	canEdit,
	canSeeCost,
	locationName,
	locationNames,
	movements,
	onShowMoreMovements,
	movementLimit,
	onChanged,
	editHref,
	close,
	locationId,
	currency,
	recipesEnabled,
	canEditRecipes,
}: {
	item: ItemDetail
	canEdit: boolean
	canSeeCost: boolean
	locationName: string
	locationNames: ReadonlyMap<string, string>
	movements: MovementsQuery
	onShowMoreMovements: () => void
	movementLimit: number
	onChanged: () => void
	editHref: string
	close: () => void
	locationId: string
	currency: string
	recipesEnabled: boolean
	canEditRecipes: boolean
}) {
	const { t, i18n } = useLingui()
	const { memberNames } = useLoaderData<typeof loader>()
	const { request } = useInventoryClient()
	const quantity = useQuantityFormat()
	const notifyChanged = useNotifyInventoryChanged()
	const itemName = item.name
	const [adjusting, setAdjusting] = useState(false)
	const [archiving, setArchiving] = useState(false)
	const [archivePending, setArchivePending] = useState(false)
	const [archiveError, setArchiveError] = useState<string | null>(null)

	const fmt = (value: number) =>
		quantity.format(value, {
			baseUnit: item.baseUnit,
			countUnit: item.countUnit,
			units: item.units,
		})
	const countPerUnit = thousandthsInUnit(
		item.countUnit ??
			(item.baseUnit === 'piece'
				? 'piece'
				: item.baseUnit === 'g'
					? 'kg'
					: 'l'),
		item.baseUnit,
		item.units,
	)
	const ratio = fillRatio(item.onHand, item.fillUpToQuantity)

	async function archive() {
		setArchivePending(true)
		setArchiveError(null)
		try {
			await request(`/items/${encodeURIComponent(item.id)}/archive`, {
				method: 'POST',
				body: JSON.stringify({ expectedVersion: item.version }),
			})
			toast.success(t`${itemName} archived.`)
			notifyChanged()
			setArchiving(false)
			onChanged()
			close()
		} catch (caught) {
			setArchiveError(i18n._(inventorySaveErrorMessage(caught)))
		} finally {
			setArchivePending(false)
		}
	}

	const chart = item.cost
		? item.cost.history.map((point) => ({
				label: new Intl.DateTimeFormat(i18n.locale, {
					month: 'short',
					day: 'numeric',
				}).format(new Date(point.at)),
				cost:
					countPerUnit === null
						? 0
						: (point.costMicro * countPerUnit) /
							1_000_000_000 /
							10 ** currencyExponent(item.cost?.currency),
			}))
		: []
	const chartConfig = {
		cost: { label: t`Cost`, color: 'var(--chart-1)' },
	} satisfies ChartConfig

	return (
		<SheetPanel
			title={<span className="wrap-anywhere">{item.name}</span>}
			description={
				<>
					{categoryLabel(item.category, i18n)}
					{item.kind === 'made' ? (
						<>
							{' · '}
							<Trans>Made in house</Trans>
						</>
					) : null}
				</>
			}
			headerExtra={
				item.archived ? (
					<Badge variant="secondary">
						<Trans>Archived</Trans>
					</Badge>
				) : item.status === 'low' ? (
					<Badge variant="warning">
						<Trans context="inventory stock status">Low</Trans>
					</Badge>
				) : item.status === 'out' ? (
					<Badge variant="destructive">
						<Trans context="inventory stock status">Out</Trans>
					</Badge>
				) : null
			}
		>
			{canEdit ? (
				<div className="flex flex-wrap gap-2" data-testid="item-sheet-actions">
					<Button
						variant="outline"
						render={<Link to={editHref} />}
						data-testid="item-sheet-edit"
					>
						<Icon name="pencil" />
						<Trans>Edit</Trans>
					</Button>
					{canSeeCost ? (
						<Button
							variant="outline"
							onClick={() => setAdjusting(true)}
							data-testid="item-sheet-adjust"
						>
							<Trans>Adjust stock</Trans>
						</Button>
					) : null}
					<Button
						variant="outline"
						onClick={() => {
							setArchiveError(null)
							setArchiving(true)
						}}
						data-testid="item-sheet-archive"
					>
						<Icon name="trash-2" />
						<Trans>Archive</Trans>
					</Button>
				</div>
			) : null}

			<section className="flex flex-col gap-3" aria-labelledby="item-summary">
				<h3 id="item-summary" className="text-sm font-semibold">
					<Trans>Summary</Trans>
				</h3>
				<div className="flex flex-col gap-1">
					<span className="text-muted-foreground text-xs">
						{locationName ? (
							<Trans>On hand at {locationName}</Trans>
						) : (
							<Trans>On hand</Trans>
						)}
					</span>
					<bdi
						dir="ltr"
						className="text-2xl font-semibold tabular-nums"
						data-testid="item-sheet-on-hand"
					>
						{fmt(item.onHand)}
					</bdi>
					{ratio !== null ? (
						<Progress
							value={Math.round(ratio * 100)}
							aria-label={t`Compared with fill up to`}
							className="w-40"
						/>
					) : null}
				</div>
				<dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
					<dt className="text-muted-foreground">
						<Trans>Order more when below</Trans>
					</dt>
					<dd className="tabular-nums">
						{item.orderBelowQuantity === null ? (
							<span className="text-muted-foreground">—</span>
						) : (
							<bdi dir="ltr">{fmt(item.orderBelowQuantity)}</bdi>
						)}
					</dd>
					<dt className="text-muted-foreground">
						<Trans>Fill up to</Trans>
					</dt>
					<dd className="tabular-nums">
						{item.fillUpToQuantity === null ? (
							<span className="text-muted-foreground">—</span>
						) : (
							<bdi dir="ltr">{fmt(item.fillUpToQuantity)}</bdi>
						)}
					</dd>
					<dt className="text-muted-foreground">
						<Trans>Last counted</Trans>
					</dt>
					<dd>
						{item.lastCountedAt === null ? (
							<span className="text-muted-foreground">
								<Trans>Not counted yet</Trans>
							</span>
						) : (
							formatDateTime(item.lastCountedAt, i18n.locale)
						)}
					</dd>
				</dl>
				{item.onHandByLocation.length > 1 ? (
					<ul
						className="flex flex-col gap-1 text-sm"
						data-testid="item-sheet-locations"
					>
						{item.onHandByLocation.map((row) => (
							<li
								key={row.locationId}
								className="flex items-center justify-between gap-3"
							>
								<span className="text-muted-foreground wrap-anywhere">
									{locationNames.get(row.locationId) ?? row.locationId}
								</span>
								<bdi dir="ltr" className="tabular-nums">
									{fmt(row.onHand)}
								</bdi>
							</li>
						))}
					</ul>
				) : null}
			</section>

			{canSeeCost && item.cost ? (
				<section
					className="flex flex-col gap-3"
					aria-labelledby="item-cost"
					data-testid="item-sheet-cost"
				>
					<h3 id="item-cost" className="text-sm font-semibold">
						<Trans>Cost</Trans>
					</h3>
					<dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
						{item.cost.lastCostMicro !== null && countPerUnit !== null ? (
							<>
								<dt className="text-muted-foreground">
									<Trans>Last paid, per unit</Trans>
								</dt>
								<dd className="tabular-nums">
									<bdi dir="ltr">
										{formatCostPerUnit(
											item.cost.lastCostMicro,
											countPerUnit,
											item.cost.currency,
											i18n.locale,
										)}
									</bdi>{' '}
									<span className="text-muted-foreground">
										<bdi dir="ltr">
											{item.countUnit
												? quantity.unitName(item.countUnit, item.units)
												: ''}
										</bdi>
									</span>
								</dd>
							</>
						) : null}
						{item.valueMinor !== undefined ? (
							<>
								<dt className="text-muted-foreground">
									<Trans>Worth</Trans>
								</dt>
								<dd className="tabular-nums">
									<bdi dir="ltr">
										{formatMoney(
											item.valueMinor,
											item.currency ?? currency,
											i18n.locale,
										)}
									</bdi>
								</dd>
							</>
						) : null}
					</dl>
					{chart.length >= 2 ? (
						<ChartContainer
							config={chartConfig}
							className="aspect-auto h-32 w-full"
						>
							<LineChart
								accessibilityLayer
								data={chart}
								margin={{ left: 4, right: 12, top: 8 }}
							>
								<CartesianGrid vertical={false} />
								<XAxis
									dataKey="label"
									tickLine={false}
									axisLine={false}
									tickMargin={8}
								/>
								<YAxis hide domain={['auto', 'auto']} />
								<ChartTooltip content={<ChartTooltipContent hideLabel />} />
								<Line
									dataKey="cost"
									type="monotone"
									stroke="var(--color-cost)"
									strokeWidth={2}
									dot={false}
								/>
							</LineChart>
						</ChartContainer>
					) : null}
				</section>
			) : null}

			<section className="flex flex-col gap-3" aria-labelledby="item-buying">
				<h3 id="item-buying" className="text-sm font-semibold">
					<Trans>Buying</Trans>
				</h3>
				{item.suppliers.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						<Trans>No supplier yet. Add one in Purchasing.</Trans>
					</p>
				) : (
					<ul
						className="flex flex-col gap-2 text-sm"
						data-testid="item-sheet-suppliers"
					>
						{item.suppliers.map((supplier) => (
							<li
								key={supplier.id}
								className="flex items-center justify-between gap-3"
							>
								<span className="flex min-w-0 flex-col">
									<span className="font-medium wrap-anywhere">
										{supplier.supplierName}
									</span>
									<span className="text-muted-foreground text-xs">
										{supplier.packName} ·{' '}
										<bdi dir="ltr">{fmt(supplier.packBaseQuantity)}</bdi>
									</span>
								</span>
								{supplier.priceMinor !== undefined ? (
									<bdi dir="ltr" className="tabular-nums">
										{formatMoney(
											supplier.priceMinor,
											supplier.currency ?? currency,
											i18n.locale,
										)}
									</bdi>
								) : null}
							</li>
						))}
					</ul>
				)}
			</section>

			<ItemRecipeSections
				item={item}
				locationId={locationId}
				currency={currency}
				recipesEnabled={recipesEnabled}
				canEditRecipes={canEditRecipes && !item.archived}
				canEditInventory={canEdit}
				onChanged={onChanged}
			/>

			<section className="flex flex-col gap-3" aria-labelledby="item-history">
				<h3 id="item-history" className="text-sm font-semibold">
					<Trans>History</Trans>
				</h3>
				{movements.error && !movements.data ? (
					<Alert variant="destructive">
						<AlertDescription>
							{i18n._(inventoryErrorMessage(movements.error))}
						</AlertDescription>
						<Button
							className="mt-2 justify-self-start"
							variant="outline"
							onClick={movements.reload}
						>
							<Trans>Try again</Trans>
						</Button>
					</Alert>
				) : movements.loading && !movements.data ? (
					<Skeleton className="h-20 w-full" />
				) : (movements.data?.movements.length ?? 0) === 0 ? (
					<p className="text-muted-foreground text-sm">
						<Trans>Nothing has happened to this item yet.</Trans>
					</p>
				) : (
					<>
						<ul
							className="flex flex-col divide-y text-sm"
							data-testid="item-sheet-history"
							aria-busy={movements.refreshing}
						>
							{movements.data!.movements.map((movement) => {
								const who =
									movement.actor.kind === 'operator' && movement.actor.id
										? (memberNames[movement.actor.id] ?? null)
										: movement.actor.kind === 'staff'
											? t`Staff member`
											: movement.actor.kind === 'system'
												? t`Automatic`
												: null
								const reason =
									movement.reason && movement.kind === 'waste'
										? Object.hasOwn(WASTE_REASON_LABELS, movement.reason)
											? i18n._(
													WASTE_REASON_LABELS[
														movement.reason as keyof typeof WASTE_REASON_LABELS
													],
												)
											: movement.reason
										: movement.reason && movement.kind === 'adjustment'
											? Object.hasOwn(ADJUSTMENT_REASON_LABELS, movement.reason)
												? i18n._(
														ADJUSTMENT_REASON_LABELS[
															movement.reason as keyof typeof ADJUSTMENT_REASON_LABELS
														],
													)
												: movement.reason
											: movement.reason
								return (
									<li
										key={movement.id}
										className="flex items-start justify-between gap-3 py-2"
									>
										<span className="flex min-w-0 flex-col">
											<span className="font-medium">
												{i18n._(MOVEMENT_KIND_LABELS[movement.kind])}
												{reason ? (
													<span className="text-muted-foreground font-normal">
														{' · '}
														{reason}
													</span>
												) : null}
											</span>
											<span className="text-muted-foreground text-xs">
												{formatDateTime(movement.createdAt, i18n.locale)}
												{who ? ` · ${who}` : ''}
											</span>
											{movement.note ? (
												<span className="text-muted-foreground text-xs wrap-anywhere">
													{movement.note}
												</span>
											) : null}
										</span>
										<bdi dir="ltr" className="shrink-0 tabular-nums">
											{movement.quantity > 0
												? '+'
												: movement.quantity < 0
													? '−'
													: ''}
											{fmt(Math.abs(movement.quantity))}
										</bdi>
									</li>
								)
							})}
						</ul>
						{movements.data!.nextCursor !== null &&
						movements.data!.movements.length >= movementLimit ? (
							<Button
								variant="outline"
								className="self-start"
								onClick={onShowMoreMovements}
								data-testid="item-sheet-more-history"
							>
								<Trans>Show more</Trans>
							</Button>
						) : null}
					</>
				)}
			</section>

			<AdjustStockDialog
				item={item}
				locationId={locationId}
				open={adjusting}
				onOpenChange={setAdjusting}
				onAdjusted={onChanged}
			/>
			<AlertDialog
				open={archiving}
				onOpenChange={(next) => {
					if (!archivePending) setArchiving(next)
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							<Trans>Archive this item?</Trans>
						</AlertDialogTitle>
						<AlertDialogDescription>
							<Trans>
								<span className="wrap-anywhere">{itemName}</span> leaves your
								lists and counts. Its history is kept.
							</Trans>
						</AlertDialogDescription>
					</AlertDialogHeader>
					{archiveError ? (
						<Alert variant="destructive" data-testid="item-sheet-archive-error">
							<AlertDescription>{archiveError}</AlertDescription>
						</Alert>
					) : null}
					<AlertDialogFooter>
						<AlertDialogCancel disabled={archivePending}>
							<Trans>Cancel</Trans>
						</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							disabled={archivePending}
							onClick={() => void archive()}
							data-testid="item-sheet-archive-confirm"
						>
							<Trans>Archive</Trans>
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</SheetPanel>
	)
}
