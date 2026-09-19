'use client'

import { Trans } from '@lingui/macro'
import { AnnotatedLayout, AnnotatedSection } from '@repo/ui/annotated-layout'
import { Button } from '@repo/ui/button'
import { PageTitle } from '@repo/ui/page-title'
import { useState } from 'react'
import { Form, Link, useLoaderData, useNavigation } from 'react-router'

import {
	AddressAutocompleteField,
	type AddressFieldValues,
} from '#app/components/locations/address-autocomplete-field.tsx'
import { LocationMap } from '#app/components/locations/location-map.tsx'
import { TimezoneSelectField } from '#app/components/locations/timezone-select-field.tsx'

import { type loader } from './new.tsx'

export default function NewRestaurantLocationPage() {
	const { googleMapsApiKey, googleMapsMode } = useLoaderData<typeof loader>()
	const navigation = useNavigation()
	const [address, setAddress] = useState<AddressFieldValues>({
		addressLine1: '',
		addressLine2: '',
		city: '',
		state: '',
		postalCode: '',
		country: 'US',
		formattedAddress: '',
		googlePlaceId: '',
		latitude: '',
		longitude: '',
	})

	const lat = address.latitude ? Number(address.latitude) : null
	const lng = address.longitude ? Number(address.longitude) : null

	return (
		<div className="mx-auto flex h-full w-full max-w-4xl flex-col gap-6 py-8 md:px-6 lg:px-8">
			<PageTitle
				title="Add location"
				description="Create a new restaurant branch with a verified address."
			/>
			<AnnotatedLayout>
				<AnnotatedSection
					title="Details"
					description="Restaurant branch profile and address."
				>
					<Form method="post" className="flex flex-col gap-6">
						<div className="grid gap-4 md:grid-cols-2">
							<label className="space-y-1 md:col-span-2">
								<span className="text-sm font-medium">
									<Trans>Location name</Trans>
								</span>
								<input
									name="name"
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
									required
									className="border-input bg-background flex h-9 w-full rounded-md border px-3 text-sm"
								/>
							</label>
							<TimezoneSelectField
								name="timezone"
								defaultValue="America/Chicago"
								required
							/>
							<label className="space-y-1">
								<span className="text-sm font-medium">
									<Trans>Prep time (minutes)</Trans>
								</span>
								<input
									name="prepTimeMinutes"
									type="number"
									defaultValue={15}
									min={1}
									max={180}
									className="border-input bg-background flex h-9 w-full rounded-md border px-3 text-sm"
								/>
							</label>
						</div>
						<AddressAutocompleteField
							mapsMode={googleMapsMode}
							googleMapsApiKey={googleMapsApiKey}
							values={address}
							onChange={setAddress}
						/>
						<LocationMap
							mapsMode={googleMapsMode}
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
						<label className="flex items-center gap-2 text-sm">
							<input type="checkbox" name="active" value="on" />
							<Trans>Active (requires map pin)</Trans>
						</label>
						<div className="flex gap-3">
							<Button type="submit" disabled={navigation.state !== 'idle'}>
								<Trans>Save location</Trans>
							</Button>
							<Button
								variant="outline"
								render={<Link to={`..`} relative="path" />}
							>
								<Trans>Cancel</Trans>
							</Button>
						</div>
					</Form>
				</AnnotatedSection>
			</AnnotatedLayout>
		</div>
	)
}
