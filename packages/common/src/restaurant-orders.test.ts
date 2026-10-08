import { describe, expect, it } from 'vitest'

import {
	buildPublicOrderingOptions,
	canonicalOrderRequest,
	extractPostalCode,
	priceRestaurantOrder,
	restaurantOrderContextSchema,
	restaurantOrderRequestSchema,
	type RestaurantOrderContext,
	type RestaurantOrderRequest,
} from './restaurant-orders.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORG_ID = 'org_test_1'
const LOCATION_ID = 'loc-1'
const NOW = new Date('2025-06-15T16:00:00.000Z') // Sunday 16:00 UTC

const EVERY_DAY_HOURS = [
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

function makeLocation(overrides: Record<string, unknown> = {}) {
	return {
		id: LOCATION_ID,
		name: 'Main Street',
		timezone: 'UTC',
		taxRate: 8.25,
		prepTime: 15,
		currency: 'USD',
		fulfillmentOptions: {
			pickup: true,
			delivery: true,
			dineIn: true,
			curbside: false,
		},
		inHouseTips: { pickupTips: true, deliveryTips: true, dineInTips: true },
		deliveryConfig: {
			providers: ['in_house'],
			estimatedDeliveryTimeMin: 30,
			estimatedDeliveryTimeMax: 60,
		},
		deliveryZones: [
			{
				id: 'zone-1',
				name: 'Downtown',
				provider: 'in_house',
				restriction: 'allowed',
				type: 'zip_code',
				zipCodes: ['78701'],
				minimumOrder: 15,
				deliveryFee: 4.5,
				enabled: true,
			},
		],
		onlineHours: EVERY_DAY_HOURS,
		...overrides,
	}
}

const burger = {
	id: 'item-burger',
	displayName: 'Burger',
	price: 10,
	availabilityStatus: 'available',
	modifierGroups: [
		{
			id: 'grp-size',
			name: 'Size',
			selectionType: 'single',
			minSelections: 1,
			availabilityStatus: 'available',
			options: [
				{
					id: 'opt-reg',
					displayName: 'Regular',
					price: 0,
					availabilityStatus: 'available',
				},
				{
					id: 'opt-large',
					displayName: 'Large',
					price: 3,
					availabilityStatus: 'available',
				},
			],
		},
		{
			id: 'grp-toppings',
			name: 'Toppings',
			selectionType: 'multiple',
			minSelections: 0,
			maxSelections: 2,
			availabilityStatus: 'available',
			options: [
				{
					id: 'opt-cheese',
					displayName: 'Cheese',
					price: 1,
					availabilityStatus: 'available',
				},
				{
					id: 'opt-bacon',
					displayName: 'Bacon',
					price: 2,
					applySalesTax: false,
					availabilityStatus: 'available',
				},
				{
					id: 'opt-jalapeno',
					displayName: 'Jalapeno',
					price: 0.5,
					availabilityStatus: 'available',
				},
			],
		},
		{
			id: 'grp-drinks',
			name: 'Drinks',
			selectionType: 'quantity',
			minSelections: 0,
			maxSelections: 4,
			availabilityStatus: 'available',
			options: [
				{
					id: 'opt-cola',
					displayName: 'Cola',
					price: 2,
					availabilityStatus: 'available',
				},
			],
		},
	],
}

const latte = {
	id: 'item-latte',
	displayName: 'Latte',
	price: 4,
	availabilityStatus: 'available',
	variations: {
		groups: [
			{
				id: 'vg-size',
				name: 'Size',
				values: [
					{ id: 'v-small', name: 'Small' },
					{ id: 'v-large', name: 'Large' },
				],
			},
		],
		variants: [
			{
				id: 'var-small',
				valueIds: ['v-small'],
				price: 4,
				availabilityStatus: 'available',
			},
			{
				id: 'var-large',
				valueIds: ['v-large'],
				price: 5.5,
				availabilityStatus: 'available',
			},
		],
	},
}

const pizza = {
	id: 'item-pizza',
	displayName: 'Pizza',
	price: 12,
	availabilityStatus: 'available',
	modifierGroups: [
		{
			id: 'grp-pizza-toppings',
			name: 'Pizza Toppings',
			selectionType: 'pizza',
			minSelections: 0,
			availabilityStatus: 'available',
			options: [
				{
					id: 'opt-pep',
					displayName: 'Pepperoni',
					price: 2,
					priceWhole: 2,
					priceLeft: 1.25,
					priceRight: 1.25,
					availabilityStatus: 'available',
				},
			],
		},
	],
}

const sandwich = {
	id: 'item-sandwich',
	displayName: 'Sandwich',
	price: 8,
	availabilityStatus: 'available',
	modifierGroups: [
		{
			id: 'grp-bread',
			name: 'Bread',
			selectionType: 'single',
			minSelections: 1,
			availabilityStatus: 'available',
			options: [
				{
					id: 'opt-white',
					displayName: 'White',
					price: 0,
					availabilityStatus: 'available',
				},
				{
					id: 'opt-toasted',
					displayName: 'Toasted',
					price: 0.5,
					availabilityStatus: 'available',
					nestedModifierGroups: [
						{
							id: 'grp-toast-level',
							name: 'Toast level',
							selectionType: 'single',
							minSelections: 1,
							availabilityStatus: 'available',
							options: [
								{
									id: 'opt-light',
									displayName: 'Light',
									price: 0,
									availabilityStatus: 'available',
								},
								{
									id: 'opt-dark',
									displayName: 'Dark',
									price: 0,
									availabilityStatus: 'available',
								},
							],
						},
					],
				},
			],
		},
	],
}

const brisket = {
	id: 'item-brisket',
	displayName: 'Brisket Plate',
	price: 18,
	availabilityStatus: 'available',
}

const ribs = {
	id: 'item-ribs',
	displayName: 'Ribs',
	price: 15,
	availabilityStatus: 'available',
}

function makeMenu(items: unknown[] = [burger, latte, pizza, sandwich]) {
	return {
		organization: { id: ORG_ID, slug: 'test-org', currency: 'USD' },
		locations: [makeLocation()],
		menus: [
			{
				id: 'menu-1',
				displayName: 'Main Menu',
				menuType: 'regular',
				specialInstructions: true,
				availabilityStatus: 'available',
				categories: [
					{
						id: 'cat-food',
						displayName: 'Food',
						availabilityStatus: 'available',
						items,
					},
				],
			},
		],
		locationOverrides: {},
	}
}

function makeDrop(overrides: Record<string, unknown> = {}) {
	return {
		organization: { id: ORG_ID, slug: 'test-org', currency: 'USD' },
		drop: {
			id: 'drop-1',
			title: 'Friday BBQ',
			slug: 'friday-bbq',
			status: 'live',
			ordersOpenAt: '2025-06-01T00:00:00.000Z',
			ordersCloseAt: '2025-06-20T22:00:00.000Z',
			checkoutHoldMinutes: 10,
			menu: {
				id: 'menu-drop',
				displayName: 'BBQ',
				specialInstructions: true,
			},
		},
		pickupWindows: [
			{
				id: 'win-1',
				locationId: LOCATION_ID,
				location: { id: LOCATION_ID, name: 'Main Street', timezone: 'UTC' },
				date: '2025-06-20',
				startTime: '17:00',
				endTime: '19:00',
				slotIntervalMinutes: 30,
				maxOrdersPerSlot: 2,
				orderLeadTimeMinutes: 30,
				slots: [],
			},
		],
		inventoryOverrides: [
			{
				entityType: 'item',
				entityId: 'item-brisket',
				inventory: 5,
				maxPerOrder: 3,
				maxPerPickupSlot: 2,
			},
			{
				entityType: 'category',
				entityId: 'cat-bbq',
				inventory: 10,
				maxPerOrder: 4,
			},
		],
		categories: [
			{
				id: 'cat-bbq',
				displayName: 'BBQ',
				availabilityStatus: 'available',
				items: [brisket, ribs],
			},
		],
		...overrides,
	}
}

function makeContext(
	overrides: {
		menu?: ReturnType<typeof makeMenu>
		drop?: ReturnType<typeof makeDrop> | null
		onlinePayment?: {
			enabled: boolean
			processor: 'connect' | 'checkout' | null
		}
	} = {},
): RestaurantOrderContext {
	return restaurantOrderContextSchema.parse({
		orgId: ORG_ID,
		dataRegion: 'us',
		menu: overrides.menu ?? makeMenu(),
		drop: overrides.drop === undefined ? null : overrides.drop,
		onlinePayment: overrides.onlinePayment ?? {
			enabled: true,
			processor: 'connect',
		},
	})
}

function rawRequest(overrides: Record<string, unknown> = {}) {
	return {
		idempotencyKey: '6f9d1d6e-3c3d-4d3f-9d4a-0d6a3a1b2c01',
		locale: 'en',
		locationId: LOCATION_ID,
		fulfillment: 'pickup',
		paymentMethod: 'handoff',
		contact: { name: 'Test Person', phone: '+1 555 123 4567' },
		tipPercent: 0,
		lines: [
			{
				itemId: 'item-burger',
				quantity: 2,
				options: [{ groupId: 'grp-size', optionId: 'opt-reg' }],
			},
		],
		...overrides,
	}
}

function makeRequest(
	overrides: Record<string, unknown> = {},
): RestaurantOrderRequest {
	return restaurantOrderRequestSchema.parse(rawRequest(overrides))
}

// ---------------------------------------------------------------------------
// Request schema: browser-supplied prices and unknown fields are rejected
// ---------------------------------------------------------------------------

describe('restaurantOrderRequestSchema', () => {
	it('rejects browser-supplied prices on lines (strict object)', () => {
		const parsed = restaurantOrderRequestSchema.safeParse({
			...makeRequest(),
			lines: [
				{
					itemId: 'item-burger',
					quantity: 1,
					price: 0.01,
					unitPriceCents: 1,
					options: [],
				},
			],
		})
		expect(parsed.success).toBe(false)
	})

	it('rejects browser-supplied totals at the top level', () => {
		const parsed = restaurantOrderRequestSchema.safeParse({
			...makeRequest(),
			subtotalCents: 1,
			totalCents: 1,
		})
		expect(parsed.success).toBe(false)
	})

	it('rejects a browser-supplied customerId', () => {
		const parsed = restaurantOrderRequestSchema.safeParse({
			...makeRequest(),
			customerId: 'cust_123',
		})
		expect(parsed.success).toBe(false)
	})

	it('rejects non-UUID idempotency keys', () => {
		const parsed = restaurantOrderRequestSchema.safeParse({
			...makeRequest(),
			idempotencyKey: 'not-a-uuid',
		})
		expect(parsed.success).toBe(false)
	})

	it('rejects delivery orders without an address and pickup orders with one', () => {
		expect(
			restaurantOrderRequestSchema.safeParse(
				rawRequest({ fulfillment: 'delivery' }),
			).success,
		).toBe(false)
		expect(
			restaurantOrderRequestSchema.safeParse(
				rawRequest({
					fulfillment: 'pickup',
					delivery: { address: '100 Congress Ave 78701', city: 'Austin' },
				}),
			).success,
		).toBe(false)
	})

	it('rejects tips above 30% and caps absurd quantities', () => {
		expect(
			restaurantOrderRequestSchema.safeParse(rawRequest({ tipPercent: 31 }))
				.success,
		).toBe(false)
		expect(
			restaurantOrderRequestSchema.safeParse(
				rawRequest({
					lines: [{ itemId: 'item-burger', quantity: 51, options: [] }],
				}),
			).success,
		).toBe(false)
	})

	it('normalizes phone punctuation', () => {
		const parsed = restaurantOrderRequestSchema.parse(
			makeRequest({ contact: { name: 'A', phone: '+1 (555) 123-4567' } }),
		)
		expect(parsed.contact.phone).toBe('+15551234567')
	})
})

// ---------------------------------------------------------------------------
// Server-side repricing: every cent comes from the catalog
// ---------------------------------------------------------------------------

describe('priceRestaurantOrder: repricing', () => {
	it('derives subtotal, percent tax, tip, and total in integer cents', () => {
		const result = priceRestaurantOrder(
			makeContext(),
			makeRequest({
				tipPercent: 10,
				lines: [
					{
						itemId: 'item-burger',
						quantity: 2,
						options: [
							{ groupId: 'grp-size', optionId: 'opt-reg' },
							{ groupId: 'grp-toppings', optionId: 'opt-cheese' },
						],
					},
				],
			}),
			{ now: NOW },
		)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		// unit = $10 + $1 cheese = $11 -> 2 * 1100 = 2200
		expect(result.result.subtotalCents).toBe(2200)
		// 8.25% of 2200 = 181.5 -> 182
		expect(result.result.taxCents).toBe(182)
		// 10% tip on subtotal
		expect(result.result.tipCents).toBe(220)
		expect(result.result.deliveryFeeCents).toBe(0)
		expect(result.result.totalCents).toBe(2200 + 182 + 220)
	})

	it('excludes options flagged applySalesTax:false from the taxable base', () => {
		const result = priceRestaurantOrder(
			makeContext(),
			makeRequest({
				lines: [
					{
						itemId: 'item-burger',
						quantity: 1,
						options: [
							{ groupId: 'grp-size', optionId: 'opt-reg' },
							{ groupId: 'grp-toppings', optionId: 'opt-bacon' },
						],
					},
				],
			}),
			{ now: NOW },
		)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.result.subtotalCents).toBe(1200)
		// taxable = burger only ($10) -> 82.5 -> 83
		expect(result.result.taxCents).toBe(83)
	})

	it('prices variants from the catalog, not the base item price', () => {
		const result = priceRestaurantOrder(
			makeContext(),
			makeRequest({
				lines: [{ itemId: 'item-latte', variantId: 'var-large', quantity: 1 }],
			}),
			{ now: NOW },
		)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.result.subtotalCents).toBe(550)
	})

	it('prices pizza halves from priceLeft/priceRight and rejects whole+half mixes', () => {
		const halfResult = priceRestaurantOrder(
			makeContext(),
			makeRequest({
				lines: [
					{
						itemId: 'item-pizza',
						quantity: 1,
						options: [
							{
								groupId: 'grp-pizza-toppings',
								optionId: 'opt-pep',
								half: 'left',
							},
						],
					},
				],
			}),
			{ now: NOW },
		)
		expect(halfResult.ok).toBe(true)
		if (halfResult.ok) {
			expect(halfResult.result.subtotalCents).toBe(1200 + 125)
		}

		const mixed = priceRestaurantOrder(
			makeContext(),
			makeRequest({
				lines: [
					{
						itemId: 'item-pizza',
						quantity: 1,
						options: [
							{
								groupId: 'grp-pizza-toppings',
								optionId: 'opt-pep',
								half: 'whole',
							},
							{
								groupId: 'grp-pizza-toppings',
								optionId: 'opt-pep',
								half: 'left',
							},
						],
					},
				],
			}),
			{ now: NOW },
		)
		expect(mixed.ok).toBe(false)
		if (!mixed.ok) expect(mixed.error.code).toBe('invalid_combination')
	})

	it('supports quantity groups and enforces their group maximum', () => {
		const okResult = priceRestaurantOrder(
			makeContext(),
			makeRequest({
				lines: [
					{
						itemId: 'item-burger',
						quantity: 1,
						options: [
							{ groupId: 'grp-size', optionId: 'opt-reg' },
							{ groupId: 'grp-drinks', optionId: 'opt-cola', quantity: 3 },
						],
					},
				],
			}),
			{ now: NOW },
		)
		expect(okResult.ok).toBe(true)
		if (okResult.ok) expect(okResult.result.subtotalCents).toBe(1000 + 600)

		const overResult = priceRestaurantOrder(
			makeContext(),
			makeRequest({
				lines: [
					{
						itemId: 'item-burger',
						quantity: 1,
						options: [
							{ groupId: 'grp-size', optionId: 'opt-reg' },
							{ groupId: 'grp-drinks', optionId: 'opt-cola', quantity: 5 },
						],
					},
				],
			}),
			{ now: NOW },
		)
		expect(overResult.ok).toBe(false)
		if (!overResult.ok)
			expect(overResult.error.code).toBe('option_quantity_limit')
	})
})

