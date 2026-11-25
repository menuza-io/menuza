import { Trans, useLingui } from '@lingui/react/macro'
import {
	dishProfitabilityResultSchema,
	type DishProfitabilityResult,
	MENU_ENGINEERING_GROUPS,
	type MenuEngineeringGroup,
} from '@repo/inventory'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
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
import { useEffect, useMemo, useState } from 'react'
import { EmptyState } from '#app/components/empty-state.tsx'
import { useInventoryClient } from '#app/hooks/use-inventory-client.ts'
import { formatMoney } from '#app/utils/inventory/format.ts'
import { inventoryErrorMessage } from '#app/utils/inventory/inventory-errors.ts'

export type ProfitabilityDishInput = {
	id: string
	name: string
	/** Menu price in major units. */
	price: number
	categoryKey: string
	categoryName: string
}

const PERIODS = [7, 30, 90] as const

function dateString(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, '0')
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function useGroupLabels(): Record<MenuEngineeringGroup, string> {
	const { t } = useLingui()
	return {
		keep: t`Keep`,
		reprice: t`Re-price`,
		promote: t`Promote`,
		rethink: t`Rethink`,
	}
}

type SortKey = 'margin' | 'unitMargin' | 'quantity' | 'name'

/**
 * Dish profitability (#519), per location and period: what sold, the menu
 * price, the plate cost, the margin per dish and in the period, how popular the
 * dish is among the dishes of its own category, and one of four labels in plain
 * words with a short suggestion (for a dish over its target food cost, the
 * price that hits the target). Dishes without a recipe or typed cost are listed
 * apart. Costs and margins are the cost grant's; the region refuses without it.
 */
