import { Trans, plural, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { requireUserId, userHasOrganizationPermission } from '@repo/auth'
import { type LocationSettingId } from '@repo/common/location-settings-registry'
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
import { Checkbox } from '@repo/ui/checkbox'
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
	data,
	Link,
	useFetcher,
	useLoaderData,
	useNavigate,
} from 'react-router'
import { EmptyState } from '#app/components/empty-state.tsx'
import { BulkOrderingDialog } from '#app/components/locations/bulk-ordering-dialog.tsx'
import { CopySettingsDialog } from '#app/components/locations/copy-settings-dialog.tsx'
import {
	bulkOrderingControl,
	bulkOrderingInputSchema,
} from '#app/utils/location/bulk-ordering.server.ts'
import {
	addHolidayInputSchema,
	addHolidayToLocations,
	copyLocationSettings,
	copySettingsInputSchema,
} from '#app/utils/location/copy-settings.server.ts'
import { enabledSettingIds } from '#app/utils/location/location-settings.server.ts'
import { resolveMemberLocationIds } from '#app/utils/location/member-scope.server.ts'
import { publicOrderingControls } from '#app/utils/location/ordering-pause.ts'
import { listLocationTags, tagsByLocation } from '#app/utils/location/tags.server.ts'
import { requireMenuWrite } from '#app/utils/menu/access.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	requireUserWithOrganizationPermission,
	ORG_PERMISSIONS,
} from '#app/utils/organization/permissions.server.ts'
import { deleteScopeData } from '#app/utils/phone-agent/phone-agent.server.ts'
import { notifyReservationsContextChanged } from '#app/utils/reservations/access.server.ts'
import { checkLocationReservationsDeleteGuard } from '#app/utils/reservations/region-guard.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'

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
	/** Inside the person's location scope: they can change it in bulk. */
	manageable: boolean
	/** Online ordering is paused right now. */
	paused: boolean
	tags: Array<{ id: string; name: string }>
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

const BASE_LOCATION_FILTER_FIELDS: FilterField[] = [
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
		case 'tag':
			value = location.tags.map((tag) => tag.id)
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
		condition.field === 'status' ||
		condition.field === 'fulfillment' ||
		condition.field === 'tag'
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

	const userId = await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.READ_SETTINGS_ANY,
	)

	const defaultLocale = organization.siteDefaultLocale ?? 'en'
	const [scope, tagMap, canUpdateSettings, canUpdateMenu, enabled, tagList] =
		await Promise.all([
			resolveMemberLocationIds(userId, organization.id),
			tagsByLocation(organization.id),
			userHasOrganizationPermission(
				userId,
				organization.id,
				ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
			),
			userHasOrganizationPermission(
				userId,
				organization.id,
				ORG_PERMISSIONS.UPDATE_MENU_ANY,
			),
			enabledSettingIds(organization.id),
			listLocationTags(organization.id),
		])
	const now = new Date()

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
			manageable: scope === null || scope.includes(loc.id),
			paused: publicOrderingControls(loc, now).orderingPause !== null,
			tags: tagMap.get(loc.id) ?? [],
			fulfillment,
		}
	})

	return {
		organization,
		locations,
		tags: tagList.map((tag) => ({ id: tag.id, name: tag.name })),
		enabledSettings: [...enabled] as LocationSettingId[],
		// Head office: every location in scope. Tags and chain defaults are theirs.
		isHeadOffice: scope === null,
		canUpdateSettings,
		canPause: canUpdateMenu,
	}
}

const MAX_PAYLOAD_LENGTH = 50_000

/** Reads the JSON `payload` field of a form post through a Zod schema. */
function parsePayload<T>(
	formData: FormData,
	schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
): T | null {
	const raw = formData.get('payload')
	if (typeof raw !== 'string' || raw.length > MAX_PAYLOAD_LENGTH) return null
	try {
		const parsed = schema.safeParse(JSON.parse(raw))
		return parsed.success ? parsed.data : null
	} catch {
		return null
	}
}