// ---------------------------------------------------------------------------
// Adversarial validation: unknown/unavailable items, variants, modifiers
// ---------------------------------------------------------------------------

describe('priceRestaurantOrder: adversarial validation', () => {
	it('rejects unknown items', () => {
		const result = priceRestaurantOrder(
			makeContext(),
			makeRequest({ lines: [{ itemId: 'item-ghost', quantity: 1 }] }),
			{ now: NOW },
		)
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error.code).toBe('unknown_item')
	})

	it('rejects items that are not available (excluded from the catalog)', () => {
		const context = makeContext({
			menu: makeMenu([{ ...burger, availabilityStatus: 'sold_out' }]),
		})
		const result = priceRestaurantOrder(context, makeRequest(), { now: NOW })
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error.code).toBe('unknown_item')
	})

	it('requires a variant when the item has variants and rejects unknown ones', () => {
		const missing = priceRestaurantOrder(
			makeContext(),
			makeRequest({ lines: [{ itemId: 'item-latte', quantity: 1 }] }),
			{ now: NOW },
		)
		expect(missing.ok).toBe(false)
		if (!missing.ok) expect(missing.error.code).toBe('variant_required')

		const unknown = priceRestaurantOrder(
			makeContext(),
			makeRequest({
				lines: [{ itemId: 'item-latte', variantId: 'var-huge', quantity: 1 }],
			}),
			{ now: NOW },
		)
		expect(unknown.ok).toBe(false)
		if (!unknown.ok) expect(unknown.error.code).toBe('unknown_variant')

		const rejectedWhenNoVariants = priceRestaurantOrder(
			makeContext(),
			makeRequest({
				lines: [
					{
						itemId: 'item-burger',
						variantId: 'var-small',
						quantity: 1,
						options: [{ groupId: 'grp-size', optionId: 'opt-reg' }],
					},
				],
			}),
			{ now: NOW },
		)
		expect(rejectedWhenNoVariants.ok).toBe(false)
		if (!rejectedWhenNoVariants.ok) {
			expect(rejectedWhenNoVariants.error.code).toBe('unknown_variant')
		}
	})

	it('enforces required modifier groups', () => {
		const result = priceRestaurantOrder(
			makeContext(),
			makeRequest({ lines: [{ itemId: 'item-burger', quantity: 1 }] }),
			{ now: NOW },
		)
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error.code).toBe('required_modifier')
	})

	it('enforces max selections on multiple groups', () => {
		const result = priceRestaurantOrder(
			makeContext(),
			makeRequest({
				lines: [
					{
						itemId: 'item-burger',
						quantity: 1,
						options: [
							{ groupId: 'grp-size', optionId: 'opt-reg' },
							{ groupId: 'grp-toppings', optionId: 'opt-cheese' },
							{ groupId: 'grp-toppings', optionId: 'opt-bacon' },
							{ groupId: 'grp-toppings', optionId: 'opt-jalapeno' },
						],
					},
				],
			}),
			{ now: NOW },
		)
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error.code).toBe('modifier_limit')
	})

	it('rejects unknown options and duplicate selections', () => {
		const unknown = priceRestaurantOrder(
			makeContext(),
			makeRequest({
				lines: [
					{
						itemId: 'item-burger',
						quantity: 1,
						options: [
							{ groupId: 'grp-size', optionId: 'opt-reg' },
							{ groupId: 'grp-toppings', optionId: 'opt-ghost' },
						],
					},
				],
			}),
			{ now: NOW },
		)
		expect(unknown.ok).toBe(false)
		if (!unknown.ok) expect(unknown.error.code).toBe('unknown_option')

		const duplicate = priceRestaurantOrder(
			makeContext(),
			makeRequest({
				lines: [
					{
						itemId: 'item-burger',
						quantity: 1,
						options: [
							{ groupId: 'grp-size', optionId: 'opt-reg' },
							{ groupId: 'grp-toppings', optionId: 'opt-cheese' },
							{ groupId: 'grp-toppings', optionId: 'opt-cheese' },
						],
					},
				],
			}),
			{ now: NOW },
		)
		expect(duplicate.ok).toBe(false)
		if (!duplicate.ok) expect(duplicate.error.code).toBe('duplicate_option')
	})

	it('rejects half selections outside pizza groups', () => {
		const result = priceRestaurantOrder(
			makeContext(),
			makeRequest({
				lines: [
					{
						itemId: 'item-burger',
						quantity: 1,
						options: [
							{ groupId: 'grp-size', optionId: 'opt-reg' },
							{ groupId: 'grp-toppings', optionId: 'opt-cheese', half: 'left' },
						],
					},
				],
			}),
			{ now: NOW },
		)
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error.code).toBe('invalid_half')
	})

	it('requires nested groups only when their parent option is selected', () => {
		const missingNested = priceRestaurantOrder(
			makeContext(),
			makeRequest({
				lines: [
					{
						itemId: 'item-sandwich',
						quantity: 1,
						options: [{ groupId: 'grp-bread', optionId: 'opt-toasted' }],
					},
				],
			}),
			{ now: NOW },
		)
		expect(missingNested.ok).toBe(false)
		if (!missingNested.ok) {
			expect(missingNested.error.code).toBe('required_modifier')
		}

		const withNested = priceRestaurantOrder(
			makeContext(),
			makeRequest({
				lines: [
					{
						itemId: 'item-sandwich',
						quantity: 1,
						options: [
							{ groupId: 'grp-bread', optionId: 'opt-toasted' },
							{ groupId: 'grp-toast-level', optionId: 'opt-dark' },
						],
					},
				],
			}),
			{ now: NOW },
		)
		expect(withNested.ok).toBe(true)
		if (withNested.ok) expect(withNested.result.subtotalCents).toBe(850)

		const orphanNested = priceRestaurantOrder(
			makeContext(),
			makeRequest({
				lines: [
					{
						itemId: 'item-sandwich',
						quantity: 1,
						options: [
							{ groupId: 'grp-bread', optionId: 'opt-white' },
							{ groupId: 'grp-toast-level', optionId: 'opt-dark' },
						],
					},
				],
			}),
			{ now: NOW },
		)
		expect(orphanNested.ok).toBe(false)
		if (!orphanNested.ok) {
			expect(orphanNested.error.code).toBe('unknown_modifier_group')
		}
	})

	it('rejects special instructions when the menu disables them', () => {
		const menu = makeMenu()
		menu.menus[0]!.specialInstructions = false
		const result = priceRestaurantOrder(
			makeContext({ menu }),
			makeRequest({
				lines: [
					{
						itemId: 'item-burger',
						quantity: 1,
						instructions: 'no onions',
						options: [{ groupId: 'grp-size', optionId: 'opt-reg' }],
					},
				],
			}),
			{ now: NOW },
		)
		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.error.code).toBe('instructions_not_allowed')
		}
	})

	it('rejects orders when the location is closed for online ordering', () => {
		const context = makeContext()
		context.menu.locations[0]!.onlineHours = EVERY_DAY_HOURS.map((entry) => ({
			...entry,
			isOpen: false,
			slots: [],
		}))
		const result = priceRestaurantOrder(context, makeRequest(), { now: NOW })
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error.code).toBe('ordering_closed')
	})
})

