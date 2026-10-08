import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { requireUserId } from '@repo/auth'
import { getLocalizedMenuValue } from '@repo/common/menu-types'
import {
	db,
	eq,
	ne,
	asc,
	desc,
	and,
	OrganizationDrop,
	OrganizationMenu,
	OrganizationMenuChannelState,
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
import { useCallback, useEffect, useState } from 'react'
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
import {
	PublishMenuDialog,
	type PublishChannelOption,
} from '#app/components/menu/publish-menu-dialog.tsx'
import {
	MenuPublishStatusBadge,
	menuPublishState,
} from '#app/components/menu/publish-status-badge.tsx'
import {
	requireMenuRead,
	requireMenuWrite,
} from '#app/utils/menu/access.server.ts'
import { deleteMenuEntityReferences } from '#app/utils/menu/cleanup.server.ts'
import { listPublishChannels } from '#app/utils/menu/publish.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'

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
			{ value: 'hidden', label: 'Hidden' },
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
	const result = DeleteMenuSchema.safeParse(Object.fromEntries(formData))

	if (!result.success) {
		return Response.json({ error: 'Invalid request' }, { status: 400 })
	}

	const [referencingDrop] = await db
		.select({ id: OrganizationDrop.id })
		.from(OrganizationDrop)
		.where(
			and(
				eq(OrganizationDrop.menuId, result.data.menuId),
				eq(OrganizationDrop.organizationId, organization.id),
			),
		)
		.limit(1)

	if (referencingDrop) {
		return Response.json(
			{
				error:
					'This menu is used by a drop. Delete or retarget that drop before deleting the menu.',
			},
			{ status: 409 },
		)
	}

	await db.transaction(async (tx) => {
		await tx
			.delete(OrganizationMenu)
			.where(
				and(
					eq(OrganizationMenu.id, result.data.menuId),
					eq(OrganizationMenu.organizationId, organization.id),
				),
			)

		await deleteMenuEntityReferences(
			organization.id,
			'menu',
			result.data.menuId,
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
		siteDefaultLocale: true,
	})

	await requireMenuRead(request, organization.id)

	const defaultLocale = organization.siteDefaultLocale ?? 'en'
	const menus = await db.query.OrganizationMenu.findMany({
		where: and(
			eq(OrganizationMenu.organizationId, organization.id),
			ne(OrganizationMenu.menuType, 'drop'),
		),
		with: {
			categoryAssignments: true,
			published: true,
		},
		orderBy: [asc(OrganizationMenu.position), desc(OrganizationMenu.createdAt)],
	})

	const publishChannels = await listPublishChannels(organization.id)
	const channelStates = await db
		.select()
		.from(OrganizationMenuChannelState)
		.where(eq(OrganizationMenuChannelState.organizationId, organization.id))
	type ChannelStateRow = (typeof channelStates)[number]
	const channelStatesByMenu: Map<
		string,
		Map<string, ChannelStateRow>
	> = new Map()
	for (const state of channelStates) {
		const byIntegration = channelStatesByMenu.get(state.menuId) ?? new Map()
		byIntegration.set(state.integrationId, state)
		channelStatesByMenu.set(state.menuId, byIntegration)
	}

	const serializeChannels = (menuId: string): PublishChannelOption[] =>
		publishChannels.map((channel) => {
			const state = channelStatesByMenu.get(menuId)?.get(channel.integrationId)
			return {
				integrationId: channel.integrationId,
				displayName: channel.displayName,
				selected: state?.selected ?? null,
				lastStatus: (state?.lastStatus as 'success' | 'error' | null) ?? null,
				lastError: state?.lastError ?? null,
				pushedCount: state?.pushedCount ?? null,
				lastSyncAt: state?.lastSyncAt ? state.lastSyncAt.toISOString() : null,
			}
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
			publish: {
				state: menuPublishState(Boolean(m.published), m.hasUnpublishedChanges),
				revision: m.published?.revision ?? null,
				publishedAt: m.published?.publishedAt.toISOString() ?? null,
			},
			channels: serializeChannels(m.id),
		})),
	}
}

export default function MenusIndexRoute() {
	const { organization, defaultLocale, menus } = useLoaderData<typeof loader>()
	const { _ } = useLingui()
	const deleteFetcher = useFetcher<{ success?: boolean; error?: string }>()
	const [deleteMenuId, setDeleteMenuId] = useState<string | null>(null)
	const [deleteError, setDeleteError] = useState<string | null>(null)
	const [publishMenu, setPublishMenu] = useState<{
		id: string
		name: string
		publishState: (typeof menus)[number]['publish']['state']
		channels: PublishChannelOption[]
	} | null>(null)

	useEffect(() => {
		if (deleteFetcher.state !== 'idle' || !deleteFetcher.data) return
		if (deleteFetcher.data.success) {
			setDeleteMenuId(null)
			setDeleteError(null)
			return
		}
		if (deleteFetcher.data.error) setDeleteError(deleteFetcher.data.error)
	}, [deleteFetcher.state, deleteFetcher.data])
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
										<TableHead>
											<Trans>Publish</Trans>
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
												<TableCell>
													<MenuPublishStatusBadge state={menu.publish.state} />
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
																onClick={() => {
																	setPublishMenu({
																		id: menu.id,
																		name: menuTitle,
																		publishState: menu.publish.state,
																		channels: menu.channels,
																	})
																}}
															>
																<Icon
																	name="paper-plane"
																	className="mr-2 size-4"
																/>
																<Trans>Publish…</Trans>
															</DropdownMenuItem>
															<DropdownMenuItem
																className="text-destructive focus:text-destructive"
																onClick={() => {
																	setDeleteError(null)
																	setDeleteMenuId(menu.id)
																}}
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
										<TableCell colSpan={6}>
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
				onOpenChange={(open) => {
					if (open) return
					setDeleteMenuId(null)
					setDeleteError(null)
				}}
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
						{deleteError ? (
							<p className="text-destructive text-sm">{deleteError}</p>
						) : null}
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>
							<Trans>Cancel</Trans>
						</AlertDialogCancel>
						<AlertDialogAction
							disabled={deleteFetcher.state !== 'idle'}
							onClick={() => {
								if (!deleteMenuId) return
								setDeleteError(null)
								void deleteFetcher.submit(
									{ intent: 'delete-menu', menuId: deleteMenuId },
									{ method: 'POST' },
								)
							}}
						>
							<Trans>Delete</Trans>
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>

			{/* Publish dialog */}
			{publishMenu ? (
				<PublishMenuDialog
					open={Boolean(publishMenu)}
					onOpenChange={(open) => {
						if (!open) setPublishMenu(null)
					}}
					organizationSlug={organization.slug}
					menu={{ id: publishMenu.id, name: publishMenu.name }}
					publishState={publishMenu.publishState}
					channels={publishMenu.channels}
				/>
			) : null}
		</div>
	)
}
