import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import { geocodeAddress } from './geocode.server.ts'

describe('geocodeAddress', () => {
	const originalFetch = globalThis.fetch

	beforeEach(() => {
		process.env.MOCK_GOOGLE_MAPS = 'false'
		delete process.env.GOOGLE_MAPS_SERVER_API_KEY
	})

	afterEach(() => {
		globalThis.fetch = originalFetch
		vi.restoreAllMocks()
	})

	it('returns null when no server key and mocks disabled', async () => {
		const result = await geocodeAddress({
			addressLine1: '123 Main St',
			city: 'Houston',
			state: 'TX',
			postalCode: '77002',
		})
		expect(result).toBeNull()
	})

	it('uses mock coordinates when MOCK_GOOGLE_MAPS is true', async () => {
		process.env.MOCK_GOOGLE_MAPS = 'true'
		const result = await geocodeAddress({
			addressLine1: '123 Main St',
			city: 'Houston',
			state: 'TX',
			postalCode: '77002',
		})
		expect(result?.latitude).toBe(29.7604)
		expect(result?.longitude).toBe(-95.3698)
	})
})
