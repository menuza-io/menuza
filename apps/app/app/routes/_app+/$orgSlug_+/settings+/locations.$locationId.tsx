import { Trans } from '@lingui/macro'
import { requireUserId } from '@repo/auth'
import { courseSettingsJson } from '@repo/common/kitchen-ticket'
import { getLocationCurrency } from '@repo/common/location-currency'
import {
	type DeliveryProvider,
	type DeliveryZone,
	DEFAULT_DELIVERY_CONFIG,
	DEFAULT_DELIVERY_ZONE,
	resolveTipSettings,
} from '@repo/common/location-types'
import { parseStrictOrderNumberFormat } from '@repo/common/pos-orders'
import {
	defaultServiceFeeSettings,
	serviceFeeSettingsSchema,
} from '@repo/common/service-fee'
import { parseSiteLocalesConfig } from '@repo/common/site-locales'
import { redirectWithToast } from '@repo/common/toast'
import { and, asc, db, eq, ne, OrganizationLocation } from '@repo/database'
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
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Icon } from '@repo/ui/icon'
import { useState } from 'react'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	Link,
	useFetcher,
	useLoaderData,
} from 'react-router'
import { z } from 'zod'
import {
	type InitialLocationData,
	LocationForm,
} from '#app/components/locations/location-form.tsx'
import { type OrderPolicyValues } from '#app/components/locations/order-policies-card.tsx'
import { CopyLocationOverridesDialog } from '#app/components/menu/copy-location-overrides-dialog.tsx'
import { loadLocationPolicyView } from '#app/utils/location/chain-defaults.server.ts'
import { ensureLocationCoordinates } from '#app/utils/location/geocoder.server.ts'
import { lockedSettingsChangedByFormSave } from '#app/utils/location/location-settings.server.ts'
import { locationTaxInputFields } from '#app/utils/location/tax-settings.ts'
import {
	type CheckoutRulesBundle,
	orderCapsFormFromRecord,
	packagingFeeFormFromRecord,
	parseCheckoutRulesFields,
	pickupInstructionsFromRecord,
} from '#app/utils/orders/checkout-rules-settings.ts'
import {
	feeFormFromSettings,
	parseCheckoutSettingsFields,
	tipFormFromSettings,
} from '#app/utils/orders/checkout-settings.ts'
import {
	isGuestCancelEnabled,
	isManualAcceptanceEnabled,
} from '#app/utils/orders/order-policies.server.ts'
import { parseOrderPolicyFields } from '#app/utils/orders/order-policy-settings.ts'
import {
	orderingSettingsFormFromRecord,
	parseOrderingSettingsFields,
} from '#app/utils/orders/ordering-settings.ts'
import { isPackagingFeeEnabled } from '#app/utils/orders/packaging-fee.server.ts'
import { isPrayerPauseEnabled } from '#app/utils/orders/prayer-pause.server.ts'
import { isServiceFeeEnabled } from '#app/utils/orders/service-fee.server.ts'
import { buildSlotLimitsContext } from '#app/utils/orders/slot-limits.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	requireUserWithOrganizationPermission,
	ORG_PERMISSIONS,
} from '#app/utils/organization/permissions.server.ts'
import { deleteScopeData } from '#app/utils/phone-agent/phone-agent.server.ts'
import {
	isReservationsFeatureEnabled,
	notifyReservationsContextChanged,
} from '#app/utils/reservations/access.server.ts'
import { checkLocationReservationsDeleteGuard } from '#app/utils/reservations/region-guard.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'

