import { Trans, useLingui } from '@lingui/react/macro'
import { type PlateCost } from '@repo/inventory'
import { Button } from '@repo/ui/button'
import {
	Frame,
	FrameDescription,
	FrameHeader,
	FramePanel,
	FrameTitle,
} from '@repo/ui/frame'
import { Skeleton } from '@repo/ui/skeleton'
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
	useState,
} from 'react'
import {
	InventoryClientContext,
	InventoryClientProvider,
} from '#app/components/inventory/inventory-client-provider.tsx'
import { InventoryPrefsProvider } from '#app/components/inventory/inventory-prefs.tsx'
import {
	FoodCostDot,
	RecipeSection,
} from '#app/components/inventory/recipe-section.tsx'
import { useRecipeAccess } from '#app/hooks/use-recipe-access.ts'
import { useRecipeCosts } from '#app/hooks/use-recipe-costs.ts'
import { formatMoney } from '#app/utils/inventory/format.ts'
import {
	formatPercentBp,
	majorToMinor,
	plateView,
	regionCurrency,
} from '#app/utils/inventory/recipe-form.ts'

/**
 * Menu editors are control-plane forms; recipes are regional. The panels in
 * this file are self-contained islands that talk to the region through the
 * inventory client with their own state and Save. `RecipeScope` gives the
 * panels of one page a single client, one settings read and a counter that a
 * save bumps (so the summary in the side column refreshes). Inside a client
 * that already exists (the Inventory layout, tests) it reuses it. It renders
 * only what it is given while recipes are off for the member.
 */
type ScopeValue = { revision: number; bump: () => void }
const ScopeContext = createContext<ScopeValue | null>(null)

export function useRecipeRevision(): number {
	return useContext(ScopeContext)?.revision ?? 0
}

export function useBumpRecipes(): () => void {
	return useContext(ScopeContext)?.bump ?? (() => {})
}

export function RecipeScope({
	orgSlug,
	dataRegion,
	active = true,
	children,
}: {
	orgSlug: string
	dataRegion: string | null | undefined
	/** False where there is nothing to load (a page for a new item). */
	active?: boolean
	children: ReactNode
}) {
	const access = useRecipeAccess()
	const outer = useContext(ScopeContext)
	const existing = useContext(InventoryClientContext)
	const [revision, setRevision] = useState(0)
	const bump = useCallback(() => setRevision((value) => value + 1), [])
	const value = useMemo(() => ({ revision, bump }), [revision, bump])
	if (outer || !active || !access.enabled) return <>{children}</>
	const region = dataRegion === 'ksa' ? 'ksa' : 'us'
	const inner = (
		<InventoryPrefsProvider dataRegion={region}>
			{children}
		</InventoryPrefsProvider>
	)
	return (
		<ScopeContext.Provider value={value}>
			{existing ? (
				inner
			) : (
				<InventoryClientProvider orgSlug={orgSlug}>
					{inner}
				</InventoryClientProvider>
			)}
		</ScopeContext.Provider>
	)
}

export type RecipeVariant = {
	/** The variant id (`ownerKind: 'variant'`). */
	id: string
	/** "Large / Thin crust". */
	label: string
	/** Its menu price in major units. */
	priceMajor: number
}

/**
 * "Ingredients and cost" for a menu item, in the item editor's form body.
 * Renders nothing when recipes are off or not permitted, and again when the
 * region answers 403, 404 or `feature_disabled`. Read-only without the recipe
 * grant. A new item (no id yet) only gets a note.
 */
