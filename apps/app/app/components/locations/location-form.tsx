'use client'

import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
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
import React, { useState } from 'react'
import { Link, useFetcher } from 'react-router'
import {
	LocaleContext,
	LocaleSwitcher,
	LocalizedInput,
} from '#app/components/website/locale-fields.tsx'
import { TranslateProvider } from '#app/components/website/translate-provider.tsx'
import { AddressAutocomplete } from './address-autocomplete'
import { LocationHoursSection } from './availability-picker'
import { DeliveryZoneMap } from './delivery-zone-map'
import { DeliveryZonesManager } from './delivery-zones-manager'
import { SpecialHoursPicker } from './special-hours-picker'

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
	isActive?: boolean
	isDefault?: boolean
}

interface LocationFormProps {
	orgSlug: string
	initialData?: InitialLocationData
	siteLocalesRaw?: string | null
	siteDefaultLocaleRaw?: string | null
	isEditing?: boolean
}

export function LocationForm({
	orgSlug,
	initialData,
	siteLocalesRaw,
	siteDefaultLocaleRaw,
	isEditing = false,
}: LocationFormProps) {
	const { _ } = useLingui()
	const fetcher = useFetcher<{ error?: string }>()
	const isSubmitting = fetcher.state !== 'idle'

	// Parse site locales for internationalization
	const localesConfig = parseSiteLocalesConfig(
		siteLocalesRaw,
		siteDefaultLocaleRaw,
	)
	const [activeLocale, setActiveLocale] = useState<string>(
		localesConfig.defaultLocale,
	)

	// State
	const [name, setName] = useState(initialData?.name || '')
	const [slug, setSlug] = useState(initialData?.slug || '')
	const [phone, setPhone] = useState(initialData?.phone || '')
	const [timezone, setTimezone] = useState(
		initialData?.timezone || 'America/New_York',
	)
	const [taxRate, setTaxRate] = useState(initialData?.taxRate ?? 8.25)
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
	const [specialHours, setSpecialHours] = useState<SpecialHour[]>(
		initialData?.specialHours || [],
	)

	// Timing & Prep Time
	const [prepTime, setPrepTime] = useState(initialData?.prepTime ?? 15)
	const [largeOrderThreshold, setLargeOrderThreshold] = useState(
		initialData?.largeOrderThreshold ?? 100,
	)
	const [largeOrderThresholdType, setLargeOrderThresholdType] = useState<
		'dollars' | 'items'
	>((initialData?.largeOrderThresholdType as any) || 'dollars')
	const [largeOrderExtraPrepTime, setLargeOrderExtraPrepTime] = useState(
		initialData?.largeOrderExtraPrepTime ?? 15,
	)

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

	const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault()

		const payload: Record<string, string | number | boolean> = {
			name,
			slug: slug.trim().toLowerCase(),
			phone: phone.trim(),
			timezone,
			taxRate,
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
		}

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
				<form onSubmit={handleSubmit} noValidate className="space-y-6">
					{fetcher.data?.error ? (
						<div className="bg-destructive/10 border-destructive/20 text-destructive rounded-md border p-3 text-sm">
							{fetcher.data.error}
						</div>
					) : null}
					<Tabs defaultValue="general" className="w-full">
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
									</div>

									<div className="border-border divide-border divide-y rounded-md border">
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
									/>

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

										<div className="space-y-1.5">
											<Label htmlFor="loc-extra-prep">
												<Trans>Large Order Extra Prep Time (minutes)</Trans>
											</Label>
											<Input
												id="loc-extra-prep"
												type="number"
												min="0"
												value={largeOrderExtraPrepTime}
												onChange={(e) =>
													setLargeOrderExtraPrepTime(
														parseInt(e.target.value) || 0,
													)
												}
											/>
										</div>
									</div>

									<div className="bg-muted/30 rounded-md border p-3">
										<Label className="mb-2 block text-xs uppercase">
											<Trans>Large Order Threshold Rule</Trans>
										</Label>
										<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
											<div>
												<Label className="mb-1 block text-xs">
													<Trans>Threshold Unit</Trans>
												</Label>
												<Select
													value={largeOrderThresholdType}
													onValueChange={(val) =>
														val &&
														setLargeOrderThresholdType(
															val as 'dollars' | 'items',
														)
													}
												>
													<SelectTrigger>
														<SelectValue />
													</SelectTrigger>
													<SelectContent>
														<SelectItem value="dollars">
															Order Total Amount ($)
														</SelectItem>
														<SelectItem value="items">
															Number of Items Count
														</SelectItem>
													</SelectContent>
												</Select>
											</div>

											<div>
												{(() => {
													const thresholdUnit =
														largeOrderThresholdType === 'dollars'
															? '$'
															: 'items'
													return (
														<Label className="mb-1 block text-xs">
															<Trans>
																Trigger when order exceeds ({thresholdUnit})
															</Trans>
														</Label>
													)
												})()}
												<Input
													type="number"
													min="1"
													value={largeOrderThreshold}
													onChange={(e) =>
														setLargeOrderThreshold(
															parseFloat(e.target.value) || 1,
														)
													}
												/>
											</div>
										</div>
									</div>
								</CardContent>
							</Card>

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
