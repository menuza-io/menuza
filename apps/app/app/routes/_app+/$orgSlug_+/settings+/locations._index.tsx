import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { requireUserId } from '@repo/auth'
import {
	type FulfillmentOptions,
	type LocationAddress,
} from '@repo/common/location-types'
import { pickLocalized } from '@repo/common/site-locales'
import { and, db, eq, OrganizationLocation } from '@repo/database'
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
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@repo/ui/dropdown-menu'
import {
	BadgesOrStack,
	createFilterQuery,
	Filters,
	flattenFilterConditions,
	type FilterCondition,
	type FilterField,
} from '@repo/ui/filters'
import { Frame } from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import {
	Table,
	TableBody,
	TableCell,
	TableFooter,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { useMemo, useState } from 'react'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	Link,
	useFetcher,
	useLoaderData,
	useNavigate,
} from 'react-router'
import { EmptyState } from '#app/components/empty-state.tsx'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	requireUserWithOrganizationPermission,
	ORG_PERMISSIONS,
} from '#app/utils/organization/permissions.server.ts'

interface LocationListItem {
	id: string
	name: string
	slug: string
	phone: string | null
	timezone: string
	city: string
	formattedAddress: string
	isActive: boolean
	isDefault: boolean
	fulfillment: {
		pickup: boolean
		delivery: boolean
		dineIn: boolean
		curbside: boolean
	}
}

const STATUS_TONES = {
	active: {
		dot: 'bg-emerald-500',
		badge:
			'border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:border-emerald-400/25 dark:bg-emerald-400/15 dark:text-emerald-300',
	},
	inactive: {
		dot: 'bg-muted-foreground/64',
		badge:
			'border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground',
	},
} as const

function Swatch({ className }: { className: string }) {
	return (
		<span
			aria-hidden="true"
			className={cn('size-2.5 shrink-0 rounded-full', className)}
		/>
	)
}

const LOCATION_FILTER_FIELDS: FilterField[] = [
	{
		id: 'status',
		label: 'Status',
		type: 'select',
		defaultOperator: 'is_any_of',
		searchable: false,
		icon: <Icon name="circle-check" className="size-3.5" />,
		options: [
			{
				value: 'active',
				label: 'Active',
				icon: <Swatch className={STATUS_TONES.active.dot} />,
			},
			{
				value: 'inactive',
				label: 'Inactive',
				icon: <Swatch className={STATUS_TONES.inactive.dot} />,
			},
		],
		renderValue: ({ options }) => (
			<BadgesOrStack
				options={options}
				fallback="any status"
				// eslint-disable-next-line shadcn/require-static-classes -- classes come from the static tone map above
				badgeClassName={(value) =>
					STATUS_TONES[value as keyof typeof STATUS_TONES]?.badge
				}
				// eslint-disable-next-line shadcn/require-static-classes -- classes come from the static tone map above
				dotClassName={(value) =>
					STATUS_TONES[value as keyof typeof STATUS_TONES]?.dot
				}
			/>
		),
	},
	{
		id: 'name',
		label: 'Name',
		type: 'text',
		defaultOperator: 'contains',
		placeholder: 'Search by name',
		icon: <Icon name="building" className="size-3.5" />,
	},
	{
		id: 'city',
		label: 'City',
		type: 'text',
		defaultOperator: 'contains',
		placeholder: 'Filter by city',
		icon: <Icon name="route" className="size-3.5" />,
	},
	{
		id: 'fulfillment',
		label: 'Fulfillment',
		type: 'select',
		defaultOperator: 'is_any_of',
		searchable: false,
		icon: <Icon name="blocks" className="size-3.5" />,
		options: [
			{ value: 'pickup', label: 'Pickup' },
			{ value: 'delivery', label: 'Delivery' },
			{ value: 'dineIn', label: 'Dine-In' },
			{ value: 'curbside', label: 'Curbside' },
		],
	},
]

function matchesTextOperator(
	value: string,
	operator: string,
	values: unknown[],
): boolean {
	const haystack = value.toLowerCase()
	const needle = String(values[0] ?? '').toLowerCase()

	switch (operator) {
		case 'contains':
			return haystack.includes(needle)
		case 'not_contains':
			return !haystack.includes(needle)
		case 'starts_with':
			return haystack.startsWith(needle)
		case 'ends_with':
			return haystack.endsWith(needle)
		case 'is':
			return haystack === needle
		case 'is_not':
			return haystack !== needle
		case 'empty':
			return haystack.trim().length === 0
		case 'not_empty':
			return haystack.trim().length > 0
		default:
			return true
	}
}

