'use client'

import { Trans } from '@lingui/macro'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { useEffect, useRef, useState } from 'react'

export type AddressFieldValues = {
	addressLine1: string
	addressLine2: string
	city: string
	state: string
	postalCode: string
	country: string
	formattedAddress: string
	googlePlaceId: string
	latitude: string
	longitude: string
}

type AddressAutocompleteFieldProps = {
	googleMapsApiKey?: string | null
	values: AddressFieldValues
	onChange: (values: AddressFieldValues) => void
}

export function AddressAutocompleteField({
	googleMapsApiKey,
	values,
	onChange,
}: AddressAutocompleteFieldProps) {
	const searchRef = useRef<HTMLInputElement>(null)
	const [mapsReady, setMapsReady] = useState(false)

	useEffect(() => {
		if (!googleMapsApiKey?.trim()) return
		const scriptId = 'google-maps-places'
		if (document.getElementById(scriptId)) {
			setMapsReady(true)
			return
		}
		const script = document.createElement('script')
		script.id = scriptId
		script.async = true
		script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(
			googleMapsApiKey,
		)}&libraries=places`
		script.onload = () => setMapsReady(true)
		document.head.appendChild(script)
	}, [googleMapsApiKey])

	useEffect(() => {
		if (!mapsReady || !searchRef.current || !googleMapsApiKey) return
		const google = (window as typeof window & { google?: any }).google
		if (!google?.maps?.places) return

		const autocomplete = new google.maps.places.Autocomplete(
			searchRef.current,
			{
				componentRestrictions: { country: 'us' },
				fields: [
					'address_components',
					'formatted_address',
					'geometry',
					'place_id',
				],
			},
		)

		autocomplete.addListener('place_changed', () => {
			const place = autocomplete.getPlace()
			if (!place?.address_components) return

			const component = (type: string) =>
				place.address_components?.find((c: { types: string[] }) =>
					c.types.includes(type),
				)

			const streetNumber = component('street_number')?.long_name ?? ''
			const route = component('route')?.long_name ?? ''
			const city =
				component('locality')?.long_name ??
				component('sublocality')?.long_name ??
				''
			const state = component('administrative_area_level_1')?.short_name ?? ''
			const postalCode = component('postal_code')?.long_name ?? ''
			const lat = place.geometry?.location?.lat?.()
			const lng = place.geometry?.location?.lng?.()

			onChange({
				...values,
				addressLine1: [streetNumber, route].filter(Boolean).join(' '),
				city,
				state,
				postalCode,
				country: 'US',
				formattedAddress: place.formatted_address ?? '',
				googlePlaceId: place.place_id ?? '',
				latitude: lat != null ? String(lat) : '',
				longitude: lng != null ? String(lng) : '',
			})
		})
	}, [mapsReady, googleMapsApiKey, onChange, values])

	const update = (patch: Partial<AddressFieldValues>) =>
		onChange({ ...values, ...patch })

	return (
		<div className="flex flex-col gap-4">
			{!googleMapsApiKey?.trim() ? (
				<p className="text-muted-foreground rounded-lg border p-3 text-sm">
					<Trans>
						Add PUBLIC_GOOGLE_MAPS_API_KEY for address autocomplete and map pin.
						You can still enter an address manually; saving will geocode on the
						server when possible.
					</Trans>
				</p>
			) : (
				<div className="space-y-1">
					<Label htmlFor="address-search">
						<Trans>Search address</Trans>
					</Label>
					<Input
						id="address-search"
						ref={searchRef}
						placeholder="Start typing your restaurant address"
						autoComplete="off"
					/>
				</div>
			)}
			<div className="grid gap-3 md:grid-cols-2">
				<div className="space-y-1 md:col-span-2">
					<Label htmlFor="addressLine1">
						<Trans>Street address</Trans>
					</Label>
					<Input
						id="addressLine1"
						name="addressLine1"
						value={values.addressLine1}
						onChange={(e) => update({ addressLine1: e.target.value })}
						required
					/>
				</div>
				<div className="space-y-1 md:col-span-2">
					<Label htmlFor="addressLine2">
						<Trans>Suite / unit</Trans>
					</Label>
					<Input
						id="addressLine2"
						name="addressLine2"
						value={values.addressLine2}
						onChange={(e) => update({ addressLine2: e.target.value })}
					/>
				</div>
				<div className="space-y-1">
					<Label htmlFor="city">
						<Trans>City</Trans>
					</Label>
					<Input
						id="city"
						name="city"
						value={values.city}
						onChange={(e) => update({ city: e.target.value })}
						required
					/>
				</div>
				<div className="space-y-1">
					<Label htmlFor="state">
						<Trans>State</Trans>
					</Label>
					<Input
						id="state"
						name="state"
						value={values.state}
						onChange={(e) => update({ state: e.target.value })}
						required
					/>
				</div>
				<div className="space-y-1">
					<Label htmlFor="postalCode">
						<Trans>ZIP code</Trans>
					</Label>
					<Input
						id="postalCode"
						name="postalCode"
						value={values.postalCode}
						onChange={(e) => update({ postalCode: e.target.value })}
						required
					/>
				</div>
			</div>
			<input type="hidden" name="country" value={values.country || 'US'} />
			<input
				type="hidden"
				name="formattedAddress"
				value={values.formattedAddress}
			/>
			<input type="hidden" name="googlePlaceId" value={values.googlePlaceId} />
			<input type="hidden" name="latitude" value={values.latitude} />
			<input type="hidden" name="longitude" value={values.longitude} />
		</div>
	)
}
