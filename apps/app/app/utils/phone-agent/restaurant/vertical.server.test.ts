import { restaurantDataOf } from '@repo/phone-agent-restaurant'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildPublicSiteMenuPayload } from '#app/utils/menu/public-menu-context.server.ts'
import { isReservationsFeatureEnabled } from '#app/utils/reservations/access.server.ts'
import { restaurantServerVertical } from './vertical.server.ts'

vi.mock('#app/utils/reservations/access.server.ts', () => ({
	isReservationsFeatureEnabled: vi.fn(),
}))
vi.mock('#app/utils/menu/public-menu-context.server.ts', () => ({
	buildPublicSiteMenuPayload: vi.fn(async () => ({
		payload: {
			menus: [],
			locations: [
				{
					id: 'loc_1',
					name: 'Downtown',
					phone: null,
					timezone: 'America/New_York',
					currency: 'USD',
					isDefault: true,
					isActive: true,
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
				},
			],
		},
	})),
}))

const organization = (dataRegion: string) => ({
	id: 'org_1',
	name: 'Acme',
	slug: 'acme',
	siteDefaultLocale: 'en',
	siteLocales: 'en',
	dataRegion,
})

async function configFor(dataRegion: string) {
	const result = await restaurantServerVertical.configParts({
		organization: organization(dataRegion),
		scopeId: 'loc_1',
		settings: {} as never,
		now: new Date('2026-10-20T16:00:00Z'),
		strictScope: false,
	})
	if (!result.ok) throw new Error('expected a config')
	return result.parts
}

describe('restaurant config: table booking facts', () => {
	beforeEach(() => {
		vi.mocked(isReservationsFeatureEnabled).mockReset()
	})

	it('makes booking available for a US organization with reservations.voice on (VAL-VOICE-011)', async () => {
		vi.mocked(isReservationsFeatureEnabled).mockResolvedValue(true)
		const parts = await configFor('us')
		expect(isReservationsFeatureEnabled).toHaveBeenCalledWith('org_1', 'voice')
		expect(restaurantDataOf(parts).reservations).toEqual({ available: true })
		expect(
			restaurantServerVertical.advancedPageData!({
				vertical: parts.vertical,
			} as never),
		).toMatchObject({ reservationsAvailable: true })
	})

	it('hides it while the flag is off', async () => {
		vi.mocked(isReservationsFeatureEnabled).mockResolvedValue(false)
		const parts = await configFor('us')
		expect(restaurantDataOf(parts).reservations).toEqual({ available: false })
		expect(
			restaurantServerVertical.advancedPageData!({
				vertical: parts.vertical,
			} as never),
		).toMatchObject({ reservationsAvailable: false })
	})

	it('never offers it to a KSA organization, whatever the flags say (VAL-VOICE-012)', async () => {
		vi.mocked(isReservationsFeatureEnabled).mockResolvedValue(true)
		const parts = await configFor('ksa')
		expect(restaurantDataOf(parts).reservations).toEqual({ available: false })
		expect(isReservationsFeatureEnabled).not.toHaveBeenCalled()
	})

	it('carries no guest data in the facts', async () => {
		vi.mocked(isReservationsFeatureEnabled).mockResolvedValue(true)
		const parts = await configFor('us')
		expect(JSON.stringify(restaurantDataOf(parts).reservations)).toBe(
			'{"available":true}',
		)
	})

	it('has no booking toggle data without a config', () => {
		expect(restaurantServerVertical.advancedPageData!(null)).toEqual({
			categories: [],
			reservationsAvailable: false,
		})
	})

	it('requests the web channel menu and omits till-only dishes from phone agent facts (#220)', async () => {
		vi.mocked(isReservationsFeatureEnabled).mockResolvedValue(false)
		vi.mocked(buildPublicSiteMenuPayload).mockResolvedValueOnce({
			secondsUntilVariationReturn: null,
			payload: {
				locations: [
					{
						id: 'loc_1',
						name: 'Downtown',
						phone: null,
						timezone: 'America/New_York',
						currency: 'USD',
						isDefault: true,
						isActive: true,
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
					},
				],
				menus: [
					{
						id: 'm1',
						displayName: 'Dinner',
						availabilityStatus: 'available',
						categories: [
							{
								id: 'c1',
								displayName: 'Mains',
								description: null,
								upsellCategoryIds: [],
								availabilityStatus: 'available',
								items: [
									{
										id: 'web-item',
										displayName: 'Web Dish',
										description: null,
										price: 12,
										variations: { groups: [], variants: [] },
										isGlutenFree: false,
										isVegetarian: false,
										allergens: [],
										isPopular: false,
										isUpsell: false,
										availabilityStatus: 'available',
										channels: ['web', 'pos'],
										modifierGroups: [],
									},
									{
										id: 'till-only',
										displayName: 'Till Secret Dish',
										description: null,
										price: 9,
										variations: { groups: [], variants: [] },
										isGlutenFree: false,
										isVegetarian: false,
										allergens: [],
										isPopular: false,
										isUpsell: false,
										availabilityStatus: 'available',
										channels: ['pos'],
										modifierGroups: [],
									},
								],
							},
						],
					},
				],
			} as never,
		})
		const parts = await configFor('us')
		expect(buildPublicSiteMenuPayload).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'org_1' }),
			'loc_1',
			{ channel: 'web' },
		)
		const menuIds = restaurantDataOf(parts).menus.flatMap((m) =>
			m.categories.flatMap((c) => c.items.map((i) => i.id)),
		)
		expect(menuIds).toEqual(['web-item'])
	})
})
