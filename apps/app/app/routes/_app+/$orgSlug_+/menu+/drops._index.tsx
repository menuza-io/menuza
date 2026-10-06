import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { requireUserId } from '@repo/auth'
import {
	DROP_STATUS_LABELS,
	type DropStatus,
	getDropDisplayStatus,
	getLocalizedMenuValue,
} from '@repo/common/menu-types'
import { getOrgSiteUrl } from '@repo/common/url'
import { cn } from '@repo/ui'
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
import {
	deleteDrop,
	listDropsForOrganization,
} from '#app/utils/menu/drops.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'

const DeleteDropSchema = z.object({
	intent: z.literal('delete-drop'),
	dropId: z.string().min(1),
})

const DROP_FILTER_FIELDS: FilterField[] = [
	{
		id: 'title',
		label: 'Title',
		type: 'text',
		defaultOperator: 'contains',
		placeholder: 'Enter a drop title',
		icon: <Icon name="file-text" className="size-3.5" />,
	},
	{
		id: 'slug',
		label: 'Slug',
		type: 'text',
		defaultOperator: 'contains',
		placeholder: 'Enter a slug',
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
			{ value: 'live', label: 'Live' },
			{ value: 'scheduled', label: 'Scheduled' },
			{ value: 'draft', label: 'Draft' },
			{ value: 'closed', label: 'Closed' },
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
	const result = DeleteDropSchema.safeParse(Object.fromEntries(formData))

	if (!result.success) {
		return Response.json({ error: 'Invalid request' }, { status: 400 })
	}

	await deleteDrop(organization.id, result.data.dropId)
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

	const drops = await listDropsForOrganization(organization.id)

	return {
		organization,
		drops: drops.map((d) => ({
			id: d.id,
			title: getLocalizedMenuValue(
				d.title,
				organization.siteDefaultLocale ?? 'en',
				organization.siteDefaultLocale ?? 'en',
			),
			slug: d.slug,
			status: d.status as DropStatus,
			ordersOpenAt: d.ordersOpenAt ? d.ordersOpenAt.toISOString() : null,
			ordersCloseAt: d.ordersCloseAt ? d.ordersCloseAt.toISOString() : null,
			pickupWindowsCount: d.pickupWindows.length,
			firstPickupDate: d.pickupWindows[0]?.date || null,
			firstPickupLocation: d.pickupWindows[0]?.location?.name || null,
			createdAt: d.createdAt.toISOString(),
		})),
	}
}

export default function DropsIndexRoute() {
	const { organization, drops } = useLoaderData<typeof loader>()
	const { _ } = useLingui()
	const deleteFetcher = useFetcher()
	const [deleteDropId, setDeleteDropId] = useState<string | null>(null)
	const [now, setNow] = useState(() => new Date())

	useEffect(() => {
		const interval = setInterval(() => setNow(new Date()), 30_000)
		return () => clearInterval(interval)
	}, [])

	const getFieldValue = useCallback(
		(drop: (typeof drops)[number], field: string) => {
			switch (field) {
				case 'title':
					return drop.title
				case 'slug':
					return drop.slug
				case 'status':
					return getDropDisplayStatus(
						drop.status,
						drop.ordersOpenAt,
						drop.ordersCloseAt,
						now,
					)
				default:
					return ''
			}
		},
		[now],
	)

	const {
		filterQuery,
		filteredRecords: filteredDrops,
		hasFilters,
		setFilterQuery,
	} = useMenuListFilters(drops, DROP_FILTER_FIELDS, getFieldValue)

	return (
		<div className="space-y-8">
			<PageHeader
				title={<Trans>Drops</Trans>}
				description={
					<Trans>
						Schedule limited-time menu drops with inventory limits and pickup
						slots.
					</Trans>
				}
				headingLevel="h2"
				size="section"
				actions={
					<Button render={<Link to={`/${organization.slug}/menu/drops/new`} />}>
						<Icon name="plus" className="size-4" />
						<Trans>Create Drop</Trans>
					</Button>
				}
			/>

			{drops.length === 0 ? (
				<EmptyState
					title={_(t`No drops scheduled yet`)}
					description={_(
						t`Create your first limited-time drop to sell out fast, build anticipation, and manage pickup windows.`,
					)}
					icons={['calendar', 'clock', 'sparkles']}
				/>
			) : (
				<div className="space-y-4">
					<Filters
						fields={DROP_FILTER_FIELDS}
						query={filterQuery}
						onQueryChange={setFilterQuery}
						showClear
					/>

					{filteredDrops.length === 0 ? (
						<EmptyState
							title={_(t`No drops match these filters`)}
							description={_(
								hasFilters
									? t`Try adjusting your filters or clear them to see all drops.`
									: t`Create your first limited-time drop to sell out fast, build anticipation, and manage pickup windows.`,
							)}
							icons={['search']}
						/>
					) : (
						<Frame className="w-full">
							<Table variant="card">
								<TableHeader>
									<TableRow>
										<TableHead>
											<Trans>Drop</Trans>
										</TableHead>
										<TableHead>
											<Trans>Status</Trans>
										</TableHead>
										<TableHead className="hidden sm:table-cell">
											<Trans>Pickup Window</Trans>
										</TableHead>
										<TableHead className="hidden md:table-cell">
											<Trans>Orders Schedule</Trans>
										</TableHead>
										<TableHead className="w-16">
											<span className="sr-only">
												<Trans>Actions</Trans>
											</span>
										</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{filteredDrops.map((drop) => {
										const displayStatus = getDropDisplayStatus(
											drop.status,
											drop.ordersOpenAt,
											drop.ordersCloseAt,
											now,
										)
										return (
											<TableRow key={drop.id}>
												<TableCell>
													<Link
														to={`/${organization.slug}/menu/drops/${drop.id}`}
														className="hover:text-primary text-foreground text-sm font-medium"
													>
														{drop.title}
													</Link>
													<span className="text-muted-foreground block text-xs">
														/drop/{drop.slug}
													</span>
												</TableCell>
												<TableCell>
													<Badge
														variant={
															displayStatus === 'live' ? 'outline' : 'secondary'
														}
														className="text-xs font-medium capitalize"
													>
														<span
															className={cn(
																'mr-1.5 size-1.5 rounded-full',
																displayStatus === 'live'
																	? 'bg-emerald-500'
																	: displayStatus === 'scheduled'
																		? 'bg-amber-500'
																		: 'bg-muted-foreground',
															)}
														/>
														{DROP_STATUS_LABELS[displayStatus]}
													</Badge>
												</TableCell>
												<TableCell className="hidden sm:table-cell">
													{drop.firstPickupDate ? (
														<div className="text-sm">
															<p className="font-medium">
																{drop.firstPickupDate}
															</p>
															{drop.firstPickupLocation && (
																<p className="text-muted-foreground text-xs">
																	{drop.firstPickupLocation}
																</p>
															)}
														</div>
													) : (
														<span className="text-muted-foreground text-xs italic">
															<Trans>No windows</Trans>
														</span>
													)}
												</TableCell>
												<TableCell className="hidden md:table-cell">
													<div className="text-muted-foreground space-y-0.5 text-xs">
														{drop.ordersOpenAt && (
															<p>
																<Trans>Opens:</Trans>{' '}
																{new Date(
																	drop.ordersOpenAt,
																).toLocaleDateString()}
															</p>
														)}
														{drop.ordersCloseAt && (
															<p>
																<Trans>Closes:</Trans>{' '}
																{new Date(
																	drop.ordersCloseAt,
																).toLocaleDateString()}
															</p>
														)}
														{!drop.ordersOpenAt && !drop.ordersCloseAt && (
															<span className="italic">—</span>
														)}
													</div>
												</TableCell>
												<TableCell className="text-right">
													<DropdownMenu>
														<DropdownMenuTrigger
															render={
																<Button
																	variant="ghost"
																	size="icon-sm"
																	aria-label={_(t`Drop actions`)}
																>
																	<Icon name="ellipsis" className="size-4" />
																</Button>
															}
														/>
														<DropdownMenuContent align="end">
															<DropdownMenuItem
																render={
																	<Link
																		to={`/${organization.slug}/menu/drops/${drop.id}`}
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
																render={
																	<a
																		href={`${getOrgSiteUrl(organization.slug)}/drop/${drop.slug}`}
																		target="_blank"
																		rel="noreferrer"
																	>
																		<Icon
																			name="external-link"
																			className="mr-2 size-4"
																		/>
																		<Trans>View storefront</Trans>
																	</a>
																}
															/>
															<DropdownMenuItem
																className="text-destructive focus:text-destructive"
																onClick={() => setDeleteDropId(drop.id)}
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
											{filteredDrops.length === 1 ? (
												<Trans>1 drop</Trans>
											) : (
												// eslint-disable-next-line lingui/no-expression-in-message
												<Trans>{filteredDrops.length} drops</Trans>
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

			{/* Delete Confirmation Alert */}
			<AlertDialog
				open={Boolean(deleteDropId)}
				onOpenChange={(open) => !open && setDeleteDropId(null)}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							<Trans>Delete drop?</Trans>
						</AlertDialogTitle>
						<AlertDialogDescription>
							<Trans>
								This will permanently delete this drop and remove its pickup
								schedule and inventory limits. This action cannot be undone.
							</Trans>
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>
							<Trans>Cancel</Trans>
						</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								if (!deleteDropId) return
								void deleteFetcher.submit(
									{ intent: 'delete-drop', dropId: deleteDropId },
									{ method: 'POST' },
								)
								setDeleteDropId(null)
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
