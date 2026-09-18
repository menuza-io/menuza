import { describe, expect, it } from 'vitest'

import { shouldMockGoogleMapsGeocode } from './google-maps-mode.server.ts'

describe('shouldMockGoogleMapsGeocode', () => {
	it('is true when server API key is unset in typical local dev', () => {
		// Varlock ENV in test harness: empty GOOGLE_MAPS_SERVER_API_KEY → mock path
		expect(shouldMockGoogleMapsGeocode()).toBe(true)
	})
})
