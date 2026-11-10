import { Trans, useLingui } from '@lingui/react/macro'
import {
	INVENTORY_CATEGORIES,
	listItemsResultSchema,
	listStorageAreasResultSchema,
} from '@repo/inventory'
import { useDirection } from '@repo/ui'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@repo/ui/dropdown-menu'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Sheet, SheetContent } from '@repo/ui/sheet'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
	Link,
	Outlet,
	useLocation,
	useNavigate,
	useOutlet,
	useSearchParams,
} from 'react-router'
import { EmptyState } from '#app/components/empty-state.tsx'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { InventoryHeaderActions } from '#app/components/inventory/inventory-chrome.tsx'
import { useInventoryRevision } from '#app/components/inventory/inventory-prefs.tsx'
import { type StockOutletContext } from '#app/components/inventory/stock-context.ts'
import {
	StockList,
	StockListSkeleton,
} from '#app/components/inventory/stock-list.tsx'
import { FilterSelect } from '#app/components/staff/controls.tsx'
import { useInventoryQuery } from '#app/hooks/use-inventory-client.ts'
import { requireInventoryAccess } from '#app/utils/inventory/access.server.ts'
import { formatMoney } from '#app/utils/inventory/format.ts'
import { inventoryErrorMessage } from '#app/utils/inventory/inventory-errors.ts'
import {
	categoryLabel,
	CUSTOM_CATEGORY_PREFIX,
} from '#app/utils/inventory/labels.ts'
import {
	applyStockFilterPatch,
	clearStockFilters,
	hasActiveStockFilters,
	NO_FILTER,
	parseStockFilters,
	STOCK_MAX_LIMIT,
	STOCK_PAGE_SIZE,
	stockListPath,
} from '#app/utils/inventory/stock-filters.ts'
import { type Route } from './+types/stock.ts'
import { useInventoryLayoutData } from './_layout.tsx'

export async function loader({ request, params }: Route.LoaderArgs) {
	await requireInventoryAccess(request, params.orgSlug)
	return null
}

const SEARCH_DELAY_MS = 250

