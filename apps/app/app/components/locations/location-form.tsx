'use client'

import { msg, t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	courseSettingsSchema,
	DEFAULT_COURSES,
} from '@repo/common/kitchen-ticket'
import {
	type DeliveryConfig,
	type DeliveryZone,
	type FulfillmentOptions,
	type InHouseTips,
	type LocationAddress,
	type SchedulingOptions,
	type SpecialHour,
	type WeeklySchedule,
	DEFAULT_DELIVERY_CONFIG,
	DEFAULT_DELIVERY_ZONE,
	DEFAULT_FULFILLMENT_OPTIONS,
	DEFAULT_IN_HOUSE_TIPS,
	DEFAULT_SCHEDULING,
	DEFAULT_WEEKLY_SCHEDULE,
} from '@repo/common/location-types'
import {
	formatAllocatedOrderNumber,
	ORDER_NUMBER_PREFIX_REGEX,
	parseOrderNumberFormat,
} from '@repo/common/pos-orders'
import { parseSiteLocalesConfig } from '@repo/common/site-locales'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Checkbox } from '@repo/ui/checkbox'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { StatusButton } from '@repo/ui/status-button'
import { Switch } from '@repo/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@repo/ui/tabs'
import React, { useEffect, useRef, useState } from 'react'
import { Link, useFetcher } from 'react-router'
import {
	useDiscardKey,
	useFormSnapshotSaveBar,
} from '#app/components/use-native-form-save-bar.ts'
import {
	LocaleContext,
	LocaleSwitcher,
	LocalizedInput,
} from '#app/components/website/locale-fields.tsx'
import { TranslateProvider } from '#app/components/website/translate-provider.tsx'
import {
	type CheckoutRulesBundle,
	packagingFeeFormFromRecord,
} from '#app/utils/orders/checkout-rules-settings.ts'
import {
	type CheckoutSettingsIssue,
	type FeeFormValues,
	type TipFormValues,
} from '#app/utils/orders/checkout-settings.ts'
import { type OrderPolicyError } from '#app/utils/orders/order-policy-settings.ts'
import {
	type OrderingSettingsFormBundle,
	defaultOnlineOrderingForm,
	defaultPrayerPauseForm,
	defaultSlotLimitForm,
} from '#app/utils/orders/ordering-settings.ts'
import { AddressAutocomplete } from './address-autocomplete'
import { LocationHoursSection } from './availability-picker'
import {
	LargeOrderFields,
	OrderCapsCard,
	PackagingFeeCard,
	PickupInstructionsCard,
	UtensilsCheckoutCard,
} from './checkout-rules-cards.tsx'
import {
	ServiceFeeCard,
	TipChoicesCard,
	checkoutIssueMessage,
} from './checkout-settings-cards'
import { DeliveryZoneMap } from './delivery-zone-map'
import { DeliveryZonesManager } from './delivery-zones-manager'
import {
	type OrderPolicyFlags,
	type OrderPolicyValues,
	OrderPoliciesCard,
	orderPolicyErrorMessage,
} from './order-policies-card'
import {
	OnlineOrderingBuffersCard,
	PrayerPauseCard,
	PrepScheduleCard,
	SlotLimitsCard,
} from './ordering-settings-cards'
import { SpecialHoursPicker } from './special-hours-picker'

function courseAutoFireMinutes(raw: string): number | null {
	const minutes = Number(raw.trim())
	if (!Number.isInteger(minutes) || minutes < 1 || minutes > 180) return null
	return minutes
}

function readStoredCourses(raw: string | null | undefined) {
	const fallback = {
		enabled: false,
		autoFireMinutes: '',
		courses: DEFAULT_COURSES.map((course) => ({ ...course })),
	}
	if (!raw) return fallback
	try {
		const parsed = courseSettingsSchema.safeParse(JSON.parse(raw))
		if (!parsed.success) return fallback
		return {
			enabled: parsed.data.enabled,
			autoFireMinutes: parsed.data.autoFireMinutes
				? String(parsed.data.autoFireMinutes)
				: '',
			courses:
				parsed.data.courses.length > 0 ? parsed.data.courses : fallback.courses,
		}
	} catch {
		return fallback
	}
}

const TIMEZONE_OPTIONS = [
	{ value: 'America/New_York', label: 'Eastern Time (US & Canada)' },
	{ value: 'America/Chicago', label: 'Central Time (US & Canada)' },
	{ value: 'America/Denver', label: 'Mountain Time (US & Canada)' },
	{ value: 'America/Los_Angeles', label: 'Pacific Time (US & Canada)' },
	{ value: 'Europe/London', label: 'London (GMT / BST)' },
	{ value: 'Europe/Paris', label: 'Paris (CET)' },
	{ value: 'Asia/Riyadh', label: 'Riyadh (AST)' },
	{ value: 'Asia/Dubai', label: 'Dubai (GST)' },
	{ value: 'Asia/Singapore', label: 'Singapore (SGT)' },
	{ value: 'Asia/Tokyo', label: 'Tokyo (JST)' },
]

export interface InitialLocationData {
	id?: string
	name: string
	slug: string
	phone?: string | null
	timezone?: string
	taxRate?: number
	taxInclusive?: boolean
	vatNumber?: string | null
	address?: LocationAddress | null
	storeHours?: WeeklySchedule | null
	onlineHours?: WeeklySchedule | null
	specialHours?: SpecialHour[] | null
	prepTime?: number
	largeOrderThreshold?: number
	largeOrderThresholdType?: string
	largeOrderExtraPrepTime?: number
	fulfillmentOptions?: FulfillmentOptions | null
	inHouseTips?: InHouseTips | null
	scheduling?: SchedulingOptions | null
	deliveryConfig?: DeliveryConfig | null
	deliveryZones?: DeliveryZone[] | null
	courseSettings?: string | null
	orderNumberFormat?: string | null
	isActive?: boolean
	isDefault?: boolean
}

