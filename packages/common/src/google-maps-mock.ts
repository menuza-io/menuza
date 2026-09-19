export type GoogleMapsClientMode = 'live' | 'mock'

/** Shared fixture for local dev / MOCKS when Google Maps keys are unset. */
export const GOOGLE_MAPS_MOCK_PLACE = {
	addressLine1: '123 Main St',
	addressLine2: '',
	city: 'Houston',
	state: 'TX',
	postalCode: '77002',
	country: 'US',
	formattedAddress: '123 Main St, Houston, TX 77002, USA',
	googlePlaceId: 'mock-place-houston',
	latitude: 29.7604,
	longitude: -95.3698,
} as const

export function googleMapsMockAddressFields() {
	return {
		addressLine1: GOOGLE_MAPS_MOCK_PLACE.addressLine1,
		addressLine2: GOOGLE_MAPS_MOCK_PLACE.addressLine2,
		city: GOOGLE_MAPS_MOCK_PLACE.city,
		state: GOOGLE_MAPS_MOCK_PLACE.state,
		postalCode: GOOGLE_MAPS_MOCK_PLACE.postalCode,
		country: GOOGLE_MAPS_MOCK_PLACE.country,
		formattedAddress: GOOGLE_MAPS_MOCK_PLACE.formattedAddress,
		googlePlaceId: GOOGLE_MAPS_MOCK_PLACE.googlePlaceId,
		latitude: String(GOOGLE_MAPS_MOCK_PLACE.latitude),
		longitude: String(GOOGLE_MAPS_MOCK_PLACE.longitude),
	}
}
