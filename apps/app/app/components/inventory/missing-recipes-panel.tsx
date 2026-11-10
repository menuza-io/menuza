import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { dishesWithoutRecipeResultSchema } from '@repo/inventory'
import { Alert, AlertAction, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { Skeleton } from '@repo/ui/skeleton'
import { WorkspacePanel } from '@repo/ui/workspace'
import { Link } from 'react-router'
import { EmptyState } from '#app/components/empty-state.tsx'
import { useInventoryQuery } from '#app/hooks/use-inventory-client.ts'
import { formatMoney } from '#app/utils/inventory/format.ts'
import { isRecipesUnavailable } from '#app/utils/inventory/inventory-errors.ts'

/** A menu item as the Today loader names it (the region only knows ids). */
export type MenuDishName = { id: string; name: string; price: number }

const DAYS = 30
const LIMIT = 10

/**
 * "Dishes without a recipe": what sold most in the last 30 days and has no
 * recipe, so the owner sets up the top ones first. The region returns ids and
 * numbers only; the names are joined here from the menu items the loader
 * sends. Each row opens that dish's editor.
 */
export function MissingRecipesPanel({
	orgSlug,
	locationId,
	dishes,
	currency,
}: {
	orgSlug: string
	locationId: string
	dishes: readonly MenuDishName[]
	currency: string
}) {
	const { i18n } = useLingui()
	const missing = useInventoryQuery(
		`/recipes/missing?${new URLSearchParams({ locationId, days: String(DAYS), limit: String(LIMIT) })}`,
		dishesWithoutRecipeResultSchema,
	)
	// The panel only exists for members who may see recipes: if the region says
	// otherwise, it goes away quietly.
	if (missing.error && isRecipesUnavailable(missing.error)) return null

	const names = new Map(dishes.map((dish) => [dish.id, dish]))
	const rows = (missing.data?.dishes ?? []).flatMap((dish) => {
		const menu = names.get(dish.itemId)
		return menu ? [{ ...dish, name: menu.name }] : []
	})
	const more = missing.data ? Math.max(0, missing.data.total - rows.length) : 0

	return (
		<WorkspacePanel
			title={<Trans>Dishes without a recipe</Trans>}
			data-testid="today-missing-recipes"
		>
			{missing.loading && !missing.data ? (
				<Skeleton className="h-24 w-full rounded-xl" />
			) : missing.error && !missing.data ? (
				<Alert variant="destructive" data-testid="today-missing-recipes-error">
					<AlertDescription>
						<Trans>
							We could not load your dishes. Check your connection and try
							again.
						</Trans>
					</AlertDescription>
					<AlertAction>
						<Button type="button" variant="outline" onClick={missing.reload}>
							<Trans>Try again</Trans>
						</Button>
					</AlertAction>
				</Alert>
			) : rows.length === 0 && more === 0 ? (
				<EmptyState
					icons={['check-circle']}
					title={<Trans>Every dish you sell has a recipe.</Trans>}
					description={
						<Trans>
							Dishes that sell without a recipe will show up here, best sellers
							first.
						</Trans>
					}
				/>
			) : (
				<div className="flex flex-col gap-3">
					<p className="text-muted-foreground text-sm">
						<Trans>
							Best sellers of the last 30 days first. Add a recipe to see what
							each one costs and to take stock off when it sells.
						</Trans>
					</p>
					<ul
						className="flex flex-col divide-y rounded-xl border"
						data-testid="today-missing-recipes-list"
					>
						{rows.map((dish) => (
							<li
								key={dish.itemId}
								className="flex flex-wrap items-center justify-between gap-3 p-3"
								data-testid={`today-missing-recipe-${dish.itemId}`}
							>
								<span className="flex min-w-0 flex-col">
									<span className="text-sm font-medium wrap-anywhere">
										{dish.name}
									</span>
									<span className="text-muted-foreground text-xs">
										<Plural value={dish.quantity} one="# sold" other="# sold" />
										{dish.netSalesMinor !== undefined ? (
											<>
												{' · '}
												<bdi dir="ltr" className="tabular-nums">
													{formatMoney(
														dish.netSalesMinor,
														dish.currency ?? currency,
														i18n.locale,
													)}
												</bdi>
											</>
										) : null}
									</span>
								</span>
								<Button
									variant="outline"
									size="sm"
									render={<Link to={`/${orgSlug}/menu/items/${dish.itemId}`} />}
								>
									<Trans>Add recipe</Trans>
								</Button>
							</li>
						))}
					</ul>
					{more > 0 ? (
						<p
							className="text-muted-foreground text-xs"
							data-testid="today-missing-recipes-more"
						>
							<Plural
								value={more}
								one="and # more dish without a recipe"
								other="and # more dishes without a recipe"
							/>
						</p>
					) : null}
				</div>
			)}
		</WorkspacePanel>
	)
}
