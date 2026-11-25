import { Trans, useLingui } from '@lingui/react/macro'
import {
	dishProfitabilityResultSchema,
	type FoodCostStatus,
} from '@repo/inventory'
import { TableCell, TableHead } from '@repo/ui/table'
import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useState,
} from 'react'
import { RecipeScope } from '#app/components/inventory/recipe-panel.tsx'
import { FoodCostDot } from '#app/components/inventory/recipe-section.tsx'
import { useInventoryClient } from '#app/hooks/use-inventory-client.ts'
import { useRecipeAccess } from '#app/hooks/use-recipe-access.ts'
import { useRecipeCosts } from '#app/hooks/use-recipe-costs.ts'
import {
	costRowView,
	formatPercentBp,
	majorToMinor,
	regionCurrency,
} from '#app/utils/inventory/recipe-form.ts'

type FoodCostRow = {
	hasRecipe: boolean
	foodCostBp: number | null
	status: FoodCostStatus | null
	/** Menu price without tax minus the plate cost (#519). */
	unitMarginMinor: number | null
}

type FoodCostValue = {
	/** Show the column at all. */
	visible: boolean
	rowFor: (key: string) => FoodCostRow | null
	/** The currency the costs are in (for the margin sort's period call). */
	currency: string
}

const HIDDEN: FoodCostValue = {
	visible: false,
	rowFor: () => null,
	currency: '',
}
const FoodCostContext = createContext<FoodCostValue>(HIDDEN)

/** Whether the "Food cost" column is shown (for footer column spans). */
export function useFoodCostVisible(): boolean {
	return useContext(FoodCostContext).visible
}

/** The food cost of each dish on the page, for sorting the list by it (#519). */
export function useFoodCostRows(): FoodCostValue {
	return useContext(FoodCostContext)
}

/** How the menu list is ordered; `default` leaves the list as it is. */
export type FoodCostSort = 'default' | 'food_cost' | 'margin' | 'margin_period'

/**
 * Orders `items` by food cost % (highest first, so the dishes that cost the
 * most to make come first), margin per dish or margin in a period (largest
 * first). A dish with no figure for the sort goes last, in its own order.
 * Never changes the list for `default`.
 */
export function sortItemsByFoodCost<T extends { id: string }>(
	items: readonly T[],
	sort: FoodCostSort,
	rowFor: (key: string) => FoodCostRow | null,
	periodMargin: ReadonlyMap<string, number> | null,
): T[] {
	if (sort === 'default') return [...items]
	const figure = (item: T): number | null => {
		switch (sort) {
			case 'food_cost':
				return rowFor(item.id)?.foodCostBp ?? null
			case 'margin':
				return rowFor(item.id)?.unitMarginMinor ?? null
			case 'margin_period':
				return periodMargin?.get(item.id) ?? null
			default:
				return null
		}
	}
	return items
		.map((item, index) => ({ item, index, value: figure(item) }))
		.sort((a, b) => {
			if (a.value === null && b.value === null) return a.index - b.index
			if (a.value === null) return 1
			if (b.value === null) return -1
			return b.value - a.value || a.index - b.index
		})
		.map((entry) => entry.item)
}

export type FoodCostItem = { id: string; priceMajor: number }

/**
 * Gives the menu items table its "Food cost" column: ONE costs call for the
 * page (split in 200s only beyond that), joined by item id. Renders its
 * children untouched, with the column hidden, while recipes are off, the
 * member may not read inventory, or the region says recipes are unavailable.
 */
export function FoodCostProvider({
	orgSlug,
	dataRegion,
	items,
	children,
}: {
	orgSlug: string
	dataRegion: string | null | undefined
	items: readonly FoodCostItem[]
	children: ReactNode
}) {
	const access = useRecipeAccess()
	if (!access.enabled) return <>{children}</>
	return (
		<RecipeScope orgSlug={orgSlug} dataRegion={dataRegion}>
			<FoodCostLoader dataRegion={dataRegion} items={items}>
				{children}
			</FoodCostLoader>
		</RecipeScope>
	)
}

function FoodCostLoader({
	dataRegion,
	items,
	children,
}: {
	dataRegion: string | null | undefined
	items: readonly FoodCostItem[]
	children: ReactNode
}) {
	const currency = regionCurrency(dataRegion)
	const refs = useMemo(
		() =>
			items.map((item) => {
				const priceMinor = majorToMinor(item.priceMajor, currency)
				return {
					key: item.id,
					itemId: item.id,
					...(priceMinor > 0 ? { priceMinor } : {}),
				}
			}),
		[items, currency],
	)
	const costs = useRecipeCosts(refs, currency, refs.length > 0)
	const value = useMemo<FoodCostValue>(
		() => ({
			visible: !costs.unavailable && !costs.failed,
			rowFor: (key) => (costs.rows ? costRowView(costs.rows.get(key)) : null),
			currency,
		}),
		[costs.rows, costs.unavailable, costs.failed, currency],
	)
	return (
		<FoodCostContext.Provider value={value}>
			{children}
		</FoodCostContext.Provider>
	)
}

export function FoodCostHead() {
	const { visible } = useContext(FoodCostContext)
	if (!visible) return null
	return (
		<TableHead className="hidden md:table-cell" data-testid="food-cost-head">
			<Trans>Food cost</Trans>
		</TableHead>
	)
}

