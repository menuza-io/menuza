import { Trans, t } from '@lingui/macro'
import { cn } from '@repo/ui'
import { useLingui } from '@lingui/react'
import { requireUserId } from '@repo/auth'
import { getLocalizedMenuValue } from '@repo/common/menu-types'
import {
	db,
	eq,
	asc,
	desc,
	and,
	OrganizationMenuCategory,
} from '@repo/database'
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
import { useCallback, useMemo, useState } from 'react'
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
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'

const DeleteCategorySchema = z.object({
	intent: z.literal('delete-category'),
	categoryId: z.string().min(1),
})

const CATEGORY_FILTER_FIELDS: FilterField[] = [
	{
		id: 'hierarchy',
		label: 'Hierarchy',
		type: 'select',
		defaultOperator: 'is_any_of',
		searchable: false,
		icon: <Icon name="folder-open" className="size-3.5" />,
		options: [
			{ value: 'top_level', label: 'Top-Level Categories' },
			{ value: 'subcategories', label: 'Subcategories' },
		],
	},
	{
		id: 'name',
		label: 'Name',
		type: 'text',
		defaultOperator: 'contains',
		placeholder: 'Enter a category name',
		icon: <Icon name="folder" className="size-3.5" />,
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
]

export async function action({ request, params }: ActionFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
	})

	const formData = await request.formData()
	const result = DeleteCategorySchema.safeParse(Object.fromEntries(formData))

	if (!result.success) {
		return Response.json({ error: 'Invalid request' }, { status: 400 })
	}

	await db
		.delete(OrganizationMenuCategory)
		.where(
			and(
				eq(OrganizationMenuCategory.id, result.data.categoryId),
				eq(OrganizationMenuCategory.organizationId, organization.id),
			),
		)

	await purgeOrganizationSiteCache(organization.id, organization.slug)

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
	const categories = await db.query.OrganizationMenuCategory.findMany({
		where: eq(OrganizationMenuCategory.organizationId, organization.id),
		with: {
			menuAssignments: {
				with: {
					menu: true,
				},
			},
			itemAssignments: true,
		},
		orderBy: [
			asc(OrganizationMenuCategory.position),
			desc(OrganizationMenuCategory.createdAt),
		],
	})

	return {
		organization,
		defaultLocale,
		categories: categories.map((c) => ({
			id: c.id,
			parentId: c.parentId ?? null,
			displayName: c.displayName,
			internalName: c.internalName,
			availabilityStatus: c.availabilityStatus,
			unavailableUntil: c.unavailableUntil
				? c.unavailableUntil.toISOString()
				: null,
			excludeFromOverride: c.excludeFromOverride,
			itemsCount: c.itemAssignments.length,
			menus: c.menuAssignments.map((ma) => ({
				id: ma.menu.id,
				displayName: ma.menu.displayName,
			})),
			updatedAt: c.updatedAt.toISOString(),
		})),
	}
}

