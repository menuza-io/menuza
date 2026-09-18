import { GOOGLE_MAPS_MOCK_PLACE } from '@repo/common/google-maps-mock'
import { ENV } from 'varlock/env'

import { shouldMockGoogleMapsGeocode } from '#app/utils/maps/google-maps-mode.server.ts'

export type GeocodeResult = {
	latitude: number
	longitude: number
	formattedAddress?: string
	googlePlaceId?: string
}

function buildAddressQuery(parts: {
	addressLine1?: string | null
	addressLine2?: string | null
	city?: string | null
	state?: string | null
	postalCode?: string | null
	country?: string | null
}) {
	return [
		parts.addressLine1,
		parts.addressLine2,
		parts.city,
		parts.state,
		parts.postalCode,
		parts.country ?? 'US',
	]
		.filter((part) => part && String(part).trim().length > 0)
		.join(', ')
}

export async function geocodeAddress(parts: {
	addressLine1?: string | null
	addressLine2?: string | null
	city?: string | null
	state?: string | null
	postalCode?: string | null
	country?: string | null
}): Promise<GeocodeResult | null> {
	const address = buildAddressQuery(parts)
	if (!address.trim()) return null

	if (shouldMockGoogleMapsGeocode()) {
		return {
			latitude: GOOGLE_MAPS_MOCK_PLACE.latitude,
			longitude: GOOGLE_MAPS_MOCK_PLACE.longitude,
			formattedAddress: address,
			googlePlaceId: GOOGLE_MAPS_MOCK_PLACE.googlePlaceId,
		}
	}

	const apiKey = ENV.GOOGLE_MAPS_SERVER_API_KEY?.trim()
	if (!apiKey) return null

	const url = new URL('https://maps.googleapis.com/maps/api/geocode/json')
	url.searchParams.set('address', address)
	url.searchParams.set('key', apiKey)

	const response = await fetch(url)
	if (!response.ok) return null

	const payload = (await response.json()) as {
		status?: string
		results?: Array<{
			formatted_address?: string
			place_id?: string
			geometry?: { location?: { lat?: number; lng?: number } }
		}>
	}

	const first = payload.results?.[0]
	const lat = first?.geometry?.location?.lat
	const lng = first?.geometry?.location?.lng
	if (payload.status !== 'OK' || lat == null || lng == null) return null

	return {
		latitude: lat,
		longitude: lng,
		formattedAddress: first?.formatted_address,
		googlePlaceId: first?.place_id,
	}
}