interface LocationFormProps {
	orgSlug: string
	initialData?: InitialLocationData
	siteLocalesRaw?: string | null
	siteDefaultLocaleRaw?: string | null
	isEditing?: boolean
	/** Guest cancel and acceptance settings; omitted while both flags are off. */
	orderPolicies?: {
		flags: OrderPolicyFlags
		currency: string
		initial: OrderPolicyValues
	}
	/**
	 * Tip choices (#118) and the service fee (#123). Omitted on a new location;
	 * `serviceFeeEnabled` is the `ordering.service_fee` flag.
	 */
	checkoutSettings?: {
		currency: string
		serviceFeeEnabled: boolean
		tips: TipFormValues
		fee: FeeFormValues
	}
	/** Slot limits and prayer pause cards follow org flags. */
	orderingSettings?: {
		slotLimitsEnabled: boolean
		prayerPauseEnabled: boolean
		initial: OrderingSettingsFormBundle
	}
	checkoutRules?: {
		packagingFeeEnabled: boolean
		currency: string
		locales: string[]
		defaultLocale: string
		initial: CheckoutRulesBundle
	}
}

export function LocationForm(props: LocationFormProps) {
	// Discard remounts the form with the values it opened with.
	const { discardKey, discard } = useDiscardKey()
	return <LocationFormBody key={discardKey} {...props} onDiscard={discard} />
}