export function RecipePanel({
	orgSlug,
	itemId,
	dataRegion,
	priceMajor,
	variants = [],
}: {
	orgSlug: string
	/** Null on the new-item page: there is nothing to attach a recipe to yet. */
	itemId: string | null
	dataRegion: string | null | undefined
	/** The menu form's current base price, in major units. */
	priceMajor: number
	/** The sizes the item has as saved. */
	variants?: readonly RecipeVariant[]
}) {
	const access = useRecipeAccess()
	const [hidden, setHidden] = useState(false)
	if (!access.enabled || hidden) return null

	return (
		<Frame className="w-full" data-testid="recipe-panel">
			<FrameHeader>
				<FrameTitle className="text-base">
					<Trans>Ingredients and cost</Trans>
				</FrameTitle>
				<FrameDescription>
					<Trans>
						What goes into one dish, so you can see what it costs to make and
						your food cost.
					</Trans>
				</FrameDescription>
			</FrameHeader>
			<FramePanel>
				{itemId === null ? (
					<p
						className="text-muted-foreground text-sm"
						data-testid="recipe-panel-new-note"
					>
						<Trans>
							Save this item first. Then you can add its ingredients here.
						</Trans>
					</p>
				) : (
					<RecipeScope orgSlug={orgSlug} dataRegion={dataRegion}>
						<ItemRecipe
							itemId={itemId}
							dataRegion={dataRegion}
							priceMajor={priceMajor}
							variants={variants}
							canEdit={access.canEdit}
							canTypeCost={access.canTypeCost}
							locationId={access.locationId}
							onHidden={() => setHidden(true)}
						/>
					</RecipeScope>
				)}
			</FramePanel>
		</Frame>
	)
}

function ItemRecipe({
	itemId,
	dataRegion,
	priceMajor,
	variants,
	canEdit,
	canTypeCost,
	locationId,
	onHidden,
}: {
	itemId: string
	dataRegion: string | null | undefined
	priceMajor: number
	variants: readonly RecipeVariant[]
	canEdit: boolean
	canTypeCost: boolean
	locationId: string
	onHidden: () => void
}) {
	const currency = regionCurrency(dataRegion)
	const hasSizes = variants.length > 0
	const bump = useBumpRecipes()
	const revision = useRecipeRevision()
	const refs = useMemo(
		() =>
			variants.map((variant) => ({
				key: variant.id,
				itemId,
				variantId: variant.id,
			})),
		[variants, itemId],
	)
	const costs = useRecipeCosts(refs, currency, hasSizes, revision)
	return (
		<div className="flex flex-col gap-6">
			<RecipeSection
				ownerKind="menu_item"
				ownerId={itemId}
				idPrefix="recipe"
				canEdit={canEdit}
				canTypeCost={canTypeCost}
				locationId={locationId}
				currency={currency}
				priceMinor={hasSizes ? null : majorToMinor(priceMajor, currency)}
				showSummary
				onHidden={onHidden}
				onSaved={bump}
				bare
				intro={
					hasSizes ? (
						<Trans>
							The recipe for one dish. Each size below uses it as it is, a
							multiple of it, or its own ingredients.
						</Trans>
					) : undefined
				}
			/>
			{hasSizes ? (
				<Sizes
					variants={variants}
					currency={currency}
					costs={costs}
					canEdit={canEdit}
					canTypeCost={canTypeCost}
					locationId={locationId}
					onSaved={bump}
				/>
			) : null}
		</div>
	)
}