const LocationInputSchema = z.object({
	name: z.string().min(1, 'Location name is required'),
	slug: z
		.string()
		.min(1, 'URL slug is required')
		.regex(
			/^[a-z0-9]+(?:-[a-z0-9]+)*$/,
			'Slug must contain only lowercase letters, numbers, and hyphens',
		),
	phone: z.string().optional(),
	timezone: z.string().default('America/New_York'),
	taxRate: z.coerce.number().min(0).default(0),
	...locationTaxInputFields,
	isActive: z.preprocess((val) => val === 'true' || val === true, z.boolean()),
	isDefault: z.preprocess((val) => val === 'true' || val === true, z.boolean()),
	address: z.string().optional(),
	storeHours: z.string().optional(),
	onlineHours: z.string().optional(),
	specialHours: z.string().optional(),
	prepTime: z.coerce.number().min(0).default(15),
	largeOrderThreshold: z.coerce.number().min(0).default(100),
	largeOrderThresholdType: z.string().default('dollars'),
	largeOrderExtraPrepTime: z.coerce.number().min(0).default(15),
	fulfillmentOptions: z.string().optional(),
	inHouseTips: z.string().optional(),
	scheduling: z.string().optional(),
	deliveryConfig: z.string().optional(),
	deliveryZones: z.string().optional(),
	courseSettings: z.string().optional(),
	orderNumberFormat: z.string().optional(),
	orderingSettings: z.string().optional(),
})

