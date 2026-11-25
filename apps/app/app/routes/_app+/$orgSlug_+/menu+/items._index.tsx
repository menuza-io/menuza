import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { requireUserId } from '@repo/auth'
import {
	MENU_CHANNEL_LABELS,
	MENU_CHANNELS,
	parseMenuChannels,
} from '@repo/common/menu-channels'
import {
	dietaryTagsOf,
	getLocalizedMenuValue,
	parseMenuVariations,
} from '@repo/common/menu-types'
import {
	db,
	eq,
	asc,
	desc,
	and,
	isNotNull,
	OrganizationMenuItem,
	OrganizationMenuCategory,
	OrganizationMenuLocationOverride,
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
	FoodCostSortControl,
	sortItemsByFoodCost,
	useFoodCostRows,
	type FoodCostSort,
} from '#app/components/inventory/food-cost-column.tsx'
import { AutoPopularSettings } from '#app/components/menu/auto-popular-settings.tsx'
import { MenuDeleteEffects } from '#app/components/menu/delete-effects.tsx'
import { DIETARY_TAG_MESSAGES } from '#app/components/menu/dietary-tag-switches.tsx'
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
import { isPosOwnershipEnabled } from '#app/utils/integrations/flags.server.ts'
import {
	requireMenuRead,
	requireMenuWrite,
} from '#app/utils/menu/access.server.ts'
import {
	getAutoPopularSettings,
	handleAutoPopularSettingsAction,
} from '#app/utils/menu/auto-popular.server.ts'
import {
	currencyCodeForDataRegion,
	currencyExponentFor,
} from '#app/utils/menu/bulk-apply.server.ts'
import { deleteMenuEntityReferences } from '#app/utils/menu/cleanup.server.ts'
import {
	getMenuBulkEditEnabled,
	getMenuHistoryEnabled,
} from '#app/utils/menu/menu-feature-access.server.ts'
import { loadMenuHealthCheckIds } from '#app/utils/menu/menu-health.server.ts'
import {
	menuHealthEntityType,
	MENU_HEALTH_PARAM,
	parseMenuHealthCheckKey,
} from '#app/utils/menu/menu-health.ts'
import { safeEnqueueMenuSync } from '#app/utils/menu/menu-sync.server.ts'
import {
	assertCanDeleteMenuItem,
	lockedFieldsFor,
	PosFieldLockedError,
	type PosEntityLockInfo,
} from '#app/utils/menu/pos-ownership.server.ts'
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
	{
		id: 'channels',
		label: 'Channels',
		type: 'multiselect',
		defaultOperator: 'has_any_of',
		searchable: false,
		icon: <Icon name="globe" className="size-3.5" />,
		options: MENU_CHANNELS.map((channel) => ({
			value: channel,
			label: MENU_CHANNEL_LABELS[channel],
		})),
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
	if (formData.get('intent') === 'updateAutoPopular') {
		return handleAutoPopularSettingsAction({
			request,
			organizationId: organization.id,
			formData,
		})
	}
	const result = DeleteItemSchema.safeParse(Object.fromEntries(formData))

	if (!result.success) {
		return Response.json({ error: 'Invalid request' }, { status: 400 })
	}

	try {
		await assertCanDeleteMenuItem(organization.id, result.data.itemId)
	} catch (error) {
		if (error instanceof PosFieldLockedError) return error.toResponse()
		throw error
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
	await safeEnqueueMenuSync(organization.id, {
		kind: 'menu',
		entityType: 'all',
	})

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
	const [
		menuBulkEditEnabled,
		menuHistoryEnabled,
		autoPopular,
		posOwnershipEnabled,
	] = await Promise.all([
		getMenuBulkEditEnabled(organization.id),
		getMenuHistoryEnabled(organization.id),
		getAutoPopularSettings(organization.id),
		isPosOwnershipEnabled(organization.id),
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

	const channelOverrides = await db
		.select({
			entityId: OrganizationMenuLocationOverride.entityId,
			channels: OrganizationMenuLocationOverride.channels,
		})
		.from(OrganizationMenuLocationOverride)
		.where(
			and(
				eq(OrganizationMenuLocationOverride.organizationId, organization.id),
				eq(OrganizationMenuLocationOverride.entityType, 'item'),
				isNotNull(OrganizationMenuLocationOverride.channels),
			),
		)
	const narrowedOverrideItemIds = new Set<string>()
	for (const ov of channelOverrides) {
		if (parseMenuChannels(ov.channels).length < MENU_CHANNELS.length) {
			narrowedOverrideItemIds.add(ov.entityId)
		}
	}

	const requestUrl = new URL(request.url)
	const overridesParam = requestUrl.searchParams.get('overrides') ?? ''
	const overridesFilter = overridesParam === '1' || overridesParam === 'true'
	const posLocks = posOwnershipEnabled
		? await lockedFieldsFor(
				organization.id,
				'item',
				items.map((i) => i.id),
			)
		: new Map<string, PosEntityLockInfo>()

	// `?health=<check>` narrows the list to the dishes a Menu health line
	// counted, using the same function as the card.
	const healthKey = parseMenuHealthCheckKey(
		requestUrl.searchParams.get(MENU_HEALTH_PARAM),
	)
	const healthFilter =
		healthKey && menuHealthEntityType(healthKey) === 'item'
			? {
					key: healthKey,
					itemIds: await loadMenuHealthCheckIds(organization, healthKey),
				}
			: null

	const bulkCatalog = bulkCatalogPromise
		? await bulkCatalogPromise
		: [[], [], []]
	const [bulkLocations, bulkCategories, bulkModifierGroups] = bulkCatalog

	const mappedItems = items.map((i) => {
		let allergens: string[] = []
		try {
			if (i.allergens) allergens = JSON.parse(i.allergens) as string[]
		} catch {}
		const channels = parseMenuChannels(i.channels)
		const notSoldEverywhere =
			channels.length < MENU_CHANNELS.length ||
			narrowedOverrideItemIds.has(i.id)
		const lock = posLocks.get(i.id)

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
			dietaryTags: dietaryTagsOf(i),
			isPopular: i.isPopular,
			isUpsell: i.isUpsell,
			channels,
			notSoldEverywhere,
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
			hasPosOverrides: Boolean(lock && lock.overriddenFields.length > 0),
			posProviders: lock?.providers ?? [],
			deleteLocked: Boolean(lock?.deleteLocked),
			deleteLockedProvider: lock?.deleteLockedProvider ?? null,
		}
	})
	const overriddenItemsCount = mappedItems.filter(
		(item) => item.hasPosOverrides,
	).length
	const visibleItems = overridesFilter
		? mappedItems.filter((item) => item.hasPosOverrides)
		: mappedItems

	return {
		organization: {
			id: organization.id,
			slug: organization.slug,
			dataRegion: organization.dataRegion,
		},
		defaultLocale,
		healthFilter,
		posOwnershipEnabled,
		overridesFilter,
		overriddenItemsCount,
		hasAnyItems: mappedItems.length > 0,
		menuBulkEditEnabled,
		menuHistoryEnabled,
		autoPopular,
		currencyExponent: currencyExponentFor(
			currencyCodeForDataRegion(organization.dataRegion),
		),
		bulkLocations: bulkLocations.map((row) => ({
			id: row.id,
			label: row.name,
		})),
		bulkCategories: bulkCategories.map((row) => ({
			id: row.id,
			label: getLocalizedMenuValue(
				row.displayName,
				defaultLocale,
				defaultLocale,
			),
		})),
		bulkModifierGroups: bulkModifierGroups.map((row) => ({
			id: row.id,
			label: getLocalizedMenuValue(row.name, defaultLocale, defaultLocale),
		})),
		items: visibleItems,
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
		posOwnershipEnabled,
		overridesFilter,
		overriddenItemsCount,
		hasAnyItems,
		menuBulkEditEnabled,
		menuHistoryEnabled,
		autoPopular,
		currencyExponent,
		bulkLocations,
		bulkCategories,
		bulkModifierGroups,
	} = useLoaderData<typeof loader>()
	const { _ } = useLingui()
	const deleteFetcher = useFetcher()
	const revalidator = useRevalidator()
	const [bulkOpen, setBulkOpen] = useState(false)
	const [duplicateEntity, setDuplicateEntity] =
		useState<MenuDuplicateEntity | null>(null)
	const items = useMemo(() => {
		if (!healthFilter) return allItems
		const ids = new Set(healthFilter.itemIds)
		return allItems.filter((item) => ids.has(item.id))
	}, [allItems, healthFilter])
	const [deleteItemId, setDeleteItemId] = useState<string | null>(null)
	const deletingItem = useMemo(
		() => allItems.find((item) => item.id === deleteItemId) ?? null,
		[allItems, deleteItemId],
	)
	const deleteLockedProvider = deletingItem?.deleteLockedProvider ?? 'POS'
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
						...item.dietaryTags.filter(
							(tag) => tag !== 'vegetarian' && tag !== 'gluten_free',
						),
						...(item.isAlcohol ? ['alcohol'] : []),
					]
				case 'channels':
					return item.channels
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

	// Sorting by food cost, margin per dish or margin over a period (#519).
	const foodCost = useFoodCostRows()
	const [foodCostSort, setFoodCostSort] = useState<FoodCostSort>('default')
	const [periodMargins, setPeriodMargins] = useState<ReadonlyMap<
		string,
		number
	> | null>(null)
	const sortedItems = useMemo(
		() =>
			sortItemsByFoodCost(
				filteredItems,
				foodCost.visible ? foodCostSort : 'default',
				foodCost.rowFor,
				periodMargins,
			),
		[filteredItems, foodCost.visible, foodCost.rowFor, foodCostSort, periodMargins],
	)

	const {
		selectedIds,
		toggle,
		selectAllFiltered,
		clearSelection,
		allFilteredSelected,
		hasSelection,
	} = useMenuListSelection(sortedItems)

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

			<AutoPopularSettings
				featureEnabled={autoPopular.featureEnabled}
				autoPopularCount={autoPopular.autoPopularCount}
			/>

			{!hasAnyItems ? (
				<EmptyState
					title={_(t`No items yet`)}
					description={_(
						t`Add your dishes, drinks, and culinary creations to build your restaurant menu.`,
					)}
					icons={['image', 'blocks', 'sparkles']}
				/>
			) : (
				<div className="space-y-4">
					<div className="flex flex-wrap items-center justify-between gap-2">
						<div className="min-w-0 flex-1">
							<Filters
								fields={ITEM_FILTER_FIELDS}
								query={filterQuery}
								onQueryChange={setFilterQuery}
								showClear
							/>
						</div>
						<FoodCostSortControl
							sort={foodCostSort}
							onSortChange={setFoodCostSort}
							locations={bulkLocations}
							items={allItems.map((item) => ({ id: item.id, price: item.price }))}
							onPeriodMargins={setPeriodMargins}
						/>
						{posOwnershipEnabled &&
						(overriddenItemsCount > 0 || overridesFilter) ? (
							<Button
								variant={overridesFilter ? 'secondary' : 'outline'}
								size="sm"
								render={
									<Link
										to={
											overridesFilter
												? `/${organization.slug}/menu/items`
												: `/${organization.slug}/menu/items?overrides=1`
										}
									/>
								}
							>
								<Trans>With POS overrides ({overriddenItemsCount})</Trans>
							</Button>
						) : null}
					</div>

					{sortedItems.length === 0 ? (
						<EmptyState
							title={_(t`No items match these filters`)}
							description={_(
								hasFilters || healthFilter || overridesFilter
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
									{sortedItems.map((item) => {
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
																{item.notSoldEverywhere ? (
																	<Badge
																		variant="outline"
																		className="shrink-0 px-1.5 py-0 text-[10px]"
																	>
																		<Trans>Not sold everywhere</Trans>
																	</Badge>
																) : null}
																{item.hasPosOverrides ? (
																	<Badge
																		variant="outline"
																		className="shrink-0 px-1.5 py-0 text-[10px]"
																	>
																		<Trans>Yours, not from POS</Trans>
																	</Badge>
																) : null}
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
														{item.dietaryTags
															.filter(
																(tag) =>
																	tag !== 'vegetarian' && tag !== 'gluten_free',
															)
															.map((tag) => (
																<span
																	key={tag}
																	className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[10px]"
																>
																	{_(DIETARY_TAG_MESSAGES[tag])}
																</span>
															))}
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
														{item.dietaryTags.length === 0 &&
															!item.isGlutenFree &&
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
						menuHistoryEnabled
							? (snapshotId) => void undoBulkSnapshot(snapshotId)
							: undefined
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
						{deletingItem?.deleteLocked ? (
							<p className="text-destructive text-sm">
								<Trans>
									This dish is managed in {deleteLockedProvider}. Remove it in{' '}
									{deleteLockedProvider} or{' '}
									<Link
										to={`/${organization.slug}/settings/integrations`}
										className="underline underline-offset-4"
									>
										change ownership
									</Link>
									.
								</Trans>
							</p>
						) : null}
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
							disabled={Boolean(deletingItem?.deleteLocked)}
							onClick={() => {
								if (!deleteItemId || deletingItem?.deleteLocked) return
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