function Sizes({
	variants,
	currency,
	costs,
	canEdit,
	canTypeCost,
	locationId,
	onSaved,
}: {
	variants: readonly RecipeVariant[]
	currency: string
	costs: ReturnType<typeof useRecipeCosts>
	canEdit: boolean
	canTypeCost: boolean
	locationId: string
	onSaved: () => void
}) {
	const { t, i18n } = useLingui()
	const [open, setOpen] = useState<string | null>(null)
	return (
		<section className="flex flex-col gap-2" aria-labelledby="recipe-sizes">
			<h3 id="recipe-sizes" className="text-sm font-semibold">
				<Trans>Sizes</Trans>
			</h3>
			{costs.loading && !costs.rows ? (
				<Skeleton className="h-10 w-full" />
			) : null}
			<ul className="flex flex-col gap-2" data-testid="recipe-sizes">
				{variants.map((variant) => {
					const row = costs.rows?.get(variant.id)
					const priceMinor = majorToMinor(variant.priceMajor, currency)
					const plate: PlateCost | undefined =
						row && row.costMinor !== undefined
							? {
									state: row.state,
									costMinor: row.costMinor,
									currency: row.currency,
									missingItemIds: [],
									typedCostMinor: undefined,
								}
							: undefined
					const isOpen = open === variant.id
					const label = variant.label
					return (
						<li
							key={variant.id}
							className="flex flex-col gap-3 rounded-lg border p-3"
							data-testid={`recipe-size-${variant.id}`}
						>
							<div className="flex flex-wrap items-center justify-between gap-2">
								<span className="flex min-w-0 flex-col">
									<span className="text-sm font-medium wrap-anywhere">
										{label}
									</span>
									<span className="text-muted-foreground text-xs tabular-nums">
										<bdi dir="ltr">
											{formatMoney(priceMinor, currency, i18n.locale)}
										</bdi>
									</span>
								</span>
								<span className="flex items-center gap-3 text-sm">
									{row?.costMinor !== undefined ? (
										<span className="tabular-nums">
											<bdi dir="ltr">
												{formatMoney(
													row.costMinor,
													row.currency ?? currency,
													i18n.locale,
												)}
											</bdi>
										</span>
									) : null}
									{row?.foodCostBp !== undefined ? (
										<span className="flex items-center gap-1.5 tabular-nums">
											<bdi dir="ltr">
												{formatPercentBp(row.foodCostBp, i18n.locale)}
											</bdi>
											{row.status ? <FoodCostDot status={row.status} /> : null}
										</span>
									) : null}
									<Button
										type="button"
										variant="outline"
										size="sm"
										aria-expanded={isOpen}
										onClick={() => setOpen(isOpen ? null : variant.id)}
										data-testid={`recipe-size-${variant.id}-toggle`}
									>
										{isOpen ? (
											<Trans>Close</Trans>
										) : canEdit ? (
											<Trans>Edit size</Trans>
										) : (
											<Trans>View</Trans>
										)}
									</Button>
								</span>
							</div>
							{isOpen ? (
								<RecipeSection
									ownerKind="variant"
									ownerId={variant.id}
									idPrefix={`recipe-size-${variant.id}`}
									canEdit={canEdit}
									canTypeCost={canTypeCost}
									locationId={locationId}
									currency={currency}
									priceMinor={priceMinor}
									showSummary
									plateOverride={plate}
									onSaved={onSaved}
									bare
									heading={t`Ingredients for ${label}`}
								/>
							) : null}
						</li>
					)
				})}
			</ul>
		</section>
	)
}

/**
 * The side column of the item editor: what one dish costs to make and its
 * food cost, from one costs call (so it needs no recipe read of its own) and
 * refreshed when a recipe is saved. Nothing for a new item, while recipes are
 * off, or when the region leaves the money out.
 */
export function RecipeAside({
	itemId,
	dataRegion,
	priceMajor,
	hasSizes,
}: {
	itemId: string | null
	dataRegion: string | null | undefined
	priceMajor: number
	hasSizes: boolean
}) {
	const access = useRecipeAccess()
	// The costs hook needs the inventory client, which only exists in a scope
	// that recipes are on for.
	if (!access.enabled || itemId === null) return null
	return (
		<RecipeAsideBody
			itemId={itemId}
			dataRegion={dataRegion}
			priceMajor={priceMajor}
			hasSizes={hasSizes}
		/>
	)
}