function LocationFormBody({
	orgSlug,
	initialData,
	siteLocalesRaw,
	siteDefaultLocaleRaw,
	isEditing = false,
	orderPolicies,
	checkoutSettings,
	orderingSettings,
	checkoutRules,
	onDiscard,
}: LocationFormProps & { onDiscard: () => void }) {
	const { _ } = useLingui()
	const fetcher = useFetcher<{
		error?: string
		orderPolicyError?: OrderPolicyError
		checkoutIssue?: CheckoutSettingsIssue
	}>()
	const orderPolicyError = fetcher.data?.orderPolicyError ?? null
	const orderPolicyMessage = orderPolicyError
		? _(orderPolicyErrorMessage(orderPolicyError))
		: null
	const checkoutIssue = fetcher.data?.checkoutIssue ?? null
	const checkoutMessage = checkoutIssue
		? _(checkoutIssueMessage(checkoutIssue))
		: null
	const [tab, setTab] = useState('general')
	// The refused field lives on the Fulfillment & Timing tab: show it.
	useEffect(() => {
		if (orderPolicyError || checkoutIssue) setTab('fulfillment')
	}, [orderPolicyError, checkoutIssue])
	// The fetcher stays busy through the redirect that follows a save.
	const isSubmitting = fetcher.state !== 'idle'
	const formRef = useRef<HTMLFormElement>(null)
	useFormSnapshotSaveBar(formRef, {
		saving: isSubmitting,
		result: fetcher.data,
		onDiscard,
	})

	// Parse site locales for internationalization
	const localesConfig = parseSiteLocalesConfig(
		siteLocalesRaw,
		siteDefaultLocaleRaw,
	)
	const [activeLocale, setActiveLocale] = useState<string>(
		localesConfig.defaultLocale,
	)
	const [pickupInstructions, setPickupInstructions] = useState(
		checkoutRules?.initial.pickupInstructions ?? {},
	)
	const [orderCaps, setOrderCaps] = useState(
		checkoutRules?.initial.orderCaps ?? {
			pickupMaxSubtotal: '',
			deliveryMaxSubtotal: '',
			dineInMaxGuests: '',
		},
	)
	const [packagingFee, setPackagingFee] = useState(
		checkoutRules?.initial.packagingFee ??
			packagingFeeFormFromRecord(null, checkoutRules?.currency ?? 'USD'),
	)

	// State
	const [name, setName] = useState(initialData?.name || '')
	const [slug, setSlug] = useState(initialData?.slug || '')
	const [phone, setPhone] = useState(initialData?.phone || '')
	const [timezone, setTimezone] = useState(
		initialData?.timezone || 'America/New_York',
	)
	const [taxRate, setTaxRate] = useState(initialData?.taxRate ?? 8.25)
	const [taxInclusive, setTaxInclusive] = useState(
		initialData?.taxInclusive ?? false,
	)
	const [vatNumber, setVatNumber] = useState(initialData?.vatNumber ?? '')
	const [isActive, setIsActive] = useState(initialData?.isActive ?? true)
	const [isDefault, setIsDefault] = useState(initialData?.isDefault ?? false)

	// Address
	const [address, setAddress] = useState<LocationAddress>(
		initialData?.address || {
			formattedAddress: '',
			streetNumber: '',
			streetName: '',
			unit: '',
			city: '',
			state: '',
			postalCode: '',
			country: 'United States',
			lat: 40.7128,
			lng: -74.006,
		},
	)

	// Hours
	const [storeHours, setStoreHours] = useState<WeeklySchedule>(
		initialData?.storeHours || DEFAULT_WEEKLY_SCHEDULE,
	)
	const [onlineHours, setOnlineHours] = useState<WeeklySchedule>(
		initialData?.onlineHours || DEFAULT_WEEKLY_SCHEDULE,
	)
	const [onlineOrderingForm, setOnlineOrderingForm] = useState<
		OrderingSettingsFormBundle['online']
	>(orderingSettings?.initial.online ?? defaultOnlineOrderingForm())
	const [syncOnlineWithStore, setSyncOnlineWithStore] = useState(
		orderingSettings?.initial.online.syncOnlineWithStore ?? true,
	)
	const [slotLimitForm, setSlotLimitForm] = useState(
		orderingSettings?.initial.slot ?? defaultSlotLimitForm(),
	)
	const [prepScheduleRows, setPrepScheduleRows] = useState(
		orderingSettings?.initial.prep ?? [],
	)
	const [prayerPauseForm, setPrayerPauseForm] = useState(
		orderingSettings?.initial.prayer ?? defaultPrayerPauseForm(),
	)
	const [specialHours, setSpecialHours] = useState<SpecialHour[]>(
		initialData?.specialHours || [],
	)

	// Timing & Prep Time
	const [policyValues, setPolicyValues] = useState<OrderPolicyValues | null>(
		orderPolicies?.initial ?? null,
	)
	const [tipValues, setTipValues] = useState<TipFormValues | null>(
		checkoutSettings?.tips ?? null,
	)
	const [feeValues, setFeeValues] = useState<FeeFormValues | null>(
		checkoutSettings?.fee ?? null,
	)
	const [prepTime, setPrepTime] = useState(initialData?.prepTime ?? 15)
	// The old single large-order threshold (#355 moved the rule into the online
	// ordering settings): no longer edited, posted back unchanged so saving never
	// rewrites those columns.
	const largeOrderThreshold = initialData?.largeOrderThreshold ?? 100
	const largeOrderThresholdType =
		initialData?.largeOrderThresholdType ?? 'dollars'
	const largeOrderExtraPrepTime = initialData?.largeOrderExtraPrepTime ?? 15

	// Fulfillment Options
	const [fulfillment, setFulfillment] = useState<FulfillmentOptions>(() => ({
		...DEFAULT_FULFILLMENT_OPTIONS,
		...initialData?.fulfillmentOptions,
	}))

	// In-House Tips
	const [tips, setTips] = useState<InHouseTips>(() => ({
		...DEFAULT_IN_HOUSE_TIPS,
		...initialData?.inHouseTips,
	}))

	// Scheduling
	const [scheduling, setScheduling] = useState<SchedulingOptions>(() => ({
		...DEFAULT_SCHEDULING,
		...initialData?.scheduling,
	}))

	// Delivery Configuration & Zones
	const [deliveryConfig, setDeliveryConfig] = useState<DeliveryConfig>(() => {
		const raw = (initialData?.deliveryConfig as any) || {}
		return {
			providers:
				Array.isArray(raw.providers) && raw.providers.length > 0
					? raw.providers
					: DEFAULT_DELIVERY_CONFIG.providers,
			estimatedDeliveryTimeMin:
				raw.estimatedDeliveryTimeMin ??
				raw.estimatedTimeMin ??
				DEFAULT_DELIVERY_CONFIG.estimatedDeliveryTimeMin,
			estimatedDeliveryTimeMax:
				raw.estimatedDeliveryTimeMax ??
				raw.estimatedTimeMax ??
				DEFAULT_DELIVERY_CONFIG.estimatedDeliveryTimeMax,
		}
	})
	const storedCourses = readStoredCourses(initialData?.courseSettings)
	const [coursesEnabled, setCoursesEnabled] = useState(storedCourses.enabled)
	const [autoFireMinutes, setAutoFireMinutes] = useState(
		storedCourses.autoFireMinutes,
	)
	const [courseNames, setCourseNames] = useState(storedCourses.courses)
	const storedOrderNumberFormat = parseOrderNumberFormat(
		initialData?.orderNumberFormat,
	)
	const [orderPrefix, setOrderPrefix] = useState(storedOrderNumberFormat.prefix)
	const [orderDigits, setOrderDigits] = useState(
		String(storedOrderNumberFormat.digits),
	)
	const [orderResetTime, setOrderResetTime] = useState(
		storedOrderNumberFormat.resetTime,
	)
	const [deliveryZones, setDeliveryZones] = useState<DeliveryZone[]>(() => {
		if (
			Array.isArray(initialData?.deliveryZones) &&
			initialData.deliveryZones.length > 0
		) {
			return initialData.deliveryZones
		}
		return [DEFAULT_DELIVERY_ZONE]
	})

	// Slug helper on name change
	const handleNameChange = (val: string) => {
		setName(val)
		if (!isEditing && !slug) {
			let plain = val
			try {
				if (val.startsWith('{')) {
					const obj = JSON.parse(val) as Record<string, string>
					plain =
						obj[localesConfig.defaultLocale] || Object.values(obj)[0] || ''
				}
			} catch {
				plain = val
			}
			setSlug(
				plain
					.toLowerCase()
					.replace(/[^a-z0-9]+/g, '-')
					.replace(/^-|-$/g, ''),
			)
		}
	}

	// What a save sends. The fields are React state, mostly without named
	// inputs, so the form also carries it in a hidden field for the save bar.
	const payload: Record<string, string | number | boolean> = {
		name,
		slug: slug.trim().toLowerCase(),
		phone: phone.trim(),
		timezone,
		taxRate,
		taxInclusive,
		vatNumber: vatNumber.trim(),
		isActive,
		isDefault,
		address: JSON.stringify(address),
		storeHours: JSON.stringify(storeHours),
		onlineHours: JSON.stringify(onlineHours),
		specialHours: JSON.stringify(specialHours),
		prepTime,
		largeOrderThreshold,
		largeOrderThresholdType,
		largeOrderExtraPrepTime,
		fulfillmentOptions: JSON.stringify(fulfillment),
		inHouseTips: JSON.stringify(tips),
		scheduling: JSON.stringify(scheduling),
		deliveryConfig: JSON.stringify(deliveryConfig),
		deliveryZones: JSON.stringify(deliveryZones),
		courseSettings: JSON.stringify({
			enabled: coursesEnabled,
			autoFireMinutes: courseAutoFireMinutes(autoFireMinutes),
			courses: courseNames.map((course) => ({
				id: course.id,
				name:
					course.name.trim() ||
					DEFAULT_COURSES.find((item) => item.id === course.id)?.name ||
					course.id,
			})),
		}),
		orderNumberFormat: JSON.stringify(
			parseOrderNumberFormat({
				prefix: ORDER_NUMBER_PREFIX_REGEX.test(orderPrefix.trim())
					? orderPrefix.trim()
					: '',
				digits: Math.max(2, Math.min(6, Number(orderDigits) || 4)),
				resetTime: orderResetTime || '04:00',
			}),
		),
		...(orderPolicies && policyValues ? policyValues : {}),
		// Typed text as JSON; the action reads it into the shared settings.
		...(checkoutSettings && tipValues
			? { checkoutTips: JSON.stringify(tipValues) }
			: {}),
		...(checkoutSettings?.serviceFeeEnabled && feeValues
			? { checkoutFee: JSON.stringify(feeValues) }
			: {}),
		...(orderingSettings
			? {
					orderingSettings: JSON.stringify({
						online: {
							...onlineOrderingForm,
							syncOnlineWithStore,
						},
						slot: slotLimitForm,
						prep: prepScheduleRows,
						prayer: prayerPauseForm,
					}),
				}
			: {}),
		...(checkoutRules
			? {
					checkoutRules: JSON.stringify({
						pickupInstructions,
						orderCaps,
						packagingFee,
					} satisfies CheckoutRulesBundle),
				}
			: {}),
	}

	const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault()
		void fetcher.submit(payload, { method: 'POST' })
	}

	const toggleDeliveryProvider = (p: 'in_house' | 'uber_eats' | 'doordash') => {
		setDeliveryConfig((prev) => {
			const current = Array.isArray(prev?.providers) ? prev.providers : []
			return {
				...prev,
				providers: current.includes(p)
					? current.filter((item) => item !== p)
					: [...current, p],
			}
		})
	}

	return (
		<TranslateProvider
			activeLocale={activeLocale}
			defaultLocale={localesConfig.defaultLocale}
		>
			<LocaleContext.Provider
				value={{
					activeLocale,
					defaultLocale: localesConfig.defaultLocale,
					locales: localesConfig.locales,
					setActiveLocale,
				}}
			>
				<form
					ref={formRef}
					onSubmit={handleSubmit}
					noValidate
					className="space-y-6"
				>
					<input
						type="hidden"
						name="locationDraft"
						value={JSON.stringify(payload)}
					/>
					{fetcher.data?.error ? (
						<div
							role="alert"
							className="bg-destructive/10 border-destructive/20 text-destructive rounded-md border p-3 text-sm"
							data-testid="location-form-error"
						>
							{orderPolicyMessage ? (
								<Trans>Online order rules: {orderPolicyMessage}</Trans>
							) : checkoutMessage ? (
								checkoutIssue?.section === 'fee' ? (
									<Trans>Service fee: {checkoutMessage}</Trans>
								) : (
									<Trans>Tip choices: {checkoutMessage}</Trans>
								)
							) : (
								fetcher.data.error
							)}
						</div>
					) : null}
					<Tabs
						value={tab}
						onValueChange={(next) => setTab(String(next))}
						className="w-full"
					>
						<TabsList className="grid w-full grid-cols-2 lg:grid-cols-4">
							<TabsTrigger value="general">
								<Trans>Details & Address</Trans>
							</TabsTrigger>
							<TabsTrigger value="hours">
								<Trans>Operating Hours</Trans>
							</TabsTrigger>
							<TabsTrigger value="fulfillment">
								<Trans>Fulfillment & Timing</Trans>
							</TabsTrigger>
							<TabsTrigger value="delivery">
								<Trans>Delivery & Zones</Trans>
							</TabsTrigger>
						</TabsList>

						{/* TAB 1: DETAILS & ADDRESS */}
						<TabsContent value="general" className="mt-6 space-y-6">
							<Card>
								<CardHeader>
									<div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
										<div>
											<CardTitle>
												<Trans>Location Details</Trans>
											</CardTitle>
											<CardDescription>
												<Trans>
													Basic identifiers, URL slug, and regional settings.
												</Trans>
											</CardDescription>
										</div>
										<LocaleSwitcher />
									</div>
								</CardHeader>
								<CardContent className="space-y-4">
									<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
										<div className="space-y-1.5">
											<Label htmlFor="loc-name">
												<Trans>Location Name</Trans>
											</Label>
											<LocalizedInput
												id="loc-name"
												value={name}
												onChange={handleNameChange}
												placeholder={_(msg`e.g. Downtown Flagship`)}
												required
											/>
										</div>

										<div className="space-y-1.5">
											<Label htmlFor="loc-slug">
												<Trans>URL Slug</Trans>
											</Label>
											<Input
												id="loc-slug"
												value={slug}
												onChange={(e) => setSlug(e.target.value)}
												placeholder="downtown"
												pattern="[a-z0-9-]+"
												required
											/>
											<p className="text-muted-foreground text-[11px]">
												<Trans>
													Used on the public online ordering website.
												</Trans>
											</p>
										</div>

										<div className="space-y-1.5">
											<Label htmlFor="loc-phone">
												<Trans>Phone Number</Trans>
											</Label>
											<Input
												id="loc-phone"
												type="tel"
												value={phone}
												onChange={(e) => setPhone(e.target.value)}
												placeholder="+1 (555) 234-5678"
											/>
										</div>

										<div className="space-y-1.5">
											<Label htmlFor="loc-timezone">
												<Trans>Timezone</Trans>
											</Label>
											<Select
												value={timezone}
												items={TIMEZONE_OPTIONS}
												onValueChange={(val) => val && setTimezone(val)}
											>
												<SelectTrigger id="loc-timezone">
													<SelectValue />
												</SelectTrigger>
												<SelectContent>
													{TIMEZONE_OPTIONS.map((tz) => (
														<SelectItem key={tz.value} value={tz.value}>
															{tz.label}
														</SelectItem>
													))}
												</SelectContent>
											</Select>
										</div>

										<div className="space-y-1.5">
											<Label htmlFor="loc-tax">
												<Trans>Sales Tax Rate (%)</Trans>
											</Label>
											<Input
												id="loc-tax"
												type="number"
												step="0.01"
												min="0"
												value={taxRate}
												onChange={(e) =>
													setTaxRate(parseFloat(e.target.value) || 0)
												}
												placeholder="8.25"
											/>
										</div>

										<div className="space-y-1.5">
											<Label htmlFor="loc-vat-number">
												<Trans>VAT Registration Number</Trans>
											</Label>
											<Input
												id="loc-vat-number"
												value={vatNumber}
												onChange={(e) => setVatNumber(e.target.value)}
												maxLength={32}
												pattern="[A-Za-z0-9]*"
												inputMode="text"
												autoComplete="off"
												placeholder="310123456700003"
											/>
											<p className="text-muted-foreground text-[11px]">
												<Trans>
													Printed on receipts. Letters and digits only; leave
													empty if not registered.
												</Trans>
											</p>
										</div>
									</div>

									<div className="border-border divide-border divide-y rounded-md border">
										<div className="flex items-center justify-between p-3">
											<div>
												<Label
													htmlFor="loc-tax-inclusive"
													className="cursor-pointer"
												>
													<Trans>Prices include tax</Trans>
												</Label>
												<p className="text-muted-foreground text-xs">
													<Trans>
														Menu prices already include tax (VAT), as required
														in Saudi Arabia, the EU and the UK. Tax is shown on
														receipts but not added at checkout.
													</Trans>
												</p>
											</div>
											<Switch
												id="loc-tax-inclusive"
												checked={taxInclusive}
												onCheckedChange={setTaxInclusive}
											/>
										</div>

										<div className="flex items-center justify-between p-3">
											<div>
												<Label htmlFor="loc-active" className="cursor-pointer">
													<Trans>Active Location</Trans>
												</Label>
												<p className="text-muted-foreground text-xs">
													<Trans>
														Accept orders and show this location on the website.
													</Trans>
												</p>
											</div>
											<Switch
												id="loc-active"
												checked={isActive}
												onCheckedChange={setIsActive}
											/>
										</div>

										<div className="flex items-center justify-between p-3">
											<div>
												<Label htmlFor="loc-default" className="cursor-pointer">
													<Trans>Primary / Default Location</Trans>
												</Label>
												<p className="text-muted-foreground text-xs">
													<Trans>
														Make this the primary location for your restaurant.
													</Trans>
												</p>
											</div>
											<Switch
												id="loc-default"
												checked={isDefault}
												onCheckedChange={setIsDefault}
											/>
										</div>
									</div>
								</CardContent>
							</Card>

							{/* Physical Address & Map */}
							<Card>
								<CardHeader>
									<CardTitle>
										<Trans>Physical Address</Trans>
									</CardTitle>
									<CardDescription>
										<Trans>
											Search and select location address with Google
											Autocomplete.
										</Trans>
									</CardDescription>
								</CardHeader>
								<CardContent className="space-y-4">
									<AddressAutocomplete
										address={address}
										onChange={setAddress}
									/>

									<div className="h-56 w-full pt-2">
										<DeliveryZoneMap
											centerLat={address.lat}
											centerLng={address.lng}
											zoneType="radius"
											radiusValue={3}
											radiusUnit="miles"
											polygonPoints={[]}
											editable={false}
										/>
									</div>
								</CardContent>
							</Card>
						</TabsContent>

						{/* TAB 2: OPERATING HOURS */}
						<TabsContent value="hours" className="mt-6 space-y-6">
							<Card>
								<CardHeader>
									<CardTitle>
										<Trans>Operating Hours</Trans>
									</CardTitle>
									<CardDescription>
										<Trans>
											Configure weekly opening times for dine-in store hours and
											online ordering.
										</Trans>
									</CardDescription>
								</CardHeader>
								<CardContent className="space-y-6">
									<LocationHoursSection
										storeHours={storeHours}
										onlineHours={onlineHours}
										onStoreHoursChange={setStoreHours}
										onOnlineHoursChange={setOnlineHours}
										syncOnlineWithStore={syncOnlineWithStore}
										onSyncOnlineWithStoreChange={(checked) => {
											setSyncOnlineWithStore(checked)
											setOnlineOrderingForm((prev) => ({
												...prev,
												syncOnlineWithStore: checked,
											}))
										}}
									/>

									{orderingSettings ? (
										<OnlineOrderingBuffersCard
											values={{
												...onlineOrderingForm,
												syncOnlineWithStore,
											}}
											onChange={(next) => {
												setOnlineOrderingForm(next)
												setSyncOnlineWithStore(next.syncOnlineWithStore)
											}}
										/>
									) : null}

									{orderingSettings ? (
										<UtensilsCheckoutCard
											enabled={onlineOrderingForm.utensilsEnabled}
											defaultRequested={
												onlineOrderingForm.utensilsDefaultRequested
											}
											onChange={({ enabled, defaultRequested }) =>
												setOnlineOrderingForm((prev) => ({
													...prev,
													utensilsEnabled: enabled,
													utensilsDefaultRequested: defaultRequested,
												}))
											}
										/>
									) : null}

									{checkoutRules ? (
										<PickupInstructionsCard
											locales={checkoutRules.locales}
											activeLocale={activeLocale}
											onLocaleChange={setActiveLocale}
											values={pickupInstructions}
											onChange={setPickupInstructions}
										/>
									) : null}

									<SpecialHoursPicker
										specialHours={specialHours}
										onChange={setSpecialHours}
									/>
								</CardContent>
							</Card>
						</TabsContent>

						{/* TAB 3: FULFILLMENT & PREP TIME */}
						<TabsContent value="fulfillment" className="mt-6 space-y-6">
							{/* Preparation Time */}
							<Card>
								<CardHeader>
									<CardTitle>
										<Trans>Order Preparation Time</Trans>
									</CardTitle>
									<CardDescription>
										<Trans>
											Estimated kitchen lead time and extra time for high-volume
											orders.
										</Trans>
									</CardDescription>
								</CardHeader>
								<CardContent className="space-y-4">
									<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
										<div className="space-y-1.5">
											<Label htmlFor="loc-prep">
												<Trans>Base Preparation Time (minutes)</Trans>
											</Label>
											<Input
												id="loc-prep"
												type="number"
												min="1"
												value={prepTime}
												onChange={(e) =>
													setPrepTime(parseInt(e.target.value) || 15)
												}
												required
											/>
										</div>
									</div>

									{orderingSettings ? (
										<LargeOrderFields
											values={onlineOrderingForm}
											currency={checkoutRules?.currency ?? null}
											onChange={(next) =>
												setOnlineOrderingForm((prev) => ({ ...prev, ...next }))
											}
										/>
									) : null}
								</CardContent>
							</Card>

							{orderingSettings ? (
								<PrepScheduleCard
									rows={prepScheduleRows}
									onChange={setPrepScheduleRows}
								/>
							) : null}

							{orderingSettings?.slotLimitsEnabled ? (
								<SlotLimitsCard
									values={slotLimitForm}
									onChange={setSlotLimitForm}
								/>
							) : null}

							{orderPolicies && policyValues ? (
								<OrderPoliciesCard
									flags={orderPolicies.flags}
									currency={orderPolicies.currency}
									values={policyValues}
									onChange={setPolicyValues}
									error={orderPolicyError}
								/>
							) : null}

							{orderingSettings?.prayerPauseEnabled ? (
								<PrayerPauseCard
									values={prayerPauseForm}
									onChange={setPrayerPauseForm}
								/>
							) : null}

							{/* Fulfillment Channels */}
							<Card>
								<CardHeader>
									<CardTitle>
										<Trans>Fulfillment Options</Trans>
									</CardTitle>
									<CardDescription>
										<Trans>
											Enable or disable available fulfillment channels for this
											location.
										</Trans>
									</CardDescription>
								</CardHeader>
								<CardContent>
									<div className="border-border divide-border divide-y rounded-md border">
										<div className="flex items-center justify-between p-3">
											<div>
												<Label htmlFor="opt-pickup" className="font-medium">
													<Trans>Store Pickup</Trans>
												</Label>
												<p className="text-muted-foreground text-xs">
													<Trans>Customers pick up orders in-store.</Trans>
												</p>
											</div>
											<Switch
												id="opt-pickup"
												checked={fulfillment.pickup}
												onCheckedChange={(c) =>
													setFulfillment({ ...fulfillment, pickup: c })
												}
											/>
										</div>

										<div className="flex items-center justify-between p-3">
											<div>
												<Label htmlFor="opt-delivery" className="font-medium">
													<Trans>Delivery</Trans>
												</Label>
												<p className="text-muted-foreground text-xs">
													<Trans>
														In-house fleet, Uber Eats, or DoorDash delivery.
													</Trans>
												</p>
											</div>
											<Switch
												id="opt-delivery"
												checked={fulfillment.delivery}
												onCheckedChange={(c) =>
													setFulfillment({ ...fulfillment, delivery: c })
												}
											/>
										</div>

										<div className="flex items-center justify-between p-3">
											<div>
												<Label htmlFor="opt-dinein" className="font-medium">
													<Trans>Dine-In / In-House</Trans>
												</Label>
												<p className="text-muted-foreground text-xs">
													<Trans>Table ordering and in-house steps.</Trans>
												</p>
											</div>
											<Switch
												id="opt-dinein"
												checked={fulfillment.dineIn}
												onCheckedChange={(c) =>
													setFulfillment({ ...fulfillment, dineIn: c })
												}
											/>
										</div>

										<div className="flex items-center justify-between p-3">
											<div>
												<Label htmlFor="opt-curbside" className="font-medium">
													<Trans>Curbside Pickup</Trans>
												</Label>
												<p className="text-muted-foreground text-xs">
													<Trans>Vehicle pickup with car details.</Trans>
												</p>
											</div>
											<Switch
												id="opt-curbside"
												checked={fulfillment.curbside}
												onCheckedChange={(c) =>
													setFulfillment({ ...fulfillment, curbside: c })
												}
											/>
										</div>
									</div>
								</CardContent>
							</Card>

							{/* In-House Tips & Scheduling */}
							<Card>
								<CardHeader>
									<CardTitle>
										<Trans>Tips & Order Scheduling</Trans>
									</CardTitle>
									<CardDescription>
										<Trans>
											Tip prompt options and advance order scheduling rules.
										</Trans>
									</CardDescription>
								</CardHeader>
								<CardContent className="space-y-4">
									<div>
										<Label className="mb-2 block text-xs uppercase">
											<Trans>In-House Tips</Trans>
										</Label>
										<div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
											<label className="hover:bg-muted/40 flex cursor-pointer items-center gap-2.5 rounded-md border p-3">
												<Checkbox
													checked={tips.pickupTips}
													onCheckedChange={(c) =>
														setTips({ ...tips, pickupTips: c === true })
													}
												/>
												<span className="text-xs font-medium">
													<Trans>Pickup Tips</Trans>
												</span>
											</label>

											<label className="hover:bg-muted/40 flex cursor-pointer items-center gap-2.5 rounded-md border p-3">
												<Checkbox
													checked={tips.deliveryTips}
													onCheckedChange={(c) =>
														setTips({ ...tips, deliveryTips: c === true })
													}
												/>
												<span className="text-xs font-medium">
													<Trans>Delivery Tips</Trans>
												</span>
											</label>

											<label className="hover:bg-muted/40 flex cursor-pointer items-center gap-2.5 rounded-md border p-3">
												<Checkbox
													checked={tips.dineInTips}
													onCheckedChange={(c) =>
														setTips({ ...tips, dineInTips: c === true })
													}
												/>
												<span className="text-xs font-medium">
													<Trans>Dine-In Tips</Trans>
												</span>
											</label>
										</div>
									</div>

									<div className="border-border border-t pt-4">
										<div className="flex items-center justify-between">
											<div>
												<Label htmlFor="opt-scheduling" className="font-medium">
													<Trans>Advance Scheduled Orders</Trans>
												</Label>
												<p className="text-muted-foreground text-xs">
													<Trans>
														Allow customers to schedule orders for future dates.
													</Trans>
												</p>
											</div>
											<Switch
												id="opt-scheduling"
												checked={scheduling.scheduledOrdersEnabled}
												onCheckedChange={(c) =>
													setScheduling({
														...scheduling,
														scheduledOrdersEnabled: c,
													})
												}
											/>
										</div>

										{scheduling.scheduledOrdersEnabled && (
											<div className="mt-3 max-w-xs space-y-1">
												<Label htmlFor="opt-advance-days" className="text-xs">
													<Trans>Maximum advance ordering window (days)</Trans>
												</Label>
												<Input
													id="opt-advance-days"
													type="number"
													min="1"
													max="60"
													value={scheduling.advanceOrderDays}
													onChange={(e) =>
														setScheduling({
															...scheduling,
															advanceOrderDays: parseInt(e.target.value) || 7,
														})
													}
												/>
											</div>
										)}
									</div>
								</CardContent>
							</Card>

							{checkoutSettings && tipValues ? (
								<TipChoicesCard
									currency={checkoutSettings.currency}
									values={tipValues}
									onChange={setTipValues}
									issue={checkoutIssue}
								/>
							) : null}

							{checkoutSettings?.serviceFeeEnabled && feeValues ? (
								<ServiceFeeCard
									currency={checkoutSettings.currency}
									values={feeValues}
									onChange={setFeeValues}
									issue={checkoutIssue}
								/>
							) : null}

							{checkoutRules ? (
								<OrderCapsCard
									currency={checkoutRules.currency}
									values={orderCaps}
									onChange={setOrderCaps}
								/>
							) : null}

							{checkoutRules?.packagingFeeEnabled ? (
								<PackagingFeeCard
									currency={checkoutRules.currency}
									values={packagingFee}
									onChange={setPackagingFee}
								/>
							) : null}
						</TabsContent>

						{/* TAB 4: DELIVERY & ZONES */}
						<TabsContent value="delivery" className="mt-6 space-y-6">
							<Card>
								<CardHeader>
									<CardTitle>
										<Trans>Delivery Settings & Providers</Trans>
									</CardTitle>
									<CardDescription>
										<Trans>
											Choose supported delivery channels and estimated transit
											times.
										</Trans>
									</CardDescription>
								</CardHeader>
								<CardContent className="space-y-4">
									<div>
										<Label className="mb-2 block text-xs uppercase">
											<Trans>Supported Delivery Providers</Trans>
										</Label>
										<div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
											<label className="hover:bg-muted/40 flex cursor-pointer items-center gap-2.5 rounded-md border p-3">
												<Checkbox
													checked={Boolean(
														deliveryConfig.providers?.includes('in_house'),
													)}
													onCheckedChange={() =>
														toggleDeliveryProvider('in_house')
													}
												/>
												<div>
													<span className="block text-xs font-medium">
														<Trans>In-House Delivery</Trans>
													</span>
													<span className="text-muted-foreground text-[10px]">
														Your own drivers
													</span>
												</div>
											</label>

											<label className="hover:bg-muted/40 flex cursor-pointer items-center gap-2.5 rounded-md border p-3">
												<Checkbox
													checked={Boolean(
														deliveryConfig.providers?.includes('uber_eats'),
													)}
													onCheckedChange={() =>
														toggleDeliveryProvider('uber_eats')
													}
												/>
												<div>
													<span className="block text-xs font-medium">
														<Trans>Uber Eats</Trans>
													</span>
													<span className="text-muted-foreground text-[10px]">
														On-demand fleet
													</span>
												</div>
											</label>

											<label className="hover:bg-muted/40 flex cursor-pointer items-center gap-2.5 rounded-md border p-3">
												<Checkbox
													checked={Boolean(
														deliveryConfig.providers?.includes('doordash'),
													)}
													onCheckedChange={() =>
														toggleDeliveryProvider('doordash')
													}
												/>
												<div>
													<span className="block text-xs font-medium">
														<Trans>DoorDash Drive</Trans>
													</span>
													<span className="text-muted-foreground text-[10px]">
														DoorDash dispatch
													</span>
												</div>
											</label>
										</div>
									</div>

									<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
										<div className="space-y-1.5">
											<Label htmlFor="del-time-min">
												<Trans>Estimated Min Delivery Time (minutes)</Trans>
											</Label>
											<Input
												id="del-time-min"
												type="number"
												min="5"
												value={deliveryConfig.estimatedDeliveryTimeMin ?? 20}
												onChange={(e) =>
													setDeliveryConfig({
														...deliveryConfig,
														estimatedDeliveryTimeMin:
															parseInt(e.target.value) || 20,
													})
												}
											/>
										</div>

										<div className="space-y-1.5">
											<Label htmlFor="del-time-max">
												<Trans>Estimated Max Delivery Time (minutes)</Trans>
											</Label>
											<Input
												id="del-time-max"
												type="number"
												min="5"
												value={deliveryConfig.estimatedDeliveryTimeMax ?? 45}
												onChange={(e) =>
													setDeliveryConfig({
														...deliveryConfig,
														estimatedDeliveryTimeMax:
															parseInt(e.target.value) || 45,
													})
												}
											/>
										</div>
									</div>
								</CardContent>
							</Card>

							{/* Delivery Zones Manager */}
							<Card>
								<CardHeader>
									<CardTitle>
										<Trans>Delivery Zones & Geo-Fencing</Trans>
									</CardTitle>
									<CardDescription>
										<Trans>
											Configure allowed and restricted areas via Radius, Zip
											Codes, or Drawn Polygons.
										</Trans>
									</CardDescription>
								</CardHeader>
								<CardContent>
									<DeliveryZonesManager
										zones={deliveryZones}
										onChange={setDeliveryZones}
										centerLat={address.lat}
										centerLng={address.lng}
									/>
								</CardContent>
							</Card>
						</TabsContent>
					</Tabs>

					<Card>
						<CardHeader>
							<CardTitle>
								<Trans>Courses</Trans>
							</CardTitle>
							<CardDescription>
								<Trans>
									Dine-in tickets can hold later courses until the kitchen fires
									them. Takeaway, delivery and drive-through send everything at
									once.
								</Trans>
							</CardDescription>
						</CardHeader>
						<CardContent className="space-y-4">
							<div className="flex items-center justify-between gap-3">
								<Label htmlFor="loc-courses">
									<Trans>Fire courses one at a time</Trans>
								</Label>
								<Switch
									id="loc-courses"
									checked={coursesEnabled}
									onCheckedChange={setCoursesEnabled}
								/>
							</div>
							<div className="grid gap-3 sm:grid-cols-3">
								{courseNames.map((course, index) => (
									<div key={course.id} className="space-y-2">
										<Label htmlFor={`loc-course-${course.id}`}>
											{course.id === 'starter'
												? _(t`Starter`)
												: course.id === 'main'
													? _(t`Main`)
													: course.id === 'dessert'
														? _(t`Dessert`)
														: course.id}
										</Label>
										<Input
											id={`loc-course-${course.id}`}
											value={course.name}
											onChange={(event) =>
												setCourseNames((current) =>
													current.map((item, itemIndex) =>
														itemIndex === index
															? { ...item, name: event.target.value }
															: item,
													),
												)
											}
										/>
									</div>
								))}
							</div>
							<div className="space-y-2">
								<Label htmlFor="loc-course-autofire">
									<Trans>Fire the next course after (minutes)</Trans>
								</Label>
								<Input
									id="loc-course-autofire"
									inputMode="numeric"
									value={autoFireMinutes}
									onChange={(event) => setAutoFireMinutes(event.target.value)}
									placeholder={_(t`Leave empty to fire by hand`)}
								/>
								<p className="text-muted-foreground text-xs">
									<Trans>
										Starts when every dish in the previous course is ready.
									</Trans>
								</p>
							</div>
						</CardContent>
					</Card>

					<Card>
						<CardHeader>
							<CardTitle>
								<Trans>Order numbers</Trans>
							</CardTitle>
							<CardDescription>
								<Trans>
									Format and daily reset time for new web, QR and Station order
									numbers at this location. Existing orders keep their numbers.
								</Trans>
							</CardDescription>
						</CardHeader>
						<CardContent className="space-y-4">
							<div className="grid gap-3 sm:grid-cols-3">
								<div className="space-y-2">
									<Label htmlFor="loc-order-prefix">
										<Trans>Prefix</Trans>
									</Label>
									<Input
										id="loc-order-prefix"
										maxLength={4}
										dir="ltr"
										placeholder={_(t`None (e.g. A)`)}
										value={orderPrefix}
										onChange={(event) =>
											setOrderPrefix(
												event.target.value
													.replace(/[^A-Za-z0-9]/g, '')
													.slice(0, 4),
											)
										}
									/>
								</div>
								<div className="space-y-2">
									<Label htmlFor="loc-order-digits">
										<Trans>Digits</Trans>
									</Label>
									<Input
										id="loc-order-digits"
										type="number"
										min={2}
										max={6}
										dir="ltr"
										value={orderDigits}
										onChange={(event) => setOrderDigits(event.target.value)}
									/>
								</div>
								<div className="space-y-2">
									<Label htmlFor="loc-order-reset-time">
										<Trans>Daily reset time</Trans>
									</Label>
									<Input
										id="loc-order-reset-time"
										type="time"
										dir="ltr"
										value={orderResetTime}
										onChange={(event) => setOrderResetTime(event.target.value)}
									/>
								</div>
							</div>
							<p className="text-muted-foreground text-xs">
								{(() => {
									const previewNumber = formatAllocatedOrderNumber(1, {
										prefix: orderPrefix.trim(),
										digits: Math.max(2, Math.min(6, Number(orderDigits) || 4)),
									})
									return (
										<Trans>
											First order of the business day:{' '}
											<bdi dir="ltr">{previewNumber}</bdi>
										</Trans>
									)
								})()}
							</p>
						</CardContent>
					</Card>

					{/* Bottom Actions Bar */}
					<div className="border-border flex items-center justify-end gap-3 border-t pt-4">
						<Button
							type="button"
							variant="outline"
							render={<Link to={`/${orgSlug}/settings/locations`} />}
						>
							<Trans>Cancel</Trans>
						</Button>

						<StatusButton
							type="submit"
							status={isSubmitting ? 'pending' : 'idle'}
							className="min-w-32"
						>
							{isEditing ? (
								<Trans>Save Changes</Trans>
							) : (
								<Trans>Create Location</Trans>
							)}
						</StatusButton>
					</div>
				</form>
			</LocaleContext.Provider>
		</TranslateProvider>
	)
}