export async function loader({ request, params }: LoaderFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		siteLocales: true,
		siteDefaultLocale: true,
		dataRegion: true,
	})

	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.READ_SETTINGS_ANY,
	)

	const locationId = params.locationId
	if (!locationId) {
		throw new Response('Location ID is required', { status: 400 })
	}

	const record = await db.query.OrganizationLocation.findFirst({
		where: and(
			eq(OrganizationLocation.organizationId, organization.id),
			eq(OrganizationLocation.id, locationId),
		),
	})

	if (!record) {
		throw new Response('Location not found', { status: 404 })
	}

	const parseJson = <T,>(str: string | null): T | null => {
		if (!str) return null
		try {
			return JSON.parse(str) as T
		} catch {
			return null
		}
	}

	const location: InitialLocationData = {
		id: record.id,
		name: record.name,
		slug: record.slug,
		phone: record.phone,
		timezone: record.timezone,
		taxRate: record.taxRate,
		taxInclusive: record.taxInclusive,
		vatNumber: record.vatNumber,
		isActive: record.isActive,
		isDefault: record.isDefault,
		prepTime: record.prepTime,
		largeOrderThreshold: record.largeOrderThreshold ?? 100,
		largeOrderThresholdType: record.largeOrderThresholdType,
		largeOrderExtraPrepTime: record.largeOrderExtraPrepTime,
		address: parseJson(record.address),
		storeHours: parseJson(record.storeHours),
		onlineHours: parseJson(record.onlineHours),
		specialHours: parseJson(record.specialHours),
		fulfillmentOptions: parseJson(record.fulfillmentOptions),
		inHouseTips: parseJson(record.inHouseTips),
		scheduling: parseJson(record.scheduling),
		deliveryConfig: (() => {
			const parsed = parseJson<Record<string, any>>(record.deliveryConfig)
			if (!parsed) return DEFAULT_DELIVERY_CONFIG
			return {
				providers:
					Array.isArray(parsed.providers) && parsed.providers.length > 0
						? (parsed.providers as DeliveryProvider[])
						: DEFAULT_DELIVERY_CONFIG.providers,
				estimatedDeliveryTimeMin:
					parsed.estimatedDeliveryTimeMin ??
					parsed.estimatedTimeMin ??
					DEFAULT_DELIVERY_CONFIG.estimatedDeliveryTimeMin,
				estimatedDeliveryTimeMax:
					parsed.estimatedDeliveryTimeMax ??
					parsed.estimatedTimeMax ??
					DEFAULT_DELIVERY_CONFIG.estimatedDeliveryTimeMax,
			}
		})(),
		courseSettings: record.courseSettings,
		orderNumberFormat: record.orderNumberFormat,
		deliveryZones: (() => {
			const parsed = parseJson<DeliveryZone[]>(record.deliveryZones)
			return Array.isArray(parsed) && parsed.length > 0
				? parsed
				: [DEFAULT_DELIVERY_ZONE]
		})(),
	}

	const reservationsEnabled = await isReservationsFeatureEnabled(
		organization.id,
		'enabled',
	)

	const [guestCancelEnabled, acceptanceEnabled] = await Promise.all([
		isGuestCancelEnabled(organization.id),
		isManualAcceptanceEnabled(organization.id),
	])
	const orderPolicies =
		guestCancelEnabled || acceptanceEnabled
			? {
					flags: {
						guestCancel: guestCancelEnabled,
						acceptance: acceptanceEnabled,
					},
					currency: organization.dataRegion === 'ksa' ? 'SAR' : 'USD',
					initial: {
						guestCancelMinutes: String(record.guestCancelMinutes ?? 0),
						guestCancelScheduledLeadMinutes:
							record.guestCancelScheduledLeadMinutes == null
								? ''
								: String(record.guestCancelScheduledLeadMinutes),
						orderAcceptanceMode:
							record.orderAcceptanceMode === 'manual' ? 'manual' : 'auto',
						orderAcceptanceTimeoutMinutes: String(
							record.orderAcceptanceTimeoutMinutes,
						),
						orderAcceptanceMinTotal:
							record.orderAcceptanceMinTotalCents == null
								? ''
								: (record.orderAcceptanceMinTotalCents / 100).toFixed(2),
						orderAcceptanceScheduledOnly: record.orderAcceptanceScheduledOnly,
					} satisfies OrderPolicyValues,
				}
			: undefined

	// Tip choices (#118) always; the service fee (#123) while its flag is on.
	// The currency is the one the order context gives this location.
	const checkoutCurrency =
		organization.dataRegion === 'ksa'
			? 'SAR'
			: getLocationCurrency(location.address)
	const serviceFeeEnabled = await isServiceFeeEnabled(organization.id)
	const savedFee = (() => {
		const parsed = serviceFeeSettingsSchema.safeParse(
			parseJson<unknown>(record.serviceFee),
		)
		return parsed.success
			? parsed.data
			: defaultServiceFeeSettings(checkoutCurrency)
	})()
	const checkoutSettings = {
		currency: checkoutCurrency,
		serviceFeeEnabled,
		tips: tipFormFromSettings(
			resolveTipSettings(record.tipSettings, checkoutCurrency),
			checkoutCurrency,
		),
		fee: feeFormFromSettings(savedFee, checkoutCurrency),
	}

	const [slotLimitsFlag, prayerPauseFlag] = await Promise.all([
		buildSlotLimitsContext(organization.id).then((ctx) => ctx.enabled),
		isPrayerPauseEnabled(organization.id),
	])
	const orderingSettings = {
		slotLimitsEnabled: slotLimitsFlag,
		prayerPauseEnabled: prayerPauseFlag,
		initial: orderingSettingsFormFromRecord({
			onlineOrderingSettings: parseJson(record.onlineOrderingSettings),
			slotLimitSettings: parseJson(record.slotLimitSettings),
			prepSchedule: parseJson(record.prepSchedule),
			prayerPauseSettings: parseJson(record.prayerPauseSettings),
			// A location that never saved the new large-order settings starts
			// from its old single threshold.
			legacyLargeOrder: {
				largeOrderThreshold: record.largeOrderThreshold,
				largeOrderThresholdType: record.largeOrderThresholdType,
				largeOrderExtraPrepTime: record.largeOrderExtraPrepTime,
			},
		}),
	}

	const siteLocales = parseSiteLocalesConfig(
		organization.siteLocales,
		organization.siteDefaultLocale,
	)
	const packagingFeeEnabled = await isPackagingFeeEnabled(organization.id)
	const checkoutRules = {
		packagingFeeEnabled,
		currency: checkoutCurrency,
		locales: siteLocales.locales,
		defaultLocale: siteLocales.defaultLocale,
		initial: {
			pickupInstructions: pickupInstructionsFromRecord(
				record.pickupInstructions,
				siteLocales.defaultLocale,
			),
			orderCaps: orderCapsFormFromRecord(parseJson(record.orderCaps)),
			packagingFee: packagingFeeFormFromRecord(
				parseJson(record.packagingFee),
				checkoutCurrency,
			),
		} satisfies CheckoutRulesBundle,
	}

	const allLocations = await db
		.select({
			id: OrganizationLocation.id,
			name: OrganizationLocation.name,
		})
		.from(OrganizationLocation)
		.where(eq(OrganizationLocation.organizationId, organization.id))
		.orderBy(asc(OrganizationLocation.name))

	// Chain defaults (#417): what head office locked, and where this location
	// differs from a default.
	const policy = await loadLocationPolicyView(
		{
			id: organization.id,
			slug: organization.slug,
			dataRegion: organization.dataRegion || 'us',
		},
		record.id,
	)

	return {
		organization,
		location,
		reservationsEnabled,
		allLocations,
		orderPolicies,
		checkoutSettings,
		orderingSettings,
		checkoutRules,
		policy,
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		dataRegion: true,
		hasProvisionedDb: true,
		// The default language is the fallback of the pickup instructions.
		siteLocales: true,
		siteDefaultLocale: true,
	})

	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
	)

	const locationId = params.locationId
	if (!locationId) {
		return { error: 'Location ID is required' }
	}

	const formData = await request.formData()
	const intent = formData.get('intent')

	if (intent === 'delete-location') {
		const [existingLocation] = await db
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

		if (!existingLocation) {
			return Response.json({ error: 'Location not found' }, { status: 404 })
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

		return redirectWithToast(`/${organization.slug}/settings/locations`, {
			type: 'success',
			title: 'Location deleted',
			description: 'The restaurant location has been removed.',
		})
	}

	const rawData: Record<string, unknown> = {}
	for (const [key, value] of formData.entries()) {
		rawData[key] = value
	}

	const parsed = LocationInputSchema.safeParse(rawData)
	if (!parsed.success) {
		return {
			error: parsed.error.issues[0]?.message ?? 'Invalid location details.',
		}
	}

	const data = parsed.data

	// Guest cancel and acceptance: a group whose flag is off is never written.
	const policy = parseOrderPolicyFields(rawData, {
		guestCancel: await isGuestCancelEnabled(organization.id),
		acceptance: await isManualAcceptanceEnabled(organization.id),
	})
	if (!policy.ok) {
		// The form words the code in the reader's language and marks the field.
		return {
			error: policy.error,
			orderPolicyError: { field: policy.field, code: policy.code },
		}
	}

	// Tip choices and the service fee; the fee group is skipped while its flag
	// is off. The currency is the one the order context gives this location.
	const [currentLocation] = await db
		.select({ address: OrganizationLocation.address })
		.from(OrganizationLocation)
		.where(
			and(
				eq(OrganizationLocation.id, locationId),
				eq(OrganizationLocation.organizationId, organization.id),
			),
		)
		.limit(1)
	const checkout = parseCheckoutSettingsFields(rawData, {
		currency:
			organization.dataRegion === 'ksa'
				? 'SAR'
				: getLocationCurrency(data.address ?? currentLocation?.address),
		serviceFeeEnabled: await isServiceFeeEnabled(organization.id),
	})
	if (!checkout.ok) {
		return { error: checkout.error, checkoutIssue: checkout.issue }
	}

	const ordering = parseOrderingSettingsFields(rawData, {
		slotLimits: await buildSlotLimitsContext(organization.id).then(
			(ctx) => ctx.enabled,
		),
		prayerPause: await isPrayerPauseEnabled(organization.id),
	})
	if (!ordering.ok) {
		return { error: ordering.error }
	}

	const siteLocales = parseSiteLocalesConfig(
		organization.siteLocales,
		organization.siteDefaultLocale,
	)
	const checkoutRulesResult = parseCheckoutRulesFields(rawData, {
		currency:
			organization.dataRegion === 'ksa'
				? 'SAR'
				: getLocationCurrency(data.address ?? currentLocation?.address),
		defaultLocale: siteLocales.defaultLocale,
		packagingFeeEnabled: await isPackagingFeeEnabled(organization.id),
	})
	if (!checkoutRulesResult.ok) {
		return { error: checkoutRulesResult.error }
	}

	const orderNumberFormatResult = parseStrictOrderNumberFormat(
		data.orderNumberFormat,
	)
	if (!orderNumberFormatResult.ok) {
		return { error: orderNumberFormatResult.error }
	}

	// Check if another location has this slug
	const [existingWithSlug] = await db
		.select({ id: OrganizationLocation.id })
		.from(OrganizationLocation)
		.where(
			and(
				eq(OrganizationLocation.organizationId, organization.id),
				eq(OrganizationLocation.slug, data.slug),
				ne(OrganizationLocation.id, locationId),
			),
		)
		.limit(1)

	if (existingWithSlug) {
		return { error: 'Another location already uses this URL slug.' }
	}

	// Radius delivery zones are centred on the store: make sure it has real
	// coordinates (missing or 0,0 → geocode server-side; best effort).
	const geocoded = await ensureLocationCoordinates(data.address)

	const updateSet = {
		name: data.name,
		slug: data.slug,
		phone: data.phone || null,
		timezone: data.timezone,
		taxRate: data.taxRate,
		taxInclusive: data.taxInclusive,
		vatNumber: data.vatNumber,
		isActive: data.isActive,
		isDefault: data.isDefault,
		address: geocoded.address || null,
		storeHours: data.storeHours || null,
		onlineHours: data.onlineHours || null,
		specialHours: data.specialHours || null,
		prepTime: data.prepTime,
		largeOrderThreshold: data.largeOrderThreshold,
		largeOrderThresholdType: data.largeOrderThresholdType,
		largeOrderExtraPrepTime: data.largeOrderExtraPrepTime,
		fulfillmentOptions: data.fulfillmentOptions || null,
		inHouseTips: data.inHouseTips || null,
		scheduling: data.scheduling || null,
		deliveryConfig: data.deliveryConfig || null,
		deliveryZones: data.deliveryZones || null,
		...(data.courseSettings !== undefined
			? { courseSettings: courseSettingsJson(data.courseSettings) }
			: {}),
		...(data.orderNumberFormat !== undefined
			? {
					orderNumberFormat: orderNumberFormatResult.value
						? JSON.stringify(orderNumberFormatResult.value)
						: null,
				}
			: {}),
		...policy.patch,
		...checkout.patch,
		...ordering.patch,
		...checkoutRulesResult.patch,
	}

	// Head office can lock a setting (Settings, Locations, Chain defaults). A
	// lock is enforced here, not only by a read-only field: a save that changes
	// a locked setting is refused and nothing is written.
	const lockedChanges = await lockedSettingsChangedByFormSave(
		{
			id: organization.id,
			slug: organization.slug,
			dataRegion: organization.dataRegion || 'us',
		},
		locationId,
		updateSet,
	)
	if (lockedChanges.length > 0) {
		return Response.json(
			{
				error: 'This setting is locked by head office.',
				code: 'setting_locked',
				settings: lockedChanges,
			},
			{ status: 409 },
		)
	}

	await db.transaction(async (tx) => {
		if (data.isDefault) {
			await tx
				.update(OrganizationLocation)
				.set({ isDefault: false })
				.where(eq(OrganizationLocation.organizationId, organization.id))
		}

		await tx
			.update(OrganizationLocation)
			.set(updateSet)
			.where(
				and(
					eq(OrganizationLocation.id, locationId),
					eq(OrganizationLocation.organizationId, organization.id),
				),
			)
	})

	await purgeOrganizationSiteCache(organization.id, organization.slug)
	await notifyReservationsContextChanged(organization.id, 'locations')

	return redirectWithToast(`/${organization.slug}/settings/locations`, {
		type: 'success',
		title: 'Location updated',
		description: 'Restaurant location details have been saved.',
	})
}