function invalidRequest() {
	return data({ ok: false as const, error: 'invalid_request' }, { status: 400 })
}

export async function action({ request, params }: ActionFunctionArgs) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		dataRegion: true,
		hasProvisionedDb: true,
	})

	const formData = await request.formData()
	const intent = formData.get('intent')

	// Pause or resume at many locations: the same permission as the Orders
	// page (menu write); the writer is the one the Orders page uses.
	if (intent === 'bulk-ordering') {
		const actingUserId = await requireMenuWrite(request, organization.id)
		const body = parsePayload(formData, bulkOrderingInputSchema)
		if (!body) return invalidRequest()
		const scope = await resolveMemberLocationIds(actingUserId, organization.id)
		const result = await bulkOrderingControl({
			organization,
			userId: actingUserId,
			scope,
			request,
			body,
		})
		return data({ ok: true as const, bulk: result })
	}

	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
	)

	// Copy settings between locations, with a preview, and the holiday shortcut.
	// The person's location scope is read on the server and applied to every id.
	if (
		intent === 'preview-copy' ||
		intent === 'copy-settings' ||
		intent === 'add-holiday'
	) {
		const scope = await resolveMemberLocationIds(userId, organization.id)
		const organizationForSettings = {
			id: organization.id,
			slug: organization.slug,
			dataRegion: organization.dataRegion || 'us',
		}
		if (intent === 'add-holiday') {
			const body = parsePayload(formData, addHolidayInputSchema)
			if (!body) return invalidRequest()
			const result = await addHolidayToLocations({
				organization: organizationForSettings,
				userId,
				scope,
				request,
				body,
			})
			return result.ok
				? data({ ok: true as const, holiday: result })
				: data({ ok: false as const, error: result.error }, { status: result.status })
		}
		const body = parsePayload(formData, copySettingsInputSchema)
		if (!body) return invalidRequest()
		const result = await copyLocationSettings({
			organization: organizationForSettings,
			userId,
			scope,
			request,
			body,
			apply: intent === 'copy-settings',
		})
		return result.ok
			? data({ ok: true as const, copy: result })
			: data(
					{
						ok: false as const,
						error: result.error,
						settings: result.settings,
					},
					{ status: result.status },
				)
	}

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
		await purgeOrganizationSiteCache(organization.id, organization.slug)
		await notifyReservationsContextChanged(organization.id, 'locations')

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
		await purgeOrganizationSiteCache(organization.id, organization.slug)
		await notifyReservationsContextChanged(organization.id, 'locations')

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

		const deleteGuard = await checkLocationReservationsDeleteGuard({
			organizationId: organization.id,
			dataRegion: organization.dataRegion,
			hasProvisionedDb: organization.hasProvisionedDb,
			locationId,
		})
		if (!deleteGuard.allowed) {
			return Response.json(
				{
					error: deleteGuard.error,
					futureReservations: deleteGuard.futureReservations,
				},
				{ status: deleteGuard.status },
			)
		}

		await db
			.delete(OrganizationLocation)
			.where(
				and(
					eq(OrganizationLocation.id, locationId),
					eq(OrganizationLocation.organizationId, organization.id),
				),
			)
		await deleteScopeData(organization.id, locationId, { userId, request })
		await purgeOrganizationSiteCache(organization.id, organization.slug)
		await notifyReservationsContextChanged(organization.id, 'locations')

		return { success: true }
	}

	return { error: 'Unsupported intent' }
}

