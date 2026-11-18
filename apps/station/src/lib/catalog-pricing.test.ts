import {
	priceRestaurantOrder,
	restaurantOrderContextSchema,
	restaurantOrderRequestSchema,
} from '@repo/common/restaurant-orders'
import { describe, expect, it } from 'vitest'
import { buildCategories, categoryItems } from './catalog.ts'
import { buildLine, repriceLinesFor } from './item-config.ts'
import { type MenuPayload } from './types.ts'

/**
 * #412 and #388 at the till: Station prices with the resolver the server
 * reviews the sale with. Soup is 10.00 (9.00 dine-in, 12.00 delivery); bread
 * is 1.00 (0.50 dine-in); a +10% rule rounds the mains up to whole units; tea
 * has a fixed 2.50 at this location, so the rule leaves it alone.
 */

const ALL_DAYS = [
	'sunday',
	'monday',
	'tuesday',
	'wednesday',
	'thursday',
	'friday',
	'saturday',
].map((day) => ({
	day,
	isOpen: true,
	slots: [{ start: '00:00', end: '23:59' }],
}))

function menu(): MenuPayload {
	return {
		organization: {
			id: 'org',
			name: 'Org',
			slug: 'org',
			currency: 'USD',
			defaultLocale: 'en',
		},
		locations: [
			{
				id: 'loc-1',
				name: 'Main',
				timezone: 'UTC',
				taxRate: 0,
				currency: 'USD',
				isDefault: true,
				phone: null,
				onlineHours: ALL_DAYS,
			} as never,
		],
		menus: [
			{
				id: 'm',
				displayName: 'Main',
				menuType: 'regular',
				availabilityStatus: 'available',
				position: 0,
				categories: [
					{
						id: 'mains',
						displayName: 'Mains',
						availabilityStatus: 'available',
						position: 0,
						items: [
							{
								id: 'soup',
								displayName: 'Soup',
								description: null,
								price: 10,
								orderTypePrices: { dine_in: 9, delivery: 12 },
								imageUrl: null,
								variations: { groups: [], variants: [] },
								isVegetarian: false,
								isGlutenFree: false,
								isAlcohol: false,
								dietaryTags: ['halal'],
								allergens: [],
								isPopular: false,
								availabilityStatus: 'available',
								position: 0,
								modifierGroups: [
									{
										id: 'extras',
										name: 'Extras',
										selectionType: 'multiple',
										minSelections: 0,
										maxSelections: null,
										availabilityStatus: 'available',
										position: 0,
										options: [
											{
												id: 'bread',
												displayName: 'Bread',
												price: 1,
												orderTypePrices: { dine_in: 0.5 },
												minSelections: 0,
												maxSelections: null,
												isDefault: false,
												applySalesTax: true,
												availabilityStatus: 'available',
												position: 0,
											},
										],
									},
								],
							},
						],
					},
					{
						id: 'drinks',
						displayName: 'Drinks',
						availabilityStatus: 'available',
						position: 1,
						items: [
							{
								id: 'tea',
								displayName: 'Tea',
								description: null,
								price: 3,
								imageUrl: null,
								variations: { groups: [], variants: [] },
								isVegetarian: false,
								isGlutenFree: false,
								isAlcohol: false,
								allergens: [],
								isPopular: false,
								availabilityStatus: 'available',
								position: 0,
								modifierGroups: [],
							},
						],
					},
				],
			},
		],
		locationOverrides: {
			'loc-1': [{ entityType: 'item', entityId: 'tea', price: 2.5 }],
		},
		pricingRules: [
			{
				id: 'r',
				percentBp: 1000,
				allDishes: true,
				categoryIds: [],
				locationIds: [],
				rounding: { mode: 'decimals', decimals: 0 },
			},
		],
	} as MenuPayload
}

const NOW = new Date('2026-03-10T12:00:00.000Z')

function itemOf(type: 'dine_in' | 'pickup', id: string) {
	const items = buildCategories(menu(), 'loc-1', type, NOW).flatMap(
		categoryItems,
	)
	return items.find((item) => item.id === id)!
}

describe('till prices by order type', () => {
	it('prices dine-in and takeaway differently, with rules and fixed prices', () => {
		// Soup: 9 + 10% = 9.90 -> 10 dine-in; 10 + 10% = 11 takeaway.
		expect(itemOf('dine_in', 'soup').price).toBe(10)
		expect(itemOf('pickup', 'soup').price).toBe(11)
		expect(itemOf('dine_in', 'soup').modifierGroups[0]!.options[0]!.price).toBe(
			0.5,
		)
		// Tea keeps its fixed location price, untouched by the rule.
		expect(itemOf('dine_in', 'tea').price).toBe(2.5)
	})

	it('reprices the bill when the cashier switches dine-in to takeaway', () => {
		const soup = itemOf('dine_in', 'soup')
		const line = {
			id: 'l1',
			...buildLine(soup, {}, { extras: { bread: 1 } }, 1, ''),
		}
		expect(line.baseCents).toBe(1000)
		expect(line.options[0]!.unitCents).toBe(50)
		const takeaway = buildCategories(menu(), 'loc-1', 'pickup', NOW)
		const [repriced] = repriceLinesFor([line], takeaway)
		expect(repriced!.baseCents).toBe(1100)
		expect(repriced!.options[0]!.unitCents).toBe(100)
		// A line already right is left as it is.
		expect(repriceLinesFor([repriced!], takeaway)[0]).toBe(repriced)
	})

	it('matches the price the server reviews the sale with', () => {
		const context = restaurantOrderContextSchema.parse({
			orgId: 'org',
			dataRegion: 'us',
			menu: menu(),
			drop: null,
			onlinePayment: { enabled: false, processor: null },
		})
		const request = restaurantOrderRequestSchema.parse({
			idempotencyKey: '6f9d1d6e-3c3d-4d3f-9d4a-0d6a3a1b2c01',
			locale: 'en',
			locationId: 'loc-1',
			fulfillment: 'pickup',
			paymentMethod: 'handoff',
			contact: { name: 'Walk-in', phone: '+10000000000' },
			tipPercent: 0,
			lines: [
				{
					itemId: 'soup',
					quantity: 1,
					options: [{ groupId: 'extras', optionId: 'bread' }],
				},
				{ itemId: 'tea', quantity: 1, options: [] },
			],
		})
		for (const type of ['dine_in', 'pickup'] as const) {
			const server = priceRestaurantOrder(context, request, {
				now: NOW,
				walkIn: true,
				priceAs: type,
			})
			if (!server.ok) throw new Error(server.error.code)
			const soup = itemOf(type, 'soup')
			const tea = itemOf(type, 'tea')
			const till = [
				Math.round(soup.price * 100) +
					Math.round(soup.modifierGroups[0]!.options[0]!.price * 100),
				Math.round(tea.price * 100),
			]
			expect(till).toEqual(
				server.result.lines.map((line) => line.unitPriceCents),
			)
		}
	})
})