export default function EditLocationRoute() {
	const {
		organization,
		location,
		reservationsEnabled,
		allLocations,
		orderPolicies,
		checkoutSettings,
		orderingSettings,
		checkoutRules,
		policy,
	} = useLoaderData<typeof loader>()
	const deleteFetcher = useFetcher<{
		error?: string
		futureReservations?: number
	}>()
	const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)
	const [copyOverridesOpen, setCopyOverridesOpen] = useState(false)
	const canCopyMenuOverrides = allLocations.length > 1 && location.id

	const handleConfirmDelete = () => {
		setConfirmDeleteOpen(false)
		void deleteFetcher.submit({ intent: 'delete-location' }, { method: 'POST' })
	}

	return (
		<div className="flex flex-col gap-6">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex items-center gap-3">
					<Button
						variant="outline"
						size="icon"
						render={<Link to={`/${organization.slug}/settings/locations`} />}
					>
						<Icon name="arrow-left" className="size-4" />
						<span className="sr-only">
							<Trans>Back</Trans>
						</span>
					</Button>
					<div>
						<h2 className="text-xl tracking-tight">
							<Trans>Edit Location</Trans>
						</h2>
						<p className="text-muted-foreground text-sm">
							<Trans>
								Update location details, hours, and fulfillment preferences.
							</Trans>
						</p>
					</div>
				</div>
				<Button
					type="button"
					variant="destructive"
					size="sm"
					data-testid="delete-location-button"
					disabled={deleteFetcher.state !== 'idle'}
					onClick={() => setConfirmDeleteOpen(true)}
				>
					<Icon name="trash-2" className="size-4" />
					<Trans>Delete Location</Trans>
				</Button>
			</div>

			{deleteFetcher.data?.error ? (
				<div
					role="alert"
					data-testid="location-delete-error"
					className="bg-destructive/10 border-destructive/20 text-destructive rounded-md border p-3 text-sm"
				>
					{deleteFetcher.data.error}
				</div>
			) : null}

			{reservationsEnabled ? (
				<Card data-testid="location-reservations-card">
					<CardHeader className="flex flex-row flex-wrap items-center justify-between gap-4">
						<div>
							<CardTitle className="flex items-center gap-2 text-base">
								<Icon name="calendar" className="size-4" />
								<Trans>Reservations</Trans>
							</CardTitle>
							<CardDescription>
								<Trans>
									Configure dining areas, floor plan tables, service periods,
									turn times, and online booking rules for this location.
								</Trans>
							</CardDescription>
						</div>
						<Button
							variant="outline"
							size="sm"
							data-testid="location-reservations-settings-link"
							render={
								<Link
									to={`/${organization.slug}/reservations/settings?location=${encodeURIComponent(location.id ?? '')}`}
								/>
							}
						>
							<Icon name="settings" className="size-4" />
							<Trans>Manage reservations settings</Trans>
						</Button>
					</CardHeader>
					<CardContent className="text-muted-foreground">
						<p className="text-xs">
							<Trans>
								Location time zone is used to compute reservation seating slots.
								Changing the time zone will prompt you to re-derive future
								reservation times in Reservations Settings.
							</Trans>{' '}
							({location.timezone ?? 'America/New_York'})
						</p>
					</CardContent>
				</Card>
			) : null}

			{canCopyMenuOverrides ? (
				<Card>
					<CardHeader className="flex flex-row flex-wrap items-center justify-between gap-4">
						<div>
							<CardTitle className="text-base">
								<Trans>Menu location overrides</Trans>
							</CardTitle>
							<CardDescription>
								<Trans>
									Copy this location&apos;s menu prices and availability
									overrides to another location.
								</Trans>
							</CardDescription>
						</div>
						<Button
							type="button"
							variant="outline"
							onClick={() => setCopyOverridesOpen(true)}
						>
							<Icon name="copy" className="size-4" />
							<Trans>Copy overrides</Trans>
						</Button>
					</CardHeader>
					<CopyLocationOverridesDialog
						orgSlug={organization.slug}
						open={copyOverridesOpen}
						onOpenChange={setCopyOverridesOpen}
						sourceLocationId={location.id!}
						locations={allLocations}
					/>
				</Card>
			) : null}

			<LocationForm
				orgSlug={organization.slug}
				siteLocalesRaw={organization.siteLocales}
				siteDefaultLocaleRaw={organization.siteDefaultLocale}
				isEditing={true}
				initialData={location}
				orderPolicies={orderPolicies}
				checkoutSettings={checkoutSettings}
				orderingSettings={orderingSettings}
				checkoutRules={checkoutRules}
				policy={policy}
			/>

			<AlertDialog
				open={confirmDeleteOpen}
				onOpenChange={(open) => {
					if (!open) setConfirmDeleteOpen(false)
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							<Trans>Delete restaurant location?</Trans>
						</AlertDialogTitle>
						{(() => {
							const locationName = location.name
							return (
								<AlertDialogDescription>
									<Trans>
										Are you sure you want to delete &quot;{locationName}
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
						<AlertDialogAction
							variant="destructive"
							data-testid="confirm-delete-location-button"
							onClick={handleConfirmDelete}
						>
							<Trans>Confirm Delete</Trans>
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	)
}