/**
 * One row's food cost: a percent with a status dot, "—" for a dish without a
 * recipe, and just "Recipe set" when the region sent no money (no cost grant,
 * or nothing is priced yet). Never a made-up number.
 */
export function FoodCostCell({ itemId }: { itemId: string }) {
	const { i18n } = useLingui()
	const { visible, rowFor } = useContext(FoodCostContext)
	if (!visible) return null
	const row = rowFor(itemId)
	return (
		<TableCell
			className="hidden md:table-cell"
			data-testid={`food-cost-${itemId}`}
		>
			{row === null ? (
				<span className="text-muted-foreground text-xs">…</span>
			) : !row.hasRecipe ? (
				<span className="text-muted-foreground text-xs">—</span>
			) : row.foodCostBp === null ? (
				<span className="text-muted-foreground text-xs">
					<Trans>Recipe set</Trans>
				</span>
			) : (
				<span className="flex items-center gap-2 text-sm tabular-nums">
					<bdi dir="ltr">{formatPercentBp(row.foodCostBp, i18n.locale)}</bdi>
					{row.status ? <FoodCostDot status={row.status} /> : null}
				</span>
			)}
		</TableCell>
	)
}

/** The footer's wide cell: it spans the columns before the actions column. */
export function FoodCostFooterCell({ children }: { children: ReactNode }) {
	const visible = useFoodCostVisible()
	return <TableCell colSpan={visible ? 6 : 5}>{children}</TableCell>
}

const PERIOD_DAYS = 30

function localDate(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, '0')
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * The "Sort by" control of the menu list (#519): the order it came in, food
 * cost %, margin per dish, or margin over the last 30 days at one location.
 * Shown only where the Food cost column is, so it never promises a figure the
 * member cannot see. The period margin is one call to the region
 * (`/recipes/profitability`, the cost grant's), made only while that sort is on;
 * `onPeriodMargins` hands the figures to the list, which does the ordering.
 */
type FoodCostSortControlProps = {
	sort: FoodCostSort
	onSortChange: (sort: FoodCostSort) => void
	locations: ReadonlyArray<{ id: string; label: string }>
	items: ReadonlyArray<{ id: string; price: number }>
	onPeriodMargins: (margins: ReadonlyMap<string, number> | null) => void
}

export function FoodCostSortControl(props: FoodCostSortControlProps) {
	// Without the Food cost column (recipes off, no access) there is no regional
	// client either: nothing to sort by, so nothing is rendered or asked.
	const { visible } = useContext(FoodCostContext)
	if (!visible) return null
	return <FoodCostSortControlInner {...props} />
}

function FoodCostSortControlInner({
	sort,
	onSortChange,
	locations,
	items,
	onPeriodMargins,
}: FoodCostSortControlProps) {
	const { t } = useLingui()
	const { visible, currency } = useContext(FoodCostContext)
	const { request } = useInventoryClient()
	const [locationId, setLocationId] = useState(locations[0]?.id ?? '')

	useEffect(() => {
		if (sort !== 'margin_period' || !locationId || !visible) {
			onPeriodMargins(null)
			return
		}
		let live = true
		const to = new Date()
		const from = new Date(to.getTime() - (PERIOD_DAYS - 1) * 86_400_000)
		request('/recipes/profitability', {
			method: 'POST',
			body: JSON.stringify({
				locationId,
				fromDate: localDate(from),
				toDate: localDate(to),
				currency,
				dishes: items.slice(0, 1_000).map((item) => ({
					itemId: item.id,
					priceMinor: Math.round(item.price * 100),
					categoryKey: '',
				})),
			}),
			readOnly: true,
		}).then(
			(answer) => {
				if (!live) return
				const parsed = dishProfitabilityResultSchema.parse(answer)
				onPeriodMargins(
					new Map(parsed.dishes.map((dish) => [dish.itemId, dish.marginMinor])),
				)
			},
			() => {
				if (live) onPeriodMargins(null)
			},
		)
		return () => {
			live = false
		}
	}, [sort, locationId, visible, currency, items, request, onPeriodMargins])

	if (!visible) return null
	return (
		<div
			className="flex flex-wrap items-center gap-2"
			data-testid="food-cost-sort"
		>
			<label className="flex items-center gap-2 text-sm">
				<span className="text-muted-foreground text-xs">
					<Trans>Sort by</Trans>
				</span>
				<select
					className="bg-card border-input h-8 rounded-md border px-2 text-sm"
					value={sort}
					onChange={(event) => onSortChange(event.target.value as FoodCostSort)}
				>
					<option value="default">{t`Menu order`}</option>
					<option value="food_cost">{t`Food cost % (highest first)`}</option>
					<option value="margin">{t`Margin per dish (highest first)`}</option>
					{locations.length > 0 ? (
						<option value="margin_period">
							{t`Margin, last 30 days (highest first)`}
						</option>
					) : null}
				</select>
			</label>
			{sort === 'margin_period' && locations.length > 1 ? (
				<select
					aria-label={t`Location`}
					className="bg-card border-input h-8 rounded-md border px-2 text-sm"
					value={locationId}
					onChange={(event) => setLocationId(event.target.value)}
				>
					{locations.map((location) => (
						<option key={location.id} value={location.id}>
							{location.label}
						</option>
					))}
				</select>
			) : null}
		</div>
	)
}