export default function CategoriesIndexRoute() {
	const { organization, defaultLocale, categories } =
		useLoaderData<typeof loader>()
	const { _ } = useLingui()
	const deleteFetcher = useFetcher()
	const [deleteCategoryId, setDeleteCategoryId] = useState<string | null>(null)
	const categoriesMap = useMemo(
		() => new Map(categories.map((c) => [c.id, c])),
		[categories],
	)
	const getFieldValue = useCallback(
		(category: (typeof categories)[number], field: string) => {
			switch (field) {
				case 'hierarchy':
					return category.parentId ? 'subcategories' : 'top_level'
				case 'name':
					return getLocalizedMenuValue(
						category.displayName,
						defaultLocale,
						defaultLocale,
					)
				case 'internalName':
					return category.internalName ?? ''
				case 'status':
					return category.availabilityStatus
				default:
					return ''
			}
		},
		[defaultLocale],
	)
	const {
		filterQuery,
		filteredRecords: filteredCategories,
		hasFilters,
		setFilterQuery,
	} = useMenuListFilters(categories, CATEGORY_FILTER_FIELDS, getFieldValue)

	return (
		<div className="space-y-8">
			<PageHeader
				title={<Trans>Categories</Trans>}
				description={
					<Trans>
						Organize items into categories (e.g. Appetizers, Entrees, Drinks,
						Desserts).
					</Trans>
				}
				headingLevel="h2"
				size="section"
				actions={
					<Button
						render={<Link to={`/${organization.slug}/menu/categories/new`} />}
					>
						<Icon name="plus" className="size-4" />
						<Trans>Create Category</Trans>
					</Button>
				}
			/>

			{categories.length === 0 ? (
				<EmptyState
					title={_(t`No categories yet`)}
					description={_(
						t`Create categories to group menu items together for menus and ordering.`,
					)}
					icons={['file-text', 'blocks', 'sparkles']}
				/>
			) : (
				<div className="space-y-4">
					<Filters
						fields={CATEGORY_FILTER_FIELDS}
						query={filterQuery}
						onQueryChange={setFilterQuery}
						showClear
					/>

					{filteredCategories.length === 0 ? (
						<EmptyState
							title={_(t`No categories match these filters`)}
							description={_(
								hasFilters
									? t`Try adjusting your filters or clear them to see all categories.`
									: t`Create a category to start organizing menu items.`,
							)}
							icons={['search']}
						/>
					) : (
						<Frame className="w-full">
							<Table variant="card">
								<TableHeader>
									<TableRow>
										<TableHead>
											<Trans>Category</Trans>
										</TableHead>
										<TableHead className="hidden md:table-cell">
											<Trans>Menus</Trans>
										</TableHead>
										<TableHead className="hidden sm:table-cell">
											<Trans>Items</Trans>
										</TableHead>
										<TableHead>
											<Trans>Status</Trans>
										</TableHead>
										<TableHead className="w-16">
											<span className="sr-only">
												<Trans>Actions</Trans>
											</span>
										</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{filteredCategories.map((cat) => {
										const catTitle =
											getLocalizedMenuValue(
												cat.displayName,
												defaultLocale,
												defaultLocale,
											) ||
											cat.internalName ||
											'Untitled'

										return (
											<TableRow key={cat.id}>
												<TableCell>
													<div
														className={cn(
															'flex flex-col gap-0.5',
															cat.parentId &&
																'border-primary/30 border-l-2 pl-4',
														)}
													>
														<div className="flex items-center gap-2">
															{cat.parentId && (
																<span className="text-primary/70 text-xs font-semibold select-none">
																	↳
																</span>
															)}
															<Link
																to={`/${organization.slug}/menu/categories/${cat.id}`}
																className="hover:text-primary text-foreground text-sm font-medium"
															>
																{catTitle}
															</Link>
															{cat.parentId && (
																<Badge
																	variant="outline"
																	className="text-muted-foreground px-1 py-0 text-[10px] font-normal"
																>
																	<Trans>Subcategory</Trans>
																</Badge>
															)}
														</div>
														{cat.parentId &&
															categoriesMap.get(cat.parentId) && (
																<span className="text-muted-foreground flex items-center gap-1 text-[11px]">
																	<Trans>Under</Trans>
																	{getLocalizedMenuValue(
																		categoriesMap.get(cat.parentId)!
																			.displayName,
																		defaultLocale,
																		defaultLocale,
																	)}
																</span>
															)}
														{cat.internalName && (
															<span className="text-muted-foreground block text-xs">
																{cat.internalName}
															</span>
														)}
													</div>
												</TableCell>
												<TableCell className="hidden md:table-cell">
													{cat.menus.length === 0 ? (
														<span className="text-muted-foreground text-xs italic">
															<Trans>Unassigned</Trans>
														</span>
													) : (
														<div className="flex flex-wrap gap-1">
															{cat.menus.map((m) => (
																<Badge
																	key={m.id}
																	variant="secondary"
																	className="text-xs"
																>
																	{getLocalizedMenuValue(
																		m.displayName,
																		defaultLocale,
																		defaultLocale,
																	)}
																</Badge>
															))}
														</div>
													)}
												</TableCell>
												<TableCell className="hidden sm:table-cell">
													<span className="text-muted-foreground text-sm">
														{cat.itemsCount}{' '}
														{cat.itemsCount === 1 ? 'item' : 'items'}
													</span>
												</TableCell>
												<TableCell>
													<MenuStatusBadge
														status={cat.availabilityStatus}
														unavailableUntil={cat.unavailableUntil}
													/>
												</TableCell>
												<TableCell className="text-right">
													<DropdownMenu>
														<DropdownMenuTrigger
															render={
																<Button
																	variant="ghost"
																	size="icon-sm"
																	aria-label={_(t`Category actions`)}
																>
																	<Icon name="ellipsis" className="size-4" />
																</Button>
															}
														/>
														<DropdownMenuContent align="end">
															<DropdownMenuItem
																render={
																	<Link
																		to={`/${organization.slug}/menu/categories/${cat.id}`}
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
																onClick={() => setDeleteCategoryId(cat.id)}
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
										<TableCell colSpan={4}>
											{filteredCategories.length === 1 ? (
												<Trans>1 category</Trans>
											) : (
												// eslint-disable-next-line lingui/no-expression-in-message
												<Trans>{filteredCategories.length} categories</Trans>
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
				open={Boolean(deleteCategoryId)}
				onOpenChange={(open) => !open && setDeleteCategoryId(null)}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							<Trans>Delete category?</Trans>
						</AlertDialogTitle>
						<AlertDialogDescription>
							<Trans>
								This will permanently delete this category. Items in this
								category will not be deleted, but will become unassigned.
							</Trans>
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>
							<Trans>Cancel</Trans>
						</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								if (!deleteCategoryId) return
								void deleteFetcher.submit(
									{ intent: 'delete-category', categoryId: deleteCategoryId },
									{ method: 'POST' },
								)
								setDeleteCategoryId(null)
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
