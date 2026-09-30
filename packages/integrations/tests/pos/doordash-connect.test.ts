import { describe, expect, it } from 'vitest'
import { buildDoorDashIntegrationConfig } from '../../src/pos/doordash-connect.ts'

describe('DoorDash store link', () => {
	it('persists Menuza location as partner store id and DoorDash id as merchantId', () => {
		const config = buildDoorDashIntegrationConfig({
			menuzaLocationId: 'loc_menuza_abc',
			doorDashStoreId: 'f1c7f43b-64ca-4586-b990-171aaafbca2d',
		})
		expect(config.environment).toBe('live')
		expect(config.merchantId).toBe('f1c7f43b-64ca-4586-b990-171aaafbca2d')
		expect(config.locationId).toBe('loc_menuza_abc')
		expect(config.metadata.partnerStoreId).toBe('loc_menuza_abc')
		expect(config.metadata.doorDashStoreId).toBe(
			'f1c7f43b-64ca-4586-b990-171aaafbca2d',
		)
	})
})