export function ProfitabilityScreen({
	locationId,
	currency,
	dishes,
}: {
	locationId: string
	currency: string
	dishes: readonly ProfitabilityDishInput[]
}) {
	const { i18n, t } = useLingui()
	const { request } = useInventoryClient()
	const groupLabel = useGroupLabels()
	const [days, setDays] = useState<(typeof PERIODS)[number]>(30)
	const [sort, setSort] = useState<SortKey>('margin')
	const [state, setState] = useState<{
		result: DishProfitabilityResult | null
		error: Error | null
		loading: boolean
	}>({ result: null, error: null, loading: true })

	const byId = useMemo(
		() => new Map(dishes.map((dish) => [dish.id, dish])),
		[dishes],
	)

	useEffect(() => {
		let live = true
		setState((current) => ({ ...current, loading: true, error: null }))
		const to = new Date()
		const from = new Date(to.getTime() - (days - 1) * 86_400_000)
		const body = {
			locationId,
			fromDate: dateString(from),
			toDate: dateString(to),
			currency,
			dishes: dishes.slice(0, 1_000).map((dish) => ({
				itemId: dish.id,
				priceMinor: Math.round(dish.price * 100),
				categoryKey: dish.categoryKey,
			})),
		}
		request('/recipes/profitability', {
			method: 'POST',
			body: JSON.stringify(body),
			readOnly: true,
		}).then(
			(answer) => {
				if (!live) return
				setState({
					result: dishProfitabilityResultSchema.parse(answer),
					error: null,
					loading: false,
				})
			},
			(error: unknown) => {
				if (!live) return
				setState({
					result: null,
					error: error instanceof Error ? error : new Error('failed'),
					loading: false,
				})
			},
		)
		return () => {
			live = false
		}
	}, [days, currency, dishes, locationId, request])

	const money = (minor: number) => formatMoney(minor, currency, i18n.locale)
	const result = state.result
	const sorted = useMemo(() => {
		const rows = [...(result?.dishes ?? [])]
		const name = (id: string) => byId.get(id)?.name ?? id
		rows.sort((a, b) => {
			switch (sort) {
				case 'unitMargin':
					return b.unitMarginMinor - a.unitMarginMinor
				case 'quantity':
					return b.quantity - a.quantity
				case 'name':
					return name(a.itemId).localeCompare(name(b.itemId))
				default:
					return b.marginMinor - a.marginMinor
			}
		})
		return rows
	}, [byId, result, sort])
	const counts = useMemo(() => {
		const out: Record<MenuEngineeringGroup, number> = {
			keep: 0,
			reprice: 0,
			promote: 0,
			rethink: 0,
		}
		for (const dish of result?.dishes ?? []) out[dish.group] += 1
		return out
	}, [result])

	function suggestion(dish: DishProfitabilityResult['dishes'][number]): string {
		const target = dish.suggestion.priceForTargetMinor
		const foodCost =
			dish.suggestion.foodCostBp === null
				? null
				: `${(dish.suggestion.foodCostBp / 100).toFixed(0)}%`
		const targetPercent = `${(dish.suggestion.targetBp / 100).toFixed(0)}%`
		if (dish.suggestion.overTarget && target !== null && foodCost !== null) {
			const price = money(target)
			return t`Food cost ${foodCost}, target ${targetPercent}: the price that hits target is ${price}.`
		}
		switch (dish.group) {
			case 'keep':
				return t`Popular and earns well. Keep it as it is.`
			case 'reprice':
				return t`Popular but earns less than the rest of its category. A small price rise or a cheaper recipe pays.`
			case 'promote':
				return t`Earns well but sells slowly. Feature it or move it up the menu.`
			case 'rethink':
				return t`Sells slowly and earns little. Rework the recipe, change the price or take it off.`
		}
	}

	if (state.loading && !result) {
		return <Skeleton className="h-64 w-full rounded-xl" />
	}
	if (state.error && !result) {
		return (
			<Alert variant="destructive" data-testid="profitability-error">
				<AlertDescription>
					{i18n._(inventoryErrorMessage(state.error))}
				</AlertDescription>
			</Alert>
		)
	}
	if (!result) return null

	return (
		<div className="flex flex-col gap-6" data-testid="profitability-screen">
			<div className="flex flex-wrap items-end gap-3">
				<label className="flex flex-col gap-1 text-sm">
					<span className="text-muted-foreground text-xs">
						<Trans>Period</Trans>
					</span>
					<select
						className="bg-card border-input h-8 rounded-md border px-2 text-sm"
						value={days}
						onChange={(event) =>
							setDays(Number(event.target.value) as (typeof PERIODS)[number])
						}
					>
						{PERIODS.map((value) => (
							<option key={value} value={value}>
								{value === 7
									? t`Last 7 days`
									: value === 30
										? t`Last 30 days`
										: t`Last 90 days`}
							</option>
						))}
					</select>
				</label>
				<label className="flex flex-col gap-1 text-sm">
					<span className="text-muted-foreground text-xs">
						<Trans>Sort by</Trans>
					</span>
					<select
						className="bg-card border-input h-8 rounded-md border px-2 text-sm"
						value={sort}
						onChange={(event) => setSort(event.target.value as SortKey)}
					>
						<option value="margin">{t`Margin in the period`}</option>
						<option value="unitMargin">{t`Margin per dish`}</option>
						<option value="quantity">{t`Sold`}</option>
						<option value="name">{t`Name`}</option>
					</select>
				</label>
			</div>

			<WorkspaceMetricGrid>
				<WorkspaceMetric
					label={<Trans>Total margin</Trans>}
					value={money(result.totals.marginMinor)}
				/>
				<WorkspaceMetric
					label={<Trans>Net sales of these dishes</Trans>}
					value={money(result.totals.salesMinor)}
				/>
				{MENU_ENGINEERING_GROUPS.map((group) => (
					<WorkspaceMetric
						key={group}
						label={groupLabel[group]}
						value={String(counts[group])}
					/>
				))}
			</WorkspaceMetricGrid>

			{result.truncated ? (
				<p className="text-muted-foreground text-sm">
					<Trans>
						This period has more sales than a report reads. Figures cover the
						most recent ones.
					</Trans>
				</p>
			) : null}

			<WorkspacePanel title={<Trans>Dishes with a recipe or typed cost</Trans>}>
				{sorted.length === 0 ? (
					<EmptyState
						icons={['search']}
						title={<Trans>No dish has a whole cost yet.</Trans>}
						description={
							<Trans>
								Add a recipe, or type a cost, for a dish to see its margin.
							</Trans>
						}
					/>
				) : (
					<div className="overflow-x-auto">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>
										<Trans>Dish</Trans>
									</TableHead>
									<TableHead className="text-end">
										<Trans>Sold</Trans>
									</TableHead>
									<TableHead className="text-end">
										<Trans>Price</Trans>
									</TableHead>
									<TableHead className="text-end">
										<Trans>Cost</Trans>
									</TableHead>
									<TableHead className="text-end">
										<Trans>Margin per dish</Trans>
									</TableHead>
									<TableHead className="text-end">
										<Trans>Margin in the period</Trans>
									</TableHead>
									<TableHead className="text-end">
										<Trans>Share of its category</Trans>
									</TableHead>
									<TableHead>
										<Trans>Group</Trans>
									</TableHead>
									<TableHead>
										<Trans>What to do</Trans>
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{sorted.map((dish) => (
									<TableRow
										key={dish.itemId}
										data-testid={`profit-row-${dish.itemId}`}
									>
										<TableCell className="font-medium">
											{byId.get(dish.itemId)?.name ?? dish.itemId}
											<span className="text-muted-foreground block text-xs">
												{byId.get(dish.itemId)?.categoryName}
											</span>
										</TableCell>
										<TableCell className="text-end tabular-nums">
											{dish.quantity}
										</TableCell>
										<TableCell className="text-end tabular-nums">
											{money(dish.priceMinor)}
										</TableCell>
										<TableCell className="text-end tabular-nums">
											{money(dish.costMinor)}
										</TableCell>
										<TableCell className="text-end tabular-nums">
											{money(dish.unitMarginMinor)}
										</TableCell>
										<TableCell className="text-end tabular-nums">
											{money(dish.marginMinor)}
										</TableCell>
										<TableCell className="text-end tabular-nums">
											{dish.popularityPercent}%
										</TableCell>
										<TableCell>
											<Badge variant="outline" data-testid={`profit-group-${dish.itemId}`}>
												{groupLabel[dish.group]}
											</Badge>
										</TableCell>
										<TableCell className="text-muted-foreground max-w-xs text-xs">
											{suggestion(dish)}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</div>
				)}
			</WorkspacePanel>

			{result.unlisted.length > 0 ? (
				<WorkspacePanel
					title={<Trans>Without a recipe or a whole cost</Trans>}
					data-testid="profit-unlisted"
				>
					<p className="text-muted-foreground mb-3 text-sm">
						<Trans>
							These dishes have no recipe or typed cost, or only part of a
							cost, so they are not labelled.
						</Trans>
					</p>
					<ul className="flex flex-col gap-1 text-sm">
						{result.unlisted.map((dish) => (
							<li key={dish.itemId} className="flex justify-between gap-3">
								<span>{byId.get(dish.itemId)?.name ?? dish.itemId}</span>
								<span className="text-muted-foreground tabular-nums">
									<Trans>{dish.quantity} sold</Trans>
								</span>
							</li>
						))}
					</ul>
				</WorkspacePanel>
			) : null}
		</div>
	)
}
