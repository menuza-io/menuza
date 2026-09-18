'use client'

import { Trans } from '@lingui/macro'
import {
	emptyLocationHoursBundle,
	type LocationHoursBundle,
} from '@repo/common/location-hours'
import { AnnotatedLayout, AnnotatedSection } from '@repo/ui/annotated-layout'
import { Button } from '@repo/ui/button'
import { PageTitle } from '@repo/ui/page-title'
import { Switch } from '@repo/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@repo/ui/tabs'
import { useState } from 'react'
import {
	Form,
	Link,
	useLoaderData,
	useNavigation,
	useSearchParams,
} from 'react-router'

import {
	AddressAutocompleteField,
	type AddressFieldValues,
} from '#app/components/locations/address-autocomplete-field.tsx'
import { LocationMap } from '#app/components/locations/location-map.tsx'
import { SpecialHoursEditor } from '#app/components/locations/special-hours-editor.tsx'
import { WeeklyHoursEditor } from '#app/components/locations/weekly-hours-editor.tsx'

import { type loader } from './$locationId.tsx'

export default function EditRestaurantLocationPage() {
	const { organization, location, resolvedHours, googleMapsApiKey } =
		useLoaderData<typeof loader>()
	const [searchParams] = useSearchParams()
	const tab = searchParams.get('tab') ?? 'details'
	const navigation = useNavigation()

	const [address, setAddress] = useState<AddressFieldValues>({
		addressLine1: location.addressLine1 ?? '',
		addressLine2: location.addressLine2 ?? '',
		city: location.city ?? '',
		state: location.state ?? '',
		postalCode: location.postalCode ?? '',
		country: location.country ?? 'US',
		formattedAddress: location.formattedAddress ?? '',
		googlePlaceId: location.googlePlaceId ?? '',
		latitude: location.latitude != null ? String(location.latitude) : '',
		longitude: location.longitude != null ? String(location.longitude) : '',
	})

	const [hoursBundle, setHoursBundle] = useState<LocationHoursBundle>(
		resolvedHours ?? emptyLocationHoursBundle(),
	)

	const lat = address.latitude ? Number(address.latitude) : null
	const lng = address.longitude ? Number(address.longitude) : null

	return (
		<div className="mx-auto flex h-full w-full max-w-4xl flex-col gap-6 py-8 md:px-6 lg:px-8">
			<div className="flex flex-wrap items-center justify-between gap-4">
				<PageTitle title={location.name} description="Restaurant location" />
				<Button
					variant="outline"
					render={<Link to={`/${organization.slug}/locations`} />}
				>
					<Trans>Back to list</Trans>
				</Button>
			</div>
			<Tabs value={tab}>
				<TabsList>
					<TabsTrigger value="details" render={<Link to="?tab=details" />}>
						<Trans>Details</Trans>
					</TabsTrigger>
					<TabsTrigger value="hours" render={<Link to="?tab=hours" />}>
						<Trans>Hours</Trans>
					</TabsTrigger>
					<TabsTrigger value="kitchen" render={<Link to="?tab=kitchen" />}>
						<Trans>Kitchen</Trans>
					</TabsTrigger>
				</TabsList>
				<TabsContent value="details">
					<AnnotatedLayout>
						<AnnotatedSection
							title="Details"
							description="Address and contact."
						>
							<Form method="post" className="flex flex-col gap-6">
								<input type="hidden" name="intent" value="details" />
								<div className="grid gap-4 md:grid-cols-2">
									<label className="space-y-1 md:col-span-2">
										<span className="text-sm font-medium">
											<Trans>Location name</Trans>
										</span>
										<input
											name="name"
											defaultValue={location.name}
											required
											className="border-input bg-background flex h-9 w-full rounded-md border px-3 text-sm"
										/>
									</label>
									<label className="space-y-1">
										<span className="text-sm font-medium">
											<Trans>Phone</Trans>
										</span>
										<input
											name="phone"
											defaultValue={location.phone ?? ''}
											required
											className="border-input bg-background flex h-9 w-full rounded-md border px-3 text-sm"
										/>
									</label>
									<label className="space-y-1">
										<span className="text-sm font-medium">
											<Trans>Timezone</Trans>
										</span>
										<input
											name="timezone"
											defaultValue={location.timezone}
											className="border-input bg-background flex h-9 w-full rounded-md border px-3 text-sm"
										/>
									</label>
								</div>
								<AddressAutocompleteField
									googleMapsApiKey={googleMapsApiKey}
									values={address}
									onChange={setAddress}
								/>
								<LocationMap
									googleMapsApiKey={googleMapsApiKey}
									latitude={lat}
									longitude={lng}
									onPinChange={(nextLat, nextLng) =>
										setAddress((prev) => ({
											...prev,
											latitude: String(nextLat),
											longitude: String(nextLng),
										}))
									}
								/>
								<div className="flex flex-wrap gap-6">
									<label className="flex items-center gap-2 text-sm">
										<input
											type="checkbox"
											name="active"
											value="on"
											defaultChecked={location.active}
										/>
										<Trans>Active</Trans>
									</label>
									<label className="flex items-center gap-2 text-sm">
										<input
											type="checkbox"
											name="isDefault"
											value="on"
											defaultChecked={location.isDefault}
										/>
										<Trans>Default location</Trans>
									</label>
								</div>
								<Button type="submit" disabled={navigation.state !== 'idle'}>
									<Trans>Save details</Trans>
								</Button>
							</Form>
						</AnnotatedSection>
					</AnnotatedLayout>
				</TabsContent>
				<TabsContent value="hours">
					<AnnotatedLayout>
						<AnnotatedSection
							title="Hours"
							description="Weekly store hours, online ordering hours, and exceptions."
						>
							<Form method="post" className="flex flex-col gap-8">
								<input type="hidden" name="intent" value="hours" />
								<input
									type="hidden"
									name="hoursPayload"
									value={JSON.stringify(hoursBundle)}
								/>
								<label className="flex items-center gap-2 text-sm">
									<input
										type="checkbox"
										name="storeHoursOverride"
										value="on"
										defaultChecked={location.storeHoursOverride}
									/>
									<Trans>Override brand store hours</Trans>
								</label>
								<WeeklyHoursEditor
									namePrefix="store"
									value={hoursBundle.store}
									onChange={(store) =>
										setHoursBundle((prev) => ({ ...prev, store }))
									}
								/>
								<label className="flex items-center gap-2 text-sm">
									<input
										type="checkbox"
										name="onlineHoursOverride"
										value="on"
										defaultChecked={location.onlineHoursOverride}
									/>
									<Trans>Override brand online hours</Trans>
								</label>
								<WeeklyHoursEditor
									namePrefix="online"
									value={hoursBundle.online}
									onChange={(online) =>
										setHoursBundle((prev) => ({ ...prev, online }))
									}
								/>
								<SpecialHoursEditor
									value={hoursBundle.special ?? []}
									onChange={(special) =>
										setHoursBundle((prev) => ({ ...prev, special }))
									}
								/>
								<Button type="submit" disabled={navigation.state !== 'idle'}>
									<Trans>Save hours</Trans>
								</Button>
							</Form>
						</AnnotatedSection>
					</AnnotatedLayout>
				</TabsContent>
				<TabsContent value="kitchen">
					<AnnotatedLayout>
						<AnnotatedSection
							title="Kitchen & fulfillment"
							description="Prep defaults and pickup. Delivery is enabled for all branches."
						>
							<Form method="post" className="flex flex-col gap-4">
								<input type="hidden" name="intent" value="kitchen" />
								<label className="space-y-1">
									<span className="text-sm font-medium">
										<Trans>Default prep time (minutes)</Trans>
									</span>
									<input
										name="prepTimeMinutes"
										type="number"
										defaultValue={location.prepTimeMinutes}
										min={1}
										max={180}
										className="border-input bg-background flex h-9 w-full rounded-md border px-3 text-sm"
									/>
								</label>
								<label className="space-y-1">
									<span className="text-sm font-medium">
										<Trans>Busy mode extra wait (minutes)</Trans>
									</span>
									<input
										name="busyDelayMinutes"
										type="number"
										defaultValue={location.busyDelayMinutes}
										min={0}
										max={120}
										className="border-input bg-background flex h-9 w-full rounded-md border px-3 text-sm"
									/>
								</label>
								<label className="space-y-1">
									<span className="text-sm font-medium">
										<Trans>Auto-accept window (seconds)</Trans>
									</span>
									<input
										name="acceptWindowSeconds"
										type="number"
										defaultValue={location.acceptWindowSeconds}
										min={0}
										max={600}
										className="border-input bg-background flex h-9 w-full rounded-md border px-3 text-sm"
									/>
								</label>
								<label className="flex items-center gap-2">
									<Switch
										name="pickupEnabled"
										defaultChecked={location.pickupEnabled}
									/>
									<span className="text-sm">
										<Trans>Pickup</Trans>
									</span>
								</label>
								<label className="flex items-center gap-2">
									<Switch
										name="scheduledOrdersEnabled"
										defaultChecked={location.scheduledOrdersEnabled}
									/>
									<span className="text-sm">
										<Trans>Scheduled orders</Trans>
									</span>
								</label>
								<p className="text-muted-foreground text-sm">
									<Trans>Delivery is enabled for this branch.</Trans>
								</p>
								<Button type="submit" disabled={navigation.state !== 'idle'}>
									<Trans>Save kitchen settings</Trans>
								</Button>
							</Form>
						</AnnotatedSection>
					</AnnotatedLayout>
				</TabsContent>
			</Tabs>
		</div>
	)
}
