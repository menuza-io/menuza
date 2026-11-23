import { Plural, Trans, useLingui } from '@lingui/react/macro'
import {
	dishFoodCostBp,
	type MenuPriceTax,
	type PriceAlert,
	type PriceAlerts,
} from '@repo/inventory'
import { cn } from '@repo/ui'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Skeleton } from '@repo/ui/skeleton'
import { WorkspacePanel } from '@repo/ui/workspace'
import { useMemo } from 'react'
import { Link } from 'react-router'
import { type InventoryQuery } from '#app/hooks/use-inventory-client.ts'
import { formatMoney } from '#app/utils/inventory/format.ts'
import { inventoryErrorMessage } from '#app/utils/inventory/inventory-errors.ts'
import {
	formatPercentBp,
	majorToMinor,
} from '#app/utils/inventory/recipe-form.ts'
import { percentFromBp } from '#app/utils/inventory/today-view.ts'

const SHOWN = 5

export type PriceAlertMenuDish = {
	id: string
	name: string
	price: number
	variants?: Array<{ id: string; name: string; price: number }>
}

type ResolvedDishMenu = {
	menuItemId: string
	name: string
	price: number
}

function buildMenuLookup(menuDishes: readonly PriceAlertMenuDish[]) {
	const byItemId = new Map<string, ResolvedDishMenu>()
	const byVariantId = new Map<string, ResolvedDishMenu>()
	for (const dish of menuDishes) {
		byItemId.set(dish.id, {
			menuItemId: dish.id,
			name: dish.name,
			price: dish.price,
		})
		for (const variant of dish.variants ?? []) {
			byVariantId.set(variant.id, {
				menuItemId: dish.id,
				name: variant.name,
				price: variant.price,
			})
		}
	}
	return { byItemId, byVariantId }
}

function PriceAlertRow({
	alert,
	href,
	orgSlug,
	currency,
	menuLookup,
}: {
	alert: PriceAlert
	href: string
	orgSlug: string
	currency: string
	menuLookup: ReturnType<typeof buildMenuLookup>
}) {
	const { i18n } = useLingui()
	const name = alert.itemName
	const supplier = alert.supplierName
	const percent = percentFromBp(alert.changeBp)
	const pack = alert.packName
	const was =
		alert.previousPackPriceMinor !== null
			? formatMoney(alert.previousPackPriceMinor, currency, i18n.locale)
			: null
	const now =
		alert.packPriceMinor !== null
			? formatMoney(alert.packPriceMinor, currency, i18n.locale)
			: null
	const dishesCount = alert.affectedDishes
	const affectedDishes = alert.dishes ?? []
	const tax: MenuPriceTax = {
		pricesIncludeTax: alert.pricesIncludeTax ?? false,
		taxRateBp: alert.taxRateBp ?? null,
	}
	const targetBp = alert.targetFoodCostBp ?? null
	return (
		<li
			className="flex flex-col gap-3 p-3"
			data-testid={`price-alert-${alert.itemId}`}
		>
			<div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
				<div className="flex min-w-0 flex-col gap-1">
					<p className="text-sm text-pretty">
						<span className="font-medium wrap-anywhere">{name}</span>{' '}
						<Trans>
							went up <bdi dir="ltr">{percent}%</bdi>
						</Trans>
						{supplier ? (
							<>
								{' '}
								<Trans>
									at <span className="wrap-anywhere">{supplier}</span>
								</Trans>
							</>
						) : null}
						.{' '}
						{was && now && pack ? (
							<span className="text-muted-foreground">
								<Trans>
									A {pack} was <bdi dir="ltr">{was}</bdi>, now{' '}
									<bdi dir="ltr">{now}</bdi>.
								</Trans>
							</span>
						) : null}{' '}
						{dishesCount !== null && dishesCount > 0 ? (
							<span className="text-muted-foreground">
								<Plural
									value={dishesCount}
									one="# dish costs more now."
									other="# dishes cost more now."
								/>
							</span>
						) : null}
					</p>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					{alert.severity === 'big' ? (
						<Badge variant="destructive">
							<Trans>Big rise</Trans>
						</Badge>
					) : null}
					<Button
						variant="outline"
						size="sm"
						render={<Link to={href} />}
						data-testid={`price-alert-link-${alert.itemId}`}
					>
						<Trans>See delivery</Trans>
					</Button>
				</div>
			</div>

			{affectedDishes.length > 0 ? (
				<ul
					className="flex flex-col gap-1.5"
					data-testid={`price-alert-dishes-${alert.itemId}`}
				>
					{affectedDishes.map((dish) => {
						const resolved = dish.variantId
							? menuLookup.byVariantId.get(dish.variantId)
							: dish.menuItemId
								? menuLookup.byItemId.get(dish.menuItemId)
								: undefined
						const resolvedMenuItemId = resolved?.menuItemId ?? dish.menuItemId
						const dishKey = resolvedMenuItemId ?? dish.variantId ?? 'unknown'
						const dishName =
							resolved?.name || resolvedMenuItemId || dish.variantId || ''
						const sellingPriceMinor = resolved
							? majorToMinor(resolved.price, currency)
							: null
						const oldFoodCostBp =
							sellingPriceMinor !== null
								? dishFoodCostBp(sellingPriceMinor, dish.previousCostMinor, tax)
								: null
						const newFoodCostBp =
							sellingPriceMinor !== null
								? dishFoodCostBp(sellingPriceMinor, dish.costMinor, tax)
								: null
						const isOverTarget =
							targetBp !== null &&
							newFoodCostBp !== null &&
							newFoodCostBp > targetBp
						const crossedTarget =
							targetBp !== null &&
							oldFoodCostBp !== null &&
							newFoodCostBp !== null &&
							oldFoodCostBp <= targetBp &&
							newFoodCostBp > targetBp
						const menuEditorHref = resolvedMenuItemId
							? `/${orgSlug}/menu/items/${encodeURIComponent(resolvedMenuItemId)}`
							: `/${orgSlug}/menu/items`
						const targetPriceText =
							dish.priceForTargetMinor !== null
								? formatMoney(dish.priceForTargetMinor, currency, i18n.locale)
								: null
						return (
							<li
								key={`${dish.menuItemId ?? ''}:${dish.variantId ?? ''}`}
								data-testid={`price-alert-dish-${dishKey}`}
								className={cn(
									'flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs',
									crossedTarget
										? 'border-destructive/40 bg-destructive/5'
										: isOverTarget
											? 'border-warning/40 bg-warning/5'
											: 'bg-muted/30',
								)}
							>
								<div className="flex min-w-0 flex-wrap items-center gap-2">
									<Link
										to={menuEditorHref}
										className="focus-visible:ring-ring/50 rounded-sm font-medium wrap-anywhere underline-offset-4 outline-none hover:underline focus-visible:ring-3"
										data-testid={`price-alert-dish-link-${dishKey}`}
									>
										{dishName}
									</Link>
									{crossedTarget ? (
										<Badge
											variant="destructive"
											data-testid={`price-alert-dish-over-target-${dishKey}`}
										>
											<Trans>Crossed target</Trans>
										</Badge>
									) : isOverTarget ? (
										<Badge
											variant="warning"
											data-testid={`price-alert-dish-over-target-${dishKey}`}
										>
											<Trans>Over target</Trans>
										</Badge>
									) : null}
								</div>
								<div className="flex flex-wrap items-center gap-3 tabular-nums">
									{oldFoodCostBp !== null && newFoodCostBp !== null ? (
										<span data-testid={`price-alert-dish-food-cost-${dishKey}`}>
											<bdi dir="ltr">
												{formatPercentBp(oldFoodCostBp, i18n.locale)} →{' '}
												{formatPercentBp(newFoodCostBp, i18n.locale)}
											</bdi>
										</span>
									) : (
										<span className="text-muted-foreground">
											<bdi dir="ltr">
												{formatMoney(
													dish.previousCostMinor,
													currency,
													i18n.locale,
												)}{' '}
												→ {formatMoney(dish.costMinor, currency, i18n.locale)}
											</bdi>
										</span>
									)}
									{targetPriceText !== null ? (
										<span
											className="text-muted-foreground"
											data-testid={`price-alert-dish-target-price-${dishKey}`}
										>
											<Trans>
												Target price: <bdi dir="ltr">{targetPriceText}</bdi>
											</Trans>
										</span>
									) : null}
									<Link
										to={menuEditorHref}
										className="text-primary focus-visible:ring-ring/50 rounded-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-3"
										data-testid={`price-alert-dish-edit-price-${dishKey}`}
									>
										<Trans>Edit price</Trans>
									</Link>
								</div>
							</li>
						)
					})}
				</ul>
			) : null}
		</li>
	)
}