// ---------------------------------------------------------------------------
// Delivery coverage: fail closed, fees only from the zone
// ---------------------------------------------------------------------------

describe('priceRestaurantOrder: delivery', () => {
	const deliveryRequest = (address: string, lines?: unknown[]) =>
		makeRequest({
			fulfillment: 'delivery',
			delivery: { address, city: 'Austin' },
			lines: lines ?? [
				{
					itemId: 'item-burger',
					quantity: 2,
					options: [{ groupId: 'grp-size', optionId: 'opt-reg' }],
				},
			],
		})

	it('resolves an in-house zip zone and applies its fee', () => {
		const result = priceRestaurantOrder(
			makeContext(),
			deliveryRequest('100 Congress Ave, Austin, TX 78701'),
			{ now: NOW },
		)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.result.deliveryFeeCents).toBe(450)
		expect(result.result.delivery?.zoneId).toBe('zone-1')
	})

	it('fails closed for out-of-coverage postal codes', () => {
		const result = priceRestaurantOrder(
			makeContext(),
			deliveryRequest('1 Rodeo Drive, Beverly Hills, CA 90210'),
			{ now: NOW },
		)
		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.error.code).toBe('delivery_coverage_unverified')
		}
	})

	it('fails closed when no postal code can be extracted', () => {
		const result = priceRestaurantOrder(
			makeContext(),
			deliveryRequest('Some unnumbered rural road'),
			{ now: NOW },
		)
		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.error.code).toBe('delivery_coverage_unverified')
		}
	})

	it('enforces the zone minimum order', () => {
		const result = priceRestaurantOrder(
			makeContext(),
			deliveryRequest('100 Congress Ave 78701', [
				{
					itemId: 'item-burger',
					quantity: 1,
					options: [{ groupId: 'grp-size', optionId: 'opt-reg' }],
				},
			]),
			{ now: NOW },
		)
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error.code).toBe('minimum_order')
	})

	it('rejects delivery when the location disables it', () => {
		const context = makeContext()
		context.menu.locations[0]!.fulfillmentOptions.delivery = false
		const result = priceRestaurantOrder(
			context,
			deliveryRequest('100 Congress Ave 78701'),
			{ now: NOW },
		)
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error.code).toBe('delivery_disabled')
	})
})

