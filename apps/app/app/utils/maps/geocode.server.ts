import { ENV } from 'varlock/env'

export type GeocodeResult = {
	latitude: number
	longitude: number
	formattedAddress?: string
	googlePlaceId?: string
}

const MOCK_COORDS: GeocodeResult = {
	latitude: 29.7604,
	longitude: -95.3698,
	formattedAddress: '123 Main St, Houston, TX 77002, USA',
	googlePlaceId: 'mock-place-houston',
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

	if (
		ENV.MOCK_GOOGLE_MAPS === true ||
		process.env.MOCK_GOOGLE_MAPS === 'true'
	) {
		return { ...MOCK_COORDS, formattedAddress: address }
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