function RecipeAsideBody({
	itemId,
	dataRegion,
	priceMajor,
	hasSizes,
}: {
	itemId: string
	dataRegion: string | null | undefined
	priceMajor: number
	hasSizes: boolean
}) {
	const currency = regionCurrency(dataRegion)
	const revision = useRecipeRevision()
	// Ask for the cost only: the food cost is worked out here from the price
	// as it is typed, so typing a price makes no request.
	const refs = useMemo(() => [{ key: 'item', itemId }], [itemId])
	const costs = useRecipeCosts(refs, currency, true, revision)
	const { i18n } = useLingui()
	const row = costs.rows?.get('item')
	if (costs.unavailable) return null
	if (!row || !row.hasRecipe || row.costMinor === undefined) return null
	const view = plateView(
		{
			state: row.state,
			costMinor: row.costMinor,
			currency: row.currency,
			missingItemIds: [],
		},
		{
			priceMinor:
				hasSizes || !(priceMajor > 0)
					? null
					: majorToMinor(priceMajor, currency),
			targetBp: costs.targetBp,
			currency,
		},
	)
	return (
		<Frame className="w-full" data-testid="recipe-aside">
			<FrameHeader>
				<FrameTitle className="text-base">
					<Trans>Cost to make</Trans>
				</FrameTitle>
			</FrameHeader>
			<FramePanel>
				<dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
					<dt className="text-muted-foreground">
						{row.state === 'partial' ? (
							<Trans>Cost (at least)</Trans>
						) : (
							<Trans>Cost</Trans>
						)}
					</dt>
					<dd className="tabular-nums" data-testid="recipe-aside-cost">
						<bdi dir="ltr">
							{formatMoney(row.costMinor, view.currency, i18n.locale)}
						</bdi>
					</dd>
					{view.foodCostBp !== null ? (
						<>
							<dt className="text-muted-foreground">
								<Trans>Food cost</Trans>
							</dt>
							<dd
								className="flex items-center gap-2 tabular-nums"
								data-testid="recipe-aside-food-cost"
							>
								<bdi dir="ltr">
									{formatPercentBp(view.foodCostBp, i18n.locale)}
								</bdi>
								{view.status ? <FoodCostDot status={view.status} /> : null}
							</dd>
						</>
					) : null}
				</dl>
			</FramePanel>
		</Frame>
	)
}

/**
 * "Ingredient effect" for a modifier option: what choosing it adds to a dish,
 * or which ingredient it swaps for another. Same fail-closed rules and its
 * own Save as the dish panel.
 */
export function OptionRecipePanel({
	orgSlug,
	optionId,
	dataRegion,
	isTopping,
}: {
	orgSlug: string
	/** Null on the new-option page. */
	optionId: string | null
	dataRegion: string | null | undefined
	/** A topping on a pizza: halves use half of it. */
	isTopping: boolean
}) {
	const access = useRecipeAccess()
	const [hidden, setHidden] = useState(false)
	if (!access.enabled || hidden) return null
	const currency = regionCurrency(dataRegion)
	return (
		<Frame className="w-full" data-testid="option-recipe-panel">
			<FrameHeader>
				<FrameTitle className="text-base">
					<Trans>Ingredient effect</Trans>
				</FrameTitle>
				<FrameDescription>
					<Trans>
						What choosing this option adds to the dish, or which ingredient it
						replaces.
					</Trans>
				</FrameDescription>
			</FrameHeader>
			<FramePanel>
				{optionId === null ? (
					<p
						className="text-muted-foreground text-sm"
						data-testid="recipe-panel-new-note"
					>
						<Trans>
							Save this option first. Then you can say which ingredients it
							uses.
						</Trans>
					</p>
				) : (
					<RecipeScope orgSlug={orgSlug} dataRegion={dataRegion}>
						<RecipeSection
							ownerKind="option"
							ownerId={optionId}
							idPrefix="option-recipe"
							canEdit={access.canEdit}
							canTypeCost={false}
							locationId={access.locationId}
							currency={currency}
							onHidden={() => setHidden(true)}
							bare
							addLabel={undefined}
							footnote={
								isTopping ? (
									<Trans>Half pizzas use half of this.</Trans>
								) : undefined
							}
						/>
					</RecipeScope>
				)}
			</FramePanel>
		</Frame>
	)
}
