import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { requireUserId } from '@repo/auth'
import {
	ALLERGEN_LABELS,
	getLocalizedMenuValue,
	type Allergen,
} from '@repo/common/menu-types'
import {
	db,
	eq,
	asc,
	desc,
	and,
	inArray,
	OrganizationMenuOption,
	OrganizationMediaAsset,
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
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'

const DeleteOptionSchema = z.object({
	intent: z.literal('delete-option'),
	optionId: z.string().min(1),
})

const OPTION_FILTER_FIELDS: FilterField[] = [
	{
		id: 'name',
		label: 'Name',
		type: 'text',
		defaultOperator: 'contains',
		placeholder: 'Enter an option name',
		icon: <Icon name="circle" className="size-3.5" />,
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
			{ value: 'topping', label: 'Topping' },
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

	const formData = await request.formData()
	const result = DeleteOptionSchema.safeParse(Object.fromEntries(formData))

	if (!result.success) {
		return Response.json({ error: 'Invalid request' }, { status: 400 })
	}

	await db
		.delete(OrganizationMenuOption)
		.where(
			and(
				eq(OrganizationMenuOption.id, result.data.optionId),
				eq(OrganizationMenuOption.organizationId, organization.id),
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
	// 1. Fetch options with modifier group assignments
	const options = await db.query.OrganizationMenuOption.findMany({
		where: eq(OrganizationMenuOption.organizationId, organization.id),
		with: {
			modifierGroupAssignments: {
				with: {
					modifierGroup: true,
				},
			},
			nestedModifierGroupAssignments: {
				with: {
					modifierGroup: true,
				},
			},
		},
		orderBy: [
			asc(OrganizationMenuOption.position),
			desc(OrganizationMenuOption.createdAt),
		],
	})

	// 2. Resolve media URLs for options with imageKey
	const imageKeys = options
		.map((o) => o.imageKey)
		.filter((k): k is string => Boolean(k))

	const mediaAssets =
		imageKeys.length > 0
			? await db.query.OrganizationMediaAsset.findMany({
					where: inArray(OrganizationMediaAsset.id, imageKeys),
				})
			: []

	const mediaMap = new Map<string, string>()
	for (const m of mediaAssets) {
		const url = `/resources/images?mediaId=${encodeURIComponent(m.id)}&v=${m.updatedAt.getTime()}`
		mediaMap.set(m.id, url)
		mediaMap.set(m.objectKey, url)
	}

	// 3. Combine records for client-side filtering.
	const enrichedOptions = options.map((opt) => {
		let parsedAllergens: string[] = []
		try {
			if (opt.allergens) {
				parsedAllergens = JSON.parse(opt.allergens) as string[]
			}
		} catch {}

		const assignedGroups = (opt.modifierGroupAssignments ?? [])
			.filter((a) => Boolean(a.modifierGroup))
			.map((a) => ({
				id: a.modifierGroup.id,
				name: a.modifierGroup.name,
				internalName: a.modifierGroup.internalName,
			}))

		const nestedGroups = (opt.nestedModifierGroupAssignments ?? [])
			.filter((a) => Boolean(a.modifierGroup))
			.map((a) => ({
				id: a.modifierGroup.id,
				name: a.modifierGroup.name,
				internalName: a.modifierGroup.internalName,
			}))

		return {
			...opt,
			imageUrl: opt.imageKey ? (mediaMap.get(opt.imageKey) ?? null) : null,
			allergensList: parsedAllergens,
			assignedGroups,
			nestedGroups,
		}
	})

	return {
		orgSlug: organization.slug,
		defaultLocale,
		options: enrichedOptions,
		totalCount: options.length,
	}
}

export default function OptionsIndexRoute() {
	const { orgSlug, defaultLocale, options, totalCount } =
		useLoaderData<typeof loader>()
	const { _ } = useLingui()
	const fetcher = useFetcher()

	const [deleteOptionId, setDeleteOptionId] = useState<string | null>(null)
	const getFieldValue = useCallback(
		(option: (typeof options)[number], field: string) => {
			switch (field) {
				case 'name':
					return getLocalizedMenuValue(
						option.displayName,
						defaultLocale,
						defaultLocale,
					)
				case 'internalName':
					return option.internalName ?? ''
				case 'status':
					return option.availabilityStatus
				case 'attributes':
					return [
						...(option.isTopping ? ['topping'] : []),
						...(option.isVegetarian ? ['vegetarian'] : []),
						...(option.isGlutenFree ? ['gluten_free'] : []),
						...(option.isAlcohol ? ['alcohol'] : []),
					]
				default:
					return ''
			}
		},
		[defaultLocale],
	)
	const {
		filterQuery,
		filteredRecords: filteredOptions,
		hasFilters,
		setFilterQuery,
	} = useMenuListFilters(options, OPTION_FILTER_FIELDS, getFieldValue)
	const filteredOptionsCount = filteredOptions.length

	const confirmDelete = () => {
		if (!deleteOptionId) return
		void fetcher.submit(
			{ intent: 'delete-option', optionId: deleteOptionId },
			{ method: 'POST' },
		)
		setDeleteOptionId(null)
	}

	return (
		<div className="space-y-6">
			{/* Page Header */}
			<PageHeader
				title={_(t`Menu Options`)}
				description={_(
					t`Reusable options with images, pricing, allergens, and dietary profiles assigned across multiple modifier groups.`,
				)}
				headingLevel="h2"
				size="section"
				actions={
					<Button render={<Link to={`/${orgSlug}/menu/options/new`} />}>
						<Icon name="plus" className="size-4" />
						<Trans>Create Option</Trans>
					</Button>
				}
			/>

			<Filters
				fields={OPTION_FILTER_FIELDS}
				query={filterQuery}
				onQueryChange={setFilterQuery}
				showClear
			/>

			{/* Main Options Table */}
			{filteredOptionsCount === 0 ? (
				<EmptyState
					icons={['image', 'blocks', 'sparkles']}
					title={_(t`No options found`)}
					description={
						totalCount === 0
							? _(
									t`Create your first menu option to customize modifier groups and menu items.`,
								)
							: hasFilters
								? _(
										t`Try adjusting your filters or clear them to see all options.`,
									)
								: _(t`No options match your active filters.`)
					}
					action={
						totalCount === 0
							? {
									label: _(t`Create Option`),
									href: `/${orgSlug}/menu/options/new`,
								}
							: undefined
					}
				/>
			) : (
				<Frame>
					<Table variant="card">
						<TableHeader>
							<TableRow>
								<TableHead>
									<Trans>Option</Trans>
								</TableHead>
								<TableHead>
									<Trans>Price Delta</Trans>
								</TableHead>
								<TableHead className="hidden md:table-cell">
									<Trans>Dietary & Allergens</Trans>
								</TableHead>
								<TableHead className="hidden sm:table-cell">
									<Trans>Assigned Groups</Trans>
								</TableHead>
								<TableHead>
									<Trans>Status</Trans>
								</TableHead>
								<TableHead className="w-[80px] text-right">
									<Trans>Actions</Trans>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{filteredOptions.map((option) => {
								const displayName = getLocalizedMenuValue(
									option.displayName,
									defaultLocale,
									defaultLocale,
								)

								return (
									<TableRow key={option.id}>
										{/* Option with Image & Name */}
										<TableCell>
											<div className="flex items-center gap-3">
												{option.imageUrl ? (
													<img
														src={option.imageUrl}
														alt={displayName}
														className="border-border size-10 shrink-0 rounded-md border object-cover"
													/>
												) : (
													<div className="border-border bg-muted/40 text-muted-foreground flex size-10 shrink-0 items-center justify-center rounded-md border">
														<Icon
															name="file-text"
															className="size-4 opacity-50"
														/>
													</div>
												)}
												<div className="min-w-0">
													<Link
														to={`/${orgSlug}/menu/options/${option.id}`}
														className="text-foreground block truncate font-medium hover:underline"
													>
														{displayName}
													</Link>
													{option.internalName && (
														<p className="text-muted-foreground truncate font-mono text-xs">
															{option.internalName}
														</p>
													)}
												</div>
											</div>
										</TableCell>

										{/* Price Delta */}
										<TableCell>
											<div className="space-y-0.5">
												<span className="text-sm">
													{option.price > 0
														? `+$${option.price.toFixed(2)}`
														: _(t`Free ($0.00)`)}
												</span>
												{option.isTopping && option.priceWhole != null && (
													<p className="text-muted-foreground text-[11px]">
														<Trans>Whole</Trans>: $
														{option.priceWhole.toFixed(2)} • <Trans>Half</Trans>
														: $
														{(
															option.priceLeft ?? option.priceWhole / 2
														).toFixed(2)}
													</p>
												)}
											</div>
										</TableCell>

										{/* Dietary & Allergens */}
										<TableCell className="hidden md:table-cell">
											<div className="flex max-w-xs flex-wrap gap-1">
												{option.isGlutenFree && (
													<Badge
														variant="outline"
														className="border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0 text-[10px] text-emerald-600"
													>
														GF
													</Badge>
												)}
												{option.isVegetarian && (
													<Badge
														variant="outline"
														className="border-green-500/30 bg-green-500/10 px-1.5 py-0 text-[10px] text-green-600"
													>
														VEG
													</Badge>
												)}
												{option.isAlcohol && (
													<Badge
														variant="outline"
														className="border-amber-500/30 bg-amber-500/10 px-1.5 py-0 text-[10px] text-amber-600"
													>
														21+
													</Badge>
												)}
												{option.isTopping && (
													<Badge
														variant="outline"
														className="border-primary/30 text-primary bg-primary/10 px-1.5 py-0 text-[10px]"
													>
														<Trans>Topping</Trans>
													</Badge>
												)}
												{option.allergensList.map((alg) => (
													<Badge
														key={alg}
														variant="secondary"
														className="px-1.5 py-0 text-[10px]"
													>
														{ALLERGEN_LABELS[alg as Allergen] ?? alg}
													</Badge>
												))}
												{!option.isGlutenFree &&
													!option.isVegetarian &&
													!option.isAlcohol &&
													!option.isTopping &&
													option.allergensList.length === 0 && (
														<span className="text-muted-foreground text-xs">
															—
														</span>
													)}
											</div>
										</TableCell>

										{/* Assigned Modifier Groups (Many-to-Many) */}
										<TableCell className="hidden sm:table-cell">
											<div className="space-y-1">
												<div className="flex max-w-xs flex-wrap gap-1">
													{option.assignedGroups.length === 0 ? (
														<span className="text-muted-foreground text-xs italic">
															<Trans>Unassigned</Trans>
														</span>
													) : (
														option.assignedGroups.map((g) => (
															<Badge
																key={g.id}
																variant="outline"
																className="text-xs"
															>
																{getLocalizedMenuValue(
																	g.name,
																	defaultLocale,
																	defaultLocale,
																)}
															</Badge>
														))
													)}
												</div>
												{option.nestedGroups &&
													option.nestedGroups.length > 0 && (
														<div className="flex flex-wrap items-center gap-1 text-[11px] text-indigo-600 dark:text-indigo-400">
															<Icon name="route" className="size-3" />
															<span>
																<Trans>Triggers sub-groups:</Trans>
															</span>
															{option.nestedGroups.map((g) => (
																<Badge
																	key={g.id}
																	variant="secondary"
																	className="px-1 py-0 text-[10px] font-normal"
																>
																	{getLocalizedMenuValue(
																		g.name,
																		defaultLocale,
																		defaultLocale,
																	)}
																</Badge>
															))}
														</div>
													)}
											</div>
										</TableCell>

										{/* Status */}
										<TableCell>
											<MenuStatusBadge
												status={option.availabilityStatus}
												unavailableUntil={option.unavailableUntil}
											/>
										</TableCell>

										{/* Actions */}
										<TableCell className="text-right">
											<DropdownMenu>
												<DropdownMenuTrigger
													render={
														<Button
															variant="ghost"
															size="icon-sm"
															aria-label={_(t`Option actions`)}
														>
															<Icon name="ellipsis" className="size-4" />
														</Button>
													}
												/>
												<DropdownMenuContent align="end">
													<DropdownMenuItem
														render={
															<Link
																to={`/${orgSlug}/menu/options/${option.id}`}
															>
																<Icon name="pencil" className="mr-2 size-4" />
																<Trans>Edit Details</Trans>
															</Link>
														}
													/>
													<DropdownMenuItem
														onClick={() => setDeleteOptionId(option.id)}
														className="text-destructive focus:text-destructive"
													>
														<Icon name="trash-2" className="mr-2 size-4" />
														<Trans>Delete Option</Trans>
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
								<TableCell
									colSpan={6}
									className="text-muted-foreground text-xs"
								>
									<Trans>
										Showing {filteredOptionsCount} of {totalCount} options
									</Trans>
								</TableCell>
							</TableRow>
						</TableFooter>
					</Table>
				</Frame>
			)}

			{/* Delete Confirmation Dialog */}
			<AlertDialog
				open={Boolean(deleteOptionId)}
				onOpenChange={(open) => !open && setDeleteOptionId(null)}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							<Trans>Delete Menu Option?</Trans>
						</AlertDialogTitle>
						<AlertDialogDescription>
							<Trans>
								This will permanently remove this option and unassign it from
								all modifier groups. This action cannot be undone.
							</Trans>
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>
							<Trans>Cancel</Trans>
						</AlertDialogCancel>
						<AlertDialogAction onClick={confirmDelete}>
							<Trans>Delete Option</Trans>
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	)
}
