import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { requireUserId } from '@repo/auth'
import { getLocalizedMenuValue } from '@repo/common/menu-types'
import {
	db,
	eq,
	asc,
	desc,
	and,
	OrganizationMenuModifierGroup,
	OrganizationMenuOption,
	OrganizationMenuModifierGroupOptionAssignment,
	OrganizationMenuOptionNestedModifierGroupAssignment,
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

const DeleteModifierGroupSchema = z.object({
	intent: z.literal('delete-modifier-group'),
	modifierGroupId: z.string().min(1),
})

const MODIFIER_GROUP_FILTER_FIELDS: FilterField[] = [
	{
		id: 'name',
		label: 'Name',
		type: 'text',
		defaultOperator: 'contains',
		placeholder: 'Enter a modifier group name',
		icon: <Icon name="blocks" className="size-3.5" />,
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
		id: 'selectionType',
		label: 'Type',
		type: 'select',
		defaultOperator: 'is_any_of',
		searchable: false,
		icon: <Icon name="menu" className="size-3.5" />,
		options: [
			{ value: 'single', label: 'Single selection' },
			{ value: 'multiple', label: 'Multiple selection' },
			{ value: 'quantity', label: 'Quantity' },
			{ value: 'pizza', label: 'Pizza' },
		],
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
	const result = DeleteModifierGroupSchema.safeParse(
		Object.fromEntries(formData),
	)

	if (!result.success) {
		return Response.json({ error: 'Invalid request' }, { status: 400 })
	}

	await db
		.delete(OrganizationMenuModifierGroup)
		.where(
			and(
				eq(OrganizationMenuModifierGroup.id, result.data.modifierGroupId),
				eq(OrganizationMenuModifierGroup.organizationId, organization.id),
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
	const nestedAssignments = await db
		.select({
			modifierGroupId:
				OrganizationMenuOptionNestedModifierGroupAssignment.modifierGroupId,
			parentOptionName: OrganizationMenuOption.displayName,
		})
		.from(OrganizationMenuOptionNestedModifierGroupAssignment)
		.innerJoin(
			OrganizationMenuOption,
			eq(
				OrganizationMenuOption.id,
				OrganizationMenuOptionNestedModifierGroupAssignment.optionId,
			),
		)
		.where(eq(OrganizationMenuOption.organizationId, organization.id))

	const nestedParentMap = new Map<string, string[]>()
	for (const a of nestedAssignments) {
		const list = nestedParentMap.get(a.modifierGroupId) ?? []
		list.push(a.parentOptionName)
		nestedParentMap.set(a.modifierGroupId, list)
	}

	const optionSubGroupAssignments = await db
		.select({
			parentModifierGroupId:
				OrganizationMenuModifierGroupOptionAssignment.modifierGroupId,
			childSubGroupName: OrganizationMenuModifierGroup.name,
		})
		.from(OrganizationMenuOptionNestedModifierGroupAssignment)
		.innerJoin(
			OrganizationMenuModifierGroupOptionAssignment,
			eq(
				OrganizationMenuModifierGroupOptionAssignment.optionId,
				OrganizationMenuOptionNestedModifierGroupAssignment.optionId,
			),
		)
		.innerJoin(
			OrganizationMenuModifierGroup,
			eq(
				OrganizationMenuModifierGroup.id,
				OrganizationMenuOptionNestedModifierGroupAssignment.modifierGroupId,
			),
		)
		.where(eq(OrganizationMenuModifierGroup.organizationId, organization.id))

	const groupChildSubGroupsMap = new Map<string, string[]>()
	for (const a of optionSubGroupAssignments) {
		const list = groupChildSubGroupsMap.get(a.parentModifierGroupId) ?? []
		list.push(a.childSubGroupName)
		groupChildSubGroupsMap.set(a.parentModifierGroupId, list)
	}

	const groups = await db.query.OrganizationMenuModifierGroup.findMany({
		where: eq(OrganizationMenuModifierGroup.organizationId, organization.id),
		with: {
			optionAssignments: true,
		},
		orderBy: [
			asc(OrganizationMenuModifierGroup.position),
			desc(OrganizationMenuModifierGroup.createdAt),
		],
	})

	return {
		organization,
		defaultLocale,
		groups: groups.map((g) => ({
			id: g.id,
			name: g.name,
			internalName: g.internalName,
			selectionType: g.selectionType,
			minSelections: g.minSelections,
			maxSelections: g.maxSelections,
			availabilityStatus: g.availabilityStatus,
			unavailableUntil: g.unavailableUntil
				? g.unavailableUntil.toISOString()
				: null,
			optionsCount: g.optionAssignments.length,
			updatedAt: g.updatedAt.toISOString(),
			parentOptions: nestedParentMap.get(g.id) ?? [],
			childSubGroups: groupChildSubGroupsMap.get(g.id) ?? [],
		})),
	}
}

export default function ModifiersIndexRoute() {
	const { organization, defaultLocale, groups } = useLoaderData<typeof loader>()
	const { _ } = useLingui()
	const deleteFetcher = useFetcher()
	const [deleteGroupId, setDeleteGroupId] = useState<string | null>(null)
	const getFieldValue = useCallback(
		(group: (typeof groups)[number], field: string) => {
			switch (field) {
				case 'name':
					return (
						getLocalizedMenuValue(group.name, defaultLocale, defaultLocale) ||
						group.internalName ||
						''
					)
				case 'internalName':
					return group.internalName ?? ''
				case 'selectionType':
					return group.selectionType
				case 'status':
					return group.availabilityStatus
				default:
					return ''
			}
		},
		[defaultLocale],
	)
	const {
		filterQuery,
		filteredRecords: filteredGroups,
		hasFilters,
		setFilterQuery,
	} = useMenuListFilters(groups, MODIFIER_GROUP_FILTER_FIELDS, getFieldValue)

	return (
		<div className="space-y-8">
			<PageHeader
				title={<Trans>Modifier Groups</Trans>}
				description={
					<Trans>
						Create custom options, toppings, crusts, temperatures, and choices
						for your dishes.
					</Trans>
				}
				headingLevel="h2"
				size="section"
				actions={
					<Button
						render={<Link to={`/${organization.slug}/menu/modifiers/new`} />}
					>
						<Icon name="plus" className="size-4" />
						<Trans>Create Modifier Group</Trans>
					</Button>
				}
			/>

			{groups.length === 0 ? (
				<EmptyState
					title={_(t`No modifier groups yet`)}
					description={_(
						t`Create modifier groups like "Meat Temperature", "Choice of Dressing", or "Pizza Toppings".`,
					)}
					icons={['blocks', 'sparkles']}
				/>
			) : (
				<div className="space-y-4">
					<Filters
						fields={MODIFIER_GROUP_FILTER_FIELDS}
						query={filterQuery}
						onQueryChange={setFilterQuery}
						showClear
					/>

					{filteredGroups.length === 0 ? (
						<EmptyState
							title={_(t`No modifier groups match these filters`)}
							description={_(
								hasFilters
									? t`Try adjusting your filters or clear them to see all modifier groups.`
									: t`Create a modifier group to start offering custom choices.`,
							)}
							icons={['search']}
						/>
					) : (
						<Frame className="w-full">
							<Table variant="card">
								<TableHeader>
									<TableRow>
										<TableHead>
											<Trans>Modifier Group</Trans>
										</TableHead>
										<TableHead>
											<Trans>Type</Trans>
										</TableHead>
										<TableHead className="hidden sm:table-cell">
											<Trans>Options</Trans>
										</TableHead>
										<TableHead className="hidden md:table-cell">
											<Trans>Rules</Trans>
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
									{filteredGroups.map((group) => {
										const groupTitle =
											getLocalizedMenuValue(
												group.name,
												defaultLocale,
												defaultLocale,
											) ||
											group.internalName ||
											'Untitled Group'

										return (
											<TableRow key={group.id}>
												<TableCell>
													<div className="flex items-center gap-2">
														<Link
															to={`/${organization.slug}/menu/modifiers/${group.id}`}
															className="hover:text-primary text-foreground text-sm font-medium"
														>
															{groupTitle}
														</Link>
														{group.parentOptions &&
															group.parentOptions.length > 0 && (
																<Badge
																	variant="outline"
																	className="gap-1 border-indigo-500/30 bg-indigo-500/10 px-1.5 py-0 text-[10px] text-indigo-600"
																>
																	<Icon name="route" className="size-2.5" />
																	<Trans>Nested Modifier</Trans>
																</Badge>
															)}
													</div>
													{group.internalName && (
														<span className="text-muted-foreground block text-xs">
															{group.internalName}
														</span>
													)}
													{group.parentOptions &&
														group.parentOptions.length > 0 && (
															<p className="text-muted-foreground mt-0.5 text-[11px]">
																<Trans>Nested under:</Trans>{' '}
																{group.parentOptions
																	.map(
																		(opt: string) =>
																			getLocalizedMenuValue(
																				opt,
																				defaultLocale,
																				defaultLocale,
																			) || opt,
																	)
																	.join(', ')}
															</p>
														)}
												</TableCell>
												<TableCell>
													<Badge
														variant="outline"
														className="text-xs capitalize"
													>
														{group.selectionType}
													</Badge>
												</TableCell>
												<TableCell className="hidden sm:table-cell">
													<span className="text-muted-foreground text-sm">
														{group.optionsCount}{' '}
														{group.optionsCount === 1 ? 'option' : 'options'}
													</span>
												</TableCell>
												<TableCell className="hidden md:table-cell">
													<span className="text-muted-foreground text-xs">
														{group.minSelections > 0
															? `Required (min ${group.minSelections}${
																	group.maxSelections
																		? `, max ${group.maxSelections}`
																		: ''
																})`
															: group.maxSelections
																? `Optional (max ${group.maxSelections})`
																: 'Optional'}
													</span>
												</TableCell>
												<TableCell>
													<MenuStatusBadge
														status={group.availabilityStatus}
														unavailableUntil={group.unavailableUntil}
													/>
												</TableCell>
												<TableCell className="text-right">
													<DropdownMenu>
														<DropdownMenuTrigger
															render={
																<Button
																	variant="ghost"
																	size="icon-sm"
																	aria-label={_(t`Modifier group actions`)}
																>
																	<Icon name="ellipsis" className="size-4" />
																</Button>
															}
														/>
														<DropdownMenuContent align="end">
															<DropdownMenuItem
																render={
																	<Link
																		to={`/${organization.slug}/menu/modifiers/${group.id}`}
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
																onClick={() => setDeleteGroupId(group.id)}
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
											{filteredGroups.length === 1 ? (
												<Trans>1 modifier group</Trans>
											) : (
												// eslint-disable-next-line lingui/no-expression-in-message
												<Trans>{filteredGroups.length} modifier groups</Trans>
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
				open={Boolean(deleteGroupId)}
				onOpenChange={(open) => !open && setDeleteGroupId(null)}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							<Trans>Delete modifier group?</Trans>
						</AlertDialogTitle>
						<AlertDialogDescription>
							<Trans>
								This will permanently delete this modifier group and its
								options. Items using this modifier group will no longer offer
								these choices.
							</Trans>
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>
							<Trans>Cancel</Trans>
						</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								if (!deleteGroupId) return
								void deleteFetcher.submit(
									{
										intent: 'delete-modifier-group',
										modifierGroupId: deleteGroupId,
									},
									{ method: 'POST' },
								)
								setDeleteGroupId(null)
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