function matchesSelectOperator(
	value: string | string[],
	operator: string,
	values: unknown[],
): boolean {
	const selected = values.map(String)

	if (Array.isArray(value)) {
		switch (operator) {
			case 'is_any_of':
			case 'has_any_of':
				return selected.length === 0 || selected.some((s) => value.includes(s))
			case 'has_all_of':
				return selected.every((s) => value.includes(s))
			case 'has_none_of':
				return !selected.some((s) => value.includes(s))
			default:
				return true
		}
	}

	switch (operator) {
		case 'is':
			return selected.length > 0 && selected[0] === value
		case 'is_not':
			return selected.length > 0 && selected[0] !== value
		case 'is_any_of':
			return selected.length === 0 || selected.includes(value)
		case 'is_none_of':
			return selected.length > 0 && !selected.includes(value)
		case 'empty':
			return value.trim().length === 0
		case 'not_empty':
			return value.trim().length > 0
		default:
			return true
	}
}

function matchesLocationCondition(
	location: LocationListItem,
	condition: FilterCondition,
): boolean {
	let value: string | string[] = ''
	switch (condition.field) {
		case 'status':
			value = location.isActive ? 'active' : 'inactive'
			break
		case 'name':
			value = location.name
			break
		case 'city':
			value = location.city || location.formattedAddress
			break
		case 'fulfillment': {
			const enabled: string[] = []
			if (location.fulfillment.pickup) enabled.push('pickup')
			if (location.fulfillment.delivery) enabled.push('delivery')
			if (location.fulfillment.dineIn) enabled.push('dineIn')
			if (location.fulfillment.curbside) enabled.push('curbside')
			value = enabled
			break
		}
		default:
			return true
	}

	const matches =
		condition.field === 'status' || condition.field === 'fulfillment'
			? matchesSelectOperator(value, condition.operator, condition.values)
			: matchesTextOperator(
					value as string,
					condition.operator,
					condition.values,
				)

	return condition.negated ? !matches : matches
}

export async function loader({ request, params }: LoaderFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		name: true,
		siteDefaultLocale: true,
	})

	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.READ_SETTINGS_ANY,
	)

	const defaultLocale = organization.siteDefaultLocale ?? 'en'

	const dbLocations = await db.query.OrganizationLocation.findMany({
		where: eq(OrganizationLocation.organizationId, organization.id),
		orderBy: (loc, { desc, asc }) => [desc(loc.isDefault), asc(loc.name)],
	})

	const locations: LocationListItem[] = dbLocations.map((loc) => {
		let city = ''
		let formattedAddress = ''
		if (loc.address) {
			try {
				const addr = JSON.parse(loc.address) as LocationAddress
				city = addr.city || ''
				formattedAddress = addr.formattedAddress || ''
			} catch {}
		}

		let fulfillment: FulfillmentOptions = {
			pickup: true,
			delivery: false,
			dineIn: false,
			curbside: false,
		}
		if (loc.fulfillmentOptions) {
			try {
				const f = JSON.parse(loc.fulfillmentOptions) as FulfillmentOptions
				fulfillment = {
					pickup: typeof f.pickup === 'boolean' ? f.pickup : true,
					delivery: typeof f.delivery === 'boolean' ? f.delivery : false,
					dineIn: typeof f.dineIn === 'boolean' ? f.dineIn : false,
					curbside: typeof f.curbside === 'boolean' ? f.curbside : false,
				}
			} catch {}
		}

		return {
			id: loc.id,
			name: pickLocalized(loc.name, defaultLocale, defaultLocale) || loc.name,
			slug: loc.slug,
			phone: loc.phone,
			timezone: loc.timezone,
			city,
			formattedAddress,
			isActive: loc.isActive,
			isDefault: loc.isDefault,
			fulfillment,
		}
	})

	return {
		organization,
		locations,
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
	})

	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
	)

	const formData = await request.formData()
	const intent = formData.get('intent')

	if (intent === 'toggle-active') {
		const locationId = formData.get('locationId')
		const isActive = formData.get('isActive') === 'true'

		if (typeof locationId !== 'string') {
			return { error: 'Location ID is required' }
		}

		await db
			.update(OrganizationLocation)
			.set({ isActive })
			.where(
				and(
					eq(OrganizationLocation.id, locationId),
					eq(OrganizationLocation.organizationId, organization.id),
				),
			)

		return { success: true }
	}

	if (intent === 'set-default') {
		const locationId = formData.get('locationId')
		if (typeof locationId !== 'string') {
			return { error: 'Location ID is required' }
		}

		await db.transaction(async (tx) => {
			await tx
				.update(OrganizationLocation)
				.set({ isDefault: false })
				.where(eq(OrganizationLocation.organizationId, organization.id))

			await tx
				.update(OrganizationLocation)
				.set({ isDefault: true })
				.where(
					and(
						eq(OrganizationLocation.id, locationId),
						eq(OrganizationLocation.organizationId, organization.id),
					),
				)
		})

		return { success: true }
	}

	if (intent === 'delete-location') {
		const locationId = formData.get('locationId')
		if (typeof locationId !== 'string') {
			return { error: 'Location ID is required' }
		}

		const [location] = await db
			.select({
				id: OrganizationLocation.id,
				isDefault: OrganizationLocation.isDefault,
			})
			.from(OrganizationLocation)
			.where(
				and(
					eq(OrganizationLocation.id, locationId),
					eq(OrganizationLocation.organizationId, organization.id),
				),
			)
			.limit(1)

		if (!location) {
			return { error: 'Location not found' }
		}

		await db
			.delete(OrganizationLocation)
			.where(
				and(
					eq(OrganizationLocation.id, locationId),
					eq(OrganizationLocation.organizationId, organization.id),
				),
			)

		return { success: true }
	}

	return { error: 'Unsupported intent' }
}