export default function LocationsIndexRoute() {
	const { _ } = useLingui()
	const {
		organization,
		locations,
		tags,
		enabledSettings,
		isHeadOffice,
		canUpdateSettings,
		canPause,
	} = useLoaderData<typeof loader>()
	const fetcher = useFetcher<{ error?: string; futureReservations?: number }>()
	const navigate = useNavigate()

	const [filterQuery, setFilterQuery] = useState(createFilterQuery())
	const [locationToDelete, setLocationToDelete] =
		useState<LocationListItem | null>(null)
	const [selected, setSelected] = useState<Set<string>>(new Set())
	const [bulkAction, setBulkAction] = useState<'pause' | 'resume' | null>(null)
	const [copyDialog, setCopyDialog] = useState<'copy' | 'holiday' | null>(null)

	const filterFields = useMemo<FilterField[]>(
		() => [
			...BASE_LOCATION_FILTER_FIELDS,
			...(tags.length > 0
				? [
						{
							id: 'tag',
							label: _(t`Tag`),
							type: 'multiselect',
							defaultOperator: 'is_any_of',
							searchable: false,
							icon: <Icon name="tag" className="size-3.5" />,
							options: tags.map((tag) => ({
								value: tag.id,
								label: tag.name,
							})),
						} as FilterField,
					]
				: []),
		],
		[tags, _],
	)

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
	const manageableVisible = filteredLocations.filter((l) => l.manageable)
	const selectedIds = locations
		.filter((location) => selected.has(location.id) && location.manageable)
		.map((location) => location.id)
	const allVisibleSelected =
		manageableVisible.length > 0 &&
		manageableVisible.every((location) => selected.has(location.id))
	const selectLabel = (name: string) => t`Select ${name}`
	const toggleSelected = (id: string, checked: boolean) =>
		setSelected((current) => {
			const next = new Set(current)
			if (checked) next.add(id)
			else next.delete(id)
			return next
		})
	const copyLocations = locations.map((location) => ({
		id: location.id,
		name: location.name,
		isActive: location.isActive,
		manageable: location.manageable,
	}))

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
				<div className="flex flex-wrap items-center gap-2">
					<DropdownMenu>
						<DropdownMenuTrigger render={<Button variant="outline" />}>
							<Icon name="layers" className="size-4" />
							<Trans>All locations</Trans>
							<Icon name="chevron-down" className="size-4" />
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							<DropdownMenuItem
								render={<Link to={`/${organization.slug}/status`} />}
							>
								<Icon name="activity" className="size-4" />
								<Trans>Status: can each location take orders?</Trans>
							</DropdownMenuItem>
							{canUpdateSettings ? (
								<>
									<DropdownMenuItem onClick={() => setCopyDialog('copy')}>
										<Icon name="copy" className="size-4" />
										<Trans>Copy settings</Trans>
									</DropdownMenuItem>
									<DropdownMenuItem onClick={() => setCopyDialog('holiday')}>
										<Icon name="calendar-plus" className="size-4" />
										<Trans>Add holiday to locations</Trans>
									</DropdownMenuItem>
									<DropdownMenuItem
										render={
											<Link
												to={`/${organization.slug}/settings/locations/compare`}
											/>
										}
									>
										<Icon name="sliders-horizontal" className="size-4" />
										<Trans>Compare and edit a setting</Trans>
									</DropdownMenuItem>
								</>
							) : null}
							{isHeadOffice && canUpdateSettings ? (
								<>
									<DropdownMenuSeparator />
									<DropdownMenuItem
										render={
											<Link
												to={`/${organization.slug}/settings/locations/defaults`}
											/>
										}
									>
										<Icon name="lock" className="size-4" />
										<Trans>Chain defaults and locks</Trans>
									</DropdownMenuItem>
									<DropdownMenuItem
										render={
											<Link
												to={`/${organization.slug}/settings/locations/tags`}
											/>
										}
									>
										<Icon name="tag" className="size-4" />
										<Trans>Tags and import</Trans>
									</DropdownMenuItem>
								</>
							) : null}
						</DropdownMenuContent>
					</DropdownMenu>
					<Button
						render={<Link to={`/${organization.slug}/settings/locations/new`} />}
					>
						<Icon name="plus" className="size-4" />
						<Trans>Add Location</Trans>
					</Button>
				</div>
			</div>

			<div className="space-y-4">
				{fetcher.data?.error ? (
					<div
						role="alert"
						data-testid="location-delete-error"
						className="bg-destructive/10 border-destructive/20 text-destructive rounded-md border p-3 text-sm"
					>
						{fetcher.data.error}
					</div>
				) : null}

				<Filters
					fields={filterFields}
					query={filterQuery}
					onQueryChange={setFilterQuery}
					showClear
				/>

				{selectedIds.length > 0 ? (
					<div
						className="bg-muted/40 flex flex-wrap items-center gap-2 rounded-md border p-2"
						data-testid="locations-bulk-toolbar"
					>
						<span className="text-sm font-medium">
							{plural(selectedIds.length, {
								one: '# location selected',
								other: '# locations selected',
							})}
						</span>
						{canPause ? (
							<>
								<Button
									size="sm"
									variant="outline"
									onClick={() => setBulkAction('pause')}
								>
									<Icon name="stop" className="size-4" />
									<Trans>Pause ordering</Trans>
								</Button>
								<Button
									size="sm"
									variant="outline"
									onClick={() => setBulkAction('resume')}
								>
									<Icon name="play" className="size-4" />
									<Trans>Resume ordering</Trans>
								</Button>
							</>
						) : null}
						{canUpdateSettings ? (
							<>
								<Button
									size="sm"
									variant="outline"
									onClick={() => setCopyDialog('copy')}
								>
									<Icon name="copy" className="size-4" />
									<Trans>Copy settings to these</Trans>
								</Button>
								<Button
									size="sm"
									variant="outline"
									render={
										<Link
											to={`/${organization.slug}/settings/locations/compare?locations=${selectedIds.join(',')}`}
										/>
									}
								>
									<Icon name="sliders-horizontal" className="size-4" />
									<Trans>Compare and edit</Trans>
								</Button>
							</>
						) : null}
						<Button
							size="sm"
							variant="ghost"
							onClick={() => setSelected(new Set())}
						>
							<Trans>Clear selection</Trans>
						</Button>
					</div>
				) : null}

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
									<TableHead className="w-10">
										<Checkbox
											aria-label={t`Select all locations you can manage`}
											checked={allVisibleSelected}
											disabled={manageableVisible.length === 0}
											onCheckedChange={(value) =>
												setSelected((current) => {
													const next = new Set(current)
													for (const location of manageableVisible) {
														if (value === true) next.add(location.id)
														else next.delete(location.id)
													}
													return next
												})
											}
										/>
									</TableHead>
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
										<TableCell
											className="w-10"
											onClick={(e) => e.stopPropagation()}
											onKeyDown={(e) => e.stopPropagation()}
										>
											<Checkbox
												aria-label={selectLabel(loc.name)}
												checked={selected.has(loc.id)}
												disabled={!loc.manageable}
												onCheckedChange={(value) =>
													toggleSelected(loc.id, value === true)
												}
											/>
										</TableCell>
										<TableCell className="font-medium">
											<div className="flex flex-wrap items-center gap-2">
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
											{loc.tags.length > 0 ? (
												<div className="mt-1 flex flex-wrap gap-1">
													{loc.tags.map((tag) => (
														<Badge
															key={tag.id}
															variant="outline"
															className="text-[10px]"
														>
															{tag.name}
														</Badge>
													))}
												</div>
											) : null}
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
											{loc.paused ? (
												<Badge variant="outline" className="ms-1">
													<Trans>Ordering paused</Trans>
												</Badge>
											) : null}
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
											<TableCell colSpan={6}>
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

			{bulkAction ? (
				<BulkOrderingDialog
					open
					onOpenChange={(open) => {
						if (!open) setBulkAction(null)
					}}
					action={bulkAction}
					locationIds={selectedIds}
					locationCount={selectedIds.length}
				/>
			) : null}
			{copyDialog ? (
				<CopySettingsDialog
					open
					onOpenChange={(open) => {
						if (!open) setCopyDialog(null)
					}}
					locations={copyLocations}
					enabledSettings={enabledSettings}
					initialTab={copyDialog}
					initialTargetIds={selectedIds}
				/>
			) : null}

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
