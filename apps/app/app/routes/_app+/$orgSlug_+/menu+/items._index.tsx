import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { requireUserId } from '@repo/auth'
import { getLocalizedMenuValue } from '@repo/common/menu-types'
import { db, eq, asc, desc, and, OrganizationMenuItem } from '@repo/database'
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
import { useCallback, useState } from 'react'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	Link,
	useFetcher,
	useLoaderData,
} from 'react-router'
import { z } from 'zod'
import { EmptyState } from '#app/components/empty-state.tsx'
import { useMenuListFilters } from '#app/components/menu/menu-list-filters.tsx'
import { MenuStatusBadge } from '#app/components/menu/menu-status-badge.tsx'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'

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
	})

	const formData = await request.formData()
	const result = DeleteItemSchema.safeParse(Object.fromEntries(formData))

	if (!result.success) {
		return Response.json({ error: 'Invalid request' }, { status: 400 })
	}

	await db
		.delete(OrganizationMenuItem)
		.where(
			and(
				eq(OrganizationMenuItem.id, result.data.itemId),
				eq(OrganizationMenuItem.organizationId, organization.id),
			),
		)

	return Response.json({ success: true })
}

export async function loader({ request, params }: LoaderFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		siteDefaultLocale: true,
	})

	const defaultLocale = organization.siteDefaultLocale ?? 'en'
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

	return {
		organization,
		defaultLocale,
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
	const { organization, defaultLocale, items } = useLoaderData<typeof loader>()
	const { _ } = useLingui()
	const deleteFetcher = useFetcher()
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

			{items.length === 0 ? (
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
								hasFilters
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
										<TableHead>
											<Trans>Item</Trans>
										</TableHead>
										<TableHead className="text-right sm:text-left">
											<Trans>Price</Trans>
										</TableHead>
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
														${item.price.toFixed(2)}
													</span>
												</TableCell>
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
										<TableCell colSpan={5}>
											{filteredItems.length === 1 ? (
												<Trans>1 item</Trans>
											) : (
												// eslint-disable-next-line lingui/no-expression-in-message
												<Trans>{filteredItems.length} items</Trans>
											)}
										</TableCell>
										<TableCell />
									</TableRow>
								</TableFooter>
							</Table>
						</Frame>
					)}
				</div>
			)}

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
						<AlertDialogDescription>
							<Trans>
								This will permanently delete this menu item and remove it from
								all menus and categories.
							</Trans>
						</AlertDialogDescription>
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
