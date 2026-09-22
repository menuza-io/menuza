import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { requireUserId } from '@repo/auth'
import { getLocalizedMenuValue } from '@repo/common/menu-types'
import { db, eq, asc, desc, and, OrganizationMenu } from '@repo/database'
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

const DeleteMenuSchema = z.object({
	intent: z.literal('delete-menu'),
	menuId: z.string().min(1),
})

const MENU_FILTER_FIELDS: FilterField[] = [
	{
		id: 'name',
		label: 'Name',
		type: 'text',
		defaultOperator: 'contains',
		placeholder: 'Enter a menu name',
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
]

export async function action({ request, params }: ActionFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
	})

	const formData = await request.formData()
	const result = DeleteMenuSchema.safeParse(Object.fromEntries(formData))

	if (!result.success) {
		return Response.json({ error: 'Invalid request' }, { status: 400 })
	}

	await db
		.delete(OrganizationMenu)
		.where(
			and(
				eq(OrganizationMenu.id, result.data.menuId),
				eq(OrganizationMenu.organizationId, organization.id),
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
	const menus = await db.query.OrganizationMenu.findMany({
		where: eq(OrganizationMenu.organizationId, organization.id),
		with: {
			categoryAssignments: true,
		},
		orderBy: [asc(OrganizationMenu.position), desc(OrganizationMenu.createdAt)],
	})

	return {
		organization,
		defaultLocale,
		menus: menus.map((m) => ({
			id: m.id,
			displayName: m.displayName,
			internalName: m.internalName,
			menuType: m.menuType,
			nutritionalInfo: m.nutritionalInfo,
			specialInstructions: m.specialInstructions,
			availabilityStatus: m.availabilityStatus,
			unavailableUntil: m.unavailableUntil
				? m.unavailableUntil.toISOString()
				: null,
			categoriesCount: m.categoryAssignments.length,
			updatedAt: m.updatedAt.toISOString(),
		})),
	}
}

export default function MenusIndexRoute() {
	const { organization, defaultLocale, menus } = useLoaderData<typeof loader>()
	const { _ } = useLingui()
	const deleteFetcher = useFetcher()
	const [deleteMenuId, setDeleteMenuId] = useState<string | null>(null)
	const getFieldValue = useCallback(
		(menu: (typeof menus)[number], field: string) => {
			switch (field) {
				case 'name':
					return getLocalizedMenuValue(
						menu.displayName,
						defaultLocale,
						defaultLocale,
					)
				case 'internalName':
					return menu.internalName ?? ''
				case 'status':
					return menu.availabilityStatus
				default:
					return ''
			}
		},
		[defaultLocale],
	)
	const {
		filterQuery,
		filteredRecords: filteredMenus,
		hasFilters,
		setFilterQuery,
	} = useMenuListFilters(menus, MENU_FILTER_FIELDS, getFieldValue)

	return (
		<div className="space-y-8">
			<PageHeader
				title={<Trans>Menus</Trans>}
				description={
					<Trans>
						Create and manage your menus for dine-in, online ordering, POS, and
						catering.
					</Trans>
				}
				headingLevel="h2"
				size="section"
				actions={
					<Button render={<Link to={`/${organization.slug}/menu/menus/new`} />}>
						<Icon name="plus" className="size-4" />
						<Trans>Create Menu</Trans>
					</Button>
				}
			/>

			{menus.length === 0 ? (
				<EmptyState
					title={_(t`No menus yet`)}
					description={_(
						t`Get started by creating your first menu to categorize dishes and drinks.`,
					)}
					icons={['file-text', 'blocks', 'sparkles']}
				/>
			) : (
				<div className="space-y-4">
					<Filters
						fields={MENU_FILTER_FIELDS}
						query={filterQuery}
						onQueryChange={setFilterQuery}
						showClear
					/>

					{filteredMenus.length === 0 ? (
						<EmptyState
							title={_(t`No menus match these filters`)}
							description={_(
								hasFilters
									? t`Try adjusting your filters or clear them to see all menus.`
									: t`Create a menu to start organizing your dishes and drinks.`,
							)}
							icons={['search']}
						/>
					) : (
						<Frame className="w-full">
							<Table variant="card">
								<TableHeader>
									<TableRow>
										<TableHead>
											<Trans>Menu</Trans>
										</TableHead>
										<TableHead>
											<Trans>Type</Trans>
										</TableHead>
										<TableHead className="hidden sm:table-cell">
											<Trans>Categories</Trans>
										</TableHead>
										<TableHead className="hidden md:table-cell">
											<Trans>Nutrition Info</Trans>
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
									{filteredMenus.map((menu) => {
										const menuTitle =
											getLocalizedMenuValue(
												menu.displayName,
												defaultLocale,
												defaultLocale,
											) ||
											menu.internalName ||
											'Untitled'

										return (
											<TableRow key={menu.id}>
												<TableCell>
													<Link
														to={`/${organization.slug}/menu/menus/${menu.id}`}
														className="hover:text-primary text-foreground text-sm font-medium"
													>
														{menuTitle}
													</Link>
													{menu.internalName && (
														<span className="text-muted-foreground block text-xs">
															{menu.internalName}
														</span>
													)}
												</TableCell>
												<TableCell>
													<Badge variant="outline" className="text-xs">
														{menu.menuType === 'catering'
															? 'Catering'
															: 'Online / POS'}
													</Badge>
												</TableCell>
												<TableCell className="hidden sm:table-cell">
													<span className="text-muted-foreground text-sm">
														{menu.categoriesCount}{' '}
														{menu.categoriesCount === 1
															? 'category'
															: 'categories'}
													</span>
												</TableCell>
												<TableCell className="hidden md:table-cell">
													{menu.nutritionalInfo ? (
														<Badge
															variant="secondary"
															className="bg-emerald-50 text-xs text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
														>
															<Trans>Displayed</Trans>
														</Badge>
													) : (
														<span className="text-muted-foreground text-xs">
															<Trans>Hidden</Trans>
														</span>
													)}
												</TableCell>
												<TableCell>
													<MenuStatusBadge
														status={menu.availabilityStatus}
														unavailableUntil={menu.unavailableUntil}
													/>
												</TableCell>
												<TableCell className="text-right">
													<DropdownMenu>
														<DropdownMenuTrigger
															render={
																<Button
																	variant="ghost"
																	size="icon-sm"
																	aria-label={_(t`Menu actions`)}
																>
																	<Icon name="ellipsis" className="size-4" />
																</Button>
															}
														/>
														<DropdownMenuContent align="end">
															<DropdownMenuItem
																render={
																	<Link
																		to={`/${organization.slug}/menu/menus/${menu.id}`}
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
																onClick={() => setDeleteMenuId(menu.id)}
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
											{filteredMenus.length === 1 ? (
												<Trans>1 menu</Trans>
											) : (
												// eslint-disable-next-line lingui/no-expression-in-message
												<Trans>{filteredMenus.length} menus</Trans>
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
				open={Boolean(deleteMenuId)}
				onOpenChange={(open) => !open && setDeleteMenuId(null)}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							<Trans>Delete menu?</Trans>
						</AlertDialogTitle>
						<AlertDialogDescription>
							<Trans>
								This will permanently delete this menu. Categories and items
								associated with it will remain intact.
							</Trans>
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>
							<Trans>Cancel</Trans>
						</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								if (!deleteMenuId) return
								void deleteFetcher.submit(
									{ intent: 'delete-menu', menuId: deleteMenuId },
									{ method: 'POST' },
								)
								setDeleteMenuId(null)
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