export default function InventoryStockRoute() {
	const { t, i18n } = useLingui()
	const layout = useInventoryLayoutData()
	const {
		orgSlug,
		activeLocationId,
		canEdit,
		canSeeCost,
		canManagePurchasing,
		purchasingEnabled,
		currency,
	} = layout
	const canSetLevels = purchasingEnabled && canManagePurchasing
	const direction = useDirection()
	const navigate = useNavigate()
	const outlet = useOutlet()
	const { search } = useLocation()
	const [searchParams, setSearchParams] = useSearchParams()
	const filters = parseStockFilters(searchParams)
	const basePath = `/${orgSlug}/inventory/stock`

	// The search box types freely and writes the URL after a pause. A change
	// to `q` that did not come from the box (Clear filters) refills the box.
	const [searchText, setSearchText] = useState(filters.q)
	const pushedQuery = useRef(filters.q)
	useEffect(() => {
		if (filters.q !== pushedQuery.current) {
			pushedQuery.current = filters.q
			setSearchText(filters.q)
		}
	}, [filters.q])
	useEffect(() => {
		const next = searchText.trim()
		if (next === pushedQuery.current) return
		const timer = setTimeout(() => {
			pushedQuery.current = next
			setSearchParams(
				(current) => applyStockFilterPatch(current, { q: next }),
				{ replace: true },
			)
		}, SEARCH_DELAY_MS)
		return () => clearTimeout(timer)
	}, [searchText, setSearchParams])

	const patch = useCallback(
		(change: Parameters<typeof applyStockFilterPatch>[1]) =>
			setSearchParams((current) => applyStockFilterPatch(current, change), {
				replace: true,
			}),
		[setSearchParams],
	)

	const listPath = stockListPath(filters, activeLocationId)
	const list = useInventoryQuery(listPath, listItemsResultSchema)
	const areasQuery = useInventoryQuery(
		`/storage-areas?locationId=${encodeURIComponent(activeLocationId)}`,
		listStorageAreasResultSchema,
	)
	const { reload: reloadList } = list
	const { reload: reloadAreas } = areasQuery
	const reload = useCallback(() => {
		reloadList()
		reloadAreas()
	}, [reloadList, reloadAreas])

	// A save elsewhere (waste logged, an item added) refreshes the list.
	const revision = useInventoryRevision()
	const seenRevision = useRef(revision)
	useEffect(() => {
		if (revision !== seenRevision.current) {
			seenRevision.current = revision
			reload()
		}
	}, [revision, reload])

	const areas = useMemo(() => areasQuery.data?.areas ?? [], [areasQuery.data])
	const areaNames = useMemo(
		() => new Map(areas.map((area) => [area.id, area.name])),
		[areas],
	)
	const items = list.data?.items ?? []
	const total = list.data?.total ?? 0

	const [customCategories, setCustomCategories] = useState<string[]>([])
	useEffect(() => {
		const seen = items
			.map((item) => item.category)
			.filter((category) => category.startsWith(CUSTOM_CATEGORY_PREFIX))
		if (seen.length === 0) return
		setCustomCategories((current) => [...new Set([...current, ...seen])])
		// `items` changes identity with every response.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [list.data])

	const categoryOptions = useMemo(
		() => [
			{ value: NO_FILTER, label: t`All categories` },
			...[...INVENTORY_CATEGORIES, ...customCategories].map((value) => ({
				value,
				label: categoryLabel(value, i18n),
			})),
		],
		[customCategories, i18n, t],
	)
	const areaOptions = useMemo(
		() => [
			{ value: NO_FILTER, label: t`All areas` },
			...areas.map((area) => ({ value: area.id, label: area.name })),
		],
		[areas, t],
	)

	const filtering = hasActiveStockFilters(filters)
	const close = useCallback(
		() => void navigate(`${basePath}${search}`),
		[navigate, basePath, search],
	)
	const outletContext: StockOutletContext = {
		...layout,
		basePath,
		search,
		areas,
		reload,
		close,
	}
	const shown = items.length
	const totalValueText =
		canSeeCost && list.data?.totalValueMinor !== undefined
			? formatMoney(
					list.data.totalValueMinor,
					list.data.currency ?? currency,
					i18n.locale,
				)
			: null
	const addHref = `${basePath}/new${search}`

	return (
		<div className="flex flex-col gap-6">
			{canEdit || canSetLevels ? (
				<InventoryHeaderActions>
					{canEdit ? (
						<Button render={<Link to={addHref} />} data-testid="stock-add-item">
							<Icon name="plus" />
							<Trans>Add item</Trans>
						</Button>
					) : null}
					<DropdownMenu>
						<DropdownMenuTrigger
							render={
								<Button
									variant="outline"
									size="icon-sm"
									aria-label={t`More stock actions`}
									data-testid="stock-more-actions"
								>
									<Icon name="ellipsis" />
								</Button>
							}
						/>
						<DropdownMenuContent align="end">
							{canEdit ? (
								<>
									<DropdownMenuItem
										render={<Link to={`${basePath}/add-many${search}`} />}
									>
										<Icon name="list-plus" />
										<Trans>Add many items</Trans>
									</DropdownMenuItem>
									<DropdownMenuItem
										render={<Link to={`${basePath}/areas${search}`} />}
									>
										<Icon name="layers" />
										<Trans>Storage areas</Trans>
									</DropdownMenuItem>
									<DropdownMenuItem
										render={<Link to={`${basePath}/lists${search}`} />}
									>
										<Icon name="list" />
										<Trans>Count lists</Trans>
									</DropdownMenuItem>
								</>
							) : null}
							{canSetLevels ? (
								<DropdownMenuItem
									render={<Link to={`${basePath}/levels${search}`} />}
									data-testid="stock-set-levels"
								>
									<Icon name="sliders-horizontal" />
									<Trans>Set levels</Trans>
								</DropdownMenuItem>
							) : null}
						</DropdownMenuContent>
					</DropdownMenu>
				</InventoryHeaderActions>
			) : null}

			<div
				role="search"
				className="flex flex-col gap-2 md:flex-row md:items-center"
			>
				<div className="relative md:w-72">
					<Icon
						name="search"
						className="text-muted-foreground pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2"
					/>
					<Input
						type="search"
						value={searchText}
						onChange={(event) => setSearchText(event.target.value)}
						placeholder={t`Search items`}
						aria-label={t`Search items`}
						maxLength={80}
						className="h-11 ps-8 md:h-8"
						data-testid="stock-search"
					/>
				</div>
				<div className="grid grid-cols-2 gap-2 *:last:odd:col-span-2 md:contents">
					<FilterSelect
						label={t`Filter by category`}
						options={categoryOptions}
						value={filters.category}
						onValueChange={(category) => patch({ category })}
						testId="stock-filter-category"
					/>
					{areas.length > 0 ? (
						<FilterSelect
							label={t`Filter by area`}
							options={areaOptions}
							value={filters.areaId}
							onValueChange={(areaId) => patch({ areaId })}
							testId="stock-filter-area"
						/>
					) : null}
					<Button
						type="button"
						variant={filters.lowOnly ? 'default' : 'outline'}
						aria-pressed={filters.lowOnly}
						className="h-11 md:h-8"
						onClick={() => patch({ lowOnly: !filters.lowOnly })}
						data-testid="stock-filter-low"
					>
						<Trans>Low or out</Trans>
					</Button>
				</div>
			</div>

			{list.error && !list.data ? (
				<Alert variant="destructive" data-testid="stock-error">
					<AlertDescription>
						{i18n._(inventoryErrorMessage(list.error))}
					</AlertDescription>
					<Button
						className="mt-2 justify-self-start"
						variant="outline"
						onClick={reload}
					>
						<Trans>Try again</Trans>
					</Button>
				</Alert>
			) : list.loading && !list.data ? (
				<StockListSkeleton />
			) : items.length === 0 ? (
				filtering ? (
					<EmptyState
						title={<Trans>No items match</Trans>}
						description={
							<Trans>Try a different search or clear the filters.</Trans>
						}
						icons={['search', 'list', 'layers']}
					>
						<Button
							variant="outline"
							onClick={() => {
								setSearchText('')
								setSearchParams(clearStockFilters(searchParams), {
									replace: true,
								})
							}}
							data-testid="stock-clear-filters"
						>
							<Trans>Clear filters</Trans>
						</Button>
					</EmptyState>
				) : (
					<EmptyState
						title={<Trans>No items yet</Trans>}
						description={
							<Trans>
								Add what you buy and use, one at a time or many at once. You
								will see how much you have, where it is kept and what it is
								worth.
							</Trans>
						}
						icons={['list', 'layers', 'shopping-bag']}
					>
						{canEdit ? (
							<>
								<Button render={<Link to={addHref} />}>
									<Icon name="plus" />
									<Trans>Add item</Trans>
								</Button>
								<Button
									variant="outline"
									render={<Link to={`${basePath}/add-many${search}`} />}
								>
									<Trans>Add many items</Trans>
								</Button>
							</>
						) : null}
					</EmptyState>
				)
			) : (
				<div
					className={
						list.refreshing ? 'opacity-70 transition-opacity' : undefined
					}
					aria-busy={list.refreshing}
				>
					<StockList
						items={items}
						basePath={basePath}
						search={search}
						areaNames={areaNames}
						showValue={canSeeCost}
						currency={currency}
					/>
					<div className="text-muted-foreground mt-3 flex flex-wrap items-center justify-between gap-3 text-sm">
						<span aria-live="polite" data-testid="stock-count">
							<Trans>
								Showing {shown} of {total}
							</Trans>
							{totalValueText !== null ? (
								<>
									{' · '}
									<Trans>
										Worth <bdi dir="ltr">{totalValueText}</bdi>
									</Trans>
								</>
							) : null}
						</span>
						{shown < total && filters.limit < STOCK_MAX_LIMIT ? (
							<Button
								variant="outline"
								onClick={() =>
									patch({ limit: filters.limit + STOCK_PAGE_SIZE })
								}
								data-testid="stock-show-more"
							>
								<Trans>Show more</Trans>
							</Button>
						) : shown < total ? (
							<span>
								<Trans>Search or filter to narrow the list.</Trans>
							</span>
						) : null}
					</div>
				</div>
			)}

			<Sheet
				open={outlet !== null}
				onOpenChange={(open) => {
					if (!open) close()
				}}
			>
				<SheetContent
					side={direction === 'rtl' ? 'left' : 'right'}
					className="flex w-full flex-col gap-0 data-[side=left]:sm:max-w-xl data-[side=right]:sm:max-w-xl"
				>
					<Outlet context={outletContext} />
				</SheetContent>
			</Sheet>
		</div>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
