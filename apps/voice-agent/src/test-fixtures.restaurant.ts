import {
	defaultSettingsFor,
	type PhoneAgentRuntimeConfig,
} from '@repo/phone-agent'
import {
	type AgentLocation,
	type AgentMenu,
	restaurantConfigParts,
	restaurantVertical,
} from '@repo/phone-agent-restaurant'
import { baseConfig } from './test-fixtures.ts'

export function testLocation(): AgentLocation {
	return {
		id: 'loc_1',
		name: 'Downtown',
		phone: '(555) 234-5678',
		timezone: 'America/New_York',
		taxRate: 0,
		address: null,
		storeHours: [],
		onlineHours: [],
		specialHours: [],
		prepTime: 15,
		fulfillmentOptions: {
			pickup: true,
			delivery: false,
			dineIn: false,
			curbside: false,
		},
		deliveryConfig: {
			estimatedDeliveryTimeMin: 30,
			estimatedDeliveryTimeMax: 45,
		},
		deliveryZones: [],
	}
}

/**
 * A restaurant config for the "Luigi" Downtown location, with no menus unless
 * given.
 */
export function restaurantTestConfig(
	overrides: Partial<PhoneAgentRuntimeConfig['settings']> = {},
	{ menus = [] as AgentMenu[] } = {},
): PhoneAgentRuntimeConfig {
	const base = baseConfig({
		...defaultSettingsFor(restaurantVertical),
		enabled: true,
		recordCalls: true,
		...overrides,
	})
	return {
		...base,
		organization: { ...base.organization, name: 'Luigi', slug: 'luigi' },
		...restaurantConfigParts({
			businessName: 'Luigi',
			location: testLocation(),
			menus,
		}),
	}
}
