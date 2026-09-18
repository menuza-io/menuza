import { describe, expect, it } from 'vitest'

import { assertLocationHasCoordinates } from './locations.server.ts'

describe('assertLocationHasCoordinates', () => {
	it('allows inactive locations without coordinates', () => {
		expect(() =>
			assertLocationHasCoordinates({
				active: false,
				deliveryEnabled: true,
				latitude: null,
				longitude: null,
			}),
		).not.toThrow()
	})

	it('rejects active locations without coordinates', () => {
		expect(() =>
			assertLocationHasCoordinates({
				active: true,
				deliveryEnabled: true,
				latitude: null,
				longitude: null,
			}),
		).toThrow(/map pin/)
	})

	it('accepts active locations with valid coordinates', () => {
		expect(() =>
			assertLocationHasCoordinates({
				active: true,
				deliveryEnabled: true,
				latitude: 29.76,
				longitude: -95.36,
			}),
		).not.toThrow()
	})
})