// ---------------------------------------------------------------------------
// Drops: live status, exact slots, lead time, per-order caps
// ---------------------------------------------------------------------------

describe('priceRestaurantOrder: drops', () => {
	const dropRequest = (overrides: Record<string, unknown> = {}) =>
		makeRequest({
			dropSlug: 'friday-bbq',
			pickup: { windowId: 'win-1', time: '17:30' },
			lines: [{ itemId: 'item-brisket', quantity: 2, options: [] }],
			...overrides,
		})

	it('prices a valid drop order and emits a capacity spec', () => {
		const result = priceRestaurantOrder(
			makeContext({ drop: makeDrop() }),
			dropRequest(),
			{ now: NOW },
		)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.result.subtotalCents).toBe(3600)
		expect(result.result.drop?.id).toBe('drop-1')
		expect(result.result.pickup?.time).toBe('17:30')
		expect(result.result.capacity).not.toBeNull()
		expect(result.result.capacity?.dropId).toBe('drop-1')
		expect(result.result.capacity?.windowId).toBe('win-1')
		expect(result.result.capacity?.slotTime).toBe('17:30')
		expect(result.result.capacity?.maxOrdersPerSlot).toBe(2)
		const itemEntity = result.result.capacity?.entities.find(
			(entity) => entity.kind === 'item',
		)
		expect(itemEntity).toMatchObject({
			entityId: 'item-brisket',
			quantity: 2,
			inventory: 5,
			maxPerPickupSlot: 2,
		})
		const categoryEntity = result.result.capacity?.entities.find(
			(entity) => entity.kind === 'category',
		)
		expect(categoryEntity).toMatchObject({
			entityId: 'cat-bbq',
			quantity: 2,
			inventory: 10,
		})
	})

	it('rejects drop orders when the drop is not live', () => {
		const scheduled = makeDrop()
		scheduled.drop.status = 'scheduled'
		scheduled.drop.ordersOpenAt = '2025-07-01T00:00:00.000Z'
		const scheduledResult = priceRestaurantOrder(
			makeContext({ drop: scheduled }),
			dropRequest(),
			{ now: NOW },
		)
		expect(scheduledResult.ok).toBe(false)
		if (!scheduledResult.ok) {
			expect(scheduledResult.error.code).toBe('drop_closed')
		}

		const closed = makeDrop()
		closed.drop.ordersCloseAt = '2025-06-01T00:00:00.000Z'
		const closedResult = priceRestaurantOrder(
			makeContext({ drop: closed }),
			dropRequest(),
			{ now: NOW },
		)
		expect(closedResult.ok).toBe(false)
		if (!closedResult.ok) expect(closedResult.error.code).toBe('drop_closed')

		const draft = makeDrop()
		draft.drop.status = 'draft'
		const draftResult = priceRestaurantOrder(
			makeContext({ drop: draft }),
			dropRequest(),
			{ now: NOW },
		)
		expect(draftResult.ok).toBe(false)
		if (!draftResult.ok) expect(draftResult.error.code).toBe('drop_not_found')
	})

	it('rejects slot times that are not generated slots of the window', () => {
		const result = priceRestaurantOrder(
			makeContext({ drop: makeDrop() }),
			dropRequest({ pickup: { windowId: 'win-1', time: '17:15' } }),
			{ now: NOW },
		)
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error.code).toBe('invalid_pickup_slot')
	})

	it('rejects windows from a different location', () => {
		const result = priceRestaurantOrder(
			makeContext({ drop: makeDrop() }),
			dropRequest({ pickup: { windowId: 'win-other', time: '17:30' } }),
			{ now: NOW },
		)
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error.code).toBe('invalid_pickup_window')
	})

	it('enforces the pickup lead time in the window timezone', () => {
		const drop = makeDrop()
		drop.pickupWindows[0]!.date = '2025-06-15' // today (NOW = 16:00 UTC)
		drop.pickupWindows[0]!.startTime = '16:00'
		drop.pickupWindows[0]!.endTime = '18:00'
		// lead time 30 minutes -> 16:00 slot is no longer orderable at 16:00
		const result = priceRestaurantOrder(
			makeContext({ drop }),
			dropRequest({ pickup: { windowId: 'win-1', time: '16:00' } }),
			{ now: NOW },
		)
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error.code).toBe('lead_time')

		// ...but 16:30 is exactly at the boundary and still orderable
		const okResult = priceRestaurantOrder(
			makeContext({ drop }),
			dropRequest({ pickup: { windowId: 'win-1', time: '16:30' } }),
			{ now: NOW },
		)
		expect(okResult.ok).toBe(true)
	})

	it('enforces per-order item and category caps', () => {
		const itemCap = priceRestaurantOrder(
			makeContext({ drop: makeDrop() }),
			dropRequest({
				lines: [{ itemId: 'item-brisket', quantity: 4, options: [] }],
			}),
			{ now: NOW },
		)
		expect(itemCap.ok).toBe(false)
		if (!itemCap.ok) expect(itemCap.error.code).toBe('per_order_limit')

		const categoryCap = priceRestaurantOrder(
			makeContext({ drop: makeDrop() }),
			dropRequest({
				lines: [
					{ itemId: 'item-brisket', quantity: 2, options: [] },
					{ itemId: 'item-ribs', quantity: 3, options: [] },
				],
			}),
			{ now: NOW },
		)
		expect(categoryCap.ok).toBe(false)
		if (!categoryCap.ok) expect(categoryCap.error.code).toBe('per_order_limit')
	})

	it('rejects items that are not part of the drop catalog', () => {
		const result = priceRestaurantOrder(
			makeContext({ drop: makeDrop() }),
			dropRequest({
				lines: [{ itemId: 'item-burger', quantity: 1, options: [] }],
			}),
			{ now: NOW },
		)
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error.code).toBe('unknown_item')
	})
})