/**
 * "Prices went up": items whose last delivery cost more than 5% over the one
 * before. The whole answer is money, so it is asked for only with the cost
 * grant; the region answers 403 otherwise.
 */
export function PriceAlertsPanel({
	query,
	orgSlug,
	basePath,
	search,
	currency,
	dishes = [],
}: {
	query: InventoryQuery<PriceAlerts>
	orgSlug?: string
	basePath: string
	search: string
	currency: string
	dishes?: readonly PriceAlertMenuDish[]
}) {
	const { i18n } = useLingui()
	const alerts = query.data?.alerts ?? []
	const resolvedOrgSlug =
		orgSlug ?? basePath.replace(/^\/|\/inventory\/purchasing$/g, '')
	const menuLookup = useMemo(() => buildMenuLookup(dishes), [dishes])
	// A quiet panel: no rises (or a failed read) leaves the page without it.
	if (query.error && !query.data) {
		return (
			<WorkspacePanel title={<Trans>Prices went up</Trans>}>
				<Alert variant="destructive" data-testid="price-alerts-error">
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
			</WorkspacePanel>
		)
	}
	if (!query.data) return <Skeleton className="h-10 w-full" />
	if (alerts.length === 0) return null
	return (
		<WorkspacePanel title={<Trans>Prices went up</Trans>}>
			<ul
				className="flex flex-col divide-y rounded-xl border"
				data-testid="price-alerts"
			>
				{alerts.slice(0, SHOWN).map((alert) => (
					<PriceAlertRow
						key={`${alert.itemId}-${alert.deliveryId}`}
						alert={alert}
						href={`${basePath}/deliveries/${encodeURIComponent(alert.deliveryId)}${search}`}
						orgSlug={resolvedOrgSlug}
						currency={query.data?.currency ?? currency}
						menuLookup={menuLookup}
					/>
				))}
			</ul>
		</WorkspacePanel>
	)
}
