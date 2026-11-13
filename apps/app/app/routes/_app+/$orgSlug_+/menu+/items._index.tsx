import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { requireUserId } from '@repo/auth'
import {
	getLocalizedMenuValue,
	parseMenuVariations,
} from '@repo/common/menu-types'
import {
	db,
	eq,
	asc,
	desc,
	and,
	OrganizationMenuItem,
	OrganizationMenuCategory,
	OrganizationMenuModifierGroup,
	OrganizationLocation,
} from '@repo/database'
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from '@repo/ui/alert-dialog'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@repo/ui/dropdown-menu'
import { Filters, type FilterField } from '@repo/ui/filters'
import { Frame } from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import { PageHeader } from '@repo/ui/page-header'
import {
	Table,
	TableBody,
	TableCell,
	TableFooter,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { useCallback, useMemo, useState } from 'react'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	Link,
	useFetcher,
	useLoaderData,
	useRevalidator,
} from 'react-router'
import { z } from 'zod'
import { EmptyState } from '#app/components/empty-state.tsx'
import {
	FoodCostCell,
	FoodCostFooterCell,
	FoodCostHead,
	FoodCostProvider,
} from '#app/components/inventory/food-cost-column.tsx'
import { MenuDeleteEffects } from '#app/components/menu/delete-effects.tsx'
import { MenuBulkBar } from '#app/components/menu/menu-bulk-bar.tsx'
import { MenuBulkEditSheet } from '#app/components/menu/menu-bulk-edit-sheet.tsx'
import {
	MenuDuplicateDialog,
	type MenuDuplicateEntity,
} from '#app/components/menu/menu-duplicate-dialog.tsx'
import { MenuHealthFilterNotice } from '#app/components/menu/menu-health-card.tsx'
import { useMenuListFilters } from '#app/components/menu/menu-list-filters.tsx'
import { MenuStatusBadge } from '#app/components/menu/menu-status-badge.tsx'
import { useMenuListSelection } from '#app/components/menu/use-menu-list-selection.ts'
import {
	requireMenuRead,
	requireMenuWrite,
} from '#app/utils/menu/access.server.ts'
import {
	currencyCodeForDataRegion,
	currencyExponentFor,
} from '#app/utils/menu/bulk-apply.server.ts'
import { deleteMenuEntityReferences } from '#app/utils/menu/cleanup.server.ts'
import {
	getMenuBulkEditEnabled,
	getMenuHistoryEnabled,
} from '#app/utils/menu/menu-feature-access.server.ts'
import { computeMenuHealthFor } from '#app/utils/menu/menu-health.server.ts'
import {
	MENU_HEALTH_CATEGORY_CHECKS,
	MENU_HEALTH_PARAM,
	parseMenuHealthCheckKey,
} from '#app/utils/menu/menu-health.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'

const DeleteItemSchema = z.object({
	intent: z.literal('delete-item'),
	itemId: z.string().min(1),
})

const ITEM_FILTER_FIELDS: FilterField[] = [
	{
		id: 'name',
		label: 'Name',
		type: 'text',
		defaultOperator: 'contains',
		placeholder: 'Enter an item name',
		icon: <Icon name="file-text" className="size-3.5" />,
	},
	{
		id: 'internalName',
		label: 'Internal name',
		type: 'text',
		defaultOperator: 'contains',
		placeholder: 'Enter an internal name',
		icon: <Icon name="tag" className="size-3.5" />,
	},
	{
		id: 'status',
		label: 'Status',
		type: 'select',
		defaultOperator: 'is_any_of',
		searchable: false,
		icon: <Icon name="circle-check" className="size-3.5" />,
		options: [
			{ value: 'available', label: 'Available' },
			{ value: 'unavailable', label: 'Unavailable' },
		],
	},
	{
		id: 'attributes',
		label: 'Attributes',
		type: 'multiselect',
		defaultOperator: 'has_any_of',
		searchable: false,
		icon: <Icon name="star" className="size-3.5" />,
		options: [
			{ value: 'popular', label: 'Popular' },
			{ value: 'upsell', label: 'Upsell' },
			{ value: 'vegetarian', label: 'Vegetarian' },
			{ value: 'gluten_free', label: 'Gluten-free' },
			{ value: 'alcohol', label: 'Alcohol' },
		],
	},
]