// ---------------------------------------------------------------------------
// Canonical request fingerprint (idempotency semantics)
// ---------------------------------------------------------------------------

describe('canonicalOrderRequest', () => {
	it('ignores routing/presentation fields (slug, host, locale, turnstile)', () => {
		const a = canonicalOrderRequest(makeRequest())
		const b = canonicalOrderRequest(
			makeRequest({ slug: 'test-org', host: 'test.example.com', locale: 'ar' }),
		)
		expect(a).toBe(b)
	})

	it('changes when any semantic field changes', () => {
		const base = canonicalOrderRequest(makeRequest())
		expect(canonicalOrderRequest(makeRequest({ tipPercent: 5 }))).not.toBe(base)
		expect(
			canonicalOrderRequest(makeRequest({ paymentMethod: 'online' })),
		).not.toBe(base)
		expect(
			canonicalOrderRequest(
				makeRequest({
					lines: [
						{
							itemId: 'item-burger',
							quantity: 1,
							options: [{ groupId: 'grp-size', optionId: 'opt-reg' }],
						},
					],
				}),
			),
		).not.toBe(base)
		expect(
			canonicalOrderRequest(
				makeRequest({
					contact: { name: 'Someone Else', phone: '+15551234567' },
				}),
			),
		).not.toBe(base)
	})
})