export default function LocationsIndexRoute() {
	const { _ } = useLingui()
	const { organization, locations } = useLoaderData<typeof loader>()
	const fetcher = useFetcher()
	const navigate = useNavigate()

	const [filterQuery, setFilterQuery] = useState(createFilterQuery())
	const [locationToDelete, setLocationToDelete] =
		useState<LocationListItem | null>(null)

	const filterConditions = useMemo(
		() => flattenFilterConditions(filterQuery),
		[filterQuery],
	)

	const filteredLocations = useMemo(
		() =>
			locations.filter((location) =>
				filterConditions.every((condition) =>
					matchesLocationCondition(location, condition),
				),
			),
		[locations, filterConditions],
	)

	const hasFilters = filterConditions.length > 0

	const handleToggleActive = (loc: LocationListItem) => {
		void fetcher.submit(
			{
				intent: 'toggle-active',
				locationId: loc.id,
				isActive: String(!loc.isActive),
			},
			{ method: 'POST' },
		)
	}

	const handleSetDefault = (loc: LocationListItem) => {
		void fetcher.submit(
			{
				intent: 'set-default',
				locationId: loc.id,
			},
			{ method: 'POST' },
		)
	}

	const handleDeleteConfirm = () => {
		if (!locationToDelete) return
		void fetcher.submit(
			{
				intent: 'delete-location',
				locationId: locationToDelete.id,
			},
			{ method: 'POST' },
		)
		setLocationToDelete(null)
	}

	return (
		<div className="flex flex-col gap-6">
			<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
				<div>
					<h2 className="text-xl tracking-tight">
						<Trans>Locations</Trans>
					</h2>
					<p className="text-muted-foreground text-sm">
						<Trans>
							Manage restaurant locations, store hours, fulfillment methods, and
							delivery zones.
						</Trans>
					</p>
				</div>
				<Button
					render={<Link to={`/${organization.slug}/settings/locations/new`} />}
				>
					<Icon name="plus" className="size-4" />
					<Trans>Add Location</Trans>
				</Button>
			</div>

			<div className="space-y-4">
				<Filters
					fields={LOCATION_FILTER_FIELDS}
					query={filterQuery}
					onQueryChange={setFilterQuery}
					showClear
				/>

				{locations.length === 0 ? (
					<EmptyState
						title={_(t`No locations yet`)}
						description={_(
							t`Add your restaurant's first location to configure operating hours, menu availability, and delivery zones.`,
						)}
						action={{
							label: _(t`Add Location`),
							href: `/${organization.slug}/settings/locations/new`,
						}}
					/>
				) : filteredLocations.length === 0 ? (
					<EmptyState
						title={_(t`No matching locations`)}
						description={
							hasFilters
								? _(
										t`Try adjusting your filters or clear them to see all restaurant locations.`,
									)
								: _(t`No locations found.`)
						}
					/>
				) : (
					<Frame className="w-full">
						<Table variant="card">
							<TableHeader>
								<TableRow>
									<TableHead>
										<Trans>Location</Trans>
									</TableHead>
									<TableHead className="hidden sm:table-cell">
										<Trans>Address</Trans>
									</TableHead>
									<TableHead className="hidden md:table-cell">
										<Trans>Phone</Trans>
									</TableHead>
									<TableHead className="hidden lg:table-cell">
										<Trans>Fulfillment</Trans>
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
								{filteredLocations.map((loc) => (
									<TableRow
										key={loc.id}
										className="cursor-pointer"
										onClick={() => {
											void navigate(
												`/${organization.slug}/settings/locations/${loc.id}`,
											)
										}}
										tabIndex={0}
										onKeyDown={(e) => {
											if (e.key === 'Enter' || e.key === ' ') {
												e.preventDefault()
												void navigate(
													`/${organization.slug}/settings/locations/${loc.id}`,
												)
											}
										}}
									>
										<TableCell className="font-medium">
											<div className="flex items-center gap-2">
												<span>{loc.name}</span>
												{loc.isDefault ? (
													<Badge variant="secondary" className="text-[10px]">
														<Trans>Default</Trans>
													</Badge>
												) : null}
											</div>
											<div className="text-muted-foreground text-xs font-normal">
												/{loc.slug}
											</div>
										</TableCell>
										<TableCell className="text-muted-foreground hidden text-sm sm:table-cell">
											{loc.formattedAddress || loc.city || '—'}
										</TableCell>
										<TableCell className="text-muted-foreground hidden text-sm md:table-cell">
											{loc.phone || '—'}
										</TableCell>
										<TableCell className="hidden lg:table-cell">
											<div className="flex flex-wrap gap-1">
												{loc.fulfillment.pickup ? (
													<Badge variant="outline" className="text-[10px]">
														<Trans>Pickup</Trans>
													</Badge>
												) : null}
												{loc.fulfillment.delivery ? (
													<Badge variant="outline" className="text-[10px]">
														<Trans>Delivery</Trans>
													</Badge>
												) : null}
												{loc.fulfillment.dineIn ? (
													<Badge variant="outline" className="text-[10px]">
														<Trans>Dine-in</Trans>
													</Badge>
												) : null}
												{loc.fulfillment.curbside ? (
													<Badge variant="outline" className="text-[10px]">
														<Trans>Curbside</Trans>
													</Badge>
												) : null}
											</div>
										</TableCell>
										<TableCell>
											<Badge variant="outline">
												<span
													aria-hidden="true"
													className={cn(
														'size-1.5 rounded-full',
														loc.isActive
															? 'bg-emerald-500'
															: 'bg-muted-foreground/64',
													)}
												/>
												{loc.isActive ? (
													<Trans>Active</Trans>
												) : (
													<Trans>Inactive</Trans>
												)}
											</Badge>
										</TableCell>
										<TableCell
											className="text-right"
											onClick={(e) => e.stopPropagation()}
										>
											<DropdownMenu>
												<DropdownMenuTrigger
													render={
														<Button
															variant="ghost"
															size="icon"
															className="size-8"
														/>
													}
												>
													<Icon name="ellipsis" className="size-4" />
													<span className="sr-only">
														<Trans>Actions</Trans>
													</span>
												</DropdownMenuTrigger>
												<DropdownMenuContent align="end">
													<DropdownMenuItem
														render={
															<Link
																to={`/${organization.slug}/settings/locations/${loc.id}`}
															/>
														}
													>
														<Icon name="pencil" className="size-4" />
														<Trans>Edit Details</Trans>
													</DropdownMenuItem>

													{!loc.isDefault ? (
														<DropdownMenuItem
															onClick={() => handleSetDefault(loc)}
														>
															<Icon name="circle-check" className="size-4" />
															<Trans>Set as Default</Trans>
														</DropdownMenuItem>
													) : null}

													<DropdownMenuItem
														onClick={() => handleToggleActive(loc)}
													>
														<Icon
															name={loc.isActive ? 'ban' : 'check'}
															className="size-4"
														/>
														{loc.isActive ? (
															<Trans>Mark Inactive</Trans>
														) : (
															<Trans>Mark Active</Trans>
														)}
													</DropdownMenuItem>

													<DropdownMenuSeparator />

													<DropdownMenuItem
														className="text-destructive focus:text-destructive"
														onClick={() => setLocationToDelete(loc)}
													>
														<Icon name="trash-2" className="size-4" />
														<Trans>Delete</Trans>
													</DropdownMenuItem>
												</DropdownMenuContent>
											</DropdownMenu>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
							<TableFooter>
								<TableRow>
									{(() => {
										const count = filteredLocations.length
										return (
											<TableCell colSpan={5}>
												{count === 1 ? (
													<Trans>1 location</Trans>
												) : (
													<Trans>{count} locations</Trans>
												)}
											</TableCell>
										)
									})()}
									<TableCell />
								</TableRow>
							</TableFooter>
						</Table>
					</Frame>
				)}
			</div>

			{/* Delete Location Confirmation Dialog */}
			<AlertDialog
				open={locationToDelete !== null}
				onOpenChange={(open) => {
					if (!open) setLocationToDelete(null)
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							<Trans>Delete restaurant location?</Trans>
						</AlertDialogTitle>
						{(() => {
							const locToDeleteName = locationToDelete?.name ?? ''
							return (
								<AlertDialogDescription>
									<Trans>
										Are you sure you want to delete &quot;{locToDeleteName}
										&quot;? This action cannot be undone and will remove
										operating hours and delivery zones.
									</Trans>
								</AlertDialogDescription>
							)
						})()}
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>
							<Trans>Cancel</Trans>
						</AlertDialogCancel>
						<AlertDialogAction onClick={handleDeleteConfirm}>
							<Trans>Delete Location</Trans>
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	)
}