export async function action({ request, params }: ActionFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
	})

	await requireMenuWrite(request, organization.id)

	const formData = await request.formData()
	const result = DeleteItemSchema.safeParse(Object.fromEntries(formData))

	if (!result.success) {
		return Response.json({ error: 'Invalid request' }, { status: 400 })
	}

	await db.transaction(async (tx) => {
		await tx
			.delete(OrganizationMenuItem)
			.where(
				and(
					eq(OrganizationMenuItem.id, result.data.itemId),
					eq(OrganizationMenuItem.organizationId, organization.id),
				),
			)

		await deleteMenuEntityReferences(
			organization.id,
			'item',
			result.data.itemId,
			tx,
		)
	})

	await purgeOrganizationSiteCache(organization.id, organization.slug)

	return Response.json({ success: true })
}

export async function loader({ request, params }: LoaderFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		dataRegion: true,
		siteDefaultLocale: true,
		siteLocales: true,
	})

	await requireMenuRead(request, organization.id)
	const [menuBulkEditEnabled, menuHistoryEnabled] = await Promise.all([
		getMenuBulkEditEnabled(organization.id),
		getMenuHistoryEnabled(organization.id),
	])

	const defaultLocale = organization.siteDefaultLocale ?? 'en'
	const bulkCatalogPromise = menuBulkEditEnabled
		? Promise.all([
				db
					.select({
						id: OrganizationLocation.id,
						name: OrganizationLocation.name,
					})
					.from(OrganizationLocation)
					.where(eq(OrganizationLocation.organizationId, organization.id))
					.orderBy(OrganizationLocation.name),
				db
					.select({
						id: OrganizationMenuCategory.id,
						displayName: OrganizationMenuCategory.displayName,
					})
					.from(OrganizationMenuCategory)
					.where(eq(OrganizationMenuCategory.organizationId, organization.id))
					.orderBy(asc(OrganizationMenuCategory.position)),
				db
					.select({
						id: OrganizationMenuModifierGroup.id,
						name: OrganizationMenuModifierGroup.name,
					})
					.from(OrganizationMenuModifierGroup)
					.where(
						eq(OrganizationMenuModifierGroup.organizationId, organization.id),
					)
					.orderBy(asc(OrganizationMenuModifierGroup.position)),
			])
		: null
	const items = await db.query.OrganizationMenuItem.findMany({
		where: eq(OrganizationMenuItem.organizationId, organization.id),
		with: {
			categoryAssignments: {
				with: {
					category: true,
				},
			},
			modifierGroupAssignments: {
				with: {
					modifierGroup: true,
				},
			},
		},
		orderBy: [
			asc(OrganizationMenuItem.position),
			desc(OrganizationMenuItem.createdAt),
		],
	})

	// `?health=<check>` narrows the list to the dishes a Menu health line
	// counted, using the same function as the card.
	const healthKey = parseMenuHealthCheckKey(
		new URL(request.url).searchParams.get(MENU_HEALTH_PARAM),
	)
	const healthFilter =
		healthKey && !MENU_HEALTH_CATEGORY_CHECKS.has(healthKey)
			? {
					key: healthKey,
					itemIds:
						computeMenuHealthFor(organization, {
							items,
							categories: [],
							categoryIdsWithItems: [],
						}).checks.find((check) => check.key === healthKey)?.itemIds ?? [],
				}
			: null

	const bulkCatalog = bulkCatalogPromise
		? await bulkCatalogPromise
		: [[], [], []]
	const [bulkLocations, bulkCategories, bulkModifierGroups] = bulkCatalog

	return {
		organization: {
			id: organization.id,
			slug: organization.slug,
			dataRegion: organization.dataRegion,
		},
		defaultLocale,
		healthFilter,
		menuBulkEditEnabled,
		menuHistoryEnabled,
		currencyExponent: currencyExponentFor(
			currencyCodeForDataRegion(organization.dataRegion),
		),
		bulkLocations: bulkLocations.map((row) => ({
			id: row.id,
			label: row.name,
		})),
		bulkCategories: bulkCategories.map((row) => ({
			id: row.id,
			label: getLocalizedMenuValue(row.displayName, defaultLocale, defaultLocale),
		})),
		bulkModifierGroups: bulkModifierGroups.map((row) => ({
			id: row.id,
			label: getLocalizedMenuValue(row.name, defaultLocale, defaultLocale),
		})),
		items: items.map((i) => {
			let allergens: string[] = []
			try {
				if (i.allergens) allergens = JSON.parse(i.allergens) as string[]
			} catch {}

			return {
				id: i.id,
				displayName: i.displayName,
				internalName: i.internalName,
				price: i.price,
				variationCount: parseMenuVariations(i.variations).variants.length,
				imageUrl: i.imageUrl,
				isAlcohol: i.isAlcohol,
				isGlutenFree: i.isGlutenFree,
				isVegetarian: i.isVegetarian,
				isPopular: i.isPopular,
				isUpsell: i.isUpsell,
				allergens,
				calorieMin: i.calorieMin,
				calorieMax: i.calorieMax,
				availabilityStatus: i.availabilityStatus,
				unavailableUntil: i.unavailableUntil
					? i.unavailableUntil.toISOString()
					: null,
				categories: i.categoryAssignments.map((ca) => ({
					id: ca.category.id,
					displayName: ca.category.displayName,
				})),
				modifierGroupsCount: i.modifierGroupAssignments.length,
				updatedAt: i.updatedAt.toISOString(),
			}
		}),
	}
}