// ---------------------------------------------------------------------------
// Public ordering options: aggregates only, no PII
// ---------------------------------------------------------------------------

describe('buildPublicOrderingOptions', () => {
	it('reports slot remaining counts and entity remaining without PII', () => {
		const context = makeContext({ drop: makeDrop() })
		const built = buildPublicOrderingOptions(context, {
			slug: 'test-org',
			locationId: LOCATION_ID,
			dropSlug: 'friday-bbq',
			counts: {
				slotOrders: new Map([['win-1|17:30', 1]]),
				entityUsed: new Map([
					['item|item-brisket', 2],
					['category|cat-bbq', 2],
				]),
			},
			now: NOW,
		})
		expect(built.ok).toBe(true)
		if (!built.ok) return
		const { options } = built
		expect(options.onlinePayment).toEqual({
			enabled: true,
			processor: 'connect',
		})
		expect(options.drop?.slug).toBe('friday-bbq')
		expect(options.drop?.status).toBe('live')
		const window = options.drop?.windows[0]
		expect(window?.maxOrdersPerSlot).toBe(2)
		const slot1730 = window?.slots.find((slot) => slot.time === '17:30')
		expect(slot1730?.ordersRemaining).toBe(1)
		const slot1700 = window?.slots.find((slot) => slot.time === '17:00')
		expect(slot1700?.ordersRemaining).toBe(2)
		expect(options.drop?.entityRemaining.items['item-brisket']).toBe(3)
		expect(options.drop?.entityRemaining.categories['cat-bbq']).toBe(8)
		// No customer data anywhere in the payload
		expect(JSON.stringify(options)).not.toMatch(/phone|email|contact/i)
	})

	it('marks slots whose lead time has passed', () => {
		const drop = makeDrop()
		drop.pickupWindows[0]!.date = '2025-06-15'
		drop.pickupWindows[0]!.startTime = '16:00'
		drop.pickupWindows[0]!.endTime = '18:00'
		const built = buildPublicOrderingOptions(makeContext({ drop }), {
			slug: null,
			locationId: LOCATION_ID,
			dropSlug: 'friday-bbq',
			counts: { slotOrders: new Map(), entityUsed: new Map() },
			now: NOW,
		})
		expect(built.ok).toBe(true)
		if (!built.ok) return
		const window = built.options.drop?.windows[0]
		expect(
			window?.slots.find((slot) => slot.time === '16:00')?.leadTimePassed,
		).toBe(false)
		expect(
			window?.slots.find((slot) => slot.time === '16:30')?.leadTimePassed,
		).toBe(true)
	})

	it('returns 404 for unknown locations and drops', () => {
		const unknownLocation = buildPublicOrderingOptions(makeContext(), {
			slug: null,
			locationId: 'loc-ghost',
			dropSlug: null,
			counts: { slotOrders: new Map(), entityUsed: new Map() },
			now: NOW,
		})
		expect(unknownLocation.ok).toBe(false)

		const unknownDrop = buildPublicOrderingOptions(
			makeContext({ drop: null }),
			{
				slug: null,
				locationId: LOCATION_ID,
				dropSlug: 'nope',
				counts: { slotOrders: new Map(), entityUsed: new Map() },
				now: NOW,
			},
		)
		expect(unknownDrop.ok).toBe(false)
	})
})

// ---------------------------------------------------------------------------
// Postal code extraction
// ---------------------------------------------------------------------------

describe('extractPostalCode', () => {
	it('extracts US zips and Canadian postals', () => {
		expect(extractPostalCode('100 Congress Ave, Austin TX 78701')).toBe('78701')
		expect(extractPostalCode('1 Yonge St, Toronto, ON M5E 1E5')).toBe('M5E1E5')
		expect(extractPostalCode('No postal code here')).toBeNull()
	})
})
