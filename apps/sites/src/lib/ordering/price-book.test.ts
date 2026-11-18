import {
	priceRestaurantOrder,
	restaurantOrderContextSchema,
	restaurantOrderRequestSchema,
} from '@repo/common/restaurant-orders'
import { describe, expect, it } from 'vitest'
import {
	applyPriceBook,
	buildPriceBook,
	priceModeOf,
	repriceCartForMode,
} from './price-book.ts'
import { type CartItem, type OrderingCategory } from './types.ts'

/**
 * #412 and #388 on the website: the menu shows and the cart holds the price
 * for the order type, and the region charges exactly that. Soup is 10.00,
 * 12.00 for delivery and 9.00 at the table; bread is 1.00, 1.50 for delivery;
 * pasta has two sizes; a +10% round-up rule covers the mains category at loc-1.
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

const soup = {
	id: 'soup',
	displayName: 'Soup',
	price: 10,
	orderTypePrices: { delivery: 12, dine_in: 9 },
	availabilityStatus: 'available',
	variations: { groups: [], variants: [] },
	modifierGroups: [
		{
			id: 'extras',
			name: 'Extras',
			selectionType: 'multiple' as const,
			minSelections: 0,
			maxSelections: null,
			availabilityStatus: 'available',
			options: [
				{
					id: 'bread',
					displayName: 'Bread',
					price: 1,
					orderTypePrices: { delivery: 1.5 },
					availabilityStatus: 'available',
				},
			],
		},
	],
}
const pasta = {
	id: 'pasta',
	displayName: 'Pasta',
	price: 14,
	availabilityStatus: 'available',
	variations: {
		groups: [
			{
				id: 'size',
				name: 'Size',
				values: [
					{ id: 's', name: 'Small' },
					{ id: 'l', name: 'Large' },
				],
			},
		],
		variants: [
			{
				id: 'v-s',
				valueIds: ['s'],
				price: 14,
				availabilityStatus: 'available',
			},
			{
				id: 'v-l',
				valueIds: ['l'],
				price: 18,
				availabilityStatus: 'available',
			},
		],
	},
	modifierGroups: [],
}
const tea = {
	id: 'tea',
	displayName: 'Tea',
	price: 3,
	availabilityStatus: 'available',
	variations: { groups: [], variants: [] },
	modifierGroups: [],
}

function payload(extra: Record<string, unknown> = {}) {
	return {
		organization: { id: 'org', slug: 'org', currency: 'USD' },
		locations: [
			{
				id: 'loc-1',
				name: 'Main',
				timezone: 'UTC',
				taxRate: 0,
				prepTime: 15,
				currency: 'USD',
				fulfillmentOptions: {
					pickup: true,
					delivery: true,
					dineIn: true,
					curbside: false,
				},
				inHouseTips: {
					pickupTips: false,
					deliveryTips: false,
					dineInTips: false,
				},
				deliveryConfig: {
					providers: ['in_house'],
					estimatedDeliveryTimeMin: 30,
					estimatedDeliveryTimeMax: 60,
				},
				deliveryZones: [
					{
						id: 'z',
						name: 'Z',
						provider: 'in_house',
						restriction: 'allowed',
						type: 'zip_code',
						zipCodes: ['78701'],
						minimumOrder: 0,
						deliveryFee: 0,
						enabled: true,
					},
				],
				onlineHours: ALL_DAYS,
			},
		],
		menus: [
			{
				id: 'menu-1',
				displayName: 'Main',
				menuType: 'regular',
				specialInstructions: true,
				availabilityStatus: 'available',
				categories: [
					{
						id: 'mains',
						displayName: 'Mains',
						availabilityStatus: 'available',
						items: [soup, pasta],
					},
					{
						id: 'drinks',
						displayName: 'Drinks',
						availabilityStatus: 'available',
						items: [tea],
					},
				],
			},
		],
		locationOverrides: {},
		pricingRules: [
			{
				id: 'r',
				percentBp: 1000,
				allDishes: false,
				categoryIds: ['mains'],
				locationIds: ['loc-1'],
				rounding: { mode: 'decimals', decimals: 0 },
			},
		],
		...extra,
	}
}

const NOW = new Date('2026-03-10T12:00:00.000Z')

function pageCategories(): OrderingCategory[] {
	return structuredClone(
		payload().menus[0]!.categories,
	) as unknown as OrderingCategory[]
}

function line(itemId: string, extra: Partial<CartItem> = {}): CartItem {
	return {
		id: `l-${itemId}`,
		itemId,
		name: itemId,
		basePrice: 0,
		unitPrice: 0,
		quantity: 1,
		options: [],
		instructions: '',
		...extra,
	}
}

function regionUnitCents(
	mode: 'pickup' | 'delivery' | 'dine_in',
	lines: unknown[],
) {
	const context = restaurantOrderContextSchema.parse({
		orgId: 'org',
		dataRegion: 'us',
		menu: payload(),
		drop: null,
		onlinePayment: { enabled: false, processor: null },
	})
	const request = restaurantOrderRequestSchema.parse({
		idempotencyKey: '6f9d1d6e-3c3d-4d3f-9d4a-0d6a3a1b2c01',
		locale: 'en',
		locationId: 'loc-1',
		fulfillment: mode,
		paymentMethod: 'handoff',
		contact: { name: 'Guest', phone: '+1 555 123 4567' },
		tipPercent: 0,
		...(mode === 'delivery'
			? { delivery: { address: '1 Main St 78701', city: 'Austin' } }
			: {}),
		lines,
	})
	const priced = priceRestaurantOrder(context, request, { now: NOW })
	if (!priced.ok) throw new Error(priced.error.code)
	return priced.result.lines.map((entry) => entry.unitPriceCents)
}

describe('website price book', () => {
	it('lists only prices that differ, per order type', () => {
		const book = buildPriceBook(payload(), 'loc-1', NOW)
		// Soup: rule on 10 / 12 / 9 -> 11 / 14 (13.20 up) / 10 (9.90 up).
		expect(book.items.soup).toEqual({
			modes: { dine_in: 10, pickup: 11, delivery: 14 },
		})
		expect(book.items.pasta).toEqual({ variants: { 'v-s': 16, 'v-l': 20 } })
		expect(book.items.tea).toBeUndefined()
		expect(book.options['extras:bread']).toEqual({
			modes: { dine_in: 1, pickup: 1, delivery: 1.5 },
		})
		expect(buildPriceBook(payload(), null, NOW)).toEqual({
			items: {},
			options: {},
		})
	})

	it('shows the delivery price only for delivery', () => {
		const book = buildPriceBook(payload(), 'loc-1', NOW)
		const categories = pageCategories()
		applyPriceBook(categories, book, 'pickup')
		expect(categories[0]!.items[0]!.price).toBe(11)
		applyPriceBook(categories, book, 'delivery')
		expect(categories[0]!.items[0]!.price).toBe(14)
		expect(categories[0]!.items[0]!.modifierGroups[0]!.options[0]!.price).toBe(
			1.5,
		)
		// Variation dishes show the lowest resolved size.
		expect(categories[0]!.items[1]!.price).toBe(16)
		expect(categories[1]!.items[0]!.price).toBe(3)
	})

	it('reprices the cart when switched from delivery to pickup, and agrees with the region', () => {
		const book = buildPriceBook(payload(), 'loc-1', NOW)
		const cart = [
			line('soup', {
				basePrice: 14,
				unitPrice: 15.5,
				options: [
					{
						groupId: 'extras',
						groupName: 'Extras',
						optionId: 'bread',
						optionName: 'Bread',
						priceDelta: 1.5,
					},
				],
			}),
			line('pasta', { variantId: 'v-l', basePrice: 20, unitPrice: 20 }),
			line('tea', { basePrice: 3, unitPrice: 3 }),
		]
		const pickup = repriceCartForMode(cart, book, 'pickup')
		expect(pickup.changed).toBe(true)
		expect(pickup.lines.map((entry) => entry.unitPrice)).toEqual([12, 20, 3])
		// Unchanged lines keep their identity.
		expect(pickup.lines[2]).toBe(cart[2])
		const regionLines = [
			{
				itemId: 'soup',
				quantity: 1,
				options: [{ groupId: 'extras', optionId: 'bread' }],
			},
			{ itemId: 'pasta', variantId: 'v-l', quantity: 1, options: [] },
			{ itemId: 'tea', quantity: 1, options: [] },
		]
		for (const mode of ['pickup', 'delivery', 'dine_in'] as const) {
			const site = repriceCartForMode(cart, book, mode).lines.map((entry) =>
				Math.round(entry.unitPrice * 100),
			)
			expect(site).toEqual(regionUnitCents(mode, regionLines))
		}
		expect(repriceCartForMode(pickup.lines, book, 'pickup').changed).toBe(false)
	})

	it('keeps a fixed location price and falls back to the base price', () => {
		const book = buildPriceBook(
			payload({
				locationOverrides: {
					'loc-1': [{ entityType: 'item', entityId: 'soup', price: 8 }],
				},
				pricingRules: [],
			}) as never,
			'loc-1',
			NOW,
		)
		expect(book.items.soup).toEqual({
			modes: { dine_in: 8, pickup: 8, delivery: 8 },
		})
		const noTypes = buildPriceBook(
			payload({ pricingRules: [] }) as never,
			'loc-1',
			NOW,
		)
		expect(noTypes.items.tea).toBeUndefined()
	})

	it('prices a table order as dine-in', () => {
		expect(priceModeOf('pickup', true)).toBe('dine_in')
		expect(priceModeOf('delivery')).toBe('delivery')
		expect(priceModeOf('pickup')).toBe('pickup')
	})
})