export default function ItemsIndexRoute() {
	const { organization, items } = useLoaderData<typeof loader>()
	// The Food cost column asks the region once for the whole list; it renders
	// nothing extra while recipes are off.
	return (
		<FoodCostProvider
			orgSlug={organization.slug}
			dataRegion={organization.dataRegion}
			items={items.map((item) => ({ id: item.id, priceMajor: item.price }))}
		>
			<ItemsIndexContent />
		</FoodCostProvider>
	)
}

function ItemsIndexContent() {
	const {
		organization,
		defaultLocale,
		items: allItems,
		healthFilter,
		menuBulkEditEnabled,
		menuHistoryEnabled,
		currencyExponent,
		bulkLocations,
		bulkCategories,
		bulkModifierGroups,
	} = useLoaderData<typeof loader>()
	const { _ } = useLingui()
	const deleteFetcher = useFetcher()
	const revalidator = useRevalidator()
	const [bulkOpen, setBulkOpen] = useState(false)
	const [duplicateEntity, setDuplicateEntity] = useState<MenuDuplicateEntity | null>(
		null,
	)
	const items = useMemo(() => {
		if (!healthFilter) return allItems
		const ids = new Set(healthFilter.itemIds)
		return allItems.filter((item) => ids.has(item.id))
	}, [allItems, healthFilter])
	const [deleteItemId, setDeleteItemId] = useState<string | null>(null)
	const getFieldValue = useCallback(
		(item: (typeof items)[number], field: string) => {
			switch (field) {
				case 'name':
					return getLocalizedMenuValue(
						item.displayName,
						defaultLocale,
						defaultLocale,
					)
				case 'internalName':
					return item.internalName ?? ''
				case 'status':
					return item.availabilityStatus
				case 'attributes':
					return [
						...(item.isPopular ? ['popular'] : []),
						...(item.isUpsell ? ['upsell'] : []),
						...(item.isVegetarian ? ['vegetarian'] : []),
						...(item.isGlutenFree ? ['gluten_free'] : []),
						...(item.isAlcohol ? ['alcohol'] : []),
					]
				default:
					return ''
			}
		},
		[defaultLocale],
	)
	const {
		filterQuery,
		filteredRecords: filteredItems,
		hasFilters,
		setFilterQuery,
	} = useMenuListFilters(items, ITEM_FILTER_FIELDS, getFieldValue)

	const {
		selectedIds,
		toggle,
		selectAllFiltered,
		clearSelection,
		allFilteredSelected,
		hasSelection,
	} = useMenuListSelection(filteredItems)

	const undoBulkSnapshot = useCallback(
		async (snapshotId: string) => {
			if (!menuHistoryEnabled) return
			await fetch(`/${organization.slug}/menu/history`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					intent: 'restore',
					snapshotId,
				}),
			})
			void revalidator.revalidate()
		},
		[menuHistoryEnabled, organization.slug, revalidator],
	)

	return (
		<div className="space-y-8">
			<PageHeader
				title={<Trans>Items</Trans>}
				description={
					<Trans>
						Create and manage your dishes, beverages, sides, and retail
						products.
					</Trans>
				}
				headingLevel="h2"
				size="section"
				actions={
					<Button render={<Link to={`/${organization.slug}/menu/items/new`} />}>
						<Icon name="plus" className="size-4" />
						<Trans>Create Item</Trans>
					</Button>
				}
			/>

			{healthFilter ? (
				<MenuHealthFilterNotice
					checkKey={healthFilter.key}
					count={items.length}
					clearTo={`/${organization.slug}/menu/items`}
				/>
			) : null}

			{allItems.length === 0 ? (
				<EmptyState
					title={_(t`No items yet`)}
					description={_(
						t`Add your dishes, drinks, and culinary creations to build your restaurant menu.`,
					)}
					icons={['image', 'blocks', 'sparkles']}
				/>
			) : (
				<div className="space-y-4">
					<Filters
						fields={ITEM_FILTER_FIELDS}
						query={filterQuery}
						onQueryChange={setFilterQuery}
						showClear
					/>

					{filteredItems.length === 0 ? (
						<EmptyState
							title={_(t`No items match these filters`)}
							description={_(
								hasFilters || healthFilter
									? t`Try adjusting your filters or clear them to see all items.`
									: t`Create an item to start building your menu.`,
							)}
							icons={['search']}
						/>
					) : (
						<Frame className="w-full">
							<Table variant="card">
								<TableHeader>
									<TableRow>
										{menuBulkEditEnabled ? (
											<TableHead className="w-10">
												<span className="sr-only">
													<Trans>Select</Trans>
												</span>
											</TableHead>
										) : null}
										<TableHead>
											<Trans>Item</Trans>
										</TableHead>
										<TableHead className="text-right sm:text-left">
											<Trans>Price</Trans>
										</TableHead>
										<FoodCostHead />
										<TableHead className="hidden sm:table-cell">
											<Trans>Categories</Trans>
										</TableHead>
										<TableHead className="hidden md:table-cell">
											<Trans>Dietary & Allergens</Trans>
										</TableHead>
										<TableHead className="hidden sm:table-cell">
											<Trans>Status</Trans>
										</TableHead>
										<TableHead className="hidden w-16 sm:table-cell">
											<span className="sr-only">
												<Trans>Actions</Trans>
											</span>
										</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{filteredItems.map((item) => {
										const itemTitle =
											getLocalizedMenuValue(
												item.displayName,
												defaultLocale,
												defaultLocale,
											) ||
											item.internalName ||
											'Untitled'

										return (
											<TableRow key={item.id}>
												{menuBulkEditEnabled ? (
													<TableCell className="w-10">
														<Checkbox
															checked={selectedIds.includes(item.id)}
															onCheckedChange={(value) =>
																toggle(item.id, value === true)
															}
															aria-label={_(t`Select {name}`, {
																name: itemTitle,
															})}
														/>
													</TableCell>
												) : null}
												<TableCell className="max-w-[200px] sm:max-w-none">
													<div className="flex min-w-0 items-center gap-3">
														<div className="bg-muted flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md border">
															{item.imageUrl ? (
																<img
																	src={item.imageUrl}
																	alt={itemTitle}
																	className="h-full w-full object-cover"
																/>
															) : (
																<Icon
																	name="image"
																	className="text-muted-foreground/40 size-4"
																/>
															)}
														</div>
														<div className="min-w-0 flex-1">
															<div className="flex min-w-0 items-center gap-1.5">
																<Link
																	to={`/${organization.slug}/menu/items/${item.id}`}
																	className="hover:text-primary text-foreground block truncate text-sm font-medium"
																>
																	{itemTitle}
																</Link>
																{item.isPopular && (
																	<span className="shrink-0 rounded bg-amber-100 px-1 text-[10px] text-amber-800 dark:bg-amber-950 dark:text-amber-300">
																		★ Popular
																	</span>
																)}
															</div>
															{item.internalName && (
																<span className="text-muted-foreground block truncate text-xs">
																	{item.internalName}
																</span>
															)}
														</div>
													</div>
												</TableCell>
												<TableCell className="text-right whitespace-nowrap sm:text-left">
													<span className="text-sm">
														{item.variationCount > 0 && <Trans>From</Trans>} $
														{item.price.toFixed(2)}
													</span>
													{item.variationCount > 0 && (
														<span className="text-muted-foreground block text-xs">
															{item.variationCount} <Trans>variations</Trans>
														</span>
													)}
												</TableCell>
												<FoodCostCell itemId={item.id} />
												<TableCell className="hidden sm:table-cell">
													{item.categories.length === 0 ? (
														<span className="text-muted-foreground text-xs italic">
															<Trans>Unassigned</Trans>
														</span>
													) : (
														<div className="flex flex-wrap gap-1">
															{item.categories.map((c) => (
																<Badge
																	key={c.id}
																	variant="secondary"
																	className="text-xs"
																>
																	{getLocalizedMenuValue(
																		c.displayName,
																		defaultLocale,
																		defaultLocale,
																	)}
																</Badge>
															))}
														</div>
													)}
												</TableCell>
												<TableCell className="hidden md:table-cell">
													<div className="flex flex-wrap items-center gap-1">
														{item.isGlutenFree && (
															<span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-800 dark:bg-amber-950 dark:text-amber-300">
																GF
															</span>
														)}
														{item.isVegetarian && (
															<span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
																V
															</span>
														)}
														{item.isAlcohol && (
															<span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[10px]">
																21+
															</span>
														)}
														{item.allergens.length > 0 && (
															<span className="text-muted-foreground text-[11px]">
																{item.allergens.slice(0, 2).join(', ')}
																{item.allergens.length > 2 &&
																	` +${item.allergens.length - 2}`}
															</span>
														)}
														{!item.isGlutenFree &&
															!item.isVegetarian &&
															!item.isAlcohol &&
															item.allergens.length === 0 && (
																<span className="text-muted-foreground text-xs">
																	—
																</span>
															)}
													</div>
												</TableCell>
												<TableCell className="hidden sm:table-cell">
													<MenuStatusBadge
														status={item.availabilityStatus}
														unavailableUntil={item.unavailableUntil}
													/>
												</TableCell>
												<TableCell className="hidden text-right sm:table-cell">
													<DropdownMenu>
														<DropdownMenuTrigger
															render={
																<Button
																	variant="ghost"
																	size="icon-sm"
																	aria-label={_(t`Item actions`)}
																>
																	<Icon name="ellipsis" className="size-4" />
																</Button>
															}
														/>
														<DropdownMenuContent align="end">
															<DropdownMenuItem
																render={
																	<Link
																		to={`/${organization.slug}/menu/items/${item.id}`}
																	>
																		<Icon
																			name="pencil"
																			className="mr-2 size-4"
																		/>
																		<Trans>Edit</Trans>
																	</Link>
																}
															/>
															<DropdownMenuItem
																onClick={() =>
																	setDuplicateEntity({
																		entityType: 'item',
																		entityId: item.id,
																	})
																}
															>
																<Icon name="copy" className="mr-2 size-4" />
																<Trans>Duplicate</Trans>
															</DropdownMenuItem>
															<DropdownMenuItem
																className="text-destructive focus:text-destructive"
																onClick={() => setDeleteItemId(item.id)}
															>
																<Icon name="trash-2" className="mr-2 size-4" />
																<Trans>Delete</Trans>
															</DropdownMenuItem>
														</DropdownMenuContent>
													</DropdownMenu>
												</TableCell>
											</TableRow>
										)
									})}
								</TableBody>
								<TableFooter>
									<TableRow>
										<FoodCostFooterCell>
											{filteredItems.length === 1 ? (
												<Trans>1 item</Trans>
											) : (
												// eslint-disable-next-line lingui/no-expression-in-message
												<Trans>{filteredItems.length} items</Trans>
											)}
										</FoodCostFooterCell>
										<TableCell />
									</TableRow>
								</TableFooter>
							</Table>
							{menuBulkEditEnabled ? (
								<MenuBulkBar
									selectedCount={selectedIds.length}
									allFilteredSelected={allFilteredSelected}
									onToggleSelectAll={(checked) =>
										checked ? selectAllFiltered() : clearSelection()
									}
									onBulkEdit={() => setBulkOpen(true)}
									onClear={clearSelection}
								/>
							) : null}
						</Frame>
					)}
				</div>
			)}

			{menuBulkEditEnabled ? (
				<MenuBulkEditSheet
					orgSlug={organization.slug}
					open={bulkOpen && hasSelection}
					onOpenChange={(open) => {
						setBulkOpen(open)
						if (!open) clearSelection()
					}}
					targetType="item"
					selectedIds={selectedIds}
					defaultLocale={defaultLocale}
					currencyExponent={currencyExponent}
					locations={bulkLocations}
					categories={bulkCategories}
					modifierGroups={bulkModifierGroups}
					rows={filteredItems
						.filter((row) => selectedIds.includes(row.id))
						.map((row) => ({
							id: row.id,
							displayName: getLocalizedMenuValue(
								row.displayName,
								defaultLocale,
								defaultLocale,
							),
							price: row.price,
							updatedAt: row.updatedAt,
						}))}
					onUndoSnapshot={
						menuHistoryEnabled ? (snapshotId) => void undoBulkSnapshot(snapshotId) : undefined
					}
				/>
			) : null}

			<MenuDuplicateDialog
				orgSlug={organization.slug}
				open={Boolean(duplicateEntity)}
				onOpenChange={(open) => !open && setDuplicateEntity(null)}
				entity={duplicateEntity}
			/>

			{/* Delete confirmation dialog */}
			<AlertDialog
				open={Boolean(deleteItemId)}
				onOpenChange={(open) => !open && setDeleteItemId(null)}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							<Trans>Delete item?</Trans>
						</AlertDialogTitle>
						<MenuDeleteEffects
							orgSlug={organization.slug}
							entityType="item"
							entityId={deleteItemId}
						/>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>
							<Trans>Cancel</Trans>
						</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								if (!deleteItemId) return
								void deleteFetcher.submit(
									{ intent: 'delete-item', itemId: deleteItemId },
									{ method: 'POST' },
								)
								setDeleteItemId(null)
							}}
						>
							<Trans>Delete</Trans>
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	)
}
