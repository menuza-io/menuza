import { Trans, useLingui } from '@lingui/react/macro'
import { type FoodCostStatus } from '@repo/inventory'
import { TableCell, TableHead } from '@repo/ui/table'
import { createContext, type ReactNode, useContext, useMemo } from 'react'
import { RecipeScope } from '#app/components/inventory/recipe-panel.tsx'
import { FoodCostDot } from '#app/components/inventory/recipe-section.tsx'
import { useRecipeAccess } from '#app/hooks/use-recipe-access.ts'
import { useRecipeCosts } from '#app/hooks/use-recipe-costs.ts'
import {
	costRowView,
	formatPercentBp,
	majorToMinor,
	regionCurrency,
} from '#app/utils/inventory/recipe-form.ts'

type FoodCostValue = {
	/** Show the column at all. */
	visible: boolean
	rowFor: (key: string) => {
		hasRecipe: boolean
		foodCostBp: number | null
		status: FoodCostStatus | null
	} | null
}

const HIDDEN: FoodCostValue = { visible: false, rowFor: () => null }
const FoodCostContext = createContext<FoodCostValue>(HIDDEN)

/** Whether the "Food cost" column is shown (for footer column spans). */
export function useFoodCostVisible(): boolean {
	return useContext(FoodCostContext).visible
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
		}),
		[costs.rows, costs.unavailable, costs.failed],
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
