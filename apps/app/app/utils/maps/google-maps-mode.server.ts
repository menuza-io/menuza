import { type GoogleMapsClientMode } from '@repo/common/google-maps-mock'
import { ENV } from 'varlock/env'

export type { GoogleMapsClientMode }

/** Browser Maps JS + Places: mock when no referrer key (local dev). */
export function getGoogleMapsClientMode(): GoogleMapsClientMode {
	const key = ENV.PUBLIC_GOOGLE_MAPS_API_KEY?.trim()
	return key ? 'live' : 'mock'
}

/** Server geocode: mock when no server key or explicit dev mocks (see MOCKS). */
export function shouldMockGoogleMapsGeocode(): boolean {
	if (ENV.MOCK_GOOGLE_MAPS === true) return true
	if (process.env.MOCKS === 'true') return true
	return !ENV.GOOGLE_MAPS_SERVER_API_KEY?.trim()
}
